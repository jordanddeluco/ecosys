// QA (model): undoing the creation of a list, a calendar or a folder never strands what was put in it
// since. shared/model.js revertChange and trackChanges: a list a quick add made ("#Groceries Milk")
// goes with the task, unless another task has joined it meanwhile; the same for a calendar (its events)
// and a folder (notes not in Recently Deleted, and folders inside it), whatever order the collections
// are tracked in. A redo (the shell runs an undo under trackChanges and keeps what takes it back) still
// takes it all back, folders inside folders too. trackChanges' undo says how many records the run
// changed (.count), so the shell can tell an undo that found nothing left to take back.
// Pure Node: a fake localStorage. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db, setSyncAdapter } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const N = await import('../notes/core/notes.js');
const { COLLECTIONS } = await import('../shared/sanitize.js');
const { todayYmd, addDaysYmd } = await import('../shared/dates.js');

const pushed = [];
setSyncAdapter({ push: (ops) => pushed.push(...JSON.parse(JSON.stringify(ops))), pending: () => [] });
const take = () => pushed.splice(0);

/** mod Z, as the shell runs it: the undo under trackChanges over every collection; what that returns is the redo. */
const runUndo = (undo) => M.trackChanges(undo, COLLECTIONS);
const listNamed = (name) => db.all('lists').find((l) => l.name === name) || null;
/** A note with some text (an empty one is discarded rather than moved to Recently Deleted). */
const textNote = (folderId, text) => N.createNote({ folderId, blocks: [{ t: 'h1', c: [[text]] }, { t: 'p', c: [['Some words']] }] });

const today = todayYmd();
const tomorrow = addDaysYmd(today, 1);

test('a quick add that made a list: Undo removes the task and keeps the list another task has joined since', () => {
  // Schedule's "Add a task": "#Groceries QA Milk" makes the list.
  const undo = M.trackChanges(() => M.createTask({ title: 'Milk', newList: 'Groceries QA' }), ['tasks', 'lists']);
  const milk = undo.result;
  const list = listNamed('Groceries QA');
  assert.equal(milk.listId, list?.id, 'the list is made, with Milk in it');
  // Tasks: "#Groceries QA Eggs" joins it.
  const eggs = M.createTask({ title: 'Eggs', newList: 'Groceries QA' });
  assert.equal(eggs.listId, list.id);
  take();
  const redo = runUndo(undo);
  assert.equal(db.get('tasks', milk.id), null, 'Milk goes');
  assert.deepEqual(db.get('lists', list.id), list, 'the list Eggs is in stays, untouched');
  assert.equal(M.liveListId(db.get('tasks', eggs.id)), list.id, 'Eggs is still in it, not in the Inbox');
  assert.deepEqual(take().map((o) => [o.op, o.c, o.id]), [['del', 'tasks', milk.id]], 'one write: Milk');
  assert.equal(redo.count, 1, 'the undo changed one record');
  redo();
  assert.equal(db.get('tasks', milk.id)?.listId, list.id, 'Redo: Milk is back in the list');
  db.remove('tasks', milk.id);
  db.remove('tasks', eggs.id);
  db.remove('lists', list.id);
});

test('...with nothing else in it, the list goes with the task, in whatever order the collections are tracked', () => {
  for (const names of [['tasks', 'lists'], ['lists', 'tasks']]) {
    const name = `Groceries QA ${names[0]}`;
    const undo = M.trackChanges(() => M.createTask({ title: 'Milk', newList: name }), names);
    const list = listNamed(name);
    const redo = runUndo(undo); // mod Z
    assert.equal(db.get('tasks', undo.result.id), null, `${names}: the task goes`);
    assert.equal(db.get('lists', list.id), null, `${names}: and so does the list it made`);
    assert.equal(redo.count, 2);
    const undoAgain = runUndo(redo); // shift mod Z
    assert.deepEqual(db.get('lists', list.id), list, `${names}: Redo brings the list back`);
    assert.equal(db.get('tasks', undo.result.id)?.listId, list.id, `${names}: with the task in it`);
    runUndo(undoAgain); // mod Z again: both go again
    assert.equal(db.get('lists', list.id), null);
    assert.equal(db.get('tasks', undo.result.id), null);
  }
});

