// notes editor: DOM → model. Reads a block element back into runs (reconcile), and maps DOM points
// to model offsets and back. Leaves are text nodes, <br> (one "\n") and chips (their cached label).
// Subtrees marked data-deco (checkbox, task info) are never read. A <br> with no text after it is the
// trailing sentinel and is ignored.

import { normRuns, isRef, HL_COLORS, blockLen } from './model.js';

const isDeco = (n) => n.nodeType === 1 && n.hasAttribute('data-deco');
const isChip = (n) => n.nodeType === 1 && n.classList.contains('ne-chip');
const chipLen = (n) => (n.dataset.label || '').length;

const MARK_TAGS = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', U: 'u', INS: 'u', S: 's', DEL: 's', STRIKE: 's', CODE: 'c' };
const KNOWN = new Set(['STRONG', 'EM', 'U', 'S', 'CODE', 'MARK', 'A', 'BR', 'DIV', 'SPAN']);

/**
 * Read a block element's text back into runs.
 * Returns {runs, dirty} — dirty when the DOM holds something the renderer would never produce
 * (browser-inserted spans/fonts/blocks, text outside the text container), so the block is re-rendered.
 */
export function readRuns(el, { code = false } = {}) {
  const out = [];
  let dirty = false;
  let lastLeaf = null;
  const push = (text, marks, attrs) => {
    out.push([text, marks, attrs]);
  };
  const walk = (node, marks, attrs, inTx) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        const t = ch.data.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '');
        if (t !== ch.data) dirty = true;
        if (!inTx && t) dirty = true;
        if (t) {
          push(t, marks, attrs);
          lastLeaf = 'text';
        }
        continue;
      }
      if (ch.nodeType !== 1) continue;
      if (isDeco(ch)) continue;
      const tag = ch.tagName;
      if (tag === 'BR') {
        push('\n', marks, attrs);
        lastLeaf = 'br';
        continue;
      }
      if (isChip(ch)) {
        const ref = ch.dataset.ref;
        const label = ch.dataset.label;
        if (isRef(ref) && label) {
          const a = { ref, atom: 1 };
          if (ch.dataset.hl && HL_COLORS.includes(ch.dataset.hl)) a.hl = ch.dataset.hl;
          push(label, '', a);
          lastLeaf = 'chip';
        }
        continue;
      }
      let m = marks;
      let a = attrs;
      if (MARK_TAGS[tag]) m += MARK_TAGS[tag];
      else if (tag === 'MARK') a = { ...(a || {}), hl: HL_COLORS.includes(ch.dataset.hl) ? ch.dataset.hl : 'purple' };
      else if (tag === 'A') {
        if (ch.dataset.ref) a = { ...(a || {}), ref: ch.dataset.ref };
        else if (ch.getAttribute('href')) a = { ...(a || {}), href: ch.getAttribute('href') };
      } else if (tag === 'DIV' && ch.classList.contains('ne-tx')) {
        walk(ch, m, a, true);
        continue;
      } else if (tag === 'DIV' || tag === 'P') {
        // A browser-inserted line inside a block: keep its text on a new line.
        dirty = true;
        if (out.length && lastLeaf !== 'br') push('\n', marks, attrs);
      } else if (!KNOWN.has(tag) || tag === 'SPAN') dirty = true;
      if (tag === 'B' || tag === 'I' || tag === 'DEL' || tag === 'STRIKE' || tag === 'INS') dirty = true;
      walk(ch, m, a, inTx);
    }
  };
  walk(el, '', null, false);
  if (lastLeaf === 'br' && out.length) {
    const last = out[out.length - 1];
    if (last[0].endsWith('\n')) last[0] = last[0].slice(0, -1);
  }
  return { runs: normRuns(out, { code }), dirty };
}

// ------------------------------------------------------------------ offsets

function lenOf(n) {
  if (n.nodeType === 3) return n.data.length;
  if (n.nodeType !== 1 || isDeco(n)) return 0;
  if (n.tagName === 'BR') return 1;
  if (isChip(n)) return chipLen(n);
  let s = 0;
  for (const c of n.childNodes) s += lenOf(c);
  return s;
}

