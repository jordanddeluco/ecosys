// notes editor: pure document commands. Each takes (doc, sel, …) and returns {doc, sel} or null
// when there is nothing to do. Docs are immutable arrays of immutable blocks (see model.js).

import {
  LIST, HEADINGS, MAX_IN, isText, blockLen, blockText, splitRuns, mergeRuns, mkRun, spliceRuns, mapRange, addMark, delMark,
  withAttr, rangeEvery, rMarks, rAttrs, isAtom, codeRuns, newBlock, retype, idsOf, idx, caret, isCollapsed, orderSel, segments,
  ensureDoc, replaceAt, linkExtent, runsLen, nextText, prevText, newId, normRuns, fixOff,
} from './model.js';

const done = (doc, sel) => ({ doc: ensureDoc(doc), sel });
const toP = (b) => retype(b, 'p');

// ------------------------------------------------------------------ text

/**
 * Delete the selected range (across blocks too). With `emptyType` (user deletes), select-all + delete
 * leaves one empty block of that type (Apple: an empty Title).
 */
export function deleteRange(doc, sel, { emptyType = null } = {}) {
  if (isCollapsed(sel)) return null;
  const { s, e } = orderSel(doc, sel);
  if (s.i < 0 || e.i < 0) return null;
  const first = doc[s.i];
  const last = doc[e.i];
  const lastLen = blockLen(last);
  if (emptyType && s.i === 0 && s.off === 0 && e.i === doc.length - 1 && e.off >= lastLen && (s.i !== e.i || blockLen(first) > 0)) {
    const b = { ...retype(first.t === 'hr' ? { id: first.id, t: 'p', c: [] } : first, emptyType), c: [] };
    return { doc: [b], sel: caret(b.id, 0) };
  }
  if (s.i === e.i) {
    if (!isText(first)) return null;
    const c = spliceRuns(first.c, s.off, e.off);
    return done(replaceAt(doc, s.i, { ...first, c: first.t === 'code' ? codeRuns(textOf(c)) : c }), caret(first.id, s.off));
  }
  const tail = isText(last) ? splitRuns(last.c, e.off)[1] : [];
  if (!isText(first)) {
    // Started on a divider: keep the end block's remainder with its own type.
    const keep = isText(last) ? [{ ...last, c: tail }] : [];
    const out = [...doc.slice(0, s.i), ...keep, ...doc.slice(e.i + 1)];
    const j = keep.length ? s.i : Math.min(s.i, out.length - 1);
    const fixed = ensureDoc(out);
    const t = isText(fixed[j]) ? j : nextText(fixed, j) ?? prevText(fixed, j);
    return { doc: fixed, sel: caret(fixed[t].id, 0) };
  }
  const head = splitRuns(first.c, s.off)[0];
  const c = first.t === 'code' ? codeRuns(textOf(head) + textOf(tail)) : mergeRuns([...head, ...tail]);
  const out = [...doc.slice(0, s.i), { ...first, c }, ...doc.slice(e.i + 1)];
  return done(out, caret(first.id, s.off));
}

const textOf = (runs) => runs.map((r) => r[0]).join('');

/** Replace the selection with runs (inline), caret after them. */
export function insertRuns(doc, sel, runs, opts) {
  const base = isCollapsed(sel) ? { doc, sel } : deleteRange(doc, sel, opts) || { doc, sel };
  const d = base.doc;
  const p = base.sel.f;
  const i = idx(d, p.id);
  const b = d[i];
  if (!isText(b)) return null;
  const ins = b.t === 'code' ? [[textOf(runs)]] : runs;
  const n = runsLen(ins);
  const c = b.t === 'code' ? codeRuns(textOf(splitRuns(b.c, p.off)[0]) + textOf(ins) + textOf(splitRuns(b.c, p.off)[1])) : spliceRuns(b.c, p.off, p.off, ins);
  return { doc: replaceAt(d, i, { ...b, c }), sel: caret(b.id, p.off + n) };
}

export const insertText = (doc, sel, text, fmt = {}, opts) => (text ? insertRuns(doc, sel, [mkRun(text, fmt.marks || '', fmt.attrs || null)], opts) : null);

