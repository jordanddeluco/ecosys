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
