// notes/editor: pure-module tests (model, commands, autoformat, history) + the "no HTML sinks" check.
// Runs in Node (node --test); the DOM parts are covered by the browser harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = process.env.ECOSYS_ROOT ? pathToFileURL(`${process.env.ECOSYS_ROOT.replace(/\\/g, '/')}/`) : new URL('../', import.meta.url);
const M = await import(new URL('notes/editor/model.js', ROOT));
const C = await import(new URL('notes/editor/commands.js', ROOT));
const A = await import(new URL('notes/editor/autoformat.js', ROOT));
const { History } = await import(new URL('notes/editor/history.js', ROOT));

const doc = (...blocks) => M.normDoc(blocks);
const text = (d) => d.map((b) => (b.t === 'hr' ? 'hr' : `${b.t}${b.in ? b.in : ''}${b.t === 'check' ? (b.ck ? '[x]' : '[ ]') : ''}:${M.blockText(b)}`));
const sel = (aId, aOff, fId = aId, fOff = aOff) => ({ a: { id: aId, off: aOff }, f: { id: fId, off: fOff } });

test('the editor never uses an HTML string sink', () => {
  const dir = fileURLToPath(new URL('notes/editor/', ROOT));
  const SINK = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|setHTMLUnsafe|parseHTMLUnsafe|createContextualFragment)\b|execCommand\(\s*['"]insertHTML|\beval\(|new Function\(/;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!SINK.test(src), `${f} uses an HTML sink`);
  }
});

test('normDoc cleans hostile input', () => {
  const d = M.normDoc([
    { id: 'a', t: 'script', c: [['x']] },
    { id: 'a', t: 'p', c: [['ok', 'bzzi', { href: 'javascript:alert(1)' }], ['tab', '', { href: 'java\tscript:alert(1)' }], ['good', '', { href: 'https://e.com/\u202e' }]] },
    { id: 'bad id!', t: 'check', ck: 'yes', in: 99, task: '<x>', c: [['a\u0000b\u2028c']] },
    { id: 'r', t: 'p', c: [['chip\nlabel', 'b', { ref: 'note:abc', atom: 1 }], ['bad ref', '', { ref: 'note:../x', atom: 1 }], ['day', '', { ref: 'day:2026-02-30', atom: 1 }]] },
    { t: 'hr' },
  ]);
  assert.equal(d[0].t, 'p');
  assert.equal(d[1].id !== 'a', true, 'duplicate ids are re-assigned');
  assert.deepEqual(d[1].c, [['ok', 'bi'], ['tab'], ['good', '', { href: 'https://e.com/' }]], 'javascript: (even with a tab) dropped, bidi stripped');
  assert.equal(d[1].c[0][1], 'bi', 'marks are canonical and unique');
  assert.equal(d[2].ck, false);
  assert.equal(d[2].in, 6);
  assert.equal(d[2].task, undefined);
  assert.equal(M.blockText(d[2]), 'ab\nc');
  assert.deepEqual(d[3].c[0], ['chip label', '', { ref: 'note:abc', atom: 1 }], 'atoms: one line, no marks');
  assert.ok(!d[3].c.some((r) => r[2] && (r[2].ref === 'note:../x' || r[2].ref === 'day:2026-02-30')), 'invalid refs dropped');
  assert.equal(d.at(-1).t, 'p', 'a text block always follows a divider');
  assert.deepEqual(M.normDoc([]).map((b) => b.t), ['p']);
});

