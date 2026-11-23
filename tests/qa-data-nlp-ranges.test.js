// QA (data): date ranges in quick add. "Vacation dec 20-28" used to make a one-day event on Dec 20
// titled "Vacation -28", and "Conference dec 3 to dec 5" one on Dec 3 titled "Conference to dec 5".
// With `ranges: true` (the callers that save a range pass it, see qa-data-nlp-ranges-optin) a range
// is read whole: an event gets `endDate` (its last day; all day, or timed from the start time on the
// first day to the end time on the last), a task the first day as its date and the last as its
// deadline. Numbers that are not a range ("pages 20-28", "3-5 dec 4") are read as before; a range
// that cannot be one ("jan 5 - jan 2", "feb 20-30") stays in the title, like "feb 30".
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../shared/nlp.js';
import { isYmd } from '../shared/sanitize.js';
import { addDaysYmd, diffDays } from '../shared/dates.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12);
const NOW = at(2026, 11, 22); // Sunday 22 November 2026
const e = (s, o = {}) => parse(s, { mode: 'event', now: NOW, ranges: true, ...o });
const t = (s, o = {}) => parse(s, { mode: 'task', now: NOW, ranges: true, ...o });
const span = (r) => ({ title: r.title, date: r.date, endDate: r.endDate, allDay: r.allDay, time: r.time });
const kinds = (r) => r.tokens.map((x) => `${x.kind}:${x.text}`);

test('events: "Vacation dec 20-28" is one all-day event over those days, with nothing left in the title', () => {
  assert.deepEqual(span(e('Vacation dec 20-28')), { title: 'Vacation', date: '2026-12-20', endDate: '2026-12-28', allDay: true, time: null });
  assert.deepEqual(kinds(e('Vacation dec 20-28')), ['date:dec 20-28'], 'one date token: the Create card keeps all of it on ×');
  assert.deepEqual(span(e('Conference dec 3 to dec 5')), { title: 'Conference', date: '2026-12-03', endDate: '2026-12-05', allDay: true, time: null });
  assert.deepEqual(span(e('Trip dec 30 - jan 2')), { title: 'Trip', date: '2026-12-30', endDate: '2027-01-02', allDay: true, time: null }, 'into the next year');
  // a single date has no endDate
  assert.equal(e('Holiday dec 25').endDate, null);
  assert.equal(t('Vacation dec 20-28').endDate, null, 'tasks never get an endDate');
});

test('events: the ways people write a range', () => {
  const dec = { date: '2026-12-20', endDate: '2026-12-28' };
  for (const s of [
    'Trip dec 20-28',
    'Trip dec 20 - 28',
    'Trip dec 20–28',
    'Trip dec 20 — dec 28',
    'Trip dec 20 to 28',
    'Trip from dec 20 to dec 28',
    'Trip between dec 20 and 28',
    'Trip dec 20 through 28',
    'Trip december 20 thru december 28',
    'Trip dec 20 until dec 28',
    'Trip dec 20 till 28',
    'Trip dec 20th - 28th',
    'Trip dec. 20 - 28',
    'Trip on dec 20-28',
    'Trip 20-28 dec',
    'Trip 20 to 28 december',
    'Trip 20 dec - 28 dec',
    'Trip the 20th to the 28th of december',
    'Trip 12/20-12/28',
    'Trip 12/20 - 12/28',
    'Trip 12/20-28',
    'Trip 2026-12-20 to 2026-12-28',
    'Trip 12/20/26 to 12/28/26',
  ]) {
    const r = e(s);
    assert.deepEqual({ title: r.title, date: r.date, endDate: r.endDate, allDay: r.allDay }, { title: 'Trip', ...dec, allDay: true }, s);
  }
  for (const s of ['Trip 20/12-28/12', 'Trip 20/12 - 28/12', 'Trip 20/12-28']) assert.deepEqual([e(s, { dmy: true }).date, e(s, { dmy: true }).endDate], ['2026-12-20', '2026-12-28'], `${s} (D/M)`);
  // years: on both ends, at the end (for both), or on one end (the other is the next / last such date)
  assert.deepEqual([e('Trip dec 20-28, 2027').date, e('Trip dec 20-28, 2027').endDate], ['2027-12-20', '2027-12-28']);
  assert.deepEqual([e('Trip 20-28 dec 2027').date, e('Trip 20-28 dec 2027').endDate], ['2027-12-20', '2027-12-28']);
  assert.deepEqual([e('Trip dec 30 - jan 2 2028').date, e('Trip dec 30 - jan 2 2028').endDate], ['2027-12-30', '2028-01-02']);
  assert.deepEqual([e('Trip dec 30 2027 - jan 2').date, e('Trip dec 30 2027 - jan 2').endDate], ['2027-12-30', '2028-01-02']);
  assert.deepEqual([e('Trip dec 30 2026 - dec 2 2027').date, e('Trip dec 30 2026 - dec 2 2027').endDate], ['2026-12-30', '2027-12-02'], 'as written');
  // a one-day range is that day
  assert.deepEqual([e('Trip dec 20-20').date, e('Trip dec 20-20').endDate], ['2026-12-20', '2026-12-20']);
});

