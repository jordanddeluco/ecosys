// Generators for notes/core fuzz tests: runs, blocks, notes and folders (hostile and near-valid),
// Markdown-ish soup, and search queries.
import { obj, pollution, jsonValue, hostileString, VALID_IDS, BAD_IDS, VALID_DATES, BAD_DATES } from './json-gen.js';
import { hostileUrl, hostileHtml, canonicalHtml } from './html-gen.js';

const C = (n) => String.fromCharCode(n);
export const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'bullet', 'dash', 'num', 'check', 'quote', 'code', 'hr'];
const HL = ['purple', 'pink', 'orange', 'mint', 'blue'];

const MD_PIECES = [
  'note', 'Hello', 'world', ' ', ' ', '  ', 'é', '中文', `${C(0xd83d)}${C(0xde00)}`, '*', '**', '***', '_', '__', '~', '~~', '`', '``', '```', '[', ']', '(', ')', '[x]', '[ ]', '<', '>', '<u>', '</u>',
  '<b>', '<script>', '==', '=', '#', '##', '# ', '1.', '1)', '2.', '- ', '* ', '+ ', '> ', '\\', '\\*', '&amp;', '&#35;', '&lt;', '[[Title]]', '[[2026-11-22]]', '[a](https://ex.example)',
  '[b](javascript:alert(1))', '<https://ex.example>', 'https://ex.example/x_y*z', 'mailto:a@b.example', '!', '|', ':', '---', '===', '#tag', '#a/b', '#Work/Clients-', '@x', 'ecosys://note/abc',
  '[t](ecosys://task/abc123)', '\t', C(0), C(1), C(0x2028), C(0x202e), C(0xd800), '-', '+', '.', '^',
];
export function mdText(rng, len = rng.int(1, 16)) {
  return rng.repeat(len, () => rng.pick(MD_PIECES)).join('');
}

/** Markdown-ish soup for markdownToBlocks: lines with block markers, fences, indents, quotes, tables. */
export function mdSoup(rng) {
  const lines = rng.repeat(rng.int(1, 25), () =>
    rng.weighted([
      [6, () => mdText(rng)],
      [3, () => `${' '.repeat(rng.pick([0, 0, 1, 2, 3, 4, 5, 8, 12]))}${rng.pick(['- ', '* ', '+ ', '1. ', '2) ', '10. ', '- [ ] ', '- [x] ', '[ ] ', '[x] ', '> ', '>> ', '# ', '## ', '### ', '#### ', ''])}${mdText(rng, rng.int(0, 6))}`],
      [1, () => rng.pick(['```', '```js', '~~~', '````', '---', '***', '___', '===', '--', '', '', '|a|b|', '|-|-|', '| --- | :-: |', '\\', '---\ntitle: "x"\n---'])],
      [1, () => `\t${mdText(rng, 3)}`],
    ]),
  );
  let s = lines.join(rng.pick(['\n', '\n', '\r\n', '\n\n']));
  if (rng.chance(0.1)) s = s.slice(0, rng.int(0, s.length));
  return s;
}

export function genRef(rng) {
  const id = rng.chance(0.85) ? rng.pick(VALID_IDS) : rng.pick(BAD_IDS.filter((x) => typeof x === 'string'));
  return rng.weighted([
    [3, () => `note:${id}`],
    [1, () => `note:${id}#${rng.pick(VALID_IDS)}`],
    [2, () => `task:${id}`],
    [2, () => `event:${id}`],
    [1, () => `event:${id}@${rng.pick([...VALID_DATES, ...BAD_DATES.filter((x) => typeof x === 'string')])}`],
    [2, () => `day:${rng.pick([...VALID_DATES, ...BAD_DATES.filter((x) => typeof x === 'string')])}`],
    [1, () => rng.pick(['note:', 'task', 'x:abc', 'javascript:alert(1)', 'note:a b', '__proto__:x', `note:${'a'.repeat(41)}`])],
  ]);
}

