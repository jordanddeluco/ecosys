// shared/sync.js and request size: the server takes request bodies up to 2 MiB of UTF-8 and up to 2000
// ops per request. Big first-run imports, backups and batches (also of non-Latin text) must arrive
// whole; a 413 is answered with smaller requests and never by reloading the server state over the
// local data. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };

const BODY_LIMIT = 2 * 1024 * 1024; // server/http.mjs
const T0 = Date.now() - 86400000;
const task = (id, notes) => ({ id, title: `Task ${id}`, notes, listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 0, createdAt: T0, updatedAt: T0 });
const tasks = (n, prefix, notes) => Array.from({ length: n }, (_, i) => task(`${prefix}${String(i).padStart(6, '0')}`, notes));

// This browser already has ~2 MB of tasks when it meets a server for the first time.
ls.setItem('ecosys:v1:tasks', JSON.stringify(tasks(3000, 'big', 'x'.repeat(600))));
ls.setItem('ecosys:v1:seeded', 'user');

// ---------------------------------------------------------------- fake server (real limits)
const server = {
  rev: 0,
  initialized: false,
  cols: Object.fromEntries(['tasks', 'lists', 'events', 'calendars', 'notes', 'folders'].map((c) => [c, new Map()])),
  settings: {},
  limit: BODY_LIMIT, // a proxy in front of it may take less
  requests: [],
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const state = () => ({ rev: server.rev, initialized: server.initialized, data: Object.fromEntries(Object.entries(server.cols).map(([c, m]) => [c, [...m.values()]])), settings: server.settings });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  const method = opts.method || 'GET';
  const bytes = opts.body ? Buffer.byteLength(opts.body) : 0;
  const req = { method, path, bytes, status: 200 };
  server.requests.push(req);
  const reply = (status, body) => ((req.status = status), json(status, body));
  if (bytes > Math.min(server.limit, BODY_LIMIT)) return reply(413, { error: 'Request body too large' });
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (path === 'hello') return reply(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'] });
  if (path === 'state') return reply(200, structuredClone(state()));
  if (path === 'import' && method === 'POST') {
    if (server.initialized) return reply(409, { error: 'already initialized' });
    for (const [c, items] of Object.entries(body.data)) for (const it of items) server.cols[c].set(it.id, it);
    Object.assign(server.settings, body.settings);
    server.initialized = true;
    return reply(200, { rev: ++server.rev });
  }
  if (path === 'ops' && method === 'POST') {
    if (body.ops.length > 2000) return reply(413, { error: 'too many ops in one request' });
    for (const o of body.ops) {
      if (o.op === 'put') server.cols[o.c].set(o.item.id, o.item);
      else if (o.op === 'del') server.cols[o.c].delete(o.id);
      else if (o.op === 'replace') server.cols[o.c] = new Map(o.items.map((it) => [it.id, it]));
      else if (o.op === 'settings') Object.assign(server.settings, o.patch);
    }
    return reply(200, { rev: ++server.rev, applied: body.ops.length, rejected: [] });
  }
  if (path === 'events') {
    const stream = new ReadableStream({
      start(c) {
        opts.signal?.addEventListener('abort', () => {
          try {
            c.error(new DOMException('Aborted', 'AbortError'));
          } catch {}
        });
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return reply(404, { error: 'Not found' });
};

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const since = (mark) => server.requests.slice(mark);
const replaced = [];
window.addEventListener('ecosys:data-replaced', (e) => replaced.push(e.detail.reason));

const { db, importData } = await import('../shared/store.js');
const { startSync, syncState } = await import('../shared/sync.js');

test('first run with more data than one request: the import carries what fits, puts bring the rest', async () => {
  await startSync();
  assert.equal(syncState.status, 'online');
  await until(() => syncState.pending === 0);
  assert.equal(server.initialized, true);
  assert.equal(server.cols.tasks.size, 3000, 'every local task reached the server');
  assert.equal(db.all('tasks').length, 3000);
  const imp = server.requests.filter((r) => r.path === 'import');
  assert.equal(imp.length, 1);
  assert.ok(imp[0].bytes <= 1500000, `import body ${imp[0].bytes} bytes`);
  assert.ok(server.requests.some((r) => r.path === 'ops'), 'the rest followed as ops');
  assert.ok(server.requests.every((r) => r.status !== 413 && r.bytes <= BODY_LIMIT));
  assert.deepEqual(replaced, [], 'loading the server state does not clear undo history');
});

test('a batch of non-Latin text is measured in bytes and split into requests that fit', async () => {
  const mark = server.requests.length;
  const notes = '日本語のメモ'.repeat(600); // 3600 characters, 10800 bytes
  const ids = [];
  db.batch(() => {
    for (let i = 0; i < 400; i++) ids.push(db.insert('tasks', { title: `CJK ${i}`, notes }).id);
  });
  await until(() => syncState.pending === 0);
  const pushes = since(mark).filter((r) => r.path === 'ops');
  assert.ok(pushes.length >= 3, `${pushes.length} requests`);
  assert.ok(pushes.every((r) => r.status === 200 && r.bytes <= 1500000), pushes.map((r) => r.bytes).join(', '));
  assert.ok(ids.every((id) => server.cols.tasks.has(id) && db.get('tasks', id)));
  assert.equal(db.all('tasks').length, 3400);
});

test('importing a backup bigger than one request replaces the collection on the server, in parts', async () => {
  const mark = server.requests.length;
  const res = importData({ app: 'ecosys', tasks: tasks(3500, 'imp', 'y'.repeat(700)) });
  assert.equal(res.counts.tasks, 3500);
  await until(() => syncState.pending === 0);
  assert.equal(server.cols.tasks.size, 3500);
  assert.ok([...server.cols.tasks.keys()].every((id) => id.startsWith('imp')), 'the old tasks are gone, as in the backup');
  assert.equal(db.all('tasks').length, 3500);
  const reqs = since(mark);
  assert.ok(reqs.filter((r) => r.path === 'ops').length >= 2);
  assert.ok(reqs.every((r) => r.status === 200 && r.bytes <= 1500000));
  assert.equal(reqs.filter((r) => r.path === 'state').length, 0, 'no reload of the server state');
  assert.deepEqual(replaced, ['import']);
});

test('a 413 from something with a lower limit: smaller requests, nothing dropped, no reload', async () => {
  server.limit = 300000;
  const mark = server.requests.length;
  const ids = [];
  db.batch(() => {
    for (let i = 0; i < 300; i++) ids.push(db.insert('tasks', { title: `Proxy ${i}`, notes: 'z'.repeat(2000) }).id);
  });
  await until(() => syncState.pending === 0);
  const reqs = since(mark);
  assert.ok(reqs.some((r) => r.status === 413), 'the first request was too big');
  assert.ok(reqs.filter((r) => r.path === 'ops' && r.status === 200).length >= 2);
  assert.equal(reqs.filter((r) => r.path === 'state').length, 0, 'no reload over local data');
  assert.ok(ids.every((id) => server.cols.tasks.has(id) && db.get('tasks', id)));
  assert.equal(syncState.lastError, null);
});

test('a replace that is still too big for a lower limit is split further, never dropped', async () => {
  server.limit = 100000;
  const mark = server.requests.length;
  importData({ app: 'ecosys', tasks: tasks(300, 'rep', 'r'.repeat(1000)) }); // about 360 KB in one replace
  await until(() => syncState.pending === 0);
  assert.equal(syncState.lastError, null, 'nothing was too large');
  assert.equal(server.cols.tasks.size, 300);
  assert.ok([...server.cols.tasks.keys()].every((id) => id.startsWith('rep')), 'the replace reached the server first');
  assert.ok(since(mark).some((r) => r.status === 413));
  assert.equal(since(mark).filter((r) => r.path === 'state').length, 0);
  server.limit = BODY_LIMIT;
});

test('one change that is too large on its own stays in this browser and is reported; the rest syncs', async () => {
  server.limit = 20000;
  const warn = console.warn;
  console.warn = () => {};
  const mark = server.requests.length;
  const big = db.insert('tasks', { title: 'Huge', notes: 'n'.repeat(20000) });
  await until(() => syncState.pending === 0);
  assert.match(syncState.lastError, /too large to sync/);
  assert.ok(db.get('tasks', big.id), 'kept locally');
  assert.equal(server.cols.tasks.has(big.id), false);
  const small = db.insert('tasks', { title: 'Small' });
  await until(() => server.cols.tasks.has(small.id));
  console.warn = warn;
  assert.equal(since(mark).filter((r) => r.path === 'state').length, 0);
  assert.ok(db.get('tasks', big.id));
  server.limit = BODY_LIMIT;
});

test('pagehide stops the stream', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(syncState.leader, false);
});
