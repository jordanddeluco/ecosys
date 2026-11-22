// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../shared/nlp.js';

// Sunday, Nov 22 2026, noon
const now = new Date(2026, 10, 22, 12, 0);
const lists = [
  { id: 'L1', name: 'Personal' },
  { id: 'L2', name: 'Work' },
  { id: 'L3', name: 'Home Projects' },
];
const calendars = [
  { id: 'C1', name: 'Personal' },
  { id: 'C2', name: 'Work' },
];
const task = (s, o = {}) => parse(s, { mode: 'task', now, lists, ...o });
const event = (s, o = {}) => parse(s, { mode: 'event', now, calendars, ...o });

test('task: date, time, duration, list, priority, tag', () => {
  const r = task('Call mom tomorrow 6pm for 20m #Personal !! @phone');
  assert.equal(r.title, 'Call mom');
  assert.equal(r.date, '2026-11-23');
  assert.equal(r.time, '18:00');
  assert.equal(r.duration, 20);
  assert.equal(r.listId, 'L1');
  assert.equal(r.priority, 2);
  assert.deepEqual(r.tags, ['phone']);
});

test('task: multi-word list names and unknown lists', () => {
  assert.equal(task('Fix shelf #Home Projects').listId, 'L3');
  const r = task('Pay rent every 1st #Rent');
  assert.equal(r.newList, 'Rent');
  assert.deepEqual(r.repeat, { freq: 'month', interval: 1, monthDay: 1 });
  assert.equal(r.date, '2026-12-01');
  assert.equal(r.title, 'Pay rent');
});

test('task: deadline, evening, someday', () => {
  const r = task('Renew passport by dec 15');
  assert.equal(r.deadline, '2026-12-15');
  assert.equal(r.date, null);
  assert.equal(r.title, 'Renew passport');
  const e = task('Read book tonight');
  assert.equal(e.evening, true);
  assert.equal(e.date, '2026-11-22');
  assert.equal(task('Plan a trip someday').someday, true);
});

test('relative and absolute dates', () => {
  assert.equal(task('Report in 3 days').date, '2026-11-25');
  assert.equal(task('Dentist next thu 10am').date, '2026-11-26');
  assert.equal(task('Dentist next thu 10am').time, '10:00');
  assert.equal(task('Ship it friday').date, '2026-11-27');
  assert.equal(task('Review next week').date, '2026-11-23');
  assert.equal(task('Call bank 12/3').date, '2026-12-03');
  assert.equal(task('Taxes april 15').date, '2027-04-15');
  assert.equal(task('Party 2026-12-31').date, '2026-12-31');
});

test('times: bare hours, 24h, keywords', () => {
  assert.equal(task('Meet at 5').time, '17:00');
  assert.equal(task('Call at 9').time, '09:00');
  assert.equal(task('Sync 14:30').time, '14:30');
  assert.equal(task('Lunch at noon').time, '12:00');
  assert.equal(task('Run 6a').time, '06:00');
});

test('things that must NOT be parsed', () => {
  assert.equal(task('Buy sun cream').date, null);
  assert.equal(task('Buy sun cream').title, 'Buy sun cream');
  assert.equal(task('Take pills 2 a day').time, null);
  assert.equal(task('Read chapters 2-3').time, null);
  assert.equal(task('Read chapters 2-3').title, 'Read chapters 2-3');
  assert.equal(task('Clean the wedding dress').date, null);
  const q = task('Watch "Friday Night Lights"');
  assert.equal(q.date, null);
  assert.equal(q.title, 'Watch Friday Night Lights');
});

test('repeats', () => {
  assert.deepEqual(task('Gym every mon, wed and fri 7am').repeat, { freq: 'week', interval: 1, days: [1, 3, 5] });
  assert.deepEqual(task('Water plants every other week').repeat.interval, 2);
  assert.deepEqual(task('Sync biweekly').repeat, { freq: 'week', interval: 2, days: [0] });
  assert.equal(task('Stretch daily').repeat.freq, 'day');
});

test('event: time ranges', () => {
  const r = event('Standup 9:30-9:45 every weekday');
  assert.equal(r.time, '09:30');
  assert.equal(r.endTime, '09:45');
  assert.equal(r.duration, 15);
  assert.deepEqual(r.repeat.days, [1, 2, 3, 4, 5]);
  assert.equal(r.date, '2026-11-23'); // first weekday on/after today
  assert.equal(event('Dinner 7-9pm').time, '19:00');
  assert.equal(event('Dinner 7-9pm').endTime, '21:00');
  assert.equal(event('Workshop 11-1pm').time, '11:00');
  assert.equal(event('Workshop 11-1pm').endTime, '13:00');
  assert.equal(event('Party 10pm-1am').duration, 180);
});

test('event: location, calendar, all-day', () => {
  const r = event('Lunch with Sam fri 1pm at Cafe Luna #Work');
  assert.equal(r.title, 'Lunch with Sam');
  assert.equal(r.date, '2026-11-27');
  assert.equal(r.time, '13:00');
  assert.equal(r.location, 'Cafe Luna');
  assert.equal(r.calendarId, 'C2');
  const a = event('Holiday dec 25');
  assert.equal(a.allDay, true);
  assert.equal(a.date, '2026-12-25');
  assert.equal(event('Call at 3pm').date, '2026-11-22');
});
