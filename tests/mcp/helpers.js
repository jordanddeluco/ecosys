// Shared helpers for the MCP conformance suite (tests/mcp/*.test.js).
//
// Everything here talks to ecosys from the outside, the way an AI client does:
//   - startServer() spawns `node server.mjs` on a random free port with ECOSYS_DATA_DIR set to a
//     fresh temp folder (never port 4300, never the real .ecosys/ folder) and kills it afterwards;
//   - credentials, modes and seed data go through the documented browser API (/api/ai/*, /api/ops),
//     as a paired browser: with the server's pairing secret, read from its data folder's pair.json;
//   - HttpMcp speaks Streamable HTTP (legacy and 2026-07-28 framing), StdioMcp drives
//     mcp/stdio-bridge.mjs line by line.
// Every response is checked against the JSON-RPC/MCP envelope rules as it arrives, so each test
// also re-checks the basics (JSON only, ids echoed, resultType on modern results, ...).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ constants (from the spec, not the code)

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = join(ROOT, 'server.mjs');
export const BRIDGE = join(ROOT, 'mcp', 'stdio-bridge.mjs');
export const NOTES_TOOLS_FILE = join(ROOT, 'server', 'tools-notes.mjs');
const REAL_DATA_DIR = join(ROOT, '.ecosys');
const LIVE_PORT = 4300;

export const MODERN = ['2026-07-28'];
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_LEGACY = LEGACY[0];

export const K = {
  version: 'io.modelcontextprotocol/protocolVersion',
  caps: 'io.modelcontextprotocol/clientCapabilities',
  info: 'io.modelcontextprotocol/clientInfo',
  logLevel: 'io.modelcontextprotocol/logLevel',
  server: 'io.modelcontextprotocol/serverInfo',
  sub: 'io.modelcontextprotocol/subscriptionId',
};

export const CORE_READ_TOOLS = ['get_overview', 'get_context', 'find_tasks', 'get_task', 'find_events', 'get_event', 'find_free_time', 'plan_tasks', 'find_changes'];
export const CORE_WRITE_TOOLS = ['create_tasks', 'update_tasks', 'complete_tasks', 'create_events', 'update_event', 'schedule_tasks', 'create_list', 'create_calendar', 'update_list', 'update_calendar', 'delete_items', 'undo_change'];
export const NOTES_READ_TOOLS = ['notes_list', 'notes_search', 'notes_read', 'notes_structure'];
export const NOTES_WRITE_TOOLS = ['notes_create', 'notes_append', 'notes_update', 'notes_trash', 'notes_send_to_tasks'];
/** Write tools that only add things (MCP: destructiveHint false = "performs only additive updates"). */
export const ADDITIVE_TOOLS = ['create_tasks', 'create_events', 'create_list', 'notes_create'];
/** Write tools that mostly add (append text, link blocks to new tasks): either hint is defensible. */
export const MOSTLY_ADDITIVE_TOOLS = ['notes_append', 'notes_send_to_tasks'];
/** Tools that remove things: these must say destructiveHint true. */
export const DELETE_TOOLS = ['delete_items', 'notes_trash'];

export const CLIENT_INFO = { name: 'mcp-conformance', version: '1.0.0' };

