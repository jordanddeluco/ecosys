// Notes are validated with the notes data model in EVERY app. shared/store.js registers the
// definitive notes / folders / task.source validators (notes/core/schema.js) itself, so a page that
// never opens the notes app (Tasks, Schedule, Home before its lazy import) no longer strips note
// blocks when it saves remote changes, snapshots, backups or other tabs' writes over the
// localStorage copy every app shares.
//
// This file never imports notes/core/schema.js: like such a page it loads shared/store.js only
// (npm test runs every test file in its own process). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
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

// ---------------------------------------------------------------- fixtures (canonical records)

const P = 'ecosys:v1:';
const T0 = 1795000000000;
const T1 = T0 + 5000;

/** A full note as the notes app stores it: every block type, marks, chips, links, highlights. */
const NOTE = {
  id: 'n1',
  v: 1,
  rev: 7,
  blocks: [
    { id: 'b1', t: 'h1', c: [['Groceries']] },
    { id: 'b2', t: 'check', in: 0, ck: true, task: 'tk1', c: [['oat '], ['barista', 'b']] },
    { id: 'b3', t: 'p', c: [['see '], ['Plan', '', { ref: 'note:n2', atom: 1 }], [' and '], ['the shop', 'i', { href: 'https://example.com/shop', hl: 'mint' }], [' #home']] },
    { id: 'b4', t: 'num', in: 1, start: 3, c: [['third']] },
    { id: 'b5', t: 'code', lang: 'js', c: [['let x = 1;\n\tx++;']] },
    { id: 'b6', t: 'hr' },
    { id: 'b7', t: 'quote', c: [['bold ', 'b'], ['code', 'c'], [' mixed', 'bius']] },
    { id: 'b8', t: 'h2', fold: true, c: [['Later'], [' on 22 Nov', '', { ref: 'day:2026-11-22', atom: 1 }]] },
  ],
  title: 'Groceries',
  tags: ['home'],
  links: ['task:tk1', 'note:n2', 'day:2026-11-22'],
  folderId: 'f1',
  pinned: true,
  day: '2026-11-22',
  event: { id: 'e1', date: '2026-11-24' },
  aiHidden: false,
  aiPrev: { at: T0, by: 'mcp:claude', rev: 6, blocks: [{ id: 'b1', t: 'h1', c: [['Groceries']] }] },
  locked: null,
  editedBy: 'mcp:claude',
  editedAt: T1,
  createdAt: T0,
  updatedAt: T1,
  trashedAt: null,
  trashedFrom: null,
};

/** A note in Recently Deleted, with lists and a plain link. */
const NOTE2 = {
  id: 'n2',
  v: 1,
  rev: 3,
  blocks: [
    { id: 'p1', t: 'h1', c: [['Plan']] },
    { id: 'p2', t: 'bullet', in: 0, c: [['first ', 'u'], ['docs', '', { href: 'https://example.org/docs' }]] },
    { id: 'p3', t: 'dash', in: 2, c: [['nested ', 's'], ['#work/clients']] },
    { id: 'p4', t: 'check', in: 0, ck: false, c: [['call back']] },
  ],
  title: 'Plan',
  tags: ['work/clients'],
  links: [],
  folderId: null,
  pinned: false,
  day: null,
  event: null,
  aiHidden: true,
  aiPrev: null,
  locked: null,
  editedBy: 'user',
  editedAt: T1,
  createdAt: T0,
  updatedAt: T1,
  trashedAt: T1,
  trashedFrom: 'f1',
};

const FOLDER = { id: 'f1', name: 'Work', parentId: null, color: 'teal', order: 1, sort: 'title', sortDir: 'asc', groupByDate: false, view: 'gallery', aiHidden: true, createdAt: T0, updatedAt: T1 };
const TASK = { id: 'tk1', title: 'Buy oat milk', source: { app: 'notes', noteId: 'n1', blockId: 'b2' }, createdAt: T0, updatedAt: T0 };

