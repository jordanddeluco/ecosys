// Deterministic repros of the defects the fuzz properties found (their shrunk counterexamples), one
// test per defect, so each one is reported in every run whatever the seed. A test here passes once
// its defect is fixed. Runs with notes/core/schema.js registered when it exists (as in the notes
// app, the schedule app and the server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as S from '../../shared/sanitize.js';
import * as R from '../../shared/recur.js';
import { parse } from '../../shared/nlp.js';
import { runChildProps } from './lib/child.js';

const has = (rel) => existsSync(new URL(rel, import.meta.url));
const SC = has('../../notes/core/schema.js') ? await import('../../notes/core/schema.js') : null;
const MD = has('../../notes/core/markdown.js') ? await import('../../notes/core/markdown.js') : null;
const notes = SC ? {} : { skip: 'notes/core/schema.js not present' };
const markdown = SC && MD ? {} : { skip: 'notes/core/markdown.js not present' };
const J = (s) => JSON.parse(s); // like data arriving from the network: "__proto__"/"toString" become own keys
const noThrow = (fn, what) => {
  try {
    return fn();
  } catch (err) {
    assert.fail(`${what} threw ${err?.name}: ${err?.message}`);
  }
};
const now = (y, m, d) => new Date(y, m - 1, d, 12);
const quiet = (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};

// ---------------------------------------------------------------- shared/sanitize.js

test('sanitize: validateItem does not throw on a JSON object with a non-callable toString in a text field (notes.body)', () => {
  noThrow(() => S.validateItem('notes', J('{"id":"a","body":{"toString":0}}')), "validateItem('notes', {body:{toString:0}})");
});

test('sanitize: validateSnapshot / validateOps do not throw on such a record (an import or sync batch must not fail as a whole)', () => {
  noThrow(() => S.validateSnapshot(J('{"data":{"notes":[{"id":"a","body":{"toString":""}}]}}')), 'validateSnapshot');
  noThrow(() => S.validateOps(J('[{"op":"replace","c":"notes","items":[{"id":"a","body":{"toString":""}}]}]')), 'validateOps');
});

test('sanitize: a repaired event keeps the canonical key order (end right after start), so JSON comparisons in store/sync stay stable', () => {
  const e = S.validateItem('events', { id: 'a', start: '2024-02-29T23:59' });
  const fields = S.schemaFields('events').filter((k) => k in e);
  assert.deepEqual(Object.keys(e), fields, `keys ${JSON.stringify(Object.keys(e))}`);
  assert.equal(JSON.stringify(S.validateItem('events', e)), JSON.stringify(e), 'a second validation changes the JSON');
});

test('sanitize: extendSchema refuses prototype names such as "__proto__" (no writes onto Object.prototype) — isolated child process', async () => {
  const report = await runChildProps(new URL('./lib/extend-schema-props.js', import.meta.url));
  const r = report.results.find((x) => x.name.startsWith('extendSchema'));
  assert.ok(r?.ok, r?.error);
});

// ---------------------------------------------------------------- notes/core/schema.js

test('notes schema: validateBlocks does not throw on a run whose href is an object ({"toString":""})', notes, () => {
  noThrow(() => SC.validateBlocks(J('[{"c":[["x","",{"href":{"toString":""}}]]}]')), 'validateBlocks');
});

test('notes schema: validateItem("notes") never turns a note with one odd run into an empty shell (it keeps the blocks or rejects the record)', notes, () => {
  const raw = J('{"id":"n1","blocks":[{"id":"b1","t":"h1","c":[["Groceries"]]},{"id":"b2","t":"p","c":[["milk "],["link","",{"href":{"toString":""}}]]}],"pinned":true,"rev":5}');
  const out = quiet(() => S.validateItem('notes', raw));
  assert.ok(out === null || (Array.isArray(out.blocks) && out.blocks.length >= 2), `validateItem returned ${JSON.stringify(out)} — the note content would be replaced by this`);
});

