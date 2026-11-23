// Recurrence rules shared by tasks and events (pure: also used by the server and MCP tools).
// rule = { freq: 'day'|'week'|'month'|'year', interval: 1, days?: [0..6], monthDay?: 1..31, month?: 1..12, from?: 'due'|'done' }
import { parseYmd, ymd, todayYmd, addDays, addMonths, addDaysYmd, diffDays, daysInMonth, WEEKDAY_SHORT, ordinal, fmt } from './dates.js';

const sortNum = (a, b) => a - b;

/** Date in month `m` (0-based, may overflow) of year `y` on `day`, clamped to the month's length. */
function clampedDate(y, m, day) {
  const first = new Date(y, m, 1);
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, daysInMonth(first.getFullYear(), first.getMonth())));
}

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
      if (rule.month) return ymd(clampedDate(d.getFullYear() + n, rule.month - 1, rule.monthDay || d.getDate()));
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
  if (rule.freq === 'month' && rule.monthDay) {
    const x = clampedDate(d.getFullYear(), d.getMonth(), rule.monthDay);
    return ymd(x >= d ? x : clampedDate(d.getFullYear(), d.getMonth() + 1, rule.monthDay));
  }
  if (rule.freq === 'year' && rule.monthDay) {
    const m = rule.month ? rule.month - 1 : d.getMonth();
    const x = clampedDate(d.getFullYear(), m, rule.monthDay);
    return ymd(x >= d ? x : clampedDate(d.getFullYear() + 1, m, rule.monthDay));
  }
  return fromYmd;
}

/** Last date on the pattern that is <= fromYmd (monthly / yearly rules with a monthDay). */
export function prevOnOrBefore(rule, fromYmd) {
  const d = parseYmd(fromYmd);
  if (rule.freq === 'month' && rule.monthDay) {
    const x = clampedDate(d.getFullYear(), d.getMonth(), rule.monthDay);
    return ymd(x <= d ? x : clampedDate(d.getFullYear(), d.getMonth() - 1, rule.monthDay));
  }
  if (rule.freq === 'year' && rule.monthDay) {
    const m = rule.month ? rule.month - 1 : d.getMonth();
    const x = clampedDate(d.getFullYear(), m, rule.monthDay);
    return ymd(x <= d ? x : clampedDate(d.getFullYear() - 1, m, rule.monthDay));
  }
  return fromYmd;
}

/**
 * Move an off-pattern date to the nearest date on a monthly/yearly pattern (ties go back), so stepping
 * forward from it never skips the current month. Other rules return the date unchanged.
 */
export function snapToPattern(rule, s) {
  if (!rule || !((rule.freq === 'month' || rule.freq === 'year') && rule.monthDay)) return s;
  const before = prevOnOrBefore(rule, s);
  const after = firstOnOrAfter(rule, s);
  return diffDays(before, s) <= diffDays(s, after) ? before : after;
}

/**
 * A date of the sequence that nextOccurrence steps through from `d` (a date on it, not after
 * `today`), skipping whole periods so that it is at most one period before `today`. Every date it
 * skips is on or before `today`, so stepping on from the result gives the same dates as stepping
 * from `d`. Monthly and yearly rules without a monthDay take their day from the date stepped from,
 * which can still move at a month end (Jan 31 → Feb 28 → Mar 28): those step one at a time until
 * the day is 28 or less.
 */
function skipToward(rule, d, today) {
  const n = Math.max(1, rule.interval || 1); // as nextOccurrence reads it
  if (!Number.isInteger(n)) return d;
  if (rule.freq === 'day' || rule.freq === 'week') {
    const period = rule.freq === 'day' ? n : 7 * n; // a weekly pattern repeats every n weeks
    const gap = diffDays(d, today);
    return gap >= period ? addDaysYmd(d, gap - (gap % period)) : d;
  }
  if (rule.freq !== 'month' && rule.freq !== 'year') return d;
  const x = parseYmd(d);
  const day = rule.monthDay || x.getDate();
  if (!rule.monthDay && day > 28) return d;
  const t = parseYmd(today);
  const step = rule.freq === 'month' ? n : 12 * n;
  const k = Math.floor(((t.getFullYear() - x.getFullYear()) * 12 + t.getMonth() - x.getMonth()) / step) - 1; // lands in an earlier month than today
  if (k < 1) return d;
  if (rule.freq === 'year' && rule.month) return ymd(clampedDate(x.getFullYear() + k * n, rule.month - 1, day));
  return ymd(addMonths(x, k * step, day));
}

/** a <= b for 'YYYY-MM-DD' strings, also when one has run past year 9999 (a longer year is later). */
const notAfter = (a, b) => typeof a === 'string' && typeof b === 'string' && (a.length === b.length ? a <= b : a.length < b.length);

