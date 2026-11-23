// MCP conformance over stdio: mcp/stdio-bridge.mjs driven line by line, as Claude Desktop / Claude
// Code drive it. Both eras, newline framing, stdout hygiene, exit on EOF, credentials and modes
// shared with a running HTTP server (an isolated `node server.mjs` on the same temp data folder),
// and the bridge working on its own once that server is gone.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  startServer, StdioMcp, HttpMcp, assertTodayLine, todayIn, addDays, sleep, makeTempDir, removeDir, childEnv,
  ROOT, MODERN, LEGACY, LATEST_LEGACY, K, isPlainObject,
} from './helpers.js';

const V = MODERN[0];

describe('MCP over stdio (mcp/stdio-bridge.mjs)', () => {
  /** @type {import('./helpers.js').Server} */
  let server;
  let writer;
  let reader;
  let today;
  const live = new Set();

  /** Run `fn` against a fresh bridge, then close stdin and check the exit code and stdout. */
  async function session(opts, fn) {
    const b = new StdioMcp({ dataDir: server.dataDir, clientId: writer.id, ...opts });
    live.add(b);
    let closed;
    try {
      await fn(b);
    } finally {
      closed = await b.close().catch((e) => ({ code: -1, error: e }));
      live.delete(b);
    }
    assert.equal(closed.code, 0, `the bridge exits with 0 when stdin closes (${closed.error?.message || ''} stderr: ${b.stderr.slice(-300)})`);
    b.assertCleanStdout();
    return { bridge: b, closed };
  }
  const initParams = (protocolVersion = LATEST_LEGACY) => ({ protocolVersion, capabilities: {}, clientInfo: { name: 'claude-desktop', version: '1.0.0' } });

  before(async () => {
    server = await startServer();
    await server.ops([{ op: 'put', c: 'calendars', item: { id: 'calstdio', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
    writer = await server.createClient({ kind: 'claude', label: 'Claude Desktop' });
    reader = await server.createClient({ kind: 'claude', access: 'read', label: 'Claude read-only' });
    today = (await new HttpMcp(server, { token: writer.token }).ok('get_context')).data.today;
  });
  after(async () => {
    for (const b of live) b.kill();
    await server?.stop();
  });

  test('legacy lifecycle: initialize -> notifications/initialized (no output) -> tools/list -> tools/call -> ping', async () => {
    await session({}, async (b) => {
      const init = await b.request('initialize', initParams('2025-11-25'));
      const r = init.result;
      assert.equal(r.protocolVersion, '2025-11-25');
      // stdio sessions are told when their tool list changes (Connect AI access, AI or notes access).
      assert.deepEqual(r.capabilities.tools, { listChanged: true });
      assert.equal(r.serverInfo.name, 'ecosys');
      assert.ok(typeof r.instructions === 'string' && r.instructions.length > 20);
      assert.equal(r.resultType, undefined, 'legacy results leave out resultType');
      const before = b.lines.length;
      b.notify('notifications/initialized');
      assert.deepEqual((await b.request('ping')).result, {});
      assert.equal(b.lines.length, before + 1, 'the notification got no reply; the next line answered the ping');
      const list = await b.request('tools/list');
      assert.ok(list.result.tools.length >= 17);
      assert.equal(list.result.ttlMs, undefined);
      b.tools = new Map(list.result.tools.map((t) => [t.name, t]));
      const ctx = await b.call('get_context');
      assert.equal(ctx.isError, false);
      assert.equal(ctx.result.resultType, undefined);
      assert.ok(isPlainObject(ctx.data));
      const w = await b.call('create_tasks', { tasks: [{ text: 'Stdio buy milk tomorrow p1' }] });
      assert.equal(w.isError, false, w.text);
      const t = w.data.created[0];
      assert.deepEqual([t.title, t.date, t.priority], ['Stdio buy milk', addDays(today, 1), 'P1']);
      assert.match(w.data.change_id, /^chg_/);
    });
  });

  test('legacy version negotiation over stdio', async () => {
    await session({}, async (b) => {
      for (const v of LEGACY) assert.equal((await b.request('initialize', initParams(v))).result.protocolVersion, v, v);
      for (const v of ['2099-01-01', V, '', null]) {
        assert.equal((await b.request('initialize', initParams(v))).result.protocolVersion, LATEST_LEGACY, `initialize ${JSON.stringify(v)}`);
      }
    });
  });

  test('modern over stdio: server/discover, tools/list and tools/call with _meta only (no headers)', async () => {
    await session({}, async (b) => {
      const d = (await b.modern('server/discover')).result;
      for (const v of [...MODERN, ...LEGACY]) assert.ok(d.supportedVersions.includes(v), v);
      assert.deepEqual(d.capabilities.tools, { listChanged: false });
      assert.ok(typeof d.instructions === 'string' && d.instructions.length > 20);
      assert.ok(Number.isInteger(d.ttlMs) && d.ttlMs >= 0);
      assert.ok(['public', 'private'].includes(d.cacheScope));
      const list = (await b.modern('tools/list')).result;
      assert.ok(Number.isInteger(list.ttlMs) && list.ttlMs >= 0);
      assert.equal(list.cacheScope, 'private');
      b.tools = new Map(list.tools.map((t) => [t.name, t]));
      assert.equal((await b.call('get_context', {}, { modern: true })).isError, false);
      const err = await b.call('get_task', { task_id: 'nope' }, { modern: true });
      assert.equal(err.isError, true);
      assert.equal(err.result.resultType, 'complete');
      assertTodayLine(err.text, { today });
      // A request without clientInfo is fine; the identity is optional.
      assert.ok((await b.modern('tools/list', {}, { meta: { [K.version]: V, [K.caps]: {} } })).result);
    });
  });

  test('modern errors over stdio: -32022, -32602, -32601; subscriptions/listen is acknowledged, then completed', async () => {
    await session({}, async (b) => {
      for (const [method, v] of [['tools/list', '2030-01-01'], ['server/discover', '1900-01-01'], ['tools/call', 'draft']]) {
        const m = await b.request(method, { ...(method === 'tools/call' ? { name: 'get_context', arguments: {} } : {}), _meta: { [K.version]: v, [K.caps]: {} } });
        assert.equal(m.error?.code, -32022, `${method} ${v}`);
        assert.equal(m.error.data?.requested, v);
        assert.ok(m.error.data.supported.includes(V));
      }
      assert.equal((await b.request('tools/list', { _meta: { [K.version]: V } })).error?.code, -32602, 'missing clientCapabilities');
      assert.equal((await b.request('tools/list', { _meta: { [K.version]: V, [K.caps]: 'x' } })).error?.code, -32602, 'non-object clientCapabilities');
      for (const m of ['prompts/list', 'resources/list', 'no/such/method']) assert.equal((await b.modern(m)).error?.code, -32601, m);
      const from = b.messages.length;
      const sub = await b.modern('subscriptions/listen', { notifications: {} });
      const ackAt = b.messages.findIndex((x, i) => i >= from && x.method === 'notifications/subscriptions/acknowledged');
      assert.ok(ackAt >= 0, 'the acknowledgement notification is sent');
      const ack = b.messages[ackAt];
      assert.deepEqual(ack.params.notifications, {}, 'nothing to subscribe to');
      assert.equal(ack.params._meta?.[K.sub], sub.id);
      assert.ok(ackAt < b.messages.indexOf(sub), 'acknowledged before completing');
      assert.equal(sub.result._meta?.[K.sub], sub.id);
      // The bridge is still answering (a dual-era client may probe it with methods it lacks).
      assert.deepEqual((await b.request('ping')).result, {});
    });
  });

  test('framing: CRLF, several messages per chunk, a message split across chunks, blank lines; bad input is answered, never fatal', async () => {
    await session({}, async (b) => {
      b.sentIds.push('crlf', 'a', 'b', 'c', 'split', 'after');
      b.write('{"jsonrpc":"2.0","id":"crlf","method":"ping"}\r\n');
      await b.waitFor((m) => m.id === 'crlf', { what: 'the CRLF ping' });
      b.write(['a', 'b', 'c'].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })).join('\n') + '\n');
      for (const id of ['a', 'b', 'c']) await b.waitFor((m) => m.id === id, { what: `ping ${id}` });
      const msg = JSON.stringify({ jsonrpc: '2.0', id: 'split', method: 'tools/call', params: { name: 'get_context', arguments: {} } });
      b.write(msg.slice(0, 10));
      await sleep(60);
      b.write(msg.slice(10, 40));
      await sleep(60);
      b.write(msg.slice(40) + '\n');
      const split = await b.waitFor((m) => m.id === 'split', { what: 'the split request' });
      assert.equal(split.result?.isError, false);
      b.write('\n\n   \n\r\n');
      b.write('{ not json\n');
      b.write('[{"jsonrpc":"2.0","id":"in-batch","method":"ping"}]\n');
      b.write('{"jsonrpc":"2.0","id":null,"method":"ping"}\n');
      b.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"nothing","reason":"test"}}\n');
      b.write('{"jsonrpc":"2.0","id":"after","method":"ping"}\n');
      await b.waitFor((m) => m.id === 'after', { what: 'the ping after the bad lines' });
      const anonymous = b.messages.filter((m) => !Object.hasOwn(m, 'id'));
      assert.deepEqual(anonymous.map((m) => m.error?.code), [-32700, -32600, -32600], 'parse error, batch, null id: answered without an id');
      assert.ok(!b.messages.some((m) => m.id === 'in-batch'), 'a batch is rejected as a whole');
      assert.equal(b.lines.length, 9, `one line per request, none for blank lines or notifications: ${JSON.stringify(b.lines)}`);
    });
  });

  test('a line over the 4 MB message limit is refused, and the bridge keeps answering', async () => {
    await session({}, async (b) => {
      b.sentIds.push('after-big');
      b.write('a'.repeat(4.5 * 1024 * 1024));
      b.write('\n{"jsonrpc":"2.0","id":"after-big","method":"ping"}\n');
      const ping = await b.waitFor((m) => m.id === 'after-big', { what: 'the ping after the oversized line', timeout: 20000 });
      assert.deepEqual(ping.result, {});
      const errors = b.messages.filter((m) => !Object.hasOwn(m, 'id')).map((m) => m.error?.code);
      assert.ok(errors.length >= 1 && errors.every((c) => c === -32600 || c === -32700), `the oversized input is answered with errors: ${JSON.stringify(errors)}`);
    });
  });

  test('one JSON object per line, even when the data holds newlines and non-ASCII text', async () => {
    await session({}, async (b) => {
      const title = 'Stdio ünïcödé ✓ 日本語 🚀';
      const w = await b.call('create_tasks', { tasks: [{ title, notes: 'Line one\nLine two\r\nLine three\ttabbed — 日本語' }] });
      assert.equal(w.isError, false, w.text);
      const t = (await b.call('get_task', { task_id: w.data.created[0].task_id })).data.task;
      assert.equal(t.title, title);
      assert.match(t.notes, /Line one\nLine two/);
      assert.match(t.notes, /日本語/);
      for (const line of b.lines) assert.ok(!line.includes('\r'), 'no raw CR inside a line');
    });
  });

  test('exits promptly (code 0) when stdin closes, after answering what was already sent', async () => {
    const b = new StdioMcp({ dataDir: server.dataDir, clientId: writer.id });
    live.add(b);
    b.send({ jsonrpc: '2.0', id: 'last-1', method: 'ping' });
    b.send({ jsonrpc: '2.0', id: 'last-2', method: 'tools/call', params: { name: 'get_context', arguments: {} } });
    const r = await b.close();
    live.delete(b);
    assert.equal(r.code, 0);
    assert.ok(r.ms < 3000, `exited ${r.ms} ms after stdin closed`);
    assert.deepEqual(b.messages.map((m) => m.id).sort(), ['last-1', 'last-2'], 'requests sent before EOF are answered');
    b.assertCleanStdout();
  });

  test('the bridge and the HTTP server share data, undo history, activity and credentials', async () => {
    const http = new HttpMcp(server, { token: writer.token });
    await session({}, async (b) => {
      const w = await b.call('create_tasks', { tasks: [{ title: 'Made over stdio' }] });
      const id = w.data.created[0].task_id;
      assert.ok((await server.state()).data.tasks.some((t) => t.id === id), 'GET /api/state sees the bridge\'s write');
      assert.equal((await http.ok('find_tasks', { query: 'Made over stdio' })).data.total, 1, 'MCP over HTTP sees it too');
      const h = await http.ok('create_tasks', { tasks: [{ title: 'Made over HTTP' }] });
      assert.equal((await b.call('find_tasks', { query: 'Made over HTTP' })).data.total, 1, 'and the other way round');
      const u = await b.call('undo_change', { change_id: h.data.change_id });
      assert.equal(u.isError, false, u.text);
      assert.equal(u.data.restored, 1);
      assert.equal((await http.ok('find_tasks', { query: 'Made over HTTP' })).data.total, 0, 'an HTTP change undone over stdio');
      const ai = await server.aiOverview();
      assert.ok(ai.activity.some((a) => a.clientId === writer.id && a.tool === 'create_tasks' && /Made over stdio/.test(a.summary)), 'the bridge\'s activity is in the shared feed');
      assert.ok(ai.activity.some((a) => a.tool === 'undo_change' && a.clientId === writer.id));
    });
  });

  test('concurrent writers (stdio bridge and HTTP server, two processes) never lose an update', async () => {
    // Up to three rounds of 2 x 20 simultaneous writes: the lock contention this test looks for is
    // timing dependent, so one round alone can miss it.
    const N = 20;
    const failures = [];
    const saved = [];
    const before = await server.state();
    for (let round = 0; round < 3 && !failures.length; round++) {
      const http = new HttpMcp(server, { token: (await server.createClient({ kind: 'other', label: `Race HTTP ${round}` })).token });
      await http.listTools();
      await session({}, async (b) => {
        await b.listTools();
        const title = (side, i) => `Race ${round} ${side} ${i}`;
        const viaStdio = Array.from({ length: N }, (_, i) => b.call('create_tasks', { tasks: [{ title: title('stdio', i) }] }).then((r) => [title('stdio', i), r]));
        const viaHttp = Array.from({ length: N }, (_, i) => http.call('create_tasks', { tasks: [{ title: title('http', i) }] }).then((r) => [title('http', i), r]));
        for (const [t, r] of await Promise.all([...viaStdio, ...viaHttp])) {
          if (r.isError) failures.push(`${t}: ${r.text.split('\n')[0]}`);
          else saved.push([t, r.data.change_id]);
        }
      });
    }
    const st = await server.state();
    for (const [t] of saved) assert.ok(st.data.tasks.some((x) => x.title === t), `${t} was saved and must still be there (no lost update)`);
    assert.equal(new Set(saved.map(([, c]) => c)).size, saved.length, 'every write is its own change');
    assert.equal(st.rev, before.rev + saved.length, 'one data revision per successful write, across both processes');
    assert.deepEqual(failures, [], `writes failed under cross-process lock contention (${failures.length} of ${saved.length + failures.length})`);
  });

  test('the cross-process data lock behind every MCP write never fails or double-grants under contention', async (t) => {
    // Root cause check for the test above, made deterministic: three processes take the lock in
    // server/util.mjs 300 times each and increment a shared counter inside it.
    const util = await import(pathToFileURL(join(ROOT, 'server', 'util.mjs')).href);
    if (typeof util.createLock !== 'function') return t.skip('server/util.mjs no longer exports createLock');
    const dir = makeTempDir('ecosys-mcp-lock-');
    try {
      const worker = join(dir, 'lock-worker.mjs');
      writeFileSync(worker, [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const [,, utilUrl, dir, n] = process.argv;',
        'const { createLock } = await import(utilUrl);',
        "const lock = createLock(join(dir, 'lock'));",
        "const counter = join(dir, 'counter.txt');",
        'const errors = {};',
        'let ok = 0;',
        'for (let i = 0; i < Number(n); i++) {',
        '  try {',
        "    lock(() => writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)));",
        '    ok++;',
        '  } catch (e) {',
        '    errors[e.code || e.message] = (errors[e.code || e.message] || 0) + 1;',
        '  }',
        '}',
        'process.stdout.write(JSON.stringify({ ok, errors }));',
      ].join('\n'));
      writeFileSync(join(dir, 'counter.txt'), '0');
      const utilUrl = pathToFileURL(join(ROOT, 'server', 'util.mjs')).href;
      const results = await Promise.all(
        [1, 2, 3].map(
          () =>
            new Promise((resolveRun, reject) => {
              const p = spawn(process.execPath, [worker, utilUrl, dir, '300'], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
              let out = '';
              let err = '';
              p.stdout.on('data', (c) => (out += c));
              p.stderr.on('data', (c) => (err += c));
              p.on('error', reject);
              p.on('close', () => {
                try {
                  resolveRun(JSON.parse(out));
                } catch {
                  reject(new Error(`lock worker failed: ${err || out}`));
                }
              });
            }),
        ),
      );
      const ok = results.reduce((a, r) => a + r.ok, 0);
      const counter = Number(readFileSync(join(dir, 'counter.txt'), 'utf8'));
      assert.equal(counter, ok, `mutual exclusion: ${ok - counter} increments were lost`);
      const errors = results.map((r) => r.errors).filter((e) => Object.keys(e).length);
      assert.deepEqual(errors, [], `taking the lock threw instead of waiting (${ok} of 900 succeeded): ${JSON.stringify(errors)}`);
    } finally {
      removeDir(dir);
    }
  });

  test('activity of read calls made over stdio is saved before the bridge exits', async () => {
    // Clients often run a bridge for a few calls and close it (Claude Code on Windows closes stdin,
    // then kills the process tree ~300 ms later). Read activity must not be lost on the way out.
    const probe = `stdio-read-probe-${Date.now()}`;
    await session({}, async (b) => {
      assert.equal((await b.call('find_tasks', { query: probe })).isError, false);
    });
    const ai = await server.aiOverview();
    const hit = ai.activity.find((a) => a.clientId === writer.id && a.tool === 'find_tasks' && a.summary.includes(probe));
    assert.ok(hit, `the find_tasks call is in the activity feed: ${JSON.stringify(ai.activity.slice(0, 3))}`);
  });

  test('a read-only connection over stdio sees only read tools and cannot write', async () => {
    await session({ clientId: reader.id }, async (b) => {
      const tools = await b.listTools();
      assert.deepEqual(await b.listTools({ modern: true }), tools, 'same in both eras');
      assert.ok(tools.length >= 8);
      for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.ok(!tools.some((t) => t.name === 'create_tasks'));
      const w = await b.call('create_tasks', { tasks: [{ title: 'Read-only stdio attempt' }] });
      assert.equal(w.isError, true);
      assert.match(w.text, /read-only/);
      assert.ok(!(await server.state()).data.tasks.some((t) => t.title === 'Read-only stdio attempt'));
      assert.equal((await b.call('find_tasks', {})).isError, false);
    });
  });

  test('mode changes made in ecosys reach a running bridge at once (off, read, write)', async () => {
    await session({}, async (b) => {
      assert.equal((await b.call('get_context')).isError, false);
      try {
        await server.setMode('off');
        const off = await b.call('get_context');
        assert.equal(off.isError, true);
        assert.match(off.text, /AI access is turned off in ecosys/);
        assertTodayLine(off.text, { today });
        await server.setMode('read');
        const tools = await b.listTools();
        assert.ok(tools.every((t) => t.annotations.readOnlyHint === true), 'mode read: read tools only');
        assert.match((await b.call('create_tasks', { tasks: [{ title: 'Mode read stdio' }] })).text, /read-only/);
      } finally {
        await server.setMode('write');
      }
      await b.listTools();
      assert.equal((await b.call('get_context')).isError, false, 'back to normal');
    });
  });

  test('a missing, unknown or removed connection: every request gets an error naming Connect AI, and the bridge stays up', async () => {
    for (const clientId of ['deadbeefdeadbeef', null]) {
      const { bridge } = await session({ clientId }, async (b) => {
        const init = await b.request('initialize', initParams());
        assert.match(init.error?.message || '', /Connect AI/, 'initialize');
        b.notify('notifications/initialized');
        assert.match((await b.request('tools/list')).error?.message || '', /Connect AI/);
        assert.ok((await b.modern('server/discover')).error, 'discover');
        assert.ok((await b.request('ping')).error, 'even ping needs a connection');
      });
      assert.match(bridge.stderr, clientId ? /no connection matches/ : /--client/, 'the reason is logged to stderr');
    }
    const temp = await server.createClient({ kind: 'other', label: 'Removed while running' });
    await session({ clientId: temp.id }, async (b) => {
      assert.deepEqual((await b.request('ping')).result, {});
      await server.deleteClient(temp.id);
      const after = await b.request('tools/list');
      assert.match(after.error?.message || '', /Connect AI/, 'a connection removed in ecosys stops working at once');
    });
  });

  test('credentials and data folder: --token, ECOSYS_MCP_TOKEN and ECOSYS_DATA_DIR (without --data) work', async () => {
    await session({ clientId: null, args: ['--token', writer.token] }, async (b) => {
      assert.equal((await b.call('get_context')).isError, false, '--token');
    });
    await session({ clientId: null, token: writer.token }, async (b) => {
      assert.equal((await b.call('get_context')).isError, false, 'ECOSYS_MCP_TOKEN');
    });
    await session({ dataArg: false }, async (b) => {
      const w = await b.call('create_tasks', { tasks: [{ title: 'Via ECOSYS_DATA_DIR' }] });
      assert.equal(w.isError, false, w.text);
    });
    assert.ok((await server.state()).data.tasks.some((t) => t.title === 'Via ECOSYS_DATA_DIR'), 'written to the temp data folder');
  });

  test('dates and error texts follow the bridge\'s own time zone (TZ=Asia/Tokyo)', async () => {
    const zone = 'Asia/Tokyo';
    await session({ env: { TZ: zone } }, async (b) => {
      const tokyoToday = todayIn(zone);
      const ctx = (await b.call('get_context')).data;
      assert.equal(ctx.time_zone, zone);
      assert.equal(ctx.utc_offset, '+09:00');
      assert.ok(ctx.today === tokyoToday || ctx.today === addDays(tokyoToday, 1), `today in Tokyo: ${ctx.today} vs ${tokyoToday}`);
      const err = await b.call('get_task', { task_id: 'nope' });
      assertTodayLine(err.text, { today: ctx.today, zone, offset: '+09:00' });
      const w = await b.call('create_tasks', { tasks: [{ title: 'Tokyo tomorrow', date: 'tomorrow' }] });
      assert.equal(w.data.created[0].date, addDays(ctx.today, 1));
    });
  });

  test('tool definitions over stdio are the ones served over HTTP (both eras)', async () => {
    const httpTools = await new HttpMcp(server, { token: writer.token }).listTools();
    const httpRead = await new HttpMcp(server, { token: reader.token, era: 'legacy', version: LATEST_LEGACY }).listTools();
    await session({}, async (b) => {
      assert.deepEqual(await b.listTools(), httpTools, 'legacy over stdio = HTTP');
      assert.deepEqual(await b.listTools({ modern: true }), httpTools, 'modern over stdio = HTTP');
    });
    await session({ clientId: reader.id }, async (b) => {
      assert.deepEqual(await b.listTools(), httpRead, 'read-only: same subset');
    });
  });

  test('works with the HTTP server gone (stopped server, stale server.json)', async () => {
    await server.stop({ keepData: true });
    await session({}, async (b) => {
      const w = await b.call('create_tasks', { tasks: [{ title: 'Offline write' }] });
      assert.equal(w.isError, false, w.text);
      assert.equal((await b.call('find_tasks', { query: 'Offline write' })).data.total, 1);
    });
    const disk = JSON.parse(readFileSync(join(server.dataDir, 'data.json'), 'utf8'));
    assert.ok(disk.data.tasks.some((t) => t.title === 'Offline write'), 'written to data.json');
    assert.ok(Number.isInteger(disk.rev));
    const ai = JSON.parse(readFileSync(join(server.dataDir, 'ai.json'), 'utf8'));
    assert.ok(ai.activity.some((a) => a.tool === 'create_tasks' && a.clientId === writer.id && /Offline write/.test(a.summary)), 'write activity saved to ai.json');
  });
});