test('notes schema: validateFolder does not throw on {"name":{"toString":0}}', notes, () => {
  noThrow(() => SC.validateFolder(J('{"id":"a","name":{"toString":0}}')), 'validateFolder');
  noThrow(() => S.validateItem('folders', J('{"id":"a","name":{"toString":0}}')), "validateItem('folders')");
});

test('notes schema: normalizeTag is idempotent for "İstanbul" (a stored tag must normalize to itself, or rename/remove/#search cannot find it)', notes, () => {
  const once = SC.normalizeTag('İstanbul');
  assert.equal(SC.normalizeTag(once), once, `normalizeTag("İstanbul") = ${JSON.stringify(once)}, normalizeTag of that = ${JSON.stringify(SC.normalizeTag(once))}`);
});

test('notes schema: removeTagFromBlocks removes #a/b even when two tags touch ("#a/b#a/b")', notes, () => {
  const r = SC.removeTagFromBlocks([SC.newBlock('p', '#a/b#a/b and #a here')], 'a');
  const tags = SC.deriveFields({ blocks: r.blocks }).tags;
  assert.deepEqual(tags.filter((t) => SC.tagMatches(t, 'a')), [], `text after removal: ${JSON.stringify(r.blocks.map(SC.blockText))}`);
});

// ---------------------------------------------------------------- notes/core/markdown.js

const roundTrip = (blocks) => MD.markdownToBlocks(MD.blocksToMarkdown(blocks));

test('markdown: a trailing line break in a Body does not come back as a literal backslash', markdown, () => {
  const back = roundTrip([SC.newBlock('p', 'a\n')]);
  const text = back.map(SC.blockText).join('|');
  assert.ok(!text.includes('\\'), `"a\\n" → ${JSON.stringify(MD.blocksToMarkdown([SC.newBlock('p', 'a\n')]))} → ${JSON.stringify(text)}`);
});

test('markdown: a heading whose text is "#" is escaped once, not twice', markdown, () => {
  const b = SC.newBlock('h2', '#');
  const back = roundTrip([b]);
  assert.deepEqual(back.map((x) => [x.t, SC.blockText(x)]), [['h2', '#']], `Markdown ${JSON.stringify(MD.blocksToMarkdown([b]))}`);
});

test('markdown: Body text with a leading space before a list/heading marker stays Body text (" +", " - x", " # x")', markdown, () => {
  for (const text of [' +', ' - x', ' # x', ' 1. x']) {
    const b = SC.newBlock('p', text);
    const back = roundTrip([b]);
    assert.deepEqual(back.map((x) => [x.t, SC.blockText(x).trim()]), [['p', text.trim()]], `${JSON.stringify(text)} → ${JSON.stringify(MD.blocksToMarkdown([b]))} → ${JSON.stringify(back.map((x) => [x.t, SC.blockText(x)]))}`);
  }
});

test('markdown: "- [ ]\\na" is a fixed point after one round trip', markdown, () => {
  const once = MD.blocksToMarkdown(MD.markdownToBlocks('- [ ]\na'));
  assert.equal(MD.blocksToMarkdown(MD.markdownToBlocks(once)), once);
});

test('markdown: slugify never produces a reserved Windows device name ("con.a" → file "con.a.md" cannot be created)', markdown, () => {
  for (const t of ['con.a', 'NUL.txt', 'com1.notes', 'aux.backup']) assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(MD.slugify(t)), `slugify(${JSON.stringify(t)}) = ${JSON.stringify(MD.slugify(t))}`);
});

// ---------------------------------------------------------------- shared/nlp.js

test('nlp: a year before 1000 never gives a malformed date ("5/1/0491" → "491-05-01")', () => {
  for (const s of ['Party 5/1/0491', 'Party 0392-3-1', 'Party dec 5 0999']) {
    const d = parse(s, { now: now(2026, 11, 22) }).date;
    assert.ok(d === null || S.isYmd(d), `${s} → ${d}`);
  }
});

