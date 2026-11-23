// ecosys notes: the data model (notes-spec section 4) — blocks, runs, notes and folders.
// Pure ES module: runs in the browser and in Node (the MCP server imports it). No DOM, no storage.
//
//   block  { id, t, in?, ck?, task?, start?, lang?, fold?, c:[run…] }   (hr: { id, t:'hr' })
//   run    [text] | [text, marks] | [text, marks, attrs]
//          marks ⊆ 'biusc' in that order; attrs ⊆ { ref, href, hl, atom:1 } (in that key order)
//   note   { id, v, rev, blocks, title, tags, links, folderId, pinned, day, event, aiHidden, aiPrev,
//            locked, editedBy, editedAt, createdAt, updatedAt, trashedAt, trashedFrom }
//   folder { id, name, parentId, color, order, sort, sortDir, groupByDate, view, aiHidden, createdAt, updatedAt }
//
// title, tags and links are DERIVED from the blocks and recomputed on every validation.
// Importing this module registers the note, folder and task.source field validators with
// shared/sanitize.js (extendSchema), so the shared store and the server keep these fields.
// The same canonical form is produced by notes/editor/model.js (normDoc), so blocks compare equal.
import { extendSchema, schemaFields, sanitizeHtml, decodeEntities, cleanHref, isId, isYmd, isPlainObject, safeString, COLORS } from '../../shared/sanitize.js';

// ---------------------------------------------------------------- constants

export const NOTE_FORMAT = 1;
export const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'bullet', 'dash', 'num', 'check', 'quote', 'code', 'hr'];
export const LIST_TYPES = ['bullet', 'dash', 'num', 'check'];
export const HEADING_TYPES = ['h1', 'h2', 'h3'];
export const MARKS = 'biusc';
export const HIGHLIGHTS = ['purple', 'pink', 'orange', 'mint', 'blue'];
export const DEFAULT_HIGHLIGHT = 'purple';
export const EDITORS = ['user', 'mcp:claude', 'mcp:chatgpt', 'mcp:grok', 'mcp:other'];
export const EDITOR_LABEL = { user: 'You', 'mcp:claude': 'Claude', 'mcp:chatgpt': 'ChatGPT', 'mcp:grok': 'Grok', 'mcp:other': 'AI assistant' };
export const FOLDER_SORTS = ['edited', 'created', 'title'];
export const TRASH_DAYS = 30;
export const NOTE_LIMITS = {
  blocks: 5000,
  blockChars: 20000,
  noteBytes: 256 * 1024, // serialized blocks
  recordBytes: 448 * 1024, // whole record incl. aiPrev (the server refuses items over 512 KB)
  tags: 100,
  tagChars: 64,
  titleChars: 120,
  links: 1000,
  indent: 6,
  folderName: 60,
  folderDepth: 3,
  hrefChars: 2048,
};

const LIST_SET = new Set(LIST_TYPES);
const HEADING_SET = new Set(HEADING_TYPES);
const TYPE_SET = new Set(BLOCK_TYPES);
const ts = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;

// ---------------------------------------------------------------- ids

/** Block ids: 1–40 of [A-Za-z0-9_-] (the editor makes 8 lowercase alphanumerics), unique within a note. */
export const isBlockId = (s) => isId(s);

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function newBlockId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += ALPHABET[x % 36];
  return s;
}

/** A 16-char hex id like shared/store.js uid() (for records built outside the store, e.g. samples). */
export function newRecordId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- text

// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BIDI_RE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}]/gu;
const LINE_SEP_RE = /[\u{2028}\u{2029}]/gu;
const REPLACEMENT_CHAR = '\u{FFFD}';
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text as stored in a run: \r\n, \r, U+2028 and U+2029 become \n; C0 controls except \n are removed
 * (tabs survive only in code, elsewhere they become spaces); lone surrogates become U+FFFD.
 */
export function cleanText(s, { code = false } = {}) {
  // Only strings and numbers are text: String() of an untrusted object can throw (a non-callable toString).
  let t = typeof s === 'string' ? s : typeof s === 'number' || typeof s === 'boolean' ? String(s) : '';
  t = t.replace(/\r\n?/g, '\n').replace(LINE_SEP_RE, '\n').replace(CTRL_RE, '');
  if (!code) t = t.replace(/\t/g, ' ');
  return typeof t.toWellFormed === 'function' ? t.toWellFormed() : t.replace(LONE_SURROGATE_RE, REPLACEMENT_CHAR);
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
/** s.slice(0, n) that never splits a surrogate pair. */
export function cut(s, n) {
  if (s.length <= n) return s;
  let k = Math.max(0, n);
  if (k > 0 && isHigh(s.charCodeAt(k - 1))) k--;
  return s.slice(0, k);
}

// ---------------------------------------------------------------- links (href) and refs

const HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// eslint-disable-next-line no-control-regex
const LEADING_C0_SPACE_RE = new RegExp('^[\\x00-\\x20]+');

/**
 * A URL link target, or null. Checked on the protocol the WHATWG URL parser sees (so
 * "java\tscript:" is javascript: and is refused), http(s)/mailto/tel only, at most 2048 chars,
 * bidi controls removed. Internal targets are never hrefs (they are refs).
 */
export function safeHref(s) {
  if (typeof s !== 'string') return null;
  const raw = s.replace(BIDI_RE, '').trim();
  if (!raw || raw.length > NOTE_LIMITS.hrefChars) return null;
  // No scheme (the URL parser strips C0 controls and spaces at the start and tabs/newlines anywhere):
  // a relative link, refused without paying for the parser's exception.
  if (!SCHEME_RE.test(raw.replace(/[\t\n\r]/g, '').replace(LEADING_C0_SPACE_RE, ''))) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!HREF_PROTOCOLS.has(u.protocol)) return null;
  const href = u.href;
  if (href.length > NOTE_LIMITS.hrefChars) return null;
  if (u.protocol === 'tel:') return u.pathname.replace(/[\s()-]/g, '') ? href : null;
  return cleanHref(href) ? href : null; // the shared allowlist (shared/sanitize.js) agrees
}

const RID = '[A-Za-z0-9_-]{1,40}';
const REF_RE = new RegExp(`^(note):(${RID})(?:#(${RID}))?$|^(task):(${RID})$|^(event):(${RID})(?:@(\\d{4}-\\d{2}-\\d{2}))?$|^(day):(\\d{4}-\\d{2}-\\d{2})$`);

/** 'note:<id>[#<blockId>]' · 'task:<id>' · 'event:<id>[@YYYY-MM-DD]' · 'day:YYYY-MM-DD' → parts, or null. */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.length > 100) return null;
  const m = REF_RE.exec(ref);
  if (!m) return null;
  if (m[1]) return { kind: 'note', id: m[2], blockId: m[3] || null };
  if (m[4]) return { kind: 'task', id: m[5] };
  if (m[6]) {
    if (m[8] && !isYmd(m[8])) return null;
    return { kind: 'event', id: m[7], date: m[8] || null };
  }
  if (!isYmd(m[10])) return null;
  return { kind: 'day', date: m[10] };
}
export const isRef = (s) => !!parseRef(s);

export function formatRef(r) {
  if (!r) return null;
  if (r.kind === 'note') return `note:${r.id}${r.blockId ? `#${r.blockId}` : ''}`;
  if (r.kind === 'task') return `task:${r.id}`;
  if (r.kind === 'event') return `event:${r.id}${r.date ? `@${r.date}` : ''}`;
  if (r.kind === 'day') return `day:${r.date}`;
  return null;
}

