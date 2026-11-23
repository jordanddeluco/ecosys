// Property/fuzz tests for shared/nlp.js parse(): random unicode, grammar token soup, odd list names
// and options. It must never throw, never return an invalid date/time/duration/repeat, keep every
// unparsed letter in the title, and report consistent tokens. Explicit dates must be read exactly
// (or not at all) and "the Nth" must land on an N-th. Time-zone-dependent relative dates are checked
// per zone in recur-dst.fuzz.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../shared/nlp.js';
import { isYmd, isHHMM, validateRepeat } from '../../shared/sanitize.js';
import { SEED, runs, forAll, fail, check, assume, shrinkString, shrinkValue, show, reproduce } from './lib/harness.js';
import * as O from './lib/cal-oracle.js';

console.log(`# nlp fuzz: seed ${SEED}, TZ ${Intl.DateTimeFormat().resolvedOptions().timeZone} (reproduce: ${reproduce()})`);

const C = (n) => String.fromCharCode(n);
const LETTER = /\p{L}/u;

// ---------------------------------------------------------------- generators

const RANGES = [
  [40, 0x20, 0x7e], [3, 0xa0, 0xff], [2, 0x100, 0x24f], [2, 0x370, 0x3ff], [2, 0x400, 0x4ff], [2, 0x590, 0x5ff], [2, 0x600, 0x6ff], [1, 0x660, 0x669], [1, 0x900, 0x97f],
  [2, 0x4e00, 0x4fff], [1, 0x3040, 0x30ff], [1, 0xac00, 0xad00], [1, 0xff01, 0xff5e], [1, 0x300, 0x36f], [1, 0x2000, 0x206f], [1, 0x1f300, 0x1faff], [1, 0x1d400, 0x1d7ff],
  [0.5, 0x0, 0x1f], [0.3, 0xd800, 0xdfff], [0.3, 0xfff0, 0xffff],
];
function randomUnicode(rng, len = rng.int(0, 60)) {
  let out = '';
  for (let i = 0; i < len; i++) {
    const [, lo, hi] = rng.weighted(RANGES.map((r) => [r[0], r]));
    const cp = rng.int(lo, hi);
    out += cp >= 0xd800 && cp <= 0xdfff ? C(cp) : String.fromCodePoint(cp);
  }
  return out;
}

