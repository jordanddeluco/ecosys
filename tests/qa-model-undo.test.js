// QA (model): an undo takes back only its own change. shared/model.js revertChange and every undo the
// model hands out (toggleTask, scheduleTask, deleteTask, trackChanges): edits made since, in the
// same app, another app, another tab or by an assistant, stay; a record deleted since stays deleted;
// an undo is one new synced write. Pure Node: a fake localStorage. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db, setSyncAdapter, applyRemoteOps } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const { todayYmd, addDaysYmd } = await import('../shared/dates.js');
const S = await import('../notes/core/schema.js');

const pushed = [];
setSyncAdapter({ push: (ops) => pushed.push(...JSON.parse(JSON.stringify(ops))), pending: () => [] });
const take = () => pushed.splice(0);
/** Let the clock move on, so a later write has a later updatedAt. */
const tick = () => new Promise((r) => setTimeout(r, 3));
/** An edit that arrives from elsewhere (another device, an assistant over MCP), as sync applies it. */
const remoteEdit = (c, id, patch) => applyRemoteOps([{ op: 'put', c, item: { ...db.get(c, id), ...patch, updatedAt: Date.now() } }]);
const ev = (e) => db.insert('events', { title: 'E', calendarId: null, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, ...e });

const today = todayYmd();
const tomorrow = addDaysYmd(today, 1);

test('revertChange restores only the fields the change made, and only where they still hold its value', async () => {
  const t = M.createTask({ title: 'QA undo', date: tomorrow });
  const before = structuredClone(t);
  const after = db.update('tasks', t.id, { date: today }); // "Add to Today"
  await tick();
  db.update('tasks', t.id, { title: 'QA undo renamed', notes: 'written later' }); // edits made since
  await tick();
  take();
  const back = M.revertChange('tasks', before, after);
  assert.equal(back.date, tomorrow, 'the change is taken back');
  assert.deepEqual([back.title, back.notes], ['QA undo renamed', 'written later'], 'edits made since stay');
  assert.deepEqual([back.id, back.createdAt], [t.id, t.createdAt], 'id and createdAt are never touched');
  assert.ok(back.updatedAt > after.updatedAt, 'an undo is a new edit: updatedAt moves on');
  assert.deepEqual(db.get('tasks', t.id), back, 'returns the record as the undo leaves it');
  const ops = take();
  assert.deepEqual(ops.map((o) => [o.op, o.c, o.item?.id]), [['put', 'tasks', t.id]], 'one synced write');
  assert.deepEqual(ops[0].item, back);

  // A field this change made that was changed again since keeps its newer value; the others go back.
  const b2 = structuredClone(db.get('tasks', t.id));
  const a2 = db.update('tasks', t.id, { date: today, priority: 3 });
  db.update('tasks', t.id, { date: addDaysYmd(today, 5) });
  const r2 = M.revertChange('tasks', b2, a2);
  assert.equal(r2.date, addDaysYmd(today, 5), 'moved again since: the newer date stays');
  assert.equal(r2.priority, b2.priority, 'the priority this change set goes back');

  // Nothing of the change left to take back: nothing is written or synced.
  const b3 = structuredClone(db.get('tasks', t.id));
  const a3 = db.update('tasks', t.id, { priority: 2 });
  db.update('tasks', t.id, { priority: 1 });
  take();
  const r3 = M.revertChange('tasks', b3, a3);
  assert.equal(r3.priority, 1);
  assert.deepEqual(take(), [], 'no write, no op');
  db.remove('tasks', t.id);
});

