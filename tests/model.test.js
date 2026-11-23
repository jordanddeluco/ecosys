// shared/model.js: DST-safe event layout, repeating tasks, orphan lists, legacy someday flags,
// recurring-series edits and change tracking. Run with: npm test
process.env.TZ = 'America/New_York'; // DST starts 2026-03-08, ends 2026-11-01
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db, settings } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const { todayYmd, addDaysYmd } = await import('../shared/dates.js');

const ev = (e) => db.insert('events', { title: 'E', calendarId: null, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, ...e });
const timedOn = (day) => M.dayInstances(M.eventInstances(day, day), day).timed;

test('timed events use wall-clock minutes on DST changeover days', () => {
  assert.equal(new Date(2026, 2, 8, 12).getTimezoneOffset(), 240, 'test runs in America/New_York');
  const spring = ev({ start: '2026-03-08T10:00', end: '2026-03-08T11:00' });
  const fall = ev({ start: '2026-11-01T10:00', end: '2026-11-01T11:00' });
  const [a] = timedOn('2026-03-08');
  assert.equal(a.top, 600);
  assert.equal(a.bottom, 660);
  const [b] = timedOn('2026-11-01');
  assert.equal(b.top, 600);
  assert.equal(b.bottom, 660);
  db.remove('events', spring.id);
  db.remove('events', fall.id);
});

test('a daily 9:00 series stays at 9:00 across the DST change', () => {
  const s = ev({ start: '2026-03-06T09:00', end: '2026-03-06T09:30', repeat: { freq: 'day', interval: 1 } });
  for (const day of ['2026-03-07', '2026-03-08', '2026-03-09']) {
    const [i] = timedOn(day);
    assert.equal(i.top, 540, day);
    assert.equal(i.bottom, 570, day);
  }
  db.remove('events', s.id);
});

test('events crossing midnight, ending at midnight, and full days', () => {
  const late = ev({ start: '2026-03-07T23:00', end: '2026-03-08T01:00' });
  assert.deepEqual(timedOn('2026-03-07').map((i) => [i.top, i.bottom]), [[1380, 1440]]);
  assert.deepEqual(timedOn('2026-03-08').map((i) => [i.top, i.bottom]), [[0, 60]]);
  db.remove('events', late.id);
  const toMidnight = ev({ start: '2026-11-01T23:00', end: '2026-11-02T00:00' });
  assert.deepEqual(timedOn('2026-11-01').map((i) => [i.top, i.bottom]), [[1380, 1440]]);
  assert.deepEqual(timedOn('2026-11-02'), []);
  db.remove('events', toMidnight.id);
  // midnight to midnight on the 23-hour day is still a full day → all-day row
  const day = ev({ start: '2026-03-08T00:00', end: '2026-03-09T00:00' });
  const { allDay, timed } = M.dayInstances(M.eventInstances('2026-03-08', '2026-03-08'), '2026-03-08');
  assert.equal(allDay.length, 1);
  assert.equal(timed.length, 0);
  db.remove('events', day.id);
});

test('events with broken start/end are skipped instead of crashing', () => {
  db.all('events').push({ id: 'broken', start: 5, end: null });
  assert.doesNotThrow(() => M.eventInstances('2026-01-01', '2026-12-31'));
  db.all('events').pop();
});

test('completing a repeating task with no date puts it on the next occurrence', () => {
  const t = M.createTask({ title: 'Stretch', repeat: { freq: 'day', interval: 1 } });
  assert.equal(t.date, null);
  const undo = M.toggleTask(t.id);
  const after = db.get('tasks', t.id);
  assert.equal(after.done, false);
  assert.equal(after.date, addDaysYmd(todayYmd(), 1));
  const copies = db.all('tasks').filter((x) => x.repeatOf === t.id);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].done, true);
  undo();
  assert.equal(db.get('tasks', t.id).date, null);
  assert.equal(db.all('tasks').filter((x) => x.repeatOf === t.id).length, 0);
  db.remove('tasks', t.id);
});

