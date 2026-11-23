// QA wave 1 (schedule): the pure helpers behind the time grid and Custom repeat (schedule/grid.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// shared/model.js (layoutColumns) loads the store: give it the browser globals it may use.
globalThis.window ??= new EventTarget();
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: 'visible' });
if (!globalThis.localStorage) {
  const mem = new Map();
  const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
}

const { MIN_VIS, visualBottom, blockBox, untilAfter } = await import('../schedule/grid.js');
const { layoutColumns } = await import('../shared/model.js');
const { occurrencesBetween } = await import('../shared/recur.js');

test('short items are drawn at least MIN_VIS minutes long, never past midnight', () => {
  assert.equal(MIN_VIS, 20);
  assert.equal(visualBottom(570, 585), 590, 'a 15-minute 9:30 standup is drawn to 9:50');
  assert.equal(visualBottom(570, 630), 630, 'longer items keep their length');
  assert.equal(visualBottom(1425, 1440), 1440, '23:45 – 24:00 stops at the end of the day');
  assert.equal(visualBottom(1430, 1440), 1440);
});

test('back-to-back 15-minute items sit side by side once drawn at their visual length', () => {
  const items = [
    { id: 'a', top: 570, bottom: visualBottom(570, 585) },
    { id: 'b', top: 585, bottom: visualBottom(585, 600) },
  ];
  const laid = layoutColumns(items);
  const a = laid.find((x) => x.id === 'a');
  const b = laid.find((x) => x.id === 'b');
  assert.equal(a.cols, 2, 'they overlap visually, so they share the column');
  assert.notEqual(a.col, b.col);
});

const lay = (spec) => layoutColumns(spec.map(([id, top, bottom]) => ({ id, top, bottom })));

test('events starting within 30 minutes of each other sit side by side (no cascade over the title)', () => {
  const laid = lay([
    ['road', 600, 690],
    ['hiring', 615, 675],
    ['pickup', 630, 660],
    ['coffee', 630, 690],
  ]);
  for (const it of laid) {
    const box = blockBox(it, laid);
    assert.equal(box.width, (it.span / it.cols) * 100, `${it.id} is not widened under a later neighbour`);
  }
});

test('an earlier event still stretches under one that starts 30 minutes or more later (Google)', () => {
  const laid = lay([
    ['long', 540, 660],
    ['later', 600, 660],
  ]);
  const long = laid.find((x) => x.id === 'long');
  const later = laid.find((x) => x.id === 'later');
  assert.equal(blockBox(long, laid).width, 85, '50% × 1.7');
  assert.equal(blockBox(later, laid).width, 50, 'the last column is never widened');
  assert.equal(blockBox(later, laid).left, 50);
});

test('the widening is decided by every overlapping later item, not just the nearest', () => {
  const laid = lay([
    ['a', 540, 720],
    ['b', 600, 660],
    ['c', 550, 700],
  ]);
  const a = laid.find((x) => x.id === 'a');
  // c starts 10 minutes after a and sits in a later column: a must not cover c's title.
  assert.equal(blockBox(a, laid).width, (a.span / a.cols) * 100);
});

test('untilAfter: "ends after N times" is the date of the Nth occurrence', () => {
  const tueThu = { freq: 'week', interval: 1, days: [2, 4] };
  // Tue Nov 24 2026, Thu 26, Tue Dec 1, Thu 3, Tue 8
  assert.equal(untilAfter(tueThu, '2026-11-24', 5), '2026-12-08');
  assert.equal(untilAfter(tueThu, '2026-11-24', 1), '2026-11-24', 'the start is the first time');
  assert.equal(untilAfter({ freq: 'day', interval: 3 }, '2026-11-22', 4), '2026-12-01');
  assert.equal(untilAfter({ freq: 'month', interval: 1 }, '2026-01-31', 3), '2026-03-31');
  assert.equal(untilAfter({ freq: 'year', interval: 1 }, '2024-02-29', 2), '2025-02-28');
  // The series then has exactly N occurrences.
  const until = untilAfter(tueThu, '2026-11-24', 10);
  assert.equal(occurrencesBetween(tueThu, '2026-11-24', '2026-11-24', '2030-01-01', { until }).length, 10);
  assert.equal(untilAfter(null, '2026-11-24', 3), null);
});
