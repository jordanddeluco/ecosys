// notes/core/markdown.js: the Markdown mapping both ways, escaping, external Markdown, links and
// safety, front matter, and round trips (seeded fuzz). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToMarkdown, markdownToBlocks, inlineMarkdown, noteToMarkdown, parseFrontMatter, slugify, avoidDeviceName, looksLikeMarkdown, refUrl, urlRef } from '../notes/core/markdown.js';
import { validateBlocks, validateBlock, validateNote, blockText, splitBlock } from '../notes/core/schema.js';

const strip = (blocks) => blocks.map(({ id, ...rest }) => rest);
const md2b = (md, opts) => strip(markdownToBlocks(md, opts));
const roundTrip = (blocks, opts) => strip(markdownToBlocks(blocksToMarkdown(validateBlocks(blocks), opts), opts));

test('blocks → Markdown: every block type and mark', () => {
  const md = blocksToMarkdown(
    validateBlocks([
      { t: 'h1', c: [['Title']] },
      { t: 'h2', c: [['Heading']] },
      { t: 'h3', c: [['Sub']] },
      { t: 'p', c: [['plain '], ['b', 'b'], [' '], ['i', 'i'], [' '], ['u', 'u'], [' '], ['s', 's'], [' '], ['c', 'c'], [' '], ['hl', '', { hl: 'pink' }], [' '], ['link', '', { href: 'https://example.com/a' }]] },
      { t: 'bullet', in: 0, c: [['star']] },
      { t: 'dash', in: 1, c: [['dash']] },
      { t: 'num', in: 0, c: [['one']], start: 3 },
      { t: 'num', in: 0, c: [['two']] },
      { t: 'check', in: 0, ck: false, c: [['todo']] },
      { t: 'check', in: 0, ck: true, task: 'tk1', c: [['done']] },
      { t: 'quote', c: [['quoted\nsoft']] },
      { t: 'code', lang: 'js', c: [['let a = 1;']] },
      { t: 'hr' },
      { t: 'p', c: [['line one\nline two']] },
    ]),
  );
  assert.equal(
    md,
    [
      '# Title',
      '',
      '## Heading',
      '',
      '### Sub',
      '',
      'plain **b** *i* <u>u</u> ~~s~~ `c` ==hl== [link](https://example.com/a)',
      '',
      '* star',
      '    - dash',
      '3. one',
      '4. two',
      '- [ ] todo',
      '- [x] done [task](ecosys://task/tk1)',
      '',
      '> quoted\\',
      '> soft',
      '',
      '```js',
      'let a = 1;',
      '```',
      '',
      '---',
      '',
      'line one\\',
      'line two',
      '',
    ].join('\n'),
  );
});

test('Markdown → blocks: the same table back', () => {
  assert.deepEqual(md2b('# T\n## H\n### S\n#### deeper\n\n* a\n+ plus\n- d\n1. n\n- [ ] c\n- [X] k\n> q\n\n---\n\n```py extra\nx\n```'), [
    { t: 'h1', c: [['T']] },
    { t: 'h2', c: [['H']] },
    { t: 'h3', c: [['S']] },
    { t: 'h3', c: [['deeper']] },
    { t: 'bullet', in: 0, c: [['a']] },
    { t: 'bullet', in: 0, c: [['plus']] },
    { t: 'dash', in: 0, c: [['d']] },
    { t: 'num', in: 0, c: [['n']] },
    { t: 'check', in: 0, ck: false, c: [['c']] },
    { t: 'check', in: 0, ck: true, c: [['k']] },
    { t: 'quote', c: [['q']] },
    { t: 'hr' },
    { t: 'code', lang: 'py', c: [['x']] },
  ]);
});

test('escaping: literal markup characters survive as text', () => {
  const tricky = [
    '* not a list', '- not a dash', '+ plus', '1. not numbered', '12) nope', '# not a heading', '> not a quote', '---', '***', '===',
    '**not bold** _not italic_ ~~nor~~ ==this== `nor` <u>this</u>', '[not](a link) ![no](image)', '[[Not a wiki link]] stays', 'AT&amp;T \\ backslash',
    '| a | b |', ':--|--', 'C# and 50%', '#tag at start stays a tag', '[ ] not a checkbox', 'x = y == z',
  ];
  for (const text of tricky) {
    const back = roundTrip([{ t: 'p', c: [[text]] }]);
    assert.deepEqual(back, [{ t: 'p', c: [[text]] }], text);
  }
  assert.equal(inlineMarkdown([['#tag at start']]), '#tag at start', '#tag is not escaped (Obsidian tags)');
  assert.equal(inlineMarkdown([['# heading-like']]), '\\# heading-like');
  assert.equal(inlineMarkdown([['[[Wiki]] text']]), '[[Wiki]] text', 'an unresolved [[Title]] stays a wiki link');
  // inside every block type, and after soft breaks
  for (const t of ['h2', 'bullet', 'check', 'quote', 'num']) {
    const b = { t, in: 0, c: [['- x\n> y\n1. z']] };
    if (t === 'h2') b.c = [['- x #']];
    assert.deepEqual(roundTrip([b]), strip(validateBlocks([b])), t);
  }
});

