// notes editor: the blocks model (pure — no DOM). Blocks JSON is canonical (notes-spec §4).
//
// block: { id, t, in?, ck?, task?, start?, lang?, fold?, c: [run…] }   (hr: { id, t:'hr' })
// run:   [text] | [text, marks] | [text, marks, attrs]
//        marks ⊆ 'biusc' in that order; attrs ⊆ { href, hl, ref, atom:1 }
// Offsets are UTF-16 code units. An atom (chip) counts as its cached label and is never split.
// Blocks are treated as immutable: every change makes new block objects, so an undo snapshot is just
// the previous array.

import { cleanHref, isYmd } from '../../shared/sanitize.js';

export const MARKS = 'biusc';
export const HL_COLORS = ['purple', 'pink', 'orange', 'mint', 'blue'];
export const TYPES = ['p', 'h1', 'h2', 'h3', 'bullet', 'dash', 'num', 'check', 'quote', 'code', 'hr'];
const TYPE_SET = new Set(TYPES);
export const LIST = new Set(['bullet', 'dash', 'num', 'check']);
export const HEADINGS = new Set(['h1', 'h2', 'h3']);
export const MAX_IN = 6;
export const MAX_BLOCKS = 5000;
export const MAX_TEXT = 20000;
export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// The one name table for block types, in sentence case: the slash menu, Turn into, the Aa panel, the shortcuts
// sheet, the docs and what a screen reader hears all say the same words.
export const TYPE_NAMES = {
  h1: 'Title', h2: 'Heading', h3: 'Subheading', p: 'Body', code: 'Code block', quote: 'Quote',
  bullet: 'Bulleted list', dash: 'Dashed list', num: 'Numbered list', check: 'Checklist', hr: 'Divider',
};

// ------------------------------------------------------------------ text & attrs

// C0 controls except \t and \n, plus DEL. \r is folded into \n first.
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

export function cleanText(s, { code = false } = {}) {
  let t = String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(CTRL, '');
  if (!code) t = t.replace(/\t/g, ' ');
  return t;
}

const OK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
/** A link target the editor will store: http(s), mailto or tel, checked on the WHATWG-parsed protocol. */
export function safeHref(s) {
  if (typeof s !== 'string') return null;
  const raw = s.replace(BIDI, '').trim();
  if (!raw || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!OK_PROTOCOLS.has(u.protocol)) return null;
  const href = u.href;
  if (href.length > 2048) return null;
  if (u.protocol !== 'tel:' && !cleanHref(href)) return null; // the shared allowlist agrees
  return href;
}

/** What a person typed into a link field → a safe href ('example.com' → https://example.com/). */
export function hrefFromInput(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const direct = safeHref(t);
  if (direct) return direct;
  if (/^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i.test(t)) return safeHref(`mailto:${t}`);
  if (/^(?:[\w-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i.test(t)) return safeHref(`https://${t}`);
  return null;
}

/** The host a link points to, for the anti-phishing caption. */
export function hrefHost(href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'mailto:') return u.pathname;
    if (u.protocol === 'tel:') return u.pathname;
    return u.host;
  } catch {
    return '';
  }
}