/** Delete one grapheme (or an atom) before / after a collapsed caret, within the block. */
export function deleteChar(doc, sel, dir) {
  const i = idx(doc, sel.f.id);
  const b = doc[i];
  if (!isText(b)) return null;
  const off = sel.f.off;
  const text = blockText(b);
  let from = off;
  let to = off;
  // Atoms go as a whole.
  let pos = 0;
  for (const r of b.c) {
    const len = r[0].length;
    if (isAtom(r) && ((dir < 0 && off === pos + len) || (dir > 0 && off === pos))) {
      from = pos;
      to = pos + len;
      break;
    }
    pos += len;
  }
  if (from === to) {
    if (dir < 0) {
      if (off === 0) return null;
      from = prevGrapheme(text, off);
    } else {
      if (off >= text.length) return null;
      to = nextGrapheme(text, off);
    }
  }
  const c = spliceRuns(b.c, from, to);
  return { doc: replaceAt(doc, i, { ...b, c: b.t === 'code' ? codeRuns(textOf(c)) : c }), sel: caret(b.id, from) };
}

let seg = null;
const segmenter = () => (seg ??= typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : false);
export function prevGrapheme(text, off) {
  const s = segmenter();
  if (!s) return Math.max(0, fixOff(text, off - 1) === off ? off - 2 : off - 1);
  let last = 0;
  for (const g of s.segment(text.slice(0, off))) last = g.index;
  return last;
}
export function nextGrapheme(text, off) {
  const s = segmenter();
  if (!s) return Math.min(text.length, fixOff(text, off + 1));
  for (const g of s.segment(text.slice(off))) return off + g.segment.length;
  return text.length;
}

// ------------------------------------------------------------------ Enter / Backspace / Delete

/**
 * Enter (insertParagraph). Rules (notes-spec §3): split mid-text (lists inherit, checks start unchecked,
 * headings continue as Body); Enter at the start of a non-empty heading inserts Body above; an empty list
 * item outdents or leaves the list; an empty quote line leaves the quote; code blocks take a newline and
 * are left with Enter on an empty last line.
 */
export function enter(doc, sel, opts) {
  const base = isCollapsed(sel) ? { doc, sel } : deleteRange(doc, sel, opts) || { doc, sel };
  const d = base.doc;
  const p = base.sel.f;
  const i = idx(d, p.id);
  const b = d[i];
  if (!isText(b)) return null;
  const len = blockLen(b);
  const off = Math.min(p.off, len);
  const used = idsOf(d);
  if (b.t === 'code') {
    const text = blockText(b);
    if (off === len && (len === 0 || text.endsWith('\n'))) {
      if (len === 0) {
        const nb = toP(b);
        return { doc: replaceAt(d, i, nb), sel: caret(nb.id, 0), kind: 'structure' };
      }
      const nb = { ...b, c: codeRuns(text.slice(0, -1)) };
      const np = newBlock('p', used);
      return { doc: replaceAt(d, i, nb, np), sel: caret(np.id, 0) };
    }
    return insertText(d, base.sel, '\n');
  }
  if (LIST.has(b.t) && len === 0) {
    if (b.in > 0) return { doc: replaceAt(d, i, { ...b, in: b.in - 1 }), sel: caret(b.id, 0) };
    const nb = toP(b);
    return { doc: replaceAt(d, i, nb), sel: caret(nb.id, 0) };
  }
  if (b.t === 'quote' && len === 0) {
    const nb = toP(b);
    return { doc: replaceAt(d, i, nb), sel: caret(nb.id, 0) };
  }
  const sibling = (fields) => {
    if (HEADINGS.has(b.t)) return newBlock('p', used);
    if (b.t === 'check') return newBlock('check', used, { in: b.in, ck: false, ...fields });
    if (LIST.has(b.t)) return newBlock(b.t, used, { in: b.in, ...fields });
    return newBlock(b.t === 'quote' ? 'quote' : 'p', used);
  };
  if (off === 0 && len > 0) {
    // Insert an empty block above; the block (its id, check state, task link) stays with its text.
    const above = HEADINGS.has(b.t) ? newBlock('p', used) : sibling();
    return { doc: [...d.slice(0, i), above, ...d.slice(i)], sel: caret(b.id, 0) };
  }
  const [left, right] = splitRuns(b.c, off);
  const keep = { ...b, c: left };
  const nb = { ...sibling(), c: right };
  return { doc: replaceAt(d, i, keep, nb), sel: caret(nb.id, 0) };
}

