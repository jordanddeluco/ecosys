// QA (data, second pass): properties of date ranges on generated text. tests/fuzz/nlp.fuzz.test.js
// runs the parser without `ranges`, so the range rule needs its own: with ranges: true on range-like
// token soup (dates, bare days, separators, times, lengths, quantities, repeats), parse() must never
// throw, every day it gives is a real stored date, an event's range runs forward for at most a year,
// a timed range is timed by a start and an end time for at most 14 days (never a stretched length),
// every letter outside a token stays in the title, and tokens match the input. Without ranges: true
// no range is ever read. Seeded and repeatable like the fuzz suite (FUZZ_SEED, FUZZ_RUNS).
// Run with: npm test
import { test } from 'node:test';
import { parse } from '../shared/nlp.js';
import { isYmd, isHHMM } from '../shared/sanitize.js';
import { diffDays } from '../shared/dates.js';
import { runs, forAll, check, shrinkString, show } from './fuzz/lib/harness.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'december', 'feb.', 'sept'];
const SEPS = ['-', ' - ', '–', ' – ', '—', ' to ', ' through ', ' thru ', ' until ', ' till ', ' and ', '- ', ' -'];
const WORDS = ['Trip', 'Vacation', 'from', 'between', 'on', 'by', 'due', 'the', 'of', 'people', 'pages', 'boxes', 'km', '%', 'off', 'in', 'at', 'with', 'Rome', 'Sam', 'Hawaii', 'all day', 'every', 'every weekday', 'every mon-fri', 'weekly on tue - thu', 'every fri to sun', 'every 2 weeks', 'tomorrow', 'fri', 'evening', 'morning', 'tonight', '#Work', '"quoted dec 3-5"', '!!', 'p1', '@phone', ','];
const TIMES = ['9am', '9-11am', '9am-5pm', '10pm-2am', 'at 5', 'noon', '6pm-5pm', '5pm-6pm', 'from 9 to 5', '17:00', '9:30am'];
const LENGTHS = ['for 2h', 'for 45m', 'for an hour', '90min', 'for 1.5h'];

function datePart(rng) {
  const d = () => String(rng.weighted([[8, () => rng.int(1, 31)], [1, () => rng.int(0, 99)]]));
  const y = () => (rng.chance(0.3) ? rng.pick([' 2026', ', 2027', ' 2028', ' 9999', ' 1000', ' 0999']) : '');
  return rng.weighted([
    [4, () => `${rng.pick(MONTHS)} ${d()}${rng.chance(0.2) ? rng.pick(['st', 'nd', 'rd', 'th']) : ''}${y()}`],
    [2, () => `${d()} ${rng.chance(0.3) ? 'of ' : ''}${rng.pick(MONTHS)}${y()}`],
    [3, () => d()],
    [1, () => `the ${d()}th`],
    [2, () => `${rng.int(0, 13)}/${d()}${rng.chance(0.3) ? `/${rng.pick(['26', '2027', '99'])}` : ''}`],
    [1, () => `${rng.pick(['2026', '2027', '0999', '9999'])}-${rng.int(0, 13)}-${d()}`],
  ]);
}
function rangeSoup(rng) {
  const parts = [];
  for (let i = rng.int(1, 6); i > 0; i--) {
    parts.push(
      rng.weighted([
        [5, () => `${datePart(rng)}${rng.pick(SEPS)}${datePart(rng)}`],
        [2, () => datePart(rng)],
        [3, () => rng.pick(WORDS)],
        [2, () => rng.pick(TIMES)],
        [1, () => rng.pick(LENGTHS)],
        [1, () => `${rng.int(0, 99)}${rng.pick(['%', ' %', ' people', ''])}`],
      ]),
    );
  }
  return parts.join(rng.pick([' ', ' ', '  ', ', ']));
}
function gen(rng) {
  const now = new Date(rng.pick([2026, 2027, 2028, 1000, 9999]), rng.int(0, 11), rng.int(1, 28), 12);
  return { input: rangeSoup(rng), opts: { mode: rng.pick(['task', 'event']), now, ranges: true, dmy: rng.chance(0.2), hour12: rng.chance(0.8), lists: [{ id: 'L1', name: 'Work' }], calendars: [{ id: 'C1', name: 'Work' }] } };
}
const shrink = (value, stillFails) => {
  const r = shrinkString(value.input, (s) => stillFails({ ...value, input: s }));
  return r ? { value: { ...value, input: r.value }, error: r.error } : null;
};
const display = ({ input, opts }) => show({ input, mode: opts.mode, now: opts.now.toDateString(), dmy: opts.dmy });
const minutes = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const LETTER = /\p{L}/u;

