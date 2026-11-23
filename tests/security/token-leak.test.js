// Connection keys must only ever leave ai.json through the local browser API (GET /api/ai and the
// /api/ai/clients replies). Everywhere else (server log, error replies, tool output, activity,
// the SSE stream, data files, undo files, server.json, the Claude Desktop config, the stdio
// bridge's output) a key, current or rotated away, must never appear.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AIStore } from '../../server/ai-store.mjs';
import { BODY_LIMIT } from '../../server/http.mjs';
import {
  createScope, startServer, request, rawHttp, api, mcpPost, legacyCall, modernCall, openSse, runBridge, captureLog,
  bearer, nearMiss, leaked, ensureDir, PING, BS, sleep,
} from './_harness.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirText = (d) => (existsSync(d) ? readdirSync(d).map((n) => readFileSync(join(d, n), 'utf8')).join('\n') : '');

describe('connection keys never leak', () => {
  const scope = createScope('leak');
  after(() => scope.cleanup());

  test('a full session leaves no key in the log, error replies, tool output, activity, SSE or data files', async () => {
    const s = await startServer(scope, { allowedHosts: 'abc.trycloudflare.com' });
    s.core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cal1', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
    const tokens = new Set();
    const bodies = [];
    const keep = async (p) => {
      const r = await p;
      bodies.push(r.text, JSON.stringify(r.headers));
      return r;
    };
    const tab = openSse(s.port, { path: '/api/events?client=leak-tab' });
    await tab.ready;
    const A = (await api(s, 'POST', '/api/ai/clients', { kind: 'claude' })).json.client;
    const R = (await api(s, 'POST', '/api/ai/clients', { kind: 'chatgpt', access: 'read' })).json.client;
    const F = (await api(s, 'POST', '/api/ai/clients', { kind: 'other', label: 'Flood' })).json.client;
    for (const c of [A, R, F]) tokens.add(c.token);

    await keep(mcpPost(s, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'leak-probe', version: '1' } } }, bearer(A.token)));
    await keep(modernCall(s, A.token, 'server/discover'));
    await keep(legacyCall(s, A.token, 'tools/list'));
    const created = await keep(legacyCall(s, A.token, 'tools/call', { name: 'create_tasks', arguments: { tasks: [{ title: 'Leak check', notes: 'n' }, { text: 'Call mom tomorrow 6pm p1' }] } }));
    const taskId = created.json.result.structuredContent.created[0].task_id;
    const changeId = created.json.result.structuredContent.change_id;
    for (const [name, args] of [
      ['update_tasks', { tasks: [{ task_id: taskId, title: 'Leak check 2' }] }],
      ['complete_tasks', { task_ids: [taskId] }],
      ['find_tasks', { query: 'Leak' }],
      ['get_task', { task_id: taskId }],
      ['get_context', {}],
      ['get_overview', {}],
      ['find_changes', { limit: 50 }],
      ['create_events', { events: [{ title: 'Leak event', start: '2026-12-01T10:00', duration_minutes: 30 }] }],
      ['find_events', { from: '2026-11-01', to: '2026-12-31' }],
      ['find_free_time', { from: '2026-12-01', to: '2026-12-02' }],
      ['undo_change', { change_id: changeId }],
      ['get_task', { task_id: 'nope' }],
      ['create_tasks', { tasks: [{}] }],
      ['no_such_tool', {}],
      ['update_event', { event_id: 'nope', title: 'x' }],
    ]) await keep(legacyCall(s, A.token, 'tools/call', { name, arguments: args }));
    await keep(modernCall(s, A.token, 'tools/call', { name: 'get_context', arguments: {} }));
    await keep(legacyCall(s, R.token, 'tools/call', { name: 'create_tasks', arguments: { tasks: [{ title: 'nope' }] } }));
    await keep(mcpPost(s, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_context', arguments: {} } }, {}, `/s/${R.token}/mcp`));
    await api(s, 'POST', '/api/ai/mode', { mode: 'off' });
    await keep(legacyCall(s, A.token, 'tools/call', { name: 'get_overview', arguments: {} }));
    await api(s, 'POST', '/api/ai/mode', { mode: 'write' });
    await keep(mcpPost(s, '{"jsonrpc":', bearer(A.token)));
    await keep(mcpPost(s, JSON.stringify({ ...PING, pad: 'x'.repeat(BODY_LIMIT) }), bearer(A.token)));
    await keep(mcpPost(s, '[]', bearer(A.token)));
    for (const t of [A.token, R.token]) {
      await keep(mcpPost(s, PING, bearer(nearMiss(t))));
      await keep(mcpPost(s, PING, {}, `/s/${nearMiss(t)}/mcp`));
      await keep(api(s, 'POST', '/api/internal/notify', { events: [] }, bearer(nearMiss(t))));
    }
    await keep(request(s.port, { method: 'POST', path: '/mcp', host: 'abc.trycloudflare.com', body: PING, headers: bearer(A.token) }));
    await keep(request(s.port, { method: 'GET', path: '/api/ai', host: 'abc.trycloudflare.com', headers: { 'x-ecosys': s.secret } }));
    await keep(request(s.port, { method: 'GET', path: '/api/ai', headers: { 'x-ecosys': s.secret, origin: 'https://evil.example' } }));
    await keep(request(s.port, { method: 'GET', path: '/api/ai', headers: { 'x-ecosys': '1' } }));
    for (let i = 0; i < 121; i++) {
      const r = await legacyCall(s, F.token, 'ping', {}, i);
      if (i >= 119) bodies.push(r.text);
    }
    await keep(api(s, 'POST', '/api/ai/undo', { changeId: 'chg_nope' }));
    await keep(api(s, 'POST', '/api/ops', { ops: [{ op: 'put', c: 'tasks', item: { id: '<bad>' } }, { op: 'boom' }] }));
    await keep(api(s, 'POST', `/api/ai/clients/${A.id}`, { access: 'root' }));
    await keep(api(s, 'POST', '/api/ai/clients', { kind: 'hal' }));
    await keep(api(s, 'GET', '/api/state'));
    await keep(api(s, 'GET', '/api/hello'));
    const oldA = A.token;
    const rotated = (await api(s, 'POST', `/api/ai/clients/${A.id}`, { rotate: true })).json.client;
    tokens.add(rotated.token);
    await keep(legacyCall(s, oldA, 'ping'));
    await keep(legacyCall(s, rotated.token, 'tools/call', { name: 'find_changes', arguments: {} }));
    await api(s, 'DELETE', `/api/ai/clients/${R.id}`);
    await keep(legacyCall(s, R.token, 'ping'));
    await keep(api(s, 'POST', '/api/internal/notify', { events: [{ event: 'ai', data: { type: 'connected', clientName: 'bridge' } }] }, bearer(rotated.token)));
    await sleep(1300); // deferred read activity reaches ai.json about a second later
    s.core.ai.flush();
    await sleep(100);
    tab.close();
    s.app.writeServerInfo();

    const ai = JSON.parse(readFileSync(join(s.dataDir, 'ai.json'), 'utf8'));
    const activityApi = JSON.stringify((await api(s, 'GET', '/api/ai')).json.activity);
    const haystacks = {
      'the server log': s.log.text(),
      'MCP and API replies (bodies and headers)': bodies.join('\n'),
      'the SSE stream': tab.state.raw,
      'the activity list (GET /api/ai)': activityApi,
      'ai.json activity and change history': JSON.stringify({ activity: ai.activity, changes: ai.changes }),
      'undo files (changes/)': dirText(join(s.dataDir, 'changes')),
      'data.json': readFileSync(join(s.dataDir, 'data.json'), 'utf8'),
      'backups/': dirText(join(s.dataDir, 'backups')),
      'server.json': readFileSync(join(s.dataDir, 'server.json'), 'utf8'),
    };
    for (const [where, text] of Object.entries(haystacks)) assert.deepEqual(leaked(text, tokens), [], `a key leaked into ${where}`);
    // sanity: the haystacks really hold this session
    assert.ok(tab.state.events.some((e) => e.event === 'ai' && e.data?.type === 'activity'), 'activity reached the SSE stream');
    assert.ok(activityApi.includes('create_tasks') && haystacks['ai.json activity and change history'].includes('undo_change'));
    assert.ok(bodies.some((b) => b.includes('Rate limit')), 'the rate limit was hit');
    assert.ok(ai.clients.some((c) => c.token === rotated.token), 'ai.json itself does hold the keys');
  });

  test('a malformed request target that carries the secret path is a 400, and the key is not logged', async () => {
    const s = await startServer(scope);
    const c = s.core.ai.createClient({ kind: 'chatgpt' });
    const statuses = [];
    for (const target of [`/${BS}%/s/${c.token}/mcp`, `/${BS}[/s/${c.token}/mcp`]) {
      statuses.push((await rawHttp(s.port, { method: 'POST', target, headers: [['Content-Type', 'application/json']], body: JSON.stringify(PING) })).status);
    }
    assert.deepEqual({ statuses, keyInLog: leaked(s.log.text(), [c.token]) }, { statuses: [400, 400], keyInLog: [] });
  });

  test('error replies never echo a presented key, near misses included', async () => {
    const s = await startServer(scope);
    const c = s.core.ai.createClient({ kind: 'claude' });
    const presented = [nearMiss(c.token), `${c.token}x`, c.token.slice(0, -1), 'A'.repeat(43)];
    for (const p of presented) {
      for (const r of [
        await mcpPost(s, PING, bearer(p)),
        await mcpPost(s, PING, { authorization: p }),
        await mcpPost(s, PING, {}, `/s/${p}/mcp`),
        await api(s, 'POST', '/api/internal/notify', { events: [] }, bearer(p)),
        await mcpPost(s, PING, bearer(p), '/mcp', { method: 'GET' }),
      ]) {
        assert.ok(r.status >= 400, `${r.status}`);
        assert.deepEqual(leaked(r.text + JSON.stringify(r.headers), [p, c.token]), []);
      }
    }
    assert.deepEqual(leaked(s.log.text(), [c.token, ...presented]), []);
  });

  test('the stdio bridge never prints a key on stdout or stderr, right or wrong', async () => {
    const dir = scope.tempDir('bridge-leak');
    const c = new AIStore({ dir, log: silent }).createClient({ kind: 'claude', label: 'Claude Desktop' });
    const wrong = nearMiss(c.token);
    const calls = (label) => [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: `From the bridge (${label})` }] } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find_changes', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      '{ broken',
    ];
    for (const [label, args, env] of [
      ['--client <id>', ['--client', c.id], {}],
      ['--token <key>', ['--token', c.token], {}],
      ['ECOSYS_MCP_TOKEN', [], { ECOSYS_MCP_TOKEN: c.token }],
      ['a wrong --token', ['--token', wrong], {}],
      ['a wrong ECOSYS_MCP_TOKEN', [], { ECOSYS_MCP_TOKEN: wrong }],
    ]) {
      const r = await runBridge(dir, args, calls(label), { env });
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      assert.deepEqual(leaked(r.lines.join('\n') + r.tail, [c.token, wrong]), [], `${label}: stdout`);
      assert.deepEqual(leaked(r.stderr, [c.token, wrong]), [], `${label}: stderr`);
      if (label.startsWith('a wrong')) assert.equal(r.msgs.filter((m) => m.result).length, 0, `${label}: nothing ran`);
      else assert.equal(r.msgs.find((m) => m.id === 1)?.result?.isError, false, `${label}: the tool ran`);
    }
  });

  test('the Claude Desktop entry and server.json name the connection, never its key', async () => {
    const claudeDir = ensureDir(join(scope.tempDir('claude-leak'), 'Claude'));
    const cfg = join(claudeDir, 'claude_desktop_config.json');
    writeFileSync(cfg, '{"mcpServers":{}}');
    const s = await startServer(scope, { installPaths: [cfg] });
    const r = await api(s, 'POST', '/api/ai/install/claude-desktop', {});
    assert.equal(r.status, 200, r.text);
    const client = s.core.ai.get(r.json.clientId);
    const written = dirText(claudeDir);
    assert.ok(written.includes(client.id), 'the entry names the connection id');
    assert.deepEqual(leaked(written, [client.token]), [], 'the key was written into the Claude Desktop folder');
    s.app.writeServerInfo();
    assert.deepEqual(leaked(readFileSync(join(s.dataDir, 'server.json'), 'utf8'), [client.token]), []);
  });

  test('a corrupt ai.json grants nothing and never prints the whole key it holds', (t) => {
    const tok = crypto.randomBytes(32).toString('base64url');
    let longest = 0;
    for (const v of [
      `{"mode":"write","clients":[{"id":"abc","kind":"claude","token":"${tok}"x,"access":"write"}]}`,
      `{"mode":"write","clients":[{"id":"abc","kind":"claude","token":${tok}}]}`,
      `{"mode":"write","clients":[{"id":"abc","kind":"claude","token":"${tok}`,
      `{"clients":[{"token":"${tok}"}]}}`,
      `\u0000{"clients":[{"token":"${tok}"}]}`,
      `{"clients":[{"id":"abc","token":"${tok}"]}`,
    ]) {
      const dir = scope.tempDir('corrupt');
      writeFileSync(join(dir, 'ai.json'), v);
      const log = captureLog();
      const store = new AIStore({ dir, log });
      assert.equal(store.byToken(tok), null, 'a corrupt key file grants no access');
      const text = log.text();
      assert.deepEqual(leaked(text, [tok]), [], 'the whole key was printed');
      for (let i = 0; i < tok.length; i++) for (let j = i + longest + 1; j <= tok.length; j++) if (text.includes(tok.slice(i, j))) longest = j - i;
    }
    t.diagnostic(`longest fragment of a key in the corrupt-file log line: ${longest} of ${tok.length} characters`);
  });

  test('ai.json is private to the user (POSIX permissions)', { skip: process.platform === 'win32' ? 'Windows uses ACLs; POSIX mode bits do not apply' : false }, async () => {
    const s = await startServer(scope);
    s.core.ai.createClient({ kind: 'claude' });
    const mode = statSync(join(s.dataDir, 'ai.json')).mode & 0o777;
    assert.equal(mode & 0o077, 0, `ai.json mode ${mode.toString(8)}`);
  });
});
