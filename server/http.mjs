// The ecosys HTTP server: static apps, the browser sync API (+ SSE), the AI connection API and the
// MCP endpoint (Streamable HTTP, JSON responses only).
//
// Who can reach what. The Host header alone proves nothing (any device that reaches the port can
// send "Host: 127.0.0.1"), so "this computer" also means a loopback connection that no proxy relayed.
//   local    Host 127.0.0.1:PORT / localhost:PORT / [::1]:PORT,          apps, /api/*, MCP
//            from a loopback address, without proxy forwarding headers
//   tunnel   Host in ECOSYS_ALLOWED_HOSTS (e.g. abc.trycloudflare.com),  MCP only; everything else is 404
//            from a loopback address (the tunnel program runs on this computer),
//            or a local Host relayed by a tunnel that rewrites Host
//   LAN      an IP literal Host, only when HOST is not loopback          apps only: no API, no MCP
//                                                                        (each device keeps its own data)
//   anything else: DNS rebinding, a local or tunnel Host sent by another device, or more than one
//   Host header (400)                                                     403
//
// "This computer" is still not enough for /api/*: every account on a PC shares its loopback, and a raw
// TCP forward (netsh portproxy, ssh -R, ngrok tcp) relays anyone's bytes. So the browser API also needs
// the pairing secret (see pairingSecret below): a browser gets it once, from the link ecosys prints.
import http from 'node:http';
import { join, resolve } from 'node:path';
import { serveStatic, BASE_CSP } from './static.mjs';
import { SseHub } from './sse.mjs';
import { ConflictError } from './store.mjs';
import { KINDS, ACCESS } from './ai-store.mjs';
import { ToolError } from './tools.mjs';
import { rpcError, ERR } from './mcp.mjs';
import { installClaudeDesktop, InstallError } from './install.mjs';
import { COLLECTIONS } from './validate.mjs';
import { isId, isPlainObject, safeParse, safeEqual, atomicWriteJson, readJson, randomToken, createLock, cleanText, describeError, notifyProof } from './util.mjs';
import { ROOT, DEFAULT_DATA_DIR } from './core.mjs';

export const BODY_LIMIT = 2 * 1024 * 1024;
const RATE_LIMIT = 120; // MCP requests per minute per credential
const BAD_AUTH_LIMIT = 30; // failed MCP auth attempts per minute (all callers)

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': BASE_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
};
/**
 * Browser-API replies (connection keys in GET /api/ai and the /api/ai/clients replies, the user's
 * data elsewhere) must not be kept in a browser's disk cache: "no-cache" still stores them.
 */
const NO_STORE = { 'Cache-Control': 'no-store' };

const isLoopbackHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';

/** How many Host header lines a request has (Node keeps only the first one in req.headers). */
export const hostLines = (req) => {
  let n = 0;
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') n++;
  return n;
};

/** X-Ecosys-Proof: "<client id> <ms> <proof>", see notifyProof() in util.mjs. */
const PROOF_RE = /^([a-z0-9_-]{1,40}) (\d{13}) ([A-Za-z0-9_-]{43})$/i;
const PROOF_MAX_AGE_MS = 120000;

/** A connection from this computer: 127.0.0.0/8 or ::1 (also IPv4-mapped, as a dual-stack listener reports it). */
export const isLoopbackAddr = (a) => typeof a === 'string' && (a === '::1' || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/i.test(a));

/** Headers a proxy or tunnel adds when it relays a request for someone else. */
const FORWARD_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'via'];
export const isForwarded = (headers) => FORWARD_HEADERS.some((h) => headers[h] !== undefined);

const TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/**
 * Sliding-window rate limiter: at most `limit` accepted hits per key in any `windowMs`. Refused
 * hits are not recorded, so a key holds at most `limit` timestamps however hard it is hammered.
 */
