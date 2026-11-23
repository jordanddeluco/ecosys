// shared/store.js in Node with a fake localStorage: validation on load/import, op capture for sync,
// remote ops, full replace, deferred saves, cross-tab events. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- fake browser
class MemoryStorage {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
    this.failWrites = false;
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
    if (this.failWrites) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
const P = 'ecosys:v1:';
const evil = '"><img src=x onerror=alert(1)>';
// Data written by "another page on this origin" before the app loads.
const ls = new MemoryStorage({
  [P + 'tasks']: JSON.stringify([
    { id: 'good1', title: 'Fine', date: '2026-11-22', someday: true, evening: true },
    { id: evil, title: 'bad id' },
    { id: 'bad2', title: 'Bad fields', date: '1', priority: 7, time: evil, done: evil },
    'junk',
  ]),
  [P + 'settings']: JSON.stringify({ scheduleDays: 5e9, scheduleView: 'days', hiddenTaskLists: 5, taskSort: { today: 'bogus' }, theme: 'dark' }),
  [P + 'events']: '{not json',
});
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
const storageEvent = (key, newValue) => window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea: ls }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const events = [];
window.addEventListener('ecosys:data-replaced', (e) => events.push(e.detail.reason));

const store = await import('../shared/store.js');
const { db, settings, setSyncAdapter, applyRemoteOps, replaceAll, importData, exportData, resetData, seedIfEmpty, registerSeeder, storageAvailable, snapshot, uid, DEFAULT_SETTINGS } = store;

const pushed = [];
const adapter = { push: (ops) => pushed.push(...JSON.parse(JSON.stringify(ops))), pending: () => [] };
const take = () => pushed.splice(0);

// ---------------------------------------------------------------- tests

test('records from localStorage are validated on load', () => {
  assert.equal(storageAvailable(), true);
  const tasks = db.all('tasks');
  assert.deepEqual(tasks.map((t) => t.id), ['good1', 'bad2']);
  assert.ok(!('someday' in tasks[0]) && !('evening' in tasks[0]));
  assert.equal(tasks[1].date, null);
  assert.equal(tasks[1].priority, 0);
  assert.equal(tasks[1].time, null);
  assert.equal(tasks[1].done, false);
  assert.deepEqual(db.all('events'), []);
  const s = settings.get();
  assert.equal(s.scheduleDays, DEFAULT_SETTINGS.scheduleDays);
  assert.equal(s.scheduleView, 'days');
  assert.deepEqual(s.hiddenTaskLists, []);
  assert.deepEqual(s.taskSort, {});
  assert.equal(s.theme, 'dark');
});

test('uid() makes 16 hex chars', () => {
  assert.match(uid(), /^[0-9a-f]{16}$/);
  assert.notEqual(uid(), uid());
});

test('first-run seeding is not recorded as sync ops', () => {
  setSyncAdapter(adapter);
  registerSeeder((d) => d.insert('lists', { name: 'Seeded', color: 'teal', order: 9 }));
  seedIfEmpty(true);
  assert.ok(db.all('lists').some((l) => l.name === 'Seeded'));
  assert.ok(db.all('calendars').length >= 2, 'default calendars exist');
  assert.equal(take().length, 0);
});

test('every write is recorded as an op', () => {
  setSyncAdapter(adapter);
  const t = db.insert('tasks', { title: 'Write tests', priority: 2 });
  assert.deepEqual(take(), [{ op: 'put', c: 'tasks', item: t }]);
  const u = db.update('tasks', t.id, { title: 'Write more tests' });
  assert.equal(u.title, 'Write more tests');
  assert.deepEqual(take(), [{ op: 'put', c: 'tasks', item: u }]);
  db.put('tasks', { ...u, title: 'Put' });
  assert.equal(take()[0].item.title, 'Put');
  db.remove('tasks', t.id);
  assert.deepEqual(take(), [{ op: 'del', c: 'tasks', id: t.id }]);
  settings.set({ theme: 'light' });
  assert.deepEqual(take(), [{ op: 'settings', patch: { theme: 'light' } }]);
  assert.equal(JSON.parse(ls.getItem(P + 'settings')).theme, 'light');
});

test('a batch pushes its ops once', () => {
  setSyncAdapter(adapter);
  let a;
  let b;
  db.batch(() => {
    a = db.insert('tasks', { title: 'A' });
    b = db.insert('tasks', { title: 'B' });
    db.update('tasks', a.id, { done: true });
  });
  const ops = take();
  assert.equal(ops.length, 3);
  assert.equal(ops[2].item.done, true);
  db.batch(() => [a, b].forEach((x) => db.remove('tasks', x.id)));
  assert.equal(take().length, 2);
});