/** Backspace at offset 0 (collapsed). */
export function backspaceAtStart(doc, sel) {
  const i = idx(doc, sel.f.id);
  const b = doc[i];
  if (!isText(b)) return null;
  if (LIST.has(b.t) && b.in > 0) return { doc: replaceAt(doc, i, { ...b, in: b.in - 1 }), sel: caret(b.id, 0) };
  if (LIST.has(b.t) || b.t === 'quote' || HEADINGS.has(b.t) || b.t === 'code') {
    const nb = toP(b);
    return { doc: replaceAt(doc, i, nb), sel: caret(nb.id, 0) };
  }
  if (i === 0) return null;
  const prev = doc[i - 1];
  if (prev.t === 'hr') return done([...doc.slice(0, i - 1), ...doc.slice(i)], caret(b.id, 0));
  const plen = blockLen(prev);
  const c = prev.t === 'code' ? codeRuns(blockText(prev) + blockText(b)) : mergeRuns([...prev.c, ...b.c]);
  return done([...doc.slice(0, i - 1), { ...prev, c }, ...doc.slice(i + 1)], caret(prev.id, plen));
}

/** Delete at the end of a block (collapsed): merge the next block in (or drop a divider). */
export function deleteAtEnd(doc, sel) {
  const i = idx(doc, sel.f.id);
  const b = doc[i];
  if (!isText(b) || i >= doc.length - 1) return null;
  const next = doc[i + 1];
  if (next.t === 'hr') return done([...doc.slice(0, i + 1), ...doc.slice(i + 2)], caret(b.id, sel.f.off));
  const c = b.t === 'code' ? codeRuns(blockText(b) + blockText(next)) : mergeRuns([...b.c, ...(next.t === 'code' ? normRuns([[blockText(next)]]) : next.c)]);
  return done([...doc.slice(0, i), { ...b, c }, ...doc.slice(i + 2)], caret(b.id, sel.f.off));
}

// ------------------------------------------------------------------ block types

const TOGGLES = new Set(['bullet', 'dash', 'num', 'check', 'quote', 'code']);

/**
 * Turn the selected blocks into type t. Lists, checklists, quote and code toggle back to Body when every
 * selected block already has that type. Several lines become one code block; a code block turned into
 * anything else splits into one block per line.
 */
export function setType(doc, sel, t, fields = {}, { toggle = true } = {}) {
  const { s, e } = orderSel(doc, sel);
  const range = [];
  for (let i = s.i; i <= e.i; i++) if (isText(doc[i])) range.push(i);
  if (!range.length) return null;
  const target = toggle && TOGGLES.has(t) && range.every((i) => doc[i].t === t) ? 'p' : t;
  if (!toggle && range.every((i) => doc[i].t === target) && !Object.keys(fields).length) return null;
  const inRange = new Set(range);
  const used = idsOf(doc);

  if (target === 'code' && range.length > 1) {
    // Several blocks → one code block; offsets map into the joined text.
    const parts = range.map((i) => blockText(doc[i]));
    const at = (i, off) => {
      let n = 0;
      for (let k = 0; k < range.length; k++) {
        if (range[k] === i) return n + off;
        n += parts[k].length + 1;
      }
      return n;
    };
    const first = doc[range[0]];
    const nb = { ...retype(first, 'code', fields), c: codeRuns(parts.join('\n')) };
    const out = [...doc.slice(0, range[0]), nb, ...doc.slice(range.at(-1) + 1).filter(Boolean)];
    // Dividers inside the range are dropped with the joined lines.
    const so = at(s.i, s.off);
    const eo = at(e.i, e.off);
    const fwd = orderSel(doc, sel).fwd;
    return done(out, fwd ? { a: { id: nb.id, off: so }, f: { id: nb.id, off: eo } } : { a: { id: nb.id, off: eo }, f: { id: nb.id, off: so } });
  }

  const out = [];
  const remap = new Map(); // old position → new {id, off}
  for (let i = 0; i < doc.length; i++) {
    const b = doc[i];
    if (!inRange.has(i)) {
      out.push(b);
      continue;
    }
    if (b.t === 'code' && target !== 'code' && blockText(b).includes('\n')) {
      const lines = blockText(b).split('\n');
      let n = 0;
      lines.forEach((line, k) => {
        const nb = k === 0 ? { ...retype(b, target, fields), c: normRuns([[line]]) } : { ...newBlock(target, used, fields), c: normRuns([[line]]) };
        remap.set(`${b.id}:${k}`, { id: nb.id, start: n, len: line.length });
        n += line.length + 1;
        out.push(nb);
      });
      continue;
    }
    out.push(target === b.t && !Object.keys(fields).length ? b : retype(b, target, fields));
  }
  const mapPos = (p) => {
    const b = doc[idx(doc, p.id)];
    if (b && b.t === 'code' && target !== 'code' && blockText(b).includes('\n')) {
      const lines = blockText(b).split('\n');
      for (let k = 0; k < lines.length; k++) {
        const m = remap.get(`${b.id}:${k}`);
        if (m && p.off <= m.start + m.len) return { id: m.id, off: Math.max(0, p.off - m.start) };
      }
    }
    return { ...p };
  };
  return done(out, { a: mapPos(sel.a), f: mapPos(sel.f) });
}

