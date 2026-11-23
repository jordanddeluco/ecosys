// QA data safety: shared/sync.js and shared/store.js against a fake ecosys server (mocked fetch and
// event stream, as in sync.test.js). Two ways this browser's copy, or a change made elsewhere, is lost
// although every piece of the system is running:
//   - a change from elsewhere (an assistant, another browser) to a record that has an edit of this tab
//     still waiting to be sent (typing: a deferred save, then the 120 ms push) is reverted, because
//     the waiting edit is re-applied as the whole record and then pushed over it;
//   - the server comes back with a new, empty data folder (data.json was corrupt and moved aside,
//     .ecosys was deleted, another ECOSYS_DATA_DIR or a new copy of ecosys): the tab reloads its
//     "state" and replaces its own copy with nothing, so no browser is left to bring the data back.
// Both are pinned with `todo` until fixed. Run with: npm test
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
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };

// ---------------------------------------------------------------- fake server (whole-record puts, like server/store.mjs)
const T0 = Date.now() - 3600000;
const task = (id, title, extra = {}) => ({ id, title, notes: '', done: false, createdAt: T0, updatedAt: T0, ...extra });
const empty = () => ({ tasks: [], lists: [], events: [], calendars: [], notes: [], folders: [] });
const server = {
  rev: 10,
  initialized: true,
  // What the user's other browser put on the server before this browser first connected.
  data: { ...empty(), tasks: [task('ta00000000000001', 'Pay the rent'), task('ta00000000000002', 'Book the dentist'), task('ta00000000000003', 'Call mom')] },
  settings: {},
  requests: [],
  stream: null,
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
const sendEvent = (event, data) => server.stream.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.requests.push({ method, path, body });
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'] });
  if (path === 'state') return json(200, { rev: server.rev, initialized: server.initialized, data: structuredClone(server.data), settings: { ...server.settings } });
  if (path === 'import' && method === 'POST') {
    if (server.initialized) return json(409, { error: 'ecosys already has data on this computer', rev: server.rev });
    for (const c of Object.keys(server.data)) if (Array.isArray(body.data?.[c])) server.data[c] = [...body.data[c], ...server.data[c].filter((x) => !body.data[c].some((y) => y.id === x.id))];
    server.initialized = true;
    return json(200, { rev: ++server.rev });
  }
  if (path === 'ops' && method === 'POST') {
    applyOps(body.ops);
    return json(200, { rev: ++server.rev, applied: body.ops.length, rejected: [] });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
};

const { db } = await import('../shared/store.js');
const { startSync, syncState } = await import('../shared/sync.js');

await startSync();
await until(() => server.stream && syncState.online);

test('setup: this browser adopted the server data on its first sync', () => {
  assert.equal(syncState.online, true);
  assert.deepEqual(db.all('tasks').map((t) => t.title).sort(), ['Book the dentist', 'Call mom', 'Pay the rent']);
});

test(
  'a change from elsewhere to a task this tab is still saving keeps both changes',
  { todo: 'An edit still waiting to be sent (deferred save + push) is re-applied as the whole record over a remote change to the same record and pushed: the assistant’s / other browser’s change is reverted' },
  async () => {
    const id = 'ta00000000000001';
    // The user types in the task's notes (Tasks saves typing with { defer: true }).
    db.update('tasks', id, { notes: 'Landlord wants it by the 3rd' }, { defer: true });
    // Meanwhile an assistant completes the same task (complete_tasks): the server saves it and streams the op.
    const done = { ...server.data.tasks.find((t) => t.id === id), done: true, completedAt: Date.now(), updatedAt: Date.now() };
    applyOps([{ op: 'put', c: 'tasks', item: done }]);
    sendEvent('ops', { rev: ++server.rev, origin: 'ai:claude1', ops: [{ op: 'put', c: 'tasks', item: done }] });
    await until(() => syncState.pending === 0 && server.requests.some((r) => r.path === 'ops' && r.body.ops.some((o) => o.item?.id === id)), 3000);
    await sleep(300);
    const onServer = server.data.tasks.find((t) => t.id === id);
    assert.equal(onServer.notes, 'Landlord wants it by the 3rd', 'the user’s typing reached the server');
    assert.equal(onServer.done, true, 'the assistant’s completion is still there on the server');
    assert.equal(db.get('tasks', id).done, true, 'and in this tab');
  },
);

test(
  'the server comes back with an empty data folder: this browser keeps its copy and brings it to the new folder',
  { todo: 'resync() replaces the local copy with an uninitialized, empty server state: every collection of the tab is emptied (localStorage too) and the import that should restore the folder then sends nothing' },
  async () => {
    const before = db.all('tasks').length;
    assert.ok(before >= 3);
    // data.json was corrupt and moved aside (or .ecosys deleted, or another data folder): the server starts empty.
    Object.assign(server, { rev: 0, initialized: false, data: empty(), settings: {} });
    // The tab's stream reconnects after the restart and reloads the state (resync), as a snapshot event does.
    sendEvent('snapshot', { rev: 0 });
    await sleep(500);
    assert.equal(db.all('tasks').length, before, 'this browser still has its tasks');
    assert.ok(JSON.parse(ls.getItem('ecosys:v1:tasks') || '[]').length >= before, 'its saved copy (localStorage) too');
    assert.ok(await until(() => server.initialized && server.data.tasks.length >= before, 3000), 'and the new data folder gets them, as the first browser to reach it');
  },
);

test('teardown', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(20);
});
