// QA (data, second pass): a run of weekdays in a repeat. "Gym every mon-fri" repeated on Mondays only
// and started on a Friday (the "fri" after the dash was read as the first date), the same silent guess
// as the weekday lists fixed in the first pass. A run is every day from its first to its last, over
// the weekend when it gets there ("fri-sun"), alone or in a list ("mon-wed, fri").
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../shared/nlp.js';
import { parseRepeat, clock } from '../server/model.mjs';

const NOW = new Date(2026, 10, 22, 12); // Sunday 22 November 2026
const t = (s) => parse(s, { mode: 'task', now: NOW });
const rep = (r) => ({ title: r.title, date: r.date, days: r.repeat?.days, interval: r.repeat?.interval });

test('every mon-fri repeats on every day of the run and starts on the first of them', () => {
  for (const [s, days, date] of [
    ['Gym every mon-fri', [1, 2, 3, 4, 5], '2026-11-23'],
    ['Gym every mon - fri', [1, 2, 3, 4, 5], '2026-11-23'],
    ['Gym every mon–fri', [1, 2, 3, 4, 5], '2026-11-23'],
    ['Gym every monday-friday', [1, 2, 3, 4, 5], '2026-11-23'],
    ['Gym every monday to friday', [1, 2, 3, 4, 5], '2026-11-23'],
    ['Gym every tue through thu', [2, 3, 4], '2026-11-24'],
    ['Gym every tue thru thu', [2, 3, 4], '2026-11-24'],
    ['Gym every fri-sun', [0, 5, 6], '2026-11-22'],
    ['Gym every sat-mon', [0, 1, 6], '2026-11-22'],
    ['Gym every sun-sat', [0, 1, 2, 3, 4, 5, 6], '2026-11-22'],
    ['Gym every mon-wed, fri', [1, 2, 3, 5], '2026-11-23'],
    ['Gym every mon-wed and fri', [1, 2, 3, 5], '2026-11-23'],
    ['Gym every mon, wed-fri', [1, 3, 4, 5], '2026-11-23'],
    ['Gym every tue/thu-sat', [2, 4, 5, 6], '2026-11-24'],
  ]) assert.deepEqual(rep(t(s)), { title: 'Gym', date, days, interval: 1 }, s);
  assert.deepEqual(rep(t('Gym every other tue-thu')), { title: 'Gym', date: '2026-11-24', days: [2, 3, 4], interval: 2 });
  assert.deepEqual(rep(t('Gym weekly on mon-fri')), { title: 'Gym', date: '2026-11-23', days: [1, 2, 3, 4, 5], interval: 1 });
  assert.deepEqual(rep(t('Gym every 2 weeks on mon-wed')), { title: 'Gym', date: '2026-11-23', days: [1, 2, 3], interval: 2 });
  assert.deepEqual(rep(t('Gym biweekly on thu - sat')), { title: 'Gym', date: '2026-11-26', days: [4, 5, 6], interval: 2 });
  const timed = t('Gym every mon-fri 7am');
  assert.deepEqual([timed.title, timed.time, timed.repeat.days], ['Gym', '07:00', [1, 2, 3, 4, 5]]);
  const ev = parse('Standup every mon-thu 9:30am for 15m', { mode: 'event', now: NOW });
  assert.deepEqual([ev.title, ev.date, ev.time, ev.duration, ev.repeat.days], ['Standup', '2026-11-23', '09:30', 15, [1, 2, 3, 4]]);
});

test('words after a day that are not a run stay in the title', () => {
  assert.deepEqual(rep(t('Gym every mon wedding')), { title: 'Gym wedding', date: '2026-11-23', days: [1], interval: 1 });
  assert.deepEqual(rep(t('Gym every mon to the gym')), { title: 'Gym to the gym', date: '2026-11-23', days: [1], interval: 1 });
  assert.deepEqual(rep(t('Gym every mon-mon')), { title: 'Gym', date: '2026-11-23', days: [1], interval: 1 });
});

test('the server reads the same runs as a repeat (repeat: "every mon-fri")', () => {
  const c = clock(NOW);
  assert.deepEqual(parseRepeat('every mon-fri', c, '2026-11-23').rule.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseRepeat('weekly on fri-sun', c, '2026-11-27').rule.days, [0, 5, 6]);
  assert.deepEqual(parseRepeat('every 2 weeks on mon - wed', c, '2026-11-23').rule, { freq: 'week', interval: 2, days: [1, 2, 3] });
});