test('a list made in the same go as a task that has since moved to another list goes; a completed task still holds it', () => {
  const work = M.createList({ name: 'QA Work' });
  const undo = M.trackChanges(() => M.createTask({ title: 'Report', newList: 'QA Reports' }), ['tasks', 'lists']);
  const reports = listNamed('QA Reports');
  const later = M.createTask({ title: 'Slides', listId: reports.id });
  db.update('tasks', later.id, { listId: work.id }); // moved out again since
  const undoDone = M.trackChanges(() => M.createTask({ title: 'Invoice', newList: 'QA Invoices' }), ['tasks', 'lists']);
  const invoices = listNamed('QA Invoices');
  const paid = M.createTask({ title: 'Paid', listId: invoices.id });
  M.toggleTask(paid.id); // done, but still in the list (its Completed section)
  undo();
  undoDone();
  assert.equal(db.get('lists', reports.id), null, 'nothing is in Reports any more: it goes');
  assert.ok(db.get('lists', invoices.id), 'a completed task is still in Invoices: it stays');
  for (const t of [later, paid]) db.remove('tasks', t.id);
  for (const l of [work, invoices]) db.remove('lists', l.id);
});

test('revertChange on its own: a list, calendar or folder still in use is left, and returned', () => {
  const list = M.createList({ name: 'QA Holder' });
  const t = M.createTask({ title: 'In it', listId: list.id });
  take();
  assert.deepEqual(M.revertChange('lists', null, list), list, 'kept while a task is in it, and returned');
  assert.deepEqual(take(), [], 'nothing written');
  db.remove('tasks', t.id);
  assert.equal(M.revertChange('lists', null, list), null, 'once empty it goes');
  assert.equal(db.get('lists', list.id), null);
  // Tasks, events and notes hold nothing: undoing their creation removes them as before.
  const plain = M.createTask({ title: 'Plain' });
  assert.equal(M.revertChange('tasks', null, plain), null);
  assert.equal(db.get('tasks', plain.id), null);
});

test('a calendar made with its first event: Undo removes the calendar only once no event is left in it', () => {
  const make = (name) =>
    M.trackChanges(() => {
      const cal = db.insert('calendars', { name, color: 'teal', visible: true, order: 9 });
      return M.createEvent({ title: 'Flight', calendarId: cal.id, date: tomorrow, time: '09:00' });
    }, ['calendars', 'events']); // the calendar is tracked first: its event still goes first
  const undo = make('QA Trips');
  const calId = undo.result.calendarId;
  const hotel = M.createEvent({ title: 'Hotel', calendarId: calId, date: tomorrow }); // added to it since
  undo();
  assert.equal(db.get('events', undo.result.id), null, 'the flight goes');
  assert.ok(db.get('calendars', calId), 'the calendar stays: the hotel is in it');
  assert.equal(db.get('events', hotel.id)?.calendarId, calId);
  db.remove('events', hotel.id);
  db.remove('calendars', calId);

  const undo2 = make('QA Trips 2');
  const cal2 = undo2.result.calendarId;
  undo2();
  assert.equal(db.get('events', undo2.result.id), null);
  assert.equal(db.get('calendars', cal2), null, 'nothing else in it: it goes too');
});

test('a folder: kept while a note is in it; a note in Recently Deleted does not hold it, and restores to Notes', () => {
  const undo = M.trackChanges(() => N.createFolder({ name: 'QA Ideas' }), ['notes', 'folders']);
  const folder = undo.result;
  const note = textNote(folder.id, 'QA idea');
  undo();
  assert.ok(db.get('folders', folder.id), 'a note was put in it since: it stays');

  const undo2 = M.trackChanges(() => N.createFolder({ name: 'QA Drafts' }), ['notes', 'folders']);
  const drafts = undo2.result;
  N.moveNote(note.id, drafts.id);
  N.trashNote(note.id);
  undo2();
  assert.equal(db.get('folders', drafts.id), null, 'its only note is in Recently Deleted: the folder goes');
  N.restoreNote(note.id);
  assert.equal(db.get('notes', note.id).folderId, null, 'restored, the note goes to Notes');
  db.remove('notes', note.id);
  db.remove('folders', folder.id);
});

