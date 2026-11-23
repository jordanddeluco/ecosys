// notes editor: model → DOM. Everything is built with createElement / textContent; attribute values come
// from validated model fields only (ids, enum types, safe hrefs, ref grammar, highlight enum).
//
// <div class="ne-b" data-id data-type [data-checked] style="--in:n">
//   [<span class="ne-ck" data-deco contenteditable=false role=checkbox>]   (checklists)
//   <div class="ne-tx" dir="auto" [role=heading|blockquote|code]>runs… [<span class="ne-deco" data-deco>] [<br class="ne-end">]</div>
// </div>
// A trailing <br> keeps an empty line (or a line ending in a soft break, a chip or a task label) caret-able;
// readers ignore a <br> that has no text after it. Elements marked data-deco are never read back as text.
// Headings, quotes and code blocks carry their ARIA role, so a screen reader can tell a title from body text
// and jump by heading inside the note (list markers get alt text in editor.css).

import { LIST, HEADINGS, isAtom, rMarks, rAttrs, refKind, refId, blockLen } from './model.js';
import { checkCircle, taskCircle, svgIcon } from './icons.js';
import { fmt, parseYmd, todayYmd } from '../../shared/dates.js';

const isYmdStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Append text with soft breaks (\n → <br>) to a parent. */
function appendText(parent, text) {
  const parts = text.split('\n');
  parts.forEach((part, k) => {
    if (k > 0) parent.append(document.createElement('br'));
    if (part) parent.append(document.createTextNode(part));
  });
}

function wrap(tag, child, attrs) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(child);
  return n;
}

/** Relative wording for a date chip tooltip: Today, Tomorrow, In 3 days, 2 days ago… */
export function relativeDay(ymd) {
  const a = parseYmd(todayYmd());
  const b = parseYmd(ymd);
  const n = Math.round((b - a) / 86400000);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1) return n < 14 ? `In ${n} days` : n < 60 ? `In ${Math.round(n / 7)} weeks` : `In ${Math.round(n / 30)} months`;
  const m = -n;
  return m < 14 ? `${m} days ago` : m < 60 ? `${Math.round(m / 7)} weeks ago` : `${Math.round(m / 30)} months ago`;
}

/** The absolute label for a date chip: 'Sun, 22 Nov' (with the year when it isn't this year). */
export function dayChipLabel(ymd) {
  const d = parseYmd(ymd);
  const same = d.getFullYear() === new Date().getFullYear();
  return fmt(d, { weekday: 'short', day: 'numeric', month: 'short', ...(same ? {} : { year: 'numeric' }) });
}

const COLOR_RE = /^(iris|blue|teal|green|yellow|orange|red|pink|purple|graphite)$/;

function lookupRef(ref, ctx) {
  try {
    if (refKind(ref) === 'task' && ctx.taskLookup) {
      const t = ctx.taskLookup(refId(ref));
      return t ? { title: t.title, done: !!t.done, date: t.date || null, repeat: !!t.repeat } : { missing: true };
    }
    return ctx.refLookup ? ctx.refLookup(ref) || null : null;
  } catch {
    return null;
  }
}

/** A span that never wraps inside (white-space: nowrap): a chip's glyph stays with the word next to it. */
function nowrap(...kids) {
  const n = document.createElement('span');
  n.className = 'ne-nb';
  n.append(...kids.filter((k) => k !== null && k !== ''));
  return n;
}

/** Length of the word a chip's glyph is kept with: the first (or last) word; one character of a very long one. */
function edgeWord(s, end) {
  const m = end ? /\S+$/.exec(s) : /^\s*\S+/.exec(s);
  if (!m) return 0;
  if (m[0].length <= 24) return m[0].length;
  const cp = end ? s.codePointAt(s.length - 2) : s.codePointAt(0);
  return cp > 0xffff ? 2 : 1;
}

/**
 * A chip's text with its leading glyph kept on the first word and a trailing icon on the last word, so a chip
 * that wraps never leaves its circle, colour bar or repeat icon alone at the end or start of a line.
 */
function chipText(title, glyph = null, after = null) {
  const t = document.createElement('span');
  t.className = 'ne-chip-t';
  const s = String(title ?? '');
  const head = glyph ? edgeWord(s, false) : 0;
  const tail = after ? edgeWord(s, true) : 0;
  if (glyph && after && head + tail >= s.length) {
    t.append(nowrap(glyph, s, after));
    return t;
  }
  if (glyph) t.append(nowrap(glyph, s.slice(0, head)));
  const mid = s.slice(head, s.length - tail);
  if (mid) t.append(mid);
  if (after) t.append(nowrap(s.slice(s.length - tail), after));
  return t;
}