test('round trips: marks, nesting, soft breaks, numbering, empty lines, links and chips', () => {
  const doc = [
    { t: 'h1', c: [['Groceries']] },
    { t: 'p', c: [] },
    { t: 'p', c: [] },
    { t: 'p', c: [['Some '], ['bold', 'b'], [' and '], ['nested ', 'b'], ['both', 'bi'], [', '], ['code', 'c'], ['.']] },
    { t: 'check', in: 0, ck: false, c: [['oat milk']] },
    { t: 'check', in: 2, ck: true, c: [['barista', 'b']] },
    { t: 'num', in: 0, start: 7, c: [['seven']] },
    { t: 'num', in: 0, c: [['eight']] },
    { t: 'num', in: 1, c: [['nested one']] },
    { t: 'bullet', in: 0, c: [['line\nbreak '], ['bold\nbreak', 'b']] },
    { t: 'quote', c: [['a']] },
    { t: 'quote', c: [['b']] },
    { t: 'p', c: [['see '], ['Plan', '', { ref: 'note:n1', atom: 1 }], [' / '], ['words', 'i', { ref: 'note:n2' }], [' '], ['Fri', '', { ref: 'day:2026-11-27', atom: 1 }], [' '], ['Standup', '', { ref: 'event:e1@2026-11-24', atom: 1 }], [' '], ['site', 'b', { href: 'https://example.com/x_(y)?q=1' }]] },
    { t: 'code', c: [['```\nfenced inside\n````']] },
    { t: 'h3', c: [['Ends with #']] },
  ];
  const opts = { noteTitle: (id) => (id === 'n1' ? 'Plan' : id === 'n2' ? 'Other title' : null) };
  assert.deepEqual(roundTrip(doc, opts), strip(validateBlocks(doc)));
});

test('highlight colours and whitespace at mark edges are the only things Markdown normalizes', () => {
  assert.deepEqual(roundTrip([{ t: 'p', c: [['a '], ['hl', '', { hl: 'blue' }]] }]), [{ t: 'p', c: [['a '], ['hl', '', { hl: 'purple' }]] }]);
  assert.deepEqual(markdownToBlocks('==x==', { hl: 'mint' })[0].c, [['x', '', { hl: 'mint' }]]);
  assert.deepEqual(roundTrip([{ t: 'p', c: [['a'], [' bold ', 'b'], ['c']] }]), [{ t: 'p', c: [['a '], ['bold', 'b'], [' c']] }]);
});

test('external Markdown: setext, lazy lines, hard breaks, tables, 2-space/tab nesting, fences', () => {
  assert.deepEqual(md2b('Title\n=====\n\nSub\n---\n\npara one\ncontinues  \nhard\\\nharder'), [
    { t: 'h1', c: [['Title']] },
    { t: 'h2', c: [['Sub']] },
    { t: 'p', c: [['para one continues\nhard\nharder']] },
  ]);
  assert.deepEqual(md2b('| a | b |\n|---|:-:|\n| 1 | 2 \\| 3 |'), [{ t: 'p', c: [['a | b']] }, { t: 'p', c: [['1 | 2 | 3']] }]);
  assert.deepEqual(
    md2b('- a\n  - b\n    - c\n  - b2\n- d').map((b) => [b.c[0][0], b.in]),
    [['a', 0], ['b', 1], ['c', 2], ['b2', 1], ['d', 0]],
  );
  assert.deepEqual(md2b('* a\n\t* b\n\t\t* c\n\t* b2').map((b) => b.in), [0, 1, 2, 1], 'a tab is one level');
  assert.deepEqual(md2b('* a\n        * jump').map((b) => b.in), [0, 2], '4 spaces per level, levels can be skipped');
  assert.deepEqual(md2b('1. one\n1. two\n1. three').map((b) => b.start ?? 1), [1, 1, 1], 'numbers after the first are ignored');
  assert.deepEqual(md2b('~~~\nraw <b>\n~~~\n\n```\nunclosed'), [{ t: 'code', c: [['raw <b>']] }, { t: 'code', c: [['unclosed']] }]);
  assert.deepEqual(md2b('> a\nlazy\n>\n> > nested'), [{ t: 'quote', c: [['a lazy']] }, { t: 'quote', c: [['nested']] }]);
  assert.deepEqual(md2b('[ ] lenient\n[x] done'), [{ t: 'check', in: 0, ck: false, c: [['lenient']] }, { t: 'check', in: 0, ck: true, c: [['done']] }]);
  assert.deepEqual(md2b('text\n\n\n\nmore'), [{ t: 'p', c: [['text']] }, { t: 'p', c: [] }, { t: 'p', c: [] }, { t: 'p', c: [['more']] }]);
  assert.deepEqual(md2b('\r\n\r\n  # Indented heading  ##  \r\n'), [{ t: 'h1', c: [['Indented heading']] }]);
});

