// ecosys notes: Markdown, the exchange format (MCP, export, import, copy). Blocks JSON stays canonical.
// Pure ES module (browser + Node). A CommonMark-ish subset, notes-spec section 4 "Markdown mapping":
//
//   h1/h2/h3  # / ## / ###          bullet/dash/num  * / - / N.      check  - [ ] / - [x]
//   quote     >                     code  ```lang fences            hr  ---
//   indent    4 spaces per level out; 2–4 spaces or a tab per level in
//   marks     **b** *i* ~~s~~ `c` <u>u</u> ==highlight==   (<u> is the only HTML; any other <…> is text)
//   links     [t](https://…)   chips/refs [label](ecosys://note|task|event|day/…)   export: [[Title]], [[YYYY-MM-DD]]
//   task link a checklist item linked to a task ends with " [task](ecosys://task/<id>)"
//   soft break "\" at the end of a line;  blank lines: one separates blocks, each extra one is an empty Body line
//
// markdownToBlocks never produces HTML or unsafe links: every href goes through safeHref and every
// block through validateBlocks (schema.js).
import {
  validateBlocks, mkRun, parseRef, formatRef, safeHref, blockText, cleanText, cleanMarks, cut, isAtomRun, isBlockId, DEFAULT_HIGHLIGHT, HIGHLIGHTS, NOTE_LIMITS,
} from './schema.js';
// safeString, not String(): input that was never validated can hold a parsed JSON object whose
// toString is not a function, and String() of that throws.
import { safeString } from '../../shared/sanitize.js';

const LIST = new Set(['bullet', 'dash', 'num', 'check']);
const MAX_INPUT = 2 * 1024 * 1024;
const LANG_RE = /^[\w+-]{1,20}$/; // a code block's language, as schema.js validates it

// ================================================================ blocks → Markdown

const MARK_ORDER = ['u', 'h', 's', 'b', 'i'];
const OPEN = { b: '**', i: '*', s: '~~', h: '==', u: '<u>' };
const CLOSE = { b: '**', i: '*', s: '~~', h: '==', u: '</u>' };

/** ecosys:// URL for a ref ('note:abc' → 'ecosys://note/abc'). */
export function refUrl(ref) {
  const r = parseRef(ref);
  if (!r) return null;
  if (r.kind === 'note') return `ecosys://note/${r.id}${r.blockId ? `#${r.blockId}` : ''}`;
  if (r.kind === 'task') return `ecosys://task/${r.id}`;
  if (r.kind === 'event') return `ecosys://event/${r.id}${r.date ? `@${r.date}` : ''}`;
  return `ecosys://day/${r.date}`;
}

/** Ref for an ecosys:// (or ecosys:) URL, or null. */
export function urlRef(url) {
  const m = /^ecosys:(?:\/\/)?(note|task|event|day)\/(\S{1,90})$/i.exec(safeString(url).trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  let ref;
  if (kind === 'note') {
    const [id, blockId] = m[2].split('#');
    ref = formatRef({ kind, id, blockId });
  } else if (kind === 'event') {
    const [id, date] = m[2].split('@');
    ref = formatRef({ kind, id, date });
  } else ref = kind === 'task' ? `task:${m[2]}` : `day:${m[2]}`;
  return parseRef(ref) ? ref : null;
}

// Characters that would start markup anywhere in a line.
const ESC_INLINE = /[\\`*_~[\]<]/g;

const escapePart = (t) =>
  t
    .replace(ESC_INLINE, '\\$&')
    .replace(/=(?==)|(?<==)=|^=|=$/g, '\\=')
    .replace(/&(?=#?[A-Za-z0-9]{1,32};)/g, '\\&');

// Literal [[Title]] text (an unresolved wiki link) stays as written, so exports keep it a link.
const WIKI_TEXT_RE = /\[\[[^[\]\n|]{1,200}(?:\|[^[\]\n]{1,200})?\]\]/g;

function escapeText(t, { wiki = true } = {}) {
  if (!wiki || !t.includes('[[')) return escapePart(t);
  let out = '';
  let last = 0;
  for (const m of t.matchAll(WIKI_TEXT_RE)) {
    let before = escapePart(t.slice(last, m.index));
    // "!" + "[[…]]" is a literal "!" before a wiki link; escaped like a "!" before any link, so the
    // text reads back and is written again the same way (escapePart never escapes "!" itself).
    if (before.endsWith('!')) before = `${before.slice(0, -1)}\\!`;
    out += before + m[0];
    last = m.index + m[0].length;
  }
  return out + escapePart(t.slice(last));
}

/**
 * Escapes for text that starts a line (block markers, setext lines, table rows), also after leading
 * spaces. `end`: nothing follows the text on its line ("#" or "1." alone is a marker only then, or
 * before a space).
 */
function escapeLineStart(t, end = true) {
  const lead = /^[ \t]*/.exec(t)[0];
  if (lead) return lead + escapeLineStart(t.slice(lead.length), end);
  const markerEnds = (n) => (n === t.length ? end : t[n] === ' ' || t[n] === '\t');
  const h = /^#{1,6}/.exec(t);
  if (h && markerEnds(h[0].length)) return `\\${t}`;
  if (/^[-+=>|:]/.test(t)) return `\\${t}`;
  const m = /^(\d{1,9})[.)]/.exec(t);
  if (m && markerEnds(m[0].length)) return `${m[1]}\\${t.slice(m[1].length)}`;
  return t;
}

function codeSpan(t) {
  let longest = 0;
  for (const m of t.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.length >= 2 && t.startsWith(' ') && t.endsWith(' ') && /[^ ]/.test(t)) ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

function linkDest(url) {
  const u = url.replace(/\\/g, '\\\\');
  return /[\s()<>]/.test(u) ? `<${u.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : u;
}

const wikiSafe = (s) => !!s && !/[[\]|\n#^]/.test(s) && s.length <= 200;

/**
 * Plain (unformatted, one-line) text linked to a task, event or day — or to a note, when it reads back
 * as that note's chip — becomes a chip when the Markdown is read back. It is written as that chip
 * right away, so the Markdown is the same after a round trip.
 */
function chipify(runs, ctx) {
  const out = [];
  for (let i = 0; i < runs.length; ) {
    const r = runs[i];
    const ref = Array.isArray(r) && r[2] && !r[2].atom ? r[2].ref : null;
    const p = ref ? parseRef(ref) : null;
    if (!p) {
      out.push(r);
      i++;
      continue;
    }
    let j = i;
    let text = '';
    let styled = false;
    let hl = null;
    while (j < runs.length && Array.isArray(runs[j]) && runs[j][2]?.ref === ref && !runs[j][2].atom) {
      const t = typeof runs[j][0] === 'string' ? runs[j][0] : '';
      text += ctx.heading ? t.replace(/\n/g, ' ') : t; // a heading is one line
      if (/[bisuc]/.test(typeof runs[j][1] === 'string' ? runs[j][1] : '')) styled = true;
      hl ||= runs[j][2].hl || null;
      j++;
    }
    let chip = !styled && !text.includes('\n') && !!text.trim();
    if (chip && p.kind === 'note') {
      const title = ctx.noteTitle ? ctx.noteTitle(p.id) : null;
      chip = !ctx.noteTitle || title == null || sameText(text, title);
    }
    if (chip) out.push([text, '', { ref, ...(hl ? { hl } : {}), atom: 1 }]);
    else for (let k = i; k < j; k++) out.push(runs[k]);
    i = j;
  }
  return out;
}

/** runs → md items: {k:'text'|'code'|'br'|'atom', text, m:Set, link:{key, url}|null, atom?} */
function toItems(runs, ctx) {
  const items = [];
  for (const r of chipify(Array.isArray(runs) ? runs : [], ctx)) {
    if (!Array.isArray(r)) continue;
    let text = typeof r[0] === 'string' ? r[0] : typeof r[0] === 'number' ? String(r[0]) : '';
    if (!text) continue;
    const marks = typeof r[1] === 'string' ? r[1] : '';
    const a = r[2] || null;
    const m = new Set();
    for (const x of 'bius') if (marks.includes(x)) m.add(x);
    if (a?.hl) m.add('h');
    if (a?.atom && a.ref) {
      // Chip labels are trimmed when read back, so their edge spaces are written outside the brackets.
      const label = text.replace(/\n/g, ' ');
      const lead = /^\s*/.exec(label)[0];
      const trail = label.trim() ? label.slice(label.length - trailRun(label, WS1)) : '';
      if (lead) items.push({ k: 'text', text: lead, m: new Set(), link: null });
      items.push({ k: 'atom', text: label.trim() || label, m, ref: a.ref, link: null });
      if (trail) items.push({ k: 'text', text: trail, m: new Set(), link: null });
      continue;
    }
    const link = a?.ref ? { key: `r:${a.ref}`, url: refUrl(a.ref) } : a?.href ? { key: `h:${a.href}`, url: a.href } : null;
    const code = marks.includes('c');
    if (ctx.heading) text = text.replace(/\n/g, ' ');
    const parts = text.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) {
        // Spaces before a line break don't survive Markdown (a hard break drops them): leave them out.
        for (let last = items[items.length - 1]; last?.k === 'text' && /[ \t]$/.test(last.text); last = items[items.length - 1]) {
          last.text = trimEndSpTab(last.text);
          if (last.text) break;
          items.pop();
        }
        items.push({ k: 'br', m: new Set(m), link: null });
      }
      // Spaces that start a line (after a break, or the block) are dropped when it's read back.
      const lineStart = !items.length || items[items.length - 1].k === 'br';
      const t = !code && lineStart ? p.replace(/^[ \t]+/, '') : p;
      if (t) items.push({ k: code ? 'code' : 'text', text: t, m: new Set(m), link });
    });
  }
  // A line break (or spaces) at the very end can't be written: "a\" at the end of a block reads back
  // as a literal backslash. Markdown drops trailing whitespace anyway.
  while (items.length && (items[items.length - 1].k === 'br' || (items[items.length - 1].k === 'text' && SP_TAB_ONLY.test(items[items.length - 1].text)))) items.pop();
  // …and trailing spaces are trimmed before escaping, so an edge "=" is escaped the same way next time.
  const last = items[items.length - 1];
  if (last?.k === 'text') last.text = trimEndSpTab(last.text);
  return fixEdges(items);
}

