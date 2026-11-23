// QA (data, final pass): a pasted wall of text never freezes quick add. Several parser rules look at the
// text after each of their matches, so a long run of tokens was quadratic: 100,000 characters of
// "fri fri ..." took about 3 s, "#x #x ..." over 1 s, on every keystroke in a field without a length
// limit (Schedule's Create card has none; Tasks and the server stop at 1000 characters). parse() now
// reads about the first 2000 characters and keeps the rest in the title exactly as typed: nothing is
// lost (a stored title keeps 500 characters anyway), and every shorter input parses as before.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../shared/nlp.js';

const NOW = new Date(2026, 10, 22, 12); // Sunday 22 November 2026
const opts = (mode) => ({ mode, now: NOW, ranges: true, lists: [{ id: 'L1', name: 'Home' }], calendars: [{ id: 'C1', name: 'Home' }] });
const squash = (s) => s.replace(/"([^"]*)"/g, '$1').replace(/\s+/g, ' ').trim();

test('100,000 characters of tokens parse in well under a second (they took up to 3 s)', () => {
  const slow = [];
  for (const unit of ['fri ', '#x ', '@a ', 'every mon ', 'dec 5 ', 'at 5 ', 'tomorrow ', 'p1 ', '9-5 ', 'mon-fri, ', '"x" ']) {
    const input = unit.repeat(Math.ceil(100000 / unit.length));
    for (const mode of ['task', 'event']) {
      const t0 = performance.now();
      parse(input, opts(mode));
      const ms = performance.now() - t0;
      if (ms > 400) slow.push(`${JSON.stringify(unit)} x ${input.length} (${mode}): ${ms.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test('text past the first 2000 characters is kept in the title as typed, never lost', () => {
  const tail = ' see notes about the 3pm call, fri and dec 5 #Home @phone p1';
  const input = `Plan the trip tomorrow 6pm ${'word '.repeat(600)}${tail}`;
  for (const mode of ['task', 'event']) {
    const r = parse(input, opts(mode));
    assert.equal(r.date, '2026-11-23', `${mode}: a date near the start is read`);
    assert.equal(r.time, '18:00');
    assert.ok(r.tokens.every((t) => t.end <= 2000), 'nothing is read past the limit');
    assert.ok(r.title.endsWith(squash(tail)), `${mode}: the unread end is in the title as typed`);
    assert.equal(r.title, squash(input.replace('tomorrow 6pm ', '')));
  }
  // a task's list and labels past the limit are not read either: they stay words of the title
  const r = parse(`${'x '.repeat(1200)}#Home @phone !!`, opts('task'));
  assert.deepEqual([r.listId, r.newList, r.tags, r.priority], [null, null, [], 0]);
  assert.ok(r.title.endsWith('x #Home @phone!!'), r.title.slice(-30)); // (the title loses a space before punctuation, as always)
});

test('the limit falls between words, and never inside a character', () => {
  // "tomorrow" across the 2000th character is not cut into "tomo" + "rrow": it stays whole in the title
  const head = 'a '.repeat(998); // 1996 characters
  const r = parse(`${head}tomorrow 6pm`, opts('task'));
  assert.equal(r.date, null);
  assert.ok(r.title.endsWith('a tomorrow 6pm'), r.title.slice(-30));
  // "quoted text" across the limit is not read in part: the words in quotes stay unread, as always
  const quoted = `Meet tomorrow ${'w '.repeat(980)}"dec 5 at noon ${'q '.repeat(20)}end" fri`;
  const q = parse(quoted, opts('event'));
  assert.deepEqual([q.date, q.time, q.allDay], ['2026-11-23', null, true], 'nothing inside the quotes is read');
  assert.ok(q.title.endsWith(`w dec 5 at noon ${'q '.repeat(20)}end fri`), q.title.slice(-60));
  // a long run without spaces is cut at the limit, but never in the middle of a surrogate pair
  const emoji = '\u{1F600}'.repeat(1500); // 3000 code units, no spaces
  for (const pre of ['', 'x']) {
    const out = parse(pre + emoji, opts('task'));
    assert.equal(out.title, pre + emoji, 'every character is kept');
    assert.ok(out.title.isWellFormed(), 'no half surrogate pair');
  }
});

test('inputs up to the limit parse as they always did', () => {
  const pad = 'x'.repeat(1990);
  assert.deepEqual(
    [parse(`${pad} fri`, opts('task')).date, parse(`${pad} fri`, opts('task')).title],
    ['2026-11-27', pad],
    'a weekday at the end of 1994 characters is read',
  );
  const r = parse(`Gym every mon wed fri 7am ${'z'.repeat(1960)}`, opts('task'));
  assert.deepEqual([r.title, r.date, r.time, r.repeat], [`Gym ${'z'.repeat(1960)}`, '2026-11-23', '07:00', { freq: 'week', interval: 1, days: [1, 3, 5] }]);
  const e = parse(`Vacation dec 20-28 ${'y'.repeat(1970)}`, opts('event'));
  assert.deepEqual([e.date, e.endDate, e.allDay], ['2026-12-20', '2026-12-28', true]);
});