/** A chip (atom run): note / task / event / day reference. */
export function renderChip(run, ctx = {}) {
  const ref = run[2].ref;
  const kind = refKind(ref);
  const label = run[0];
  const info = lookupRef(ref, ctx);
  const chip = document.createElement('span');
  chip.className = `ne-chip ne-chip-${kind}`;
  chip.contentEditable = 'false';
  chip.dataset.ref = ref;
  chip.dataset.label = label;
  chip.setAttribute('role', 'link');
  if (info?.missing || info?.trashed) chip.classList.add('ne-missing');
  if (run[2].hl) {
    chip.classList.add('ne-chip-hl');
    chip.dataset.hl = run[2].hl;
  }
  if (kind === 'task') {
    const done = !!info?.done;
    const circle = document.createElement('span');
    circle.className = 'ne-tc';
    circle.dataset.taskToggle = '';
    circle.setAttribute('aria-hidden', 'true');
    circle.append(taskCircle(done));
    if (done) chip.classList.add('ne-done');
    const title = info?.title || label;
    chip.append(chipText(title, circle, info?.repeat ? svgIcon('repeat', { size: 13, cls: 'ne-chip-rep' }) : null));
    chip.setAttribute('aria-label', `Task: ${title}${done ? ', done' : ''}`);
    return chip;
  }
  if (kind === 'event') {
    const bar = document.createElement('span');
    bar.className = 'ne-chip-bar';
    if (info?.color && COLOR_RE.test(info.color)) bar.style.background = `var(--c-${info.color})`;
    const title = info?.title || label;
    const t = chipText(title, bar);
    // The day and time stay together; the line may break before them.
    if (info?.title && info.sub) t.append(' ', nowrap(`· ${info.sub}`));
    chip.append(t);
    chip.setAttribute('aria-label', `Event: ${t.textContent}`);
    return chip;
  }
  if (kind === 'day') {
    // Shown in the reader's own date format (the stored label is a cache for exports); short, so it never wraps.
    // The relative day ("In 2 days") is on the chip's hover card, so there is no tooltip on top of it.
    const ymd = String(ref).slice(4);
    const shown = isYmdStr(ymd) ? safeDayLabel(ymd, label) : label;
    const t = document.createElement('span');
    t.className = 'ne-chip-t';
    t.textContent = shown;
    chip.append(svgIcon('calendar', { size: 14, cls: 'ne-chip-ic' }), t);
    chip.setAttribute('aria-label', `Date: ${shown}`);
    return chip;
  }
  const title = info?.title || label;
  chip.append(chipText(title));
  chip.setAttribute('aria-label', `Note: ${title}`);
  return chip;
}

function safeDayLabel(ymd, fallback) {
  try {
    return dayChipLabel(ymd) || fallback;
  } catch {
    return fallback;
  }
}

/** Fill a text container with runs. */
export function renderRuns(tx, runs, ctx = {}) {
  let last = null;
  for (const r of runs) {
    last = r;
    if (isAtom(r)) {
      tx.append(renderChip(r, ctx));
      continue;
    }
    const frag = document.createDocumentFragment();
    appendText(frag, r[0]);
    let node = frag;
    const m = rMarks(r);
    const a = rAttrs(r);
    if (m.includes('c')) node = wrap('code', node);
    if (m.includes('s')) node = wrap('s', node);
    if (m.includes('u')) node = wrap('u', node);
    if (m.includes('i')) node = wrap('em', node);
    if (m.includes('b')) node = wrap('strong', node);
    if (a?.hl) node = wrap('mark', node, { class: 'ne-hl', 'data-hl': a.hl });
    if (a?.href) node = wrap('a', node, { class: 'ne-link', href: a.href, rel: 'noopener noreferrer' });
    else if (a?.ref) node = wrap('a', node, { class: 'ne-ref', 'data-ref': a.ref });
    tx.append(node);
  }
  if (!last || isAtom(last) || last[0].endsWith('\n')) {
    const br = document.createElement('br');
    br.className = 'ne-end';
    tx.append(br);
  }
}

/** Trailing, non-editable task info on a checklist item linked to a task (date + repeat). */
function taskMeta(b, ctx) {
  if (!b.task || !ctx.taskLookup) return null;
  let t = null;
  try {
    t = ctx.taskLookup(b.task);
  } catch {
    t = null;
  }
  if (!t) return null;
  const span = document.createElement('span');
  span.className = 'ne-deco ne-taskmeta';
  span.dataset.deco = '';
  span.contentEditable = 'false';
  span.dataset.taskRef = `task:${b.task}`;
  if (t.repeat) span.append(svgIcon('repeat', { size: 13 }));
  if (t.date && isYmdStr(t.date)) {
    const d = document.createElement('span');
    d.className = 'ne-taskdate';
    d.textContent = dayChipLabel(t.date);
    if (t.date < todayYmd() && !t.done) d.classList.add('overdue');
    span.append(d);
  }
  if (!span.childNodes.length) {
    const d = document.createElement('span');
    d.className = 'ne-taskdate';
    d.textContent = 'Task';
    span.append(d);
  }
  // A click shows the task's card (Complete / Open), like a chip.
  span.setAttribute('role', 'button');
  const due = t.date && isYmdStr(t.date) ? `, ${dayChipLabel(t.date)}` : '';
  span.setAttribute('aria-label', `Linked task${due}${t.repeat ? ', repeats' : ''}`);
  return span;
}

