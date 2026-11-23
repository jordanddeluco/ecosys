// QA fix (model, flows-notes finding): completing a task that a notes checklist item is linked to, in
// Tasks, on Home or in Schedule (shared/model.js toggleTask, with Notes closed), checked the item but
// left it between the open items, although Sort checked items is Automatically. The mirror now moves
// it as Notes does (the spec's rule, the editor's autoSort: a checked item and its subtree go to the end
// of its run of items at its level; unchecked, it goes back above its first checked sibling), and the
// undo puts a note nobody touched since back exactly as it was. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });

const { db, settings, setSyncAdapter } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const S = await import('../notes/core/schema.js');
const C = await import('../notes/editor/commands.js');

const pushed = [];
setSyncAdapter({ push: (ops) => pushed.push(...JSON.parse(JSON.stringify(ops))), pending: () => [] });
const take = () => pushed.splice(0);
const opKeys = (ops) => ops.map((o) => `${o.op} ${o.c}:${o.item?.id ?? o.id}`).sort();

const item = (id, text, extra = {}) => ({ id, t: 'check', in: 0, c: [[text]], ...extra });
const task = (title) => M.createTask({ title });
const note = (blocks) => db.insert('notes', { ...S.newNote({ blocks }) });
/** The note's checklist as [text, checked, indent] in order. */
const list = (id) => db.get('notes', id).blocks.filter((b) => b.t === 'check').map((b) => [S.blockText(b), !!b.ck, b.in || 0]);

// ---------------------------------------------------------------- the same rule as the editor