/** Model offset of a DOM point inside block element `el` (clamped to the block length). */
export function offsetIn(el, node, offset, block) {
  if (!el.contains(node)) return 0;
  let total = 0;
  const visit = (n) => {
    if (n === node) {
      if (n.nodeType === 3) {
        total += Math.min(offset, n.data.length);
        return true;
      }
      if (isChip(n)) {
        if (offset > 0) total += chipLen(n);
        return true;
      }
      if (isDeco(n)) return true;
      const kids = n.childNodes;
      for (let k = 0; k < offset && k < kids.length; k++) total += lenOf(kids[k]);
      return true;
    }
    if (n.nodeType === 3) {
      total += n.data.length;
      return false;
    }
    if (n.nodeType !== 1) return false;
    if (isDeco(n)) return n.contains(node);
    if (n.tagName === 'BR') {
      total += 1;
      return false;
    }
    if (isChip(n)) {
      if (n.contains(node)) {
        total += chipLen(n);
        return true;
      }
      total += chipLen(n);
      return false;
    }
    for (const c of n.childNodes) if (visit(c)) return true;
    return false;
  };
  visit(el);
  const max = block ? blockLen(block) : total;
  return Math.max(0, Math.min(total, max));
}

/** DOM point for a model offset in block element `el`. At a format boundary the earlier text node wins. */
export function pointAt(el, off) {
  let acc = 0;
  let res = null;
  const visit = (n) => {
    const kids = n.childNodes;
    for (let k = 0; k < kids.length; k++) {
      const ch = kids[k];
      if (ch.nodeType === 3) {
        const L = ch.data.length;
        if (off <= acc + L) {
          res = { node: ch, offset: off - acc };
          return true;
        }
        acc += L;
        continue;
      }
      if (ch.nodeType !== 1 || isDeco(ch)) continue;
      if (ch.tagName === 'BR') {
        if (off === acc) {
          // Before the line break, and before a task label just ahead of it: typing lands in the text.
          let j = k;
          while (j > 0 && isDeco(kids[j - 1])) j--;
          res = { node: n, offset: j };
          return true;
        }
        acc += 1;
        continue;
      }
      if (isChip(ch)) {
        const L = chipLen(ch);
        if (off === acc) {
          res = { node: n, offset: k };
          return true;
        }
        if (off < acc + L) {
          res = { node: n, offset: k + 1 };
          return true;
        }
        acc += L;
        continue;
      }
      if (visit(ch)) return true;
    }
    return false;
  };
  const tx = el.querySelector(':scope > .ne-tx') || el;
  if (visit(tx)) return res;
  // Past the end: before any trailing decoration (and the end <br> after it).
  let k = tx.childNodes.length;
  while (k > 0 && (isDeco(tx.childNodes[k - 1]) || isEndBr(tx.childNodes[k - 1]))) k--;
  return { node: tx, offset: k };
}

const isEndBr = (n) => n.nodeType === 1 && n.tagName === 'BR' && n.classList.contains('ne-end');

/**
 * Is a DOM point right after a non-editable decoration (a task label) in a block's text? Chrome puts the
 * caret there for a click right of the line, ArrowRight or End; what the browser would do from there
 * (Backspace deletes the label, typing lands after it) goes through the model instead.
 */
export function afterDeco(node, offset) {
  if (!node || node.nodeType !== 1 || !node.classList?.contains('ne-tx')) return false;
  const prev = node.childNodes[offset - 1];
  return !!prev && isDeco(prev);
}

/** The block element (direct child of root) holding a node. */
export function blockElOf(root, node) {
  let n = node && node.nodeType === 3 ? node.parentNode : node;
  while (n && n !== root) {
    if (n.parentNode === root && n.nodeType === 1 && n.classList.contains('ne-b')) return n;
    n = n.parentNode;
  }
  return null;
}