const WORDS = [
  'today', 'tdy', 'tomorrow', 'tmrw', 'yesterday', 'mon', 'monday', 'tue', 'tues', 'wed', 'thu', 'thurs', 'fri', 'friday', 'sat', 'sun', 'sunday', 'next', 'this', 'coming', 'on', 'by', 'due',
  'in', 'at', '@', 'for', 'every', 'each', 'other', 'and', '&', '+', ',', 'day', 'days', 'week', 'weeks', 'weekday', 'weekend', 'month', 'months', 'year', 'years', 'daily', 'weekly',
  'monthly', 'yearly', 'annually', 'biweekly', 'fortnightly', 'someday', 'some day', 'morning', 'afternoon', 'evening', 'night', 'tonight', 'noon', 'midday', 'midnight', 'all day',
  'all-day', 'from', 'to', 'until', 'till', '-', '–', 'the', 'of', 'a', 'an', 'one', 'two', 'twelve', 'couple', 'half', 'hour', 'hours', 'hr', 'h', 'm', 'min', 'mins', 'minutes', 'p1',
  'p2', 'p3', 'p4', 'p0', 'p5', '!', '!!', '!!!', '!!!!', '!high', '!low', '!med', 'jan', 'january', 'feb', 'mar', 'apr', 'may', 'june', 'jul', 'aug', 'sept', 'oct', 'nov', 'dec', 'december',
  'with', 'Sam', 'Cafe', 'Luna', 'call', 'mom', 'buy', 'milk', '"', '"quoted tomorrow"', '#', '#Work', '#Home Projects', '#new-list', '@phone', '@', 'am', 'pm', 'a.m.', 'p.m.', 'a', 'p',
  'after', 'completion', 'done', 'Ünïcödé', 'İstanbul', 'straße', '日本', 'مرحبا', C(1), C(2), '\t', '\n',
];
function num(rng) {
  return rng.weighted([
    [6, () => String(rng.int(0, 31))],
    [2, () => String(rng.int(0, 99)).padStart(2, '0')],
    [2, () => String(rng.int(0, 9999)).padStart(4, '0')],
    [1, () => rng.pick(['0', '00', '1000', '99999', '99999999999', '9'.repeat(25), '1.5', '0.001', '2.75', '1e3', '٣', '３'])],
    [2, () => `${rng.int(0, 25)}:${String(rng.int(0, 61)).padStart(2, '0')}`],
    [1, () => `${rng.int(0, 13)}${rng.pick(['am', 'pm', 'a', 'p', ' pm', 'p.m.', 'h', 'm', 'min', 'st', 'nd', 'rd', 'th'])}`],
    [1, () => `${rng.int(0, 13)}/${rng.int(0, 32)}${rng.chance(0.5) ? `/${rng.pick([String(rng.int(0, 99)), String(rng.int(0, 9999)).padStart(4, '0')])}` : ''}`],
    [1, () => `${String(rng.int(0, 9999)).padStart(4, '0')}-${rng.int(0, 13)}-${rng.int(0, 32)}`],
    [1, () => `${rng.int(0, 24)}${rng.pick(['-', '–', ' to '])}${rng.int(0, 24)}${rng.pick(['', 'pm', 'am', ':30'])}`],
  ]);
}
function tokenSoup(rng) {
  const parts = rng.repeat(rng.int(1, 12), () => rng.weighted([[8, () => rng.pick(WORDS)], [5, () => num(rng)], [1, () => randomUnicode(rng, rng.int(1, 4))]]));
  return parts.join(rng.pick([' ', ' ', '  ', ', ', '']));
}

const LIST_NAMES = ['Work', 'Personal', 'Home', 'Home Projects', 'home', 'W', '', 'a.b', '(x)', '[y]', '*', '+1', 'C++', 'Ünïcödé', 'İstanbul', 'i̇', 'Straße', '日本', '😀 Fun', 'x'.repeat(80), 'Work Work', '#hash', '\\d+', '$1', 'tomorrow'];
function genOptions(rng) {
  const mode = rng.pick(['task', 'task', 'event']);
  const named = rng.sample(LIST_NAMES, rng.int(0, 8)).map((name, i) => ({ id: `L${i}`, name }));
  const day = O.ymdOf(rng.weighted([[5, () => rng.int(O.daysFromCivil(1990, 1, 1), O.daysFromCivil(2060, 12, 31))], [1, () => rng.int(O.daysFromCivil(1000, 1, 1), O.daysFromCivil(9990, 12, 31))]]));
  const [y, m, d] = day.split('-').map(Number);
  const opts = { mode, now: new Date(y, m - 1, d, rng.int(0, 23), rng.int(0, 59)) };
  if (mode === 'task') opts.lists = named;
  else opts.calendars = named;
  if (rng.chance(0.5)) opts.hour12 = rng.chance(0.5);
  if (rng.chance(0.3)) opts.dmy = rng.chance(0.5);
  return opts;
}
const genCase = (rng) => ({ input: rng.weighted([[3, () => tokenSoup(rng)], [1, () => randomUnicode(rng)], [1, () => `${tokenSoup(rng)} ${randomUnicode(rng, rng.int(0, 8))} ${tokenSoup(rng)}`]]), opts: genOptions(rng) });
const display = ({ input, opts }) => show({ input, ...opts, now: opts?.now?.toString?.(), lists: opts?.lists?.map((l) => l.name), calendars: opts?.calendars?.map((l) => l.name) }, 600);

/** Shrink the input string, keep the options. */
function shrinkCase(value, stillFails) {
  const r = shrinkString(value.input, (s) => stillFails({ ...value, input: s }));
  return r ? { value: { ...value, input: r.value }, error: r.error } : null;
}