// ---------------------------------------------------------------- a page that never loaded the notes app

const ls = new MemoryStorage({
  [P + 'notes']: JSON.stringify([NOTE]),
  [P + 'folders']: JSON.stringify([FOLDER]),
  [P + 'tasks']: JSON.stringify([TASK]),
  [P + 'seeded']: 'user',
});
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

// sanitize.js on its own has only the stage-1 notes schema (what such a page validated with before).
const S = await import('../shared/sanitize.js');
const before = { notes: S.schemaFields('notes'), folders: S.schemaFields('folders'), tasks: S.schemaFields('tasks') };
const { db, applyRemoteOps, replaceAll, exportData, importData, snapshot } = await import('../shared/store.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const stored = (c) => JSON.parse(ls.getItem(P + c) || '[]');
const byId = (list, id) => list.find((x) => x.id === id) ?? null;
/** The exact stored form (key order included): store.js, sync.js and the server compare JSON strings. */
const same = (actual, expected, what) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), what);

// The form the store keeps: the fixture plus the stage-1 fields the schema also keeps (body, color, order).
const FIXTURES = { n1: ['notes', NOTE], n2: ['notes', NOTE2], f1: ['folders', FOLDER], tk1: ['tasks', TASK] };
const want = Object.fromEntries(Object.entries(FIXTURES).map(([id, [c, x]]) => [id, S.validateItem(c, clone(x))]));

/** `actual` keeps every field of fixture `id` as given (blocks, runs and attrs exactly), in the stored form. */
function kept(actual, id, what = id) {
  const fixture = FIXTURES[id][1];
  assert.ok(actual, `${what} is missing`);
  for (const k of Object.keys(fixture)) assert.deepEqual(actual[k], fixture[k], `${what}: ${k} was not kept`);
  same(actual, want[id], `${what}: not in the stored form`);
}

// ---------------------------------------------------------------- tests

test('only shared/store.js is loaded, and it registers the notes data model before it validates anything', () => {
  assert.ok(!before.notes.includes('blocks'), `precondition: nothing registered the notes schema before shared/store.js was imported (notes fields: ${before.notes.join(', ')})`);
  assert.ok(!before.folders.includes('view') && !before.tasks.includes('source'), 'precondition: stage-1 folders and tasks schemas');
  const notes = S.schemaFields('notes');
  for (const k of ['v', 'rev', 'blocks', 'links', 'day', 'event', 'aiHidden', 'aiPrev', 'locked', 'editedBy', 'editedAt', 'trashedFrom']) assert.ok(notes.includes(k), `notes keep ${k}`);
  for (const k of ['sort', 'sortDir', 'groupByDate', 'view', 'aiHidden']) assert.ok(S.schemaFields('folders').includes(k), `folders keep ${k}`);
  assert.ok(S.schemaFields('tasks').includes('source'), 'tasks keep source');
});

test('notes/core/schema.js never imports shared/store.js, so registering the notes data model cannot become an import loop', async () => {
  // store.js imports schema.js and calls registerNoteSchemas() while it loads. If schema.js imported
  // store.js, a page that loads schema.js first (the notes app) would run store.js before schema.js
  // had initialized its bindings, and the store would fail to load.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../notes/core/schema.js', import.meta.url), 'utf8');
  const specs = [...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] || m[2] || m[3]);
  assert.ok(specs.some((s) => s.endsWith('shared/sanitize.js')), `precondition: the import list was read (${specs.join(', ')})`);
  for (const s of specs) assert.ok(!/(^|\/)store\.js$/.test(s), `notes/core/schema.js imports ${s}`);
});

test('the fixtures are valid records that validation keeps as given', () => {
  for (const id of Object.keys(FIXTURES)) kept(want[id], id);
});