// ------------------------------------------------------------------ small utils

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const cleanup = { children: new Set(), dirs: new Set() };
// Last line of defence: never leave a server or bridge running, or a temp folder behind.
process.on('exit', () => {
  for (const c of cleanup.children) {
    try {
      c.kill();
    } catch {}
  }
  for (const d of cleanup.dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

export async function freePort() {
  for (;;) {
    const s = net.createServer();
    await new Promise((r, j) => s.once('error', j).listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    if (p !== LIVE_PORT) return p;
  }
}

/** A fresh temp data folder. Refuses anything that could be the real data folder. */
export function makeTempDir(prefix = 'ecosys-mcp-conf-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  assertSafeDataDir(dir);
  cleanup.dirs.add(dir);
  return dir;
}

export function assertSafeDataDir(dir) {
  const abs = resolve(dir).toLowerCase();
  assert.ok(abs !== REAL_DATA_DIR.toLowerCase() && !abs.startsWith(REAL_DATA_DIR.toLowerCase() + sep), `refusing to use the real data folder ${dir}`);
  assert.ok(!abs.startsWith(ROOT.toLowerCase() + sep), `test data must live outside the project: ${dir}`);
}

export function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
  cleanup.dirs.delete(dir);
}

/** Environment for child processes: no test-runner context, no stray ecosys credentials. */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const k of ['ECOSYS_CLIENT', 'ECOSYS_MCP_TOKEN', 'ECOSYS_ALLOWED_HOSTS', 'ECOSYS_DATA_DIR', 'PORT', 'HOST']) delete env[k];
  return { ...env, ...extra };
}

// ------------------------------------------------------------------ dates (pure Y-M-D arithmetic, zone-free)

export const WD3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymdParts = (s) => s.split('-').map(Number);
export function addDays(ymd, n) {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function weekday(ymd) {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** First date on or after `ymd` that falls on weekday `wd` (0 = Sunday). */
export function onOrAfter(ymd, wd) {
  for (let i = 0; i < 7; i++) if (weekday(addDays(ymd, i)) === wd) return addDays(ymd, i);
  throw new Error('unreachable');
}
/** Today's date in an IANA zone, as YYYY-MM-DD. */
export function todayIn(zone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "Today is Sun 2026-11-22, 15:30 (America/Denver, UTC-07:00)." */
export const TODAY_LINE_RE = /Today is (Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{4}-\d{2}-\d{2}), ([01]\d|2[0-3]):([0-5]\d) \(([^()]+), UTC([+-]\d{2}:\d{2})\)\./;

export function parseTodayLine(text) {
  const m = TODAY_LINE_RE.exec(text);
  return m ? { weekday: m[1], date: m[2], time: `${m[3]}:${m[4]}`, zone: m[5], offset: m[6] } : null;
}

/** An error text must carry today's date (and zone) so the model can correct relative dates. */
export function assertTodayLine(text, { today, zone, offset } = {}, what = 'error text') {
  const t = parseTodayLine(text);
  assert.ok(t, `${what} should include "Today is <Day> YYYY-MM-DD, HH:MM (<zone>, UTC±HH:MM).": ${JSON.stringify(text)}`);
  assert.equal(t.weekday, WD3[weekday(t.date)], `weekday in the today line matches the date: ${t.weekday} ${t.date}`);
  if (today) {
    // Tolerate a midnight rollover between two calls.
    const ok = t.date === today || (t.date === addDays(today, 1) && t.time < '00:10');
    assert.ok(ok, `${what}: today line says ${t.date}, the server's today is ${today}`);
  }
  if (zone) assert.equal(t.zone, zone, `${what}: zone`);
  if (offset) assert.equal(t.offset, offset, `${what}: UTC offset`);
  return t;
}

// ------------------------------------------------------------------ raw HTTP

function mergeHeaders(...objs) {
  const out = {};
  for (const o of objs) {
    for (const [k, v] of Object.entries(o || {})) {
      const key = k.toLowerCase();
      if (v === undefined || v === null) delete out[key];
      else out[key] = v;
    }
  }
  return out;
}

/**
 * One HTTP request on a fresh connection. `body` may be an object (sent as JSON), a string or a
 * Buffer. `rawHeaders: true` sends `headers` exactly as given (no defaults, original case).
 */
export function request(port, { method = 'POST', path = '/mcp', headers = {}, body, host, rawHeaders = false, timeout = 20000, agent = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    let h;
    if (rawHeaders) h = { ...headers };
    else {
      h = mergeHeaders({ host: host ?? `127.0.0.1:${port}` }, data !== null ? { 'content-type': 'application/json' } : {}, headers);
      if (data !== null) h['content-length'] = Buffer.byteLength(data);
    }
    let settled = false;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        settled = true;
        resolvePromise({ status: res.statusCode, headers: res.headers, text, json, reusedSocket: r.reusedSocket === true });
      });
      res.on('error', (e) => !settled && reject(e));
    });
    r.on('error', (e) => !settled && reject(e));
    r.setTimeout(timeout, () => r.destroy(new Error(`request ${method} ${path} timed out`)));
    r.end(data ?? undefined);
  });
}

// ------------------------------------------------------------------ the ecosys server under test

/**
 * Spawn `node server.mjs` against a fresh data folder on a random port.
 * @returns {Promise<Server>}
 */