function run({ input, opts }) {
  try {
    return parse(input, opts);
  } catch (err) {
    fail('throws', `parse threw ${err?.name}: ${err?.message}`);
  }
}

function property(t, name, n, prop, gen = genCase) {
  const r = forAll(name, { runs: runs(n), gen, prop, shrink: shrinkCase, display });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
}

// ---------------------------------------------------------------- properties

test('parse never throws on random unicode, token soup, odd list names and options', (t) => {
  property(t, 'nlp.never-throws', 6000, (c) => {
    const r = run(c);
    check(r && typeof r === 'object', 'shape', 'no result object');
  });
});

test('parse never returns an invalid date or deadline (always a real YYYY-MM-DD, year 1000-9999)', (t) => {
  property(t, 'nlp.dates', 6000, (c) => {
    const r = run(c);
    for (const k of ['date', 'deadline']) check(r[k] === null || isYmd(r[k]), `invalid-${k}`, () => `${k} = ${show(r[k])}`);
  });
});

test('parse never returns an invalid time, end time or duration', (t) => {
  property(t, 'nlp.times', 6000, (c) => {
    const r = run(c);
    check(r.time === null || isHHMM(r.time), 'time', () => `time = ${show(r.time)}`);
    check(r.endTime === null || isHHMM(r.endTime), 'endTime', () => `endTime = ${show(r.endTime)}`);
    check(r.endTime === null || r.time !== null, 'endTime-alone', 'endTime without time');
    check(r.duration === null || (Number.isInteger(r.duration) && r.duration >= 1), 'duration', () => `duration = ${show(r.duration)}`);
  });
});

test('parse returns a priority 0-3, lowercase unique tags, and list/calendar ids from the options only', (t) => {
  property(t, 'nlp.fields', 5000, (c) => {
    const r = run(c);
    check(Number.isInteger(r.priority) && r.priority >= 0 && r.priority <= 3, 'priority', () => `priority = ${show(r.priority)}`);
    check(Array.isArray(r.tags) && new Set(r.tags).size === r.tags.length && r.tags.every((x) => typeof x === 'string' && x === x.toLowerCase() && /^\p{L}/u.test(x)), 'tags', () => `tags = ${show(r.tags)}`);
    const ids = new Set((c.opts.lists || c.opts.calendars || []).map((l) => l.id));
    check(r.listId === null || (c.opts.mode !== 'event' && ids.has(r.listId)), 'listId', () => `listId = ${show(r.listId)}`);
    check(r.calendarId === null || (c.opts.mode === 'event' && ids.has(r.calendarId)), 'calendarId', () => `calendarId = ${show(r.calendarId)}`);
    check(r.newList === null || (c.opts.mode !== 'event' && typeof r.newList === 'string' && /^[\p{L}\p{N}_-]+$/u.test(r.newList)), 'newList', () => `newList = ${show(r.newList)}`);
    check(!(r.listId && r.newList), 'list-both', 'both listId and newList');
  });
});

test('parse returns repeat rules the validators keep unchanged (freq, interval 1-999, days, monthDay, month), and a repeat always has a date', (t) => {
  property(t, 'nlp.repeat', 5000, (c) => {
    const r = run(c);
    if (r.repeat === null) return;
    const rule = r.repeat;
    check(['day', 'week', 'month', 'year'].includes(rule.freq), 'freq', () => `freq ${show(rule.freq)}`);
    check(Number.isInteger(rule.interval) && rule.interval >= 1 && rule.interval <= 999, 'interval', () => `interval ${show(rule.interval)} (validateRepeat would store ${show(validateRepeat(rule)?.interval)})`);
    const v = validateRepeat(rule);
    const norm = { ...rule, ...(rule.days ? { days: [...rule.days].sort((a, b) => a - b) } : {}) };
    for (const k of ['freq', 'interval', 'monthDay', 'month']) check(v?.[k] === norm[k], 'validator-changes', () => `validateRepeat changes ${k}: ${show(norm[k])} → ${show(v?.[k])}`);
    check(show(v?.days) === show(norm.days), 'validator-changes', () => `validateRepeat changes days: ${show(norm.days)} → ${show(v?.days)}`);
    check(r.date !== null, 'repeat-no-date', 'repeat without a first date');
  });
});

