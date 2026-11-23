// shared/nlp.js dates: parse() only ever returns real 'YYYY-MM-DD' dates in years 1000-9999 (the stored
// range, shared/sanitize.js isYmd), reads an explicit date exactly or not at all, and caps repeat
// intervals at 99 like the server. Regression tests for the defects the QA fuzz suite found
// (tests/fuzz/nlp.fuzz.test.js and tests/fuzz/regressions.fuzz.test.js), and for the problems the
// verifier found in those fixes. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../shared/nlp.js';
import { ymd, parseYmd, addDaysYmd, hour12, setHour12, fmtTime } from '../shared/dates.js';
import { isYmd, validateRepeat } from '../shared/sanitize.js';
import { parseDate, parseWhen, validYmd, ToolError } from '../server/model.mjs';

const at = (y, m, d) => new Date(y, m - 1, d, 12);
const NOW = at(2026, 11, 22); // a Sunday
const p = (s, o = {}) => parse(s, { mode: 'task', now: NOW, ...o });
/** Not read as a date at all: no date or deadline, and the whole text stays in the title. */
const unread = (s, o = {}) => {
  const r = p(s, o);
  assert.deepEqual({ date: r.date, deadline: r.deadline, title: r.title }, { date: null, deadline: null, title: s }, s);
};

test('a year before 1000 is not read (it used to come out unpadded: "5/1/0491" gave "491-05-01")', () => {
  for (const s of ['Party 5/1/0491', 'Party 0392-3-1', 'Party 0999-12-31', 'Party dec 5 0999', 'Party 5 may 0491', 'Party may 5, 0491']) unread(s);
  unread('Party 1/5/0491', { dmy: true });
  // and the first stored year still works
  assert.equal(p('Party 1000-01-01').date, '1000-01-01');
  assert.equal(p('Party jan 1 1000').date, '1000-01-01');
  assert.equal(p('Party 9999-12-31').date, '9999-12-31');
});

test('a four-digit year is taken as written (0058 is not 1958, 0001 is not 2001); a two-digit year is 20xx', () => {
  unread('Party 28 january 0058');
  unread('Party 0099-12-31');
  unread('Party 12/5/0001');
  unread('Party 28/1/0058', { dmy: true });
  assert.equal(p('Party 1/28/1058').date, '1058-01-28');
  assert.equal(p('Party 12/5/01').date, '2001-12-05');
  assert.equal(p('Party 12/5/26').date, '2026-12-05');
  assert.equal(p('Party 5/12/26', { dmy: true }).date, '2026-12-05');
});

test('Feb 29 and month lengths are checked against the actual year (2/29/2026 is not March 1)', () => {
  for (const s of ['Party 2/29/2026', 'Party 2/29/9402', 'Party 2/29/2100', 'Party 2026-02-29', 'Party feb 29 2026', 'Party 29 february 2026', 'Party feb 29, 2100', 'Party 4/31/2027', 'Party 2027-04-31', 'Party 31 april 2027', 'Party june 31 2027']) unread(s);
  unread('Party 29/2/2026', { dmy: true });
  for (const [s, want] of [['Party 2/29/2028', '2028-02-29'], ['Party 2/29/2000', '2000-02-29'], ['Party feb 29 2000', '2000-02-29'], ['Party 2028-2-29', '2028-02-29'], ['Party 29 feb 2400', '2400-02-29']]) assert.equal(p(s).date, want, s);
  assert.equal(p('Party 29/2/2028', { dmy: true }).date, '2028-02-29');
});

test('a month and day without a year is the next one that exists: Feb 29 waits for a leap year, April 31 is not a date', () => {
  assert.equal(p('Leap party feb 29').date, '2028-02-29');
  assert.equal(p('Leap party 2/29').date, '2028-02-29');
  assert.equal(p('Leap party 29 february').date, '2028-02-29');
  assert.equal(p('Leap party feb 29', { now: at(2028, 2, 29) }).date, '2028-02-29', 'today');
  assert.equal(p('Leap party feb 29', { now: at(2028, 3, 1) }).date, '2032-02-29', 'not clamped to Feb 28 of the next year');
  assert.equal(p('Leap party feb 29', { now: at(2096, 3, 1) }).date, '2104-02-29', '2100 is not a leap year');
  assert.equal(p('Pay by 2/29').deadline, '2028-02-29');
  for (const s of ['Party april 31', 'Party 31 april', 'Party 4/31', 'Party 2/30', 'Party 30 feb', 'Party sept 31']) unread(s);
  // ordinary dates are unchanged: this year, or next year once passed
  assert.equal(p('Taxes april 15').date, '2027-04-15');
  assert.equal(p('Call bank 12/3').date, '2026-12-03');
  assert.equal(p('Holiday dec 25').date, '2026-12-25');
  assert.equal(p('Today nov 22').date, '2026-11-22');
});

