// The browser API under cross-site attack (server/http.mjs checkBrowser + handleApi): the pairing
// secret (X-Ecosys), Origin and Sec-Fetch-Site on every /api route and method, CORS preflights,
// form/text CSRF, body size limits, malformed JSON, prototype pollution and the SSE endpoint's access
// rules. The Origin and Fetch Metadata attacks carry the real secret, so each check is shown to hold
// on its own. Every attack is followed by a check that nothing at all changed.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_LIMIT } from '../../server/http.mjs';
import { createScope, startServer, request, rawHttp, api, mcpPost, openSse, bearer, PING, leaked, corsHeaders, ensureDir, sleep, tooLargeOrReset, nearMiss as nearMissKey } from './_harness.js';

describe('browser API: CSRF, Origin and Sec-Fetch checks on every route', () => {
  const scope = createScope('csrf');
  let s;
  let P;
  let L;
  let K; // the server's pairing secret: what a paired tab sends as X-Ecosys
  let claudeDir;
  let cfgPath;
  let victim;
  let notifier;
  let changeId;

  before(async () => {
    claudeDir = ensureDir(join(scope.tempDir('claude-home'), 'Claude'));
    cfgPath = join(claudeDir, 'claude_desktop_config.json');
    s = await startServer(scope, { allowedHosts: 'abc.trycloudflare.com', installPaths: [cfgPath] });
    P = s.port;
    L = `http://127.0.0.1:${P}`;
    K = s.secret;
    const imp = await api(s, 'POST', '/api/import', {
      data: { tasks: [{ id: 'seed1', title: 'Seed', createdAt: 1, updatedAt: 1 }], calendars: [{ id: 'cal1', name: 'Personal', color: 'iris' }] },
      settings: { theme: 'light' },
    });
    assert.equal(imp.status, 200, imp.text);
    victim = s.core.ai.createClient({ kind: 'claude' });
    notifier = s.core.ai.createClient({ kind: 'claude', label: 'Bridge' });
    changeId = s.core.callTool('create_tasks', { tasks: [{ title: 'Undo target' }] }, { client: victim }).structuredContent.change_id;
    assert.ok(changeId);
  });
  after(() => scope.cleanup());

  function fingerprint() {
    s.core.store.refresh();
    s.core.ai.refresh();
    return JSON.stringify({
      rev: s.core.store.rev,
      data: s.core.store.toJSON(),
      mode: s.core.ai.mode(),
      clients: s.core.ai.state.clients.map((c) => [c.id, c.token, c.access, c.label, c.kind]),
      undoneBy: s.core.ai.change(changeId)?.undoneBy ?? null,
      claudeDir: readdirSync(claudeDir).sort(),
    });
  }

  const routes = () => [
    { method: 'GET', path: '/api/hello' },
    { method: 'GET', path: '/api/state' },
    { method: 'GET', path: '/api/ai' },
    { method: 'GET', path: '/api/events?client=csrf', sse: true },
    { method: 'POST', path: '/api/events', body: {} },
    { method: 'POST', path: '/api/import', body: { data: { tasks: [{ id: 'csrf1', title: 'CSRF import', createdAt: 1, updatedAt: 1 }] } } },
    {
      method: 'POST',
      path: '/api/ops',
      body: { client: 'csrf', ops: [{ op: 'put', c: 'tasks', item: { id: 'csrf2', title: 'CSRF op', createdAt: 1, updatedAt: 1 } }, { op: 'settings', patch: { theme: 'dark' } }, { op: 'del', c: 'tasks', id: 'seed1' }] },
    },
    { method: 'POST', path: '/api/ai/mode', body: { mode: 'off' } },
    { method: 'POST', path: '/api/ai/clients', body: { kind: 'other', label: 'csrf' } },
    { method: 'POST', path: `/api/ai/clients/${victim.id}`, body: { rotate: true, access: 'read', label: 'pwned' } },
    { method: 'DELETE', path: `/api/ai/clients/${victim.id}` },
    { method: 'POST', path: '/api/ai/undo', body: { changeId } },
    { method: 'POST', path: '/api/ai/install/claude-desktop', body: {} },
    // Not a browser route: it takes a connection key (the stdio bridge's proof) instead of the pairing
    // secret. The attacks below don't hold one (with one, see "notify with a key" further down).
    { method: 'POST', path: '/api/internal/notify', body: { events: [{ event: 'ai', data: { type: 'connected', clientName: 'csrf' } }] }, control: bearer(notifier.token) },
    { method: 'PUT', path: '/api/ops', body: { ops: [] } },
    { method: 'PATCH', path: '/api/ai/mode', body: { mode: 'off' } },
    { method: 'OPTIONS', path: '/api/ops' },
    { method: 'HEAD', path: '/api/ai' },
    { method: 'GET', path: '/api/nope' },
    { method: 'POST', path: '/api/nope', body: {} },
    { method: 'GET', path: '/api' },
  ];

  // `unpaired`: the attack holds no pairing secret (anything a page on another site can send).
  const attacks = () => [
    { name: 'no X-Ecosys header', headers: {}, unpaired: true },
    { name: 'X-Ecosys: 1 (the header from before pairing)', headers: { 'x-ecosys': '1' }, unpaired: true },
    { name: 'X-Ecosys: 0', headers: { 'x-ecosys': '0' }, unpaired: true },
    { name: 'X-Ecosys: true', headers: { 'x-ecosys': 'true' }, unpaired: true },
    { name: 'two X-Ecosys headers', headers: { 'x-ecosys': ['1', '1'] }, unpaired: true },
    { name: 'a secret one character off', headers: { 'x-ecosys': nearMissKey(K) }, unpaired: true },
    { name: 'the secret twice', headers: { 'x-ecosys': [K, K] }, unpaired: true },
    { name: 'the secret with a character more', headers: { 'x-ecosys': `${K}A` }, unpaired: true },
    { name: 'HTML form POST (urlencoded, no custom header)', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'mode=off&kind=other&changeId=x', unpaired: true },
    { name: 'text/plain POST from another site', headers: { 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } },
    { name: 'multipart POST from another site', headers: { 'content-type': 'multipart/form-data; boundary=x', origin: 'https://evil.example' }, rawBody: '--x\r\nContent-Disposition: form-data; name="mode"\r\n\r\noff\r\n--x--\r\n' },
    { name: 'foreign Origin', headers: { 'x-ecosys': K, origin: 'https://evil.example' } },
    { name: 'Origin null (sandboxed frame, file://)', headers: { 'x-ecosys': K, origin: 'null' } },
    { name: 'Origin of another local port', headers: { 'x-ecosys': K, origin: `http://127.0.0.1:${P + 1}` } },
    { name: 'Origin of localhost on another port', headers: { 'x-ecosys': K, origin: `http://localhost:${P + 1}` } },
    { name: 'Origin with https scheme', headers: { 'x-ecosys': K, origin: `https://127.0.0.1:${P}` } },
    { name: 'Origin with a trailing slash', headers: { 'x-ecosys': K, origin: `${L}/` } },
    { name: 'look-alike Origin', headers: { 'x-ecosys': K, origin: `${L}.evil.example` } },
    { name: 'upper-case Origin', headers: { 'x-ecosys': K, origin: L.toUpperCase() } },
    { name: 'two Origin headers (ours and theirs)', headers: { 'x-ecosys': K, origin: [L, 'https://evil.example'] } },
    { name: 'Sec-Fetch-Site: cross-site', headers: { 'x-ecosys': K, 'sec-fetch-site': 'cross-site' } },
    { name: 'Sec-Fetch-Site: same-site (another localhost port)', headers: { 'x-ecosys': K, 'sec-fetch-site': 'same-site' } },
    { name: 'valid Origin but a cross-site fetch', headers: { 'x-ecosys': K, origin: L, 'sec-fetch-site': 'cross-site' } },
    { name: 'rebinding Host', headers: { 'x-ecosys': K }, host: `evil.example:${P}`, expect: [403] },
    { name: 'tunnel Host', headers: { 'x-ecosys': K }, host: 'abc.trycloudflare.com', expect: [404] },
    { name: 'relayed by a proxy (X-Forwarded-For)', headers: { 'x-ecosys': K, 'x-forwarded-for': '203.0.113.9' }, expect: [404] },
  ];

  const send = (route, attack, { control = false } = {}) =>
    request(P, {
      method: route.method,
      path: route.path,
      host: attack.host,
      headers: { ...(control ? route.control || {} : {}), ...attack.headers },
      body: route.method === 'GET' || route.method === 'HEAD' ? undefined : attack.rawBody ?? route.body,
      headersOnly: route.sse,
    });

  /** GET /api/hello is public: without the secret it says only that this caller isn't paired. */
  const helloUnpaired = (r) => r.status === 200 && JSON.stringify(Object.keys(r.json || {}).sort()) === '["app","features","ok","paired","version"]' && r.json.paired === false;

  test('every route refuses every cross-site, rebinding, tunnel, unpaired and header-less variant, and nothing changes', async () => {
    const before = fingerprint();
    const tokens = [victim.token, notifier.token, K];
    let count = 0;
    for (const attack of attacks()) {
      for (const route of routes()) {
        const r = await send(route, attack);
        count++;
        const label = `${attack.name}: ${route.method} ${route.path} -> ${r.status} ${r.error || ''} ${r.text.slice(0, 80)}`;
        assert.deepEqual(leaked(r.text, tokens), [], `${label}: leaked a key or the pairing secret`);
        assert.deepEqual(corsHeaders(r.headers), [], `${label}: CORS headers`);
        if (attack.unpaired && route.path === '/api/hello' && route.method === 'GET') {
          assert.ok(helloUnpaired(r), `${label}: hello answers, and says only "not paired"`);
          continue;
        }
        const notify = route.path === '/api/internal/notify';
        const allowed = attack.expect || (notify ? [401, 403] : [403, 404, 405]);
        assert.ok(allowed.includes(r.status), label);
        // Without the secret every browser route says exactly why, before anything else (even a 404).
        // (A HEAD reply has no body; the stream request reads only the headers.)
        if (attack.unpaired && !notify && !attack.expect) {
          assert.equal(r.status, 403, label);
          if (route.method !== 'HEAD' && !route.sse) assert.deepEqual(r.json, { error: 'pairing_required' }, label);
        }
        if (route.method === 'POST' && !route.path.startsWith('/api/nope') && !notify && !attack.expect) assert.equal(r.status, 403, label);
      }
    }
    assert.ok(count > 500, `ran ${count} attack requests`);
    await sleep(50);
    assert.equal(fingerprint(), before, 'no attack changed data, settings, mode, connections, undo state or the Claude config');
    assert.ok(!existsSync(cfgPath), 'the Claude Desktop config was never written');
  });

  test('notify with a key: every cross-site and relayed variant is still refused (a key does not lift the browser checks)', async () => {
    const before = fingerprint();
    const notify = routes().find((x) => x.path === '/api/internal/notify');
    for (const attack of attacks().filter((a) => !a.unpaired)) {
      const r = await send(notify, { ...attack, headers: { ...bearer(notifier.token), ...attack.headers } });
      assert.ok((attack.expect || [403]).includes(r.status), `${attack.name}: notify with a key -> ${r.status} ${r.text.slice(0, 80)}`);
    }
    assert.equal(fingerprint(), before);
  });

  test('control: the same routes work for a same-origin request (so the refusals above come from the checks)', async () => {
    const good = { 'x-ecosys': K, origin: L, 'sec-fetch-site': 'same-origin' };
    const expect = {
      'GET /api/hello': 200,
      'GET /api/state': 200,
      'GET /api/ai': 200,
      'GET /api/events?client=csrf': 200,
      'POST /api/events': 404,
      'POST /api/import': 409, // already initialized: the route ran and refused a second import
      'POST /api/ops': 200,
      'POST /api/ai/mode': 200,
      'POST /api/ai/clients': 200,
      [`POST /api/ai/clients/${victim.id}`]: 200,
      [`DELETE /api/ai/clients/${victim.id}`]: 200,
      'POST /api/ai/undo': 200,
      'POST /api/ai/install/claude-desktop': 200,
      'POST /api/internal/notify': 200,
      'PUT /api/ops': 405,
      'PATCH /api/ai/mode': 405,
      'OPTIONS /api/ops': 405,
      'HEAD /api/ai': 405,
      'GET /api/nope': 404,
      'POST /api/nope': 404,
      'GET /api': 404,
    };
    for (const route of routes()) {
      const r = await send(route, { headers: good }, { control: true });
      assert.equal(r.status, expect[`${route.method} ${route.path}`], `${route.method} ${route.path}: ${r.text.slice(0, 200)}`);
    }
    assert.ok(existsSync(cfgPath), 'the installer ran for the same-origin request');
    await api(s, 'POST', '/api/ai/mode', { mode: 'write' });
    // Requests from tools on this computer (no Origin, no Sec-Fetch-*) and user navigations work too.
    const hello = await api(s, 'GET', '/api/hello');
    assert.equal(hello.status, 200);
    assert.equal(hello.json.paired, true, 'hello says the request was paired');
    assert.equal((await api(s, 'GET', '/api/state', undefined, { 'sec-fetch-site': 'none' })).status, 200);
    for (const origin of [`http://localhost:${P}`, `http://[::1]:${P}`]) assert.equal((await api(s, 'GET', '/api/state', undefined, { origin })).status, 200, origin);
  });

  test('CORS preflights are refused and no response ever carries CORS or private-network headers', async () => {
    const key = s.core.ai.createClient({ kind: 'other', label: 'cors' }).token;
    for (const path of ['/api/ops', '/api/ai', '/api/ai/install/claude-desktop', '/api/events', '/mcp', `/s/${key}/mcp`, '/', '/tasks/']) {
      for (const origin of ['https://evil.example', L, 'null']) {
        const r = await request(P, {
          method: 'OPTIONS',
          path,
          headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-ecosys, content-type, authorization', 'access-control-request-private-network': 'true' },
        });
        assert.ok(r.status >= 400 && r.status < 500, `OPTIONS ${path} (${origin}) -> ${r.status}`);
        assert.deepEqual(corsHeaders(r.headers), [], `OPTIONS ${path}`);
      }
    }
    for (const origin of ['https://evil.example', L, 'null', undefined]) {
      for (const [method, path, body, headers] of [
        ['GET', '/api/hello', undefined, {}],
        ['GET', '/api/hello', undefined, { 'x-ecosys': K }],
        ['GET', '/api/ai', undefined, { 'x-ecosys': K }],
        ['GET', '/api/ai', undefined, { 'x-ecosys': '1' }],
        ['POST', '/api/ops', { ops: [] }, { 'x-ecosys': K }],
        ['POST', '/mcp', PING, bearer(key)],
        ['GET', '/', undefined, {}],
        ['GET', '/shared/ui.css', undefined, {}],
        ['GET', '/nope', undefined, {}],
      ]) {
        const r = await request(P, { method, path, body, headers: { ...headers, origin } });
        assert.deepEqual(corsHeaders(r.headers), [], `${method} ${path} (Origin ${origin})`);
      }
    }
  });

  test('a Content-Length over 2 MB is refused at once, before any body is read', async () => {
    for (const path of ['/api/ops', '/api/import', '/api/ai/mode', '/api/ai/clients', '/api/ai/install/claude-desktop', '/api/internal/notify', '/api/ai/undo']) {
      // A paired tab (notify: a key holder), so the size check is what answers.
      const auth = path === '/api/internal/notify' ? ['Authorization', `Bearer ${notifier.token}`] : ['X-Ecosys', K];
      const r = await rawHttp(P, {
        method: 'POST',
        target: path,
        headers: [auth, ['Content-Type', 'application/json'], ['Content-Length', String(BODY_LIMIT + 1)]],
        timeout: 4000,
      });
      assert.equal(r.status, 413, `${path} -> ${r.status}${r.timedOut ? ' (waited for a body that never came)' : ''}`);
    }
  });

  test('a body of exactly 2 MB is accepted; one byte more is refused', async () => {
    const mk = (n) => {
      const head = '{"ops":[],"pad":"';
      const tail = '"}';
      return head + 'x'.repeat(n - head.length - tail.length) + tail;
    };
    const exact = await api(s, 'POST', '/api/ops', mk(BODY_LIMIT));
    assert.equal(exact.status, 200, exact.text.slice(0, 200));
    const revBefore = s.core.store.rev;
    const over = await api(s, 'POST', '/api/ops', mk(BODY_LIMIT + 1));
    assert.ok(tooLargeOrReset(over), `${over.status} ${over.error || ''}`);
    assert.equal(s.core.store.rev, revBefore);
  });

  test('an oversized chunked body is cut off (413 or reset), nothing is applied and nothing is logged', async () => {
    const before = fingerprint();
    const errorsBefore = s.log.entries.filter((e) => e.level === 'error').length;
    const result = await new Promise((resolvePromise) => {
      const r = http.request(
        { host: '127.0.0.1', port: P, method: 'POST', path: '/api/ops', agent: false, headers: { host: `127.0.0.1:${P}`, 'x-ecosys': K, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          res.on('end', () => resolvePromise({ status: res.statusCode }));
          res.on('error', (e) => resolvePromise({ status: res.statusCode, error: e.code }));
        },
      );
      r.on('error', (e) => resolvePromise({ status: 0, error: e.code || e.message }));
      r.write('{"ops":[{"op":"put","c":"tasks","item":{"id":"chunky","title":"');
      const chunk = Buffer.alloc(64 * 1024, 'a');
      let n = 0;
      const pump = () => {
        while (n < 48) {
          n++;
          if (!r.write(chunk)) return r.once('drain', pump);
        }
        r.end('"}}]}');
      };
      pump();
    });
    assert.ok(result.status === 413 || ['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(result.error) || /hang up/.test(result.error || ''), JSON.stringify(result));
    assert.equal((await api(s, 'GET', '/api/hello')).status, 200, 'server still answers');
    await sleep(50);
    assert.equal(fingerprint(), before);
    assert.equal(s.log.entries.filter((e) => e.level === 'error').length, errorsBefore, s.log.text());
  });

  test('malformed or non-object JSON gets a 400 on every JSON route (never a 500), and nothing changes', async () => {
    const before = fingerprint();
    const bodies = [
      '{', '{"a":', '{"a":1}}', 'nul', '{\'a\':1}', '{"a":NaN}', '{"a":1} trailing', '﻿{}', '{"a":1,}', '/* c */{}', '{"a":"\u0000"', '[]', '[1]', '"str"', '42', 'null', 'true',
      '{"a":'.repeat(20000) + '1' + '}'.repeat(20000), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x7d]),
    ];
    const jsonRoutes = ['/api/import', '/api/ops', '/api/ai/mode', '/api/ai/clients', `/api/ai/clients/${notifier.id}`, '/api/ai/undo', '/api/ai/install/claude-desktop', '/api/internal/notify'];
    for (const path of jsonRoutes) {
      for (const body of bodies) {
        const r = await api(s, 'POST', path, body, bearer(notifier.token));
        assert.equal(r.status, 400, `${path} ${JSON.stringify(String(body).slice(0, 30))} -> ${r.status} ${r.text.slice(0, 120)}`);
        assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
      }
    }
    assert.equal(fingerprint(), before);
    assert.equal(s.log.entries.filter((e) => e.level === 'error').length, 0, s.log.text());
  });

  test('prototype-pollution payloads are inert on every route (and over MCP)', async () => {
    const key = s.core.ai.createClient({ kind: 'other', label: 'pp' }).token;
    const P1 = '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}';
    const cases = [
      ['/api/ops', '{"__proto__":{"polluted":"yes"},"ops":[]}'],
      ['/api/ops', '{"constructor":{"prototype":{"polluted":"yes"}},"ops":[]}'],
      ['/api/ops', '{"ops":[{"op":"put","c":"tasks","item":{"id":"pp1","title":"x","createdAt":1,"updatedAt":1,"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}}]}'],
      ['/api/ops', '{"ops":[{"op":"settings","patch":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"theme":"dark"}}]}'],
      ['/api/ops', '{"ops":[{"op":"put","c":"__proto__","item":{"id":"pp2"}},{"op":"put","c":"constructor","item":{"id":"pp3"}},{"op":"replace","c":"__proto__","items":[]}]}'],
      ['/api/ops', '{"ops":[{"op":"put","c":"tasks","item":{"id":"__proto__","title":"proto id","createdAt":1,"updatedAt":1}},{"op":"del","c":"tasks","id":"constructor"}]}'],
      ['/api/ops', '{"ops":[{"op":"__proto__"},{"op":"constructor","c":"tasks"},{"op":"toString"}]}'],
      ['/api/ai/mode', `${P1},"mode":"write"}`],
      ['/api/ai/clients', `${P1},"kind":"other","label":"pp2"}`],
      ['/api/import', `{"data":{"tasks":[],"__proto__":{"polluted":"yes"}},"settings":{"__proto__":{"polluted":"yes"}}}`],
      ['/api/ai/undo', `${P1},"changeId":"__proto__"}`],
      ['/api/internal/notify', `${P1},"events":[{"event":"ops","data":{"rev":1,"ops":[{"op":"put","c":"tasks","item":{"id":"pp4","__proto__":{"polluted":"yes"}}}]}},{"__proto__":{"polluted":"yes"}}]}`],
    ];
    for (const [path, body] of cases) {
      const r = await api(s, 'POST', path, body, bearer(notifier.token));
      assert.ok(r.status > 0 && r.status < 500, `${path} -> ${r.status} ${r.text.slice(0, 200)}`);
      assert.equal(Object.prototype.polluted, undefined, `${path} polluted Object.prototype`);
      assert.equal({}.polluted, undefined);
    }
    for (const body of [
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_tasks","arguments":{"tasks":[{"title":"pp","__proto__":{"polluted":"yes"}}],"__proto__":{"polluted":"yes"}},"__proto__":{"polluted":"yes"}},"__proto__":{"polluted":"yes"}}`,
      `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"__proto__","arguments":{}}}`,
      `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"constructor","arguments":{"constructor":{"prototype":{"polluted":"yes"}}}}}`,
      `{"jsonrpc":"2.0","id":4,"method":"__proto__"}`,
      `{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"clientInfo":{"name":"x","__proto__":{"polluted":"yes"}},"__proto__":{"polluted":"yes"}}}`,
    ]) {
      const r = await mcpPost(s, body, bearer(key));
      assert.ok(r.status > 0 && r.status < 500, `MCP ${body.slice(0, 80)} -> ${r.status}`);
      assert.equal(Object.prototype.polluted, undefined, 'MCP payload polluted Object.prototype');
    }
    assert.equal(Object.getPrototypeOf(s.core.store.settings()), Object.prototype);
    const disk = readFileSync(join(s.dataDir, 'data.json'), 'utf8');
    assert.ok(!disk.includes('polluted'), 'no polluting key reached data.json');
  });

  test('too many ops in one request is refused before anything is applied', async () => {
    const before = fingerprint();
    const ops = Array.from({ length: 2001 }, (_, i) => ({ op: 'put', c: 'tasks', item: { id: `many${i}`, title: 'x', createdAt: 1, updatedAt: 1 } }));
    const r = await api(s, 'POST', '/api/ops', { ops });
    assert.equal(r.status, 413, r.text.slice(0, 200));
    assert.equal(fingerprint(), before);
  });

  test('internal notify: a read-only key or made-up ops only ever cause a snapshot; names are cleaned and capped', async () => {
    const { DataStore } = await import('../../server/store.mjs');
    const ro = s.core.ai.createClient({ kind: 'grok', access: 'read' });
    const fresh = s.core.ai.createClient({ kind: 'chatgpt', label: 'Notifier 2' });
    const tab = openSse(P, { path: '/api/events?client=notify-tab' });
    await tab.ready;
    await tab.wait((e) => e.event === 'ai' && e.data?.type === 'status');
    const other = new DataStore({ dir: s.dataDir, validators: s.core.validators, log: { error() {}, warn() {}, info() {}, log() {} } });
    // 1. a real change on disk, announced with a read-only key
    const first = other.transaction((tx) => tx.put('tasks', { id: 'ro1', title: 'Real', createdAt: 1, updatedAt: 1 }));
    assert.equal((await api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev: first.rev, ops: first.ops } }] }, bearer(ro.token))).status, 200);
    const ev1 = await tab.wait((e) => (e.event === 'ops' || e.event === 'snapshot') && e.data?.rev === first.rev);
    assert.equal(ev1.event, 'snapshot', 'a read-only key cannot push ops to browsers');
    // 2. made-up ops (not on disk) with a write key
    const second = other.transaction((tx) => tx.put('tasks', { id: 'ro2', title: 'Real 2', createdAt: 1, updatedAt: 1 }));
    const fake = { op: 'put', c: 'tasks', item: { id: 'fake9', title: 'Made up', createdAt: 1, updatedAt: 1 } };
    await api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ops', data: { rev: second.rev, ops: [fake] } }] }, bearer(notifier.token));
    const ev2 = await tab.wait((e) => (e.event === 'ops' || e.event === 'snapshot') && e.data?.rev === second.rev);
    assert.equal(ev2.event, 'snapshot', 'ops that do not match the disk are never relayed');
    // 3. the client name shown by the connect animation is cleaned and capped
    const hostile = `\u0000\u001b[31m<img src=x onerror=alert(1)>${'x'.repeat(500)}`;
    await api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ai', data: { type: 'connected', clientName: hostile } }] }, bearer(fresh.token));
    const conn = await tab.wait((e) => e.event === 'ai' && e.data?.type === 'connected' && e.data.client?.id === fresh.id);
    assert.ok(conn.data.clientName.length <= 80, `name length ${conn.data.clientName.length}`);
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(conn.data.clientName), 'control characters removed');
    assert.equal(conn.data.client.token, undefined);
    tab.close();
    assert.ok(!tab.state.events.some((e) => e.event === 'ops' && JSON.stringify(e.data).includes('fake9')));
    assert.equal((await api(s, 'POST', '/api/internal/notify', { events: [] }, bearer(nearMissKey(ro.token)))).status, 401);
  });

  test('slow-loris guards: header and request timeouts are set', () => {
    assert.ok(s.app.server.headersTimeout > 0 && s.app.server.headersTimeout <= 60000, `headersTimeout ${s.app.server.headersTimeout}`);
    assert.ok(s.app.server.requestTimeout > 0 && s.app.server.requestTimeout <= 120000, `requestTimeout ${s.app.server.requestTimeout}`);
  });

  test('SSE: a paired tab gets its stream (fetch() with the pairing header, and the safe headers)', async () => {
    for (const headers of [{}, { origin: L, 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }]) {
      const r = await request(P, { path: '/api/events?client=ok', headers: { 'x-ecosys': K, ...headers }, headersOnly: true });
      assert.equal(r.status, 200, JSON.stringify(headers));
      assert.match(r.headers['content-type'], /^text\/event-stream/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', 'a cross-site <script src> cannot run the stream');
      assert.match(r.headers['cache-control'] || '', /\bno-(cache|store)\b/);
      assert.deepEqual(corsHeaders(r.headers), []);
    }
  });

  test('SSE: no exemption any more: without the pairing secret (an EventSource, <img src>, the old header) the stream is refused', async () => {
    for (const headers of [{}, { 'x-ecosys': '1' }, { 'x-ecosys': nearMissKey(K) }, { origin: L, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }, { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' }]) {
      const r = await request(P, { path: '/api/events?client=ok', headers, timeout: 4000 });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.deepEqual(r.json, { error: 'pairing_required' });
      assert.ok(!/event-stream/.test(r.headers['content-type'] || ''), `${JSON.stringify(headers)} got a stream`);
    }
  });

  test('SSE: cross-site, rebinding, tunnel and proxied access is refused, and other methods never stream', async () => {
    for (const [label, opts] of [
      ['foreign Origin', { headers: { origin: 'https://evil.example' } }],
      ['Origin null', { headers: { origin: 'null' } }],
      ['another local port', { headers: { origin: `http://localhost:${P + 1}` } }],
      ['cross-site', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors' } }],
      ['same-site', { headers: { 'sec-fetch-site': 'same-site' } }],
      ['rebinding Host', { host: `evil.example:${P}` }],
      ['tunnel Host', { host: 'abc.trycloudflare.com' }],
      ['proxied', { headers: { 'x-forwarded-for': '203.0.113.9' } }],
    ]) {
      // With the real secret: these checks hold on their own.
      const r = await request(P, { path: '/api/events?client=evil', headersOnly: true, ...opts, headers: { 'x-ecosys': K, ...(opts.headers || {}) } });
      assert.ok(r.status === 403 || r.status === 404, `${label} -> ${r.status}`);
      assert.ok(!/event-stream/.test(r.headers['content-type'] || ''), `${label} got a stream`);
    }
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await request(P, { method, path: '/api/events?client=x', headers: { 'x-ecosys': K }, body: method === 'HEAD' || method === 'OPTIONS' ? undefined : '{}', headersOnly: true });
      assert.ok(r.status >= 400, `${method} /api/events -> ${r.status}`);
      assert.ok(!/event-stream/.test(r.headers['content-type'] || ''), `${method} got a stream`);
    }
  });

  test('SSE: the stream never carries a connection key, even while keys are created, rotated and used', async () => {
    const tab = openSse(P, { path: '/api/events?client=watcher' });
    await tab.ready;
    await tab.wait((e) => e.event === 'ai' && e.data?.type === 'status');
    const tokens = new Set();
    const created = (await api(s, 'POST', '/api/ai/clients', { kind: 'chatgpt' })).json.client;
    tokens.add(created.token);
    await mcpPost(s, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sse-probe', version: '1' } } }, bearer(created.token));
    await mcpPost(s, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'Seen over SSE' }] } } }, bearer(created.token));
    const rotated = (await api(s, 'POST', `/api/ai/clients/${created.id}`, { rotate: true })).json.client;
    tokens.add(rotated.token);
    await api(s, 'POST', '/api/ai/mode', { mode: 'read' });
    await api(s, 'POST', '/api/ai/mode', { mode: 'write' });
    await api(s, 'DELETE', `/api/ai/clients/${created.id}`);
    await tab.wait((e) => e.event === 'ai' && e.data?.type === 'activity');
    await tab.wait((e) => e.event === 'ops');
    await sleep(150);
    tab.close();
    for (const c of s.core.ai.state.clients) tokens.add(c.token);
    assert.ok(tab.state.events.some((e) => e.event === 'ai' && e.data?.type === 'connected'), 'the connect event arrived');
    assert.deepEqual(leaked(tab.state.raw, tokens), [], 'a key appeared in the event stream');
  });

  test('SSE: a hostile client id is never reflected into headers', async () => {
    for (const client of ['%0d%0aSet-Cookie:%20x=1', '<script>alert(1)</script>', 'a'.repeat(5000), '__proto__', '../../etc']) {
      const r = await request(P, { path: `/api/events?client=${client}`, headers: { 'x-ecosys': K }, headersOnly: true });
      assert.equal(r.status, 200);
      assert.equal(r.headers['set-cookie'], undefined);
      const headerText = Object.values(r.headers).join('\n');
      for (const v of new Set([client, decodeURIComponent(client)])) assert.ok(!headerText.includes(v), `client id ${JSON.stringify(v.slice(0, 40))} reflected into a header`);
    }
  });
});