const RID = '[A-Za-z0-9_-]{1,40}';
const REF_RE = new RegExp(`^(?:note:${RID}(?:#${RID})?|task:${RID}|event:${RID}(?:@(\\d{4}-\\d{2}-\\d{2}))?|day:(\\d{4}-\\d{2}-\\d{2}))$`);
/** Ref grammar: note:<id>[#<blockId>] · task:<id> · event:<id>[@YYYY-MM-DD] · day:YYYY-MM-DD */
export function isRef(s) {
  if (typeof s !== 'string') return false;
  const m = REF_RE.exec(s);
  if (!m) return false;
  if (m[1] && !isYmd(m[1])) return false;
  if (m[2] && !isYmd(m[2])) return false;
  return true;
}
export const refKind = (ref) => String(ref || '').split(':')[0];
export const refId = (ref) => String(ref || '').slice(String(ref || '').indexOf(':') + 1).split(/[#@]/)[0];

export function normMarks(m) {
  const s = typeof m === 'string' ? m : '';
  let out = '';
  for (const c of MARKS) if (s.includes(c)) out += c;
  return out;
}

export function cleanAttrs(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out = {};
  if (a.ref != null && isRef(a.ref)) out.ref = a.ref;
  if (!out.ref && a.href != null) {
    const h = safeHref(String(a.href));
    if (h) out.href = h;
  }
  if (a.hl != null && HL_COLORS.includes(a.hl)) out.hl = a.hl;
  if (out.ref && (a.atom === 1 || a.atom === true)) out.atom = 1;
  return Object.keys(out).length ? out : null;
}

// ------------------------------------------------------------------ runs

export const rText = (r) => r[0];
export const rMarks = (r) => r[1] || '';
export const rAttrs = (r) => r[2] || null;
export const isAtom = (r) => !!(r && r[2] && r[2].atom);

/** A run. Marks are always stored in canonical 'biusc' order, so equal formatting compares equal. */
export function mkRun(text, marks = '', attrs = null) {
  const a = attrs && Object.keys(attrs).length ? attrs : null;
  const m = marks ? normMarks(marks) : '';
  if (a) return [text, m, a];
  if (m) return [text, m];
  return [text];
}

export function sameAttrs(a, b) {
  const x = a || null;
  const y = b || null;
  if (x === y) return true;
  if (!x || !y) return false;
  return x.href === y.href && x.hl === y.hl && x.ref === y.ref && !!x.atom === !!y.atom;
}
export const sameFmt = (x, y) => rMarks(x) === rMarks(y) && sameAttrs(rAttrs(x), rAttrs(y));

/** Merge adjacent runs with the same format and drop empty ones (no text cleaning). */
export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r || !r[0]) continue;
    const last = out[out.length - 1];
    if (last && !isAtom(last) && !isAtom(r) && sameFmt(last, r)) out[out.length - 1] = mkRun(last[0] + r[0], r[1], r[2]);
    else out.push(r);
  }
  return out;
}

/** Untrusted runs → canonical runs: cleaned text, canonical marks, checked attrs, merged. */
export function normRuns(runs, { code = false } = {}) {
  if (!Array.isArray(runs)) return [];
  const out = [];
  for (const raw of runs) {
    const r = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(r)) continue;
    let text = cleanText(r[0], { code });
    if (!text) continue;
    let marks = code ? '' : normMarks(r[1]);
    const attrs = code ? null : cleanAttrs(r[2]);
    if (attrs?.atom) {
      marks = '';
      text = text.replace(/\n/g, ' ');
    }
    out.push(mkRun(text, marks, attrs));
  }
  const merged = mergeRuns(out);
  if (code && merged.length > 1) return [[merged.map(rText).join('')]];
  return merged;
}

/** Plain code-block content: one unmarked run. */
export const codeRuns = (text) => (text ? [[text]] : []);

export const runsLen = (runs) => {
  let n = 0;
  for (const r of runs) n += r[0].length;
  return n;
};
export const runsText = (runs) => runs.map((r) => r[0]).join('');
export const isText = (b) => !!b && b.t !== 'hr';
export const blockText = (b) => (b && b.c ? runsText(b.c) : '');
export const blockLen = (b) => (b && b.c ? runsLen(b.c) : 0);

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
/** Never split a surrogate pair: an offset between the halves moves past the pair. */
export function fixOff(text, off) {
  if (off > 0 && off < text.length && isHigh(text.charCodeAt(off - 1)) && isLow(text.charCodeAt(off))) return off + 1;
  return off;
}

/** Split runs at a text offset → [left, right]. An offset inside an atom keeps the atom on the left. */
export function splitRuns(runs, off) {
  const left = [];
  const right = [];
  let pos = 0;
  for (const r of runs) {
    const len = r[0].length;
    if (pos + len <= off) left.push(r);
    else if (pos >= off) right.push(r);
    else if (isAtom(r)) left.push(r);
    else {
      const k = fixOff(r[0], off - pos);
      if (k > 0) left.push(mkRun(r[0].slice(0, k), r[1], r[2]));
      if (k < len) right.push(mkRun(r[0].slice(k), r[1], r[2]));
    }
    pos += len;
  }
  return [left, right];
}