test('never HTML, never unsafe links: tags stay text, javascript:/data: links keep only their text', () => {
  const b = md2b('<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:x">a</a>\n\n[click](javascript:alert(1)) [d](data:text/html,x) [v](  vbscript:x ) [ok](https://ok.example) <https://auto.example> ![img](https://img.example/i.png) [rel](/relative)');
  assert.deepEqual(b, [
    { t: 'p', c: [['<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:x">a</a>']] },
    { t: 'p', c: [['click d v '], ['ok', '', { href: 'https://ok.example/' }], [' <https://auto.example> '], ['img', '', { href: 'https://img.example/i.png' }], [' rel']] },
  ]);
  const md = blocksToMarkdown(validateBlocks(b));
  assert.ok(!/(^|[^\\])<(script|img|a )/.test(md), 'HTML is escaped on the way out');
  assert.match(md, /\\<script>/);
});

test('task links, wiki links, ecosys:// refs and chips', () => {
  const [item] = markdownToBlocks('- [ ] Buy milk [task](ecosys://task/t_9)');
  assert.equal(item.task, 't_9');
  assert.deepEqual(item.c, [['Buy milk']]);
  assert.equal(markdownToBlocks('- [ ] mid [task](ecosys://task/t1) text')[0].task, undefined, 'only a trailing [task] link links the item');
  const notes = { abc: 'Project plan' };
  const opts = { noteTitle: (id) => notes[id] ?? null, resolveNote: (t) => (t.toLowerCase() === 'project plan' ? { id: 'abc', title: 'Project plan' } : null) };
  assert.deepEqual(md2b('[[project plan]] [[Missing]] [[Project plan|the plan]] [[2026-11-22]] [Project plan](ecosys://note/abc) [my words](ecosys://note/abc) [x](ecosys:note/abc#blk1) [Day](ecosys://day/2026-11-22) [E](ecosys://event/e1@2026-11-24) [bad](ecosys://note/../x)', opts)[0].c, [
    ['Project plan', '', { ref: 'note:abc', atom: 1 }],
    [' [[Missing]] '],
    ['the plan', '', { ref: 'note:abc' }],
    [' '],
    ['2026-11-22', '', { ref: 'day:2026-11-22', atom: 1 }],
    [' '],
    ['Project plan', '', { ref: 'note:abc', atom: 1 }],
    [' '],
    ['my words', '', { ref: 'note:abc' }],
    [' '],
    ['x', '', { ref: 'note:abc#blk1' }],
    [' '],
    ['Day', '', { ref: 'day:2026-11-22', atom: 1 }],
    [' '],
    ['E', '', { ref: 'event:e1@2026-11-24', atom: 1 }],
    [' bad'],
  ]);
  // export (wiki) style: note and day chips become [[…]], with fresh titles
  const blocks = validateBlocks([{ t: 'p', c: [['Old label', '', { ref: 'note:abc', atom: 1 }], [' '], ['Sun 22', '', { ref: 'day:2026-11-22', atom: 1 }], [' '], ['T', '', { ref: 'task:t1', atom: 1 }]] }]);
  assert.equal(blocksToMarkdown(blocks, { wiki: true, noteTitle: (id) => notes[id] }), '[[Project plan]] [[2026-11-22]] [T](ecosys://task/t1)\n');
  assert.equal(refUrl('event:e1@2026-11-24'), 'ecosys://event/e1@2026-11-24');
  assert.equal(urlRef('ecosys://note/abc#b1'), 'note:abc#b1');
  assert.equal(urlRef('ecosys://task/a b'), null);
});

