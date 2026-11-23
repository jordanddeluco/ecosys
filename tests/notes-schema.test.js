// notes/core/schema.js: blocks, runs, hrefs (XSS), refs, tags, derived fields, limits, legacy HTML,
// folders, and the validators it registers with shared/sanitize.js. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../notes/core/schema.js';
import { validateItem, validateCollection, validateOp, validateOps, schemaFields } from '../shared/sanitize.js';

const strip = (blocks) => blocks.map(({ id, ...rest }) => rest);

test('validateBlock: canonical shapes per type, unknown fields dropped, unknown types keep their text', () => {
  const [h, chk, num, code, hr, quote, odd] = S.validateBlocks([
    { id: 'h', t: 'h1', fold: true, in: 3, ck: true, c: [['Title']], evil: '<x>' },
    { id: 'c', t: 'check', in: 9, ck: 'yes', task: 'task_1', c: [['oat']] },
    { id: 'n', t: 'num', in: -2, start: 5, c: [['five']] },
    { id: 'k', t: 'code', lang: 'js', c: [['a\tb', 'b'], ['\nc', '', { href: 'https://x.com' }]] },
    { id: 'r', t: 'hr', c: [['ignored']] },
    { id: 'q', t: 'quote', in: 2, c: [['q']] },
    { id: 'o', t: 'table', c: [['kept as body']] },
  ]);
  assert.deepEqual(h, { id: 'h', t: 'h1', fold: true, c: [['Title']] });
  assert.deepEqual(chk, { id: 'c', t: 'check', in: 6, ck: false, task: 'task_1', c: [['oat']] });
  assert.deepEqual(num, { id: 'n', t: 'num', in: 0, start: 5, c: [['five']] });
  assert.deepEqual(code, { id: 'k', t: 'code', lang: 'js', c: [['a\tb\nc']] }, 'code: one run, no marks, tabs kept');
  assert.deepEqual(hr, { id: 'r', t: 'hr' });
  assert.deepEqual(quote, { id: 'q', t: 'quote', c: [['q']] });
  assert.deepEqual(odd, { id: 'o', t: 'p', c: [['kept as body']] });
  assert.equal(S.validateBlock(null), null);
  assert.equal(S.validateBlock([]), null);
  assert.equal(S.validateBlock({ t: 'num', start: 1, c: [] }).start, undefined, 'start 1 is the default');
  assert.equal(S.validateBlock({ t: 'code', lang: 'c#', c: [] }).lang, undefined, 'lang must match [\\w+-]{1,20}');
  assert.equal(S.validateBlock({ t: 'check', c: [] }).task, undefined, 'no task key when unlinked');
});

test('runs: canonical marks, merged neighbours, empty runs dropped, chips never merged', () => {
  const b = S.validateBlock({
    id: 'x',
    t: 'p',
    c: [['a', 'ibb'], ['b', 'bi'], [''], ['c'], 'd', ['chip', 'b', { ref: 'note:n1', atom: true }], ['chip', '', { ref: 'note:n1', atom: 1 }], [5]],
  });
  assert.deepEqual(b.c, [['ab', 'bi'], ['cd'], ['chip', '', { ref: 'note:n1', atom: 1 }], ['chip', '', { ref: 'note:n1', atom: 1 }], ['5']]);
  // attrs: ref wins over href, atom needs a ref, unknown highlight colours are dropped, key order is ref, href, hl, atom
  const [r1, r2, r3] = S.validateRuns([
    ['x', '', { href: 'https://a.example', ref: 'task:t1', hl: 'pink', atom: 1, onclick: 'alert(1)' }],
    ['y', '', { href: 'https://a.example', atom: 1, hl: 'red' }],
    ['z', '', { hl: 'mint' }],
  ]);
  assert.deepEqual(r1, ['x', '', { ref: 'task:t1', hl: 'pink', atom: 1 }]);
  assert.deepEqual(r2, ['y', '', { href: 'https://a.example/' }]);
  assert.deepEqual(r3, ['z', '', { hl: 'mint' }]);
  assert.deepEqual(Object.keys(r1[2]), ['ref', 'hl', 'atom']);
  // an empty chip label falls back to a readable one
  assert.deepEqual(S.validateRuns([['  ', '', { ref: 'day:2026-11-22', atom: 1 }]]), [['2026-11-22', '', { ref: 'day:2026-11-22', atom: 1 }]]);
});

test('text cleaning: C0 controls, line separators, tabs, lone surrogates', () => {
  const b = S.validateBlock({ t: 'p', c: [['a\u0000b\u0007c\r\nd\u{2028}e\u{2029}f\tg\uD800h']] });
  assert.equal(b.c[0][0], 'abc\nd\ne\nf g\u{FFFD}h');
  assert.equal(S.cleanText('x\ty', { code: true }), 'x\ty');
  assert.equal(S.cut('a\u{1F600}', 2), 'a', 'cut never splits a surrogate pair');
});

test('safeHref: WHATWG protocol check — no javascript:, data:, vbscript:, relative or oversized links', () => {
  const bad = [
    'javascript:alert(1)',
    'java\tscript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\u0001javascript:alert(1)',
    'jav&#x61;script:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/x',
    '/relative',
    'ecosys://note/abc',
    'mailto:',
    `https://example.com/${'a'.repeat(2100)}`,
    42,
    null,
  ];
  for (const h of bad) assert.equal(S.safeHref(h), null, String(h).slice(0, 40));
  assert.equal(S.safeHref('https://Example.com'), 'https://example.com/');
  assert.equal(S.safeHref('http://example.com/a?b=1#c'), 'http://example.com/a?b=1#c');
  assert.equal(S.safeHref('mailto:sam@example.com'), 'mailto:sam@example.com');
  assert.equal(S.safeHref('tel:+15551234'), 'tel:+15551234');
  assert.equal(S.safeHref('https://exa\u{202E}mple.com'), 'https://example.com/', 'bidi controls are removed');
  // an href that fails is dropped from the run; the text stays
  assert.deepEqual(S.validateRuns([['click', '', { href: 'javascript:alert(document.cookie)' }]]), [['click']]);
});