test('completing a repeating task that is decades overdue moves it after today (no 5000-step cap)', () => {
  const today = todayYmd();
  const t = M.createTask({ title: 'Old daily', date: '2000-01-01', deadline: '2000-01-03', repeat: { freq: 'day', interval: 1 } });
  const undo = M.toggleTask(t.id);
  const after = db.get('tasks', t.id);
  assert.equal(after.date, addDaysYmd(today, 1));
  assert.equal(after.deadline, addDaysYmd(today, 3), 'the deadline keeps its gap');
  undo();
  assert.equal(db.get('tasks', t.id).date, '2000-01-01');
  db.remove('tasks', t.id);
});

test('a monthly series that starts off its day of month is shown on its start date too (RFC 5545 DTSTART)', () => {
  const s = ev({ start: '2026-11-22T09:00', end: '2026-11-22T10:00', repeat: { freq: 'month', interval: 1, monthDay: 15 } });
  const days = M.eventInstances('2026-11-01', '2027-01-31').filter((i) => i.event.id === s.id).map((i) => i.occurrence);
  assert.deepEqual(days, ['2026-11-22', '2026-12-15', '2027-01-15']);
  assert.equal(timedOn('2026-11-22').filter((i) => i.event.id === s.id).length, 1);
  db.remove('events', s.id);
});

test('completing a repeating task moves it forward and resets its steps', () => {
  const today = todayYmd();
  const t = M.createTask({ title: 'Water plants', date: today, repeat: { freq: 'week', interval: 1 }, checklist: [{ id: 's1', title: 'Ferns', done: true }] });
  M.toggleTask(t.id);
  const after = db.get('tasks', t.id);
  assert.equal(after.date, addDaysYmd(today, 7));
  assert.equal(after.checklist[0].done, false);
  db.remove('tasks', t.id);
});

test('a task whose list was deleted shows in Inbox and maps to the inbox for hidden lists', () => {
  const t = M.createTask({ title: 'Orphan', date: todayYmd() });
  db.update('tasks', t.id, { listId: 'gone12345' });
  assert.ok(M.tasksIn('inbox').some((x) => x.id === t.id));
  assert.equal(M.taskListKey(db.get('tasks', t.id)), 'inbox');
  const s = { ...settings.get(), showTasksInSchedule: true, hiddenTaskLists: ['inbox'] };
  assert.equal(M.isTaskListHidden(db.get('tasks', t.id), s), true);
  assert.ok(!M.scheduledTasks(todayYmd(), todayYmd(), s).some((x) => x.id === t.id));
  assert.ok(M.scheduledTasks(todayYmd(), todayYmd(), { ...s, hiddenTaskLists: [] }).some((x) => x.id === t.id));
  db.update('tasks', t.id, { done: true, completedAt: Date.now() });
  assert.ok(M.completedIn('inbox').some((x) => x.id === t.id));
  db.remove('tasks', t.id);
});

test('createTask ignores a list id that no longer exists', () => {
  const t = M.createTask({ title: 'Stale chip', listId: 'deadbeef' });
  assert.equal(t.listId, null);
  db.remove('tasks', t.id);
});

test('legacy someday flags never hide a dated task from the calendar', () => {
  const day = todayYmd();
  // An old record as another tab might still write it.
  db.all('tasks').push({ id: 'legacy1', title: 'Old', date: day, someday: true, done: false, tags: [], checklist: [], listId: null, order: 0, createdAt: 1, updatedAt: 1 });
  const s = { ...settings.get(), showTasksInSchedule: true, hiddenTaskLists: [] };
  assert.ok(M.scheduledTasks(day, day, s).some((t) => t.id === 'legacy1'));
  db.all('tasks').pop();
  const t = M.createTask({ title: 'Dated', date: day, time: '10:00', someday: true });
  assert.equal(t.date, day);
  assert.equal(t.time, '10:00');
  assert.ok(!('someday' in t));
  db.remove('tasks', t.id);
});

test('priorityColor falls back for out-of-range values', () => {
  assert.equal(M.priorityColor(3), 'var(--p1)');
  assert.equal(M.priorityColor(7), 'var(--text-3)');
  assert.equal(M.priorityColor(undefined), 'var(--text-3)');
});

