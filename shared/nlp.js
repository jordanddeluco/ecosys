// Natural-language quick-add parser shared by every ecosys app.
//
// Tasks:   "Pay rent every 1st #Home !!"          "Call mom tomorrow 6pm for 20m @phone"
// Events:  "Lunch with Sam fri 1-2pm at Cafe Luna #Work"   "Standup every weekday 9:30am for 15m"
//
// Syntax
//   dates      today · tomorrow · mon…sun · next fri · in 3 days · next week · this weekend
//              dec 5 · 5 december · 12/5 · 2026-12-05 · the 15th · someday
//              Only real dates in years 1000-9999 are read (the stored range, see sanitize.js isYmd).
//              A four-digit year is taken as written; 12/5/26 is 2026. A date without a year is the
//              next one on or after today that exists (feb 29 waits for a leap year, "the 31st" for a
//              month with 31 days). An impossible date ("feb 30", "the 31st of june") stays in the title,
//              and no other rule reads it (not as "the 31st", not as an event's place after "at").
//   date ranges only with `ranges: true` (a caller that reads just `date` would lose the last day)
//              dec 20-28 · dec 30 - jan 2 · from dec 3 to dec 5 · between dec 3 and 5 · 20-28 december
//              12/20-12/28 · 2026-12-20 to 2026-12-28   (separators: - – — to through thru until till)
//              Events: `date` is the first day and `endDate` the last: all day, or with a start and an
//              end time one event from the start on the first day to the end on the last (at most 14
//              days). Tasks: the first day is the date and the last the deadline.
//              Without a year: the range under way when it started nearer to today than the next one
//              starts ("dec 20-28" on Dec 22), else the next one. A backwards, impossible or over-a-year
//              range ("jan 5 - jan 2", "feb 20-30") stays in the title. When a range can't be read whole,
//              only its first day is read and the rest stays in the title: with a repeat, or an event
//              with a time but no end time ("9am", "9am for 2h": one sitting) or timed over 14 days.
//              A number before % is not a day ("nov 25 - 30% off"); nor, after a spaced dash, is a
//              number before a word ("dec 3 - 10 people"), unless the word starts a place or a person
//              ("dec 20 - 28 in Rome", "dec 20 - 28 with Sam").
//   times      5pm · 5:30pm · 17:00 · at 5 · noon · midnight · this morning · afternoon · tonight · in the evening
//   ranges     2-3pm · 10am to 11:30 · from 9 to 5
//   duration   for 30m · for 1.5h · for an hour · 45min   (whole minutes: "0.1m" is not a duration)
//   repeat     daily · weekly · every day · every other week · every 2 months · every weekday
//              every mon, wed · every mon wed fri · every tue/thu · every mon-fri · every fri to sun
//              every 2 weeks on mon and thu
//              weekly on tue, fri · every 15th · every morning (daily at 9) · yearly (keeps its month)
//              intervals go up to 99, like the stored rules: "every 100 days" stays in the title and is
//              reported in `rejectedRepeat` (so a caller can say why nothing repeats)
//   deadline   by friday  (tasks)
//   list       #Work (tasks: list · events: calendar) — unknown #name creates a list
//   tags       @phone (tasks)
//   priority   !  !!  !!!  ·  p1 p2 p3  ·  !high
//   location   at Cafe Luna (events)
//   all-day    all day (events)
//   protect    wrap words in "quotes" to keep them in the title
//   long text  only about the first 2000 characters are read (a phrase across the cut only up to it); the
//              rest stays in the title as typed, or in the place when the place runs up to the cut. Words
//              just before the cut read as in the whole text ("… sat down" is no Saturday, "… dec 3 - 10
//              people" no range)

import { ymd, parseYmd, addDays, addMonths, daysInMonth, diffDays, pad } from './dates.js';

// Every date parse() returns is a real 'YYYY-MM-DD' in these years (shared/sanitize.js isYmd).
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;
// "in N days/weeks/months/years": no larger offset can stay inside the stored years from any date,
// and capping N keeps the date arithmetic far from the limits of Date (no NaN dates).
const MAX_OFFSET = { day: 9000 * 366, week: 9000 * 53, month: 9000 * 12, year: 9000 };
// Largest repeat interval, the same limit as the stored rules (shared/sanitize.js REPEAT_INTERVAL_MAX,
// server/model.mjs normalizeRule): a larger one would be stored as 99, so it is not read at all.
const MAX_INTERVAL = 99;

/** `d` if it is a valid date in the stored years, else null. */
const storable = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) && d.getFullYear() >= MIN_YEAR && d.getFullYear() <= MAX_YEAR ? d : null);
/**
 * The local date y-m-d (m 0-based) if it exists and is in the stored years, else null. Years are taken
 * as written. A day the local time zone skipped (Pacific/Apia has no 2011-12-30) is not a date here:
 * new Date() would move it to the next day.
 */
const calendarDate = (y, m, d) => {
  if (!(y >= MIN_YEAR && y <= MAX_YEAR && m >= 0 && m <= 11 && d >= 1 && d <= daysInMonth(y, m))) return null;
  const x = new Date(y, m, d);
  return x.getDate() === d ? x : null;
};

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2 };
const WD_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD_ABBR = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const WD = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUMW = '(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a\\s+couple\\s+of)';
// "5pm", "5 pm", "5 p.m.", "5p" — a lone a/p must be attached to the number ("2 a day" is not 2am).
const MER = '(\\s*[ap]\\.?m\\.?|[ap])';
const UNIT_M = '(?:m|mins?|minutes?)';
const UNIT_H = '(?:h|hrs?|hours?)';
// Masks over the input, one character each, so positions keep matching the input:
const MARK = '\u0001'; // consumed by a rule: left out of the title
const QUOTE = '\u0002'; // "quoted text": kept in the title, never parsed (it can be or start a place: at "Joe's")
const KEEP = '\u0003'; // a phrase a rule recognised but rejected ("feb 30", "every 100 days"): kept in the title, never parsed, never a place