/** Render one block element. */
export function renderBlock(b, ctx = {}) {
  const el = document.createElement('div');
  el.className = 'ne-b';
  el.dataset.id = b.id;
  el.dataset.type = b.t;
  if (b.t === 'hr') {
    el.contentEditable = 'false';
    el.setAttribute('role', 'separator');
    const rule = document.createElement('div');
    rule.className = 'ne-rule';
    el.append(rule);
    el._b = b;
    return el;
  }
  if (LIST.has(b.t)) {
    el.style.setProperty('--in', String(b.in || 0));
    el.dataset.lvl = String((b.in || 0) % 3);
  }
  const tx = document.createElement('div');
  tx.className = 'ne-tx';
  // ids are validated block ids; the prefix keeps them unique when two editors show the same note.
  if (ctx.idPrefix) tx.id = `${ctx.idPrefix}${b.id}`;
  tx.setAttribute('dir', 'auto');
  if (b.t === 'check') {
    el.dataset.checked = String(!!b.ck);
    const ck = document.createElement('span');
    ck.className = 'ne-ck';
    ck.dataset.deco = '';
    ck.contentEditable = 'false';
    ck.setAttribute('role', 'checkbox');
    ck.setAttribute('aria-checked', String(!!b.ck));
    // Named by the item's own text (live), so a screen reader says "Milk, checkbox, not checked".
    if (tx.id) ck.setAttribute('aria-labelledby', tx.id);
    else ck.setAttribute('aria-label', 'Checklist item');
    if (ctx.readOnly) ck.setAttribute('aria-disabled', 'true');
    ck.append(checkCircle());
    el.append(ck);
    if (b.task) el.dataset.task = b.task;
  }
  if (HEADINGS.has(b.t)) {
    tx.setAttribute('role', 'heading');
    tx.setAttribute('aria-level', b.t.slice(1));
  } else if (b.t === 'quote') tx.setAttribute('role', 'blockquote');
  if (b.t === 'code') {
    tx.spellcheck = false;
    tx.setAttribute('autocorrect', 'off');
    tx.setAttribute('autocapitalize', 'off');
    tx.setAttribute('role', 'code');
    tx.setAttribute('aria-roledescription', 'code block');
    if (b.lang) el.dataset.lang = b.lang;
  }
  renderRuns(tx, b.c || [], ctx);
  const meta = b.t === 'check' ? taskMeta(b, ctx) : null;
  if (meta) {
    // The label goes last on the line, before the end <br> (one is added when the text has none): a line that
    // ends in a non-editable label has no end of its own in Chrome, and End from after the label would jump
    // to the end of the note.
    const last = tx.lastChild;
    if (last && last.nodeName === 'BR' && last.classList.contains('ne-end')) tx.insertBefore(meta, last);
    else {
      const br = document.createElement('br');
      br.className = 'ne-end';
      tx.append(meta, br);
    }
  }
  el.append(tx);
  if (!blockLen(b)) el.classList.add('is-empty');
  el._b = b;
  el._tx = tx;
  return el;
}

// ------------------------------------------------------------------ list markers

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
function alpha(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    x--;
    s = ALPHA[x % 26] + s;
    x = Math.floor(x / 26);
  }
  return s || 'a';
}
function roman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  let x = n;
  for (const [v, r] of map) while (x >= v) {
    s += r;
    x -= v;
  }
  return s;
}
const numLabel = (n, level) => (level % 3 === 1 ? `${alpha(n)}.` : level % 3 === 2 ? `${roman(n)}.` : `${n}.`);

/** Numbered-list markers by level (1. a. i.); `start` is honoured on the first item of a run only. */
export function numMarkers(doc) {
  const out = new Map();
  const count = new Array(8).fill(0);
  const fresh = new Array(8).fill(true);
  for (const b of doc) {
    if (!LIST.has(b.t)) {
      count.fill(0);
      fresh.fill(true);
      continue;
    }
    const L = b.in || 0;
    for (let k = L + 1; k < 8; k++) {
      count[k] = 0;
      fresh[k] = true;
    }
    if (b.t === 'num') {
      count[L] = fresh[L] ? (Number.isInteger(b.start) ? b.start : 1) : count[L] + 1;
      fresh[L] = false;
      out.set(b.id, numLabel(count[L], L));
    } else {
      count[L] = 0;
      fresh[L] = true;
    }
  }
  return out;
}
