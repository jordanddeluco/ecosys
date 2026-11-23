// HTTP server: static hardening, Host/Origin checks, browser sync API, SSE, AI connection API and
// the Claude Desktop installer (server/http.mjs, server/static.mjs, server/install.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { duplexPair } from 'node:stream';
import { mkdtempSync as mkdtemp, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { createEcosysServer, parseAllowedHosts, createLimiter, isLoopbackAddr } from '../server/http.mjs';
import { claudeDesktopConfigPaths } from '../server/install.mjs';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const made = [];
const mkdtempSync = (prefix) => {
  const d = mkdtemp(prefix);
  made.push(d);
  return d;
};

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

/** port → the pairing secret of the server on it (its data folder's pair.json, as a browser gets it from the pairing link). */
const secrets = new Map();

async function start(opts = {}, listenOn = '127.0.0.1') {
  const dataDir = mkdtempSync(join(tmpdir(), 'ecosys-http-'));
  const core = await createCore({ dataDir, log: silent });
  const port = await freePort();
  const app = createEcosysServer({ core, port, log: silent, ...opts });
  await new Promise((r) => app.server.listen(port, listenOn, r));
  const secret = JSON.parse(readFileSync(join(dataDir, 'pair.json'), 'utf8')).secret;
  secrets.set(port, secret);
  return { core, app, port, dataDir, secret };
}

/** `connect` is the address the socket goes to; `host` is the Host header (default: the local one). */
function req(port, { method = 'GET', path = '/', headers = {}, body, host, connect = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request(
      { host: connect, port, method, path, headers: { host: host ?? `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
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
      },
    );
    r.on('error', reject);
    r.end(data || undefined);
  });
}
/** A browser-API call as a paired tab (X-Ecosys: the server's pairing secret). */
const api = (port, method, path, body, headers = {}) => req(port, { method, path, body, headers: { 'x-ecosys': secrets.get(port), ...headers } });

/**
 * Feed one raw HTTP request into the server as if it arrived from `remoteAddress` (for example a
 * phone on the LAN), whatever network this machine has.
 */
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

const RPC_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const LAN_IP = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

/** Open an SSE stream and collect events. */
function sse(port, client) {
  const events = [];
  let resolveWait = null;
  let waitFor = null;
  const r = http.get({ host: '127.0.0.1', port, path: `/api/events?client=${client}`, headers: { host: `127.0.0.1:${port}`, 'x-ecosys': secrets.get(port) } }, (res) => {
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
        if (ev) {
          events.push({ event: ev, data: JSON.parse(data) });
          if (waitFor && waitFor(events[events.length - 1])) {
            waitFor = null;
            resolveWait();
          }
        }
      }
    });
  });
  return {
    events,
    headers: new Promise((r2) => r.on('response', (res) => r2(res.headers))),
    wait(pred, ms = 2000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timed out waiting for SSE event')), ms);
        waitFor = pred;
        resolveWait = () => {
          clearTimeout(t);
          res(events.find(pred));
        };
      });
    },
    close: () => r.destroy(),
  };
}

let s;
before(async () => {
  s = await start({ allowedHosts: parseAllowedHosts('abc.trycloudflare.com, .ngrok-free.dev') });
});
after(async () => {
  await s.app.close();
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// ------------------------------------------------------------------ static files

test('static pages carry the security headers and a strict CSP', async () => {
  const r = await req(s.port, { path: '/tasks/' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(r.headers['cache-control'], 'no-cache');
  const csp = r.headers['content-security-policy'];
  for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-eval/.test(csp));
  const err = await req(s.port, { path: '/nope' });
  assert.equal(err.status, 404);
  assert.equal(err.headers['x-content-type-options'], 'nosniff', 'errors get the headers too');
});

test('inline scripts still on a page are allowed by exact hash only', async () => {
  const r = await req(s.port, { path: '/' });
  assert.equal(r.status, 200);
  const inline = /<script(?![^>]*\bsrc=)[^>]*>/i.test(r.text);
  const csp = r.headers['content-security-policy'];
  assert.equal(/'sha256-[A-Za-z0-9+/=]+'/.test(csp), inline);
  assert.ok(!csp.includes("'unsafe-inline' ;") && !/script-src[^;]*unsafe-inline/.test(csp));
});

test('path traversal, dotfiles, NTFS streams and 8.3 names are refused', async () => {
  const cases = [
    '/%5C.git%5Cconfig',
    '/tasks%5C..%5C.git%5CHEAD',
    '/GIT~1/config',
    '/GITIGN~1',
    '/index.html::$DATA',
    '/.git/config',
    '/.ecosys/data.json',
    '/.ecosys/ai.json',
    '/%2e%2e/%2e%2e/Windows/win.ini',
    '/tasks/..%2f..%2f.git/HEAD',
    '/x%5C..%5C..%5C..%5CWindows%5Cwin.ini',
    '/server/core.mjs',
    '/mcp/stdio-bridge.mjs',
    '/package.json',
    '/node_modules/x.js',
    '/tests/server-http.test.js',
    '/tasks/%00.html',
  ];
  for (const path of cases) {
    const r = await req(s.port, { path });
    assert.ok(r.status === 400 || r.status === 404, `${path} -> ${r.status}`);
    assert.ok(!/\[core\]|ref: refs|"token"/.test(r.text), `${path} leaked`);
  }
});

test('malformed percent-encoding is a 400, not a 500', async () => {
  for (const path of ['/%', '/%E0%A4%A', '/tasks/%ZZ']) assert.equal((await req(s.port, { path })).status, 400, path);
});

test('directory redirects stay on this origin (no open redirect)', async () => {
  const r = await req(s.port, { path: '/tasks?x=1' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/tasks/?x=1');
  for (const path of ['/%2Ftasks', '/%5Cevil.example%5C..%5Ctasks', '//evil.example/tasks', '/%2F%2Fevil.example']) {
    const x = await req(s.port, { path });
    const loc = x.headers.location;
    assert.ok(!loc || (loc.startsWith('/') && !loc.startsWith('//') && !loc.includes('\\')), `${path} -> ${loc}`);
  }
});

test('HEAD, ETag revalidation and 405 for other methods', async () => {
  const head = await req(s.port, { method: 'HEAD', path: '/shared/ui.css' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  const again = await req(s.port, { path: '/shared/ui.css', headers: { 'if-none-match': head.headers.etag } });
  assert.equal(again.status, 304);
  const post = await req(s.port, { method: 'POST', path: '/', body: '{}' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

// ------------------------------------------------------------------ Host allowlist

test('unknown Host headers are refused (DNS rebinding)', async () => {
  for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, `192.168.1.5:${s.port}`, `localhost.evil.example:${s.port}`]) {
    const r = await req(s.port, { path: '/', host });
    assert.equal(r.status, 403, `host ${JSON.stringify(host)} -> ${r.status}`);
  }
  // No Host header at all (HTTP/1.0)
  const raw = await new Promise((resolve) => {
    const sock = net.connect(s.port, '127.0.0.1', () => sock.end('GET / HTTP/1.0\r\n\r\n'));
    let out = '';
    sock.on('data', (c) => (out += c));
    sock.on('close', () => resolve(out));
  });
  assert.match(raw, /^HTTP\/1\.[01] 403/);
  for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`]) assert.equal((await req(s.port, { path: '/', host })).status, 200, host);
});

test('tunnel hosts reach only the MCP endpoint', async () => {
  for (const host of ['abc.trycloudflare.com', 'x.ngrok-free.dev']) {
    assert.equal((await req(s.port, { path: '/', host })).status, 404, `${host} static`);
    assert.equal((await api(s.port, 'GET', '/api/state', undefined, { host })).status, 404, `${host} api`);
    assert.equal((await req(s.port, { method: 'POST', path: '/mcp', host, body: '{}' })).status, 401, `${host} mcp`);
  }
  assert.equal((await req(s.port, { path: '/', host: 'ngrok-free.dev' })).status, 403, 'a suffix entry matches subdomains only');
  // Origin through a tunnel: https web origins pass to the credential check; plain http is refused.
  const host = 'abc.trycloudflare.com';
  assert.equal((await req(s.port, { method: 'POST', path: '/mcp', host, body: '{}', headers: { origin: 'https://claude.ai' } })).status, 401);
  assert.equal((await req(s.port, { method: 'POST', path: '/mcp', host, body: '{}', headers: { origin: 'http://evil.example' } })).status, 403);
  // On local hosts only ecosys itself may be the Origin.
  assert.equal((await req(s.port, { method: 'POST', path: '/mcp', body: '{}', headers: { origin: 'http://localhost:3000' } })).status, 403);
  assert.deepEqual(parseAllowedHosts(' https://A.example.com/ , localhost, 127.0.0.1:4300, , bad host'), ['a.example.com']);
});

test('LAN mode serves the apps by IP but never the API or MCP', async () => {
  const lan = await start({ host: '0.0.0.0' });
  try {
    const host = `192.168.1.20:${lan.port}`;
    const c = lan.core.ai.createClient({ kind: 'claude' });
    assert.equal((await req(lan.port, { path: '/tasks/', host })).status, 200);
    assert.equal((await api(lan.port, 'GET', '/api/state', undefined, { host })).status, 404);
    // A key sent from another device would cross the network as plain HTTP.
    const viaLan = await req(lan.port, { method: 'POST', path: '/mcp', host, headers: { authorization: `Bearer ${c.token}` }, body: RPC_LIST });
    assert.equal(viaLan.status, 404);
    assert.ok(!viaLan.text.includes('get_overview'));
    assert.equal((await req(lan.port, { method: 'POST', path: `/s/${c.token}/mcp`, host, body: RPC_LIST })).status, 404);
    assert.equal((await req(lan.port, { method: 'POST', path: '/mcp', host: `[fd00::5]:${lan.port}`, headers: { authorization: `Bearer ${c.token}` }, body: RPC_LIST })).status, 404);
    // The same key keeps working on this computer.
    assert.equal((await req(lan.port, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${c.token}` }, body: RPC_LIST })).status, 200);
    assert.equal((await req(lan.port, { path: '/', host: `myhost.local:${lan.port}` })).status, 403);
  } finally {
    await lan.app.close();
  }
});

test('connection addresses: loopback in every spelling, nothing else', () => {
  for (const a of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) assert.equal(isLoopbackAddr(a), true, a);
  for (const a of ['192.168.1.84', '::ffff:192.168.1.84', '10.0.0.1', 'fe80::1', '0.0.0.0', '::', '127.0.0.1.evil', '1127.0.0.1', '', undefined, null]) assert.equal(isLoopbackAddr(a), false, String(a));
});

test('a local Host name sent by another device gets nothing (Host spoofing)', async () => {
  const lan = await start({ host: '0.0.0.0' });
  try {
    const c = lan.core.ai.createClient({ kind: 'claude' });
    for (const from of ['192.168.1.84', '::ffff:192.168.1.84', '10.0.0.7', 'fe80::1', '2001:db8::7']) {
      for (const host of [`127.0.0.1:${lan.port}`, `localhost:${lan.port}`, `[::1]:${lan.port}`]) {
        const keys = await rawFrom(lan.app, from, { path: '/api/ai', headers: { host, 'x-ecosys': lan.secret } });
        assert.equal(keys.status, 403, `${from} as ${host}`);
        assert.ok(!keys.text.includes(c.token), 'no connection key leaks');
      }
      const body = JSON.stringify({ mode: 'off' });
      const mode = await rawFrom(lan.app, from, { method: 'POST', path: '/api/ai/mode', headers: { host: `127.0.0.1:${lan.port}`, 'x-ecosys': lan.secret, 'content-type': 'application/json' }, body });
      assert.equal(mode.status, 403, from);
      const mcp = await rawFrom(lan.app, from, { method: 'POST', path: '/mcp', headers: { host: `127.0.0.1:${lan.port}`, authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify(RPC_LIST) });
      assert.equal(mcp.status, 403, from);
      assert.equal((await rawFrom(lan.app, from, { path: '/tasks/', headers: { host: `127.0.0.1:${lan.port}` } })).status, 403, from);
    }
    assert.equal(lan.core.ai.mode(), 'write', 'the mode did not change');
    // Connections from this computer, as a dual-stack listener reports them, are local.
    for (const from of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal((await rawFrom(lan.app, from, { path: '/api/state', headers: { host: `127.0.0.1:${lan.port}`, 'x-ecosys': lan.secret } })).status, 200, from);
    }
  } finally {
    await lan.app.close();
  }
});

test('over a real network connection, a spoofed Host gets nothing', { skip: !LAN_IP && 'this machine has no LAN IPv4 address' }, async () => {
  const lan = await start({ host: '0.0.0.0' }, '0.0.0.0');
  try {
    const c = lan.core.ai.createClient({ kind: 'claude' });
    const spoof = { connect: LAN_IP, host: `127.0.0.1:${lan.port}` };
    const keys = await req(lan.port, { ...spoof, path: '/api/ai', headers: { 'x-ecosys': lan.secret } });
    assert.equal(keys.status, 403);
    assert.ok(!keys.text.includes(c.token));
    assert.equal((await req(lan.port, { ...spoof, method: 'POST', path: '/api/ai/mode', headers: { 'x-ecosys': lan.secret }, body: { mode: 'read' } })).status, 403);
    assert.equal(lan.core.ai.mode(), 'write');
    const honest = { connect: LAN_IP, host: `${LAN_IP}:${lan.port}` };
    assert.equal((await req(lan.port, { ...honest, path: '/tasks/' })).status, 200, 'the apps are on the network');
    assert.equal((await api(lan.port, 'GET', '/api/state', undefined, { host: honest.host })).status, 404);
    assert.equal((await req(lan.port, { ...honest, method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${c.token}` }, body: RPC_LIST })).status, 404);
    assert.equal((await req(lan.port, { ...honest, method: 'POST', path: `/s/${c.token}/mcp`, body: RPC_LIST })).status, 404);
  } finally {
    await lan.app.close();
  }
});

