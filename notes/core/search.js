// ecosys notes: search — the query language and ranking (notes-spec section 6), shared by the app and MCP.
// Pure ES module (browser + Node). The index is in memory only: one entry per note object, cached in a
// WeakMap (store records are replaced on change, so a changed note is re-indexed automatically).
//
// Query language:  words (ANDed; word starts, then substrings) · "exact phrase" · -word · -"phrase"
//   #tag (nested children included) · -#tag · in:"Folder" or in:Work/Clients (subfolders included;
//   in:notes = the default Notes folder) · is:pinned|daily|meeting|checklist|ai|hidden · has:todo|done|link|task
//   edited:today|yesterday|7d|30d|YYYY-MM-DD · created:7d|30d|YYYY-MM-DD   (-is: / -has: negate)
// An unknown operator is plain text.
import { blockText, normalizeTag, tagMatches, descendantIds, resolveFolderPath, folderPath, cut } from './schema.js';
import { escapeHtml, safeString } from '../../shared/sanitize.js';

const ELLIPSIS = '\u{2026}';
const DAY = 86400000;

// ---------------------------------------------------------------- normalisation

const COMBINING_RE = /\p{M}/gu;
const WS_RE = /\s/u;
const ASCII_RE = /^[\x00-\x7f]*$/;
const charCache = new Map();

function normChar(ch) {
  let out = charCache.get(ch);
  if (out === undefined) {
    out = WS_RE.test(ch) ? ' ' : ch.normalize('NFKD').replace(COMBINING_RE, '').toLowerCase();
    if (charCache.size < 50000) charCache.set(ch, out);
  }
  return out;
}

/**
 * Text for matching: lowercase, NFKD with combining marks removed (é matches e), whitespace runs
 * collapsed to one space. Works code point by code point so offsets can be mapped back (see
 * normalizeWithMap); both always give the same string.
 */
export function normalize(s) {
  const str = safeString(s);
  if (ASCII_RE.test(str)) return str.toLowerCase().replace(/\s+/g, ' ');
  return normalizeWithMap(str, false).norm;
}

/** {norm, map}: map[k] = index in `s` of the character that produced norm[k] (map[norm.length] = s.length). */
export function normalizeWithMap(s, withMap = true) {
  const str = safeString(s);
  let norm = '';
  const map = withMap ? [] : null;
  let lastWs = false;
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    let out;
    if (cp < 128) {
      const ch = str[i];
      out = ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' ? ' ' : ch.toLowerCase();
    } else out = normChar(str.slice(i, i + len));
    if (out === ' ') {
      if (lastWs) {
        i += len;
        continue;
      }
      lastWs = true;
    } else if (out) lastWs = false;
    if (map) for (let k = 0; k < out.length; k++) map.push(i);
    norm += out;
    i += len;
  }
  if (map) map.push(str.length);
  return { norm, map };
}

const LETTER_RE = /[\p{L}\p{N}]/u;
const isWordStart = (hay, i) => i === 0 || !LETTER_RE.test(hay[i - 1]);

// ---------------------------------------------------------------- query language

const IS_FLAGS = ['pinned', 'daily', 'meeting', 'checklist', 'ai', 'hidden'];
const HAS_FLAGS = ['todo', 'done', 'link', 'task'];
const HAS_ALIASES = { checklist: 'todo', todos: 'todo', checked: 'done', links: 'link', tasks: 'task' };
const IS_ALIASES = { pin: 'pinned', day: 'daily', meetings: 'meeting', checklists: 'checklist', 'ai-edited': 'ai' };

function parseDateFilter(v) {
  const s = safeString(v).trim().toLowerCase();
  if (s === 'today') return { kind: 'days', days: 0 };
  if (s === 'yesterday') return { kind: 'yesterday' };
  let m = /^(\d{1,4})([dwmy])$/.exec(s);
  if (m) {
    const n = Number(m[1]) * { d: 1, w: 7, m: 30, y: 365 }[m[2]];
    return n >= 1 && n <= 36500 ? { kind: 'days', days: n } : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) return { kind: 'date', ymd: s };
  }
  return null;
}