test('refs: the grammar is enforced', () => {
  for (const ok of ['note:abc', 'note:abc#b1', 'task:t_1', 'event:e-1', 'event:e1@2026-11-24', 'day:2026-11-22']) assert.ok(S.isRef(ok), ok);
  for (const bad of ['note:', 'note:a b', 'task:t#x', 'event:e@2026-13-01', 'day:2026-02-30', 'day:today', 'url:http://x', 'note:../x', `note:${'a'.repeat(41)}`]) assert.equal(S.isRef(bad), false, bad);
  assert.deepEqual(S.parseRef('note:abc#b1'), { kind: 'note', id: 'abc', blockId: 'b1' });
  assert.equal(S.formatRef(S.parseRef('event:e1@2026-11-24')), 'event:e1@2026-11-24');
});

test('validateBlocks: ids unique (duplicates and bad ids get new ones) and the 5,000-block / 20,000-char limits', () => {
  const blocks = S.validateBlocks([{ id: 'same', t: 'p', c: [] }, { id: 'same', t: 'p', c: [] }, { id: 'bad id!', t: 'p', c: [] }]);
  assert.equal(new Set(blocks.map((b) => b.id)).size, 3);
  assert.equal(blocks[0].id, 'same');
  assert.ok(blocks.every((b) => S.isBlockId(b.id)));
  assert.equal(S.validateBlocks(Array.from({ length: 5200 }, () => ({ t: 'p', c: [] }))).length, 5000);
  const long = S.validateBlock({ t: 'p', c: [['x'.repeat(15000), 'b'], ['y'.repeat(15000)]] });
  assert.equal(S.blockText(long).length, 20000);
});

test('tags: rules from the spec (letters required, trailing / and - dropped, nested, never in code/links/chips)', () => {
  const t = (text) => S.findTags(text).map((x) => x.tag);
  assert.deepEqual(t('#home #Work/Clients- #x/ #1 #2026 #a1 mail#not a&#38; path/#no ##double #ok_tag'), ['home', 'work/clients', 'x', 'a1', 'ok_tag']);
  assert.deepEqual(t('#Café and #日本'), ['café', '日本']);
  assert.equal(S.normalizeTag('#Work/Projects/'), 'work/projects');
  assert.equal(S.normalizeTag('123'), null);
  assert.equal(S.normalizeTag('a'.repeat(80)).length, 64);
  assert.ok(S.tagMatches('work/clients', 'work'));
  assert.ok(!S.tagMatches('workshop', 'work'));
  const { tags } = S.deriveFields({
    blocks: S.validateBlocks([
      { t: 'p', c: [['#one '], ['#two', 'c'], [' '], ['#three', '', { href: 'https://x.com' }], [' '], ['#four', '', { ref: 'note:n', atom: 1 }], [' #Five']] },
      { t: 'code', c: [['#six']] },
      { t: 'p', c: [['#se'], ['ven', 'b']] },
    ]),
  });
  assert.deepEqual(tags, ['one', 'five', 'seven'], 'tags can span marks, but not code, links or chips');
});

test('deriveFields: title, links; noteStats and notePreview', () => {
  const blocks = S.validateBlocks([
    { t: 'hr' },
    { t: 'p', c: [['   ']] },
    { t: 'h1', c: [['  Groceries \n for the   week ']] },
    { t: 'p', c: [['see '], ['Plan', '', { ref: 'note:n2#b3', atom: 1 }], [' and '], ['x', '', { ref: 'event:e1@2026-11-24' }]] },
    { t: 'check', ck: true, task: 'tk1', c: [['buy oat milk']] },
    { t: 'check', c: [['bread']] },
  ]);
  const d = S.deriveFields({ blocks });
  assert.equal(d.title, 'Groceries');
  assert.deepEqual(d.links, ['note:n2#b3', 'event:e1@2026-11-24', 'task:tk1']);
  assert.equal(S.deriveFields({ blocks: S.validateBlocks([{ t: 'p', c: [['x'.repeat(300)]] }]) }).title.length, 120);
  const st = S.noteStats({ blocks });
  assert.deepEqual(st.checks, { open: 1, done: 1 });
  assert.ok(st.words >= 9 && st.chars > 30);
  assert.equal(S.notePreview({ blocks }), 'for the week');
  assert.equal(S.notePreview({ blocks: S.validateBlocks([{ t: 'h1', c: [['Only title']] }]) }), '');
});