/** Fallback label for a chip whose cached text is empty. */
export function refLabel(ref) {
  const r = parseRef(ref);
  if (!r) return 'Link';
  return r.kind === 'day' ? r.date : r.kind === 'note' ? 'Note' : r.kind === 'task' ? 'Task' : 'Event';
}

// ---------------------------------------------------------------- runs

export function cleanMarks(m) {
  if (typeof m !== 'string' || !m) return '';
  let out = '';
  for (const ch of MARKS) if (m.includes(ch)) out += ch;
  return out;
}

/** attrs → canonical {ref?, href?, hl?, atom?} (ref wins over href; atom needs a ref), or null. */
export function cleanAttrs(a) {
  if (!isPlainObject(a)) return null;
  const out = {};
  if (a.ref != null && isRef(a.ref)) out.ref = a.ref;
  if (!out.ref && typeof a.href === 'string') {
    const h = safeHref(a.href);
    if (h) out.href = h;
  }
  if (a.hl != null && HIGHLIGHTS.includes(a.hl)) out.hl = a.hl;
  if (out.ref && (a.atom === 1 || a.atom === true)) out.atom = 1;
  return Object.keys(out).length ? out : null;
}

export function mkRun(text, marks = '', attrs = null) {
  const a = attrs && Object.keys(attrs).length ? attrs : null;
  if (a) return [text, marks || '', a];
  if (marks) return [text, marks];
  return [text];
}

const runAttrs = (r) => r[2] || null;
export const isAtomRun = (r) => !!(r && r[2] && r[2].atom);
function sameAttrs(x, y) {
  if (x === y) return true;
  if (!x || !y) return false;
  return x.href === y.href && x.hl === y.hl && x.ref === y.ref && !!x.atom === !!y.atom;
}

/** Untrusted runs → canonical runs: cleaned text, canonical marks and attrs, merged, ≤ max chars. */
export function validateRuns(c, { code = false, max = NOTE_LIMITS.blockChars } = {}) {
  if (!Array.isArray(c)) return [];
  const out = [];
  let total = 0;
  for (const raw of c) {
    const r = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(r) || (typeof r[0] !== 'string' && typeof r[0] !== 'number')) continue;
    let text = cleanText(r[0], { code });
    let marks = code ? '' : cleanMarks(r[1]);
    const attrs = code ? null : cleanAttrs(r[2]);
    if (attrs?.atom) {
      marks = '';
      // A chip is never split (splitBlock cuts around it), so its label must fit in one block.
      text = cut(text.replace(/\n/g, ' '), NOTE_LIMITS.blockChars);
      if (!text.trim()) text = refLabel(attrs.ref);
    }
    if (!text) continue;
    if (total + text.length > max) {
      if (attrs?.atom) break;
      text = cut(text, max - total);
      if (!text) break;
    }
    total += text.length;
    const last = out[out.length - 1];
    if (last && !isAtomRun(last) && !attrs?.atom && last[1] === marks && sameAttrs(last[2], attrs)) last[0] += text;
    else out.push([text, marks, attrs]);
    if (total >= max) break;
  }
  if (code && out.length > 1) return [[out.map((r) => r[0]).join('')]];
  return out.map((r) => mkRun(r[0], r[1], r[2]));
}

// safeString, not String(): these helpers also see blocks that were never validated, and String() of
// a parsed JSON object whose toString is not a function throws.
export const runsText = (runs) => (Array.isArray(runs) ? runs.map((r) => (Array.isArray(r) ? safeString(r[0]) : typeof r === 'string' ? r : '')).join('') : '');
export const blockText = (b) => (b && b.t !== 'hr' && Array.isArray(b.c) ? runsText(b.c) : '');
export const isTextBlock = (b) => !!b && b.t !== 'hr';

// ---------------------------------------------------------------- blocks

const clampIndent = (v) => (Number.isInteger(v) ? Math.min(NOTE_LIMITS.indent, Math.max(0, v)) : 0);
const LANG_RE = /^[\w+-]{1,20}$/;

/**
 * Untrusted block → canonical block, or null. Unknown types keep their text as Body. Text past
 * `maxChars` (20,000) is cut; validateBlocks({split:true}) splits long blocks instead.
 */
export function validateBlock(b, { maxChars = NOTE_LIMITS.blockChars } = {}) {
  if (!isPlainObject(b)) return null;
  const id = isBlockId(b.id) ? b.id : newBlockId();
  const t = TYPE_SET.has(b.t) ? b.t : 'p';
  if (t === 'hr') return { id, t };
  const out = { id, t };
  if (LIST_SET.has(t)) out.in = clampIndent(b.in);
  if (t === 'check') {
    out.ck = b.ck === true;
    if (isId(b.task)) out.task = b.task;
  }
  if (t === 'num' && Number.isInteger(b.start) && b.start >= 0 && b.start <= 999999999 && b.start !== 1) out.start = b.start;
  if (t === 'code' && typeof b.lang === 'string' && LANG_RE.test(b.lang)) out.lang = b.lang;
  if (HEADING_SET.has(t) && b.fold === true) out.fold = true;
  out.c = validateRuns(b.c, { code: t === 'code', max: maxChars });
  return out;
}

/**
 * Untrusted block array → canonical blocks (ids unique; repaired ids are new). At most `max` blocks
 * (5,000; pass Infinity to see how many there would be). With `split`, a block longer than 20,000
 * characters becomes several consecutive blocks (splitBlock) instead of being cut; a new piece never
 * takes an id that another block in `arr` has (that block keeps it, and its links).
 */
export function validateBlocks(arr, { max = NOTE_LIMITS.blocks, split = false } = {}) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  let taken = null; // with split: every id the input has, so a piece never takes a later block's id
  const opts = split ? { maxChars: Infinity } : undefined;
  for (const raw of arr) {
    if (out.length >= max) break;
    const b = validateBlock(raw, opts);
    if (!b) continue;
    let parts = [b];
    if (split) {
      parts = splitBlock(b);
      if (parts.length > 1) claimPieceIds(parts, (taken ??= new Set(arr.map((x) => (isPlainObject(x) ? x.id : null)))));
    }
    for (const part of parts) {
      if (out.length >= max) break;
      while (seen.has(part.id)) part.id = newBlockId();
      seen.add(part.id);
      out.push(part);
    }
  }
  return out;
}

/**
 * The pieces of a split block (splitBlock: x, x-1, x-2 …) after the first get ids `taken` doesn't
 * hold, which are then added to it. Long text is stored split, so a note that has x often has x-1
 * too: a new piece named x-1 would take over that block's links (note:<id>#x-1, a task's source).
 */
function claimPieceIds(parts, taken) {
  for (let k = 1; k < parts.length; k++) {
    while (taken.has(parts[k].id)) parts[k].id = newBlockId();
    taken.add(parts[k].id);
  }
  return parts;
}

/** Runs covering text offsets [a, b) of their concatenation, read from run `from` (which starts at offset `at`). */
function sliceRuns(runs, a, b, from = 0, at = 0) {
  const out = [];
  let pos = at;
  for (let i = from; i < runs.length; i++) {
    const r = runs[i];
    const t = r[0];
    const s = pos;
    pos += t.length;
    if (pos <= a) continue;
    if (s >= b) break;
    const piece = t.slice(Math.max(0, a - s), Math.min(t.length, b - s));
    if (piece) out.push(mkRun(piece, r[1] || '', r[2] || null));
  }
  return out;
}