function genAttrs(rng) {
  const e = [];
  if (rng.chance(0.4)) e.push(['href', rng.chance(0.8) ? hostileUrl(rng) : jsonValue(rng, 2)]);
  if (rng.chance(0.3)) e.push(['ref', rng.chance(0.9) ? genRef(rng) : jsonValue(rng, 2)]);
  if (rng.chance(0.3)) e.push(['hl', rng.chance(0.8) ? rng.pick([...HL, 'red', '', null]) : jsonValue(rng, 2)]);
  if (rng.chance(0.2)) e.push(['atom', rng.pick([1, true, 0, 'x', 2])]);
  if (rng.chance(0.1)) e.push([rng.pick(['__proto__', 'constructor', 'style', 'onclick']), pollution()]);
  return obj(rng.shuffle(e));
}

export function genRuns(rng) {
  if (rng.chance(0.05)) return jsonValue(rng, 1);
  return rng.repeat(rng.small(7), () =>
    rng.weighted([
      [6, () => {
        const r = [rng.chance(0.85) ? mdText(rng, rng.int(1, 6)) : hostileString(rng)];
        if (rng.chance(0.5)) r.push(rng.chance(0.9) ? rng.sample(['b', 'i', 'u', 's', 'c', 'x', 'B'], rng.int(0, 4)).join('') : jsonValue(rng, 1));
        if (r.length === 2 && rng.chance(0.4)) r.push(genAttrs(rng));
        return r;
      }],
      [1, () => mdText(rng, 2)],
      [1, () => rng.pick([[], [5], [null], ['', 'b'], [1234, 'i'], [{}, 'b'], 'x'])],
    ]),
  );
}

export function genBlock(rng) {
  const t = rng.weighted([[10, () => rng.pick(BLOCK_TYPES)], [1, () => rng.pick(['h4', 'todo', '', null, '__proto__', 'P'])]]);
  const e = [
    ['id', rng.weighted([[6, () => `b${rng.int(0, 40)}`], [2, () => rng.pick(VALID_IDS)], [1, () => rng.pick(BAD_IDS)]])],
    ['t', t],
    ['c', genRuns(rng)],
  ];
  if (rng.chance(0.5)) e.push(['in', rng.weighted([[5, () => rng.int(0, 6)], [1, () => rng.pick([-1, 7, 99, '2', 2.5, null])]])]);
  if (rng.chance(0.4)) e.push(['ck', rng.pick([true, false, 'true', 1, null])]);
  if (rng.chance(0.2)) e.push(['task', rng.chance(0.8) ? rng.pick(VALID_IDS) : rng.pick(BAD_IDS)]);
  if (rng.chance(0.2)) e.push(['start', rng.pick([0, 1, 2, 7, 100, 999999999, 1e10, -1, 2.5, '3'])]);
  if (rng.chance(0.2)) e.push(['lang', rng.pick(['js', 'c++', 'objective-c', 'x'.repeat(21), 'a b', '', '<script>', 'py'])]);
  if (rng.chance(0.1)) e.push(['fold', rng.pick([true, false, 'true'])]);
  if (rng.chance(0.05)) e.push(['__proto__', pollution()]);
  return obj(rng.shuffle(e));
}

export function genBlocks(rng, max = 30) {
  return rng.repeat(rng.small(max), (r) => (r.chance(0.95) ? genBlock(r) : jsonValue(r, 1)));
}