/** Model position for a DOM point (or null outside the editor). */
export function pointToModel(root, node, offset, blockOf) {
  if (!node || !root.contains(node)) return null;
  if (node === root) {
    const kids = [...root.children].filter((c) => c.classList.contains('ne-b'));
    if (!kids.length) return null;
    if (offset < kids.length) {
      const el = kids[offset];
      return { id: el.dataset.id, off: 0, hr: el.dataset.type === 'hr' };
    }
    const el = kids[kids.length - 1];
    const b = blockOf(el.dataset.id);
    return { id: el.dataset.id, off: b ? blockLen(b) : 0, hr: el.dataset.type === 'hr' };
  }
  const el = blockElOf(root, node);
  if (!el) return null;
  const id = el.dataset.id;
  if (el.dataset.type === 'hr') return { id, off: 0, hr: true };
  return { id, off: offsetIn(el, node, offset, blockOf(id)) };
}

/** Read the live DOM selection into model terms. */
export function readSelection(root, blockOf) {
  const s = root.ownerDocument.getSelection();
  if (!s || !s.rangeCount) return null;
  const a = pointToModel(root, s.anchorNode, s.anchorOffset, blockOf);
  const f = pointToModel(root, s.focusNode, s.focusOffset, blockOf);
  if (!a || !f) return null;
  return { a, f };
}

/** Apply a model selection to the DOM (skipped when it already matches: avoids iOS handle flicker). */
export function writeSelection(root, els, sel) {
  const ea = els.get(sel.a.id);
  const ef = els.get(sel.f.id);
  if (!ea || !ef) return false;
  const A = pointAt(ea, sel.a.off);
  const F = pointAt(ef, sel.f.off);
  const s = root.ownerDocument.getSelection();
  if (!s) return false;
  if (s.rangeCount && s.anchorNode === A.node && s.anchorOffset === A.offset && s.focusNode === F.node && s.focusOffset === F.offset) return true;
  try {
    s.setBaseAndExtent(A.node, A.offset, F.node, F.offset);
  } catch {
    return false;
  }
  return true;
}

/** A DOM Range covering [from, to) of a block. */
export function rangeIn(el, from, to) {
  const A = pointAt(el, from);
  const B = pointAt(el, to);
  const r = el.ownerDocument.createRange();
  try {
    r.setStart(A.node, A.offset);
    r.setEnd(B.node, B.offset);
  } catch {
    return null;
  }
  return r;
}

/** Client rect of a caret position (falls back to the block's line box for empty blocks). */
export function caretRect(el, off) {
  const r = rangeIn(el, off, off);
  if (r) {
    const rects = r.getClientRects();
    if (rects.length) return rects[rects.length - 1];
    const b = r.getBoundingClientRect();
    if (b.height) return b;
  }
  const tx = el.querySelector(':scope > .ne-tx') || el;
  const box = tx.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(tx).lineHeight) || 24;
  return { left: box.left, right: box.left, top: box.top, bottom: box.top + lh, width: 0, height: lh, x: box.left, y: box.top };
}

/** Caret position from a viewport point (drop target, clicks). */
export function caretFromPoint(doc, x, y) {
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

/**
 * Is the live DOM of a block exactly what the renderer would produce for it? Adjacent text nodes are
 * compared as one; decorations are compared by tag only.
 */
export function sameShape(live, fresh) {
  const norm = (n) => {
    const out = [];
    for (const c of n.childNodes) {
      if (c.nodeType === 3) {
        if (!c.data) continue;
        const last = out[out.length - 1];
        if (last && last.text !== undefined) last.text += c.data;
        else out.push({ text: c.data });
      } else if (c.nodeType === 1) out.push({ el: c });
    }
    return out;
  };
  const eq = (a, b) => {
    const x = norm(a);
    const y = norm(b);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      const p = x[i];
      const q = y[i];
      if (p.text !== undefined || q.text !== undefined) {
        if (p.text !== q.text) return false;
        continue;
      }
      if (p.el.tagName !== q.el.tagName) return false;
      if (isDeco(p.el) || isChip(p.el)) {
        if (isChip(p.el) !== isChip(q.el)) return false;
        if (isChip(p.el) && (p.el.dataset.ref !== q.el.dataset.ref || p.el.dataset.label !== q.el.dataset.label)) return false;
        continue;
      }
      if (p.el.attributes.length !== q.el.attributes.length) return false;
      for (const at of q.el.attributes) if (p.el.getAttribute(at.name) !== at.value) return false;
      if (!eq(p.el, q.el)) return false;
    }
    return true;
  };
  return eq(live, fresh);
}