/**
 * A canonical block whose text is longer than `max` (20,000) → consecutive blocks of the same type,
 * each ≤ max: cut at the last line break (then the last space) in the second half of each piece, which
 * is dropped like a line break; otherwise a hard cut that never splits a chip or a surrogate pair.
 * The first piece keeps the id, task link and list number; the others get ids derived from it
 * (validateBlocks and rewriteTags give a piece a new id when another block of the note has that one).
 */
export function splitBlock(b, max = NOTE_LIMITS.blockChars) {
  if (!b || b.t === 'hr' || !Array.isArray(b.c)) return [b];
  const text = runsText(b.c);
  if (text.length <= max) return [b];
  const code = b.t === 'code';
  const atoms = []; // [start, end) of each chip, in text order (runs never overlap)
  let at = 0;
  for (const r of b.c) {
    if (isAtomRun(r)) atoms.push([at, at + r[0].length]);
    at += r[0].length;
  }
  // The chip that holds offset j, or null: a binary search, so a block made of thousands of chips
  // whose labels have spaces splits in linear time (checking every chip for every space took seconds).
  const atomAt = (j) => {
    let a = 0;
    let z = atoms.length - 1;
    while (a <= z) {
      const m = (a + z) >> 1;
      if (j < atoms[m][0]) z = m - 1;
      else if (j >= atoms[m][1]) a = m + 1;
      else return atoms[m];
    }
    return null;
  };
  // The last `sep` at an offset in [lo, from], or -1. Only that range is read: lastIndexOf alone
  // would read a text without line breaks back to its start for every piece.
  const lastSep = (sep, lo, from) => {
    if (from < lo) return -1;
    const i = text.slice(lo, from + 1).lastIndexOf(sep);
    return i < 0 ? -1 : lo + i;
  };
  const cuts = []; // [start, end) of each piece
  let pos = 0;
  while (text.length - pos > max) {
    const hi = pos + max; // a separator right at the limit still works: the piece is exactly max long
    const lo = pos + Math.floor(max / 2);
    let k = -1;
    for (const sep of code ? ['\n'] : ['\n', ' ']) {
      let j = lastSep(sep, lo, hi);
      // A separator inside a chip doesn't count: look again before that chip.
      for (let a; j >= 0 && (a = atomAt(j)); ) j = lastSep(sep, lo, a[0] - 1);
      if (j >= 0) {
        k = j;
        break;
      }
    }
    if (k >= 0) {
      cuts.push([pos, k]);
      pos = k + 1;
      continue;
    }
    let end = hi;
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    const atom = atomAt(end); // never cut inside a chip
    if (atom && atom[0] < end) end = atom[0] > pos ? atom[0] : atom[1];
    cuts.push([pos, end]);
    pos = end;
  }
  cuts.push([pos, text.length]);
  const base = { t: b.t };
  if (LIST_SET.has(b.t)) base.in = b.in || 0;
  if (b.t === 'check') base.ck = !!b.ck;
  if (code && b.lang) base.lang = b.lang;
  const stem = isBlockId(b.id) ? b.id : newBlockId();
  let ri = 0; // the first run that ends after the next piece starts (pieces come in order), and its offset
  let rAt = 0;
  return cuts.map(([s, e], k) => {
    while (ri < b.c.length && rAt + b.c[ri][0].length <= s) rAt += b.c[ri++][0].length;
    const id = k === 0 ? stem : `${stem.slice(0, 34)}-${k.toString(36)}`;
    const extra = k === 0 ? { ...b } : { ...base };
    return validateBlock({ ...extra, id, c: sliceRuns(b.c, s, e, ri, rAt) }, { maxChars: Math.max(max, e - s) });
  });
}

/**
 * Why `blocks` can't be stored as one note, or null when they fit: {reason:'blocks'|'bytes', count,
 * size} (at most 5,000 blocks and 256 KB of blocks JSON). Check before saving, so nothing is cut.
 */
export function noteOverLimit(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const size = blocksBytes(list);
  if (list.length > NOTE_LIMITS.blocks) return { reason: 'blocks', count: list.length, size };
  if (size > NOTE_LIMITS.noteBytes) return { reason: 'bytes', count: list.length, size };
  return null;
}

/** A new canonical block. `extra` may carry in / ck / task / start / lang / c (runs). */
export function newBlock(t = 'p', text = '', extra = {}) {
  const c = Array.isArray(extra?.c) ? extra.c : text ? [[safeString(text)]] : [];
  return validateBlock({ ...(isPlainObject(extra) ? extra : {}), id: isBlockId(extra?.id) ? extra.id : newBlockId(), t, c });
}

const blocksBytes = (blocks) => JSON.stringify(blocks).length;

/** Blocks cut to the per-note limit (whole blocks from the end; the app warns long before). */
function capBlocks(blocks) {
  if (blocksBytes(blocks) <= NOTE_LIMITS.noteBytes) return blocks;
  const out = [];
  let n = 2;
  for (const b of blocks) {
    const size = JSON.stringify(b).length + 1;
    if (n + size > NOTE_LIMITS.noteBytes) break;
    out.push(b);
    n += size;
  }
  return out;
}

export const blocksEqual = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** True when no block has any visible text (dividers alone don't count). */
export function isEmptyBlocks(blocks) {
  return !Array.isArray(blocks) || blocks.every((b) => !blockText(b).trim());
}
export const isEmptyNote = (note) => !note?.locked && isEmptyBlocks(note?.blocks);

// ---------------------------------------------------------------- tags

// Combining marks (\p{M}) belong to a tag: decomposed accents, and "İ".toLowerCase() is "i" + U+0307.
const TAG_RE = /(?<![\p{L}\p{M}\p{N}_&/#])#([\p{L}\p{N}_][\p{L}\p{M}\p{N}_\-/]*)/gu;
const TAG_BODY_RE = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_\-/]*$/u;
const HAS_LETTER_RE = /\p{L}/u;
// U+0307 COMBINING DOT ABOVE right after i or j (written as an escape: the character itself is invisible).
// The whole run goes: "İ" followed by another dot above lowercases to "i" + two of them, and leaving
// one would make the next normalizeTag() strip it, so the stored tag would not be canonical.
const DOT_ABOVE_AFTER_IJ_RE = new RegExp('(?<=[ij])\\u0307+', 'g');

/** Tag spelled in text (without '#') → canonical tag ('Work/Clients-' → 'work/clients'), or null. Idempotent. */
export function normalizeTag(raw) {
  let t = (typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '').replace(BIDI_RE, '').replace(/^#+/, '').normalize('NFC');
  t = t.replace(/[/-]+$/, '');
  if (t.length > NOTE_LIMITS.tagChars) t = cut(t, NOTE_LIMITS.tagChars).replace(/[/-]+$/, '');
  if (!t || !HAS_LETTER_RE.test(t) || !TAG_BODY_RE.test(t)) return null;
  // "İ".toLowerCase() is "i" + a combining dot above, which looks exactly like "i": drop that dot.
  return t.toLowerCase().replace(DOT_ABOVE_AFTER_IJ_RE, '').normalize('NFC');
}

/** Tag matches `filter` itself or is nested under it ('work/clients' matches 'work'). */
export const tagMatches = (tag, filter) => tag === filter || (typeof tag === 'string' && tag.startsWith(`${filter}/`));

/**
 * Text segments of a block that can hold #tags: consecutive runs that are not inline code, links
 * or chips. Each: {text, parts:[{i (run index), start, end}]} (offsets inside `text`).
 */
export function tagSegments(block) {
  if (!block || block.t === 'code' || block.t === 'hr' || !Array.isArray(block.c)) return [];
  const segs = [];
  let cur = null;
  block.c.forEach((r, i) => {
    // A run that isn't [text, marks?, attrs?] (a block that was never validated) holds no tags either.
    const a = Array.isArray(r) ? runAttrs(r) : null;
    const masked = !Array.isArray(r) || (a && (a.atom || a.href || a.ref)) || safeString(r[1]).includes('c');
    if (masked) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { text: '', parts: [] };
      segs.push(cur);
    }
    const text = safeString(r[0]);
    cur.parts.push({ i, start: cur.text.length, end: cur.text.length + text.length });
    cur.text += text;
  });
  return segs;
}

/** #tag tokens in plain text: [{tag, raw (as written, no '#'), start, end}] (end excludes a dropped trailing / or -). */
export function findTags(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('#')) return out;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) {
    const raw = m[1].replace(/[/-]+$/, '');
    const tag = normalizeTag(raw);
    if (!tag) continue;
    out.push({ tag, raw, start: m.index, end: m.index + 1 + raw.length });
  }
  return out;
}

