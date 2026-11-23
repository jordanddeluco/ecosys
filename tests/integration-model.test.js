// Integration: shared/model.js and shared/seed.js on the real store, validators and notes data model.
// Covers what every app (Home, tasks, schedule, notes) loads on a first run and on a reload, what a
// new server is sent, how an older browser's samples are kept, createTask's `source` link, and
// toggleTask keeping the notes checklist items linked to a task in step with it (Notes open or not).
// Pure Node: a fake localStorage and a fake ecosys server. Run with: npm test
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
  clear() {
    this.map.clear();
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

const { db, registerSeeder, seedIfEmpty, seededAt, setSyncAdapter, snapshot, resetData, COLLECTIONS } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const { seed } = await import('../shared/seed.js');
const { validateItem, validateSnapshot, validateOp, isId } = await import('../shared/sanitize.js');
const S = await import('../notes/core/schema.js');
const { hasIcon } = await import('../shared/icons.js');
const { todayYmd, addDaysYmd } = await import('../shared/dates.js');

const P = 'ecosys:v1:';
const pushed = [];
setSyncAdapter({ push: (ops) => pushed.push(...JSON.parse(JSON.stringify(ops))), pending: () => [] });
const take = () => pushed.splice(0);
const counts = (d = db) => Object.fromEntries(COLLECTIONS.map((c) => [c, d.all(c).length]));
const copyAll = (d = db) => Object.fromEntries(COLLECTIONS.map((c) => [c, structuredClone(d.all(c))]));
const dayNote = () => db.all('notes').find((n) => n.day);
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ---------------------------------------------------------------- first run

test('first run: the samples go in once, untouched, saved, and not recorded for sync', () => {
  assert.ok(COLLECTIONS.every((c) => db.all(c).length === 0), 'a new browser starts empty');
  registerSeeder(seed);
  seedIfEmpty();
  const at = seededAt();
  assert.ok(Number.isFinite(at), 'the seed time is kept');
  assert.equal(ls.getItem(`${P}seeded`), String(at));
  assert.deepEqual(take(), [], 'seeding sends no ops: sync decides what a server gets');
  for (const c of COLLECTIONS) {
    assert.ok(db.all(c).length > 0, `${c}: has samples`);
    for (const x of db.all(c)) {
      // sync.js treats exactly these as untouched samples (firstSyncOps → pristine)
      assert.equal(x.createdAt, x.updatedAt, `${c} ${x.id}: untouched`);
      assert.ok(x.createdAt >= at && x.createdAt - at < 2000, `${c} ${x.id}: made with the seed batch`);
    }
    assert.deepEqual(JSON.parse(ls.getItem(P + c)), db.all(c), `${c}: saved to storage as loaded`);
  }
  const n = counts();
  assert.ok(n.tasks >= 10 && n.events >= 5 && n.lists >= 2 && n.calendars >= 2, JSON.stringify(n));
  assert.ok(n.notes >= 3 && n.notes <= 5 && n.folders >= 1, JSON.stringify(n));
  seedIfEmpty();
  assert.deepEqual(counts(), n, 'a second call adds nothing');
});

test('every sample is canonical for the validators every app and the server share', () => {
  for (const c of COLLECTIONS) {
    const ids = new Set();
    for (const x of db.all(c)) {
      assert.ok(isId(x.id) && !ids.has(x.id), `${c} ${x.id}: a valid, unique id`);
      ids.add(x.id);
      assert.deepEqual(validateItem(c, structuredClone(x)), x, `${c} ${x.id}: validates to itself`);
    }
  }
  // What a new server keeps of them (POST /api/import runs the same validators): everything.
  const kept = validateSnapshot({ data: snapshot().data, settings: {} });
  assert.equal(kept.dropped, 0);
  for (const c of COLLECTIONS) assert.deepEqual(kept.data[c], db.all(c), `${c}: nothing stripped`);
});

test('the sample notes are blocks notes (notes v1) with folders, tags, links and today’s note', () => {
  const notes = db.all('notes');
  const folders = db.all('folders');
  const folderIds = new Set(folders.map((f) => f.id));
  const noteIds = new Set(notes.map((n) => n.id));
  for (const n of notes) {
    const what = `note "${n.title}"`;
    assert.equal(n.v, S.NOTE_FORMAT, `${what}: current format`);
    assert.ok(Array.isArray(n.blocks) && n.blocks.length && !S.isEmptyBlocks(n.blocks), `${what}: has blocks with text`);
    assert.ok(!n.body, `${what}: no stage-1 HTML body`);
    assert.ok(n.title, `${what}: has a title`);
    const derived = S.deriveFields(n);
    assert.deepEqual([n.title, n.tags, n.links], [derived.title, derived.tags, derived.links], `${what}: derived fields are current`);
    assert.deepEqual(S.validateBlocks(n.blocks), n.blocks, `${what}: canonical blocks`);
    assert.ok(n.rev >= 1 && n.editedBy === 'user' && Number.isFinite(n.editedAt), `${what}: rev / editedBy / editedAt`);
    assert.ok(n.trashedAt === null && n.locked === null && n.aiPrev === null && n.aiHidden === false, `${what}: a plain live note`);
    assert.ok(n.folderId === null || folderIds.has(n.folderId), `${what}: in Notes or in a sample folder`);
    for (const ref of n.links) {
      const r = S.parseRef(ref);
      assert.ok(r, `${what}: link ${ref} parses`);
      if (r.kind === 'note') assert.ok(noteIds.has(r.id), `${what}: ${ref} is a sample note`);
      if (r.kind === 'task') assert.ok(db.get('tasks', r.id), `${what}: ${ref} is a sample task`);
    }
  }
  assert.ok(notes.some((n) => n.pinned), 'a pinned note');
  assert.ok(notes.some((n) => n.blocks.some((b) => b.t === 'check')), 'a checklist');
  assert.ok(notes.some((n) => n.tags.length), 'tags');
  assert.ok(notes.some((n) => n.links.some((l) => l.startsWith('note:'))), 'a link to another note');
  const days = notes.filter((n) => n.day);
  assert.equal(days.length, 1, 'one daily note');
  assert.ok([todayYmd(), addDaysYmd(todayYmd(), -1)].includes(days[0].day), 'for today');
  for (const f of folders) {
    assert.ok(f.parentId === null || folderIds.has(f.parentId), `folder ${f.name}: parent exists`);
    assert.ok(S.folderDepth(f.id, folders) <= 3, `folder ${f.name}: at most 3 levels`);
  }
  assert.equal(new Set(folders.map((f) => `${f.parentId}/${f.name.toLowerCase()}`)).size, folders.length, 'folder names are unique among siblings');
});

// ---------------------------------------------------------------- linked checklist items

const stored = (c, id) => JSON.parse(ls.getItem(P + c)).find((x) => x.id === id);
const opKeys = (ops) => ops.map((o) => `${o.op} ${o.c}:${o.item?.id ?? o.id}`).sort();
const checks = (id) => db.get('notes', id).blocks.filter((b) => b.t === 'check').map((b) => b.ck);
/** Records a test makes, removed afterwards even when it fails (so the later tests see the samples only). */
function scratch() {
  const made = { tasks: [], notes: [] };
  return {
    task(fields) {
      const t = M.createTask({ date: todayYmd(), ...fields });
      made.tasks.push(t.id);
      return t;
    },
    note(title, blocks, extra = {}) {
      const n = db.insert('notes', { ...S.newNote({ blocks: [S.newBlock('h1', title), ...blocks] }), ...extra });
      made.notes.push(n.id);
      return n;
    },
    keep: (c, id) => made[c].push(id),
    cleanup() {
      db.batch(() => {
        for (const c of ['tasks', 'notes']) for (const id of made[c]) db.remove(c, id);
      });
      take();
    },
  };
}
const linkedItem = (t, ck = false) => S.newBlock('check', t.title, { task: t.id, ck });

test('today’s note and its task are one object in two views, with or without Notes open', async () => {
  const day = dayNote();
  const item = day.blocks.find((b) => b.t === 'check' && b.task);
  assert.ok(item, 'today’s note has a checklist item linked to a task');
  const task = db.get('tasks', item.task);
  assert.ok(task, 'the linked task is a sample task');
  assert.equal(task.date, day.day, 'due on the day of the note');
  assert.equal(S.blockText(item), task.title);
  assert.equal(item.ck, task.done);
  assert.ok(day.links.includes(`task:${task.id}`));
  assert.deepEqual(task.source, { app: 'notes', noteId: day.id, blockId: item.id }, 'the task links back to the item (From note in Tasks)');
  const N = await import('../notes/core/notes.js');
  take();
  try {
    // Completing it in Tasks, on Home or in Schedule (they all call toggleTask; Notes need not be
    // open) checks the item in the same batch: one change notification, one push carrying both.
    const seen = [];
    const off = db.on(({ names }) => seen.push([...names].sort().join('+')));
    const undo = M.toggleTask(task.id);
    await new Promise((r) => setTimeout(r, 0)); // listeners hear about changes in a microtask
    off();
    assert.equal(db.get('tasks', task.id).done, true);
    const done = db.get('notes', day.id);
    // "Move checked items down" (on by default, as in Apple Notes) may move the checked item below the
    // other items, so compare item by item: the item is checked, nothing else changed.
    const byId = (blocks) => Object.fromEntries(blocks.map((b) => [b.id, b]));
    assert.deepEqual(byId(done.blocks), byId(day.blocks.map((b) => (b.id === item.id ? { ...b, ck: true } : b))), 'the item is checked; nothing else changed');
    assert.equal(done.blocks.length, day.blocks.length, 'no item added or removed');
    assert.deepEqual(seen, ['notes+tasks'], 'one change notification for both');
    assert.deepEqual(opKeys(take()), [`put notes:${day.id}`, `put tasks:${task.id}`], 'one push with both');
    assert.equal(done.rev, day.rev + 1, 'a saved change: rev + 1');
    assert.deepEqual([done.editedAt, done.editedBy], [day.editedAt, day.editedBy], 'a system change, as Notes makes it: not counted as your edit');
    assert.deepEqual(stored('notes', day.id), done, 'saved that way, for every app');
    assert.deepEqual(validateItem('notes', structuredClone(done)), done, 'still canonical');
    assert.equal(N.syncTaskChecks(day.id), null, 'Notes finds nothing left to mirror when it opens');

    // Undo puts both back: the task as it was, the item unchecked. An undo is a new edit, so the
    // task's updatedAt moves on (sync and the server see a newer copy, not a stale one).
    undo();
    const restored = db.get('tasks', task.id);
    assert.deepEqual({ ...restored, updatedAt: task.updatedAt }, task, 'the task is back as it was');
    assert.ok(restored.updatedAt >= task.updatedAt, 'updatedAt moves on');
    const back = db.get('notes', day.id);
    assert.deepEqual(byId(back.blocks), byId(day.blocks), 'the item is unchecked again');
    assert.equal(back.blocks.length, day.blocks.length);
    assert.equal(back.rev, day.rev + 2, 'rev only moves on, so an assistant holding the older rev sees the change');
    assert.deepEqual(opKeys(take()), [`put notes:${day.id}`, `put tasks:${task.id}`]);

    // And from Notes: checking the item completes the task, unchecking it reopens the task.
    const before = db.get('notes', day.id);
    N.setChecked(day.id, item.id, true);
    assert.equal(db.get('tasks', task.id).done, true, 'checking the item completes the task');
    const checked = db.get('notes', day.id);
    assert.equal(checked.blocks.find((b) => b.id === item.id).ck, true);
    assert.equal(checked.rev, before.rev + 1, 'one saved change, not two');
    const ops = take();
    const last = (c, id) => ops.filter((o) => o.c === c && o.item?.id === id).at(-1)?.item;
    assert.deepEqual(last('notes', day.id), checked, 'the server gets the note as saved');
    assert.deepEqual(last('tasks', task.id), db.get('tasks', task.id), 'and the task as saved');
    N.setChecked(day.id, item.id, false);
    assert.equal(db.get('tasks', task.id).done, false, 'unchecking it reopens the task');
    assert.deepEqual(checks(day.id), day.blocks.filter((b) => b.t === 'check').map((b) => b.ck));
  } finally {
    db.batch(() => {
      db.put('tasks', task);
      db.put('notes', day);
    });
    take();
  }
});

test('toggleTask: every linked item follows, and only linked items; other notes are not written', () => {
  const s = scratch();
  try {
    // One task, linked from two notes (a duplicated note, say) and from a note in Recently Deleted.
    const call = s.task({ title: 'Call the plumber' });
    const a = s.note('House', [linkedItem(call)]);
    const b = s.note('House (copy)', [S.newBlock('check', 'Buy a plunger'), linkedItem(call), S.newBlock('check', 'Fix the tap', { ck: true })]);
    const trashed = s.note('Old list', [linkedItem(call)], { trashedAt: Date.now() - 60000 });
    const other = s.note('Elsewhere', [S.newBlock('check', 'Not linked')]);
    take();
    const undo = M.toggleTask(call.id);
    assert.deepEqual(checks(a.id), [true]);
    assert.deepEqual(checks(b.id), [false, true, true], 'only the linked item changes');
    assert.deepEqual(db.get('notes', trashed.id), trashed, 'a note in Recently Deleted is left alone');
    assert.deepEqual(db.get('notes', other.id), other, 'a note without the link is left alone');
    assert.deepEqual(opKeys(take()), [`put notes:${a.id}`, `put notes:${b.id}`, `put tasks:${call.id}`].sort());

    // Reopening a done task unchecks its items; undoing that checks them again.
    const reopen = M.toggleTask(call.id);
    assert.deepEqual([checks(a.id), checks(b.id)], [[false], [false, false, true]]);
    reopen();
    assert.deepEqual([checks(a.id), checks(b.id)], [[true], [false, true, true]]);
    undo();
    assert.equal(db.get('tasks', call.id).done, false);
    assert.deepEqual([checks(a.id), checks(b.id)], [[false], [false, false, true]], 'back where they started');
    take();

    // A task no note links to: no note is written.
    const plain = s.task({ title: 'Nothing links here' });
    take();
    M.toggleTask(plain.id);
    assert.deepEqual(opKeys(take()), [`put tasks:${plain.id}`]);

    // A repeating task moves to its next date and stays open, so its item stays unchecked.
    const fern = s.task({ title: 'Water the fern', repeat: { freq: 'day', interval: 1 } });
    const plants = s.note('Plants', [linkedItem(fern)]);
    take();
    M.toggleTask(fern.id);
    const logged = db.all('tasks').find((x) => x.repeatOf === fern.id);
    assert.ok(logged, 'the completed copy is logged');
    s.keep('tasks', logged.id);
    assert.equal(db.get('tasks', fern.id).done, false);
    assert.ok(db.get('tasks', fern.id).date > todayYmd(), 'advanced');
    assert.deepEqual(db.get('notes', plants.id), plants, 'its item stays unchecked, and the note is not written');
    assert.deepEqual(opKeys(take()), [`put tasks:${fern.id}`, `put tasks:${logged.id}`].sort());
  } finally {
    s.cleanup();
  }
});

test('toggleTask never cuts a note: one the check would push over the size limit is left as it is', () => {
  const s = scratch();
  try {
    const t = s.task({ title: 'Pack the van' });
    db.update('tasks', t.id, { done: true, completedAt: Date.now() });
    // A note at exactly the limit, its item checked: unchecking it ("ck":false) adds one character.
    const blocks = [S.newBlock('h1', 'Moving day'), linkedItem(t, true)];
    const size = (bl) => JSON.stringify(bl).length;
    const limit = S.NOTE_LIMITS.noteBytes;
    // 10,000-character paragraphs, then one sized to fill the rest (well under the 20,000 per block).
    while (limit - size(blocks) > 20000) blocks.push(S.newBlock('p', 'x'.repeat(10000)));
    const last = S.newBlock('p', 'x');
    last.c = [['x'.repeat(limit - size([...blocks, last]) + 1)]];
    blocks.push(last);
    assert.equal(size(blocks), limit);
    assert.equal(S.noteOverLimit(blocks), null, 'it fits');
    const big = db.insert('notes', S.newNote({ blocks }));
    s.keep('notes', big.id);
    assert.deepEqual(big.blocks, blocks, 'stored whole');
    take();
    M.toggleTask(t.id);
    assert.equal(db.get('tasks', t.id).done, false, 'the task reopens');
    assert.deepEqual(db.get('notes', big.id), big, 'the note is left whole (Notes shows the task as it is)');
    assert.deepEqual(opKeys(take()), [`put tasks:${t.id}`]);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------- model.js

test('createTask takes source in the same insert; the validator keeps a good one and drops junk', () => {
  take();
  const day = dayNote();
  const src = { app: 'notes', noteId: day.id, blockId: day.blocks[1].id };
  const made = [];
  const create = (fields) => {
    const t = M.createTask(fields);
    made.push(t.id);
    return t;
  };

  const t = create({ title: 'From a note', source: src });
  assert.deepEqual(t.source, src);
  assert.notEqual(t.source, src, 'a copy, not the caller’s object');
  const ops = take();
  assert.equal(ops.length, 1, 'one op: the task arrives with its source');
  assert.deepEqual(ops[0].item.source, src);
  assert.deepEqual(validateOp(ops[0]), ops[0], 'the server keeps it as sent');

  assert.deepEqual(create({ title: 'No block', source: { app: 'notes', noteId: day.id } }).source, { app: 'notes', noteId: day.id }, 'blockId is optional');
  assert.deepEqual(create({ title: 'Extras', source: { ...src, blockId: 'not a block id', html: '<img src=x>' } }).source, { app: 'notes', noteId: day.id }, 'unknown keys and a bad blockId are dropped');
  const junk = [null, 0, 'notes', ['notes', day.id], { app: 'mail', noteId: day.id }, { app: 'notes', noteId: '../x' }, { app: 'notes' }, Object.create({ app: 'notes', noteId: day.id })];
  for (const bad of junk) assert.ok(!('source' in create({ title: 'Junk source', source: bad })), `no source from ${JSON.stringify(bad)}`);
  assert.ok(!('source' in create({ title: 'Plain' })), 'no source, no key');

  // Duplicate (tasks) passes the whole task: the copy keeps its source, and so does completing it.
  const copy = create({ ...structuredClone(t), order: t.order + 0.001 });
  assert.notEqual(copy.id, t.id);
  assert.deepEqual(copy.source, src);
  M.toggleTask(copy.id);
  assert.deepEqual(db.get('tasks', copy.id).source, src);
  // A repeating task's completed copy keeps it too.
  const daily = create({ title: 'Daily from a note', date: todayYmd(), repeat: { freq: 'day', interval: 1 }, source: src });
  M.toggleTask(daily.id);
  const logged = db.all('tasks').find((x) => x.repeatOf === daily.id);
  assert.ok(logged);
  made.push(logged.id);
  assert.deepEqual(logged.source, src);
  assert.deepEqual(db.get('tasks', daily.id).source, src);

  db.batch(() => made.forEach((id) => db.remove('tasks', id)));
  take();
});

test('smart lists: every icon exists, and Today has its own (Tomorrow is the sun)', () => {
  for (const s of M.SMART_LISTS) assert.ok(hasIcon(s.icon), `${s.id}: icon "${s.icon}" exists in icons.js`);
  assert.equal(M.SMART_LISTS.find((s) => s.id === 'today').icon, 'today');
  assert.equal(new Set(M.SMART_LISTS.map((s) => s.icon)).size, M.SMART_LISTS.length, 'no two smart lists share an icon');
});

// ---------------------------------------------------------------- reloads

test('a reload, or another app opening, loads the same records and seeds nothing', async () => {
  const before = copyAll();
  // A page load is a new store module over the same storage (Home → tasks → schedule → notes).
  for (const app of ['home', 'tasks', 'schedule', 'notes']) {
    const page = await import(`../shared/store.js?page=${app}`);
    page.registerSeeder(seed);
    page.seedIfEmpty();
    for (const c of COLLECTIONS) assert.deepEqual(page.db.all(c), before[c], `${app}: ${c} unchanged, blocks and all`);
    assert.equal(page.seededAt(), seededAt(), `${app}: same seed time, so sync still knows the samples`);
  }
  assert.deepEqual(copyAll(), before);
});

test('Settings › Start over with sample data: a fresh set, valid, replacing (not adding to) the old one', () => {
  const old = new Set(db.all('notes').map((n) => n.id));
  const before = counts();
  resetData({ withSamples: true });
  assert.deepEqual(counts(), before, 'the same samples, once');
  assert.ok(db.all('notes').every((n) => !old.has(n.id) && n.blocks.length), 'new sample notes with blocks');
  for (const c of COLLECTIONS) for (const x of db.all(c)) assert.deepEqual(validateItem(c, structuredClone(x)), x);
  const ops = take();
  assert.deepEqual(ops.map((o) => o.op), COLLECTIONS.map(() => 'replace'), 'one replace per collection');
  for (const o of ops) assert.deepEqual(o.items, db.all(o.c), `${o.c}: the replace carries the samples`);
  const day = dayNote();
  const item = day.blocks.find((b) => b.task);
  assert.deepEqual(db.get('tasks', item.task)?.source, { app: 'notes', noteId: day.id, blockId: item.id }, 'still linked both ways');
});

// ---------------------------------------------------------------- a new server

test('a new server starts with this browser’s samples, notes blocks and task source included', async () => {
  const server = { rev: 0, initialized: false, data: Object.fromEntries(COLLECTIONS.map((c) => [c, []])), settings: {}, imports: [], ops: [] };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync'] });
    if (path === 'state') return json(200, { rev: server.rev, initialized: server.initialized, data: structuredClone(server.data), settings: structuredClone(server.settings) });
    if (path === 'import' && opts.method === 'POST') {
      if (server.initialized) return json(409, { error: 'already initialized' });
      server.imports.push(body);
      const v = validateSnapshot(body, { all: true }); // the same validators as server/validate.mjs
      server.data = v.data;
      server.settings = v.settings;
      server.initialized = true;
      return json(200, { rev: ++server.rev });
    }
    if (path === 'ops' && opts.method === 'POST') {
      server.ops.push(...body.ops);
      return json(200, { rev: ++server.rev, applied: body.ops.length, rejected: [] });
    }
    if (path === 'events') return new Response(new ReadableStream({ start(c) { opts.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} }); } }), { status: 200 });
    return json(404, { error: 'Not found' });
  };
  const local = copyAll();
  const { startSync, syncState } = await import('../shared/sync.js');
  try {
    await startSync();
    await until(() => syncState.online && syncState.pending === 0);
    assert.equal(server.imports.length, 1, 'one import');
    for (const c of COLLECTIONS) {
      assert.deepEqual(server.imports[0].data[c], local[c], `${c}: sent as they are`);
      assert.deepEqual(server.data[c], local[c], `${c}: the server keeps every field`);
      assert.deepEqual(db.all(c), local[c], `${c}: this browser shows the server's copy, unchanged`);
    }
    assert.ok(server.data.notes.every((n) => n.blocks.length), 'notes keep their blocks');
    assert.ok(server.data.tasks.some((t) => t.source?.app === 'notes'), 'the linked task keeps its source');
    assert.deepEqual(server.ops, [], 'nothing is sent twice');
  } finally {
    window.dispatchEvent(new Event('pagehide')); // stop the stream and timers
  }
});