export function createLimiter(limit, windowMs = 60000, now = () => performance.now()) {
  const hits = new Map();
  const live = (key, t) => {
    const arr = hits.get(key);
    if (!arr) return null;
    let i = 0;
    while (i < arr.length && t - arr[i] >= windowMs) i++;
    if (i) arr.splice(0, i);
    return arr;
  };
  return {
    /** Count one request for `key`. True when it is over the limit (it is then not counted). */
    hit(key) {
      const t = now();
      const arr = live(key, t) || [];
      if (arr.length >= limit) return true;
      arr.push(t);
      hits.set(key, arr);
      return false;
    },
    size: (key) => live(key, now())?.length || 0,
    /** Forget keys with no hits in the window. */
    sweep() {
      const t = now();
      for (const key of [...hits.keys()]) if (!live(key, t).length) hits.delete(key);
    },
  };
}

/**
 * The data folder a stdio bridge must be given with `--data` to reach this server's data: null for
 * the default .ecosys folder (the bridge finds that one itself), else the folder as an absolute
 * path, since an app such as Claude Desktop starts the bridge from a folder of its own. Every bridge
 * setup uses it: the Claude Desktop installer, and the commands the Connect AI sheet shows.
 */
export function bridgeDataDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) return null;
  const dir = resolve(dataDir);
  return dir === resolve(DEFAULT_DATA_DIR) ? null : dir;
}

// ---------------------------------------------------------------- browser pairing
//
// The browser API answers only browsers paired with this data folder, Jupyter-style. The server keeps
// a secret in <data folder>/pair.json ({"v":1,"secret":"…"}): made on first start, written atomically
// and private like everything in that folder, kept across restarts. It prints the pairing link
// http://127.0.0.1:PORT/#pair=<secret> where it runs (and --open opens it); a browser that opened the
// link keeps the secret (shared/boot.js, shared/pair.js) and sends it as X-Ecosys on every /api
// request. Anything else gets 403 {"error":"pairing_required"}. The secret is never logged except in
// that link, never sent in a response and never put in server.json. /mcp keeps its per-assistant keys;
// the stdio bridge's notify keeps its proof (an HMAC made with a connection key), and never sees it.

export const PAIR_FILE = 'pair.json';
/** A usable pairing secret: randomToken() makes 43 characters (32 random bytes, base64url). */
const PAIR_SECRET_RE = /^[A-Za-z0-9_-]{43,200}$/;

/**
 * The pairing secret of data folder `dataDir`: read from pair.json, else made and written there (under
 * the data folder's lock, so two servers starting together agree on one). A pair.json that isn't JSON
 * or holds no usable secret is replaced, with one warning: each browser then opens the new link once.
 * One that can't be read at all (another program holds it, no permission) stops start-up instead of
 * being written over.
 */
export function pairingSecret(dataDir, { log = console } = {}) {
  const file = join(dataDir, PAIR_FILE);
  return createLock(join(dataDir, 'lock'))(() => {
    let saved = null;
    try {
      saved = readJson(file); // null when there is none
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        throw Object.assign(new Error(`ecosys could not read ${file} (${err.code || 'error'}), which holds the secret browsers connect with. Close the program that has it open, or check its permissions, then start ecosys again.`), { code: 'EPAIRFILE', cause: err });
      }
      saved = false;
    }
    if (isPlainObject(saved) && typeof saved.secret === 'string' && PAIR_SECRET_RE.test(saved.secret)) return saved.secret;
    if (saved !== null) log.warn?.(`ecosys: ${file} holds no usable pairing secret, so a new one is made: open the new pairing link once in each browser`);
    const secret = randomToken();
    atomicWriteJson(file, { v: 1, secret });
    return secret;
  });
}

/** The link that pairs a browser: `base` (the server's own URL, ending in "/") with the secret in its hash. */
export const pairingLink = (base, secret) => `${base}#pair=${secret}`;

/** Parse ECOSYS_ALLOWED_HOSTS ("a.example.com, .trycloudflare.com"). Entries starting with "." match subdomains. */
export function parseAllowedHosts(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter((s) => s && /^[a-z0-9.:[\]-]+$/.test(s) && s !== '.' && !isLoopbackHost(s.replace(/:\d+$/, '')));
}