test('noteToMarkdown with front matter; parseFrontMatter; slugify; looksLikeMarkdown', () => {
  const note = validateNote({ id: 'n', blocks: [{ t: 'h1', c: [['Say "hi"']] }, { t: 'p', c: [['#home #work/x']] }], pinned: true, day: '2026-11-22', createdAt: Date.UTC(2026, 10, 1), editedAt: Date.UTC(2026, 10, 2) });
  const md = noteToMarkdown(note, { frontMatter: true, folderPath: 'Work/Clients' });
  assert.equal(md, '---\ntitle: "Say \\"hi\\""\ncreated: 2026-11-01T00:00:00.000Z\nupdated: 2026-11-02T00:00:00.000Z\ntags: [home, work/x]\nfolder: "Work/Clients"\npinned: true\nday: 2026-11-22\n---\n\n# Say "hi"\n\n#home #work/x\n');
  const fm = parseFrontMatter(md);
  assert.equal(fm.data.title, 'Say "hi"');
  assert.deepEqual(fm.data.tags, ['home', 'work/x']);
  assert.equal(fm.data.folder, 'Work/Clients');
  assert.ok(fm.body.startsWith('\n# Say'));
  assert.deepEqual(parseFrontMatter('---\nnot: yaml: [x\n---\nbody').data.not, 'yaml: [x');
  assert.equal(parseFrontMatter('---\n\n# heading, not front matter\n---\n').body, '---\n\n# heading, not front matter\n---\n');
  assert.equal(Object.getPrototypeOf(parseFrontMatter('---\n__proto__: x\n---\n').data), null);
  assert.deepEqual(md2b('---\ntitle: x\n---\nBody', { frontMatter: true }), [{ t: 'p', c: [['Body']] }]);
  assert.equal(slugify(' Q3: plan / "draft"? '), 'Q3 plan draft');
  assert.equal(slugify('...'), 'Untitled');
  assert.equal(slugify('CON'), 'CON_');
  assert.ok(looksLikeMarkdown('# Title\ntext'));
  assert.ok(looksLikeMarkdown('some **bold** text'));
  assert.ok(looksLikeMarkdown('- [ ] item'));
  assert.ok(!looksLikeMarkdown('just a sentence. And another one.'));
});

// ---------------------------------------------------------------- fuzz (seeded, deterministic)

function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

test('fuzz: realistic notes round-trip exactly', () => {
  const rnd = prng(20261122);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const WORDS = ['milk', 'Oat', 'call Sam', 'v2.0', 'e.g.', 'naïve café', '\u{1F600} party', 'C#', 'snake_case', 'a*b', 'x = y', '50%', '#home', '#work/clients', 'it’s', '“quoted”', '(see below)', 'TODO:', 'Q&A', '<tag>', 'a~b', '[draft]'];
  const MARKS = ['', '', '', 'b', 'i', 'bi', 'u', 's', 'c', 'bu', 'is'];
  const TYPES = ['p', 'p', 'h1', 'h2', 'h3', 'bullet', 'dash', 'num', 'check', 'quote'];
  const SEP = [' ', ' ', ', ', '. ', ': ', ' - ', ' (', ') ', '\n'];
  for (let n = 0; n < 400; n++) {
    const blocks = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
      const t = pick(TYPES);
      const c = [];
      const k = 1 + Math.floor(rnd() * 5);
      for (let j = 0; j < k; j++) {
        const r = rnd();
        const text = pick(WORDS);
        const marks = pick(MARKS);
        if (r < 0.08) c.push([text, marks.replace('c', ''), { href: 'https://example.com/x?y=1' }]);
        else if (r < 0.14) c.push([text, '', { ref: 'task:t1', atom: 1 }]);
        else if (r < 0.2) c.push([text, marks, { hl: 'purple' }]);
        else c.push([text, marks]);
        if (j < k - 1) c.push([t.startsWith('h') ? ' ' : pick(SEP)]);
      }
      return { t, in: Math.floor(rnd() * 3), ck: rnd() < 0.5, c };
    });
    const want = strip(validateBlocks(blocks));
    assert.deepEqual(roundTrip(blocks), want, blocksToMarkdown(validateBlocks(blocks)));
  }
});

test('fuzz: any mix of marks reads back as the same text and is stable after one pass', () => {
  const rnd = prng(7);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const WORDS = ['alpha', 'x', 'Hello', '42', 'end.', '(p)', '#tag', '*', '_', '==', '~', '`t`', 'C#', '1.', ':', '\u{1F600}', '[b]', '-', '&amp;'];
  const MARKS = ['', 'b', 'i', 'bi', 'u', 's', 'c', 'bs', 'iu', 'bc', 'is'];
  for (let n = 0; n < 1500; n++) {
    const runs = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => {
      const t = pick(WORDS) + (rnd() < 0.4 ? pick([' ', '', ', ']) + pick(WORDS) : '');
      const r = rnd();
      return r < 0.1 ? [t, pick(MARKS), { hl: 'pink' }] : r < 0.15 ? [t, '', { ref: 'note:n1', atom: 1 }] : r < 0.2 ? [t, pick(MARKS).replace('c', ''), { href: 'https://e.com/' }] : [t, pick(MARKS)];
    });
    const doc = validateBlocks([{ t: pick(['p', 'h2', 'bullet', 'quote', 'check']), in: 0, c: runs }]);
    const md1 = blocksToMarkdown(doc);
    const back = markdownToBlocks(md1);
    const md2 = blocksToMarkdown(back);
    assert.equal(blocksToMarkdown(markdownToBlocks(md2)), md2, `stable: ${md1}`);
    assert.equal(blockText(back[0]).replace(/\s+/g, ''), blockText(doc[0]).replace(/\s+/g, ''), `same text: ${md1}`);
  }
});