export async function startServer({ env = {}, dataDir = null } = {}) {
  const dir = dataDir || makeTempDir();
  assertSafeDataDir(dir);
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: childEnv({ PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: dir, ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    cleanup.children.add(child);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (out = (out + c).slice(-50000)));
    child.stderr.on('data', (c) => (out = (out + c).slice(-50000)));
    let exitInfo = null;
    const exited = new Promise((r) =>
      child.once('exit', (code, signal) => {
        exitInfo = { code, signal };
        cleanup.children.delete(child);
        r(exitInfo);
      }),
    );
    const deadline = Date.now() + 20000;
    let ready = false;
    while (!exitInfo && Date.now() < deadline) {
      try {
        // /api/hello answers without the pairing secret, so it says when the server is up.
        const r = await request(port, { method: 'GET', path: '/api/hello', timeout: 2000 });
        if (r.status === 200 && r.json?.app === 'ecosys') {
          ready = true;
          break;
        }
      } catch {}
      await sleep(60);
    }
    if (ready) return new Server({ port, dataDir: dir, child, exited, logs: () => out, secret: pairSecret(dir) });
    try {
      child.kill();
    } catch {}
    await Promise.race([exited, sleep(3000)]);
    lastErr = out;
    if (!/EADDRINUSE|already in use/i.test(out)) break;
  }
  throw new Error(`ecosys server did not start:\n${lastErr}`);
}

/** The browser pairing secret of the server whose data folder is `dataDir` (its pair.json), or null. */
export function pairSecret(dataDir) {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, 'pair.json'), 'utf8')).secret;
    return typeof s === 'string' && s ? s : null;
  } catch {
    return null;
  }
}

export class Server {
  constructor({ port, dataDir, child, exited, logs, secret }) {
    assert.notEqual(port, LIVE_PORT, 'never the live dev server port');
    assert.ok(secret, `the server wrote its pairing secret to ${join(dataDir, 'pair.json')}`);
    Object.assign(this, { port, dataDir, child, exited, logs, secret });
    this.stopped = false;
  }

