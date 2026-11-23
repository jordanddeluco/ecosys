// Regression tests for the server fixes from the QA security and MCP conformance runs:
// duplicate Host headers, raw backslashes in request targets (and what reaches the log), no-store
// on replies that carry keys, /api/events needing the pairing secret, tunnel Hosts from other devices,
// the 401 JSON-RPC code, notify proofs, the Claude Desktop installer's backups and read-only
// configs, a corrupt ai.json, and dates from the phrase parser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { inspect } from 'node:util';
import { duplexPair } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCore } from '../server/core.mjs';
import { createEcosysServer, parseAllowedHosts } from '../server/http.mjs';
import { mergeConfig, installClaudeDesktop, bridgeEntry, InstallError, ownBackupPattern, KEEP_BACKUPS } from '../server/install.mjs';
import { AIStore } from '../server/ai-store.mjs';
import { ERR } from '../server/mcp.mjs';
import { notifyProof, stamp } from '../server/util.mjs';
import { checkNlpDate, checkNlpTime, checkNlpRepeat, parseDate, parseWhen, parseTime, parseRepeat, clock, validYmd, ToolError } from '../server/model.mjs';

const WIN = process.platform === 'win32';
const BS = '\\';
const made = [];
const tempDir = (prefix = 'ecosys-hard-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

/** A console-like logger that keeps every line, the way a real console would print it. */
function captureLog() {
  const lines = [];
  const mk = (level) => (...args) => lines.push({ level, text: args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ') });
  return { lines, error: mk('error'), warn: mk('warn'), info: mk('info'), log: mk('log'), text: () => lines.map((l) => l.text).join('\n') };
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

const servers = [];
/** port → the pairing secret of the server on it (its data folder's pair.json, as a browser gets it from the pairing link). */
const secrets = new Map();
async function start(opts = {}) {
  const dataDir = tempDir('ecosys-hard-data-');
  const log = captureLog();
  const core = await createCore({ dataDir, log });
  const port = await freePort();
  const app = createEcosysServer({ core, port, log, installPaths: [join(tempDir('ecosys-hard-claude-'), 'Claude', 'claude_desktop_config.json')], ...opts });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  servers.push(app);
  const secret = JSON.parse(readFileSync(join(dataDir, 'pair.json'), 'utf8')).secret;
  secrets.set(port, secret);
  return { core, app, port, dataDir, log, secret };
}

function req(port, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: host ?? `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.end(data || undefined);
  });
}
/** A browser-API call as a paired tab (X-Ecosys: the server's pairing secret). */
const api = (port, method, path, body, headers = {}) => req(port, { method, path, body, headers: { 'x-ecosys': secrets.get(port), ...headers } });

/** Raw request lines on a socket: status and the response text. */
function raw(port, lines, body = '') {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end(`${lines.join('\r\n')}\r\nConnection: close\r\n\r\n${body}`));
    let out = '';
    sock.on('data', (c) => (out += c));
    sock.on('error', () => {});
    sock.on('close', () => resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(out)?.[1] || 0), text: out }));
  });
}

/** One request that arrives from `remoteAddress` (another device on the network, say). */
function rawFrom(app, remoteAddress, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    const [inside, outside] = duplexPair();
    Object.defineProperty(inside, 'remoteAddress', { value: remoteAddress });
    let out = '';
    outside.setEncoding('utf8');
    outside.on('data', (c) => (out += c));
    outside.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1]), text: out.slice(out.indexOf('\r\n\r\n') + 4) }));
    app.server.emit('connection', inside);
    const all = { connection: 'close', 'content-length': Buffer.byteLength(body), ...headers };
    outside.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
  });
}

let s;
before(async () => {
  s = await start({ allowedHosts: parseAllowedHosts('abc.trycloudflare.com') });
});
after(async () => {
  for (const app of servers) await app.close();
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

// ------------------------------------------------------------------ request parsing

test('more than one Host header is a 400, whichever one comes first (RFC 9112 section 3.2)', async () => {
  const local = `127.0.0.1:${s.port}`;
  for (const hosts of [[local, 'evil.example'], ['evil.example', local], [local, local]]) {
    const r = await raw(s.port, ['GET /api/hello HTTP/1.1', ...hosts.map((h) => `Host: ${h}`), `X-Ecosys: ${s.secret}`]);
    assert.equal(r.status, 400, `Host lines ${JSON.stringify(hosts)} -> ${r.status}`);
    assert.ok(!r.text.includes('"app":"ecosys"'));
  }
  assert.equal((await raw(s.port, ['GET /api/hello HTTP/1.1', `Host: ${local}`, `X-Ecosys: ${s.secret}`])).status, 200, 'one Host line is fine');
});

test('a raw backslash in the request target is a 400, and nothing (no key) reaches the log', async () => {
  const c = s.core.ai.createClient({ kind: 'chatgpt' });
  const before = s.log.lines.length;
  for (const target of [`/${BS}%zz/`, `/${BS}[/`, `/${BS}%00/`, `/${BS}%/x`, `/${BS}evil.example/tasks`, `/tasks${BS}..${BS}x`]) {
    assert.equal((await raw(s.port, [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${s.port}`])).status, 400, target);
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  for (const target of [`/${BS}%/s/${c.token}/mcp`, `/${BS}[/s/${c.token}/mcp`]) {
    const r = await raw(s.port, [`POST ${target} HTTP/1.1`, `Host: 127.0.0.1:${s.port}`, 'Content-Type: application/json', `Content-Length: ${body.length}`], body);
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes(c.token));
  }
  const logged = s.log.lines.slice(before);
  assert.deepEqual(logged.filter((l) => l.level === 'error').map((l) => l.text.split('\n')[0]), [], 'malformed targets are client errors, not logged server errors');
  assert.ok(!s.log.text().includes(c.token), 'the key is not in the log');
  s.core.ai.deleteClient(c.id);
});