const trimTermPunct = (w) => (/^[\p{P}\p{S}]+$/u.test(w) ? w : w.replace(/^[("'\u{201C}\u{2018}[]+/u, '').replace(/[,.;:!?)"'\u{201D}\u{2019}\]]+$/u, ''));

/**
 * Query string → {raw, terms, phrases, tags, folder, is:{…}, has:{…}, not:{terms, phrases, tags,
 * folder, is:{…}, has:{…}}, edited, created, empty}. Terms and phrases are normalized.
 */
export function parseQuery(q) {
  const raw = safeString(q).slice(0, 1000);
  const out = {
    raw,
    terms: [],
    phrases: [],
    tags: [],
    folder: null,
    is: {},
    has: {},
    not: { terms: [], phrases: [], tags: [], folder: null, is: {}, has: {} },
    edited: null,
    created: null,
    empty: true,
  };
  const addTerm = (word, neg) => {
    const n = normalize(trimTermPunct(word)).trim();
    if (!n) return;
    for (const part of n.split(' ')) if (part) (neg ? out.not.terms : out.terms).push(part);
  };
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && WS_RE.test(raw[i])) i++;
    if (i >= raw.length) break;
    let neg = false;
    if (raw[i] === '-' && i + 1 < raw.length && !WS_RE.test(raw[i + 1])) {
      neg = true;
      i++;
    }
    const start = i;
    if (raw[i] === '"') {
      const end = raw.indexOf('"', i + 1);
      const phrase = normalize(raw.slice(i + 1, end < 0 ? raw.length : end)).trim();
      i = end < 0 ? raw.length : end + 1;
      if (phrase) (neg ? out.not.phrases : out.phrases).push(phrase);
      continue;
    }
    const op = /^([A-Za-z]+):/.exec(raw.slice(i, i + 12));
    if (op) {
      let j = i + op[0].length;
      let value;
      if (raw[j] === '"') {
        const end = raw.indexOf('"', j + 1);
        value = raw.slice(j + 1, end < 0 ? raw.length : end);
        j = end < 0 ? raw.length : end + 1;
      } else {
        let k = j;
        while (k < raw.length && !WS_RE.test(raw[k])) k++;
        value = raw.slice(j, k);
        j = k;
      }
      const name = op[1].toLowerCase();
      const v = value.trim().toLowerCase();
      let handled = true;
      if (name === 'in' && value.trim()) {
        if (neg) out.not.folder = value.trim();
        else out.folder = value.trim();
      } else if (name === 'is' && (IS_FLAGS.includes(v) || IS_ALIASES[v])) {
        (neg ? out.not.is : out.is)[IS_ALIASES[v] || v] = true;
      } else if (name === 'has' && (HAS_FLAGS.includes(v) || HAS_ALIASES[v])) {
        (neg ? out.not.has : out.has)[HAS_ALIASES[v] || v] = true;
      } else if ((name === 'edited' || name === 'created') && !neg && parseDateFilter(v)) {
        out[name] = parseDateFilter(v);
      } else if (name === 'tag' && normalizeTag(value)) {
        (neg ? out.not.tags : out.tags).push(normalizeTag(value));
      } else handled = false;
      if (handled) {
        i = j;
        continue;
      }
    }
    let k = i;
    while (k < raw.length && !WS_RE.test(raw[k])) k++;
    const word = raw.slice(start, k);
    i = k;
    if (word.startsWith('#') && normalizeTag(word.slice(1))) {
      (neg ? out.not.tags : out.tags).push(normalizeTag(word.slice(1)));
      continue;
    }
    addTerm(word, neg);
  }
  out.empty =
    !out.terms.length && !out.phrases.length && !out.tags.length && out.folder == null && !Object.keys(out.is).length && !Object.keys(out.has).length &&
    !out.edited && !out.created && !out.not.terms.length && !out.not.phrases.length && !out.not.tags.length && out.not.folder == null &&
    !Object.keys(out.not.is).length && !Object.keys(out.not.has).length;
  return out;
}

// ---------------------------------------------------------------- index

const index = new WeakMap();

const NO_ENTRY = Object.freeze({ title: '', tags: Object.freeze([]), blocks: Object.freeze([]), body: '', open: 0, done: 0, hasTask: false, hasLink: false });

/** The search index entry for one note (cached per note object; anything that isn't one matches nothing). */
export function indexEntry(note) {
  if (!note || typeof note !== 'object') return NO_ENTRY;
  let e = index.get(note);
  if (e) return e;
  const blocks = [];
  let open = 0;
  let done = 0;
  let task = false;
  let href = false;
  if (!note.locked) {
    for (const b of Array.isArray(note.blocks) ? note.blocks : []) {
      if (!b || b.t === 'hr') continue;
      const raw = blockText(b);
      if (b.t === 'check') {
        // An item without text is a place to type (a template's), not a to-do: as noteStats counts.
        if (raw.trim()) {
          if (b.ck) done++;
          else open++;
        }
        if (b.task) task = true;
      }
      if (!href && Array.isArray(b.c) && b.c.some((r) => r?.[2]?.href)) href = true;
      if (raw.trim()) blocks.push({ id: b.id, raw, norm: normalize(raw), title: !blocks.length });
    }
  }
  const links = Array.isArray(note.links) ? note.links.filter((l) => typeof l === 'string') : [];
  e = {
    title: normalize(note.title || '').trim(),
    tags: (Array.isArray(note.tags) ? note.tags : []).filter((t) => typeof t === 'string').map((t) => ({ tag: t, norm: normalize(t) })),
    blocks,
    body: blocks.map((b) => b.norm).join('\n'),
    open,
    done,
    hasTask: task || links.some((l) => l.startsWith('task:')),
    hasLink: href || links.length > 0,
  };
  index.set(note, e);
  return e;
}

/** Build index entries ahead of time (e.g. when the app is idle after load). */
export function indexNotes(notes) {
  for (const n of Array.isArray(notes) ? notes : []) indexEntry(n);
}

// ---------------------------------------------------------------- matching & ranking

function countHits(hay, term, max = 5) {
  let any = false;
  let ws = 0;
  let i = hay.indexOf(term);
  let guard = 0;
  while (i >= 0 && guard++ < 200) {
    any = true;
    if (isWordStart(hay, i) && ++ws >= max) break;
    i = hay.indexOf(term, i + term.length);
  }
  return { any, ws };
}

/** Best field score for one term (notes-spec ranking). 0 = no match. */
function termScore(e, term, folderNorm) {
  if (e.title === term) return 100;
  const t = countHits(e.title, term, 1);
  if (t.ws) return 40;
  if (e.tags.some((x) => tagMatches(x.norm, term) || x.norm.split('/').some((seg) => seg.startsWith(term)))) return 25;
  if (t.any) return 20;
  const b = countHits(e.body, term, 5);
  if (b.ws) return 8 + Math.min(8, (b.ws - 1) * 2);
  if (b.any) return 4;
  if (folderNorm) {
    const f = countHits(folderNorm, term, 1);
    if (f.ws) return 3;
  }
  return 0;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 'YYYY-MM-DD' of time `ms` on this device's clock. */
const localYmd = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** The first moment (ms) of day `ymd` on this device's clock (a midnight a clock change skips: the first moment after it). */
const localDayStart = (ymd) => {
  const [Y, M, D] = ymd.split('-').map(Number);
  return new Date(Y, M - 1, D).getTime();
};
/** The day `n` days after `ymd` ('YYYY-MM-DD'; by default the next one). */
const nextYmd = (ymd, n = 1) => {
  const [Y, M, D] = ymd.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D + n)).toISOString().slice(0, 10);
};

/**
 * The day filters' bounds, worked out once per search: `today` (YYYY-MM-DD) and `dayStart(ymd)` (ms
 * of that day's first moment) are the user's (opts.today / opts.dayStart: the server's notes tools
 * pass the apps' time zone, which can differ from the server's own), else this device's clock at `now`.
 */
function dayBounds(now, opts) {
  const start = typeof opts.dayStart === 'function' ? opts.dayStart : localDayStart;
  const today = typeof opts.today === 'string' && YMD_RE.test(opts.today) ? opts.today : localYmd(now);
  const cache = new Map();
  const at = (ymd) => {
    if (!cache.has(ymd)) {
      const ms = Number(start(ymd));
      cache.set(ymd, Number.isFinite(ms) ? ms : localDayStart(ymd));
    }
    return cache.get(ymd);
  };
  return { now, today: at(today), yesterday: at(nextYmd(today, -1)), day: at };
}

function dateOk(ms, f, b) {
  if (!f) return true;
  if (!Number.isFinite(ms)) return false;
  // "7d" counts back from now; "today", "yesterday" and a date are whole days of the user's calendar.
  if (f.kind === 'days') return ms >= (f.days === 0 ? b.today : b.now - f.days * DAY);
  if (f.kind === 'yesterday') return ms >= b.yesterday && ms < b.today;
  return ms >= b.day(f.ymd) && ms < b.day(nextYmd(f.ymd));
}

const isAiEdited = (n) => !!n.aiPrev || (typeof n.editedBy === 'string' && n.editedBy.startsWith('mcp:'));

function flagOk(n, e, name, value) {
  const v = {
    pinned: !!n.pinned,
    daily: !!n.day,
    meeting: !!n.event,
    checklist: e.open + e.done > 0,
    ai: isAiEdited(n),
    hidden: !!n.aiHidden,
    todo: e.open > 0,
    done: e.done > 0,
    link: e.hasLink,
    task: e.hasTask,
  }[name];
  return value ? !!v : !v;
}

/** Folder filter → predicate on note.folderId ('notes' = the default Notes folder), or null when no folder matches. */
function folderFilter(name, folders) {
  if (name == null) return () => true;
  const key = safeString(name).trim().toLowerCase();
  const hit = resolveFolderPath(name, folders);
  if (hit) {
    const ids = descendantIds(hit.id, folders);
    return (n) => !!n.folderId && ids.has(n.folderId);
  }
  if (key === 'notes' || key === '') return (n) => !n.folderId && !n.day;
  return null;
}

/**
 * Search notes. opts: {folders, limit=50, sort:'relevance'|'date', now (ms, default Date.now()),
 * today ('YYYY-MM-DD') and dayStart(ymd) → ms (the user's calendar for edited:/created: days; default
 * this device's clock), trash=false (true: search only Recently Deleted), snippets=true}. Returns
 * [{note, score, snippets:[{blockId, text, ranges}], titleRanges}] best first. A query of only
 * operators lists every match, newest edit first.
 */
/** A parseQuery() result as is; anything else is read as query text. */
function asQuery(q) {
  const ok = (o) => !!o && typeof o === 'object' && ['terms', 'phrases', 'tags'].every((k) => Array.isArray(o[k])) && !!o.is && !!o.has && typeof o.is === 'object' && typeof o.has === 'object';
  return ok(q) && ok(q.not) ? q : parseQuery(q);
}

export function searchNotes(notes, q, opts = {}) {
  const query = asQuery(q);
  if (query.empty) return [];
  const folders = Array.isArray(opts.folders) ? opts.folders : [];
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const bounds = query.edited || query.created ? dayBounds(now, opts) : null;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const inFolder = folderFilter(query.folder, folders);
  const outFolder = query.not.folder != null ? folderFilter(query.not.folder, folders) : null;
  if (!inFolder) return [];
  const terms = [...new Set(query.terms)];
  const phrases = [...new Set(query.phrases)];
  const termText = terms.join(' ');
  const pathCache = new Map();
  const pathOf = (id) => {
    if (!id) return '';
    if (!pathCache.has(id)) pathCache.set(id, normalize(folderPath(id, folders)));
    return pathCache.get(id);
  };
  const results = [];
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!n || typeof n !== 'object') continue;
    if (!!n.trashedAt !== !!opts.trash) continue;
    if (!inFolder(n) || (outFolder && outFolder(n))) continue;
    if (!dateOk(n.editedAt, query.edited, bounds) || !dateOk(n.createdAt, query.created, bounds)) continue;
    const e = indexEntry(n);
    const tags = Array.isArray(n.tags) ? n.tags : [];
    if (!query.tags.every((t) => tags.some((x) => tagMatches(x, t)))) continue;
    if (query.not.tags.some((t) => tags.some((x) => tagMatches(x, t)))) continue;
    if (!Object.entries(query.is).every(([k, v]) => flagOk(n, e, k, v))) continue;
    if (!Object.entries(query.has).every(([k, v]) => flagOk(n, e, k, v))) continue;
    if (Object.keys(query.not.is).some((k) => flagOk(n, e, k, true))) continue;
    if (Object.keys(query.not.has).some((k) => flagOk(n, e, k, true))) continue;
    const hay = `${e.title}\n${e.body}`;
    if (query.not.terms.some((t) => hay.includes(t) || e.tags.some((x) => x.norm.includes(t)))) continue;
    if (query.not.phrases.some((p) => hay.includes(p))) continue;
    let score = 0;
    let ok = true;
    const folderNorm = pathOf(n.folderId);
    for (const t of terms) {
      const s = termScore(e, t, folderNorm);
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) continue;
    for (const p of phrases) {
      if (!hay.includes(p)) {
        ok = false;
        break;
      }
      score += 15;
    }
    if (!ok) continue;
    if (terms.length > 1 && termText === e.title) score += 100;
    const days = Math.max(0, (now - (Number.isFinite(n.editedAt) ? n.editedAt : now)) / DAY);
    score += 10 * Math.exp(-days / 30);
    if (n.pinned) score += 3;
    results.push({ note: n, score: Math.round(score * 100) / 100 });
  }
  const byEdited = (a, b) => (b.note.editedAt || 0) - (a.note.editedAt || 0);
  const relevance = terms.length || phrases.length;
  results.sort(opts.sort === 'date' || !relevance ? byEdited : (a, b) => b.score - a.score || byEdited(a, b));
  const top = results.slice(0, limit);
  const needles = [...phrases, ...terms].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const r of top) {
    r.titleRanges = needles.length ? matchRanges(r.note.title || '', needles) : [];
    r.snippets = opts.snippets === false || !needles.length ? [] : snippetsFor(indexEntry(r.note), needles);
  }
  return top;
}