test('big input is bounded and fast', () => {
  const md = `${'- [ ] item with **bold** and a [link](https://example.com)\n'.repeat(6000)}`;
  const t0 = Date.now();
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 5000, 'at most 5,000 blocks');
  assert.ok(Date.now() - t0 < 4000);
  assert.ok(blocksToMarkdown(blocks).length > 100000);
  const huge = markdownToBlocks('x'.repeat(3 * 1024 * 1024));
  assert.equal(huge.length, Math.ceil((2 * 1024 * 1024) / 20000), '2 MB input cap; a long paragraph is split into blocks of ≤ 20,000 chars, not cut');
  assert.equal(huge.map(blockText).join('').length, 2 * 1024 * 1024);
  assert.equal(markdownToBlocks(md, { max: Infinity }).length, 6000, 'max: Infinity lets a caller see that it would not fit');
});

// An MCP call parses while it holds the server's data lock, and a pasted file must not freeze a tab:
// the inline parser and the serializer must stay linear on hostile input.
//
// Measured as growth, not against a clock: one input of n characters is timed against 16 inputs of
// n/16 (the same total work), so the ratio is about 1 for linear code and up to 16 for quadratic
// code, whatever the machine and its load. Each measurement repeats until it spans ~20 ms (a fast
// case is not lost in timer noise); a ratio that looks high is measured again (best of up to 4
// rounds, so a GC pause or a busy CPU in one round doesn't count), and a case gets up to 3 tries,
// because a burst of load can spoil one try but a quadratic fails every one. A known-quadratic
// function must fail the same check, so it can't pass vacuously.
//
// The size is the real one, 200 KB (an MCP call's limit): the share of a quadratic grows with the
// input, so a small input would hide one whose steps are cheap. Measured on this code: linear cases
// 0.4–2.3 (also with 4 other test processes busy); a scan to the end of the text for every "[" added
// to the real parser 5.5 on a quiet machine (3.2–3.9 under that load); a pure quadratic 7–16.
//
// A failure comes quickly: once one large run takes seconds (GROWTH_SLOW_MS; a linear 200 KB parse
// takes 10–500 ms here, even on a busy machine), more rounds and tries would only repeat that cost
// (a strong quadratic takes 17–70 s per run: 3 tries × 4 rounds of it took over 6 minutes to fail),
// so the measurement stops there. The pass mark stays the ratio: a slow machine that is still
// linear passes.
const GROWTH_SPLIT = 16;
const GROWTH_LIMIT = 4;
const GROWTH_TRIES = 3;
const GROWTH_SLOW_MS = 3000;
function growthRatio(make, run, n) {
  const small = make(Math.floor(n / GROWTH_SPLIT));
  const large = make(n);
  const time = (fn, reps) => {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    return performance.now() - t0;
  };
  // Warm up (compile) first: a slow first call would make the small inputs look slower. The second
  // small run sets how many times each measurement repeats.
  const one = Math.max(time(() => run(small), 1), time(() => run(small), 1), 0.001);
  const reps = Math.min(500, Math.max(1, Math.ceil(20 / (one * GROWTH_SPLIT))));
  let tSmall = Infinity;
  let tLarge = Infinity;
  for (let round = 0; round < 4; round++) {
    tSmall = Math.min(tSmall, time(() => { for (let i = 0; i < GROWTH_SPLIT; i++) run(small); }, reps));
    tLarge = Math.min(tLarge, time(() => run(large), reps));
    if (tLarge / tSmall < GROWTH_LIMIT || tLarge / reps > GROWTH_SLOW_MS) break;
  }
  return { ratio: tLarge / tSmall, ms: tLarge / reps };
}

