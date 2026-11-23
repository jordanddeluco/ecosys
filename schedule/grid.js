// schedule — pure helpers for the time grid and the editor's "Ends after N times" (no DOM, so they are
// unit-tested in Node: tests/qa-schedule-grid.test.js, tests/qa-schedule-perf.test.js).
import { occurrencesBetween } from '../shared/recur.js';
import { addDaysYmd, addDays, parseYmd, ymd, diffDays } from '../shared/dates.js';

const clockMinutes = (d) => d.getHours() * 60 + d.getMinutes();

/**
 * Every day's share of `instances` (eventInstances() output) in one pass: a Map from each of `days` (sorted
 * 'YYYY-MM-DD') to {allDay, timed}, exactly what shared/model.js dayInstances(instances, day) gives for that
 * day (timed ones with {top, bottom} in wall-clock minutes, long timed events in the all-day row, the input
 * order kept). dayInstances walks every instance for each day, so a month grid or a year of agenda cost
 * days × instances (seconds with a big calendar); this costs each instance only the days it spans.
 */
export function bucketDays(instances, days) {
  const map = new Map();
  const n = days.length;
  const starts = new Array(n);
  const ends = new Array(n);
  const slots = new Array(n);
  for (let k = 0; k < n; k++) {
    slots[k] = { allDay: [], timed: [] };
    map.set(days[k], slots[k]);
    starts[k] = parseYmd(days[k]);
    ends[k] = addDays(starts[k], 1);
  }
  if (!n) return map;
  for (const i of instances) {
    const first = ymd(i.start);
    const endYmd = ymd(i.end);
    // The last day it touches: an all-day event's end date; a timed one's last minute (one ending at
    // midnight doesn't reach the next day).
    const last = i.allDay ? endYmd : ymd(new Date(i.end.getTime() - 1));
    if (!(last >= days[0]) || !(first <= days[n - 1])) continue; // also skips invalid dates ('NaN-…')
    // Timed events of a full day or more (by the clock, not elapsed time) go in the all-day row.
    const long = !i.allDay && diffDays(first, endYmd) * 1440 + clockMinutes(i.end) - clockMinutes(i.start) >= 1440;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] < first) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < n && days[k] <= last; k++) {
      const slot = slots[k];
      if (i.allDay) {
        slot.allDay.push(i);
        continue;
      }
      // The same test as dayInstances, so the two always agree (a clock change at midnight included).
      const dayStart = starts[k];
      const dayEnd = ends[k];
      if (!(i.start < dayEnd && i.end > dayStart)) continue;
      if (long) {
        slot.allDay.push(i);
        continue;
      }
      const s = i.start <= dayStart ? 0 : clockMinutes(i.start);
      const e = i.end >= dayEnd ? 1440 : clockMinutes(i.end);
      slot.timed.push({ ...i, top: s, bottom: Math.max(e, s + 15) });
    }
  }
  return map;
}

/** Tasks by their date: a Map from 'YYYY-MM-DD' to that day's tasks (in the order given). */
export function tasksByDay(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!t?.date) continue;
    const list = map.get(t.date);
    if (list) list.push(t);
    else map.set(t.date, [t]);
  }
  return map;
}

/**
 * The shortest an item is drawn, in minutes. A 15-minute event at 48px an hour would be a 10px sliver that
 * cuts its own text; 20 minutes gives a 14px block that fits one line. Stored times never change: only
 * the drawing (and the overlap layout, so back-to-back short items sit side by side, as in Google Calendar).
 */
export const MIN_VIS = 20;

/** The bottom an item is drawn at (minutes from midnight), never past the end of the day. */
export const visualBottom = (top, bottom) => Math.max(bottom, Math.min(1440, top + MIN_VIS));

/** Later items that start within this many minutes of an item sit beside it instead of over its title. */
export const CASCADE_MIN = 30;

/**
 * Left and width (percent of the day column) of a laid-out item ({top, bottom, col, cols, span} from
 * layoutColumns), given the column's other items. Google's overlap: an earlier event stretches under the
 * later ones (which sit on top), but only when every overlapping item in a later column starts at least
 * 30 minutes after it, so its title row stays readable. Items that start close together sit side by side.
 */
export function blockBox(it, items = []) {
  const left = (it.col / it.cols) * 100;
  const base = (it.span / it.cols) * 100;
  if (it.col + it.span >= it.cols) return { left, width: base };
  const later = items.filter((o) => o !== it && o.col > it.col && o.top < it.bottom && o.bottom > it.top);
  const widen = later.every((o) => o.top - it.top >= CASCADE_MIN);
  return { left, width: widen ? Math.min(100 - left, base * 1.7) : base };
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * "Ends after N times" as the date of the Nth occurrence of a series starting on `startYmd` (the end
 * date ecosys stores). Null when the series has fewer than N occurrences in the next 100 years.
 */
export function untilAfter(rule, startYmd, count, exdates = []) {
  const n = clampInt(count, 1, 999, 1);
  if (!rule) return null;
  const span = { day: 1, week: 7, month: 31, year: 366 }[rule.freq] || 1;
  let to = addDaysYmd(startYmd, Math.min(36600, span * Math.max(1, rule.interval || 1) * (n + 1) + 7));
  for (let tries = 0; tries < 4; tries++) {
    const dates = occurrencesBetween(rule, startYmd, startYmd, to, { exdates });
    if (dates.length >= n) return dates[n - 1];
    to = addDaysYmd(to, 36600);
  }
  return null;
}
