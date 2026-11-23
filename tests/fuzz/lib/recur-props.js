// Time-zone-sensitive properties of shared/dates.js, shared/recur.js and the relative-date part of
// shared/nlp.js. tests/fuzz/recur-dst.fuzz.test.js runs this module in a child process per zone
// (TZ=America/New_York, Europe/London, …) via lib/child-runner.mjs. Dates are biased towards the
// zone's real DST transitions (found by scanning local-noon offsets), month ends and Feb 29.
import * as R from '../../../shared/recur.js';
import * as D from '../../../shared/dates.js';
import { parse as nlpParse } from '../../../shared/nlp.js';
import { isYmd, validateRepeat } from '../../../shared/sanitize.js';
import * as O from './cal-oracle.js';
import { check, assume, show } from './harness.js';

function findTransitions(y0 = 1970, y1 = 2037) {
  const out = [];
  let prev = new Date(y0, 0, 1, 12).getTimezoneOffset();
  for (let z = O.daysFromCivil(y0, 1, 2), end = O.daysFromCivil(y1, 12, 31); z <= end; z++) {
    const [y, m, d] = O.civilFromDays(z);
    const off = new Date(y, m - 1, d, 12).getTimezoneOffset();
    if (off !== prev) out.push(O.ymdOf(z));
    prev = off;
  }
  return out;
}
const TRANSITIONS = findTransitions();
const LO = O.daysFromCivil(1000, 1, 1);
const HI = O.daysFromCivil(9899, 12, 31);
const clampYmd = (s) => O.ymdOf(Math.min(HI, Math.max(LO, O.dayOf(s))));

export const describeEnv = () => ({
  TZ: process.env.TZ ?? null,
  resolved: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offsetJan: new Date(2026, 0, 15, 12).getTimezoneOffset(),
  offsetJul: new Date(2026, 6, 15, 12).getTimezoneOffset(),
  dstTransitions1970to2037: TRANSITIONS.length,
  sample: TRANSITIONS.filter((s) => s >= '2026-01-01' && s <= '2026-12-31'),
});

// ---------------------------------------------------------------- generators

function genDate(rng) {
  return clampYmd(
    rng.weighted([
      [TRANSITIONS.length ? 5 : 0, () => O.addDays(rng.pick(TRANSITIONS), rng.int(-3, 3))],
      [2, () => {
        const y = rng.int(1970, 2099);
        const m = rng.int(1, 12);
        return O.ymdOf(O.daysFromCivil(y, m, rng.pick([1, 28, 29, 30, 31].filter((d) => d <= O.dim(y, m)))));
      }],
      [1, () => {
        const y = rng.pick([1900, 1904, 2000, 2004, 2024, 2028, 2096, 2100]);
        return `${y}-02-${O.isLeap(y) && rng.chance(0.7) ? '29' : '28'}`;
      }],
      [3, () => O.ymdOf(rng.int(O.daysFromCivil(1970, 1, 1), O.daysFromCivil(2099, 12, 31)))],
      [0.5, () => O.ymdOf(rng.int(LO, HI))],
    ]),
  );
}

function genRule(rng, start, { sync = true } = {}) {
  const freq = rng.pick(['day', 'week', 'week', 'month', 'month', 'year']);
  const interval = rng.weighted([[6, 1], [3, () => rng.int(2, 4)], [1, () => rng.int(5, 13)], [0.2, () => rng.pick([52, 99, 365, 999])]]);
  const r = { freq, interval };
  const z = O.dayOf(start);
  const [y, m, d] = O.civilFromDays(z);
  if (freq === 'week' && rng.chance(0.85)) {
    let days = rng.sample([0, 1, 2, 3, 4, 5, 6], rng.int(1, 7));
    if (sync && !days.includes(O.weekday(z))) days.push(O.weekday(z));
    r.days = [...new Set(days)].sort((a, b) => a - b);
  }
  if (freq === 'month' || freq === 'year') {
    if (sync) r.monthDay = d === O.dim(y, m) && rng.chance(0.5) ? rng.int(d, 31) : d;
    else if (rng.chance(0.8)) r.monthDay = rng.int(1, 31);
  }
  if (freq === 'year' && rng.chance(0.5)) r.month = sync ? m : rng.int(1, 12);
  if (rng.chance(0.3)) r.from = rng.pick(['due', 'done']);
  return r;
}