test('a server error is logged as text without the request target, the key or the error object', async () => {
  const x = await start();
  const c = x.core.ai.createClient({ kind: 'claude' });
  const original = x.core.mcp.handle;
  x.core.mcp.handle = () => {
    throw Object.assign(new Error(`exploded near /s/${c.token}/mcp`), { input: `/s/${c.token}/mcp`, code: 'EBOOM' });
  };
  try {
    const r = await req(x.port, { method: 'POST', path: `/s/${c.token}/mcp`, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes(c.token));
  } finally {
    x.core.mcp.handle = original;
  }
  const errors = x.log.lines.filter((l) => l.level === 'error').map((l) => l.text);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /^ecosys: POST request failed: \[EBOOM\] Error: exploded near \/s\/\[redacted\]\/mcp/);
  assert.ok(!x.log.text().includes(c.token), 'no key in the log');
  assert.ok(!/input:/.test(x.log.text()), 'the error object (and its input property) is not dumped');
});

// ------------------------------------------------------------------ caching

test('replies that carry connection keys are Cache-Control: no-store; static files and the event stream keep no-cache', async () => {
  const created = await api(s.port, 'POST', '/api/ai/clients', { kind: 'other', label: 'cache test' });
  const id = created.json.client.id;
  const { cfg } = claudeFolder();
  const inst = await start({ installPaths: [cfg] });
  const replies = {
    'GET /api/ai': await api(s.port, 'GET', '/api/ai'),
    'POST /api/ai/clients': created,
    'POST /api/ai/clients/:id': await api(s.port, 'POST', `/api/ai/clients/${id}`, { rotate: true }),
    'POST /api/ai/install/claude-desktop': await api(inst.port, 'POST', '/api/ai/install/claude-desktop', {}),
  };
  for (const [label, r] of Object.entries(replies)) {
    assert.equal(r.status, 200, `${label}: ${r.text.slice(0, 200)}`);
    assert.match(r.text, /"token"/, `${label} carries a key`);
    assert.equal(r.headers['cache-control'], 'no-store', label);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', label);
  }
  assert.equal((await api(s.port, 'GET', '/api/nope')).headers['cache-control'], 'no-store', 'API errors too');
  assert.equal((await req(s.port, { path: '/tasks/' })).headers['cache-control'], 'no-cache', 'static files revalidate');
  const sse = await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events?client=cache', agent: false, headers: { host: `127.0.0.1:${s.port}`, 'x-ecosys': s.secret } }, (res) => {
      resolve(res.headers);
      r.destroy();
    });
  });
  assert.equal(sse['cache-control'], 'no-cache');
  await api(s.port, 'DELETE', `/api/ai/clients/${id}`);
});

