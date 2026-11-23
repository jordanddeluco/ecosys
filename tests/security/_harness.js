// Shared helpers for the adversarial security suite (tests/security/*.test.js).
//
// Isolation rules, enforced here so no test can get them wrong:
//  - every server runs on a random free port (never 4300, the live dev server) with its data in a
//    fresh temp folder (never the real .ecosys/ folder), and is closed by the scope's cleanup;
//  - in-process servers always get `installPaths` inside a temp folder, so even a broken CSRF check
//    could never touch the real Claude Desktop config;
//  - child processes (server.mjs, the stdio bridge) get temp HOME/APPDATA/data folders.
// The browser API needs each server's pairing secret: the servers below expose it as `secret` (read
// from their data folder's pair.json, as a browser gets it from the pairing link), and api() and
// openSse() send it like a paired tab. A test of what an unpaired caller gets sends its own headers.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { createCore } from '../../server/core.mjs';
import { createEcosysServer, parseAllowedHosts, PAIR_FILE } from '../../server/http.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIVE_PORT = 4300;
export const LIVE_DATA_DIR = join(ROOT, '.ecosys');
export const BRIDGE = join(ROOT, 'mcp', 'stdio-bridge.mjs');
export const SERVER_ENTRY = join(ROOT, 'server.mjs');
export const BS = String.fromCharCode(92); // a literal backslash, for raw request targets
export const MODERN = '2026-07-28';
export const LEGACY = '2025-06-18';
export const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'security-suite', version: '1.0' },
};
export const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = realpathSync(tmpdir());

function assertSafeDir(dir) {
  const real = realpathSync(dir);
  const live = (() => {
    try {
      return realpathSync(LIVE_DATA_DIR);
    } catch {
      return LIVE_DATA_DIR;
    }
  })();
  if (real.toLowerCase() === live.toLowerCase() || !real.toLowerCase().startsWith(TMP.toLowerCase())) {
    throw new Error(`refusing to use ${dir}: tests must only use fresh temp folders`);
  }
}

// ------------------------------------------------------------------ scopes (cleanup)

/** Collects temp folders and closers for one suite; `cleanup()` undoes everything. */
export function createScope(label) {
  const dirs = [];
  const closers = [];
  return {
    tempDir(prefix = label) {
      const d = mkdtempSync(join(TMP, `ecosys-sec-${prefix}-`));
      dirs.push(d);
      return d;
    },
    defer(fn) {
      closers.push(fn);
    },
    async cleanup() {
      for (const fn of closers.splice(0).reverse()) {
        try {
          await fn();
        } catch {}
      }
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export async function freePort() {
  for (;;) {
    const s = net.createServer();
    await new Promise((r, j) => s.once('error', j).listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    if (p !== LIVE_PORT) return p;
  }
}

// ------------------------------------------------------------------ pairing

/** The pairing secret of the server whose data folder is `dataDir` (its pair.json), or null. */
export function pairSecret(dataDir) {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, PAIR_FILE), 'utf8')).secret;
    return typeof s === 'string' && s ? s : null;
  } catch {
    return null;
  }
}

/** port → the pairing secret of the server on it, for helpers that only get a port. */
const secrets = new Map();
function remember(scope, port, secret) {
  if (!secret) throw new Error(`the server on port ${port} wrote no pairing secret to its ${PAIR_FILE}`);
  secrets.set(port, secret);
  scope.defer(() => secrets.delete(port));
  return secret;
}
/** The pairing secret of the server on `port` (started by this harness), or null. */
export const secretFor = (port) => secrets.get(port) ?? null;
const secretOf = (s) => s?.secret ?? secretFor(s?.port) ?? (s?.dataDir ? pairSecret(s.dataDir) : null);
/** The header a paired browser tab sends to server `s`. */
export const paired = (s) => ({ 'x-ecosys': secretOf(s) });