test('full notes, their folder and task.source survive loading from localStorage', () => {
  kept(db.get('notes', 'n1'), 'n1', 'note n1 as loaded');
  kept(db.get('folders', 'f1'), 'f1', 'folder f1 as loaded');
  kept(db.get('tasks', 'tk1'), 'tk1', 'task tk1 as loaded');
});

test('remote ops (another browser, an AI over MCP) keep full notes: put, replace, and a no-op replace changes nothing', () => {
  const raw = ls.getItem(P + 'notes');
  assert.deepEqual(applyRemoteOps([{ op: 'put', c: 'notes', item: clone(NOTE) }]), [], 'the same note again is no change');
  assert.equal(ls.getItem(P + 'notes'), raw, 'nothing was rewritten');

  assert.deepEqual(applyRemoteOps([{ op: 'put', c: 'notes', item: clone(NOTE2) }]), ['notes']);
  kept(db.get('notes', 'n2'), 'n2', 'n2 in the cache');
  kept(byId(stored('notes'), 'n2'), 'n2', 'n2 in localStorage');
  kept(byId(stored('notes'), 'n1'), 'n1', 'n1 in localStorage');

  const saved = ls.getItem(P + 'notes');
  assert.deepEqual(applyRemoteOps([{ op: 'replace', c: 'notes', items: [clone(NOTE), clone(NOTE2)] }]), [], 'a replace with the same notes is no change');
  assert.equal(ls.getItem(P + 'notes'), saved);

  const edited = { ...clone(NOTE), rev: 8, updatedAt: T1 + 1, blocks: [...clone(NOTE.blocks), { id: 'b9', t: 'p', c: [['added by Claude', 'i']] }] };
  assert.deepEqual(applyRemoteOps([{ op: 'replace', c: 'notes', items: [edited, clone(NOTE2)] }]), ['notes']);
  const got = db.get('notes', 'n1');
  same(got.blocks, edited.blocks, 'replaced blocks kept exactly');
  assert.equal(got.rev, 8);
  same(byId(stored('notes'), 'n1'), got, 'localStorage has the same record');
  applyRemoteOps([{ op: 'put', c: 'notes', item: clone(NOTE) }]); // back to the fixture

  assert.deepEqual(applyRemoteOps([{ op: 'put', c: 'folders', item: { ...clone(FOLDER), view: 'list', updatedAt: T1 + 2 } }]), ['folders']);
  assert.equal(db.get('folders', 'f1').view, 'list');
  assert.equal(db.get('folders', 'f1').aiHidden, true);
  applyRemoteOps([{ op: 'put', c: 'folders', item: clone(FOLDER) }]);
  kept(db.get('folders', 'f1'), 'f1');
  kept(byId(stored('folders'), 'f1'), 'f1', 'f1 in localStorage');
  applyRemoteOps([{ op: 'put', c: 'tasks', item: { ...clone(TASK), title: 'Buy oat milk (2)', updatedAt: T1 } }]);
  assert.deepEqual(db.get('tasks', 'tk1').source, TASK.source);
  applyRemoteOps([{ op: 'put', c: 'tasks', item: clone(TASK) }]);
  kept(db.get('tasks', 'tk1'), 'tk1');
});

test('a server snapshot (replaceAll) keeps full notes; an unchanged one rewrites nothing', () => {
  const raw = ls.getItem(P + 'notes');
  const server = { rev: 9, data: { notes: [clone(NOTE), clone(NOTE2)], folders: [clone(FOLDER)], tasks: [clone(TASK)] }, settings: {} };
  const names = replaceAll(server, { reason: 'sync' });
  assert.ok(!names.includes('notes') && !names.includes('folders') && !names.includes('tasks'), `unchanged collections were replaced: ${names}`);
  assert.equal(ls.getItem(P + 'notes'), raw, 'notes in localStorage were not rewritten');

  const moved = { ...clone(NOTE2), trashedAt: null, trashedFrom: null, folderId: 'f1', updatedAt: T1 + 3 };
  assert.ok(replaceAll({ data: { notes: [clone(NOTE), moved] } }).includes('notes'));
  const got = db.get('notes', 'n2');
  assert.deepEqual(got.blocks, NOTE2.blocks, 'blocks kept exactly');
  assert.equal(got.folderId, 'f1');
  assert.equal(got.trashedAt, null);
  same(byId(stored('notes'), 'n2'), got);
  kept(byId(stored('notes'), 'n1'), 'n1', 'n1 in localStorage');
  replaceAll(server);
  kept(byId(snapshot().data.notes, 'n1'), 'n1');
  kept(byId(snapshot().data.notes, 'n2'), 'n2');
});

