// QA fix (model, cross request from the data owner): createEvent added elapsed time to the start, so an
// event across a clock change ended an hour off: "Conference mar 13-15 9am-5pm" saved an end of 6pm and
// a slot drawn 1:00-4:00 on the night the clocks go forward saved 1:00-5:00. The end is now the start
// plus the minutes on the clock, exactly as the server's addMinutesDT computes it. Run with: npm test
process.env.TZ = 'America/Denver'; // DST starts 2027-03-14 at 2:00 (to 3:00), ends 2027-11-07 at 2:00 (to 1:00)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db } = await import('../shared/store.js');
const M = await import('../shared/model.js');
const { addMinutesDT } = await import('../server/model.mjs');
const { addDaysYmd } = await import('../shared/dates.js');

const made = (fields) => {
  const e = M.createEvent({ title: 'QA', ...fields });
  db.remove('events', e.id);
  return [e.start, e.end];
};

test('the test runs in America/Denver, where the clocks change on 2027-03-14 and 2027-11-07', () => {
  assert.equal(new Date(2027, 2, 13, 12).getTimezoneOffset(), 420);
  assert.equal(new Date(2027, 2, 15, 12).getTimezoneOffset(), 360);
  assert.equal(new Date(2027, 10, 8, 12).getTimezoneOffset(), 420);
});

test('an event across the night the clocks go forward ends at the time asked', () => {
  // "Conference mar 13-15 9am-5pm": 9:00 on the 13th to 17:00 on the 15th, 2 days and 8 hours on the clock.
  assert.deepEqual(made({ date: '2027-03-13', time: '09:00', duration: 2 * 1440 + 480 }), ['2027-03-13T09:00', '2027-03-15T17:00']);
  // A slot drawn 1:00-4:00 on that night.
  assert.deepEqual(made({ date: '2027-03-14', time: '01:00', duration: 180 }), ['2027-03-14T01:00', '2027-03-14T04:00']);
  // An end in the skipped hour stays as written, so the event keeps its 90 minutes by the clock.
  assert.deepEqual(made({ date: '2027-03-14', time: '01:00', duration: 90 }), ['2027-03-14T01:00', '2027-03-14T02:30']);
});

test('an event across the night the clocks go back ends at the time asked', () => {
  assert.deepEqual(made({ date: '2027-11-07', time: '01:00', duration: 120 }), ['2027-11-07T01:00', '2027-11-07T03:00']);
  assert.deepEqual(made({ date: '2027-11-06', time: '22:00', duration: 360 }), ['2027-11-06T22:00', '2027-11-07T04:00']);
});

test('ordinary days, the default length and an end past midnight are as before', () => {
  assert.deepEqual(made({ date: '2027-06-01', time: '09:00', duration: 45 }), ['2027-06-01T09:00', '2027-06-01T09:45']);
  const e = M.createEvent({ title: 'QA', date: '2027-06-01', time: '23:30' }, { defaultEventMinutes: 90 });
  db.remove('events', e.id);
  assert.deepEqual([e.start, e.end], ['2027-06-01T23:30', '2027-06-02T01:00']);
  const all = M.createEvent({ title: 'QA', date: '2027-06-01', endDate: '2027-06-03', allDay: true });
  db.remove('events', all.id);
  assert.deepEqual([all.allDay, all.start, all.end], [true, '2027-06-01', '2027-06-03']);
});

test('the browser and the server agree on every end around both clock changes', () => {
  const days = [];
  for (let k = -2; k <= 2; k++) days.push(addDaysYmd('2027-03-14', k), addDaysYmd('2027-11-07', k));
  for (const date of days) {
    for (let h = 0; h < 24; h++) {
      for (const duration of [15, 30, 60, 90, 150, 180, 600, 1440, 1500, 2 * 1440 + 480]) {
        const time = `${String(h).padStart(2, '0')}:${h % 2 ? '30' : '00'}`;
        const [start, end] = made({ date, time, duration });
        // A start in the skipped hour is read as the hour after it (2:30 is 3:30), as before.
        assert.equal(end, addMinutesDT(start, duration), `${date} ${time} + ${duration}`);
      }
    }
  }
});