/** A console-like logger that records everything (inspect()ed, so error properties are included). */
export function captureLog() {
  const entries = [];
  const mk = (level) => (...args) => entries.push({ level, args, text: args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8, breakLength: Infinity }))).join(' ') });
  return { entries, error: mk('error'), warn: mk('warn'), info: mk('info'), log: mk('log'), debug: mk('debug'), text: () => entries.map((e) => e.text).join('\n') };
}

// ------------------------------------------------------------------ servers

/**
 * Start an in-process ecosys server (server/core.mjs + server/http.mjs) on a random port with its
 * own temp data folder. Options go to createEcosysServer; `allowedHosts` may be a string.
 */
export async function startServer(scope, opts = {}) {
  const { allowedHosts = [], installPaths, ...rest } = opts;
  const dataDir = scope.tempDir('data');
  assertSafeDir(dataDir);
  const log = captureLog();
  const core = await createCore({ dataDir, log });
  const port = await freePort();
  const app = createEcosysServer({
    core,
    port,
    log,
    allowedHosts: typeof allowedHosts === 'string' ? parseAllowedHosts(allowedHosts) : allowedHosts,
    installPaths: installPaths || [join(scope.tempDir('claude'), 'Claude', 'claude_desktop_config.json')],
    ...rest,
  });
  await new Promise((r, j) => app.server.once('error', j).listen(port, '127.0.0.1', r));
  scope.defer(() => app.close());
  return { core, app, port, dataDir, log, secret: remember(scope, port, pairSecret(dataDir)) };
}

/**
 * Like startServer, but the app's handler sits behind a thin wrapper server so a test can pretend
 * a request came from another device: send `x-test-remote-addr: 192.168.1.50` (removed before the
 * app sees the request) and the socket's remoteAddress reads as that value. `appPort` lets the app
 * believe it listens on another port (e.g. 80) than the wrapper really does.
 */
export async function startWrapped(scope, opts = {}) {
  const { allowedHosts = [], installPaths, appPort, host = '127.0.0.1', ...rest } = opts;
  const dataDir = scope.tempDir('wrap');
  assertSafeDir(dataDir);
  const log = captureLog();
  const core = await createCore({ dataDir, log });
  const port = await freePort();
  const app = createEcosysServer({
    core,
    port: appPort ?? port,
    host,
    log,
    allowedHosts: typeof allowedHosts === 'string' ? parseAllowedHosts(allowedHosts) : allowedHosts,
    installPaths: installPaths || [join(scope.tempDir('claude'), 'Claude', 'claude_desktop_config.json')],
    ...rest,
  });
  const outer = http.createServer((req, res) => {
    const spoof = req.headers['x-test-remote-addr'];
    if (spoof !== undefined) {
      delete req.headers['x-test-remote-addr'];
      Object.defineProperty(req.socket, 'remoteAddress', { value: spoof === 'none' ? undefined : spoof, configurable: true });
    }
    app.handler(req, res);
  });
  await new Promise((r, j) => outer.once('error', j).listen(port, '127.0.0.1', r));
  scope.defer(async () => {
    outer.closeAllConnections?.();
    await new Promise((r) => outer.close(() => r()));
    await app.close();
  });
  return { core, app, port, dataDir, log, appPort: appPort ?? port, secret: remember(scope, port, pairSecret(dataDir)) };
}

// ------------------------------------------------------------------ HTTP clients

/**
 * http.request wrapper. Never throws: transport failures resolve with {status: 0, error}.
 * `host: null` is not supported here (use rawHttp). Header values may be arrays (sent as repeats).
 * `headersOnly` resolves as soon as the status line and headers arrive (for SSE streams).
 */