const intersect = (a, b) => new Set([...a].filter((x) => b.has(x)));
const DELIMS = new Set(['b', 'i', 's', 'h']); // marks written with flanking delimiters (<u> has no such rules)
const PUNCT_EDGE_START = /^[\p{P}\p{S}]+/u;
const WS1 = /^\s$/u;
const PUNCT1 = /^[\p{P}\p{S}]$/u;
// Markdown only drops spaces and tabs at line ends (JS trim() would also drop U+FEFF, NBSP …, which stay).
const SP_TAB_ONLY = /^[ \t]*$/;

// End-anchored regexes like /\s+$/ backtrack quadratically on long runs, so trailing runs are
// measured with loops (one character test each).
/** Length (UTF-16 units) of the run of code points matching `re` (a one-character test) at the end of s. */
function trailRun(s, re) {
  let e = s.length;
  while (e > 0) {
    let k = e - 1;
    const c = s.charCodeAt(k);
    if (c >= 0xdc00 && c <= 0xdfff && k > 0) {
      const h = s.charCodeAt(k - 1);
      if (h >= 0xd800 && h <= 0xdbff) k--;
    }
    if (!re.test(s.slice(k, e))) break;
    e = k;
  }
  return s.length - e;
}
/** s without trailing spaces and tabs. */
function trimEndSpTab(s) {
  let e = s.length;
  while (e > 0 && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  return e === s.length ? s : s.slice(0, e);
}
const isWordChar = (c) => c !== undefined && !/\s/u.test(c) && !/[\p{P}\p{S}]/u.test(c);
/** First / last code point of a string (emoji count as one symbol, like CommonMark). */
const firstCp = (s) => (s ? String.fromCodePoint(s.codePointAt(0)) : undefined);
const lastCp = (s) => {
  if (!s) return undefined;
  const n = s.length;
  const c = s.charCodeAt(n - 1);
  if (c >= 0xdc00 && c <= 0xdfff && n >= 2) {
    const h = s.charCodeAt(n - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.slice(-2);
  }
  return s[n - 1];
};
/** The character the serialized item starts / ends with (links, chips and code start with punctuation). */
const firstChar = (it) => (!it || it.k === 'br' ? undefined : it.k === 'text' ? firstCp(it.text) : it.k === 'code' ? '`' : '[');
const lastChar = (it) => (!it || it.k === 'br' ? undefined : it.k === 'text' ? lastCp(it.text) : it.k === 'code' ? '`' : ')');
const sameMarks = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** Merge neighbours that ended up with the same kind, marks and link (e.g. code spans whose marks were dropped). */
function mergeItems(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && (it.k === 'text' || it.k === 'code') && last.k === it.k && last.link?.key === it.link?.key && sameMarks(last.m, it.m)) {
      out[out.length - 1] = { ...last, text: last.text + it.text };
    } else out.push(it);
  }
  return out;
}

/**
 * Delimiters can't sit next to whitespace on their inner side ("** a**" is not bold), so leading and
 * trailing spaces of a marked span move outside it. Likewise a delimiter between punctuation and a
 * letter can't open or close ("**a.**b"), so that edge punctuation moves outside the span. Whitespace-
 * only pieces keep only the marks that continue on both sides.
 */
function fixEdges(items) {
  // One item's marks can change after its neighbour was looked at: repeat until nothing changes.
  let cur = items;
  for (let pass = 0; pass < 4; pass++) {
    const next = fixEdgesOnce(cur);
    const same = next.length === cur.length && next.every((x, i) => x.text === cur[i].text && x.k === cur[i].k && sameMarks(x.m, cur[i].m));
    cur = next;
    if (same) break;
  }
  return cur;
}

function fixEdgesOnce(items) {
  const out = [];
  const marksOf = (x, it) => (x && x.k !== 'br' && x.link?.key === it.link?.key ? x.m : new Set());
  // A neighbour in another link is written as "[…](…)": the character next to it is a bracket.
  const charBefore = (x, it) => (x && x.k === 'text' && x.link?.key !== it.link?.key ? (it.link ? '[' : ')') : lastChar(x));
  const charAfter = (x, it) => (x && x.k === 'text' && x.link?.key !== it.link?.key ? (it.link ? ']' : '[') : firstChar(x));
  // <u></u> has no flanking rules: spaces at its edges stay underlined (only **, *, ~~, == need them out).
  const edge = (m, kept) => new Set([...kept, ...[...m].filter((x) => !DELIMS.has(x))]);
  for (let i = 0; i < items.length; i++) {
    let it = items[i];
    const prev = out[out.length - 1];
    const next = items[i + 1];
    const prevM = marksOf(prev, it);
    const nextM = marksOf(next, it);
    const opening = [...it.m].filter((m) => DELIMS.has(m) && !prevM.has(m));
    const closing = [...it.m].filter((m) => DELIMS.has(m) && !nextM.has(m));
    if (it.k === 'code') {
      // A code span starts and ends with a backtick (punctuation): a delimiter between it and a letter
      // can't open or close, so those marks are dropped from the span.
      const drop = new Set([...(isWordChar(charBefore(prev, it)) ? opening : []), ...(isWordChar(charAfter(next, it)) ? closing : [])]);
      out.push(drop.size ? { ...it, m: new Set([...it.m].filter((m) => !drop.has(m))) } : it);
      continue;
    }
    if (it.k !== 'text' || !it.m.size) {
      out.push(it);
      continue;
    }
    if (!it.text.trim()) {
      out.push({ ...it, m: edge(it.m, intersect(it.m, intersect(prevM, nextM))) });
      continue;
    }
    let core = it.text;
    let head = '';
    let tail = '';
    let before = charBefore(prev, it);
    let after = charAfter(next, it);
    for (;;) {
      const ws = /^\s+/u.exec(core)?.[0];
      if (ws) {
        head += ws;
        core = core.slice(ws.length);
        before = ' ';
        continue;
      }
      const p = opening.length && isWordChar(before) ? PUNCT_EDGE_START.exec(core)?.[0] : null;
      if (p && p.length < core.length) {
        head += p;
        core = core.slice(p.length);
        before = p[p.length - 1];
        continue;
      }
      break;
    }
    for (;;) {
      const wn = trailRun(core, WS1);
      if (wn) {
        tail = core.slice(core.length - wn) + tail;
        core = core.slice(0, core.length - wn);
        after = ' ';
        continue;
      }
      const pn = closing.length && isWordChar(after) ? trailRun(core, PUNCT1) : 0;
      const p = pn ? core.slice(core.length - pn) : null;
      if (p && p.length < core.length) {
        tail = p + tail;
        core = core.slice(0, core.length - p.length);
        after = p[0];
        continue;
      }
      break;
    }
    if (head) out.push({ ...it, text: head, m: edge(it.m, intersect(it.m, prevM)) });
    if (core) {
      // Still a punctuation-only span between letters: write it without the marks that can't open/close.
      const stuckOpen = opening.length && isWordChar(before) && PUNCT_EDGE_START.test(core);
      const stuckClose = closing.length && isWordChar(after) && trailRun(core, PUNCT1) > 0;
      const drop = new Set([...(stuckOpen ? opening : []), ...(stuckClose ? closing : [])]);
      out.push(drop.size ? { ...it, text: core, m: new Set([...it.m].filter((m) => !drop.has(m))) } : { ...it, text: core });
    }
    if (tail) out.push({ ...it, text: tail, m: edge(it.m, intersect(it.m, nextM)) });
  }
  return mergeItems(out);
}