test('revertChange: undoing a create, a delete, and a change to a record deleted since', () => {
  // Undo a create: the record goes, if it is still there.
  const made = M.createTask({ title: 'QA made' });
  assert.equal(M.revertChange('tasks', null, made), null);
  assert.equal(db.get('tasks', made.id), null);
  take();
  assert.equal(M.revertChange('tasks', null, made), null, 'already gone: nothing to do');
  assert.deepEqual(take(), []);

  // Undo a delete: it comes back as it was.
  const t = M.createTask({ title: 'QA deleted', date: today, tags: ['x'] });
  const gone = db.remove('tasks', t.id);
  const back = M.revertChange('tasks', gone, null);
  assert.deepEqual(back, t, 'put back whole: same id, fields and timestamps');
  assert.deepEqual(db.get('tasks', t.id), t);

  // ...unless it has been re-created (or restored, and edited) since: that copy is left alone.
  const gone2 = db.remove('tasks', t.id);
  db.put('tasks', { ...gone2, title: 'QA restored elsewhere', updatedAt: Date.now() });
  take();
  assert.equal(M.revertChange('tasks', gone2, null).title, 'QA restored elsewhere');
  assert.deepEqual(take(), [], 'not written over');

  // A change to a record that was deleted since: it stays deleted.
  const before = structuredClone(db.get('tasks', t.id));
  const after = db.update('tasks', t.id, { date: tomorrow });
  db.remove('tasks', t.id);
  take();
  assert.equal(M.revertChange('tasks', before, after), null);
  assert.equal(db.get('tasks', t.id), null, 'not brought back');
  assert.deepEqual(take(), []);
  assert.equal(M.revertChange('tasks', null, null), null, 'no record at all: nothing to do');
});

test("revertChange keeps an event's times together: never half a move", () => {
  const e = ev({ title: 'QA meeting', start: '2026-12-01T10:00', end: '2026-12-01T11:00' });
  // Moved, then renamed elsewhere: the undo moves it back and keeps the new name.
  const b1 = structuredClone(e);
  const a1 = db.update('events', e.id, { start: '2026-12-03T14:00', end: '2026-12-03T15:00' });
  remoteEdit('events', e.id, { title: 'QA meeting renamed', location: 'Room 2' });
  const r1 = M.revertChange('events', b1, a1);
  assert.deepEqual([r1.start, r1.end, r1.title, r1.location], ['2026-12-01T10:00', '2026-12-01T11:00', 'QA meeting renamed', 'Room 2']);

  // Moved a day earlier, then made longer since: taking back only the start would leave it ending
  // before it starts. The times stay as they are now, together.
  const b2 = structuredClone(db.get('events', e.id));
  const a2 = db.update('events', e.id, { start: '2026-11-30T10:00', end: '2026-11-30T11:00' });
  db.update('events', e.id, { end: '2026-11-30T12:00' });
  const r2 = M.revertChange('events', b2, a2);
  assert.deepEqual([r2.start, r2.end], ['2026-11-30T10:00', '2026-11-30T12:00'], 'the later resize stands');

  // Made all-day since a move: the move's timed start and end are not put back onto it.
  const b3 = structuredClone(db.get('events', e.id));
  const a3 = db.update('events', e.id, { start: '2026-12-05T09:00', end: '2026-12-05T10:00' });
  db.update('events', e.id, { allDay: true, start: '2026-12-05', end: '2026-12-05' });
  const r3 = M.revertChange('events', b3, a3);
  assert.deepEqual([r3.allDay, r3.start, r3.end], [true, '2026-12-05', '2026-12-05']);
  db.remove('events', e.id);
});