// ---------------------------------------------------------------- derived fields

function firstLineTitle(text) {
  const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  return cut(line, NOTE_LIMITS.titleChars).trim();
}

/** {title, tags, links} computed from the blocks (never trusted from input). */
export function deriveFields(note) {
  const blocks = Array.isArray(note?.blocks) ? note.blocks : [];
  let title = '';
  const tags = [];
  const tagSet = new Set();
  const links = [];
  const linkSet = new Set();
  const addLink = (ref) => {
    if (!linkSet.has(ref) && links.length < NOTE_LIMITS.links) {
      linkSet.add(ref);
      links.push(ref);
    }
  };
  for (const b of blocks) {
    if (!b || b.t === 'hr') continue;
    if (!title) {
      const t = blockText(b);
      if (t.trim()) title = firstLineTitle(t);
    }
    for (const seg of tagSegments(b)) {
      for (const { tag } of findTags(seg.text)) {
        if (!tagSet.has(tag) && tags.length < NOTE_LIMITS.tags) {
          tagSet.add(tag);
          tags.push(tag);
        }
      }
    }
    for (const r of Array.isArray(b.c) ? b.c : []) {
      const ref = r?.[2]?.ref;
      if (ref && isRef(ref)) addLink(ref);
    }
    if (b.t === 'check' && isId(b.task)) addLink(`task:${b.task}`);
  }
  return { title, tags, links };
}

/**
 * Word, character and checklist counts (for the Info panel and list rows). A checklist item without
 * text (the empty one a meeting-notes template starts with) is a place to type, not a to-do: it
 * counts as neither open nor done.
 */
export function noteStats(note) {
  const blocks = Array.isArray(note?.blocks) ? note.blocks : [];
  let words = 0;
  let chars = 0;
  let open = 0;
  let done = 0;
  for (const b of blocks) {
    if (!b) continue;
    const t = blockText(b);
    if (b.t === 'check' && t.trim()) {
      if (b.ck) done++;
      else open++;
    }
    if (!t) continue;
    for (const _ of t) chars++;
    words += countWords(t);
  }
  return { words, chars, checks: { open, done } };
}

let segmenter;
function countWords(t) {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
    } catch {
      segmenter = null;
    }
  }
  if (segmenter) {
    let n = 0;
    for (const s of segmenter.segment(t)) if (s.isWordLike) n++;
    return n;
  }
  return (t.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) || []).length;
}

/**
 * The first text line after the title (list row line 2), at most `max` chars. Headings after the
 * title block are section names, not text, and are passed over, so notes that share a template
 * (meeting notes: "Notes", "Action items") preview what was written in them, or nothing yet.
 */
export function notePreview(note, max = 160) {
  const blocks = Array.isArray(note?.blocks) ? note.blocks : [];
  let seenTitle = false;
  for (const b of blocks) {
    if (!b || b.t === 'hr') continue;
    if (seenTitle && HEADING_SET.has(b.t)) continue;
    const lines = blockText(b).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const line of lines) {
      if (!seenTitle) {
        seenTitle = true;
        continue;
      }
      return cut(line, max);
    }
  }
  return '';
}

// ---------------------------------------------------------------- notes

const cleanEditor = (v) => (EDITORS.includes(v) ? v : 'user');
/** Booleans read like shared/sanitize.js does (true, 'true' and 1 are true). */
const flag = (v) => v === true || v === 'true' || v === 1;

function cleanEventLink(v) {
  if (!isPlainObject(v) || !isId(v.id) || !isYmd(v.date)) return null;
  return { id: v.id, date: v.date };
}

const B64_RE = /^[A-Za-z0-9+/=_-]+$/;
function cleanLocked(v) {
  if (!isPlainObject(v)) return null;
  const { iv, ct } = v;
  // 450,000 base64 characters hold 256 KB of encrypted blocks and keep the record under the server's 512 KB.
  if (typeof iv !== 'string' || typeof ct !== 'string' || iv.length < 8 || iv.length > 64 || ct.length > 450000 || !B64_RE.test(iv) || !B64_RE.test(ct)) return null;
  return { iv, ct };
}

function cleanAiPrev(v) {
  if (!isPlainObject(v) || !Array.isArray(v.blocks)) return null;
  return {
    at: ts(v.at) ? v.at : 0,
    by: EDITORS.includes(v.by) ? v.by : 'mcp:other',
    rev: Number.isInteger(v.rev) && v.rev >= 0 ? v.rev : 0,
    blocks: capBlocks(validateBlocks(v.blocks)),
  };
}

const cleanLine = (v, max) => cut(cleanText(v).replace(/\s+/g, ' ').trim(), max);

function legacyTags(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const t = normalizeTag(x);
    if (t && !out.includes(t) && out.length < NOTE_LIMITS.tags) out.push(t);
  }
  return out;
}

const strTitle = (v) => (typeof v === 'string' ? cleanLine(v, NOTE_LIMITS.titleChars) : '');
/** Stable id of the i-th block converted from a stage-1 note (≤ 40 characters, valid for isId). */
const legacyBlockId = (noteId, i) => `${noteId.slice(0, 30)}-${i.toString(36)}`;

/** Blocks for a note stored before blocks existed ({title, body:'<notes html>'}). */
function legacyBlocks(raw) {
  const blocks = htmlToBlocks(raw.body);
  const title = strTitle(raw.title);
  if (title && firstLineTitle(blocks.map(blockText).find((t) => t.trim()) || '').toLowerCase() !== title.toLowerCase()) {
    blocks.unshift(newBlock('h1', title));
  }
  // Stage-1 tags were a separate field; keep the ones the text doesn't mention as a final #tag line.
  const have = new Set(deriveFields({ blocks }).tags);
  const extra = legacyTags(raw.tags).filter((t) => !have.has(t));
  if (extra.length) blocks.push(newBlock('p', extra.map((t) => `#${t}`).join(' ')));
  return blocks;
}

/**
 * Untrusted note → canonical note record, or null (not an object / bad id). Derived fields are
 * recomputed; unknown fields are dropped; limits are applied (≤ 5,000 blocks, ≤ 20,000 chars per
 * block, ≤ 256 KB of blocks). A locked note (v1.1) keeps its stored title and tags and no blocks.
 */