test('a backup (exportData, then importData) round-trips full notes, folders and task.source', () => {
  const backup = clone(exportData()); // as written to and read back from a file
  kept(byId(backup.notes, 'n1'), 'n1', 'n1 in the backup');
  kept(byId(backup.notes, 'n2'), 'n2', 'n2 in the backup');
  db.remove('notes', 'n1');
  db.update('notes', 'n2', { pinned: true });
  db.remove('folders', 'f1');
  const r = importData(backup);
  assert.equal(r.dropped, 0);
  assert.deepEqual(db.all('notes').map((n) => n.id), ['n1', 'n2']);
  kept(db.get('notes', 'n1'), 'n1', 'n1 after the import');
  kept(db.get('notes', 'n2'), 'n2', 'n2 after the import');
  kept(byId(stored('notes'), 'n1'), 'n1', 'n1 in localStorage after the import');
  kept(byId(stored('notes'), 'n2'), 'n2', 'n2 in localStorage after the import');
  kept(db.get('folders', 'f1'), 'f1', 'f1 after the import');
  kept(db.get('tasks', 'tk1'), 'tk1', 'tk1 after the import');
});

test('another tab writing full notes (storage event) keeps them', () => {
  const other = [clone(NOTE), { ...clone(NOTE2), rev: 4, blocks: [...clone(NOTE2.blocks), { id: 'p5', t: 'quote', c: [['from the other tab']] }] }];
  const newValue = JSON.stringify(other);
  ls.setItem(P + 'notes', newValue);
  window.dispatchEvent(Object.assign(new Event('storage'), { key: P + 'notes', newValue, storageArea: ls }));
  kept(db.get('notes', 'n1'), 'n1');
  assert.deepEqual(db.get('notes', 'n2').blocks, other[1].blocks);
  assert.equal(db.get('notes', 'n2').rev, 4);
});