/** Links and chips start with "[" and end with ")": marks that would close or open against a letter go inside. */
function fixGroupEdges(list) {
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if ((g.k !== 'group' && g.k !== 'atom') || !g.m.size) continue;
    const prev = list[i - 1];
    const next = list[i + 1];
    const prevM = prev && prev.k !== 'br' ? prev.m : new Set();
    const nextM = next && next.k !== 'br' ? next.m : new Set();
    const move = new Set();
    if (isWordChar(lastChar(prev))) for (const m of g.m) if (DELIMS.has(m) && !prevM.has(m)) move.add(m);
    if (isWordChar(firstChar(next))) for (const m of g.m) if (DELIMS.has(m) && !nextM.has(m)) move.add(m);
    if (!move.size) continue;
    g.m = new Set([...g.m].filter((m) => !move.has(m)));
    if (g.k === 'group') g.children = g.children.map((c) => ({ ...c, m: new Set([...c.m, ...move]) }));
    else g.inner = move; // chip label written as [==label==](url)
  }
  return list;
}

/** Group consecutive items that share a (non-chip) link. */
function groupLinks(items) {
  const grouped = [];
  for (const it of items) {
    if (it.link) {
      const last = grouped[grouped.length - 1];
      if (last && last.k === 'group' && last.link.key === it.link.key) last.children.push(it);
      else grouped.push({ k: 'group', link: it.link, children: [it] });
    } else grouped.push(it);
  }
  // Spaces at a link's edges go outside its brackets: "[a ](…)" would read back as "a" (a chip
  // label is trimmed), so the Markdown wouldn't be stable.
  const out = [];
  for (const g of grouped) {
    if (g.k !== 'group') {
      out.push(g);
      continue;
    }
    const kids = g.children;
    let lead = '';
    let trail = '';
    while (kids.length && kids[0].k === 'text') {
      const n = /^\s*/u.exec(kids[0].text)[0].length;
      if (!n) break;
      lead += kids[0].text.slice(0, n);
      if (n < kids[0].text.length) {
        kids[0] = { ...kids[0], text: kids[0].text.slice(n) };
        break;
      }
      kids.shift();
    }
    while (kids.length && kids[kids.length - 1].k === 'text') {
      const last = kids[kids.length - 1];
      const n = trailRun(last.text, WS1);
      if (!n) break;
      trail = last.text.slice(last.text.length - n) + trail;
      if (n < last.text.length) {
        kids[kids.length - 1] = { ...last, text: last.text.slice(0, last.text.length - n) };
        break;
      }
      kids.pop();
    }
    if (lead) out.push({ k: 'text', text: lead, m: new Set(), link: null });
    if (kids.length) out.push(g);
    if (trail) out.push({ k: 'text', text: trail, m: new Set(), link: null });
  }
  for (const g of out) {
    if (g.k !== 'group') continue;
    let common = null;
    for (const c of g.children) common = common ? intersect(common, c.m) : new Set(c.m);
    g.m = common || new Set();
    g.children = g.children.map((c) => ({ ...c, link: null, m: new Set([...c.m].filter((x) => !g.m.has(x))) }));
  }
  return out;
}

function serializeItems(items, ctx, st) {
  const stack = [];
  const parts = [];
  const closeFrom = (k) => {
    while (stack.length > k) parts.push(CLOSE[stack.pop()]);
  };
  /** "!" right before a link or chip would make it an image: escape that "!" (unless it is escaped already). */
  const guardBang = () => {
    const k = parts.length - 1;
    const p = parts[k];
    if (!p || !p.endsWith('!')) return;
    let slashes = 0;
    for (let j = p.length - 2; j >= 0 && p[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) parts[k] = `${p.slice(0, -1)}\\!`;
  };
  let afterBreaks = -1; // index of the first item after the current run of line breaks
  const lasting = (i, mark) => {
    let n = 0;
    for (let j = i; j < items.length; j++) {
      if (items[j].k === 'br') continue;
      if (!items[j].m.has(mark)) break;
      n++;
    }
    return n;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k === 'br') {
      // Close what doesn't continue on the next line (or doesn't cover the break itself).
      if (afterBreaks <= i) {
        afterBreaks = i + 1;
        while (afterBreaks < items.length && items[afterBreaks].k === 'br') afterBreaks++;
      }
      const j = afterBreaks;
      const nextM = j < items.length ? intersect(items[j].m, it.m) : new Set();
      const k = stack.findIndex((m) => !nextM.has(m));
      if (k >= 0) closeFrom(k);
      parts.push(`\\\n${ctx.prefix}`);
      st.lineStart = true;
      continue;
    }
    const k = stack.findIndex((m) => !it.m.has(m));
    if (k >= 0) closeFrom(k);
    const open = MARK_ORDER.filter((m) => it.m.has(m) && !stack.includes(m));
    if (open.length > 1) open.sort((a, b) => lasting(i, b) - lasting(i, a) || MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b));
    for (const m of open) {
      parts.push(OPEN[m]);
      stack.push(m);
      st.lineStart = false;
    }
    if (it.k === 'group' || it.k === 'atom') guardBang();
    st.end = i + 1 >= items.length || items[i + 1].k === 'br'; // nothing else on this line
    const content = itemContent(it, ctx, st);
    if (content) parts.push(content);
  }
  closeFrom(0);
  return parts.join('');
}

function itemContent(it, ctx, st) {
  if (it.k === 'text') {
    // Literal [[Title]] reads back as a chip, which can't be bold/italic/struck/underlined or sit in a
    // link: with those it is escaped, so it stays the same text.
    let t = escapeText(it.text, { wiki: !ctx.inLink && ![...it.m].some((m) => m !== 'h') });
    // Spaces that start a line are dropped when it's read back, so they're left out.
    if (st.lineStart) t = escapeLineStart(t.replace(/^[ \t]+/, ''), st.end !== false);
    st.lineStart = st.lineStart && !t; // a line of only spaces hasn't started yet
    return t;
  }
  st.lineStart = false;
  if (it.k === 'code') return codeSpan(it.text);
  if (it.k === 'atom') {
    const r = parseRef(it.ref);
    const inner = MARK_ORDER.filter((m) => it.inner?.has(m));
    // A day chip showing its date is written [[YYYY-MM-DD]] (which reads back as that chip).
    if (!inner.length && r?.kind === 'day' && (ctx.wiki || it.text === r.date)) return `[[${r.date}]]`;
    if (!inner.length && ctx.wiki && r?.kind === 'note' && !r.blockId) {
      const title = ctx.noteTitle?.(r.id) ?? it.text;
      if (wikiSafe(title)) return `[[${title}]]`;
    }
    const label = r?.kind === 'note' ? (ctx.noteTitle?.(r.id) ?? it.text) : it.text;
    const open = inner.map((m) => OPEN[m]).join('');
    const close = [...inner].reverse().map((m) => CLOSE[m]).join('');
    return `[${open}${escapeText(label, { wiki: false })}${close}](${linkDest(refUrl(it.ref))})`;
  }
  if (it.k === 'group') {
    const inner = serializeItems(it.children, { ...ctx, inLink: true }, { lineStart: false });
    return `[${inner}](${linkDest(it.link.url)})`;
  }
  return '';
}