test('validateNote: derived fields recomputed, defaults, limits, aiPrev, locked, unknown keys dropped', () => {
  const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"bad": 1}}}');
  const n = S.validateNote(Object.assign(raw, {
    id: 'n1',
    title: 'IGNORED',
    tags: ['fake'],
    links: ['note:fake'],
    blocks: [{ t: 'h1', c: [['Real #tag']] }],
    pinned: 'yes',
    day: '2026-02-30',
    event: { id: 'e1', date: '2026-11-24', extra: 1 },
    aiPrev: { at: 5, by: 'mcp:claude', rev: 3, blocks: [{ t: 'p', c: [['old']] }] },
    editedBy: 'hacker',
    constructorX: 1,
    createdAt: 10,
  }));
  assert.equal({}.polluted, undefined);
  assert.equal({}.bad, undefined);
  assert.equal(n.title, 'Real #tag');
  assert.deepEqual(n.tags, ['tag']);
  assert.deepEqual(n.links, []);
  assert.equal(n.pinned, false, 'true, "true" and 1 are true; anything else is false');
  assert.equal(n.day, null);
  assert.deepEqual(n.event, { id: 'e1', date: '2026-11-24' });
  assert.equal(n.aiPrev.by, 'mcp:claude');
  assert.equal(n.aiPrev.blocks[0].c[0][0], 'old');
  assert.equal(n.editedBy, 'user');
  assert.equal(n.createdAt, 10);
  assert.equal(n.updatedAt, 10);
  assert.equal(n.editedAt, 10);
  assert.equal(n.v, 1);
  assert.equal(n.rev, 0);
  assert.deepEqual(Object.keys(n), ['id', 'v', 'rev', 'blocks', 'title', 'tags', 'links', 'folderId', 'pinned', 'day', 'event', 'aiHidden', 'aiPrev', 'locked', 'editedBy', 'editedAt', 'createdAt', 'updatedAt', 'trashedAt', 'trashedFrom']);
  assert.equal(S.validateNote({ id: '../etc' }), null);
  assert.equal(S.validateNote('x'), null);
  // locked (v1.1): no blocks, stored title/tags kept
  const l = S.validateNote({ id: 'n2', title: 'Secret', tags: ['Private'], locked: { iv: 'abcdefghijkl', ct: 'QUJD' }, blocks: [{ t: 'p', c: [['plain']] }] });
  assert.deepEqual(l.blocks, []);
  assert.equal(l.title, 'Secret');
  assert.deepEqual(l.tags, ['private']);
  assert.equal(S.validateNote({ id: 'n3', locked: { iv: 'short', ct: 'x' } }).locked, null);
  // oversize: blocks capped at 256 KB, the review copy dropped before the record outgrows sync
  const big = Array.from({ length: 30 }, () => ({ t: 'p', c: [['x'.repeat(19000)]] }));
  const b = S.validateNote({ id: 'n4', blocks: big, aiPrev: { at: 1, by: 'mcp:grok', rev: 1, blocks: big } });
  assert.ok(JSON.stringify(b.blocks).length <= S.NOTE_LIMITS.noteBytes);
  assert.equal(b.aiPrev, null);
  // deterministic: validating a validated note changes nothing
  assert.deepEqual(S.validateNote(structuredClone(n)), n);
});

test('legacy stage-1 notes (title + sanitized HTML body) become blocks', () => {
  const n = S.validateNote({
    id: 'old',
    title: 'Welcome to Notes',
    body:
      '<h1>Welcome to Notes</h1><p>Jot <strong>bold</strong> and <em>it</em> <mark>hl</mark> <u>u</u> <s>s</s> <code>c</code></p>' +
      '<ul class="checklist"><li data-checked="true">Open this note</li><li data-checked="false">Make a checklist #todo</li></ul>' +
      '<ol><li>one<ol><li>nested</li></ol></li></ol><blockquote>Quote</blockquote><pre><code>x = 1\ny</code></pre><hr>' +
      '<p><a href="ecosys:task/t1" data-task="t1">Plan the week</a> <a href="https://example.com">site</a> <a href="javascript:alert(1)">bad</a></p>' +
      '<p onclick="alert(1)">x<script>alert(1)</script><img src=x onerror=alert(1)></p>',
  });
  assert.deepEqual(strip(n.blocks), [
    { t: 'h1', c: [['Welcome to Notes']] },
    { t: 'p', c: [['Jot '], ['bold', 'b'], [' and '], ['it', 'i'], [' '], ['hl', '', { hl: 'purple' }], [' '], ['u', 'u'], [' '], ['s', 's'], [' '], ['c', 'c']] },
    { t: 'check', in: 0, ck: true, c: [['Open this note']] },
    { t: 'check', in: 0, ck: false, c: [['Make a checklist #todo']] },
    { t: 'num', in: 0, c: [['one']] },
    { t: 'num', in: 1, c: [['nested']] },
    { t: 'quote', c: [['Quote']] },
    { t: 'code', c: [['x = 1\ny']] },
    { t: 'hr' },
    { t: 'p', c: [['Plan the week', '', { ref: 'task:t1', atom: 1 }], [' '], ['site', '', { href: 'https://example.com/' }], [' bad']] },
    { t: 'p', c: [['x']] },
  ]);
  assert.equal(n.title, 'Welcome to Notes');
  assert.deepEqual(n.tags, ['todo']);
  const t = S.validateNote({ id: 'old2', title: 'Different', body: '<p>body</p>' });
  assert.deepEqual(strip(t.blocks), [{ t: 'h1', c: [['Different']] }, { t: 'p', c: [['body']] }], 'a title that differs from the body is kept as the first line');
});

