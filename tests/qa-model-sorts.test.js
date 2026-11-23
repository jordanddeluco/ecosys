// QA (model, cross-area): Tasks' sort menu speaks the same words as the rest of Tasks. The planned
// day is "Date" (rows, the task pane, Home), the day a task must be done is its "Deadline", so the
// sort by `date` reads "Date" in the Sort menu and the header's "Sorted by" chip, never "Due date"
// (shared/model.js SORTS). Its order is unchanged. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { SORTS } = await import('../shared/model.js');

test('SORTS: the sort by the planned day is "Date", and no sort says "Due"', () => {
  assert.equal(SORTS.date.label, 'Date');
  assert.deepEqual(Object.keys(SORTS), ['manual', 'date', 'priority', 'alpha', 'created'], 'the same sorts, in menu order');
  for (const [id, s] of Object.entries(SORTS)) assert.doesNotMatch(s.label, /\bdue\b/i, id);
});

test('SORTS.date: by date, then time, then my order; tasks without a date or time go last', () => {
  const t = (id, date, time, order) => ({ id, date, time, order, createdAt: order });
  const list = [t('none', null, null, 1), t('b-late', '2031-05-07', '18:00', 2), t('a', '2031-05-06', null, 3), t('b-early', '2031-05-07', '09:00', 4), t('b-untimed', '2031-05-07', null, 0), t('b-tie2', '2031-05-07', '09:00', 6)];
  assert.deepEqual(
    [...list].sort(SORTS.date.fn).map((x) => x.id),
    ['a', 'b-early', 'b-tie2', 'b-late', 'b-untimed', 'none'],
  );
});