export function validateNote(raw) {
  if (!isPlainObject(raw) || !isId(raw.id)) return null;
  const locked = cleanLocked(raw.locked);
  let blocks = [];
  if (!locked) {
    // Over-long blocks are split, never cut. A stage-1 note (HTML body, no blocks) is converted
    // with block ids derived from its id, so every conversion (browser, server, each reload of
    // data.json) gives the same ids and links to its blocks keep working.
    if (Array.isArray(raw.blocks)) blocks = validateBlocks(raw.blocks, { split: true });
    else if (typeof raw.body === 'string' && raw.body.trim()) blocks = validateBlocks(legacyBlocks(raw).map((b, i) => ({ ...b, id: legacyBlockId(raw.id, i) })));
    else if (strTitle(raw.title)) blocks = [newBlock('h1', strTitle(raw.title), { id: legacyBlockId(raw.id, 0) })];
    blocks = capBlocks(blocks);
  }
  const derived = locked ? { title: strTitle(raw.title), tags: legacyTags(raw.tags), links: [] } : deriveFields({ blocks });
  const createdAt = ts(raw.createdAt) ? raw.createdAt : ts(raw.updatedAt) ? raw.updatedAt : Date.now();
  const updatedAt = ts(raw.updatedAt) ? raw.updatedAt : createdAt;
  const note = {
    id: raw.id,
    v: NOTE_FORMAT,
    rev: Number.isInteger(raw.rev) && raw.rev >= 0 && raw.rev <= 1e12 ? raw.rev : 0,
    blocks,
    title: derived.title,
    tags: derived.tags,
    links: derived.links,
    folderId: isId(raw.folderId) ? raw.folderId : null,
    pinned: flag(raw.pinned),
    day: isYmd(raw.day) ? raw.day : null,
    event: cleanEventLink(raw.event),
    aiHidden: flag(raw.aiHidden),
    aiPrev: locked ? null : cleanAiPrev(raw.aiPrev),
    locked,
    editedBy: cleanEditor(raw.editedBy),
    editedAt: ts(raw.editedAt) ? raw.editedAt : updatedAt,
    createdAt,
    updatedAt,
    trashedAt: ts(raw.trashedAt) ? raw.trashedAt : null,
    trashedFrom: isId(raw.trashedFrom) ? raw.trashedFrom : null,
  };
  // The review copy is a convenience: drop it rather than let the record outgrow the sync limit.
  if (note.aiPrev && JSON.stringify(note).length > NOTE_LIMITS.recordBytes) note.aiPrev = null;
  return note;
}

/** A new note record without an id (the caller inserts it; db.insert adds id and timestamps). */
export function newNote({ folderId = null, day = null, event = null, blocks, pinned = false, aiHidden = false, editedBy = 'user', now } = {}) {
  pinned = flag(pinned);
  aiHidden = flag(aiHidden);
  const t = ts(now) ? now : Date.now();
  const bl = capBlocks(blocks !== undefined ? validateBlocks(blocks) : [newBlock('h1')]);
  const d = deriveFields({ blocks: bl });
  return {
    v: NOTE_FORMAT,
    rev: 1,
    blocks: bl,
    title: d.title,
    tags: d.tags,
    links: d.links,
    folderId: isId(folderId) ? folderId : null,
    pinned: pinned === true,
    day: isYmd(day) ? day : null,
    event: cleanEventLink(event),
    aiHidden: aiHidden === true,
    aiPrev: null,
    locked: null,
    editedBy: cleanEditor(editedBy),
    editedAt: t,
    createdAt: t,
    updatedAt: t,
    trashedAt: null,
    trashedFrom: null,
  };
}

/** Serialized size of a note's blocks in bytes-ish (UTF-16 units), for the 256 KB limit / Info panel. */
export const noteSize = (note) => blocksBytes(Array.isArray(note?.blocks) ? note.blocks : []);

// ---------------------------------------------------------------- templates

const longDateFmt = new Map();
/** 'Sunday, 22 November 2026' in the given (or default) locale. */
export function longDate(ymd, locale) {
  if (!isYmd(ymd)) return '';
  const key = locale || '';
  if (!longDateFmt.has(key)) {
    let f;
    try {
      f = new Intl.DateTimeFormat(locale || undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } catch {
      f = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
    longDateFmt.set(key, f);
  }
  const [y, m, d] = ymd.split('-').map(Number);
  return longDateFmt.get(key).format(new Date(y, m - 1, d));
}

/** Daily note template: the long date as Title, then an empty Body line for the caret. */
export const dailyNoteBlocks = (ymd, { locale } = {}) => [newBlock('h1', longDate(ymd, locale)), newBlock('p')];

/** Meeting notes template (notes-spec section 7): title, Notes, Action items with one empty item. */
export const meetingNoteBlocks = (title = '') => [
  newBlock('h1', cleanLine(title, NOTE_LIMITS.titleChars) || 'Meeting notes'),
  newBlock('h3', 'Notes'),
  newBlock('p'),
  newBlock('h3', 'Action items'),
  newBlock('check'),
];

// ---------------------------------------------------------------- tag rewrites (pure)

// A '#' starts a tag unless it follows one of these (TAG_RE's look-behind); then comes the tag body.
const TAG_PREV_RE = /^[\p{L}\p{M}\p{N}_&/#]$/u;
const TAG_BODY_AT_RE = /[\p{L}\p{N}_][\p{L}\p{M}\p{N}_\-/]*/uy;
const ENDS_PHRASE_RE = /[\s.,;:!?)]/;
/** The last character of a non-empty string (both halves of a surrogate pair). */
const lastChar = (s) => (s.length > 1 && /[\uDC00-\uDFFF]/.test(s[s.length - 1]) && /[\uD800-\uDBFF]/.test(s[s.length - 2]) ? s.slice(-2) : s.slice(-1));

/**
 * The rewrites of one tag segment's text: {del (1 = the character at that offset goes), ins (Map:
 * offset → text written just before it)}, or null when nothing changes. The text is read like
 * findTags reads it, left to right, but against what is kept so far: a deleted tag leaves the text
 * on its two sides touching, so a '#' right after it ("#a#a", "#a/b#a/b") can start a tag, and `fn`
 * sees that one too. One pass therefore leaves no tag that should have gone, however many touch, and
 * the space taken with a deleted tag is chosen on the text as it will be (no punctuation is lost).
 */
function tagEdits(text, fn) {
  const n = text.length;
  let del = null;
  let ins = null;
  const out = []; // what is kept or written so far, newest last: [character, offset or -1 if written]
  const prev = () => (out.length ? out[out.length - 1][0] : '');
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) === 0x23 && !TAG_PREV_RE.test(prev())) {
      TAG_BODY_AT_RE.lastIndex = i + 1;
      const m = TAG_BODY_AT_RE.exec(text);
      const raw = m ? m[0].replace(/[/-]+$/, '') : '';
      const tag = raw ? normalizeTag(raw) : null;
      const rep = tag ? fn(tag, raw) : undefined;
      if (rep !== undefined && rep !== raw) {
        del ??= new Uint8Array(n);
        let end = i + 1 + raw.length;
        if (rep !== '') {
          const w = `#${safeString(rep)}`;
          ins ??= new Map();
          ins.set(i, w);
          out.push([lastChar(w), -1]);
        } else if (text[end] === ' ' && (prev() === '' || prev() === ' ')) {
          end++; // deleting: also take one neighbouring space, so no double space is left behind
        } else if (prev() === ' ' && out[out.length - 1][1] >= 0 && (end === n || ENDS_PHRASE_RE.test(text[end]))) {
          del[out.pop()[1]] = 1;
        }
        del.fill(1, i, end);
        i = end;
        continue;
      }
    }
    // Any other character (a kept tag too: its body has no '#', so it is read on like plain text).
    const cp = text.codePointAt(i);
    const ch = cp > 0xffff ? text.slice(i, i + 2) : text[i];
    out.push([ch, i]);
    i += ch.length;
  }
  return del || ins ? { del, ins } : null;
}

