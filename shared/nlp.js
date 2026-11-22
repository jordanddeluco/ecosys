// Natural-language quick-add parser shared by every ecosys app.
//
// Tasks:   "Pay rent every 1st #Home !!"          "Call mom tomorrow 6pm for 20m @phone"
// Events:  "Lunch with Sam fri 1-2pm at Cafe Luna #Work"   "Standup every weekday 9:30am for 15m"
//
// Syntax
//   dates      today · tomorrow · mon…sun · next fri · in 3 days · next week · this weekend
//              dec 5 · 5 december · 12/5 · 2026-12-05 · the 15th · someday
//   times      5pm · 5:30pm · 17:00 · at 5 · noon · midnight · morning · afternoon · tonight
//   ranges     2-3pm · 10am to 11:30 · from 9 to 5
//   duration   for 30m · for 1.5h · for an hour · 45min
//   repeat     daily · weekly · every day · every other week · every 2 months · every weekday
//              every mon, wed · every 15th
//   deadline   by friday  (tasks)
//   list       #Work (tasks: list · events: calendar) — unknown #name creates a list
//   tags       @phone (tasks)
//   priority   !  !!  !!!  ·  p1 p2 p3  ·  !high
//   location   at Cafe Luna (events)
//   all-day    all day (events)
//   protect    wrap words in "quotes" to keep them in the title

import { ymd, addDays, addMonths, daysInMonth, pad } from './dates.js';

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
const MARK = '\u0001';

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

/**
 * @param {string} input
 * @param {{mode?:'task'|'event', now?:Date, lists?:{id,name}[], calendars?:{id,name}[], hour12?:boolean, dmy?:boolean}} opts
 */
