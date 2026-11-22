// Date helpers shared by every ecosys app.
// Dates are stored as local "floating" strings: 'YYYY-MM-DD' and 'YYYY-MM-DDTHH:MM'.

export const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const todayYmd = () => ymd(new Date());

export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
  x.setDate(x.getDate() + n);
  return x;
}

export const addDaysYmd = (s, n) => ymd(addDays(parseYmd(s), n));

export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** Add months, clamping the day (Jan 31 + 1 month → Feb 28/29). `day` overrides the anchor day. */
export function addMonths(d, n, day = d.getDate()) {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const first = new Date(y, m, 1);
  const dim = daysInMonth(first.getFullYear(), first.getMonth());
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, dim), d.getHours(), d.getMinutes());
}

export function startOfWeek(d, weekStart = 0) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() - weekStart + 7) % 7));
  return x;
}

export const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

/** Whole days from a to b (b - a), DST-safe. Accepts Date or ymd string. */
export function diffDays(a, b) {
  const A = typeof a === 'string' ? parseYmd(a) : a;
  const B = typeof b === 'string' ? parseYmd(b) : b;
  return Math.round(
    (Date.UTC(B.getFullYear(), B.getMonth(), B.getDate()) - Date.UTC(A.getFullYear(), A.getMonth(), A.getDate())) / 86400000,
  );
}

export function parseDT(s) {
  const [date, time = '00:00'] = s.split('T');
  const d = parseYmd(date);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

export const fmtDT = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const fromMinutes = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

export const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---------- formatting ----------

let _hour12 = null;
export function setHour12(v) {
  _hour12 = v;
}
export function hour12() {
  if (_hour12 !== null) return _hour12;
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 !== false;
  } catch {
    return true;
  }
}

/** '14:30' → '2:30 PM' (or '14:30'). `compact` drops ':00' and the space: '2pm'. */
export function fmtTime(hhmm, { compact = false } = {}) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (!hour12()) return `${pad(h)}:${pad(m)}`;
  const suffix = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  if (compact) return `${hh}${m ? ':' + pad(m) : ''}${suffix.toLowerCase()}`;
  return `${hh}:${pad(m)} ${suffix}`;
}

export function fmtDuration(mins) {
  if (!mins) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const fmtCache = new Map();
export function fmt(d, opts) {
  const key = JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(undefined, opts));
  return fmtCache.get(key).format(typeof d === 'string' ? parseYmd(d) : d);
}

export const WEEKDAY_SHORT = Array.from({ length: 7 }, (_, i) => fmt(new Date(2023, 0, 1 + i), { weekday: 'short' }));
export const WEEKDAY_NARROW = Array.from({ length: 7 }, (_, i) => fmt(new Date(2023, 0, 1 + i), { weekday: 'narrow' }));
export const WEEKDAY_LONG = Array.from({ length: 7 }, (_, i) => fmt(new Date(2023, 0, 1 + i), { weekday: 'long' }));

/** Human label for a day: Today, Tomorrow, Yesterday, weekday (within a week), or 'Mon, Dec 5'. */
export function dayLabel(s, { long = false } = {}) {
  const n = diffDays(todayYmd(), s);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  const d = parseYmd(s);
  if (n > 1 && n < 7) return fmt(d, { weekday: 'long' });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return fmt(d, {
    weekday: long ? 'long' : 'short',
    month: long ? 'long' : 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Short date like 'Dec 5' (adds year when not this year). */
export function shortDate(s) {
  const d = parseYmd(s);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return fmt(d, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
