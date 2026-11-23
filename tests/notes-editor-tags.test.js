// notes/editor #tags: the editor highlights, completes and checks tags with the rules of
// notes/core/schema.js (which derives the tags the sidebar and search use), combining marks included,
// so a Hindi, Arabic (with harakat) or decomposed-accent tag is one tag everywhere, not a cut-off one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.ECOSYS_ROOT ? pathToFileURL(`${process.env.ECOSYS_ROOT.replace(/\\/g, '/')}/`) : new URL('../', import.meta.url);
const M = await import(new URL('notes/editor/model.js', ROOT));
const S = await import(new URL('notes/core/schema.js', ROOT));

const HINDI = 'हिंदी'; // ह + vowel sign i (Mc) + anusvara (Mn) + द + vowel sign ii (Mc)
const ARABIC = 'مَرْحَبًا'; // letters with fatha, sukun and tanween (Mn)
const DECOMPOSED = 'café'; // e + combining acute accent

const spans = (s) => M.tagSpans(s).map(({ start, end }) => s.slice(start, end));

test('tagSpans keeps combining marks inside a tag (Hindi, Arabic harakat, decomposed accents)', () => {
  assert.deepEqual(spans(`plan #${HINDI} today`), [`#${HINDI}`]);
  assert.deepEqual(spans(`#${ARABIC} و #عربي`), [`#${ARABIC}`, '#عربي']);
  assert.deepEqual(spans(`#${DECOMPOSED}!`), [`#${DECOMPOSED}`]);
  assert.deepEqual(spans('#हिंदी/नोट्स-'), ['#हिंदी/नोट्स'], 'nested, trailing - left out');
  // A tag never starts right after a letter, a mark, a digit, _, &, / or #.
  assert.deepEqual(spans('C#sharp &#38; a/#b ##x x#y ि#z 1#q _#w'), []);
  assert.deepEqual(spans('#123 #_ #-a'), [], 'a tag needs a letter, and starts with a letter, digit or _');
  assert.deepEqual(spans('#2026plans #a_b'), ['#2026plans', '#a_b']);
  assert.deepEqual(spans('no tags here'), []);
  assert.deepEqual(M.tagSpans(null), []);
});

test('tagSpans finds exactly the tags notes/core/schema.js finds', () => {
  const corpus = [
    `#${HINDI} और #मराठी`,
    `صباح #${ARABIC} #عمل/مشروع`,
    `#${DECOMPOSED} #naïve #İstanbul`,
    '#work/clients- #a/b/c #x-y-',
    'Email a#b, C#, &#38;, https://x.test/#frag, #ok',
    '#日本語 #한국어 #ελληνικά #עברית',
    'mixed #tag1 #1tag #_under #9',
  ];
  for (const s of corpus) {
    const editor = M.tagSpans(s).map(({ start, end }) => [start, end]);
    const core = S.findTags(s).map(({ start, end }) => [start, end]);
    assert.deepEqual(editor, core, s);
  }
});

test('tagAtEnd: the tag being typed, marks included; isTagBody: can the query still be a tag', () => {
  assert.deepEqual(M.tagAtEnd('see #ह'), { start: 4, body: 'ह' });
  assert.deepEqual(M.tagAtEnd(`see #${HINDI}`), { start: 4, body: HINDI }, 'the vowel signs stay in the query');
  assert.deepEqual(M.tagAtEnd(`#${ARABIC}`), { start: 0, body: ARABIC });
  assert.equal(M.tagAtEnd('C#x'), null);
  assert.equal(M.tagAtEnd('#'), null);
  assert.equal(M.tagAtEnd('#a b'), null, 'only at the very end');
  assert.equal(M.tagAtEnd(undefined), null);
  for (const q of [HINDI, ARABIC, DECOMPOSED, 'work/', 'a-b', '_x', '9a']) assert.equal(M.isTagBody(q), true, q);
  for (const q of ['', 'a b', 'ि', '-a', '/a', 'a!', 'a#b']) assert.equal(M.isTagBody(q), false, JSON.stringify(q));
  assert.equal(M.isTagBody(null), false);
});

test('tagFromInput: what the Add tag / Rename tag fields keep', () => {
  assert.equal(M.tagFromInput(`  #${HINDI} `), HINDI);
  assert.equal(M.tagFromInput(`#${ARABIC}`), ARABIC);
  assert.equal(M.tagFromInput('#My topic!'), 'My-topic');
  assert.equal(M.tagFromInput('##work/clients/'), 'work/clients');
  assert.equal(M.tagFromInput('िabc'), 'abc', 'never starts with a combining mark');
  assert.equal(M.tagFromInput('-/x'), 'x');
  assert.equal(M.tagFromInput('!!!'), '');
  assert.equal(M.tagFromInput(null), '');
  // Whatever it returns with a letter in it is a tag the core accepts whole.
  for (const raw of [`#${HINDI}`, `#${ARABIC}`, `#${DECOMPOSED}`, '#My topic!', 'a/b c', '#İstanbul']) {
    const t = M.tagFromInput(raw);
    assert.ok(S.normalizeTag(t), `${raw} → ${t}`);
    assert.deepEqual(S.findTags(`#${t}`).map((x) => x.raw), [t], `#${t} is read back as one tag`);
  }
});
