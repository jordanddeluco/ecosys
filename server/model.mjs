// Server-side domain logic for the MCP tools: dates, repeats, tasks, events and free time.
// Pure functions over plain data. Imports only the pure shared modules (no DOM, no localStorage).
import { parse as nlpParse } from '../shared/nlp.js';
import { nextRepeatDates, occurrencesBetween, firstOnOrAfter, describe as describeRule } from '../shared/recur.js';
import { pad, ymd, parseYmd, addDaysYmd, diffDays } from '../shared/dates.js';
import { COLORS } from './validate.mjs';
import { uid, cleanText } from './util.mjs';

export { COLORS, uid };

// ---------------------------------------------------------------- errors + clock

/** An error the model can act on. The tools layer turns it into an isError result. */
export class ToolError extends Error {}
export const fail = (msg) => {
  throw new ToolError(msg);
};

export const WD3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}

const fmtOffset = (m) => `${m >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;

export function utcOffset(d = new Date()) {
  return fmtOffset(-d.getTimezoneOffset());
}

/** `z` when it names a time zone this computer knows (an IANA name such as "Europe/Berlin"), else null. */
export function validTimeZone(z) {
  if (typeof z !== 'string' || !z || z.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(z)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

const wallFormats = new Map();
/** The wall-clock fields of time `ms` in time zone `zone`. */
function wallParts(ms, zone) {
  let f = wallFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    if (wallFormats.size > 20) wallFormats.clear();
    wallFormats.set(zone, f);
  }
  const p = {};
  for (const x of f.formatToParts(ms)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/**
 * The time zone localStamp() (and so every time a tool shows) uses: that of the last clock made, when
 * it is not this process's own (null). Tool calls run one at a time, each with a fresh clock.
 */
let stampZone = null;

/**
 * The tools' clock: today, the time and the zone, in `zone` (the one the apps run in: settings
 * uiTimeZone) when it is given and known, else in this process's zone. A Node process keeps the zone
 * it started in when the computer's zone changes (travel); the apps follow the new one, so their zone
 * wins. `now` is a Date whose local fields show that wall time, as the phrase parser reads them.
 */
export function clock(now = new Date(), zone = null) {
  const z = validTimeZone(zone);
  stampZone = z && z !== timeZone() ? z : null;
  if (!stampZone) {
    const today = ymd(now);
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return { now, today, time, nowDT: `${today}T${time}`, zone: timeZone(), offset: utcOffset(now), weekday: WD_LONG[now.getDay()] };
  }
  const w = wallParts(now.getTime(), stampZone);
  const today = `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  const time = `${pad(w.h)}:${pad(w.mi)}`;
  const offset = fmtOffset(Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - (now.getTime() - now.getMilliseconds())) / 60000));
  const local = new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, now.getMilliseconds());
  return { now: local, today, time, nowDT: `${today}T${time}`, zone: stampZone, offset, weekday: WD_LONG[parseYmd(today).getDay()] };
}

export const fmtDay = (s) => `${WD3[parseYmd(s).getDay()]} ${s}`;
export const todayLine = (c) => `Today is ${fmtDay(c.today)}, ${c.time} (${c.zone}, UTC${c.offset}).`;

// ---------------------------------------------------------------- formats

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar date 'YYYY-MM-DD' from 1000-01-01 to 9999-12-31 (the range the data validators store). */
export function validYmd(s) {
  // The range is checked here, not left to ymd(): it would have to keep not zero-padding years below 1000.
  if (typeof s !== 'string' || !YMD_RE.test(s) || Number(s.slice(0, 4)) < 1000) return false;
  const d = parseYmd(s);
  return ymd(d) === s;
}