test('"the Nth" is the next month that has that day (on Jan 31, "the 30th" is Mar 30, not Mar 1)', () => {
  assert.equal(p('Pay rent the 30th', { now: at(2028, 1, 31) }).date, '2028-03-30');
  assert.equal(p('Pay rent the 29th', { now: at(2027, 1, 31) }).date, '2027-03-29');
  assert.equal(p('Pay rent the 29th', { now: at(2028, 1, 31) }).date, '2028-02-29');
  assert.equal(p('Pay rent the 31st', { now: at(2026, 4, 15) }).date, '2026-05-31');
  assert.equal(p('Pay rent the 31st', { now: at(2026, 6, 1) }).date, '2026-07-31');
  assert.equal(p('Pay rent the 31st', { now: at(2026, 12, 31) }).date, '2026-12-31');
  assert.equal(p('Pay rent the 1st', { now: at(2026, 12, 31) }).date, '2027-01-01');
  assert.equal(p('Pay by the 30th', { now: at(2027, 2, 10) }).deadline, '2027-03-30');
  assert.equal(p('Pay rent the 15th').date, '2026-12-15');
  // every day of a common and a leap year, N = 28..31: the first date on or after today with that day
  for (let day = '2027-01-01'; day <= '2028-12-31'; day = addDaysYmd(day, 1)) {
    const [y, m, d] = day.split('-').map(Number);
    for (const n of [28, 29, 30, 31]) {
      let want = day;
      while (+want.slice(8) !== n) want = addDaysYmd(want, 1);
      assert.equal(p(`Pay rent the ${n}th`, { now: at(y, m, d) }).date, want, `today ${day}, the ${n}th`);
    }
  }
});

test('an impossible written-out date is not read, and no part of it is read as another date', () => {
  // "the 29th" used to be read on its own: date 2026-11-29, title "Party of february 2026"
  for (const s of ['Party the 29th of february 2026', 'Party the 31st of june', 'Party the 31st of april 2027', 'Party the 30th of feb', 'Party june 31', 'Party 31 sept', 'Due the 31st of june']) unread(s);
  unread('Party the 31st of june', { mode: 'event' });
  // the phrases around it are still read
  const r = p('Party the 31st of june friday 5pm');
  assert.deepEqual([r.date, r.time, r.title], ['2026-11-27', '17:00', 'Party the 31st of june']);
  const e = parse('Dinner the 30th of feb at Cafe Luna', { mode: 'event', now: NOW });
  assert.deepEqual([e.date, e.location, e.title], [null, 'Cafe Luna', 'Dinner the 30th of feb']);
});

test('huge relative offsets give no date (never "NaN-NaN-NaN" or a 5-digit year); far ones that can be stored still work', () => {
  for (const s of ['Trip in 381894475 years', 'Trip in 8000 years', 'Trip in 7974 years', 'Report in 99999999999 days', 'Report in 9999999999999999999999999 weeks', 'Trip by in 100000000 months']) unread(s);
  assert.equal(p('Trip in 7973 years').date, '9999-11-22', 'the last stored year');
  assert.equal(p('Trip in 300 years').date, '2326-11-22');
  assert.equal(p('Trip in 1000 months').date, '2110-03-22');
  assert.equal(p('Trip in 1000 weeks').date, '2046-01-21');
  assert.equal(p('Trip in 3 days').date, '2026-11-25');
  assert.equal(p('Trip by in 2 weeks').deadline, '2026-12-06');
});