function serializeInline(runs, opts) {
  const ctx = { wiki: !!opts.wiki, noteTitle: typeof opts.noteTitle === 'function' ? opts.noteTitle : null, prefix: opts.prefix || '', heading: !!opts.heading };
  // Spaces moved out of a link join the text next to them (so "#" + " " + link still reads as "# …"
  // and gets its line-start escape), and at the very end they are dropped like any trailing space.
  const items = mergeItems(groupLinks(toItems(runs, ctx)));
  while (items.length && items[items.length - 1].k === 'text' && SP_TAB_ONLY.test(items[items.length - 1].text)) items.pop();
  return serializeItems(fixGroupEdges(items), ctx, { lineStart: opts.lineStart !== false });
}

// Text outside chips and note/task/event/day links (whose labels may legitimately be refreshed).
/**
 * What a round trip must keep: every visible character outside chips and note/task/event/day links
 * (whose labels may legitimately be refreshed) with its marks. Whitespace is ignored (it may move
 * outside a mark span).
 */
function markSig(runs) {
  const out = [];
  for (const r of runs) {
    if (!Array.isArray(r) || r[2]?.ref) continue;
    const t = typeof r[0] === 'string' ? r[0] : '';
    const m = `${cleanMarks(r[1])}${r[2]?.hl ? 'h' : ''}`;
    for (const ch of t) if (!WS1.test(ch)) out.push(m ? `${ch}${m}` : ch);
  }
  return out.join('\u0000');
}
const DELIM_MARK = /[bis]/;
function stripMark(runs, m) {
  return runs.map((r) => {
    if (m === 'h') {
      if (!r[2]?.hl) return r;
      const { hl: _x, ...rest } = r[2];
      return mkRun(r[0], r[1], Object.keys(rest).length ? rest : null);
    }
    return mkRun(r[0], safeString(r[1]).replace(m, ''), r[2]);
  });
}

/**
 * Inline Markdown for runs (no block prefix). opts: {wiki, noteTitle(id), prefix (after soft breaks),
 * heading}. CommonMark can't express every overlap of bold/italic/strike/highlight (crossing spans
 * next to punctuation); when the result wouldn't read back as the same text, the conflicting marks
 * are dropped (italic first, then strike, highlight, bold) instead of leaking stray delimiters.
 */
export function inlineMarkdown(runs, opts = {}) {
  let list = Array.isArray(runs) ? runs.filter(Array.isArray) : [];
  let md = serializeInline(list, opts);
  if (!list.some((r) => DELIM_MARK.test(typeof r[1] === 'string' ? r[1] : '') || r[2]?.hl)) return md;
  // Every visible character must read back with the same marks, not just the same letters.
  const check = (l) => markSig(parseInline(serializeInline(l, { ...opts, wiki: false, noteTitle: null, prefix: '' }))) === markSig(l);
  if (check(list)) return md;
  for (const m of ['i', 's', 'h', 'b']) {
    list = stripMark(list, m);
    md = serializeInline(list, opts);
    if (check(list)) return md;
  }
  return md;
}

function fenceFor(text) {
  let longest = 0;
  for (const m of text.matchAll(/^[ \t]*(`{3,})/gm)) longest = Math.max(longest, m[1].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** One block as Markdown (no trailing newline). `num` is its list number for numbered items. */
export function blockToMarkdown(b, opts = {}, num = 1) {
  if (!b || typeof b !== 'object') return '';
  const inl = (o) => inlineMarkdown(b.c, { ...opts, ...o });
  switch (b.t) {
    case 'h1':
    case 'h2':
    case 'h3': {
      const hashes = '#'.repeat(Number(b.t[1]));
      // A trailing run of # after a space (or alone) would read as the closing sequence: escape its
      // first # (once: text that starts with "#" is escaped as a line start already).
      const text = trimEndSpTab(inl({ heading: true })).replace(/(^|[ \t])(#+)$/, '$1\\$2');
      return text ? `${hashes} ${text}` : hashes;
    }
    case 'quote': {
      const text = inl({ prefix: '> ' });
      return text ? `> ${text}` : '>';
    }
    case 'code': {
      const text = blockText(b);
      const fence = fenceFor(text);
      // Only a canonical language name: anything else could break the fence line (or throw when printed).
      return `${fence}${typeof b.lang === 'string' && LANG_RE.test(b.lang) ? b.lang : ''}\n${text}${text ? '\n' : ''}${fence}`;
    }
    case 'hr':
      return '---';
    case 'bullet':
    case 'dash':
    case 'num':
    case 'check': {
      const indent = '    '.repeat(Number.isInteger(b.in) ? Math.max(0, Math.min(6, b.in)) : 0);
      const marker = b.t === 'bullet' ? '* ' : b.t === 'dash' ? '- ' : b.t === 'num' ? `${num}. ` : b.ck ? '- [x] ' : '- [ ] ';
      let text = inl({ prefix: indent + ' '.repeat(marker.length) });
      if (b.t === 'check' && isBlockId(b.task)) {
        text = trimEndSpTab(text); // reading back drops spaces before the [task] link
        text += `${text ? ' ' : ''}[task](ecosys://task/${b.task})`;
      }
      return trimEndSpTab(`${indent}${marker}${text}`);
    }
    default:
      return inl({});
  }
}

/** A Body with nothing to write: only spaces, tabs and line breaks, and no code span (` ` is text). */
const isEmptyP = (b) => b.t === 'p' && !(Array.isArray(b.c) ? b.c : []).some((r) => Array.isArray(r) && ((typeof r[1] === 'string' && r[1].includes('c')) || !/^[ \t\n]*$/.test(safeString(r[0]))));

/**
 * Blocks → Markdown. opts.wiki writes note and day chips as [[Title]] / [[YYYY-MM-DD]] (file export);
 * opts.noteTitle(id) gives the current title of a linked note (fresh chip labels).
 */
export function blocksToMarkdown(blocks, opts = {}) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && typeof b === 'object');
  let out = '';
  let prev = null;
  let empties = 0;
  const lastType = [];
  const counters = [];
  for (const b of list) {
    if (isEmptyP(b)) {
      empties++;
      lastType.length = 0;
      continue;
    }
    let num = 1;
    if (LIST.has(b.t)) {
      const L = Number.isInteger(b.in) ? Math.max(0, Math.min(6, b.in)) : 0; // as blockToMarkdown indents it
      lastType.length = Math.min(lastType.length, L + 1);
      counters.length = Math.min(counters.length, L + 1);
      if (b.t === 'num') {
        // List numbers have at most 9 digits (a longer one isn't a list marker any more).
        counters[L] = Math.min(999999999, lastType[L] === 'num' ? counters[L] + 1 : Number.isInteger(b.start) ? b.start : 1);
        num = counters[L];
      }
      lastType[L] = b.t;
    } else lastType.length = 0;
    const md = blockToMarkdown(b, opts, num);
    if (!md) {
      // Writes nothing (e.g. an unvalidated block without a type): an empty line, like an empty Body.
      empties++;
      continue;
    }
    if (prev) {
      let sep = LIST.has(prev.t) && LIST.has(b.t) ? '\n' : prev.t === 'quote' && b.t === 'quote' ? '\n>\n' : '\n\n';
      if (empties) sep = `\n\n${'\n'.repeat(empties)}`;
      out += sep;
    }
    out += md;
    prev = b;
    empties = 0;
  }
  // A U+FEFF that starts the text would read back as a byte-order mark and vanish: leave it out.
  if (out.startsWith('\u{FEFF}')) out = out.slice(1).replace(/^\n+/, '');
  return out ? `${out}\n` : '';
}

// Windows reserves device names even with an extension ("con.txt"): the part before the first dot
// counts, spaces before that dot are ignored ("nul .txt"), and COM¹-³ / LPT¹-³ and the console
// names CONIN$ / CONOUT$ are reserved too.
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?= *(?:\.|$))/i;

/**
 * A file or folder name that Windows can create: '_' goes after a device name it starts with
 * ('con.txt' → 'con_.txt', 'NUL' → 'NUL_', 'LPT¹' → 'LPT¹_'); any other name comes back unchanged.
 */
export const avoidDeviceName = (name) => safeString(name).replace(DEVICE_NAME_RE, '$1_');

