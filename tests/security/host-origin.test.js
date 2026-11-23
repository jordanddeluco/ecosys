// Who can reach what (server/http.mjs classify()): the Host allowlist against DNS rebinding,
// tunnels (MCP only), proxies that relay for others (forwarding headers), LAN mode (apps only) and
// loopback Host names sent from another device. Remote addresses are simulated by a wrapper server
// (see startWrapped in _harness.js), so nothing here listens beyond 127.0.0.1.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedHosts } from '../../server/http.mjs';
import { createScope, startServer, startWrapped, request, rawHttp, PING, bearer, leaked } from './_harness.js';

const TUNNELS = 'abc.trycloudflare.com, .ngrok-free.dev';
const FORWARD_HEADERS = {
  forwarded: 'for=203.0.113.9;proto=https',
  'x-forwarded-for': '203.0.113.9',
  'x-forwarded-host': 'abc.trycloudflare.com',
  'x-forwarded-proto': 'https',
  'x-real-ip': '203.0.113.9',
  'cf-connecting-ip': '203.0.113.9',
  'true-client-ip': '203.0.113.9',
  via: '1.1 cloudflared',
};

describe('Host allowlist, DNS rebinding, tunnels and LAN mode', () => {
  const scope = createScope('host');
  let s;
  let tok;
  let lan;
  let lanTok;
  let nolan;
  let p80;
  before(async () => {
    s = await startServer(scope, { allowedHosts: TUNNELS });
    tok = s.core.ai.createClient({ kind: 'claude' }).token;
    lan = await startWrapped(scope, { host: '0.0.0.0' });
    lanTok = lan.core.ai.createClient({ kind: 'claude' }).token;
    nolan = await startWrapped(scope, { host: '127.0.0.1' });
    p80 = await startWrapped(scope, { host: '127.0.0.1', appPort: 80 });
  });
  after(() => scope.cleanup());

  /**
   * One request per route; SSE only waits for the headers. API routes carry the server's real pairing
   * secret (`srv.secret`), so what refuses them below is the Host and route rules, not pairing.
   */
  const routes = (key, srv) => [
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/tasks/' },
    { method: 'GET', path: '/api/hello', headers: { 'x-ecosys': srv.secret } },
    { method: 'GET', path: '/api/ai', headers: { 'x-ecosys': srv.secret } },
    { method: 'GET', path: '/api/state', headers: { 'x-ecosys': srv.secret } },
    { method: 'GET', path: '/api/events?client=x', headers: { 'x-ecosys': srv.secret }, headersOnly: true },
    { method: 'POST', path: '/api/ops', headers: { 'x-ecosys': srv.secret }, body: { ops: [] } },
    { method: 'POST', path: '/mcp', headers: bearer(key), body: PING },
    { method: 'POST', path: `/s/${key}/mcp`, body: PING },
    { method: 'GET', path: '/.well-known/oauth-protected-resource' },
  ];
  const send = (srv, r, host, extra = {}) => request(srv.port, { ...r, host, headers: { ...(r.headers || {}), ...extra } });

  test('foreign and look-alike Host values are refused on every route (DNS rebinding)', async () => {
    const P = s.port;
    const hosts = [
      'evil.example', `evil.example:${P}`, `127.0.0.1:${P + 1}`, `localhost:${P + 1}`, `[::1]:${P + 1}`, '127.0.0.1', 'localhost', '[::1]',
      `localhost.:${P}`, `127.0.0.1.:${P}`, `127.1:${P}`, `0x7f.0.0.1:${P}`, `2130706433:${P}`, `0177.0.0.1:${P}`, `0.0.0.0:${P}`,
      `[::ffff:127.0.0.1]:${P}`, `[0:0:0:0:0:0:0:1]:${P}`, `127.0.0.1:0${P}`, `127.0.0.1:${P}.evil.example`, `127.0.0.1.nip.io:${P}`,
      `localhost.evil.example:${P}`, `app.localhost:${P}`, `127.0.0.1:${P}@evil.example`, `evil.example@127.0.0.1:${P}`, `127.0.0.1:${P}, evil.example`,
      `xn--80ak6aa92e.com:${P}`, `${'a'.repeat(300)}.example:${P}`, `127.0.0.1:${P}/`, `127.0.0.1:${P}:${P}`,
    ];
    for (const host of hosts) {
      for (const r of routes(tok, s)) {
        const res = await send(s, r, host);
        assert.equal(res.status, 403, `Host ${JSON.stringify(host)} ${r.method} ${r.path} -> ${res.status}`);
        assert.deepEqual(leaked(res.text, [tok]), []);
        assert.ok(!res.json?.result, 'no MCP result');
      }
    }
    // the allowed local names still work (and Host is case-insensitive)
    for (const host of [`127.0.0.1:${P}`, `localhost:${P}`, `[::1]:${P}`, `LOCALHOST:${P}`]) {
      assert.equal((await request(P, { path: '/api/state', host, headers: { 'x-ecosys': s.secret } })).status, 200, host);
    }
  });

  test('requests without a usable Host header are refused', async () => {
    assert.equal((await rawHttp(s.port, { target: '/', host: null, version: '1.0' })).status, 403, 'HTTP/1.0 without Host');
    const h11 = (await rawHttp(s.port, { target: '/api/hello', host: null, headers: [['X-Ecosys', s.secret]] })).status;
    assert.ok(h11 === 400 || h11 === 403, `HTTP/1.1 without Host -> ${h11}`);
    for (const host of ['', ' ']) assert.equal((await rawHttp(s.port, { target: '/api/hello', host, headers: [['X-Ecosys', s.secret]] })).status, 403, `Host ${JSON.stringify(host)}`);
  });

  test('more than one Host header is refused, whichever one comes first (RFC 9112 section 3.2)', async () => {
    const local = `127.0.0.1:${s.port}`;
    const evilFirst = await rawHttp(s.port, { target: '/api/hello', host: null, headers: [['Host', 'evil.example'], ['Host', local], ['X-Ecosys', s.secret]] });
    assert.ok(evilFirst.status === 400 || evilFirst.status === 403, `foreign Host first -> ${evilFirst.status}`);
    // Node keeps only the first Host header, so a foreign second one is silently ignored today.
    const localFirst = await rawHttp(s.port, { target: '/api/hello', host: null, headers: [['Host', local], ['Host', 'evil.example'], ['X-Ecosys', s.secret]] });
    assert.ok(localFirst.status === 400 || localFirst.status === 403, `local Host first, foreign Host second -> ${localFirst.status} (expected 400)`);
  });

  test('requests relayed by a proxy or tunnel to a local Host reach only MCP', async () => {
    for (const [name, value] of Object.entries(FORWARD_HEADERS)) {
      const extra = { [name]: value };
      for (const r of routes(tok, s)) {
        const res = await send(s, r, undefined, extra);
        const isMcp = r.path === '/mcp' || r.path.startsWith('/s/');
        if (isMcp) assert.equal(res.status, 200, `${name}: ${r.path} with a key -> ${res.status}`);
        else assert.equal(res.status, 404, `${name}: ${r.method} ${r.path} -> ${res.status}`);
        if (r.path === '/api/ai') assert.deepEqual(leaked(res.text, [tok]), []);
      }
      assert.equal((await request(s.port, { method: 'POST', path: '/mcp', body: PING, headers: extra })).status, 401, `${name}: MCP still needs a key`);
    }
    // even an empty forwarding header counts
    const empty = await rawHttp(s.port, { target: '/api/ai', headers: [['X-Ecosys', s.secret], ['X-Forwarded-For', '']] });
    assert.equal(empty.status, 404);
    assert.deepEqual(leaked(empty.text, [tok]), []);
  });

  test('tunnel hosts reach only the MCP endpoint', async () => {
    const tunnelHosts = ['abc.trycloudflare.com', 'ABC.TryCloudflare.com', 'abc.trycloudflare.com:443', 'x.ngrok-free.dev', 'a.b.ngrok-free.dev'];
    const notMcp = [
      { method: 'GET', path: '/' }, { method: 'GET', path: '/index.html' }, { method: 'GET', path: '/tasks' }, { method: 'GET', path: '/tasks/' },
      { method: 'GET', path: '/shared/ui.css' }, { method: 'HEAD', path: '/' }, { method: 'OPTIONS', path: '/' }, { method: 'GET', path: '/api' },
      { method: 'GET', path: '/api/hello', headers: { 'x-ecosys': s.secret } }, { method: 'GET', path: '/api/ai', headers: { 'x-ecosys': s.secret } },
      { method: 'GET', path: '/api/events', headers: { 'x-ecosys': s.secret }, headersOnly: true }, { method: 'POST', path: '/api/ops', headers: { 'x-ecosys': s.secret }, body: { ops: [] } },
      { method: 'POST', path: '/api/internal/notify', headers: bearer(tok), body: { events: [] } },
      { method: 'POST', path: '/api/ai/install/claude-desktop', headers: { 'x-ecosys': s.secret }, body: {} },
      { method: 'POST', path: '/api/ai/mode', headers: { 'x-ecosys': s.secret }, body: { mode: 'off' } },
      { method: 'GET', path: '/.git/config' }, { method: 'GET', path: '/.well-known/oauth-authorization-server' }, { method: 'GET', path: '/mcp/' },
      { method: 'GET', path: '/MCP' }, { method: 'POST', path: `/s/${tok}/mcp/`, body: PING },
    ];
    for (const host of tunnelHosts) {
      for (const r of notMcp) {
        const res = await send(s, r, host);
        assert.equal(res.status, 404, `${host} ${r.method} ${r.path} -> ${res.status}`);
        assert.equal(res.headers.location, undefined, `${host} ${r.path}: never a redirect`);
        assert.deepEqual(leaked(res.text, [tok]), []);
      }
      assert.equal((await request(s.port, { method: 'POST', path: '/mcp', host, body: PING })).status, 401, `${host}: MCP needs a key`);
      assert.equal((await request(s.port, { method: 'POST', path: '/mcp', host, body: PING, headers: bearer(tok) })).status, 200, `${host}: MCP with a key`);
      assert.equal((await request(s.port, { method: 'POST', path: `/s/${tok}/mcp`, host, body: PING })).status, 200, `${host}: secret path`);
      assert.equal((await request(s.port, { method: 'GET', path: '/mcp', host, headers: bearer(tok) })).status, 405);
    }
    assert.equal(s.core.ai.mode(), 'write', 'nothing changed the AI mode');
    for (const host of ['ngrok-free.dev', 'evilngrok-free.dev', 'x.ngrok-free.dev.evil.example', 'abc.trycloudflare.com.evil.example', 'xabc.trycloudflare.com', 'trycloudflare.com', 'abc-trycloudflare.com', 'abc.trycloudflare.co']) {
      assert.equal((await request(s.port, { method: 'POST', path: '/mcp', host, body: PING, headers: bearer(tok) })).status, 403, `look-alike tunnel ${host}`);
    }
  });

  test('through a tunnel, MCP refuses plain-http and opaque Origins; https web origins go on to the key check', async () => {
    const host = 'abc.trycloudflare.com';
    for (const origin of ['http://evil.example', 'null', 'https://evil.example/path', 'javascript:alert(1)', 'file://', 'http://abc.trycloudflare.com', 'https://evil.example:99999x', 'https://']) {
      const r = await request(s.port, { method: 'POST', path: '/mcp', host, body: PING, headers: { ...bearer(tok), origin } });
      assert.equal(r.status, 403, `Origin ${origin} -> ${r.status}`);
      assert.ok(!r.json?.result);
    }
    for (const origin of ['https://claude.ai', 'https://chatgpt.com', 'https://abc.trycloudflare.com', 'https://grok.com:443']) {
      assert.equal((await request(s.port, { method: 'POST', path: '/mcp', host, body: PING, headers: { ...bearer(tok), origin } })).status, 200, origin);
      assert.equal((await request(s.port, { method: 'POST', path: '/mcp', host, body: PING, headers: { origin } })).status, 401, `${origin} without a key`);
    }
  });

  test('ECOSYS_ALLOWED_HOSTS parsing drops wildcards, loopback names and junk', () => {
    assert.deepEqual(parseAllowedHosts('*.trycloudflare.com, *, ?'), []);
    assert.deepEqual(parseAllowedHosts('localhost, 127.0.0.1, [::1], 127.0.0.1:4300, localhost:80, [::1]:4300'), []);
    assert.deepEqual(parseAllowedHosts(' https://A.Example.com/path?x , http://b.example.com/ '), ['a.example.com', 'b.example.com']);
    assert.deepEqual(parseAllowedHosts('evil.example\r\nX-Injected: 1, bad host, a_b.example, .'), []);
    assert.deepEqual(parseAllowedHosts(''), []);
    assert.deepEqual(parseAllowedHosts(undefined), []);
  });

  test('LAN mode: another device gets the apps by IP address, never the API or MCP', async () => {
    const P = lan.port;
    for (const host of [`192.168.1.10:${P}`, `[fd00::10]:${P}`]) {
      const from = { 'x-test-remote-addr': '192.168.1.50' };
      assert.equal((await request(P, { path: '/', host, headers: from })).status, 200, `${host} apps`);
      assert.equal((await request(P, { path: '/tasks/', host, headers: from })).status, 200);
      for (const r of routes(lanTok, lan).filter((x) => x.path !== '/' && x.path !== '/tasks/' && !x.path.startsWith('/.well-known'))) {
        const res = await send(lan, r, host, from);
        assert.equal(res.status, 404, `${host} ${r.method} ${r.path} -> ${res.status}`);
        assert.deepEqual(leaked(res.text, [lanTok]), []);
      }
      assert.equal((await request(P, { path: '/.git/config', host, headers: from })).status, 404);
    }
    assert.equal((await request(P, { path: '/', host: `myhost.local:${P}`, headers: { 'x-test-remote-addr': '192.168.1.50' } })).status, 403, 'LAN names are not IP literals');
  });

  test('loopback Host names sent from another device are refused (the Host header alone proves nothing)', async () => {
    const P = lan.port;
    for (const remote of ['192.168.1.50', '::ffff:192.168.1.50', 'fe80::1', '10.0.0.7', '203.0.113.9', 'none']) {
      for (const host of [`127.0.0.1:${P}`, `localhost:${P}`, `[::1]:${P}`]) {
        for (const r of routes(lanTok, lan)) {
          const res = await send(lan, r, host, { 'x-test-remote-addr': remote });
          assert.equal(res.status, 403, `remote ${remote}, Host ${host}, ${r.method} ${r.path} -> ${res.status}`);
          assert.deepEqual(leaked(res.text, [lanTok]), []);
        }
      }
    }
  });

  test('loopback connections count as local (127/8, ::1, IPv4-mapped)', async () => {
    for (const remote of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      const r = await request(lan.port, { path: '/api/state', headers: { 'x-ecosys': lan.secret, 'x-test-remote-addr': remote } });
      assert.equal(r.status, 200, remote);
    }
  });

  test('without LAN mode, other devices are refused even with an IP-literal Host', async () => {
    const P = nolan.port;
    for (const host of [`192.168.1.10:${P}`, `127.0.0.1:${P}`]) {
      for (const path of ['/', '/tasks/']) {
        assert.equal((await request(P, { path, host, headers: { 'x-test-remote-addr': '192.168.1.50' } })).status, 403, `${host} ${path}`);
      }
    }
  });

  test('bare loopback names (no port) are accepted only when ecosys really is on port 80', async () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1:80']) {
      assert.equal((await request(p80.port, { path: '/api/state', host, headers: { 'x-ecosys': p80.secret } })).status, 200, `port 80: ${host}`);
    }
    for (const host of ['evil.example', '127.0.0.1:8080', `127.0.0.1:${p80.port}`]) {
      assert.equal((await request(p80.port, { path: '/api/state', host, headers: { 'x-ecosys': p80.secret } })).status, 403, `port 80: ${host}`);
    }
  });

  test('WebSocket upgrades are never accepted (cross-site WebSocket hijacking)', async () => {
    for (const target of ['/', '/api/events', '/mcp', `/s/${tok}/mcp`, '/api/ai']) {
      for (const origin of [null, 'https://evil.example', `http://127.0.0.1:${s.port}`]) {
        const headers = [['Upgrade', 'websocket'], ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='], ['Sec-WebSocket-Version', '13'], ['X-Ecosys', s.secret]];
        if (origin) headers.push(['Origin', origin]);
        const r = await rawHttp(s.port, { target, headers, connection: 'Upgrade', headersOnly: true, timeout: 3000 });
        assert.notEqual(r.status, 101, `${target} (Origin ${origin}) was upgraded`);
        assert.ok(!/^upgrade$/i.test(r.headers.connection || '') && r.headers['sec-websocket-accept'] === undefined, target);
      }
    }
  });

  test('CONNECT, asterisk-form and absolute-form request targets are refused', async () => {
    const connect = await rawHttp(s.port, { method: 'CONNECT', target: `127.0.0.1:${s.port}`, connection: null, timeout: 3000 });
    assert.ok(connect.status === 0 || connect.status >= 400, `CONNECT -> ${connect.status}`);
    assert.equal((await rawHttp(s.port, { method: 'OPTIONS', target: '*' })).status, 400);
    assert.equal((await rawHttp(s.port, { target: `http://127.0.0.1:${s.port}/api/ai`, headers: [['X-Ecosys', s.secret]] })).status, 400);
    assert.equal((await rawHttp(s.port, { target: 'https://evil.example/' })).status, 400);
    // Leading slashes collapse into a path ("/127.0.0.1:P/api/hello"), never an authority + "/api/hello".
    const rel = await rawHttp(s.port, { target: `//127.0.0.1:${s.port}/api/hello`, headers: [['X-Ecosys', s.secret]] });
    assert.ok(rel.status === 400 || rel.status === 404, `protocol-relative target -> ${rel.status}`);
    assert.ok(!rel.text.includes('"app":"ecosys"'), 'not routed to /api/hello');
  });
});