test('app writes are sanitized; invalid records are kept locally but not synced', () => {
  setSyncAdapter(adapter);
  const t = db.insert('tasks', { title: 'X', someday: true, priority: '2', duration: 'lots', tags: 'nope' });
  assert.ok(!('someday' in t));
  assert.equal(t.priority, 2);
  assert.equal(t.duration, null);
  assert.deepEqual(t.tags, []);
  take();
  const bad = db.put('tasks', { id: 'has space', title: 'bad' });
  assert.equal(bad.id, 'has space');
  assert.equal(take().length, 0);
  db.remove('tasks', 'has space');
  db.remove('tasks', t.id);
  take();
});

test('settings.set ignores invalid values and unknown keys, accepts app-prefixed keys', () => {
  setSyncAdapter(adapter);
  const warn = console.warn;
  console.warn = () => {};
  settings.set({ scheduleDays: 99, evil: '<x>', notesView: 'grid', defaultEventMinutes: '45' });
  console.warn = warn;
  const s = settings.get();
  assert.equal(s.scheduleDays, DEFAULT_SETTINGS.scheduleDays);
  assert.equal(s.evil, undefined);
  assert.equal(s.notesView, 'grid');
  assert.equal(s.defaultEventMinutes, 45);
  assert.deepEqual(take(), [{ op: 'settings', patch: { notesView: 'grid', defaultEventMinutes: 45 } }]);
});

test('deferred updates save once, on flush', async () => {
  setSyncAdapter(adapter);
  const t = db.insert('tasks', { title: 'Typing' });
  take();
  let notified = 0;
  const off = db.on(() => notified++);
  db.update('tasks', t.id, { notes: 'h' }, { defer: true });
  db.update('tasks', t.id, { notes: 'he' }, { defer: true });
  db.update('tasks', t.id, { notes: 'hel' }, { defer: true });
  assert.equal(db.get('tasks', t.id).notes, 'hel', 'cache updates immediately');
  assert.equal(take().length, 0, 'not pushed yet');
  assert.ok(!ls.getItem(P + 'tasks').includes('"hel"'), 'not saved yet');
  db.flush();
  const ops = take();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].item.notes, 'hel');
  assert.ok(ls.getItem(P + 'tasks').includes('"hel"'));
  await tick();
  assert.equal(notified, 1);
  // a normal write flushes pending deferred edits first
  db.update('tasks', t.id, { notes: 'hello' }, { defer: true });
  db.insert('tasks', { title: 'Other' });
  assert.equal(take().length, 2);
  off();
});

test('applyRemoteOps validates, saves, emits remote and never re-pushes', async () => {
  setSyncAdapter(adapter);
  take();
  let evt = null;
  const off = db.on((e) => (evt = e));
  const names = applyRemoteOps([
    { op: 'put', c: 'tasks', item: { id: 'remote1', title: 'From AI', priority: 3 } },
    { op: 'put', c: 'tasks', item: { id: evil, title: 'nope' } },
    { op: 'del', c: 'tasks', id: 'does-not-exist' },
    { op: 'settings', patch: { theme: 'dim', evil: 1 } },
    { op: 'eval', code: 'x' },
  ]);
  assert.deepEqual(names.sort(), ['settings', 'tasks']);
  assert.equal(db.get('tasks', 'remote1').title, 'From AI');
  assert.equal(db.get('tasks', evil), null);
  assert.equal(settings.get().theme, 'dim');
  assert.equal(settings.get().evil, undefined);
  assert.equal(take().length, 0);
  assert.ok(ls.getItem(P + 'tasks').includes('remote1'));
  await tick();
  assert.equal(evt.remote, true);
  assert.ok(evt.names.has('tasks'));
  // applying the same op again changes nothing
  assert.deepEqual(applyRemoteOps([{ op: 'put', c: 'tasks', item: db.get('tasks', 'remote1') }]), []);
  off();
});

test('a remote op applied before the storage event from another tab keeps the write of that tab and announces it', async () => {
  setSyncAdapter(adapter);
  const current = JSON.parse(ls.getItem(P + 'tasks'));
  // Tab B saved a task; its storage event has not reached this tab yet.
  ls.setItem(P + 'tasks', JSON.stringify([...current, { id: 'tabB01', title: 'Saved by tab B' }]));
  let evt = null;
  const off = db.on((e) => (evt = e));
  applyRemoteOps([{ op: 'put', c: 'events', item: { id: 'ev01', start: '2026-12-01', end: '2026-12-01', allDay: true } }, { op: 'put', c: 'tasks', item: { id: 'srv01', title: 'From server' } }]);
  assert.ok(db.get('tasks', 'tabB01'), 'tab B write kept');
  assert.ok(db.get('tasks', 'srv01'));
  assert.ok(JSON.parse(ls.getItem(P + 'tasks')).some((t) => t.id === 'tabB01'), 'not clobbered in storage');
  await tick();
  assert.ok(evt.names.has('tasks') && evt.names.has('events'));
  off();
  for (const id of ['tabB01', 'srv01']) db.remove('tasks', id);
  db.remove('events', 'ev01');
  take();
});