test('without a year it is the next range that has not ended, or the one under way (when it began recently)', () => {
  assert.deepEqual([e('Vacation dec 20-28', { now: at(2026, 12, 22) }).date, e('Vacation dec 20-28', { now: at(2026, 12, 22) }).endDate], ['2026-12-20', '2026-12-28'], 'typed on Dec 22');
  assert.deepEqual([e('Vacation dec 20-28', { now: at(2026, 12, 28) }).date, e('Vacation dec 20-28', { now: at(2026, 12, 28) }).endDate], ['2026-12-20', '2026-12-28'], 'on its last day');
  assert.deepEqual([e('Vacation dec 20-28', { now: at(2026, 12, 29) }).date, e('Vacation dec 20-28', { now: at(2026, 12, 29) }).endDate], ['2027-12-20', '2027-12-28'], 'the day after: next year');
  assert.deepEqual([e('Trip dec 30 - jan 2', { now: at(2027, 1, 1) }).date, e('Trip dec 30 - jan 2', { now: at(2027, 1, 1) }).endDate], ['2026-12-30', '2027-01-02'], 'across the new year');
  // Feb 29 waits for a leap year, as a single date does
  assert.deepEqual([e('Leap feb 29 - mar 1').date, e('Leap feb 29 - mar 1').endDate], ['2028-02-29', '2028-03-01']);
});

test('tasks: the first day is the date and the last the deadline, as two tokens', () => {
  const r = t('Prep slides dec 3-5');
  assert.deepEqual({ title: r.title, date: r.date, deadline: r.deadline }, { title: 'Prep slides', date: '2026-12-03', deadline: '2026-12-05' });
  assert.deepEqual(kinds(r), ['date:dec 3', 'deadline:-5'], 'the deadline chip keeps only its own words on ×');
  const c = t('Conference prep from dec 3 to dec 5 9am');
  assert.deepEqual({ title: c.title, date: c.date, deadline: c.deadline, time: c.time }, { title: 'Conference prep', date: '2026-12-03', deadline: '2026-12-05', time: '09:00' });
  assert.deepEqual(kinds(c), ['date:from dec 3', 'deadline:to dec 5', 'time:9am']);
  assert.deepEqual([t('Trip 20-28 dec').date, t('Trip 20-28 dec').deadline, t('Trip 20-28 dec').title], ['2026-12-20', '2026-12-28', 'Trip']);
  // keeping the deadline's words (the chip's ×) quotes them: the first day is still the date
  const kept = t('Prep slides dec 3"-5"');
  assert.deepEqual([kept.title, kept.date, kept.deadline], ['Prep slides -5', '2026-12-03', null]);
});

test('events with a start and an end time run from the start on the first day to the end on the last', () => {
  const c = e('Conference dec 3-5 9am-5pm');
  assert.deepEqual(
    { date: c.date, endDate: c.endDate, time: c.time, endTime: c.endTime, duration: c.duration, allDay: c.allDay, title: c.title },
    { date: '2026-12-03', endDate: '2026-12-05', time: '09:00', endTime: '17:00', duration: 2 * 1440 + 480, allDay: false, title: 'Conference' },
  );
  assert.equal(e('Party dec 31 - jan 1 10pm-2am').duration, 240, 'over midnight into the next year');
  assert.equal(e('Course dec 1-15 6pm-5pm').duration, 14 * 1440 - 60, 'a timed event can be 14 days long');
  // (a lone time, a typed length or more than 14 days: only the first day, see qa-data-nlp-ranges-edges)
  assert.deepEqual(span(e('Retreat dec 3-5 all day 9am')), { title: 'Retreat', date: '2026-12-03', endDate: '2026-12-05', allDay: true, time: null });
  // a place before or after the range
  for (const s of ['Trip dec 3-5 at Cabin Lodge', 'Trip at Cabin Lodge dec 3-5']) assert.deepEqual([e(s).location, e(s).title, e(s).endDate], ['Cabin Lodge', 'Trip', '2026-12-05'], s);
});