  get alive() {
    return !this.stopped && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Kill the server; by default also delete its data folder. */
  async stop({ keepData = false } = {}) {
    if (!this.stopped) {
      this.stopped = true;
      try {
        this.child.kill();
      } catch {}
      const done = await Promise.race([this.exited, sleep(5000).then(() => null)]);
      if (!done) {
        try {
          this.child.kill('SIGKILL');
        } catch {}
        await Promise.race([this.exited, sleep(3000)]);
      }
    }
    if (!keepData) removeDir(this.dataDir);
  }

  /** Browser API call as a paired browser (local host, X-Ecosys: the pairing secret). */
  async api(method, path, body, headers = {}) {
    const r = await request(this.port, { method, path, body, headers: { 'x-ecosys': this.secret, ...headers } });
    return r;
  }

  async apiOk(method, path, body) {
    const r = await this.api(method, path, body);
    assert.equal(r.status, 200, `${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  }

  /** A new AI connection, as the Connect AI panel makes it. Returns {id, token, kind, label, access, secretPath, ...}. */
  async createClient({ kind = 'claude', access = 'write', label } = {}) {
    const j = await this.apiOk('POST', '/api/ai/clients', { kind, access, ...(label ? { label } : {}) });
    assert.ok(j.client?.id && typeof j.client.token === 'string', `POST /api/ai/clients returns the credential: ${JSON.stringify(j)}`);
    return j.client;
  }
  async updateClient(id, patch) {
    return (await this.apiOk('POST', `/api/ai/clients/${id}`, patch)).client;
  }
  async deleteClient(id) {
    return this.apiOk('DELETE', `/api/ai/clients/${id}`);
  }
  async setMode(mode) {
    const j = await this.apiOk('POST', '/api/ai/mode', { mode });
    assert.equal(j.mode, mode);
    return j;
  }
  async aiOverview() {
    return this.apiOk('GET', '/api/ai');
  }
  async state() {
    return this.apiOk('GET', '/api/state');
  }
  /** Apply sync ops as a browser tab would (seed data). */
  async ops(ops) {
    const j = await this.apiOk('POST', '/api/ops', { client: 'mcpconformance', ops });
    assert.deepEqual(j.rejected || [], [], `seed ops rejected: ${JSON.stringify(j.rejected)}`);
    return j;
  }
  async item(c, id) {
    return (await this.state()).data[c].find((x) => x.id === id) || null;
  }

  /** Open the browser SSE stream and collect events. */
  events(client = 'conformance-tab') {
    const events = [];
    const waiters = [];
    const req = http.get({ host: '127.0.0.1', port: this.port, path: `/api/events?client=${client}`, headers: { host: `127.0.0.1:${this.port}`, 'x-ecosys': this.secret }, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev) continue;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          events.push({ event: ev, data: parsed });
          for (const w of [...waiters]) {
            const hit = events.find(w.pred);
            if (hit) {
              waiters.splice(waiters.indexOf(w), 1);
              clearTimeout(w.timer);
              w.resolve(hit);
            }
          }
        }
      });
    });
    req.on('error', () => {});
    return {
      events,
      wait(pred, ms = 4000, what = 'SSE event') {
        const hit = events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const w = { pred, resolve: res };
          w.timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            rej(new Error(`timed out waiting for ${what}; got ${JSON.stringify(events.map((e) => [e.event, e.data?.type]))}`));
          }, ms);
          waiters.push(w);
        });
      },
      close: () => req.destroy(),
    };
  }
}

// ------------------------------------------------------------------ JSON-RPC / MCP envelope checks

/** Checks every HTTP MCP response: JSON only, one JSON-RPC 2.0 message, ids echoed, never null. */
export function checkHttpEnvelope(res, { id } = {}) {
  assert.notEqual(res.headers['access-control-allow-origin'], '*', 'never a wildcard CORS header on the MCP endpoint');
  if (res.status === 202) {
    assert.equal(res.text, '', '202 Accepted has no body');
    return;
  }
  const ct = String(res.headers['content-type'] || '');
  assert.match(ct, /^application\/json\b/i, `MCP responses are JSON only (status ${res.status}, content-type "${ct}")`);
  assert.ok(!/event-stream/i.test(ct), 'never an SSE stream');
  assert.ok(isPlainObject(res.json), `the body is one JSON object: ${res.text.slice(0, 200)}`);
  checkMessage(res.json, { id });
  if ('result' in res.json) assert.equal(res.status, 200, 'a result comes with HTTP 200');
}

/** JSON-RPC 2.0 response rules shared by both transports. */
export function checkMessage(m, { id } = {}) {
  assert.equal(m.jsonrpc, '2.0', 'jsonrpc is "2.0"');
  const hasResult = Object.hasOwn(m, 'result');
  const hasError = Object.hasOwn(m, 'error');
  assert.ok(hasResult !== hasError, `exactly one of result / error: ${JSON.stringify(m).slice(0, 200)}`);
  if (Object.hasOwn(m, 'id')) {
    assert.ok(typeof m.id === 'string' || typeof m.id === 'number', `id is a string or number, never null: ${JSON.stringify(m.id)}`);
  }
  if (hasResult) {
    assert.ok(isPlainObject(m.result), 'result is an object');
    if (id !== undefined) assert.equal(m.id, id, 'the response echoes the request id');
  }
  if (hasError) {
    assert.ok(isPlainObject(m.error), 'error is an object');
    assert.ok(Number.isInteger(m.error.code), 'error.code is an integer');
    assert.equal(typeof m.error.message, 'string');
    assert.ok(m.error.message.length > 0, 'error.message is not empty');
    if (id !== undefined && Object.hasOwn(m, 'id')) assert.equal(m.id, id, 'an error echoes the request id');
  }
}

/** 2026-07-28: every result says resultType and SHOULD carry serverInfo. */
export function checkModernResult(result) {
  assert.equal(result.resultType, 'complete', 'modern results carry resultType "complete"');
  const info = result._meta?.[K.server];
  assert.ok(isPlainObject(info), 'modern results carry _meta serverInfo');
  assert.equal(info.name, 'ecosys');
  assert.equal(typeof info.version, 'string');
}

/** CallToolResult shape (+ outputSchema conformance when the tool definition is known). */
export function checkToolResult(result, { tool = null, modern = false } = {}) {
  assert.ok(isPlainObject(result), 'tools/call result is an object');
  assert.ok(Array.isArray(result.content) && result.content.length > 0, 'content is a non-empty array');
  for (const block of result.content) {
    assert.equal(block.type, 'text', 'content blocks are text');
    assert.equal(typeof block.text, 'string');
    assert.ok(!CONTROL_RE.test(block.text), `tool output has no control characters: ${JSON.stringify(block.text.slice(0, 120))}`);
  }
  if (Object.hasOwn(result, 'isError')) assert.equal(typeof result.isError, 'boolean', 'isError is a boolean');
  if (Object.hasOwn(result, 'structuredContent')) assert.ok(isPlainObject(result.structuredContent), 'structuredContent is a JSON object (2025-06-18+)');
  if (modern) checkModernResult(result);
  if (tool?.outputSchema && result.isError !== true) {
    assert.ok(Object.hasOwn(result, 'structuredContent'), `${tool.name} declares an outputSchema, so it must return structuredContent`);
    assert.deepEqual(validate(result.structuredContent, tool.outputSchema, 'structuredContent'), [], `${tool.name}: structuredContent conforms to its outputSchema`);
  }
}

// ------------------------------------------------------------------ MCP over Streamable HTTP

export class HttpMcp {
  /**
   * @param {Server} server
   * @param {{token?:string, secretPath?:string|null, era?:'modern'|'legacy', version?:string|null, clientInfo?:object}} opts
   */
  constructor(server, { token, secretPath = null, era = 'modern', version, clientInfo = CLIENT_INFO } = {}) {
    this.server = server;
    this.port = server.port;
    this.token = token;
    this.path = secretPath || '/mcp';
    this.useSecretPath = !!secretPath;
    this.era = era;
    this.version = version !== undefined ? version : era === 'modern' ? MODERN[0] : null;
    this.clientInfo = clientInfo;
    this.nextId = 1;
    this.tools = null;
  }

  static forClient(server, client, opts = {}) {
    return new HttpMcp(server, { token: client.token, ...opts });
  }

  meta(extra = {}) {
    return { [K.version]: this.version, [K.caps]: {}, [K.info]: this.clientInfo, ...extra };
  }

  baseHeaders() {
    return mergeHeaders({ accept: 'application/json, text/event-stream' }, this.token && !this.useSecretPath ? { authorization: `Bearer ${this.token}` } : {});
  }

  eraHeaders(method, params) {
    if (this.era === 'modern') {
      return { 'mcp-protocol-version': this.version, 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': params?.name } : {}) };
    }
    return this.version ? { 'mcp-protocol-version': this.version } : {};
  }

  /** POST any body; no checks. */
  send(body, { headers = {}, path = this.path, method = 'POST' } = {}) {
    return request(this.port, { method, path, body, headers: mergeHeaders(this.baseHeaders(), headers) });
  }

  /** A JSON-RPC request with era-appropriate framing; envelope checked. */
  async request(method, params = {}, { id = this.nextId++, headers = {}, meta, noMeta = false, noEraHeaders = false } = {}) {
    const p = { ...params };
    if (this.era === 'modern' && !noMeta) p._meta = meta ?? this.meta();
    const msg = { jsonrpc: '2.0', id, method, params: p };
    const res = await this.send(msg, { headers: mergeHeaders(noEraHeaders ? {} : this.eraHeaders(method, p), headers) });
    checkHttpEnvelope(res, { id });
    const out = { ...res, id, result: res.json?.result, error: res.json?.error };
    if (out.result && this.era === 'modern') checkModernResult(out.result);
    return out;
  }

  /** A JSON-RPC notification (no id); expects 202. */
  async notify(method, params, { headers = {} } = {}) {
    const msg = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    const res = await this.send(msg, { headers: mergeHeaders(this.era === 'legacy' && this.version ? { 'mcp-protocol-version': this.version } : {}, headers) });
    return res;
  }

  /** Legacy handshake. Adopts the negotiated version for later requests. */
  async initialize(protocolVersion = LATEST_LEGACY, { clientInfo = this.clientInfo, capabilities = {}, id } = {}) {
    assert.equal(this.era, 'legacy', 'initialize is legacy only');
    const saved = this.version;
    this.version = null; // the version header may be absent on initialize
    const res = await this.request('initialize', { protocolVersion, capabilities, clientInfo }, { id });
    this.version = res.result?.protocolVersion ?? saved;
    return res;
  }

  async listTools() {
    const res = await this.request('tools/list');
    assert.ok(res.result, `tools/list failed: ${JSON.stringify(res.error)}`);
    assert.ok(Array.isArray(res.result.tools), 'tools/list returns a tools array');
    this.tools = new Map(res.result.tools.map((t) => [t.name, t]));
    return res.result.tools;
  }

  /** tools/call that must not be a protocol error. Returns {result, text, data, isError, res}. */
  async call(name, args = {}, { headers = {}, id } = {}) {
    if (!this.tools) await this.listTools();
    const res = await this.request('tools/call', { name, arguments: args }, { headers, id });
    assert.ok(res.result, `tools/call ${name} returned a protocol error: ${JSON.stringify(res.error)}`);
    checkToolResult(res.result, { tool: this.tools.get(name) || null, modern: this.era === 'modern' });
    return { res, result: res.result, text: res.result.content.map((c) => c.text).join('\n'), data: res.result.structuredContent, isError: res.result.isError === true };
  }

  /** tools/call that must succeed (isError false). */
  async ok(name, args = {}) {
    const r = await this.call(name, args);
    assert.equal(r.isError, false, `${name} failed: ${r.text}`);
    return r;
  }

  /** tools/call that must be a tool error (isError true). */
  async fails(name, args = {}) {
    const r = await this.call(name, args);
    assert.equal(r.isError, true, `${name} should fail: ${r.text}`);
    return r;
  }
}

// ------------------------------------------------------------------ MCP over stdio (mcp/stdio-bridge.mjs)

export class StdioMcp {
  /**
   * @param {{dataDir:string, clientId?:string|null, token?:string|null, args?:string[], env?:object, dataArg?:boolean}} opts
   */
  constructor({ dataDir, clientId = null, token = null, args = [], env = {}, dataArg = true }) {
    assertSafeDataDir(dataDir);
    const argv = [BRIDGE];
    if (clientId) argv.push('--client', clientId);
    if (dataArg) argv.push('--data', dataDir);
    argv.push(...args);
    // ECOSYS_DATA_DIR is always set too, so the bridge can never fall back to the real .ecosys/.
    this.child = spawn(process.execPath, argv, {
      cwd: ROOT,
      env: childEnv({ ECOSYS_DATA_DIR: dataDir, ...(token ? { ECOSYS_MCP_TOKEN: token } : {}), ...env }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    cleanup.children.add(this.child);
    this.lines = [];
    this.messages = [];
    this.badLines = [];
    this.stderr = '';
    this.sentIds = [];
    this.waiters = [];
    this.buf = '';
    this.nextId = 1;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this.onData(c));
    this.child.stderr.on('data', (c) => (this.stderr = (this.stderr + c).slice(-100000)));
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((r) =>
      this.child.once('exit', (code, signal) => {
        cleanup.children.delete(this.child);
        r({ code, signal });
      }),
    );
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.badLines.push(line);
        continue;
      }
      this.messages.push(msg);
    }
    for (const w of [...this.waiters]) {
      const hit = this.messages.slice(w.from).find(w.pred);
      if (hit) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(hit);
      }
    }
  }

  waitFor(pred, { timeout = 15000, from = 0, what = 'message' } = {}) {
    const hit = this.messages.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, from, resolve: res };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`stdio: timed out waiting for ${what}. stdout: ${JSON.stringify(this.lines.slice(-5))} stderr: ${this.stderr.slice(-500)}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  write(text) {
    this.child.stdin.write(text);
  }
  send(msg) {
    if (Object.hasOwn(msg, 'id')) this.sentIds.push(msg.id);
    this.write(JSON.stringify(msg) + '\n');
  }

  /** Send a request and wait for the response with the same id; envelope checked. */
  async request(method, params, { id = this.nextId++, timeout } = {}) {
    const from = this.messages.length;
    this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    const m = await this.waitFor((x) => Object.hasOwn(x, 'id') && x.id === id && (Object.hasOwn(x, 'result') || Object.hasOwn(x, 'error')), { timeout, from, what: `the response to ${method} (id ${JSON.stringify(id)})` });
    checkMessage(m, { id });
    return m;
  }

  /** A modern (2026-07-28) request: version, capabilities and identity in params._meta. */
  async modern(method, params = {}, { meta, ...opts } = {}) {
    const m = await this.request(method, { ...params, _meta: meta ?? { [K.version]: MODERN[0], [K.caps]: {}, [K.info]: CLIENT_INFO } }, opts);
    if (m.result) checkModernResult(m.result);
    return m;
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  async listTools({ modern = false } = {}) {
    const m = modern ? await this.modern('tools/list') : await this.request('tools/list');
    assert.ok(m.result, `tools/list failed: ${JSON.stringify(m.error)}`);
    this.tools = new Map(m.result.tools.map((t) => [t.name, t]));
    return m.result.tools;
  }

  async call(name, args = {}, { modern = false } = {}) {
    if (!this.tools) await this.listTools();
    const params = { name, arguments: args };
    const m = modern ? await this.modern('tools/call', params) : await this.request('tools/call', params);
    assert.ok(m.result, `tools/call ${name} returned a protocol error: ${JSON.stringify(m.error)}`);
    checkToolResult(m.result, { tool: this.tools.get(name) || null, modern });
    return { result: m.result, text: m.result.content.map((c) => c.text).join('\n'), data: m.result.structuredContent, isError: m.result.isError === true };
  }

  /** Close stdin and wait for the process to exit. */
  async close({ timeout = 6000 } = {}) {
    const t0 = Date.now();
    try {
      this.child.stdin.end();
    } catch {}
    const r = await Promise.race([this.exited, sleep(timeout).then(() => null)]);
    if (!r) {
      this.kill();
      throw new Error(`stdio bridge did not exit within ${timeout} ms of stdin closing. stderr: ${this.stderr.slice(-500)}`);
    }
    return { ...r, ms: Date.now() - t0, stderr: this.stderr };
  }

  kill() {
    try {
      this.child.kill();
    } catch {}
  }

  /** stdout carried only JSON-RPC messages, one per line, each answering something we sent. */
  assertCleanStdout() {
    assert.deepEqual(this.badLines, [], 'every stdout line is a JSON-RPC message');
    const seen = new Set();
    for (const m of this.messages) {
      assert.equal(m.jsonrpc, '2.0');
      if (Object.hasOwn(m, 'method')) {
        assert.ok(!Object.hasOwn(m, 'id'), `the server must not send requests over stdio: ${JSON.stringify(m)}`);
        continue;
      }
      if (!Object.hasOwn(m, 'id')) {
        assert.ok(m.error, `a message without id must be an error for an unreadable request: ${JSON.stringify(m)}`);
        continue;
      }
      assert.ok(this.sentIds.includes(m.id), `response to an id we never sent: ${JSON.stringify(m.id)}`);
      assert.ok(!seen.has(m.id), `duplicate response for id ${JSON.stringify(m.id)}`);
      seen.add(m.id);
    }
  }
}

// ------------------------------------------------------------------ JSON Schema (the subset tool schemas use)

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
// JSON Schema 2020-12 vocabulary. Anything else (e.g. OpenAPI's "nullable") is a mistake in a tool schema.
const KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', '$anchor', '$dynamicRef', '$dynamicAnchor', '$vocabulary',
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains',
  'maxProperties', 'minProperties', 'required', 'dependentRequired', 'properties', 'patternProperties',
  'additionalProperties', 'propertyNames', 'items', 'prefixItems', 'contains', 'unevaluatedItems',
  'unevaluatedProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentSchemas',
  'format', 'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples',
  'contentEncoding', 'contentMediaType', 'contentSchema',
]);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Validate a value against a schema. Returns a list of problems ([] = valid). */
export function validate(value, schema, path = '$') {
  const errs = [];
  if (schema === true || schema === undefined) return errs;
  if (schema === false) return [`${path} is not allowed`];
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) return [`${path}: expected ${types.join(' or ')}, got ${t}`];
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) errs.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => sameJson(e, value))) errs.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (t === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errs.push(`${path}: not above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errs.push(`${path}: not below ${schema.exclusiveMaximum}`);
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errs.push(`${path}: items are not unique`);
    if (schema.items !== undefined) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) errs.push(`${path}.${k} is required`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) errs.push(...validate(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k} is not allowed`);
      else if (isPlainObject(schema.additionalProperties)) errs.push(...validate(v, schema.additionalProperties, `${path}.${k}`));
    }
  }
  for (const s of schema.allOf || []) errs.push(...validate(value, s, path));
  if (schema.anyOf && !schema.anyOf.some((s) => !validate(value, s, path).length)) errs.push(`${path}: matches none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter((s) => !validate(value, s, path).length).length !== 1) errs.push(`${path}: must match exactly one of oneOf`);
  if (schema.not && !validate(value, schema.not, path).length) errs.push(`${path}: must not match "not"`);
  return errs;
}

/**
 * Lint a schema used in a tool definition. Returns a list of problems.
 * closed: every object schema with properties must say additionalProperties:false.
 * describe: every property must carry a description (it is all a model sees).
 * (Input schemas get both, plus "arrays say what their items are"; output schemas only need to be
 * valid JSON Schema.)
 */
export function lintSchema(schema, path = 'schema', { closed = false, describe = false } = {}, problems = []) {
  if (typeof schema === 'boolean') return problems;
  if (!isPlainObject(schema)) {
    problems.push(`${path} is not a schema object`);
    return problems;
  }
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k) && !k.startsWith('x-')) problems.push(`${path} uses "${k}", which is not a JSON Schema keyword`);
  if (Object.hasOwn(schema, '$ref') && !String(schema.$ref).startsWith('#')) problems.push(`${path} uses a remote $ref (clients must not dereference it)`);
  const types = schema.type === undefined ? [] : [schema.type].flat();
  if (schema.type !== undefined && (!types.length || types.some((x) => !JSON_TYPES.has(x)) || new Set(types).size !== types.length)) problems.push(`${path}.type is invalid: ${JSON.stringify(schema.type)}`);
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) problems.push(`${path}.enum must be a non-empty array`);
    else if (types.length) for (const v of schema.enum) if (validate(v, { type: schema.type }).length) problems.push(`${path}.enum value ${JSON.stringify(v)} does not match type ${JSON.stringify(schema.type)}`);
  }
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (schema[k] !== undefined && !(Number.isInteger(schema[k]) && schema[k] >= 0)) problems.push(`${path}.${k} must be a non-negative integer`);
  }
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (schema[k] !== undefined && typeof schema[k] !== 'number') problems.push(`${path}.${k} must be a number`);
  for (const [lo, hi] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
    if (typeof schema[lo] === 'number' && typeof schema[hi] === 'number' && schema[lo] > schema[hi]) problems.push(`${path}: ${lo} > ${hi}`);
  }
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, 'u');
    } catch (e) {
      problems.push(`${path}.pattern does not compile: ${e.message}`);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((x) => typeof x !== 'string') || new Set(schema.required).size !== schema.required.length) problems.push(`${path}.required must be unique strings`);
    else if (isPlainObject(schema.properties)) for (const r of schema.required) if (!Object.hasOwn(schema.properties, r)) problems.push(`${path}.required names "${r}", which is not in properties`);
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) problems.push(`${path}.properties must be an object`);
    else {
      if (types.length && !types.includes('object')) problems.push(`${path} has properties but is not an object type`);
      if (closed && schema.additionalProperties !== false) problems.push(`${path} accepts unknown fields (additionalProperties is not false)`);
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (describe && !(typeof sub?.description === 'string' && sub.description.trim())) problems.push(`${path}.properties.${k} has no description`);
        lintSchema(sub, `${path}.properties.${k}`, { closed, describe }, problems);
      }
    }
  }
  if (isPlainObject(schema.additionalProperties)) lintSchema(schema.additionalProperties, `${path}.additionalProperties`, { closed, describe }, problems);
  if (closed && types.includes('array') && schema.items === undefined && schema.prefixItems === undefined) problems.push(`${path} is an array without items`);
  // The server caps unlimited strings (20000) and arrays (200) anyway; the schema should say so.
  if (closed && types.includes('string') && schema.maxLength === undefined && schema.enum === undefined) problems.push(`${path} is a string without maxLength (the advertised schema should state the server's limit)`);
  if (closed && types.includes('array') && schema.maxItems === undefined) problems.push(`${path} is an array without maxItems (the advertised schema should state the server's limit)`);
  if (Array.isArray(schema.items)) problems.push(`${path}.items is an array (tuple form is prefixItems in 2020-12)`);
  else if (schema.items !== undefined) lintSchema(schema.items, `${path}.items`, { closed, describe }, problems);
  for (const k of ['allOf', 'anyOf', 'oneOf']) if (schema[k] !== undefined) (Array.isArray(schema[k]) ? schema[k] : [null]).forEach((s, i) => lintSchema(s, `${path}.${k}[${i}]`, { closed, describe }, problems));
  if (schema.not !== undefined) lintSchema(schema.not, `${path}.not`, { closed, describe }, problems);
  if (schema.default !== undefined && validate(schema.default, schema).length) problems.push(`${path}.default does not match its own schema`);
  return problems;
}

/** Problems with one tool definition from tools/list (shape, schemas, annotations). */
export function lintTool(t) {
  const p = [];
  const name = typeof t?.name === 'string' ? t.name : '<no name>';
  if (!isPlainObject(t)) return [`tool is not an object`];
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) p.push(`${name}: name must be 1-128 of [A-Za-z0-9_.-]`);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) p.push(`${name}: name should be snake_case`);
  if (!(typeof t.title === 'string' && t.title.trim())) p.push(`${name}: title missing`);
  if (!(typeof t.description === 'string' && t.description.trim().length >= 20)) p.push(`${name}: description missing or too short`);
  if (!isPlainObject(t.inputSchema)) p.push(`${name}: inputSchema missing`);
  else {
    if (t.inputSchema.type !== 'object') p.push(`${name}: inputSchema.type must be "object"`);
    if (t.inputSchema.additionalProperties !== false) p.push(`${name}: inputSchema must set additionalProperties:false`);
    lintSchema(t.inputSchema, `${name}.inputSchema`, { closed: true, describe: true }, p);
  }
  if (t.outputSchema !== undefined) {
    if (!isPlainObject(t.outputSchema) || t.outputSchema.type !== 'object') p.push(`${name}: outputSchema must be an object schema (structuredContent is an object)`);
    else lintSchema(t.outputSchema, `${name}.outputSchema`, {}, p);
  }
  const a = t.annotations;
  if (!isPlainObject(a)) p.push(`${name}: annotations missing`);
  else {
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) if (typeof a[k] !== 'boolean') p.push(`${name}: annotations.${k} must be set explicitly (boolean)`);
    if (a.openWorldHint !== false) p.push(`${name}: openWorldHint should be false (a local database is a closed world)`);
    if (a.title !== undefined && a.title !== t.title) p.push(`${name}: annotations.title "${a.title}" differs from title "${t.title}"`);
    if (a.readOnlyHint === true && a.destructiveHint === true) p.push(`${name}: a read-only tool cannot be destructive`);
  }
  return p;
}

export { existsSync };