/** Minutes since an arbitrary epoch for a local wall-clock 'YYYY-MM-DDTHH:MM' (DST-free arithmetic). */
export function wallMin(dt) {
  const [date, time = '00:00'] = dt.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 60000;
}
export function fromWallMin(mins) {
  const d = new Date(mins * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export const addMinutesDT = (dt, mins) => fromWallMin(wallMin(dt) + mins);
export const hhmmToMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const fmtMinutes = (mins) => {
  if (!mins) return '0m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`;
};

// ---------------------------------------------------------------- input parsing

const hint = (what, example) => `${what}. Use ${example}`;

/**
 * Longest date, time or repeat phrase that is parsed at all. The phrase parsers (shared/nlp.js and
 * the repeat patterns) take time that grows with the square of the input, and they run on the
 * server's only thread, so anything longer is refused before any of them sees it.
 */
export const MAX_PHRASE = 200;

// What the phrase parser (shared/nlp.js) works out is checked before anything uses it. It has
// produced dates such as '491-05-01' (an unpadded year), 'NaN-NaN-NaN' (a huge offset) and
// '10026-11-22' (a five-digit year); the data validators would silently drop such a date, so the
// item would be saved without the date the assistant asked for.

/** A date from the phrase parser: returned when it is a real 'YYYY-MM-DD' (years 1000-9999), else an actionable error. */
export function checkNlpDate(date, phrase, c, field = 'date') {
  if (validYmd(date)) return date;
  fail(`${field} "${cleanText(phrase).slice(0, 40)}" does not give a date ecosys can store (a real date from 1000-01-01 to 9999-12-31). Use YYYY-MM-DD (e.g. ${addDaysYmd(c.today, 1)}).`);
}

/** A time from the phrase parser: 'HH:MM' (24h), else an actionable error. */
export function checkNlpTime(time, phrase, field = 'time') {
  if (typeof time === 'string' && HHMM_RE.test(time)) return time;
  fail(`${field} "${cleanText(phrase).slice(0, 40)}" does not give a time ecosys can store. Use HH:MM in 24-hour time (e.g. 14:30).`);
}

const notStorableRepeat = (field, phrase) =>
  fail(`${field} "${cleanText(phrase).slice(0, 40)}" is not a repeat ecosys can store: use every 1 to 99 days, weeks, months or years (e.g. "every 2 weeks").`);

/** A repeat rule from the phrase parser: every 1-99 days/weeks/months/years with valid weekdays, else an actionable error. */
export function checkNlpRepeat(rep, phrase, field = 'repeat') {
  if (!rep) return null;
  const interval = rep.interval ?? 1;
  if (!FREQS.includes(rep.freq) || !Number.isInteger(interval) || interval < 1 || interval > 99) notStorableRepeat(field, phrase);
  const out = { ...rep, interval };
  if (out.days !== undefined) {
    out.days = (Array.isArray(out.days) ? out.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!out.days.length) delete out.days;
  }
  if (out.monthDay !== undefined && !(Number.isInteger(out.monthDay) && out.monthDay >= 1 && out.monthDay <= 31)) delete out.monthDay;
  return out;
}

/**
 * A repeat the phrase parser recognised but could not read: "every 100 days" (or "every 0 weeks")
 * stays in the title, and parse() names it in `rejectedRepeat`. That is an actionable error here, not
 * an item saved without the repeat the assistant asked for. `phrase` is what the message quotes
 * (default: the rejected phrase itself).
 */
export function checkNlpRejectedRepeat(p, field = 'repeat', phrase = p?.rejectedRepeat) {
  if (p?.rejectedRepeat) notStorableRepeat(field, phrase);
}

/** "now" (any case), which models often send for the current moment. */
const NOW_RE = /^(right\s+)?now$/i;

/** 'YYYY-MM-DD', 'today', 'tomorrow', 'now', or a short phrase like 'next friday' / 'dec 5' / 'in 3 days'. */
export function parseDate(v, c, field = 'date') {
  if (typeof v !== 'string' || !v.trim()) fail(hint(`${field} must be a date`, `YYYY-MM-DD (e.g. ${addDaysYmd(c.today, 1)})`));
  const s = v.trim();
  if (s.length > MAX_PHRASE) fail(`${field} is too long. Use YYYY-MM-DD (e.g. ${addDaysYmd(c.today, 1)}), "today" or "tomorrow".`);
  if (NOW_RE.test(s)) return c.today;
  if (YMD_RE.test(s)) {
    if (!validYmd(s)) fail(`${field} "${s}" is not a real date. Use YYYY-MM-DD (e.g. ${addDaysYmd(c.today, 1)}).`);
    return s;
  }
  // A whole ISO date-time ("2026-12-03T10:00", "…T10:00:00.000Z", "…T10:00-07:00") gives its date as
  // written. Only a whole one: "2026-12-03T10:00 to 2026-12-05T10:00" names two days, and the phrase
  // parser below refuses it like anything else it can't read as one day.
  const isoLike = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (isoLike) {
    if (!validYmd(isoLike[1])) fail(`${field} "${cleanText(s).slice(0, 40)}" is not a real date. Use YYYY-MM-DD (e.g. ${addDaysYmd(c.today, 1)}).`);
    return isoLike[1];
  }
  // Ranges are read so that two days are refused by name, never taken as their first one.
  const r = nlpParse(s, { mode: 'task', now: c.now, ranges: true });
  // "dec 3-5" or "dec 3 by dec 5": two days where one is asked for. The example is the end that a
  // deadline or the end of a window means, else the first day.
  if (r.date && r.deadline && r.deadline !== r.date && !r.title) {
    fail(`${field} "${cleanText(s).slice(0, 40)}" names two days (${r.date} and ${r.deadline}); ${field} takes one. Use YYYY-MM-DD (e.g. ${/^(deadline|end_date)$|_to$/.test(field) ? r.deadline : r.date}).`);
  }
  if (r.date && !r.title) return checkNlpDate(r.date, s, c, field);
  fail(`${field} "${cleanText(s).slice(0, 40)}" is not a date I understand. Use YYYY-MM-DD (e.g. ${addDaysYmd(c.today, 1)}), "today" or "tomorrow".`);
}

/** 'HH:MM' (24h) or '5pm' / '9:30am'. */
export function parseTime(v, c, field = 'time', hour12 = true) {
  if (typeof v !== 'string' || !v.trim()) fail(`${field} must be a time. Use HH:MM in 24-hour time (e.g. 14:30).`);
  const s = v.trim();
  if (s.length > MAX_PHRASE) fail(`${field} is too long. Use HH:MM in 24-hour time (e.g. 14:30).`);
  if (NOW_RE.test(s)) return c.time;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(s);
  if (m) return `${pad(+m[1])}:${m[2]}`;
  const r = nlpParse(s, { mode: 'task', now: c.now, hour12 });
  if (r.time && !r.title) return checkNlpTime(r.time, s, field);
  fail(`${field} "${cleanText(s).slice(0, 20)}" is not a time I understand. Use HH:MM in 24-hour time (e.g. 14:30).`);
}

/**
 * A local date-time: 'YYYY-MM-DDTHH:MM[:SS]' (local wall time), an ISO string with Z/±HH:MM (converted
 * to local time), 'YYYY-MM-DD' (date only), 'now', or a phrase like 'tomorrow 3pm'. Returns {date, time|null}.
 */
export function parseWhen(v, c, field = 'start', hour12 = true) {
  if (typeof v !== 'string' || !v.trim()) fail(hint(`${field} is required`, `YYYY-MM-DDTHH:MM local time (e.g. ${addDaysYmd(c.today, 1)}T15:00)`));
  const s = v.trim();
  if (s.length > MAX_PHRASE) fail(`${field} is too long. Use YYYY-MM-DDTHH:MM local time (e.g. ${addDaysYmd(c.today, 1)}T15:00).`);
  if (NOW_RE.test(s)) return { date: c.today, time: c.time };
  if (YMD_RE.test(s)) return { date: parseDate(s, c, field), time: null };
  const local = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(s);
  if (local) {
    if (!validYmd(local[1])) fail(`${field} "${s}" is not a real date.`);
    return { date: local[1], time: `${local[2]}:${local[3]}` };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) fail(`${field} "${s}" is not a valid date-time.`);
    const at = localStamp(d.getTime()); // the user's wall time (see clock())
    if (!validYmd(at.slice(0, 10))) fail(`${field} "${s}" is not a date ecosys can store (a real date from 1000-01-01 to 9999-12-31).`);
    return { date: at.slice(0, 10), time: at.slice(11) };
  }
  const r = nlpParse(s, { mode: 'event', now: c.now, hour12, ranges: true });
  // "dec 20-28": a date range where one day or date-time is asked for
  if (r.endDate && r.endDate !== r.date && !r.title && !r.repeat) {
    const also = field === 'from' || field === 'to' ? ` To cover those days use from "${r.date}" and to "${r.endDate}".` : field === 'end' ? ` For an all-day event over those days use end_date "${r.endDate}".` : '';
    fail(`${field} "${cleanText(s).slice(0, 40)}" is a date range (${r.date} to ${r.endDate}); ${field} takes one day or date-time. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM (e.g. ${field === 'to' || field === 'end' ? r.endDate : r.date}).${also}`);
  }
  if (r.date && !r.title && !r.repeat) return { date: checkNlpDate(r.date, s, c, field), time: r.allDay || !r.time ? null : checkNlpTime(r.time, s, field) };
  fail(`${field} "${cleanText(s).slice(0, 40)}" is not a date-time I understand. Use YYYY-MM-DDTHH:MM local time (e.g. ${addDaysYmd(c.today, 1)}T15:00).`);
}

export function parseDuration(v, field = 'duration_minutes', max = 1440) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`${field} must be a whole number of minutes between 1 and ${max}.`);
  return n;
}