// ------------------------------------------------------------------ /api/events

test('/api/events needs the pairing secret like every other browser route (no EventSource exemption)', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const plain = await req(s.port, { method, path: '/api/events', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'mode=off' });
    assert.equal(plain.status, 403, `${method} without the secret -> ${plain.status}`);
    assert.equal(plain.json?.error, 'pairing_required');
    const withHeader = await api(s.port, method, '/api/events', {});
    assert.ok(withHeader.status === 404 || withHeader.status === 405, `${method} with the secret -> ${withHeader.status}`);
  }
  const head = await req(s.port, { method: 'HEAD', path: '/api/events' });
  assert.equal(head.status, 403);
  const open = (headers) =>
    new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events?client=ok', agent: false, headers: { host: `127.0.0.1:${s.port}`, ...headers } }, (res) => {
        resolve({ status: res.statusCode, type: res.headers['content-type'] });
        r.destroy();
      });
    });
  // What an EventSource (or an <img src>) sends: no custom header. And the header from before pairing.
  assert.deepEqual(await open({}), { status: 403, type: 'application/json; charset=utf-8' });
  assert.deepEqual(await open({ 'x-ecosys': '1' }), { status: 403, type: 'application/json; charset=utf-8' });
  assert.deepEqual(await open({ 'x-ecosys': s.secret }), { status: 200, type: 'text/event-stream; charset=utf-8' });
});

// ------------------------------------------------------------------ tunnels

test('a tunnel Host sent from another device is refused; the tunnel program on this computer reaches MCP', async () => {
  const lan = await start({ host: '0.0.0.0', allowedHosts: parseAllowedHosts('abc.trycloudflare.com, .ngrok-free.dev') });
  const c = lan.core.ai.createClient({ kind: 'claude' });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const call = (from, host, extra = {}) => rawFrom(lan.app, from, { method: 'POST', path: '/mcp', headers: { host, authorization: `Bearer ${c.token}`, 'content-type': 'application/json', ...extra }, body });
  for (const from of ['192.168.1.50', '::ffff:192.168.1.50', '10.0.0.7', 'fe80::1']) {
    for (const host of ['abc.trycloudflare.com', 'x.ngrok-free.dev', 'abc.trycloudflare.com:443']) {
      const r = await call(from, host);
      assert.equal(r.status, 403, `${from} as ${host} -> ${r.status}`);
      assert.ok(!r.text.includes('get_overview') && !r.text.includes(c.token));
    }
    const secret = await rawFrom(lan.app, from, { method: 'POST', path: `/s/${c.token}/mcp`, headers: { host: 'abc.trycloudflare.com', 'content-type': 'application/json' }, body });
    assert.equal(secret.status, 403, `${from}: secret path`);
  }
  for (const from of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const r = await call(from, 'abc.trycloudflare.com');
    assert.equal(r.status, 200, `${from} (the tunnel program) -> ${r.status}`);
    assert.match(r.text, /get_overview/);
    assert.equal((await rawFrom(lan.app, from, { path: '/', headers: { host: 'abc.trycloudflare.com' } })).status, 404, 'still MCP only');
  }
});

// ------------------------------------------------------------------ MCP auth

test('a 401 keeps HTTP 401 + WWW-Authenticate, and its JSON-RPC code is an application code outside -32768..-32000', async () => {
  assert.ok(ERR.UNAUTHORIZED < -32768 || ERR.UNAUTHORIZED > -32000, `ERR.UNAUTHORIZED = ${ERR.UNAUTHORIZED}`);
  assert.ok(ERR.UNAUTHORIZED < 0);
  for (const headers of [{}, { authorization: 'Bearer nope' }]) {
    const r = await req(s.port, { method: 'POST', path: '/mcp', headers, body: { jsonrpc: '2.0', id: 7, method: 'tools/list' } });
    assert.equal(r.status, 401);
    assert.equal(r.headers['www-authenticate'], 'Bearer realm="ecosys"');
    assert.equal(r.json.error.code, ERR.UNAUTHORIZED);
  }
  // The handler itself (also what the stdio bridge answers for an unknown connection).
  const out = s.core.mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { client: null, transport: 'stdio' });
  assert.equal(out.status, 401);
  assert.equal(out.body.error.code, ERR.UNAUTHORIZED);
  assert.equal(out.body.id, 3);
});