/** A filesystem-safe base name for a note's title (case and spaces kept, so [[Title]] links resolve). */
export function slugify(title, fallback = 'Untitled') {
  let s = cleanText(title)
    .normalize('NFC')
    .replace(/[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, '')
    .replace(/[<>:"/\\|?*\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  s = avoidDeviceName(s);
  if (s.length > 80) s = cut(s, 80).replace(/[.\s]+$/, '');
  if (!s) s = safeString(fallback) || 'Untitled';
  return s;
}

const yamlStr = (s) => `"${safeString(s).replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, ' ')}"`;
// Only real dates: new Date(ms).toISOString() throws past ±8.64e15 ms.
const iso = (ms) => (Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null);

/**
 * A whole note as Markdown. opts: {frontMatter=false, folderPath, wiki=true, noteTitle(id)}.
 * Front matter (YAML): title, created, updated, tags, folder, pinned, day.
 */
export function noteToMarkdown(note, { frontMatter = false, folderPath, wiki = true, noteTitle } = {}) {
  const body = blocksToMarkdown(note?.blocks, { wiki, noteTitle });
  if (!frontMatter) return body;
  const lines = ['---', `title: ${yamlStr(safeString(note?.title) || 'New Note')}`];
  const created = iso(note?.createdAt);
  const updated = iso(note?.editedAt ?? note?.updatedAt);
  if (created) lines.push(`created: ${created}`);
  if (updated) lines.push(`updated: ${updated}`);
  const tags = Array.isArray(note?.tags) ? note.tags.map(safeString).filter(Boolean) : [];
  if (tags.length) lines.push(`tags: [${tags.join(', ')}]`);
  if (safeString(folderPath)) lines.push(`folder: ${yamlStr(folderPath)}`);
  if (note?.pinned) lines.push('pinned: true');
  if (typeof note?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(note.day)) lines.push(`day: ${note.day}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n${body}`;
}

/** Simple YAML front matter ({key: value | [list]}) and the rest of the text. Nothing is evaluated. */
export function parseFrontMatter(text) {
  const src = safeString(text).replace(/^\u{FEFF}/u, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  const data = Object.create(null);
  if (!m) return { data, body: src };
  const lines = m[1].split(/\r?\n/);
  if (!lines.every((l) => !l.trim() || /^[A-Za-z_][\w-]{0,40}\s*:/.test(l) || /^\s+-\s/.test(l) || /^\s/.test(l))) return { data, body: src };
  let lastKey = null;
  for (const line of lines) {
    const kv = /^([A-Za-z_][\w-]{0,40})\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1].toLowerCase();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const raw = kv[2].trim();
      lastKey = key;
      data[key] = /^\[.*\]$/.test(raw) ? raw.slice(1, -1).split(',').map(unquote).filter(Boolean) : raw === '' ? [] : unquote(raw);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && lastKey) {
      if (!Array.isArray(data[lastKey])) data[lastKey] = [];
      data[lastKey].push(unquote(item[1]));
    }
  }
  for (const k of Object.keys(data)) if (Array.isArray(data[k]) && !data[k].length) data[k] = '';
  return { data, body: src.slice(m[0].length) };
}

function unquote(s) {
  const t = safeString(s).trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return t;
}

// ================================================================ Markdown → blocks
//
// The inline parser runs in linear time, whatever the input (an MCP call holds the server's data lock
// while it parses, and a pasted file must not freeze a tab): one left-to-right pass with CommonMark's
// bracket stack for links (no look-ahead scans), a delimiter list for emphasis, and memoized searches
// for code-span and link-title closers. Nodes live in linked lists, so wrapping a range of them in a
// mark or a link is O(1).

const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/u;
const SPECIAL = new Set(['\\', '\n', '`', '<', '[', ']', '!', '*', '_', '~', '=']);

const isWhite = (c) => c === undefined || WS_RE.test(c);
const isPunct = (c) => c !== undefined && PUNCT_RE.test(c);

function runLen(s, i, ch, to) {
  let j = i;
  while (j < to && s[j] === ch) j++;
  return j - i;
}

/**
 * Index of the backtick run of exactly n backticks that closes a code span, or -1. `memo` remembers
 * where the last run of each length is once a search has reached the end, so an unclosed run costs
 * O(1) after the first full scan (cmark's trick); a search that succeeds ends where the span is consumed.
 */
function backtickClose(s, from, to, n, memo) {
  if (memo.scanned && !(memo.last.get(n) >= from)) return -1;
  let i = from;
  while (i < to) {
    const k = s.indexOf('`', i);
    if (k < 0 || k >= to) break;
    const len = runLen(s, k, '`', to);
    if (!(memo.last.get(len) >= k)) memo.last.set(len, k);
    if (len === n) return k;
    i = k + len;
  }
  memo.scanned = true;
  return -1;
}

const unescapeMd = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

function skipLineWs(s, i, to) {
  let nl = 0;
  while (i < to && (s[i] === ' ' || s[i] === '\t' || (s[i] === '\n' && nl++ === 0))) i++;
  return i;
}

function skipSpaces(s, i, to) {
  while (i < to && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/**
 * First unescaped `close` at or after `from` (a link title's end), or -1. Searches start right after a
 * title opener (never a backslash), so they all agree on which characters are escaped, and one
 * remembered answer serves every later search that starts before it.
 */
function titleClose(s, from, to, close, memo) {
  const m = memo.get(close);
  if (m && m.from <= from && (m.at < 0 || m.at >= from)) return m.at;
  let k = from;
  while (k < to && s[k] !== close) k += s[k] === '\\' ? 2 : 1;
  const at = k < to ? k : -1;
  memo.set(close, { from, at });
  return at;
}

/** `(dest "title")` starting at s[j0] === '(' (right after a link's "]"). → {url, end} or null. */
function linkTail(s, j0, to, memo) {
  let j = skipLineWs(s, j0 + 1, to);
  let url;
  if (s[j] === '<') {
    let k = j + 1;
    while (k < to && s[k] !== '>' && s[k] !== '<' && s[k] !== '\n') k += s[k] === '\\' ? 2 : 1;
    if (s[k] !== '>') return null;
    url = unescapeMd(s.slice(j + 1, k));
    j = k + 1;
  } else {
    const st = j;
    let par = 0;
    while (j < to) {
      const c = s[j];
      if (c === '\\' && ASCII_PUNCT_RE.test(s[j + 1] || '')) {
        j += 2;
        continue;
      }
      if (c === '(') {
        if (++par > 32) return null;
      } else if (c === ')') {
        if (par === 0) break;
        par--;
      } else if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      j++;
    }
    url = unescapeMd(s.slice(st, j));
  }
  const afterDest = j;
  j = skipLineWs(s, j, to);
  if (j > afterDest && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const k = titleClose(s, j + 1, to, s[j] === '(' ? ')' : s[j], memo);
    if (k < 0) return null;
    j = skipLineWs(s, k + 1, to);
  }
  if (s[j] !== ')') return null;
  return { url, end: j + 1 };
}

const WIKI_MAX = 200;
/** [[Title]] / [[Title|label]] starting at s[at] === '[' && s[at+1] === '[' (looks at most 204 characters ahead). */
function tryWiki(s, at, to) {
  const lim = Math.min(to, at + WIKI_MAX + 4);
  let k = at + 2;
  while (k < lim && s[k] !== ']') {
    if (s[k] === '[' || s[k] === '\n') return null;
    k++;
  }
  if (k + 1 >= lim || s[k] !== ']' || s[k + 1] !== ']') return null;
  const inner = s.slice(at + 2, k);
  if (!inner.trim() || inner.length > WIKI_MAX) return null;
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
  if (!target) return null;
  return { node: { t: 'wiki', target, label: label || target, raw: s.slice(at, k + 2) }, end: k + 2 };
}

// ---------------------------------------------------------------- node lists

const newList = () => ({ head: null, tail: null });
function append(list, node) {
  node.prev = list.tail;
  node.next = null;
  if (list.tail) list.tail.next = node;
  else list.head = node;
  list.tail = node;
  return node;
}
function unlink(list, node) {
  if (node.prev) node.prev.next = node.next;
  else list.head = node.next;
  if (node.next) node.next.prev = node.prev;
  else list.tail = node.prev;
  node.prev = node.next = null;
}
/** Move the nodes strictly between a and b (a before b, same list) into `node`, which takes their place. */
function wrapBetween(a, b, node) {
  const kids = newList();
  if (a.next !== b) {
    kids.head = a.next;
    kids.tail = b.prev;
    kids.head.prev = null;
    kids.tail.next = null;
  }
  node.kids = kids;
  node.prev = a;
  node.next = b;
  a.next = node;
  b.prev = node;
  return node;
}
/** Detach every node after `a` into a new list. */
function cutAfter(list, a) {
  const kids = newList();
  if (a.next) {
    kids.head = a.next;
    kids.tail = list.tail;
    kids.head.prev = null;
    a.next = null;
    list.tail = a;
  }
  return kids;
}

/** Inline Markdown → node tree (lists of text, code, br, mark, link and wiki nodes). Linear time. */
function parseNodes(s) {
  const to = s.length;
  const root = newList();
  let buf = []; // pending literal text, in pieces (joined once per text node)
  const flush = () => {
    if (!buf.length) return;
    const text = buf.length === 1 ? buf[0] : buf.join('');
    buf = [];
    if (text) append(root, { t: 'text', text });
  };
  /** Drop trailing spaces/tabs of the pending text. → how many spaces ended it (2+ before a newline: hard break). */
  const stripTrail = () => {
    let spaces = 0;
    let counting = true;
    while (buf.length) {
      const p = buf[buf.length - 1];
      let j = p.length;
      while (j > 0 && (p[j - 1] === ' ' || p[j - 1] === '\t')) {
        if (counting) {
          if (p[j - 1] === ' ') spaces++;
          else counting = false;
        }
        j--;
      }
      if (j > 0) {
        buf[buf.length - 1] = p.slice(0, j);
        break;
      }
      buf.pop();
    }
    return spaces;
  };

  // Delimiter list (emphasis), oldest first. seq numbers order it, so bounds survive removals.
  const D = { head: null, tail: null, seq: 0 };
  const pushDelim = (d) => {
    d.seq = ++D.seq;
    d.dprev = D.tail;
    d.dnext = null;
    if (D.tail) D.tail.dnext = d;
    else D.head = d;
    D.tail = d;
  };
  const brackets = []; // open "[" / "![": {node, bottom (delimiter seq when pushed), image, seq}
  let pushed = 0;
  let noLinksUpTo = 0; // "[" openers pushed before the latest link can't make links (no links in links)
  const ticks = { scanned: false, last: new Map() };
  const titles = new Map();

  let i = 0;
  while (i < to) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '\n' && i + 1 < to) {
        stripTrail();
        flush();
        append(root, { t: 'br' });
        i = skipSpaces(s, i + 2, to);
        continue;
      }
      if (n !== undefined && i + 1 < to && ASCII_PUNCT_RE.test(n)) {
        buf.push(n);
        i += 2;
        continue;
      }
      buf.push('\\');
      i++;
      continue;
    }
    if (c === '\n') {
      if (stripTrail() >= 2) {
        flush();
        append(root, { t: 'br' });
      } else buf.push(' ');
      i = skipSpaces(s, i + 1, to);
      continue;
    }
    if (c === '`') {
      const n = runLen(s, i, '`', to);
      const close = backtickClose(s, i + n, to, n, ticks);
      if (close >= 0) {
        flush();
        let code = s.slice(i + n, close).replace(/\n/g, ' ');
        if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
        append(root, { t: 'code', text: code });
        i = close + n;
      } else {
        buf.push('`'.repeat(n));
        i += n;
      }
      continue;
    }
    if (c === '<') {
      const tag = s.slice(i, i + 4).toLowerCase();
      if (tag.startsWith('<u>') || tag === '</u>') {
        flush();
        const len = tag === '</u>' ? 4 : 3;
        const node = append(root, { t: 'text', text: s.slice(i, i + len) });
        pushDelim({ ch: 'u', node, len: 1, orig: 1, open: len === 3, close: len === 4 });
        i += len;
        continue;
      }
      buf.push('<');
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      const at = image ? i + 1 : i;
      if (s[at + 1] === '[') {
        const w = tryWiki(s, at, to);
        if (w) {
          if (image) buf.push('!'); // "![[Title]]": a literal "!" before a wiki link
          flush();
          append(root, w.node);
          i = w.end;
          continue;
        }
      }
      flush();
      const node = append(root, { t: 'text', text: image ? '![' : '[' });
      brackets.push({ node, bottom: D.seq, image, seq: ++pushed });
      i = at + 1;
      continue;
    }
    if (c === ']') {
      const br = brackets[brackets.length - 1];
      const usable = br && (br.image || br.seq > noLinksUpTo);
      const l = usable && s[i + 1] === '(' ? linkTail(s, i + 1, to, titles) : null;
      if (!l) {
        if (br) brackets.pop();
        buf.push(']');
        i++;
        continue;
      }
      flush();
      brackets.pop();
      processEmphasis(D, br.bottom);
      const kids = cutAfter(root, br.node);
      unlink(root, br.node);
      const node = { t: 'link', url: l.url, kids };
      if (br.image) {
        node.kids = newList();
        append(node.kids, { t: 'text', text: plainOf(kids).trim() || 'Image' });
      } else noLinksUpTo = pushed;
      append(root, node);
      i = l.end;
      continue;
    }
    if (c === '*' || c === '_' || c === '~' || c === '=') {
      const n = runLen(s, i, c, to);
      if ((c === '~' || c === '=') && n !== 2) {
        buf.push(c.repeat(n));
        i += n;
        continue;
      }
      const prev = i > 0 ? lastCp(s.slice(Math.max(0, i - 2), i)) : undefined;
      const next = i + n < to ? firstCp(s.slice(i + n, i + n + 2)) : undefined;
      const left = !isWhite(next) && (!isPunct(next) || isWhite(prev) || isPunct(prev));
      const right = !isWhite(prev) && (!isPunct(prev) || isWhite(next) || isPunct(next));
      const open = c === '_' ? left && (!right || isPunct(prev)) : left;
      const close = c === '_' ? right && (!left || isPunct(next)) : right;
      flush();
      const node = append(root, { t: 'text', text: c.repeat(n) });
      if (open || close) pushDelim({ ch: c, node, len: n, orig: n, open, close });
      i += n;
      continue;
    }
    let j = i + 1;
    while (j < to && !SPECIAL.has(s[j])) j++;
    buf.push(s.slice(i, j));
    i = j;
  }
  flush();
  processEmphasis(D, 0);
  return root;
}

function unlinkDelim(D, d) {
  if (d.dprev) d.dprev.dnext = d.dnext;
  else D.head = d.dnext;
  if (d.dnext) d.dnext.dprev = d.dprev;
  else D.tail = d.dprev;
  d.dprev = d.dnext = null;
}

/**
 * CommonMark's "process emphasis" (with the rule of 3) for the delimiters above `bottom` (a seq), plus
 * ~~ / == / <u></u>; afterwards those delimiters are off the list. A matched pair wraps the nodes
 * between it in a mark node, and the delimiters in between are dropped. Amortized linear: a failed
 * search raises the floor for its kind of closer, a successful one removes everything it walked over.
 */
function processEmphasis(D, bottom) {
  let closer = D.tail;
  if (!closer || closer.seq <= bottom) return;
  while (closer.dprev && closer.dprev.seq > bottom) closer = closer.dprev;
  const floor = new Map();
  while (closer) {
    if (!closer.close || closer.len <= 0) {
      closer = closer.dnext;
      continue;
    }
    const star = closer.ch === '*' || closer.ch === '_';
    const key = star ? `${closer.ch}${closer.open ? 1 : 0}${closer.orig % 3}` : closer.ch;
    const lo = Math.max(bottom, floor.get(key) ?? 0);
    let op = closer.dprev;
    while (op && op.seq > lo) {
      if (op.ch === closer.ch && op.open && op.len > 0 && !(star && (op.close || closer.open) && (op.orig + closer.orig) % 3 === 0 && !(op.orig % 3 === 0 && closer.orig % 3 === 0))) break;
      op = op.dprev;
    }
    if (!op || op.seq <= lo) {
      floor.set(key, closer.dprev ? closer.dprev.seq : bottom);
      const next = closer.dnext;
      if (!closer.open) unlinkDelim(D, closer);
      closer = next;
      continue;
    }
    let use;
    let mark;
    if (op.ch === 'u') {
      use = 1;
      mark = 'u';
    } else if (op.ch === '~' || op.ch === '=') {
      use = 2;
      mark = op.ch === '~' ? 's' : 'h';
    } else {
      use = op.len >= 2 && closer.len >= 2 ? 2 : 1;
      mark = use === 2 ? 'b' : 'i';
    }
    wrapBetween(op.node, closer.node, { t: 'mark', m: mark });
    // Delimiters between the pair can't match any more.
    op.dnext = closer;
    closer.dprev = op;
    op.len -= use;
    closer.len -= use;
    op.node.text = op.ch === 'u' ? '' : op.node.text.slice(0, op.len);
    closer.node.text = closer.ch === 'u' ? '' : closer.node.text.slice(0, closer.len);
    if (op.len <= 0) unlinkDelim(D, op);
    if (closer.len <= 0) {
      const next = closer.dnext;
      unlinkDelim(D, closer);
      closer = next;
    }
  }
  // Everything above the bottom is done: unmatched delimiters stay literal text.
  while (D.tail && D.tail.seq > bottom) unlinkDelim(D, D.tail);
}

/** Plain text of a node list (iterative: emphasis can nest very deep). */
function plainOf(list) {
  let s = '';
  const stack = [list.head];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    stack.push(n.next);
    if (n.t === 'text' || n.t === 'code') s += n.text;
    else if (n.t === 'br') s += ' ';
    else if (n.t === 'wiki') s += n.label;
    else if (n.kids) stack.push(n.kids.head);
  }
  return s;
}

/** Does the list contain a mark node passing `test(m)` (or, with code, a code span)? */
function hasMark(list, test, { code = false } = {}) {
  const stack = [list.head];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if ((n.t === 'mark' && test(n.m)) || (code && n.t === 'code')) return true;
    stack.push(n.next);
    if (n.kids) stack.push(n.kids.head);
  }
  return false;
}