test('pathological Markdown parses and serializes in linear time (16× the input costs ~16× the time, not ~256×)', () => {
  const K = 200 * 1024;
  const fill = (unit) => (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const check = (what, make, run, n) => {
    let best = null;
    let tries = 0;
    while (tries < GROWTH_TRIES && !(best?.ratio < GROWTH_LIMIT)) {
      const r = growthRatio(make, run, n);
      tries++;
      if (!best || r.ratio < best.ratio) best = r;
      if (r.ms > GROWTH_SLOW_MS) break; // seconds per run: another try would cost as much again
    }
    assert.ok(best.ratio < GROWTH_LIMIT, `${what}: ${GROWTH_SPLIT}× the input took ${best.ratio.toFixed(1)}× as long (${best.ms.toFixed(1)} ms for ${n} characters, best of ${tries} ${tries === 1 ? 'try' : 'tries'}): it grows faster than linear`);
  };
  // The check itself sees a quadratic (the old tryWiki: a scan to the end of the text for every "[").
  const quadratic = (s) => {
    let x = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === '[') x += s.indexOf(']]', i + 2);
    return x;
  };
  let seen = 0;
  for (let k = 0; k < GROWTH_TRIES && seen < GROWTH_LIMIT; k++) seen = Math.max(seen, growthRatio(fill('[[x'), quadratic, 32 * 1024).ratio);
  assert.ok(seen >= GROWTH_LIMIT, `the growth check detects a quadratic (ratio ${seen.toFixed(1)})`);
  const cases = {
    'open brackets': fill('['),
    'unclosed wiki links': fill('[[x'),
    'unclosed emphasis': fill('*a'),
    'brackets before one close': (n) => `${'['.repeat(n - 1)}]`,
    'link-ish': fill('[a]('),
    'brackets and backticks': fill('[`'),
    'unclosed titles': fill('[a](b ('),
    'links among open brackets': fill('[ [a](b) '),
    'backticks in destinations': fill('[a](`) [ '),
    'nested emphasis': (n) => `${'*_'.repeat(Math.floor(n / 4))}a${'_*'.repeat(Math.floor(n / 4))}`,
    'many soft breaks': fill('abc def\n'),
    'quote lines': fill('> a\n'),
    'heading with a long space run': (n) => `# a${' '.repeat(n)}b`,
    'growing backtick runs': (n) => {
      let s = '';
      for (let k = 1; s.length < n; k++) s += `${'`'.repeat(k)}x`;
      return s.slice(0, n);
    },
    'chips side by side, with spaces in their labels': fill('[a b c d e f g h i j](ecosys://task/x)'),
  };
  for (const [name, make] of Object.entries(cases)) check(`parsing ${name}`, make, (md) => markdownToBlocks(md), K);
  // Splitting a long block skips the spaces inside chips (it used to look each one up in every chip:
  // seconds for 200 KB of chips) and reads each run once. Pieces of 1,000 characters, so that the
  // small inputs are split as well.
  const chips = (n) => validateBlock({ t: 'p', c: Array.from({ length: Math.ceil(n / 19) }, () => ['a b c d e f g h i j', '', { ref: 'task:x', atom: 1 }]) }, { maxChars: Infinity });
  check('splitting a block of chips with spaces in their labels', chips, (b) => splitBlock(b, 1000), K);
  // Serializing: one block holds at most 20,000 characters, so the large input is 19,000.
  const runs = {
    'spaces inside bold': (n) => [['a' + ' '.repeat(n) + 'b', 'b']],
    'punctuation inside bold': (n) => [['x'], ['a' + '!'.repeat(n) + 'b', 'b'], ['y']],
    'line breaks': (n) => [['a' + '\n'.repeat(n) + 'b']],
    'alternating marks': (n) => Array.from({ length: Math.floor(n / 4) }, (_, i) => [`w${i} `, i % 2 ? 'b' : 'i']),
  };
  for (const [name, make] of Object.entries(runs)) check(`writing ${name}`, (n) => validateBlocks([{ t: 'p', c: make(n) }]), (blocks) => blocksToMarkdown(blocks), 19000);
});