test('registered with shared/sanitize.js: the store keeps blocks and drops stage-1 extras; tasks keep source', () => {
  assert.ok(['blocks', 'rev', 'aiPrev', 'editedAt', 'day', 'event'].every((k) => schemaFields('notes').includes(k)));
  const n = validateItem('notes', { id: 'n1', blocks: [{ id: 'b1', t: 'p', c: [['hello #x']] }], pinned: 'true', body: '<p onclick="x()">old</p>' });
  assert.deepEqual(n.blocks, [{ id: 'b1', t: 'p', c: [['hello #x']] }]);
  assert.equal(n.title, 'hello #x', 'blocks win over a stage-1 body');
  assert.deepEqual(n.tags, ['x']);
  assert.equal(n.pinned, true, "'true' reads as true, like the stage-1 schema");
  assert.equal(n.body, '<p>old</p>', 'stage-1 fields keep their own validators');
  assert.equal('_done' in n, false);
  assert.deepEqual(validateItem('notes', n), n, 'idempotent');
  // a stage-1 record keeps its sanitized body until it is saved with blocks
  const legacy = validateItem('notes', { id: 'n2', body: '<p onclick=x>hi</p>', tags: ['Kept', 'hi'] });
  assert.equal(legacy.body, '<p>hi</p>');
  assert.equal(legacy.title, 'hi');
  assert.deepEqual(legacy.tags, ['kept', 'hi'], 'stage-1 tags survive as a #tag line');
  assert.equal(S.blockText(legacy.blocks.at(-1)), '#kept #hi');
  assert.deepEqual(validateItem('notes', legacy), legacy, 'idempotent once converted');
  // the per-call cache never leaks between records or mutations
  const raw = { id: 'n3', blocks: [{ id: 'b', t: 'p', c: [['one']] }] };
  assert.equal(validateItem('notes', raw).title, 'one');
  raw.blocks = [{ id: 'b', t: 'p', c: [['two']] }];
  assert.equal(validateItem('notes', raw).title, 'two');
  const { items } = validateCollection('notes', [{ id: 'a', blocks: [{ t: 'p', c: [['A']] }] }, { id: 'b', blocks: [{ t: 'p', c: [['B']] }] }]);
  assert.deepEqual(items.map((x) => x.title), ['A', 'B']);
  const f = validateItem('folders', { id: 'f1', name: ' Work / Clients ', color: 'nope', icon: 'x', sort: 'title', sortDir: 'up', view: 'gallery', aiHidden: 1 });
  assert.deepEqual([f.name, f.color, f.sort, f.sortDir, f.view, f.aiHidden, 'icon' in f], ['Work - Clients', 'iris', 'title', null, 'gallery', false, false]);
  const t = validateItem('tasks', { id: 't1', title: 'x', source: { app: 'notes', noteId: 'n1', blockId: 'b1', evil: 1 } });
  assert.deepEqual(t.source, { app: 'notes', noteId: 'n1', blockId: 'b1' });
  assert.equal(validateItem('tasks', { id: 't2', source: { app: 'mail', noteId: 'n1' } }).source, undefined);
});

test('newNote, newBlock, templates', () => {
  const n = S.newNote({ folderId: 'f1', blocks: [{ t: 'h1', c: [['Hi']] }], now: 1000 });
  assert.equal(n.id, undefined);
  assert.equal(n.rev, 1);
  assert.equal(n.title, 'Hi');
  assert.equal(n.editedAt, 1000);
  assert.deepEqual(S.newNote().blocks.map((b) => b.t), ['h1']);
  assert.equal(S.newBlock('p', 'x', { id: 'fixed' }).id, 'fixed');
  const b = S.newBlock('check', 'milk', { ck: true, in: 2 });
  assert.deepEqual({ ...b, id: 'x' }, { id: 'x', t: 'check', in: 2, ck: true, c: [['milk']] });
  assert.match(S.newBlockId(), /^[a-z0-9]{8}$/);
  assert.match(S.newRecordId(), /^[0-9a-f]{16}$/);
  const daily = S.dailyNoteBlocks('2026-11-22', { locale: 'en-GB' });
  assert.deepEqual(daily.map((x) => x.t), ['h1', 'p']);
  assert.match(S.blockText(daily[0]), /^Sunday,? 22 November 2026$/);
  assert.equal(S.longDate('2026-02-30'), '');
  assert.deepEqual(S.meetingNoteBlocks('Standup').map((x) => [x.t, S.blockText(x)]), [['h1', 'Standup'], ['h3', 'Notes'], ['p', ''], ['h3', 'Action items'], ['check', '']]);
  assert.ok(S.isEmptyBlocks(S.validateBlocks([{ t: 'p', c: [['  ']] }, { t: 'hr' }])));
});

test('tag rewrites keep formatting, casing and spacing', () => {
  const blocks = S.validateBlocks([
    { id: 'a', t: 'p', c: [['buy '], ['#Wo', 'b'], ['rk', 'bi'], [' and #work/Clients today']] },
    { id: 'b', t: 'p', c: [['#work']] },
    { id: 'c', t: 'p', c: [['keep `#work`'], ['#work', 'c']] },
  ]);
  const r = S.renameTagInBlocks(blocks, 'work', 'Job');
  assert.ok(r.changed);
  assert.deepEqual(r.blocks[0].c, [['buy '], ['#Job', 'b'], [' and #Job/Clients today']]);
  assert.deepEqual(r.blocks[2].c, [['keep `#Job`'], ['#work', 'c']], 'inline code is never rewritten');
  assert.equal(S.renameTagInBlocks(blocks, 'work', 'bad tag!').changed, false);
  const rm = S.removeTagFromBlocks(blocks, 'work');
  assert.deepEqual(rm.blocks.map((b) => b.id), ['a', 'c'], 'a block left empty by the removal goes');
  assert.deepEqual(rm.blocks[0].c, [['buy and today']]);
  const ap = S.appendTag(blocks, '#Errand');
  assert.equal(S.blockText(ap.blocks.at(-1)), '#errand');
  assert.equal(S.appendTag(blocks, 'work').changed, false, 'already tagged');
});

