// Connect AI over the browser API (server/http.mjs, server/ai-store.mjs): `bridgeArgs` for a custom
// data folder (and a bridge started with them works), undo state on activity entries (after a
// reload too, and live over SSE), and the key-free GET /api/ai/status.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { duplexPair } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCore, DEFAULT_DATA_DIR } from '../server/core.mjs';
import { createEcosysServer, parseAllowedHosts, bridgeDataDir } from '../server/http.mjs';
import { AIStore } from '../server/ai-store.mjs';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const made = [];
const tempDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
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

const servers = new Set();
/** port → the pairing secret of the server on it (its data folder's pair.json, as a browser gets it from the pairing link). */
const secrets = new Map();
async function start({ dataDir = tempDir('ecosys-aiov-'), ...opts } = {}) {
  const core = await createCore({ dataDir, log: silent });
  const port = await freePort();
  const app = createEcosysServer({ core, port, log: silent, installPaths: [join(tempDir('ecosys-aiov-claude-'), 'Claude', 'claude_desktop_config.json')], ...opts });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  servers.add(app);
  const secret = JSON.parse(readFileSync(join(dataDir, 'pair.json'), 'utf8')).secret;
  secrets.set(port, secret);
  return { core, app, port, dataDir, secret, stop: () => (servers.delete(app), app.close()) };
}

after(async () => {
  for (const app of servers) await app.close();
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

function req(port, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  return new Promise((resolveReq, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, method, path, agent: false, headers: { host: host ?? `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolveReq({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    r.on('error', reject);
    r.end(data || undefined);
  });
}
/** A browser-API call as a paired tab (X-Ecosys: the server's pairing secret). */
const api = (port, method, path, body, headers = {}) => req(port, { method, path, body, headers: { 'x-ecosys': secrets.get(port), ...headers } });

/** One raw request as if it came from `remoteAddress` (another device on the network). */
function rawFrom(app, remoteAddress, { path, headers }) {
  return new Promise((resolveRaw) => {
    const [inside, outside] = duplexPair();
    Object.defineProperty(inside, 'remoteAddress', { value: remoteAddress });
    let out = '';
    outside.setEncoding('utf8');
    outside.on('data', (c) => (out += c));
    outside.on('end', () => resolveRaw({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1]), text: out }));
    app.server.emit('connection', inside);
    const all = { connection: 'close', ...headers };
    outside.write(`GET ${path} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
  });
}

/** Collect SSE events from /api/events. */
function sse(port) {
  const events = [];
  const waiters = [];
  const r = http.get({ host: '127.0.0.1', port, path: '/api/events?client=tab1', headers: { host: `127.0.0.1:${port}`, 'x-ecosys': secrets.get(port) } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!event) continue;
        events.push({ event, data: JSON.parse(data) });
        for (const w of [...waiters]) if (w.pred(events.at(-1))) w.done(events.at(-1));
      }
    });
  });
  return {
    opened: new Promise((r2) => r.on('response', r2)),
    wait(pred, ms = 3000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timed out waiting for an SSE event')), ms);
        waiters.push({ pred, done: (e) => (clearTimeout(t), res(e)) });
      });
    },
    close: () => r.destroy(),
  };
}

/** A task created by an assistant, its change_id, and that change undone from the browser. */
async function changeAndUndo(s) {
  const c = s.core.ai.createClient({ kind: 'claude', label: 'Claude Code' });
  const made1 = s.core.callTool('create_tasks', { tasks: [{ title: 'Pack the tent' }] }, { client: c });
  const kept = s.core.callTool('create_tasks', { tasks: [{ title: 'Buy stove gas' }] }, { client: c });
  const changeId = made1.structuredContent.change_id;
  const u = await api(s.port, 'POST', '/api/ai/undo', { changeId });
  assert.equal(u.status, 200, u.text);
  return { c, changeId, undoId: u.json.changeId, keptId: kept.structuredContent.change_id };
}