// ---------------------------------------------------------------- snippets & highlighting

/** [[start, end]] (UTF-16 offsets in `text`) of every occurrence of the needles, merged. */
export function matchRanges(text, needles) {
  const src = safeString(text);
  if (!src || !needles?.length) return [];
  const { norm, map } = normalizeWithMap(src);
  const ranges = [];
  for (const nd of needles) {
    if (!nd) continue;
    let i = norm.indexOf(nd);
    while (i >= 0 && ranges.length < 200) {
      const s = map[i];
      let e = map[i + nd.length - 1];
      e += src.codePointAt(e) > 0xffff ? 2 : 1;
      while (e < src.length && /\p{M}/u.test(src[e])) e++;
      ranges.push([s, e]);
      i = norm.indexOf(nd, i + nd.length);
    }
  }
  return mergeRanges(ranges, src.length);
}

function mergeRanges(ranges, len) {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, Math.min(len, s | 0)), Math.max(0, Math.min(len, e | 0))])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** The body block (not the title) with the most distinct hits, cut to about ±60 characters around its first hit. */
function snippetsFor(e, needles) {
  let best = null;
  let bestCount = 0;
  for (const b of e.blocks) {
    if (b.title) continue;
    let count = 0;
    for (const nd of needles) if (b.norm.includes(nd)) count++;
    if (count > bestCount) {
      best = b;
      bestCount = count;
    }
  }
  if (!best) return [];
  const ranges = matchRanges(best.raw, needles);
  if (!ranges.length) return [];
  const raw = best.raw;
  let start = Math.max(0, ranges[0][0] - 60);
  let end = Math.min(raw.length, ranges[0][1] + 60);
  if (start > 0) {
    const sp = raw.slice(start, Math.min(ranges[0][0], start + 15)).search(/\s/);
    if (sp >= 0) start += sp + 1;
    if (isLow(raw.charCodeAt(start))) start++;
  }
  if (end < raw.length) {
    const tail = raw.slice(Math.max(ranges[0][1], end - 15), end);
    const sp = tail.search(/\s\S*$/);
    if (sp >= 0) end = Math.max(ranges[0][1], end - 15) + sp;
    if (isLow(raw.charCodeAt(end))) end++;
  }
  const pre = start > 0 ? ELLIPSIS : '';
  const post = end < raw.length ? ELLIPSIS : '';
  const text = `${pre}${raw.slice(start, end).replace(/\n/g, ' ')}${post}`;
  const shift = pre.length - start;
  const local = ranges
    .filter(([s, e2]) => e2 > start && s < end)
    .map(([s, e2]) => [Math.max(s, start) + shift, Math.min(e2, end) + shift]);
  return [{ blockId: best.id, text, ranges: local }];
}

/** Escaped HTML for `text` with the ranges wrapped in <mark> (safe to assign to innerHTML). */
export function highlight(text, ranges) {
  const src = safeString(text);
  const merged = mergeRanges(Array.isArray(ranges) ? ranges.filter((r) => Array.isArray(r) && r.length >= 2) : [], src.length);
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += escapeHtml(src.slice(pos, s));
    out += `<mark>${escapeHtml(src.slice(s, e))}</mark>`;
    pos = e;
  }
  return out + escapeHtml(src.slice(pos));
}

/** A one-line preview of the text around the first match of `q` in a note (for result rows). */
export function snippetText(note, q) {
  const query = asQuery(q);
  const needles = [...(query?.phrases || []), ...(query?.terms || [])].sort((a, b) => b.length - a.length);
  if (!note || !needles.length) return '';
  const s = snippetsFor(indexEntry(note), needles)[0];
  return s ? cut(s.text, 200) : '';
}