test('series: detached copies remember their occurrence and go away with the series', () => {
  const s = ev({ start: '2026-12-01T09:00', end: '2026-12-01T10:00', repeat: { freq: 'day', interval: 1 } });
  const c1 = M.detachOccurrence(s.id, '2026-12-03', { title: 'Moved' });
  const c2 = M.detachOccurrence(s.id, '2026-12-08', { start: '2026-12-09T09:00', end: '2026-12-09T10:00' });
  assert.equal(c1.occurrence, '2026-12-03');
  assert.equal(c2.occurrence, '2026-12-08');
  assert.deepEqual(db.get('events', s.id).exdates, ['2026-12-03', '2026-12-08']);
  M.deleteOccurrence(s.id, '2026-12-05', 'following');
  assert.equal(db.get('events', s.id).until, '2026-12-04');
  assert.ok(db.get('events', c1.id), 'earlier copy stays');
  assert.equal(db.get('events', c2.id), null, 'later copy (even moved to another day) goes');
  M.deleteOccurrence(s.id, '2026-12-01', 'all');
  assert.equal(db.get('events', s.id), null);
  assert.equal(db.get('events', c1.id), null);
});

test('series: "this and following" moves copies and shifts exdates with the dates', () => {
  const s = ev({ start: '2026-12-01T09:00', end: '2026-12-01T10:00', repeat: { freq: 'day', interval: 1 }, exdates: ['2026-12-02', '2026-12-12'] });
  const copy = M.detachOccurrence(s.id, '2026-12-11', { title: 'Edited' });
  const next = M.splitSeries(s.id, '2026-12-10', { start: '2026-12-11T09:00', end: '2026-12-11T10:00' });
  assert.equal(db.get('events', s.id).until, '2026-12-09');
  assert.deepEqual(next.exdates, ['2026-12-12', '2026-12-13']);
  assert.equal(db.get('events', copy.id).seriesId, next.id);
  M.deleteOccurrence(next.id, '2026-12-11', 'all');
  M.deleteOccurrence(s.id, '2026-12-01', 'all');
  assert.equal(db.get('events', copy.id), null);
  assert.deepEqual(M.shiftSeriesDates({ exdates: ['2026-01-31'], until: '2026-02-28' }, 1), { exdates: ['2026-02-01'], until: '2026-03-01' });
  assert.deepEqual(M.shiftSeriesDates({ exdates: [] }, 0), {});
});

test('series: "this event" delete adds an exdate once', () => {
  const s = ev({ start: '2026-12-01T09:00', end: '2026-12-01T10:00', repeat: { freq: 'day', interval: 1 } });
  M.deleteOccurrence(s.id, '2026-12-04', 'this');
  M.deleteOccurrence(s.id, '2026-12-04', 'this');
  assert.deepEqual(db.get('events', s.id).exdates, ['2026-12-04']);
  assert.ok(!M.eventInstances('2026-12-04', '2026-12-04').some((i) => i.event.id === s.id));
  db.remove('events', s.id);
});

test('trackChanges undoes exactly what it touched', () => {
  const a = ev({ start: '2026-12-01T09:00', end: '2026-12-01T10:00', title: 'A' });
  const b = ev({ start: '2026-12-02T09:00', end: '2026-12-02T10:00', title: 'B' });
  const undo = M.trackChanges(() => {
    db.update('events', a.id, { title: 'A2' });
    db.remove('events', b.id);
    return db.insert('events', { title: 'C', start: '2026-12-03T09:00', end: '2026-12-03T10:00' });
  });
  const c = undo.result;
  const later = ev({ start: '2026-12-04T09:00', end: '2026-12-04T10:00', title: 'Later' }); // made afterwards, must survive
  undo();
  assert.equal(db.get('events', a.id).title, 'A');
  assert.equal(db.get('events', b.id).title, 'B');
  assert.equal(db.get('events', c.id), null);
  assert.ok(db.get('events', later.id));
  for (const x of [a, b, later]) db.remove('events', x.id);
});
