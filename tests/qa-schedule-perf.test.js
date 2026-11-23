// QA fix round (schedule, perf): Schedule sorts the instances of a range into its days once per render
// (schedule/grid.js bucketDays) instead of asking dayInstances() for each day, which walked every instance
// in the range for every day: a 366-day agenda took seconds with a big calendar, the month grid and the week
// slowed the same way. bucketDays must give exactly what dayInstances gives for each day (a property test
// over random events, DST changeover days included), at a cost that grows with the instances and the days
// each one spans, not days × instances. Run with: npm test
process.env.TZ = 'America/Denver'; // DST starts 2027-03-14 at 2:00 (to 3:00), ends 2027-11-07 at 2:00 (to 1:00)

import { test } from 'node:test';
import assert from 'node:assert/strict';

// shared/model.js loads the store: give it the browser globals it may use.
globalThis.window ??= new EventTarget();
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: 'visible' });
if (!globalThis.localStorage) {
  const mem = new Map();
  const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
}

const { bucketDays, tasksByDay } = await import('../schedule/grid.js');
const { dayInstances } = await import('../shared/model.js');
const { addDaysYmd, parseYmd } = await import('../shared/dates.js');

// A small seeded random (mulberry32), so a failure can be replayed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const daysFrom = (from, n) => Array.from({ length: n }, (_, i) => addDaysYmd(from, i));
const at = (dayYmd, mins) => {
  const d = parseYmd(dayYmd);
  d.setHours(0, mins, 0, 0);
  return d;
};

/** An instance as eventInstances makes it: all day (start and end dates) or timed (Dates). */
function instance(n, { allDay, start, end }) {
  return { key: `e${n}@x`, event: { id: `e${n}`, title: `E${n}` }, occurrence: 'x', start, end, allDay, calendar: null, color: 'iris' };
}

function randomInstances(seed, from, spanDays, count) {
  const r = rng(seed);
  const out = [];
  for (let n = 0; n < count; n++) {
    const day = addDaysYmd(from, Math.floor(r() * (spanDays + 20)) - 10); // some start before the range, some after
    const kind = r();
    if (kind < 0.2) {
      const len = Math.floor(r() * 6); // one to six days
      out.push(instance(n, { allDay: true, start: parseYmd(day), end: parseYmd(addDaysYmd(day, r() < 0.05 ? -1 : len)) }));
      continue;
    }
    const startMin = r() < 0.1 ? 0 : Math.floor(r() * 96) * 15; // some at midnight
    const length =
      kind < 0.6 ? 15 + Math.floor(r() * 12) * 15 // under 3 hours
      : kind < 0.75 ? 1440 - startMin // to midnight exactly
      : kind < 0.85 ? Math.floor(r() * 48) * 60 + 30 // overnight or several days, by the clock
      : kind < 0.9 ? 0 // zero length
      : kind < 0.95 ? 1440 // a day exactly (sits in the all-day row)
      : -60; // ends before it starts (bad data must not throw)
    const start = at(day, startMin);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + length);
    out.push(instance(n, { allDay: false, start, end }));
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

const shape = ({ allDay, timed }) => ({ allDay: allDay.map((i) => i.key), timed: timed.map((i) => `${i.key} ${i.top}-${i.bottom}`) });

test('bucketDays gives each day exactly what dayInstances gives it (random events, both DST changes)', () => {
  // Ranges around the spring and autumn changes of 2027 and an ordinary month.
  for (const [seed, from, span] of [[1, '2027-03-01', 31], [2, '2027-10-25', 21], [3, '2027-06-01', 45], [4, '2026-12-20', 20]]) {
    const inst = randomInstances(seed, from, span, 600);
    const days = daysFrom(from, span);
    const buckets = bucketDays(inst, days);
    assert.deepEqual([...buckets.keys()], days, 'one entry per day, in order');
    for (const d of days) assert.deepEqual(shape(buckets.get(d)), shape(dayInstances(inst, d)), `seed ${seed}, ${d}`);
  }
});

test('bucketDays: the all-day row, overnight events, midnight ends and the days around a clock change', () => {
  const inst = [
    instance(1, { allDay: true, start: parseYmd('2027-03-13'), end: parseYmd('2027-03-15') }),
    instance(2, { allDay: false, start: at('2027-03-13', 22 * 60), end: at('2027-03-14', 6 * 60) }), // over the spring change
    instance(3, { allDay: false, start: at('2027-03-14', 9 * 60), end: at('2027-03-15', 0) }), // ends at midnight
    instance(4, { allDay: false, start: at('2027-03-14', 8 * 60), end: at('2027-03-15', 8 * 60) }), // 24 hours by the clock
    instance(5, { allDay: false, start: at('2027-03-15', 10 * 60), end: at('2027-03-15', 10 * 60 + 5) }), // 5 minutes: drawn 15
  ];
  const days = daysFrom('2027-03-12', 5);
  const b = bucketDays(inst, days);
  assert.deepEqual(shape(b.get('2027-03-12')), { allDay: [], timed: [] });
  assert.deepEqual(shape(b.get('2027-03-13')), { allDay: ['e1@x'], timed: ['e2@x 1320-1440'] });
  assert.deepEqual(shape(b.get('2027-03-14')), { allDay: ['e1@x', 'e4@x'], timed: ['e2@x 0-360', 'e3@x 540-1440'] });
  assert.deepEqual(shape(b.get('2027-03-15')), { allDay: ['e1@x', 'e4@x'], timed: ['e5@x 600-615'] }, 'a midnight end does not reach the next day');
  for (const d of days) assert.deepEqual(shape(b.get(d)), shape(dayInstances(inst, d)), d);
  assert.deepEqual([...bucketDays(inst, []).keys()], [], 'no days, no buckets');
  assert.deepEqual(shape(bucketDays([], ['2027-03-14']).get('2027-03-14')), { allDay: [], timed: [] });
});

test('bucketDays costs the instances and the days they span, not days × instances', () => {
  // 4,000 one-hour events over a year, read through counting getters. dayInstances reads every instance's
  // start once for each of the 366 days (about 1.5 million reads); bucketing reads each a few times.
  let reads = 0;
  const from = '2027-01-01';
  const days = daysFrom(from, 366);
  const inst = [];
  for (let n = 0; n < 4000; n++) {
    const day = days[n % 366];
    const s = at(day, 9 * 60 + (n % 8) * 60);
    const e = new Date(s.getTime() + 3600000);
    const i = instance(n, { allDay: false, start: s, end: e });
    Object.defineProperty(i, 'start', { enumerable: true, get: () => (reads++, s) });
    inst.push(i);
  }
  const b = bucketDays(inst, days);
  assert.equal([...b.values()].reduce((sum, x) => sum + x.timed.length, 0), 4000, 'every event lands on its one day');
  assert.ok(reads < 4000 * 8, `start was read ${reads} times for 4,000 one-day events (bounded per event, not per day)`);
});

test('tasksByDay groups dated tasks by day, in the order given, and skips undated ones', () => {
  const tasks = [{ id: 'a', date: '2027-01-02' }, { id: 'b', date: null }, { id: 'c', date: '2027-01-01' }, { id: 'd', date: '2027-01-02' }, null];
  const m = tasksByDay(tasks);
  assert.deepEqual([...m.keys()], ['2027-01-02', '2027-01-01']);
  assert.deepEqual(m.get('2027-01-02').map((t) => t.id), ['a', 'd']);
  assert.equal(m.get('2027-01-03'), undefined);
});