test('revertChange: done and completedAt go back together; tags and exdates keep what was added since', async () => {
  const t = M.createTask({ title: 'QA done pair', date: today, tags: ['home'] });
  const b1 = structuredClone(t);
  const a1 = db.update('tasks', t.id, { done: true, completedAt: Date.now() });
  await tick();
  db.update('tasks', t.id, { done: false, completedAt: null }); // reopened…
  await tick();
  const again = db.update('tasks', t.id, { done: true, completedAt: Date.now() }); // …and completed again since
  const r1 = M.revertChange('tasks', b1, a1);
  assert.deepEqual([r1.done, r1.completedAt], [true, again.completedAt], 'the newer completion stands, whole');

  // A label added by the change goes; one added since stays.
  const b2 = structuredClone(db.get('tasks', t.id));
  const a2 = db.update('tasks', t.id, { tags: ['home', 'phone'] });
  db.update('tasks', t.id, { tags: ['home', 'phone', 'later'] });
  assert.deepEqual(M.revertChange('tasks', b2, a2).tags, ['home', 'later']);
  db.remove('tasks', t.id);

  // Editing one occurrence (a detached copy), then deleting another one elsewhere: the undo brings
  // the edited day back to the series and keeps the other day deleted.
  const s = ev({ title: 'QA daily', start: '2026-12-01T09:00', end: '2026-12-01T09:30', repeat: { freq: 'day', interval: 1 } });
  const undo = M.trackChanges(() => M.detachOccurrence(s.id, '2026-12-03', { title: 'QA moved one' }));
  const copy = undo.result;
  remoteEdit('events', s.id, { exdates: ['2026-12-03', '2026-12-05'] }); // "this event" deleted on another device
  undo();
  assert.equal(db.get('events', copy.id), null, 'the edited copy goes');
  assert.deepEqual(db.get('events', s.id).exdates, ['2026-12-05'], 'the day deleted since stays deleted');
  const days = M.eventInstances('2026-12-01', '2026-12-06').filter((i) => i.event.id === s.id).map((i) => i.occurrence);
  assert.deepEqual(days, ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-06'], 'Dec 3 is back in the series');
  db.remove('events', s.id);
});

test("revertChange on a note: only the change is taken back, and the note's rev moves on, never back", () => {
  const n = db.insert('notes', S.newNote({ blocks: [S.newBlock('h1', 'QA note'), S.newBlock('p', 'first')] }));
  const before = structuredClone(n);
  const after = db.update('notes', n.id, { blocks: [n.blocks[0], S.newBlock('p', 'second')], rev: n.rev + 1 });
  db.update('notes', n.id, { pinned: true, rev: after.rev + 1 }); // pinned since
  const back = M.revertChange('notes', before, after);
  assert.deepEqual(back.blocks, n.blocks, 'the text goes back');
  assert.equal(back.pinned, true, 'the pin made since stays');
  assert.equal(back.rev, after.rev + 2, 'rev moves on (an assistant holding the old rev sees the change)');
  db.remove('notes', n.id);
});

test('toggleTask: Undo reopens the task and keeps edits made since; a task deleted since stays deleted', () => {
  const t = M.createTask({ title: 'QA toggle', date: today });
  const undo = M.toggleTask(t.id);
  assert.equal(db.get('tasks', t.id).done, true);
  remoteEdit('tasks', t.id, { title: 'QA toggle renamed', notes: 'added on the phone' });
  undo();
  const x = db.get('tasks', t.id);
  assert.deepEqual([x.done, x.completedAt, x.title, x.notes], [false, null, 'QA toggle renamed', 'added on the phone']);

  // Reopening is undone the same way.
  M.toggleTask(t.id);
  const reopen = M.toggleTask(t.id);
  db.update('tasks', t.id, { priority: 3 });
  reopen();
  assert.deepEqual([db.get('tasks', t.id).done, db.get('tasks', t.id).priority], [true, 3]);

  // Completed, then deleted: the completion's Undo does not bring it back.
  const t2 = M.createTask({ title: 'QA toggle then delete', date: today });
  const undo2 = M.toggleTask(t2.id);
  M.deleteTask(t2.id);
  undo2();
  assert.equal(db.get('tasks', t2.id), null);
  db.remove('tasks', t.id);
});

test('toggleTask on a repeating task: Undo moves it back and removes the logged copy, keeping edits made since', () => {
  const r = M.createTask({ title: 'QA daily', date: today, repeat: { freq: 'day', interval: 1 }, checklist: [{ id: 'qastep01', title: 'Step', done: true }] });
  const undo = M.toggleTask(r.id);
  const copy = db.all('tasks').find((x) => x.repeatOf === r.id);
  assert.ok(copy?.done, 'a completed copy is logged');
  assert.equal(db.get('tasks', r.id).date, tomorrow, 'the task moves on');
  db.update('tasks', r.id, { title: 'QA daily renamed' });
  undo();
  const x = db.get('tasks', r.id);
  assert.deepEqual([x.date, x.title, x.done], [today, 'QA daily renamed', false]);
  assert.deepEqual(x.checklist, r.checklist, 'its steps are as they were');
  assert.equal(db.get('tasks', copy.id), null, 'the logged copy goes');

  // The logged copy deleted since (Clear completed): the Undo still moves the task back, and does not recreate it.
  const undo2 = M.toggleTask(r.id);
  const copy2 = db.all('tasks').find((y) => y.repeatOf === r.id);
  db.remove('tasks', copy2.id);
  undo2();
  assert.equal(db.get('tasks', r.id).date, today);
  assert.equal(db.all('tasks').filter((y) => y.repeatOf === r.id).length, 0);
  db.remove('tasks', r.id);
});

test('scheduleTask: Undo puts the time block back and keeps a rename and a note made since in Tasks', () => {
  const t = M.createTask({ title: 'QA block', date: tomorrow, time: '10:00', duration: 30 });
  const undo = M.scheduleTask(t.id, tomorrow, '14:00', 30); // dragged in Schedule
  assert.equal(db.get('tasks', t.id).time, '14:00');
  remoteEdit('tasks', t.id, { title: 'Renamed in Tasks qzx', notes: 'important details written later' });
  undo();
  const x = db.get('tasks', t.id);
  assert.deepEqual([x.date, x.time, x.duration], [tomorrow, '10:00', 30], 'the block is back where it was');
  assert.deepEqual([x.title, x.notes], ['Renamed in Tasks qzx', 'important details written later'], 'the edits made since stay');

  // Moved, then deleted: the move's Undo does not bring it back.
  const undo2 = M.scheduleTask(t.id, today, '09:00', 30);
  M.deleteTask(t.id);
  undo2();
  assert.equal(db.get('tasks', t.id), null);
});

test('deleteTask: Undo brings the task back once; a copy restored or re-created since is left alone', () => {
  const t = M.createTask({ title: 'QA delete', date: today });
  const undo = M.deleteTask(t.id);
  assert.equal(db.get('tasks', t.id), null);
  undo();
  assert.deepEqual(db.get('tasks', t.id), t);
  const undo2 = M.deleteTask(t.id);
  db.put('tasks', { ...t, title: 'QA delete, restored on the phone', updatedAt: Date.now() });
  undo2();
  assert.equal(db.get('tasks', t.id).title, 'QA delete, restored on the phone');
  db.remove('tasks', t.id);
});

test('trackChanges: Undo takes back a move and a delete and removes what was made, keeping edits made since', () => {
  const a = ev({ title: 'A', start: '2026-12-01T09:00', end: '2026-12-01T10:00' });
  const b = ev({ title: 'B', start: '2026-12-02T09:00', end: '2026-12-02T10:00' });
  const undo = M.trackChanges(() => {
    db.update('events', a.id, { start: '2026-12-01T14:00', end: '2026-12-01T15:00' });
    db.remove('events', b.id);
    return db.insert('events', { title: 'C', calendarId: null, allDay: false, start: '2026-12-03T09:00', end: '2026-12-03T10:00' });
  });
  const c = undo.result;
  remoteEdit('events', a.id, { title: 'A renamed', notes: 'agenda written later' });
  undo();
  const x = db.get('events', a.id);
  assert.deepEqual([x.start, x.end, x.title, x.notes], ['2026-12-01T09:00', '2026-12-01T10:00', 'A renamed', 'agenda written later']);
  assert.deepEqual(db.get('events', b.id), b, 'the deleted event is back');
  assert.equal(db.get('events', c.id), null, 'the new one is gone');

  // A record deleted since stays deleted.
  const undo2 = M.trackChanges(() => db.update('events', a.id, { title: 'A2' }));
  db.remove('events', a.id);
  undo2();
  assert.equal(db.get('events', a.id), null);
  db.remove('events', b.id);
});