export const PRIORITY_IN = { p1: 3, p2: 2, p3: 1, p4: 0 };
export const priorityLabel = (p) => `P${4 - (p || 0)}`;
export function parsePriority(v) {
  const k = String(v ?? '').trim().toLowerCase();
  if (!(k in PRIORITY_IN)) fail(`priority must be "p1" (highest), "p2", "p3" or "p4" (none). Got "${cleanText(k).slice(0, 10)}".`);
  return PRIORITY_IN[k];
}

export const MAX_LABELS = 20;
export function parseLabels(v, field = 'labels') {
  if (!Array.isArray(v)) fail(`${field} must be an array of strings.`);
  const out = new Set();
  for (const x of v) {
    if (typeof x !== 'string') fail(`${field} must be an array of strings.`);
    const t = x.slice(0, 200).trim().replace(/^[@#]+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (t) out.add(t);
    // Stop at the limit instead of reading on: a huge array must not cost more than a short one.
    if (out.size > MAX_LABELS) fail(`At most ${MAX_LABELS} ${field} per task.`);
  }
  return [...out];
}

const RRULE_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WD_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const weekdayIndex = (w) => WD_NAMES[String(w).toLowerCase().slice(0, 3)] ?? -1;
const FREQS = ['day', 'week', 'month', 'year'];

function normalizeRule(r, anchor) {
  const rule = { freq: r.freq, interval: Math.max(1, Math.min(99, r.interval || 1)) };
  if (r.days?.length) rule.days = [...new Set(r.days)].sort((a, b) => a - b);
  if (r.monthDay) rule.monthDay = r.monthDay;
  if (r.from === 'done') rule.from = 'done';
  if (anchor) {
    const d = parseYmd(anchor);
    if (rule.freq === 'week' && !rule.days) rule.days = [d.getDay()];
    if ((rule.freq === 'month' || rule.freq === 'year') && !rule.monthDay) rule.monthDay = d.getDate();
  }
  return rule;
}

/**
 * A repeat rule from natural text ("every weekday", "every 2 weeks on mon, thu", "monthly on the 15th",
 * "daily after completion"), an RRULE ("FREQ=WEEKLY;BYDAY=MO,WE"), or a rule object
 * {freq, interval, days, monthDay}. "none"/"never"/null clears it. Returns {rule, until, count}.
 * `canEnd: false` (tasks, which repeat until their repeat is removed) refuses an RRULE COUNT or UNTIL
 * instead of returning one that nothing would use.
 */
export function parseRepeat(v, c, anchor = null, { canEnd = true } = {}) {
  if (v === null || v === undefined) return { rule: null };
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (!FREQS.includes(v.freq)) fail('repeat.freq must be "day", "week", "month" or "year".');
    const days = v.days === undefined ? undefined : v.days;
    if (days !== undefined && (!Array.isArray(days) || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) fail('repeat.days must be up to 7 weekday numbers, 0 (Sun) to 6 (Sat).');
    if (v.monthDay !== undefined && !(Number.isInteger(v.monthDay) && v.monthDay >= 1 && v.monthDay <= 31)) fail('repeat.monthDay must be 1-31.');
    if (v.interval !== undefined && !(Number.isInteger(v.interval) && v.interval >= 1 && v.interval <= 99)) fail('repeat.interval must be 1-99.');
    return { rule: normalizeRule(v, anchor) };
  }
  if (typeof v !== 'string') fail('repeat must be text like "every weekday" or "monthly on the 15th".');
  let s = v.trim();
  if (s.length > MAX_PHRASE) fail('repeat is too long. Use a short pattern like "every weekday", "every mon, wed" or "monthly on the 15th".');
  if (!s || /^(none|never|no|off|does not repeat|don'?t repeat)$/i.test(s)) return { rule: null };
  if (/FREQ=/i.test(s)) return parseRRule(s.replace(/^RRULE:/i, ''), c, anchor, { canEnd });
  let from = null;
  s = s.replace(/\b(?:after|from)\s+(?:completion|completing|done|completed|finishing|it'?s\s+done)\b/i, () => {
    from = 'done';
    return ' ';
  });
  // "every 2 weeks on mon, thu" / "weekly on tue and fri" (the quick-add parser reads only one day there)
  const wk = /^\s*(?:(?:every|each)\s+(?:(\d{1,2}|other)\s+)?weeks?|weekly|biweekly|fortnightly)\s+on\s+([a-z ,&+]+?)\s*$/i.exec(s);
  if (wk) {
    const days = wk[2].split(/\s*(?:,|and|&|\+|\s)\s*/i).filter(Boolean).map(weekdayIndex);
    if (days.length && days.every((d) => d >= 0)) {
      const interval = /bi|fort/i.test(s.trim().slice(0, 11)) || /other/i.test(wk[1] || '') ? 2 : wk[1] ? parseInt(wk[1], 10) : 1;
      // "every 0 weeks on mon" gets the same 1-99 error as "every 0 weeks" (normalizeRule would clamp it to weekly).
      if (!(Number.isInteger(interval) && interval >= 1 && interval <= 99)) notStorableRepeat('repeat', v);
      return { rule: normalizeRule({ freq: 'week', interval, days, from }, anchor) };
    }
  }
  const r = nlpParse(/^(every|each|daily|weekly|monthly|yearly|annually|biweekly|fortnightly)\b/i.test(s.trim()) ? s : `every ${s}`, { mode: 'task', now: c.now });
  // "every 100 days": say what the limit is, rather than "not a pattern I understand".
  checkNlpRejectedRepeat(r, 'repeat', v);
  if (!r.repeat || r.title.replace(/\b(on|the|at)\b/gi, '').trim()) {
    fail(`repeat "${cleanText(v).slice(0, 40)}" is not a pattern I understand. Try "daily", "every weekday", "every mon, wed", "every 2 weeks", "monthly on the 15th", "yearly", or add "after completion".`);
  }
  const rep = { ...checkNlpRepeat(r.repeat, v), from };
  // The quick-add parser anchors "weekly"/"monthly" to today; tie them to the item's own date instead.
  if (anchor) {
    if (rep.freq === 'week' && !/\b(sun|mon|tue|wed|thu|fri|sat)|\bweek(day|end)s?\b/i.test(s)) delete rep.days;
    if ((rep.freq === 'month' || rep.freq === 'year') && !/\d{1,2}(st|nd|rd|th)\b/i.test(s)) delete rep.monthDay;
  }
  return { rule: normalizeRule(rep, anchor || (validYmd(r.date) ? r.date : null)) };
}

/**
 * An RRULE part ecosys can't store as sent: refused in the words of the 1-99 limit (what was sent,
 * what ecosys can store, an example), never rounded, skipped or dropped into a different rule.
 */
const badRRule = (part, what) => fail(`repeat "${cleanText(part).slice(0, 40)}" is not a repeat ecosys can store: ${what}.`);
/** An RRULE number: digits only, else NaN ("2.5", "+2", "1e1", "1,15" and "" are not whole numbers). */
const rruleInt = (v) => (/^\d{1,9}$/.test(v) ? Number(v) : NaN);
const rruleDay = (d) => (Object.hasOwn(RRULE_DAYS, d) ? RRULE_DAYS[d] : undefined);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NO_POSITIONS = 'it repeats on weekdays every 1 to 99 weeks (e.g. "FREQ=WEEKLY;BYDAY=TU,TH") or on one day of the month (e.g. "FREQ=MONTHLY;BYMONTHDAY=10"), not on a weekday\'s place in the month like 2TU or -1FR';
const ONE_MONTH_DAY = 'a repeat can be on one day of the month (e.g. "FREQ=MONTHLY;BYMONTHDAY=15"); for two days a month, add one repeating item for each day';
const AT_ITS_TIME = 'a repeat comes back at the time of the item itself; set that time on the event (start) or the task (time) and leave out BYHOUR, BYMINUTE and BYSECOND';
/** The RRULE parts read below; WKST is read only to check that it changes nothing. */
const RRULE_PARTS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST', 'UNTIL', 'COUNT']);
/** What to send instead of the other RFC 5545 parts. */
const RRULE_INSTEAD = {
  BYSETPOS: NO_POSITIONS,
  BYHOUR: AT_ITS_TIME,
  BYMINUTE: AT_ITS_TIME,
  BYSECOND: AT_ITS_TIME,
};
const RRULE_STORED = 'ecosys stores FREQ, INTERVAL, BYDAY, BYMONTHDAY, COUNT and UNTIL (e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10")';

function parseRRule(s, c, anchor, { canEnd = true } = {}) {
  // Every part once, as NAME=VALUE: a part that is not, or one given twice, is refused, never skipped.
  const parts = new Map();
  for (const raw of s.split(';')) {
    const part = raw.trim();
    if (!part) continue; // "FREQ=DAILY;" ends in an empty part, which says nothing
    const kv = part.split('=').map((x) => x.trim().toUpperCase());
    if (kv.length !== 2 || !/^[A-Z][A-Z0-9-]*$/.test(kv[0])) badRRule(part, 'write each part once, as NAME=VALUE separated by ";" (e.g. "FREQ=DAILY;COUNT=10")');
    if (parts.has(kv[0])) {
      badRRule(part, kv[0] === 'BYMONTHDAY' ? ONE_MONTH_DAY : kv[0] === 'BYDAY' ? 'list every weekday in one BYDAY (e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR")' : `give ${kv[0]} once (e.g. "FREQ=DAILY;COUNT=10")`);
    }
    parts.set(kv[0], kv[1]);
  }
  const given = (k) => parts.has(k);
  const val = (k) => parts.get(k);
  const freq = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[val('FREQ')];
  if (!freq) badRRule(given('FREQ') ? `FREQ=${val('FREQ')}` : s, 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY (e.g. "FREQ=WEEKLY;BYDAY=MO,WE")');
  const rule = { freq, interval: 1 };
  if (given('INTERVAL')) {
    rule.interval = rruleInt(val('INTERVAL'));
    if (!(rule.interval >= 1 && rule.interval <= 99)) {
      badRRule(`INTERVAL=${val('INTERVAL')}`, 'use every 1 to 99 days, weeks, months or years, as a whole INTERVAL (e.g. "FREQ=WEEKLY;INTERVAL=2" for every 2 weeks)');
    }
  }
  if (given('BYDAY')) {
    const list = val('BYDAY').split(',').map((d) => d.trim());
    // "2TU" (the 2nd Tuesday) or a monthly or yearly BYDAY: no rule ecosys stores says that.
    if (list.some((d) => /^[+-]?\d/.test(d)) || (freq !== 'week' && freq !== 'day')) badRRule(`BYDAY=${val('BYDAY')}`, NO_POSITIONS);
    const days = list.map(rruleDay);
    if (days.some((d) => d === undefined)) badRRule(`BYDAY=${val('BYDAY')}`, 'BYDAY lists weekdays as SU, MO, TU, WE, TH, FR or SA (e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR")');
    // Every 2 days, but only on Mondays and Wednesdays, is no weekly rule: only every day is.
    if (freq === 'day' && rule.interval > 1) {
      badRRule(`INTERVAL=${val('INTERVAL')}`, 'a daily repeat on chosen weekdays is every week on those days (e.g. "FREQ=DAILY;BYDAY=MO,WE,FR"); for every 2 weeks or more use FREQ=WEEKLY (e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR")');
    }
    rule.freq = 'week';
    rule.days = days;
  }
  if (given('BYMONTHDAY')) {
    const v = val('BYMONTHDAY');
    if (freq !== 'month' && freq !== 'year') badRRule(`BYMONTHDAY=${v}`, 'a day of the month goes with FREQ=MONTHLY or FREQ=YEARLY (e.g. "FREQ=MONTHLY;BYMONTHDAY=15")');
    if (v.includes(',')) badRRule(`BYMONTHDAY=${v}`, ONE_MONTH_DAY);
    const md = rruleInt(v);
    if (!(md >= 1 && md <= 31)) {
      badRRule(`BYMONTHDAY=${v}`, 'BYMONTHDAY must be one whole day of the month from 1 to 31 (e.g. "FREQ=MONTHLY;BYMONTHDAY=15"; 31 means the last day of shorter months)');
    }
    rule.monthDay = md;
  }
  if (given('BYMONTH')) {
    // A yearly repeat comes back in the month of the item's own date: BYMONTH can only say that again.
    const v = val('BYMONTH');
    const month = anchor && validYmd(anchor) ? Number(anchor.slice(5, 7)) : null;
    if (freq !== 'year' || rruleInt(v) !== month) {
      badRRule(`BYMONTH=${v}`, `a yearly repeat comes back in the month of the item's own date${month ? ` (${MONTH_NAMES[month - 1]})` : ''}, and other repeats can't leave months out; give the item a date in the month you want and leave out BYMONTH (e.g. "FREQ=YEARLY"), or repeat every few months (e.g. "FREQ=MONTHLY;INTERVAL=3")`);
    }
  }
  if (given('WKST')) {
    const v = val('WKST');
    const start = rruleDay(v);
    if (start === undefined) badRRule(`WKST=${v}`, 'WKST is a weekday: SU, MO, TU, WE, TH, FR or SA (e.g. "WKST=MO")');
    // ecosys counts weeks from Sunday. Another first day matters only every 2 weeks or more, and only
    // when it puts the rule's weekdays into different weeks: some before that day and some from it on.
    const days = rule.days || [];
    if (start > 0 && rule.interval > 1 && days.some((d) => d < start) && days.some((d) => d >= start)) {
      badRRule(`WKST=${v}`, `ecosys starts weeks on Sunday, and with INTERVAL=${rule.interval} a week from ${v} puts these weekdays into different weeks; leave out WKST, or add one repeating item for each weekday (e.g. "FREQ=WEEKLY;INTERVAL=${rule.interval};BYDAY=${val('BYDAY').split(',')[0].trim()}")`);
    }
  }
  if (!canEnd && (given('COUNT') || given('UNTIL'))) {
    badRRule(given('COUNT') ? `COUNT=${val('COUNT')}` : `UNTIL=${val('UNTIL')}`, "a repeating task comes back until its repeat is removed, so it can't end after a number of times or on a date; send the repeat without COUNT and UNTIL (e.g. \"FREQ=WEEKLY;BYDAY=MO\")");
  }
  let until = null;
  if (given('UNTIL')) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/.exec(val('UNTIL'));
    until = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    if (!validYmd(until)) badRRule(`UNTIL=${val('UNTIL')}`, 'UNTIL must be a real date written YYYYMMDD (e.g. "UNTIL=20261231")');
  }
  let count = null;
  if (given('COUNT')) {
    count = rruleInt(val('COUNT'));
    if (!(count >= 1 && count <= 1000)) badRRule(`COUNT=${val('COUNT')}`, 'COUNT must be a whole number of occurrences from 1 to 1000 (e.g. "FREQ=DAILY;COUNT=10"), or end it with UNTIL=YYYYMMDD');
  }
  if (given('COUNT') && given('UNTIL')) badRRule(`UNTIL=${val('UNTIL')}`, 'end a repeat with COUNT or with UNTIL, not both (e.g. "FREQ=DAILY;COUNT=10" or "FREQ=DAILY;UNTIL=20261231")');
  for (const k of parts.keys()) {
    if (!RRULE_PARTS.has(k)) badRRule(`${k}=${val(k)}`, Object.hasOwn(RRULE_INSTEAD, k) ? RRULE_INSTEAD[k] : RRULE_STORED);
  }
  return { rule: normalizeRule(rule, anchor), until, count };
}

/** Last date of a series that has `count` occurrences from `start`. */
export function untilForCount(rule, start, count) {
  const dates = occurrencesBetween(rule, start, start, addDaysYmd(start, 366 * 30));
  return dates[Math.min(count, dates.length) - 1] || start;
}

export const describeRepeat = (rule) => (rule ? describeRule(rule) + (rule.from === 'done' ? ' after completion' : '') : null);

// ---------------------------------------------------------------- lists + calendars

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Resolve a list by id or name. 'inbox' (or null) → null (the Inbox). Throws with the candidates and,
 * for a tool that puts tasks in the list (`canCreate`), how to add one (create_list); a search
 * (find_tasks) only names the lists there are.
 */
export function resolveList(state, v, { canCreate = true } = {}) {
  if (v === null || v === undefined || norm(v) === 'inbox' || norm(v) === '') return null;
  if (typeof v !== 'string') fail('list must be a list id or name.');
  const lists = state.all('lists');
  const hit = lists.find((l) => l.id === v) || lists.find((l) => norm(l.name) === norm(v));
  if (hit) return hit.id;
  const names = lists.slice(0, 50).map((l) => `${q(l.name)} (id=${l.id})`).join(', ') || 'none yet';
  fail(`No list named ${q(cleanText(v).slice(0, 40))}. Lists: "Inbox", ${names}${lists.length > 50 ? ` and ${lists.length - 50} more (get_context)` : ''}.${canCreate ? ' Use create_list to add one.' : ''}`);
}

export function resolveCalendar(state, v) {
  const cals = state.all('calendars');
  if (v === null || v === undefined || v === '') {
    const c = cals.find((x) => x.visible !== false) || cals[0];
    if (!c) fail('There are no calendars yet. Open the schedule app once to create the default ones.');
    return c.id;
  }
  if (typeof v !== 'string') fail('calendar must be a calendar id or name.');
  const hit = cals.find((c) => c.id === v) || cals.find((c) => norm(c.name) === norm(v));
  if (hit) return hit.id;
  const names = cals.slice(0, 50).map((c) => `${q(c.name)} (id=${c.id})`).join(', ') || 'none';
  fail(`No calendar named ${q(cleanText(v).slice(0, 40))}. Calendars: ${names}${cals.length > 50 ? ` and ${cals.length - 50} more (get_context)` : ''}.`);
}

export const listName = (state, id) => (id ? state.get('lists', id)?.name || 'Inbox' : 'Inbox');
export const calendarName = (state, id) => state.get('calendars', id)?.name || 'Calendar';

// ---------------------------------------------------------------- tasks

export const isOverdue = (t, today) => !t.done && !!((t.date && t.date < today) || (t.deadline && t.deadline < today));

export function nextTaskOrder(state) {
  let max = 0;
  for (const t of state.all('tasks')) if (typeof t.order === 'number' && t.order > max) max = t.order;
  return max + 1;
}

export function newTask(fields, now = Date.now()) {
  return {
    id: uid(),
    title: 'New task',
    notes: '',
    listId: null,
    tags: [],
    priority: 0,
    date: null,
    time: null,
    duration: null,
    deadline: null,
    repeat: null,
    checklist: [],
    done: false,
    completedAt: null,
    order: 1,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

/**
 * Complete a task (in a transaction). A repeating task logs a completed copy and moves to its next
 * date, keeping its identity. Returns {task, advancedTo|null, copyId|null}.
 */
export function completeTask(tx, t, c) {
  const now = Date.now();
  if (!t.repeat) {
    return { task: tx.put('tasks', { ...t, done: true, completedAt: now, updatedAt: now }), advancedTo: null };
  }
  // The same next dates as the apps (shared/model.js toggleTask): however far overdue, the task comes
  // back after today; an off-pattern date snaps to its monthly/yearly pattern first; completing an
  // "after completion" task early still moves it on; one without any date gets the next date.
  const { date, deadline } = nextRepeatDates(t, c.today);
  const { id: _omit, ...rest } = t;
  const copy = tx.put('tasks', { ...rest, id: uid(), repeat: null, done: true, completedAt: now, repeatOf: t.id, createdAt: now, updatedAt: now });
  const task = tx.put('tasks', {
    ...t,
    date,
    deadline,
    checklist: (t.checklist || []).map((s) => ({ ...s, done: false })),
    done: false,
    completedAt: null,
    updatedAt: now,
  });
  return { task, advancedTo: task.date || task.deadline, copyId: copy.id };
}

export function taskView(state, t, c, { detailed = false } = {}) {
  const v = {
    task_id: t.id,
    title: t.title,
    list: listName(state, t.listId),
    list_id: t.listId || null,
    priority: priorityLabel(t.priority),
    date: t.date || null,
    time: t.time || null,
    duration_minutes: t.duration || null,
    deadline: t.deadline || null,
    labels: t.tags || [],
    repeat: describeRepeat(t.repeat),
    done: !!t.done,
    overdue: !!isOverdue(t, c.today),
    steps_done: (t.checklist || []).filter((s) => s.done).length,
    steps_total: (t.checklist || []).length,
  };
  if (t.done && t.completedAt) v.completed_at = localStamp(t.completedAt);
  if (detailed) {
    v.notes = t.notes || '';
    v.steps = (t.checklist || []).map((s) => ({ step_id: s.id, title: s.title, done: !!s.done }));
    v.repeat_rule = t.repeat || null;
    v.created_at = t.createdAt ? localStamp(t.createdAt) : null;
    v.updated_at = t.updatedAt ? localStamp(t.updatedAt) : null;
    if (t.repeatOf) v.completed_occurrence_of = t.repeatOf;
  }
  return v;
}

/** 'YYYY-MM-DDTHH:MM' of time `ms`, in the zone of the tools' clock (see clock()). */
export function localStamp(ms) {
  if (stampZone) {
    const w = wallParts(ms, stampZone);
    return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
  }
  const d = new Date(ms);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Stored text as a JSON string. Everything a user (or another assistant, a synced tab, an imported
 * backup) named goes into tool text this way: titles, notes and locations, and the names of lists,
 * calendars and labels. So none of it can pose as a field of a line (a second id=, OVERDUE) or as an
 * instruction outside the quotes.
 */
const q = (s) => JSON.stringify(cleanText(s));
/** A task's labels as one quoted string: "@home @phone". */
export const labelsText = (tags) => q(tags.map((x) => '@' + x).join(' '));

export function taskLine(state, t, c) {
  const parts = [q(t.title)];
  if (t.date) parts.push(fmtDay(t.date) + (t.time ? ` ${t.time}` : '') + (t.duration ? ` (${fmtMinutes(t.duration)})` : ''));
  else if (t.time) parts.push(`at ${t.time}`);
  if (t.deadline) parts.push(`deadline ${fmtDay(t.deadline)}`);
  if (isOverdue(t, c.today)) parts.push('OVERDUE');
  if (t.priority) parts.push(priorityLabel(t.priority));
  parts.push(`list ${q(listName(state, t.listId))}`);
  if (t.tags?.length) parts.push(`labels ${labelsText(t.tags)}`);
  if (t.repeat) parts.push(`repeats ${describeRepeat(t.repeat)}`);
  if (t.checklist?.length) parts.push(`${t.checklist.filter((s) => s.done).length}/${t.checklist.length} steps`);
  if (t.done) parts.push(`done${t.completedAt ? ' ' + localStamp(t.completedAt).replace('T', ' ') : ''}`);
  parts.push(`id=${t.id}`);
  return parts.join(' | ');
}

/** Sort open tasks: dated first (date, time), then priority, then manual order. */
export function byDue(a, b) {
  return (a.date || a.deadline || '9999').localeCompare(b.date || b.deadline || '9999') ||
    (a.time || '99').localeCompare(b.time || '99') ||
    (b.priority || 0) - (a.priority || 0) ||
    (a.order ?? 0) - (b.order ?? 0);
}

// ---------------------------------------------------------------- events

const shiftDate = (s, n) => (s.length > 10 ? `${addDaysYmd(s.slice(0, 10), n)}${s.slice(10)}` : addDaysYmd(s, n));
export { shiftDate };

/** Code-unit order of two strings: for 'YYYY-MM-DD(THH:MM)' the time order, and much faster than localeCompare. */
export const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Expand events (incl. repeating ones) into occurrences that touch [fromYmd, toYmd] (inclusive days),
 * sorted (all-day first, then by start). `match(event)`: only events it accepts (checked once per
 * event, before expanding). Wall-clock string arithmetic only, so DST changeover days are never an
 * hour off: an occurrence starts on its own day at the event's time, and ends as many days later as
 * the event does (a year of a few hundred series is tens of thousands of occurrences).
 */
export function instancesBetween(state, fromYmd, toYmd, { calendarIds = null, match = null } = {}) {
  const cals = new Map(state.all('calendars').map((x) => [x.id, x]));
  const out = [];
  const lo = `${fromYmd}T00:00`;
  const hi = `${addDaysYmd(toYmd, 1)}T00:00`;
  for (const e of state.all('events')) {
    if (calendarIds && !calendarIds.includes(e.calendarId)) continue;
    if (typeof e.start !== 'string' || typeof e.end !== 'string') continue;
    const startDate = e.start.slice(0, 10);
    const endDate = e.end.slice(0, 10);
    // Starts after the range (a series too), or a single event that is over before it.
    if (startDate > toYmd || (!e.repeat && endDate < fromYmd)) continue;
    if (match && !match(e)) continue;
    const span = Math.max(0, diffDays(startDate, endDate));
    const dates = e.repeat
      ? occurrencesBetween(e.repeat, startDate, span ? addDaysYmd(fromYmd, -span) : fromYmd, toYmd, { exdates: e.exdates || [], until: e.until || null })
      : [startDate];
    const startTime = e.start.slice(10);
    const endTime = e.end.slice(10);
    const cal = cals.get(e.calendarId);
    const calendar = cal?.name || 'Calendar';
    const hidden = cal?.visible === false;
    for (const d of dates) {
      const start = `${d}${startTime}`;
      const end = `${span ? addDaysYmd(d, span) : d}${endTime}`;
      if (e.allDay) {
        if (end.slice(0, 10) < fromYmd || d > toYmd) continue;
      } else if (!(start < hi && end > lo)) continue;
      out.push({ event: e, occurrence: d, start, end, allDay: !!e.allDay, calendar, hidden });
    }
  }
  return out.sort((a, b) => (a.allDay === b.allDay ? cmpStr(a.start, b.start) || cmpStr(b.end, a.end) : a.allDay ? -1 : 1));
}

export function eventView(i, { detailed = false } = {}) {
  const e = i.event;
  const v = {
    event_id: e.id,
    occurrence: e.repeat ? i.occurrence : null,
    title: e.title,
    calendar: i.calendar,
    calendar_id: e.calendarId,
    all_day: i.allDay,
    start: i.start,
    end: i.end,
    location: e.location || '',
    repeat: describeRepeat(e.repeat),
  };
  if (e.seriesId) v.detached_from = e.seriesId;
  if (detailed) {
    v.notes = e.notes || '';
    v.repeat_rule = e.repeat || null;
    v.until = e.until || null;
    v.exdates = e.exdates || [];
  }
  return v;
}

export function eventLine(i) {
  const e = i.event;
  const when = i.allDay
    ? `${fmtDay(i.start)}${i.end !== i.start ? ` to ${fmtDay(i.end)}` : ''} all day`
    : `${fmtDay(i.start.slice(0, 10))} ${i.start.slice(11)}-${i.end.slice(0, 10) === i.start.slice(0, 10) ? i.end.slice(11) : `${fmtDay(i.end.slice(0, 10))} ${i.end.slice(11)}`}`;
  const parts = [when, q(e.title), `calendar ${q(i.calendar)}`];
  if (e.location) parts.push(`at ${q(e.location)}`);
  if (e.repeat) parts.push(`repeats ${describeRepeat(e.repeat)}`);
  parts.push(`id=${e.id}${e.repeat ? ` occurrence=${i.occurrence}` : ''}`);
  return parts.join(' | ');
}

/**
 * Move a repeat rule with its series when the series start moves to another day: "weekly on Mon"
 * becomes "weekly on Tue", "monthly on the 3rd" becomes "on the 4th". Multi-day patterns such as
 * weekdays are kept as they are.
 */
export function shiftRule(rule, fromYmd, toYmd) {
  if (!rule || fromYmd === toYmd) return rule;
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmd);
  const r = { ...rule };
  if (r.freq === 'week' && r.days?.length === 1 && r.days[0] === a.getDay()) r.days = [b.getDay()];
  if ((r.freq === 'month' || r.freq === 'year') && r.monthDay) r.monthDay = b.getDate();
  return r;
}

export function isOccurrence(e, occurrence) {
  const startDate = e.start.slice(0, 10);
  if (!e.repeat) return occurrence === startDate;
  return occurrencesBetween(e.repeat, startDate, occurrence, occurrence, { exdates: e.exdates || [], until: e.until || null }).includes(occurrence);
}

// ---------------------------------------------------------------- free time

/**
 * Busy intervals (wall minutes) between two wall-clock date-times: timed events and timed tasks.
 * `ignoreTaskIds` lets schedule_tasks move a task without being blocked by its own current slot.
 */
export function busyIntervals(state, fromDT, toDT, { calendarIds = null, tasks = true, ignoreTaskIds = [], defaultTaskMinutes = 30, buffer = 0 } = {}) {
  const out = [];
  const fromYmd = fromDT.slice(0, 10);
  const toYmd = toDT.slice(0, 10);
  for (const i of instancesBetween(state, addDaysYmd(fromYmd, -1), toYmd, { calendarIds })) {
    if (i.allDay) continue;
    out.push([wallMin(i.start) - buffer, wallMin(i.end) + buffer]);
  }
  if (tasks) {
    const ignore = new Set(ignoreTaskIds);
    for (const t of state.all('tasks')) {
      if (t.done || !t.date || !t.time || ignore.has(t.id) || t.date < addDaysYmd(fromYmd, -1) || t.date > toYmd) continue;
      const s = wallMin(`${t.date}T${t.time}`);
      out.push([s - buffer, s + (t.duration || defaultTaskMinutes) + buffer]);
    }
  }
  return mergeIntervals(out);
}

export function mergeIntervals(list) {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Free gaps of at least `duration` minutes inside working hours, between two wall-clock date-times.
 * Returns [{start, end, minutes}] (wall-clock strings), at most `max`.
 */
export function freeSlots(busy, fromDT, toDT, { duration = 30, workStart = '09:00', workEnd = '17:00', excludeWeekends = true, max = 5, roundTo = 15 } = {}) {
  const slots = [];
  const lo = wallMin(fromDT);
  const hi = wallMin(toDT);
  const ws = hhmmToMin(workStart);
  const we = hhmmToMin(workEnd);
  if (we <= ws) fail(`working_hours.end (${workEnd}) must be after working_hours.start (${workStart}).`);
  for (let d = fromDT.slice(0, 10), guard = 0; d <= toDT.slice(0, 10) && guard < 400; d = addDaysYmd(d, 1), guard++) {
    const wd = parseYmd(d).getDay();
    if (excludeWeekends && (wd === 0 || wd === 6)) continue;
    const day0 = wallMin(`${d}T00:00`);
    let a = Math.max(day0 + ws, lo);
    const b = Math.min(day0 + we, hi);
    if (roundTo > 1) a = Math.ceil(a / roundTo) * roundTo;
    if (b - a < duration) continue;
    let cur = a;
    for (const [s, e] of busy) {
      if (e <= cur) continue;
      if (s >= b) break;
      if (s - cur >= duration) slots.push([cur, s]);
      cur = Math.max(cur, roundTo > 1 ? Math.ceil(e / roundTo) * roundTo : e);
      if (cur >= b) break;
    }
    if (b - cur >= duration) slots.push([cur, b]);
    if (slots.length >= max) break;
  }
  return slots.slice(0, max).map(([s, e]) => ({ start: fromWallMin(s), end: fromWallMin(e), minutes: e - s }));
}

export { ymd, parseYmd, addDaysYmd, diffDays, firstOnOrAfter, occurrencesBetween, nlpParse };
