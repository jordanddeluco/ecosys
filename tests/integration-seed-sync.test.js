// Integration: a new browser's first-run samples (shared/seed.js) meet a server that already has data
// (from another browser). The untouched samples are never sent and give way to the server's data, so
// nothing is doubled: tasks, lists, events, calendars, notes, folders, or today's note. A sample the
// person already edited is kept and filed under the server's folder of the same name.
// Pure Node: a fake localStorage and a fake ecosys server driven by the real shared/sync.js. Run with: npm test
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
// No Web Locks: sync.js opens its own event stream, and no BroadcastChannel keeps the process alive.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };

const { validateItem, validateOp, COLLECTIONS } = await import('../shared/sanitize.js');
const S = await import('../notes/core/schema.js');
const { todayYmd } = await import('../shared/dates.js');
const { db, registerSeeder, seedIfEmpty, snapshot } = await import('../shared/store.js');
const { seed } = await import('../shared/seed.js');

// ---------------------------------------------------------------- this browser: first run, offline at first
registerSeeder(seed);
seedIfEmpty();
const samples = snapshot().data;
const sampleIds = new Set(COLLECTIONS.flatMap((c) => samples[c].map((x) => `${c}:${x.id}`)));
// Before the server was reachable, the person ticked an item in a sample note that sits in a folder.
const groceries = samples.notes.find((n) => n.title === 'Groceries') || samples.notes.find((n) => n.folderId && n.blocks.some((b) => b.t === 'check' && !b.ck));
const groceriesFolder = samples.folders.find((f) => f.id === groceries.folderId);
const ticked = groceries.blocks.find((b) => b.t === 'check' && !b.ck);
const edited = db.update('notes', groceries.id, { blocks: groceries.blocks.map((b) => (b.id === ticked.id ? { ...b, ck: true } : b)), rev: groceries.rev + 1, editedAt: Date.now() });

// ---------------------------------------------------------------- the server, filled by another browser
const T0 = Date.now() - 5 * 86400000;
const rec = (c, x) => validateItem(c, { createdAt: T0, updatedAt: T0, ...x });
const today = todayYmd();
const theirs = {
  lists: [rec('lists', { id: 'srvlistpersonal', name: 'Personal', color: 'iris', order: 0 })],
  calendars: [rec('calendars', { id: 'srvcalpersonal1', name: 'Personal', color: 'iris', visible: true, order: 0 })],
  tasks: [rec('tasks', { id: 'srvtask00000001', title: 'Book the dentist', listId: 'srvlistpersonal', date: today })],
  events: [rec('events', { id: 'srvevent0000001', title: 'Yoga', calendarId: 'srvcalpersonal1', allDay: false, start: `${today}T07:00`, end: `${today}T08:00` })],
  // Their folder has the same name as the one this browser's edited sample note sits in.
  folders: [rec('folders', { id: 'srvfoldershared', name: groceriesFolder.name, color: 'orange', parentId: null, order: 0 })],
  notes: [
    rec('notes', { ...S.newNote({ blocks: [S.newBlock('h1', 'Packing list'), S.newBlock('check', 'Passport')], now: T0 }), id: 'srvnotepacking1', folderId: 'srvfoldershared' }),
    // Their browser made today's note too: there must still be one daily note per day.
    rec('notes', { ...S.newNote({ day: today, blocks: S.dailyNoteBlocks(today), now: T0 }), id: 'srvnotetoday001' }),
  ],
};
const server = { rev: 30, data: structuredClone(theirs), imports: 0, pushed: [] };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync'] });
  if (path === 'state') return json(200, { rev: server.rev, initialized: true, data: structuredClone(server.data), settings: { theme: 'dark' } });
  if (path === 'import') {
    server.imports++;
    return json(409, { error: 'already initialized' });
  }
  if (path === 'ops' && opts.method === 'POST') {
    const ops = JSON.parse(opts.body).ops.map(validateOp); // the same validators as server/validate.mjs
    for (const o of ops) {
      server.pushed.push(o);
      if (o?.op !== 'put') continue;
      const list = server.data[o.c];
      const i = list.findIndex((x) => x.id === o.item.id);
      if (i >= 0) list[i] = o.item;
      else list.push(o.item);
    }
    return json(200, { rev: ++server.rev, applied: ops.length, rejected: [] });
  }
  if (path === 'events') return new Response(new ReadableStream({ start(c) { opts.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} }); } }), { status: 200 });
  return json(404, { error: 'Not found' });
};
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const { startSync, syncState } = await import('../shared/sync.js');

test('first sync: untouched samples are not sent, and give way to the server’s data', async () => {
  assert.ok(samples.notes.length >= 3 && samples.tasks.length >= 10, 'this browser had its samples');
  await startSync();
  await until(() => syncState.online && server.pushed.length > 0 && syncState.pending === 0);
  assert.equal(server.imports, 0, 'no import: the server already had data');
  const sent = server.pushed.map((o) => `${o.c}:${o.item?.id ?? o.id}`);
  assert.deepEqual(sent, [`notes:${groceries.id}`], 'only the edited sample is sent');
  assert.ok(!sent.some((k) => k !== `notes:${groceries.id}` && sampleIds.has(k)), 'no untouched sample reaches the server');

  // This browser now shows the server's data plus the one kept note: nothing twice.
  for (const c of COLLECTIONS) {
    const ids = db.all(c).map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `${c}: no duplicate ids`);
    const want = [...theirs[c].map((x) => x.id), ...(c === 'notes' ? [groceries.id] : [])].sort();
    assert.deepEqual([...ids].sort(), want, `${c}: the server's records (and the kept note), no samples`);
    assert.deepEqual(JSON.parse(ls.getItem(`ecosys:v1:${c}`)).map((x) => x.id).sort(), want, `${c}: saved that way too`);
  }
  assert.equal(db.all('notes').filter((n) => n.day === today).length, 1, 'one daily note for today: the server’s');
  assert.equal(db.all('folders').filter((f) => f.name === groceriesFolder.name).length, 1, `one "${groceriesFolder.name}" folder`);
});

test('the edited sample keeps its edit and is filed under the server’s folder of the same name', () => {
  const mine = db.get('notes', groceries.id);
  const onServer = server.data.notes.find((n) => n.id === groceries.id);
  assert.equal(mine.folderId, 'srvfoldershared', `re-filed under the server’s "${groceriesFolder.name}" folder`);
  assert.deepEqual(onServer, mine, 'the server has the same copy');
  assert.equal(mine.blocks.find((b) => b.id === ticked.id).ck, true, 'the tick survived');
  assert.deepEqual(mine.blocks, edited.blocks);
  assert.ok(!server.data.folders.some((f) => f.id === groceriesFolder.id), 'the sample folder is not sent');
});

test('after the first sync, changes are sent as usual', async () => {
  const before = server.pushed.length;
  const t = db.insert('tasks', { title: 'Made after the first sync', listId: 'srvlistpersonal' });
  await until(() => server.pushed.length > before && syncState.pending === 0);
  assert.deepEqual(server.pushed.slice(before).map((o) => `${o.c}:${o.item?.id}`), [`tasks:${t.id}`]);
  window.dispatchEvent(new Event('pagehide')); // stop the stream and timers
});