/**
 * The 'YYYY-MM-DD' that `v` names (a date-time 'YYYY-MM-DDTHH:MM' or a Date gives its local date),
 * or null when it is no real date. The search below compares dates as strings, so it must never see
 * a longer string such as a date-time: that is "later" than every date and the loop would run to
 * its guard (seconds on the main thread, and a date thousands of years away).
 */
function dayOf(v) {
  const s = v instanceof Date ? ymd(v) : typeof v === 'string' ? v.slice(0, 10) : '';
  const d = parseYmd(s);
  return !Number.isNaN(d.getTime()) && ymd(d) === s ? s : null;
}

/** The first date after `today` (a real 'YYYY-MM-DD') of the sequence through `d` (a date on the pattern). */
function firstAfter(rule, d, today) {
  // The guard only stops runaway input: within years 1000-9999 even stepping one at a time ends sooner.
  for (let guard = 0; notAfter(d, today) && guard < 1e6; guard++) {
    const from = skipToward(rule, d, today);
    const next = nextOccurrence(rule, from);
    if (!notAfter(d, next) || next === d) return next; // no progress (an invalid date): stop, never loop
    d = next;
  }
  return d;
}

/**
 * Where a repeating task goes when it is completed: { date, deadline }.
 *  - from 'due' (default): the next occurrence after its date (or deadline), skipping past ones
 *    (however far overdue: whole periods are skipped arithmetically).
 *  - from 'done': the next occurrence after today; completing early still moves it forward.
 *  - a repeating task with no date and no deadline lands on the next occurrence after today.
 * `today` is a 'YYYY-MM-DD' (a date-time or a Date counts as its date; anything else, such as
 * undefined, means the current date). A task date or deadline that is no real date counts as none.
 */
export function nextRepeatDates(task, today) {
  const rule = task.repeat;
  if (!rule) return { date: task.date ?? null, deadline: task.deadline ?? null };
  const day = dayOf(today) ?? todayYmd();
  const date = dayOf(task.date);
  const deadline = dayOf(task.deadline);
  const anchor = date || deadline || day;
  const base = snapToPattern(rule, rule.from === 'done' ? day : anchor);
  let next = firstAfter(rule, nextOccurrence(rule, base), day);
  if (rule.from === 'done' && date && next === date) next = nextOccurrence(rule, next);
  const shift = diffDays(anchor, next);
  return {
    date: date ? addDaysYmd(date, shift) : deadline ? null : next,
    deadline: deadline ? addDaysYmd(deadline, shift) : null,
  };
}

/** Keep a rule on the same weekdays / day of month after its series moves by `deltaDays` to `newDate`. */
export function shiftRule(rule, deltaDays, newDate) {
  if (!rule) return rule;
  const r = { ...rule };
  if (r.freq === 'week' && r.days && deltaDays % 7) r.days = r.days.map((d) => (((d + deltaDays) % 7) + 7) % 7).sort(sortNum);
  if ((r.freq === 'month' || r.freq === 'year') && deltaDays && newDate) {
    const d = parseYmd(newDate);
    r.monthDay = d.getDate();
    if (r.freq === 'year' && r.month) r.month = d.getMonth() + 1;
  }
  return r;
}

/**
 * All occurrence dates of a series starting on `startYmd`, within [fromYmd, toYmd] inclusive.
 * `exdates` are skipped; `until` (ymd) ends the series. A yearly series repeats in the month it
 * starts in (like RFC 5545 without BYMONTH): `month` is the anchor of a repeating task, while a
 * series is anchored by its start, which moving it changes (code that moves only monthDay is fine).
 * The start itself is always the first occurrence, also when it is not on the pattern (RFC 5545
 * counts DTSTART): "monthly on the 15th" starting on the 22nd has the 22nd, then the 15ths.
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
    push(startYmd); // the start, even off the pattern (weekly series start this way too)
    for (let guard = 0; guard < 600; guard++, k++) {
      const s = ymd(addMonths(start, k * step, day));
      if (s > end) break;
      if (s !== startYmd) push(s);
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
    case 'year': {
      const base = every('year') || 'Yearly';
      return rule.month && rule.monthDay ? `${base} on ${fmt(new Date(2024, rule.month - 1, rule.monthDay), { month: 'short', day: 'numeric' })}` : base;
    }
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
    // month + monthDay anchor the pattern, so a postponed yearly task still comes back on its day
    { label: 'Yearly', rule: { freq: 'year', interval: 1, monthDay: d.getDate(), month: d.getMonth() + 1 } },
  ];
}
