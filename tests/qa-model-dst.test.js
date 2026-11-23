// QA (model): events on the days the clocks change (shared/model.js eventInstances, detachOccurrence,
// splitSeries). An event whose start falls in the hour skipped by "spring forward" keeps its length
// (2:30 to 3:30 shows 3:30 to 4:30, as Apple and Google show it, not 3:30 to 3:30); every other
// instance is exactly where it was before. Run with: npm test
process.env.TZ = 'America/Denver'; // DST starts 2027-03-14 at 2:00 (to 3:00), ends 2027-11-07 at 2:00 (to 1:00)
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const { parseDT, addDaysYmd, diffDays, toMinutes } = await import('../shared/dates.js');

const ev = (e) => db.insert('events', { title: 'E', calendarId: null, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, ...e });
const inst = (e, day) => M.eventInstances(day, day).filter((i) => i.event.id === e.id && i.occurrence === day);
const grid = (e, day) => M.dayInstances(inst(e, day), day).timed.map((i) => [i.top, i.bottom]);
const HOUR = 3600000;

test('the test runs in America/Denver, where 2:00 to 3:00 does not exist on 2027-03-14', () => {
  assert.equal(new Date(2027, 2, 13, 12).getTimezoneOffset(), 420);
  assert.equal(new Date(2027, 2, 14, 12).getTimezoneOffset(), 360);
  assert.equal(new Date(2027, 2, 14, 2, 30).getHours(), 3, 'a 2:30 start is read as 3:30');
});

test('a daily 2:30am event keeps its hour on the night the clocks go forward', () => {
  const e = ev({ title: 'QA night shift', start: '2027-03-12T02:30', end: '2027-03-12T03:30', repeat: { freq: 'day', interval: 1 } });
  assert.deepEqual(grid(e, '2027-03-13'), [[150, 210]], '2:30 to 3:30 the day before');
  assert.deepEqual(grid(e, '2027-03-14'), [[210, 270]], '3:30 to 4:30 on the day 2:30 does not exist');
  assert.deepEqual(grid(e, '2027-03-15'), [[150, 210]], '2:30 to 3:30 the day after');
  const [i] = inst(e, '2027-03-14');
  assert.equal(i.end - i.start, HOUR, 'an hour long');
  db.remove('events', e.id);
});

test('a single event in the skipped hour keeps its length', () => {
  const e = ev({ start: '2027-03-14T02:15', end: '2027-03-14T03:00' });
  const [i] = inst(e, '2027-03-14');
  assert.deepEqual([i.start.getHours(), i.start.getMinutes(), i.end.getHours(), i.end.getMinutes()], [3, 15, 4, 0], '3:15 to 4:00');
  assert.deepEqual(grid(e, '2027-03-14'), [[195, 240]]);
  db.remove('events', e.id);
});

test('a series that starts in the skipped hour is at 2:30 on every other day', () => {
  const e = ev({ start: '2027-03-14T02:30', end: '2027-03-14T03:30', repeat: { freq: 'day', interval: 1 } });
  assert.deepEqual(grid(e, '2027-03-14'), [[210, 270]]);
  for (const day of ['2027-03-15', '2027-03-16', '2027-06-01']) assert.deepEqual(grid(e, day), [[150, 210]], day);
  db.remove('events', e.id);
});

test('falling back: a 1:30 to 2:30 series stays at 1:30 to 2:30 on the grid', () => {
  const e = ev({ start: '2027-11-05T01:30', end: '2027-11-05T02:30', repeat: { freq: 'day', interval: 1 } });
  for (const day of ['2027-11-06', '2027-11-07', '2027-11-08']) assert.deepEqual(grid(e, day), [[90, 150]], day);
  db.remove('events', e.id);
});

test('every other instance is exactly where it was: same start, and the stored end, all year', () => {
  // Daily series at awkward times (around the changes, overnight, a two-day one), checked on every day
  // of 2027 against the earlier arithmetic: the start at the stored clock time, the end read from the
  // stored end string moved by the same days. Only a start in the skipped hour is different.
  const shapes = [
    ['00:30', '01:30'], ['01:30', '02:30'], ['01:45', '03:15'], ['02:00', '02:45'], ['02:30', '03:30'],
    ['03:00', '04:00'], ['09:00', '09:30'], ['22:00', '01:00', 1], ['23:30', '02:30', 2],
  ];
  const first = '2026-12-31';
  for (const [s, en, days = 0] of shapes) {
    const e = ev({ start: `${first}T${s}`, end: `${addDaysYmd(first, days)}T${en}`, repeat: { freq: 'day', interval: 1 } });
    const wall = days * 1440 + toMinutes(en) - toMinutes(s);
    const all = M.eventInstances('2027-01-01', '2027-12-31').filter((i) => i.event.id === e.id);
    assert.equal(all.length, 365 + Math.min(days, 1), `${s}: one instance a day (plus Dec 31's, when it runs into 2027)`);
    for (const i of all) {
      const d = i.occurrence;
      if (d < '2027-01-01') continue;
      const start = parseDT(`${d}T${s}`);
      assert.equal(i.start.getTime(), start.getTime(), `${s} on ${d}: start`);
      const skipped = start.getHours() * 60 + start.getMinutes() !== toMinutes(s);
      if (!skipped) assert.equal(i.end.getTime(), parseDT(`${addDaysYmd(d, days)}T${en}`).getTime(), `${s} on ${d}: end`);
      else {
        const clock = diffDays(d, `${i.end.getFullYear()}-${String(i.end.getMonth() + 1).padStart(2, '0')}-${String(i.end.getDate()).padStart(2, '0')}`) * 1440 + i.end.getHours() * 60 + i.end.getMinutes() - (i.start.getHours() * 60 + i.start.getMinutes());
        assert.equal(clock, wall, `${s} on ${d} (skipped hour): keeps its length by the clock`);
      }
    }
    db.remove('events', e.id);
  }
});

test('editing one occurrence keeps the series’ clock time, on the night the clocks change too', () => {
  // A series that starts in the skipped hour: its copies on other days are at 2:30, not 3:30.
  const a = ev({ start: '2027-03-14T02:30', end: '2027-03-14T03:30', repeat: { freq: 'day', interval: 1 } });
  const copy = M.detachOccurrence(a.id, '2027-03-16', { title: 'Moved one' });
  assert.deepEqual([copy.start, copy.end], ['2027-03-16T02:30', '2027-03-16T03:30']);
  const tail = M.splitSeries(a.id, '2027-03-20', { title: 'Later ones' });
  assert.deepEqual([tail.start, tail.end], ['2027-03-20T02:30', '2027-03-20T03:30']);
  assert.deepEqual(grid(tail, '2027-03-21'), [[150, 210]]);

  // The night itself: the copy stores the series' times and shows an hour from 3:30.
  const b = ev({ start: '2027-03-12T02:30', end: '2027-03-12T03:30', repeat: { freq: 'day', interval: 1 } });
  const night = M.detachOccurrence(b.id, '2027-03-14', { title: 'That night' });
  assert.deepEqual([night.start, night.end], ['2027-03-14T02:30', '2027-03-14T03:30']);
  assert.deepEqual(grid(night, '2027-03-14'), [[210, 270]]);
  for (const x of [a, copy, tail, b, night]) db.remove('events', x.id);
});