function prop({ input, opts }) {
  let r;
  try {
    r = parse(input, opts);
  } catch (err) {
    check(false, 'throws', `parse threw ${err?.name}: ${err?.message}`);
  }
  for (const k of ['date', 'deadline', 'endDate']) check(r[k] === null || isYmd(r[k]), `invalid-${k}`, () => `${k} = ${show(r[k])}`);
  check(r.time === null || isHHMM(r.time), 'time', () => `time ${show(r.time)}`);
  check(r.duration === null || (Number.isInteger(r.duration) && r.duration >= 1), 'duration', () => `duration ${show(r.duration)}`);
  if (r.endDate !== null) {
    check(opts.mode === 'event', 'task-endDate', 'a task has an endDate');
    check(r.date !== null && r.date <= r.endDate && diffDays(r.date, r.endDate) <= 366, 'span', () => `${r.date}..${r.endDate}`);
    check(r.repeat === null, 'repeat-range', 'a repeat with an endDate');
  }
  if (r.endDate && r.endDate > r.date && r.time) {
    check(r.endTime !== null, 'stretched', () => `a timed range without an end time: ${r.date} ${r.time} .. ${r.endDate}`);
    check(!r.tokens.some((tk) => tk.kind === 'duration'), 'stretched-length', 'a typed length stretched over the range');
    check(r.duration === diffDays(r.date, r.endDate) * 1440 + minutes(r.endTime) - minutes(r.time) && r.duration <= 14 * 1440, 'timed-span', () => `duration ${r.duration} for ${r.date} ${r.time} .. ${r.endDate} ${r.endTime}`);
  }
  if (r.allDay) check(r.time === null, 'allday-time', () => `all day at ${r.time}`);
  if (r.repeat) check(r.date !== null, 'repeat-no-date', 'a repeat without a first date');
  // every letter outside a token is in the title; tokens are sorted, apart and match the input
  const covered = new Uint8Array(input.length);
  let last = 0;
  for (const tk of r.tokens) {
    check(tk.start >= last && tk.end > tk.start && tk.end <= input.length && tk.text === input.slice(tk.start, tk.end), 'token', () => `token ${show(tk)}`);
    for (let i = tk.start; i < tk.end; i++) covered[i] = 1;
    last = tk.end;
  }
  const free = [...input].filter((ch, i) => !covered[i] && LETTER.test(ch)).join('');
  const kept = [...r.title].filter((ch) => LETTER.test(ch)).join('');
  check(free === kept, 'letters', () => `letters outside tokens ${show(free)}, title ${show(r.title)}`);
  // the same text without the option never reads a range
  const off = parse(input, { ...opts, ranges: undefined });
  check(off.endDate === null, 'off-endDate', () => `endDate ${off.endDate} without ranges: true`);
  check(JSON.stringify(parse(input, opts)) === JSON.stringify(r), 'nondeterministic', 'two parses differ');
}

test('date ranges on generated text: real days, forward spans, no stretched times, every letter kept', (t) => {
  const r = forAll('qa-data.ranges', { runs: runs(4000), gen, prop, shrink, display });
  t.diagnostic(`cases=${r.runs}`);
});