test('nlp: a four-digit year below 100 is not moved to the 1900s/2000s ("28 january 0058" → 1958-01-28)', () => {
  for (const [s, bad] of [['Party 28 january 0058', '1958-01-28'], ['Party 0099-12-31', '1999-12-31'], ['Party 12/5/0001', '2001-12-05']]) {
    assert.notEqual(parse(s, { now: now(2026, 11, 22), dmy: s.includes('january') }).date, bad, s);
  }
});

test('nlp: an impossible M/D/YYYY date (2/29 in a common year) is not read as March 1', () => {
  for (const s of ['Party 2/29/2026', 'Party 2/29/9402']) {
    const d = parse(s, { now: now(2026, 11, 22) }).date;
    assert.ok(d === null || d.slice(5) === '02-29', `${s} → ${d}`);
  }
});

test('nlp: "the 30th" read on Jan 31 is Mar 30, not Mar 1/2 (no month overflow)', () => {
  assert.equal(parse('Pay rent the 30th', { now: now(2028, 1, 31) }).date, '2028-03-30');
  assert.equal(parse('Pay rent the 29th', { now: now(2027, 1, 31) }).date, '2027-03-29');
});

test('nlp: an impossible worded date ("the 29th of february 2026") is not read as some other date', () => {
  const r = parse('Party the 29th of february 2026', { now: now(2026, 11, 22) });
  assert.equal(r.date, null, `date ${r.date}, title ${JSON.stringify(r.title)}`);
});

test('nlp: huge relative offsets give no date instead of "NaN-NaN-NaN" or a 5-digit year', () => {
  for (const s of ['Trip in 381894475 years', 'Report in 99999999999 days', 'Trip in 8000 years']) {
    const d = parse(s, { now: now(2026, 11, 22) }).date;
    assert.ok(d === null || S.isYmd(d), `${s} → ${d}`);
  }
});

test('nlp: "every 1000 days" is not stored as daily (interval kept or the phrase not read as a repeat)', () => {
  const r = parse('Water plants every 1000 days', { now: now(2026, 11, 22) });
  if (r.repeat) assert.equal(S.validateRepeat(r.repeat).interval, r.repeat.interval, `parsed interval ${r.repeat.interval}, validateRepeat stores ${S.validateRepeat(r.repeat).interval}`);
});

test('nlp: a repeat never gets weekday NaN ("2/9/0211 weekly")', () => {
  const r = parse('2/9/0211 weekly', { mode: 'event', now: now(2026, 11, 22) });
  assert.ok(!r.repeat?.days || r.repeat.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), `repeat ${JSON.stringify(r.repeat)}`);
});

// ---------------------------------------------------------------- shared/recur.js

test('recur: completing a long-overdue daily task moves it after today (no 5000-step cap)', () => {
  const r = R.nextRepeatDates({ date: '2000-01-01', repeat: { freq: 'day', interval: 1 } }, '2026-11-22');
  assert.ok(r.date > '2026-11-22', `got ${r.date}`);
  const w = R.nextRepeatDates({ date: '1981-07-14', repeat: { freq: 'week', interval: 1, days: [0, 1, 2, 3, 4, 5, 6] } }, '2017-03-11');
  assert.ok(w.date > '2017-03-11', `got ${w.date}`);
});

test('recur: a monthly/yearly series starting off its monthDay still shows its start date (weekly series do; RFC 5545 counts DTSTART)', () => {
  const y = R.occurrencesBetween({ freq: 'year', interval: 1, monthDay: 25 }, '1972-10-12', '1972-10-01', '1973-12-31');
  assert.equal(y[0], '1972-10-12', `yearly: ${JSON.stringify(y)}`);
  const m = R.occurrencesBetween({ freq: 'month', interval: 1, monthDay: 15 }, '2026-11-22', '2026-11-01', '2027-01-31');
  assert.equal(m[0], '2026-11-22', `monthly: ${JSON.stringify(m)}`);
  const w = R.occurrencesBetween({ freq: 'week', interval: 1, days: [1] }, '2026-11-24', '2026-11-01', '2026-12-31');
  assert.equal(w[0], '2026-11-24', 'weekly (control)');
});
