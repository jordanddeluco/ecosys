import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, occurrencesBetween, describe } from '../shared/recur.js';

test('weekdays skip the weekend', () => {
  const r = { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] };
  assert.equal(nextOccurrence(r, '2026-11-27'), '2026-11-30'); // Fri → Mon
  assert.equal(describe(r), 'Weekdays');
});

test('every other week on Thursday', () => {
  const r = { freq: 'week', interval: 2, days: [4] };
  assert.deepEqual(occurrencesBetween(r, '2026-11-26', '2026-11-20', '2026-12-31'), ['2026-11-26', '2026-12-10', '2026-12-24']);
});

test('series far in the past still expands quickly and correctly', () => {
  const r = { freq: 'week', interval: 1, days: [1, 3] };
  assert.deepEqual(occurrencesBetween(r, '2020-01-06', '2026-11-22', '2026-11-28'), ['2026-11-23', '2026-11-25']);
  assert.deepEqual(occurrencesBetween({ freq: 'day', interval: 3 }, '2026-01-01', '2026-11-22', '2026-11-27'), ['2026-11-24', '2026-11-27']);
});

test('monthly on the 31st clamps to short months', () => {
  const r = { freq: 'month', interval: 1, monthDay: 31 };
  assert.deepEqual(occurrencesBetween(r, '2026-01-31', '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('exdates and until', () => {
  const r = { freq: 'day', interval: 1 };
  assert.deepEqual(occurrencesBetween(r, '2026-11-20', '2026-11-20', '2026-11-30', { exdates: ['2026-11-21'], until: '2026-11-23' }), ['2026-11-20', '2026-11-22', '2026-11-23']);
});

test('yearly birthdays', () => {
  assert.deepEqual(occurrencesBetween({ freq: 'year', interval: 1, monthDay: 26 }, '1990-11-26', '2026-11-01', '2027-12-31'), ['2026-11-26', '2027-11-26']);
});

// ---------------------------------------------------------------- completing repeating tasks
import { nextRepeatDates, snapToPattern, firstOnOrAfter, prevOnOrBefore, shiftRule } from '../shared/recur.js';

const monthly28 = { freq: 'month', interval: 1, monthDay: 28 };

test('monthly repeats never skip the current month (audit cases, today = 2026-11-22)', () => {
  // on schedule, date on the pattern
  assert.equal(nextRepeatDates({ date: '2026-11-28', repeat: monthly28 }, '2026-11-22').date, '2026-12-28');
  // on schedule, pulled earlier to today
  assert.equal(nextRepeatDates({ date: '2026-11-22', repeat: monthly28 }, '2026-11-22').date, '2026-12-28');
  // on schedule, postponed to Dec 3 (was: Jan 28)
  assert.equal(nextRepeatDates({ date: '2026-12-03', repeat: monthly28 }, '2026-11-22').date, '2026-12-28');
  // after done, completed late on Dec 2 (was: Jan 28)
  assert.equal(nextRepeatDates({ date: '2026-11-28', repeat: { ...monthly28, from: 'done' } }, '2026-12-02').date, '2026-12-28');
  // after done, completed early on Nov 22
  assert.equal(nextRepeatDates({ date: '2026-11-28', repeat: { ...monthly28, from: 'done' } }, '2026-11-22').date, '2026-12-28');
});

test('repeating tasks: no date, deadlines, overdue, early completion', () => {
  const daily = { freq: 'day', interval: 1 };
  assert.deepEqual(nextRepeatDates({ date: null, deadline: null, repeat: daily }, '2026-11-22'), { date: '2026-11-23', deadline: null });
  assert.deepEqual(nextRepeatDates({ date: null, deadline: '2026-11-22', repeat: daily }, '2026-11-22'), { date: null, deadline: '2026-11-23' });
  assert.deepEqual(nextRepeatDates({ date: '2026-11-22', deadline: '2026-11-24', repeat: daily }, '2026-11-22'), { date: '2026-11-23', deadline: '2026-11-25' });
  // overdue weekly task jumps to the next future occurrence
  assert.equal(nextRepeatDates({ date: '2026-11-02', repeat: { freq: 'week', interval: 1, days: [1] } }, '2026-11-22').date, '2026-11-23');
  // weekly "after done", completed early (Mon) for a Wednesday task: moves to next week, not the same day
  assert.equal(nextRepeatDates({ date: '2026-11-25', repeat: { freq: 'week', interval: 1, days: [3], from: 'done' } }, '2026-11-23').date, '2026-12-02');
});

test('pattern helpers for monthly and yearly rules', () => {
  assert.equal(snapToPattern(monthly28, '2026-12-03'), '2026-11-28');
  assert.equal(snapToPattern(monthly28, '2026-11-22'), '2026-11-28');
  assert.equal(snapToPattern({ freq: 'day', interval: 1 }, '2026-11-22'), '2026-11-22');
  assert.equal(prevOnOrBefore({ freq: 'month', monthDay: 31 }, '2026-03-15'), '2026-02-28');
  // yearly rules move to the next year, not the next month
  assert.equal(firstOnOrAfter({ freq: 'year', interval: 1, monthDay: 15 }, '2026-11-22'), '2027-11-15');
  assert.equal(firstOnOrAfter({ freq: 'year', interval: 1, monthDay: 15, month: 3 }, '2026-11-22'), '2027-03-15');
  assert.deepEqual(occurrencesBetween({ freq: 'year', interval: 1, month: 2, monthDay: 29 }, '2024-02-29', '2025-01-01', '2028-12-31'), ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  assert.equal(nextOccurrence({ freq: 'year', interval: 1, month: 2, monthDay: 29 }, '2024-02-29'), '2025-02-28');
});

test('the Yearly preset keeps its month: a postponed yearly task comes back on its own day', async () => {
  const { presets } = await import('../shared/recur.js');
  const yearly = presets('2026-03-15').find((p) => p.label === 'Yearly').rule;
  assert.deepEqual(yearly, { freq: 'year', interval: 1, monthDay: 15, month: 3 });
  assert.equal(describe(yearly), `Yearly on ${new Date(2024, 2, 15).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  // postponed from Mar 15 to Apr 2, then completed: next year on Mar 15 (not Apr 15)
  assert.equal(nextRepeatDates({ date: '2026-04-02', repeat: yearly }, '2026-04-02').date, '2027-03-15');
  assert.equal(nextRepeatDates({ date: '2026-03-15', repeat: yearly }, '2026-03-15').date, '2027-03-15');
});

test('a yearly series repeats on the day it starts, even if code that moved it left an old month in the rule', () => {
  // moved from Mar 2 to Apr 2 by a shiftRule that updates monthDay only
  assert.deepEqual(occurrencesBetween({ freq: 'year', interval: 1, monthDay: 2, month: 3 }, '2026-04-02', '2026-01-01', '2028-12-31'), ['2026-04-02', '2027-04-02', '2028-04-02']);
  assert.deepEqual(occurrencesBetween({ freq: 'year', interval: 2, monthDay: 31, month: 1 }, '2025-01-31', '2025-01-01', '2029-12-31'), ['2025-01-31', '2027-01-31', '2029-01-31']);
});

test('shiftRule keeps weekdays and day of month in step with a moved series', () => {
  assert.deepEqual(shiftRule({ freq: 'week', interval: 1, days: [1, 3] }, 1, '2026-11-24'), { freq: 'week', interval: 1, days: [2, 4] });
  assert.deepEqual(shiftRule({ freq: 'week', interval: 1, days: [6] }, 1, '2026-11-29'), { freq: 'week', interval: 1, days: [0] });
  assert.deepEqual(shiftRule({ freq: 'month', interval: 1, monthDay: 5 }, 3, '2026-12-08'), { freq: 'month', interval: 1, monthDay: 8 });
  assert.equal(shiftRule(null, 3), null);
});