// ---------------------------------------------------------------- older browsers

test('a browser seeded by an older version keeps its own samples: no second set, HTML notes read as blocks', async () => {
  ls.clear();
  const T = Date.now() - 3 * 86400000;
  ls.setItem(`${P}seeded`, String(T));
  ls.setItem(`${P}tasks`, JSON.stringify([{ id: 'oldtask000000001', title: 'Plan the week', listId: null, createdAt: T, updatedAt: T }]));
  ls.setItem(`${P}folders`, JSON.stringify([{ id: 'oldfolder0000001', name: 'Work', color: 'blue', icon: '', parentId: null, order: 0, createdAt: T, updatedAt: T }]));
  ls.setItem(
    `${P}notes`,
    JSON.stringify([
      {
        id: 'oldnote000000001',
        title: 'Weekly planning',
        body: '<h2>Weekly planning</h2><ul class="checklist"><li data-checked="true">Review last week</li><li data-checked="false">Block focus time</li></ul><p>Related task: <a href="ecosys:task/oldtask000000001" data-task="oldtask000000001">Plan the week</a></p>',
        folderId: 'oldfolder0000001',
        pinned: false,
        color: null,
        tags: [],
        order: 1,
        trashedAt: null,
        createdAt: T,
        updatedAt: T,
      },
    ]),
  );
  const page = await import('../shared/store.js?page=upgraded');
  page.registerSeeder(seed);
  page.seedIfEmpty();
  assert.deepEqual(counts(page.db), { tasks: 1, lists: 0, events: 0, calendars: 0, notes: 1, folders: 1 }, 'nothing added');
  const [n] = page.db.all('notes');
  assert.equal(n.title, 'Weekly planning');
  const checks = n.blocks.filter((b) => b.t === 'check').map((b) => [S.blockText(b), b.ck]);
  assert.deepEqual(checks, [['Review last week', true], ['Block focus time', false]], 'the checklist is a checklist');
  assert.ok(n.blocks.some((b) => S.blockText(b).includes('Plan the week')), 'the text is all there');
  assert.equal(n.folderId, 'oldfolder0000001');
  assert.equal(n.createdAt, n.updatedAt, 'still an untouched sample for sync');
  const again = await import('../shared/store.js?page=upgraded-again');
  assert.deepEqual(again.db.all('notes'), page.db.all('notes'), 'the same block ids on every load, so links to them hold');
});
