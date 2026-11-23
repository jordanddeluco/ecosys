// mcp/stdio-bridge.mjs: stdio MCP for local apps (Claude Desktop, Claude Code, Grok CLI).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIStore } from '../server/ai-store.mjs';
import { createCore } from '../server/core.mjs';
import { createEcosysServer } from '../server/http.mjs';
import { notifyProof } from '../server/util.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'stdio-bridge.mjs');
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '0.1.0' } };
const silent = { warn() {}, error() {}, info() {}, log() {} };

/** Run the bridge with the given stdin lines; resolves with parsed stdout messages, stderr and exit code. */
function runBridge(args, lines, env = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ECOSYS_CLIENT: '', ECOSYS_MCP_TOKEN: '', ...env };
    delete childEnv.NODE_TEST_CONTEXT; // the bridge is a normal program, not a test file
    const p = spawn(process.execPath, [BRIDGE, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      const rawLines = out.split('\n').filter(Boolean);
      resolve({ code, err, raw: rawLines, msgs: rawLines.map((l) => JSON.parse(l)) });
    });
    p.stdin.end(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  });
}

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-bridge-'));
  made.push(dir);
  const ai = new AIStore({ dir });
  const c = ai.createClient({ kind: 'claude', label: 'Claude Desktop' });
  return { dir, c, ai };
}

test('speaks both eras over stdio and writes to the shared data file', async () => {
  const { dir, c } = setup();
  const r = await runBridge(
    ['--client', c.id, '--data', dir],
    [
      { jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: META } },
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ text: 'Buy milk tomorrow p1' }] } } },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', id: 4, method: 'subscriptions/listen', params: { _meta: META } },
      '{ not json',
      { jsonrpc: '2.0', id: 5, method: 'nope/nope' },
    ],
  );
  assert.equal(r.code, 0, r.err);
  assert.ok(r.raw.every((l) => l.startsWith('{"jsonrpc":"2.0"')), 'stdout carries only JSON-RPC');
  const byId = new Map(r.msgs.filter((m) => 'id' in m).map((m) => [m.id, m]));
  assert.equal(byId.get('d1').result.resultType, 'complete');
  assert.ok(byId.get('d1').result.supportedVersions.includes('2026-07-28'));
  assert.equal(byId.get(0).result.protocolVersion, '2025-11-25');
  assert.ok(byId.get(1).result.tools.length >= 15);
  assert.equal(byId.get(2).result.isError, false);
  assert.deepEqual(byId.get(3).result, {});
  const ack = r.msgs.find((m) => m.method === 'notifications/subscriptions/acknowledged');
  assert.ok(ack, 'subscriptions/listen is acknowledged');
  assert.equal(byId.get(4).result.resultType, 'complete');
  assert.ok(r.msgs.some((m) => m.error?.code === -32700), 'parse errors are answered, not fatal');
  assert.equal(byId.get(5).error.code, -32601);
  assert.equal(r.msgs.filter((m) => !('id' in m) && !m.method && !m.error).length, 0, 'no stray messages');
  assert.equal(r.msgs.filter((m) => 'id' in m).length, 7, 'one reply per request, none for the notification');
  const data = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'));
  assert.equal(data.data.tasks[0].title, 'Buy milk');
  const ai = JSON.parse(readFileSync(join(dir, 'ai.json'), 'utf8'));
  assert.ok(ai.activity.some((a) => a.tool === 'create_tasks' && a.clientId === c.id));
  assert.ok(ai.changes.length === 1);
  assert.equal(ai.changes[0].after, undefined, 'undo data is not kept inside ai.json');
  assert.ok(existsSync(join(dir, 'changes', `${ai.changes[0].changeId}.json`)));
  assert.equal(ai.clients[0].lastClientName, 'claude-ai 0.1.0');
});

test('an unknown or missing connection gets clear errors (and the process stays up)', async () => {
  const { dir } = setup();
  const r = await runBridge(['--client', 'deadbeefdeadbeef', '--data', dir], [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.equal(r.code, 0);
  assert.equal(r.msgs.length, 2, 'notifications get no reply');
  for (const m of r.msgs) assert.match(m.error.message, /Connect AI/);
  assert.match(r.err, /no connection matches/);
});

test('a key works instead of an id', async () => {
  const { dir, c } = setup();
  const r = await runBridge(['--data', dir], [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } }], { ECOSYS_MCP_TOKEN: c.token });
  assert.equal(r.msgs[0].result.isError, false);
  const ai = JSON.parse(readFileSync(join(dir, 'ai.json'), 'utf8'));
  assert.ok(ai.activity.some((a) => a.tool === 'get_context' && a.clientId === c.id), 'read activity is saved before the bridge exits');
});

test('with the server running, browsers get the bridge\'s change live', async () => {
  const { dir, c } = setup();
  const core = await createCore({ dataDir: dir, log: silent });
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  const app = createEcosysServer({ core, port, log: silent });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  app.writeServerInfo();
  const events = [];
  // A paired browser tab: the pairing secret the server keeps in the data folder (pair.json).
  const secret = JSON.parse(readFileSync(join(dir, 'pair.json'), 'utf8')).secret;
  const sse = http.get({ host: '127.0.0.1', port, path: '/api/events?client=tab', headers: { host: `127.0.0.1:${port}`, 'x-ecosys': secret } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ event: ev, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
      }
    });
  });
  try {
    await new Promise((r) => setTimeout(r, 150));
    const r = await runBridge(['--client', c.id, '--data', dir], [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'Live from Claude' }] } } },
    ]);
    assert.equal(r.code, 0, r.err);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !events.some((e) => e.event === 'ops' || e.event === 'snapshot')) await new Promise((res) => setTimeout(res, 50));
    const ops = events.find((e) => e.event === 'ops');
    assert.ok(ops || events.some((e) => e.event === 'snapshot'), JSON.stringify(events.map((e) => e.event)));
    if (ops) {
      assert.equal(ops.data.origin, `ai:${c.id}`);
      assert.equal(ops.data.ops[0].item.title, 'Live from Claude');
    }
    assert.ok(events.some((e) => e.event === 'ai' && e.data.type === 'connected' && e.data.client.id === c.id), 'connect animation event');
    assert.ok(events.some((e) => e.event === 'ai' && e.data.type === 'activity' && e.data.entry.tool === 'create_tasks'));
    const st = core.store.snapshot();
    assert.ok(st.data.tasks.some((t) => t.title === 'Live from Claude'));
  } finally {
    sse.destroy();
    await app.close();
  }
});