test('Delete folder, Undo, Redo: the folder and the one inside it go again; their notes go back to Recently Deleted', () => {
  const top = N.createFolder({ name: 'QA Work' });
  const sub = N.createFolder({ name: 'QA Clients', parentId: top.id });
  const note = textNote(sub.id, 'QA client notes');
  const undoDelete = N.deleteFolder(top.id);
  assert.equal(db.get('folders', top.id), null);
  assert.ok(db.get('notes', note.id).trashedAt, 'its note went to Recently Deleted');

  const redo = runUndo(undoDelete); // mod Z
  assert.ok(db.get('folders', top.id) && db.get('folders', sub.id), 'both folders are back');
  assert.equal(db.get('notes', note.id).trashedAt, null, 'and the note is back in them');

  const again = runUndo(redo); // shift mod Z
  assert.equal(db.get('folders', sub.id), null, 'the folder inside goes again');
  assert.equal(db.get('folders', top.id), null, 'and so does the one it was in');
  assert.ok(db.get('notes', note.id).trashedAt, 'the note is in Recently Deleted again');
  assert.equal(again.count, 3, 'the redo changed the note and the two folders');

  // Folders made inside folders by one action go innermost first, whatever their order in the store.
  for (const outerLast of [false, true]) {
    const undoMade = M.trackChanges(() => {
      const a = N.createFolder({ name: 'QA A' });
      const b = N.createFolder({ name: 'QA B', parentId: a.id });
      const c = N.createFolder({ name: 'QA C', parentId: b.id });
      if (outerLast) db.put('folders', db.remove('folders', a.id)); // the outermost sits last in the store
      return [a, b, c];
    }, ['folders']);
    assert.equal(undoMade.count, 3);
    undoMade();
    assert.deepEqual(undoMade.result.map((f) => db.get('folders', f.id)), [null, null, null], `all three go (outermost last: ${outerLast})`);
  }
  db.remove('notes', note.id);
});

test('trackChanges counts what the run changed: 0 for an undo that found nothing left to take back', () => {
  // "Add to Today", then an assistant deletes the task: mod Z has nothing to do, and the shell can say so.
  const t = M.createTask({ title: 'QA nothing left', date: tomorrow });
  const before = structuredClone(t);
  const after = db.update('tasks', t.id, { date: today });
  db.remove('tasks', t.id);
  take();
  const redo = runUndo(() => M.revertChange('tasks', before, after));
  assert.equal(redo.count, 0, 'nothing changed');
  assert.deepEqual(take(), [], 'nothing written');
  assert.equal(db.get('tasks', t.id), null, 'and the task stays deleted');

  // The same for the model's own undos: a completion, a time block and a tracked change.
  const t2 = M.createTask({ title: 'QA done then deleted', date: today });
  const undoDone = M.toggleTask(t2.id);
  M.deleteTask(t2.id);
  assert.equal(runUndo(undoDone).count, 0);
  const t3 = M.createTask({ title: 'QA moved then deleted', date: today, time: '10:00', duration: 30 });
  const undoMove = M.scheduleTask(t3.id, today, '14:00', 30);
  db.remove('tasks', t3.id);
  assert.equal(runUndo(undoMove).count, 0);
  const e = M.createEvent({ title: 'QA event', date: tomorrow, time: '09:00' });
  const undoEdit = M.trackChanges(() => db.update('events', e.id, { title: 'QA event renamed' }));
  assert.equal(undoEdit.count, 1, 'the edit changed one record');
  db.remove('events', e.id);
  assert.equal(runUndo(undoEdit).count, 0);
  assert.equal(M.trackChanges(() => null).count, 0, 'a run that writes nothing');

  // An undo that does take something back counts it.
  const t4 = M.createTask({ title: 'QA moved', date: today, time: '10:00', duration: 30 });
  const redo4 = runUndo(M.scheduleTask(t4.id, today, '14:00', 30));
  assert.equal(redo4.count, 1);
  assert.equal(db.get('tasks', t4.id).time, '10:00');
  db.remove('tasks', t4.id);
});
