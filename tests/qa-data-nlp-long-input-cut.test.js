// QA (data, second pass: verifier findings on the 2000-character limit in quick add). parse() reads about
// the first 2000 characters of a long paste; three things went wrong at that cut:
//  - A place that ran up to the cut stopped there, and the rest of the paste went into the title:
//    "Team offsite tomorrow 9am-5pm at Lakeside Lodge <paragraph>" was saved as "Team offsite quarter,
//    agenda notes …". The place now takes the rest, as it did before the limit, and its token covers it.
//  - The last words read were taken as the end of the input: "… sat down" became Saturday, "… evening
//    news" 18:00, "… dec 3 - 10 people" a range to Dec 10. Rules that look past their match now see the
//    words that follow the cut, and a stand-in for them in the masked text.
//  - The title's trailing trim tried every position in a long run of dashes or commas: "Notes " +
//    100,000 dashes + " end" took 6 s per keystroke in Schedule's Create card. It now runs in linear time.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../shared/nlp.js';

const NOW = new Date(2026, 10, 22, 12); // Sunday 22 November 2026
const opts = (mode, more = {}) => ({ mode, now: NOW, ranges: true, lists: [{ id: 'L1', name: 'Home' }], calendars: [{ id: 'C1', name: 'Home' }], ...more });
const squash = (s) => s.replace(/"([^"]*)"/g, '$1').replace(/\s+/g, ' ').trim();
const PARA = `Team offsite tomorrow 9am-5pm at Lakeside Lodge ${'agenda notes and goals for the quarter, '.repeat(2500)}`;

test('a place that runs up to the cut keeps the rest of the paste, and the title stays the title', () => {
  const r = parse(PARA, opts('event'));
  assert.equal(r.title, 'Team offsite');
  assert.deepEqual([r.date, r.time, r.endTime], ['2026-11-23', '09:00', '17:00']);
  const place = PARA.slice(PARA.indexOf('Lakeside')).trim().replace(/,$/, '');
  assert.equal(r.location, place);
  // its token covers all of it: the Create card highlights the whole place, and "Keep" quotes all of it
  const tok = r.tokens.find((t) => t.kind === 'location');
  assert.deepEqual([tok.start, tok.end], [PARA.indexOf('at Lakeside'), PARA.trimEnd().length]);
  assert.equal(tok.text, PARA.slice(tok.start, tok.end));
  const kept = parse(`${PARA.slice(0, tok.start)}"${PARA.slice(tok.start, tok.end)}"${PARA.slice(tok.end)}`, opts('event'));
  assert.deepEqual([kept.location, kept.date, kept.time], [null, '2026-11-23', '09:00']);
  assert.equal(kept.title, `Team offsite ${squash(PARA.slice(tok.start)).replace(/,$/, '')}`);
  // "with" just before the cut still ends the place, and what follows is the title's, as in a short text
  const w = parse(`Party tomorrow at Cafe Luna ${'b '.repeat(983)}${'with Sam and Alex '.repeat(10)}`, opts('event'));
  assert.equal(w.location, `Cafe Luna ${'b '.repeat(983)}`.trim());
  assert.equal(w.title, `Party ${squash('with Sam and Alex '.repeat(10))}`);
});