export function createEcosysServer({ core, root = ROOT, port = 4300, host = '127.0.0.1', allowedHosts = [], log = console, bridgePath = join(ROOT, 'mcp', 'stdio-bridge.mjs'), installPaths = null }) {
  const { store, ai } = core;
  const hub = new SseHub();
  const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const localOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  // On port 80 browsers send Host and Origin without the port.
  if (port === 80) {
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) {
      localHosts.add(h);
      localOrigins.add(`http://${h}`);
    }
  }
  const lanMode = !isLoopbackHost(host);
  const tunnelOrigins = new Set(allowedHosts.filter((h) => !h.startsWith('.')).map((h) => `https://${h}`));
  const pairSecret = pairingSecret(core.dataDir, { log });
  /** Does this request carry the pairing secret? A timing-safe compare that refuses any other length too. */
  const paired = (req) => {
    const v = req.headers['x-ecosys'];
    return typeof v === 'string' && safeEqual(v, pairSecret);
  };

  // ---------------------------------------------------------------- live updates

  let lastRevBroadcast = store.rev;
  let snapshotTimer = null;
  let externalPending = false; // data.json changed on disk and browsers have not been told yet
  const broadcastOps = (data) => {
    lastRevBroadcast = Math.max(lastRevBroadcast, data.rev);
    hub.broadcast('ops', data, { except: data.origin });
  };
  const broadcastSnapshot = () => {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    if (!externalPending && store.rev === lastRevBroadcast) return;
    externalPending = false;
    lastRevBroadcast = store.rev;
    hub.broadcast('snapshot', { rev: store.rev });
  };
  // Another process (the stdio bridge, or a hand edit) changed data.json. Wait a moment: the
  // bridge's notify call usually follows with the exact ops, which is cheaper than a full refetch.
  store.onExternalChange = () => {
    externalPending = true;
    if (!snapshotTimer) {
      snapshotTimer = setTimeout(broadcastSnapshot, 250);
      snapshotTimer.unref?.();
    }
  };
  const announced = new Map(); // client id → time of the last "connected" event we sent
  const sendAi = (payload) => {
    if (payload.type === 'connected') announced.set(payload.client.id, Date.now());
    hub.broadcast('ai', payload);
  };
  ai.onExternal = ({ activity, connected }) => {
    for (const c of connected) {
      if (Date.now() - (announced.get(c.id) || 0) < 30000) continue;
      sendAi({ type: 'connected', client: { id: c.id, kind: c.kind, label: c.label }, clientName: c.lastClientName || null });
    }
    for (const entry of activity) sendAi({ type: 'activity', entry });
    if (connected.length) sendAi(core.statusPayload());
  };
  /** A change the tabs were already told of was put back (its save failed): every tab reloads. */
  const untell = () => {
    externalPending = true;
    broadcastSnapshot();
  };
  core.emitter = (event, payload) => {
    if (event === 'ops') broadcastOps(payload);
    else if (event === 'ai') sendAi(payload);
    else if (event === 'snapshot') untell();
  };

  // Connected flags flip after 10 idle minutes; tell the AI panel.
  let statusSig = '';
  const statusTimer = setInterval(() => {
    const sig = JSON.stringify(ai.statusClients().map((c) => [c.id, c.connected]));
    if (sig !== statusSig) {
      if (statusSig) sendAi(core.statusPayload());
      statusSig = sig;
    }
    perClient.sweep();
  }, 30000);
  statusTimer.unref?.();
  // Pick up writes from other processes even when nobody is making requests.
  const pollTimer = setInterval(() => {
    try {
      store.refresh();
      ai.refresh();
    } catch (err) {
      log.error('ecosys: refresh failed', err.message);
    }
  }, 1500);
  pollTimer.unref?.();

  // ---------------------------------------------------------------- helpers

  function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
    res.end(buf);
  }
  const json = (res, status, obj, extra) => send(res, status, obj, 'application/json; charset=utf-8', extra);
  /** Every browser-API reply: JSON that no cache may store. */
  const apiJson = (res, status, obj, extra) => json(res, status, obj, { ...NO_STORE, ...extra });
  const apiError = (res, status, message) => apiJson(res, status, { error: message });

  function readBody(req, limit = BODY_LIMIT) {
    return new Promise((resolveBody, reject) => {
      const len = Number(req.headers['content-length']);
      if (len > limit) return reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('Request body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const parseJsonText = (text) => {
    if (!text.trim()) return {};
    try {
      return safeParse(text);
    } catch {
      throw Object.assign(new Error('Malformed JSON body'), { status: 400 });
    }
  };

  /**
   * Where a request comes from: 'local', 'tunnel', 'lan' (see the table at the top), 'foreign'
   * (a local Host name sent from another device), 'offbox' (a tunnel Host name sent from another
   * device) or null (a Host we do not serve).
   */
  function classify(req) {
    const h = String(req.headers.host || '').toLowerCase();
    if (!h) return null;
    const loopback = isLoopbackAddr(req.socket?.remoteAddress);
    if (localHosts.has(h)) {
      if (!loopback) return 'foreign';
      // A tunnel or reverse proxy on this computer that rewrites Host to 127.0.0.1 still relays
      // other people's requests, so it gets what any tunnel gets: the MCP endpoint only.
      return isForwarded(req.headers) ? 'tunnel' : 'local';
    }
    const name = h.replace(/:\d+$/, '');
    for (const a of allowedHosts) {
      if (a.startsWith('.') ? name.endsWith(a) && name.length > a.length : h === a || name === a) {
        // The tunnel program (cloudflared, ngrok, ...) runs on this computer and connects over
        // loopback. The same name arriving from another device is someone on the network posing as
        // the tunnel, who would reach MCP over plain HTTP.
        return loopback ? 'tunnel' : 'offbox';
      }
    }
    if (lanMode && h.endsWith(`:${port}`) && (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^\[[0-9a-f:.]+\]$/.test(name))) return 'lan';
    return null;
  }

  // ---------------------------------------------------------------- rate limiting (MCP)

  const perClient = createLimiter(RATE_LIMIT); // per credential id
  const badAuth = createLimiter(BAD_AUTH_LIMIT); // failed key checks, all callers together

  // ---------------------------------------------------------------- MCP

  function bearer(req) {
    const h = req.headers.authorization;
    if (typeof h !== 'string') return null;
    const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(h);
    if (m) return m[1];
    const bare = h.trim();
    return TOKEN_RE.test(bare) ? bare : null;
  }

  async function handleMcp(req, res, pathToken, hostKind) {
    if (req.method !== 'POST') return json(res, 405, rpcError(null, ERR.INVALID_REQUEST, 'Method not allowed: use POST'), { Allow: 'POST' });
    // On local hosts a browser Origin must be ecosys itself (a page on another local port or a
    // rebound name cannot drive the endpoint). Through an allowlisted tunnel the callers are AI
    // vendors' servers whose Origin values are undocumented; the Host is already verified and a
    // credential is required, so only plain-http foreign origins are refused there.
    const origin = req.headers.origin;
    if (origin) {
      const ok = hostKind === 'tunnel' ? tunnelOrigins.has(origin) || /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) : localOrigins.has(origin);
      if (!ok) return json(res, 403, rpcError(null, ERR.INVALID_REQUEST, 'Forbidden origin'));
    }
    ai.refresh();
    const token = pathToken || bearer(req);
    const client = token ? ai.byToken(token) : null;
    if (!client) {
      if (badAuth.hit('all')) return json(res, 429, rpcError(null, ERR.INVALID_REQUEST, 'Too many failed attempts; wait a minute'), { 'Retry-After': '60' });
      return json(res, 401, rpcError(null, ERR.UNAUTHORIZED, 'Unauthorized: send the ecosys connection key as "Authorization: Bearer <key>" or use the secret URL from ecosys, Connect AI'), {
        'WWW-Authenticate': 'Bearer realm="ecosys"',
      });
    }
    if (perClient.hit(client.id)) return json(res, 429, rpcError(null, ERR.INVALID_REQUEST, `Rate limit: at most ${RATE_LIMIT} requests per minute`), { 'Retry-After': '30' });
    let msg;
    try {
      const text = await readBody(req);
      msg = safeParse(text);
    } catch (err) {
      if (err.status === 413) return json(res, 413, rpcError(null, ERR.INVALID_REQUEST, 'Request body too large'));
      return json(res, 400, rpcError(null, ERR.PARSE, 'Parse error'));
    }
    const out = core.mcp.handle(msg, { client, transport: 'http', header: (n) => (typeof req.headers[n] === 'string' ? req.headers[n] : undefined) });
    if (out.status === 202 || !out.body) {
      res.writeHead(202, { ...SECURITY_HEADERS, 'Content-Length': 0 });
      return res.end();
    }
    return json(res, out.status, out.body);
  }

  // ---------------------------------------------------------------- browser API

  /**
   * Why a browser-API request is refused (403), or null. Pairing comes first: a request without this
   * data folder's secret learns nothing else, not even whether the route exists. The Origin and Fetch
   * Metadata checks still apply to everything, paired or not.
   */
  function checkBrowser(req, { pairing = true } = {}) {
    if (pairing && !paired(req)) return 'pairing_required';
    const origin = req.headers.origin;
    if (origin && !localOrigins.has(origin)) return 'cross-origin request refused';
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request refused';
    return null;
  }

  const dataArg = bridgeDataDir(core.dataDir);
  const bridgeArgs = dataArg ? ['--data', dataArg] : [];
  const localUrl = `http://127.0.0.1:${port}/mcp`;

  /**
   * Recent activity with what the undo history knows about each entry's change: `undoOf` (an undo:
   * the change it took back) and `undone` (true once it was undone itself). After a reload the
   * Connect AI sheet then shows "Undone" instead of an Undo button that would get a 409.
   */
  const activityView = (limit) =>
    ai.recentActivity(limit).map((e) => {
      const rec = e.changeId ? ai.change(e.changeId) : null;
      return rec ? { ...e, undoOf: rec.undoOf || e.undoOf || null, undone: !!rec.undoneBy } : e;
    });

  // GET /api/ai: everything the Connect AI sheet needs, connection keys included.
  const aiOverview = () => ({
    mode: ai.mode(),
    localUrl,
    publicUrls: allowedHosts.filter((h) => !h.startsWith('.')).map((h) => `https://${h}/mcp`),
    clients: ai.fullClients(),
    activity: activityView(50),
    bridgePath,
    // Appended to every hand-copied stdio setup (and the tunnel restart command) by shared/ai.js.
    bridgeArgs,
    nodePath: process.execPath,
  });
  // GET /api/ai/status: what Home, the toolbar chip and aiStatus() show. It never holds a key or a
  // secret path, so pages that only show status never receive one.
  const aiStatus = () => ({ mode: ai.mode(), localUrl, clients: ai.publicClients(), activity: activityView(50) });
  const fullClient = (id) => ai.fullClients().find((c) => c.id === id) || null;

  async function handleApi(req, res, path, url) {
    const m = req.method;
    const route = `${m} ${path}`;
    // Every route needs the pairing secret, the event stream too (shared/sync.js opens it with fetch()),
    // except two: GET /api/hello, which says whether the request was paired and nothing more, and the
    // stdio bridge's notify, which proves a connection key instead (the bridge never holds the secret).
    const notify = route === 'POST /api/internal/notify';
    const why = checkBrowser(req, { pairing: !notify && route !== 'GET /api/hello' });
    if (why) return apiError(res, 403, why);
    // A notify without any credential is refused before its body is read.
    if (notify && req.headers['x-ecosys-proof'] === undefined && !bearer(req)) return apiError(res, 401, 'Unauthorized');

    if (route === 'GET /api/hello') return apiJson(res, 200, { ok: true, app: 'ecosys', version: core.version, features: ['sync', 'mcp'], paired: paired(req) });
    if (route === 'GET /api/state') return apiJson(res, 200, store.snapshot());
    if (route === 'GET /api/events') {
      const { key } = hub.attach(req, res, url.searchParams.get('client'), SECURITY_HEADERS);
      hub.send(key, 'ai', core.statusPayload());
      return;
    }
    if (route === 'GET /api/ai') {
      ai.refresh();
      return apiJson(res, 200, aiOverview());
    }
    if (route === 'GET /api/ai/status') {
      ai.refresh();
      return apiJson(res, 200, aiStatus());
    }

    if (m !== 'POST' && m !== 'DELETE') return apiError(res, m === 'GET' ? 404 : 405, m === 'GET' ? 'Not found' : 'Method not allowed');
    const raw = await readBody(req);
    const body = parseJsonText(raw);
    if (!isPlainObject(body)) return apiError(res, 400, 'Body must be a JSON object');

    if (route === 'POST /api/import') {
      try {
        const out = store.importData(body);
        lastRevBroadcast = out.rev;
        hub.broadcast('snapshot', { rev: out.rev });
        return apiJson(res, 200, out);
      } catch (err) {
        if (err instanceof ConflictError) return apiJson(res, 409, { error: err.message, rev: store.rev });
        throw err;
      }
    }
    if (route === 'POST /api/ops') {
      const client = isId(body.client) ? body.client : null;
      // The other tabs hear of a change as soon as it is made in memory (beforeSave), not after the
      // data file is written (a large library takes a while); the writer is answered once it is saved.
      // A save that fails puts everything back, and the tabs already told are told to reload.
      let told = false;
      const tell = (r) => {
        if (told || !r?.applied?.length) return;
        told = true;
        broadcastOps({ rev: r.rev, origin: client, ops: r.applied });
      };
      let out;
      try {
        out = store.applyOps(body.ops, { beforeSave: tell });
      } catch (err) {
        if (told) untell();
        throw err;
      }
      tell(out);
      return apiJson(res, 200, { rev: out.rev, applied: out.applied.length, rejected: out.rejected, ...(Number.isInteger(body.baseRev) ? { baseRev: body.baseRev } : {}) });
    }
    if (route === 'POST /api/ai/mode') {
      ai.setMode(body.mode);
      sendAi(core.statusPayload());
      return apiJson(res, 200, { mode: ai.mode() });
    }
    if (route === 'POST /api/ai/clients') {
      if (!KINDS.includes(body.kind)) return apiError(res, 400, `kind must be one of ${KINDS.join(', ')}`);
      if (body.access !== undefined && !ACCESS.includes(body.access)) return apiError(res, 400, 'access must be "write" or "read"');
      const c = ai.createClient({ kind: body.kind, access: body.access || 'write', label: typeof body.label === 'string' ? body.label : undefined });
      sendAi(core.statusPayload());
      return apiJson(res, 200, { client: fullClient(c.id) });
    }
    const cm = /^\/api\/ai\/clients\/([^/]+)$/.exec(path);
    if (cm) {
      if (!isId(cm[1])) return apiError(res, 404, 'No such connection');
      if (m === 'DELETE') {
        ai.deleteClient(cm[1]);
        sendAi(core.statusPayload());
        return apiJson(res, 200, { ok: true });
      }
      const c = ai.updateClient(cm[1], { access: body.access, rotate: body.rotate === true, label: typeof body.label === 'string' ? body.label : undefined });
      sendAi(core.statusPayload());
      return apiJson(res, 200, { client: fullClient(c.id) });
    }
    if (route === 'POST /api/ai/undo') {
      try {
        const out = core.undo(body.changeId, null);
        return apiJson(res, 200, { ok: true, rev: out.rev, restored: out.data.restored, skipped: out.data.skipped, changeId: out.data.change_id, summary: out.summary });
      } catch (err) {
        if (err instanceof ToolError) return apiError(res, 409, err.message);
        throw err;
      }
    }
    if (route === 'POST /api/ai/install/claude-desktop') {
      let client = isId(body.clientId) ? ai.get(body.clientId) : null;
      if (body.clientId !== undefined && !client) return apiError(res, 404, 'No such connection');
      if (client && client.kind !== 'claude') return apiError(res, 400, 'That connection is not a Claude connection');
      // Re-running the installer reuses the Claude Desktop connection instead of piling up new ones.
      if (!client && body.clientId === undefined) client = ai.fullClients().find((c) => c.kind === 'claude' && c.label === 'Claude Desktop') || null;
      if (!client) {
        client = ai.createClient({ kind: 'claude', access: body.access === 'read' ? 'read' : 'write', label: 'Claude Desktop' });
        sendAi(core.statusPayload());
      }
      try {
        const out = installClaudeDesktop({
          nodePath: process.execPath,
          bridgePath,
          clientId: client.id,
          dataDir: dataArg,
          ...(installPaths ? { paths: installPaths } : {}),
        });
        return apiJson(res, 200, { ok: true, path: out.path, paths: out.paths, backups: out.backups, clientId: client.id, client: fullClient(client.id) });
      } catch (err) {
        if (err instanceof InstallError) return apiJson(res, err.status, { ok: false, error: err.message, clientId: client.id });
        throw err;
      }
    }
    if (route === 'POST /api/internal/notify') return handleNotify(req, res, body, raw);
    return apiError(res, 404, 'Not found');
  }

  /**
   * Who sent a notify: the stdio bridge proves it holds a connection key (X-Ecosys-Proof, an HMAC
   * of the body made with the key) so it never has to send the key itself; `Authorization: Bearer
   * <key>` is accepted too (older bridges, scripts).
   */
  function notifier(req, raw) {
    const proof = req.headers['x-ecosys-proof'];
    if (typeof proof === 'string') {
      const p = PROOF_RE.exec(proof.trim());
      if (!p || Math.abs(Date.now() - Number(p[2])) > PROOF_MAX_AGE_MS) return null;
      const check = () => {
        const c = ai.get(p[1]);
        return c && safeEqual(p[3], notifyProof(c.token, c.id, p[2], raw)) ? c : null;
      };
      return check() || (ai.refresh(), check());
    }
    const token = bearer(req);
    if (!token) return null;
    return ai.byToken(token) || (ai.refresh(), ai.byToken(token));
  }

  /**
   * A change a notify names, as it is on disk now: {op:'put', c, item} with the record read here,
   * {op:'del', c, id} when it is gone, {op:'settings', patch} with the settings; null when the disk
   * doesn't show that change. Bridges name records ({op, c, id}); older ones sent whole records, and
   * only the id of those is used.
   */
  function opFromDisk(o) {
    if (!isPlainObject(o)) return null;
    if (o.op === 'settings') return { op: 'settings', patch: store.settings() };
    if (!COLLECTIONS.includes(o.c)) return null;
    const id = o.op === 'put' && isPlainObject(o.item) ? o.item.id : o.id;
    if (!isId(id)) return null;
    const item = store.get(o.c, id);
    if (o.op === 'put') return item ? { op: 'put', c: o.c, item } : null;
    if (o.op === 'del') return item ? null : { op: 'del', c: o.c, id };
    return null;
  }

  // The stdio bridge wrote data.json / ai.json itself and tells us right away (best effort). It says
  // which records changed and the rev that made, never what they hold: a stale server.json may name a
  // port someone else listens on now. What browsers get is always read from disk here, so a notifier
  // can never show them made-up data either.
  function handleNotify(req, res, body, raw) {
    const client = notifier(req, raw);
    if (!client) return apiError(res, 401, 'Unauthorized');
    const events = (Array.isArray(body.events) ? body.events.slice(0, 50) : []).filter(isPlainObject);
    // Order for the UI: "connected" first, then the activity it caused, then the data.
    for (const ev of events) {
      if (ev.event !== 'ai' || !isPlainObject(ev.data) || ev.data.type !== 'connected') continue;
      if (Date.now() - (announced.get(client.id) || 0) < 30000) continue;
      sendAi({ type: 'connected', client: { id: client.id, kind: client.kind, label: client.label }, clientName: ev.data.clientName ? cleanText(ev.data.clientName).slice(0, 80) : null });
      sendAi(core.statusPayload());
    }
    ai.refresh();
    store.refresh({ silent: true });
    for (const ev of events) {
      if (ev.event === 'ops' && isPlainObject(ev.data) && Number.isInteger(ev.data.rev) && Array.isArray(ev.data.ops)) {
        if (store.rev <= lastRevBroadcast) continue;
        // Relay the change only when it is the newest one on disk and every record it names is there as
        // named; anything else (or a read-only connection) gets a plain snapshot.
        const ops = ev.data.ops.slice(0, 2000).map(opFromDisk).filter(Boolean);
        if (ev.data.rev === store.rev && core.accessFor(client) === 'write' && ops.length && ops.length === ev.data.ops.length) {
          clearTimeout(snapshotTimer);
          snapshotTimer = null;
          externalPending = false;
          broadcastOps({ rev: store.rev, origin: `ai:${client.id}`, ops });
        } else broadcastSnapshot();
      }
    }
    // Changed but no matching ops (yet): a following notify may still carry them.
    if (store.rev > lastRevBroadcast) store.onExternalChange();
    return apiJson(res, 200, { ok: true });
  }

  // ---------------------------------------------------------------- dispatch

  async function handler(req, res) {
    try {
      // RFC 9112 section 3.2: more than one Host line is a 400. Node keeps only the first, so a
      // proxy in front that routes on another line would disagree with us about who is asking.
      if (hostLines(req) > 1) return send(res, 400, 'Bad request: more than one Host header');
      const kind = classify(req);
      if (kind === 'foreign') return send(res, 403, 'Forbidden: 127.0.0.1 and localhost only answer on the computer that runs ecosys.');
      if (kind === 'offbox') return send(res, 403, 'Forbidden: a tunnel address only answers through a tunnel running on the computer that runs ecosys.');
      if (!kind) return send(res, 403, 'Forbidden: unknown Host header. Open ecosys at http://127.0.0.1:' + port + '/');
      // A raw backslash is never part of a valid request target, and the URL parser would read
      // "/\x/..." as a host name ("//x/...").
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.includes('\\')) return send(res, 400, 'Bad request');
      let url;
      try {
        url = new URL(req.url.replace(/^\/+/, '/'), 'http://localhost');
      } catch {
        return send(res, 400, 'Bad request');
      }
      const path = url.pathname;

      if (path.startsWith('/.well-known/')) return json(res, 404, { error: 'Not found' });
      const secret = /^\/s\/([^/]+)\/mcp$/.exec(path);
      if (path === '/mcp' || secret) {
        // LAN mode serves the apps only: a key sent from another device would cross the network as
        // plain HTTP. Assistants elsewhere use a tunnel (HTTPS) instead.
        if (kind === 'lan') return json(res, 404, rpcError(null, ERR.INVALID_REQUEST, 'Not found: AI connections only answer on the computer that runs ecosys, or through a tunnel'));
        return await handleMcp(req, res, secret ? (TOKEN_RE.test(secret[1]) ? secret[1] : '!') : null, kind);
      }
      if (kind === 'tunnel') return send(res, 404, 'Not found');
      if (path === '/api' || path.startsWith('/api/')) {
        if (kind !== 'local') return json(res, 404, { error: 'Not found' });
        return await handleApi(req, res, path, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });
      return await serveStatic(req, res, { root, url, headers: SECURITY_HEADERS, send: (status, text) => send(res, status, text) });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      // Logged as text without the request target: a secret URL (/s/<key>/mcp) must never put a
      // connection key into the log.
      if (status === 500) log.error(`ecosys: ${req.method} request failed: ${describeError(err)}`);
      if (res.headersSent) return res.end();
      const msg = status === 500 ? 'Server error' : cleanText(err.message).slice(0, 300);
      if (String(req.url || '').startsWith('/api/')) return apiJson(res, status, { error: msg });
      return send(res, status, msg);
    }
  }

  const server = http.createServer(handler);
  server.headersTimeout = 30000;
  server.requestTimeout = 60000;

  function writeServerInfo() {
    try {
      atomicWriteJson(join(core.dataDir, 'server.json'), { pid: process.pid, port, host, startedAt: Date.now(), version: core.version });
    } catch (err) {
      log.error('ecosys: could not write server.json', err.message);
    }
  }

  function close() {
    clearInterval(statusTimer);
    clearInterval(pollTimer);
    clearTimeout(snapshotTimer);
    core.close();
    hub.close();
    return new Promise((r) => server.close(() => r()));
  }

  return {
    server,
    hub,
    close,
    writeServerInfo,
    handler,
    /** The pairing link for the server's own URL `base` (see pairingSecret): only ever shown where ecosys runs. */
    pairingUrl: (base = `http://127.0.0.1:${port}/`) => pairingLink(base, pairSecret),
  };
}
