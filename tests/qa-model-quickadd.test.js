// QA (model): a time typed without a day ("Lunch at noon", "Email Sam at 3") gets one, so the task
// reaches Today, Upcoming, Home and the calendar (shared/model.js createTask, dayForTime): today while
// that time is still ahead, tomorrow once it has passed, the deadline's day for "by fri 5pm".
// Run with: npm test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db, settings } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const { parse } = await import('../shared/nlp.js');

/** Run fn with the clock at a local date and time (Sunday 22 November 2026 unless given). */
function at([y, mo, d, h, mi], fn) {
  mock.timers.enable({ apis: ['Date'], now: new Date(y, mo - 1, d, h, mi) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}
const quickAdd = (text) => M.createTask(parse(text, { mode: 'task', lists: db.all('lists') }));

test('dayForTime: today while the time is still ahead, tomorrow once it has passed, else the deadline day', () => {
  const now = new Date(2026, 10, 22, 11, 30);
  assert.equal(M.dayForTime('12:00', { now }), '2026-11-22');
  assert.equal(M.dayForTime('11:30', { now }), '2026-11-22', 'this very minute is still today');
  assert.equal(M.dayForTime('11:29', { now }), '2026-11-23');
  assert.equal(M.dayForTime('09:00', { now: new Date(2026, 11, 31, 18, 0) }), '2027-01-01', 'over the new year');
  assert.equal(M.dayForTime('17:00', { now, deadline: '2026-11-27' }), '2026-11-27', '"by fri 5pm"');
  assert.equal(M.dayForTime('17:00', { now, deadline: 'soon' }), '2026-11-22', 'a deadline that is not a date is ignored');
});

test('quick add: "Lunch at noon" in the morning is today at 12:00, and shows in Today and on the calendar', () => {
  at([2026, 11, 22, 9, 0], () => {
    const lunch = quickAdd('Lunch at noon');
    assert.deepEqual([lunch.title, lunch.date, lunch.time], ['Lunch', '2026-11-22', '12:00']);
    assert.ok(M.tasksIn('today', { today: '2026-11-22' }).some((t) => t.id === lunch.id), 'in Today');
    const s = { ...settings.get(), showTasksInSchedule: true, hiddenTaskLists: [] };
    assert.ok(M.scheduledTasks('2026-11-22', '2026-11-22', s).some((t) => t.id === lunch.id), 'on the calendar');
    assert.deepEqual(M.taskBlock(lunch, s), { top: 720, bottom: 720 + (s.defaultTaskMinutes || 30) }, 'as a time block at noon');
    const email = quickAdd('Email Sam at 3');
    assert.deepEqual([email.date, email.time], ['2026-11-22', '15:00']);
    for (const t of [lunch, email]) db.remove('tasks', t.id);
  });
});

test('quick add: a time that has already passed today is for tomorrow', () => {
  at([2026, 11, 22, 15, 0], () => {
    const lunch = quickAdd('Lunch at noon');
    assert.deepEqual([lunch.date, lunch.time], ['2026-11-23', '12:00'], 'tomorrow at noon, not an overdue lunch');
    assert.ok(M.tasksIn('upcoming', { today: '2026-11-22' }).some((t) => t.id === lunch.id), 'in Upcoming');
    db.remove('tasks', lunch.id);
  });
  at([2026, 12, 31, 20, 0], () => {
    const t = quickAdd('Standup 9:30');
    assert.deepEqual([t.date, t.time], ['2027-01-01', '09:30']);
    db.remove('tasks', t.id);
  });
});

test('quick add: "by fri 5pm" is on the deadline day; a repeat starts on its first day', () => {
  at([2026, 11, 22, 9, 0], () => {
    const report = quickAdd('Submit report by fri 5pm');
    assert.deepEqual([report.date, report.time, report.deadline], ['2026-11-27', '17:00', '2026-11-27']);
    // createTask from code: a weekly repeat with a time and no date starts on its first weekday.
    const gym = M.createTask({ title: 'Gym', time: '07:00', repeat: { freq: 'week', interval: 1, days: [3] } });
    assert.equal(gym.date, '2026-11-25', 'the first Wednesday');
    for (const t of [report, gym]) db.remove('tasks', t.id);
  });
});

test('plannedDay: what a composer shows before Enter is the day createTask saves', () => {
  at([2026, 11, 22, 15, 0], () => {
    for (const text of ['Lunch at noon', 'Call Dana at 11:59pm', 'Submit report by fri 5pm', 'Standup every mon at 9am', 'Call mom tomorrow 6pm', 'Plan a weekend trip']) {
      const r = parse(text, { mode: 'task', lists: db.all('lists') });
      const t = M.createTask(r);
      assert.equal(M.plannedDay(r), t.date, text);
      db.remove('tasks', t.id);
    }
    assert.equal(M.plannedDay(parse('Lunch at noon', { mode: 'task', lists: [] })), '2026-11-23', 'noon has passed: tomorrow');
    assert.equal(M.plannedDay({ time: '07:00', repeat: { freq: 'week', interval: 1, days: [3] } }), '2026-11-25', 'a repeat: its first day');
    assert.equal(M.plannedDay({ title: 'No time' }), null);
  });
});

test('createTask: dates are kept, and a task without a time stays undated', () => {
  at([2026, 11, 22, 9, 0], () => {
    const dated = quickAdd('Call mom tomorrow 6pm');
    assert.deepEqual([dated.date, dated.time], ['2026-11-23', '18:00']);
    const later = M.createTask({ title: 'Later', date: '2026-12-01', time: '08:00' });
    assert.equal(later.date, '2026-12-01');
    const inbox = quickAdd('Plan a weekend trip');
    assert.deepEqual([inbox.date, inbox.time], [null, null], 'an Inbox task stays in the Inbox');
    const bad = M.createTask({ title: 'Bad time', time: '25:00' });
    assert.deepEqual([bad.date, bad.time], [null, null], 'a time that is not a time sets no day');
    for (const t of [dated, later, inbox, bad]) db.remove('tasks', t.id);
  });
});