export const sliceRuns = (runs, from, to) => splitRuns(splitRuns(runs, to)[0], from)[1];

/** Replace [from, to) with `ins` runs. */
export function spliceRuns(runs, from, to, ins = []) {
  const [a] = splitRuns(runs, from);
  const [, b] = splitRuns(runs, to);
  return mergeRuns([...a, ...ins, ...b]);
}

/** Apply fn to every run part inside [from, to). */
export function mapRange(runs, from, to, fn) {
  if (to <= from) return runs;
  const [a, rest] = splitRuns(runs, from);
  const [mid, b] = splitRuns(rest, to - from);
  return mergeRuns([...a, ...mid.map(fn), ...b]);
}

export const addMark = (r, m) => (isAtom(r) ? r : mkRun(r[0], normMarks(rMarks(r) + m), r[2]));
export const delMark = (r, m) => mkRun(r[0], rMarks(r).replace(m, ''), r[2]);
export function withAttr(r, key, value) {
  if (isAtom(r) && key !== 'hl') return r;
  const a = { ...(r[2] || {}) };
  if (value == null) delete a[key];
  else a[key] = value;
  if (key === 'href' && value) delete a.ref;
  if (key === 'ref' && value) delete a.href;
  if (!a.ref) delete a.atom;
  return mkRun(r[0], r[1], Object.keys(a).length ? a : null);
}

/** True when every non-atom character in [from, to) satisfies pred (false for an empty range). */
export function rangeEvery(runs, from, to, pred) {
  let any = false;
  let pos = 0;
  for (const r of runs) {
    const len = r[0].length;
    const s = Math.max(pos, from);
    const e = Math.min(pos + len, to);
    if (e > s && !isAtom(r)) {
      any = true;
      if (!pred(r)) return false;
    }
    pos += len;
    if (pos >= to) break;
  }
  return any;
}

/** The run that holds the character before `off` (or after, at offset 0), with its start offset. */
export function runAt(runs, off, { after = false } = {}) {
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const len = runs[i][0].length;
    if (after ? off >= pos && off < pos + len : off > pos && off <= pos + len) return { run: runs[i], i, start: pos };
    pos += len;
  }
  if (!after && off === 0 && runs.length) return { run: runs[0], i: 0, start: 0, edge: true };
  return null;
}

/** The format typing continues with at `off`: marks and highlight of the run before; links and chips never extend. */
export function typingFormat(runs, off) {
  const at = runAt(runs, off);
  if (!at) return { marks: '', attrs: null };
  const r = at.run;
  if (isAtom(r)) return { marks: '', attrs: null };
  const a = r[2];
  return { marks: rMarks(r), attrs: a && a.hl ? { hl: a.hl } : null };
}

/** [from, to) of the link (href, or a non-chip ref) around `off`, or null. */
export function linkExtent(runs, off) {
  const spans = [];
  let pos = 0;
  for (const r of runs) {
    spans.push({ r, s: pos, e: pos + r[0].length });
    pos += r[0].length;
  }
  const key = (r) => (r[2] && !r[2].atom ? r[2].href || r[2].ref || null : null);
  let k = spans.findIndex((x) => key(x.r) && off > x.s && off < x.e);
  if (k < 0) k = spans.findIndex((x) => key(x.r) && (off === x.s || off === x.e));
  if (k < 0) return null;
  const v = key(spans[k].r);
  let a = k;
  let b = k;
  while (a > 0 && key(spans[a - 1].r) === v) a--;
  while (b < spans.length - 1 && key(spans[b + 1].r) === v) b++;
  const r = spans[k].r[2];
  return { from: spans[a].s, to: spans[b].e, href: r.href || null, ref: r.ref || null };
}