test('a place can start right at the cut, with the words after it, as in the whole text', () => {
  const words = 'Lakeside Lodge near the water '.repeat(10);
  const input = `Dinner tomorrow ${'b '.repeat(990)}at ${words}`;
  const r = parse(input, opts('event'));
  assert.deepEqual([r.date, r.location, r.title], ['2026-11-23', words.trim(), `Dinner ${'b '.repeat(990).trim()}`]);
  const tok = r.tokens.find((t) => t.kind === 'location');
  assert.deepEqual([tok.start, tok.end, tok.text], [input.lastIndexOf('at '), input.trimEnd().length, `at ${words.trim()}`]);
  // quoted words across the cut can be the place too: the cut moves before them, they stay whole
  const q = parse(`Dinner tomorrow ${'b '.repeat(989)}at "Lakeside ${'w '.repeat(200)}" more`, opts('event'));
  assert.equal(q.location, `Lakeside ${'w '.repeat(200)} more`); // (a place keeps its spacing as typed)
  // a lone quote is not quoted text, and a rejected date is never a place, at the cut as anywhere
  const lone = parse(`Dinner tomorrow ${'b '.repeat(990)}at "lone quote ${'and words '.repeat(20)}`, opts('event'));
  assert.equal(lone.location, null);
  const feb = parse(`${'b '.repeat(995)}at feb 30 ${'remaining words '.repeat(20)}`, opts('event'));
  assert.deepEqual([feb.location, feb.date], [null, null]);
});

test('the last words read before the cut are read as in the whole text', () => {
  // "sat" is a word of the sentence, not Saturday
  const sat = `${'a '.repeat(997)}${'sat down and talked about the plan '.repeat(10)}`;
  for (const mode of ['task', 'event']) {
    const r = parse(sat, opts(mode));
    assert.deepEqual([r.date, r.title], [null, squash(sat)], mode);
  }
  // "evening news" is not 18:00 (nor, for an event, today)
  const eve = `${'e '.repeat(996)}${'evening news was long and dull '.repeat(10)}`;
  for (const mode of ['task', 'event']) {
    const r = parse(eve, opts(mode));
    assert.deepEqual([r.date, r.time, r.title], [null, null, squash(eve)], mode);
  }
  // quoted text across the cut stays unread, and the word before it is not the end of the input
  const club = `Book club sat "${'w '.repeat(1200)}" more`;
  const c = parse(club, opts('task'));
  assert.deepEqual([c.date, c.title], [null, squash(club)]);
  // "dec 3 - 10 people" is how many came, not a range to Dec 10
  const party = `${'c '.repeat(992)}${'dec 3 - 10 people came to the party '.repeat(10)}`;
  const t = parse(party, opts('task'));
  assert.deepEqual([t.date, t.deadline], ['2026-12-03', null]);
  const e = parse(party, opts('event'));
  assert.deepEqual([e.date, e.endDate, e.allDay], ['2026-12-03', null, true]);
});

test('what follows the cut counts as typed, not as the end of the text nor as an unknown word', () => {
  // "!!" before more words is a priority, as it is in the whole text
  assert.equal(parse(`${'a '.repeat(998)}${'!! more words here '.repeat(10)}`, opts('task')).priority, 2);
  // nothing but spaces after the cut: the text does end there, so "evening" is its last word
  assert.equal(parse(`Read ${'e '.repeat(993)}evening${' '.repeat(3000)}`, opts('task')).time, '18:00');
  // "30 %discount" is a percentage, not the last day of a range
  const pct = parse(`${'c '.repeat(991)}${'nov 25 - 30 %discount on everything '.repeat(10)}`, opts('task'));
  assert.deepEqual([pct.date, pct.deadline], ['2026-11-25', null]);
  // a range that goes on with a place is still a range
  const rome = parse(`${'c '.repeat(994)}${'dec 20 - 28 in Rome with friends '.repeat(10)}`, opts('event'));
  assert.deepEqual([rome.date, rome.endDate, rome.allDay], ['2026-12-20', '2026-12-28', true]);
  // "fri morning" across the cut: Friday, as in the whole text; "morning", past the cut, is not read
  const fri = parse(`${'x '.repeat(998)}${'fri morning meeting '.repeat(10)}`, opts('task'));
  assert.deepEqual([fri.date, fri.time], ['2026-11-27', null]);
});