// ------------------------------------------------------------------ hostile framing, key handling

const LIMIT = 4 * 1024 * 1024; // the bridge's line limit (MAX_LINE)

/** A bridge whose stdin is written step by step; `wait(pred)` resolves with the first matching reply. */
function liveBridge(args) {
  const childEnv = { ...process.env, ECOSYS_CLIENT: '', ECOSYS_MCP_TOKEN: '' };
  delete childEnv.NODE_TEST_CONTEXT;
  const p = spawn(process.execPath, [BRIDGE, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const msgs = [];
  const waiters = [];
  let out = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    out += c;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const m = JSON.parse(out.slice(0, i));
      out = out.slice(i + 1);
      msgs.push(m);
      for (const w of [...waiters]) {
        if (!w.pred(m)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  p.stderr.resume();
  const closed = new Promise((r) => p.on('close', r));
  return {
    msgs,
    closed,
    write: (s) => new Promise((r) => (p.stdin.write(s) ? r() : p.stdin.once('drain', r))),
    end: () => p.stdin.end(),
    wait: (pred, ms = 15000) =>
      msgs.find(pred)
        ? Promise.resolve(msgs.find(pred))
        : new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timed out; got ${JSON.stringify(msgs).slice(0, 300)}`)), ms);
            waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
          }),
  };
}

test('an over-long line gets exactly one error, and what follows it on the same line is never run', async () => {
  const { dir, c } = setup();
  const b = liveBridge(['--client', c.id, '--data', dir]);
  await b.write('A'.repeat(LIMIT + 4096)); // no newline yet
  const tooLarge = await b.wait((m) => m.error);
  assert.equal(tooLarge.error.code, -32600);
  assert.match(tooLarge.error.message, /too large/i);
  // The rest of that same line is a complete, valid request: it must be dropped with the line.
  await b.write(JSON.stringify({ jsonrpc: '2.0', id: 'smuggled', method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'SMUGGLED' }] } } }) + '\n');
  // A whole over-long line in one write, then normal traffic.
  await b.write(JSON.stringify({ jsonrpc: '2.0', id: 'big', method: 'ping', params: { pad: 'x'.repeat(LIMIT) } }) + '\n');
  await b.write('{"jsonrpc":"2.0","id":"next","method":"ping"}\n');
  await b.wait((m) => m.id === 'next');
  b.end();
  assert.equal(await b.closed, 0);
  assert.deepEqual(b.msgs.map((m) => m.id ?? m.error?.code), [-32600, -32600, 'next'], 'one error per over-long line, then the next message');
  assert.ok(!existsSync(join(dir, 'data.json')) || !readFileSync(join(dir, 'data.json'), 'utf8').includes('SMUGGLED'), 'the smuggled request did not run');
});

test('a line just under the limit is still handled, split over many writes', async () => {
  const { dir, c } = setup();
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 'edge', method: 'ping', params: { pad: '' } });
  const line = msg.replace('"pad":""', `"pad":"${'y'.repeat(LIMIT - msg.length)}"`);
  assert.equal(line.length, LIMIT);
  const b = liveBridge(['--client', c.id, '--data', dir]);
  for (let i = 0; i < line.length; i += 300000) await b.write(line.slice(i, i + 300000));
  await b.write('\n');
  const r = await b.wait((m) => m.id === 'edge');
  assert.deepEqual(r.result, {});
  b.end();
  assert.equal(await b.closed, 0);
  assert.equal(b.msgs.length, 1);
});

test('the bridge proves its key to the server it notifies instead of sending it', async () => {
  const { dir, c } = setup();
  // Something listens on the port named in server.json; it might not be ecosys at all.
  const seen = [];
  const listener = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (x) => chunks.push(x));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString('utf8') });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid: process.pid, port: listener.address().port, host: '127.0.0.1', startedAt: Date.now() }));
  try {
    const r = await runBridge(['--client', c.id, '--data', dir], [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_tasks', arguments: { tasks: [{ title: 'Notify me' }] } } },
    ]);
    assert.equal(r.code, 0, r.err);
    assert.ok(seen.length >= 1, 'the bridge notified the listener');
    for (const n of seen) {
      assert.equal(n.url, '/api/internal/notify');
      assert.equal(n.headers.authorization, undefined, 'no Authorization header');
      assert.ok(!JSON.stringify(n.rawHeaders).includes(c.token) && !n.body.includes(c.token), 'the key itself was sent');
      const [id, at, proof] = String(n.headers['x-ecosys-proof']).split(' ');
      assert.equal(id, c.id);
      assert.equal(proof, notifyProof(c.token, c.id, at, n.body), 'the proof is an HMAC of this body made with the key');
    }
  } finally {
    await new Promise((r) => listener.close(r));
  }
});