function genWindow(rng, start) {
  const from = clampYmd(
    rng.weighted([
      [4, () => O.addDays(start, rng.int(-30, 400))],
      [3, () => O.addDays(start, rng.int(0, 365 * 30))],
      [1, () => O.addDays(start, -rng.int(1, 1000))],
      [TRANSITIONS.length ? 2 : 0, () => O.addDays(rng.pick(TRANSITIONS), rng.int(-10, 0))],
    ]),
  );
  const to = clampYmd(O.addDays(from, rng.weighted([[5, () => rng.int(0, 60)], [3, () => rng.int(0, 400)], [1, () => rng.int(400, 1100)], [0.3, () => -rng.int(1, 30)]])));
  return { from, to };
}

function genSeries(rng, { sync = true } = {}) {
  const start = rng.chance(0.85) ? clampYmd(O.ymdOf(rng.int(O.daysFromCivil(1971, 1, 1), O.daysFromCivil(2060, 12, 31)))) : genDate(rng);
  const rule = genRule(rng, start, { sync });
  const { from, to } = genWindow(rng, start);
  const plain = O.oracleOccurrences(rule, start, from, to);
  const exdates = rng.chance(0.4) ? [...rng.sample(plain, rng.int(0, 3)), ...rng.repeat(rng.small(2), () => genDate(rng))] : [];
  const until = rng.chance(0.3) ? clampYmd(rng.chance(0.5) && plain.length ? rng.pick(plain) : O.addDays(start, rng.int(-10, 900))) : null;
  return { rule, start, from, to, exdates, until };
}

const occ = ({ rule, start, from, to, exdates, until }) => R.occurrencesBetween(rule, start, from, to, { exdates, until });
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const diffList = (a, b) => {
  const i = a.findIndex((x, k) => x !== b[k]);
  const at = i < 0 ? Math.min(a.length, b.length) : i;
  return `first difference at #${at}: got ${show(a.slice(Math.max(0, at - 1), at + 3))} expected ${show(b.slice(Math.max(0, at - 1), at + 3))} (got ${a.length}, expected ${b.length})`;
};

// snapToPattern / nextRepeatDates oracle (independent day arithmetic)
function oracleSnap(rule, s) {
  if (!((rule.freq === 'month' || rule.freq === 'year') && rule.monthDay)) return s;
  const [y, m] = s.split('-').map(Number);
  const at = (yy, mm) => {
    const [y2, m2] = O.addYm(yy, mm, 0);
    return O.ymdOf(O.daysFromCivil(y2, m2, Math.min(rule.monthDay, O.dim(y2, m2))));
  };
  let prev;
  let next;
  if (rule.freq === 'month') {
    const x = at(y, m);
    const [py, pm] = O.addYm(y, m, -1);
    const [ny, nm] = O.addYm(y, m, 1);
    prev = x <= s ? x : at(py, pm);
    next = x >= s ? x : at(ny, nm);
  } else {
    const mm = rule.month || m;
    const x = at(y, mm);
    prev = x <= s ? x : at(y - 1, mm);
    next = x >= s ? x : at(y + 1, mm);
  }
  return O.dayOf(s) - O.dayOf(prev) <= O.dayOf(next) - O.dayOf(s) ? prev : next;
}

function oracleRepeat(task, today) {
  const rule = task.repeat;
  const anchor = task.date || task.deadline || today;
  const base = oracleSnap(rule, rule.from === 'done' ? today : anchor);
  let next = O.oracleNext(rule, base);
  while (next <= today) next = O.oracleNext(rule, next);
  if (rule.from === 'done' && task.date && next === task.date) next = O.oracleNext(rule, next);
  const shift = O.dayOf(next) - O.dayOf(anchor);
  return { date: task.date ? O.addDays(task.date, shift) : task.deadline ? null : next, deadline: task.deadline ? O.addDays(task.deadline, shift) : null };
}

function genTask(rng, { maxOverdueYears = 40 } = {}) {
  const today = clampYmd(rng.chance(0.6) && TRANSITIONS.length ? O.addDays(rng.pick(TRANSITIONS.filter((s) => s >= '1990')), rng.int(-2, 2)) : O.ymdOf(rng.int(O.daysFromCivil(1990, 1, 1), O.daysFromCivil(2060, 12, 31))));
  const offset = rng.weighted([[4, () => rng.int(-60, 60)], [3, () => rng.int(-800, 400)], [2, () => -rng.int(0, Math.round(365.25 * maxOverdueYears))]]);
  const date = rng.chance(0.75) ? O.addDays(today, offset) : null;
  const deadline = rng.chance(0.35) ? O.addDays(date || today, rng.int(date ? 0 : -400, 60)) : null;
  const rule = genRule(rng, date || deadline || today, { sync: rng.chance(0.7) });
  if ((rule.freq === 'month' || rule.freq === 'year') && !rule.monthDay) rule.monthDay = O.civilFromDays(O.dayOf(date || deadline || today))[2];
  return { today, task: { date, deadline, repeat: rule } };
}