test('remote changes do not overwrite local edits the server has not confirmed yet', () => {
  const mine = db.insert('tasks', { title: 'Mine' });
  const edited = db.update('tasks', mine.id, { title: 'Mine, edited' });
  setSyncAdapter({ push: () => {}, pending: () => [{ op: 'put', c: 'tasks', item: edited }] });
  applyRemoteOps([{ op: 'put', c: 'tasks', item: { ...edited, title: 'Theirs' } }]);
  assert.equal(db.get('tasks', mine.id).title, 'Mine, edited');
  setSyncAdapter(adapter);
});

test('replaceAll swaps in a server snapshot; only non-routine reasons fire ecosys:data-replaced', () => {
  setSyncAdapter(adapter);
  take();
  events.length = 0;
  const changed = replaceAll({
    rev: 7,
    initialized: true,
    data: { tasks: [{ id: 's1', title: 'Server task' }, { id: evil }], lists: [], events: [], calendars: [{ id: 'c1', name: 'Cal' }], notes: [{ id: 'n1', body: '<p onclick=x>hi</p>' }], folders: [] },
    settings: { theme: 'light' },
  });
  assert.ok(changed.includes('tasks') && changed.includes('notes'));
  assert.deepEqual(db.all('tasks').map((t) => t.id), ['s1']);
  assert.equal(db.get('notes', 'n1').body, '<p>hi</p>');
  assert.equal(settings.get().theme, 'light');
  assert.equal(settings.get().scheduleView, DEFAULT_SETTINGS.scheduleView, 'settings reset to defaults + server');
  assert.deepEqual(events, [], 'a routine resync keeps undo history');
  assert.equal(take().length, 0);
  assert.deepEqual(replaceAll(snapshot()), [], 'same state: nothing changes');
  replaceAll({ data: { tasks: [{ id: 's2', title: 'Restored' }] } }, { reason: 'restore' });
  assert.deepEqual(events, ['restore']);
  assert.deepEqual(db.all('tasks').map((t) => t.id), ['s2']);
});