test('folders: validation, paths, nesting helpers, AI visibility inheritance, unique names', () => {
  const folders = [
    { id: 'w', name: 'Work', parentId: null, aiHidden: false },
    { id: 'c', name: 'Clients', parentId: 'w', aiHidden: true },
    { id: 'a', name: 'Acme', parentId: 'c' },
    { id: 'loop1', name: 'L1', parentId: 'loop2' },
    { id: 'loop2', name: 'L2', parentId: 'loop1' },
  ];
  assert.equal(S.folderPath('a', folders), 'Work/Clients/Acme');
  assert.equal(S.folderDepth('a', folders), 3);
  assert.equal(S.folderPath(null, folders), '');
  assert.ok(S.folderPath('loop1', folders).length < 20, 'cycles are cut');
  assert.deepEqual([...S.descendantIds('w', folders)].sort(), ['a', 'c', 'w']);
  assert.equal(S.resolveFolderPath('work/clients', folders).id, 'c');
  assert.equal(S.resolveFolderPath('Acme', folders).id, 'a', 'a unique name works without its path');
  assert.equal(S.resolveFolderPath('Nope', folders), null);
  assert.ok(S.folderHiddenFromAi('a', folders), 'inherited from Clients');
  assert.ok(!S.folderHiddenFromAi('w', folders));
  assert.ok(S.noteHiddenFromAi({ folderId: 'a' }, folders));
  assert.ok(S.noteHiddenFromAi({ aiHidden: true }, folders));
  assert.ok(S.noteHiddenFromAi({ locked: { iv: 'x', ct: 'y' } }, folders));
  assert.equal(S.uniqueFolderName('Work', [{ name: 'work' }, { name: 'Work 2' }]), 'Work 3');
  assert.equal(S.validateFolder({ id: 'f', name: '' }).name, 'Untitled folder');
  assert.equal(S.validateFolder({ id: 'f', name: 'x'.repeat(100) }).name.length, 60);
  assert.equal(S.validateFolder({ id: 'f', parentId: 'f' }).parentId, null, 'a folder is not its own parent');
});

test('splitBlock / validateBlocks({split}) and noteOverLimit: long blocks are split, never cut', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ');
  const [b] = S.validateBlocks([{ id: 'long1', t: 'check', ck: true, task: 'tk', in: 2, c: [[text.slice(0, 15000), 'b'], [' Plan ', '', { ref: 'note:n1', atom: 1 }], [text.slice(15000)]] }], { split: true }).slice(0, 1);
  const parts = S.validateBlocks([{ id: 'long1', t: 'check', ck: true, task: 'tk', in: 2, c: [[text.slice(0, 15000), 'b'], [' Plan ', '', { ref: 'note:n1', atom: 1 }], [text.slice(15000)]] }], { split: true });
  assert.equal(b.id, 'long1');
  assert.ok(parts.length >= 2 && parts.every((p) => S.blockText(p).length <= 20000 && p.t === 'check' && p.in === 2 && p.ck === true));
  assert.equal(parts[0].task, 'tk');
  assert.ok(parts.slice(1).every((p) => !p.task));
  assert.equal(new Set(parts.map((p) => p.id)).size, parts.length, 'ids stay unique');
  assert.ok(parts.flatMap((p) => p.c).some((r) => r[2]?.atom && r[0] === ' Plan '), 'a chip is never split');
  assert.equal(S.validateBlocks(parts, { split: true }).length, parts.length, 'idempotent');
  assert.equal(S.blockText(S.validateBlocks([{ t: 'p', c: [['x'.repeat(25000)]] }])[0]).length, 20000, 'without split the old cut still applies');
  assert.equal(S.noteOverLimit([{ id: 'a', t: 'p', c: [['x']] }]), null);
  assert.equal(S.noteOverLimit(Array.from({ length: 5001 }, (_, i) => ({ id: `b${i}`, t: 'hr' }))).reason, 'blocks');
  assert.equal(S.noteOverLimit([{ id: 'a', t: 'p', c: [['x'.repeat(270000)]] }]).reason, 'bytes');
  const n = S.validateNote({ id: 'n', blocks: [{ id: 'q', t: 'p', c: [['y'.repeat(30000)]] }] });
  assert.deepEqual(n.blocks.map((x) => S.blockText(x).length), [20000, 10000], 'validateNote splits too (sync never cuts a long block)');
  // A space inside a chip is not a place to split: the last space outside one is (after chip 1,000).
  const chip = (i) => ['a b c d e f g h i j', '', { ref: `task:t${i % 7}`, atom: 1 }];
  const c = Array.from({ length: 1500 }, (_, i) => (i % 500 === 499 ? [chip(i), [' ']] : [chip(i)])).flat();
  const pieces = S.validateBlocks([{ id: 'ch', t: 'p', c }], { split: true });
  assert.deepEqual(pieces.map((p) => p.c.filter(S.isAtomRun).length), [1000, 500]);
  assert.ok(pieces.every((p) => S.blockText(p).length <= 20000 && p.c.filter(S.isAtomRun).every((r) => r[0] === 'a b c d e f g h i j')), 'every chip whole');
  assert.equal(pieces.map(S.blockText).join(' '), c.map((r) => r[0]).join(''));
});

test('stage-1 notes convert to the same block ids every time', () => {
  const legacy = { id: 'old', title: 'Groceries', body: '<h1>Groceries</h1><ul class="checklist"><li data-checked="false">Milk</li></ul>', tags: ['home'] };
  const a = S.validateNote(legacy).blocks.map((b) => b.id);
  assert.deepEqual(a, ['old-0', 'old-1', 'old-2']);
  assert.deepEqual(S.validateNote({ ...legacy }).blocks.map((b) => b.id), a);
  assert.deepEqual(S.validateNote({ id: 'x'.repeat(40), title: 'Only a title' }).blocks.map((b) => b.id), [`${'x'.repeat(30)}-0`]);
  assert.ok(S.validateNote({ id: 'x'.repeat(40), title: 'T' }).blocks.every((b) => S.isBlockId(b.id)));
});

