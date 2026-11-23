// notes/core/search.js: the query language, ranking, filters, snippets and highlighting. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, searchNotes, highlight, normalize, normalizeWithMap, matchRanges, snippetText, indexNotes } from '../notes/core/search.js';
import { validateNote } from '../notes/core/schema.js';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const DAY = 86400000;
let seq = 0;
const note = (blocks, extra = {}) =>
  validateNote({
    id: extra.id || `n${++seq}`,
    blocks: blocks.map((b) => (typeof b === 'string' ? { t: 'p', c: [[b]] } : b)),
    createdAt: NOW - (extra.created ?? 60) * DAY,
    editedAt: NOW - (extra.age ?? 1) * DAY,
    ...extra,
  });
const h1 = (t) => ({ t: 'h1', c: [[t]] });
const ids = (res) => res.map((r) => r.note.id);
const folders = [
  { id: 'fw', name: 'Work', parentId: null },
  { id: 'fc', name: 'Clients', parentId: 'fw' },
  { id: 'fp', name: 'Personal', parentId: null },
];

test('parseQuery: words, phrases, exclusions, tags, folders, flags and dates', () => {
  const p = parseQuery('Milk "Oat  Milk" -soy -"no thanks" #Home/Shop -#work in:"Work/Clients" -in:Personal is:pinned -is:daily has:todo -has:link edited:7d created:2026-11-20 foo:bar C# milk,');
  assert.deepEqual(p.terms, ['milk', 'foo:bar', 'c#', 'milk']);
  assert.deepEqual(p.phrases, ['oat milk']);
  assert.deepEqual(p.tags, ['home/shop']);
  assert.equal(p.folder, 'Work/Clients');
  assert.deepEqual(p.is, { pinned: true });
  assert.deepEqual(p.has, { todo: true });
  assert.deepEqual(p.not, { terms: ['soy'], phrases: ['no thanks'], tags: ['work'], folder: 'Personal', is: { daily: true }, has: { link: true } });
  assert.deepEqual(p.edited, { kind: 'days', days: 7 });
  assert.deepEqual(p.created, { kind: 'date', ymd: '2026-11-20' });
  assert.equal(p.empty, false);
  assert.equal(parseQuery('   ').empty, true);
  assert.deepEqual(parseQuery('is:unknown edited:someday #2026').terms, ['is:unknown', 'edited:someday', '#2026'], 'unknown operators and number "tags" are text');
  assert.deepEqual(parseQuery('edited:today').edited, { kind: 'days', days: 0 });
  assert.deepEqual(parseQuery('edited:yesterday').edited, { kind: 'yesterday' });
  assert.deepEqual(parseQuery('created:2w').created, { kind: 'days', days: 14 });
  assert.equal(parseQuery('created:2026-02-30').created, null);
  assert.deepEqual(parseQuery('"unclosed phrase').phrases, ['unclosed phrase']);
});

test('normalisation: case, accents (é = e), whitespace; offsets map back', () => {
  assert.equal(normalize('Café  CRÈME\nbrûlée'), 'cafe creme brulee');
  assert.equal(normalize('ﬁle'), 'file');
  const { norm, map } = normalizeWithMap('Ünïcode  x');
  assert.equal(norm, 'unicode x');
  assert.equal(map[norm.indexOf('x')], 9);
  assert.deepEqual(matchRanges('Crème brûlée, creme', ['creme']), [[0, 5], [14, 19]]);
  assert.deepEqual(matchRanges('étude', ['etude']), [[0, 6]], 'a combining mark stays inside the range');
});

test('ranking: title exact > title word start > tag > title substring > body word start > body substring', () => {
  const notes = [
    note([h1('Plan'), 'unrelated'], { id: 'exact' }),
    note([h1('Plan the week'), 'x'], { id: 'start' }),
    note([h1('Other'), '#plan'], { id: 'tag' }),
    note([h1('Airplanes'), 'x'], { id: 'sub' }),
    note([h1('Body'), 'we plan a lot, plan plan plan'], { id: 'body' }),
    note([h1('Body2'), 'airplanes everywhere'], { id: 'bodysub' }),
    note([h1('Nothing'), 'here'], { id: 'none' }),
  ];
  const res = searchNotes(notes, 'plan', { now: NOW });
  assert.deepEqual(ids(res), ['exact', 'start', 'tag', 'sub', 'body', 'bodysub']);
  const body = res.find((r) => r.note.id === 'body');
  assert.ok(body.score > 8 + 6 && body.score < 8 + 8 + 11, 'extra body hits add up to +8');
  // recency and pinned break ties
  const a = note([h1('Twin'), 'x'], { id: 'old', age: 60 });
  const b = note([h1('Twin'), 'x'], { id: 'new', age: 0 });
  const c = note([h1('Twin'), 'x'], { id: 'pinned', age: 60, pinned: true });
  assert.deepEqual(ids(searchNotes([a, c, b], 'twin', { now: NOW })), ['new', 'pinned', 'old']);
  assert.deepEqual(ids(searchNotes([a, c, b], 'twin', { now: NOW, sort: 'date' })), ['new', 'old', 'pinned']);
  // every word must match; a full-title match of a multi-word query wins
  const w = [note([h1('weekly planning')], { id: 'full' }), note([h1('planning weekly notes long')], { id: 'part' }), note([h1('weekly')], { id: 'one' })];
  assert.deepEqual(ids(searchNotes(w, 'weekly planning', { now: NOW })), ['full', 'part']);
});