test('parse keeps every letter that is not part of a parsed token in the title (so the title is never empty while unparsed letters remain)', (t) => {
  property(t, 'nlp.title-letters', 6000, (c) => {
    const r = run(c);
    const covered = new Uint8Array(c.input.length + 1);
    for (const tk of r.tokens) for (let i = tk.start; i < tk.end && i < covered.length; i++) covered[i] = 1;
    let free = '';
    for (let i = 0; i < c.input.length; i++) {
      if (covered[i]) continue;
      const cp = c.input.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (cp > 0xffff) i++;
      if (LETTER.test(ch)) free += ch;
    }
    const inTitle = [...r.title].filter((ch) => LETTER.test(ch)).join('');
    if (free) check(r.title.trim() !== '', 'empty-title', () => `title is empty but these letters were not parsed: ${show(free)}`);
    check(inTitle === free, 'letters', () => `letters outside tokens ${show(free)} but title letters ${show(inTitle)} (title ${show(r.title)})`);
  });
});

test('parse reports sorted, non-overlapping tokens that match the input text', (t) => {
  property(t, 'nlp.tokens', 5000, (c) => {
    const r = run(c);
    let last = 0;
    for (const tk of r.tokens) {
      check(Number.isInteger(tk.start) && Number.isInteger(tk.end) && tk.start >= last && tk.end > tk.start && tk.end <= c.input.length, 'span', () => `token ${show(tk)} (input length ${c.input.length})`);
      check(tk.text === c.input.slice(tk.start, tk.end), 'text', () => `token text ${show(tk.text)} != input slice ${show(c.input.slice(tk.start, tk.end))}`);
      last = tk.end;
    }
  });
});

test('parse keeps the title well-formed (no half surrogate pairs) for well-formed input, and is deterministic', (t) => {
  property(t, 'nlp.wellformed', 4000, (c) => {
    assume(c.input.isWellFormed());
    const r = run(c);
    check(r.title.isWellFormed(), 'surrogate', () => `title ${show(r.title)} has a lone surrogate`);
    check(JSON.stringify(parse(c.input, c.opts)) === JSON.stringify(r), 'nondeterministic', 'two parses differ');
  });
});

test('event mode: all-day events have no time; a time implies a date', (t) => {
  property(
    t,
    'nlp.event',
    4000,
    (c) => {
      const r = run(c);
      if (r.allDay) check(r.time === null && r.endTime === null, 'allday-time', () => `allDay with time ${r.time}-${r.endTime}`);
      check(r.time === null || r.date !== null, 'time-no-date', () => `time ${r.time} without a date`);
    },
    (rng) => {
      const c = genCase(rng);
      c.opts = { ...c.opts, mode: 'event', calendars: c.opts.calendars || c.opts.lists || [], lists: undefined };
      return c;
    },
  );
});