test('numbers that are not a range are read as before', () => {
  for (const [s, title, date] of [
    ['Read chapters 2-3', 'Read chapters 2-3', null],
    ['Read pages 20-28', 'Read pages 20-28', null],
    ['Work 9-5', 'Work 9-5', null],
    ['Read pages 3-5 dec 4', 'Read pages 3-5', '2026-12-04'],
    ['Work 9-5 dec 3', 'Work 9-5', '2026-12-03'],
    ['Meeting dec 3 - 2 hours', 'Meeting - 2 hours', '2026-12-03'],
    ['Gift dec 3 and dec 5', 'Gift and dec 5', '2026-12-03'],
    ['Vacation dec 30-2', 'Vacation -2', '2026-12-30'],
    ['Party 12/5', 'Party', '2026-12-05'],
    ['Party 2026-12-31', 'Party', '2026-12-31'],
    ['Party 12/5/2026', 'Party', '2026-12-05'],
  ]) {
    const r = t(s);
    assert.deepEqual({ title: r.title, date: r.date, deadline: r.deadline }, { title, date, deadline: null }, s);
  }
  // a repeat's dates: only the first day is read, as before (its days come from the repeat)
  const s = e('Standup every weekday dec 1-5');
  assert.deepEqual([s.date, s.endDate, s.repeat.days], ['2026-12-01', null, [1, 2, 3, 4, 5]]);
  // a day already read wins
  assert.deepEqual([t('Prep tomorrow dec 3-5').date, t('Prep tomorrow dec 3-5').deadline], ['2026-11-23', null]);
});

test('a backwards, impossible or over-a-year range is not read and stays in the title (also not as a place)', () => {
  for (const s of ['Trip jan 5 - jan 2', 'Trip jan 5 - jan 2 2027', 'Trip feb 20-30', 'Trip feb 30 - mar 2', 'Trip apr 31 - may 2', 'Trip dec 5 2027 - dec 3 2027', 'Trip dec 3 2026 - dec 5 2028', 'Trip 2026-02-27 to 2026-02-30']) {
    for (const r of [t(s), e(s)]) assert.deepEqual({ title: r.title, date: r.date, endDate: r.endDate, deadline: r.deadline }, { title: s, date: null, endDate: null, deadline: null }, s);
  }
  const at2 = e('Party at feb 20-30');
  assert.deepEqual([at2.location, at2.date, at2.title], [null, null, 'Party at feb 20-30']);
});

test('the result goes straight into the model: createEvent saves the span, createTask the date and deadline', async () => {
  // shared/store.js in memory, as tests/qa-model-quickadd.test.js runs it
  globalThis.window ??= new EventTarget();
  globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const mem = new Map();
  const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
  const M = await import('../shared/model.js');
  const pick = (x) => ({ title: x.title, allDay: x.allDay, start: x.start, end: x.end });
  assert.deepEqual(pick(M.createEvent(e('Vacation dec 20-28'))), { title: 'Vacation', allDay: true, start: '2026-12-20', end: '2026-12-28' });
  assert.deepEqual(pick(M.createEvent(e('Trip dec 30 - jan 2'))), { title: 'Trip', allDay: true, start: '2026-12-30', end: '2027-01-02' });
  assert.deepEqual(pick(M.createEvent(e('Conference dec 3-5 9am-5pm'))), { title: 'Conference', allDay: false, start: '2026-12-03T09:00', end: '2026-12-05T17:00' });
  const task = M.createTask(t('Prep slides dec 3-5'));
  assert.deepEqual({ title: task.title, date: task.date, deadline: task.deadline }, { title: 'Prep slides', date: '2026-12-03', deadline: '2026-12-05' });
});

test('every range read is a real stored date span: date ≤ endDate (or deadline) ≤ date + 366 days', () => {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (const now of [at(2026, 11, 22), at(2027, 2, 28), at(2028, 2, 29), at(2026, 12, 31), at(9999, 12, 20), at(1000, 1, 1)]) {
    for (let m1 = 0; m1 < 12; m1 += 1) {
      for (const [d1, d2, m2] of [[1, 3, m1], [28, 31, m1], [29, 2, (m1 + 1) % 12], [31, 1, (m1 + 1) % 12], [15, 15, (m1 + 6) % 12]]) {
        const s = `Trip ${months[m1]} ${d1} - ${months[m2]} ${d2}`;
        const ev = e(s, { now });
        if (ev.endDate !== null) {
          assert.ok(isYmd(ev.date) && isYmd(ev.endDate) && ev.date <= ev.endDate && diffDays(ev.date, ev.endDate) <= 366, `${s} → ${ev.date}..${ev.endDate}`);
          assert.ok(ev.endDate >= addDaysYmd(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, 0), `${s}: has not ended`);
          assert.equal(ev.title, 'Trip', s);
        } else assert.equal(ev.date, null, `${s}: a range is read whole or not at all (date ${ev.date})`);
        const tk = t(s, { now });
        assert.deepEqual([tk.date, tk.deadline], [ev.date, ev.endDate], `${s}: a task reads the same days`);
      }
    }
  }
});