test('safeHref checks the parsed protocol', () => {
  assert.equal(M.safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(M.safeHref('  JaVaScRiPt:alert(1)'), null);
  assert.equal(M.safeHref('java\nscript:alert(1)'), null);
  assert.equal(M.safeHref('data:text/html,x'), null);
  assert.equal(M.safeHref('mailto:me@example.com'), 'mailto:me@example.com');
  assert.equal(M.hrefFromInput('example.com/x'), 'https://example.com/x');
  assert.equal(M.hrefFromInput('me@example.com'), 'mailto:me@example.com');
  assert.equal(M.hrefFromInput('not a link'), null);
});

test('Enter rules', () => {
  let d = doc({ id: 'h', t: 'h1', c: [['Title']] });
  let r = C.enter(d, sel('h', 5));
  assert.deepEqual(text(r.doc), ['h1:Title', 'p:'], 'after a title comes Body');
  d = doc({ id: 'c', t: 'check', in: 1, ck: true, task: 't1', c: [['done item']] });
  r = C.enter(d, sel('c', 4));
  assert.deepEqual(text(r.doc), ['check1[x]:done', 'check1[ ]: item']);
  assert.equal(r.doc[0].task, 't1', 'the task link stays with the original block');
  assert.equal(r.doc[1].task, undefined);
  r = C.enter(d, sel('c', 0));
  assert.deepEqual(text(r.doc), ['check1[ ]:', 'check1[x]:done item'], 'Enter at the start inserts above');
  assert.equal(r.doc[1].id, 'c');
  r = C.enter(doc({ id: 'e', t: 'bullet', in: 2, c: [] }), sel('e', 0));
  assert.deepEqual(text(r.doc), ['bullet1:']);
  r = C.enter(doc({ id: 'e', t: 'bullet', in: 0, c: [] }), sel('e', 0));
  assert.deepEqual(text(r.doc), ['p:']);
  r = C.enter(doc({ id: 'q', t: 'quote', c: [] }), sel('q', 0));
  assert.deepEqual(text(r.doc), ['p:']);
  r = C.enter(doc({ id: 'k', t: 'code', c: [['a']] }), sel('k', 1));
  assert.deepEqual(text(r.doc), ['code:a\n']);
  r = C.enter(r.doc, sel('k', 2));
  assert.deepEqual(text(r.doc), ['code:a', 'p:'], 'Enter on an empty last line leaves the code block');
});

test('Backspace / Delete at block edges', () => {
  const d = doc({ id: 'a', t: 'p', c: [['one']] }, { id: 'h', t: 'hr' }, { id: 'b', t: 'h2', c: [['two']] });
  let r = C.backspaceAtStart(d, sel('b', 0));
  assert.deepEqual(text(r.doc), ['p:one', 'hr', 'p:two'], 'heading → Body first');
  r = C.backspaceAtStart(r.doc, sel('b', 0));
  assert.deepEqual(text(r.doc), ['p:one', 'p:two'], 'then the divider goes');
  r = C.backspaceAtStart(r.doc, sel('b', 0));
  assert.deepEqual(text(r.doc), ['p:onetwo']);
  assert.deepEqual(r.sel.f, { id: 'a', off: 3 });
  r = C.deleteAtEnd(doc({ id: 'a', t: 'p', c: [['x']] }, { id: 'b', t: 'check', in: 0, ck: false, c: [['y', 'b']] }), sel('a', 1));
  assert.deepEqual(r.doc[0].c, [['x'], ['y', 'b']]);
});

test('deleteRange across blocks, select-all', () => {
  const d = doc({ id: 'a', t: 'h1', c: [['hello']] }, { id: 'b', t: 'p', c: [['middle']] }, { id: 'c', t: 'bullet', in: 0, c: [['world']] });
  let r = C.deleteRange(d, sel('a', 2, 'c', 3));
  assert.deepEqual(text(r.doc), ['h1:held']);
  r = C.deleteRange(d, sel('a', 0, 'c', 5), { emptyType: 'h1' });
  assert.deepEqual(text(r.doc), ['h1:'], 'select all + delete leaves one empty Title');
  r = C.deleteRange(d, sel('a', 0, 'c', 5));
  assert.deepEqual(text(r.doc), ['h1:'], 'without emptyType the first block just empties');
});

test('marks, highlights, links', () => {
  const d = doc({ id: 'a', t: 'p', c: [['hello world']] });
  let r = C.toggleMark(d, sel('a', 0, 'a', 5), 'b');
  assert.deepEqual(r.doc[0].c, [['hello', 'b'], [' world']]);
  r = C.toggleMark(r.doc, sel('a', 0, 'a', 11), 'b');
  assert.deepEqual(r.doc[0].c, [['hello world', 'b']], 'partly bold → all bold');
  r = C.toggleMark(r.doc, sel('a', 0, 'a', 11), 'b');
  assert.deepEqual(r.doc[0].c, [['hello world']]);
  r = C.setHighlight(r.doc, sel('a', 6, 'a', 11), 'mint');
  assert.deepEqual(r.doc[0].c, [['hello '], ['world', '', { hl: 'mint' }]]);
  r = C.setLink(r.doc, sel('a', 0, 'a', 5), 'https://e.com/');
  assert.deepEqual(r.doc[0].c[0], ['hello', '', { href: 'https://e.com/' }]);
  r = C.setLink(r.doc, sel('a', 2), null);
  assert.deepEqual(r.doc[0].c[0], ['hello ']);
  r = C.insertAtom(doc({ id: 'x', t: 'p', c: [['see']] }), sel('x', 3), 'Groceries', 'note:n1');
  assert.deepEqual(r.doc[0].c, [['see'], ['Groceries', '', { ref: 'note:n1', atom: 1 }], [' ']]);
});

test('block types: toggles, code merge and split', () => {
  const d = doc({ id: 'a', t: 'p', c: [['one']] }, { id: 'b', t: 'p', c: [['two']] });
  let r = C.setType(d, sel('a', 0, 'b', 3), 'check');
  assert.deepEqual(text(r.doc), ['check[ ]:one', 'check[ ]:two']);
  r = C.setType(r.doc, sel('a', 0, 'b', 3), 'check');
  assert.deepEqual(text(r.doc), ['p:one', 'p:two'], 'toggles back');
  r = C.setType(d, sel('a', 0, 'b', 3), 'code');
  assert.deepEqual(text(r.doc), ['code:one\ntwo']);
  r = C.setType(r.doc, sel('a', 0, 'a', 7), 'p');
  assert.deepEqual(text(r.doc), ['p:one', 'p:two']);
  r = C.setType(d, sel('a', 0), 'check', {}, { toggle: false });
  assert.deepEqual(text(r.doc).slice(0, 1), ['check[ ]:one']);
  assert.equal(C.setType(r.doc, sel('a', 0), 'check', {}, { toggle: false }), null, 'no toggle-off when asked not to');
});

test('checklists: auto-sort, manual sort, run commands, moving with subtrees', () => {
  const d = doc(
    { id: 'a', t: 'check', in: 0, ck: true, c: [['a']] },
    { id: 'a1', t: 'check', in: 1, ck: false, c: [['a1']] },
    { id: 'b', t: 'check', in: 0, ck: false, c: [['b']] },
    { id: 'c', t: 'check', in: 0, ck: false, c: [['c']] },
    { id: 'p', t: 'p', c: [['after']] },
  );
  const moved = C.autoSort(d, 'a');
  assert.deepEqual(text(moved), ['check[ ]:b', 'check[ ]:c', 'check[x]:a', 'check1[ ]:a1', 'p:after'], 'checked item moves with its subtree');
  const un = doc({ id: 'x', t: 'check', in: 0, ck: true, c: [['x']] }, { id: 'y', t: 'check', in: 0, ck: true, c: [['y']] }, { id: 'z', t: 'check', in: 0, ck: false, c: [['z']] });
  assert.deepEqual(text(C.autoSort(un, 'z')), ['check[ ]:z', 'check[x]:x', 'check[x]:y'], 'unchecking moves it above the first checked sibling');
  assert.deepEqual(text(C.autoSort(d, 'b')), ['check[ ]:b', 'check[x]:a', 'check1[ ]:a1', 'check[ ]:c', 'p:after'], 'an unchecked item goes above checked siblings');
  assert.deepEqual(text(C.autoSort(un, 'x')), ['check[x]:y', 'check[ ]:z', 'check[x]:x'], 'a checked item goes to the end of its run');
  assert.equal(C.autoSort(un, 'z') && C.autoSort(C.autoSort(un, 'z'), 'z'), null, 'sorting is idempotent');
  assert.deepEqual(text(C.sortChecked(d, 0)), ['check[ ]:b', 'check[ ]:c', 'check[x]:a', 'check1[ ]:a1', 'p:after']);
  assert.deepEqual(C.runIds(d, 2), ['a', 'a1', 'b', 'c']);
  const del = C.deleteChecked(d, 0, sel('b', 0));
  assert.deepEqual(text(del.doc), ['check1[ ]:a1', 'check[ ]:b', 'check[ ]:c', 'p:after']);
  const mv = C.moveBlocks(d, sel('a', 0), 1);
  assert.deepEqual(text(mv.doc), ['check[ ]:b', 'check[x]:a', 'check1[ ]:a1', 'check[ ]:c', 'p:after']);
  const up = C.moveBlocks(d, sel('c', 0), -1);
  assert.deepEqual(text(up.doc), ['check[x]:a', 'check1[ ]:a1', 'check[ ]:c', 'check[ ]:b', 'p:after']);
  const drag = C.moveUnitTo(d, 0, 2, 4);
  assert.deepEqual(text(drag), ['check[ ]:b', 'check[ ]:c', 'check[x]:a', 'check1[ ]:a1', 'p:after'], 'a drag is a model move, never a copy');
  assert.equal(drag.length, d.length);
});

test('insertFragment: inline, multi-block, into an empty block, never duplicate task links', () => {
  const d = doc({ id: 'a', t: 'p', c: [['hello world']] });
  let r = C.insertFragment(d, sel('a', 6), [{ id: 'x', t: 'h2', c: [['big ', 'b']] }]);
  assert.deepEqual(r.doc[0].c, [['hello '], ['big ', 'b'], ['world']], 'one block merges inline');
  r = C.insertFragment(d, sel('a', 6), [{ id: 'x1', t: 'p', c: [['one']] }, { id: 'x2', t: 'check', in: 0, ck: false, task: 't9', c: [['two']] }]);
  assert.deepEqual(text(r.doc), ['p:hello one', 'check[ ]:twoworld']);
  assert.equal(r.doc[1].task, undefined);
  r = C.insertFragment(doc({ id: 'e', t: 'p', c: [] }), sel('e', 0), [{ id: 'x', t: 'quote', c: [['q']] }]);
  assert.deepEqual(text(r.doc), ['quote:q'], 'an empty block takes the pasted type');
});

test('autoformat: line and inline rules', () => {
  const b = (t, s) => ({ id: 'z', t, in: 0, c: s ? [[s]] : [] });
  assert.equal(A.lineRule(b('p', '# '), 2).t, 'h1');
  assert.equal(A.lineRule(b('p', '### x'), 4).t, 'h3');
  assert.equal(A.lineRule(b('p', '- '), 2).t, 'dash');
  assert.equal(A.lineRule(b('p', '* '), 2).t, 'bullet');
  assert.equal(A.lineRule(b('p', '12) '), 4).start, 12);
  assert.equal(A.lineRule(b('p', '- [x] '), 6).ck, true);
  assert.equal(A.lineRule(b('dash', '[ ] '), 4).t, 'check', 'list → checklist switch');
  assert.equal(A.lineRule(b('dash', '# '), 2), null, 'headings only from Body');
  assert.equal(A.lineRule(b('p', 'x # '), 4), null, 'only at the start');
  assert.equal(A.enterRule(b('p', '---')).t, 'hr');
  assert.equal(A.enterRule(b('p', '```js')).lang, 'js');
  const inl = (s) => A.inlineRule(b('p', s), s.length);
  assert.equal(inl('a **b**').mark, 'b');
  assert.equal(inl('a *i*').mark, 'i');
  assert.equal(inl('x ==h==').hl, true);
  assert.equal(inl('a `c`').mark, 'c');
  assert.equal(inl('snake_case_'), null);
  assert.equal(inl('2*3*'), null);
  assert.equal(inl('a ~b~'), null, 'a single ~ does nothing');
  assert.equal(inl('a ** b**'), null, 'no space just inside');
  assert.equal(A.inlineRule({ id: 'z', t: 'code', c: [['a **b**']] }, 7), null, 'never inside code');
  const d = doc({ id: 'z', t: 'p', c: [['a **bold**']] });
  const r = A.applyInlineRule(d, 0, A.inlineRule(d[0], 10));
  assert.deepEqual(r.doc[0].c, [['a '], ['bold', 'b']]);
});

test('history: coalescing, whitespace groups, undo/redo', () => {
  const h = new History();
  const s0 = { doc: ['v0'] };
  h.record(s0, { kind: 'type', block: 'a', now: 1000 });
  assert.equal(h.record({ doc: ['v1'] }, { kind: 'type', block: 'a', now: 1500 }), false, 'merged within 1 s');
  h.record({ doc: ['v2'] }, { kind: 'type', block: 'a', now: 1600, ws: true });
  assert.equal(h.record({ doc: ['v3'] }, { kind: 'type', block: 'a', now: 1700 }), true, 'a new group after whitespace');
  assert.equal(h.record({ doc: ['v4'] }, { kind: 'type', block: 'b', now: 1750 }), true, 'another block starts a group');
  assert.equal(h.record({ doc: ['v5'] }, { kind: 'type', block: 'b', now: 3000 }), true, 'a pause starts a group');
  h.record({ doc: ['v6'] }, { kind: 'structure' });
  assert.equal(h.undoStack.length, 5);
  const prev = h.undo({ doc: ['now'] });
  assert.deepEqual(prev, { doc: ['v6'] });
  assert.deepEqual(h.redo({ doc: ['v6'] }), { doc: ['now'] });
});