/** [from, to) of the atom at `off` (either edge counts when `edge`), or null. */
export function atomAround(runs, off, dir) {
  let pos = 0;
  for (const r of runs) {
    const len = r[0].length;
    if (isAtom(r)) {
      if (dir < 0 && off === pos + len) return { from: pos, to: pos + len, run: r };
      if (dir > 0 && off === pos) return { from: pos, to: pos + len, run: r };
      if (off > pos && off < pos + len) return { from: pos, to: pos + len, run: r };
    }
    pos += len;
  }
  return null;
}

/** Text with atoms, inline code and links masked out (for tag / wiki-link detection). */
export function maskedText(runs) {
  let s = '';
  for (const r of runs) {
    const a = r[2];
    const mask = (a && (a.atom || a.href || a.ref)) || rMarks(r).includes('c');
    s += mask ? '\u0000'.repeat(r[0].length) : r[0];
  }
  return s;
}

// ------------------------------------------------------------------ #tags
// The rules of notes/core/schema.js, which derives the tags the sidebar and search use: '#', then a
// letter, digit or _, then letters, combining marks (Devanagari vowel signs, Arabic harakat, decomposed
// accents), digits, _, - and / (nested tags). Never right after a letter, mark, digit, _, &, / or #, so
// "C#", "&#38;" and URL fragments stay text.

const TAG_SRC = '(?<![\\p{L}\\p{M}\\p{N}_&/#])#([\\p{L}\\p{N}_][\\p{L}\\p{M}\\p{N}_\\-/]*)';
const TAG_ALL_RE = new RegExp(TAG_SRC, 'gu'); // matchAll() works on a copy: no shared lastIndex
const TAG_END_RE = new RegExp(`${TAG_SRC}$`, 'u');
const TAG_BODY_RE = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_\-/]*$/u;
const HAS_LETTER_RE = /\p{L}/u;

/** #tags in (masked) text: [{start, end, tag}]. end leaves out a trailing / or -; a tag needs a letter. */
export function tagSpans(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('#')) return out;
  for (const m of text.matchAll(TAG_ALL_RE)) {
    const tag = m[1].replace(/[/-]+$/, '');
    if (tag && HAS_LETTER_RE.test(tag)) out.push({ start: m.index, end: m.index + 1 + tag.length, tag });
  }
  return out;
}

/** The #tag that `text` ends with: {start (of the '#'), body (what follows it)}, or null. */
export function tagAtEnd(text) {
  const m = TAG_END_RE.exec(typeof text === 'string' ? text : '');
  return m ? { start: m.index, body: m[1] } : null;
}

/** Can `q`, typed after a '#', still be (the start of) a tag? */
export const isTagBody = (q) => typeof q === 'string' && TAG_BODY_RE.test(q);

/**
 * A tag name typed into a field ('#My topic!') → the tag text ('My-topic'): no leading '#', spaces
 * become '-', only what a tag can hold, never starting with a mark, - or /, no trailing / or -.
 * '' when nothing is left. The case is kept (tags match case-insensitively).
 */
export function tagFromInput(s) {
  return String(s ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{M}\p{N}_\-/]/gu, '')
    .replace(/^[\p{M}\-/]+/u, '')
    .replace(/[/-]+$/, '');
}

// ------------------------------------------------------------------ ids & blocks

const ALPH = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function newId(used) {
  for (;;) {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    let s = '';
    for (const x of b) s += ALPH[x % 36];
    if (!used || !used.has(s)) {
      used?.add(s);
      return s;
    }
  }
}
export const idsOf = (doc) => new Set(doc.map((b) => b.id));

const clampIn = (v) => (Number.isInteger(v) ? Math.min(MAX_IN, Math.max(0, v)) : 0);

/** A new block. `fields` may carry in / ck / start / lang. */
export function newBlock(t = 'p', used = null, fields = {}, c = []) {
  const b = { id: newId(used), t };
  if (t === 'hr') return b;
  if (LIST.has(t)) b.in = clampIn(fields.in);
  if (t === 'check') b.ck = fields.ck === true;
  if (t === 'num' && Number.isInteger(fields.start) && fields.start !== 1 && fields.start >= 0) b.start = fields.start;
  if (t === 'code' && typeof fields.lang === 'string' && /^[\w+-]{1,20}$/.test(fields.lang)) b.lang = fields.lang;
  b.c = c;
  return b;
}

