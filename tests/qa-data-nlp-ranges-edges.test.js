// QA (data, second pass): what a date range must not swallow, and the two decisions the first pass
// left open. With `ranges: true`:
//   - a quantity after a date is not the range's last day: "Sale nov 25 - 30% off" was Nov 25-30
//     titled "Sale % off", "Dinner dec 3 - 10 people" was Dec 3-10 titled "Dinner people";
//   - a time that is not a start and an end is for one sitting: "Course dec 3-5 9am for 2h" was one
//     50-hour event; now only the first day is read (the rest stays in the title), as with a repeat;
//   - without a year, the range under way is chosen only when it began nearer to today than the next
//     one begins: "Trip feb 5 - jan 2" typed on Nov 22 was an event that began 9.5 months ago.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../shared/nlp.js';
import { diffDays } from '../shared/dates.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12);
const NOW = at(2026, 11, 22); // Sunday 22 November 2026
const e = (s, o = {}) => parse(s, { mode: 'event', now: NOW, ranges: true, ...o });
const t = (s, o = {}) => parse(s, { mode: 'task', now: NOW, ranges: true, ...o });
const days = (r) => [r.date, r.endDate ?? r.deadline];

test('a number after a date that is a quantity is not the last day of a range', () => {
  for (const [s, title, date] of [
    ['Sale nov 25 - 30% off', 'Sale - 30% off', '2026-11-25'],
    ['Sale nov 25-30% off', 'Sale -30% off', '2026-11-25'],
    ['Sale nov 25 - 30 % off', 'Sale - 30 % off', '2026-11-25'],
    ['Dinner dec 3 - 10 people', 'Dinner - 10 people', '2026-12-03'],
    ['Order 12/5 - 12 boxes', 'Order - 12 boxes', '2026-12-05'],
    ['Read dec 3 - 10 pages', 'Read - 10 pages', '2026-12-03'],
    ['Run dec 3 – 10 km', 'Run – 10 km', '2026-12-03'],
  ]) {
    for (const r of [t(s), e(s)]) assert.deepEqual({ title: r.title, date: r.date, endDate: r.endDate, deadline: r.deadline }, { title, date, endDate: null, deadline: null }, s);
  }
  // still ranges: a word that starts a place or a person, a parsed token, the end of the text, no
  // spaces around the dash, a month on both ends
  for (const [s, title] of [
    ['Vacation dec 20 - 28 in Rome', 'Vacation in Rome'],
    ['Trip dec 20 - 28 with Sam', 'Trip with Sam'],
    ['Trip dec 20 - 28', 'Trip'],
    ['Trip dec 20 - 28 #Family', 'Trip'],
    ['Trip dec 20-28 Hawaii', 'Trip Hawaii'],
    ['Trip dec 20 - dec 28 Hawaii', 'Trip Hawaii'],
    ['Trip dec 20 to 28 Hawaii', 'Trip Hawaii'],
  ]) {
    const r = t(s);
    assert.deepEqual([r.title, ...days(r)], [title, '2026-12-20', '2026-12-28'], s);
  }
  const c = e('Conference dec 3 - 5 at Hilton');
  assert.deepEqual([c.title, c.location, ...days(c)], ['Conference', 'Hilton', '2026-12-03', '2026-12-05']);
});

