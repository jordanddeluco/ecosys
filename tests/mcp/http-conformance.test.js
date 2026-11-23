// MCP conformance over Streamable HTTP, against an isolated `node server.mjs` (random port, temp data):
// transport rules (POST only, JSON only, 202 for notifications, no batches, auth, Origin/Host,
// limits), the legacy era (initialize handshake, version negotiation, MCP-Protocol-Version header,
// optional sessions, ping) and the 2026-07-28 era (server/discover, _meta, resultType, caching
// fields, Mcp-Method / Mcp-Name header checks, -32020 / -32022 / 404 -32601).
//
// Budget notes: the server allows 30 failed key checks a minute in total and 120 requests a minute
// per credential, so tests that send many requests use their own credential and the 401 tests stay
// well under 30.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startServer, HttpMcp, request, checkHttpEnvelope, checkModernResult, assertTodayLine, existsSync,
  MODERN, LEGACY, LATEST_LEGACY, K, CLIENT_INFO, NOTES_TOOLS_FILE, isPlainObject,
} from './helpers.js';

const V = MODERN[0];
const TUNNEL = 'mcp-conformance.trycloudflare.com';
const b64 = (s) => `=?base64?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const pingMsg = (id = 1) => ({ jsonrpc: '2.0', id, method: 'ping' });
const initMsg = (id = 1, protocolVersion = LATEST_LEGACY) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO } });

describe('MCP over Streamable HTTP (isolated server)', () => {
  /** @type {import('./helpers.js').Server} */
  let server;
  let writer;
  let today;
  const auth = (c = writer) => ({ authorization: `Bearer ${c.token}` });
  const legacy = (c = writer, opts = {}) => new HttpMcp(server, { token: c.token, era: 'legacy', version: LATEST_LEGACY, ...opts });
  const modern = (c = writer, opts = {}) => new HttpMcp(server, { token: c.token, era: 'modern', ...opts });
  // ecosys keeps at most 20 connections: per-test credentials are removed after each test.
  const temp = [];
  const fresh = async (label, kind = 'other', access = 'write') => {
    const c = await server.createClient({ kind, access, label });
    temp.push(c.id);
    return c;
  };
  afterEach(async () => {
    for (const id of temp.splice(0)) await server.deleteClient(id).catch(() => {});
  });

  before(async () => {
    server = await startServer({ env: { ECOSYS_ALLOWED_HOSTS: TUNNEL } });
    await server.ops([{ op: 'put', c: 'calendars', item: { id: 'calhttp', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
    writer = await server.createClient({ kind: 'claude', label: 'HTTP conformance' });
    today = (await modern(writer).ok('get_context')).data.today;
  });
  after(async () => {
    await server?.stop();
  });

  // ================================================================ transport

  describe('transport', () => {
    test('GET, DELETE and other non-POST methods on the endpoint are 405 with Allow: POST (never an SSE stream)', async () => {
      const cases = [
        ['GET', '/mcp', { accept: 'text/event-stream', ...auth() }],
        ['GET', '/mcp', auth()],
        ['DELETE', '/mcp', { 'mcp-session-id': 'abc', ...auth() }],
        ['PUT', '/mcp', auth()],
        ['PATCH', '/mcp', auth()],
        ['HEAD', '/mcp', auth()],
        ['GET', `/s/${writer.token}/mcp`, { accept: 'text/event-stream' }],
        ['DELETE', `/s/${writer.token}/mcp`, {}],
      ];
      for (const [method, path, headers] of cases) {
        const r = await request(server.port, { method, path, headers });
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.equal(r.headers.allow, 'POST', `${method} ${path}: Allow header`);
        assert.ok(!/event-stream/i.test(r.headers['content-type'] || ''), `${method} ${path} must not open a stream`);
        if (method !== 'HEAD') assert.match(r.headers['content-type'] || '', /^application\/json/, `${method} ${path}: JSON error body`);
      }
    });

    test('/.well-known/* is 404 and never a redirect (no OAuth discovery)', async () => {
      const paths = [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server',
        '/.well-known/openid-configuration',
        '/.well-known/mcp',
        '/.well-known/mcp.json',
        '/.well-known/',
      ];
      for (const path of paths) {
        for (const method of ['GET', 'POST']) {
          const r = await request(server.port, { method, path, headers: auth(), body: method === 'POST' ? {} : undefined });
          assert.equal(r.status, 404, `${method} ${path}`);
          assert.equal(r.headers.location, undefined, `${method} ${path} must not redirect`);
        }
      }
      const bare = await request(server.port, { method: 'GET', path: '/.well-known' });
      assert.equal(bare.status, 404);
      assert.equal(bare.headers.location, undefined);
    });

    test('every response is application/json, whatever the Accept header says', async () => {
      const c = await fresh('Accept variants');
      for (const accept of ['application/json, text/event-stream', 'text/event-stream', 'application/json', '*/*', undefined]) {
        const h = { accept };
        const l = legacy(c);
        const lm = [
          await l.request('initialize', { protocolVersion: LATEST_LEGACY, capabilities: {}, clientInfo: CLIENT_INFO }, { headers: h }),
          await l.request('tools/call', { name: 'get_context', arguments: {} }, { headers: h }),
          await l.request('no/such/method', {}, { headers: h }),
        ];
        const m = modern(c);
        const mm = [await m.request('server/discover', {}, { headers: h }), await m.request('tools/list', {}, { headers: h }), await m.request('no/such/method', {}, { headers: h })];
        // request() already checked: application/json, one JSON-RPC object, id echoed.
        for (const r of [...lm, ...mm]) assert.ok(r.status === 200 || r.status === 404, `Accept ${accept}: status ${r.status}`);
      }
    });

    test('notifications and client responses are accepted with 202 and an empty body', async () => {
      const msgs = [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'user cancelled' } },
        { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p1', progress: 1, total: 2 } },
        { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
        { jsonrpc: '2.0', method: 'notifications/something_new', params: { x: 1 } },
        { jsonrpc: '2.0', id: 99, result: {} },
        { jsonrpc: '2.0', id: 'srv-1', error: { code: -32601, message: 'not supported' } },
      ];
      for (const version of ['2025-06-18', undefined, V]) {
        for (const m of msgs) {
          const r = await request(server.port, { body: m, headers: { ...auth(), accept: 'application/json, text/event-stream', 'mcp-protocol-version': version, ...(version === V && m.method ? { 'mcp-method': m.method } : {}) } });
          assert.equal(r.status, 202, `${JSON.stringify(m)} (MCP-Protocol-Version ${version})`);
          assert.equal(r.text, '', `202 has no body: ${JSON.stringify(m)}`);
        }
      }
    });

    test('JSON-RPC error codes stay in the standard and MCP ranges (never the legacy -32000..-32019 block)', async () => {
      // MCP 2026-07-28: -32000..-32019 is legacy/implementation-defined and new code SHOULD NOT use
      // it; -32020..-32099 is reserved for the spec; application codes go outside -32768..-32000.
      const seen = new Map();
      const note = (what, r) => r.json?.error && seen.set(what, r.json.error.code);
      note('no key (401)', await request(server.port, { body: pingMsg() }));
      note('parse error', await request(server.port, { body: '{', headers: auth() }));
      note('batch', await request(server.port, { body: [pingMsg()], headers: auth() }));
      note('GET (405)', await request(server.port, { method: 'GET', headers: auth() }));
      note('bad origin (403)', await request(server.port, { body: pingMsg(), headers: { ...auth(), origin: 'https://evil.example' } }));
      const m = modern(writer);
      note('header mismatch', await m.request('tools/list', {}, { headers: { 'mcp-method': 'x' } }));
      note('unsupported version', await m.request('tools/list', {}, { meta: { ...m.meta(), [K.version]: '2030-01-01' }, headers: { 'mcp-protocol-version': '2030-01-01' } }));
      note('unknown method', await m.request('nope/nope'));
      note('unknown tool', await m.request('tools/call', { name: 'nope', arguments: {} }));
      const allowed = (code) => [-32700, -32600, -32601, -32602, -32603].includes(code) || (code >= -32099 && code <= -32020) || code > -32000 || code < -32768;
      const bad = [...seen].filter(([, code]) => !allowed(code)).map(([what, code]) => `${what}: ${code}`);
      assert.deepEqual(bad, [], 'error codes from the legacy implementation-defined range');
    });

    test('JSON-RPC batches are rejected with 400 and -32600', async () => {
      const batches = [[pingMsg(1)], [{ jsonrpc: '2.0', method: 'notifications/initialized' }], [], [pingMsg(1), pingMsg(2)]];
      for (const body of batches) {
        const r = await request(server.port, { body, headers: auth() });
        assert.equal(r.status, 400, JSON.stringify(body));
        checkHttpEnvelope(r);
        assert.equal(r.json.error.code, -32600, JSON.stringify(body));
        assert.ok(!Object.hasOwn(r.json, 'id'), 'a batch has no single id to echo');
      }
    });

    test('malformed messages: parse errors (-32700, no id) and invalid envelopes (-32600 / -32602)', async () => {
      const cases = [
        ['{"jsonrpc":', -32700],
        ['', -32700],
        ['not json', -32700],
        ['null', -32600],
        ['42', -32600],
        ['"ping"', -32600],
        [{ id: 1, method: 'ping' }, -32600, 1],
        [{ jsonrpc: '1.0', id: 1, method: 'ping' }, -32600, 1],
        [{ jsonrpc: '2.0', id: null, method: 'ping' }, -32600],
        [{ jsonrpc: '2.0', id: {}, method: 'ping' }, -32600],
        [{ jsonrpc: '2.0', id: true, method: 'ping' }, -32600],
        [{ jsonrpc: '2.0', id: 1, method: 7 }, -32600, 1],
        [{ jsonrpc: '2.0', id: 1 }, -32600, 1],
        [{ jsonrpc: '2.0', id: 1, method: 'ping', params: [1, 2] }, -32602, 1],
        [{ jsonrpc: '2.0', id: 1, method: 'ping', params: 'x' }, -32602, 1],
      ];
      for (const [body, code, id] of cases) {
        const r = await request(server.port, { body, headers: auth() });
        const what = typeof body === 'string' ? body : JSON.stringify(body);
        assert.equal(r.status, 400, what);
        checkHttpEnvelope(r);
        assert.equal(r.json.error.code, code, what);
        if (id === undefined) assert.ok(!Object.hasOwn(r.json, 'id'), `${what}: an unreadable id is omitted (never null)`);
        else assert.equal(r.json.id, id, `${what}: the readable id is echoed`);
      }
    });

    test('authentication: missing or wrong keys get 401, WWW-Authenticate: Bearer and a JSON-RPC error', async () => {
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_LEGACY, capabilities: {}, clientInfo: CLIENT_INFO } };
      const bad = [
        ['/mcp', {}],
        ['/mcp', { authorization: 'Bearer not-a-real-key' }],
        ['/mcp', { authorization: `Bearer ${writer.token}x` }],
        ['/mcp', { authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` }],
        [`/mcp?token=${writer.token}`, {}],
        [`/mcp?access_token=${writer.token}`, {}],
        [`/s/${writer.token.slice(0, -2)}zz/mcp`, {}],
        ['/s/short/mcp', {}],
      ];
      for (const [path, headers] of bad) {
        const r = await request(server.port, { path, body: init, headers });
        const what = `${path.replace(writer.token, '<key>')} ${JSON.stringify(headers).replace(writer.token, '<key>')}`;
        assert.equal(r.status, 401, what);
        assert.match(r.headers['www-authenticate'] || '', /^Bearer realm="ecosys"$/, `${what}: WWW-Authenticate`);
        assert.ok(!/resource_metadata/.test(r.headers['www-authenticate']), 'no OAuth protected-resource metadata is advertised');
        checkHttpEnvelope(r);
        assert.ok(r.json.error.code < 0);
      }
      const good = [
        ['/mcp', { authorization: `Bearer ${writer.token}` }],
        ['/mcp', { authorization: `bearer ${writer.token}` }],
        ['/mcp', { authorization: `BEARER   ${writer.token}` }],
        ['/mcp', { authorization: writer.token }],
        [`/s/${writer.token}/mcp`, {}],
      ];
      for (const [path, headers] of good) {
        const r = await request(server.port, { path, body: init, headers });
        assert.equal(r.status, 200, `${path === '/mcp' ? Object.values(headers)[0].replace(writer.token, '<key>') : 'secret path'} should authenticate`);
        checkHttpEnvelope(r, { id: 1 });
        assert.equal(r.json.result.protocolVersion, LATEST_LEGACY);
      }
    });

    test('the secret path serves both eras (connectors that cannot send headers)', async () => {
      const c = await fresh('Secret path', 'chatgpt');
      const l = new HttpMcp(server, { token: c.token, secretPath: c.secretPath, era: 'legacy', version: null });
      assert.equal((await l.initialize('2025-06-18')).result.protocolVersion, '2025-06-18');
      assert.equal((await l.notify('notifications/initialized')).status, 202);
      assert.equal((await l.call('get_context')).isError, false);
      const m = new HttpMcp(server, { token: c.token, secretPath: c.secretPath, era: 'modern' });
      assert.equal((await m.request('server/discover')).status, 200);
      assert.equal((await m.call('find_tasks', {})).isError, false);
    });

    test('Origin and Host are checked (DNS rebinding); no Origin, as from AI vendors, is fine', async () => {
      for (const origin of ['https://evil.example', `http://127.0.0.1:${server.port === 1 ? 2 : 1}`, 'null', `http://localhost.evil.example:${server.port}`]) {
        const r = await request(server.port, { body: pingMsg(), headers: { ...auth(), origin } });
        assert.equal(r.status, 403, `Origin ${origin}`);
      }
      for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, undefined]) {
        const r = await request(server.port, { body: pingMsg(), headers: { ...auth(), origin } });
        assert.equal(r.status, 200, `Origin ${origin}`);
      }
      for (const host of [`evil.example:${server.port}`, `127.0.0.1.nip.io:${server.port}`, `attacker.localhost:${server.port}`]) {
        const r = await request(server.port, { body: pingMsg(), headers: auth(), host });
        assert.equal(r.status, 403, `Host ${host}`);
      }
      for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
        const r = await request(server.port, { body: pingMsg(), headers: auth(), host });
        assert.equal(r.status, 200, `Host ${host}`);
      }
    });

    test('a rotated or removed key stops working at once', async () => {
      const c = await fresh('Lifecycle');
      assert.equal((await legacy(c).request('ping')).status, 200);
      const rotated = await server.updateClient(c.id, { rotate: true });
      assert.notEqual(rotated.token, c.token);
      assert.equal((await legacy(c).send(pingMsg())).status, 401, 'old key after rotation');
      assert.equal((await legacy(rotated).request('ping')).status, 200, 'new key after rotation');
      await server.deleteClient(c.id);
      assert.equal((await legacy(rotated).send(pingMsg())).status, 401, 'removed connection');
    });

    test('rate limit: 120 requests a minute per credential, then 429 with Retry-After; others are unaffected', async () => {
      const c = await fresh('Flood');
      const l = legacy(c);
      for (let i = 0; i < 120; i++) {
        const r = await l.request('ping');
        assert.equal(r.status, 200, `request ${i + 1}`);
      }
      const over = await l.send(pingMsg(121));
      assert.equal(over.status, 429);
      assert.ok(Number(over.headers['retry-after']) > 0, 'Retry-After header');
      checkHttpEnvelope(over);
      assert.equal((await legacy(writer).request('ping')).status, 200, 'another credential still works');
    });

    test('a body over the 2 MB limit is refused with 413 and a JSON-RPC error', async () => {
      const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'Huge', notes: 'a'.repeat(2 * 1024 * 1024) }] } } });
      const r = await request(server.port, { body: big, headers: { ...auth(), 'mcp-protocol-version': LATEST_LEGACY } });
      assert.equal(r.status, 413);
      checkHttpEnvelope(r);
      const st = await server.state();
      assert.ok(!st.data.tasks.some((t) => t.title === 'Huge'), 'nothing was created');
    });

    test('MCP responses carry the security headers (nosniff, no-cache) and no wildcard CORS', async () => {
      const c = legacy(writer);
      for (const r of [await c.request('ping'), await c.request('no/such/method'), await c.send({ jsonrpc: '2.0', method: 'notifications/initialized' }), await request(server.port, { method: 'GET', path: '/mcp', headers: auth() })]) {
        assert.equal(r.headers['x-content-type-options'], 'nosniff', `status ${r.status}`);
        assert.match(r.headers['cache-control'] || '', /no-cache|no-store/, `status ${r.status}`);
        assert.notEqual(r.headers['access-control-allow-origin'], '*');
      }
    });

    test('keep-alive: several requests, including a 202, share one connection cleanly', async () => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      try {
        const h = { ...auth(), 'mcp-protocol-version': LATEST_LEGACY };
        const seq = [initMsg(1), { jsonrpc: '2.0', method: 'notifications/initialized' }, pingMsg(2), { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_context', arguments: {} } }];
        const out = [];
        for (const body of seq) out.push(await request(server.port, { body, headers: h, agent }));
        assert.deepEqual(out.map((r) => r.status), [200, 202, 200, 200, 200]);
        out.forEach((r, i) => checkHttpEnvelope(r, { id: seq[i].id }));
        assert.ok(out.slice(1).every((r) => r.reusedSocket), 'the same socket carried every request');
        assert.equal(out[4].json.result.isError, false);
      } finally {
        agent.destroy();
      }
    });

    test('through an allowlisted tunnel host only the MCP endpoint answers', async () => {
      const ok = await request(server.port, { body: initMsg(1), headers: auth(), host: TUNNEL });
      assert.equal(ok.status, 200, 'MCP with a key through the tunnel');
      checkHttpEnvelope(ok, { id: 1 });
      const secret = await request(server.port, { path: `/s/${writer.token}/mcp`, body: initMsg(2), host: TUNNEL });
      assert.equal(secret.status, 200, 'secret path through the tunnel');
      const modernCall = await request(server.port, {
        body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {}, _meta: { [K.version]: V, [K.caps]: {}, [K.info]: CLIENT_INFO } } },
        headers: { ...auth(), 'mcp-protocol-version': V, 'mcp-method': 'tools/call', 'mcp-name': 'get_context' },
        host: TUNNEL,
      });
      assert.equal(modernCall.status, 200, 'modern framing through the tunnel');
      assert.equal(modernCall.json.result.isError, false);
      // AI vendors call from their own https origins; plain-http foreign origins are refused.
      assert.equal((await request(server.port, { body: pingMsg(), headers: { ...auth(), origin: 'https://chatgpt.com' }, host: TUNNEL })).status, 200);
      assert.equal((await request(server.port, { body: pingMsg(), headers: { ...auth(), origin: 'http://evil.example' }, host: TUNNEL })).status, 403);
      assert.equal((await request(server.port, { body: pingMsg(), host: TUNNEL })).status, 401, 'a key is still required');
      // Nothing else is reachable through the tunnel: not the browser API, not the apps.
      for (const [method, path, body] of [['GET', '/api/hello'], ['GET', '/api/ai'], ['GET', '/api/state'], ['POST', '/api/ai/mode', { mode: 'off' }], ['POST', '/api/ai/clients', { kind: 'other' }], ['GET', '/'], ['GET', '/tasks/'], ['GET', '/.well-known/oauth-protected-resource']]) {
        // Even with the pairing secret (a paired browser's header): the tunnel reaches MCP only.
        const r = await request(server.port, { method, path, body, host: TUNNEL, headers: { 'x-ecosys': server.secret } });
        assert.equal(r.status, 404, `${method} ${path} through the tunnel`);
        assert.ok(!(r.text || '').includes(writer.token), 'no key leaks');
      }
      assert.equal((await server.aiOverview()).mode, 'write', 'the mode was not changed through the tunnel');
      // A local proxy that rewrites Host to 127.0.0.1 still relays other people's requests.
      const fwd = { 'x-ecosys': server.secret, 'x-forwarded-for': '203.0.113.5' };
      assert.equal((await request(server.port, { method: 'GET', path: '/api/hello', headers: fwd })).status, 404, 'forwarded request: no browser API');
      assert.equal((await request(server.port, { body: pingMsg(), headers: { ...auth(), ...fwd } })).status, 200, 'forwarded request: MCP still works');
    });

    test('a burst of wrong keys is throttled (429) without locking out valid keys', async () => {
      // Runs last among the 401 tests: the failed-key budget is shared by all callers for a minute.
      let locked = null;
      for (let i = 0; i < 40 && !locked; i++) {
        const r = await request(server.port, { body: pingMsg(i), headers: { authorization: `Bearer wrong-key-${String(i).padStart(2, '0')}-${'x'.repeat(40)}` } });
        if (r.status === 429) locked = r;
        else assert.equal(r.status, 401);
      }
      assert.ok(locked, 'repeated wrong keys get 429');
      assert.ok(Number(locked.headers['retry-after']) > 0, 'Retry-After');
      checkHttpEnvelope(locked);
      assert.equal((await legacy(writer).request('ping')).status, 200, 'a valid key still works during the lockout');
    });
  });

  // ================================================================ legacy era

  describe('legacy era (2025-11-25 and older)', () => {
    test('lifecycle: initialize -> notifications/initialized -> tools/list -> tools/call -> ping', async () => {
      const c = legacy(await fresh('Legacy flow', 'chatgpt'), { version: null });
      const init = await c.initialize('2025-06-18', { clientInfo: { name: 'openai-mcp', version: '1.0.0' } });
      assert.equal(init.status, 200);
      const r = init.result;
      assert.equal(r.protocolVersion, '2025-06-18');
      assert.ok(isPlainObject(r.capabilities));
      assert.deepEqual(r.capabilities.tools, { listChanged: false });
      assert.equal(r.serverInfo?.name, 'ecosys');
      assert.equal(typeof r.serverInfo.version, 'string');
      assert.ok(typeof r.instructions === 'string' && r.instructions.trim().length > 20, 'instructions');
      for (const k of ['resultType', 'ttlMs', 'cacheScope']) assert.equal(r[k], undefined, `legacy results leave out ${k}`);
      assert.equal(r._meta?.[K.server], undefined, 'legacy results leave out _meta serverInfo');

      const note = await c.notify('notifications/initialized');
      assert.equal(note.status, 202);
      assert.equal(note.text, '');

      const list = await c.request('tools/list');
      assert.equal(list.status, 200);
      assert.ok(list.result.tools.length >= 17);
      for (const k of ['nextCursor', 'resultType', 'ttlMs', 'cacheScope']) assert.equal(list.result[k], undefined, `legacy tools/list leaves out ${k}`);

      const call = await c.call('get_context', {});
      assert.equal(call.isError, false);
      assert.equal(call.result.isError, false, 'isError is explicit');
      assert.equal(call.result.resultType, undefined);
      assert.match(call.text, /^Today is /);

      assert.deepEqual((await c.request('ping')).result, {});
    });

    test('version negotiation: supported versions are echoed, anything else gets the latest legacy version', async () => {
      const c = legacy(writer, { version: null });
      for (const v of LEGACY) assert.equal((await c.initialize(v)).result.protocolVersion, v, `initialize ${v}`);
      // initialize always selects legacy semantics, so even the modern version is answered with a legacy one.
      for (const v of ['2099-01-01', '1999-12-31', V, 'latest', '', 20251125, null, { v: 1 }]) {
        const r = await c.request('initialize', { protocolVersion: v, capabilities: {}, clientInfo: CLIENT_INFO });
        assert.equal(r.status, 200, `initialize ${JSON.stringify(v)}`);
        assert.equal(r.result.protocolVersion, LATEST_LEGACY, `initialize ${JSON.stringify(v)} -> latest legacy`);
      }
      const none = await c.request('initialize', { capabilities: {}, clientInfo: CLIENT_INFO });
      assert.equal(none.result.protocolVersion, LATEST_LEGACY, 'no protocolVersion');
      const bare = await c.request('initialize');
      assert.equal(bare.status, 200, 'initialize without capabilities/clientInfo is still answered');
    });

    test('MCP-Protocol-Version header: absent means 2025-03-26, supported values work, others are 400', async () => {
      const c = legacy(await fresh('Version header'), { version: null });
      assert.equal((await c.request('tools/list')).status, 200, 'absent header');
      for (const v of LEGACY) assert.equal((await c.request('ping', {}, { headers: { 'mcp-protocol-version': v } })).status, 200, v);
      for (const v of ['banana', '1999-01-01', '2025-13-45', '2025-06-18, 2025-11-25']) {
        for (const method of ['tools/list', 'tools/call', 'ping']) {
          const params = method === 'tools/call' ? { name: 'get_context', arguments: {} } : {};
          const r = await c.request(method, params, { headers: { 'mcp-protocol-version': v } });
          assert.equal(r.status, 400, `${method} with MCP-Protocol-Version ${v}`);
          assert.ok(r.error, `${method} ${v}: JSON-RPC error`);
          assert.equal(r.json.id, r.id, 'id echoed');
        }
      }
      // The modern version header without a modern _meta: required _meta fields are missing.
      const r = await c.request('tools/list', {}, { headers: { 'mcp-protocol-version': V } });
      assert.equal(r.status, 400);
      assert.equal(r.error.code, -32602);
    });

    test('a notification POST with an unsupported MCP-Protocol-Version is also 400 (transport MUST)', async () => {
      // 2025-06-18 transport: "If the server receives a request with an invalid or unsupported
      // MCP-Protocol-Version, it MUST respond with 400 Bad Request" — notifications are POSTs too.
      const r = await request(server.port, { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { ...auth(), 'mcp-protocol-version': 'banana' } });
      assert.equal(r.status, 400, `got ${r.status}`);
    });

    test('ping works at any time (before initialize too) and echoes every kind of id', async () => {
      const c = legacy(await fresh('Ping first'), { version: null });
      assert.deepEqual((await c.request('ping')).result, {}, 'ping before initialize');
      assert.deepEqual((await c.request('ping', {})).result, {});
      for (const id of [0, -7, Number.MAX_SAFE_INTEGER, '', 'abc-123', 'ünïcödé ✓']) {
        const r = await c.request('ping', undefined, { id });
        assert.equal(r.status, 200);
        assert.equal(r.json.id, id, `id ${JSON.stringify(id)} is echoed exactly`);
      }
      const raw = await c.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
      assert.equal(raw.status, 200, 'ping without params');
      assert.deepEqual(raw.json.result, {});
    });

    test('tools/list is deterministic and unpaginated; cursors and unknown methods are errors', async () => {
      const c = legacy(await fresh('List rules'));
      const a = await c.request('tools/list');
      const b = await c.request('tools/list');
      assert.deepEqual(a.result, b.result, 'same tools, same order');
      const names = a.result.tools.map((t) => t.name);
      assert.equal(new Set(names).size, names.length, 'tool names are unique');
      const cur = await c.request('tools/list', { cursor: 'abc' });
      assert.equal(cur.error?.code, -32602, 'any cursor is invalid when everything fits on one page');
      for (const m of ['resources/list', 'resources/templates/list', 'prompts/list', 'completion/complete', 'sampling/createMessage', 'tools/delete', 'server/discover']) {
        const r = await c.request(m);
        assert.equal(r.error?.code, -32601, `${m} -> method not found`);
        assert.ok([200, 404].includes(r.status), `${m}: status ${r.status}`);
      }
    });

    test('tools/call: unknown tools and malformed params are protocol errors, bad arguments are tool errors', async () => {
      const c = legacy(await fresh('Legacy call errors'));
      const unknown = await c.request('tools/call', { name: 'rm_rf', arguments: {} });
      assert.equal(unknown.error?.code, -32602);
      assert.match(unknown.error.message, /rm_rf/);
      for (const params of [{ arguments: {} }, { name: 42, arguments: {} }, { name: '', arguments: {} }, { name: 'get_context', arguments: [] }, { name: 'get_context', arguments: 'x' }]) {
        const r = await c.request('tools/call', params);
        assert.equal(r.error?.code, -32602, JSON.stringify(params));
      }
      const noArgs = await c.request('tools/call', { name: 'get_context' });
      assert.equal(noArgs.result?.isError, false, 'arguments are optional');
      const bad = await c.call('get_task', {});
      assert.equal(bad.isError, true, 'a missing required argument is a tool error the model can fix');
      assert.match(bad.text, /task_id/);
      assertTodayLine(bad.text, { today });
    });

    test('Mcp-Session-Id is optional: requests work with or without one', async () => {
      const c = legacy(await fresh('Sessions'), { version: null });
      const init = await c.initialize(LATEST_LEGACY);
      const sid = init.headers['mcp-session-id'];
      if (sid === undefined) {
        // Stateless legacy (recommended): no session is minted and none is required.
        assert.equal((await c.request('tools/list')).status, 200, 'no session header');
        assert.equal((await c.request('tools/list', {}, { headers: { 'mcp-session-id': 'made-up-session' } })).status, 200, 'an unknown session id is ignored');
        const del = await request(server.port, { method: 'DELETE', path: '/mcp', headers: { ...auth(), 'mcp-session-id': 'made-up-session' } });
        assert.equal(del.status, 405, 'DELETE to end a session MAY be 405');
      } else {
        assert.match(sid, /^[\x21-\x7E]+$/, 'session ids are visible ASCII');
        assert.equal((await c.request('tools/list', {}, { headers: { 'mcp-session-id': sid } })).status, 200);
        assert.equal((await c.request('tools/list')).status, 400, 'a server that mints sessions requires them');
        assert.equal((await c.request('tools/list', {}, { headers: { 'mcp-session-id': 'unknown' } })).status, 404, 'unknown session -> 404');
      }
    });

    test('_meta without a protocol version (e.g. a progressToken) keeps a request legacy', async () => {
      const c = legacy(await fresh('Progress token'));
      const call = await c.request('tools/call', { name: 'get_context', arguments: {}, _meta: { progressToken: 'p-1' } });
      assert.equal(call.status, 200);
      assert.equal(call.result?.isError, false);
      assert.equal(call.result.resultType, undefined, 'answered as legacy');
      const list = await c.request('tools/list', { _meta: { progressToken: 7 } });
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.result?.tools));
    });

    test('initialize is always legacy, even when params._meta carries a protocol version', async () => {
      // "An initialize request selects legacy semantics" — a client that adds _meta to every request
      // must still be able to fall back to the handshake.
      const c = legacy(await fresh('Initialize with _meta'), { version: null });
      const r = await c.request('initialize', { protocolVersion: LATEST_LEGACY, capabilities: {}, clientInfo: CLIENT_INFO, _meta: { [K.version]: V, [K.caps]: {}, [K.info]: CLIENT_INFO } });
      assert.equal(r.status, 200, `initialize with _meta -> ${r.status} ${JSON.stringify(r.error)}`);
      assert.equal(r.result?.protocolVersion, LATEST_LEGACY);
    });
  });

  // ================================================================ modern era

  describe('modern era (2026-07-28)', () => {
    test('server/discover: resultType, supportedVersions, capabilities, ttlMs/cacheScope and serverInfo', async () => {
      const c = modern(writer);
      const r = await c.request('server/discover', {}, { headers: { 'mcp-session-id': 'should-be-ignored' } });
      assert.equal(r.status, 200);
      assert.equal(r.headers['mcp-session-id'], undefined, 'modern: never mint or echo a session id');
      const d = r.result;
      assert.ok(Array.isArray(d.supportedVersions) && d.supportedVersions.every((v) => typeof v === 'string'));
      for (const v of [...MODERN, ...LEGACY]) assert.ok(d.supportedVersions.includes(v), `a dual-era server lists ${v}`);
      assert.ok(isPlainObject(d.capabilities));
      assert.deepEqual(d.capabilities.tools, { listChanged: false });
      assert.ok(typeof d.instructions === 'string' && d.instructions.trim().length > 20);
      assert.ok(Number.isInteger(d.ttlMs) && d.ttlMs >= 0, 'ttlMs is an integer >= 0');
      assert.ok(['public', 'private'].includes(d.cacheScope), 'cacheScope');
      // clientInfo is optional; logLevel is allowed
      assert.equal((await c.request('server/discover', {}, { meta: { [K.version]: V, [K.caps]: {} } })).status, 200, 'without clientInfo');
      assert.equal((await c.request('server/discover', {}, { meta: { ...c.meta(), [K.logLevel]: 'debug' } })).status, 200, 'with logLevel');
      // every version the legacy handshake can negotiate is advertised
      const l = legacy(writer, { version: null });
      for (const v of LEGACY) assert.ok(d.supportedVersions.includes((await l.initialize(v)).result.protocolVersion));
      // one server identity everywhere: discover, initialize and /api/hello agree on the version
      const init = (await l.initialize(LATEST_LEGACY)).result;
      const hello = await server.apiOk('GET', '/api/hello');
      assert.equal(d._meta[K.server].version, init.serverInfo.version);
      assert.equal(init.serverInfo.version, hello.version);
      assert.equal(d.instructions, init.instructions, 'the same instructions in both eras');
      // the instructions only promise notes when notes tools are actually offered
      const names = (await c.listTools()).map((t) => t.name);
      const hasNotes = names.some((n) => n.startsWith('notes_'));
      if (hasNotes) assert.match(d.instructions, /notes/i, 'notes tools exist, so the instructions mention notes');
      else assert.ok(!/notes_\w+|calendar and notes|notes app/i.test(d.instructions), `no notes tools (file present: ${existsSync(NOTES_TOOLS_FILE)}), so the instructions must not promise notes: ${d.instructions}`);
    });

    test('_meta: clientCapabilities is required, clientInfo optional, a malformed claim is never treated as legacy', async () => {
      const c = modern(await fresh('Meta rules'));
      const missing = await c.request('tools/list', {}, { meta: { [K.version]: V, [K.info]: CLIENT_INFO } });
      assert.equal(missing.status, 400);
      assert.equal(missing.error.code, -32602, 'missing clientCapabilities');
      for (const caps of ['yes', [], null, 1]) {
        const r = await c.request('tools/list', {}, { meta: { [K.version]: V, [K.caps]: caps } });
        assert.equal(r.status, 400, `clientCapabilities ${JSON.stringify(caps)}`);
        assert.equal(r.error.code, -32602);
      }
      assert.equal((await c.request('tools/list', {}, { meta: { [K.version]: V, [K.caps]: {} } })).status, 200, 'clientInfo is optional');
      for (const v of [20260728, null, {}, '']) {
        const r = await c.request('tools/list', {}, { meta: { [K.version]: v, [K.caps]: {} }, headers: { 'mcp-protocol-version': typeof v === 'string' ? v || undefined : String(v) } });
        assert.equal(r.status, 400, `protocolVersion ${JSON.stringify(v)}`);
        assert.ok([-32602, -32020, -32022].includes(r.error?.code), `protocolVersion ${JSON.stringify(v)}: ${JSON.stringify(r.error)}`);
      }
      // the modern version header with no (or a non-object) _meta: required fields are missing
      const noMeta = await c.request('tools/list', {}, { noMeta: true });
      assert.equal(noMeta.status, 400);
      assert.equal(noMeta.error.code, -32602);
      const strMeta = await c.request('tools/list', { _meta: 'x' }, { noMeta: true });
      assert.equal(strMeta.status, 400);
      assert.equal(strMeta.error.code, -32602);
    });

    test('results carry resultType and serverInfo; tools/list carries ttlMs and a private cacheScope', async () => {
      const c = modern(await fresh('Modern results'));
      const list = await c.request('tools/list'); // resultType + serverInfo are checked by request()
      assert.ok(Number.isInteger(list.result.ttlMs) && list.result.ttlMs >= 0);
      assert.equal(list.result.cacheScope, 'private', 'the tool list depends on the credential (read-only connections see fewer tools)');
      assert.equal(list.result.nextCursor, undefined);
      const ok = await c.call('get_context');
      assert.equal(ok.isError, false);
      const bad = await c.call('get_task', { task_id: 'no-such-task' });
      assert.equal(bad.isError, true);
      checkModernResult(bad.result);
    });

    test('header checks: MCP-Protocol-Version, Mcp-Method and Mcp-Name must match the body (400 / -32020)', async () => {
      const c = modern(await fresh('Header checks'));
      const call = { name: 'get_context', arguments: {} };
      const cases = [
        ['missing MCP-Protocol-Version', 'tools/list', {}, { 'mcp-protocol-version': undefined }],
        ['MCP-Protocol-Version differs from _meta', 'tools/list', {}, { 'mcp-protocol-version': LATEST_LEGACY }],
        ['missing Mcp-Method', 'tools/list', {}, { 'mcp-method': undefined }],
        ['missing Mcp-Method (discover)', 'server/discover', {}, { 'mcp-method': undefined }],
        ['Mcp-Method differs', 'tools/list', {}, { 'mcp-method': 'tools/call' }],
        ['Mcp-Method differs only in case', 'tools/list', {}, { 'mcp-method': 'Tools/List' }],
        ['tools/call without Mcp-Name', 'tools/call', call, { 'mcp-name': undefined }],
        ['Mcp-Name differs', 'tools/call', call, { 'mcp-name': 'get_overview' }],
        ['Mcp-Name differs only in case', 'tools/call', call, { 'mcp-name': 'GET_CONTEXT' }],
        ['base64 Mcp-Name decodes to another name', 'tools/call', call, { 'mcp-name': b64('get_overview') }],
      ];
      for (const [what, method, params, headers] of cases) {
        const r = await c.request(method, params, { headers });
        assert.equal(r.status, 400, what);
        assert.equal(r.error?.code, -32020, `${what}: ${JSON.stringify(r.error)}`);
        assert.equal(r.json.id, r.id, `${what}: id echoed`);
      }
      // Header names are case-insensitive; the sentinel is decoded before comparing.
      const caps = await request(server.port, {
        rawHeaders: true,
        body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { ...call, _meta: c.meta() } }),
        headers: {
          Host: `127.0.0.1:${server.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          AUTHORIZATION: `Bearer ${c.token}`, 'MCP-PROTOCOL-VERSION': V, 'MCP-METHOD': 'tools/call', 'MCP-NAME': 'get_context',
        },
      });
      assert.equal(caps.status, 200, 'upper-case header names');
      assert.equal((await c.call('get_context', {}, { headers: { 'mcp-name': b64('get_context') } })).isError, false, 'base64 sentinel');
      // A non-ASCII name travels in the sentinel: the header check passes, then the tool is unknown.
      const intl = await c.request('tools/call', { name: 'café_tool', arguments: {} }, { headers: { 'mcp-name': b64('café_tool') } });
      assert.equal(intl.error?.code, -32602, `decoded before comparing: ${JSON.stringify(intl.error)}`);
    });

    test('unsupported protocol versions -> 400 / -32022 with data.supported and data.requested', async () => {
      const c = modern(await fresh('Unsupported versions'));
      for (const [method, params] of [['tools/list', {}], ['server/discover', {}], ['tools/call', { name: 'get_context', arguments: {} }]]) {
        for (const v of ['2030-01-01', '1900-01-01', '2026-07-29', 'draft', LATEST_LEGACY]) {
          const r = await c.request(method, params, { meta: { ...c.meta(), [K.version]: v }, headers: { 'mcp-protocol-version': v } });
          const what = `${method} with _meta protocolVersion ${v}`;
          assert.equal(r.status, 400, what);
          assert.equal(r.error?.code, -32022, `${what}: ${JSON.stringify(r.error)}`);
          assert.equal(r.error.data?.requested, v, `${what}: data.requested`);
          assert.ok(Array.isArray(r.error.data.supported) && r.error.data.supported.includes(V), `${what}: data.supported lists ${V}`);
          assert.equal(r.json.id, r.id);
        }
      }
    });

    test('unknown or removed methods -> 404 / -32601', async () => {
      const c = modern(await fresh('Unknown methods'));
      for (const m of ['prompts/list', 'prompts/get', 'resources/list', 'resources/read', 'completion/complete', 'logging/setLevel', 'no/such/method']) {
        const r = await c.request(m, m === 'resources/read' ? { uri: 'ecosys://x' } : {}, { headers: m === 'resources/read' || m === 'prompts/get' ? { 'mcp-name': 'x' } : {} });
        assert.equal(r.status, 404, m);
        assert.equal(r.error?.code, -32601, m);
      }
      // A JSON-only server has nothing to stream: subscriptions/listen is either not implemented
      // (-32601) or completes at once.
      const sub = await c.request('subscriptions/listen', { notifications: {} });
      if (sub.error) {
        assert.equal(sub.status, 404);
        assert.equal(sub.error.code, -32601);
      } else assert.equal(sub.result.resultType, 'complete');
    });

    test('tools/call: results, tool errors and protocol errors', async () => {
      const c = modern(await fresh('Modern calls'));
      const ok = await c.call('find_tasks', {});
      assert.equal(ok.isError, false);
      const unknown = await c.request('tools/call', { name: 'drop_database', arguments: {} });
      assert.equal(unknown.error?.code, -32602);
      assert.ok([200, 400].includes(unknown.status));
      const badArgs = await c.request('tools/call', { name: 'get_context', arguments: [1] });
      assert.equal(badArgs.error?.code, -32602);
      const noName = await c.request('tools/call', { arguments: {} });
      assert.equal(noName.error?.code, -32602);
      const toolErr = await c.call('get_event', { event_id: 'nope' });
      assert.equal(toolErr.isError, true);
      assertTodayLine(toolErr.text, { today });
    });
  });

  // ================================================================ both eras

  test('the tool list is identical in both eras', async () => {
    const a = await legacy(writer).listTools();
    const b = await modern(writer).listTools();
    assert.deepEqual(a, b);
  });
});