/** A small seeded generator, so a failure names a doc that can be replayed. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('autoSortChecks moves an item exactly as the Notes editor does (the spec rule), for any checklist', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const doc = [{ id: 'h', t: 'h1', c: [['Title']] }];
    const runs = 1 + Math.floor(r() * 2);
    let n = 0;
    for (let k = 0; k < runs; k++) {
      let lvl = 0;
      const len = 1 + Math.floor(r() * 7);
      for (let j = 0; j < len; j++) {
        lvl = Math.max(0, Math.min(lvl + (r() < 0.3 ? 1 : r() < 0.3 ? -1 : 0), 3));
        doc.push(item(`i${n}`, `Item ${n++}`, { in: lvl, ck: r() < 0.4 }));
      }
      doc.push({ id: `p${k}`, t: 'p', c: [['Between']] });
    }
    const checksAt = doc.filter((b) => b.t === 'check');
    const pick = checksAt[Math.floor(r() * checksAt.length)];
    for (const ck of [true, false]) {
      const changed = doc.map((b) => (b.id === pick.id ? { ...b, ck } : b));
      const editor = C.autoSort(changed, pick.id) ?? changed;
      assert.deepEqual(M.autoSortChecks(changed, [pick.id]), editor, `seed ${seed}: ${pick.id} ${ck ? 'checked' : 'unchecked'}`);
    }
  }
});

test('autoSortChecks: several items in document order, and the caret item (or its parent) stays still', () => {
  const doc = [item('a', 'A', { ck: true }), item('b', 'B'), item('c', 'C', { ck: true }), item('d', 'D')];
  const editor = C.autoSort(C.autoSort(doc, 'a'), 'c');
  assert.deepEqual(M.autoSortChecks(doc, ['c', 'a']), editor, 'taken in the order they are in, as the editor takes them');
  assert.deepEqual(M.autoSortChecks(doc, ['c', 'a']).map((b) => b.id), ['b', 'd', 'a', 'c']);
  // keep: the caret is in A, or in a child of A: A doesn't move under it.
  assert.equal(M.autoSortChecks(doc, ['a'], { keep: 'a' }), doc, 'nothing moves: the same array back');
  const nested = [item('a', 'A', { ck: true }), item('a1', 'A child', { in: 1 }), item('b', 'B')];
  assert.equal(M.autoSortChecks(nested, ['a'], { keep: 'a1' }), nested, 'an item the caret is indented under stays too');
  assert.deepEqual(M.autoSortChecks(nested, ['a'], { keep: 'b' }).map((b) => b.id), ['b', 'a', 'a1'], 'the caret elsewhere: it moves, with its subtree');
  // Not an item, or no such block: nothing to do.
  assert.equal(M.autoSortChecks(doc, ['zz']), doc);
  assert.equal(M.autoSortChecks(doc, []), doc);
});

// ---------------------------------------------------------------- completing the task in Tasks (Notes closed)

test('completing a linked task outside Notes moves its item below the open ones, and Undo puts it back in its place', () => {
  const milk = task('Buy milk');
  const n = note([{ id: 'h', t: 'h1', c: [['Groceries']] }, item('m', 'Buy milk', { task: milk.id }), item('e', 'Eggs'), item('b', 'Bread', { ck: true }), { id: 'p', t: 'p', c: [['#home']] }]);
  const before = structuredClone(db.get('notes', n.id));
  take();
  const undo = M.toggleTask(milk.id);
  assert.equal(db.get('tasks', milk.id).done, true);
  assert.deepEqual(list(n.id), [['Eggs', false, 0], ['Bread', true, 0], ['Buy milk', true, 0]], 'checked and at the end of its checklist, as checking it in Notes does');
  const done = db.get('notes', n.id);
  assert.deepEqual(done.blocks.at(-1), before.blocks.at(-1), 'the rest of the note stays where it was');
  assert.equal(done.rev, before.rev + 1, 'one saved change');
  assert.deepEqual([done.editedAt, done.editedBy], [before.editedAt, before.editedBy], 'a system change, not counted as your edit');
  assert.deepEqual(S.validateBlocks(structuredClone(done.blocks)), done.blocks, 'still canonical');
  assert.deepEqual(opKeys(take()), [`put notes:${n.id}`, `put tasks:${milk.id}`], 'one push with both');

  undo();
  assert.equal(db.get('tasks', milk.id).done, false, 'the task is open again');
  assert.deepEqual(db.get('notes', n.id).blocks, before.blocks, 'the item is unchecked and back in its place');
  assert.ok(db.get('notes', n.id).rev > done.rev, 'rev only moves on');
  db.batch(() => {
    db.remove('notes', n.id);
    db.remove('tasks', milk.id);
  });
});

test('reopening the task moves the item back above the first checked one; its Undo checks it at the end again', () => {
  const call = task('Call the bank');
  const n = note([item('x', 'Pay rent', { ck: true }), item('c', 'Call the bank', { task: call.id, ck: true }), item('y', 'Water plants')]);
  db.update('tasks', call.id, { done: true, completedAt: Date.now() });
  db.update('notes', n.id, { blocks: [item('y', 'Water plants'), item('x', 'Pay rent', { ck: true }), item('c', 'Call the bank', { task: call.id, ck: true })] });
  const checked = structuredClone(db.get('notes', n.id).blocks);
  const reopen = M.toggleTask(call.id);
  assert.deepEqual(list(n.id), [['Water plants', false, 0], ['Call the bank', false, 0], ['Pay rent', true, 0]]);
  reopen();
  assert.deepEqual(db.get('notes', n.id).blocks, checked, 'as it was before the reopen');
  db.batch(() => {
    db.remove('notes', n.id);
    db.remove('tasks', call.id);
  });
});

test('the item moves with the items indented under it, and a nested item stays under its parent', () => {
  const pack = task('Pack');
  const flights = task('Book flights');
  const n = note([
    item('t', 'Trip'),
    item('f', 'Book flights', { in: 1, task: flights.id }),
    item('o', 'Book hotel', { in: 1 }),
    item('p', 'Pack', { task: pack.id }),
    item('p1', 'Passport', { in: 1 }),
    item('p2', 'Charger', { in: 1 }),
    item('w', 'Water plants'),
  ]);
  M.toggleTask(flights.id);
  assert.deepEqual(list(n.id).map(([t, c, i]) => `${'  '.repeat(i)}${c ? '[x]' : '[ ]'} ${t}`), ['[ ] Trip', '  [ ] Book hotel', '  [x] Book flights', '[ ] Pack', '  [ ] Passport', '  [ ] Charger', '[ ] Water plants'], 'within its parent');
  M.toggleTask(pack.id);
  assert.deepEqual(list(n.id).map(([t, c, i]) => `${'  '.repeat(i)}${c ? '[x]' : '[ ]'} ${t}`), ['[ ] Trip', '  [ ] Book hotel', '  [x] Book flights', '[ ] Water plants', '[x] Pack', '  [ ] Passport', '  [ ] Charger'], 'with its subtree');
  db.batch(() => {
    db.remove('notes', n.id);
    db.remove('tasks', pack.id);
    db.remove('tasks', flights.id);
  });
});

test('every note linking the task follows; with Sort checked items set to Manually the item stays in place', () => {
  const plumber = task('Call the plumber');
  const a = note([item('a1', 'Call the plumber', { task: plumber.id }), item('a2', 'Fix the tap')]);
  const b = note([item('b1', 'Buy a plunger'), item('b2', 'Call the plumber', { task: plumber.id }), item('b3', 'Mop the floor')]);
  M.toggleTask(plumber.id);
  assert.deepEqual(list(a.id).map((x) => x[0]), ['Fix the tap', 'Call the plumber']);
  assert.deepEqual(list(b.id).map((x) => x[0]), ['Buy a plunger', 'Mop the floor', 'Call the plumber']);
  M.toggleTask(plumber.id); // reopened: no checked sibling to go above, so it stays at the end, unchecked
  assert.deepEqual(list(b.id), [['Buy a plunger', false, 0], ['Mop the floor', false, 0], ['Call the plumber', false, 0]]);

  settings.set({ notesCheckedSort: 'manual' });
  try {
    const order = list(a.id).map((x) => x[0]);
    M.toggleTask(plumber.id);
    assert.deepEqual(list(a.id), order.map((t) => [t, t === 'Call the plumber', 0]), 'checked where it is');
  } finally {
    settings.set({ notesCheckedSort: 'auto' });
  }
  db.batch(() => {
    db.remove('notes', a.id);
    db.remove('notes', b.id);
    db.remove('tasks', plumber.id);
  });
});

test('Undo after the note was edited keeps the edit: the item is unchecked and moves as Notes moves it', () => {
  const milk = task('Buy milk');
  const n = note([item('m', 'Buy milk', { task: milk.id }), item('e', 'Eggs'), item('b', 'Bread', { ck: true })]);
  const undo = M.toggleTask(milk.id);
  // Edited since (in Notes, another tab, an assistant): a new item at the top.
  const cur = db.get('notes', n.id);
  db.update('notes', n.id, { blocks: [item('j', 'Jam'), ...cur.blocks], rev: cur.rev + 1 });
  undo();
  assert.equal(db.get('tasks', milk.id).done, false);
  assert.deepEqual(list(n.id), [['Jam', false, 0], ['Eggs', false, 0], ['Buy milk', false, 0], ['Bread', true, 0]], 'the edit stays; the item, unchecked, goes above the checked one');
  db.batch(() => {
    db.remove('notes', n.id);
    db.remove('tasks', milk.id);
  });
});

test('a repeating task stays open, so its item is neither checked nor moved, and the note is not written', () => {
  const fern = M.createTask({ title: 'Water the fern', date: '2026-01-05', repeat: { freq: 'day', interval: 1 } });
  const n = note([item('f', 'Water the fern', { task: fern.id }), item('o', 'Other')]);
  const before = structuredClone(db.get('notes', n.id));
  take();
  const undo = M.toggleTask(fern.id);
  assert.deepEqual(db.get('notes', n.id), before);
  const logged = db.all('tasks').find((x) => x.repeatOf === fern.id);
  assert.ok(logged, 'the completed copy is logged');
  undo();
  assert.equal(db.get('tasks', logged.id), null, 'Undo removes the logged copy');
  assert.deepEqual(db.get('notes', n.id), before);
  db.batch(() => {
    db.remove('notes', n.id);
    db.remove('tasks', fern.id);
  });
});
