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
const pick = (r) => ({ title: r.title, date: r.date, time: r.time });

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
  assert.equal(e.time, '19:00');
  assert.equal(e.date, '2026-11-22');
  assert.equal(e.title, 'Read book');
  assert.equal('evening' in e, false);
  assert.equal(task('Plan a trip someday').someday, true);
});

test('parts of the day', () => {
  const ev = task('Call mom in the evening');
  assert.equal(ev.time, '18:00');
  assert.equal(ev.title, 'Call mom');
  assert.equal(task('Call mom this evening').date, '2026-11-22');
  // bare words only count at the end or next to another token
  const news = task('Read evening news');
  assert.equal(news.time, null);
  assert.equal(news.title, 'Read evening news');
  assert.equal(task('Read morning paper').title, 'Read morning paper');
  const tm = task('Call mom tomorrow morning about taxes');
  assert.equal(tm.date, '2026-11-23');
  assert.equal(tm.time, '09:00');
  assert.equal(tm.title, 'Call mom about taxes');
  const fri = task('Gym fri morning');
  assert.equal(fri.date, '2026-11-27');
  assert.equal(fri.time, '09:00');
  assert.equal(fri.title, 'Gym');
  assert.equal(task('Run tomorrow afternoon').time, '14:00');
  // an hour without am/pm follows the part of the day; explicit am/pm wins
  assert.equal(task('Dinner at 7 in the evening').time, '19:00');
  assert.equal(task('Wake up at 5 in the morning').time, '05:00');
  assert.equal(task('Call at 2 in the afternoon').time, '14:00');
  assert.equal(task('Movie 9pm tonight').time, '21:00');
  assert.equal(task('Movie 9pm tonight').title, 'Movie');
  assert.equal(task('Flight 6:30am tomorrow morning').time, '06:30');
  const drinks = event('Drinks from 7 to 9 tonight');
  assert.equal(drinks.time, '19:00');
  assert.equal(drinks.endTime, '21:00');
  assert.equal(drinks.duration, 120);
  assert.equal(drinks.title, 'Drinks');
});

test('"this morning" / "this afternoon" are today, like "tonight" and "this evening"', () => {
  assert.deepEqual(pick(task('Meet Sam this afternoon at 3')), { title: 'Meet Sam', date: '2026-11-22', time: '15:00' });
  assert.deepEqual(pick(task('Call the bank this morning')), { title: 'Call the bank', date: '2026-11-22', time: '09:00' });
  assert.deepEqual(pick(task('Call mom tonight')), { title: 'Call mom', date: '2026-11-22', time: '19:00' });
  assert.deepEqual(pick(task('Stretch in the morning')), { title: 'Stretch', date: null, time: '09:00' }, '"in the …" names no day');
  assert.deepEqual(pick(task('Report due friday afternoon')), { title: 'Report', date: '2026-11-27', time: '14:00' });
});

test('"every morning" / "each evening" repeat daily at that part of the day', () => {
  const w = task('Water plants every morning');
  assert.deepEqual(pick(w), { title: 'Water plants', date: '2026-11-22', time: '09:00' });
  assert.deepEqual(w.repeat, { freq: 'day', interval: 1 });
  assert.equal(task('Run every evening at 7').time, '19:00');
  assert.equal(task('Run every evening at 7').title, 'Run');
  assert.equal(task('Journal each night').time, '21:00');
  assert.equal(task('Walk every afternoon').time, '14:00');
  const s = event('Standup every morning 9:30-9:45');
  assert.deepEqual([s.time, s.endTime, s.repeat?.freq, s.title], ['09:30', '09:45', 'day', 'Standup']);
  assert.equal(task('Read evening news').repeat, null);
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
  // yearly rules carry their anchor month, so moving the task doesn't move the pattern
  assert.deepEqual(task('Renew passport yearly').repeat, { freq: 'year', interval: 1, monthDay: 22, month: 11 });
  const b = task('Birthday dec 5 every year');
  assert.equal(b.date, '2026-12-05');
  assert.deepEqual(b.repeat, { freq: 'year', interval: 1, monthDay: 5, month: 12 });
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
