// notes editor: Markdown-style autoformat (notes-spec §3), detected from the resulting text after input —
// never from key events — so it works with any keyboard or IME. Pure functions over a block + caret.

import { LIST, blockText, splitRuns, mergeRuns, mapRange, addMark, withAttr, rMarks, isAtom, retype, caret, replaceAt, idx, newBlock, idsOf, codeRuns } from './model.js';

// Line shortcuts: the text from the block start up to the caret must be exactly the marker.
const LINE_RULES = [
  { re: /^(#{1,3}) $/, list: false, make: (m) => ({ t: `h${m[1].length}` }) },
  { re: /^[*•] $/, list: true, make: () => ({ t: 'bullet' }) },
  { re: /^- $/, list: true, make: () => ({ t: 'dash' }) },
  { re: /^(\d{1,9})[.)] $/, list: true, make: (m) => ({ t: 'num', start: Math.min(999999999, parseInt(m[1], 10)) }) },
  { re: /^(?:- )?\[( |x|X)?\] $/, list: true, make: (m) => ({ t: 'check', ck: /x/i.test(m[1] || '') }) },
  { re: /^> $/, list: false, make: () => ({ t: 'quote' }) },
  { re: /^```([\w+-]{0,20}) $/, list: false, make: (m) => ({ t: 'code', lang: m[1] || undefined }) },
  { re: /^(?:---|\*\*\*|___) $/, list: false, make: () => ({ t: 'hr' }) },
];

/**
 * A line shortcut that just completed at the caret (on Space), or null.
 * Fires in a Body block, or in a list item when switching to another list type.
 */
export function lineRule(block, off) {
  if (!block || !block.c || (block.t !== 'p' && !LIST.has(block.t))) return null;
  const pre = blockText(block).slice(0, off);
  if (pre.length > 24 || !pre.endsWith(' ')) return null;
  if (block.c.some((r, i) => isAtom(r) && i === 0)) return null;
  for (const rule of LINE_RULES) {
    const m = rule.re.exec(pre);
    if (!m) continue;
    if (block.t !== 'p' && !rule.list) return null;
    const res = rule.make(m);
    if (block.t !== 'p') {
      if (res.t === block.t && !(res.t === 'check')) return null;
      if (res.t === 'check' && block.t === 'check') return null;
    }
    return { ...res, strip: m[0].length };
  }
  return null;
}

/** Apply a line rule → {doc, sel, morph} (dividers add a Body block after). */
export function applyLineRule(doc, i, rule) {
  const b = doc[i];
  const rest = splitRuns(b.c, rule.strip)[1];
  if (rule.t === 'hr') {
    const used = idsOf(doc);
    const hr = { id: b.id, t: 'hr' };
    const after = { ...newBlock('p', used), c: rest };
    return { doc: replaceAt(doc, i, hr, after), sel: caret(after.id, 0), morph: 'hr' };
  }
  const fields = {};
  if (rule.t === 'check') fields.ck = rule.ck;
  if (rule.t === 'num' && rule.start !== 1) fields.start = rule.start;
  if (rule.t === 'code' && rule.lang) fields.lang = rule.lang;
  if (LIST.has(rule.t)) fields.in = LIST.has(b.t) ? b.in : 0;
  const nb = { ...retype({ ...b, c: rest }, rule.t, fields), c: rule.t === 'code' ? codeRuns(rest.map((r) => r[0]).join('')) : rest };
  return { doc: replaceAt(doc, i, nb), sel: caret(nb.id, 0), morph: rule.t };
}

/** On Enter in a Body block: '---' / '***' / '___' → divider, '```lang' → code block. */
export function enterRule(block) {
  if (!block || block.t !== 'p') return null;
  const text = blockText(block);
  if (/^(?:---|\*\*\*|___)$/.test(text)) return { t: 'hr', strip: text.length };
  const m = /^```([\w+-]{0,20})$/.exec(text);
  if (m) return { t: 'code', lang: m[1] || undefined, strip: text.length };
  return null;
}

// Inline shortcuts fire when the closing marker is typed. Order matters: doubles before singles.
const INLINE = [
  { mk: '**', mark: 'b' },
  { mk: '~~', mark: 's' },
  { mk: '==', hl: true },
  { mk: '`', mark: 'c', code: true },
  { mk: '*', mark: 'i' },
  { mk: '_', mark: 'i' },
];
const BOUNDARY = /[\s\p{P}\p{S}]/u;

/**
 * An inline shortcut that completed at the caret, or null.
 * Rules: the opening marker follows whitespace/punctuation (or the block start), no space just inside
 * the markers, non-empty content, never inside code, never across a chip or a soft break.
 */
export function inlineRule(block, off) {
  if (!block || !block.c || block.t === 'code') return null;
  const text = blockText(block);
  const pre = text.slice(0, off);
  for (const rule of INLINE) {
    const { mk } = rule;
    if (!pre.endsWith(mk)) continue;
    const close = pre.length - mk.length;
    const single = mk.length === 1;
    const ch = mk[0];
    // A single marker must not be half of a double one ("**", "__").
    if (single && pre[close - 1] === ch) continue;
    if (close < 1 || /\s/.test(pre[close - 1])) continue;
    // Search backward for the opening marker.
    let open = -1;
    for (let k = close - 1 - (mk.length - 1); k >= 0; k--) {
      if (pre.startsWith(mk, k) && k + mk.length < close) {
        if (single && (pre[k - 1] === ch || pre[k + 1] === ch)) continue;
        open = k;
        break;
      }
      if (pre[k] === '\n') break;
    }
    if (open < 0) continue;
    const content = pre.slice(open + mk.length, close);
    if (!content || /^\s|\s$/.test(content) || content.includes('\n')) continue;
    if (!rule.code && content.includes(ch) && mk.length === 1) continue;
    if (open > 0 && !BOUNDARY.test(pre[open - 1])) continue;
    if (open > 0 && pre[open - 1] === ch) continue;
    if (overlapsAtomOrCode(block.c, open, off)) continue;
    return { ...rule, open, close, end: off, content };
  }
  return null;
}

function overlapsAtomOrCode(runs, from, to) {
  let pos = 0;
  for (const r of runs) {
    const len = r[0].length;
    if (pos < to && pos + len > from && (isAtom(r) || rMarks(r).includes('c') || r[2]?.href || r[2]?.ref)) return true;
    pos += len;
  }
  return false;
}

/** Apply an inline rule: drop both markers and format the content. */
export function applyInlineRule(doc, i, rule, { hl = 'purple' } = {}) {
  const b = doc[i];
  const { open, close, end, mk } = rule;
  // Remove the closing marker first so the opening offsets stay valid.
  let c = mergeRuns([...splitRuns(b.c, close)[0], ...splitRuns(b.c, end)[1]]);
  c = mergeRuns([...splitRuns(c, open)[0], ...splitRuns(c, open + mk.length)[1]]);
  const from = open;
  const to = close - mk.length;
  c = mapRange(c, from, to, (r) => (rule.hl ? withAttr(r, 'hl', hl) : addMark(r, rule.mark)));
  const nb = { ...b, c };
  return { doc: replaceAt(doc, idx(doc, b.id), nb), sel: caret(b.id, to), range: [from, to] };
}