/** Change a block's type, keeping its id and text (and indent / check state where they still apply). */
export function retype(b, t, fields = {}) {
  if (t === 'hr') return { id: b.id, t: 'hr' };
  const out = { id: b.id, t };
  if (LIST.has(t)) out.in = clampIn(fields.in ?? (LIST.has(b.t) ? b.in : 0));
  if (t === 'check') {
    out.ck = fields.ck ?? (b.t === 'check' ? b.ck === true : false);
    if (b.t === 'check' && b.task) out.task = b.task;
  }
  if (t === 'num') {
    const s = fields.start ?? (b.t === 'num' ? b.start : undefined);
    if (Number.isInteger(s) && s !== 1 && s >= 0) out.start = s;
  }
  if (t === 'code') {
    const lang = fields.lang ?? (b.t === 'code' ? b.lang : undefined);
    if (typeof lang === 'string' && /^[\w+-]{1,20}$/.test(lang)) out.lang = lang;
  }
  if (HEADINGS.has(t) && b.fold === true && HEADINGS.has(b.t)) out.fold = true;
  out.c = t === 'code' ? codeRuns(blockText(b)) : b.t === 'code' ? normRuns([[blockText(b)]]) : b.c || [];
  return out;
}

function limitRuns(runs) {
  let n = 0;
  const out = [];
  for (const r of runs) {
    if (n >= MAX_TEXT) break;
    if (n + r[0].length > MAX_TEXT) {
      if (isAtom(r)) break;
      out.push(mkRun(r[0].slice(0, fixOff(r[0], MAX_TEXT - n)), r[1], r[2]));
      break;
    }
    out.push(r);
    n += r[0].length;
  }
  return out;
}

/** Untrusted block → canonical block (or null). `used` collects ids so they stay unique. */
export function normBlock(b, used) {
  if (!b || typeof b !== 'object') return null;
  const id = typeof b.id === 'string' && ID_RE.test(b.id) && !used.has(b.id) ? b.id : newId(used);
  used.add(id);
  const t = TYPE_SET.has(b.t) ? b.t : 'p';
  if (t === 'hr') return { id, t };
  const out = { id, t };
  if (LIST.has(t)) out.in = clampIn(b.in);
  if (t === 'check') {
    out.ck = b.ck === true;
    if (typeof b.task === 'string' && ID_RE.test(b.task)) out.task = b.task;
  }
  if (t === 'num' && Number.isInteger(b.start) && b.start >= 0 && b.start <= 999999999 && b.start !== 1) out.start = b.start;
  if (t === 'code' && typeof b.lang === 'string' && /^[\w+-]{1,20}$/.test(b.lang)) out.lang = b.lang;
  if (HEADINGS.has(t) && b.fold === true) out.fold = true;
  out.c = limitRuns(normRuns(b.c, { code: t === 'code' }));
  return out;
}

/** Keep the document editable: never empty, a text block after every divider and at the end. */
export function ensureDoc(doc, { emptyType = 'p' } = {}) {
  if (!doc.length) return [newBlock(emptyType)];
  let used = null;
  const out = [];
  for (let i = 0; i < doc.length; i++) {
    out.push(doc[i]);
    if (doc[i].t === 'hr' && (i === doc.length - 1 || doc[i + 1].t === 'hr')) {
      used ??= idsOf(doc);
      out.push(newBlock('p', used));
    }
  }
  return out;
}

export function normDoc(blocks, opts) {
  const used = new Set();
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (out.length >= MAX_BLOCKS) break;
    const n = normBlock(b, used);
    if (n) out.push(n);
  }
  return ensureDoc(out, opts);
}

// ------------------------------------------------------------------ positions & selection

const IDX = new WeakMap();
/** Index of a block id in a doc array (cached per array — docs are immutable). */
export function idx(doc, id) {
  let m = IDX.get(doc);
  if (!m) {
    m = new Map();
    for (let i = 0; i < doc.length; i++) m.set(doc[i].id, i);
    IDX.set(doc, m);
  }
  return m.get(id) ?? -1;
}