test('long paragraphs, items and code become several blocks: nothing is cut', () => {
  const para = Array.from({ length: 6000 }, (_, i) => `w${i}`).join(' ');
  const [a, b, c] = markdownToBlocks(`${para}\n\n- [ ] ${para} [task](ecosys://task/t1)\n\n\`\`\`js\n${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')}\n\`\`\``).reduce((acc, blk) => {
    const last = acc[acc.length - 1];
    if (last && last[0].t === blk.t) last.push(blk);
    else acc.push([blk]);
    return acc;
  }, []);
  for (const group of [a, b, c]) assert.ok(group.length >= 2 && group.every((x) => blockText(x).length <= 20000));
  assert.equal(a.map(blockText).join(' '), para, 'split at spaces, every word kept');
  assert.equal(b.map(blockText).join(' '), para);
  assert.equal(b[0].task, 't1', 'the first piece keeps the task link');
  assert.ok(b.slice(1).every((x) => x.t === 'check' && !x.task));
  assert.equal(c.map(blockText).join('\n'), Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'), 'code splits at line breaks');
  assert.ok(c.every((x) => x.lang === 'js'));
});

test('a chip whose label is longer than a block is cut to 20,000 characters, in a block of its own', () => {
  // A chip is never split: its label used to be kept whole, leaving a block over the limit.
  const blocks = markdownToBlocks(`See [${'ab'.repeat(10005)}](ecosys://task/a) now`);
  assert.deepEqual(blocks.map((b) => blockText(b).length), [4, 20000, 3]);
  assert.deepEqual(blocks[1].c, [['ab'.repeat(10000), '', { ref: 'task:a', atom: 1 }]]);
  const md = blocksToMarkdown(markdownToBlocks(blocksToMarkdown(blocks)));
  assert.equal(blocksToMarkdown(markdownToBlocks(md)), md, 'stable after one pass');
});

test('empty list items, quotes and headings survive a round trip (no "a 2." merging)', () => {
  const doc = [
    { t: 'h1', c: [['Packing']] },
    { t: 'num', in: 0, c: [['Passport']] },
    { t: 'num', in: 0, c: [] },
    { t: 'num', in: 0, c: [['Charger']] },
    { t: 'dash', in: 0, c: [['Socks']] },
    { t: 'dash', in: 0, c: [] },
    { t: 'bullet', in: 1, c: [] },
    { t: 'check', in: 0, ck: false, c: [['a']] },
    { t: 'num', in: 0, c: [] },
    { t: 'h2', c: [] },
    { t: 'quote', c: [] },
    { t: 'quote', c: [['q']] },
    { t: 'quote', c: [] },
    { t: 'quote', c: [] },
    { t: 'p', c: [['after']] },
    { t: 'quote', c: [] },
  ];
  assert.deepEqual(roundTrip(doc), strip(validateBlocks(doc)));
  assert.deepEqual(md2b('- a\n-\n- b').map((x) => [x.t, blockText(x)]), [['dash', 'a'], ['dash', ''], ['dash', 'b']]);
  assert.deepEqual(md2b('para\n-\n1.').map((x) => [x.t, blockText(x)]), [['p', 'para - 1.']], 'an empty item never interrupts a paragraph');
  assert.deepEqual(md2b('>'), [{ t: 'quote', c: [] }]);
  assert.deepEqual(md2b('- [ ]\ntext').map((x) => [x.t, blockText(x)]), [['check', 'text']], 'no leading space from the line break');
});

test('Markdown is stable after one round trip (cases found by fuzzing)', () => {
  const stable = (md) => {
    const once = blocksToMarkdown(markdownToBlocks(md));
    assert.equal(blocksToMarkdown(markdownToBlocks(once)), once, JSON.stringify(md));
  };
  for (const md of ['- [ ]\na', '[] a\n\n2)', '* a= ', '1.[[2026-11-22]]', '![[2026-11-22]]', '**a\n*|[a](ecosys://task/a)***', '<u>a\u2028\n</u>a', '[[2026-11-22]] ', '999999999. a\n1. b']) stable(md);
  const blocksStable = (blocks) => {
    const once = blocksToMarkdown(validateBlocks(blocks));
    assert.equal(blocksToMarkdown(markdownToBlocks(once)), once, JSON.stringify(blocks));
  };
  for (const c of [
    [['a\n']], [['#']], [[' +']], [['a', 'c', { ref: 'note:a' }]], [['a', 'i', { ref: 'note:a' }]], [['a ', '', { ref: 'event:a' }]],
    [['[[2026-11-22]]', 'u']], [['!'], ['a', '', { ref: 'note:a' }]], [['a ', 'u'], [' ', 'u'], ['a']], [['a', 'bs'], ['a'], ['a', 's']],
    [['a', 'bu'], ['\n a', 'b']], [[' ', 'c', { ref: 'note:a' }]], [['\ufeff', 'c']], [['a'], ['[a', '', { ref: 'task:a', hl: 'pink' }]],
  ]) blocksStable([{ t: 'p', c }]);
  blocksStable([{ t: 'h2', c: [['#']] }, { t: 'h3', c: [['a= ']] }, { t: 'check', task: 'a', c: [['a ']] }, { t: 'check', c: [['Task', '', { ref: 'task:a', atom: 1 }]] }]);
  assert.deepEqual(roundTrip([{ t: 'h2', c: [['#']] }]), [{ t: 'h2', c: [['#']] }], 'escaped once, not twice');
  assert.deepEqual(roundTrip([{ t: 'p', c: [[' - x']] }]), [{ t: 'p', c: [['- x']] }], 'Body text stays Body text');
  assert.ok(!blockText(roundTrip([{ t: 'p', c: [['a\n']] }])[0]).includes('\\'), 'a trailing line break never becomes a backslash');
});

test('CommonMark: no links inside links; [[wiki]] after "!" is a wiki link; slugify avoids device names', () => {
  assert.deepEqual(md2b('[a [b](https://b.example/) c](https://a.example/)')[0].c, [['[a '], ['b', '', { href: 'https://b.example/' }], [' c](https://a.example/)']]);
  assert.deepEqual(md2b('![[2026-11-22]]')[0].c, [['!'], ['2026-11-22', '', { ref: 'day:2026-11-22', atom: 1 }]]);
  for (const t of ['con.a', 'NUL.txt', 'com1.notes', 'aux.backup', 'CON']) {
    const s = slugify(t);
    assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s), `${t} → ${s}`);
    assert.equal(slugify(s), s);
  }
});

