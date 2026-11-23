// mcp/stdio-bridge.mjs under hostile input: invalid JSON, wrong shapes, odd ids, over-long lines
// (and what follows them on the same line), deep nesting, prototype keys, binary garbage, broken
// UTF-8, floods, a stdin that closes mid-message, missing or wrong credentials, mode off and
// read-only keys, and where it writes. Every run uses its own temp data folder (--data).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { AIStore } from '../../server/ai-store.mjs';
import { createScope, startBridge, runBridge, snapshotTree, ensureDir, nearMiss, leaked } from './_harness.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const LIMIT = 4 * 1024 * 1024; // the bridge's line limit
const isRpc = (m) => m && typeof m === 'object' && !Array.isArray(m) && m.jsonrpc === '2.0' && !('__raw' in m);
const tasksIn = (dir) => (existsSync(join(dir, 'data.json')) ? JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).data.tasks.map((t) => t.title) : []);

describe('stdio bridge: hostile input', () => {
  const scope = createScope('bridge');
  after(() => scope.cleanup());
  function setup({ access = 'write', mode } = {}) {
    const dir = scope.tempDir('bridge-data');
    const ai = new AIStore({ dir, log: silent });
    const c = ai.createClient({ kind: 'claude', label: 'Claude Desktop', access });
    if (mode) ai.setMode(mode);
    return { dir, c, ai };
  }

  test('invalid JSON, wrong shapes and odd ids get the right errors, in order; stdout stays pure JSON-RPC', async () => {
    const { dir, c } = setup();
    const cases = [
      ['', null],
      ['   ', null],
      ['\r', null],
      ['null', { code: -32600 }],
      ['1', { code: -32600 }],
      ['"str"', { code: -32600 }],
      ['[]', { code: -32600 }],
      ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', { code: -32600 }],
      ['{"jsonrpc":"2.0"}', { code: -32600 }],
      ['{"jsonrpc":"1.0","id":"v1","method":"ping"}', { id: 'v1', code: -32600 }],
      ['{"jsonrpc":"2.0","id":{},"method":"ping"}', { code: -32600 }],
      ['{"jsonrpc":"2.0","id":null,"method":"ping"}', { code: -32600 }],
      ['{"jsonrpc":"2.0","id":true,"method":"ping"}', { code: -32600 }],
      ['{"jsonrpc":"2.0","id":"m","method":7}', { id: 'm', code: -32600 }],
      ['{"jsonrpc":"2.0","id":"p","method":"tools/call","params":"x"}', { id: 'p', code: -32602 }],
      ['{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"get_context","arguments":[]}}', { id: 'a', code: -32602 }],
      ['{"jsonrpc":"2.0","id":"u","method":"tools/call","params":{"name":"rm_rf","arguments":{}}}', { id: 'u', code: -32602 }],
      ['{"jsonrpc":"2.0","id":"n","method":"nope/nope"}', { id: 'n', code: -32601 }],
      ['{ not json', { code: -32700 }],
      ['{"jsonrpc":"2.0","id":"x","method":"ping"} trailing', { code: -32700 }],
      ['{"jsonrpc":"2.0","method":"notifications/initialized"}', null],
      ['{"jsonrpc":"2.0","result":{}}', null],
      ['{"jsonrpc":"2.0","id":"crlf","method":"ping"}\r', { id: 'crlf', result: true }],
      ['{"jsonrpc":"2.0","id":"last","method":"ping"}', { id: 'last', result: true }],
    ];
    const r = await runBridge(dir, ['--client', c.id], cases.map(([l]) => l));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.lines.every((l) => isRpc(JSON.parse(l))), 'every stdout line is a JSON-RPC 2.0 object');
    const expected = cases.filter(([, e]) => e).map(([, e]) => e);
    assert.equal(r.msgs.length, expected.length, `one reply per request, none for blank lines and notifications: ${JSON.stringify(r.msgs).slice(0, 400)}`);
    expected.forEach((e, i) => {
      const m = r.msgs[i];
      if (e.id !== undefined) assert.equal(m.id, e.id, `reply ${i}`);
      else assert.equal(m.id, undefined, `reply ${i} has no id`);
      if (e.result) assert.ok(m.result && !m.error, `reply ${i}: ${JSON.stringify(m)}`);
      else assert.equal(m.error?.code, e.code, `reply ${i}: ${JSON.stringify(m)}`);
    });
  });

  test('one over-long line gets exactly one error reply, and the bridge carries on', async () => {
    const { dir, c } = setup();
    const big = JSON.stringify({ jsonrpc: '2.0', id: 'big', method: 'ping', params: { pad: 'x'.repeat(LIMIT + 1024 * 1024) } });
    const r = await runBridge(dir, ['--client', c.id], `${big}\n{"jsonrpc":"2.0","id":"after","method":"ping"}\n`);
    assert.equal(r.code, 0, r.stderr);
    const errors = r.msgs.filter((m) => m.error);
    assert.ok(r.msgs.some((m) => m.id === 'after' && m.result), 'the next message is still answered');
    assert.ok(!r.msgs.some((m) => m.id === 'big' && m.result), 'the over-long message was not run');
    assert.equal(errors.length, 1, `replies to one over-long message: ${JSON.stringify(errors)}`);
  });

  test('bytes that follow an over-long line on the same line are not run as a new request (no smuggling)', async () => {
    const { dir, c } = setup();
    const b = startBridge(dir, ['--client', c.id]);
    await b.write('A'.repeat(LIMIT + 4096)); // no newline yet
    const tooLarge = await b.wait((m) => m.error && /too large/i.test(m.error.message));
    assert.equal(tooLarge.error.code, -32600);
    // The rest of the same line: a complete, valid request that must not run.
    await b.write(JSON.stringify({ jsonrpc: '2.0', id: 'smuggled', method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'SMUGGLED' }] } } }) + '\n');
    await b.write('{"jsonrpc":"2.0","id":"next","method":"ping"}\n');
    await b.wait((m) => m.id === 'next');
    await b.end();
    assert.equal(await b.exited, 0);
    assert.deepEqual(
      { smuggledReply: b.msgs.some((m) => m.id === 'smuggled'), tasks: tasksIn(dir) },
      { smuggledReply: false, tasks: [] },
      'the tail of an over-long line was executed as a request',
    );
  });

  test('a large but allowed message (3 MB) is handled normally', async () => {
    const { dir, c } = setup();
    const r = await runBridge(dir, ['--client', c.id], [{ jsonrpc: '2.0', id: 'large', method: 'ping', params: { pad: 'y'.repeat(3 * 1024 * 1024) } }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.msgs.map((m) => [m.id, !!m.result]), [['large', true], [2, true]]);
  });

  test('deeply nested JSON and prototype keys are inert', async () => {
    const { dir, c } = setup();
    const r = await runBridge(dir, ['--client', c.id], [
      '['.repeat(200000),
      '{"a":'.repeat(100000) + '1' + '}'.repeat(100000),
      '[' .repeat(5000) + ']'.repeat(5000),
      '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"jsonrpc":"2.0","id":"pp1","method":"ping"}',
      '{"jsonrpc":"2.0","id":"pp2","method":"tools/call","params":{"name":"get_context","arguments":{"__proto__":{"x":1}},"__proto__":{"x":1}}}',
      '{"jsonrpc":"2.0","id":"pp3","method":"tools/call","params":{"name":"__proto__","arguments":{}}}',
      '{"jsonrpc":"2.0","id":"pp4","method":"tools/call","params":{"name":"create_tasks","arguments":{"tasks":[{"title":"Proto","__proto__":{"done":true}}]}}}',
      '{"jsonrpc":"2.0","id":"end","method":"ping"}',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.lines.every((l) => isRpc(JSON.parse(l))));
    const byId = new Map(r.msgs.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
    assert.ok(byId.get('pp1')?.result, 'prototype keys are dropped, the message still works');
    assert.equal(byId.get('pp2')?.result?.isError, false);
    assert.ok(byId.get('pp3')?.error, 'a tool named __proto__ is unknown');
    assert.equal(byId.get('pp4')?.result?.isError, false);
    assert.ok(byId.get('end')?.result);
    const disk = readFileSync(join(dir, 'data.json'), 'utf8');
    assert.ok(!disk.includes('__proto__') && !disk.includes('polluted'));
    assert.equal(JSON.parse(disk).data.tasks.find((t) => t.title === 'Proto')?.done, false, 'no field smuggled in through __proto__');
  });

  test('binary garbage, NUL bytes, broken UTF-8 and stray CR/LF do not crash it', async () => {
    const { dir, c } = setup();
    let seed = 0x2545f491;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0xff;
    const garbage = Buffer.from(Array.from({ length: 96 * 1024 }, rnd));
    const parts = [garbage, Buffer.from('\n\u0000\u0001\u0002\n'), Buffer.from([0xff, 0xfe, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0x0a]), Buffer.from('\r\r\n\n\r\n{"jsonrpc":"2.0","id":"alive","method":"ping"}\n')];
    const r = await runBridge(dir, ['--client', c.id], Buffer.concat(parts));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.lines.every((l) => isRpc(JSON.parse(l))), 'stdout is still pure JSON-RPC');
    assert.ok(r.msgs.some((m) => m.id === 'alive' && m.result), 'answers after the garbage');
    assert.ok(!/at .+:\d+:\d+/.test(r.stderr), `no stack traces: ${r.stderr.slice(0, 300)}`);
  });

  test('2000 requests in one burst are all answered, in order', async () => {
    const { dir, c } = setup();
    const lines = Array.from({ length: 2000 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    const r = await runBridge(dir, ['--client', c.id], lines);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.msgs.map((m) => m.id), lines.map((l) => l.id));
  });

  test('stdin closing mid-line: a complete last message is still answered, a cut one is a parse error', async () => {
    const { dir, c } = setup();
    const whole = await runBridge(dir, ['--client', c.id], '{"jsonrpc":"2.0","id":"tail","method":"ping"}');
    assert.equal(whole.code, 0);
    assert.ok(whole.msgs.some((m) => m.id === 'tail' && m.result));
    const cut = await runBridge(dir, ['--client', c.id], '{"jsonrpc":"2.0","id":"cut","meth');
    assert.equal(cut.code, 0);
    assert.deepEqual(cut.msgs.map((m) => m.error?.code), [-32700]);
  });

  test('an unknown connection, a wrong key or no connection never runs a tool, and the key is not echoed', async () => {
    const { dir, c } = setup();
    const call = [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'Should not exist' }] } } }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }];
    for (const [label, args, env] of [
      ['unknown --client', ['--client', 'deadbeefdeadbeef'], {}],
      ['a malicious --client value', ['--client', '../../../etc/passwd'], {}],
      ['wrong --token', ['--token', nearMiss(c.token)], {}],
      ['wrong ECOSYS_CLIENT', [], { ECOSYS_CLIENT: 'deadbeefdeadbeef' }],
      ['nothing', [], {}],
    ]) {
      const r = await runBridge(dir, args, call, { env });
      assert.equal(r.code, 0, label);
      assert.equal(r.msgs.length, 2, label);
      for (const m of r.msgs) assert.ok(m.error && !m.result, `${label}: ${JSON.stringify(m).slice(0, 200)}`);
      assert.deepEqual(leaked(r.stderr + r.lines.join('\n'), [c.token, nearMiss(c.token)]), [], label);
    }
    assert.deepEqual(tasksIn(dir), [], 'nothing was written');
  });

  test('mode off and read-only keys are enforced over stdio too', async () => {
    const off = setup({ mode: 'off' });
    const r1 = await runBridge(off.dir, ['--client', off.c.id], [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'off' }] } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_context', arguments: {} } },
    ]);
    for (const m of r1.msgs) {
      assert.equal(m.result?.isError, true);
      assert.match(m.result.content[0].text, /AI access is turned off in ecosys/);
    }
    assert.deepEqual(tasksIn(off.dir), []);
    const ro = setup({ access: 'read' });
    const r2 = await runBridge(ro.dir, ['--client', ro.c.id], [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'ro' }] } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_items', arguments: { items: [{ type: 'task', id: 'x' }] } } },
    ]);
    const tools = r2.msgs.find((m) => m.id === 1).result.tools;
    assert.ok(tools.length > 0 && tools.every((t) => t.annotations.readOnlyHint === true), 'only read tools listed');
    for (const id of [2, 3]) {
      const m = r2.msgs.find((x) => x.id === id);
      assert.equal(m.result?.isError, true);
      assert.match(m.result.content[0].text, /read-only/);
    }
    assert.deepEqual(tasksIn(ro.dir), []);
  });

  test('it writes only inside its data folder', async () => {
    const sandbox = scope.tempDir('bridge-sandbox');
    const dir = join(sandbox, 'data');
    const cwd = ensureDir(join(sandbox, 'cwd'));
    const c = new AIStore({ dir, log: silent }).createClient({ kind: 'claude' });
    const r = await runBridge(dir, ['--client', c.id], [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'Sandboxed' }] } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_list', arguments: { name: 'Sandbox list' } } },
    ], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.msgs.every((m) => m.result?.isError === false), JSON.stringify(r.msgs).slice(0, 300));
    const outside = [...snapshotTree(sandbox).keys()].filter((p) => !p.startsWith(`data${sep}`) && p !== `data${sep}` && p !== `cwd${sep}`);
    assert.deepEqual(outside, [], `files written outside the data folder: ${outside.map((p) => relative(sandbox, join(sandbox, p))).join(', ')}`);
    assert.deepEqual(tasksIn(dir), ['Sandboxed']);
  });
});