export const caret = (id, off) => ({ a: { id, off }, f: { id, off } });
export const isCollapsed = (sel) => !!sel && sel.a.id === sel.f.id && sel.a.off === sel.f.off;
export const sameSel = (x, y) => !!x && !!y && x.a.id === y.a.id && x.a.off === y.a.off && x.f.id === y.f.id && x.f.off === y.f.off;

/** Selection → ordered {s:{i,off}, e:{i,off}, fwd}. */
export function orderSel(doc, sel) {
  const ai = idx(doc, sel.a.id);
  const fi = idx(doc, sel.f.id);
  const fwd = ai < fi || (ai === fi && sel.a.off <= sel.f.off);
  return fwd ? { s: { i: ai, off: sel.a.off }, e: { i: fi, off: sel.f.off }, fwd } : { s: { i: fi, off: sel.f.off }, e: { i: ai, off: sel.a.off }, fwd };
}

/** Clamp a selection to the doc (missing blocks → nearest text block). */
export function clampSel(doc, sel, fallbackIndex = 0) {
  const fix = (p) => {
    let i = p ? idx(doc, p.id) : -1;
    if (i < 0) i = Math.min(Math.max(0, fallbackIndex), doc.length - 1);
    let b = doc[i];
    if (!isText(b)) {
      const j = nextText(doc, i) ?? prevText(doc, i);
      b = doc[j];
      return { id: b.id, off: 0 };
    }
    const len = blockLen(b);
    return { id: b.id, off: Math.min(Math.max(0, p && p.id === b.id ? p.off : len), len) };
  };
  if (!sel) {
    const p = fix(null);
    return { a: p, f: p };
  }
  return { a: fix(sel.a), f: fix(sel.f) };
}

export function nextText(doc, i) {
  for (let j = i + 1; j < doc.length; j++) if (isText(doc[j])) return j;
  return null;
}
export function prevText(doc, i) {
  for (let j = i - 1; j >= 0; j--) if (isText(doc[j])) return j;
  return null;
}

/** Per-block [from, to) segments a selection covers (text blocks only). */
export function segments(doc, sel, { skipCode = false } = {}) {
  const { s, e } = orderSel(doc, sel);
  const out = [];
  for (let i = s.i; i <= e.i; i++) {
    const b = doc[i];
    if (!isText(b) || (skipCode && b.t === 'code')) continue;
    const from = i === s.i ? s.off : 0;
    const to = i === e.i ? e.off : blockLen(b);
    out.push({ i, from, to });
  }
  return out;
}

/** Rebase an offset across a text change (common prefix / suffix). */
export function rebaseOff(oldText, newText, off) {
  if (oldText === newText) return Math.min(off, newText.length);
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;
  if (off <= p) return off;
  if (off >= oldText.length - s) return Math.max(0, newText.length - (oldText.length - off));
  return Math.min(newText.length, p + (newText.length - s - p));
}

export function replaceAt(doc, i, ...blocks) {
  const out = doc.slice();
  out.splice(i, 1, ...blocks);
  // Same id in the same place (typing, formatting): the id → index map still holds.
  if (blocks.length === 1 && blocks[0] && doc[i] && blocks[0].id === doc[i].id) {
    const m = IDX.get(doc);
    if (m) IDX.set(out, m);
  }
  return out;
}

export function runsEqual(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || !sameFmt(a[i], b[i])) return false;
  return true;
}

/** Shallow structural equality of two blocks (ids, fields, runs). */
export function blocksEqual(x, y) {
  if (x === y) return true;
  if (!x || !y || x.id !== y.id || x.t !== y.t) return false;
  if ((x.in ?? 0) !== (y.in ?? 0) || !!x.ck !== !!y.ck || (x.task || null) !== (y.task || null) || (x.start ?? null) !== (y.start ?? null)) return false;
  if ((x.lang || '') !== (y.lang || '') || !!x.fold !== !!y.fold) return false;
  if (x.t === 'hr') return true;
  return runsEqual(x.c || [], y.c || []);
}

export function docsEqual(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!blocksEqual(a[i], b[i])) return false;
  return true;
}