export function request(port, { method = 'GET', path = '/', headers = {}, body, host, timeout = 15000, headersOnly = false } = {}) {
  return new Promise((resolvePromise) => {
    let data = null;
    if (body !== undefined) data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { host: host ?? `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined || h[k] === null) delete h[k];
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolvePromise(v);
      }
    };
    let r;
    try {
      r = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
        if (headersOnly) {
          done({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text: '', json: null });
          r.destroy();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          done({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text, json });
        });
        res.on('error', (e) => done({ status: res.statusCode, error: e.code || e.message, headers: res.headers, rawHeaders: res.rawHeaders, text: Buffer.concat(chunks).toString('utf8'), json: null }));
      });
    } catch (err) {
      return done({ status: 0, error: err.code || err.message, headers: {}, rawHeaders: [], text: '', json: null });
    }
    const timer = setTimeout(() => {
      done({ status: 0, error: 'TIMEOUT', headers: {}, rawHeaders: [], text: '', json: null });
      r.destroy();
    }, timeout);
    r.on('close', () => clearTimeout(timer));
    r.on('error', (e) => done({ status: 0, error: e.code || e.message, headers: {}, rawHeaders: [], text: '', json: null }));
    r.end(data || undefined);
  });
}

/** Browser-API call as a paired tab: adds X-Ecosys with server `s`'s pairing secret (headers may override it). */
export const api = (s, method, path, body, headers = {}, extra = {}) => request(s.port, { method, path, body, headers: { ...paired(s), ...headers }, ...extra });

/** POST a JSON-RPC message to /mcp (or `path`). */
export const mcpPost = (s, body, headers = {}, path = '/mcp', extra = {}) =>
  request(s.port, { method: 'POST', path, body, headers: { accept: 'application/json, text/event-stream', ...headers }, ...extra });

export const bearer = (token) => ({ authorization: `Bearer ${token}` });

/** Legacy-era call with a key. */
export const legacyCall = (s, token, method, params = {}, id = 1, headers = {}) =>
  mcpPost(s, { jsonrpc: '2.0', id, method, params }, { ...bearer(token), 'mcp-protocol-version': LEGACY, ...headers });

/** Modern-era call with a key (adds _meta and the mirrored headers). */
export const modernCall = (s, token, method, params = {}, id = 1, headers = {}) =>
  mcpPost(
    s,
    { jsonrpc: '2.0', id, method, params: { ...params, _meta: META } },
    { ...bearer(token), 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}), ...headers },
  );

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** Parse a raw HTTP/1.x response. Header names are lower-cased; repeats are joined with ", " (and kept in headerList). */
export function parseRawResponse(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return { status: 0, statusLine: buf.toString('latin1').split('\r\n')[0] || '', headers: {}, headerList: [], text: '' };
  const [statusLine, ...lines] = buf.subarray(0, end).toString('latin1').split('\r\n');
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(statusLine)?.[1] || 0);
  const headers = {};
  const headerList = [];
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    const v = l.slice(i + 1).trim();
    headerList.push([k, v]);
    headers[k] = k in headers ? `${headers[k]}, ${v}` : v;
  }
  let body = buf.subarray(end + 4);
  if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(body);
  return { status, statusLine, headers, headerList, text: body.toString('utf8') };
}

/** Send raw bytes on a fresh connection and parse the reply. Never throws. */
export function rawRequest(port, data, { timeout = 8000, headersOnly = false } = {}) {
  return new Promise((resolvePromise) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    let done = false;
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolvePromise({ ...parseRawResponse(Buffer.concat(chunks)), ...extra });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeout);
    sock.on('connect', () => sock.write(data));
    sock.on('data', (c) => {
      chunks.push(c);
      const all = Buffer.concat(chunks);
      const end = all.indexOf('\r\n\r\n');
      if (end < 0) return;
      if (headersOnly) return finish();
      const head = all.subarray(0, end).toString('latin1');
      const cl = /\r\ncontent-length:\s*(\d+)/i.exec(head);
      if (cl && all.length >= end + 4 + Number(cl[1])) finish();
    });
    sock.on('error', (e) => finish({ error: e.code || e.message }));
    sock.on('close', () => finish());
  });
}

/**
 * Build and send a raw request. `target` is sent exactly as given. `host: null` sends no Host header.
 * `headers` is a list of [name, value] pairs (repeats allowed). `connection: null` omits Connection.
 */
export function rawHttp(port, { method = 'GET', target = '/', host, headers = [], body, version = '1.1', connection = 'close', headersOnly = false, timeout = 8000, contentLength = true } = {}) {
  const lines = [`${method} ${target} HTTP/${version}`];
  if (host !== null) lines.push(`Host: ${host ?? `127.0.0.1:${port}`}`);
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  if (buf && contentLength) lines.push(`Content-Length: ${buf.length}`);
  if (connection) lines.push(`Connection: ${connection}`);
  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
  return rawRequest(port, buf ? Buffer.concat([head, buf]) : head, { headersOnly, timeout });
}

/**
 * Open an SSE stream as a paired tab of the server on `port` (X-Ecosys: its secret; pass
 * `'x-ecosys': null` to send none); collects the raw text and parsed events.
 */
export function openSse(port, { path = '/api/events?client=sec-tab', headers = {}, host } = {}) {
  const sent = { host: host ?? `127.0.0.1:${port}`, 'x-ecosys': secretFor(port), ...headers };
  for (const k of Object.keys(sent)) if (sent[k] === undefined || sent[k] === null) delete sent[k];
  const state = { status: null, headers: null, raw: '', events: [], error: null };
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      const hit = state.events.find(w.pred);
      if (hit) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(hit);
      }
    }
  };
  let onResponse;
  const ready = new Promise((r) => (onResponse = r));
  const req = http.get({ host: '127.0.0.1', port, path, agent: false, headers: sent }, (res) => {
    state.status = res.statusCode;
    state.headers = res.headers;
    onResponse();
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      state.raw += c;
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {}
        state.events.push({ event: ev, data: parsed });
      }
      check();
    });
    res.on('error', () => {});
  });
  req.on('error', (e) => {
    state.error = e.code || e.message;
    onResponse();
  });
  return {
    state,
    ready,
    wait(pred, ms = 4000) {
      const hit = state.events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, resolve: (v) => (clearTimeout(t), res(v)) };
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          rej(new Error(`timed out waiting for an SSE event; got ${state.events.map((e) => e.event).join(',')}`));
        }, ms);
        waiters.push(w);
      });
    },
    close: () => req.destroy(),
  };
}

// ------------------------------------------------------------------ child processes

/** process.env plus overrides; on Windows, keys are matched case-insensitively so nothing is duplicated. */
export function envWith(overrides) {
  const out = { ...process.env };
  const names = Object.keys(overrides).map((k) => k.toLowerCase());
  for (const k of Object.keys(out)) {
    if (k === 'NODE_TEST_CONTEXT' || (process.platform === 'win32' ? names.includes(k.toLowerCase()) : k in overrides)) delete out[k];
  }
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * Run `node server.mjs` as a child process on a random port with a temp data folder.
 * `env` adds/overrides variables (e.g. temp HOME/APPDATA). Resolves once /api/hello answers.
 */
export async function spawnServer(scope, { env = {}, cwd } = {}) {
  const port = await freePort();
  const dataDir = scope.tempDir('child-data');
  assertSafeDir(dataDir);
  const runDir = cwd || scope.tempDir('child-cwd');
  const childEnv = envWith({ PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: dataDir, ECOSYS_ALLOWED_HOSTS: '', ...env });
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: runDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  scope.defer(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([exited, sleep(5000)]);
    }
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    // /api/hello answers without the pairing secret (paired: false), so it says when the server is up.
    const r = await request(port, { path: '/api/hello', timeout: 1500 });
    if (r.status === 200) break;
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server.mjs did not start: ${out.slice(0, 2000)}`);
    await sleep(100);
  }
  return { port, dataDir, cwd: runDir, child, output: () => out, secret: remember(scope, port, pairSecret(dataDir)) };
}

/**
 * Start the stdio bridge. `dataDir` is required (never the real data folder). Returns helpers to
 * write to stdin and wait for replies. Every stdout line is kept in `lines` (raw) and `msgs` (parsed,
 * or {__raw} when a line is not JSON).
 */
export function startBridge(dataDir, args = [], { env = {}, cwd } = {}) {
  assertSafeDir(dataDir);
  const childEnv = envWith({ ECOSYS_CLIENT: '', ECOSYS_MCP_TOKEN: '', ECOSYS_DATA_DIR: dataDir, ...env });
  const p = spawn(process.execPath, [BRIDGE, '--data', dataDir, ...args], { env: childEnv, cwd: cwd || dataDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const msgs = [];
  const lines = [];
  let pendingOut = '';
  let err = '';
  const waiters = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    pendingOut += d;
    let i;
    while ((i = pendingOut.indexOf('\n')) >= 0) {
      const line = pendingOut.slice(0, i);
      pendingOut = pendingOut.slice(i + 1);
      lines.push(line);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        m = { __raw: line };
      }
      msgs.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    }
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => (err += d));
  p.stdin.on('error', () => {});
  const exited = new Promise((r) => p.on('close', (code) => r(code)));
  const kill = setTimeout(() => p.kill(), 120000);
  exited.then(() => clearTimeout(kill));
  return {
    p,
    msgs,
    lines,
    exited,
    stderr: () => err,
    stdoutTail: () => pendingOut,
    write: (chunk) => new Promise((r) => (p.stdin.write(chunk) ? r() : p.stdin.once('drain', r))),
    end: (chunk) => new Promise((r) => p.stdin.end(chunk, r)),
    wait(pred, ms = 8000) {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, resolve: (v) => (clearTimeout(t), res(v)) };
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          rej(new Error(`timed out waiting for a bridge reply; got ${JSON.stringify(msgs).slice(0, 500)}`));
        }, ms);
        waiters.push(w);
      });
    },
  };
}

