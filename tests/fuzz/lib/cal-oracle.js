// A time-zone-independent calendar oracle: proleptic Gregorian dates as integer day numbers
// (days since 1970-01-01), using H. Hinnant's civil-from-days algorithms. No Date objects, so DST,
// local midnight gaps and the process TZ cannot affect it.

export function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z0) {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const p2 = (n) => String(n).padStart(2, '0');
export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const dim = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
export const dayOf = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return daysFromCivil(y, m, d);
};
export const ymdOf = (z) => {
  const [y, m, d] = civilFromDays(z);
  return `${String(y).padStart(4, '0')}-${p2(m)}-${p2(d)}`;
};
/** 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export const weekday = (z) => (((z % 7) + 7 + 4) % 7);
export const addDays = (s, k) => ymdOf(dayOf(s) + k);
/** (y, m) + k months → [y, m]. */
export function addYm(y, m, k) {
  const t = y * 12 + (m - 1) + k;
  return [Math.floor(t / 12), (((t % 12) + 12) % 12) + 1];
}
/** Date `k` months after `s` on `day` (default: s's day), clamped to the month's length. */
export function addMonths(s, k, day) {
  const [y, m, d] = s.split('-').map(Number);
  const [y2, m2] = addYm(y, m, k);
  return ymdOf(daysFromCivil(y2, m2, Math.min(day ?? d, dim(y2, m2))));
}

/** Is the series start on its own pattern ("synchronized" in RFC 5545 terms)? */
export function startOnPattern(rule, startYmd) {
  const z = dayOf(startYmd);
  const [y, m, d] = civilFromDays(z);
  if (rule.freq === 'week' && rule.days?.length) return rule.days.includes(weekday(z));
  if ((rule.freq === 'month' || rule.freq === 'year') && rule.monthDay) return d === Math.min(rule.monthDay, dim(y, m));
  return true;
}

/**
 * Occurrences of a series (shared/recur.js occurrencesBetween semantics) within [from, to]:
 *  day / week without days: start + k*step; week with days: every n-th week (Sunday-based, counted
 *  from the start's week) on those days, plus the start itself; month / year: the start's month
 *  + k*step months on monthDay (or the start's day), clamped to month ends; never before the start,
 *  never after `until`, minus exdates.
 */
export function oracleOccurrences(rule, startYmd, fromYmd, toYmd, { exdates = [], until = null } = {}) {
  const out = [];
  if (toYmd < startYmd) return out;
  const S = dayOf(startYmd);
  const F = dayOf(fromYmd);
  const end = Math.min(dayOf(toYmd), until ? dayOf(until) : Infinity);
  const ex = new Set(exdates);
  const n = Math.max(1, rule.interval || 1);
  const found = new Set();
  const push = (z) => {
    if (z >= F && z <= end && z >= S && !found.has(z)) {
      const s = ymdOf(z);
      found.add(z);
      if (!ex.has(s)) out.push(s);
    }
  };
  if (rule.freq === 'day' || (rule.freq === 'week' && !rule.days?.length)) {
    const step = rule.freq === 'day' ? n : 7 * n;
    for (let z = S + Math.max(0, Math.floor((F - S) / step)) * step; z <= end; z += step) push(z);
  } else if (rule.freq === 'week') {
    const days = [...new Set(rule.days)].sort((a, b) => a - b);
    const sow = S - weekday(S);
    push(S);
    for (let b = Math.max(0, Math.floor((F - sow) / (7 * n)) - 1); sow + 7 * n * b <= end; b++) for (const d of days) push(sow + 7 * n * b + d);
    out.sort();
  } else {
    const step = rule.freq === 'month' ? n : 12 * n;
    const [sy, sm, sd] = civilFromDays(S);
    const [fy, fm] = civilFromDays(F);
    const day = rule.monthDay || sd;
    for (let k = Math.max(0, Math.floor(((fy - sy) * 12 + (fm - sm)) / step) - 1); ; k++) {
      const [y, m] = addYm(sy, sm, k * step);
      const z = daysFromCivil(y, m, Math.min(day, dim(y, m)));
      if (z > end) break;
      push(z);
    }
  }
  return out;
}

/**
 * Next occurrence strictly after `d` for a task rule (shared/recur.js nextOccurrence semantics),
 * assuming `d` is on the pattern: day +n; week +7n or the next listed weekday (then the first one
 * n weeks on); month +n months on monthDay; year +n years in `month` (or d's month) on monthDay.
 */
export function oracleNext(rule, d) {
  const n = Math.max(1, rule.interval || 1);
  const z = dayOf(d);
  const [y, m, dd] = civilFromDays(z);
  switch (rule.freq) {
    case 'day':
      return ymdOf(z + n);
    case 'week': {
      if (!rule.days?.length) return ymdOf(z + 7 * n);
      const days = [...rule.days].sort((a, b) => a - b);
      const wd = weekday(z);
      const later = days.find((x) => x > wd);
      return later !== undefined ? ymdOf(z + later - wd) : ymdOf(z - wd + 7 * n + days[0]);
    }
    case 'month':
      return addMonths(d, n, rule.monthDay || dd);
    case 'year': {
      if (rule.month) {
        const y2 = y + n;
        return ymdOf(daysFromCivil(y2, rule.month, Math.min(rule.monthDay || dd, dim(y2, rule.month))));
      }
      return addMonths(d, 12 * n, rule.monthDay || dd);
    }
    default:
      return ymdOf(z + 1);
  }
}

/** Every date in (a, b) exclusive, as day numbers (b - a ≤ limit). */
export function* between(a, b, limit = 4000) {
  const A = dayOf(a);
  const B = dayOf(b);
  for (let z = A + 1; z < B && z - A <= limit; z++) yield z;
}