// ------------------------------------------------------------------ notify proofs

test('internal notify: a proof made with the key works without sending the key; a wrong, stale or rotated one does not', async () => {
  const c = s.core.ai.createClient({ kind: 'claude', label: 'Proof test' });
  const send = (body, proof) => req(s.port, { method: 'POST', path: '/api/internal/notify', body, headers: { 'x-ecosys': '1', 'x-ecosys-proof': proof } });
  const body = JSON.stringify({ events: [] });
  const now = String(Date.now());
  assert.equal((await send(body, `${c.id} ${now} ${notifyProof(c.token, c.id, now, body)}`)).status, 200, 'a valid proof');
  const other = JSON.stringify({ events: [{ event: 'ai', data: { type: 'connected' } }] });
  assert.equal((await send(other, `${c.id} ${now} ${notifyProof(c.token, c.id, now, body)}`)).status, 401, 'a proof for another body');
  assert.equal((await send(body, `${c.id} ${now} ${notifyProof('x'.repeat(43), c.id, now, body)}`)).status, 401, 'a proof made with another key');
  const old = String(Date.now() - 5 * 60 * 1000);
  assert.equal((await send(body, `${c.id} ${old} ${notifyProof(c.token, c.id, old, body)}`)).status, 401, 'a stale proof');
  assert.equal((await send(body, `nope ${now} ${notifyProof(c.token, 'nope', now, body)}`)).status, 401, 'an unknown connection');
  assert.equal((await send(body, 'garbage')).status, 401);
  assert.equal((await api(s.port, 'POST', '/api/internal/notify', { events: [] }, { authorization: `Bearer ${c.token}` })).status, 200, 'Bearer still works');
  const oldToken = c.token;
  s.core.ai.updateClient(c.id, { rotate: true });
  const t = String(Date.now());
  assert.equal((await send(body, `${c.id} ${t} ${notifyProof(oldToken, c.id, t, body)}`)).status, 401, 'a rotated key');
  s.core.ai.deleteClient(c.id);
});

// ------------------------------------------------------------------ Claude Desktop installer

function claudeFolder() {
  const dir = join(tempDir('ecosys-hard-claude-'), 'Claude');
  mkdirSync(dir, { recursive: true });
  const cfg = join(dir, 'claude_desktop_config.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 }));
  return { dir, cfg };
}
const entry = bridgeEntry({ nodePath: process.execPath, bridgePath: '/x/stdio-bridge.mjs', clientId: 'abc123' });

test('repeat installs prune only the installer\'s own backups, never a user\'s files', () => {
  const { dir, cfg } = claudeFolder();
  const mine = {
    'claude_desktop_config.json.2020-01-01.bak': 'mine',
    'claude_desktop_config.json.my-backup.bak': 'mine too',
    'claude_desktop_config.json.orig': 'not a .bak',
    'claude_desktop_config.json.2020-01-01T00-00-00-000Z.bak.keep': 'not ours either',
    'notes.bak': 'unrelated',
  };
  for (const [n, c] of Object.entries(mine)) writeFileSync(join(dir, n), c);
  const pattern = ownBackupPattern(cfg);
  assert.ok(pattern.test(`claude_desktop_config.json.${stamp()}.bak`), 'stamp() names match the pattern');
  for (const n of Object.keys(mine)) assert.equal(pattern.test(n), false, n);
  for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
    const out = mergeConfig(cfg, entry);
    assert.ok(out.backup && existsSync(out.backup));
    const t = Date.now();
    while (Date.now() === t); // a new millisecond, so the stamps differ
  }
  const names = readdirSync(dir);
  assert.equal(names.filter((n) => pattern.test(n)).length, KEEP_BACKUPS, 'the newest own backups are kept');
  for (const [n, c] of Object.entries(mine)) assert.equal(readFileSync(join(dir, n), 'utf8'), c, `${n} was deleted or changed`);
  assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')), { mcpServers: { other: { command: 'x' }, ecosys: entry }, keep: 1 });
});

