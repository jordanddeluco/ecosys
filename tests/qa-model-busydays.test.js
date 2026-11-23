// QA (model, cross-area): busyDays, the mini month's grey dots shared by Home and Schedule
// (shared/model.js). A day has a dot when it has plans: an event of a calendar that is shown (each
// day of a multi-day one, clipped to the range) or an open task with a time that Schedule draws.
// Hidden calendars, hidden task lists, tasks hidden on the calendar, done tasks and tasks without a
// time leave no dot, and it never throws. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db, settings } = await import('../shared/store.js');
const M = await import('../shared/model.js');

// A month grid of 2031: May 2031 starts on a Thursday; the Sunday grid runs 27 April to 7 June (42 days).
const FROM = '2031-04-27';
const TO = '2031-06-07';
const sorted = (set) => [...set].sort();
const ev = (e) => db.insert('events', { title: 'E', calendarId: null, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, ...e });
const task = (t) => db.insert('tasks', { title: 'T', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 1, ...t });
const shown = (extra = {}) => ({ ...settings.get(), showTasksInSchedule: true, hiddenTaskLists: [], ...extra });
function clear() {
  for (const c of ['events', 'tasks', 'calendars', 'lists']) for (const x of [...db.all(c)]) db.remove(c, x.id);
}

test('busyDays: nothing planned, or a range that is not one, has no dots', () => {
  clear();
  assert.ok(M.busyDays(FROM, TO) instanceof Set);
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown())), []);
  ev({ start: '2031-05-14T10:00', end: '2031-05-14T11:00' });
  for (const [a, b] of [[TO, FROM], ['2031-05-32', TO], [FROM, ''], [null, TO], [FROM, undefined]]) {
    assert.deepEqual(sorted(M.busyDays(a, b, shown())), [], `${a} to ${b}`);
  }
  clear();
});

test('busyDays: each day an event of a shown calendar touches, clipped to the range', () => {
  clear();
  ev({ start: '2031-05-14T10:00', end: '2031-05-14T11:00' }); // one hour
  ev({ start: '2031-05-20T23:00', end: '2031-05-21T01:00' }); // over midnight: both days
  ev({ start: '2031-05-24T22:00', end: '2031-05-25T00:00' }); // ends at midnight: its own day only
  ev({ allDay: true, start: '2031-05-28', end: '2031-05-30' }); // three days, end inclusive
  ev({ allDay: true, start: '2031-04-25', end: '2031-04-28' }); // starts before the grid
  ev({ start: '2031-06-06T09:00', end: '2031-06-09T09:00' }); // runs past the grid
  ev({ start: '2031-06-20T09:00', end: '2031-06-20T10:00' }); // after the grid
  assert.deepEqual(sorted(M.busyDays(FROM, TO)), [
    '2031-04-27', '2031-04-28',
    '2031-05-14',
    '2031-05-20', '2031-05-21',
    '2031-05-24',
    '2031-05-28', '2031-05-29', '2031-05-30',
    '2031-06-06', '2031-06-07',
  ]);
  assert.deepEqual(sorted(M.busyDays('2031-05-21', '2031-05-21')), ['2031-05-21'], 'a one-day range');
  clear();
});

test('busyDays: a repeating event marks each occurrence, not the dates taken out of it', () => {
  clear();
  // Weekly on Mondays from 5 May 2031, with 19 May taken out and the series ending 2 June.
  ev({ start: '2031-05-05T09:00', end: '2031-05-05T09:30', repeat: { freq: 'week', interval: 1 }, exdates: ['2031-05-19'], until: '2031-06-02' });
  assert.deepEqual(sorted(M.busyDays(FROM, TO)), ['2031-05-05', '2031-05-12', '2031-05-26', '2031-06-02']);
  clear();
});

test('busyDays: an event of a hidden calendar leaves no dot until the calendar is shown', () => {
  clear();
  const cal = db.insert('calendars', { name: 'QA side', color: 'teal', visible: false });
  ev({ calendarId: cal.id, start: '2031-05-14T10:00', end: '2031-05-14T11:00' });
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown())), []);
  db.update('calendars', cal.id, { visible: true });
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown())), ['2031-05-14']);
  clear();
});

test('busyDays: an open task with a time marks its day, as Schedule draws it', () => {
  clear();
  const list = db.insert('lists', { name: 'QA errands', color: 'green', icon: '', order: 0 });
  task({ title: 'Timed', date: '2031-05-06', time: '09:00' });
  task({ title: 'In a list', listId: list.id, date: '2031-05-07', time: '18:30', duration: 45 });
  task({ title: 'No time', date: '2031-05-08' });
  task({ title: 'Done', date: '2031-05-09', time: '10:00', done: true, completedAt: Date.now() });
  task({ title: 'No date', time: '11:00' });
  task({ title: 'Outside', date: '2031-06-08', time: '12:00' });
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown())), ['2031-05-06', '2031-05-07']);
  assert.deepEqual(sorted(M.busyDays(FROM, TO)), [], 'no settings: events only');
  assert.deepEqual(sorted(M.busyDays(FROM, TO, null)), [], 'null settings: events only');
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown({ showTasksInSchedule: false }))), [], 'tasks hidden on the calendar');
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown({ hiddenTaskLists: [list.id] }))), ['2031-05-06'], 'its list hidden');
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown({ hiddenTaskLists: ['inbox'] }))), ['2031-05-07'], 'Inbox hidden');
  // Events and tasks together: one dot per day.
  ev({ start: '2031-05-06T14:00', end: '2031-05-06T15:00' });
  ev({ start: '2031-05-15T14:00', end: '2031-05-15T15:00' });
  assert.deepEqual(sorted(M.busyDays(FROM, TO, shown())), ['2031-05-06', '2031-05-07', '2031-05-15']);
  clear();
});

test('busyDays: settings it cannot read leave out the tasks, never the events', () => {
  clear();
  ev({ start: '2031-05-14T10:00', end: '2031-05-14T11:00' });
  task({ date: '2031-05-06', time: '09:00' });
  // hiddenTaskLists that is no list: scheduledTasks throws on it, busyDays still has the event's day.
  assert.deepEqual(sorted(M.busyDays(FROM, TO, { showTasksInSchedule: true, hiddenTaskLists: { length: 1 } })), ['2031-05-14']);
  clear();
});