test('an event over several days is timed only from a start to an end time: a lone time or a typed length is one sitting', () => {
  // the first day at that time and length, the rest of the range left in the title (as with a repeat)
  for (const [s, title, time, duration] of [
    ['Course dec 3-5 9am for 2h', 'Course -5', '09:00', 120],
    ['Hotel dec 3-5 3pm', 'Hotel -5', '15:00', null],
    ['Course dec 3-5 9am-11am for 2h', 'Course -5', '09:00', 120],
    ['Trip dec 3-5 evening', 'Trip -5', '18:00', null],
    ['Course from dec 3 to dec 5 at 9', 'Course to dec 5', '09:00', null],
    ['Course jan 5 - mar 30 6pm', 'Course - mar 30', '18:00', null],
  ]) {
    const r = e(s);
    assert.deepEqual({ title: r.title, endDate: r.endDate, time: r.time, duration: r.duration, allDay: r.allDay }, { title, endDate: null, time, duration, allDay: false }, s);
    assert.ok(r.date >= '2026-12-03', s);
  }
  // the first day is the range's first day, also when the month comes last ("20-28 dec")
  assert.deepEqual([e('Course 20-28 dec 9am').date, e('Course 20-28 dec 9am').title], ['2026-12-20', 'Course -28 dec']);
  // a typed length is never stretched over days
  for (const s of ['Course dec 3-5 9am for 2h', 'Course dec 3-5 9am for 90m', 'Course dec 1-20 6pm for an hour', 'Course dec 30 - jan 2 8am for 45 minutes']) {
    const r = e(s);
    assert.ok(r.duration <= 120 && !r.endDate, `${s}: ${r.duration} minutes, endDate ${r.endDate}`);
  }
  // a start and an end time: one event from the start on the first day to the end on the last, up to 14 days
  assert.deepEqual([e('Course dec 3-5 9-11am').duration, e('Course dec 3-5 9-11am').endDate], [2 * 1440 + 120, '2026-12-05']);
  assert.deepEqual([e('Course dec 1-15 6pm-5pm').duration, e('Course dec 1-15 6pm-5pm').endDate], [14 * 1440 - 60, '2026-12-15']);
  const long = e('Course dec 1-15 5pm-6pm'); // 14 days and an hour
  assert.deepEqual({ endDate: long.endDate, date: long.date, time: long.time, duration: long.duration, title: long.title }, { endDate: null, date: '2026-12-01', time: '17:00', duration: 60, title: 'Course -15' });
  // a part of the day found after the range stays in the title rather than stretching it
  const lodge = e('Trip dec 3-5 evening at Lodge');
  assert.deepEqual({ title: lodge.title, allDay: lodge.allDay, time: lodge.time, location: lodge.location, days: days(lodge) }, { title: 'Trip evening', allDay: true, time: null, location: 'Lodge', days: ['2026-12-03', '2026-12-05'] });
  // all day wins over a time, as on one day; a one-day range is that day
  assert.deepEqual([e('Retreat dec 3-5 all day 9am').allDay, ...days(e('Retreat dec 3-5 all day 9am'))], [true, '2026-12-03', '2026-12-05']);
  assert.deepEqual([e('Trip dec 20-20 9am').time, e('Trip dec 20-20 9am').title], ['09:00', 'Trip']);
  // a task keeps its time with the range: planned on the first day at that time, due on the last
  const task = t('Prep dec 3-5 9am for 2h');
  assert.deepEqual([task.title, task.date, task.deadline, task.time, task.duration], ['Prep', '2026-12-03', '2026-12-05', '09:00', 120]);
});

test('without a year, the range under way only when it began nearer to today than the next one begins', () => {
  assert.deepEqual(days(e('Trip feb 5 - jan 2')), ['2027-02-05', '2028-01-02'], 'began 290 days ago, the next one begins in 75: the next one');
  assert.deepEqual(days(e('Trip mar 5 - feb 1')), ['2027-03-05', '2028-02-01']);
  assert.deepEqual(days(e('Lease jan 1 - dec 31')), ['2027-01-01', '2027-12-31']);
  assert.deepEqual(days(e('School year sep 1 - jun 15')), ['2026-09-01', '2027-06-15'], 'began 82 days ago, the next one begins in 283: this one');
  // the half-year line: began 182 days ago (the next begins in 183) is this one, 183 days ago is the next
  assert.deepEqual(days(e('Trip may 24 - nov 30')), ['2026-05-24', '2026-11-30']);
  assert.deepEqual(days(e('Trip may 23 - nov 30')), ['2027-05-23', '2027-11-30']);
  // a range under way that began days ago is this one, a range that has ended is next year's
  assert.deepEqual(days(e('Vacation dec 20-28', { now: at(2026, 12, 22) })), ['2026-12-20', '2026-12-28']);
  assert.deepEqual(days(e('Vacation dec 20-28', { now: at(2026, 12, 29) })), ['2027-12-20', '2027-12-28']);
  assert.deepEqual(days(t('Trip dec 30 - jan 2', { now: at(2027, 1, 1) })), ['2026-12-30', '2027-01-02']);
  // an end that exists only in a leap year: the next range that fits in a year (was not read at all)
  assert.deepEqual(days(e('Trip mar 1 - feb 29')), ['2027-03-01', '2028-02-29']);
  // every range read has not ended, began at most half a year ago, and is at most a year long
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (const now of [at(2026, 11, 22), at(2027, 6, 30), at(2028, 2, 29), at(2026, 12, 31)]) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        const r = e(`Trip ${months[a]} 10 - ${months[b]} 9`, { now });
        if (!r.endDate) continue;
        assert.ok(r.endDate >= today && diffDays(r.date, today) <= 183 && diffDays(r.date, r.endDate) <= 366, `${months[a]} 10 - ${months[b]} 9 on ${today}: ${r.date}..${r.endDate}`);
      }
    }
  }
});