test('a record whose validator throws is dropped alone: other tabs, remote batches and backups keep everything else', () => {
  // A validator that throws on purpose, so the store's handling is tested whatever notes/core/schema.js
  // does with odd input today (it repairs the odd folder below rather than throwing on it).
  const boom = (v) => (v === 'boom' ? null.x : undefined); // a TypeError for 'boom'; the field is never kept
  S.extendSchema('folders', { zzBoom: boom });
  S.extendSchema('notes', { zzBoom: boom });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const bad = () => ({ id: 'bad1', name: 'Throws', zzBoom: 'boom' });
    const badNote = () => ({ ...clone(NOTE2), id: 'n4', zzBoom: 'boom' });
    // Parsed JSON can also hold objects whose toString is not a function: repaired or dropped, never a throw.
    const odd = () => JSON.parse('{"id":"odd1","name":{"toString":0},"parentId":{"toString":""}}');
    const okOdd = () => {
      const f = db.get('folders', 'odd1');
      assert.ok(f === null || typeof f.name === 'string', 'an odd folder is either dropped or repaired');
    };
    const gone = (what) => {
      assert.equal(db.get('folders', 'bad1'), null, `${what}: the folder whose validator threw was dropped`);
      assert.equal(db.get('notes', 'n4'), null, `${what}: the note whose validator threw was dropped`);
    };
    // Another tab (the same loader runs when a page starts).
    const newValue = JSON.stringify([FOLDER, bad(), odd()]);
    ls.setItem(P + 'folders', newValue);
    assert.doesNotThrow(() => window.dispatchEvent(Object.assign(new Event('storage'), { key: P + 'folders', newValue, storageArea: ls })));
    kept(db.get('folders', 'f1'), 'f1', 'f1 after another tab wrote a folder whose validator throws');
    gone('another tab');
    okOdd();
    // A remote batch.
    const note = { ...clone(NOTE2), rev: 5, updatedAt: T1 + 9 };
    assert.doesNotThrow(() =>
      applyRemoteOps([{ op: 'put', c: 'folders', item: bad() }, { op: 'put', c: 'notes', item: badNote() }, { op: 'put', c: 'notes', item: note }, { op: 'replace', c: 'folders', items: [clone(FOLDER), bad(), odd()] }]),
    );
    assert.equal(db.get('notes', 'n2').rev, 5, 'the valid op of the batch was applied');
    kept(db.get('folders', 'f1'), 'f1', 'f1 after a remote batch');
    gone('a remote batch');
    okOdd();
    // A backup.
    const backup = clone(exportData());
    backup.folders.push(bad(), odd());
    backup.notes.push(badNote(), JSON.parse('{"id":"n3","title":{"toString":0},"body":{"valueOf":0,"toString":0}}'));
    let r;
    assert.doesNotThrow(() => (r = importData(backup)));
    kept(db.get('folders', 'f1'), 'f1', 'f1 after importing a backup with records whose validators throw');
    assert.equal(db.get('notes', 'n2').rev, 5);
    assert.ok(r.dropped >= 2 && r.dropped <= 4, `dropped ${r.dropped}`);
    gone('a backup');
    okOdd();
    // Each collection whose validator threw was reported once, not once per record.
    for (const c of ['folders', 'notes']) assert.equal(warnings.filter((w) => w.includes(`a ${c} validator threw`)).length, 1, `${c}: ${warnings.join(' | ')}`);
  } finally {
    console.warn = warn;
    S.extendSchema('folders', { zzBoom: () => undefined }); // inert from here on
    S.extendSchema('notes', { zzBoom: () => undefined });
  }
  applyRemoteOps([{ op: 'replace', c: 'folders', items: [clone(FOLDER)] }, { op: 'put', c: 'notes', item: clone(NOTE2) }]);
  kept(db.get('folders', 'f1'), 'f1', 'f1 once the throwing validator is inert');
});

test('writes to a prototype-named "collection" are refused before anything changes', () => {
  const protoKeys = Object.getOwnPropertyNames(Object.prototype).join();
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'nope']) {
    assert.throws(() => db.insert(name, { title: 'x' }), /unknown collection/, name);
    assert.throws(() => db.put(name, { id: 'x1' }), /unknown collection/, name);
    assert.throws(() => db.update(name, 'x1', { title: 'y' }), /unknown collection/, name);
    assert.throws(() => db.remove(name, 'x1'), /unknown collection/, name);
  }
  assert.equal(Object.getOwnPropertyNames(Object.prototype).join(), protoKeys);
  kept(db.get('notes', 'n1'), 'n1');
});

test('a repaired event keeps its canonical key order, so the server echoing it back is not a change', () => {
  const e = db.insert('events', { title: 'Call', start: '2026-11-22T10:00' }); // no end: repaired to 11:00
  assert.equal(e.end, '2026-11-22T11:00');
  const keys = Object.keys(e);
  assert.equal(keys.indexOf('end'), keys.indexOf('start') + 1, `end right after start: ${keys}`);
  // The server stores what it was sent and sends it back (as JSON) in its next state.
  assert.deepEqual(replaceAll({ data: { events: clone(db.all('events')) } }), []);
  assert.deepEqual(applyRemoteOps([{ op: 'put', c: 'events', item: clone(e) }]), []);
});