test('importData validates and sanitizes every record and reports what was dropped', () => {
  setSyncAdapter(adapter);
  take();
  events.length = 0;
  const backup = JSON.parse(
    JSON.stringify({
      app: 'ecosys',
      version: 1,
      tasks: [
        { id: 't1', title: 'Ok', listId: 'l1', priority: 3, date: '2026-12-01' },
        { id: 't2', title: 'xss', priority: '1" onmouseover="x', time: '"><svg onload=alert(1)>', duration: '45"><b>' },
        { id: '"><script>', title: 'bad id' },
        null,
      ],
      lists: [{ id: 'l1', name: 'List', color: 'red;background:url(x)' }],
      events: [{ id: 'e1', title: 'E', start: 5, end: 6 }],
      notes: [{ id: 'n2', title: 'Note', body: '<img src=x onerror=alert(1)><b>bold</b><script>steal()</script>' }],
      settings: { scheduleDays: 3e9, theme: 'dim', hiddenTaskLists: 5 },
    }),
  );
  backup.tasks[0] = JSON.parse(JSON.stringify(backup.tasks[0]).replace('{', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},'));
  assert.ok(Object.hasOwn(backup.tasks[0], '__proto__'));
  const res = importData(backup);
  assert.equal(res.counts.tasks, 2);
  assert.equal(res.dropped, 3); // bad id, null, event with numeric start/end
  const t2 = db.get('tasks', 't2');
  assert.equal(t2.priority, 0);
  assert.equal(t2.time, null);
  assert.equal(t2.duration, null);
  assert.equal(db.get('lists', 'l1').color, 'iris');
  assert.equal(db.get('notes', 'n2').body, '<b>bold</b>');
  assert.equal(settings.get().scheduleDays, DEFAULT_SETTINGS.scheduleDays);
  assert.equal(settings.get().theme, 'dim');
  assert.equal({}.polluted, undefined);
  assert.ok(db.all('calendars').length >= 1, 'default calendars are created when the backup has none');
  assert.deepEqual(events, ['import']);
  const ops = take();
  const replaced = ops.filter((o) => o.op === 'replace').map((o) => o.c).sort();
  assert.deepEqual(replaced, ['events', 'lists', 'notes', 'tasks']);
  assert.ok(ops.some((o) => o.op === 'settings'));
  assert.throws(() => importData({ tasks: [] }), /not an ecosys backup/);
  assert.throws(() => importData({ app: 'ecosys' }), /no tasks/);
});

test('exportData round-trips through importData', () => {
  const before = exportData();
  assert.equal(before.app, 'ecosys');
  assert.ok(Array.isArray(before.notes) && Array.isArray(before.folders));
  importData(JSON.parse(JSON.stringify(before)));
  const after = exportData();
  for (const c of ['tasks', 'lists', 'events', 'calendars', 'notes', 'folders']) assert.deepEqual(after[c], before[c], c);
});

test('resetData pushes one replace per collection with the final contents', () => {
  setSyncAdapter(adapter);
  take();
  events.length = 0;
  registerSeeder((d) => d.insert('tasks', { title: 'Sample' }));
  resetData({ withSamples: true });
  const ops = take();
  const tasksOp = ops.find((o) => o.op === 'replace' && o.c === 'tasks');
  assert.deepEqual(tasksOp.items.map((t) => t.title), ['Sample']);
  assert.equal(ops.filter((o) => o.op === 'put').length, 0, 'inserts are folded into the replace');
  assert.equal(ops.find((o) => o.c === 'calendars').items.length, 2);
  resetData();
  assert.deepEqual(events, ['samples', 'erase']);
  assert.equal(take().find((o) => o.c === 'tasks').items.length, 0);
});

test('resetData also deletes the notes version history (IndexedDB "ecosys"), from any app; importing a backup keeps it', () => {
  const deleted = [];
  globalThis.indexedDB = { deleteDatabase: (name) => (deleted.push(name), {}) };
  try {
    db.insert('tasks', { title: 'Erase me' });
    resetData();
    assert.deepEqual(deleted, ['ecosys']);
    assert.equal(db.all('tasks').length, 0);
    resetData({ withSamples: true }); // the old notes are gone here too
    assert.deepEqual(deleted, ['ecosys', 'ecosys']);
    importData(JSON.parse(JSON.stringify(exportData())));
    assert.equal(deleted.length, 2, 'restoring a backup keeps the history of the notes it restores');
  } finally {
    delete globalThis.indexedDB;
  }
  // No IndexedDB (Node, some private modes) or a blocked one (a sandboxed frame throws on access): erasing still works.
  db.insert('tasks', { title: 'Erase me too' });
  assert.doesNotThrow(() => resetData());
  assert.equal(db.all('tasks').length, 0);
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' });
    },
  });
  try {
    db.insert('tasks', { title: 'And me' });
    events.length = 0;
    assert.doesNotThrow(() => resetData());
    assert.equal(db.all('tasks').length, 0);
    assert.deepEqual(events, ['erase']);
  } finally {
    delete globalThis.indexedDB;
  }
});

test('another tab writing: reloaded and validated; clearing storage is undone', async () => {
  setSyncAdapter(null);
  db.insert('tasks', { title: 'Keep me' });
  let evt = null;
  const off = db.on((e) => (evt = e));
  const raw = JSON.stringify([{ id: 'tab2', title: 'From tab 2' }, { id: evil }]);
  ls.setItem(P + 'tasks', raw);
  storageEvent(P + 'tasks', raw);
  assert.deepEqual(db.all('tasks').map((t) => t.id), ['tab2']);
  await tick();
  assert.equal(evt.remote, true);
  // localStorage.clear() from another page on the origin
  ls.clear();
  storageEvent(null, null);
  assert.ok(ls.getItem(P + 'tasks').includes('tab2'), 'data written back');
  assert.deepEqual(db.all('tasks').map((t) => t.id), ['tab2']);
  off();
});

test('a failed save keeps the new state in memory and reports once', () => {
  let errors = 0;
  const onErr = () => errors++;
  window.addEventListener('ecosys:save-error', onErr);
  const warn = console.warn;
  console.warn = () => {};
  ls.failWrites = true;
  const t = db.insert('tasks', { title: 'Too big' });
  db.update('tasks', t.id, { title: 'Still too big' });
  ls.failWrites = false;
  console.warn = warn;
  assert.equal(db.get('tasks', t.id).title, 'Still too big');
  assert.equal(errors, 1);
  window.removeEventListener('ecosys:save-error', onErr);
});