test('phrases, exclusions, accents and CJK substrings', () => {
  const notes = [
    note([h1('Coffee'), 'oat milk latte'], { id: 'oat' }),
    note([h1('Tea'), 'milk and oat cookies'], { id: 'cookies' }),
    note([h1('Café list'), 'soy milk'], { id: 'soy' }),
    note([h1('日本語のメモ'), '東京で会議'], { id: 'cjk' }),
  ];
  assert.deepEqual(ids(searchNotes(notes, '"oat milk"', { now: NOW })), ['oat']);
  assert.deepEqual(ids(searchNotes(notes, 'milk -soy', { now: NOW })).sort(), ['cookies', 'oat']);
  assert.deepEqual(ids(searchNotes(notes, 'milk -"and oat"', { now: NOW })).sort(), ['oat', 'soy']);
  assert.deepEqual(ids(searchNotes(notes, 'cafe', { now: NOW })), ['soy']);
  assert.deepEqual(ids(searchNotes(notes, '会議', { now: NOW })), ['cjk']);
  assert.deepEqual(searchNotes(notes, '', { now: NOW }), []);
});

test('filters: tags (nested), folders (subfolders, the default Notes folder), flags, dates, trash', () => {
  const notes = [
    note([h1('A'), '#work/clients #x'], { id: 'a', folderId: 'fc', pinned: true }),
    note([h1('B'), '#work'], { id: 'b', folderId: 'fw', age: 10 }),
    note([h1('C'), { t: 'check', ck: false, c: [['todo']] }, { t: 'check', ck: true, task: 't1', c: [['done']] }], { id: 'c', folderId: 'fp', age: 40 }),
    note([h1('D'), { t: 'p', c: [['link', '', { href: 'https://x.com' }]] }], { id: 'd', day: '2026-11-22' }),
    note([h1('E'), 'meeting'], { id: 'e', event: { id: 'ev1', date: '2026-11-24' }, aiPrev: { at: 1, by: 'mcp:claude', rev: 0, blocks: [] }, editedBy: 'mcp:claude', age: 0 }),
    note([h1('F'), 'gone'], { id: 'f', trashedAt: NOW - DAY }),
  ];
  const q = (s, o = {}) => ids(searchNotes(notes, s, { folders, now: NOW, ...o })).sort();
  assert.deepEqual(q('#work'), ['a', 'b'], 'nested tags count');
  assert.deepEqual(q('#work/clients'), ['a']);
  assert.deepEqual(q('#work -#x'), ['b']);
  assert.deepEqual(q('in:Work'), ['a', 'b'], 'subfolders count');
  assert.deepEqual(q('in:"work/clients"'), ['a']);
  assert.deepEqual(q('in:Clients'), ['a'], 'a unique folder name works without its path');
  assert.deepEqual(q('in:notes'), ['e'], 'the default folder: no folder, not a daily note');
  assert.deepEqual(q('in:Nowhere'), []);
  assert.deepEqual(q('-in:Work is:checklist'), ['c']);
  assert.deepEqual(q('is:pinned'), ['a']);
  assert.deepEqual(q('is:daily'), ['d']);
  assert.deepEqual(q('is:meeting'), ['e']);
  assert.deepEqual(q('is:ai'), ['e']);
  assert.deepEqual(q('has:todo'), ['c']);
  assert.deepEqual(q('has:done has:task'), ['c']);
  assert.deepEqual(q('has:link'), ['c', 'd'], 'task links and URLs both count');
  assert.deepEqual(q('edited:today'), ['e']);
  assert.deepEqual(q('edited:yesterday'), ['a', 'd']);
  assert.deepEqual(q('edited:30d'), ['a', 'b', 'd', 'e']);
  const c60 = new Date(NOW - 60 * DAY);
  const ymd = `${c60.getFullYear()}-${String(c60.getMonth() + 1).padStart(2, '0')}-${String(c60.getDate()).padStart(2, '0')}`;
  assert.deepEqual(q(`created:${ymd}`), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(q('created:7d'), []);
  assert.deepEqual(q('gone'), [], 'trashed notes are left out');
  assert.deepEqual(q('gone', { trash: true }), ['f'], 'unless searching Recently Deleted');
  assert.deepEqual(q('is:pinned', { trash: true }), []);
  const onlyFilters = searchNotes(notes, 'in:Work', { folders, now: NOW });
  assert.deepEqual(ids(onlyFilters), ['a', 'b'], 'operators only: newest edit first');
});

test('snippets: the best body block, about ±60 chars, every term marked; title ranges', () => {
  const long = `${'Lorem ipsum dolor sit amet. '.repeat(6)}The quarterly budget review is on Friday with the whole team. ${'Sed do eiusmod tempor. '.repeat(6)}`;
  const n = note([h1('Budget notes'), 'nothing here', long, 'budget only'], { id: 's' });
  const [r] = searchNotes([n], 'budget review', { now: NOW });
  assert.deepEqual(r.titleRanges, [[0, 6]]);
  const s = r.snippets[0];
  assert.equal(s.blockId, n.blocks[2].id, 'the block with the most distinct hits');
  assert.ok(s.text.startsWith('\u{2026}') && s.text.endsWith('\u{2026}'));
  assert.ok(s.text.length < 160);
  const marked = s.ranges.map(([a, b]) => s.text.slice(a, b).toLowerCase());
  assert.deepEqual(marked, ['budget', 'review']);
  assert.deepEqual(searchNotes([note([h1('Budget')], { id: 't' })], 'budget', { now: NOW })[0].snippets, [], 'no body hit: no snippet (the title has its own ranges)');
  assert.match(snippetText(n, 'friday'), /Friday/);
});

test('highlight: escaped HTML with <mark>, overlapping and bad ranges are safe', () => {
  assert.equal(highlight('<b>x</b> & "y"', [[3, 4], [0, 1], [2, 5], [50, 60], [-5, 0], ['a', 'b']]), '<mark>&lt;</mark>b<mark>&gt;x&lt;</mark>/b&gt; &amp; &quot;y&quot;');
  assert.equal(highlight('<img src=x onerror=alert(1)>', []), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(highlight(null, null), '');
});

test('the index follows note objects (a changed note is re-indexed) and stays fast', () => {
  let n = note([h1('First title')], { id: 'x' });
  assert.equal(searchNotes([n], 'first', { now: NOW }).length, 1);
  n = note([h1('Second title')], { id: 'x' });
  assert.equal(searchNotes([n], 'first', { now: NOW }).length, 0);
  const many = Array.from({ length: 5000 }, (_, i) =>
    note([h1(`Note ${i} about ${i % 7 ? 'gardening' : 'cooking'}`), `Body text ${i} with some words like tomato basil sourdough and #tag${i % 50}`, { t: 'check', ck: i % 2 === 0, c: [['item']] }], { id: `m${i}`, age: i % 90 }),
  );
  indexNotes(many);
  const t0 = performance.now();
  const res = searchNotes(many, 'cooking basil', { now: NOW, limit: 50 });
  const ms = performance.now() - t0;
  assert.equal(res.length, 50);
  assert.ok(res.every((r) => /cooking/.test(r.note.title)));
  assert.ok(ms < 500, `5,000 notes searched in ${ms.toFixed(1)} ms`);
});

test('search functions never throw on values that were never validated; a non-query object searches for nothing', () => {
  const odd = JSON.parse('{"toString":0}');
  const good = validateNote({ id: 'g', blocks: [{ t: 'h1', c: [['Hello world']] }] });
  const calls = {
    parseQuery: () => parseQuery(odd),
    searchNotes: () => searchNotes([good, odd, null, { id: 'x', title: odd, tags: [odd], blocks: odd, editedAt: odd }], odd),
    searchOddNotes: () => searchNotes([odd, { id: 'y', title: odd, tags: [odd, 'a'], blocks: [{ t: 'p', c: [[odd]] }] }], 'hello'),
    highlight: () => highlight(odd, [[0, 1], odd, null]),
    normalize: () => normalize(odd),
    normalizeWithMap: () => normalizeWithMap(odd),
    matchRanges: () => matchRanges(odd, [odd]),
    snippetText: () => snippetText(good, odd),
    indexNotes: () => indexNotes([odd, null, 3]),
  };
  for (const [name, fn] of Object.entries(calls)) assert.doesNotThrow(fn, name);
  assert.deepEqual(searchNotes([good], odd), [], 'an object that is not a parsed query is no query at all');
  assert.deepEqual(searchNotes([good], { terms: 'hello' }), []);
  assert.equal(searchNotes([good], parseQuery('hello')).length, 1, 'a parsed query is used as is');
  assert.equal(highlight(odd, []), '');
  assert.equal(parseQuery(odd).empty, true);
});
