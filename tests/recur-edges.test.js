// shared/recur.js edge cases the QA fuzz suite found (tests/fuzz/lib/recur-props.js): completing a
// repeating task that is far overdue (the next date used to stop after 5000 steps, in the past), and
// monthly/yearly series whose start is not on their pattern (the start, RFC 5545's DTSTART, was left
// out). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRepeatDates, nextOccurrence, occurrencesBetween, snapToPattern } from '../shared/recur.js';
import { addDaysYmd, diffDays, todayYmd } from '../shared/dates.js';

/** nextRepeatDates as it was, but stepping one occurrence at a time with no cap: the answer to match. */
function stepped(task, today) {
  const rule = task.repeat;
  const anchor = task.date || task.deadline || today;
  let next = nextOccurrence(rule, snapToPattern(rule, rule.from === 'done' ? today : anchor));
  while (next <= today) next = nextOccurrence(rule, next);
  if (rule.from === 'done' && task.date && next === task.date) next = nextOccurrence(rule, next);
  const shift = diffDays(anchor, next);
  return { date: task.date ? addDaysYmd(task.date, shift) : task.deadline ? null : next, deadline: task.deadline ? addDaysYmd(task.deadline, shift) : null };
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

test('completing a task overdue by decades moves it after today (it used to stop after 5000 steps, in the past)', () => {
  // the QA repros: 2013-09-10 and 1995-03-24 before
  assert.deepEqual(nextRepeatDates({ date: '2000-01-01', repeat: { freq: 'day', interval: 1 } }, '2026-11-22'), { date: '2026-11-23', deadline: null });
  assert.deepEqual(nextRepeatDates({ date: '1981-07-14', repeat: { freq: 'week', interval: 1, days: ALL_DAYS, from: 'due' } }, '2017-03-11'), { date: '2017-03-12', deadline: null });
  // the pattern keeps its phase: every 3 days from 2000-01-01 is ... 2026-11-22 + 3
  assert.equal(nextRepeatDates({ date: '2000-01-01', repeat: { freq: 'day', interval: 3 } }, '2026-11-22').date, '2026-11-25');
  assert.equal(nextRepeatDates({ date: '1990-01-01', repeat: { freq: 'week', interval: 1, days: WEEKDAYS } }, '2026-11-22').date, '2026-11-23');
  // every other week on Tue + Thu since Tue 1995-01-03: 2026-11-24 is an off week, so Dec 1
  const biweekly = { freq: 'week', interval: 2, days: [2, 4] };
  assert.equal(nextRepeatDates({ date: '1995-01-03', repeat: biweekly }, '2026-11-22').date, stepped({ date: '1995-01-03', repeat: biweekly }, '2026-11-22').date);
  assert.equal(nextRepeatDates({ date: '1990-01-31', repeat: { freq: 'month', interval: 1, monthDay: 31 } }, '2026-11-22').date, '2026-11-30');
  assert.equal(nextRepeatDates({ date: '1904-02-29', repeat: { freq: 'year', interval: 1, monthDay: 29, month: 2 } }, '2026-11-22').date, '2027-02-28');
  assert.equal(nextRepeatDates({ date: '1904-02-29', repeat: { freq: 'year', interval: 4, monthDay: 29, month: 2 } }, '2026-11-22').date, '2028-02-29');
  // a deadline moves with the date (the gap is kept); an undated task's deadline moves on its own
  assert.deepEqual(nextRepeatDates({ date: '1990-03-01', deadline: '1990-03-04', repeat: { freq: 'day', interval: 7 } }, '2026-11-22'), stepped({ date: '1990-03-01', deadline: '1990-03-04', repeat: { freq: 'day', interval: 7 } }, '2026-11-22'));
  assert.deepEqual(nextRepeatDates({ date: null, deadline: '1985-06-15', repeat: { freq: 'month', interval: 1, monthDay: 15 } }, '2026-11-22'), { date: null, deadline: '2026-12-15' });
});

test('the fast-forward gives exactly the dates of stepping one occurrence at a time (any rule, long overdue)', () => {
  // (the reference steps one at a time, so daily and weekly rules get shorter overdue spans here;
  // the test above has them decades overdue)
  const short = [];
  for (const interval of [1, 2, 7]) short.push({ freq: 'day', interval });
  for (const interval of [1, 3]) short.push({ freq: 'week', interval });
  for (const days of [[1, 3, 5], ALL_DAYS, [0, 6]]) for (const interval of [1, 2]) short.push({ freq: 'week', interval, days });
  // monthly/yearly with and without a monthDay: without one the day can move at month ends (Jan 31 → Feb 28 → Mar 28)
  const long = [];
  for (const monthDay of [undefined, 15, 29, 31]) for (const interval of [1, 6]) long.push({ freq: 'month', interval, ...(monthDay ? { monthDay } : {}) });
  for (const monthDay of [undefined, 29, 31]) for (const month of [undefined, 2]) for (const interval of [1, 4]) long.push({ freq: 'year', interval, ...(monthDay ? { monthDay } : {}), ...(month ? { month } : {}) });
  let cases = 0;
  for (const [rules, dates] of [[short, ['2024-02-29', '2025-08-31', '2026-11-20', null]], [long, ['1996-01-31', '1996-02-29', '2004-08-30', '2026-11-20', null]]]) {
    for (const rule of rules) {
      for (const from of [undefined, 'done']) {
        const r = from ? { ...rule, from } : rule;
        for (const date of dates) {
          for (const today of ['2026-11-22', '2028-02-29']) {
            for (const deadline of [null, date ? addDaysYmd(date, 3) : '2001-05-31']) {
              const task = { date, deadline, repeat: r };
              const got = nextRepeatDates(task, today);
              assert.deepEqual(got, stepped(task, today), `today ${today}, task ${JSON.stringify(task)}`);
              assert.ok((got.date ?? got.deadline) > today, `not after today: ${JSON.stringify(got)}`);
              cases++;
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 1000, `${cases} cases`);
});

test('completing a task overdue by thousands of years is quick and lands after today', () => {
  const t0 = performance.now();
  const today = '9999-01-15';
  for (const repeat of [{ freq: 'day', interval: 1 }, { freq: 'week', interval: 1, days: [1, 3, 5] }, { freq: 'week', interval: 3 }, { freq: 'month', interval: 1, monthDay: 31 }, { freq: 'year', interval: 1, monthDay: 29, month: 2 }]) {
    const r = nextRepeatDates({ date: '1000-01-06', repeat }, today);
    assert.ok(r.date > today && r.date <= '9999-12-31', `${JSON.stringify(repeat)} → ${r.date}`);
  }
  assert.equal(nextRepeatDates({ date: '1000-01-01', repeat: { freq: 'day', interval: 1 } }, today).date, '9999-01-16');
  assert.equal(nextRepeatDates({ date: '1000-01-06', repeat: { freq: 'year', interval: 1, monthDay: 29, month: 2 } }, today).date, '9999-02-28');
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
});

test('a malformed today (a date-time, a Date, no date at all) is quick and gives the right date', () => {
  // '2026-11-22T10:00' compared as a string is "later" than every date: the search ran to its
  // 1e6-step guard (2.3 s on the main thread) and returned 4764-10-18
  const daily = { date: '2026-11-20', repeat: { freq: 'day', interval: 1 } };
  const t0 = performance.now();
  assert.deepEqual(nextRepeatDates(daily, '2026-11-22T10:00'), { date: '2026-11-23', deadline: null });
  assert.deepEqual(nextRepeatDates(daily, '2026-11-22T10:00:00.000Z'), { date: '2026-11-23', deadline: null });
  assert.deepEqual(nextRepeatDates(daily, new Date(2026, 10, 22, 10)), { date: '2026-11-23', deadline: null });
  assert.deepEqual(nextRepeatDates({ date: '2000-01-01', repeat: { freq: 'day', interval: 1 } }, '2026-11-22T23:59'), { date: '2026-11-23', deadline: null });
  assert.deepEqual(nextRepeatDates({ date: '2026-11-02', repeat: { freq: 'month', interval: 1, monthDay: 2 }, deadline: '2026-11-05' }, '2026-11-22T08:00'), { date: '2026-12-02', deadline: '2026-12-05' });
  // a today that names no date means the current date
  for (const bad of [undefined, null, '', 'soon', '2026-13-45', 42, '10000-01-01', new Date(NaN)]) {
    const before = todayYmd();
    const got = nextRepeatDates({ date: null, repeat: { freq: 'day', interval: 1 } }, bad);
    assert.ok([addDaysYmd(before, 1), addDaysYmd(todayYmd(), 1)].includes(got.date) && got.deadline === null, `${String(bad)} → ${JSON.stringify(got)}`);
  }
  // a task date that is a date-time counts as its date; one that is no date at all counts as none
  assert.deepEqual(nextRepeatDates({ date: '2026-11-20T09:00', repeat: { freq: 'day', interval: 1 } }, '2026-11-22'), { date: '2026-11-23', deadline: null });
  assert.deepEqual(nextRepeatDates({ date: 'someday', repeat: { freq: 'day', interval: 2 } }, '2026-11-22'), { date: '2026-11-24', deadline: null });
  assert.deepEqual(nextRepeatDates({ date: '2026-11-20', deadline: 'NaN-NaN-NaN', repeat: { freq: 'day', interval: 1 } }, '2026-11-22'), { date: '2026-11-23', deadline: null });
  // a rule the validators would never keep (weekday -1) cannot loop either
  const odd = nextRepeatDates({ date: '2026-11-21', repeat: { freq: 'week', interval: 1, days: [-1] } }, '2026-11-22');
  assert.equal(typeof odd.date, 'string');
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `${ms.toFixed(0)} ms`);
});

test('a monthly or yearly series always has its start date (RFC 5545 DTSTART), then its pattern', () => {
  // the QA repros: the start was missing, the first date was 1972-10-25 / 2026-12-15
  assert.deepEqual(occurrencesBetween({ freq: 'year', interval: 1, monthDay: 25 }, '1972-10-12', '1972-10-01', '1973-12-31'), ['1972-10-12', '1972-10-25', '1973-10-25']);
  assert.deepEqual(occurrencesBetween({ freq: 'month', interval: 1, monthDay: 15 }, '2026-11-22', '2026-11-01', '2027-01-31'), ['2026-11-22', '2026-12-15', '2027-01-15']);
  assert.deepEqual(occurrencesBetween({ freq: 'month', interval: 2, monthDay: 10 }, '2026-11-22', '2026-11-22', '2027-03-31'), ['2026-11-22', '2027-01-10', '2027-03-10']);
  // like a weekly series that starts off its weekdays (the control)
  assert.deepEqual(occurrencesBetween({ freq: 'week', interval: 1, days: [1] }, '2026-11-24', '2026-11-01', '2026-12-08'), ['2026-11-24', '2026-11-30', '2026-12-07']);
  // a start on its pattern is listed once (also when monthDay is clamped to a short month)
  assert.deepEqual(occurrencesBetween({ freq: 'month', interval: 1, monthDay: 15 }, '2026-11-15', '2026-11-01', '2027-01-31'), ['2026-11-15', '2026-12-15', '2027-01-15']);
  assert.deepEqual(occurrencesBetween({ freq: 'month', interval: 1, monthDay: 31 }, '2027-02-28', '2027-02-01', '2027-04-30'), ['2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(occurrencesBetween({ freq: 'year', interval: 1, monthDay: 29 }, '2027-02-28', '2027-01-01', '2028-12-31'), ['2027-02-28', '2028-02-29']);
});

test('the start of a series follows the window, exdates and until like any other occurrence', () => {
  const rule = { freq: 'month', interval: 1, monthDay: 15 };
  assert.deepEqual(occurrencesBetween(rule, '2026-11-22', '2026-11-23', '2027-01-31'), ['2026-12-15', '2027-01-15'], 'a window after the start');
  assert.deepEqual(occurrencesBetween(rule, '2026-11-22', '2026-11-01', '2026-11-22'), ['2026-11-22'], 'a window ending on the start');
  assert.deepEqual(occurrencesBetween(rule, '2026-11-22', '2026-11-01', '2026-11-21'), [], 'a window before the start');
  assert.deepEqual(occurrencesBetween(rule, '2026-11-22', '2026-11-01', '2027-01-31', { exdates: ['2026-11-22'] }), ['2026-12-15', '2027-01-15'], 'an exdate on the start');
  assert.deepEqual(occurrencesBetween(rule, '2026-11-22', '2026-11-01', '2027-01-31', { until: '2026-12-01' }), ['2026-11-22'], 'until before the next one');
  assert.deepEqual(occurrencesBetween(rule, '2026-11-22', '2026-11-01', '2027-01-31', { until: '2026-11-21' }), [], 'until before the start');
  // windows split anywhere add up to the whole (the start appears exactly once)
  const whole = occurrencesBetween(rule, '2026-11-22', '2026-10-01', '2027-06-30');
  for (let mid = '2026-10-01'; mid < '2027-06-30'; mid = addDaysYmd(mid, 1)) {
    assert.deepEqual([...occurrencesBetween(rule, '2026-11-22', '2026-10-01', mid), ...occurrencesBetween(rule, '2026-11-22', addDaysYmd(mid, 1), '2027-06-30')], whole, `split after ${mid}`);
  }
});