// explicit dates: read exactly, or not at all
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function genExplicitDate(rng) {
  const y = rng.weighted([[7, () => rng.int(1000, 9999)], [2, () => rng.int(100, 999)], [1, () => rng.int(0, 99)]]);
  const m = rng.int(1, 12);
  const d = rng.weighted([[8, () => rng.int(1, O.dim(Math.max(1, y), m))], [2, () => rng.int(28, 31)]]);
  const Y = String(y).padStart(4, '0');
  const dmy = rng.chance(0.3);
  const mon = MONTHS[m - 1];
  const name = rng.chance(0.5) ? mon : mon.slice(0, 3);
  const text = rng.pick([
    `${Y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    `${Y}-${m}-${d}`,
    dmy ? `${d}/${m}/${Y}` : `${m}/${d}/${Y}`,
    `${name} ${d} ${Y}`,
    `${name} ${d}, ${Y}`,
    `${d} ${name} ${Y}`,
    `the ${d}th of ${name} ${Y}`,
  ]);
  return { y, m, d, text, dmy };
}

// (structured cases are not shrunk: the expectation is derived from the generated fields)
function explicitDateProp({ y, m, d, text, dmy, now }) {
  const [ny, nm, nd] = O.civilFromDays(now);
  const res = parse(`Party ${text}`, { mode: 'task', now: new Date(ny, nm - 1, nd, 12), dmy });
  const valid = y >= 1000 && d <= O.dim(y, m);
  const want = valid ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  check(res.date === want && res.deadline === null, valid ? 'misread' : 'invalid-accepted', () => `parse("Party ${text}"${dmy ? ', dmy' : ''}) → date ${show(res.date)}, expected ${show(want)}`);
}
const nowDay = (rng) => rng.int(O.daysFromCivil(1990, 1, 1), O.daysFromCivil(2060, 12, 31));

const NUMERIC = /^\d/;
function explicitDateTest(t, name, n, accept) {
  const r = forAll(name, {
    runs: runs(n),
    gen: (rng) => {
      let c;
      do c = genExplicitDate(rng);
      while (!accept(c));
      return { ...c, now: nowDay(rng) };
    },
    prop: explicitDateProp,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
}

test('explicit valid dates in years 1000-9999 (YYYY-MM-DD, M/D/YYYY, "Mon D YYYY", "D Mon YYYY", "the Dth of Mon YYYY") are read exactly', (t) => {
  explicitDateTest(t, 'nlp.explicit-dates', 4000, (c) => c.y >= 1000 && c.d <= O.dim(c.y, c.m));
});

test('impossible numeric dates (2026-02-29, 2/29/2026, 4/31/2027) are not read as another date', (t) => {
  explicitDateTest(t, 'nlp.impossible-numeric', 2000, (c) => c.y >= 1000 && c.d > O.dim(c.y, c.m) && NUMERIC.test(c.text));
});

test('impossible worded dates ("Feb 29 2026", "31 April 2027", "the 31th of June 2027") are not read as another date', (t) => {
  explicitDateTest(t, 'nlp.impossible-worded', 2000, (c) => c.y >= 1000 && c.d > O.dim(c.y, c.m) && !NUMERIC.test(c.text));
});

test('explicit dates before year 1000 (outside the stored range) are not read as some other date', (t) => {
  const r = forAll('nlp.explicit-dates-early', {
    runs: runs(2000),
    gen: (rng) => {
      let c;
      do c = genExplicitDate(rng);
      while (c.y >= 1000);
      return { ...c, now: nowDay(rng) };
    },
    prop: explicitDateProp,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('"every N days/weeks/months/years" keeps N, or is not read as a repeat at all (never silently becomes another interval when stored)', (t) => {
  const r = forAll('nlp.every-n', {
    runs: runs(2000),
    gen: (rng) => ({ n: rng.weighted([[4, () => rng.int(1, 999)], [2, () => rng.int(1000, 1e6)], [1, () => rng.int(1e6, 1e12)]]), unit: rng.pick(['day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years']), now: nowDay(rng) }),
    prop: ({ n, unit, now }) => {
      const [ny, nm, nd] = O.civilFromDays(now);
      const res = parse(`Water plants every ${n} ${unit}`, { mode: 'task', now: new Date(ny, nm - 1, nd, 12) });
      if (!res.repeat) return;
      const stored = validateRepeat(res.repeat);
      check(res.repeat.interval === n, 'interval', () => `"every ${n} ${unit}" → interval ${res.repeat.interval}`);
      check(stored?.interval === n, 'stored-interval', () => `"every ${n} ${unit}" → interval ${n}, but validateRepeat stores ${show(stored?.interval)} (the task would repeat every ${stored?.interval} ${stored?.freq})`);
    },
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('far relative dates ("in N days/weeks/months/years", huge N) give a valid date or none', (t) => {
  const r = forAll('nlp.far-relative', {
    runs: runs(3000),
    gen: (rng) => ({
      n: rng.weighted([[3, () => String(rng.int(1, 9999))], [3, () => String(rng.int(1e4, 1e9))], [2, () => String(rng.int(1, 9)) + '0'.repeat(rng.int(9, 30))], [1, () => rng.pick(['a', 'an', 'one', 'twelve', 'a couple of'])]]),
      unit: rng.pick(['day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years']),
      by: rng.chance(0.3),
      now: nowDay(rng),
    }),
    prop: ({ n, unit, by, now }) => {
      const [ny, nm, nd] = O.civilFromDays(now);
      const text = `Trip ${by ? 'by ' : ''}in ${n} ${unit}`;
      const res = parse(text, { mode: 'task', now: new Date(ny, nm - 1, nd, 12) });
      for (const k of ['date', 'deadline']) check(res[k] === null || isYmd(res[k]), 'invalid-date', () => `parse(${show(text)}) → ${k} ${show(res[k])}`);
    },
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('"the Nth" is the first date on or after today whose day of month is N', (t) => {
  const r = forAll('nlp.the-nth', {
    runs: runs(3000),
    gen: (rng) => {
      const y = rng.int(1990, 2060);
      const m = rng.int(1, 12);
      const day = rng.weighted([[3, () => rng.int(1, O.dim(y, m))], [2, () => O.dim(y, m) - rng.int(0, 2)]]);
      return { today: O.ymdOf(O.daysFromCivil(y, m, day)), n: rng.weighted([[5, () => rng.int(1, 31)], [3, () => rng.int(28, 31)]]) };
    },
    prop: ({ today, n }) => {
      assume(isYmd(today) && Number.isInteger(n) && n >= 1 && n <= 31);
      const [y, m, d] = today.split('-').map(Number);
      const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
      const res = parse(`Pay rent the ${n}${suffix}`, { mode: 'task', now: new Date(y, m - 1, d, 12) });
      let want = null;
      for (let z = O.dayOf(today); z <= O.dayOf(today) + 62; z++) {
        if (O.civilFromDays(z)[2] === n) {
          want = O.ymdOf(z);
          break;
        }
      }
      check(res.date === want, 'nth', () => `today ${today}: "the ${n}${suffix}" → ${show(res.date)}, expected ${want}`);
    },
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('parse stays fast on adversarial input at the callers\' 1000-character cap (< 100 ms) and at 10x that (< 1 s)', () => {
  const now = new Date(2026, 10, 22, 12);
  const shapes = [
    '1,', ', ', ' -', '-,', '!', '#', '@', '"', 'a', 'at 5 ', '9-5 ', 'every mon, ', 'mon and ', 'for 1h ', 'in 3 days ', 'the 15th ', '12/5 ', '2026-12-05 ', 'tomorrow ', 'every other ', 'p1 ',
    '#Home ', '@x ', '"x" ', 'at Cafe ', '\u0001', `${C(0xd800)}`, ' ', '\t', 'morning ', '10:30am-11pm ',
  ];
  const slow = [];
  for (const [len, budget] of [
    [1000, 100],
    [10000, 1000],
  ]) {
    for (const s of shapes) {
      const input = s.repeat(Math.ceil(len / s.length)).slice(0, len);
      for (const mode of ['task', 'event']) {
        const t0 = performance.now();
        parse(input, { mode, now, lists: [{ id: 'L1', name: 'Home' }], calendars: [{ id: 'C1', name: 'Home' }] });
        const ms = performance.now() - t0;
        if (ms > budget) slow.push(`${len} chars of ${show(s)} (${mode}): ${ms.toFixed(0)} ms > ${budget} ms`);
      }
    }
  }
  assert.deepEqual(slow, [], `slow inputs:\n  ${slow.join('\n  ')}`);
});
