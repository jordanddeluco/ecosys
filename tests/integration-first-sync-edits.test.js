// Integration: a new browser's first-run samples, edited before its first sync, meet a server that
// already has data (from another browser) with today's daily note and a "Work" folder.
// Before the first sync the person completes the sample task "Reply to Taylor about the venue" in
// Tasks, which checks its item in today's sample note (shared/model.js toggleTask, one object in two
// views), and pins the sample note "Project kickoff", which sits in Work › Meetings.
// What the person did must reach the server, and nothing may be doubled: one daily note per day, one
// "Work" folder. The two `todo` tests are known gaps in shared/sync.js firstSyncOps (an edited sample
// daily note is sent as a second note for its day; a needed sample folder's sample parent is sent
// although the server has a folder of that name at that level). Remove `todo` once it handles them.
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

const { validateItem, validateOp } = await import('../shared/sanitize.js');
const S = await import('../notes/core/schema.js');
const { todayYmd } = await import('../shared/dates.js');
const { db, registerSeeder, seedIfEmpty } = await import('../shared/store.js');
const { seed } = await import('../shared/seed.js');
const { toggleTask } = await import('../shared/model.js');

// ---------------------------------------------------------------- this browser: first run, offline at first
registerSeeder(seed);
seedIfEmpty();
const today = todayYmd();
const sampleDay = db.all('notes').find((n) => n.day === today);
const reply = db.get('tasks', sampleDay.blocks.find((b) => b.task).task);
const kickoff = db.all('notes').find((n) => n.title === 'Project kickoff');
const meetings = db.get('folders', kickoff.folderId);
const work = db.get('folders', meetings.parentId);
const sampleIds = new Set(['tasks', 'lists', 'events', 'calendars', 'notes', 'folders'].flatMap((c) => db.all(c).map((x) => `${c}:${x.id}`)));

toggleTask(reply.id); // in Tasks, with Notes closed
db.update('notes', kickoff.id, { pinned: true });

// ---------------------------------------------------------------- the server, filled by another browser
const T0 = Date.now() - 5 * 86400000;
const rec = (c, x) => validateItem(c, { createdAt: T0, updatedAt: T0, ...x });
const server = {
  rev: 40,
  data: {
    tasks: [],
    lists: [rec('lists', { id: 'srvlistpersonal', name: 'Personal', color: 'iris', order: 0 })],
    events: [],
    calendars: [],
    folders: [rec('folders', { id: 'srvfolderwork01', name: 'Work', color: 'blue', parentId: null, order: 0 })],
    notes: [rec('notes', { ...S.newNote({ day: today, blocks: [...S.dailyNoteBlocks(today), S.newBlock('check', 'Call the bank')], now: T0 }), id: 'srvnotetoday001' })],
  },
  pushed: [],
  imports: 0,
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync'] });
  if (path === 'state') return json(200, { rev: server.rev, initialized: true, data: structuredClone(server.data), settings: {} });
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
const onServer = (c, id) => server.data[c].find((x) => x.id === id);

test('first sync: what the person did before it reaches the server', async () => {
  assert.equal(db.get('tasks', reply.id).done, true, 'the task was completed offline');
  assert.equal(db.get('notes', sampleDay.id).blocks.find((b) => b.task === reply.id).ck, true, 'and its item in today’s note checked with it');
  try {
    await startSync();
    await until(() => syncState.online && server.pushed.length > 0 && syncState.pending === 0);
  } finally {
    window.dispatchEvent(new Event('pagehide')); // stop the stream and timers
  }
  assert.equal(server.imports, 0, 'no import: the server already had data');
  assert.equal(onServer('tasks', reply.id)?.done, true, 'the completed task is on the server, done');
  assert.equal(onServer('tasks', reply.id).listId, 'srvlistpersonal', 'filed under the server’s list of the same name');
  assert.equal(onServer('notes', kickoff.id)?.pinned, true, 'the pinned note is on the server, pinned');
  const untouched = server.pushed.map((o) => `${o.c}:${o.item?.id ?? o.id}`).filter((k) => sampleIds.has(k) && ![`tasks:${reply.id}`, `notes:${kickoff.id}`, `notes:${sampleDay.id}`, `folders:${meetings.id}`, `folders:${work.id}`].includes(k));
  assert.deepEqual(untouched, [], 'no other sample is sent');
});

test('first sync: still one daily note for today', { todo: 'shared/sync.js firstSyncOps sends an edited sample daily note as a second note for a day the server already has' }, () => {
  assert.equal(server.data.notes.filter((n) => n.day === today && !n.trashedAt).length, 1, 'on the server');
  assert.equal(db.all('notes').filter((n) => n.day === today && !n.trashedAt).length, 1, 'in this browser');
});

test('first sync: still one "Work" folder, and the pinned note’s folders exist on the server', { todo: 'shared/sync.js firstSyncOps sends the sample "Work" folder (parent of the needed "Meetings") although the server has a "Work" folder' }, () => {
  const roots = (folders) => folders.filter((f) => f.parentId === null && f.name.toLowerCase() === 'work').length;
  assert.equal(roots(server.data.folders), 1, 'on the server');
  assert.equal(roots(db.all('folders')), 1, 'in this browser');
  const note = onServer('notes', kickoff.id);
  for (let id = note?.folderId, depth = 0; id && depth < 5; depth++) {
    const f = server.data.folders.find((x) => x.id === id);
    assert.ok(f, `folder ${id} is on the server`);
    id = f.parentId;
  }
});