test('hostile values never throw; tags with combining marks are canonical and idempotent', () => {
  const odd = JSON.parse('{"toString":""}');
  assert.doesNotThrow(() => S.validateBlocks([{ c: [['', '', { href: odd }]] }, { c: [['x', odd, { href: odd, ref: odd, hl: odd }]] }]));
  assert.doesNotThrow(() => S.validateFolder({ id: 'f', name: JSON.parse('{"toString":0}') }));
  assert.equal(S.validateFolder({ id: 'f', name: JSON.parse('{"toString":0}') }).name, 'Untitled folder');
  assert.equal(S.cleanText(odd), '');
  assert.equal(S.normalizeTag(odd), null);
  const v = S.validateNote({ id: 'n1', blocks: [{ id: 'b', t: 'p', c: [['keep me'], ['x', '', { href: odd }]] }] });
  assert.deepEqual(v.blocks[0].c, [['keep mex']], 'one odd run never empties the note');
  for (const t of ['İstanbul', 'Ǆemal', 'cafe\u0301', 'हिंदी']) {
    const n = S.normalizeTag(t);
    assert.ok(n, t);
    assert.equal(S.normalizeTag(n), n, `${t} → ${n} is idempotent`);
  }
  assert.equal(S.normalizeTag('İstanbul'), 'istanbul');
  assert.deepEqual(S.findTags('#हिंदी ok').map((x) => x.tag), ['हिंदी'], 'Devanagari vowel signs belong to the tag');
  const r = S.removeTagFromBlocks([{ id: 'a', t: 'p', c: [['#a/b#a/b and here']] }], 'a');
  assert.deepEqual(S.deriveFields({ blocks: r.blocks }).tags, [], 'removing #a/b from "#a/b#a/b" leaves no #a/b');
  assert.equal(S.safeHref('relative/path'), null);
  assert.equal(S.safeHref('\u0001 java\tscript:alert(1)'), null);
  assert.equal(S.safeHref(' https://ok.example '), 'https://ok.example/');
  // Compared with the URL parser in the same process (not with a clock), so a busy machine can't fail it:
  // refusing measures ~40× faster than parsing (and throwing), and a parser-based check would be ~1×.
  const time = (fn) => Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  }));
  const refuse = time(() => {
    for (let i = 0; i < 20000; i++) S.safeHref(`b${i}`);
  });
  const parse = time(() => {
    for (let i = 0; i < 20000; i++) {
      try {
        new URL(`b${i}`);
      } catch {}
    }
  });
  assert.ok(refuse * 5 < parse, `a relative link is refused without paying for the URL parser (${refuse.toFixed(1)} ms vs ${parse.toFixed(1)} ms)`);
});