const sameText = (a, b) => safeString(a).trim().toLowerCase() === safeString(b).trim().toLowerCase();

/** Node tree → runs. ctx: {hl, noteTitle(id), resolveNote(title)}. Iterative (an explicit stack). */
function flatten(list, ctx) {
  const out = [];
  const attrs = (st, link) => {
    const a = {};
    if (link?.ref) a.ref = link.ref;
    if (link?.href) a.href = link.href;
    if (st.hl) a.hl = ctx.hl;
    if (link?.atom) a.atom = 1;
    return a;
  };
  const stack = [{ n: list.head, st: { marks: '', link: null, hl: false } }];
  while (stack.length) {
    const fr = stack[stack.length - 1];
    const n = fr.n;
    if (!n) {
      stack.pop();
      continue;
    }
    fr.n = n.next;
    const st = fr.st;
    if (n.t === 'text') {
      if (n.text) out.push(mkRun(n.text, st.marks, attrs(st, st.link)));
    } else if (n.t === 'code') {
      if (n.text) out.push(mkRun(n.text, st.marks.includes('c') ? st.marks : st.marks + 'c', attrs(st, st.link)));
    } else if (n.t === 'br') {
      out.push(mkRun('\n', st.marks, attrs(st, st.link)));
    } else if (n.t === 'mark') {
      const next = n.m === 'h' ? (st.hl ? st : { ...st, hl: true }) : st.marks.includes(n.m) ? st : { ...st, marks: st.marks + n.m };
      stack.push({ n: n.kids.head, st: next });
    } else if (n.t === 'link') {
      const ref = urlRef(n.url);
      if (ref) {
        const r = parseRef(ref);
        const label = plainOf(n.kids);
        // Bold/italic/code… text linked to a note, task, event or day is linked text, never a chip
        // (chips carry no marks). A plain link to a note is a chip when its label is the note's title.
        const styled = /[bisuc]/.test(st.marks) || hasMark(n.kids, (m) => m !== 'h', { code: true });
        let atom = !styled;
        if (atom && r.kind === 'note') {
          const title = ctx.noteTitle ? ctx.noteTitle(r.id) : null;
          atom = !ctx.noteTitle || title == null || sameText(label, title);
        }
        if (!label.trim() && !styled) atom = true; // "[](ecosys://…)": a chip with its default label
        if (atom) {
          const hl = st.hl || hasMark(n.kids, (m) => m === 'h');
          out.push(mkRun(label.trim() || r.date || 'Link', '', { ref, ...(hl ? { hl: ctx.hl } : {}), atom: 1 }));
          continue;
        }
        stack.push({ n: n.kids.head, st: { ...st, link: { ref } } });
        continue;
      }
      const href = safeHref(n.url);
      stack.push({ n: n.kids.head, st: href ? { ...st, link: { href } } : st });
    } else if (n.t === 'wiki') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(n.target) && parseRef(`day:${n.target}`)) {
        out.push(mkRun(n.label === n.target ? n.target : n.label, '', { ...attrs(st, null), ref: `day:${n.target}`, atom: 1 }));
        continue;
      }
      const hit = ctx.resolveNote ? ctx.resolveNote(n.target) : null;
      if (hit && hit.id) {
        const ref = `note:${hit.id}`;
        if (sameText(n.label, n.target)) out.push(mkRun(hit.title || n.label, '', { ...attrs(st, null), ref, atom: 1 }));
        else out.push(mkRun(n.label, st.marks, attrs(st, { ref })));
      } else out.push(mkRun(n.raw, st.marks, attrs(st, st.link)));
    }
  }
  return out;
}