test('a read-only config gets a clear 409 InstallError, stays unchanged, and leaves no temp file or new backup', { skip: !WIN && 'only Windows refuses to replace a read-only file' }, async () => {
  const { dir, cfg } = claudeFolder();
  for (let i = 0; i < KEEP_BACKUPS + 1; i++) writeFileSync(join(dir, `claude_desktop_config.json.2020-01-0${i + 1}T00-00-00-000Z.bak`), 'old');
  const before = readdirSync(dir).sort();
  const content = readFileSync(cfg);
  chmodSync(cfg, 0o444);
  try {
    assert.throws(() => mergeConfig(cfg, entry), (err) => err instanceof InstallError && err.status === 409 && /read-only/.test(err.message) && err.message.includes(cfg));
    assert.throws(() => installClaudeDesktop({ nodePath: process.execPath, bridgePath: '/x', clientId: 'abc', paths: [cfg] }), InstallError);
    // and over HTTP: a clear error, not "Server error"
    const x = await start({ installPaths: [cfg] });
    const r = await api(x.port, 'POST', '/api/ai/install/claude-desktop', {});
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /read-only/);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally {
    chmodSync(cfg, 0o666);
  }
  assert.deepEqual(readFileSync(cfg), content, 'unchanged');
  assert.deepEqual(readdirSync(dir).sort(), before, 'no temp file, no backup, and nothing pruned after a failed install');
});

// ------------------------------------------------------------------ a corrupt ai.json

test('a corrupt ai.json: the log quotes nothing from it, and it is set aside (keys kept), not overwritten', () => {
  const tok = randomBytes(32).toString('base64url');
  for (const text of [
    `{"mode":"write","clients":[{"id":"abc","kind":"claude","token":${tok}}]}`,
    `{"mode":"write","clients":[{"id":"abc","kind":"claude","token":"${tok}"x,"access":"write"}]}`,
    `{"clients":[{"token":"${tok}`,
  ]) {
    const dir = tempDir();
    writeFileSync(join(dir, 'ai.json'), text);
    const log = captureLog();
    const store = new AIStore({ dir, log });
    assert.equal(store.byToken(tok), null, 'a corrupt file grants nothing');
    const logged = log.text();
    assert.match(logged, /ai\.json is not valid JSON/);
    for (let i = 0; i + 8 <= tok.length; i++) assert.ok(!logged.includes(tok.slice(i, i + 8)), `the log quotes part of the key: ${logged}`);
    assert.equal(readFileSync(join(dir, 'ai.json'), 'utf8'), text, 'loading changes nothing on disk');
    // The next save keeps the corrupt file under another name instead of overwriting it.
    const c = store.createClient({ kind: 'claude' });
    const aside = readdirSync(dir).filter((n) => /^ai\.json\.corrupt-/.test(n));
    assert.equal(aside.length, 1, readdirSync(dir).join(', '));
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), text, 'the corrupt file, with its keys, is kept byte for byte');
    assert.equal(JSON.parse(readFileSync(join(dir, 'ai.json'), 'utf8')).clients[0].id, c.id, 'ai.json is valid again');
    store.createClient({ kind: 'other' });
    assert.equal(readdirSync(dir).filter((n) => /^ai\.json\.corrupt-/.test(n)).length, 1, 'set aside once');
    assert.ok(!log.text().includes(tok));
  }
});

test("a corrupt data.json stops the start with a message that quotes none of the user's data, and is left as it was", async () => {
  const { DataStore } = await import('../server/store.mjs');
  const { loadValidators } = await import('../server/validate.mjs');
  const validators = await loadValidators({ log: captureLog() });
  for (const text of ['{"rev":1,"data":{"tasks":[{"id":"a","title":"Call the PRIVATEDOCTOR about results"x}]}}', '{"data":{"tasks":[{"title":PRIVATEDOCTOR}]}}', '{"data":"PRIVATEDOCTOR']) {
    const dir = tempDir();
    writeFileSync(join(dir, 'data.json'), text);
    const log = captureLog();
    let message = '';
    assert.throws(() => new DataStore({ dir, validators, log, startWaitMs: 0 }), (err) => ((message = err.message), err.name === 'DataFileError'));
    assert.match(message, /data\.json is not valid JSON/);
    assert.ok(!/PRIVATE|DOCTOR|results/.test(message + log.text()), message);
    assert.equal(readFileSync(join(dir, 'data.json'), 'utf8'), text, 'left as it was');
  }
});

// ------------------------------------------------------------------ dates from the phrase parser