test('relative dates stop at the end of the stored range (today is 9999-12-31)', () => {
  const end = { now: at(9999, 12, 31) };
  assert.equal(p('Plan today', end).date, '9999-12-31');
  for (const s of ['Plan tomorrow', 'Plan next week', 'Plan next year', 'Plan the 5th', 'Plan in 2 days', 'Plan monday']) unread(s, end);
  assert.equal(p('Plan friday', end).date, '9999-12-31');
  const r = p('Water daily', end);
  assert.deepEqual([r.date, r.repeat], ['9999-12-31', { freq: 'day', interval: 1 }]);
  const w = p('Water every monday', end);
  assert.equal(w.date, '9999-12-31', 'the first monday would be in year 10000, so the repeat starts today');
  assert.ok(isYmd(w.date) && w.repeat.days.every((d) => Number.isInteger(d)));
});

test('repeat intervals go up to 99, like the server; larger ones are not read as a repeat (never stored as another interval)', () => {
  assert.deepEqual(p('Water plants every 99 days').repeat, { freq: 'day', interval: 99 });
  assert.deepEqual(p('Review every 52 weeks').repeat, { freq: 'week', interval: 52, days: [0] });
  for (const s of ['Water plants every 100 days', 'Water plants every 1000 days', 'Review every 582851674324 weeks', 'Bill every 365 months', 'Renew every 100 years', 'Water every 0 days']) {
    const r = p(s);
    assert.deepEqual([r.repeat, r.title], [null, s], s);
  }
  for (let n = 1; n <= 120; n++) {
    const r = p(`Water every ${n} days`);
    assert.equal(r.repeat?.interval ?? null, n <= 99 ? n : null, `every ${n} days`);
    if (r.repeat) assert.deepEqual(validateRepeat(r.repeat), r.repeat, `validateRepeat keeps "every ${n} days"`);
  }
});

test('a repeat always gets real weekdays and day of month (no weekday NaN from a malformed date: "2/9/0211 weekly")', () => {
  const r = parse('2/9/0211 weekly', { mode: 'event', now: NOW });
  assert.deepEqual([r.date, r.repeat, r.title, r.allDay], ['2026-11-22', { freq: 'week', interval: 1, days: [0] }, '2/9/0211', true]);
  assert.deepEqual(p('Pay 0392-3-1 monthly').repeat, { freq: 'month', interval: 1, monthDay: 22 });
  assert.deepEqual(p('Party 2/29/2026 yearly').repeat, { freq: 'year', interval: 1, monthDay: 22, month: 11 });
  assert.deepEqual(p('Party 2/29/2028 yearly').repeat, { freq: 'year', interval: 1, monthDay: 29, month: 2 });
});

test('an invalid `now` does not give NaN dates (the current time is used)', () => {
  const r = parse('Call mom tomorrow 6pm', { mode: 'task', now: new Date(NaN) });
  assert.ok(isYmd(r.date), `date ${r.date}`);
  assert.equal(r.title, 'Call mom');
  assert.equal(parse('Call mom tomorrow', { now: NOW.getTime() }).date, '2026-11-23', 'a timestamp works like a Date');
});

test('every numeric date shape with edge values gives a stored date or none', () => {
  const ys = ['0000', '0001', '0058', '0099', '0100', '0999', '1000', '2026', '2100', '9999'];
  const ms = ['0', '1', '2', '02', '4', '12', '13'];
  const ds = ['0', '1', '28', '29', '30', '31', '32'];
  for (const y of ys) for (const m of ms) for (const d of ds) {
    for (const s of [`${y}-${m}-${d}`, `${m}/${d}/${y}`, `${m}/${d}/${y.slice(2)}`, `${m}/${d}`]) {
      for (const o of [{}, { dmy: true }, { mode: 'event' }]) {
        const r = p(`Party ${s}`, o);
        for (const k of ['date', 'deadline']) assert.ok(r[k] === null || isYmd(r[k]), `"Party ${s}" ${JSON.stringify(o)} → ${k} ${r[k]}`);
      }
    }
  }
});