/** Insert a divider after the caret's block (an empty Body line becomes the divider). */
export function insertDivider(doc, sel) {
  const { e } = orderSel(doc, sel);
  const b = doc[e.i];
  const used = idsOf(doc);
  const hr = newBlock('hr', used);
  if (isText(b) && blockLen(b) === 0 && b.t === 'p') {
    const out = replaceAt(doc, e.i, hr, b);
    return { doc: ensureDoc(out), sel: caret(b.id, 0) };
  }
  const after = doc[e.i + 1];
  const np = after && isText(after) && blockLen(after) === 0 ? null : newBlock('p', used);
  const out = [...doc.slice(0, e.i + 1), hr, ...(np ? [np] : []), ...doc.slice(e.i + 1)];
  const target = np || after;
  return { doc: ensureDoc(out), sel: caret(target.id, 0) };
}

/** Indent (+1) or outdent (−1) list and checklist items in the selection. */
export function indent(doc, sel, delta) {
  const { s, e } = orderSel(doc, sel);
  let changed = false;
  const out = doc.map((b, i) => {
    if (i < s.i || i > e.i || !LIST.has(b.t)) return b;
    const n = Math.min(MAX_IN, Math.max(0, (b.in || 0) + delta));
    if (n === b.in) return b;
    changed = true;
    return { ...b, in: n };
  });
  return changed ? { doc: out, sel } : null;
}

// ------------------------------------------------------------------ inline formatting

/** Toggle a mark over the selection (removed when every selected character already has it). */
export function toggleMark(doc, sel, mark) {
  if (isCollapsed(sel)) return null;
  const segs = segments(doc, sel, { skipCode: true }).filter((g) => g.to > g.from);
  if (!segs.length) return null;
  const on = !segs.every((g) => rangeEvery(doc[g.i].c, g.from, g.to, (r) => rMarks(r).includes(mark)));
  const out = doc.slice();
  for (const g of segs) {
    const b = out[g.i];
    out[g.i] = { ...b, c: mapRange(b.c, g.from, g.to, (r) => (on ? addMark(r, mark) : delMark(r, mark))) };
  }
  return { doc: out, sel, on };
}

/** Is every selected character marked? (For toolbar state.) */
export function markActive(doc, sel, mark) {
  const segs = segments(doc, sel, { skipCode: true }).filter((g) => g.to > g.from);
  return segs.length > 0 && segs.every((g) => rangeEvery(doc[g.i].c, g.from, g.to, (r) => rMarks(r).includes(mark)));
}

/** The highlight colour shared by the whole selection, or null. */
export function hlActive(doc, sel) {
  const segs = segments(doc, sel, { skipCode: true }).filter((g) => g.to > g.from);
  let color;
  for (const g of segs) {
    let pos = 0;
    for (const r of doc[g.i].c) {
      const len = r[0].length;
      if (pos + len > g.from && pos < g.to) {
        const c = rAttrs(r)?.hl || null;
        if (color === undefined) color = c;
        else if (color !== c) return null;
      }
      pos += len;
    }
  }
  return color || null;
}