test('dates, times and repeats from the phrase parser are checked before use', () => {
  const c = clock(new Date(2026, 10, 22, 10, 0));
  for (const bad of ['491-05-01', 'NaN-NaN-NaN', '10026-11-22', '2026-02-30', '2026-13-01', '', null, undefined, 20261122]) {
    assert.throws(() => checkNlpDate(bad, 'some phrase', c, 'date'), (err) => err instanceof ToolError && /YYYY-MM-DD \(e\.g\. 2026-11-23\)/.test(err.message) && /"some phrase"/.test(err.message), String(bad));
  }
  assert.equal(checkNlpDate('2026-11-23', 'tomorrow', c), '2026-11-23');
  for (const bad of ['25:00', 'NaN:NaN', '9:5', null]) assert.throws(() => checkNlpTime(bad, 'x'), (err) => err instanceof ToolError && /HH:MM/.test(err.message), String(bad));
  assert.equal(checkNlpTime('09:30', 'x'), '09:30');
  for (const bad of [{ freq: 'day', interval: 1000 }, { freq: 'day', interval: 0 }, { freq: 'day', interval: 1.5 }, { freq: 'hour', interval: 1 }]) {
    assert.throws(() => checkNlpRepeat(bad, 'every so often'), (err) => err instanceof ToolError && /1 to 99/.test(err.message), JSON.stringify(bad));
  }
  assert.deepEqual(checkNlpRepeat({ freq: 'week', interval: 2, days: [1, Number.NaN, 9] }, 'x'), { freq: 'week', interval: 2, days: [1] });
  assert.deepEqual(checkNlpRepeat({ freq: 'week', days: [Number.NaN] }, 'x'), { freq: 'week', interval: 1 });
  assert.equal(checkNlpRepeat(null, 'x'), null);
  // The parse functions still accept what they did, and refuse what they cannot store.
  assert.equal(parseDate('next friday', c), '2026-11-27');
  assert.equal(parseDate('in 2 weeks', c), '2026-12-06');
  assert.deepEqual(parseWhen('tomorrow 3pm', c), { date: '2026-11-23', time: '15:00' });
  assert.equal(parseTime('5pm', c), '17:00');
  assert.deepEqual(parseRepeat('every 2 weeks', c, '2026-11-23').rule, { freq: 'week', interval: 2, days: [1] });
  for (const phrase of ['in 381894475 years', 'Party 5/1/0491', '0392-3-1']) assert.throws(() => parseDate(phrase, c), ToolError, phrase);
});

test('create_tasks and create_events with text never store a date the validators would drop', async () => {
  const dataDir = tempDir('ecosys-hard-nlp-');
  const core = await createCore({ dataDir, log: captureLog() });
  core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cal1', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
  const client = core.ai.createClient({ kind: 'claude' });
  const phrases = ['Party 5/1/0491', 'Party 0392-3-1', 'Trip in 381894475 years', 'Trip in 8000 years', 'Party 28 january 0058', 'Party 2/29/2026', 'Water plants every 1000 days', '2/9/0211 weekly', 'Dentist tomorrow 3pm', 'Pay rent the 30th'];
  const tasks = core.callTool('create_tasks', { tasks: phrases.map((text) => ({ text })), allow_duplicates: true }, { client });
  assert.equal(tasks.isError, false, tasks.content[0].text);
  for (const t of core.store.all('tasks')) {
    for (const f of ['date', 'deadline']) assert.ok(t[f] === null || validYmd(t[f]), `${t.title}: ${f} ${t[f]}`);
    if (t.repeat) assert.ok(t.repeat.interval >= 1 && t.repeat.interval <= 99 && (t.repeat.days || []).every((d) => Number.isInteger(d)), `${t.title}: ${JSON.stringify(t.repeat)}`);
  }
  for (const f of tasks.structuredContent.failed) assert.match(f.error, /YYYY-MM-DD|HH:MM|1 to 99/, f.error);
  const events = core.callTool('create_events', { events: phrases.map((text) => ({ text, calendar: 'Personal' })), allow_duplicates: true }, { client });
  for (const e of core.store.all('events')) {
    assert.ok(validYmd(e.start.slice(0, 10)) && validYmd(e.end.slice(0, 10)), `${e.title}: ${e.start} - ${e.end}`);
  }
  if (events.structuredContent) for (const f of events.structuredContent.failed) assert.ok(f.error.length > 10, f.error);
  core.close();
});