test('dates.js ymd does not pad a year below 1000, so a round trip still rejects "0491-05-01" (server validYmd, the apps\' isYmd)', () => {
  // ymd() once zero-padded years 0-999: '0491-05-01' then survived ymd(parseYmd(s)) === s, and the
  // server accepted dates that the data validators then dropped (a task saved without its date, an
  // update that erased the date it had, a whole create_events call refused).
  const d = new Date(2000, 4, 1);
  d.setFullYear(491);
  assert.equal(ymd(d), '491-05-01');
  assert.equal(ymd(new Date(2026, 10, 22)), '2026-11-22');
  assert.equal(ymd(new Date(NaN)), 'NaN-NaN-NaN');
  const roundTrip = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s; // schedule/app.js and notes/app.js isYmd
  for (const s of ['0491-05-01', '0999-12-31', '0100-01-01', '0001-01-01', '0000-01-01', '0099-12-31']) {
    assert.equal(roundTrip(s), false, `app isYmd("${s}")`);
    assert.equal(validYmd(s), false, `validYmd("${s}")`);
    assert.equal(isYmd(s), false, `sanitize isYmd("${s}")`);
  }
  for (const s of ['1000-01-01', '2026-11-22', '2028-02-29', '9999-12-31']) assert.ok(roundTrip(s) && validYmd(s) && isYmd(s), s);
});

test('dates.js hour12() asks Intl for the system 12/24-hour answer once, not on every fmtTime() call', () => {
  // fmtTime() runs for every time on screen; building an Intl.DateTimeFormat each time was about 3 s
  // of the notes list profile.
  const Real = Intl.DateTimeFormat;
  let made = 0;
  Intl.DateTimeFormat = function DateTimeFormat(...args) {
    made++;
    return new Real(...args);
  };
  try {
    setHour12(null); // follow the system
    const system = hour12();
    for (let i = 0; i < 1000; i++) fmtTime('14:30');
    assert.ok(made <= 1, `Intl.DateTimeFormat was built ${made} times for 1000 times`);
    assert.equal(fmtTime('14:30'), system ? '2:30 PM' : '14:30');
    // The setting still wins over the cached system answer, and null goes back to it.
    setHour12(true);
    assert.equal(fmtTime('14:30'), '2:30 PM');
    assert.equal(fmtTime('14:00', { compact: true }), '2pm');
    setHour12(false);
    assert.equal(fmtTime('14:30'), '14:30');
    assert.equal(hour12(), false);
    setHour12(null);
    assert.equal(hour12(), system);
    assert.ok(made <= 1, `built ${made} times`);
  } finally {
    Intl.DateTimeFormat = Real;
    setHour12(null);
  }
});

test('server parseDate / parseWhen refuse a year below 1000 with an error, instead of a date the validators drop', () => {
  const now = new Date(2026, 10, 22, 12);
  const c = { now, today: '2026-11-22' };
  for (const s of ['0491-05-01', '0999-12-31', '0100-01-01']) {
    assert.throws(() => parseDate(s, c), (err) => err instanceof ToolError && /is not a real date/.test(err.message), `parseDate("${s}")`);
    assert.throws(() => parseWhen(`${s}T10:00`, c), (err) => err instanceof ToolError && /is not a real date/.test(err.message), `parseWhen("${s}T10:00")`);
    assert.throws(() => parseWhen(s, c), ToolError, `parseWhen("${s}")`);
  }
  assert.equal(parseDate('1000-01-01', c), '1000-01-01');
  assert.deepEqual(parseWhen('2026-12-01T10:00', c), { date: '2026-12-01', time: '10:00' });
});

test('"every N days" with N outside 1-99 is not read, and parse names it in rejectedRepeat (so the server can say "use every 1 to 99 ...")', () => {
  for (const [s, phrase] of [
    ['Water plants every 100 days', 'every 100 days'],
    ['Water plants every 1000 days', 'every 1000 days'],
    ['Review each 582851674324 weeks', 'each 582851674324 weeks'],
    ['Bill EVERY 365 Months #Home', 'EVERY 365 Months'],
    ['Water every 0 days', 'every 0 days'],
  ]) {
    const r = p(s);
    assert.deepEqual([r.repeat, r.rejectedRepeat, r.date], [null, phrase, null], s);
    assert.ok(r.title.includes(phrase), `${s}: the phrase stays in the title (${r.title})`);
  }
  // events, and the "every <pattern>" text the server's parseRepeat builds from a repeat field
  const e = parse('Standup every 100 days 9am', { mode: 'event', now: NOW });
  assert.deepEqual([e.repeat, e.rejectedRepeat, e.title, e.time], [null, 'every 100 days', 'Standup every 100 days', '09:00']);
  assert.equal(p('every 100 days').rejectedRepeat, 'every 100 days');
  // a readable interval has none, and the other repeat phrases still work beside a rejected one
  for (const s of ['Water every 99 days', 'Water daily', 'Water every 2 weeks', 'Water plants']) assert.equal(p(s).rejectedRepeat, null, s);
  const both = p('Water every 100 days and daily');
  assert.deepEqual([both.repeat, both.rejectedRepeat], [{ freq: 'day', interval: 1 }, 'every 100 days']);
});