/** Inline Markdown → runs (not yet validated). */
export function parseInline(src, opts = {}) {
  const s = safeString(src);
  const ctx = { hl: HIGHLIGHTS.includes(opts.hl) ? opts.hl : DEFAULT_HIGHLIGHT, noteTitle: typeof opts.noteTitle === 'function' ? opts.noteTitle : null, resolveNote: typeof opts.resolveNote === 'function' ? opts.resolveNote : null };
  return flatten(parseNodes(s), ctx);
}

// ---------------------------------------------------------------- block parser

function indentOf(line) {
  let col = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    col = line[i] === '\t' ? col + 4 - (col % 4) : col + 1;
    i++;
  }
  return { ind: col, rest: line.slice(i) };
}

/** The line with up to `cols` columns of indentation removed. */
function stripCols(line, cols) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols && (line[i] === ' ' || line[i] === '\t')) {
    col = line[i] === '\t' ? col + 4 - (col % 4) : col + 1;
    i++;
  }
  return line.slice(i);
}

const isBlank = (l) => /^[ \t]*$/.test(l);
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const HR_RE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** An ATX heading line ("## Text ##") → {level, text} without the closing #s, or null. Linear (no regex). */
function atxHeading(rest) {
  let n = 0;
  while (n < 7 && rest[n] === '#') n++;
  if (n < 1 || n > 6 || (n < rest.length && rest[n] !== ' ' && rest[n] !== '\t')) return null;
  const isSp = (c) => c === ' ' || c === '\t';
  let a = n;
  let e = rest.length;
  while (a < e && isSp(rest[a])) a++;
  while (e > a && isSp(rest[e - 1])) e--;
  // The closing sequence: #s at the end, alone or after a space ("## a \#" keeps its escaped #).
  let h = e;
  while (h > a && rest[h - 1] === '#') h--;
  if (h < e && (h === a || isSp(rest[h - 1]))) {
    e = h;
    while (e > a && isSp(rest[e - 1])) e--;
  }
  return { level: n, text: rest.slice(a, e) };
}
const BULLET_RE = /^([-+*])(?:[ \t]+(.*)|[ \t]*$)/;
const ORDERED_RE = /^(\d{1,9})([.)])(?:[ \t]+(.*)|[ \t]*$)/;
const TASK_RE = /^\[([ xX])\](?:[ \t]+(.*)|[ \t]*$)/;
const BARE_TASK_RE = /^\[([ xX]?)\][ \t]+(\S.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-{2,})[ \t]*$/;
const TABLE_SEP_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isFence(rest) {
  const m = FENCE_RE.exec(rest);
  return !!m && !(m[1][0] === '`' && m[2].includes('`'));
}

/** Does this line start a block (and so end a paragraph or a list item's text)? */
function startsBlock(rest, ind, inList) {
  if (ind > 3 && !inList) return false;
  if (isFence(rest) || HR_RE.test(rest) || (rest[0] === '#' && atxHeading(rest)) || rest[0] === '>') return true;
  // Inside a list a bare marker ("-", "*", "2.") is an empty item; an empty item can't interrupt a paragraph.
  // ([^ \t], not \S: JS counts U+FEFF and other characters as \s, but they are item text here.)
  if (/^[-+*](?:[ \t]+[^ \t]|[ \t]*$)/.test(rest)) return inList || /^[-+*][ \t]+[^ \t]/.test(rest);
  const o = /^(\d{1,9})[.)](?:[ \t]+([^ \t])|[ \t]*$)/.exec(rest);
  if (o && (inList || (o[1] === '1' && o[2]))) return true;
  return BARE_TASK_RE.test(rest);
}