/** Apply tagEdits() to the runs of one tag segment (copies, changed in place). */
function applyTagEdits(runs, seg, { del, ins }) {
  for (const p of seg.parts) {
    let s = '';
    let from = p.start;
    for (let j = p.start; j < p.end; j++) {
      const w = ins?.get(j);
      const gone = !!del?.[j];
      if (w === undefined && !gone) continue;
      s += seg.text.slice(from, j) + (w ?? '');
      from = gone ? j + 1 : j;
    }
    runs[p.i][0] = s + seg.text.slice(from, p.end);
  }
}

/**
 * Rewrite #tags in blocks. `fn(tag, raw)` returns the replacement text for a tag token (without
 * the '#', '' to delete it) or undefined to keep it. Returns {blocks, changed}. Marks are kept: the
 * replacement takes the format of the run where the token starts. Nothing is cut: a block that a
 * longer tag name pushes past 20,000 characters comes back as several blocks (splitBlock), and the
 * new pieces never take the id of another block (every block keeps its id, so links to it work).
 */
export function rewriteTags(blocks, fn) {
  let changed = false;
  const list = Array.isArray(blocks) ? blocks : [];
  let taken = null; // every block's id: a piece split off a block never takes another block's id
  const out = list.flatMap((b) => {
    let runs = null;
    for (const seg of tagSegments(b)) {
      const edits = tagEdits(seg.text, fn);
      if (!edits) continue;
      runs ??= b.c.map((r) => (Array.isArray(r) ? [...r] : r));
      applyTagEdits(runs, seg, edits);
    }
    if (!runs) return [b];
    changed = true;
    const parts = splitBlock(validateBlock({ ...b, c: runs }, { maxChars: Infinity }));
    return parts.length > 1 ? claimPieceIds(parts, (taken ??= new Set(list.map((x) => x?.id)))) : parts;
  });
  return { blocks: changed ? out : blocks, changed };
}