test('slugify: every name Windows reserves, with or without an extension or spaces before it', () => {
  // CON, PRN, AUX, NUL, COM0-9, LPT0-9, COM¹²³ / LPT¹²³ and the console names CONIN$ / CONOUT$; the part
  // before the first dot counts, and spaces before that dot are ignored ("nul .txt" is NUL).
  const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|$)/i;
  const names = ['CON', 'prn.md', 'Aux.txt', 'nul .txt', 'NUL. md', 'COM0', 'com9.notes', 'LPT0.x', 'COM¹.md', 'lpt³', 'conin$', 'CONOUT$.txt', 'nul.tar.gz'];
  for (const t of names) {
    const s = slugify(t);
    assert.ok(!RESERVED.test(s), `${t} → ${s}`);
    assert.equal(slugify(s), s, `${t}: stable`);
  }
  assert.equal(slugify('con.txt'), 'con_.txt', 'the name stays readable');
  assert.equal(slugify('COM¹.md'), 'COM¹_.md');
  for (const t of ['console', 'Conference.md', 'nullable', 'com10', 'lpt', 'auxiliary', 'clock$']) assert.equal(slugify(t), t, `${t} is not a device name`);
  // The same rule for the app's own file and folder names (notes/export.js), so the two can't drift.
  for (const t of names) {
    const s = avoidDeviceName(t);
    assert.ok(!RESERVED.test(s), `avoidDeviceName: ${t} → ${s}`);
    assert.equal(avoidDeviceName(s), s, `avoidDeviceName: ${t}: stable`);
  }
  assert.deepEqual(['con', 'NUL.md', 'nul .txt', 'LPT¹', 'CONIN$'].map(avoidDeviceName), ['con_', 'NUL_.md', 'nul_ .txt', 'LPT¹_', 'CONIN$_']);
  for (const t of ['console', 'Conference.md', 'nullable', 'com10', 'My notes', '']) assert.equal(avoidDeviceName(t), t);
  assert.equal(avoidDeviceName(JSON.parse('{"toString":0}')), '', 'never throws');
});

test('Markdown functions never throw on values that were never validated', () => {
  const odd = JSON.parse('{"toString":0}');
  const calls = {
    markdownToBlocks: () => markdownToBlocks(odd),
    blocksToMarkdown: () => blocksToMarkdown([{ t: 'p', c: [[odd, odd, { href: odd, ref: odd }]] }, { t: 'check', task: odd, in: odd, c: [[odd]] }, { t: 'code', lang: odd, c: [[odd]] }, { t: odd, c: odd }, null]),
    inlineMarkdown: () => inlineMarkdown([[odd, odd, odd], null, 'x']),
    noteToMarkdown: () => noteToMarkdown({ title: odd, tags: [odd, 'ok'], day: odd, createdAt: 1e20, editedAt: odd, blocks: odd }, { frontMatter: true, folderPath: odd }),
    parseFrontMatter: () => parseFrontMatter(odd),
    looksLikeMarkdown: () => looksLikeMarkdown(odd),
    urlRef: () => urlRef(odd),
    refUrl: () => refUrl(odd),
    slugify: () => slugify(odd, odd),
  };
  for (const [name, fn] of Object.entries(calls)) assert.doesNotThrow(fn, name);
  assert.equal(blocksToMarkdown([{ t: 'code', lang: 'js\n# injected', c: [['x']] }]), '```\nx\n```\n', 'a language that is not a language name is not written into the fence');
  assert.equal(blocksToMarkdown([{ t: 'check', task: 'bad id!', c: [['x']] }]), '- [ ] x\n', 'nor a task link to an invalid id');
  assert.equal(blocksToMarkdown([{ t: 'bullet', in: 2.5, c: [['x']] }, { t: 'bullet', in: 1, c: [['y']] }]), '* x\n    * y\n', 'an indent that is not a whole number is no indent (it used to throw)');
  assert.equal(slugify(odd, odd), 'Untitled');
  const fm = noteToMarkdown({ title: odd, tags: [odd, 'ok'], day: odd, createdAt: 1e20, blocks: [] }, { frontMatter: true });
  assert.equal(fm, '---\ntitle: "New Note"\ntags: [ok]\n---\n\n');
});