function tableCells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Markdown → canonical blocks. opts:
 *   noteTitle(id) → current title of a note (decides chip vs. wrapped link for ecosys://note links)
 *   resolveNote(title) → {id, title} | null (resolves [[Title]]; unresolved ones stay literal text)
 *   hl: colour for ==highlights== (default 'purple'); frontMatter: true strips a YAML header first
 *   max: most blocks returned (default 5,000, the note limit; pass Infinity to see how many there are)
 * A paragraph, item, quote or code block longer than 20,000 characters is split into several blocks.
 */
export function markdownToBlocks(md, opts = {}) {
  let src = safeString(md);
  if (src.length > MAX_INPUT) src = src.slice(0, MAX_INPUT);
  src = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\u{FFFD}').replace(/^\u{FEFF}/u, '');
  if (opts.frontMatter) src = parseFrontMatter(src).body;
  const lines = src.split('\n');
  const out = [];
  const inline = (text) => parseInline(text, opts);
  let i = 0;
  let blank = 0;
  let stack = []; // open list levels: {ind, level}
  let lastNum = []; // per level: true while a numbered run continues
  const resetLists = () => {
    stack = [];
    lastNum = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      blank++;
      i++;
      continue;
    }
    if (out.length && blank >= 2) {
      for (let k = 1; k < blank; k++) out.push({ t: 'p', c: [] });
      resetLists();
    }
    blank = 0;
    const { ind, rest } = indentOf(line);
    let m;

    // Fenced code
    if ((m = FENCE_RE.exec(rest)) && isFence(rest)) {
      const fence = m[1];
      const info = m[2].trim();
      const closeRe = new RegExp(`^${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (closeRe.test(indentOf(l).rest)) {
          i++;
          break;
        }
        body.push(stripCols(l, ind));
        i++;
      }
      const lang = info.split(/[ \t]/)[0] || '';
      out.push({ t: 'code', lang, c: body.length ? [[body.join('\n')]] : [] });
      resetLists();
      continue;
    }

    // Divider
    if (HR_RE.test(rest)) {
      out.push({ t: 'hr' });
      resetLists();
      i++;
      continue;
    }

    // ATX heading
    const atx = rest[0] === '#' ? atxHeading(rest) : null;
    if (atx) {
      out.push({ t: `h${Math.min(3, atx.level)}`, c: inline(atx.text) });
      resetLists();
      i++;
      continue;
    }

    // Block quote. Blank ">" lines separate its paragraphs (one quote block each). Our own output puts
    // one blank ">" line between quote blocks and writes an empty quote as a lone ">", so a run of b
    // blank lines holds floor((b-1)/2) empty quotes between paragraphs, floor(b/2) before the first or
    // after the last, and ceil(b/2) when the quote has no text at all (extra blank lines inside a quote
    // become empty quote lines, like extra blank lines between paragraphs become empty Body lines).
    if (rest[0] === '>') {
      const paras = [];
      const gaps = [0]; // gaps[k]: blank quote lines before paras[k]; the last entry: after the last paragraph
      let cur = null;
      while (i < lines.length) {
        const l = lines[i];
        const { ind: li, rest: lr } = indentOf(l);
        if (lr[0] === '>') {
          let r = lr;
          while (r[0] === '>') {
            r = r.slice(1);
            if (r[0] === ' ' || r[0] === '\t') r = r.slice(1);
          }
          if (isBlank(r)) {
            cur = null;
            gaps[gaps.length - 1]++;
          } else {
            if (!cur) {
              cur = [];
              paras.push(cur);
              gaps.push(0);
            }
            cur.push(r.replace(/^[ \t]+/, ''));
          }
          i++;
          continue;
        }
        if (isBlank(l) || !cur || startsBlock(lr, li, false)) break;
        cur.push(lr);
        i++;
      }
      const empties = (n) => {
        for (let k = 0; k < n; k++) out.push({ t: 'quote', c: [] });
      };
      if (!paras.length) empties(Math.ceil(gaps[0] / 2));
      paras.forEach((p, k) => {
        empties(k === 0 ? Math.floor(gaps[0] / 2) : Math.floor((gaps[k] - 1) / 2));
        out.push({ t: 'quote', c: inline(p.join('\n')) });
      });
      if (paras.length) empties(Math.floor(gaps[paras.length] / 2));
      resetLists();
      continue;
    }

    // List items (and lenient "[ ] text" checklist lines)
    const bm = BULLET_RE.exec(rest);
    const om = bm ? null : ORDERED_RE.exec(rest);
    const tm = bm || om ? null : BARE_TASK_RE.exec(rest);
    if (bm || om || tm) {
      while (stack.length && stack[stack.length - 1].ind > ind + 1) stack.pop();
      const top = stack[stack.length - 1];
      let level;
      if (!top) level = Math.min(6, Math.floor(ind / 4));
      else if (ind >= top.ind + 2) level = Math.min(6, top.level + Math.max(1, Math.round((ind - top.ind) / 4)));
      else level = top.level;
      if (top && level === top.level) stack[stack.length - 1] = { ind, level };
      else stack.push({ ind, level });
      lastNum.length = Math.min(lastNum.length, level + 1);

      let content = bm ? bm[2] ?? '' : om ? om[3] ?? '' : tm[2];
      let t = bm ? (bm[1] === '-' ? 'dash' : 'bullet') : om ? 'num' : 'check';
      let ck = tm ? /x/i.test(tm[1]) : false;
      if (bm || om) {
        const task = TASK_RE.exec(content);
        if (task) {
          t = 'check';
          ck = /x/i.test(task[1]);
          content = task[2] ?? '';
        }
      }
      const parts = [content];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) break;
        const { ind: li, rest: lr } = indentOf(l);
        if (startsBlock(lr, li, true)) break;
        parts.push(lr);
        i++;
      }
      // An item whose text starts on the next line ("- [ ]\ntext") doesn't start with a space.
      const block = { t, in: level, c: inline(parts.join('\n').replace(/^\n+/, '')) };
      if (t === 'check') {
        block.ck = ck;
        takeTaskLink(block);
      }
      if (t === 'num') {
        const n = Number(om[1]);
        if (!lastNum[level] && n !== 1) block.start = n;
        lastNum[level] = true;
      } else lastNum[level] = false;
      out.push(block);
      continue;
    }

    // Table → one Body line per row, cells joined by " | " (tables arrive in v1.2)
    if (rest.includes('|') && !rest.endsWith('\\') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEP_RE.test(lines[i + 1])) {
      out.push({ t: 'p', c: inline(tableCells(rest).join(' | ')) });
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        out.push({ t: 'p', c: inline(tableCells(lines[i]).join(' | ')) });
        i++;
      }
      resetLists();
      continue;
    }

    // Paragraph (or setext heading)
    const parts = [rest];
    let heading = null;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) break;
      if (SETEXT_RE.test(l)) {
        heading = l.trim()[0] === '=' ? 'h1' : 'h2';
        i++;
        break;
      }
      const { ind: li, rest: lr } = indentOf(l);
      if (startsBlock(lr, li, false)) break;
      parts.push(lr);
      i++;
    }
    out.push({ t: heading || 'p', c: inline(parts.join('\n')) });
    resetLists();
  }
  // Long paragraphs (and items, quotes, code) become several blocks instead of losing text past
  // 20,000 characters. opts.max (default 5,000) caps the block count; Infinity lets a caller check it.
  return validateBlocks(out, { max: opts.max ?? NOTE_LIMITS.blocks, split: true });
}

/** A checklist item ending in "[task](ecosys://task/<id>)" is linked to that task. */
function takeTaskLink(block) {
  const c = block.c;
  const last = c[c.length - 1];
  if (!isAtomRun(last)) return;
  const r = parseRef(last[2].ref);
  // Exactly "task" (what blockToMarkdown writes): a chip labelled "Task" at the end stays a chip.
  if (r?.kind !== 'task' || last[0].trim() !== 'task') return;
  c.pop();
  const prev = c[c.length - 1];
  if (prev && !isAtomRun(prev)) {
    prev[0] = trimEndSpTab(prev[0]);
    if (!prev[0]) c.pop();
  }
  block.task = r.id;
}

/** True when plain text looks like Markdown (paste heuristic, notes-spec section 3). */
export function looksLikeMarkdown(text) {
  const s = safeString(text);
  return /^(?:#{1,3} |[*-] |\d+[.)] |- \[[ xX]\] |> |```)/m.test(s) || /\*\*[^*\n]+\*\*/.test(s) || /\[[^\]\n]+\]\([^)\s]+\)/.test(s);
}