export function parse(input, opts = {}) {
  const mode = opts.mode || 'task';
  const now = opts.now || new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hour12 = opts.hour12 ?? true;
  const dmy = opts.dmy ?? false;

  const out = {
    title: '',
    date: null,
    time: null,
    endTime: null,
    duration: null,
    priority: 0,
    tags: [],
    listId: null,
    newList: null,
    calendarId: null,
    repeat: null,
    location: null,
    deadline: null,
    someday: false,
    evening: false,
    allDay: false,
    tokens: [],
  };

  // Protect "quoted text" from parsing.
  let masked = input.replace(/"[^"]*"/g, (m) => '\u0002'.repeat(m.length));

  const consume = (start, end, kind, label) => {
    masked = masked.slice(0, start) + MARK.repeat(end - start) + masked.slice(end);
    out.tokens.push({ start, end, kind, text: input.slice(start, end), label });
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

  const setDate = (d, prefix) => {
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
  rule(new RegExp(`(?<![\\w])(?:every|each)\\s+(other\\s+)?(${WD}(?:\\s*(?:,|and|&|\\+)\\s*${WD})*)(?![\\w])`, 'gi'), (m) => {
    const days = [...new Set(m[2].split(/\s*(?:,|and|&|\+)\s*/i).map(wdIndex).filter((x) => x >= 0))];
    return setRepeat({ freq: 'week', interval: m[1] ? 2 : 1, days });
  });
  rule(/(?<![\w])(?:every|each)\s+(?:month\s+on\s+the\s+)?(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+(?:the|every)\s+month)?(?![\w])/gi, (m) => {
    const d = +m[1];
    if (d < 1 || d > 31) return false;
    return setRepeat({ freq: 'month', interval: 1, monthDay: d });
  });
  rule(new RegExp(`(?<![\\w])(?:every|each)\\s+(other\\s+)?(?:(${NUMW})\\s+)?(day|week|month|year)s?(?![\\w])`, 'gi'), (m) => {
    const n = m[1] ? 2 : m[2] ? num(m[2]) : 1;
    if (!n || Number.isNaN(n)) return false;
    return setRepeat({ freq: m[3].toLowerCase(), interval: n });
  });
  rule(/(?<![\w])(daily|weekly|monthly|yearly|annually|biweekly|fortnightly)(?![\w])/gi, (m) => {
    const w = m[1].toLowerCase();
    const map = { daily: ['day', 1], weekly: ['week', 1], monthly: ['month', 1], yearly: ['year', 1], annually: ['year', 1], biweekly: ['week', 2], fortnightly: ['week', 2] };
    return setRepeat({ freq: map[w][0], interval: map[w][1] });
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
    return 'time';
  });

  // ---------- single times ----------
  const setTime = (t) => {
    if (!t || out.time) return false;
    out.time = t;
    return 'time';
  };
  rule(new RegExp(`(?<![\\w:])(?:(?:at|@)\\s*)?(\\d{1,2})(?::([0-5]\\d))?${MER}(?![\\w])`, 'gi'), (m) => setTime(toHHMM(m[1], m[2], m[3])));
  rule(/(?<![\w:])(?:(?:at|@)\s*)?([01]?\d|2[0-3]):([0-5]\d)(?![\w:])/gi, (m) => setTime(toHHMM(m[1], m[2], null)));
  rule(/(?<![\w])(?:at|@)\s*(\d{1,2})(?![\w:.])/gi, (m) => setTime(toHHMM(m[1], 0, null, { bare: true })));
  rule(/(?<![\w])(?:at\s+)?(noon|midday)(?![\w])/gi, () => setTime('12:00'));
  rule(/(?<![\w])(?:at\s+)?midnight(?![\w])/gi, () => setTime('23:59'));
  rule(/(?<![\w])(?:this\s+|in\s+the\s+)?morning(?![\w])/gi, () => setTime('09:00'));
  rule(/(?<![\w])(?:this\s+|in\s+the\s+)?afternoon(?![\w])/gi, () => setTime('14:00'));
  rule(/(?<![\w])(tonight|this\s+evening|(?:in\s+the\s+)?evening)(?![\w])/gi, (m) => {
    const isTonight = !/^(in the )?evening$/i.test(m[1].replace(/\s+/g, ' '));
    if (mode === 'task') {
      out.evening = true;
      if (isTonight && !out.date) out.date = ymd(today);
      return 'date';
    }
    if (isTonight && !out.date) out.date = ymd(today);
    if (!out.time) out.time = isTonight ? '19:00' : '18:00';
    return 'time';
  });

  // ---------- durations ----------
  const setDuration = (mins) => {
    if (!mins || out.duration) return false;
    out.duration = Math.round(mins);
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
    if (!n || Number.isNaN(n)) return false;
    const u = m[3].toLowerCase();
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
  // ISO 2026-12-05
  rule(new RegExp(`(?<![\\w-])${PRE}(\\d{4})-(\\d{1,2})-(\\d{1,2})(?![\\w-])`, 'gi'), (m) => {
    const d = new Date(+m[2], +m[3] - 1, +m[4]);
    if (d.getMonth() !== +m[3] - 1) return false;
    return setDate(d, m[1]);
  });
  // 12/5 or 12/5/2026 (M/D, or D/M when dmy)
  rule(new RegExp(`(?<![\\w/])${PRE}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?(?![\\w/])`, 'gi'), (m) => {
    let mo = +(dmy ? m[3] : m[2]);
    let da = +(dmy ? m[2] : m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > daysInMonth(2024, mo - 1)) return false;
    let y = m[4] ? +m[4] : today.getFullYear();
    if (y < 100) y += 2000;
    let d = new Date(y, mo - 1, da);
    if (!m[4] && d < today) d = new Date(y + 1, mo - 1, da);
    return setDate(d, m[1]);
  });
  const monthDay = (mo, da, y, prefix) => {
    if (mo < 0 || da < 1 || da > 31) return false;
    let year = y ? +y : today.getFullYear();
    if (da > daysInMonth(year, mo)) return false;
    let d = new Date(year, mo, da);
    if (!y && d < today) d = new Date(year + 1, mo, Math.min(da, daysInMonth(year + 1, mo)));
    return setDate(d, prefix);
  };
  rule(new RegExp(`(?<![\\w])${PRE}(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\w])`, 'gi'), (m) => monthDay(monthIndex(m[2]), +m[3], m[4], m[1]));
  rule(new RegExp(`(?<![\\w])${PRE}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})(?:,?\\s+(\\d{4}))?(?![\\w])`, 'gi'), (m) => monthDay(monthIndex(m[3]), +m[2], m[4], m[1]));
  // weekdays: full names anywhere; abbreviations ("fri", "sun") only with a prefix, at the end of the
  // input, or right next to another parsed token ("fri 1pm") — so "Buy sun cream" stays a title.
  rule(new RegExp(`(?<![\\w])(?:(on|by|due|this|next|coming)\\s+)?(${WD})(?![\\w])`, 'gi'), (m) => {
    const word = m[2].toLowerCase();
    const idx = wdIndex(word);
    if (idx < 0) return false;
    const full = WD_FULL.includes(word);
    const after = masked.slice(m.index + m[0].length);
    const atEnd = after.replace(new RegExp(MARK, 'g'), '').trim() === '';
    const nextToToken = after.replace(/^\s+/, '').startsWith(MARK) || masked.slice(0, m.index).replace(/\s+$/, '').endsWith(MARK);
    if (!full && !m[1] && !atEnd && !nextToToken) return false;
    const p = (m[1] || '').toLowerCase();
    let delta = (idx - today.getDay() + 7) % 7;
    if (p === 'next' && delta === 0) delta = 7;
    return setDate(addDays(today, delta), p === 'by' ? 'by' : null);
  });
  // "the 15th" / "on the 3rd"
  rule(/(?<![\w])(?:(on|by|due)\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)(?![\w])/gi, (m) => {
    const da = +m[2];
    if (da < 1 || da > 31) return false;
    let d = new Date(today.getFullYear(), today.getMonth(), da);
    if (d.getDate() !== da || d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, da);
    return setDate(d, m[1]);
  });
  if (mode === 'task') {
    rule(/(?<![\w])some\s?day(?![\w])/gi, () => {
      out.someday = true;
      return 'date';
    });
  }

  // ---------- location (events): "at <place>" up to the next parsed token ----------
  if (mode === 'event') {
    const re = /(?<![\w])(?:at|@)\s+(?=[\p{L}\u0002])/giu;
    let m;
    const found = [];
    while ((m = re.exec(masked))) found.push(m);
    for (const f of found) {
      if (out.location) break;
      const startText = f.index + f[0].length;
      let end = masked.indexOf(MARK, startText);
      if (end < 0) end = masked.length;
      const withIdx = masked.slice(startText, end).search(/\s+with\s+/i);
      if (withIdx >= 0) end = startText + withIdx;
      const loc = input.slice(startText, end).replace(/"/g, '').trim().replace(/[,.;]+$/, '');
      if (!loc) continue;
      out.location = loc;
      consume(f.index, startText + input.slice(startText, end).trimEnd().length, 'location');
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
    out.date = ymd(d);
  }
  if (out.repeat && out.date) {
    const anchor = new Date(out.date + 'T00:00');
    if (out.repeat.freq === 'week' && !out.repeat.days) out.repeat.days = [anchor.getDay()];
    if ((out.repeat.freq === 'month' || out.repeat.freq === 'year') && !out.repeat.monthDay) out.repeat.monthDay = anchor.getDate();
  }

  // ---------- event defaults ----------
  if (mode === 'event') {
    if (out.time && !out.date) out.date = ymd(today);
    if (out.date && !out.time) out.allDay = true;
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
  title = title
    .replace(/"([^"]*)"/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
  out.title = title;
  out.tokens.sort((a, b) => a.start - b.start);
  return out;
}