/** Highlight the selection in a colour, or remove highlights (color null). */
export function setHighlight(doc, sel, color) {
  if (isCollapsed(sel)) return null;
  const segs = segments(doc, sel, { skipCode: true }).filter((g) => g.to > g.from);
  if (!segs.length) return null;
  const out = doc.slice();
  for (const g of segs) {
    const b = out[g.i];
    out[g.i] = { ...b, c: mapRange(b.c, g.from, g.to, (r) => withAttr(r, 'hl', color || null)) };
  }
  return { doc: out, sel };
}

/**
 * Link the selection to a URL (href) or remove links (href null). With a collapsed caret inside a link,
 * the whole link is changed. A collapsed caret elsewhere inserts the URL as linked text.
 */
export function setLink(doc, sel, href, { key = 'href' } = {}) {
  if (isCollapsed(sel)) {
    const i = idx(doc, sel.f.id);
    const b = doc[i];
    if (!isText(b) || b.t === 'code') return null;
    const ext = linkExtent(b.c, sel.f.off);
    if (ext) {
      const c = mapRange(b.c, ext.from, ext.to, (r) => withAttr(withAttr(r, 'href', null), 'ref', null));
      const c2 = href ? mapRange(c, ext.from, ext.to, (r) => withAttr(r, key, href)) : c;
      return { doc: replaceAt(doc, i, { ...b, c: c2 }), sel };
    }
    if (!href || key !== 'href') return null;
    return insertRuns(doc, sel, [mkRun(href.replace(/^mailto:/, ''), '', { href })]);
  }
  const segs = segments(doc, sel, { skipCode: true }).filter((g) => g.to > g.from);
  if (!segs.length) return null;
  const out = doc.slice();
  for (const g of segs) {
    const b = out[g.i];
    out[g.i] = { ...b, c: mapRange(b.c, g.from, g.to, (r) => (href ? withAttr(r, key, href) : withAttr(withAttr(r, 'href', null), 'ref', null))) };
  }
  return { doc: out, sel };
}

/** Insert a chip (atom) for a ref, followed by a space. */
export function insertAtom(doc, sel, label, ref) {
  const runs = [mkRun(String(label || ref).replace(/\s+/g, ' ').trim() || ref, '', { ref, atom: 1 })];
  const r = insertRuns(doc, sel, runs);
  if (!r) return null;
  const i = idx(r.doc, r.sel.f.id);
  const b = r.doc[i];
  const next = blockText(b).charAt(r.sel.f.off);
  if (next === ' ') return { doc: r.doc, sel: caret(b.id, r.sel.f.off + 1) };
  return insertRuns(r.doc, r.sel, [[' ']]);
}

// ------------------------------------------------------------------ checklists

/** [start, end) of the contiguous checklist run around index i (or null). */
export function checkRun(doc, i) {
  if (!doc[i] || doc[i].t !== 'check') return null;
  let a = i;
  let b = i + 1;
  while (a > 0 && doc[a - 1].t === 'check') a--;
  while (b < doc.length && doc[b].t === 'check') b++;
  return [a, b];
}

/** End (exclusive) of item i's subtree: the following items in its run indented deeper. */
export function subtreeEnd(doc, i) {
  const b = doc[i];
  if (!LIST.has(b.t)) return i + 1;
  let j = i + 1;
  while (j < doc.length && LIST.has(doc[j].t) && (doc[j].in || 0) > (b.in || 0)) j++;
  return j;
}

/** Set check state for the given block ids. */
export function setChecked(doc, ids, value) {
  const set = new Set(ids);
  let changed = false;
  const out = doc.map((b) => {
    if (!set.has(b.id) || b.t !== 'check' || b.ck === value) return b;
    changed = true;
    return { ...b, ck: value };
  });
  return changed ? out : null;
}

/** Check-block ids touched by the selection. */
export function checkIdsIn(doc, sel) {
  const { s, e } = orderSel(doc, sel);
  const ids = [];
  for (let i = s.i; i <= e.i; i++) if (doc[i]?.t === 'check') ids.push(doc[i].id);
  return ids;
}

/** Items of the run around i (or every check item when i is not in a checklist). */
export function runIds(doc, i) {
  const r = checkRun(doc, i);
  const list = r ? doc.slice(r[0], r[1]) : doc.filter((b) => b.t === 'check');
  return list.map((b) => b.id);
}

