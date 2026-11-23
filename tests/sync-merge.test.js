// shared/sync.js: a browser that syncs for the first time with a server that already has data keeps
// what was typed in it (merged in by id), while its untouched sample data is left out. Run with: npm test
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
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => new MemoryStorage() });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: 'localhost' };

// A server that another browser already filled (with its own sample data).
const T0 = 1700000000000;
const server = {
  rev: 12,
  data: {
    tasks: [{ id: 'srvtask1', title: 'Server sample', listId: 'srvlist1', createdAt: T0, updatedAt: T0 }],
    lists: [{ id: 'srvlist1', name: 'Personal', color: 'iris', createdAt: T0, updatedAt: T0 }],
    events: [],
    calendars: [{ id: 'srvcal1', name: 'Personal', color: 'iris', createdAt: T0, updatedAt: T0 }],
    notes: [],
    folders: [],
  },
  settings: { theme: 'dark' },
  pushed: [],
  hold: null, // a promise the next op push waits for
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', features: ['sync'] });
  if (path === 'state') return json(200, { rev: server.rev, initialized: true, data: structuredClone(server.data), settings: server.settings });
  if (path === 'ops') {
    const body = JSON.parse(opts.body);
    server.arrived = true;
    await server.hold;
    server.pushed.push(...body.ops);
    return json(200, { rev: ++server.rev, applied: body.ops.length, rejected: [] });
  }
  if (path === 'events') return new Response(new ReadableStream({ start(c) { opts.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} }); } }), { status: 200 });
  return json(404, {});
};
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const { db, seedIfEmpty, registerSeeder, seededAt } = await import('../shared/store.js');
const { startSync, syncState } = await import('../shared/sync.js');

// This browser: fresh samples, plus things the person made later.
registerSeeder((d) => {
  d.insert('lists', { name: 'Personal', color: 'iris', order: 0 });
  d.insert('tasks', { title: 'Local sample' });
});
seedIfEmpty();
const later = seededAt() + 60000;
const personal = db.all('lists').find((l) => l.name === 'Personal');
const garden = db.put('lists', { id: 'garden01', name: 'Garden', color: 'green', order: 3, createdAt: later, updatedAt: later });
db.put('tasks', { id: 'mytask01', title: 'Mine, in Personal', listId: personal.id, createdAt: later, updatedAt: later });
db.put('tasks', { id: 'mytask02', title: 'Mine, in Garden', listId: garden.id, createdAt: later, updatedAt: later });
const sampleTask = db.all('tasks').find((t) => t.title === 'Local sample');
db.put('notes', { id: 'mynote01', title: 'Mine', body: '<p>x</p>', createdAt: later, updatedAt: later });
// An old version of this module kept a full copy of the local data here, forever.
ls.setItem('ecosys:v1:backup-before-sync', JSON.stringify({ app: 'ecosys', tasks: new Array(50).fill({ id: 'x' }) }));

test('first sync with a server that has data: merge what was made here, skip untouched samples', async () => {
  let release;
  server.hold = new Promise((r) => (release = r));
  await startSync();
  assert.equal(syncState.online, true);
  // While the merge is on its way, only the records it leaves out are kept aside (small, not a full copy).
  await until(() => server.arrived);
  const backup = JSON.parse(ls.getItem('ecosys:v1:backup-before-sync'));
  assert.equal(backup.kind, 'left-out-by-first-sync');
  assert.deepEqual(backup.records.tasks.map((t) => t.id), [sampleTask.id]);
  assert.deepEqual(backup.records.lists.map((l) => l.id), [personal.id]);
  assert.deepEqual(backup.records.calendars.map((c) => c.name), ['Personal', 'Work'], 'the untouched default calendars');
  assert.deepEqual(Object.keys(backup.records).sort(), ['calendars', 'lists', 'tasks']);
  assert.ok(!backup.records.tasks.some((t) => t.id === 'mytask01'), 'merged records are not copied');
  release();
  await until(() => server.pushed.length > 0);
  const ids = server.pushed.map((o) => o.item?.id);
  assert.ok(ids.includes('mytask01') && ids.includes('mytask02') && ids.includes('mynote01'));
  assert.ok(ids.includes('garden01'), 'a list the merged tasks need is added');
  assert.ok(!ids.includes(sampleTask.id), 'untouched sample task is not pushed');
  assert.ok(!ids.includes(personal.id), 'sample list is matched by name, not duplicated');
  const t1 = server.pushed.find((o) => o.item?.id === 'mytask01');
  assert.equal(t1.item.listId, 'srvlist1', 'task re-pointed at the server list of the same name');
  // local view = server data + merged records
  assert.ok(db.get('tasks', 'srvtask1'));
  assert.equal(db.get('tasks', 'mytask01').listId, 'srvlist1');
  assert.ok(db.get('tasks', 'mytask02'));
  assert.equal(db.get('tasks', sampleTask.id), null);
  await until(() => syncState.pending === 0);
  assert.equal(ls.getItem('ecosys:v1:backup-before-sync'), null, 'the copy goes once the merge is on the server');
  assert.ok(ls.getItem('ecosys:v1:sync'), 'later loads skip the merge');
  window.dispatchEvent(new Event('pagehide'));
});