test('long runs of dashes, commas or semicolons are trimmed in linear time (they took seconds)', () => {
  const cases = [
    // [input, mode, title, place]: runs inside the text took 1.7 to 8 s; trailing runs are still trimmed
    [`Notes ${'-'.repeat(100000)} end`, 'task', `Notes ${'-'.repeat(100000)} end`, null],
    [`Lunch ${', '.repeat(50000)}end`, 'task', `Lunch${','.repeat(50000)} end`, null],
    [`x ${'—'.repeat(50000)} y`, 'event', `x ${'—'.repeat(50000)} y`, null],
    [`Lunch ${' ,'.repeat(50000)}`, 'task', 'Lunch', null],
    [`Party at Lodge ${','.repeat(100000)} end`, 'event', 'Party', `Lodge ${','.repeat(100000)} end`],
    [`Party at Lodge${',;.'.repeat(30000)}`, 'event', 'Party', 'Lodge'],
  ];
  const slow = [];
  for (const [input, mode, title, place] of cases) {
    const t0 = performance.now();
    const r = parse(input, opts(mode));
    const ms = performance.now() - t0;
    if (ms > 400) slow.push(`${JSON.stringify(input.slice(0, 16))}… (${mode}): ${ms.toFixed(0)} ms`);
    assert.equal(r.title, title, `${JSON.stringify(input.slice(0, 16))}… title`);
    assert.equal(r.location, place, `${JSON.stringify(input.slice(0, 16))}… place`);
  }
  assert.deepEqual(slow, []);
});

test('random phrases just before the cut are read as they are in a short text', () => {
  let seed = 20261123;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const VOCAB = ['tomorrow', 'today', 'fri', 'sat', 'sun', 'mon', 'wed', 'friday', 'next', 'this', 'on', 'by', 'dec', 'nov', 'may', '3', '5', '10', '20', '28', '30', '12/5', '12/20-12/28', '2026-12-05', '-', '–', 'to', 'and', 'between', 'from', 'people', 'in', 'Rome', '%', '30%', '9am', '5pm', '9am-5pm', 'at', 'Cafe', 'with', 'Sam', '#Home', '#new', '@phone', '!', '!!', 'p1', '!high', 'every', 'other', 'weekday', 'week', 'weeks', 'month', '2', '100', 'days', 'daily', 'weekly', 'for', '30m', '1.5h', 'an', 'hour', 'morning', 'evening', 'afternoon', 'tonight', 'noon', 'midnight', 'all day', 'someday', 'the', '15th', '31st', 'of', 'june', 'feb', '29', '"quoted words"', '"', ',', ';', 'e', 'a', 'Lunch', '—', 'until'];
  const FILL = 'lorem ipsum dolor amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
  const words = (n, from) => Array.from({ length: n }, () => pick(from)).join(' ');
  const parts = (r) => ({ ...r, title: undefined, tokens: r.tokens.map((t) => [t.kind, t.text]) });
  const bad = [];
  for (let i = 0; i < 300; i++) {
    const phrase = words(1 + Math.floor(rnd() * 8), VOCAB);
    const tail = words(40, FILL);
    // the long text ends its phrase 0-12 characters before the 2000th (so the cut falls at it or just
    // after it); the short one is the same phrase between the same words, far from any cut
    let head = '';
    const at = 1993 - phrase.length - Math.floor(rnd() * 13);
    while (head.length < at - 12) head += `${pick(FILL)} `;
    head = head.padEnd(at, ' ');
    const short = `lorem ${phrase} ${tail}`;
    const long = `${head}lorem ${phrase} ${tail}`;
    for (const o of [opts('task'), opts('event'), opts('event', { ranges: false, dmy: true })]) {
      const s = parse(short, o);
      const l = parse(long, o);
      try {
        assert.deepEqual(parts(l), parts(s));
        assert.equal(l.title, `${squash(head)} ${s.title}`);
      } catch {
        bad.push(`${o.mode}${o.ranges ? '+ranges' : ''}: …${JSON.stringify(long.slice(at, at + phrase.length + 14))}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