/** Feed lines to a bridge, close stdin, wait for exit. */
export async function runBridge(dataDir, args, input, opts) {
  const b = startBridge(dataDir, args, opts);
  const text = Array.isArray(input) ? input.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n' : input;
  await b.end(text);
  const code = await b.exited;
  return { code, msgs: b.msgs, lines: b.lines, stderr: b.stderr(), tail: b.stdoutTail() };
}

// ------------------------------------------------------------------ files

/** Map of every file/dir under `dir` (relative path → sha256 of the content, or 'dir'). */
export function snapshotTree(dir) {
  const out = new Map();
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (e.isDirectory()) {
        out.set(rel + sep, 'dir');
        walk(p);
      } else {
        let h;
        try {
          h = createHash('sha256').update(readFileSync(p)).digest('hex');
        } catch (err) {
          h = `unreadable:${err.code}`;
        }
        out.set(rel, h);
      }
    }
  };
  walk(dir);
  return out;
}

export function diffTrees(before, after) {
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    changed: [...before.keys()].filter((k) => after.has(k) && before.get(k) !== after.get(k)).sort(),
  };
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

// ------------------------------------------------------------------ secrets

/** The same key with its last character changed to another valid base64url character. */
export function nearMiss(token) {
  const last = token.at(-1);
  return token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

/** A key shortened so a failing assertion never prints it. */
export const redact = (s) => `${String(s).slice(0, 4)}...(${String(s).length} chars)`;

/** Which of `secrets` occur in `text` (redacted, so assertion output never shows a key). */
export const leaked = (text, secrets) => [...secrets].filter((s) => s && String(text).includes(s)).map(redact);

export const randomHex = (n = 6) => randomBytes(n).toString('hex');

/**
 * An oversized upload was refused: a 413, or the server closed the connection while the client was
 * still sending (it answers 413 from the Content-Length header first, so the client may see a reset).
 */
export const tooLargeOrReset = (r) => r.status === 413 || (r.status === 0 && /ECONNRESET|EPIPE|ECONNABORTED|hang up/i.test(String(r.error)));

/** Status codes that mean "refused" without leaking anything. */
export const isRefusal = (status) => status >= 400 && status < 500;

/** True when a response carries any CORS / private-network / timing header. */
export const corsHeaders = (headers) => Object.keys(headers || {}).filter((k) => /^access-control-|^timing-allow-origin$/i.test(k));