const byChange = (activity, id) => activity.find((e) => e.changeId === id);

// ------------------------------------------------------------------ bridgeArgs

test('bridgeDataDir: nothing for the default folder, else the folder as an absolute path', () => {
  assert.equal(bridgeDataDir(DEFAULT_DATA_DIR), null);
  assert.equal(bridgeDataDir(join(DEFAULT_DATA_DIR, 'sub', '..')), null, 'the same folder spelled another way');
  const other = join(tmpdir(), 'ecosys-elsewhere');
  assert.equal(bridgeDataDir(other), resolve(other));
  assert.equal(bridgeDataDir('relative-data'), resolve('relative-data'), 'a relative folder becomes absolute (the bridge runs from another folder)');
  for (const none of [undefined, null, '', 42]) assert.equal(bridgeDataDir(none), null, String(none));
});

test('GET /api/ai sends bridgeArgs for a custom data folder, and the command built from it starts a working bridge', async () => {
  const s = await start();
  const created = (await api(s.port, 'POST', '/api/ai/clients', { kind: 'claude', label: 'Claude Code' })).json.client;
  const o = (await api(s.port, 'GET', '/api/ai')).json;
  assert.deepEqual(o.bridgeArgs, ['--data', resolve(s.dataDir)]);
  assert.ok(Array.isArray(o.bridgeArgs) && o.bridgeArgs.every((a) => typeof a === 'string'), 'an argv array, never a command line');

  // What Connect AI shows for Claude Code, Grok CLI and "Other": node <bridge> --client <id> ...bridgeArgs,
  // run from some other folder, with no ecosys variables set.
  const env = { ...process.env, ECOSYS_DATA_DIR: '', ECOSYS_CLIENT: '', ECOSYS_MCP_TOKEN: '' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(o.nodePath, [o.bridgePath, '--client', created.id, ...o.bridgeArgs], { cwd: tempDir('ecosys-aiov-cwd-'), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const closed = new Promise((r) => child.on('close', r));
  child.stdin.end(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_context', arguments: {} } },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  assert.equal(await closed, 0, err);
  const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(!msgs.some((m) => m.error), `no error replies (e.g. -32001 Unauthorized): ${out}`);
  assert.equal(msgs.find((m) => m.id === 2)?.result?.isError, false, out);
  assert.doesNotMatch(err, /no connection matches/);
  await s.stop();
});

test('the Claude Desktop installer and bridgeArgs point at the same data folder', async () => {
  const claudeDir = join(tempDir('ecosys-aiov-appdata-'), 'Claude');
  mkdirSync(claudeDir); // "Claude Desktop is installed"
  const s = await start({ installPaths: [join(claudeDir, 'claude_desktop_config.json')] });
  const o = (await api(s.port, 'GET', '/api/ai')).json;
  const r = await api(s.port, 'POST', '/api/ai/install/claude-desktop', {});
  assert.equal(r.status, 200, r.text);
  const entry = JSON.parse(readFileSync(r.json.path, 'utf8')).mcpServers.ecosys;
  assert.deepEqual(entry.args.slice(entry.args.indexOf('--data')), o.bridgeArgs);
  await s.stop();
});

// ------------------------------------------------------------------ undo state on activity

test('GET /api/ai marks undone changes and says what each undo took back', async () => {
  const s = await start();
  const { c, changeId, undoId, keptId } = await changeAndUndo(s);
  assert.equal(s.core.callTool('get_context', {}, { client: c }).isError, false); // a read: an entry without a change
  const act = (await api(s.port, 'GET', '/api/ai')).json.activity;
  assert.equal(byChange(act, changeId).undone, true, 'the undone change offers no Undo button (it would get a 409)');
  assert.equal(byChange(act, changeId).undoOf, null);
  assert.equal(byChange(act, undoId).undoOf, changeId, 'the undo names the change it took back');
  assert.equal(byChange(act, undoId).undone, false);
  assert.equal(byChange(act, keptId).undone, false, 'other changes are untouched');
  assert.equal((await api(s.port, 'POST', '/api/ai/undo', { changeId })).status, 409, 'and that button really would get a 409');

  // Undoing the undo re-applies the change (a redo): the chain reads correctly link by link.
  const redo = await api(s.port, 'POST', '/api/ai/undo', { changeId: undoId });
  assert.equal(redo.status, 200, redo.text);
  const act2 = (await api(s.port, 'GET', '/api/ai')).json.activity;
  assert.equal(byChange(act2, undoId).undone, true);
  assert.equal(byChange(act2, redo.json.changeId).undoOf, undoId);
  assert.equal(byChange(act2, redo.json.changeId).undone, false);
  // Reads and other entries without a change are passed through as they are.
  const reads = act2.filter((e) => !e.changeId);
  assert.ok(reads.length >= 1 && reads.every((e) => !('undone' in e) && !('undoOf' in e)), JSON.stringify(reads));
  await s.stop();
});

test('after a restart (or when ai.json was written by another process) the undo state is still right', async () => {
  const dataDir = tempDir('ecosys-aiov-restart-');
  const first = await start({ dataDir });
  const { changeId, undoId } = await changeAndUndo(first);
  await first.stop();
  const second = await start({ dataDir });
  const act = (await api(second.port, 'GET', '/api/ai')).json.activity;
  assert.equal(byChange(act, changeId).undone, true);
  assert.equal(byChange(act, undoId).undoOf, changeId);
  // The undo's activity entry itself carries undoOf in ai.json (no lookup needed).
  const saved = JSON.parse(readFileSync(join(dataDir, 'ai.json'), 'utf8')).activity;
  assert.equal(saved.find((e) => e.changeId === undoId).undoOf, changeId);
  assert.ok(saved.filter((e) => e.changeId !== undoId).every((e) => !('undoOf' in e)), 'only undo entries carry undoOf');
  await second.stop();
});

test('an undo\'s live activity event carries undoOf, so every open tab marks the original at once', async () => {
  const s = await start();
  const stream = sse(s.port);
  await stream.opened;
  const { changeId, undoId } = await changeAndUndo(s);
  const ev = await stream.wait((e) => e.event === 'ai' && e.data.type === 'activity' && e.data.entry.tool === 'undo_change');
  assert.equal(ev.data.entry.undoOf, changeId);
  assert.equal(ev.data.entry.changeId, undoId);
  const plain = await stream.wait((e) => e.event === 'ai' && e.data.type === 'activity' && e.data.entry.changeId === changeId);
  assert.ok(!('undoOf' in plain.data.entry), 'a plain change has no undoOf');
  stream.close();
  await s.stop();
});

test('AIStore.addChange puts undoOf on the activity entry (only a valid change id, only for an undo)', () => {
  const dir = tempDir('ecosys-aiov-store-');
  const ai = new AIStore({ dir, log: silent });
  const who = { id: 'u1', kind: 'claude', label: 'Claude' };
  const item = { c: 'tasks', id: 't1', item: { id: 't1', title: 'x' } };
  const a = ai.addChange({ client: who, tool: 'create_tasks', summary: 'Added', before: [{ ...item, item: null }], after: [item] });
  assert.ok(!('undoOf' in a.entry));
  const b = ai.addChange({ client: who, tool: 'undo_change', summary: 'Undid: Added', before: [item], after: [{ ...item, item: null }], undoOf: a.changeId });
  assert.equal(b.entry.undoOf, a.changeId);
  assert.equal(ai.change(a.changeId).undoneBy, b.changeId);
  assert.equal(ai.recentActivity(1)[0].undoOf, a.changeId);
  const bad = ai.makeActivity({ client: who, tool: 'undo_change', summary: 'x', undoOf: '<img src=x>' });
  assert.ok(!('undoOf' in bad), 'anything that is not a change id is left out');
  // Another process (the stdio bridge) sees it too.
  const other = new AIStore({ dir, log: silent });
  assert.equal(other.recentActivity(5).find((e) => e.changeId === b.changeId).undoOf, a.changeId);
  ai.flush();
  other.flush();
});

// ------------------------------------------------------------------ GET /api/ai/status

test('GET /api/ai/status: mode, connections and activity, without any key or secret path', async () => {
  const s = await start({ allowedHosts: parseAllowedHosts('abc.trycloudflare.com') });
  const { c, changeId, undoId } = await changeAndUndo(s);
  const ro = s.core.ai.createClient({ kind: 'chatgpt', access: 'read' });
  s.core.seen(c, { clientName: 'claude-code 2.1', handshake: true });
  const r = await api(s.port, 'GET', '/api/ai/status');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.headers['content-type'], /^application\/json/);
  for (const k of s.core.ai.state.clients) {
    assert.ok(!r.text.includes(k.token), 'no connection key');
    assert.ok(!r.text.includes(k.token.slice(0, 16)), 'not even part of one');
  }
  assert.doesNotMatch(r.text, /secretPath|\/s\/[A-Za-z0-9_-]{20,}|"token"/);
  assert.equal(r.json.mode, 'write');
  assert.equal(r.json.localUrl, `http://127.0.0.1:${s.port}/mcp`);
  assert.deepEqual(Object.keys(r.json).sort(), ['activity', 'clients', 'localUrl', 'mode']);
  const mine = r.json.clients.find((x) => x.id === c.id);
  assert.deepEqual(Object.keys(mine).sort(), ['access', 'connected', 'createdAt', 'id', 'kind', 'label', 'lastClientName', 'lastSeen']);
  assert.equal(mine.connected, true);
  assert.equal(mine.lastClientName, 'claude-code 2.1');
  assert.equal(r.json.clients.find((x) => x.id === ro.id).access, 'read');
  assert.equal(byChange(r.json.activity, changeId).undone, true);
  assert.equal(byChange(r.json.activity, undoId).undoOf, changeId);
  // It follows the mode.
  await api(s.port, 'POST', '/api/ai/mode', { mode: 'read' });
  assert.equal((await api(s.port, 'GET', '/api/ai/status')).json.mode, 'read');
  await s.stop();
});

test('GET /api/ai/status gets the same checks as every browser API route', async () => {
  const s = await start({ allowedHosts: parseAllowedHosts('abc.trycloudflare.com') });
  const L = `http://127.0.0.1:${s.port}`;
  const path = '/api/ai/status';
  assert.equal((await req(s.port, { path })).status, 403, 'no X-Ecosys header');
  assert.equal((await req(s.port, { path, headers: { 'x-ecosys': '1' } })).status, 403, 'the header from before pairing (not the secret)');
  assert.equal((await api(s.port, 'GET', path, undefined, { origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await api(s.port, 'GET', path, undefined, { origin: 'null' })).status, 403, 'Origin null');
  assert.equal((await api(s.port, 'GET', path, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site fetch');
  assert.equal((await api(s.port, 'GET', path, undefined, { host: `evil.example:${s.port}` })).status, 403, 'rebinding Host');
  assert.equal((await req(s.port, { path, host: 'abc.trycloudflare.com', headers: { 'x-ecosys': s.secret } })).status, 404, 'through a tunnel: MCP only');
  assert.equal((await api(s.port, 'GET', path, undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 404, 'relayed by a proxy');
  assert.equal((await rawFrom(s.app, '192.168.1.50', { path, headers: { host: `127.0.0.1:${s.port}`, 'x-ecosys': s.secret } })).status, 403, 'another device');
  assert.equal((await api(s.port, 'HEAD', path)).status, 405);
  assert.equal((await api(s.port, 'POST', path, {})).status, 404);
  const ok = await api(s.port, 'GET', path, undefined, { origin: L, 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200, 'and the same-origin control works');
  for (const k of Object.keys(ok.headers)) assert.ok(!/^access-control-/i.test(k), `no CORS header (${k})`);
  await s.stop();
});