/** Rename #from (and, with children, #from/…) to #to everywhere in the blocks. #to keeps its casing. */
export function renameTagInBlocks(blocks, from, to, { children = true } = {}) {
  const f = normalizeTag(from);
  const toRaw = safeString(to).replace(BIDI_RE, '').trim().replace(/^#+/, '').replace(/[/-]+$/, '').normalize('NFC');
  if (!f || !normalizeTag(toRaw) || normalizeTag(toRaw) !== toRaw.toLowerCase()) return { blocks, changed: false };
  const depth = f.split('/').length;
  return rewriteTags(blocks, (tag, raw) => {
    if (tag === f) return toRaw;
    if (children && tag.startsWith(`${f}/`)) return `${toRaw}/${raw.split('/').slice(depth).join('/')}`;
    return undefined;
  });
}

/** Remove #tag (and, with children, #tag/…) text; blocks left empty by it are removed. */
export function removeTagFromBlocks(blocks, tag, { children = true } = {}) {
  const f = normalizeTag(tag);
  if (!f) return { blocks, changed: false };
  const before = new Set((Array.isArray(blocks) ? blocks : []).filter((b) => blockText(b).trim()).map((b) => b?.id));
  // One pass is enough: rewriteTags also offers the tags that only form once a touching one is gone
  // ("#a#a", "#a/b#a/b"), so no matching tag is ever left behind.
  const r = rewriteTags(blocks, (t) => (t === f || (children && t.startsWith(`${f}/`)) ? '' : undefined));
  if (!r.changed) return r;
  let out = r.blocks.filter((b) => !(b && before.has(b.id) && !blockText(b).trim() && b.t !== 'hr'));
  if (!out.length) out = [newBlock('p')];
  return { blocks: out, changed: true };
}

/** Append #tag as a final Body line (Apple's "Add tag" for several notes), unless already tagged. */
export function appendTag(blocks, tag) {
  const t = normalizeTag(tag);
  if (!t) return { blocks, changed: false };
  const has = deriveFields({ blocks }).tags.some((x) => x === t);
  if (has) return { blocks, changed: false };
  return { blocks: [...(Array.isArray(blocks) ? blocks : []), newBlock('p', `#${t}`)], changed: true };
}

// ---------------------------------------------------------------- folders

const cleanFolderName = (v) => cut(cleanText(v).replace(/[\s]+/g, ' ').replace(/\//g, '-').trim(), NOTE_LIMITS.folderName).trim();

/** Untrusted folder → canonical folder record, or null. */
export function validateFolder(raw) {
  if (!isPlainObject(raw) || !isId(raw.id)) return null;
  const createdAt = ts(raw.createdAt) ? raw.createdAt : ts(raw.updatedAt) ? raw.updatedAt : Date.now();
  return {
    id: raw.id,
    name: cleanFolderName(raw.name) || 'Untitled folder',
    parentId: isId(raw.parentId) && raw.parentId !== raw.id ? raw.parentId : null,
    color: COLORS.includes(raw.color) ? raw.color : 'iris',
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) && Math.abs(raw.order) <= 1e15 ? raw.order : 0,
    sort: FOLDER_SORTS.includes(raw.sort) ? raw.sort : null,
    sortDir: raw.sortDir === 'asc' || raw.sortDir === 'desc' ? raw.sortDir : null,
    groupByDate: typeof raw.groupByDate === 'boolean' ? raw.groupByDate : null,
    view: raw.view === 'list' || raw.view === 'gallery' ? raw.view : null,
    aiHidden: raw.aiHidden === true,
    createdAt,
    updatedAt: ts(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

export { cleanFolderName };

/** Folder records of a list or an id → folder Map (anything that isn't an object is skipped). */
const folderList = (folders) => (folders instanceof Map ? [...folders.values()] : Array.isArray(folders) ? folders : []).filter((f) => f && typeof f === 'object');
const byIdMap = (folders) => (folders instanceof Map ? folders : new Map(folderList(folders).map((f) => [f.id, f])));

// Folders are a tree, but two browsers that move folders into each other at the same time store a
// parent cycle (each move was fine where it was made). Every view cuts a cycle at the same folder, so
// all folders always show, each in one place: the folder in the cycle created first (then the
// smallest id) is shown at the top level, and the others inside it as stored. Creation times never
// change, so renaming or recolouring a folder of the cycle doesn't turn the tree around; moving one
// of them (to the top level, or into a folder outside the cycle) ends the cycle.

/** The folder a cycle is cut at (shown at the top level): the oldest createdAt, then the smallest id. */
function cycleCut(cycle) {
  const at = (f) => (typeof f.createdAt === 'number' && Number.isFinite(f.createdAt) ? f.createdAt : 0);
  return cycle.reduce((a, b) => (at(b) < at(a) || (at(b) === at(a) && String(b.id) < String(a.id)) ? b : a));
}

/** The stored parent of a folder record, or null (none, itself, or a folder that isn't there). */
const storedParent = (f, map) => (f.parentId && f.parentId !== f.id && map.get(f.parentId)) || null;

/** The folders from `folderId` up its stored parents: [the folder, its parent, …] up to a repeat (a cycle) or the top (at most 16). → {walk, repeat} */
function walkUp(folderId, map) {
  const walk = [];
  const seen = new Set();
  let f = folderId ? map.get(folderId) : null;
  while (f && !seen.has(f.id) && walk.length < 16) {
    seen.add(f.id);
    walk.push(f);
    f = storedParent(f, map);
  }
  return { walk, repeat: f && seen.has(f.id) ? f : null };
}

/** Folder chain from the root down to `folderId`, as the folder tree shows it (a parent cycle is cut at cycleCut, a missing parent makes a top-level folder). */
export function folderChain(folderId, folders) {
  const map = byIdMap(folders);
  const { walk, repeat } = walkUp(folderId, map);
  if (repeat) {
    const cut = cycleCut(walk.slice(walk.indexOf(repeat)));
    walk.length = walk.indexOf(cut) + 1;
  }
  return walk.reverse();
}

/**
 * The parent each folder is shown under (Map: id → parent id or null for the top level): its stored
 * parentId, except that a missing parent makes it a top-level folder and each parent cycle is cut at
 * one folder (cycleCut), as folderChain does.
 */
export function folderParents(folders) {
  const map = byIdMap(folders);
  const out = new Map();
  const state = new Map(); // id → index on the walk in progress, or -1 when done
  for (const start of map.values()) {
    if (state.has(start.id)) continue;
    const walk = [];
    let f = start;
    while (f && !state.has(f.id)) {
      state.set(f.id, walk.length);
      walk.push(f);
      f = storedParent(f, map);
    }
    const cut = f && state.get(f.id) >= 0 && walk[state.get(f.id)] === f ? cycleCut(walk.slice(state.get(f.id))) : null;
    for (const x of walk) {
      state.set(x.id, -1);
      out.set(x.id, x === cut ? null : storedParent(x, map)?.id ?? null);
    }
  }
  return out;
}

/** 'Work/Clients' ('' for the default Notes folder or a missing folder). */
export const folderPath = (folderId, folders) => folderChain(folderId, folders).map((f) => safeString(f.name)).join('/');

/** Nesting depth: 1 for a top-level folder, 0 for none. */
export const folderDepth = (folderId, folders) => folderChain(folderId, folders).length;

/** Ids of a folder and every folder nested in it (as the folder tree shows them: see folderParents). */
export function descendantIds(folderId, folders) {
  const parents = folderParents(folders);
  const kids = new Map();
  for (const [id, p] of parents) {
    if (!p) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(id);
  }
  const out = new Set();
  const stack = [folderId];
  while (stack.length && out.size < 5000) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const k of kids.get(id) || []) stack.push(k);
  }
  return out;
}

const foldKey = (s) => safeString(s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Folder by path ('Work/Clients', as folderPath gives it) or by name when the name is unique; case-insensitive. */
export function resolveFolderPath(path, folders) {
  const list = folderList(folders);
  const parts = safeString(path).split('/').map(foldKey).filter(Boolean);
  if (!parts.length) return null;
  const parents = folderParents(list);
  let parent = null;
  let hit = null;
  for (const part of parts) {
    hit = list.find((f) => (parents.get(f.id) ?? null) === parent && foldKey(f.name) === part) || null;
    if (!hit) break;
    parent = hit.id;
  }
  if (hit) return hit;
  if (parts.length === 1) {
    const named = list.filter((f) => foldKey(f.name) === parts[0]);
    if (named.length === 1) return named[0];
  }
  return null;
}

/**
 * True when the folder or any folder above it is hidden from AI. Above means its stored parents, all
 * of them: in a parent cycle every folder of the cycle counts, wherever the tree shows it, so a cycle
 * never shows an assistant a folder that one of the moves put inside a hidden one.
 */
export function folderHiddenFromAi(folderId, folders) {
  return walkUp(folderId, byIdMap(folders)).walk.some((f) => f.aiHidden);
}

/** True when a note must never be shown to an AI assistant (hidden, in a hidden folder, locked). */
export function noteHiddenFromAi(note, folders) {
  return !!(note?.aiHidden || note?.locked || (note?.folderId && folderHiddenFromAi(note.folderId, folders)));
}

/** A folder name not used by `siblings` ("New Folder", "New Folder 2", …). */
export function uniqueFolderName(name, siblings) {
  const base = cleanFolderName(name) || 'New Folder';
  const taken = new Set(folderList(siblings).map((f) => foldKey(f.name)));
  if (!taken.has(foldKey(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` ${n}`;
    const cand = `${cut(base, NOTE_LIMITS.folderName - suffix.length).trim()}${suffix}`;
    if (!taken.has(foldKey(cand))) return cand;
  }
  return `${cut(base, NOTE_LIMITS.folderName - 5)} ${newBlockId().slice(0, 4)}`;
}

// ---------------------------------------------------------------- legacy HTML → blocks

/**
 * Blocks from notes HTML (the stage-1 `body` field). The HTML goes through sanitizeHtml first, so
 * only allowlisted, well-formed markup is walked. Lists, checklists, headings, quotes, code, marks
 * and links (incl. data-task/data-note/data-event chips) are kept.
 */
export function htmlToBlocks(html) {
  const safe = sanitizeHtml(typeof html === 'string' ? html : '');
  const blocks = [];
  const marks = []; // stack of {tag, mark?, attrs?}
  const lists = []; // stack of {type:'bullet'|'num'|'check', start}
  let cur = null;
  let inPre = 0;
  let quote = 0;
  let heading = null;

  const curMarks = () => cleanMarks(marks.map((m) => m.mark || '').join(''));
  const curAttrs = () => {
    let a = null;
    for (const m of marks) if (m.attrs) a = { ...(a || {}), ...m.attrs };
    return a ? cleanAttrs(a) : null;
  };
  const start = (t, extra = {}) => {
    flush();
    cur = { t, c: [], ...extra };
  };
  const flush = () => {
    if (!cur) return;
    if (cur.t === 'code') cur.c = [[cur.c.map((r) => r[0]).join('').replace(/\n$/, '')]];
    else {
      // Collapse HTML whitespace and trim the block's edges.
      const runs = cur.c;
      if (runs.length) {
        runs[0][0] = runs[0][0].replace(/^[ \t\n]+/, '');
        const last = runs[runs.length - 1];
        last[0] = last[0].replace(/[ \t]+$/, '');
      }
    }
    blocks.push(cur);
    cur = null;
  };
  const text = (raw) => {
    let s = decodeEntities(raw);
    if (!inPre) s = s.replace(/[ \t\n\r\f]+/g, ' ');
    if (!s) return;
    if (!cur) {
      if (!inPre && !s.trim()) return;
      start(inPre ? 'code' : quote ? 'quote' : heading || 'p');
    }
    cur.c.push([s, inPre ? '' : curMarks(), inPre ? null : curAttrs()]);
  };
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(safe))) {
    if (m[4] !== undefined) {
      text(m[4]);
      continue;
    }
    const close = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attr = (name) => {
      const am = new RegExp(`\\s${name}="([^"]*)"`).exec(m[3]);
      return am ? decodeEntities(am[1]) : null;
    };
    switch (tag) {
      case 'p':
      case 'div':
        if (close) flush();
        else if (!lists.length) start(quote ? 'quote' : 'p');
        break;
      case 'h1':
      case 'h2':
      case 'h3':
        if (close) {
          flush();
          heading = null;
        } else {
          heading = tag;
          start(tag);
        }
        break;
      case 'blockquote':
        if (close) {
          flush();
          quote = Math.max(0, quote - 1);
        } else {
          flush();
          quote++;
        }
        break;
      case 'pre':
        if (close) {
          flush();
          inPre = Math.max(0, inPre - 1);
        } else {
          start('code');
          inPre++;
        }
        break;
      case 'hr':
        flush();
        blocks.push({ t: 'hr' });
        break;
      case 'br':
        if (cur) cur.c.push(['\n', curMarks(), curAttrs()]);
        else if (inPre) text('\n');
        break;
      case 'ul':
      case 'ol':
        if (close) {
          flush();
          lists.pop();
        } else {
          flush();
          const cls = attr('class') || '';
          lists.push({ type: /\bchecklist\b/.test(cls) ? 'check' : tag === 'ol' ? 'num' : 'bullet' });
        }
        break;
      case 'li': {
        if (close) {
          flush();
          break;
        }
        const top = lists[lists.length - 1];
        const type = top ? top.type : 'bullet';
        const checked = attr('data-checked');
        const cls = attr('class') || '';
        const isCheck = type === 'check' || checked != null;
        start(isCheck ? 'check' : type, { in: Math.max(0, lists.length - 1), ...(isCheck ? { ck: checked === 'true' || /\bchecked\b/.test(cls) } : {}) });
        break;
      }
      case 'strong':
      case 'b':
      case 'em':
      case 'i':
      case 'u':
      case 's':
      case 'del':
      case 'mark':
      case 'code':
      case 'a':
      case 'span': {
        if (close) {
          const k = marks.map((x) => x.tag).lastIndexOf(tag);
          if (k >= 0) marks.splice(k, 1);
          break;
        }
        if (tag === 'code' && inPre) break;
        const entry = { tag };
        if (tag === 'strong' || tag === 'b') entry.mark = 'b';
        else if (tag === 'em' || tag === 'i') entry.mark = 'i';
        else if (tag === 'u') entry.mark = 'u';
        else if (tag === 's' || tag === 'del') entry.mark = 's';
        else if (tag === 'code') entry.mark = 'c';
        else if (tag === 'mark') entry.attrs = { hl: DEFAULT_HIGHLIGHT };
        else if (tag === 'span' && /\bhl\b/.test(attr('class') || '')) entry.attrs = { hl: DEFAULT_HIGHLIGHT };
        else if (tag === 'a') {
          const task = attr('data-task');
          const note = attr('data-note');
          const event = attr('data-event');
          const href = attr('href');
          if (task && isId(task)) entry.attrs = { ref: `task:${task}`, atom: 1 };
          else if (note && isId(note)) entry.attrs = { ref: `note:${note}`, atom: 1 };
          else if (event && isId(event)) entry.attrs = { ref: `event:${event}`, atom: 1 };
          else if (href) {
            const em = /^ecosys:\/{0,2}(note|task|event|day)\/(.+)$/i.exec(href);
            const ref = em ? `${em[1].toLowerCase()}:${em[2]}` : null;
            if (ref && isRef(ref)) entry.attrs = { ref, atom: 1 };
            else {
              const h = safeHref(href);
              if (h) entry.attrs = { href: h };
            }
          }
        }
        marks.push(entry);
        break;
      }
      default:
        break;
    }
  }
  flush();
  return validateBlocks(
    blocks.map((b) => ({ ...b, id: newBlockId(), c: b.t === 'hr' ? undefined : b.c.map((r) => mkRun(r[0], r[1], r[2])) })),
    { split: true },
  );
}

// ---------------------------------------------------------------- store registration

let slot = null; // {raw, note}: one validateItem() call validates the note once, not once per field
let warnedAt = 0;
/**
 * The canonical note for one validateItem() pass. When validateNote throws, the error goes on to
 * validateItem, which refuses the whole record (null): returning nothing here would make every notes
 * field undefined while id, body, color and order still validate, so the record would come out as an
 * empty note that a sync op or an import accepts as a put, replacing the note's real content.
 */
function noteFor(raw) {
  if (!slot || slot.raw !== raw) {
    slot = null;
    try {
      slot = { raw, note: validateNote(raw) };
    } catch (err) {
      const t = Date.now();
      if (t - warnedAt > 60000) {
        warnedAt = t;
        console.warn('ecosys notes: a note could not be validated, so it was refused', err?.message ?? err);
      }
      throw err;
    }
  }
  return slot.note;
}
const pick = (k) => (_v, raw) => {
  const n = noteFor(raw);
  return n ? n[k] : undefined;
};

/**
 * Field validators for shared/sanitize.js: the notes collection (extends its stage-1 schema). The
 * stage-1 fields body (sanitized HTML), color and order keep their own validators, so stage-1 records
 * stay valid; a stage-1 body is turned into blocks, and the save paths (notes.js saveBlocks, the MCP
 * tools) clear it once the blocks are written.
 */
export const NOTE_SCHEMA_FIELDS = {
  title: pick('title'),
  folderId: pick('folderId'),
  pinned: pick('pinned'),
  tags: pick('tags'),
  trashedAt: pick('trashedAt'),
  createdAt: pick('createdAt'),
  updatedAt: pick('updatedAt'),
  v: pick('v'),
  rev: pick('rev'),
  blocks: pick('blocks'),
  links: pick('links'),
  day: pick('day'),
  event: pick('event'),
  aiHidden: pick('aiHidden'),
  aiPrev: pick('aiPrev'),
  locked: pick('locked'),
  editedBy: pick('editedBy'),
  editedAt: pick('editedAt'),
  trashedFrom: pick('trashedFrom'),
  // Last key: forget the cached note so a later call with the same (mutated) object re-validates.
  _done: () => {
    slot = null;
    return undefined;
  },
};

const pickFolder = (k) => (_v, raw) => validateFolder(raw)?.[k];
/** Field validators for shared/sanitize.js: the folders collection. */
export const FOLDER_SCHEMA_FIELDS = Object.fromEntries(
  ['name', 'parentId', 'color', 'icon', 'order', 'sort', 'sortDir', 'groupByDate', 'view', 'aiHidden', 'createdAt', 'updatedAt'].map((k) => [k, k === 'icon' ? () => undefined : pickFolder(k)]),
);

/** task.source: where a task came from ({app:'notes', noteId, blockId}); omitted otherwise. */
export function cleanTaskSource(v) {
  if (!isPlainObject(v) || v.app !== 'notes' || !isId(v.noteId)) return undefined;
  return isBlockId(v.blockId) ? { app: 'notes', noteId: v.noteId, blockId: v.blockId } : { app: 'notes', noteId: v.noteId };
}

let registered = false;
/** Register the notes, folders and task.source validators with shared/sanitize.js (idempotent). */
export function registerNoteSchemas() {
  if (registered) return;
  registered = true;
  extendSchema('notes', NOTE_SCHEMA_FIELDS);
  extendSchema('folders', FOLDER_SCHEMA_FIELDS);
  if (!schemaFields('tasks').includes('source')) extendSchema('tasks', { source: cleanTaskSource });
}
registerNoteSchemas();