// ---------------------------------------------------------------- properties

export const properties = [
  {
    name: 'the requested time zone is active (and DST zones really change offset)',
    test() {
      const env = describeEnv();
      if (process.env.TZ && process.env.TZ !== 'UTC') {
        check(env.resolved === process.env.TZ || env.resolved.endsWith(process.env.TZ.split('/').pop()), 'tz', () => `TZ=${process.env.TZ} but Intl resolved ${env.resolved}`);
        check(env.dstTransitions1970to2037 > 0, 'tz', () => `no DST transitions found in ${process.env.TZ} (TZ not applied?)`);
      }
    },
  },
  {
    name: 'dates.js: ymd(parseYmd(s)) round-trips every date (DST days, month ends, leap days)',
    runs: 4000,
    gen: genDate,
    prop: (s) => check(D.ymd(D.parseYmd(s)) === s, 'roundtrip', () => `ymd(parseYmd(${s})) = ${D.ymd(D.parseYmd(s))}`),
  },
  {
    name: 'dates.js: addDaysYmd and diffDays agree with day arithmetic across DST changes',
    runs: 4000,
    gen: (rng) => ({ s: genDate(rng), k: rng.weighted([[5, () => rng.int(-40, 40)], [2, () => rng.int(-2000, 2000)], [1, () => rng.int(-40000, 40000)]]) }),
    prop: ({ s, k }) => {
      const want = O.addDays(s, k);
      assume(want >= '1000-01-01' && want <= '9999-12-31');
      check(D.addDaysYmd(s, k) === want, 'addDays', () => `addDaysYmd(${s}, ${k}) = ${D.addDaysYmd(s, k)}, expected ${want}`);
      check(D.diffDays(s, want) === k, 'diffDays', () => `diffDays(${s}, ${want}) = ${D.diffDays(s, want)}, expected ${k}`);
    },
  },
  {
    name: 'dates.js: addMonths clamps to the month end (Jan 31 + 1 → Feb 28/29) and daysInMonth is right',
    runs: 3000,
    gen: (rng) => ({ s: genDate(rng), k: rng.int(-30, 30), day: rng.chance(0.4) ? rng.int(1, 31) : undefined }),
    prop: ({ s, k, day }) => {
      const want = O.addMonths(s, k, day);
      assume(want >= '1000-01-01' && want <= '9999-12-31');
      const got = D.ymd(day === undefined ? D.addMonths(D.parseYmd(s), k) : D.addMonths(D.parseYmd(s), k, day));
      check(got === want, 'addMonths', () => `addMonths(${s}, ${k}${day === undefined ? '' : `, ${day}`}) = ${got}, expected ${want}`);
      const [y, m] = want.split('-').map(Number);
      check(D.daysInMonth(y, m - 1) === O.dim(y, m), 'daysInMonth', () => `daysInMonth(${y}, ${m - 1}) = ${D.daysInMonth(y, m - 1)}, expected ${O.dim(y, m)}`);
    },
  },
  {
    name: 'recur: occurrencesBetween equals an independent day-arithmetic oracle (intervals > 1, month ends, Feb 29, DST, exdates, until)',
    runs: 3000,
    gen: (rng) => genSeries(rng, { sync: true }),
    prop: (c) => {
      const got = occ(c);
      const want = O.oracleOccurrences(c.rule, c.start, c.from, c.to, c);
      check(sameList(got, want), 'oracle', () => diffList(got, want));
    },
  },
  {
    name: 'recur: occurrencesBetween is window-consistent for any rule (the fast-forward never shifts the pattern)',
    runs: 3000,
    gen: (rng) => genSeries(rng, { sync: rng.chance(0.5) }),
    prop: (c) => {
      const span = O.dayOf(c.to) - O.dayOf(c.start);
      assume(span <= 1500 || c.rule.freq === 'month' || c.rule.freq === 'year');
      assume(span <= 365 * 45);
      const window = occ(c);
      const full = R.occurrencesBetween(c.rule, c.start, c.start, c.to, c).filter((d) => d >= c.from);
      check(sameList(window, full), 'window', () => `window [${c.from}, ${c.to}] vs. expanding from the start: ${diffList(window, full)}`);
      if (c.from < c.to) {
        const mid = O.ymdOf(Math.floor((O.dayOf(c.from) + O.dayOf(c.to)) / 2));
        const left = R.occurrencesBetween(c.rule, c.start, c.from, mid, c);
        const right = R.occurrencesBetween(c.rule, c.start, O.addDays(mid, 1), c.to, c);
        check(sameList([...left, ...right], window), 'split', () => `[from, mid] + [mid+1, to] differs from [from, to]: ${diffList([...left, ...right], window)}`);
      }
    },
  },
  {
    name: 'recur: occurrencesBetween output is sorted, unique, valid, inside [from, to], not after until, without exdates (any rule)',
    runs: 3000,
    gen: (rng) => genSeries(rng, { sync: rng.chance(0.5) }),
    prop: (c) => {
      const got = occ(c);
      const ex = new Set(c.exdates);
      got.forEach((d, i) => {
        check(isYmd(d), 'invalid', () => `invalid date ${show(d)}`);
        check(!i || d > got[i - 1], 'order', () => `not strictly increasing at #${i}: ${got[i - 1]}, ${d}`);
        check(d >= c.from && d <= c.to && d >= c.start, 'bounds', () => `${d} outside [${c.from}, ${c.to}] or before the start ${c.start}`);
        check(!c.until || d <= c.until, 'until', () => `${d} after until ${c.until}`);
        check(!ex.has(d), 'exdate', () => `exdate ${d} returned`);
      });
    },
  },
  {
    name: 'recur: the series start is its own first occurrence (RFC 5545: DTSTART is always an instance)',
    runs: 1500,
    gen: (rng) => {
      const start = clampYmd(O.ymdOf(rng.int(O.daysFromCivil(1971, 1, 1), O.daysFromCivil(2060, 12, 31))));
      return { start, rule: genRule(rng, start, { sync: rng.chance(0.4) }) };
    },
    prop: ({ start, rule }) => {
      const got = R.occurrencesBetween(rule, start, start, O.addDays(start, 400));
      check(got[0] === start, 'start', () => `first occurrence ${show(got[0])} is not the series start ${start} (rule ${show(rule)})`);
    },
  },
  {
    name: 'recur: nextOccurrence steps through exactly the dates occurrencesBetween lists',
    runs: 2000,
    gen: (rng) => {
      const c = genSeries(rng, { sync: true });
      if (c.rule.freq === 'year') delete c.rule.month; // a series repeats in its start month; `month` anchors tasks
      return { ...c, exdates: [], until: null };
    },
    prop: (c) => {
      const list = occ(c);
      for (let i = 0; i + 1 < list.length; i++) check(R.nextOccurrence(c.rule, list[i]) === list[i + 1], 'next', () => `nextOccurrence(${show(c.rule)}, ${list[i]}) = ${R.nextOccurrence(c.rule, list[i])}, list has ${list[i + 1]}`);
    },
  },
  {
    name: 'recur: nextOccurrence is a valid date strictly after its input (any rule, any date)',
    runs: 4000,
    gen: (rng) => {
      const d = genDate(rng);
      return { d, rule: genRule(rng, d, { sync: rng.chance(0.5) }) };
    },
    prop: ({ d, rule }) => {
      assume(d <= '9800-12-31');
      const n = R.nextOccurrence(rule, d);
      check(isYmd(n), 'invalid', () => `nextOccurrence(${show(rule)}, ${d}) = ${show(n)}`);
      check(n > d, 'not-after', () => `nextOccurrence(${show(rule)}, ${d}) = ${n} is not after ${d}`);
    },
  },
  {
    name: 'recur: nextRepeatDates never returns a past date (the date, or the deadline of an undated task)',
    runs: 4000,
    gen: (rng) => genTask(rng, { maxOverdueYears: 40 }),
    prop: ({ today, task }) => {
      const r = R.nextRepeatDates(task, today);
      const when = r.date ?? r.deadline;
      check(when !== null && isYmd(when), 'invalid', () => `got ${show(r)}`);
      check(when > today, 'past', () => `today ${today}, task ${show(task)} → ${show(r)} (not after today)`);
      if (r.date && r.deadline && task.date && task.deadline) check(O.dayOf(r.deadline) - O.dayOf(r.date) === O.dayOf(task.deadline) - O.dayOf(task.date), 'gap', 'date→deadline gap changed');
    },
  },
  {
    name: 'recur: nextRepeatDates matches an independent oracle (first occurrence after today, done/due, deadlines; up to 10 years overdue)',
    runs: 3000,
    gen: (rng) => genTask(rng, { maxOverdueYears: 10 }),
    prop: ({ today, task }) => {
      const got = R.nextRepeatDates(task, today);
      const want = oracleRepeat(task, today);
      check(got.date === want.date && got.deadline === want.deadline, 'oracle', () => `today ${today}, task ${show(task)} → ${show(got)}, expected ${show(want)}`);
    },
  },
  {
    name: 'recur: describe / presets / shiftRule never throw and keep rules valid',
    runs: 1500,
    gen: (rng) => {
      const d = genDate(rng);
      return { d, rule: genRule(rng, d, { sync: rng.chance(0.5) }), delta: rng.int(-400, 400) };
    },
    prop: ({ d, rule, delta }) => {
      const text = R.describe(rule);
      check(typeof text === 'string' && text.length > 0, 'describe', () => `describe(${show(rule)}) = ${show(text)}`);
      for (const p of R.presets(d)) if (p.rule) check(validateRepeat(p.rule) !== null, 'preset', () => `preset ${show(p)} is not a valid rule`);
      const moved = O.addDays(d, delta);
      assume(moved >= '1000-01-01' && moved <= '9999-12-31');
      const s = R.shiftRule(rule, delta, moved);
      check(validateRepeat(s) !== null, 'shift', () => `shiftRule(${show(rule)}, ${delta}) = ${show(s)}`);
      if (rule.freq === 'week' && rule.days) check(sameList(s.days, [...new Set(rule.days.map((x) => (((x + delta) % 7) + 7) % 7))].sort((a, b) => a - b)), 'shift-days', () => `shiftRule days ${show(s.days)}`);
    },
  },
  {
    name: 'nlp: relative dates (today, tomorrow, in N days/weeks/months/years, weekdays, next week/month/year, weekends) match calendar arithmetic across DST',
    runs: 3000,
    gen: (rng) => {
      const day = rng.chance(0.7) && TRANSITIONS.length ? O.addDays(rng.pick(TRANSITIONS.filter((s) => s >= '1990')), rng.int(-2, 2)) : O.ymdOf(rng.int(O.daysFromCivil(1990, 1, 1), O.daysFromCivil(2060, 12, 31)));
      const [y, m, d] = day.split('-').map(Number);
      const now = new Date(y, m - 1, d, rng.pick([0, 0, 1, 2, 3, 12, 22, 23, rng.int(0, 23)]), rng.pick([0, 30, 59, rng.int(0, 59)]));
      const N = rng.weighted([[5, () => rng.int(1, 40)], [2, () => rng.int(41, 1000)]]);
      const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const [phrase, kind, arg] = rng.pick([
        ['today', 'add', 0], ['tomorrow', 'add', 1], [`in ${N} days`, 'add', N], [`in ${N} weeks`, 'add', 7 * N], [`in ${N} months`, 'months', N], [`in ${Math.min(N, 300)} years`, 'months', 12 * Math.min(N, 300)],
        ['next week', 'nextweek'], ['next month', 'nextmonth'], ['next year', 'nextyear'], ['this weekend', 'thisweekend'], ['next weekend', 'nextweekend'],
        [rng.pick(WD), 'weekday', null], [`next ${rng.pick(WD)}`, 'nextweekday', null],
      ]);
      return { now: now.getTime(), phrase, kind, arg };
    },
    prop: ({ now: t, phrase, kind, arg }) => {
      const now = new Date(t);
      const today = D.ymd(now);
      const z = O.dayOf(today);
      const wd = O.weekday(z);
      const [y, m] = today.split('-').map(Number);
      const word = phrase.split(' ').pop();
      const idx = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(word);
      const toSat = wd === 0 ? -1 : (6 - wd + 7) % 7;
      const want = {
        add: () => O.addDays(today, arg),
        months: () => O.addMonths(today, arg),
        nextweek: () => O.addDays(today, (1 - wd + 7) % 7 || 7),
        nextmonth: () => O.ymdOf(O.daysFromCivil(...O.addYm(y, m, 1), 1)),
        nextyear: () => `${String(y + 1).padStart(4, '0')}-01-01`,
        thisweekend: () => O.addDays(today, Math.max(0, toSat)),
        nextweekend: () => O.addDays(today, toSat < 0 ? 6 : toSat + 7),
        weekday: () => O.addDays(today, (idx - wd + 7) % 7),
        nextweekday: () => O.addDays(today, (idx - wd + 7) % 7 || 7),
      }[kind]();
      assume(want <= '9999-12-31');
      const r = nlpParse(`Report ${phrase}`, { mode: 'task', now });
      check(r.date === want, 'date', () => `parse("Report ${phrase}") at ${now.toString()} → date ${show(r.date)}, expected ${want}`);
      check(r.title === 'Report', 'title', () => `title ${show(r.title)}`);
    },
  },
];
