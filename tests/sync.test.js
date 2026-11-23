// shared/sync.js against a fake ecosys server (mocked fetch + event stream): first-run import,
// debounced op push, remote ops and AI events over the stream, retry with an outbox, rejected ops.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- fake browser
class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
const ls = new MemoryStorage();
const ss = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => ss });
// No Web Locks: this tab opens its own stream (and no BroadcastChannel keeps the process alive).
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };

// ---------------------------------------------------------------- fake server
const server = {
  rev: 0,
  initialized: false,
  data: { tasks: [], lists: [], events: [], calendars: [], notes: [], folders: [] },
  settings: {},
  requests: [],
  failOps: 0, // respond 503 to the next N op pushes
  rejectOps: false, // respond 400 to op pushes
  rejectIndex: -1, // report the op at this index as rejected (200 with rejected:[…])
  stream: null,
  headersSeen: new Set(),
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function applyOps(ops) {
  for (const o of ops) {
    if (o.op === 'put') {
      const list = server.data[o.c];
      const i = list.findIndex((x) => x.id === o.item.id);
      if (i >= 0) list[i] = o.item;
      else list.push(o.item);
    } else if (o.op === 'del') server.data[o.c] = server.data[o.c].filter((x) => x.id !== o.id);
    else if (o.op === 'replace') server.data[o.c] = o.items;
    else if (o.op === 'settings') Object.assign(server.settings, o.patch);
  }
}
const encoder = new TextEncoder();
function sendEvent(event, data) {
  server.stream.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.headersSeen.add(opts.headers?.['X-Ecosys']);
  server.requests.push({ method, path, body });
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'] });
  if (path === 'state') return json(200, { rev: server.rev, initialized: server.initialized, data: structuredClone(server.data), settings: { ...server.settings } });
  if (path === 'import' && method === 'POST') {
    server.importing = true;
    await server.holdImport;
    server.data = { ...server.data, ...body.data };
    server.settings = body.settings;
    server.initialized = true;
    return json(200, { rev: ++server.rev });
  }
  if (path === 'ops' && method === 'POST') {
    if (server.failOps > 0) {
      server.failOps--;
      return json(503, { error: 'busy' });
    }
    if (server.rejectOps) return json(400, { error: 'invalid op' });
    const rejected = server.rejectIndex >= 0 && body.ops[server.rejectIndex] ? [{ index: server.rejectIndex, error: 'tasks is full' }] : [];
    applyOps(body.ops.filter((_, i) => !rejected.some((r) => r.index === i)));
    return json(200, { rev: ++server.rev, applied: body.ops.length - rejected.length, rejected });
  }
  if (path === 'events') {
    const stream = new ReadableStream({
      start(c) {
        server.stream = c;
        opts.signal?.addEventListener('abort', () => {
          try {
            c.error(new DOMException('Aborted', 'AbortError'));
          } catch {}
        });
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return json(404, { error: 'Not found' });
};

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const statuses = [];
const aiEvents = [];
window.addEventListener('ecosys:sync', (e) => statuses.push(e.detail.status));
window.addEventListener('ecosys:ai', (e) => aiEvents.push(e.detail));

const { db, settings, seedIfEmpty, registerSeeder } = await import('../shared/store.js');
const { startSync, syncState } = await import('../shared/sync.js');

registerSeeder((d) => d.insert('tasks', { title: 'Local before sync' }));
seedIfEmpty();

test('first run: the server starts with this browser data', async () => {
  let release;
  server.holdImport = new Promise((r) => (release = r));
  const started = startSync();
  await until(() => server.importing);
  const during = db.insert('tasks', { title: 'Typed while the import was on its way' });
  release();
  const st = await started;
  assert.equal(st, syncState);
  await until(() => server.data.tasks.some((x) => x.id === during.id));
  assert.ok(db.get('tasks', during.id), 'a write made during the import is kept and sent');
  assert.equal(syncState.online, true);
  assert.equal(syncState.status, 'online');
  assert.deepEqual(statuses.slice(0, 2), ['connecting', 'online']);
  const imp = server.requests.find((r) => r.path === 'import');
  assert.ok(imp, 'POST api/import was sent');
  assert.ok(imp.body.data.tasks.some((t) => t.title === 'Local before sync'));
  assert.ok(Array.isArray(imp.body.data.notes));
  assert.equal(window.ecosysSync, syncState);
  const pushed = server.requests.filter((r) => r.path === 'ops').flatMap((r) => r.body.ops);
  assert.deepEqual(pushed.map((o) => o.item?.id), [during.id], 'seed data is not pushed as ops, only the later write');
  assert.deepEqual([...server.headersSeen], ['1'], 'every request carries X-Ecosys: 1');
  await until(() => server.stream);
});

test('local writes are pushed as ops, debounced into one request', async () => {
  const before = server.requests.filter((r) => r.path === 'ops').length;
  const t = db.insert('tasks', { title: 'Pushed' });
  db.update('tasks', t.id, { title: 'Pushed, edited' });
  settings.set({ theme: 'dark' });
  await until(() => server.requests.filter((r) => r.path === 'ops').length > before);
  const req = server.requests.filter((r) => r.path === 'ops').at(-1);
  assert.equal(req.body.client, syncState.clientId);
  assert.ok(Number.isInteger(req.body.baseRev));
  assert.equal(req.body.ops.length, 2, 'two puts of one task are compacted into one');
  assert.equal(req.body.ops[0].item.title, 'Pushed, edited');
  assert.deepEqual(req.body.ops[1], { op: 'settings', patch: { theme: 'dark' } });
  assert.ok(server.data.tasks.some((x) => x.id === t.id));
  await until(() => syncState.pending === 0);
  assert.equal(syncState.rev, server.rev);
});

test('remote ops and AI events arrive over the event stream', async () => {
  sendEvent('ops', { rev: 99, origin: 'ai:claude1', ops: [{ op: 'put', c: 'tasks', item: { id: 'fromai01', title: 'Added by Claude', priority: 3 } }] });
  sendEvent('ai', { type: 'activity', entry: { id: 'a1', tool: 'create_tasks', summary: 'Created 1 task' } });
  await until(() => db.get('tasks', 'fromai01'));
  assert.equal(db.get('tasks', 'fromai01').priority, 3);
  await until(() => aiEvents.length);
  assert.equal(aiEvents[0].type, 'activity');
  assert.equal(syncState.rev, 99);
  // our own echo is ignored; invalid ops are dropped
  sendEvent('ops', { rev: 100, origin: syncState.clientId, ops: [{ op: 'del', c: 'tasks', id: 'fromai01' }] });
  sendEvent('ops', { rev: 101, origin: 'x', ops: [{ op: 'put', c: 'tasks', item: { id: '"><img src=x onerror=1>' } }] });
  await until(() => syncState.rev === 101);
  assert.ok(db.get('tasks', 'fromai01'));
  assert.equal(db.all('tasks').filter((x) => x.id.includes('<')).length, 0);
});

test('a "snapshot" event reloads the server state', async () => {
  server.data.tasks.push({ id: 'ondisk1', title: 'Written by the MCP bridge', createdAt: 1, updatedAt: 1 });
  server.rev = 150;
  sendEvent('snapshot', { rev: 150 });
  await until(() => db.get('tasks', 'ondisk1'));
  assert.equal(syncState.rev, 150);
});

test('failed pushes are kept in the outbox and retried', async () => {
  server.failOps = 1;
  const t = db.insert('tasks', { title: 'Retry me' });
  await until(() => syncState.status === 'offline');
  const saved = JSON.parse(ss.getItem('ecosys:sync:outbox'));
  assert.ok(saved.entries.some((e) => e.op.item?.id === t.id), 'outbox is in sessionStorage');
  assert.ok(ls.getItem(`ecosys:v1:outbox:${syncState.clientId}`), 'and in localStorage for crash recovery');
  await until(() => server.data.tasks.some((x) => x.id === t.id), 5000);
  await until(() => syncState.pending === 0);
  assert.equal(ss.getItem('ecosys:sync:outbox'), null);
  assert.equal(ls.getItem(`ecosys:v1:outbox:${syncState.clientId}`), null);
  assert.equal(syncState.status, 'online', 'back online once a push works again (the stream never dropped)');
  assert.equal(syncState.lastError, null);
});

test('changes the server refuses are dropped from the outbox, but this tab keeps its copy and says so', async () => {
  server.rejectOps = true;
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  const states = server.requests.filter((r) => r.path === 'state').length;
  const t = db.insert('tasks', { title: 'Rejected' });
  await until(() => syncState.pending === 0 && syncState.lastError);
  await new Promise((r) => setTimeout(r, 200));
  console.warn = warn;
  server.rejectOps = false;
  assert.ok(db.get('tasks', t.id), 'not replaced by the server state');
  assert.equal(server.requests.filter((r) => r.path === 'state').length, states, 'no reload over local data');
  assert.match(syncState.lastError, /could not save a change \(invalid op\)/);
  assert.ok(warnings.some((w) => w.includes(`put tasks:${t.id}`)));
  assert.equal(syncState.status, 'online');
});

test('per-op rejections in a 200 answer are reported the same way (also by the push that recovers)', async () => {
  server.failOps = 1; // the first try fails (offline), the retry succeeds but refuses the op
  server.rejectIndex = 0;
  const warn = console.warn;
  console.warn = () => {};
  const t = db.insert('tasks', { title: 'Refused one' });
  await until(() => syncState.status === 'offline');
  await until(() => syncState.pending === 0, 5000);
  console.warn = warn;
  server.rejectIndex = -1;
  assert.ok(db.get('tasks', t.id));
  assert.equal(syncState.status, 'online');
  assert.match(syncState.lastError, /tasks is full/, 'going back online does not hide the refusal');
});

test('the AI status is kept in syncState and replayed to tabs that join later', async () => {
  sendEvent('ai', { type: 'status', mode: 'write', clients: [{ id: 'c1', kind: 'claude', label: 'Claude', access: 'write', connected: true, lastSeen: 1 }] });
  await until(() => syncState.ai?.mode === 'write');
  assert.equal(syncState.ai.clients[0].kind, 'claude');
  assert.equal(aiEvents.at(-1).type, 'status');
});

test('pagehide stops the stream and timers', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(syncState.leader, false);
});