export function genNote(rng) {
  const e = [['id', rng.chance(0.9) ? rng.pick(VALID_IDS) : rng.pick(BAD_IDS)]];
  const add = (p, k, v) => rng.chance(p) && e.push([k, typeof v === 'function' ? v() : v]);
  add(0.85, 'blocks', () => genBlocks(rng));
  add(0.2, 'body', () => (rng.chance(0.5) ? hostileHtml(rng) : canonicalHtml(rng)));
  add(0.3, 'title', () => hostileString(rng));
  add(0.3, 'tags', () => rng.repeat(rng.small(6), () => rng.pick(['work', 'Work/Clients', '#home', '', 'x'.repeat(70), 'a b', 'ünï', '__proto__', 5])));
  add(0.4, 'folderId', () => rng.pick([...VALID_IDS, ...BAD_IDS]));
  add(0.3, 'pinned', () => rng.pick([true, false, 'true', 1]));
  add(0.3, 'day', () => rng.pick([...VALID_DATES, ...BAD_DATES]));
  add(0.2, 'event', () => obj([['id', rng.pick([...VALID_IDS, ...BAD_IDS])], ['date', rng.pick([...VALID_DATES, ...BAD_DATES])]]));
  add(0.2, 'aiHidden', () => rng.pick([true, false, 'true']));
  add(0.15, 'aiPrev', () => obj([['at', rng.pick([1763800000000, -1, 'x'])], ['by', rng.pick(['mcp:claude', 'user', 'evil'])], ['rev', rng.pick([0, 3, -1, 1.5])], ['blocks', genBlocks(rng)]]));
  add(0.08, 'locked', () => obj([['iv', rng.pick(['abcdefgh12345678', 'short', '', 'a+b/c=d_e-fghijk'])], ['ct', rng.weighted([[5, () => 'QUJD'.repeat(rng.int(1, 100))], [1, () => 'A'.repeat(rng.int(100000, 700000))], [1, () => '<script>']])]]));
  add(0.3, 'editedBy', () => rng.pick(['user', 'mcp:claude', 'mcp:evil', null]));
  for (const k of ['editedAt', 'createdAt', 'updatedAt', 'trashedAt']) add(0.4, k, () => rng.pick([1763800000000, 0, -5, 8.64e15 + 1, 'yesterday', null, 1.5]));
  add(0.2, 'trashedFrom', () => rng.pick([...VALID_IDS, ...BAD_IDS]));
  add(0.2, 'rev', () => rng.pick([0, 1, 42, -1, 1.5, 1e13, '3']));
  add(0.2, 'links', () => ['note:fake', 'javascript:alert(1)']);
  add(0.1, rng.pick(['__proto__', 'constructor', 'prototype', 'extra']), () => pollution());
  return obj(rng.shuffle(e));
}

export function genFolder(rng) {
  const e = [['id', rng.chance(0.9) ? rng.pick(VALID_IDS) : rng.pick(BAD_IDS)]];
  const add = (p, k, v) => rng.chance(p) && e.push([k, typeof v === 'function' ? v() : v]);
  add(0.9, 'name', () => (rng.chance(0.7) ? rng.pick(['Work', 'Work/Clients', '  spaced  ', '', 'x'.repeat(80), 'a\nb', 'ünï', '.hidden', '<b>']) : hostileString(rng)));
  add(0.5, 'parentId', () => rng.pick([...VALID_IDS, ...BAD_IDS]));
  add(0.4, 'color', () => rng.pick(['iris', 'red', 'nope', null]));
  add(0.3, 'order', () => rng.pick([0, 1, 1e16, 'x', -2.5]));
  add(0.3, 'sort', () => rng.pick(['edited', 'created', 'title', 'x', null]));
  add(0.3, 'sortDir', () => rng.pick(['asc', 'desc', 'up']));
  add(0.3, 'groupByDate', () => rng.pick([true, false, 'true']));
  add(0.3, 'view', () => rng.pick(['list', 'gallery', 'grid']));
  add(0.2, 'aiHidden', () => rng.pick([true, false, 1]));
  add(0.1, '__proto__', () => pollution());
  return obj(rng.shuffle(e));
}

export function genQuery(rng) {
  return rng
    .repeat(rng.int(0, 6), () =>
      rng.weighted([
        [5, () => rng.pick(['note', 'hello', 'wor', 'é', 'e', '中', 'x', 'a', '**', '[', 'Title', 'tag', 'b1', mdText(rng, 1)])],
        [2, () => `#${rng.pick(['work', 'work/clients', 'home', 'ünï', 'a/b', '', '#', '-'])}`],
        [1, () => `-${rng.pick(['note', '#work', '"a b"', 'is:pinned', 'has:todo', 'in:Work'])}`],
        [2, () => `${rng.pick(['is', 'has', 'in', 'edited', 'created', 'tag', 'IS', 'x'])}:${rng.pick(['pinned', 'daily', 'meeting', 'checklist', 'ai', 'hidden', 'todo', 'done', 'link', 'task', '"Work"', 'Work/Clients', 'today', 'yesterday', '7d', '30d', '2026-11-22', '2026-13-45', 'notes', '', 'bogus'])}`],
        [1, () => `"${rng.pick(['hello world', 'a', '', 'note "x', 'é'])}"`],
        [1, () => hostileString(rng).slice(0, 20)],
      ]),
    )
    .join(rng.pick([' ', '  ', '\t', '']));
}
