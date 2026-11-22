// Recurrence rules shared by tasks and events.
// rule = { freq: 'day'|'week'|'month'|'year', interval: 1, days?: [0..6], monthDay?: 1..31, from?: 'due'|'done' }
import { parseYmd, ymd, addDays, addMonths, diffDays, WEEKDAY_SHORT, ordinal } from './dates.js';

const sortNum = (a, b) => a - b;

/** The next occurrence strictly after `afterYmd`, assuming `afterYmd` is itself on the pattern. */
export function nextOccurrence(rule, afterYmd) {
  const d = parseYmd(afterYmd);
  const n = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case 'day':
      return ymd(addDays(d, n));
    case 'week': {
      const days = rule.days?.length ? [...rule.days].sort(sortNum) : null;
      if (!days) return ymd(addDays(d, 7 * n));
      const wd = d.getDay();
      const later = days.find((x) => x > wd);
      if (later !== undefined) return ymd(addDays(d, later - wd));
      return ymd(addDays(addDays(d, -wd), 7 * n + days[0]));
    }
    case 'month':
      return ymd(addMonths(d, n, rule.monthDay || d.getDate()));
    case 'year':
      return ymd(addMonths(d, 12 * n, rule.monthDay || d.getDate()));
    default:
      return ymd(addDays(d, 1));
  }
}

/** First date on the pattern that is >= fromYmd (used when a rule is applied to a date that isn't on it). */
export function firstOnOrAfter(rule, fromYmd) {
  const d = parseYmd(fromYmd);
  if (rule.freq === 'week' && rule.days?.length) {
    for (let i = 0; i < 7; i++) {
      const x = addDays(d, i);
      if (rule.days.includes(x.getDay())) return ymd(x);
    }
  }
  if ((rule.freq === 'month' || rule.freq === 'year') && rule.monthDay) {
    const x = addMonths(d, 0, rule.monthDay);
    return ymd(x >= d ? x : addMonths(d, 1, rule.monthDay));
  }
  return fromYmd;
}

/**
 * All occurrence dates of a series starting on `startYmd`, within [fromYmd, toYmd] inclusive.
 * `exdates` are skipped; `until` (ymd) ends the series.
 */
export function occurrencesBetween(rule, startYmd, fromYmd, toYmd, { exdates = [], until = null } = {}) {
  const out = [];
  if (toYmd < startYmd) return out;
  const end = until && until < toYmd ? until : toYmd;
  const ex = new Set(exdates);
  const n = Math.max(1, rule.interval || 1);
  const push = (s) => {
    if (s >= fromYmd && s <= end && s >= startYmd && !ex.has(s)) out.push(s);
  };
  const start = parseYmd(startYmd);

  if (rule.freq === 'month' || rule.freq === 'year') {
    const step = rule.freq === 'month' ? n : 12 * n;
    const day = rule.monthDay || start.getDate();
    const monthsAhead = (parseYmd(fromYmd).getFullYear() - start.getFullYear()) * 12 + parseYmd(fromYmd).getMonth() - start.getMonth();
    let k = Math.max(0, Math.floor(monthsAhead / step) - 1);
    for (let guard = 0; guard < 600; guard++, k++) {
      const s = ymd(addMonths(start, k * step, day));
      if (s > end) break;
      push(s);
    }
    return out;
  }

  let cur;
  if (rule.freq === 'day') {
    const skip = Math.max(0, Math.floor(diffDays(startYmd, fromYmd) / n));
    cur = ymd(addDays(start, skip * n));
  } else if (rule.freq === 'week' && rule.days?.length) {
    const sow = addDays(start, -start.getDay());
    const weeks = Math.max(0, Math.floor(diffDays(sow, parseYmd(fromYmd)) / 7));
    const blocks = Math.floor(weeks / n) * n;
    if (blocks > 0) {
      const days = [...rule.days].sort(sortNum);
      cur = ymd(addDays(sow, 7 * blocks + days[0]));
    } else cur = startYmd;
  } else {
    const skip = Math.max(0, Math.floor(diffDays(startYmd, fromYmd) / (7 * n)));
    cur = ymd(addDays(start, skip * 7 * n));
  }

  for (let guard = 0; guard < 2000 && cur <= end; guard++) {
    push(cur);
    cur = nextOccurrence(rule, cur);
  }
  return out;
}

export function sameDays(a = [], b = []) {
  return a.length === b.length && [...a].sort(sortNum).every((v, i) => v === [...b].sort(sortNum)[i]);
}

/** 'Daily', 'Every 2 weeks on Mon, Wed', 'Weekdays', 'Monthly on the 15th' … */
export function describe(rule) {
  if (!rule) return 'Never';
  const n = Math.max(1, rule.interval || 1);
  const every = (unit) => (n === 1 ? null : `Every ${n} ${unit}s`);
  switch (rule.freq) {
    case 'day':
      return every('day') || 'Daily';
    case 'week': {
      const days = rule.days?.length ? [...rule.days].sort(sortNum) : null;
      if (n === 1 && days && sameDays(days, [1, 2, 3, 4, 5])) return 'Weekdays';
      if (n === 1 && days && sameDays(days, [0, 6])) return 'Weekends';
      if (n === 1 && days && days.length === 7) return 'Daily';
      const base = every('week') || 'Weekly';
      return days ? `${base} on ${days.map((d) => WEEKDAY_SHORT[d]).join(', ')}` : base;
    }
    case 'month': {
      const base = every('month') || 'Monthly';
      return rule.monthDay ? `${base} on the ${ordinal(rule.monthDay)}` : base;
    }
    case 'year':
      return every('year') || 'Yearly';
    default:
      return 'Custom';
  }
}

/** Preset rules offered in pickers. */
export function presets(anchorYmd) {
  const d = anchorYmd ? parseYmd(anchorYmd) : new Date();
  return [
    { label: 'Never', rule: null },
    { label: 'Daily', rule: { freq: 'day', interval: 1 } },
    { label: 'Weekdays', rule: { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] } },
    { label: `Weekly on ${WEEKDAY_SHORT[d.getDay()]}`, rule: { freq: 'week', interval: 1, days: [d.getDay()] } },
    { label: `Every 2 weeks on ${WEEKDAY_SHORT[d.getDay()]}`, rule: { freq: 'week', interval: 2, days: [d.getDay()] } },
    { label: `Monthly on the ${ordinal(d.getDate())}`, rule: { freq: 'month', interval: 1, monthDay: d.getDate() } },
    { label: 'Yearly', rule: { freq: 'year', interval: 1, monthDay: d.getDate() } },
  ];
}