const wdIndex = (w) => {
  w = w.toLowerCase();
  const i = WD_FULL.indexOf(w);
  return i >= 0 ? i : WD_ABBR[w] ?? -1;
};
const monthIndex = (w) => MONTH_KEYS.indexOf(w.toLowerCase().slice(0, 3));
const num = (w) => {
  w = w.toLowerCase().replace(/\s+of$/, '').replace(/^a\s+/, '');
  return /^\d+$/.test(w) ? parseInt(w, 10) : NUM_WORDS[w] ?? NaN;
};

// Weekdays in a list, as people type them: "mon, wed and fri", "mon wed fri", "tue/thu", "sat & sun",
// "mon, wed, and fri". Spaces alone are enough; "and" is a word of its own. A run of days is one item:
// "mon-fri", "fri - sun", "monday to friday", "mon-wed, fri".
const WD_TO = '(?:\\s*[-–—]\\s*|\\s+(?:to|through|thru|till|until)\\s+)';
const WD_ITEM = `${WD}(?:${WD_TO}${WD})?`;
const WD_LIST = `${WD_ITEM}(?:(?:\\s*[,/&+]\\s*(?:and\\s+)?|\\s+and\\s+|\\s+)${WD_ITEM})*`;
const WD_RUN = new RegExp(`(?<![\\w])(${WD})(?:${WD_TO}(${WD}))?(?![\\w])`, 'gi');
/**
 * The weekdays (0-6) named in a WD_LIST match, once each and Sunday first, as the stored rules keep
 * them. A run is every day from its first to its last, over the weekend if it gets there ("fri-sun").
 */
const listedDays = (s) => {
  const days = new Set();
  for (const x of s.matchAll(WD_RUN)) {
    const from = wdIndex(x[1]);
    const to = x[2] ? wdIndex(x[2]) : from;
    if (from < 0 || to < 0) continue;
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return [...days].sort((a, b) => a - b);
};

// Date ranges: "dec 20-28", "dec 30 - jan 2", "from dec 3 to dec 5", "between dec 3 and 5",
// "20-28 december", "12/20-12/28", "2026-12-20 to 2026-12-28". RANGE matches each end whole;
// rangeEnd() reads it. An end is a date as the single-date rules read it, or a bare day ("28") that
// takes the other end's month and year. A number followed by a percent sign is not a day ("30% off").
const ORD = '(?:st|nd|rd|th)?';
const R_ISO = '\\d{4}-\\d{1,2}-\\d{1,2}';
const R_NUM = '\\d{1,2}/\\d{1,2}(?:/(?:\\d{4}|\\d{2}))?';
const R_MD = `${MON}\\.?\\s+\\d{1,2}${ORD}(?:,?\\s+\\d{4})?`;
const R_DM = `(?:the\\s+)?\\d{1,2}${ORD}\\s+(?:of\\s+)?${MON}(?:,?\\s+\\d{4})?`;
const R_DAY = `(?:the\\s+)?\\d{1,2}${ORD}`;
const RANGE = new RegExp(
  `(?<![\\w/-])(?:(on|by|due|from|between)\\s+)?(${R_ISO}|${R_NUM}|${R_MD}|${R_DM}|${R_DAY})(\\s*[-–—]\\s*|\\s+(?:to|through|thru|until|till|and)\\s+)(${R_ISO}|${R_NUM}|${R_MD}|${R_DM}|${R_DAY}(?:,?\\s+\\d{4})?)(?![\\w/:]|[.,-]\\d|\\s*%)`,
  'gi',
);
const END_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const END_NUM = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?$/;
const END_MD = new RegExp(`^(${MON})\\.?\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?$`, 'i');
const END_DM = new RegExp(`^(?:the\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MON})(?:,?\\s+(\\d{4}))?$`, 'i');
const END_DAY = new RegExp(`^(?:the\\s+)?(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?$`, 'i');
/**
 * One end of a date range: {y, mo, d, dm}. `y` is null without a year, `mo` (0-based) is null for a
 * bare day, `dm` marks a day written before its month ("28 dec"). The numbers are as written: the
 * caller checks them. A numeric date is M/D, or D/M when `dmy`; a two-digit year is 20xx.
 */
function rangeEnd(s, dmy) {
  let m;
  if ((m = END_ISO.exec(s))) return { y: +m[1], mo: +m[2] - 1, d: +m[3], dm: false };
  if ((m = END_NUM.exec(s))) return { y: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null, mo: +(dmy ? m[2] : m[1]) - 1, d: +(dmy ? m[1] : m[2]), dm: false };
  if ((m = END_MD.exec(s))) return { y: m[3] ? +m[3] : null, mo: monthIndex(m[1]), d: +m[2], dm: false };
  if ((m = END_DM.exec(s))) return { y: m[3] ? +m[3] : null, mo: monthIndex(m[2]), d: +m[1], dm: true };
  if ((m = END_DAY.exec(s))) return { y: m[2] ? +m[2] : null, mo: null, d: +m[1], dm: false };
  return null;
}
// A range is at most a year long (the server's limit for an all-day event), and a timed one at most
// 14 days (its limit for a timed event): a longer range with a time is not read whole.
const MAX_RANGE_DAYS = 366;
const MAX_TIMED_MINUTES = 14 * 1440;
// After a spaced dash, a bare last day followed by a word is a quantity ("dec 3 - 10 people"), unless
// the word starts a place or a person: "dec 20 - 28 in Rome", "dec 20 - 28 with Sam".
const RANGE_GOES_ON = /^\s+(?:in|at|on|for|with|and|to|from|by|near|via)(?![\p{L}\p{N}_])/iu;
const minutesOf = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

// A pasted wall of text is read up to about this many characters; the rest is title text as typed (or
// the place's, when the place runs up to the cut).
// Several rules look at the text after each of their matches, so 100,000 characters of "fri fri …"
// took seconds on every keystroke in a field without a limit (Schedule's Create card). A title keeps
// 500 characters, and the callers that send more (the Tasks composer, the server) stop at 1000.
const MAX_PARSE = 2000;
/**
 * Where to stop reading `s`: at the last white space up to MAX_PARSE when there is one near it, never
 * inside a surrogate pair, and never inside "quoted text" (which then stays whole and unread).
 */
function parseEnd(s) {
  if (s.length <= MAX_PARSE) return s.length;
  let sp = MAX_PARSE;
  while (sp > MAX_PARSE - 200 && !/\s/.test(s[sp])) sp--;
  const c = s.charCodeAt(MAX_PARSE - 1);
  const end = sp > MAX_PARSE - 200 ? sp : c >= 0xd800 && c <= 0xdbff ? MAX_PARSE - 1 : MAX_PARSE;
  const quoted = /"[^"]*"/g; // the pairs parse() protects, found the same way
  for (let m; (m = quoted.exec(s)) && m.index < end; ) if (m.index + m[0].length > end) return m.index;
  return end;
}