/** Delete checked items of the run around i (or the whole note). */
export function deleteChecked(doc, i, sel) {
  const ids = new Set(runIds(doc, i).filter((id) => doc[idx(doc, id)].ck));
  if (!ids.size) return null;
  const out = doc.filter((b) => !ids.has(b.id));
  const fixed = ensureDoc(out);
  let s = sel;
  if (!s || ids.has(s.a.id) || ids.has(s.f.id)) {
    const k = Math.min(Math.max(0, i), fixed.length - 1);
    const t = isText(fixed[k]) ? k : nextText(fixed, k) ?? prevText(fixed, k) ?? 0;
    s = caret(fixed[t].id, 0);
  }
  return { doc: fixed, sel: s };
}

/** Sibling scope of item i inside its run: [lo, hi) bounded by the parent. */
function scopeOf(doc, i) {
  const [a, b] = checkRun(doc, i);
  const lvl = doc[i].in || 0;
  let lo = i;
  while (lo > a && (doc[lo - 1].in || 0) >= lvl) lo--;
  let hi = i + 1;
  while (hi < b && (doc[hi].in || 0) >= lvl) hi++;
  return [lo, hi, lvl];
}

/** Units (item + subtree) at level lvl inside [lo, hi). */
function unitsIn(doc, lo, hi, lvl) {
  const units = [];
  let k = lo;
  while (k < hi) {
    if ((doc[k].in || 0) === lvl) {
      const end = Math.min(hi, subtreeEnd(doc, k));
      units.push([k, end]);
      k = end;
    } else k++;
  }
  return units;
}

function moveSpan(doc, from, to, dest) {
  // Move doc[from..to) so it starts at index `dest` of the array without the span.
  const span = doc.slice(from, to);
  const rest = [...doc.slice(0, from), ...doc.slice(to)];
  return [...rest.slice(0, dest), ...span, ...rest.slice(dest)];
}

/**
 * Apple's automatic sort for one item: a checked item (with its subtree) moves to the end of its run of
 * siblings; an unchecked one moves back above the first checked sibling. Returns a new doc or null.
 */
export function autoSort(doc, id) {
  const i = idx(doc, id);
  if (i < 0 || doc[i].t !== 'check') return null;
  const [lo, hi, lvl] = scopeOf(doc, i);
  const units = unitsIn(doc, lo, hi, lvl);
  const me = units.findIndex((u) => u[0] === i);
  if (me < 0) return null;
  const [from, to] = units[me];
  if (doc[i].ck) {
    const lastEnd = units.at(-1)[1];
    if (to === lastEnd) return null;
    // After the last unit; the destination index is in the array without our span.
    return moveSpan(doc, from, to, lastEnd - (to - from));
  }
  const firstChecked = units.find((u, k) => k !== me && doc[u[0]].ck);
  if (!firstChecked || firstChecked[0] > from) return null;
  return moveSpan(doc, from, to, firstChecked[0]);
}

/** Move checked items to the bottom of every sibling group in the run around i (manual mode command). */
export function sortChecked(doc, i) {
  const r = checkRun(doc, i);
  if (!r) return null;
  const sortScope = (d, lo, hi, lvl) => {
    const units = unitsIn(d, lo, hi, lvl);
    const pieces = units.map(([a, b]) => {
      let block = d.slice(a, b);
      if (b - a > 1) {
        const inner = d.slice(a, b);
        const sub = sortScope(inner, 1, inner.length, (inner[0].in || 0) + 1);
        block = sub;
      }
      return { ck: d[a].ck, blocks: block };
    });
    const sorted = [...pieces.filter((p) => !p.ck), ...pieces.filter((p) => p.ck)];
    return [...d.slice(0, lo), ...sorted.flatMap((p) => p.blocks), ...d.slice(hi)];
  };
  const minIn = Math.min(...doc.slice(r[0], r[1]).map((b) => b.in || 0));
  const out = sortScope(doc, r[0], r[1], minIn);
  return out.every((b, k) => b === doc[k]) ? null : out;
}

/**
 * Move the selected block(s) (with their list subtree) up or down past the neighbouring unit.
 * Returns {doc, sel} or null.
 */