test('a note whose validator throws is refused whole: never an empty note that a sync op would store', () => {
  // validateNote meets something it can't read (here a getter that throws, deep in a block). The
  // record must come out null, not as {id, body:'', color:null, order:0}: a put of that would
  // replace the note's real content.
  const boom = () => ({ id: 'n1', title: 'Groceries', blocks: [{ id: 'b1', t: 'h1', c: [['Groceries']] }, { id: 'b2', get t() { throw new Error('boom'); } }] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(validateItem('notes', boom()), null);
    assert.equal(validateOp({ op: 'put', c: 'notes', item: boom() }), null, 'the sync op is dropped, so the stored note stays as it was');
    assert.deepEqual(validateOps([{ op: 'put', c: 'notes', item: boom() }, { op: 'put', c: 'notes', item: { id: 'n2', blocks: [{ t: 'p', c: [['fine']] }] } }]).map((o) => o.item.id), ['n2'], 'only that record');
    assert.deepEqual(validateCollection('notes', [boom(), { id: 'n2' }]).items.map((n) => n.id), ['n2']);
    // The next record validates normally (nothing stale is cached from the failed one).
    const ok = validateItem('notes', { id: 'n1', blocks: [{ id: 'b1', t: 'p', c: [['Back']] }] });
    assert.deepEqual([ok.title, ok.blocks.length], ['Back', 1]);
  } finally {
    console.warn = warn;
  }
});

test('normalizeTag is a fixed point: every BMP character, "İ" with extra dots above, after a letter', () => {
  for (const t of ['İ̇stanbul', 'i̇̇x', 'J̇̇', 'İ', 'ΑΣ', 'ẞig']) {
    const n = S.normalizeTag(t);
    assert.ok(n, t);
    assert.equal(S.normalizeTag(n), n, `${JSON.stringify(t)} → ${JSON.stringify(n)} → ${JSON.stringify(S.normalizeTag(n))}`);
  }
  assert.equal(S.normalizeTag('İ̇stanbul'), 'istanbul', 'every dot above that lowercasing leaves after i goes');
  const bad = [];
  for (let cp = 0; cp <= 0xffff && bad.length < 5; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCharCode(cp);
    for (const s of [`a${c}`, `İ${c}̇`]) {
      const n = S.normalizeTag(s);
      if (n !== null && S.normalizeTag(n) !== n) bad.push(`U+${cp.toString(16)}: ${JSON.stringify(s)} → ${JSON.stringify(n)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('removing a tag: touching tags of any length, punctuation and marks kept, nothing else lost', () => {
  const texts = (r) => r.blocks.map(S.blockText);
  const chain = S.removeTagFromBlocks([S.newBlock('p', `${'#a'.repeat(100)} end`)], 'a');
  assert.deepEqual(texts(chain), ['end'], 'a chain of 100 touching tags (each forms once the one before it is gone)');
  assert.deepEqual(S.deriveFields({ blocks: chain.blocks }).tags, []);
  assert.deepEqual(texts(S.removeTagFromBlocks([S.newBlock('p', '#a/b#a/b and #a here')], 'a')), ['and here']);
  assert.deepEqual(texts(S.removeTagFromBlocks([S.newBlock('p', '#a #a.')], 'a')), ['.'], 'the full stop after the last tag stays');
  assert.deepEqual(texts(S.removeTagFromBlocks([S.newBlock('p', 'x #a #a.')], 'a')), ['x.']);
  assert.deepEqual(texts(S.removeTagFromBlocks([S.newBlock('p', '#a #a, b')], 'a')), [', b']);
  assert.deepEqual(texts(S.removeTagFromBlocks([S.newBlock('p', 'one #a two')], 'a')), ['one two'], 'one space is left between words');
  assert.deepEqual(texts(S.removeTagFromBlocks([S.newBlock('p', '#a#b')], 'a')), ['#b'], 'a tag that only forms afterwards and is not removed stays');
  const marked = S.validateBlocks([{ t: 'p', c: [['see '], ['#a', 'b'], [' and '], ['link', '', { href: 'https://e.example/' }], [' #a.', 'i']] }]);
  assert.deepEqual(S.removeTagFromBlocks(marked, 'a').blocks[0].c, [['see and '], ['link', '', { href: 'https://e.example/' }], ['.', 'i']]);
  const r = S.removeTagFromBlocks([S.newBlock('p', '#a'.repeat(9999))], 'a');
  assert.deepEqual(texts(r), [''], 'a 20,000-character chain goes in one pass');
  // Seeded property: no matching tag is left, removing again changes nothing, and every character that
  // stays was in the text, in order (only tags and the spaces next to them go).
  let seed = 20261122;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pieces = ['#a', '#a/b', '#a-', '#ab', '#b', '#A', '#İ', ' ', ' ', '.', ',', 'x', 'a', '/', '-', '#', '##', '&', '_', '#1', '#a/', '\u{1F642}', '#é', '\n', ')'];
  for (let k = 0; k < 3000; k++) {
    let s = '';
    for (let j = 1 + Math.floor(rnd() * 14); j > 0; j--) s += pieces[Math.floor(rnd() * pieces.length)];
    const blocks = [S.newBlock('p', s)];
    for (const [tag, children] of [['a', true], ['a', false], ['a/b', true]]) {
      const out = S.removeTagFromBlocks(blocks, tag, { children });
      const left = S.deriveFields({ blocks: out.blocks }).tags.filter((t) => t === tag || (children && t.startsWith(`${tag}/`)));
      assert.deepEqual(left, [], `${JSON.stringify(s)} without #${tag}: ${JSON.stringify(texts(out))}`);
      assert.equal(S.removeTagFromBlocks(out.blocks, tag, { children }).changed, false, `${JSON.stringify(s)}: one pass is enough`);
      const was = S.blockText(blocks[0]).replace(/\s/g, '');
      let at = 0;
      for (const ch of texts(out).join('').replace(/\s/g, '')) {
        at = was.indexOf(ch, at);
        assert.ok(at >= 0, `${JSON.stringify(s)} → ${JSON.stringify(texts(out))}: a character that wasn't removed is changed`);
        at++;
      }
    }
  }
});

test('a tag rename that pushes a block past 20,000 characters splits it: no text is cut', () => {
  const blocks = S.validateBlocks([{ id: 'big', t: 'p', c: [[`${'w '.repeat(9990)}#a`]] }]);
  const r = S.renameTagInBlocks(blocks, 'a', 'x'.repeat(60));
  assert.ok(r.changed);
  assert.deepEqual(r.blocks.map((b) => S.blockText(b).length), [19979, 61]);
  assert.equal(r.blocks.map(S.blockText).join(' '), `${'w '.repeat(9990)}#${'x'.repeat(60)}`);
  assert.equal(r.blocks[0].id, 'big');
});

test('a piece split off a long block never takes another block\'s id: links to x-1 keep pointing at the same text', () => {
  // Long text is stored split (x, x-1, …) and x is cut at the last space before 20,000, so it is
  // usually a few characters short of the limit: a longer tag name splits it again. That piece used
  // to be named x-1 as well, and on save the stored x-1 (the rest of the paragraph) got a random id,
  // so note:<id>#x-1 links and a task's source block pointed at the few-character piece.
  const text = `${'word '.repeat(3995)}#a ${'more '.repeat(2000)}`;
  const note = S.validateNote({ id: 'n1', blocks: [{ id: 'big', t: 'p', c: [[text]] }] });
  assert.deepEqual(note.blocks.map((b) => b.id), ['big', 'big-1']);
  const tail = S.blockText(note.blocks[1]);
  const r = S.renameTagInBlocks(note.blocks, 'a', 'project-alpha');
  assert.ok(r.changed);
  const ids = r.blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, `ids stay unique: ${ids}`);
  assert.equal(ids[0], 'big');
  assert.equal(S.blockText(r.blocks.find((b) => b.id === 'big-1')), tail, 'big-1 keeps its text');
  assert.ok(r.blocks.length === 3 && r.blocks.every((b) => S.blockText(b).length <= 20000));
  assert.equal(r.blocks.map(S.blockText).join(' '), text.replace('#a ', '#project-alpha '), 'no text lost or moved');
  const saved = S.validateNote({ ...note, blocks: r.blocks });
  assert.deepEqual(saved.blocks.map((b) => b.id), ids, 'saving keeps every id');
  assert.equal(S.blockText(saved.blocks.find((b) => b.id === 'big-1')), tail);

  // The same when a long block arrives whole (an assistant replaces a split code block, an import):
  // its new pieces get new ids, and the block that already is x-1 keeps its id and text.
  const code = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  for (const out of [
    S.validateBlocks([{ id: 'x', t: 'code', c: [[code]] }, { id: 'x-1', t: 'code', c: [['old tail']] }], { split: true }),
    S.validateNote({ id: 'n2', blocks: [{ id: 'x', t: 'code', c: [[code]] }, { id: 'x-1', t: 'code', c: [['old tail']] }] }).blocks,
  ]) {
    assert.equal(out[0].id, 'x');
    assert.equal(S.blockText(out.find((b) => b.id === 'x-1')), 'old tail');
    assert.equal(out.at(-1).id, 'x-1', 'x-1 stays where it was');
    assert.equal(out.map(S.blockText).join('\n'), `${code}\nold tail`);
    assert.equal(new Set(out.map((b) => b.id)).size, out.length);
  }
  assert.deepEqual(S.validateBlocks([{ id: 'x', t: 'code', c: [[code]] }], { split: true }).map((b) => b.id), ['x', 'x-1'], 'without a clash the pieces are still named after the block');
});

test('a chip label longer than a block is cut to fit: no block is ever over 20,000 characters', () => {
  // A chip is never split, so a 20,010-character label (e.g. "[…](ecosys://task/a)" in an assistant's
  // Markdown) used to leave a block over the limit, plus an empty block after it.
  const n = S.validateNote({ id: 'a', blocks: [{ c: [['ab'.repeat(10005), '', { atom: 1, ref: 'task:a' }]] }] });
  assert.ok(n.blocks.every((b) => S.blockText(b).length <= 20000), JSON.stringify(n.blocks.map((b) => S.blockText(b).length)));
  assert.equal(n.blocks.length, 1);
  assert.deepEqual(n.blocks[0].c, [['ab'.repeat(10000), '', { ref: 'task:a', atom: 1 }]]);
  assert.deepEqual(S.validateNote(n), n, 'idempotent');
  // With text around it, the chip gets a block of its own.
  const m = S.validateNote({ id: 'b', blocks: [{ c: [['x '.repeat(100)], ['y'.repeat(25000), '', { atom: 1, ref: 'note:z' }], [' tail']] }] });
  assert.ok(m.blocks.every((b) => S.blockText(b).length <= 20000), JSON.stringify(m.blocks.map((b) => S.blockText(b).length)));
  assert.ok(m.blocks.some((b) => b.c.length === 1 && b.c[0][2]?.atom === 1 && b.c[0][0] === 'y'.repeat(20000)));
  assert.equal(S.blockText(m.blocks.at(-1)), 'tail');
  // Never half a surrogate pair; a label that is only spaces up to the cut gets the default label.
  const [[emoji]] = S.validateRuns([[`a${'\u{1F600}'.repeat(10000)}`, '', { atom: 1, ref: 'task:a' }]], { max: Infinity });
  assert.equal(emoji, `a${'\u{1F600}'.repeat(9999)}`);
  assert.deepEqual(S.validateRuns([[`${' '.repeat(20000)}x`, '', { atom: 1, ref: 'task:a' }]], { max: Infinity }), [['Task', '', { ref: 'task:a', atom: 1 }]]);
});

test('helpers never throw on blocks, runs, folders and values that were never validated', () => {
  const odd = JSON.parse('{"toString":0}');
  const rawBlocks = [{ id: odd, t: 'p', c: [[odd, odd, odd], null, 'str', 5, { 0: 'x' }] }, { t: 'check', c: {} }, null, 7];
  const calls = {
    runsText: () => S.runsText([[odd], [odd, odd]]),
    blockText: () => S.blockText({ t: 'p', c: [[odd]] }),
    tagSegments: () => S.tagSegments({ t: 'p', c: [['#x', odd], null, [odd]] }),
    deriveFields: () => S.deriveFields({ blocks: rawBlocks }),
    noteStats: () => S.noteStats({ blocks: rawBlocks }),
    notePreview: () => S.notePreview({ blocks: rawBlocks }),
    isEmptyBlocks: () => S.isEmptyBlocks(rawBlocks),
    newBlock: () => S.newBlock('p', odd),
    splitBlock: () => S.splitBlock({ id: odd, t: 'p', c: [['x'.repeat(20001)]] }),
    renameTagInBlocks: () => S.renameTagInBlocks(rawBlocks, 'a', odd),
    removeTagFromBlocks: () => S.removeTagFromBlocks([{ id: 'x', t: 'p', c: [['#a', odd], [odd]] }, { t: 'p', c: [['no id #a']] }, ...rawBlocks], 'a'),
    rewriteTags: () => S.rewriteTags([{ t: 'p', c: [['#a #b']] }], () => odd),
    appendTag: () => S.appendTag(odd, 'x'),
    folderPath: () => S.folderPath('f', [{ id: 'f', name: odd }, null, 3]),
    resolveFolderPath: () => S.resolveFolderPath(odd, [{ id: 'f', name: odd }, null]),
    descendantIds: () => S.descendantIds('f', [null, { id: 'g', parentId: 'f' }]),
    uniqueFolderName: () => S.uniqueFolderName(odd, new Map([['f', { name: odd }]])),
    folderHiddenFromAi: () => S.folderHiddenFromAi('f', [null, { id: 'f', aiHidden: true }]),
    validateNote: () => S.validateNote({ id: 'n', title: odd, tags: [odd, 'ok'], body: odd, blocks: odd, event: { id: odd, date: odd } }),
    legacyNote: () => S.validateNote({ id: 'n', title: odd, tags: [odd, 'ok'], body: '<p>hi</p>' }),
  };
  for (const [name, fn] of Object.entries(calls)) assert.doesNotThrow(fn, name);
  assert.equal(S.runsText([[odd], ['a'], [3]]), 'a3');
  assert.equal(S.folderPath('f', [{ id: 'f', name: odd }]), '');
  assert.deepEqual(S.validateNote({ id: 'n', title: 'T', tags: [odd, 'ok'], body: '<p>hi</p>' }).tags, ['ok']);
  assert.equal(S.splitBlock({ id: odd, t: 'p', c: [['x'.repeat(20001)]] }).every((b) => S.isBlockId(b.id)), true, 'a bad id is replaced, not printed');
});