/**
 * @param {string} input
 * @param {{mode?:'task'|'event', now?:Date, lists?:{id,name}[], calendars?:{id,name}[], hour12?:boolean, dmy?:boolean, ranges?:boolean}} opts
 *   `ranges: true` reads date ranges ("Vacation dec 20-28"): an event's `endDate`, a task's `deadline`.
 *   Off unless asked for, because a caller that keeps only `date` (an event's start, a field that takes
 *   one day) would save the first day of "dec 20-28" and silently drop the rest.
 */
export function parse(input, opts = {}) {
  // Past MAX_PARSE the text is not read: it is added to the title as it is, or to the place when the
  // place runs up to the cut (tokens index the whole input).
  const whole = input;
  const stop = parseEnd(input);
  const unread = input.slice(stop);
  input = input.slice(0, stop);
  // What the rules see past the cut. In the masked text a KEEP stands for the unread words (after a
  // space when they start with one): no rule reads into it, and a place stops at it. A rule that looks
  // at the words after its match sees the first of them as typed (`following`), so "evening news",
  // "sat down" or "dec 3 - 10 people" just before the cut read as they do in the whole text.
  const lead = unread.search(/\S/); // -1: nothing but white space after the cut
  const space = /^\s/.test(unread) ? ' ' : '';
  const beyond = space + (lead < 0 ? '' : unread.slice(lead, lead + 16));
  const mode = opts.mode || 'task';
  const ranges = opts.ranges === true;
  const given = opts.now != null ? new Date(opts.now) : null;
  const now = given && !Number.isNaN(given.getTime()) ? given : new Date(); // an invalid `now` must not give NaN dates
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = storable(today) ? ymd(today) : null;
  const hour12 = opts.hour12 ?? true;
  const dmy = opts.dmy ?? false;

  const out = {
    title: '',
    date: null,
    // Events: the last day of a date range ("Vacation dec 20-28", with opts.ranges), else null. A task
    // reads a range's last day as its deadline instead.
    endDate: null,
    time: null,
    endTime: null,
    duration: null,
    priority: 0,
    tags: [],
    listId: null,
    newList: null,
    calendarId: null,
    repeat: null,
    // The repeat phrase that was recognised but not read because no stored rule can keep it
    // ("every 100 days": intervals are 1-99), as written in the input; it stays in the title.
    rejectedRepeat: null,
    location: null,
    deadline: null,
    someday: false,
    allDay: false,
    tokens: [],
  };
  let timeAmbiguous = false; // the parsed time had no am/pm ("at 7"), so a part of the day may move it

  // Protect "quoted text" from parsing.
  let masked = input.replace(/"[^"]*"/g, (m) => QUOTE.repeat(m.length)) + space + (lead < 0 ? '' : KEEP);
  /** The masked text after position `i` (the end of a match), then the first words past the cut. */
  const following = (i) => masked.slice(i, input.length) + beyond;
  let unreadInPlace = false; // the place ran up to the cut, so the unread words are the place's

  const consume = (start, end, kind, label) => {
    masked = masked.slice(0, start) + MARK.repeat(end - start) + masked.slice(end);
    out.tokens.push({ start, end, kind, text: whole.slice(start, end), label });
  };

  /** Run a global regex over the masked text; `fn(match)` returns a token kind to consume, or false to skip. */
  const rule = (re, fn) => {
    re.lastIndex = 0;
    const found = [];
    let m;
    while ((m = re.exec(masked))) {
      found.push(m);
      if (!m[0].length) re.lastIndex++;
    }
    for (const m of found) {
      if (masked.slice(m.index, m.index + m[0].length).includes(MARK)) continue; // overlapped by an earlier rule
      const kind = fn(m);
      if (kind) consume(m.index, m.index + m[0].length, kind);
    }
  };

  /**
   * Keep a phrase the rules recognised but rejected (an impossible date such as "the 31st of june")
   * as title text that no later rule reads, so "the 31st" is not taken as some other date and
   * "at the 31st of june" is not taken as a place. Its own mask (KEEP, not QUOTE) is what keeps it
   * out of locations: quoted text can be a place, a rejected phrase cannot.
   */
  const protect = (m) => {
    masked = masked.slice(0, m.index) + KEEP.repeat(m[0].length) + masked.slice(m.index + m[0].length);
    return false;
  };

  const setDate = (d, prefix) => {
    if (!storable(d)) return false; // outside years 1000-9999 (e.g. "in 8000 years"): not a date
    const s = ymd(d);
    if (mode === 'task' && prefix && /^by$/i.test(prefix)) {
      if (out.deadline) return false;
      out.deadline = s;
      return 'deadline';
    }
    if (out.date) return false;
    out.date = s;
    return 'date';
  };

  const toHHMM = (h, min, mer, { bare = false } = {}) => {
    h = +h;
    min = +(min || 0);
    if (Number.isNaN(h) || min > 59) return null;
    if (mer) {
      const p = mer.trim()[0].toLowerCase();
      if (h < 1 || h > 12) return null;
      if (p === 'p' && h < 12) h += 12;
      if (p === 'a' && h === 12) h = 0;
    } else if (bare) {
      if (h > 23) return null;
      if (h >= 1 && h <= 6) h += 12; // "at 5" → 5pm
    } else {
      if (h > 23) return null;
      if (hour12 && h >= 1 && h <= 6) h += 12; // "5:30" → 5:30pm in 12-hour locales
    }
    return `${pad(h)}:${pad(min)}`;
  };

  // ---------- lists / calendars (#name) ----------
  const named = (mode === 'task' ? opts.lists : opts.calendars) || [];
  const byLength = [...named].filter((l) => l.name).sort((a, b) => b.name.length - a.name.length);
  {
    const re = /(?<!\S)#/g;
    let m;
    const hits = [];
    while ((m = re.exec(masked))) hits.push(m.index);
    for (const at of hits) {
      const rest = masked.slice(at + 1);
      const low = rest.toLowerCase();
      const hit = byLength.find((l) => low.startsWith(l.name.toLowerCase()) && !/[\p{L}\p{N}_]/u.test(rest[l.name.length] || ''));
      if (hit) {
        if (mode === 'task' ? out.listId || out.newList : out.calendarId) continue;
        if (mode === 'task') out.listId = hit.id;
        else out.calendarId = hit.id;
        consume(at, at + 1 + hit.name.length, 'list', hit.name);
        continue;
      }
      const w = rest.match(/^[\p{L}\p{N}_-]+/u);
      if (w && mode === 'task' && !out.listId && !out.newList) {
        out.newList = w[0];
        consume(at, at + 1 + w[0].length, 'list', w[0]);
      }
    }
  }

  // ---------- tags (@tag), tasks only ----------
  if (mode === 'task') {
    rule(/(?<!\S)@(\p{L}[\p{L}\p{N}_-]*)/gu, (m) => {
      const t = m[1].toLowerCase();
      if (!out.tags.includes(t)) out.tags.push(t);
      return 'tag';
    });
  }

  // ---------- priority ----------
  rule(/(?<!\S)(!{1,3})(?!\S)/g, (m) => {
    if (out.priority) return false;
    out.priority = m[1].length;
    return 'priority';
  });
  rule(/(?<![\w])p([1-4])(?![\w])/gi, (m) => {
    if (out.priority) return false;
    out.priority = Math.max(0, 4 - +m[1]);
    return 'priority';
  });
  rule(/(?<!\S)!(high|hi|medium|med|low|lo)(?![\w])/gi, (m) => {
    if (out.priority) return false;
    out.priority = { high: 3, hi: 3, medium: 2, med: 2, low: 1, lo: 1 }[m[1].toLowerCase()];
    return 'priority';
  });

  // ---------- repeat ----------
  const setRepeat = (r) => {
    if (out.repeat) return false;
    out.repeat = r;
    return 'repeat';
  };
  rule(/(?<![\w])(?:every|each)\s+(weekday|workday|day)s?(?![\w])/gi, (m) =>
    m[1].toLowerCase() === 'day' ? setRepeat({ freq: 'day', interval: 1 }) : setRepeat({ freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] }),
  );
  rule(/(?<![\w])(?:every|each)\s+weekends?(?![\w])/gi, () => setRepeat({ freq: 'week', interval: 1, days: [0, 6] }));
  // "every mon, wed and fri", "every mon wed fri", "every other tue/thu"
  rule(new RegExp(`(?<![\\w])(?:every|each)\\s+(other\\s+)?(${WD_LIST})(?![\\w])`, 'gi'), (m) => setRepeat({ freq: 'week', interval: m[1] ? 2 : 1, days: listedDays(m[2]) }));
  rule(/(?<![\w])(?:every|each)\s+(?:month\s+on\s+the\s+)?(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+(?:the|every)\s+month)?(?![\w])/gi, (m) => {
    const d = +m[1];
    if (d < 1 || d > 31) return false;
    return setRepeat({ freq: 'month', interval: 1, monthDay: d });
  });
  // "every 2 weeks", "every other month", "every week on mon and thu" (a week's days can follow "on")
  rule(new RegExp(`(?<![\\w])(?:every|each)\\s+(other\\s+)?(?:(${NUMW})\\s+)?(?:(day|month|year)s?|weeks?(\\s+on\\s+(${WD_LIST}))?)(?![\\w])`, 'gi'), (m) => {
    const n = m[1] ? 2 : m[2] ? num(m[2]) : 1;
    if (!(n >= 1 && n <= MAX_INTERVAL)) {
      // "every 1000 days" is not stored as some other interval: it stays in the title, and the
      // caller learns why (the server answers "use every 1 to 99 days, ..." instead of saving a
      // task that does not repeat). The phrase is the interval ("every 0 weeks"), not the days after it.
      const phrase = m[0].slice(0, m[0].length - (m[4] || '').length);
      out.rejectedRepeat ??= input.slice(m.index, m.index + phrase.length);
      return protect({ index: m.index, 0: phrase });
    }
    const r = { freq: m[3] ? m[3].toLowerCase() : 'week', interval: n };
    if (m[5]) r.days = listedDays(m[5]);
    return setRepeat(r);
  });
  // "weekly", "biweekly on tue, fri"
  rule(new RegExp(`(?<![\\w])(?:(daily|monthly|yearly|annually)|(weekly|biweekly|fortnightly)(?:\\s+on\\s+(${WD_LIST}))?)(?![\\w])`, 'gi'), (m) => {
    const w = (m[1] || m[2]).toLowerCase();
    const map = { daily: ['day', 1], weekly: ['week', 1], monthly: ['month', 1], yearly: ['year', 1], annually: ['year', 1], biweekly: ['week', 2], fortnightly: ['week', 2] };
    const r = { freq: map[w][0], interval: map[w][1] };
    if (m[3]) r.days = listedDays(m[3]);
    return setRepeat(r);
  });

  // ---------- all day (events) ----------
  if (mode === 'event') {
    rule(/(?<![\w])all[\s-]?day(?![\w])/gi, () => {
      out.allDay = true;
      return 'allday';
    });
  }

  // ---------- time ranges ----------
  const T = `(\\d{1,2})(?::([0-5]\\d))?${MER}?`;
  rule(new RegExp(`(?<![\\w:])(?:(from|at|@)\\s*)?${T}\\s*(?:-|–|—|to|until|till)\\s*${T}(?![\\w:])`, 'gi'), (m) => {
    if (out.time) return false;
    const [, prefix, h1, m1, mer1, h2, m2, mer2] = m;
    if (!(prefix || mer1 || mer2 || m1 || m2)) return false;
    let start;
    let end;
    if (mer2 && !mer1) {
      end = toHHMM(h2, m2, mer2);
      start = toHHMM(h1, m1, mer2);
      if (start && end && start > end) start = toHHMM(h1, m1, mer2[0].toLowerCase() === 'p' ? 'a' : 'p');
    } else if (mer1 && !mer2) {
      start = toHHMM(h1, m1, mer1);
      end = toHHMM(h2, m2, mer1);
      if (start && end && end <= start) end = toHHMM(h2, m2, mer1[0].toLowerCase() === 'a' ? 'p' : 'a');
    } else if (mer1 && mer2) {
      start = toHHMM(h1, m1, mer1);
      end = toHHMM(h2, m2, mer2);
    } else {
      start = toHHMM(h1, m1, null, { bare: !m1 });
      end = toHHMM(h2, m2, null, { bare: !m2 });
      if (start && end && end <= start && +h2 < 12) end = toHHMM(+h2 + 12, m2, null);
    }
    if (!start || !end) return false;
    out.time = start;
    out.endTime = end;
    timeAmbiguous = !mer1 && !mer2;
    return 'time';
  });

  // ---------- single times ----------
  const setTime = (t, ambiguous = false) => {
    if (!t || out.time) return false;
    out.time = t;
    timeAmbiguous = ambiguous;
    return 'time';
  };
  rule(new RegExp(`(?<![\\w:])(?:(?:at|@)\\s*)?(\\d{1,2})(?::([0-5]\\d))?${MER}(?![\\w])`, 'gi'), (m) => setTime(toHHMM(m[1], m[2], m[3])));
  rule(/(?<![\w:])(?:(?:at|@)\s*)?([01]?\d|2[0-3]):([0-5]\d)(?![\w:])/gi, (m) => setTime(toHHMM(m[1], m[2], null), +m[1] <= 12));
  // "at 5" is a time, but "at 4/30" is a date ("Meeting at 4/30" used to be 16:00, title "Meeting /30")
  rule(/(?<![\w])(?:at|@)\s*(\d{1,2})(?![\w:./])/gi, (m) => setTime(toHHMM(m[1], 0, null, { bare: true }), true));
  rule(/(?<![\w])(?:at\s+)?(noon|midday)(?![\w])/gi, () => setTime('12:00'));
  rule(/(?<![\w])(?:at\s+)?midnight(?![\w])/gi, () => setTime('23:59'));

  // ---------- parts of the day ----------
  // "this morning", "in the evening" and "tonight" always count. A bare "morning" / "afternoon" /
  // "evening" only counts at the end or right next to another parsed token ("tomorrow morning"),
  // so "Read evening news" keeps its title; the rules run again after dates for "tomorrow evening …".
  // A time given without am/pm moves into that part of the day: "at 7 in the evening" is 19:00.
  const besideToken = (m) => {
    const after = following(m.index + m[0].length);
    if (after.split(MARK).join('').trim() === '') return true;
    return after.replace(/^\s+/, '').startsWith(MARK) || masked.slice(0, m.index).replace(/\s+$/, '').endsWith(MARK);
  };
  const shiftAmbiguous = (pm) => {
    if (!timeAmbiguous) return;
    const move = (t) => {
      if (!t) return t;
      const [h, mi] = t.split(':').map(Number);
      if (pm && h < 12) return `${pad(h + 12)}:${pad(mi)}`;
      if (!pm && h >= 12) return `${pad(h - 12)}:${pad(mi)}`;
      return t;
    };
    out.time = move(out.time);
    out.endTime = move(out.endTime);
    timeAmbiguous = false;
  };
  const DAYPART_TIME = { morning: '09:00', afternoon: '14:00', evening: '18:00', night: '21:00' };
  // "every morning" / "each evening": daily, at that part of the day ("every evening at 7" is 19:00).
  rule(/(?<![\w])(?:every|each)\s+(morning|afternoon|evening|night)(?![\w])/gi, (m) => {
    const part = m[1].toLowerCase();
    if (!setRepeat({ freq: 'day', interval: 1 })) return false;
    if (out.time) shiftAmbiguous(part !== 'morning');
    else setTime(DAYPART_TIME[part]);
    return 'repeat';
  });
  // An event's date range over several days is read only with an end time, so a part of the day found
  // after it ("Trip dec 3-5 evening": a lone start time) stays in the title instead of stretching it.
  const spansDays = () => mode === 'event' && !!out.endDate && out.endDate > out.date;
  const dayparts = () => {
    rule(/(?<![\w])(this\s+|in\s+the\s+)?(morning|afternoon)(?![\w])/gi, (m) => {
      if (spansDays()) return false;
      if (!m[1] && !besideToken(m)) return false;
      const morning = m[2].toLowerCase() === 'morning';
      if (/^this/i.test(m[1] || '') && !out.date) out.date = todayStr; // like "this evening"
      if (out.time) shiftAmbiguous(!morning);
      else setTime(DAYPART_TIME[morning ? 'morning' : 'afternoon']);
      return 'time';
    });
    rule(/(?<![\w])(tonight|this\s+evening|in\s+the\s+evening|evening)(?![\w])/gi, (m) => {
      if (spansDays()) return false;
      const w = m[1].toLowerCase().replace(/\s+/g, ' ');
      if (w === 'evening' && !besideToken(m)) return false;
      const isTonight = w === 'tonight' || w === 'this evening';
      if (isTonight && !out.date) out.date = todayStr;
      if (out.time) shiftAmbiguous(true);
      else setTime(isTonight ? '19:00' : '18:00');
      return 'time';
    });
  };
  dayparts();

  // ---------- durations ----------
  /** Whole minutes; less than one ("0.1m", "0.001h" round to 0) is not a duration and stays in the title. */
  const setDuration = (mins) => {
    const n = Math.round(mins);
    if (!(n >= 1 && Number.isFinite(n)) || out.duration) return false;
    out.duration = n;
    return 'duration';
  };
  rule(new RegExp(`(?<![\\w])for\\s+(\\d+(?:\\.\\d+)?)\\s*${UNIT_H}(?:\\s*(?:and\\s+)?(\\d+)\\s*${UNIT_M})?(?![\\w])`, 'gi'), (m) => setDuration(parseFloat(m[1]) * 60 + (m[2] ? +m[2] : 0)));
  rule(new RegExp(`(?<![\\w])for\\s+(\\d+)\\s*${UNIT_M}(?![\\w])`, 'gi'), (m) => setDuration(+m[1]));
  rule(/(?<![\w])for\s+(an?|one)\s+(?:hour|hr)(?:\s+and\s+a\s+half)?(?![\w])/gi, (m) => setDuration(/half/i.test(m[0]) ? 90 : 60));
  rule(/(?<![\w])for\s+half\s+an?\s+hour(?![\w])/gi, () => setDuration(30));
  rule(/(?<![\w])for\s+(\d+)\s*(?:h|hr)\s*(\d+)\s*m?(?![\w])/gi, (m) => setDuration(+m[1] * 60 + +m[2]));
  rule(new RegExp(`(?<![\\w])(\\d+(?:\\.\\d+)?)(${UNIT_H}|${UNIT_M})(?![\\w])`, 'gi'), (m) => {
    const isH = /^h/i.test(m[2]);
    return setDuration(isH ? parseFloat(m[1]) * 60 : +m[1]);
  });

  // ---------- dates ----------
  const PRE = '(?:(on|by|due)\\s+)?';
  rule(new RegExp(`(?<![\\w])${PRE}(today|tdy)(?![\\w])`, 'gi'), (m) => setDate(today, m[1]));
  rule(new RegExp(`(?<![\\w])${PRE}(tomorrow|tmrw|tmr|tmw)(?![\\w])`, 'gi'), (m) => setDate(addDays(today, 1), m[1]));
  rule(new RegExp(`(?<![\\w])(?:(by)\\s+)?in\\s+(${NUMW})\\s+(day|week|month|year)s?(?![\\w])`, 'gi'), (m) => {
    const n = num(m[2]);
    const u = m[3].toLowerCase();
    if (!(n >= 1 && n <= MAX_OFFSET[u])) return false; // (setDate also rejects a result after 9999)
    const d = u === 'day' ? addDays(today, n) : u === 'week' ? addDays(today, 7 * n) : addMonths(today, u === 'month' ? n : 12 * n);
    return setDate(d, m[1]);
  });
  rule(/(?<![\w])(?:(by)\s+)?(next|this)\s+(week|weekend|month|year)(?![\w])/gi, (m) => {
    const which = m[2].toLowerCase();
    const unit = m[3].toLowerCase();
    const wd = today.getDay();
    let d;
    if (unit === 'week') {
      if (which === 'this') return false;
      d = addDays(today, ((1 - wd + 7) % 7) || 7); // next Monday
    } else if (unit === 'weekend') {
      const toSat = wd === 0 ? -1 : (6 - wd + 7) % 7;
      d = addDays(today, which === 'this' ? Math.max(0, toSat) : (toSat < 0 ? 6 : toSat + 7));
    } else if (unit === 'month') {
      if (which === 'this') return false;
      d = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    } else {
      if (which === 'this') return false;
      d = new Date(today.getFullYear() + 1, 0, 1);
    }
    return setDate(d, m[1]);
  });
  /** The first date on or after `from` on month `mo` (0-based), day `da` that exists, or null (April 31). */
  const onOrAfter = (from, mo, da) => {
    // Feb 29 can be 8 years away (2096 → 2104); any other day is at most a year away.
    for (let k = 0; k <= 8; k++) {
      const d = calendarDate(from.getFullYear() + k, mo, da);
      if (d && d >= from) return d;
    }
    return null;
  };
  /** The last date on or before `to` on month `mo`, day `da` that exists, or null. */
  const onOrBefore = (to, mo, da) => {
    for (let k = 0; k <= 8; k++) {
      const d = calendarDate(to.getFullYear() - k, mo, da);
      if (d && d <= to) return d;
    }
    return null;
  };
  /** The first date on or after today on month `mo` (0-based), day `da` that exists, or null (April 31). */
  const nextMonthDay = (mo, da) => onOrAfter(today, mo, da);

  // Date ranges (with opts.ranges), before the single dates they are made of. An event runs from the
  // first day to the last (`endDate`); a task is planned for the first day and due on the last (its
  // deadline). A bare day takes the other end's month ("dec 20-28", "20-28 dec"). Without a year: the
  // range under way when it began nearer to today than the next one begins (on Dec 22 "dec 20-28" is
  // this year's; on Nov 22 "feb 5 - jan 2" is next February's, not one that began last February),
  // else the next one; with a year on one end, the other end is the next or last such date.
  // Not a range: two bare numbers ("pages 20-28"), a bare day before the other end's ("dec 30-2",
  // "dec 3 - 2 hours"), a quantity ("dec 3 - 10 people", "nov 25 - 30% off"), "and" without
  // "between", a day already read. A range that is backwards, impossible or longer than a year
  // ("jan 5 - jan 2", "feb 20-30") stays in the title, like an impossible date. Of a range that can't
  // be read whole only the first day is read, and the rest stays in the title: with a repeat (whose
  // days are the repeat's), and for an event over several days with a time but no end time ("9am",
  // "9am for 2h": one sitting) or timed for over 14 days.
  if (ranges) {
    rule(RANGE, (m) => {
      const [all, prefix = '', aText, sep, bText] = m;
      if (/^and$/i.test(sep.trim()) && prefix.toLowerCase() !== 'between') return false; // "dec 3 and dec 5": two days
      if (out.date || out.deadline) return false;
      const after = following(m.index + all.length);
      // (the regex checked its end on a stand-in for the words past the cut: check it on them)
      if (/^(?:[\w/:]|[.,-]\d|\s*%)/.test(after)) return false;
      const a = rangeEnd(aText, dmy);
      const b = rangeEnd(bText, dmy);
      if (!a || !b || (a.mo === null && b.mo === null)) return false;
      // "3-5 dec 4" is pages 3-5 on Dec 4, not Dec 3-5: a bare first day needs a day-month end ("20-28 dec")
      if (a.mo === null && (!b.dm || /^\s*\d/.test(after))) return false;
      // "dec 3 - 10 people", "12/5 - 12 boxes": a number after a spaced dash, then a word, is how many
      if (/^\d{1,2}$/.test(bText) && /\s/.test(sep) && /^[-–—]$/.test(sep.trim()) && /^\s+\p{L}/u.test(after) && !RANGE_GOES_ON.test(after)) return false;
      if (a.mo === null || b.mo === null) {
        // one month (and year) for both ends
        if (b.d < a.d || (a.y !== null && b.y !== null && a.y !== b.y)) return false;
        a.mo ??= b.mo;
        b.mo ??= a.mo;
        a.y ??= b.y;
        b.y ??= a.y;
      }
      if (a.mo < 0 || a.mo > 11 || b.mo < 0 || b.mo > 11 || a.d < 1 || a.d > 31 || b.d < 1 || b.d > 31) return false; // "13/5-14/5": not dates
      // "jan 5 - jan 2" is backwards, not a year long (both years written: as written)
      if (a.mo === b.mo && b.d < a.d && (a.y === null || b.y === null)) return protect(m);
      let first = null;
      let last = null;
      if (a.y !== null && b.y !== null) {
        first = calendarDate(a.y, a.mo, a.d);
        last = calendarDate(b.y, b.mo, b.d);
      } else if (a.y !== null) {
        first = calendarDate(a.y, a.mo, a.d);
        last = first && onOrAfter(first, b.mo, b.d);
      } else if (b.y !== null) {
        last = calendarDate(b.y, b.mo, b.d);
        first = last && onOrBefore(last, a.mo, a.d);
      } else {
        let under = null; // the range under way, if any
        for (let k = -1; k <= 8 && !last; k++) {
          const from = calendarDate(today.getFullYear() + k, a.mo, a.d);
          const to = from && onOrAfter(from, b.mo, b.d);
          if (!to || to < today || diffDays(from, to) > MAX_RANGE_DAYS) continue;
          if (from < today) under ??= [from, to];
          else [first, last] = under && diffDays(under[0], today) <= diffDays(today, from) ? under : [from, to];
        }
        if (!last && under) [first, last] = under;
      }
      if (!first || !last || last < first || diffDays(first, last) > MAX_RANGE_DAYS) return protect(m);
      out.date = ymd(first);
      const split = m.index + all.length - sep.length - bText.length; // where the separator starts
      // Only the first day of a repeat's range ("every weekday dec 1-5"), or of an event's range over
      // several days with a time that is not a start and an end ("dec 3-5 9am", "9am for 2h": one
      // sitting), or a timed one over 14 days: the first end (with its prefix) is the date.
      const timed = mode === 'event' && out.time && !out.allDay && last > first;
      if (out.repeat || (timed && (!out.endTime || out.duration || diffDays(first, last) * 1440 + minutesOf(out.endTime) - minutesOf(out.time) > MAX_TIMED_MINUTES))) {
        consume(m.index, split, 'date');
        return false;
      }
      if (mode === 'event') {
        out.endDate = ymd(last);
        return 'date';
      }
      // A task: the first end (with its prefix) is the date, the second (from the separator) the deadline.
      out.deadline = ymd(last);
      consume(m.index, split, 'date');
      consume(split + sep.length - sep.trimStart().length, m.index + all.length, 'deadline');
      return false;
    });
  }
  // ISO 2026-12-05 (the year as written: 0099-12-31 is year 99, outside the stored years)
  rule(new RegExp(`(?<![\\w-])${PRE}(\\d{4})-(\\d{1,2})-(\\d{1,2})(?![\\w-])`, 'gi'), (m) => {
    const d = calendarDate(+m[2], +m[3] - 1, +m[4]);
    return d ? setDate(d, m[1]) : protect(m);
  });
  // 12/5 or 12/5/2026 (M/D, or D/M when dmy); 12/5/26 is 2026, a four-digit year is read as written
  rule(new RegExp(`(?<![\\w/])${PRE}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?(?![\\w/])`, 'gi'), (m) => {
    const mo = +(dmy ? m[3] : m[2]) - 1;
    const da = +(dmy ? m[2] : m[3]);
    if (mo < 0 || mo > 11 || da < 1 || da > 31) return false;
    const d = m[4] ? calendarDate(m[4].length === 2 ? 2000 + +m[4] : +m[4], mo, da) : nextMonthDay(mo, da);
    return d ? setDate(d, m[1]) : protect(m);
  });
  // "dec 5" / "5 december 2026" / "the 5th of dec": checked against that year's calendar
  const monthDay = (m, mo, da, y, prefix) => {
    if (mo < 0 || da < 1 || da > 31) return false;
    const d = y ? calendarDate(+y, mo, da) : nextMonthDay(mo, da);
    return d ? setDate(d, prefix) : protect(m);
  };
  rule(new RegExp(`(?<![\\w])${PRE}(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\w])`, 'gi'), (m) => monthDay(m, monthIndex(m[2]), +m[3], m[4], m[1]));
  rule(new RegExp(`(?<![\\w])${PRE}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})(?:,?\\s+(\\d{4}))?(?![\\w])`, 'gi'), (m) => monthDay(m, monthIndex(m[3]), +m[2], m[4], m[1]));
  // weekdays: full names anywhere; abbreviations ("fri", "sun") only with a prefix, at the end of the
  // input, or right next to another parsed token ("fri 1pm") — so "Buy sun cream" stays a title.
  rule(new RegExp(`(?<![\\w])(?:(on|by|due|this|next|coming)\\s+)?(${WD})(?![\\w])`, 'gi'), (m) => {
    const word = m[2].toLowerCase();
    const idx = wdIndex(word);
    if (idx < 0) return false;
    const full = WD_FULL.includes(word);
    const after = following(m.index + m[0].length);
    const atEnd = after.replace(new RegExp(MARK, 'g'), '').trim() === '';
    const nextToToken =
      after.replace(/^\s+/, '').startsWith(MARK) ||
      masked.slice(0, m.index).replace(/\s+$/, '').endsWith(MARK) ||
      /^\s+(?:morning|afternoon|evening|night)(?![\w])/i.test(after); // "fri morning"
    if (!full && !m[1] && !atEnd && !nextToToken) return false;
    const p = (m[1] || '').toLowerCase();
    let delta = (idx - today.getDay() + 7) % 7;
    if (p === 'next' && delta === 0) delta = 7;
    return setDate(addDays(today, delta), p === 'by' ? 'by' : null);
  });
  // "the 15th" / "on the 3rd": the first month from this one that has that day, on or after today
  // ("the 30th" read on Jan 31 is Mar 30, never a day that spilled over into the next month)
  rule(/(?<![\w])(?:(on|by|due)\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)(?![\w])/gi, (m) => {
    const da = +m[2];
    if (da < 1 || da > 31) return false;
    for (let k = 0; k < 12; k++) {
      const at = today.getMonth() + k;
      const d = calendarDate(today.getFullYear() + Math.floor(at / 12), at % 12, da);
      if (d && d >= today) return setDate(d, m[1]);
    }
    return false;
  });
  dayparts(); // second pass: "tomorrow morning", now that "tomorrow" is a token
  if (mode === 'task') {
    rule(/(?<![\w])some\s?day(?![\w])/gi, () => {
      out.someday = true;
      return 'date';
    });
  }

  // ---------- location (events): "at <place>" up to the next parsed token ----------
  // A place starts with a letter or "quoted text", and ends before the next parsed token or rejected
  // phrase: "Party at 2026-02-30" has no place, "Party at Cafe Luna feb 30" is at Cafe Luna.
  if (mode === 'event') {
    const re = new RegExp(`(?<![\\w])(?:at|@)\\s+(?=[\\p{L}${QUOTE}${KEEP}])`, 'giu');
    // A place can also start at the cut, in the unread words, when they start with a letter or quoted
    // text (the quote then has its pair in them, as parse() pairs quotes); a rejected phrase never does.
    const placeBeyond = /^\s*\p{L}/u.test(beyond) || (unread[lead] === '"' && unread.indexOf('"', lead + 1) > 0);
    let m;
    const found = [];
    while ((m = re.exec(masked))) found.push(m);
    for (const f of found) {
      if (out.location) break;
      const startText = f.index + f[0].length;
      if (masked[startText] === KEEP && !(startText >= input.length && placeBeyond)) continue;
      let end = masked.length;
      for (const stop of [MARK, KEEP]) {
        const at = masked.indexOf(stop, startText);
        if (at >= 0 && at < end) end = at;
      }
      const withIdx = masked.slice(startText, end).search(/\s+with\s+/i);
      if (withIdx >= 0) end = startText + withIdx;
      // A place that runs up to the cut takes the unread words too, as it does when nothing follows it:
      // they are the place's, not the title's. (A trailing run of marks is matched only where it starts:
      // trying every position in a long run took seconds.)
      const from = Math.min(startText, input.length); // (past the cut, the masked text has a stand-in)
      const inPlace = unread !== '' && end >= input.length;
      const text = input.slice(from, end) + (inPlace ? unread : '');
      const loc = text.replace(/"/g, '').trim().replace(/(?<![,.;])[,.;]+$/, '');
      if (!loc) continue;
      out.location = loc;
      unreadInPlace = inPlace;
      consume(f.index, from + text.trimEnd().length, 'location');
    }
  }

  // ---------- repeat implies a first date ----------
  if (out.repeat && !out.date) {
    const r = out.repeat;
    let d = today;
    if (r.freq === 'week' && r.days?.length) {
      for (let i = 0; i < 7; i++) {
        const x = addDays(today, i);
        if (r.days.includes(x.getDay())) {
          d = x;
          break;
        }
      }
    } else if (r.freq === 'month' && r.monthDay) {
      const x = new Date(today.getFullYear(), today.getMonth(), Math.min(r.monthDay, daysInMonth(today.getFullYear(), today.getMonth())));
      d = x >= today ? x : addMonths(x, 1, r.monthDay);
    }
    out.date = storable(d) ? ymd(d) : todayStr;
  }
  if (out.repeat && out.date) {
    const anchor = parseYmd(out.date); // out.date is always a real date here, so no weekday NaN
    if (out.repeat.freq === 'week' && !out.repeat.days) out.repeat.days = [anchor.getDay()];
    if ((out.repeat.freq === 'month' || out.repeat.freq === 'year') && !out.repeat.monthDay) out.repeat.monthDay = anchor.getDate();
    if (out.repeat.freq === 'year' && !out.repeat.month) out.repeat.month = anchor.getMonth() + 1;
  }

  // ---------- event defaults ----------
  if (mode === 'event') {
    if (out.time && !out.date) out.date = todayStr;
    if (out.date && !out.time) out.allDay = true;
    // A timed date range runs from its start time on the first day to its end time on the last
    // ("Conference dec 3-5 9am-5pm", at most 14 days: the range rule reads no other timed range).
    // `duration` is the whole span.
    if (out.endDate && out.endDate > out.date && out.time && out.endTime && !out.allDay) out.duration = diffDays(out.date, out.endDate) * 1440 + minutesOf(out.endTime) - minutesOf(out.time);
    if (out.allDay) {
      out.time = null;
      out.endTime = null;
    }
  }
  if (out.time && out.endTime && !out.duration) {
    const [h1, m1] = out.time.split(':').map(Number);
    const [h2, m2] = out.endTime.split(':').map(Number);
    out.duration = h2 * 60 + m2 - (h1 * 60 + m1);
    if (out.duration <= 0) out.duration += 1440; // 10pm–1am crosses midnight
  }

  // ---------- title: the input minus consumed tokens ----------
  let title = '';
  for (let i = 0; i < input.length; i++) if (masked[i] !== MARK) title += input[i];
  title = (title + (unreadInPlace ? '' : unread))
    .replace(/"([^"]*)"/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:–—-]+|(?<![\s,;:–—-])[\s,;:–—-]+$/g, '') // (a trailing run only where it starts, as for the place)
    .trim();
  out.title = title;
  out.tokens.sort((a, b) => a.start - b.start);
  return out;
}