export function moveBlocks(doc, sel, dir) {
  const { s, e } = orderSel(doc, sel);
  const from = s.i;
  const to = Math.max(subtreeEnd(doc, e.i), e.i + 1);
  const lvl = LIST.has(doc[from].t) ? doc[from].in || 0 : 0;
  if (dir < 0) {
    if (from === 0) return null;
    let j = from - 1;
    // Jump over a deeper subtree of the previous sibling to land above that sibling.
    while (j > 0 && LIST.has(doc[j].t) && LIST.has(doc[from].t) && (doc[j].in || 0) > lvl) j--;
    return { doc: moveSpan(doc, from, to, j), sel };
  }
  if (to >= doc.length) return null;
  const nextEnd = Math.max(subtreeEnd(doc, to), to + 1);
  return { doc: moveSpan(doc, from, to, nextEnd - (to - from)), sel };
}

/** Move a unit [from, to) so it lands before block index `before` (drag and drop). */
export function moveUnitTo(doc, from, to, before) {
  if (before >= from && before <= to) return null;
  const dest = before > to ? before - (to - from) : before;
  return moveSpan(doc, from, to, dest);
}

// ------------------------------------------------------------------ paste

/**
 * Insert pasted blocks at the selection as one change. One block merges inline (an empty target block
 * takes its type); several split the target block around them.
 */
export function insertFragment(doc, sel, frag, opts) {
  if (!frag.length) return null;
  const base = isCollapsed(sel) ? { doc, sel } : deleteRange(doc, sel, opts) || { doc, sel };
  const d = base.doc;
  const p = base.sel.f;
  const i = idx(d, p.id);
  const b = d[i];
  if (!isText(b)) return null;
  const used = idsOf(d);
  const fresh = frag.map((x) => {
    const nb = { ...x, id: used.has(x.id) ? newId(used) : (used.add(x.id), x.id) };
    if (nb.t === 'check') delete nb.task; // a pasted copy is not the same task
    return nb;
  });
  if (b.t === 'code') {
    const text = fresh.map((x) => (isText(x) ? blockText(x) : '---')).join('\n');
    return insertRuns(d, base.sel, [[text]]);
  }
  const len = blockLen(b);
  if (fresh.length === 1 && isText(fresh[0])) {
    const f = fresh[0];
    if (len === 0 && f.t !== b.t) {
      const nb = { ...f, id: b.id };
      return { doc: replaceAt(d, i, nb), sel: caret(b.id, blockLen(nb)) };
    }
    return insertRuns(d, base.sel, f.t === 'code' ? [[blockText(f)]] : f.c);
  }
  const [left, right] = splitRuns(b.c, p.off);
  const out = [];
  const first = fresh[0];
  let rest = fresh.slice(1);
  if (isText(first)) {
    if (len === 0) out.push({ ...first, id: b.id });
    else out.push({ ...b, c: first.t === 'code' ? mergeRuns([...left, ...normRuns([[blockText(first)]])]) : mergeRuns([...left, ...first.c]) });
  } else {
    if (left.length || len === 0) out.push({ ...b, c: left });
    rest = fresh;
  }
  out.push(...rest);
  // The remainder of the split block joins the last pasted block (or becomes its own block).
  let caretAt;
  const last = out[out.length - 1];
  if (right.length) {
    if (isText(last) && last !== out[0]) {
      caretAt = { id: last.id, off: blockLen(last) };
      out[out.length - 1] = { ...last, c: last.t === 'code' ? codeRuns(blockText(last) + textOf(right)) : mergeRuns([...last.c, ...right]) };
    } else {
      const tail = { ...b, id: newId(used), c: right };
      if (tail.t === 'check') delete tail.task;
      out.push(tail);
      caretAt = { id: tail.id, off: 0 };
    }
  } else {
    const t = isText(last) ? last : null;
    caretAt = t ? { id: t.id, off: blockLen(t) } : null;
  }
  const result = ensureDoc([...d.slice(0, i), ...out, ...d.slice(i + 1)]);
  if (!caretAt) {
    const k = idx(result, out[out.length - 1].id);
    const t = nextText(result, k) ?? k;
    caretAt = { id: result[t].id, off: 0 };
  }
  return { doc: result, sel: { a: caretAt, f: caretAt } };
}

export { segments, toP };
