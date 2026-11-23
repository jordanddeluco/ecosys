// The MCP endpoint under attack (server/http.mjs handleMcp, server/mcp.mjs, server/core.mjs):
// missing / malformed / near-miss / smuggled keys, the secret path, constant-time key comparison,
// read-only keys and modes, the per-key and failed-auth rate limits, Origin rules, JSON-RPC edge
// cases and adversarial natural-language input. Tests that send many bad keys get their own server,
// because failed attempts share one server-wide limit.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { AIStore } from '../../server/ai-store.mjs';
import { createLimiter, BODY_LIMIT } from '../../server/http.mjs';
import { safeEqual } from '../../server/util.mjs';
import { createScope, startServer, api, mcpPost, legacyCall, modernCall, rawHttp, bearer, nearMiss, leaked, tooLargeOrReset, PING, sleep } from './_harness.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };

describe('MCP endpoint: keys, access and rate limits', () => {
  const scope = createScope('mcp');
  after(() => scope.cleanup());

  async function fresh(opts) {
    const s = await startServer(scope, opts);
    s.core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cal1', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
    s.writer = s.core.ai.createClient({ kind: 'claude' });
    s.reader = s.core.ai.createClient({ kind: 'grok', access: 'read' });
    return s;
  }
  let foreignToken;
  before(() => {
    const other = new AIStore({ dir: scope.tempDir('other-store'), log: silent });
    foreignToken = other.createClient({ kind: 'claude' }).token; // a real key, from another ecosys
  });

  test('missing, malformed, near-miss and misplaced keys get 401, a JSON-RPC error and no result', async () => {
    const s = await fresh();
    const t = s.writer.token;
    const b64 = (x) => Buffer.from(x).toString('base64');
    const variants = [
      ['no Authorization', {}],
      ['scheme only', { authorization: 'Bearer' }],
      ['short junk', { authorization: 'Bearer x' }],
      ['key plus a character', { authorization: `Bearer ${t}x` }],
      ['key minus its last character', { authorization: `Bearer ${t.slice(0, -1)}` }],
      ['last character changed', { authorization: `Bearer ${nearMiss(t)}` }],
      ['first character changed', { authorization: `Bearer ${(t[0] === 'A' ? 'B' : 'A') + t.slice(1)}` }],
      ['upper-cased key', { authorization: `Bearer ${t.toUpperCase() === t ? t.toLowerCase() : t.toUpperCase()}` }],
      ['key then extra words', { authorization: `Bearer ${t} extra` }],
      ['two credentials in one header', { authorization: `Bearer ${t},Bearer ${t}` }],
      ['Basic auth carrying the key', { authorization: `Basic ${b64(`ecosys:${t}`)}` }],
      ['another scheme', { authorization: `Token ${t}` }],
      ['scheme after the key', { authorization: `${t} Bearer` }],
      ['quoted key', { authorization: `Bearer "${t}"` }],
      ['key with base64 padding', { authorization: `Bearer ${t}=` }],
      ['a real key from another ecosys', { authorization: `Bearer ${foreignToken}` }],
      ['well-formed unknown key', { authorization: `Bearer ${'A'.repeat(43)}` }],
      ['over-long key', { authorization: `Bearer ${t.repeat(5)}` }],
      ['bare key too short', { authorization: t.slice(0, 31) }],
      ['bare key with a space inside', { authorization: `${t.slice(0, 20)} ${t.slice(20)}` }],
      ['X-Api-Key header', { 'x-api-key': t }],
      ['cookie', { cookie: `token=${t}; key=${t}` }],
      ['Proxy-Authorization', { 'proxy-authorization': `Bearer ${t}` }],
      ['query ?token=', {}, `/mcp?token=${t}`],
      ['query ?access_token=', {}, `/mcp?access_token=${t}`],
      ['query ?key=', {}, `/mcp?key=${t}`],
    ];
    assert.ok(variants.length < 30, 'stay under the failed-auth limit');
    const activityBefore = s.core.ai.recentActivity(200).length;
    for (const [label, headers, path] of variants) {
      const r = await mcpPost(s, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } }, headers, path);
      assert.equal(r.status, 401, `${label} -> ${r.status}`);
      assert.equal(r.json?.jsonrpc, '2.0', label);
      assert.ok(r.json.error.code < 0, label);
      assert.equal(r.json.result, undefined, label);
      assert.equal(r.headers['www-authenticate'], 'Bearer realm="ecosys"', label);
      assert.deepEqual(leaked(r.text, [t, foreignToken, nearMiss(t)]), [], `${label}: a presented key was echoed`);
    }
    s.core.ai.refresh();
    assert.equal(s.core.ai.recentActivity(200).length, activityBefore, 'no tool ran');
    assert.equal(s.core.ai.get(s.writer.id).lastSeen, null, 'the real key was never counted as seen');
  });

  test('accepted forms: Bearer in any case and spacing, the bare key, and the secret path', async () => {
    const s = await fresh();
    const t = s.writer.token;
    for (const [label, headers, path] of [
      ['Bearer', { authorization: `Bearer ${t}` }],
      ['bearer', { authorization: `bearer ${t}` }],
      ['BEARER', { authorization: `BEARER ${t}` }],
      ['extra spaces', { authorization: `  Bearer    ${t}  ` }],
      ['tab', { authorization: `Bearer\t${t}` }],
      ['bare key', { authorization: t }],
      ['bare key with spaces around', { authorization: ` ${t} ` }],
      ['secret path', {}, `/s/${t}/mcp`],
      ['secret path with a query', {}, `/s/${t}/mcp?x=1`],
      ['secret path with doubled leading slash', {}, `//s/${t}/mcp`],
    ]) {
      const r = await mcpPost(s, PING, headers, path);
      assert.equal(r.status, 200, `${label} -> ${r.status} ${r.text.slice(0, 120)}`);
      assert.deepEqual(r.json.result, {}, label);
    }
  });

  test('secret-path spellings that are not exactly the key are refused; the path identity wins over a header', async () => {
    const s = await fresh();
    const t = s.writer.token;
    const pct = `%${t.charCodeAt(0).toString(16).toUpperCase()}${t.slice(1)}`;
    for (const [path, statuses] of [
      [`/s/${pct}/mcp`, [401]],
      [`/s/${t}x/mcp`, [401]],
      [`/s/${t.slice(1)}/mcp`, [401]],
      [`/s/${nearMiss(t)}/mcp`, [401]],
      [`/s/${t.toUpperCase() === t ? t.toLowerCase() : t.toUpperCase()}/mcp`, [401]],
      [`/s/${t}/mcp/`, [404, 405]],
      [`/s/${t}/MCP`, [404, 405]],
      [`/S/${t}/mcp`, [404, 405]],
      [`/s/${t}%2Fmcp`, [404, 405]],
      [`/s/${t}/mcp;x`, [404, 405]],
      ['/s//mcp', [400, 404, 405]],
      [`/s/${t}/x/mcp`, [400, 404, 405]],
    ]) {
      const r = await mcpPost(s, PING, {}, path);
      assert.ok(statuses.includes(r.status), `${path} -> ${r.status}`);
      assert.ok(!r.json?.result, `${path} ran`);
      assert.deepEqual(leaked(r.text, [t]), []);
    }
    const wrongPathGoodHeader = await mcpPost(s, PING, bearer(t), `/s/${nearMiss(t)}/mcp`);
    assert.equal(wrongPathGoodHeader.status, 401, 'a wrong secret path is not rescued by a valid header');
    const other = s.core.ai.createClient({ kind: 'other', label: 'Other' });
    const r = await mcpPost(s, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } }, bearer(other.token), `/s/${t}/mcp`);
    assert.equal(r.json.result.isError, false);
    assert.equal(s.core.ai.recentActivity(1)[0].clientId, s.writer.id, 'the secret path decides who is calling');
  });

  test('GET, DELETE, PUT and OPTIONS on MCP are 405 for valid and invalid keys alike (no key oracle)', async () => {
    const s = await fresh();
    const t = s.writer.token;
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
      const good = await mcpPost(s, undefined, bearer(t), '/mcp', { method });
      const bad = await mcpPost(s, undefined, bearer(nearMiss(t)), '/mcp', { method });
      const goodPath = await mcpPost(s, undefined, {}, `/s/${t}/mcp`, { method });
      const badPath = await mcpPost(s, undefined, {}, `/s/${nearMiss(t)}/mcp`, { method });
      for (const r of [good, bad, goodPath, badPath]) {
        assert.equal(r.status, 405, method);
        assert.equal(r.headers.allow, 'POST');
      }
      assert.equal(good.text, bad.text, `${method}: same body`);
      assert.equal(goodPath.text, badPath.text, `${method}: same body on the secret path`);
    }
  });

  test('a rotated or removed key stops working at once, also when another process edits ai.json', async () => {
    const s = await fresh();
    const c = s.core.ai.createClient({ kind: 'chatgpt' });
    const oldToken = c.token; // createClient returns the stored object, which rotation updates in place
    assert.equal((await legacyCall(s, oldToken, 'ping')).status, 200);
    const rotated = (await api(s, 'POST', `/api/ai/clients/${c.id}`, { rotate: true })).json.client;
    assert.ok(rotated.token !== oldToken, 'rotation issued a new key');
    assert.equal((await legacyCall(s, oldToken, 'ping')).status, 401, 'old key');
    assert.equal((await mcpPost(s, PING, {}, `/s/${oldToken}/mcp`)).status, 401, 'old secret path');
    assert.equal((await legacyCall(s, rotated.token, 'ping')).status, 200, 'new key');
    // Another process (e.g. the stdio bridge, or a second server) removes the connection.
    const other = new AIStore({ dir: s.dataDir, log: silent });
    other.deleteClient(c.id);
    assert.equal((await legacyCall(s, rotated.token, 'ping')).status, 401, 'removed elsewhere');
  });

  test('keys are compared in constant time: one timingSafeEqual per stored key on fixed-length digests', async () => {
    const s = await fresh();
    for (let i = 0; i < 3; i++) s.core.ai.createClient({ kind: 'other', label: `Extra ${i}` });
    const n = s.core.ai.state.clients.length;
    const first = s.core.ai.state.clients[0];
    const original = crypto.timingSafeEqual;
    const calls = [];
    crypto.timingSafeEqual = (a, b) => {
      calls.push([a.length, b.length]);
      return original(a, b);
    };
    syncBuiltinESMExports();
    try {
      const results = {};
      for (const [label, send] of [
        ['wrong key', () => legacyCall(s, nearMiss(first.token), 'ping')],
        ['first stored key', () => legacyCall(s, first.token, 'ping')],
        ['wrong secret path', () => mcpPost(s, PING, {}, `/s/${nearMiss(first.token)}/mcp`)],
      ]) {
        calls.length = 0;
        results[label] = (await send()).status;
        assert.equal(calls.length, n, `${label}: ${calls.length} comparisons for ${n} stored keys (no early exit)`);
        assert.ok(calls.every(([a, b]) => a === 32 && b === 32), `${label}: compared SHA-256 digests, not raw strings`);
      }
      assert.deepEqual(results, { 'wrong key': 401, 'first stored key': 200, 'wrong secret path': 401 });
    } finally {
      crypto.timingSafeEqual = original;
      syncBuiltinESMExports();
    }
  });

  test('safeEqual compares exactly', () => {
    const k = crypto.randomBytes(32).toString('base64url');
    assert.equal(safeEqual(k, `${k}`), true);
    assert.equal(safeEqual(k, nearMiss(k)), false);
    assert.equal(safeEqual(k, k.slice(0, -1)), false);
    assert.equal(safeEqual(k, `${k}A`), false);
    assert.equal(safeEqual(k, `${k}\u0000`), false);
    assert.equal(safeEqual('', ''), false, 'an empty key never matches');
    assert.equal(safeEqual(k, undefined), false);
    assert.equal(safeEqual(undefined, undefined), false);
    assert.equal(safeEqual(null, null), false);
    assert.equal(safeEqual(['a'], ['a']), false);
    assert.equal(safeEqual('héllo-wörld-0123456789-0123456789', 'héllo-wörld-0123456789-0123456789'), true);
  });

  test('a read-only key never sees or runs a write tool (every write tool is checked)', async () => {
    const s = await fresh();
    const all = (await legacyCall(s, s.writer.token, 'tools/list')).json.result.tools;
    const writeTools = all.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    assert.ok(writeTools.length >= 8, `write tools: ${writeTools.join(', ')}`);
    for (const list of [(await legacyCall(s, s.reader.token, 'tools/list')).json.result.tools, (await modernCall(s, s.reader.token, 'tools/list')).json.result.tools]) {
      assert.deepEqual(list.filter((t) => writeTools.includes(t.name)).map((t) => t.name), [], 'write tools listed for a read-only key');
    }
    const revBefore = s.core.store.rev;
    const changesBefore = s.core.ai.recentChanges(200).length;
    for (const name of writeTools) {
      for (const send of [
        () => legacyCall(s, s.reader.token, 'tools/call', { name, arguments: {} }),
        () => mcpPost(s, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: { tasks: [{ title: 'nope' }] } } }, {}, `/s/${s.reader.token}/mcp`),
        () => modernCall(s, s.reader.token, 'tools/call', { name, arguments: {} }),
      ]) {
        const r = await send();
        assert.equal(r.status, 200, name);
        assert.equal(r.json.result?.isError, true, `${name} ran for a read-only key: ${r.text.slice(0, 200)}`);
        assert.match(r.json.result.content[0].text, /read-only/, name);
      }
    }
    assert.equal(s.core.store.rev, revBefore, 'no data changed');
    assert.equal(s.core.ai.recentChanges(200).length, changesBefore, 'no change records');
    const read = await legacyCall(s, s.reader.token, 'tools/call', { name: 'get_context', arguments: {} });
    assert.equal(read.json.result.isError, false, 'read tools still work');
  });

  test('mode "read" makes every key read-only; mode "off" blocks every tool; both survive a restart', async () => {
    const s = await fresh();
    const all = (await legacyCall(s, s.writer.token, 'tools/list')).json.result.tools.map((t) => t.name);
    const writeTools = (await legacyCall(s, s.writer.token, 'tools/list')).json.result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
    const revBefore = s.core.store.rev;
    assert.equal((await api(s, 'POST', '/api/ai/mode', { mode: 'read' })).status, 200);
    const listed = (await legacyCall(s, s.writer.token, 'tools/list')).json.result.tools.map((t) => t.name);
    assert.deepEqual(listed.filter((n) => writeTools.includes(n)), [], 'mode read hides write tools');
    for (const name of writeTools) {
      const r = await legacyCall(s, s.writer.token, 'tools/call', { name, arguments: {} });
      assert.equal(r.json.result.isError, true, name);
      assert.match(r.json.result.content[0].text, /read-only/);
    }
    assert.equal((await api(s, 'POST', '/api/ai/mode', { mode: 'off' })).status, 200);
    for (const key of [s.writer.token, s.reader.token]) {
      for (const name of all) {
        for (const send of [() => legacyCall(s, key, 'tools/call', { name, arguments: {} }), () => modernCall(s, key, 'tools/call', { name, arguments: {} })]) {
          const r = await send();
          assert.equal(r.json.result?.isError, true, `${name} ran in mode off`);
          assert.match(r.json.result.content[0].text, /AI access is turned off in ecosys/, name);
        }
      }
    }
    // The mode is stored with the keys, so a restarted server (or the stdio bridge) also refuses.
    assert.equal(new AIStore({ dir: s.dataDir, log: silent }).mode(), 'off');
    assert.equal(s.core.store.rev, revBefore, 'no data changed in read or off mode');
    await api(s, 'POST', '/api/ai/mode', { mode: 'write' });
  });

  test('per-key rate limit: 120 requests a minute, one bucket shared by the bearer and secret-path forms', async () => {
    const s = await fresh();
    const c = s.core.ai.createClient({ kind: 'other', label: 'Flood' });
    for (let i = 0; i < 60; i++) assert.equal((await legacyCall(s, c.token, 'ping', {}, i)).status, 200, `bearer ${i}`);
    for (let i = 0; i < 60; i++) assert.equal((await mcpPost(s, { ...PING, id: i }, {}, `/s/${c.token}/mcp`)).status, 200, `secret path ${i}`);
    for (const r of [await legacyCall(s, c.token, 'ping'), await mcpPost(s, PING, {}, `/s/${c.token}/mcp`), await mcpPost(s, PING, { authorization: c.token })]) {
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers['retry-after']) > 0);
      assert.equal(r.json.result, undefined);
      assert.deepEqual(leaked(r.text, [c.token]), []);
    }
    assert.equal((await legacyCall(s, s.writer.token, 'ping')).status, 200, 'other keys are not affected');
  });

  test('failed-key limit: after 30 bad keys a minute further guesses get 429, while valid keys keep working', async () => {
    const s = await fresh();
    for (let i = 0; i < 30; i++) {
      const guess = `Bearer ${crypto.randomBytes(32).toString('base64url')}`;
      assert.equal((await mcpPost(s, PING, { authorization: guess })).status, 401, `guess ${i}`);
    }
    const blocked = await mcpPost(s, PING, { authorization: `Bearer ${nearMiss(s.writer.token)}` });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '60');
    assert.deepEqual(leaked(blocked.text, [nearMiss(s.writer.token), s.writer.token]), []);
    assert.equal((await mcpPost(s, PING, {}, `/s/${nearMiss(s.writer.token)}/mcp`)).status, 429, 'secret-path guesses are limited too');
    assert.equal((await mcpPost(s, PING, {})).status, 429, 'so are requests without a key');
    assert.equal((await legacyCall(s, s.writer.token, 'ping')).status, 200, 'a valid key still works during the lockout');
    assert.equal((await mcpPost(s, PING, {}, `/s/${s.reader.token}/mcp`)).status, 200, 'a valid secret path too');
  });

  test('createLimiter: a sliding window; refused hits are not counted; idle keys are swept', () => {
    let now = 0;
    const lim = createLimiter(3, 1000, () => now);
    assert.deepEqual([lim.hit('a'), lim.hit('a'), lim.hit('a')], [false, false, false]);
    now = 500;
    assert.equal(lim.hit('a'), true, '4th in the window is refused');
    for (let i = 0; i < 100; i++) lim.hit('a');
    assert.equal(lim.size('a'), 3, 'refused hits are not stored');
    assert.equal(lim.hit('b'), false, 'keys are independent');
    now = 999;
    assert.equal(lim.hit('a'), true);
    now = 1000;
    assert.equal(lim.hit('a'), false, 'the oldest hit left the window');
    now = 5000;
    lim.sweep();
    assert.equal(lim.size('a'), 0);
    assert.equal(lim.size('b'), 0);
  });

  test('local MCP accepts only the Origin of ecosys itself (checked before the key)', async () => {
    const s = await fresh();
    const P = s.port;
    for (const origin of [`http://localhost:${P + 1}`, `https://127.0.0.1:${P}`, 'null', 'https://claude.ai', 'https://evil.example', `http://127.0.0.1:${P}.evil.example`, [`http://127.0.0.1:${P}`, 'https://evil.example']]) {
      const r = await mcpPost(s, PING, { ...bearer(s.writer.token), origin });
      assert.equal(r.status, 403, `Origin ${origin}`);
      assert.equal(r.json.result, undefined);
    }
    for (const origin of [`http://127.0.0.1:${P}`, `http://localhost:${P}`, `http://[::1]:${P}`]) {
      assert.equal((await mcpPost(s, PING, { ...bearer(s.writer.token), origin })).status, 200, origin);
    }
  });

  test('body limits on MCP: the key is checked first, then the size', async () => {
    const s = await fresh();
    const r = await rawHttp(s.port, { method: 'POST', target: '/mcp', headers: [['Content-Type', 'application/json'], ['Content-Length', String(BODY_LIMIT + 1)]], timeout: 4000 });
    assert.equal(r.status, 401, 'no key: refused without reading the body');
    const big = await rawHttp(s.port, { method: 'POST', target: '/mcp', headers: [['Content-Type', 'application/json'], ['Authorization', `Bearer ${s.writer.token}`], ['Content-Length', String(BODY_LIMIT + 1)]], timeout: 4000 });
    assert.equal(big.status, 413);
    const real = await mcpPost(s, JSON.stringify({ ...PING, pad: 'x'.repeat(BODY_LIMIT) }), bearer(s.writer.token));
    assert.ok(tooLargeOrReset(real), `${real.status} ${real.error || ''}`);
    assert.equal((await legacyCall(s, s.writer.token, 'ping')).status, 200, 'still answering');
  });

  test('JSON-RPC edge cases with a valid key are answered, never crash or 500', async () => {
    const s = await fresh();
    const key = bearer(s.writer.token);
    const cases = [
      ['[]', 400], ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', 400], ['{"jsonrpc":"2.0","id":null,"method":"ping"}', 400], ['{"jsonrpc":"2.0","id":{},"method":"ping"}', 400],
      ['{"jsonrpc":"2.0","id":[1],"method":"ping"}', 400], ['{"jsonrpc":"2.0","id":true,"method":"ping"}', 400], ['{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}', 400],
      ['{"jsonrpc":"2.0","id":1,"method":7}', 400], ['{"jsonrpc":"1.0","id":1,"method":"ping"}', 400], ['{"id":1,"method":"ping"}', 400], ['null', 400], ['"x"', 400], ['1', 400],
      ['', 400], ['{', 400], ['{"a":'.repeat(20000) + '1' + '}'.repeat(20000), 400], ['﻿{"jsonrpc":"2.0","id":1,"method":"ping"}', 400],
      [`{"jsonrpc":"2.0","id":"${'i'.repeat(100000)}","method":"ping"}`, 200], ['{"jsonrpc":"2.0","method":"notifications/anything"}', 202], ['{"jsonrpc":"2.0","result":{}}', 202],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"toString","arguments":{}}}', 200], ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hasOwnProperty"}}', 200],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_context","arguments":"x"}}', 200], ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":["get_context"]}}', 200],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_tasks","arguments":{"tasks":[' + '{"title":"x"},'.repeat(300) + '{"title":"y"}]}}}', 200],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_tasks","arguments":{"tasks":[{"title":"' + 'x'.repeat(100000) + '"}]}}}', 200],
    ];
    const revBefore = s.core.store.rev;
    for (const [body, status] of cases) {
      const r = await mcpPost(s, body, key);
      assert.equal(r.status, status, `${body.slice(0, 60)} -> ${r.status} ${r.text.slice(0, 160)}`);
      if (status === 200 && body.includes('tools/call')) assert.ok(r.json.error || r.json.result?.isError === true, `${body.slice(0, 60)} should be refused: ${r.text.slice(0, 160)}`);
    }
    assert.equal(s.core.store.rev, revBefore, 'none of these changed data');
    assert.equal((await legacyCall(s, s.writer.token, 'ping')).status, 200, 'still answering');
    assert.equal(s.log.entries.filter((e) => e.level === 'error').length, 0, s.log.text());
  });

  test('client-supplied names (clientInfo) are stripped of control characters and capped before they reach the UI', async () => {
    const s = await fresh();
    const hostile = `\u0000\u001b[2J<script>alert(1)</script>${'n'.repeat(500)}`;
    await mcpPost(s, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: hostile, version: `\u0007${'v'.repeat(300)}` } } }, bearer(s.writer.token));
    await modernCall(s, s.reader.token, 'server/discover', {}, 1);
    s.core.ai.refresh();
    const stored = s.core.ai.get(s.writer.id).lastClientName;
    assert.ok(stored && stored.length <= 80, `stored name length ${stored?.length}`);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(stored), 'control characters removed');
    for (const a of s.core.ai.recentActivity(50)) assert.ok(!a.clientName || (a.clientName.length <= 80 && !/[\u0000-\u001f\u007f]/.test(a.clientName)));
    const overview = (await api(s, 'GET', '/api/ai')).json;
    const c = overview.clients.find((x) => x.id === s.writer.id);
    assert.ok(c.lastClientName.length <= 80);
  });

  test('adversarial natural-language input is parsed quickly (no catastrophic backtracking)', async () => {
    const s = await fresh();
    const T = 1000;
    const texts = [
      'every '.repeat(200), 'tomorrow at '.repeat(90), '9'.repeat(T), 'p1 '.repeat(330), '#'.repeat(T), '@'.repeat(T), 'every 2 weeks on mon, wed at 9:30pm until dec 1 '.repeat(20),
      ' '.repeat(T - 1) + 'x', '1:'.repeat(T / 2), '2026-'.repeat(T / 5), '9-10 '.repeat(T / 5), 'for 1h '.repeat(T / 7), '1.'.repeat(T / 2), '12am'.repeat(T / 4), 'in 2 days '.repeat(T / 10),
      '(((('.repeat(T / 4), '\u{1F600}'.repeat(T / 4), 'at at at at '.repeat(T / 12), 'next next next '.repeat(T / 15), 'every other '.repeat(T / 12),
    ].map((x) => x.slice(0, T));
    const started = performance.now();
    for (const text of texts) {
      for (const [name, args] of [['create_tasks', { tasks: [{ text }] }], ['create_events', { events: [{ text }] }]]) {
        const t0 = performance.now();
        const r = await legacyCall(s, s.writer.token, 'tools/call', { name, arguments: args });
        const ms = performance.now() - t0;
        assert.equal(r.status, 200);
        assert.ok(ms < 5000, `${name} took ${Math.round(ms)} ms for ${JSON.stringify(text.slice(0, 24))}...`);
      }
    }
    assert.ok(performance.now() - started < 30000, 'whole batch');
    for (const [name, args] of [
      ['find_events', { from: '1900-01-01', to: '2900-01-01' }],
      ['find_free_time', { from: '1900-01-01', to: '2900-01-01', duration_minutes: 5 }],
      ['get_overview', { days: 100000 }],
    ]) {
      const t0 = performance.now();
      const r = await legacyCall(s, s.writer.token, 'tools/call', { name, arguments: args });
      assert.ok(performance.now() - t0 < 5000, `${name} with a huge range`);
      assert.equal(r.json.result.isError, true, `${name}: huge ranges are refused, not computed`);
    }
    await sleep(0);
  });
});