test('a request relayed by a proxy or tunnel on this computer reaches only MCP, even with a local Host', async () => {
  const c = s.core.ai.createClient({ kind: 'claude' });
  try {
    for (const relay of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-forwarded-host': 'abc.example' }, { 'x-real-ip': '203.0.113.9' }, { 'cf-connecting-ip': '203.0.113.9' }, { via: '1.1 tunnel' }]) {
      const name = Object.keys(relay)[0];
      const keys = await api(s.port, 'GET', '/api/ai', undefined, relay);
      assert.equal(keys.status, 404, name);
      assert.ok(!keys.text.includes(c.token), name);
      assert.equal((await api(s.port, 'POST', '/api/ai/mode', { mode: 'off' }, relay)).status, 404, name);
      assert.equal((await req(s.port, { path: '/tasks/', headers: relay })).status, 404, name);
    }
    assert.equal(s.core.ai.mode(), 'write');
    // Like any tunnel, the MCP endpoint still answers (with a key).
    const r = await req(s.port, { method: 'POST', path: '/mcp', headers: { 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${c.token}` }, body: RPC_LIST });
    assert.equal(r.status, 200);
    assert.ok(r.json.result.tools.some((t) => t.name === 'get_overview'));
    assert.equal((await req(s.port, { method: 'POST', path: '/mcp', headers: { 'x-forwarded-for': '203.0.113.9' }, body: RPC_LIST })).status, 401);
  } finally {
    s.core.ai.deleteClient(c.id);
  }
});

test('rate limiter: refused hits are not counted, so hammering a key costs nothing extra', () => {
  let t = 0;
  const lim = createLimiter(3, 1000, () => t);
  assert.deepEqual([lim.hit('a'), lim.hit('a'), lim.hit('a')], [false, false, false]);
  for (let i = 0; i < 10000; i++) assert.equal(lim.hit('a'), true);
  assert.equal(lim.size('a'), 3, 'never more than `limit` timestamps per key');
  assert.equal(lim.hit('b'), false, 'keys are counted separately');
  t = 999;
  assert.equal(lim.hit('a'), true, 'refused hits did not extend the window');
  t = 1000;
  assert.equal(lim.hit('a'), false, 'the window slid past the first hits');
  t = 5000;
  lim.sweep();
  assert.equal(lim.size('a'), 0);
  assert.equal(lim.size('b'), 0);
});

test('failed key checks are throttled after 30 a minute', async () => {
  const fresh = await start();
  try {
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await req(fresh.port, { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer nope' }, body: RPC_LIST })).status);
    assert.deepEqual(statuses, [...Array(30).fill(401), ...Array(10).fill(429)]);
  } finally {
    await fresh.app.close();
  }
});

// ------------------------------------------------------------------ browser API

test('browser API needs the pairing secret and same-origin', async () => {
  // /api/hello is public, and says only whether the request was paired.
  const open = await req(s.port, { path: '/api/hello' });
  assert.equal(open.status, 200);
  assert.deepEqual(open.json, { ok: true, app: 'ecosys', version: s.core.version, features: ['sync', 'mcp'], paired: false });
  assert.equal((await req(s.port, { path: '/api/hello', headers: { 'x-ecosys': '1' } })).json.paired, false, 'the header from before pairing');
  const ok = await api(s.port, 'GET', '/api/hello');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, app: 'ecosys', version: s.core.version, features: ['sync', 'mcp'], paired: true });
  // Every other route needs the secret: 403 {"error":"pairing_required"}.
  for (const headers of [{}, { 'x-ecosys': '1' }, { 'x-ecosys': `${s.secret}x` }, { 'x-ecosys': s.secret.slice(1) }]) {
    const r = await req(s.port, { path: '/api/state', headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.deepEqual(r.json, { error: 'pairing_required' });
  }
  assert.equal((await api(s.port, 'GET', '/api/hello', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await api(s.port, 'GET', '/api/state', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await api(s.port, 'GET', '/api/state', undefined, { origin: `http://localhost:${s.port}` })).status, 200);
  assert.equal((await api(s.port, 'GET', '/api/state', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await api(s.port, 'GET', '/api/state', undefined, { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await api(s.port, 'GET', '/api/nope')).status, 404);
  assert.equal((await req(s.port, { path: '/api/nope' })).status, 403, 'unpaired: not even whether a route exists');
  assert.equal((await api(s.port, 'PUT', '/api/ops', {})).status, 405);
});

test('first-run import, then state; a second import is refused', async () => {
  const st = await api(s.port, 'GET', '/api/state');
  assert.equal(st.json.initialized, false);
  assert.deepEqual(Object.keys(st.json.data).sort(), ['calendars', 'events', 'folders', 'lists', 'notes', 'tasks']);
  const imp = await api(s.port, 'POST', '/api/import', {
    data: { tasks: [{ id: 't1', title: 'Hello', createdAt: 1, updatedAt: 1 }, { id: '<bad>', title: 'x' }], calendars: [{ id: 'c1', name: 'Personal', color: 'iris' }] },
    settings: { theme: 'dark', hacked: true },
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.dropped, 1);
  const st2 = await api(s.port, 'GET', '/api/state');
  assert.equal(st2.json.initialized, true);
  assert.equal(st2.json.rev, imp.json.rev);
  assert.equal(st2.json.settings.theme, 'dark');
  assert.equal(st2.json.settings.hacked, undefined);
  const again = await api(s.port, 'POST', '/api/import', { data: { tasks: [] } });
  assert.equal(again.status, 409);
  assert.equal(again.json.rev, imp.json.rev);
});

test('malformed and oversized bodies', async () => {
  assert.equal((await api(s.port, 'POST', '/api/ops', '{"ops": [')).status, 400);
  assert.equal((await api(s.port, 'POST', '/api/ops', '[1,2]')).status, 400);
  const big = JSON.stringify({ ops: [{ op: 'put', c: 'tasks', item: { id: 'big', title: 'x'.repeat(2.1 * 1024 * 1024) } }] });
  assert.equal((await api(s.port, 'POST', '/api/ops', big)).status, 413);
});

test('ops sync between tabs over SSE (sender excluded)', async () => {
  const a = sse(s.port, 'tabA');
  const b = sse(s.port, 'tabB');
  try {
    const h = await a.headers;
    assert.match(h['content-type'], /text\/event-stream/);
    assert.equal(h['cache-control'], 'no-cache');
    assert.equal(h['x-accel-buffering'], 'no');
    await a.wait((e) => e.event === 'ai' && e.data.type === 'status');
    const r = await api(s.port, 'POST', '/api/ops', {
      client: 'tabA',
      baseRev: 1,
      ops: [
        { op: 'put', c: 'tasks', item: { id: 't2', title: 'From A', createdAt: 1, updatedAt: 1 } },
        { op: 'put', c: 'nope', item: { id: 'x' } },
        { op: 'del', c: 'tasks', id: 't1' },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.applied, 2);
    assert.equal(r.json.rejected.length, 1);
    const got = await b.wait((e) => e.event === 'ops');
    assert.equal(got.data.origin, 'tabA');
    assert.equal(got.data.rev, r.json.rev);
    assert.deepEqual(got.data.ops.map((o) => o.op), ['put', 'del']);
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(!a.events.some((e) => e.event === 'ops'), 'the sender does not get its own ops back');
  } finally {
    a.close();
    b.close();
  }
});

test('an external write to data.json reaches browsers as a snapshot event', async () => {
  const tab = sse(s.port, 'tabC');
  try {
    await tab.wait((e) => e.event === 'ai');
    const file = join(s.dataDir, 'data.json');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    disk.rev += 1;
    disk.data.tasks.push({ id: 'ext1', title: 'Edited elsewhere', createdAt: 1, updatedAt: 1 });
    writeFileSync(file, JSON.stringify(disk));
    const ev = await tab.wait((e) => e.event === 'snapshot', 4000);
    assert.equal(ev.data.rev, disk.rev);
    const st = await api(s.port, 'GET', '/api/state');
    assert.ok(st.json.data.tasks.some((t) => t.id === 'ext1'));
  } finally {
    tab.close();
  }
});

test('internal notify: needs a key, relays only ops that match the disk', async () => {
  const tab = sse(s.port, 'tabN');
  try {
    await tab.wait((e) => e.event === 'ai');
    const c = s.core.ai.createClient({ kind: 'claude' });
    assert.equal((await api(s.port, 'POST', '/api/internal/notify', { events: [] })).status, 401);
    assert.equal((await api(s.port, 'POST', '/api/internal/notify', { events: [] }, { authorization: 'Bearer nope' })).status, 401);
    // Another process writes a real change, then notifies with it plus a made-up one.
    const other = new (await import('../server/store.mjs')).DataStore({ dir: s.dataDir, validators: s.core.validators });
    const { ops, rev } = other.transaction((tx) => tx.put('tasks', { id: 'real1', title: 'Real', createdAt: 1, updatedAt: 1 }));
    const fake = { op: 'put', c: 'tasks', item: { id: 'fake1', title: 'Made up', createdAt: 1, updatedAt: 1 } };
    const r = await api(s.port, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev, ops: [...ops, fake] } }] }, { authorization: `Bearer ${c.token}` });
    assert.equal(r.status, 200);
    const ev = await tab.wait((e) => (e.event === 'snapshot' || e.event === 'ops') && e.data.rev === rev);
    assert.equal(ev.event, 'snapshot', 'made-up ops are never relayed');
    // A clean notify is relayed as ops.
    const second = other.transaction((tx) => tx.put('tasks', { id: 'real2', title: 'Real 2', createdAt: 1, updatedAt: 1 }));
    await api(s.port, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev: second.rev, ops: second.ops } }] }, { authorization: `Bearer ${c.token}` });
    const ev2 = await tab.wait((e) => (e.event === 'snapshot' || e.event === 'ops') && e.data.rev === second.rev);
    assert.equal(ev2.event, 'ops');
    assert.equal(ev2.data.origin, `ai:${c.id}`);
  } finally {
    tab.close();
  }
});

// ------------------------------------------------------------------ AI connection API

test('AI connections: create, list (with key and secret path), change, rotate, delete, mode', async () => {
  const c = await api(s.port, 'POST', '/api/ai/clients', { kind: 'chatgpt', access: 'read' });
  assert.equal(c.status, 200);
  const cl = c.json.client;
  assert.equal(cl.kind, 'chatgpt');
  assert.equal(cl.label, 'ChatGPT');
  assert.equal(cl.access, 'read');
  assert.match(cl.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(cl.secretPath, `/s/${cl.token}/mcp`);
  assert.equal((await api(s.port, 'POST', '/api/ai/clients', { kind: 'hal' })).status, 400);
  const all = await api(s.port, 'GET', '/api/ai');
  assert.equal(all.json.mode, 'write');
  assert.equal(all.json.localUrl, `http://127.0.0.1:${s.port}/mcp`);
  assert.deepEqual(all.json.publicUrls, ['https://abc.trycloudflare.com/mcp']);
  assert.ok(all.json.bridgePath.endsWith(join('mcp', 'stdio-bridge.mjs')));
  assert.equal(all.json.nodePath, process.execPath);
  assert.ok(all.json.clients.some((x) => x.id === cl.id && x.token === cl.token));
  const up = await api(s.port, 'POST', `/api/ai/clients/${cl.id}`, { access: 'write', rotate: true });
  assert.equal(up.json.client.access, 'write');
  assert.notEqual(up.json.client.token, cl.token);
  assert.equal((await api(s.port, 'POST', '/api/ai/mode', { mode: 'read' })).json.mode, 'read');
  assert.equal((await api(s.port, 'POST', '/api/ai/mode', { mode: 'chaos' })).status, 400);
  await api(s.port, 'POST', '/api/ai/mode', { mode: 'write' });
  assert.equal((await api(s.port, 'DELETE', `/api/ai/clients/${cl.id}`)).status, 200);
  assert.equal((await api(s.port, 'DELETE', `/api/ai/clients/${cl.id}`)).status, 404);
  assert.equal((await api(s.port, 'DELETE', '/api/ai/clients/..%2F..')).status, 404);
  // The key file is never served.
  assert.equal((await req(s.port, { path: '/.ecosys/ai.json' })).status, 404);
});

test('undo from the browser', async () => {
  const c = s.core.ai.createClient({ kind: 'claude' });
  const r = s.core.callTool('create_tasks', { tasks: [{ title: 'Undo me via API' }] }, { client: c });
  const changeId = r.structuredContent.change_id;
  const u = await api(s.port, 'POST', '/api/ai/undo', { changeId });
  assert.equal(u.status, 200);
  assert.equal(u.json.restored, 1);
  assert.equal((await api(s.port, 'POST', '/api/ai/undo', { changeId })).status, 409);
  assert.equal((await api(s.port, 'POST', '/api/ai/undo', { changeId: 'nope' })).status, 409);
});

test('Claude Desktop install merges the config, keeps other keys and makes a backup', async () => {
  const appdata = mkdtempSync(join(tmpdir(), 'ecosys-claude-'));
  const dir = join(appdata, 'Claude');
  mkdirSync(dir);
  const cfg = join(dir, 'claude_desktop_config.json');
  writeFileSync(cfg, '\uFEFF' + JSON.stringify({ preferences: { x: 1 }, mcpServers: { other: { command: 'foo' } } }));
  const inst = await start({ installPaths: [cfg] });
  try {
    const r = await api(inst.port, 'POST', '/api/ai/install/claude-desktop', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.path, cfg);
    const out = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.deepEqual(out.preferences, { x: 1 });
    assert.deepEqual(out.mcpServers.other, { command: 'foo' });
    assert.equal(out.mcpServers.ecosys.command, process.execPath);
    assert.ok(out.mcpServers.ecosys.args[0].endsWith(join('mcp', 'stdio-bridge.mjs')));
    assert.equal(out.mcpServers.ecosys.args[1], '--client');
    assert.equal(out.mcpServers.ecosys.args[2], r.json.clientId);
    const client = inst.core.ai.get(r.json.clientId);
    assert.equal(client.kind, 'claude');
    assert.equal(client.label, 'Claude Desktop');
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.bak')).length, 1);
    // Re-install with the same connection: still one ecosys entry.
    const again = await api(inst.port, 'POST', '/api/ai/install/claude-desktop', { clientId: r.json.clientId });
    assert.equal(again.status, 200);
    assert.equal(Object.keys(JSON.parse(readFileSync(cfg, 'utf8')).mcpServers).length, 2);
    const third = await api(inst.port, 'POST', '/api/ai/install/claude-desktop', {});
    assert.equal(third.json.clientId, r.json.clientId, 'reinstalling reuses the Claude Desktop connection');
    assert.equal(inst.core.ai.state.clients.length, 1);
    // Broken JSON is left alone.
    writeFileSync(cfg, '{ broken');
    const bad = await api(inst.port, 'POST', '/api/ai/install/claude-desktop', { clientId: r.json.clientId });
    assert.equal(bad.status, 422);
    assert.equal(readFileSync(cfg, 'utf8'), '{ broken');
  } finally {
    await inst.app.close();
  }
  const missing = await start({ installPaths: [join(appdata, 'NoClaude', 'claude_desktop_config.json')] });
  try {
    const r = await api(missing.port, 'POST', '/api/ai/install/claude-desktop', {});
    assert.equal(r.status, 404);
    assert.match(r.json.error, /does not seem to be installed/);
    assert.ok(!existsSync(join(appdata, 'NoClaude')), 'no folders are created');
  } finally {
    await missing.app.close();
  }
});

test('Claude Desktop config locations per OS', () => {
  assert.equal(claudeDesktopConfigPaths({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: join(tmpdir(), 'no-such-local') }, home: 'C:\\Users\\u' })[0], join('C:\\Users\\u\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.equal(claudeDesktopConfigPaths({ platform: 'darwin', env: {}, home: '/Users/u' })[0], join('/Users/u', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal(claudeDesktopConfigPaths({ platform: 'linux', env: {}, home: '/home/u' })[0], join('/home/u', '.config', 'Claude', 'claude_desktop_config.json'));
});