test('an impossible date after "at" is not an event\'s place, and stays in the title', () => {
  // the rejected date was masked like "quoted text", which can start a place: location "2026-02-30"
  const e = (s) => parse(s, { mode: 'event', now: NOW });
  for (const s of ['Party at 2026-02-30 with Sam', 'Dinner at the 30th of feb', 'Party at feb 30', 'Party @ 4/31/2027']) {
    const r = e(s);
    assert.deepEqual({ date: r.date, location: r.location, title: r.title }, { date: null, location: null, title: s }, s);
  }
  // a place ends before a rejected date, like before any parsed token
  const r = e('Party at Cafe Luna feb 30');
  assert.deepEqual([r.location, r.title, r.date], ['Cafe Luna', 'Party feb 30', null]);
  const k = e('Picnic at the park every 100 days');
  assert.deepEqual([k.location, k.title, k.rejectedRepeat], ['the park', 'Picnic every 100 days', 'every 100 days']);
  // quoted text can still be (or start) a place, and real dates after "at" are still dates
  assert.deepEqual([e('Lunch at "Joe\'s Diner" tomorrow').location, e('Lunch at "Joe\'s Diner" tomorrow').title], ["Joe's Diner", 'Lunch']);
  const ok = e('Party at Cafe Luna feb 3');
  assert.deepEqual([ok.location, ok.date, ok.title], ['Cafe Luna', '2027-02-03', 'Party']);
});

test('"at 4/30" is a date, not the time 16:00 with "/30" left in the title', () => {
  for (const mode of ['task', 'event']) {
    const r = parse('Meeting at 4/30', { mode, now: NOW });
    assert.deepEqual([r.date, r.time], ['2027-04-30', null], mode);
    assert.match(r.title, /^Meeting( at)?$/, mode);
    const s = parse('Party @ 12/5/2026 7pm', { mode, now: NOW });
    assert.deepEqual([s.date, s.time], ['2026-12-05', '19:00'], mode);
  }
  // "at 5" is still a time, also at the end of a phrase or before a comma
  assert.deepEqual([p('Call mom at 5').time, p('Call mom at 5').title], ['17:00', 'Call mom']);
  assert.equal(p('Call mom at 5, then dinner').time, '17:00');
  assert.equal(p('Call at 9:30').time, '09:30');
});

test('a duration under half a minute ("0.1m", "0.001h") is not read as 0 minutes; it stays in the title', () => {
  // QA's nlp fuzz found it: FUZZ_SEED=11 FUZZ_RUNS=4, minimal input "0.1m" gave duration 0
  for (const s of ['Run 0.1m', 'Run 0.4min', 'Run 0.001h', 'Run for 0.2 minutes', 'Run for 0.004 hours', 'Run 0h', 'Run for 0m', 'Run for 0h 0m']) {
    const r = p(s);
    assert.deepEqual([r.duration, r.title], [null, s], s);
  }
  for (const [s, mins] of [['Run 0.5m', 1], ['Run 0.01h', 1], ['Run 1.5h', 90], ['Run for 45min', 45], ['Run for 1h 30m', 90], ['Run for an hour', 60]]) {
    assert.deepEqual([p(s).duration, p(s).title], [mins, 'Run'], s);
  }
  // a number too large for a double is no duration either (Infinity is not a whole number of minutes)
  const huge = p(`Run ${'9'.repeat(400)}h`);
  assert.equal(huge.duration, null);
});
