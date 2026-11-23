// ecosys notes — the rich-text editor (notes-spec §3). One contenteditable host; the blocks model is the
// source of truth and the DOM is a view of it:
//   · plain typing inside a block is left to the browser (IME, autocorrect, dictation keep working) and
//     read back on `input` ("reconcile"); blocks the browser mangled are re-rendered from the model;
//   · everything structural is intercepted in `beforeinput` (Enter, deletes at block edges or across
//     blocks, formatting, paste, drop, cut, undo / redo) and applied as a model command;
//   · nothing user-provided is ever parsed as HTML or rendered with an HTML sink: text goes in with
//     textContent, hrefs pass safeHref(), clipboard HTML is walked from an inert DOMParser document.
//
// createEditor(host, opts) → api. See the contract in the stage-2 spec; extras are marked "extra".

import {
  LIST, HEADINGS, MARKS, HL_COLORS, TYPE_NAMES, isText, blockText, blockLen, normDoc, normRuns, idx, caret, isCollapsed, sameSel, orderSel,
  clampSel, typingFormat, linkExtent, runsEqual, docsEqual, replaceAt, isAtom, mkRun, safeHref, refKind, refId, maskedText, rebaseOff,
  nextText, prevText, segments, ensureDoc, newBlock, idsOf, normMarks, tagSpans, tagAtEnd, isTagBody, hrefHost,
} from './model.js';
import * as C from './commands.js';
import { lineRule, applyLineRule, enterRule, inlineRule, applyInlineRule } from './autoformat.js';
import { History, historyFor } from './history.js';
import { renderBlock, numMarkers, dayChipLabel, relativeDay } from './render.js';
import { readRuns, offsetIn, readSelection, writeSelection, rangeIn, caretRect, caretFromPoint, sameShape, blockElOf, pointToModel, afterDeco } from './dom.js';
import { htmlToBlocks, textToBlocks, looksLikeMarkdown, markdownLite, markdownLiteOut, blocksToHtml, blocksToText, MAX_PASTE } from './clipboard.js';
import { ListPopup, fuzzy } from './menus.js';
import { SelectionToolbar, FormatPanel, AccessoryBar, LinkCard, ChipCard, openLinkField, cardKeys, HL_NAMES } from './toolbar.js';
import { el, svgIcon, svgMarkup } from './icons.js';
import { toast, openMenu, isMac } from '../../shared/shell.js';
import { hasIcon } from '../../shared/icons.js';
import { db, settings } from '../../shared/store.js';
import { parse as nlpParse } from '../../shared/nlp.js';
import { todayYmd, addDaysYmd, parseYmd } from '../../shared/dates.js';
import { isYmd } from '../../shared/sanitize.js';

// Optional shared Markdown (notes/core/markdown.js). The editor keeps working without it.
let coreMd = null;
import('../core/markdown.js')
  .then((m) => {
    if (typeof m.blocksToMarkdown === 'function' && typeof m.markdownToBlocks === 'function') coreMd = m;
  })
  .catch(() => {});

// ------------------------------------------------------------------ settings & per-device prefs

const S = () => settings.get() || {};
const mdOn = () => S().notesMarkdown !== false;
const autoSortOn = () => S().notesCheckedSort !== 'manual';
const newStyle = () => (['h1', 'h2', 'h3', 'p'].includes(S().notesNewStyle) ? S().notesNewStyle : 'h1');
const textSize = () => (['s', 'm', 'l'].includes(S().notesTextSize) ? S().notesTextSize : 'm');
const reduceMotion = () => document.documentElement.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = () => matchMedia('(hover: none), (pointer: coarse)').matches;
const isMod = (e) => (isMac ? e.metaKey : e.ctrlKey);

const PREFS_KEY = 'ecosys:v1:notes-editor';
function prefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function savePrefs(patch) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...patch }));
  } catch {
    /* storage blocked: per-device prefs are a convenience */
  }
}
const lastHl = () => (HL_COLORS.includes(prefs().hl) ? prefs().hl : 'purple');

// ------------------------------------------------------------------ CSS Custom Highlight API registry
// Highlights are global by name, so ranges from every editor on the page share one Highlight object.

const HL_OK = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
const HL_REG = new Map();
function hlObject(name, priority = 0) {
  if (!HL_OK) return null;
  let h = HL_REG.get(name);
  if (!h) {
    h = new Highlight();
    h.priority = priority;
    HL_REG.set(name, h);
    CSS.highlights.set(name, h);
  }
  return h;
}

// #tag rules (combining marks included, as in notes/core/schema.js): tagSpans / tagAtEnd / isTagBody in model.js.
const WIKI_RE = /\[\[([^[\]\n]{1,120})\]\]/g;
const hasLetter = (s) => /\p{L}/u.test(s);

// ------------------------------------------------------------------ slash items

// Names come from the one table in model.js (TYPE_NAMES); the Markdown form is the hint, older names are aliases.
const SLASH = [
  { id: 'title', label: TYPE_NAMES.h1, hint: '#', icon: 'heading', alias: 'h1 large' },
  { id: 'heading', label: TYPE_NAMES.h2, hint: '##', icon: 'heading', alias: 'h2' },
  { id: 'subheading', label: TYPE_NAMES.h3, hint: '###', icon: 'heading', alias: 'h3 small' },
  { id: 'body', label: TYPE_NAMES.p, icon: 'text', alias: 'text paragraph plain' },
  { id: 'checklist', label: TYPE_NAMES.check, hint: '[]', icon: 'checklist', alias: 'todo task check box' },
  { id: 'bullet', label: TYPE_NAMES.bullet, hint: '*', icon: 'bullets', alias: 'ul unordered' },
  { id: 'dash', label: TYPE_NAMES.dash, hint: '-', icon: 'dashes', alias: 'dashes' },
  { id: 'number', label: TYPE_NAMES.num, hint: '1.', icon: 'numbers', alias: 'ol ordered' },
  { id: 'quote', label: TYPE_NAMES.quote, hint: '>', icon: 'quote', alias: 'block quote blockquote citation' },
  { id: 'mono', label: TYPE_NAMES.code, hint: '```', icon: 'code', alias: 'monostyled pre mono' },
  { id: 'divider', label: TYPE_NAMES.hr, hint: '---', icon: 'divider', alias: 'hr line rule separator' },
  { id: 'link', label: 'Link to note, task or event', hint: '[[', icon: 'link', alias: 'mention note task event' },
  { id: 'date', label: 'Date', hint: '@', icon: 'calendar', alias: 'today tomorrow day' },
  { id: 'send', label: 'Send to Tasks', icon: 'send-task', alias: 'task todo' },
];

// What "@" + one word can still turn into a date while it is typed: a number, or the start of a day or month
// name or of in / next / this / on / the ("@f", "@fr", "@fri", "@sept", "@12/5"). Generated from those words
// (nested optional groups: every prefix matches); a word that is no date ("@mark", "@sam") closes the list.
const DATE_WORDS = /^(?:\d|(?:a(?:p(?:r(?:i(?:l)?)?)?|u(?:g(?:u(?:s(?:t)?)?)?)?)?|d(?:e(?:c(?:e(?:m(?:b(?:e(?:r)?)?)?)?)?)?)?|f(?:e(?:b(?:r(?:u(?:a(?:r(?:y)?)?)?)?)?)?|r(?:i(?:d(?:a(?:y)?)?)?)?)?|i(?:n)?|j(?:a(?:n(?:u(?:a(?:r(?:y)?)?)?)?)?|u(?:l(?:y)?|n(?:e)?)?)?|m(?:a(?:r(?:c(?:h)?)?|y)?|o(?:n(?:d(?:a(?:y)?)?)?)?)?|n(?:e(?:x(?:t)?)?|o(?:v(?:e(?:m(?:b(?:e(?:r)?)?)?)?)?)?)?|o(?:c(?:t(?:o(?:b(?:e(?:r)?)?)?)?)?|n)?|s(?:a(?:t(?:u(?:r(?:d(?:a(?:y)?)?)?)?)?)?|e(?:p(?:t(?:e(?:m(?:b(?:e(?:r)?)?)?)?)?)?)?|u(?:n(?:d(?:a(?:y)?)?)?)?)?|t(?:h(?:e|i(?:s)?|u(?:r(?:s(?:d(?:a(?:y)?)?)?)?)?)?|u(?:e(?:s(?:d(?:a(?:y)?)?)?)?)?)?|w(?:e(?:d(?:n(?:e(?:s(?:d(?:a(?:y)?)?)?)?)?)?)?)?)$)/i;
// A whole first word that a date phrase continues after ("next fri", "in 2 weeks", "dec 3", "on the 15th").
const DATE_LEAD = /^(?:in|next|this|on|the|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,4}(?:st|nd|rd|th)?)$/i;
const DATE_UNITS = ['days', 'weeks', 'weekend', 'months', 'years', 'fortnight', 'morning', 'afternoon', 'evening'];

/**
 * Could `q` (what follows "@") still become a date that nlp.js reads? One word: see DATE_WORDS. Two or three:
 * a phrase that starts with a whole date word or a number, every later word a number ("3", "15th", "3pm") or
 * the start of a day, month or unit ("next f", "in 2 w", "dec 1", "5 dec"). A trailing space means more is
 * coming. Anything else is prose, and the list closes.
 */
function maybeDate(q) {
  const s = String(q ?? '');
  if (!s || /^\s|\s\s|[^\S ]/.test(s)) return false;
  const words = s.split(' ');
  if (words.length > 3 || !DATE_WORDS.test(words[0])) return false;
  if (words.length === 1) return true;
  if (!DATE_LEAD.test(words[0])) return false;
  return words.slice(1).every((w, k, all) => {
    if (!w) return k === all.length - 1;
    const lw = w.toLowerCase();
    return /^\d{1,4}(?:[/.:-]\d{0,4})*(?:s|st|n|nd|r|rd|t|th|a|am|p|pm)?$/i.test(w) || (!/^\d/.test(w) && DATE_WORDS.test(w)) || DATE_UNITS.some((u) => u.startsWith(lw));
  });
}

// Send to Tasks has one glyph everywhere: the slash menu draws the editor's 'send-task'; the checklist menu
// (shared openMenu, which draws shared icons) uses the shared one once shared/icons.js has it, and the same
// glyph from the editor's set until then (as the trusted markup the menu's iconHtml takes).
const sendIcon = () => (hasIcon('send-task') ? { icon: 'send-task' } : { iconHtml: svgMarkup('send-task', { size: 18 }) });

// How Undo / Redo name a change to a screen reader, by the kind of change ("Undo typing").
const UNDO_WHAT = { type: 'typing', format: 'formatting', check: 'check', structure: '' };
const MARK_NAMES = { b: 'Bold', i: 'Italic', u: 'Underline', s: 'Strikethrough', c: 'Inline code' };

// A doc this editor emitted comes back from the store as a late "echo" within a save / sync round trip.
// Older emissions are no echo: a store that returns one is reverting on purpose (AI Undo, Restore, Undo).
const ECHO_MS = 3000;

let editorSeq = 0;

// ------------------------------------------------------------------ the editor

class NotesEditor {
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.key = ++editorSeq;
    this.readOnly = !!opts.readOnly;
    this.noteId = opts.noteId || null;
    this.doc = normDoc(opts.blocks, { emptyType: newStyle() });
    this.history = this.adoptHistory(this.noteId);
    this.sel = null;
    this.els = new Map();
    this.version = 0;
    this.emitted = []; // [{doc, at}] recent emissions, for the stale-echo guard in setBlocks
    this.dead = false;
    this.keptEcho = false;
    this.scrollSeq = 0;
    this.notePicker = null;
    this.composing = false;
    this.composeTouched = new Set();
    this.compEndAt = -1;
    this.shiftDown = false;
    this.forcePlain = false;
    this.pending = null;
    this.lastAuto = null;
    this.prevented = null;
    this.trigger = null;
    this.sortTimers = new Map();
    this.deferredSorts = new Set();
    this.checkEntry = null;
    this.findState = null;
    this.hlRanges = new Map();
    this.cleanup = [];
    this.timers = new Set();
    this.focused = false;
    this.linkReq = 0;
    this.build();
    this.renderAll();
    this.bind();
    this.refreshHighlights('all');
  }

  // ---------------------------------------------------------------- setup

  /**
   * The undo history for a note (it outlives the editor, so undo survives switching notes and back). If
   * the note changed while no editor showed it (an AI over MCP, another tab or device), the old entries
   * would undo across that change and save the loss: the stack starts fresh instead.
   */
  adoptHistory(noteId) {
    const h = noteId ? historyFor(noteId) : new History();
    if (h.lastDoc && !docsEqual(h.lastDoc, this.doc) && !onlyLabelsDiffer(h.lastDoc, this.doc)) h.clear();
    h.lastDoc = this.doc;
    return h;
  }

  build() {
    const o = this.opts;
    this.root = el('div', { class: 'ne-root' });
    this.root.dataset.size = textSize();
    this.docEl = el('div', {
      class: 'ne-doc',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': o.label || 'Note',
      spellcheck: 'true',
      autocapitalize: 'sentences',
      autocorrect: 'on',
      enterkeyhint: 'enter',
      translate: 'no',
      'data-gramm': 'false',
      'data-gramm_editor': 'false',
      'data-enable-grammarly': 'false',
    });
    this.docEl.contentEditable = this.readOnly ? 'false' : 'true';
    if (this.readOnly) this.docEl.setAttribute('aria-readonly', 'true');
    this.overlay = el('div', { class: 'ne-overlay', 'aria-hidden': 'true' });
    this.grip = el('button', { type: 'button', class: 'ne-grip', tabindex: '-1', 'aria-hidden': 'true' }, svgIcon('grip', { size: 16 }));
    this.overlay.append(this.grip);
    this.live = el('div', { class: 'sr-only', 'aria-live': 'polite' });
    this.root.append(this.docEl, this.overlay, this.live);
    this.host.append(this.root);

    const api = {
      exec: (cmd, arg) => this.exec(cmd, arg),
      state: () => this.state(),
      focus: () => this.focusEditor(),
      hasFocus: () => document.activeElement === this.docEl,
      selRect: () => this.selRect(),
      lastHl: () => lastHl(),
      linkUI: () => this.linkUI(),
      openHref: (h) => this.openHref(h),
      toggleTask: (ref) => this.toggleTask(ref),
      activate: (ref, ev, action) => this.activate(ref, ev, action),
      onAccessoryMove: () => {
        this.panel.place();
        if (this.pop.isOpen && this.pop.mode === 'sheet') this.pop.place();
      },
    };
    this.api = api;
    this.toolbar = new SelectionToolbar(api);
    this.panel = new FormatPanel(api);
    this.acc = new AccessoryBar(api);
    this.linkCard = new LinkCard(api);
    this.chipCard = new ChipCard(api);
    this.pop = new ListPopup({
      label: 'Suggestions',
      onPick: (it) => this.pickTrigger(it),
      onHighlight: (it, id) => {
        if (id) this.docEl.setAttribute('aria-activedescendant', id);
        else this.docEl.removeAttribute('aria-activedescendant');
        // A row is read when it becomes the highlighted one, not again on every key typed while it stays.
        const key = it ? `${id}|${it.label}` : null;
        if (it && key !== this.hlSaid) this.say(it.label);
        this.hlSaid = key;
      },
    });
  }

  renderCtx() {
    return { readOnly: this.readOnly, taskLookup: this.opts.taskLookup, refLookup: this.opts.refLookup, idPrefix: `ne${this.key}-` };
  }

  renderAll() {
    const ctx = this.renderCtx();
    this.els.clear();
    const nodes = this.doc.map((b) => {
      const e = renderBlock(b, ctx);
      this.els.set(b.id, e);
      return e;
    });
    this.docEl.replaceChildren(...nodes);
    this.decorate();
    this.mo?.takeRecords();
    if (this.grip) {
      this.grip.classList.remove('on');
      this.gripFor = null;
    }
  }

  /**
   * Keyed patch: re-render only blocks whose object changed, then fix the order with one sibling walk
   * (moves and inserts only where needed). Returns the ids that were (re)rendered.
   */
  patch() {
    const ctx = this.renderCtx();
    const changed = new Set();
    let structural = this.doc.length !== this.docEl.childElementCount;
    let cur = this.docEl.firstChild;
    for (const b of this.doc) {
      let e = this.els.get(b.id);
      if (!e || e._b !== b) {
        if (e && e._b && (e._b.t !== b.t || (e._b.in || 0) !== (b.in || 0) || e._b.start !== b.start)) structural = true;
        const n = renderBlock(b, ctx);
        if (e && e.dataset.marker) n.dataset.marker = e.dataset.marker; // recomputed when structure changed
        if (e && e.parentNode === this.docEl) {
          if (e === cur) cur = n;
          e.replaceWith(n);
        } else structural = true;
        e = n;
        this.els.set(b.id, e);
        changed.add(b.id);
      }
      if (cur === e) cur = cur.nextSibling;
      else {
        structural = true;
        this.docEl.insertBefore(e, cur);
      }
    }
    // Whatever is left after the last wanted block is stale.
    while (cur) {
      const next = cur.nextSibling;
      if (cur.nodeType === 1 && this.els.get(cur.dataset.id) === cur) this.els.delete(cur.dataset.id);
      cur.remove();
      cur = next;
      structural = true;
    }
    if (this.els.size > this.doc.length) for (const [id, e] of this.els) if (e.parentNode !== this.docEl) this.els.delete(id);
    this.decorate(changed, { markers: structural });
    this.mo?.takeRecords();
    this.refreshHighlights(changed, { prune: structural });
    return changed;
  }

  /**
   * Classes and attributes that depend on neighbours or on emptiness: list numbers, is-empty, the
   * placeholder. With `only` (ids whose blocks changed), just those blocks and the first one; list
   * numbers are recomputed when `markers` (the structure changed) or on a full pass.
   */
  decorate(only = null, { markers: remark = false } = {}) {
    const long = this.doc.length > 400;
    if (this.root.classList.contains('ne-long') !== long) this.root.classList.toggle('ne-long', long);
    if (only && remark) {
      const markers = numMarkers(this.doc);
      for (const [id, m] of markers) {
        const e = this.els.get(id);
        if (e && e.dataset.marker !== m) e.dataset.marker = m;
      }
    }
    const first = this.doc[0];
    const ph = this.readOnly ? '' : this.opts.placeholder || (first && first.t === 'h1' ? 'Title' : 'Start writing');
    // The placeholder is drawn by CSS (with no text for screen readers); the empty textbox says it instead.
    const blank = this.doc.length === 1 && isText(first) && !blockLen(first);
    const aph = blank && ph ? ph : null;
    if (this.docEl.getAttribute('aria-placeholder') !== aph) {
      if (aph) this.docEl.setAttribute('aria-placeholder', aph);
      else this.docEl.removeAttribute('aria-placeholder');
    }
    const mark = (b) => {
      const e = this.els.get(b.id);
      if (!e || b.t === 'hr') return;
      const empty = blockLen(b) === 0;
      if (e.classList.contains('is-empty') !== empty) e.classList.toggle('is-empty', empty);
      const tx = e._tx;
      if (!tx) return;
      const want = b === first && empty && ph ? ph : '';
      if (want) {
        if (tx.dataset.ph !== want) tx.dataset.ph = want;
      } else if (tx.dataset.ph !== undefined) delete tx.dataset.ph;
    };
    if (only) {
      for (const id of only) {
        const b = this.block(id);
        if (b) mark(b);
      }
      if (first) mark(first);
      if (this.phBlock && this.phBlock !== first?.id) {
        const old = this.block(this.phBlock);
        if (old) mark(old);
      }
      this.phBlock = first?.id;
      return;
    }
    const markers = numMarkers(this.doc);
    for (const b of this.doc) {
      if (b.t === 'num') {
        const e = this.els.get(b.id);
        const m = markers.get(b.id) || '';
        if (e && e.dataset.marker !== m) e.dataset.marker = m;
      }
      mark(b);
    }
    this.phBlock = first?.id;
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  bind() {
    const d = this.docEl;
    this.mo = new MutationObserver((recs) => this.onMutations(recs));
    this.mo.observe(d, { childList: true, characterData: true, subtree: true });
    this.on(d, 'beforeinput', (e) => this.onBeforeInput(e));
    this.on(d, 'input', (e) => this.onInput(e));
    this.on(d, 'keydown', (e) => this.onKeyDown(e));
    this.on(d, 'keyup', (e) => this.onKeyUp(e));
    this.on(document, 'keyup', (e) => {
      if (e.key === 'Shift') this.shiftDown = false;
    });
    this.on(window, 'blur', () => (this.shiftDown = false));
    this.on(d, 'compositionstart', () => this.onCompositionStart());
    this.on(d, 'compositionend', (e) => this.onCompositionEnd(e));
    this.on(d, 'paste', (e) => this.onPaste(e));
    this.on(d, 'copy', (e) => this.onCopy(e, false));
    this.on(d, 'cut', (e) => this.onCopy(e, true));
    this.on(d, 'dragstart', (e) => e.preventDefault());
    this.on(d, 'dragover', (e) => this.onDragOver(e));
    this.on(d, 'drop', (e) => this.onDrop(e));
    this.on(d, 'pointerdown', (e) => this.onPointerDown(e));
    this.on(d, 'touchstart', (e) => {
      if (e.target.closest?.('.ne-ck, .ne-tc')) e.preventDefault();
    }, { passive: false });
    this.on(d, 'click', (e) => this.onClick(e));
    this.on(d, 'contextmenu', (e) => this.onContextMenu(e));
    this.on(d, 'focus', (e) => this.onFocus(e));
    this.on(d, 'blur', (e) => this.onBlur(e));
    this.on(d, 'pointerover', (e) => this.onPointerOver(e));
    this.on(d, 'pointerout', (e) => this.onPointerOut(e));
    this.on(d, 'pointermove', (e) => this.onHoverMove(e));
    this.on(this.root, 'pointerleave', () => this.hideGrip(300));
    this.on(this.grip, 'pointerdown', (e) => this.onGripDown(e));
    this.on(this.grip, 'pointerenter', () => clearTimeout(this.gripTimer));
    this.on(document, 'selectionchange', () => this.onSelectionChange());
    this.on(document, 'pointerup', (e) => this.onPointerUp(e));
    this.on(window, 'resize', () => this.repositionUI());
    this.on(window, 'scroll', () => this.repositionUI(), { capture: true, passive: true });
    this.cleanup.push(
      db.on(({ names }) => {
        if (names.has('settings')) this.applySettings();
        if (names.has('tasks') || names.has('notes') || names.has('events') || names.has('calendars')) this.refreshDecor();
      }),
    );
    const mq = matchMedia('(hover: none), (pointer: coarse)');
    this.on(mq, 'change', () => this.updateAccessory());
  }

  applySettings() {
    const s = textSize();
    if (this.root.dataset.size !== s) this.root.dataset.size = s;
  }

  // ---------------------------------------------------------------- helpers

  block(id) {
    const i = idx(this.doc, id);
    return i < 0 ? null : this.doc[i];
  }

  readSel() {
    const s = readSelection(this.docEl, (id) => this.block(id));
    return s ? this.normalizeHr(s) : null;
  }

  /** The selection to act on: the live one when focused, else the last known one, else the end. */
  currentSel() {
    if (document.activeElement === this.docEl) {
      const s = this.readSel();
      if (s) this.sel = s;
    }
    if (this.sel && idx(this.doc, this.sel.a.id) >= 0 && idx(this.doc, this.sel.f.id) >= 0) return clampSel(this.doc, this.sel);
    const last = prevText(this.doc, this.doc.length) ?? 0;
    return caret(this.doc[last].id, blockLen(this.doc[last]));
  }

  /** Positions on a divider move to the neighbouring text block. */
  normalizeHr(sel) {
    const fix = (p, toEnd) => {
      if (!p.hr && isText(this.block(p.id))) return { id: p.id, off: p.off };
      const i = idx(this.doc, p.id);
      const n = toEnd ? prevText(this.doc, i) ?? nextText(this.doc, i) : nextText(this.doc, i) ?? prevText(this.doc, i);
      if (n === null || n === undefined) return { id: p.id, off: 0 };
      const b = this.doc[n];
      return { id: b.id, off: n < i ? blockLen(b) : 0 };
    };
    const o = idx(this.doc, sel.a.id) <= idx(this.doc, sel.f.id);
    return { a: fix(sel.a, !o), f: fix(sel.f, o) };
  }

  setDomSel(sel) {
    if (!sel) return;
    writeSelection(this.docEl, this.els, sel);
  }

  selRect() {
    const sel = this.sel || this.currentSel();
    const s = window.getSelection();
    if (s && s.rangeCount && this.docEl.contains(s.anchorNode) && !s.isCollapsed) {
      const r = s.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) return r;
    }
    const e = this.els.get(sel.f.id);
    return e ? caretRect(e, sel.f.off) : this.docEl.getBoundingClientRect();
  }

  /** repeat: the same words twice in a row are read again (the text changes by a trailing NBSP). */
  say(text, repeat = false) {
    const t = repeat && this.live.textContent === text ? `${text} ` : text;
    this.live.textContent = '';
    this.live.textContent = t;
  }

  /**
   * Tell screen readers what a command did ("Bold on", "Heading", "Indented, level 2", "Undo typing"): the
   * model re-renders the line, so nothing else would. Polite, a beat after the change so it follows the
   * echo of the key; a newer message replaces one not yet read. A caret hint (`hint`: "Task: …. Alt+F10 for
   * options.") joins a command's message that is still waiting instead, so an undo that lands on a chip says
   * both ("Undo typing. Task: …").
   */
  announce(text, { hint = false } = {}) {
    if (!text || this.dead) return;
    const waiting = this.sayWaiting;
    if (hint && waiting && !waiting.hint) text = `${waiting.text.replace(/[.\s]+$/, '')}. ${text}`;
    clearTimeout(this.sayTimer);
    this.sayWaiting = { text, hint };
    this.sayTimer = this.later(() => {
      this.sayWaiting = null;
      this.say(text, true);
    }, 120);
  }

  scroller() {
    let n = this.root.parentElement;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // ---------------------------------------------------------------- applying changes

  /**
   * Apply a command result {doc, sel} as one undo step. what: how Undo names it to a screen reader ("Undo
   * typing"); autoText: the Markdown an autoformat replaced (its Undo says "Restored ##").
   */
  apply(res, kind = 'structure', { record = true, ws = false, auto = null, what = null, autoText = null } = {}) {
    if (!res || !res.doc || this.dead) return false; // dead: a late async pick (create-and-link…) after destroy()
    const before = { doc: this.doc, sel: this.sel, what: what ?? UNDO_WHAT[kind] ?? '' };
    if (auto) before.auto = auto;
    if (autoText) before.autoText = autoText;
    if (record && !this.suppressRecord) this.history.record(before, { kind: kind === 'type' ? 'type' : 'structure', block: res.sel?.f.id, ws });
    this.doc = res.doc;
    if (res.sel) this.sel = clampSel(this.doc, res.sel);
    this.pending = null;
    this.lastAuto = null;
    this.cancelSortsFor(before.doc);
    this.patch();
    if (document.activeElement === this.docEl && this.sel) this.setDomSel(this.sel);
    this.typedSel = kind === 'type' ? this.sel : null; // where typing left the caret (noteCaretTarget)
    this.emitChange(kind);
    return true;
  }

  emitChange(kind) {
    if (this.dead) return;
    this.version++;
    this.emitted.push({ doc: this.doc, at: performance.now() });
    if (this.emitted.length > 30) this.emitted.shift();
    this.history.lastDoc = this.doc;
    if (this.findState) this.clearFind();
    this.refreshUI();
    this.opts.onChange?.(this.doc.slice(), { kind: kind === 'type' ? 'type' : kind === 'format' ? 'format' : kind === 'check' ? 'check' : 'structure' });
  }

  refreshUI() {
    if (this.toolbar.visible) this.toolbar.refresh();
    if (this.panel.isOpen) this.panel.refresh();
    if (this.acc.visible) this.acc.refresh();
    this.emitSelectionSoon();
  }

  // ---------------------------------------------------------------- reconcile (DOM → model)

  onMutations(recs) {
    if (this.composing) {
      for (const r of recs) {
        const be = blockElOf(this.docEl, r.target);
        if (be) this.composeTouched.add(be);
      }
      return;
    }
    // Kept for the next reconcile: usually the `input` event's, which can come after this callback (any
    // capture-phase input listener, e.g. shared/ai.js on window, runs a microtask checkpoint first).
    // Changes that fired no input event (extensions, autofill) are reconciled by the timer.
    this.pendingRecs = (this.pendingRecs || []).concat(recs);
    if (this.mutTimer) return;
    this.mutTimer = this.later(() => {
      this.mutTimer = 0;
      const res = this.reconcile();
      if (res) this.commitTyping(res.before, '');
    }, 0);
  }

  /** DOM → model for every block touched since the last reconcile (records taken now or kept earlier). */
  reconcile() {
    const recs = [...(this.pendingRecs || []), ...(this.mo.takeRecords() || [])];
    this.pendingRecs = null;
    const touched = new Set(this.composeTouched);
    this.composeTouched.clear();
    let structural = false;
    for (const r of recs) {
      if (r.target === this.docEl) {
        structural = true;
        continue;
      }
      const be = blockElOf(this.docEl, r.target);
      if (be) touched.add(be);
      else if (this.docEl.contains(r.target)) structural = true;
    }
    if (!touched.size && !structural) return null;
    if (structural) {
      // Block elements added / removed by the browser: compare with what we rendered.
      const kids = [...this.docEl.childNodes];
      const ours = kids.length === this.doc.length && kids.every((n, i) => n === this.els.get(this.doc[i].id));
      if (!ours) return this.fullReconcile();
    }
    let doc = this.doc;
    const rerender = [];
    const ctx = this.renderCtx();
    for (const e of touched) {
      const id = e.dataset.id;
      const i = idx(doc, id);
      if (i < 0 || this.els.get(id) !== e) return this.fullReconcile();
      const b = doc[i];
      if (!isText(b)) continue;
      const { runs, dirty } = readRuns(e, { code: b.t === 'code' });
      let nb = b;
      if (!runsEqual(runs, b.c)) {
        nb = { ...b, c: runs };
        doc = replaceAt(doc, i, nb);
      }
      if (dirty || nb !== b) {
        if (!dirty && plainCanonical(e, nb)) {
          e._b = nb; // the common case: plain text typed into a plain line
          continue;
        }
        const fresh = renderBlock(nb, ctx);
        if (dirty || !sameShape(e, fresh)) rerender.push(fresh);
        else e._b = nb;
      }
    }
    if (doc === this.doc && !rerender.length) return null;
    const sel = this.readSelPositions(doc);
    const before = { doc: this.doc, sel: this.sel };
    this.doc = doc;
    const changed = new Set();
    for (const e of touched) if (e.dataset.id && this.block(e.dataset.id) !== before.doc[idx(before.doc, e.dataset.id)]) changed.add(e.dataset.id);
    for (const fresh of rerender) {
      const old = this.els.get(fresh.dataset.id);
      if (old.dataset.marker) fresh.dataset.marker = old.dataset.marker;
      old.replaceWith(fresh);
      this.els.set(fresh.dataset.id, fresh);
      changed.add(fresh.dataset.id);
    }
    this.mo.takeRecords();
    if (sel) {
      this.sel = sel;
      if (rerender.length) this.setDomSel(sel);
    }
    this.decorate(changed);
    this.refreshHighlights(changed);
    return { before };
  }

  /** Read the DOM selection against a doc that is about to become current. */
  readSelPositions(doc) {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !this.docEl.contains(s.anchorNode)) return null;
    const blockOf = (id) => doc[idx(doc, id)];
    const a = pointToModel(this.docEl, s.anchorNode, s.anchorOffset, blockOf);
    const f = pointToModel(this.docEl, s.focusNode, s.focusOffset, blockOf);
    if (!a || !f || idx(doc, a.id) < 0 || idx(doc, f.id) < 0) return null;
    return { a: { id: a.id, off: a.off }, f: { id: f.id, off: f.off } };
  }

  /** The browser changed the block structure (it ignored preventDefault): rebuild the model from the DOM. */
  fullReconcile() {
    const before = { doc: this.doc, sel: this.sel };
    const s = window.getSelection();
    const sp = (node, off) => {
      const be = node && blockElOf(this.docEl, node);
      return be ? { el: be, off: offsetIn(be, node, off) } : null;
    };
    const A = s && s.rangeCount ? sp(s.anchorNode, s.anchorOffset) : null;
    const F = s && s.rangeCount ? sp(s.focusNode, s.focusOffset) : null;
    const used = new Set();
    const out = [];
    const forEl = new Map();
    for (const node of [...this.docEl.childNodes]) {
      if (node.nodeType === 3) {
        if (node.data.trim()) out.push({ ...newBlock('p', used), c: normRuns([[node.data]]) });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const id = node.dataset?.id;
      const known = id && !used.has(id) ? this.block(id) : null;
      if (known) used.add(id);
      const t = known ? known.t : ['p', 'h1', 'h2', 'h3', 'bullet', 'dash', 'num', 'check', 'quote', 'code', 'hr'].includes(node.dataset?.type) ? node.dataset.type : 'p';
      if (t === 'hr') {
        out.push(known && known.t === 'hr' ? known : newBlock('hr', used));
        continue;
      }
      const { runs } = readRuns(node, { code: t === 'code' });
      const b = known ? { ...known, c: runs } : { ...newBlock(t, used, { in: known?.in }), c: runs };
      out.push(b);
      forEl.set(node, b.id);
    }
    this.doc = ensureDoc(out.length ? out : [newBlock('p')]);
    this.renderAll();
    const map = (p) => (p && forEl.has(p.el) ? { id: forEl.get(p.el), off: p.off } : null);
    const a = map(A);
    const f = map(F) || a;
    this.sel = a ? clampSel(this.doc, { a, f }) : clampSel(this.doc, this.sel);
    this.setDomSel(this.sel);
    this.refreshHighlights('all');
    return { before };
  }

  /** Throw away DOM changes the browser made despite preventDefault (Android) and re-render from the model. */
  restoreDom() {
    this.mo.takeRecords();
    this.pendingRecs = null;
    this.renderAll();
    this.setDomSel(this.sel);
  }

  commitTyping(before, data) {
    if (this.grip.classList.contains('on')) this.hideGrip(0);
    const ws = typeof data === 'string' && /\s$/.test(data);
    before.what = UNDO_WHAT.type;
    this.history.record(before, { kind: 'type', block: this.sel?.f.id, ws });
    this.lastAuto = null;
    this.typedSel = this.sel;
    this.emitChange('type');
    this.scrollCaretSoon(); // iOS can leave the caret under the keyboard
  }

  // ---------------------------------------------------------------- input events

  onBeforeInput(e) {
    if (this.readOnly) {
      e.preventDefault();
      return;
    }
    const t = e.inputType;
    this.prevented = null; // a new edit begins: an earlier prevented one can no longer leak through
    if (this.composing || t === 'insertCompositionText') return;
    // The live selection decides; the target range matters for replacements and cross-block deletes.
    const live = this.readSel() || this.sel;
    if (!live) return;
    let sel = t === 'insertReplacementText' ? this.targetSel(e) || live : live;
    sel = this.normalizeHr(sel);
    const prevent = () => {
      e.preventDefault();
      this.prevented = { type: t, at: performance.now() };
    };
    if (t === 'historyUndo' || t === 'historyRedo') {
      prevent();
      if (t === 'historyUndo') this.undo();
      else this.redo();
      return;
    }
    if (t.startsWith('format')) {
      prevent();
      const cmd = { formatBold: 'bold', formatItalic: 'italic', formatUnderline: 'underline', formatStrikeThrough: 'strike', formatIndent: 'indent', formatOutdent: 'outdent' }[t];
      if (cmd) this.exec(cmd);
      return;
    }
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      prevent();
      if (this.trigger && this.pop.isOpen && this.pop.current()) return void this.pop.pick();
      if (t === 'insertLineBreak' && this.shiftDown) this.softBreak(sel);
      else this.doEnter(sel);
      return;
    }
    if (t === 'insertFromPaste' || t === 'insertFromPasteAsQuotation' || t === 'insertFromDrop' || t === 'deleteByCut' || t === 'deleteByDrag' || t === 'insertLink') {
      prevent();
      return;
    }
    if (t === 'insertOrderedList' || t === 'insertUnorderedList' || t === 'insertHorizontalRule') {
      prevent();
      this.exec(t === 'insertOrderedList' ? 'number' : t === 'insertUnorderedList' ? 'bullet' : 'divider');
      return;
    }
    if (t === 'insertText' || t === 'insertReplacementText' || t === 'insertFromYank') {
      const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      if (/[\r\n]/.test(data)) {
        prevent();
        this.pasteData({ text: data }, sel);
        return;
      }
      const b = this.block(sel.f.id);
      if (!isCollapsed(sel)) {
        // Typing "[" over a selection surrounds it; a second "[" makes a wiki link → note picker.
        if (data === '[' && sel.a.id === sel.f.id && b && b.t !== 'code') {
          prevent();
          this.surround(sel);
          return;
        }
        if (t === 'insertReplacementText' && sel.a.id === sel.f.id && !this.rangeHasAtom(sel)) return; // spellcheck: native
        prevent();
        this.history.endGroup();
        const { s } = orderSel(this.doc, sel);
        const fmt = typingFormat(this.doc[s.i].c || [], s.off);
        this.apply(C.insertText(this.doc, sel, data, fmt, { emptyType: newStyle() }), 'type', { ws: /\s$/.test(data) });
        this.afterTyping(data);
        return;
      }
      if (!data) return;
      const p = this.pending;
      if (p && p.pos.id === sel.f.id && p.pos.off === sel.f.off) {
        prevent();
        this.apply(C.insertText(this.doc, sel, data, p), 'type', { ws: /\s$/.test(data) });
        this.afterTyping(data);
        return;
      }
      // After a task label the browser would type into a new text node behind it: the model puts it in the text.
      if (this.needsModelInsert(sel) || this.domAfterDeco()) {
        prevent();
        const fmt = typingFormat(b.c, sel.f.off);
        this.apply(C.insertText(this.doc, sel, data, fmt), 'type', { ws: /\s$/.test(data) });
        this.afterTyping(data);
      }
      return;
    }
    if (t.startsWith('delete')) {
      if (!isCollapsed(sel)) {
        prevent();
        this.apply(C.deleteRange(this.doc, sel, { emptyType: newStyle() }), 'structure');
        this.afterEdit();
        return;
      }
      const b = this.block(sel.f.id);
      if (!b) return;
      const off = sel.f.off;
      const len = blockLen(b);
      const back = /Backward$/.test(t) || t === 'deleteContent' || t === 'deleteEntireSoftLine';
      if (back) {
        const la = this.lastAuto;
        if (la && la.version === this.version && t === 'deleteContentBackward' && la.pos && la.pos.id === sel.f.id && la.pos.off === sel.f.off) {
          prevent();
          this.undo();
          return;
        }
        if (off === 0) {
          prevent();
          this.apply(C.backspaceAtStart(this.doc, sel), 'structure');
          this.afterEdit();
          return;
        }
        if (t === 'deleteContentBackward' && this.atomNear(b, off, -1)) {
          prevent();
          this.apply(C.deleteChar(this.doc, sel, -1), 'type');
          this.afterEdit();
          return;
        }
        // Right after a task label the browser would delete the label (it is not text): delete the character
        // (or the word or line the browser meant) before it, through the model.
        if (this.domAfterDeco()) {
          prevent();
          const tr = this.targetSel(e);
          const res = tr && !isCollapsed(tr) && tr.a.id === tr.f.id ? C.deleteRange(this.doc, tr) : C.deleteChar(this.doc, sel, -1);
          this.apply(res, 'type');
          this.afterEdit();
          return;
        }
      } else {
        if (off >= len) {
          prevent();
          this.apply(C.deleteAtEnd(this.doc, sel), 'structure');
          return;
        }
        if (t === 'deleteContentForward' && this.atomNear(b, off, 1)) {
          prevent();
          this.apply(C.deleteChar(this.doc, sel, 1), 'type');
          return;
        }
      }
      // A word / line delete whose range crosses into another block.
      const tr = this.targetSel(e);
      if (tr && tr.a.id !== tr.f.id) {
        prevent();
        this.apply(C.deleteRange(this.doc, tr, { emptyType: newStyle() }), 'structure');
      }
    }
  }

  /** Model selection from beforeinput's target range (valid only during dispatch). */
  targetSel(e) {
    const r = e.getTargetRanges?.()[0];
    if (!r) return null;
    const blockOf = (id) => this.block(id);
    const a = pointToModel(this.docEl, r.startContainer, r.startOffset, blockOf);
    const f = pointToModel(this.docEl, r.endContainer, r.endOffset, blockOf);
    if (!a || !f) return null;
    return this.normalizeHr({ a, f });
  }

  rangeHasAtom(sel) {
    return segments(this.doc, sel).some((g) => {
      let pos = 0;
      for (const r of this.doc[g.i].c) {
        const len = r[0].length;
        if (isAtom(r) && pos < g.to && pos + len > g.from) return true;
        pos += len;
      }
      return false;
    });
  }

  atomNear(b, off, dir) {
    let pos = 0;
    for (const r of b.c) {
      const len = r[0].length;
      if (isAtom(r) && ((dir < 0 && off === pos + len) || (dir > 0 && off === pos))) return true;
      pos += len;
    }
    return false;
  }

  /** Native typing would extend a link or land beside a chip: insert through the model instead. */
  needsModelInsert(sel) {
    const b = this.block(sel.f.id);
    if (!b || !isText(b) || b.t === 'code') return false;
    const off = sel.f.off;
    let pos = 0;
    for (const r of b.c) {
      const len = r[0].length;
      const a = r[2];
      if (a && (a.atom || a.href || a.ref) && (off === pos + len || off === pos)) return true;
      pos += len;
    }
    return false;
  }

  onInput(e) {
    if (this.readOnly) return;
    if (e.isComposing || this.composing) return;
    if (this.prevented && this.prevented.type === e.inputType && performance.now() - this.prevented.at < 300) {
      // No beforeinput since we prevented one, yet the browser changed the DOM: it applied the edit we had
      // already handled (Android can ignore preventDefault). Throw its version away.
      this.prevented = null;
      this.restoreDom();
      return;
    }
    this.prevented = null;
    const res = this.reconcile();
    if (!res) {
      this.updateTriggers(null);
      return;
    }
    this.commitTyping(res.before, e.data);
    if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') this.afterTyping(e.data || '');
    else this.afterEdit();
  }

  onCompositionStart() {
    if (this.readOnly) return;
    const sel = this.readSel();
    if (sel && !isCollapsed(sel) && sel.a.id !== sel.f.id) this.apply(C.deleteRange(this.doc, sel, { emptyType: newStyle() }), 'structure');
    this.composing = true;
    this.hideToolbar();
  }

  onCompositionEnd(e) {
    this.composing = false;
    this.compEndAt = e.timeStamp;
    this.later(() => {
      if (this.composing) return;
      const res = this.reconcile();
      if (res) {
        this.commitTyping(res.before, e.data);
        this.afterTyping(e.data || '');
      }
      if (this.pendingSet) {
        clearTimeout(this.pendingSetTimer);
        this.pendingSetTimer = this.later(() => {
          if (this.composing || !this.pendingSet) return;
          const [b, o] = this.pendingSet;
          this.pendingSet = null;
          this.setBlocks(b, o);
        }, 500);
      }
    }, 0);
  }

  afterEdit() {
    this.updateTriggers(null);
  }

  /** After typing: Markdown autoformat, then the slash / link / tag / date triggers. */
  afterTyping(data) {
    const sel = this.sel;
    if (!sel || !isCollapsed(sel)) return this.updateTriggers(data);
    const i = idx(this.doc, sel.f.id);
    const b = this.doc[i];
    if (!b || !isText(b)) return;
    if (mdOn() && !this.trigger) {
      if (data.endsWith(' ')) {
        const rule = lineRule(b, sel.f.off);
        if (rule) return this.applyAutoLine(i, rule);
      }
      if (/[*_~=`]$/.test(data)) {
        const r = inlineRule(b, sel.f.off);
        if (r) return this.applyAutoInline(i, r);
      }
    }
    this.updateTriggers(data);
  }

  applyAutoLine(i, rule) {
    const b = this.doc[i];
    const oldEl = this.els.get(b.id);
    const oldSize = oldEl ? parseFloat(getComputedStyle(oldEl.querySelector('.ne-tx') || oldEl).fontSize) : 0;
    const ghostRect = oldEl ? caretRect(oldEl, 0) : null;
    const res = applyLineRule(this.doc, i, rule);
    const marker = blockText(b).slice(0, rule.strip);
    this.apply(res, 'structure', { auto: 'line', what: TYPE_NAMES[rule.t], autoText: marker.trim() });
    this.lastAuto = { version: this.version, kind: 'line', pos: { ...this.sel.f } };
    this.morph(res.morph, rule.t === 'hr' ? res.sel.f.id : b.id, marker, oldSize, ghostRect);
    this.announce(rule.t === 'hr' ? TYPE_NAMES.hr : `Converted to ${TYPE_NAMES[rule.t]}`);
  }

  applyAutoInline(i, rule) {
    const b = this.doc[i];
    const res = applyInlineRule(this.doc, i, rule, { hl: lastHl() });
    const name = rule.hl ? 'Highlight' : MARK_NAMES[rule.mark] || 'Formatting';
    this.apply(res, 'format', { auto: 'inline', what: name.toLowerCase() });
    this.announce(`${name} applied`);
    this.lastAuto = { version: this.version, kind: 'inline', pos: { ...this.sel.f } };
    // Typing on after **bold** continues plain (the format before the opening marker).
    const nb = this.block(b.id);
    const fmt = typingFormat(nb.c, res.range[0]);
    this.pending = { marks: fmt.marks, attrs: fmt.attrs, pos: { ...res.sel.f } };
    if (rule.hl) this.sweep(b.id, res.range[0], res.range[1]);
  }

  // ---------------------------------------------------------------- Enter / soft break

  doEnter(sel) {
    this.closeTrigger();
    const b = this.block(sel.f.id);
    if (isCollapsed(sel) && b && mdOn()) {
      const r = enterRule(b);
      if (r && sel.f.off === blockLen(b)) {
        const i = idx(this.doc, b.id);
        const res = applyLineRule(this.doc, i, r);
        this.apply(res, 'structure', { auto: 'line', what: TYPE_NAMES[r.t], autoText: blockText(b) });
        this.lastAuto = { version: this.version, kind: 'line', pos: { ...this.sel.f } };
        this.morph(res.morph, r.t === 'hr' ? res.sel.f.id : b.id, '', 0, null);
        this.announce(r.t === 'hr' ? TYPE_NAMES.hr : `Converted to ${TYPE_NAMES[r.t]}`);
        return;
      }
    }
    this.apply(C.enter(this.doc, sel, { emptyType: newStyle() }), 'structure');
    this.scrollCaretSoon();
  }

  softBreak(sel) {
    this.apply(C.insertText(this.doc, sel, '\n', typingFormat(this.block(sel.f.id)?.c || [], sel.f.off), { emptyType: newStyle() }), 'structure');
  }

  // ---------------------------------------------------------------- keyboard

  onKeyDown(e) {
    if (e.key === 'Shift') this.shiftDown = true;
    this.ptrAt = 0; // the caret moves by keyboard now
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && e.timeStamp - this.compEndAt < 60) return; // Safari: the Enter that confirmed an IME
    // Suggestion popup navigation (focus stays in the editor).
    if (this.trigger && this.pop.isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.trigger.navigated = true; // the person chose a row: refreshes keep it
        this.pop.move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      // Enter picks only a highlighted row (none is highlighted while the text could still be prose, so
      // Enter makes a new line); Tab also completes a typed query with the first row ("#work" + Tab).
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !isMod(e) && !e.altKey) {
        const typed = !!(this.trigger.query || '').trim();
        const it = this.pop.current() || (e.key === 'Tab' && typed ? this.pop.items.find((x) => !x.disabled) : null);
        if (it) {
          e.preventDefault();
          this.pop.pick(this.pop.items.indexOf(it));
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeTrigger(true);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (this.panel.isOpen) this.panel.close();
      else if (this.toolbar.visible) this.hideToolbar();
      else if (this.chipCard.visible || this.linkCard.visible) {
        this.chipCard.hide();
        this.linkCard.hide();
      } else if (this.findState) this.clearFind();
      else {
        this.docEl.blur();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Alt+F10: the options for what the caret is on (the formatting toolbar, or the card of a link, chip or
    // linked task); Esc in there comes back here. Alt+Enter opens the link or chip at the caret.
    if (e.key === 'F10' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.focusOptions();
      return;
    }
    if (e.key === 'Enter' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && this.openAtCaret()) {
      e.preventDefault();
      return;
    }
    if (this.readOnly) return;
    const mod = isMod(e);
    // Paste as plain text: Ctrl+Shift+V (Windows) / Option+Shift+Cmd+V (Mac). The paste event follows.
    if (mod && e.shiftKey && e.code === 'KeyV' && (isMac ? e.altKey : !e.altKey)) {
      this.forcePlain = true;
      this.later(() => (this.forcePlain = false), 800);
      return;
    }
    // Move line / item: Alt+Shift+Up/Down, Ctrl+Cmd+Up/Down on Mac.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && ((e.altKey && e.shiftKey && !mod) || (isMac && e.ctrlKey && e.metaKey))) {
      e.preventDefault();
      this.exec(e.key === 'ArrowUp' ? 'move-up' : 'move-down');
      return;
    }
    const sc = this.shortcut(e);
    if (sc) {
      e.preventDefault();
      if (sc === 'link') e.stopPropagation();
      if (sc === 'link') this.linkUI();
      else this.exec(sc);
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const sel = this.currentSel();
      const b = this.block(sel.f.id);
      const { s, e: en } = orderSel(this.doc, sel);
      const anyList = this.doc.slice(s.i, en.i + 1).some((x) => LIST.has(x.t));
      if (anyList) {
        e.preventDefault();
        this.exec(e.shiftKey ? 'outdent' : 'indent');
        return;
      }
      if (b && b.t === 'code' && !e.shiftKey) {
        e.preventDefault();
        this.apply(C.insertText(this.doc, sel, '\t'), 'type');
        return;
      }
      return; // focus moves on, as everywhere else
    }
    if (e.key === 'Enter' && mod && !e.altKey) {
      const sel = this.currentSel();
      const b = this.block(sel.f.id);
      e.preventDefault();
      if (b && b.t === 'code') return this.leaveCode(b, true);
      // In a checklist it checks; elsewhere it opens the link or chip at the caret, like Mod+click.
      if (b && b.t !== 'check' && this.openAtCaret()) return;
      this.exec('toggle-check');
      return;
    }
    if (e.key === 'ArrowDown' && !mod && !e.shiftKey && !e.altKey) {
      const sel = this.currentSel();
      const b = this.block(sel.f.id);
      if (b && b.t === 'code' && isCollapsed(sel) && sel.f.off === blockLen(b) && idx(this.doc, b.id) === this.doc.length - 1) {
        e.preventDefault();
        this.leaveCode(b, false);
      }
    }
  }

  onKeyUp(e) {
    if (e.key === 'Shift') this.shiftDown = false;
    if (e.shiftKey || e.key === 'Shift') {
      clearTimeout(this.tbTimer);
      this.tbTimer = this.later(() => this.maybeShowToolbar(), 400);
    }
  }

  /** Leave a code block: drop a trailing newline and continue in a Body block below. */
  leaveCode(b, keepText) {
    const i = idx(this.doc, b.id);
    let doc = this.doc;
    const text = blockText(b);
    if (!keepText && text.endsWith('\n')) doc = replaceAt(doc, i, { ...b, c: text.length > 1 ? [[text.slice(0, -1)]] : [] });
    const next = doc[i + 1];
    if (next && isText(next) && next.t === 'p' && !blockLen(next)) return this.apply({ doc, sel: caret(next.id, 0) }, 'structure');
    const np = newBlock('p', idsOf(doc));
    this.apply({ doc: [...doc.slice(0, i + 1), np, ...doc.slice(i + 1)], sel: caret(np.id, 0) }, 'structure');
  }

  /** Editor keyboard shortcuts (notes-spec §3). Alt combos match on e.code (Option changes e.key on macOS). */
  shortcut(e) {
    const mod = isMod(e);
    if (!mod) return null;
    if (!isMac && e.ctrlKey && e.altKey && e.getModifierState?.('AltGraph')) return null;
    if (isMac && e.ctrlKey) return null;
    const code = e.code;
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)?.[1];
    if (e.altKey) {
      if (e.shiftKey || digit === undefined) return null;
      return { 0: 'body', 1: 'title', 2: 'heading', 3: 'subheading', 4: 'checklist', 5: 'bullet', 6: 'number', 7: 'dash', 8: 'mono', 9: 'quote' }[digit];
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!e.shiftKey) {
      if (k === 'b') return 'bold';
      if (k === 'i') return 'italic';
      if (k === 'u') return 'underline';
      if (k === 'e') return 'code';
      if (k === 'z') return 'undo';
      if (k === 'y' && !isMac) return 'redo';
      if (code === 'BracketRight') return 'indent';
      if (code === 'BracketLeft') return 'outdent';
      if (isMac && code === 'Quote') return 'quote';
      if (k === 'k') {
        const sel = this.currentSel();
        const b = this.block(sel.f.id);
        if (!isCollapsed(sel) || (b && isText(b) && linkExtent(b.c, sel.f.off))) return 'link';
        return null; // the palette gets Mod+K
      }
      return null;
    }
    if (code === 'KeyX') return 'strike';
    if (code === 'KeyH') return 'highlight';
    if (code === 'KeyZ') return 'redo';
    if (isMac) {
      if (code === 'KeyB') return 'body';
      if (code === 'KeyJ') return 'subheading';
      if (code === 'KeyL') return 'checklist';
      if (code === 'KeyU') return 'toggle-check';
      if (code === 'KeyM') return 'mono';
      if (code === 'Digit7') return 'bullet';
      if (code === 'Digit8') return 'dash';
      if (code === 'Digit9') return 'number';
    } else {
      if (code === 'Digit8') return 'bullet';
      if (code === 'Digit7') return 'number';
      if (code === 'Digit9') return 'checklist';
    }
    return null;
  }

  // ---------------------------------------------------------------- selection, focus

  onSelectionChange() {
    if (this.selRaf) return;
    this.selRaf = requestAnimationFrame(() => {
      this.selRaf = 0;
      if (this.composing) return;
      const s = this.readSel();
      if (!s) return;
      if (this.ptrAt && isCollapsed(s)) this.fixDecoCaret(s);
      // The caret where typing or deleting just put it moved with the text: no arrival (noteCaretTarget).
      const typed = sameSel(this.typedSel, s);
      this.typedSel = null;
      const prev = this.sel;
      if (prev && !sameSel(prev, s)) {
        this.history.endGroup();
        if (this.pending && !(this.pending.pos.id === s.f.id && this.pending.pos.off === s.f.off)) this.pending = null;
      }
      this.sel = s;
      if (this.trigger) this.updateTriggers(null);
      this.runDeferredSorts();
      this.updateCards({ typed });
      if (!isCollapsed(s)) {
        if (this.toolbar.visible) this.positionToolbar();
      } else this.hideToolbar();
      this.refreshUI();
    });
  }

  /** Is the live caret right after a task label (where Chrome puts it for a click right of the line)? */
  domAfterDeco() {
    const s = window.getSelection();
    return !!s && s.rangeCount > 0 && s.isCollapsed && this.docEl.contains(s.focusNode) && afterDeco(s.focusNode, s.focusOffset);
  }

  /**
   * A click right of a task-linked checklist item puts the caret after its label: move it before the label,
   * to the end of the text, where typing goes. Only for clicks and taps: from the keyboard (ArrowRight, End)
   * that spot is a step on the way to the next line.
   */
  fixDecoCaret(s) {
    if (document.activeElement === this.docEl && this.domAfterDeco()) this.setDomSel(s);
  }

  onPointerUp(e) {
    if (this.ckPress && !this.ckPress.up) this.ckPress.up = e.timeStamp;
    if (e.pointerType !== 'mouse' || this.readOnly) return;
    if (!this.docEl.contains(e.target) && !this.docEl.contains(window.getSelection()?.anchorNode)) return;
    clearTimeout(this.tbTimer);
    this.tbTimer = this.later(() => this.maybeShowToolbar(), 150);
  }

  maybeShowToolbar() {
    if (this.readOnly || coarse() || this.composing || document.activeElement !== this.docEl) return;
    const s = this.readSel();
    if (!s || isCollapsed(s)) return this.hideToolbar();
    this.sel = s;
    // Text formatting means nothing for a chip on its own (its card is the UI for it).
    if (this.onlyAtoms(s)) return this.hideToolbar();
    this.chipCard.hide();
    this.toolbar.show(this.selRect());
  }

  /** Does a (non-collapsed) selection cover chips and nothing else? */
  onlyAtoms(sel) {
    let any = false;
    for (const g of segments(this.doc, sel)) {
      let pos = 0;
      for (const r of this.doc[g.i].c) {
        const len = r[0].length;
        if (pos < g.to && pos + len > g.from) {
          if (!isAtom(r)) return false;
          any = true;
        }
        pos += len;
      }
    }
    return any;
  }

  positionToolbar() {
    if (this.toolbar.visible) this.toolbar.show(this.selRect());
  }

  hideToolbar() {
    clearTimeout(this.tbTimer);
    if (this.toolbar.visible && !this.toolbar.menuOpen) this.toolbar.hide();
  }

  /** The editor's own floating UI: the selection toolbar (with its highlight list), the Aa panel, the cards. */
  ownsUi(n) {
    return !!n && (this.toolbar.contains(n) || this.panel.contains(n) || this.linkCard.contains(n) || this.chipCard.contains(n) || !!this.wikiCard?.node.contains(n));
  }

  /**
   * Focus there and back (Esc) is no new arrival at the caret's link or chip: the editor's own UI, or its link
   * field (by its class: the field takes focus before linkUI holds it).
   */
  keepsTarget(n) {
    return this.ownsUi(n) || !!n?.closest?.('.ne-lf-pop');
  }

  onFocus(e) {
    this.focused = true;
    // From somewhere else on the page, the caret's link or chip is said again when the caret is on it. Not
    // back from the editor's own UI: a card's Esc closes it as focus leaves (its focusout), so focus comes
    // from a button no longer in the page, or from nothing.
    const from = e?.relatedTarget;
    if (from instanceof Element && from.isConnected && !this.keepsTarget(from)) this.caretTarget = null;
    if (this.sel) this.setDomSel(this.sel);
    this.updateAccessory();
    this.emitSelectionSoon();
  }

  onBlur(e) {
    this.focused = false;
    this.history.endGroup();
    const to = e.relatedTarget;
    if (!this.keepsTarget(to)) this.caretTarget = null;
    const ours = (n) => this.ownsUi(n);
    if (!ours(to)) {
      this.closeTrigger();
      this.later(() => {
        if (document.activeElement === this.docEl) return;
        if (!ours(document.activeElement)) {
          this.hideToolbar();
          this.linkCard.hide();
          this.hideWikiCard();
          this.panel.close();
        }
        this.updateAccessory();
        this.runDeferredSorts(true);
      }, 0);
    }
    // iOS 26 leaves visualViewport.offsetTop stale after the keyboard closes: re-measure later.
    this.later(() => this.acc.position(), 300);
  }

  focusEditor(sel = this.sel) {
    if (this.readOnly && !sel) return;
    this.docEl.focus({ preventScroll: true });
    if (sel) {
      this.sel = clampSel(this.doc, sel);
      this.setDomSel(this.sel);
    }
  }

  updateAccessory() {
    const mode = this.opts.accessory ?? 'auto';
    const want = !this.readOnly && (mode === true || (mode === 'auto' && coarse())) && document.activeElement === this.docEl;
    if (want && !this.acc.visible) {
      this.acc.show();
      document.body.classList.add('ne-acc-on');
      this.host.dispatchEvent(new CustomEvent('editor:accessory', { detail: { visible: true }, bubbles: true }));
    } else if (!want && this.acc.visible) {
      this.acc.hide();
      this.panel.close();
      document.body.classList.remove('ne-acc-on');
      this.host.dispatchEvent(new CustomEvent('editor:accessory', { detail: { visible: false }, bubbles: true }));
    }
  }

  repositionUI() {
    if (this.toolbar.visible) this.positionToolbar();
    if (this.pop.isOpen && this.trigger) this.placeTrigger();
    if (this.acc.visible) this.acc.position();
    if (this.linkCard.visible || this.chipCard.visible) this.updateCards();
  }

  scrollCaretSoon() {
    if (!this.acc.visible) return;
    requestAnimationFrame(() => {
      const r = this.selRect();
      const limit = this.acc.node.getBoundingClientRect().top - 12;
      const vv = window.visualViewport;
      const topLimit = (vv ? vv.offsetTop : 0) + 12;
      const sc = this.scroller();
      if (r.bottom > limit) sc.scrollBy({ top: r.bottom - limit });
      else if (r.top < topLimit) sc.scrollBy({ top: r.top - topLimit });
    });
  }

  emitSelectionSoon() {
    if (!this.opts.onSelectionChange || this.selEmitRaf) return;
    this.selEmitRaf = requestAnimationFrame(() => {
      this.selEmitRaf = 0;
      const sel = this.sel;
      if (!sel) return;
      const st = this.state();
      let rect = null;
      try {
        rect = this.selRect();
      } catch {
        rect = null;
      }
      this.opts.onSelectionChange({ blockId: sel.f.id, blockType: st.blockType, marks: st.marks, hl: st.hl, href: st.href, collapsed: st.collapsed, rect });
    });
  }

  // ---------------------------------------------------------------- state

  state() {
    const sel = this.sel ? clampSel(this.doc, this.sel) : this.currentSel();
    const b = this.block(sel.f.id) || this.doc[0];
    const collapsed = isCollapsed(sel);
    let marks = '';
    let hl = null;
    let href = null;
    if (collapsed) {
      const p = this.pending && this.pending.pos.id === sel.f.id && this.pending.pos.off === sel.f.off ? this.pending : typingFormat(b.c || [], sel.f.off);
      marks = p.marks || '';
      hl = p.attrs?.hl || null;
      const ext = isText(b) ? linkExtent(b.c, sel.f.off) : null;
      href = ext?.href || null;
    } else {
      for (const m of MARKS) if (C.markActive(this.doc, sel, m)) marks += m;
      hl = C.hlActive(this.doc, sel);
      if (sel.a.id === sel.f.id && isText(b)) {
        const { s, e } = orderSel(this.doc, sel);
        const ext = linkExtent(b.c, s.off + 1 <= e.off ? s.off + 1 : s.off);
        if (ext && ext.from <= s.off && ext.to >= e.off) href = ext.href;
      }
    }
    const { s, e } = orderSel(this.doc, sel);
    const types = new Set(this.doc.slice(s.i, e.i + 1).filter(isText).map((x) => x.t));
    return {
      blockType: b.t,
      marks,
      hl,
      href,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      collapsed,
      inList: LIST.has(b.t) || [...types].some((t) => LIST.has(t)),
      inCheck: b.t === 'check',
      inCode: b.t === 'code',
      indent: b.in || 0,
      multiType: types.size > 1,
    };
  }

  // ---------------------------------------------------------------- commands

  exec(cmd, arg) {
    const TYPES = { title: 'h1', heading: 'h2', subheading: 'h3', body: 'p', mono: 'code', bullet: 'bullet', dash: 'dash', number: 'num', checklist: 'check', quote: 'quote' };
    const MARK = { bold: 'b', italic: 'i', underline: 'u', strike: 's', code: 'c' };
    if (this.readOnly) return false;
    if (cmd === 'aa') {
      this.panel.open(arg instanceof Element ? arg : this.selRect());
      return true;
    }
    if (cmd === 'insert') {
      this.openInsert(arg);
      return true;
    }
    if (cmd === 'hide-keyboard') {
      this.docEl.blur();
      return true;
    }
    if (cmd === 'undo') return this.undo();
    if (cmd === 'redo') return this.redo();
    const sel = this.currentSel();
    const keepFocus = () => {
      if (document.activeElement !== this.docEl && !this.panel.isOpen) this.focusEditor(this.sel);
    };
    let ok = false;
    if (TYPES[cmd]) {
      ok = this.apply(C.setType(this.doc, sel, TYPES[cmd], {}, { toggle: arg?.toggle !== false }), 'structure', { what: TYPE_NAMES[TYPES[cmd]] });
      if (ok && TYPES[cmd] === 'check') this.morph('check-btn', this.sel.f.id);
    } else if (MARK[cmd]) ok = this.toggleMark(sel, MARK[cmd]);
    else if (cmd === 'divider') ok = this.apply(C.insertDivider(this.doc, sel), 'structure', { what: 'divider' });
    else if (cmd === 'highlight') ok = this.highlight(sel, arg);
    else if (cmd === 'link') {
      if (arg === undefined) {
        this.linkUI();
        return true;
      }
      const href = arg === null ? null : safeHref(String(arg));
      if (arg !== null && !href) return false;
      ok = this.apply(C.setLink(this.doc, sel, href), 'format');
    } else if (cmd === 'indent' || cmd === 'outdent') ok = this.apply(C.indent(this.doc, sel, cmd === 'indent' ? 1 : -1), 'structure', { what: cmd });
    else if (cmd === 'toggle-check') ok = this.toggleChecks(C.checkIdsIn(this.doc, sel));
    else if (cmd === 'check-all' || cmd === 'uncheck-all') ok = this.checkMany(arg, cmd === 'check-all');
    else if (cmd === 'delete-checked') {
      const i = idx(this.doc, typeof arg === 'string' ? arg : sel.f.id);
      ok = this.apply(C.deleteChecked(this.doc, i, sel), 'check', { what: 'delete' });
    } else if (cmd === 'sort-checked') {
      const i = idx(this.doc, typeof arg === 'string' ? arg : sel.f.id);
      const nd = C.sortChecked(this.doc, i);
      ok = nd ? this.applyMove(nd, 'check') : false;
    } else if (cmd === 'send-to-tasks') ok = this.sendToTasks(arg, sel);
    else if (cmd === 'insert-link-picker') ok = this.insertTriggerText('[[', sel);
    else if (cmd === 'date') ok = this.insertTriggerText('@', sel);
    else if (cmd === 'move-up' || cmd === 'move-down') {
      const res = C.moveBlocks(this.doc, sel, cmd === 'move-up' ? -1 : 1);
      ok = res ? this.applyMove(res.doc, 'structure', res.sel) : false;
    } else return false;
    if (ok) {
      keepFocus();
      this.announce(this.doneMessage(cmd, arg));
    }
    return ok;
  }

  /** What a screen reader hears after a command worked (checks say it themselves, in toggleChecks). */
  doneMessage(cmd, arg) {
    const b = this.sel ? this.block(this.sel.f.id) : null;
    const MARK = { bold: 'b', italic: 'i', underline: 'u', strike: 's', code: 'c' };
    if (MARK[cmd]) return `${MARK_NAMES[MARK[cmd]]} ${this.state().marks.includes(MARK[cmd]) ? 'on' : 'off'}`;
    if (cmd === 'highlight') {
      const hl = this.state().hl;
      return hl ? `${HL_NAMES[hl] || 'Colour'} highlight` : 'Highlight off';
    }
    if (cmd === 'link') return arg === null ? 'Link removed' : 'Link added';
    if (cmd === 'indent' || cmd === 'outdent') return `${cmd === 'indent' ? 'Indented' : 'Outdented'}, level ${(b?.in || 0) + 1}`;
    if (cmd === 'move-up' || cmd === 'move-down') return cmd === 'move-up' ? 'Moved up' : 'Moved down';
    if (cmd === 'divider') return TYPE_NAMES.hr;
    if (cmd === 'delete-checked') return 'Checked items deleted';
    if (cmd === 'sort-checked') return 'Checked items moved to the end';
    if (['title', 'heading', 'subheading', 'body', 'mono', 'bullet', 'dash', 'number', 'checklist', 'quote'].includes(cmd)) return b ? TYPE_NAMES[b.t] : '';
    return '';
  }

  toggleMark(sel, mark) {
    const b = this.block(sel.f.id);
    if (isCollapsed(sel)) {
      if (!b || b.t === 'code') return false;
      // Collapsed caret: the next typed text gets (or loses) the mark.
      const cur = this.pending && this.pending.pos.id === sel.f.id && this.pending.pos.off === sel.f.off ? this.pending : { ...typingFormat(b.c, sel.f.off) };
      // Canonical order ('biusc'), whatever order the keys were pressed in: the store saves it that way.
      const marks = normMarks(cur.marks.includes(mark) ? cur.marks.replace(mark, '') : cur.marks + mark);
      this.pending = { marks, attrs: cur.attrs || null, pos: { ...sel.f } };
      this.refreshUI();
      return true;
    }
    const res = C.toggleMark(this.doc, sel, mark);
    return this.apply(res, 'format');
  }

  highlight(sel, color) {
    let c = color;
    if (c === undefined) c = C.hlActive(this.doc, sel) ? null : lastHl();
    if (c && !HL_COLORS.includes(c)) return false;
    if (isCollapsed(sel)) {
      const b = this.block(sel.f.id);
      if (!b || b.t === 'code') return false;
      const cur = this.pending && this.pending.pos.id === sel.f.id ? this.pending : { ...typingFormat(b.c, sel.f.off) };
      this.pending = { marks: cur.marks || '', attrs: c ? { hl: c } : null, pos: { ...sel.f } };
      if (c) savePrefs({ hl: c });
      this.refreshUI();
      return true;
    }
    if (c) savePrefs({ hl: c });
    const segs = segments(this.doc, sel, { skipCode: true });
    const fade = !c ? this.captureHighlightRects(sel) : null;
    const ok = this.apply(C.setHighlight(this.doc, sel, c), 'format');
    if (ok && c) for (const g of segs) this.sweep(this.doc[g.i].id, g.from, g.to);
    if (ok && fade) this.fadeRects(fade);
    return ok;
  }

  insertTriggerText(text, sel) {
    const b = this.block(sel.f.id);
    if (!b || !isText(b) || b.t === 'code') return false;
    if (text === '[[' && !this.opts.linkProvider) return false;
    if (!isCollapsed(sel) && text === '[[') return this.openNotePicker(sel), true;
    // "@" opens only at a block start or after whitespace.
    const prevChar = blockText(b).charAt(sel.f.off - 1);
    const pre = text === '@' && prevChar && !/\s/.test(prevChar) ? ' ' : '';
    this.focusEditor(sel);
    this.apply(C.insertText(this.doc, sel, pre + text, typingFormat(b.c, sel.f.off)), 'type');
    this.updateTriggers(text.slice(-1));
    return true;
  }

  // ---------------------------------------------------------------- checklists

  toggleChecks(ids, value) {
    const list = ids.filter((id) => this.block(id)?.t === 'check');
    if (!list.length) return false;
    const v = value ?? (list.length === 1 ? !this.block(list[0]).ck : list.some((id) => !this.block(id).ck));
    const nd = C.setChecked(this.doc, list, v);
    if (!nd) return false;
    for (const id of list) {
      clearTimeout(this.sortTimers.get(id));
      this.sortTimers.delete(id);
      this.deferredSorts.delete(id);
    }
    const before = { doc: this.doc, sel: this.sel, what: UNDO_WHAT.check };
    this.history.record(before, { kind: 'structure' });
    this.checkEntry = before;
    this.doc = nd;
    this.patch();
    if (document.activeElement === this.docEl && this.sel) this.setDomSel(this.sel);
    if (v && !reduceMotion()) for (const id of list) this.els.get(id)?.classList.add('ne-checked-now');
    this.announce(v ? (list.length > 1 ? `${list.length} items checked` : 'Checked') : list.length > 1 ? `${list.length} items unchecked` : 'Not checked');
    this.emitChange('check');
    for (const id of list) this.opts.onCheckToggle?.(id, v);
    if (autoSortOn()) for (const id of list) this.scheduleSort(id);
    return true;
  }

  checkMany(id, value) {
    const sel = this.currentSel();
    const i = idx(this.doc, typeof id === 'string' ? id : sel.f.id);
    const ids = C.runIds(this.doc, i < 0 ? 0 : i);
    return this.toggleChecks(ids, value);
  }

  scheduleSort(id) {
    clearTimeout(this.sortTimers.get(id));
    this.sortTimers.set(
      id,
      this.later(() => {
        this.sortTimers.delete(id);
        this.runSort(id);
      }, 350),
    );
  }

  caretIn(id) {
    if (document.activeElement !== this.docEl || !this.sel) return false;
    const i = idx(this.doc, id);
    if (i < 0) return false;
    const end = C.subtreeEnd(this.doc, i);
    const ci = idx(this.doc, this.sel.f.id);
    return ci >= i && ci < end;
  }

  runSort(id, force = false) {
    const b = this.block(id);
    if (!b || b.t !== 'check') return;
    if (!force && this.caretIn(id)) {
      this.deferredSorts.add(id); // the block holding the caret never moves under it
      return;
    }
    const nd = C.autoSort(this.doc, id);
    if (!nd) return;
    this.applyMove(nd, 'check', null, this.checkEntry);
  }

  runDeferredSorts(blurred = false) {
    if (!this.deferredSorts.size) return;
    for (const id of [...this.deferredSorts]) {
      if (!blurred && this.caretIn(id)) continue;
      this.deferredSorts.delete(id);
      this.runSort(id, true);
    }
  }

  cancelSortsFor(prevDoc) {
    if (!this.sortTimers.size || prevDoc === this.doc) return;
    for (const [id, t] of this.sortTimers) {
      const b = this.block(id);
      if (!b || b.t !== 'check') {
        clearTimeout(t);
        this.sortTimers.delete(id);
      }
    }
  }

  /** Reorder blocks with a FLIP glide; the scroll position stays anchored. One undo step (or amended). */
  applyMove(nd, kind, sel = null, amend = null) {
    const before = { doc: this.doc, sel: this.sel, what: kind === 'check' ? UNDO_WHAT.check : 'move' };
    if (!(amend && this.history.amendable(amend))) this.history.record(before, { kind: 'structure' });
    const rects = new Map();
    if (!reduceMotion()) for (const [id, e] of this.els) rects.set(id, e.getBoundingClientRect().top);
    const sc = this.scroller();
    const top = sc.scrollTop;
    this.doc = nd;
    if (sel) this.sel = clampSel(nd, sel);
    this.patch();
    sc.scrollTop = top;
    if (document.activeElement === this.docEl && this.sel) this.setDomSel(this.sel);
    if (rects.size) {
      for (const [id, y] of rects) {
        const e = this.els.get(id);
        if (!e) continue;
        const dy = y - e.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) e.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
      }
    }
    this.emitChange(kind);
    return true;
  }

  sendToTasks(arg, sel) {
    if (!this.opts.onSendToTasks) return false;
    let ids = Array.isArray(arg) ? arg.filter((id) => this.block(id)) : null;
    if (!ids) {
      const { s, e } = orderSel(this.doc, sel);
      ids = this.doc
        .slice(s.i, e.i + 1)
        .filter((b) => isText(b) && b.t !== 'code' && blockText(b).trim() && !b.task)
        .map((b) => b.id);
    }
    if (!ids.length) {
      toast('Nothing to send to Tasks', { duration: 2200 });
      return false;
    }
    this.opts.onSendToTasks(ids);
    return true;
  }

  openCheckMenu(point, id) {
    const b = this.block(id);
    if (!b) return;
    const ids = C.runIds(this.doc, idx(this.doc, id));
    const unchecked = ids.filter((x) => !this.block(x).ck && !this.block(x).task);
    openMenu(
      point,
      [
        { label: 'Check All', icon: 'check-circle', onSelect: () => this.checkMany(id, true) },
        { label: 'Uncheck All', icon: 'circle', onSelect: () => this.checkMany(id, false) },
        !autoSortOn() && { label: 'Move Checked to Bottom', icon: 'sort', onSelect: () => this.exec('sort-checked', id) },
        { label: 'Delete Checked', icon: 'trash', danger: true, disabled: !ids.some((x) => this.block(x).ck), onSelect: () => this.exec('delete-checked', id) },
        this.opts.onSendToTasks && { sep: true },
        this.opts.onSendToTasks && !b.task && blockText(b).trim() && { label: 'Send to Tasks', ...sendIcon(), onSelect: () => this.opts.onSendToTasks([id]) },
        this.opts.onSendToTasks && unchecked.length > 0 && { label: `Send unchecked to Tasks (${unchecked.length})`, ...sendIcon(), onSelect: () => this.opts.onSendToTasks(unchecked) },
      ],
      { label: 'Checklist' },
    );
  }

  // ---------------------------------------------------------------- pointer

  onPointerDown(e) {
    this.ptrAt = e.timeStamp; // the next caret came from a click or tap (see fixDecoCaret)
    const ck = e.target.closest?.('.ne-ck');
    if (ck && this.docEl.contains(ck)) {
      e.preventDefault(); // keep the caret (and the phone keyboard) where they are
      if (this.readOnly) return;
      const be = blockElOf(this.docEl, ck);
      if (!be) return;
      const id = be.dataset.id;
      // The click that follows this press must not toggle it back (onClick): it is matched by its pointerup.
      this.ckPress = { id, up: 0 };
      if (e.pointerType === 'mouse') {
        if (e.button !== 0) return;
        if (isMod(e)) this.checkMany(id, C.runIds(this.doc, idx(this.doc, id)).some((x) => !this.block(x).ck));
        else this.toggleChecks([id]);
        return;
      }
      this.touchCheck(e, id, ck);
      return;
    }
    if (e.target.closest?.('.ne-tc')) {
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'touch' && !this.readOnly) this.trackSwipe(e);
  }

  /** Touch on a checklist circle: tap toggles; a 350 ms long-press lifts the item for dragging (or opens the menu). */
  touchCheck(e, id, ck) {
    const x0 = e.clientX;
    const y0 = e.clientY;
    let lifted = false;
    let moved = false;
    const timer = setTimeout(() => {
      lifted = true;
      navigator.vibrate?.(8);
      this.els.get(id)?.classList.add('ne-lifted');
    }, 350);
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) {
        if (!lifted) {
          clearTimeout(timer);
          cleanup();
          return;
        }
        if (!moved) {
          moved = true;
          cleanup();
          this.els.get(id)?.classList.remove('ne-lifted');
          this.startDrag(id, ev);
        }
      }
    };
    const up = () => {
      clearTimeout(timer);
      cleanup();
      this.els.get(id)?.classList.remove('ne-lifted');
      if (moved) return;
      if (lifted) this.openCheckMenu(ck, id);
      else this.toggleChecks([id]);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Swipe a list item right / left past 40 px to indent / outdent (touch). */
  trackSwipe(e) {
    const be = blockElOf(this.docEl, e.target);
    if (!be || !LIST.has(be.dataset.type)) return;
    const id = be.dataset.id;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let done = false;
    const move = (ev) => {
      if (done) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (Math.abs(dy) > 24) return cleanup();
      if (Math.abs(dx) > 40) {
        done = true;
        cleanup();
        const b = this.block(id);
        if (!b) return;
        const nb = { ...b, in: Math.min(6, Math.max(0, (b.in || 0) + (dx > 0 ? 1 : -1))) };
        if (nb.in === b.in) return;
        navigator.vibrate?.(8);
        this.apply({ doc: replaceAt(this.doc, idx(this.doc, id), nb), sel: this.sel }, 'structure');
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  }

  onClick(e) {
    // A checklist circle: a mouse press or a tap already toggled it on pointerdown. A click with no press of
    // its own is assistive technology (a screen reader's Enter or Space in browse mode, voice control's
    // "click Milk", switch access, element.click()): it toggles here.
    const ck = e.target.closest?.('.ne-ck');
    if (ck && this.docEl.contains(ck)) {
      e.preventDefault();
      const be = blockElOf(this.docEl, ck);
      const p = this.ckPress;
      this.ckPress = null;
      const pressed = !!p && e.detail > 0 && p.id === be?.dataset.id && p.up && e.timeStamp - p.up < 600;
      if (!pressed && !this.readOnly && be && this.block(be.dataset.id)?.t === 'check') this.toggleChecks([be.dataset.id]);
      return;
    }
    const chip = e.target.closest?.('.ne-chip');
    if (chip && this.docEl.contains(chip)) {
      e.preventDefault();
      const ref = chip.dataset.ref;
      if (e.target.closest('.ne-tc')) return void this.toggleTask(ref);
      if (isMod(e)) return void this.activate(ref, e, 'open');
      // A click selects the whole chip (user-select: all): put the caret after it instead, so the click
      // reads as "here", and no formatting toolbar opens over the card.
      const be = blockElOf(this.docEl, chip);
      if (be && this.block(be.dataset.id)) {
        const end = caret(be.dataset.id, offsetIn(be, chip, 0) + (chip.dataset.label || '').length);
        if (this.readOnly) this.setDomSel(end);
        else this.focusEditor(end);
        this.hideToolbar();
      }
      this.showChipCard(chip);
      return;
    }
    // The date pill after a task-linked checklist item: like a chip, a click shows its card (Complete,
    // Open) and Mod+click opens the task. People click there to put the caret at the end of the item.
    const meta = e.target.closest?.('.ne-taskmeta');
    if (meta && meta.dataset.taskRef && this.docEl.contains(meta)) {
      e.preventDefault();
      if (isMod(e)) return void this.activate(meta.dataset.taskRef, e, 'open');
      const be = blockElOf(this.docEl, meta);
      const b = be && this.block(be.dataset.id);
      if (b && !this.readOnly) this.focusEditor(caret(b.id, blockLen(b)));
      this.showChipCard(meta);
      return;
    }
    const a = e.target.closest?.('a.ne-link, a.ne-ref');
    if (a && this.docEl.contains(a)) {
      e.preventDefault();
      if (a.classList.contains('ne-ref')) {
        if (isMod(e) || this.readOnly) this.activate(a.dataset.ref, e, 'open');
        return;
      }
      if (isMod(e) || this.readOnly) this.openHref(a.getAttribute('href'));
      return;
    }
    if (isMod(e) && !this.readOnly) {
      const w = this.wikiAt();
      if (w) this.createFromWiki(w);
    }
  }

  onContextMenu(e) {
    const ck = e.target.closest?.('.ne-ck');
    if (!ck || !this.docEl.contains(ck) || this.readOnly) return;
    e.preventDefault();
    const be = blockElOf(this.docEl, ck);
    if (be) this.openCheckMenu({ x: e.clientX, y: e.clientY }, be.dataset.id);
  }

  onPointerOver(e) {
    if (e.pointerType !== 'mouse') return;
    const chip = e.target.closest?.('.ne-chip, .ne-taskmeta[data-task-ref]');
    if (!chip || !this.docEl.contains(chip)) return;
    clearTimeout(this.hoverTimer);
    this.hoverTimer = this.later(() => {
      if (chip.matches(':hover') && this.chipCard.chip !== chip) this.showChipCard(chip);
    }, 400);
  }

  onPointerOut(e) {
    const chip = e.target.closest?.('.ne-chip, .ne-taskmeta[data-task-ref]');
    if (!chip) return;
    clearTimeout(this.hoverTimer);
    if (this.chipCard.chip === chip && !this.chipCard.node?.matches(':hover')) this.chipCard.scheduleHide(300);
  }

  /** The card for a chip, or for the date pill of a task-linked checklist item (data-task-ref). */
  showChipCard(chip) {
    const ref = chip.dataset.ref || chip.dataset.taskRef;
    if (!ref) return;
    const kind = refKind(ref);
    const label = chip.dataset.label || '';
    let info = { kind, ref, title: label };
    try {
      if (kind === 'task' && this.opts.taskLookup) {
        const t = this.opts.taskLookup(refId(ref));
        info = t ? { kind, ref, title: t.title || label, done: !!t.done, sub: t.date && isYmd(t.date) ? `${dayChipLabel(t.date)}${t.repeat ? ' · Repeats' : ''}` : t.repeat ? 'Repeats' : '' } : { kind, ref, title: label, missing: true };
      } else if (this.opts.refLookup) {
        const r = this.opts.refLookup(ref);
        if (r) info = { kind, ref, title: r.title || label, sub: r.sub || '', preview: typeof r.preview === 'string' ? r.preview : '', missing: !!r.missing, trashed: !!r.trashed };
      }
    } catch {
      /* a lookup failing must not break the editor */
    }
    if (kind === 'day') {
      // The relative day lives on the card (the chip has no tooltip): "Tuesday, 2 events · In 2 days".
      const rel = relativeDay(ref.slice(4));
      if (!info.sub) info.sub = rel;
      else if (!String(info.sub).toLowerCase().includes(rel.toLowerCase())) info.sub = `${info.sub} · ${rel}`;
    }
    this.linkCard.hide();
    this.hideWikiCard();
    this.chipCard.show(chip, { ...info, readOnly: this.readOnly });
  }

  /** Open (or recover / toggle) a referenced note, task, event or day. ev is the click when there is one. */
  activate(ref, ev, action = 'open') {
    if (!this.opts.onLinkActivate) return;
    this.opts.onLinkActivate(ref, action === 'open' && ev ? ev : { type: action, action, original: ev || null });
  }

  toggleTask(ref) {
    if (this.readOnly) return;
    const id = refId(ref);
    if (this.opts.onTaskToggle) this.opts.onTaskToggle(id);
    else this.activate(ref, { type: 'toggle', action: 'toggle' }, 'toggle');
    this.later(() => this.refreshDecor(), 0);
  }

  openHref(href) {
    const h = safeHref(href || '');
    if (!h) return;
    const a = document.createElement('a');
    a.href = h;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }

  /** Re-render blocks with chips or task links when the data behind them changes. */
  refreshDecor() {
    if (this.composing) return;
    const ctx = this.renderCtx();
    let any = null;
    for (const b of this.doc) {
      if (!isText(b) || !(b.task || b.c.some(isAtom))) continue;
      const e = this.els.get(b.id);
      if (!e) continue;
      const fresh = renderBlock(b, ctx);
      const sig = (n) => [...n.querySelectorAll('.ne-chip, .ne-deco')].map((c) => `${c.className}|${c.textContent}`).join('\u0001');
      if (sig(fresh) === sig(e)) continue;
      if (e.dataset.marker) fresh.dataset.marker = e.dataset.marker;
      e.replaceWith(fresh);
      this.els.set(b.id, fresh);
      (any ||= new Set()).add(b.id);
    }
    if (any) {
      this.decorate(any);
      this.mo.takeRecords();
      if (document.activeElement === this.docEl && this.sel) this.setDomSel(this.sel);
    }
  }

  // ---------------------------------------------------------------- grips & drag

  onHoverMove(e) {
    if (e.pointerType !== 'mouse' || this.readOnly || this.dragging) return;
    const be = blockElOf(this.docEl, e.target);
    if (!be || !LIST.has(be.dataset.type)) return this.hideGrip(400);
    clearTimeout(this.gripTimer);
    if (this.gripFor === be.dataset.id && this.grip.classList.contains('on')) return;
    this.gripFor = be.dataset.id;
    const rr = this.root.getBoundingClientRect();
    const tx = be.querySelector(':scope > .ne-tx') || be;
    const lead = be.querySelector(':scope > .ne-ck') || tx;
    const lr = lead.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(tx).lineHeight) || 24;
    const left = (be.dataset.type === 'check' ? lr.left : tx.getBoundingClientRect().left - 22) - rr.left - 22;
    this.grip.style.transform = `translate(${Math.round(left)}px, ${Math.round(tx.getBoundingClientRect().top - rr.top + (lh - 24) / 2)}px)`;
    this.grip.classList.add('on');
  }

  hideGrip(ms = 0) {
    clearTimeout(this.gripTimer);
    this.gripTimer = this.later(() => {
      if (!this.dragging) this.grip.classList.remove('on');
    }, ms);
  }

  onGripDown(e) {
    if (e.button !== 0 || !this.gripFor) return;
    e.preventDefault();
    this.startDrag(this.gripFor, e);
  }

  /** Drag a block (with its list subtree) to a new place. A model move, never a native DOM drag. */
  startDrag(id, e) {
    const i = idx(this.doc, id);
    if (i < 0) return;
    const from = i;
    const to = C.subtreeEnd(this.doc, i);
    const ids = this.doc.slice(from, to).map((b) => b.id);
    this.dragging = true;
    for (const x of ids) this.els.get(x)?.classList.add('ne-dragging');
    const line = el('div', { class: 'ne-dropline' });
    this.overlay.append(line);
    let before = null;
    const rr = () => this.root.getBoundingClientRect();
    const move = (ev) => {
      const y = ev.clientY;
      let target = this.doc.length;
      for (let k = 0; k < this.doc.length; k++) {
        const r = this.els.get(this.doc[k].id)?.getBoundingClientRect();
        if (r && y < r.top + r.height / 2) {
          target = k;
          break;
        }
      }
      if (target >= from && target <= to) {
        before = null;
        line.classList.remove('on');
        return;
      }
      before = target;
      const ref = this.els.get(this.doc[Math.min(target, this.doc.length - 1)].id).getBoundingClientRect();
      const yy = target >= this.doc.length ? ref.bottom : ref.top;
      const tx = this.els.get(id).querySelector(':scope > .ne-tx');
      const left = (tx ? tx.getBoundingClientRect().left : ref.left) - rr().left - 28;
      line.style.transform = `translate(${Math.round(left)}px, ${Math.round(yy - rr().top - 1)}px)`;
      line.style.width = `${Math.round(ref.right - rr().left - left)}px`;
      line.classList.add('on');
      const sc = this.scroller();
      const sr = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
      if (y < sr.top + 40) sc.scrollBy({ top: -12 });
      else if (y > sr.bottom - 40) sc.scrollBy({ top: 12 });
    };
    const end = (commit) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      line.remove();
      for (const x of ids) this.els.get(x)?.classList.remove('ne-dragging');
      this.dragging = false;
      this.hideGrip(0);
      if (commit && before !== null) {
        const nd = C.moveUnitTo(this.doc, from, to, before);
        if (nd) this.applyMove(nd, 'structure');
      }
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    move(e);
  }

  // ---------------------------------------------------------------- triggers: slash, [[ / >>, #tag, @date

  updateTriggers(data) {
    const sel = this.sel;
    if (!sel || !isCollapsed(sel) || this.readOnly) return this.closeTrigger();
    const b = this.block(sel.f.id);
    if (!b || !isText(b) || b.t === 'code') return this.closeTrigger();
    const text = blockText(b);
    const off = sel.f.off;
    const t = this.trigger;
    if (t && t.kind !== 'insert') {
      if (t.id !== b.id || off < t.off + t.len || text.slice(t.off, t.off + t.len) !== t.chars) return this.closeTrigger();
      const q = text.slice(t.off + t.len, off);
      if (q.includes('\n') || q.length > (t.kind === 'link' ? 80 : 32)) return this.closeTrigger();
      if (t.kind === 'link' && q.includes(']]')) return this.closeTrigger();
      if (t.kind === 'tag' && !isTagBody(q)) return this.closeTrigger();
      t.query = q;
      return this.refreshTrigger();
    }
    if (t && t.kind === 'insert') {
      if (data) this.closeTrigger();
      return;
    }
    if (!data) return;
    const pre = text.slice(0, off);
    const masked = maskedText(b.c).slice(0, off);
    const ch = data.slice(-1);
    const startOrSpace = (k) => k === 0 || /\s/.test(pre[k - 1]);
    if (ch === '/' && startOrSpace(off - 1)) return this.openTrigger({ kind: 'slash', id: b.id, off: off - 1, len: 1, chars: '/' });
    if (this.opts.linkProvider && masked.endsWith('[[') && !masked.endsWith('[[[')) return this.openTrigger({ kind: 'link', id: b.id, off: off - 2, len: 2, chars: '[[' });
    if (this.opts.linkProvider && masked.endsWith('>>') && startOrSpace(off - 2)) return this.openTrigger({ kind: 'link', id: b.id, off: off - 2, len: 2, chars: '>>' });
    if (ch === '@' && startOrSpace(off - 1)) return this.openTrigger({ kind: 'date', id: b.id, off: off - 1, len: 1, chars: '@' });
    if (this.opts.tagProvider) {
      // At the tag's first character: one key, or a syllable / word an IME committed in one go ("हि").
      const m = tagAtEnd(masked);
      if (m && hasLetter(m.body) && data.endsWith(m.body)) return this.openTrigger({ kind: 'tag', id: b.id, off: m.start, len: 1, chars: '#' });
    }
  }

  openTrigger(t) {
    this.trigger = { ...t, query: '' };
    this.pop.hl = -1;
    this.updateTriggers(null);
  }

  closeTrigger() {
    if (!this.trigger && !this.pop.isOpen) return;
    this.trigger = null;
    this.linkReq++;
    this.hidePop();
  }

  /** Close the list but keep the trigger (a tag list reopens as more is typed). */
  hidePop() {
    this.pop.close();
    this.docEl.removeAttribute('aria-controls');
  }

  /**
   * Show the suggestion list and decide which row Enter picks. While what was typed could still be prose
   * (">>" or "@" with nothing after it, a tag that already exists), no row is highlighted, so Enter makes
   * a new line; arrows (or Tab) pick a row. role=textbox takes aria-controls + aria-activedescendant
   * (aria-expanded / aria-haspopup are not allowed on it).
   */
  showTrigger(rect, items, opts, auto) {
    const t = this.trigger;
    if (t && !t.navigated) this.pop.hl = auto ? items.findIndex((it) => !it.disabled) : -1;
    this.pop.show(rect, items, { kind: t?.kind || '', ...opts, autoHl: !!(auto || t?.navigated) });
    this.docEl.setAttribute('aria-controls', this.pop.id);
  }

  triggerRect() {
    const t = this.trigger;
    const e = t && this.els.get(t.id);
    return e ? caretRect(e, t.off) : this.selRect();
  }

  placeTrigger() {
    if (!this.trigger || this.trigger.kind === 'insert') return this.pop.place();
    this.pop.anchor = this.triggerRect();
    this.pop.place();
  }

  refreshTrigger() {
    const t = this.trigger;
    if (!t) return;
    const q = t.query || '';
    if (t.shown === q && this.pop.isOpen) return this.placeTrigger();
    t.shown = q;
    // A space straight after "/", ">>" or "@" means prose ("x and / or", "Step 1 >> Step 2", "@ 5pm"),
    // never a command: the list closes and Enter is a new line. ("[[" is always deliberate.)
    if ((t.kind === 'slash' || t.kind === 'date' || (t.kind === 'link' && t.chars === '>>')) && /^\s/.test(q)) return this.closeTrigger();
    if (t.kind === 'slash' || t.kind === 'insert') {
      const items = this.slashItems(q);
      // Once the query holds a space only names that start with it stay ("/numbered l"), so prose closes.
      if (!items.length && (/\s/.test(q) || q.length > 12)) return this.closeTrigger();
      this.showTrigger(t.kind === 'insert' ? t.rect : this.triggerRect(), items, { mode: t.mode || 'float', empty: 'No matching blocks' }, true);
      return;
    }
    if (t.kind === 'date') {
      const items = this.dateItems(q);
      // While what is typed can still become a date ("@fr", "@next f", "@dec "), the list stays with "Keep
      // typing a date"; prose ("@mark") closes it.
      if (!items.length && q && !maybeDate(q)) return this.closeTrigger();
      this.showTrigger(this.triggerRect(), items, { empty: 'Keep typing a date', kind: 'date' }, !!q.trim());
      return;
    }
    if (t.kind === 'tag') {
      let tags = [];
      try {
        tags = (this.opts.tagProvider?.(q) || []).map(String);
      } catch {
        tags = [];
      }
      const lq = q.toLowerCase();
      const matches = tags.filter((x) => x && x.toLowerCase().startsWith(lq));
      // A tag that already exists stays first and is not preselected: Enter ends the line ("#work" with
      // #work/clients around); arrows pick a longer tag, Tab completes the typed one.
      const exact = matches.findIndex((x) => x.toLowerCase() === lq);
      if (exact > 0) matches.unshift(...matches.splice(exact, 1));
      const items = matches.slice(0, 8).map((x) => ({ id: x, label: `#${x}`, icon: 'hash', data: { tag: x } }));
      if (!items.length || (items.length === 1 && exact >= 0)) return this.hidePop();
      this.showTrigger(this.triggerRect(), items, {}, exact < 0);
      return;
    }
    if (t.kind === 'link') {
      const req = ++this.linkReq;
      let p;
      try {
        p = Promise.resolve(this.opts.linkProvider(q));
      } catch {
        p = Promise.resolve([]);
      }
      p.then((items) => {
        if (req !== this.linkReq || !this.trigger || this.trigger.kind !== 'link') return;
        // ">>" alone at the end of a line is an arrow until something is typed after it.
        this.showTrigger(this.triggerRect(), this.linkItems(items, q), { empty: q ? 'No matches' : 'No notes yet' }, this.trigger.chars !== '>>' || !!q.trim());
      }).catch(() => {});
    }
  }

  slashItems(q) {
    const st = this.state();
    const recent = Array.isArray(prefs().recent) ? prefs().recent : [];
    let list = SLASH.filter((it) => {
      if (it.id === 'link' && !this.opts.linkProvider) return false;
      if (it.id === 'send') return st.inCheck && !!this.opts.onSendToTasks;
      return true;
    });
    if (/\S\s/.test(q)) {
      // Several words: prefix matches only ("/numbered l", "/code b", "/h1 "), never a fuzzy guess.
      const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
      const lq = norm(q.trimStart());
      list = list.filter((it) => norm(it.label).startsWith(lq) || norm(it.alias || '').startsWith(lq));
    } else if (q.trim()) {
      list = list
        .map((it) => ({ it, s: Math.max(fuzzy(it.label, q), fuzzy(it.alias || '', q) - 5) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.it);
    } else {
      const top = recent.map((id) => list.find((x) => x.id === id)).filter(Boolean).slice(0, 3);
      list = [...top, ...list.filter((x) => !top.includes(x))];
    }
    return list.map((it) => ({ id: it.id, label: it.label, hint: it.hint || '', icon: it.icon, data: it }));
  }

  dateItems(q) {
    const today = todayYmd();
    const wd = parseYmd(today).getDay();
    const nextMon = addDaysYmd(today, ((8 - wd) % 7) || 7);
    const tomorrow = addDaysYmd(today, 1);
    const base = [
      { label: 'Today', ymd: today },
      { label: 'Tomorrow', ymd: tomorrow },
      // On a Sunday next Monday is tomorrow (as nlp.js reads "next monday" too): one row, not the same day twice.
      ...(nextMon !== tomorrow ? [{ label: 'Next Monday', ymd: nextMon }] : []),
    ];
    const lq = q.trim().toLowerCase();
    let items = lq ? base.filter((x) => x.label.toLowerCase().startsWith(lq) || x.label.toLowerCase().includes(` ${lq}`)) : base;
    if (lq) {
      try {
        const r = nlpParse(q, { mode: 'task' });
        const d = r.date || r.deadline;
        if (d && isYmd(d) && !String(r.title || '').trim() && !items.some((x) => x.ymd === d)) items = [{ label: dayChipLabel(d), ymd: d, parsed: true }, ...items];
      } catch {
        /* unparsable */
      }
    }
    return items.map((x) => ({ id: x.ymd, label: x.label, hint: x.parsed ? relativeDay(x.ymd) : dayChipLabel(x.ymd), icon: 'calendar', data: x }));
  }

  linkItems(items, q) {
    const order = { note: 0, task: 1, event: 2, day: 3, create: 4 };
    const names = { note: 'Notes', task: 'Tasks', event: 'Events', day: 'Dates' };
    const list = (Array.isArray(items) ? items : []).filter((x) => x && order[x.kind] !== undefined);
    list.sort((a, b) => order[a.kind] - order[b.kind]);
    const out = list.map((x) => ({
      id: `${x.kind}:${x.id ?? ''}`,
      label: x.kind === 'create' ? `Create note “${x.title || q}”` : String(x.title || 'Untitled'),
      sub: x.sub ? String(x.sub) : '',
      icon: x.kind === 'create' ? 'note-plus' : x.kind === 'task' ? 'checklist' : x.kind === 'event' || x.kind === 'day' ? 'calendar' : 'note',
      section: x.kind === 'create' ? null : names[x.kind],
      data: x,
    }));
    if (q.trim() && !out.some((x) => x.data.kind === 'create') && (this.opts.onCreateNote || list.some((x) => x.kind === 'create'))) {
      out.push({ id: 'create:', label: `Create note “${q.trim()}”`, icon: 'note-plus', data: { kind: 'create', title: q.trim() } });
    }
    return out;
  }

  pickTrigger(it) {
    const t = this.trigger;
    if (!t) return;
    const sel = this.currentSel();
    const b = this.block(t.id || sel.f.id);
    // The typed trigger ("/he", "[[gro", "@fri", "#wo") is replaced by the result.
    const range = t.kind === 'insert' ? sel : { a: { id: t.id, off: t.off }, f: { id: t.id, off: sel.f.id === t.id ? sel.f.off : t.off + t.len + (t.query || '').length } };
    this.closeTrigger();
    if (t.kind === 'slash' || t.kind === 'insert') {
      const item = it.data;
      savePrefs({ recent: [item.id, ...(prefs().recent || []).filter((x) => x !== item.id)].slice(0, 6) });
      let doc = this.doc;
      let s = range;
      if (t.kind === 'slash') {
        const r = C.deleteRange(this.doc, range);
        if (r) {
          doc = r.doc;
          s = r.sel;
        }
      }
      const removed = doc !== this.doc;
      if (removed) this.apply({ doc, sel: s }, 'structure');
      this.focusEditor(this.sel);
      const id = item.id;
      if (id === 'link') return void this.insertTriggerText('[[', this.currentSel());
      if (id === 'date') return void this.insertTriggerText('@', this.currentSel());
      if (id === 'send') return void this.exec('send-to-tasks');
      // Removing "/query" and the conversion are one undo step.
      this.suppressRecord = removed;
      try {
        if (id === 'divider') this.exec('divider');
        else this.exec(id, { toggle: false });
      } finally {
        this.suppressRecord = false;
      }
      return;
    }
    if (t.kind === 'tag') {
      const tag = it.data.tag;
      const nextCh = blockText(b).charAt(range.f.off);
      this.apply(C.insertRuns(this.doc, { a: { id: t.id, off: t.off + 1 }, f: range.f }, [[tag + (nextCh === ' ' ? '' : ' ')]]), 'type');
      if (nextCh === ' ') this.focusEditor(caret(t.id, t.off + 1 + tag.length + 1));
      return;
    }
    if (t.kind === 'date') {
      const ymd = it.data.ymd;
      this.apply(C.insertAtom(this.doc, range, dayChipLabel(ymd), `day:${ymd}`), 'structure');
      return;
    }
    if (t.kind === 'link') {
      const x = it.data;
      if (x.kind === 'create') return void this.createAndLink(range, x);
      const ref = x.ref && typeof x.ref === 'string' ? x.ref : `${x.kind}:${x.id}`;
      if (!/^(note|task|event|day):/.test(ref)) return;
      const res = C.insertAtom(this.doc, range, this.chipLabel(ref, x), ref);
      if (!res) {
        toast('That link could not be inserted', { duration: 2200 });
        return;
      }
      this.apply(res, 'structure');
    }
  }

  /**
   * The cached label stored in a chip: absolute, never relative ("Sun, 22 Nov", not "Tomorrow"), so it
   * still reads right in exports and Markdown; the renderer shows the live title (and an event's day and
   * time) when it can. It is the item's own title, the label the save step (notes/core refreshChipLabels)
   * keeps: a label that changes length on the first save moves every offset after the chip, and a picker
   * typed right after it ("@", "/", "[[") lost its place.
   */
  chipLabel(ref, x = {}) {
    const kind = refKind(ref);
    if (kind === 'day' && isYmd(ref.slice(4))) return dayChipLabel(ref.slice(4));
    let live = null;
    try {
      live = kind === 'task' && this.opts.taskLookup ? this.opts.taskLookup(refId(ref)) : this.opts.refLookup?.(ref) || null;
    } catch {
      live = null;
    }
    if (kind === 'event') return live?.title || x.title || 'Event';
    return live?.title || x.title || 'Untitled';
  }

  /** "Create note “X”": remove the typed trigger now, insert the chip once the note exists. */
  createAndLink(range, x) {
    const title = String(x.title || '').trim() || 'Untitled';
    const del = C.deleteRange(this.doc, range);
    if (del) this.apply(del, 'type');
    const at = { ...this.sel.f };
    const insert = (res) => {
      const id = res && (res.id || (res.ref && refId(res.ref)));
      if (!id) return this.insertWiki(at, title);
      const ref = res.ref || `note:${id}`;
      const pos = clampSel(this.doc, { a: at, f: at });
      this.apply(C.insertAtom(this.doc, pos, res.title || title, ref), 'structure');
    };
    if (this.opts.onCreateNote) {
      Promise.resolve(this.opts.onCreateNote(title))
        .then(insert)
        .catch(() => this.insertWiki(at, title));
    } else if (x.ref) insert({ ref: x.ref, title });
    else this.insertWiki(at, title);
  }

  insertWiki(at, title) {
    const pos = clampSel(this.doc, { a: at, f: at });
    this.apply(C.insertText(this.doc, pos, `[[${title}]]`), 'type');
  }

  openInsert(anchor) {
    if (this.readOnly) return;
    const sel = this.currentSel();
    if (document.activeElement !== this.docEl) this.focusEditor(sel);
    const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor || this.selRect();
    this.closeTrigger();
    this.trigger = { kind: 'insert', rect, mode: coarse() && this.acc.visible ? 'sheet' : 'float', query: '' };
    this.refreshTrigger();
  }

  // ---------------------------------------------------------------- links

  linkUI() {
    if (this.readOnly) return;
    const sel = this.currentSel();
    const b = this.block(sel.f.id);
    if (!b || !isText(b) || b.t === 'code') return;
    const ext = isCollapsed(sel) ? linkExtent(b.c, sel.f.off) : null;
    const st = this.state();
    const href = ext?.href || st.href || '';
    const rect = this.selRect();
    this.hideToolbar();
    this.linkCard.hide();
    this.linkField = openLinkField(rect, {
      href,
      canNote: !!this.opts.linkProvider && !isCollapsed(sel),
      onApply: (h) => {
        this.focusEditor(sel);
        if (this.apply(C.setLink(this.doc, sel, h), 'format')) this.announce(!h ? 'Link removed' : href ? 'Link updated' : 'Link added');
      },
      onNote: () => {
        this.focusEditor(sel);
        this.openNotePicker(sel);
      },
      onClose: (applied) => {
        this.linkField = null;
        if (!applied) this.focusEditor(sel);
      },
    });
  }

  /** Close the note picker if one is open (refocus: put the caret back in the editor). */
  closeNotePicker(refocus = false) {
    this.notePicker?.close(refocus);
    this.notePicker = null;
  }

  /**
   * Link the selected words to a note / task / event: they keep your words, the link is by id.
   * opts.onRef(ref) replaces the default (set a ref on `sel`); opts.query pre-fills the search.
   */
  openNotePicker(sel, { onRef = null, query = null } = {}) {
    if (!this.opts.linkProvider || this.dead) return;
    this.closeNotePicker(false);
    const words = segments(this.doc, sel)
      .map((g) => blockText(this.doc[g.i]).slice(g.from, g.to))
      .join(' ')
      .trim();
    const rect = this.selRect();
    const pop = el('div', { class: 'menu ne-np', role: 'dialog', 'aria-label': 'Link to note, task or event' });
    const input = el('input', { class: 'input ne-np-input', type: 'text', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-label': 'Search notes, tasks and events', placeholder: 'Search notes, tasks, events' });
    input.value = (query ?? words).slice(0, 80);
    const list = new ListPopup({
      label: 'Link targets',
      onHighlight: (it, id) => {
        if (id) input.setAttribute('aria-activedescendant', id);
        else input.removeAttribute('aria-activedescendant');
      },
    });
    input.setAttribute('aria-controls', list.id);
    let closed = false;
    const close = (refocus = true) => {
      if (closed) return;
      closed = true;
      if (this.notePicker?.close === close) this.notePicker = null;
      list.close();
      pop.remove();
      document.removeEventListener('pointerdown', outside, true);
      if (refocus && !this.dead) this.focusEditor(sel);
    };
    this.notePicker = { close };
    const outside = (e) => {
      if (!pop.contains(e.target) && !(list.node && list.node.contains(e.target))) close();
    };
    const link = (ref) => {
      // The note may have changed meanwhile (or the editor gone): only link words that are still there.
      if (this.dead || idx(this.doc, sel.a.id) < 0 || idx(this.doc, sel.f.id) < 0) return;
      if (onRef) onRef(ref);
      else this.apply(C.setLink(this.doc, clampSel(this.doc, sel), ref, { key: 'ref' }), 'format');
    };
    list.onPick = (it) => {
      const x = it.data;
      close(true);
      if (x.kind === 'create') {
        const t = (x.title || input.value).trim() || words || 'Untitled';
        const done = (res) => {
          const id = res && (res.id || (res.ref && refId(res.ref)));
          if (id) link(res.ref || `note:${id}`);
        };
        if (this.opts.onCreateNote) Promise.resolve(this.opts.onCreateNote(t)).then(done).catch(() => {});
        else if (x.ref) done({ ref: x.ref });
        return;
      }
      const ref = x.ref && typeof x.ref === 'string' ? x.ref : `${x.kind}:${x.id}`;
      if (/^(note|task|event|day):/.test(ref)) link(ref);
    };
    let req = 0;
    const search = () => {
      const q = input.value;
      const r = ++req;
      new Promise((resolve) => resolve(this.opts.linkProvider(q)))
        .then((items) => {
          if (r !== req || closed) return;
          const ir = input.getBoundingClientRect();
          list.show({ left: ir.left + 12, right: ir.right, top: ir.top, bottom: ir.bottom + 4, width: ir.width, height: ir.height }, this.linkItems(items, q), { empty: 'No matches' });
        })
        .catch(() => {});
    };
    input.addEventListener('input', search);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        list.move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        list.pick();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    pop.append(input);
    document.body.append(pop);
    const vv = window.visualViewport;
    pop.style.left = `${Math.round(Math.min(Math.max(8, rect.left), (vv ? vv.width : innerWidth) - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.round(Math.min(rect.bottom + 8, (vv ? vv.height : innerHeight) - 260))}px`;
    setTimeout(() => !closed && document.addEventListener('pointerdown', outside, true));
    input.focus({ preventScroll: true });
    input.select();
    search();
  }

  /**
   * "[" typed over a selection surrounds it with brackets; a second "[" makes "[[words]]" and opens the
   * note picker — picking links the words (brackets removed), Esc keeps the literal wiki link.
   */
  surround(sel) {
    const { s, e } = orderSel(this.doc, sel);
    const b = this.doc[s.i];
    const text = blockText(b);
    const second = text.charAt(s.off - 1) === '[' && text.charAt(e.off) === ']' && text.charAt(s.off - 2) !== '[';
    const r1 = C.insertText(this.doc, caret(b.id, e.off), ']');
    const r2 = C.insertText(r1.doc, caret(b.id, s.off), '[');
    this.apply({ doc: r2.doc, sel: { a: { id: b.id, off: s.off + 1 }, f: { id: b.id, off: e.off + 1 } } }, 'structure');
    if (second && this.opts.linkProvider) this.openWikiWrap(b.id, s.off - 1, e.off + 3);
  }

  /** Link the words inside "[[…]]" (doc offsets [from, to) include the brackets). */
  openWikiWrap(id, from, to) {
    const words = { a: { id, off: from + 2 }, f: { id, off: to - 2 } };
    this.openNotePicker(words, {
      onRef: (ref) => {
        const b = this.block(id);
        const t = b ? blockText(b) : '';
        if (!b || t.slice(from, from + 2) !== '[[' || t.slice(to - 2, to) !== ']]') {
          this.apply(C.setLink(this.doc, words, ref, { key: 'ref' }), 'format');
          return;
        }
        const d1 = C.deleteRange(this.doc, { a: { id, off: to - 2 }, f: { id, off: to } }).doc;
        const d2 = C.deleteRange(d1, { a: { id, off: from }, f: { id, off: from + 2 } }).doc;
        const span = { a: { id, off: from }, f: { id, off: to - 4 } };
        const res = C.setLink(d2, span, ref, { key: 'ref' });
        if (res) this.apply({ doc: res.doc, sel: caret(id, to - 4) }, 'format');
      },
    });
  }

  /** Unresolved "[[Title]]" under the caret (plain text). */
  wikiAt() {
    const sel = this.currentSel();
    if (!isCollapsed(sel)) return null;
    const b = this.block(sel.f.id);
    if (!b || !isText(b) || b.t === 'code') return null;
    const m = maskedText(b.c);
    WIKI_RE.lastIndex = 0;
    let x;
    while ((x = WIKI_RE.exec(m))) {
      if (sel.f.off > x.index && sel.f.off < x.index + x[0].length) return { id: b.id, from: x.index, to: x.index + x[0].length, title: x[1].trim() };
    }
    return null;
  }

  createFromWiki(w) {
    if (!this.opts.onCreateNote || !w.title) return;
    Promise.resolve(this.opts.onCreateNote(w.title))
      .then((res) => {
        const id = res && (res.id || (res.ref && refId(res.ref)));
        if (!id) return;
        const b = this.block(w.id);
        if (!b || blockText(b).slice(w.from, w.to) !== `[[${w.title}]]`) return;
        const range = { a: { id: w.id, off: w.from }, f: { id: w.id, off: w.to } };
        this.apply(C.insertAtom(this.doc, range, res.title || w.title, res.ref || `note:${id}`), 'structure');
      })
      .catch(() => {});
  }

  /**
   * Cards for the caret: URL link (Open / Edit / Remove + host), note link, unresolved wiki link. typed: the
   * caret is where typing or deleting left it (see noteCaretTarget).
   */
  updateCards({ typed = false } = {}) {
    if (this.readOnly && !this.focused) return;
    const sel = this.sel;
    const inCard = (c) => c.contains(document.activeElement); // a card the keyboard is in stays
    if (!sel || !isCollapsed(sel) || document.activeElement !== this.docEl) {
      if (!this.linkCard.node?.matches(':hover') && !inCard(this.linkCard)) this.linkCard.hide();
      if (!this.wikiCard?.node.contains(document.activeElement)) this.hideWikiCard();
      if (document.activeElement === this.docEl) this.caretTarget = null;
      return;
    }
    const b = this.block(sel.f.id);
    if (!b || !isText(b)) {
      this.hideWikiCard();
      this.caretTarget = null;
      return this.linkCard.hide();
    }
    const ext = linkExtent(b.c, sel.f.off);
    this.noteCaretTarget(b, sel.f.off, ext, { typed });
    if (ext && ext.href && sel.f.off > ext.from && sel.f.off < ext.to) {
      this.hideWikiCard();
      this.showLinkCard(b, ext);
      return;
    }
    this.linkCard.hide();
    const w = this.opts.onCreateNote ? this.wikiAt() : null;
    if (w) this.showWikiCard(w);
    else this.hideWikiCard();
  }

  showLinkCard(b, ext) {
    const e = this.els.get(b.id);
    const r = e && rangeIn(e, ext.from, ext.to);
    const rect = r ? r.getBoundingClientRect() : this.selRect();
    this.linkCard.show(rect, ext.href);
  }

  /**
   * Say once, as the caret arrives, that it is on a link or a chip, and how to reach its options (screen
   * readers hear "Link to example.com. Alt+F10 for options"; nothing shows). The target is named by what it
   * points at, and which of those in its line it is, not by its offset: typing or deleting before it, or a
   * save that relabels a chip earlier in the line, is no new arrival. Nor is a caret that typing or deleting
   * moved (`typed`): that target is noted, not said, so hints never compete with the echo of the keys.
   */
  noteCaretTarget(b, off, ext, { typed = false } = {}) {
    let key = null;
    let what = '';
    const near = ext ? null : this.chipNear(b, off);
    if (ext && off > ext.from && off < ext.to) {
      key = `l:${b.id}:${ext.href || ext.ref}#${linkNth(b.c, ext)}`;
      what = ext.href ? `Link to ${hrefHost(ext.href) || ext.href}` : `Link to ${this.refTitle(ext.ref) || 'a note'}`;
    } else if (near) {
      key = `c:${b.id}:${near.ref}#${near.nth}`;
      const kind = refKind(near.ref);
      what = `${{ note: 'Note', task: 'Task', event: 'Event', day: 'Date' }[kind] || 'Link'}: ${this.refTitle(near.ref) || near.label}`;
    }
    if (key === this.caretTarget) return;
    this.caretTarget = key;
    if (key && !typed) this.announce(`${what}. Alt+F10 for options.`, { hint: true });
  }

  /** The live title of a note, task, event or day (for what a screen reader hears). */
  refTitle(ref) {
    try {
      if (refKind(ref) === 'task' && this.opts.taskLookup) return this.opts.taskLookup(refId(ref))?.title || '';
      return this.opts.refLookup?.(ref)?.title || '';
    } catch {
      return '';
    }
  }

  /**
   * The chip at the caret: touching it, or one space away (where the caret is after inserting one). nth: which
   * chip for the same ref in this line it is (0, 1, …).
   */
  chipNear(b, off) {
    const spans = [];
    const seen = new Map();
    let pos = 0;
    for (const r of b.c || []) {
      const len = r[0].length;
      if (isAtom(r)) {
        const nth = seen.get(r[2].ref) || 0;
        seen.set(r[2].ref, nth + 1);
        spans.push({ ref: r[2].ref, label: r[0], from: pos, to: pos + len, nth });
      }
      pos += len;
    }
    if (!spans.length) return null;
    const text = blockText(b);
    return spans.find((s) => s.to === off) || spans.find((s) => s.from === off) || spans.find((s) => s.to === off - 1 && text[off - 1] === ' ') || spans.find((s) => s.from === off + 1 && text[off] === ' ') || null;
  }

  /** The chip element that starts at model offset `from` in a block element. */
  chipElAt(e, from) {
    for (const c of e.querySelectorAll('.ne-chip')) if (offsetIn(e, c, 0) === from) return c;
    return null;
  }

  /**
   * Alt+F10: keyboard access to what the caret is on. A selection: the formatting toolbar. A URL link: its card
   * (Open, Edit, Remove). A chip, a note link or a linked checklist item: its card (Open; Complete for a task).
   * Focus moves to the first button; Esc there comes back to the same caret.
   */
  focusOptions() {
    const sel = this.currentSel();
    if (!isCollapsed(sel) && !this.onlyAtoms(sel)) {
      if (this.readOnly) return;
      if (!this.toolbar.visible) {
        this.chipCard.hide();
        this.toolbar.show(this.selRect());
      }
      this.toolbar.focusFirst();
      return;
    }
    const b = this.block(sel.f.id);
    const e = b && this.els.get(b.id);
    if (b && e && isText(b)) {
      const off = isCollapsed(sel) ? sel.f.off : orderSel(this.doc, sel).s.off;
      const ext = linkExtent(b.c, off);
      if (ext?.href && !this.readOnly) {
        this.hideWikiCard();
        this.showLinkCard(b, ext);
        return void this.linkCard.focusFirst();
      }
      const near = this.chipNear(b, off);
      const target = near ? this.chipElAt(e, near.from) : ext?.ref ? [...e.querySelectorAll('a.ne-ref')].find((a) => offsetIn(e, a, 0) <= off && a.dataset.ref === ext.ref) : b.task ? e.querySelector('.ne-taskmeta[data-task-ref]') : null;
      if (target) {
        this.showChipCard(target);
        return void this.chipCard.focusFirst();
      }
      // An unresolved "[[Title]]": its Create note card (shown here too: after Esc it is hidden until the caret moves).
      const w = isCollapsed(sel) && this.opts.onCreateNote && !this.readOnly ? this.wikiAt() : null;
      if (w) this.showWikiCard(w);
      if (w && this.wikiCard) return void this.wikiCard.node.querySelector('button')?.focus();
    }
    this.announce('No options here.');
  }

  /** Alt+Enter (and Mod+Enter outside checklists): open the link, chip or linked task at the caret. */
  openAtCaret() {
    const sel = this.currentSel();
    if (!isCollapsed(sel)) return false;
    const b = this.block(sel.f.id);
    if (!b || !isText(b)) return false;
    const ext = linkExtent(b.c, sel.f.off);
    if (ext?.href) return this.openHref(ext.href), true;
    if (ext?.ref) return this.activate(ext.ref, null, 'open'), true;
    const near = this.chipNear(b, sel.f.off);
    if (near) return this.activate(near.ref, null, 'open'), true;
    if (b.task) return this.activate(`task:${b.task}`, null, 'open'), true;
    return false;
  }

  showWikiCard(w) {
    if (this.wikiCard && this.wikiCard.key === `${w.id}:${w.from}`) return;
    this.hideWikiCard();
    const e = this.els.get(w.id);
    const r = e && rangeIn(e, w.from, w.to);
    if (!r) return;
    const n = el('div', { class: 'menu ne-linkcard ne-wikicard', role: 'dialog', 'aria-label': 'Unlinked note' });
    n.addEventListener('pointerdown', (ev) => ev.preventDefault());
    const b = el('button', { type: 'button', class: 'ne-lc-open' }, svgIcon('note-plus', { size: 16 }), el('span', { class: 'ne-lc-text' }, el('span', { class: 'ne-lc-host truncate', text: `Create note “${w.title}”` })));
    b.addEventListener('click', () => {
      // From the keyboard (Alt+F10), focus goes back to the note, where the new note's chip lands.
      const kb = n.contains(document.activeElement);
      this.hideWikiCard();
      if (kb) this.focusEditor(this.sel);
      this.createFromWiki(w);
    });
    // As the link and chip cards: Tab stays in it, Esc goes back to the same caret, focus leaving closes it.
    const mine = () => this.wikiCard?.node === n;
    cardKeys(n, {
      back: () => {
        this.focusEditor(this.sel);
        if (mine()) this.hideWikiCard();
      },
      hide: () => mine() && this.hideWikiCard(),
    });
    n.append(b);
    document.body.append(n);
    const rect = r.getBoundingClientRect();
    n.style.left = `${Math.round(Math.max(8, Math.min(rect.left, innerWidth - n.offsetWidth - 8)))}px`;
    n.style.top = `${Math.round(rect.bottom + 6)}px`;
    this.wikiCard = { node: n, key: `${w.id}:${w.from}` };
  }

  hideWikiCard() {
    this.wikiCard?.node.remove();
    this.wikiCard = null;
  }

  // ---------------------------------------------------------------- delight: morph, sweep, flash

  morph(kind, id, stripped = '', oldSize = 0, ghostRect = null) {
    if (reduceMotion()) return;
    const e = this.els.get(id);
    if (!e) return;
    if (kind === 'check' || kind === 'check-btn') {
      e.classList.add('ne-morph-check');
      this.later(() => e.classList.remove('ne-morph-check'), 400);
    } else if (HEADINGS.has(kind) || kind === 'quote' || LIST.has(kind) || kind === 'code' || kind === 'p') {
      const tx = e.querySelector(':scope > .ne-tx') || e;
      const now = parseFloat(getComputedStyle(tx).fontSize) || 17;
      const from = kind === 'p' ? 1.08 : oldSize && now ? Math.max(0.5, Math.min(1.6, oldSize / now)) : 0.92;
      tx.animate([{ transform: `scale(${from})`, opacity: 0.55, transformOrigin: '0 50%' }, { transform: 'none', opacity: 1, transformOrigin: '0 50%' }], { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    if (stripped.trim() && ghostRect) {
      const rr = this.root.getBoundingClientRect();
      const g = el('span', { class: 'ne-ghost', text: stripped });
      g.style.left = `${ghostRect.left - rr.left}px`;
      g.style.top = `${ghostRect.top - rr.top}px`;
      g.style.fontSize = `${oldSize || 17}px`;
      this.overlay.append(g);
      g.animate([{ opacity: 0.9, transform: 'none' }, { opacity: 0, transform: 'scale(0.6) translateX(-6px)' }], { duration: 120, easing: 'ease-out' }).finished.then(() => g.remove(), () => g.remove());
    }
  }

  /** Highlighter sweep: newly highlighted text paints left to right. */
  sweep(id, from, to) {
    if (reduceMotion()) return;
    const e = this.els.get(id);
    if (!e) return;
    for (const m of e.querySelectorAll('mark.ne-hl')) {
      const r = document.createRange();
      r.selectNodeContents(m);
      const start = offsetIn(e, m, 0);
      if (start >= from && start < to) {
        m.classList.remove('ne-sweep');
        void m.offsetWidth;
        m.classList.add('ne-sweep');
      }
    }
  }

  captureHighlightRects(sel) {
    if (reduceMotion()) return null;
    const out = [];
    const rr = this.root.getBoundingClientRect();
    for (const g of segments(this.doc, sel, { skipCode: true })) {
      const b = this.doc[g.i];
      const e = this.els.get(b.id);
      if (!e) continue;
      for (const m of e.querySelectorAll('mark.ne-hl')) {
        const start = offsetIn(e, m, 0);
        if (start >= g.to || start + m.textContent.length <= g.from) continue;
        const color = getComputedStyle(m).getPropertyValue('--hlbg').trim();
        for (const r of m.getClientRects()) out.push({ left: r.left - rr.left, top: r.top - rr.top, width: r.width, height: r.height, color });
      }
    }
    return out;
  }

  fadeRects(rects) {
    for (const r of rects) {
      const n = el('div', { class: 'ne-hlfade' });
      n.style.left = `${r.left}px`;
      n.style.top = `${r.top}px`;
      n.style.width = `${r.width}px`;
      n.style.height = `${r.height}px`;
      if (r.color) n.style.background = r.color;
      this.overlay.append(n);
      n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out' }).finished.then(() => n.remove(), () => n.remove());
    }
  }

  /**
   * Scroll so the rect from `rectOf()` sits `frac` of the way down the scroller (with `ifHidden`, only
   * when it isn't comfortably in view). Long notes skip layout of off-screen blocks (content-visibility),
   * so blocks never rendered only have an estimated height and one measured jump lands screens away:
   * there the jump is instant and is re-measured and corrected each frame until the target holds still.
   */
  scrollTarget(rectOf, { frac = 0.3, ifHidden = false, smooth = !reduceMotion() } = {}) {
    const sc = this.scroller();
    const isDoc = sc === document.scrollingElement || sc === document.documentElement;
    const delta = () => {
      const r = rectOf();
      if (!r) return null;
      const top = isDoc ? 0 : sc.getBoundingClientRect().top;
      const h = isDoc ? innerHeight : sc.clientHeight;
      if (ifHidden && r.top >= top + 40 && r.bottom <= top + h - 40) return 0;
      return r.top - top - h * frac;
    };
    const seq = ++this.scrollSeq;
    const d0 = delta();
    if (!d0) return;
    const long = this.root.classList.contains('ne-long');
    sc.scrollBy({ top: d0, behavior: smooth && !long ? 'smooth' : 'auto' });
    if (!long) return;
    let frames = 0;
    let still = 0;
    const settle = () => {
      if (seq !== this.scrollSeq || this.dead || ++frames > 24) return;
      const d = delta();
      if (d === null) return;
      if (Math.abs(d) > 4) {
        still = 0;
        sc.scrollBy({ top: d });
      } else if (++still >= 3) return; // three quiet frames: the blocks around it have rendered
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }

  scrollToBlock(id, { flash = true } = {}) {
    const e = this.els.get(id);
    if (!e) return false;
    this.scrollTarget(() => (e.isConnected ? e.getBoundingClientRect() : null));
    if (flash) {
      e.classList.remove('ne-flash');
      void e.offsetWidth;
      e.classList.add('ne-flash');
      this.later(() => e.classList.remove('ne-flash'), 1000);
    }
    return true;
  }

  // ---------------------------------------------------------------- highlights (tags, wiki links, find)

  setRanges(name, id, ranges, priority = 0) {
    if (!HL_OK) return;
    const h = hlObject(name, priority);
    let m = this.hlRanges.get(name);
    if (!m) this.hlRanges.set(name, (m = new Map()));
    for (const r of m.get(id) || []) h.delete(r);
    if (ranges && ranges.length) {
      for (const r of ranges) h.add(r);
      m.set(id, ranges);
    } else m.delete(id);
  }

  clearRanges(name) {
    const m = this.hlRanges.get(name);
    if (!m || !HL_OK) return;
    const h = hlObject(name);
    for (const rs of m.values()) for (const r of rs) h.delete(r);
    m.clear();
  }

  refreshHighlights(which, { prune = false } = {}) {
    if (!HL_OK) return;
    const ids = which === 'all' ? this.doc.map((b) => b.id) : [...which];
    if (prune || which === 'all') {
      // Drop ranges of blocks that no longer exist.
      for (const name of ['ne-tag', 'ne-wiki']) {
        const m = this.hlRanges.get(name);
        if (m) for (const id of [...m.keys()]) if (idx(this.doc, id) < 0) this.setRanges(name, id, null);
      }
    }
    for (const id of ids) {
      const b = this.block(id);
      const e = this.els.get(id);
      if (!b || !e || !isText(b) || b.t === 'code') {
        this.setRanges('ne-tag', id, null);
        this.setRanges('ne-wiki', id, null);
        continue;
      }
      const m = maskedText(b.c);
      const tags = [];
      for (const sp of tagSpans(m)) {
        const r = rangeIn(e, sp.start, sp.end);
        if (r) tags.push(r);
      }
      const wikis = [];
      if (m.includes('[[')) {
        WIKI_RE.lastIndex = 0;
        let x;
        while ((x = WIKI_RE.exec(m))) {
          const r = rangeIn(e, x.index, x.index + x[0].length);
          if (r) wikis.push(r);
        }
      }
      this.setRanges('ne-tag', id, tags);
      this.setRanges('ne-wiki', id, wikis);
    }
    if (this.findState) this.paintFind();
  }

  find(query) {
    this.clearFind();
    const q = fold(String(query || '').trim()).out;
    if (!q) return 0;
    const matches = [];
    for (const b of this.doc) {
      if (!isText(b)) continue;
      const text = blockText(b);
      const f = fold(text);
      let i = f.out.indexOf(q);
      while (i >= 0 && matches.length < 5000) {
        matches.push({ id: b.id, from: f.map[i], to: f.map[i + q.length] ?? text.length });
        i = f.out.indexOf(q, i + Math.max(1, q.length));
      }
    }
    this.findState = { query, matches, index: -1 };
    this.paintFind();
    return matches.length;
  }

  paintFind() {
    const f = this.findState;
    if (!f) return;
    this.clearRanges('ne-find');
    this.clearRanges('ne-find-cur');
    const byBlock = new Map();
    f.matches.forEach((m, k) => {
      const e = this.els.get(m.id);
      const r = e && rangeIn(e, m.from, m.to);
      if (!r) return;
      if (k === f.index) this.setRanges('ne-find-cur', m.id, [r], 2);
      else {
        if (!byBlock.has(m.id)) byBlock.set(m.id, []);
        byBlock.get(m.id).push(r);
      }
    });
    for (const [id, rs] of byBlock) this.setRanges('ne-find', id, rs, 1);
  }

  findNext(dir = 1) {
    const f = this.findState;
    if (!f || !f.matches.length) return { index: 0, count: 0 };
    const n = f.matches.length;
    f.index = (f.index + (dir < 0 ? -1 : 1) + n) % n;
    this.paintFind();
    const m = f.matches[f.index];
    const e = this.els.get(m.id);
    const r = e && rangeIn(e, m.from, m.to);
    if (r) {
      this.scrollTarget(
        () => {
          const be = this.els.get(m.id);
          const rr = be && be.isConnected ? rangeIn(be, m.from, m.to) : null;
          return rr ? rr.getBoundingClientRect() : null;
        },
        { ifHidden: true },
      );
      if (!HL_OK) {
        this.sel = { a: { id: m.id, off: m.from }, f: { id: m.id, off: m.to } };
        this.setDomSel(this.sel);
      }
    }
    if (f.index === 0 && dir > 0 && e && !reduceMotion()) {
      e.classList.remove('ne-findpulse');
      void e.offsetWidth;
      e.classList.add('ne-findpulse');
      this.later(() => e.classList.remove('ne-findpulse'), 700);
    }
    return { index: f.index + 1, count: n };
  }

  clearFind() {
    this.findState = null;
    this.clearRanges('ne-find');
    this.clearRanges('ne-find-cur');
  }

  // ---------------------------------------------------------------- clipboard

  onPaste(e) {
    e.preventDefault();
    if (this.readOnly) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    const hasFiles = (dt.files && dt.files.length > 0) || [...(dt.items || [])].some((i) => i.kind === 'file');
    if (hasFiles && !html && !text) {
      toast('Images and files aren’t supported yet');
      return;
    }
    this.pasteData({ html, text, plain: this.forcePlain }, this.currentSel());
    this.forcePlain = false;
  }

  pasteData({ html = '', text = '', plain = false }, sel) {
    const b = this.block(sel.f.id);
    if (!b || !isText(b)) return;
    if (html.length > MAX_PASTE || text.length > MAX_PASTE) toast('That paste was very large, so only the first part was added.', { duration: 5000 });
    const t = text.trim();
    const oneUrl = t && !/\s/.test(t) ? safeHref(t) : null;
    // Selected text + one safe URL on the clipboard → the selection becomes a link.
    if (oneUrl && !isCollapsed(sel) && sel.a.id === sel.f.id && b.t !== 'code') return void this.apply(C.setLink(this.doc, sel, oneUrl), 'format');
    // A bare URL at a collapsed caret → a link whose text is the URL (nothing is fetched).
    if (oneUrl && isCollapsed(sel) && b.t !== 'code' && /^(https?:|mailto:)/i.test(t) && (!html || !/<(p|div|li|h\d|table|ul|ol|br)\b/i.test(html))) {
      return void this.apply(C.insertRuns(this.doc, sel, [mkRun(t, '', { href: oneUrl })]), 'structure');
    }
    let frag = null;
    if (html && !plain && b.t !== 'code') {
      try {
        frag = htmlToBlocks(html, { refOk: (ref) => this.refOk(ref), hl: lastHl() });
      } catch {
        frag = null;
      }
    }
    if (!frag || !frag.length || (frag.length === 1 && !blockLen(frag[0]) && t)) frag = this.plainBlocks(text, b);
    if (!frag.length) return;
    if (frag.length >= 5000) toast('Only the first 5,000 lines were pasted.', { duration: 5000 });
    this.apply(C.insertFragment(this.doc, sel, frag, { emptyType: newStyle() }), 'structure', { what: 'paste' });
    this.scrollCaretSoon();
  }

  plainBlocks(text, b) {
    if (!text) return [];
    if (b.t === 'code') return [{ id: 'x', t: 'code', c: [[text.replace(/\r\n?/g, '\n')]] }];
    // Into a list or checklist item every line becomes an item of that type (markers stripped).
    if (LIST.has(b.t)) return textToBlocks(text, { type: b.t, indent: b.in || 0 });
    if (mdOn() && looksLikeMarkdown(text)) {
      try {
        const opts = {
          hl: lastHl(),
          noteTitle: (id) => {
            try {
              return this.opts.refLookup?.(`note:${id}`)?.title || null;
            } catch {
              return null;
            }
          },
        };
        const md = coreMd ? normDoc(coreMd.markdownToBlocks(text.slice(0, MAX_PASTE), opts)) : markdownLite(text);
        if (md.length) return md;
      } catch {
        /* fall back to lines */
      }
    }
    return textToBlocks(text);
  }

  refOk(ref) {
    try {
      if (refKind(ref) === 'task' && this.opts.taskLookup) return !!this.opts.taskLookup(refId(ref));
      if (this.opts.refLookup) {
        const r = this.opts.refLookup(ref);
        return r ? !r.missing : true;
      }
    } catch {
      return false;
    }
    return true;
  }

  /** Blocks covered by a selection (partial first / last blocks are sliced). */
  sliceDoc(sel) {
    const { s, e } = orderSel(this.doc, sel);
    const out = [];
    for (let i = s.i; i <= e.i; i++) {
      const b = this.doc[i];
      if (!isText(b)) {
        out.push(b);
        continue;
      }
      const from = i === s.i ? s.off : 0;
      const to = i === e.i ? e.off : blockLen(b);
      const code = blockText(b).slice(from, to);
      const c = b.t === 'code' ? (code ? [[code]] : []) : sliceRunsSafe(b.c, from, to);
      out.push({ ...b, c });
    }
    return out;
  }

  toMarkdown(blocks) {
    let md = null;
    try {
      if (coreMd) md = coreMd.blocksToMarkdown(blocks);
    } catch {
      md = null;
    }
    if (typeof md !== 'string') md = markdownLiteOut(blocks);
    return md.replace(/\n$/, '');
  }

  /**
   * text/plain for a copy. Plain words stay plain (a terminal, an email or a chat gets exactly what was
   * selected): code, unformatted text in one block, or unformatted Body lines. Formatting, chips, links
   * and structure (headings, lists, quotes, dividers) go out as Markdown. text/html always carries the
   * full model for pasting back into ecosys.
   */
  copyText(frag) {
    const plainRuns = (b) => !b.c || b.c.every((r) => !r[1] && !r[2]);
    const single = frag.length === 1 && isText(frag[0]);
    if (frag.every((b) => b.t === 'code') || (single && plainRuns(frag[0])) || frag.every((b) => b.t === 'p' && plainRuns(b))) return blocksToText(frag);
    // A selection inside one block copies as inline Markdown (no "# " or "- " prefix).
    return this.toMarkdown(single && frag[0].t !== 'code' ? [{ id: frag[0].id, t: 'p', c: frag[0].c }] : frag);
  }

  onCopy(e, cut) {
    const sel = this.readSel() || this.sel;
    if (!sel || isCollapsed(sel)) return;
    e.preventDefault();
    let frag = this.sliceDoc(sel);
    // A triple-click (or a drag) often ends at the very start of the next block, or begins at the very end
    // of one: nothing of that block is selected, so it adds no empty line or bare "# " / "- " marker.
    const { s, e: en } = orderSel(this.doc, sel);
    if (frag.length > 1 && isText(this.doc[en.i]) && en.off === 0) frag = frag.slice(0, -1);
    if (frag.length > 1 && isText(this.doc[s.i]) && s.off > 0 && s.off === blockLen(this.doc[s.i])) frag = frag.slice(1);
    try {
      e.clipboardData.setData('text/plain', this.copyText(frag));
      e.clipboardData.setData('text/html', blocksToHtml(frag));
    } catch {
      /* clipboard unavailable */
    }
    if (cut && !this.readOnly) this.apply(C.deleteRange(this.doc, sel, { emptyType: newStyle() }), 'structure', { what: 'cut' });
  }

  onDragOver(e) {
    if (this.readOnly) return;
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('Files') || types.includes('text/plain') || types.includes('text/html')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  onDrop(e) {
    e.preventDefault();
    if (this.readOnly) return;
    const dt = e.dataTransfer;
    const html = dt?.getData('text/html') || '';
    const text = dt?.getData('text/plain') || '';
    if (dt?.files?.length && !html && !text) {
      toast('Images and files aren’t supported yet');
      return;
    }
    const p = caretFromPoint(document, e.clientX, e.clientY);
    let sel = this.currentSel();
    if (p) {
      const m = pointToModel(this.docEl, p.node, p.offset, (id) => this.block(id));
      if (m) sel = this.normalizeHr({ a: m, f: m });
    }
    this.focusEditor(sel);
    this.pasteData({ html, text }, sel);
  }

  // ---------------------------------------------------------------- history

  undo() {
    this.closeTrigger();
    // The redo entry keeps the undone change's name, so Redo can say it too.
    const top = this.history.top();
    const cur = { doc: this.doc, sel: this.sel, what: top?.what || '' };
    const prev = this.history.undo(cur);
    if (!prev) return false;
    const auto = prev.auto;
    this.restore(prev);
    if (auto === 'line' && this.sel) this.morph('p', this.sel.f.id, '', 0, null);
    this.emitChange('structure');
    this.announce(auto === 'line' && prev.autoText ? `Restored ${prev.autoText}` : `Undo${prev.what ? ` ${prev.what}` : ''}`);
    return true;
  }

  redo() {
    this.closeTrigger();
    const top = this.history.redoStack[this.history.redoStack.length - 1];
    const next = this.history.redo({ doc: this.doc, sel: this.sel, what: top?.what || '' });
    if (!next) return false;
    this.restore(next);
    this.emitChange('structure');
    this.announce(`Redo${next.what ? ` ${next.what}` : ''}`);
    return true;
  }

  restore(state) {
    for (const t of this.sortTimers.values()) clearTimeout(t);
    this.sortTimers.clear();
    this.deferredSorts.clear();
    this.doc = state.doc;
    this.sel = state.sel ? clampSel(this.doc, state.sel) : null;
    this.pending = null;
    this.lastAuto = null;
    this.patch();
    if (document.activeElement === this.docEl && this.sel) this.setDomSel(this.sel);
  }

  // ---------------------------------------------------------------- public API

  /**
   * Show blocks that changed outside the editor (a save's canonical copy, sync, an AI, a restore).
   * keepSelection (default true) · noteId: a different note (switches the undo history) · record: false
   * for no undo step · force: apply even when it equals a doc this editor emitted moments ago.
   */
  setBlocks(blocks, { keepSelection = true, noteId, record, force = false } = {}) {
    if (this.dead) return;
    if (this.composing) {
      this.pendingSet = [blocks, { keepSelection, noteId, record, force }];
      return;
    }
    const next = normDoc(blocks, { emptyType: newStyle() });
    // Only an explicit noteId switches notes. Every block id new without one (an AI rewriting the whole
    // note as Markdown) is still this note: one undo step, same per-note history.
    const switching = noteId !== undefined && (noteId || null) !== this.noteId;
    if (!switching) {
      if (docsEqual(next, this.doc)) {
        this.emitted.length = 0; // the store has caught up: nothing older can be a pending echo
        return;
      }
      // A late echo of what this editor emitted moments ago (a save / sync round trip) must never roll
      // back newer typing: keep ours and say so, so the store converges on what is on screen. Anything
      // older is a deliberate revert (AI Undo, version Restore, Undo of a restore) and is shown.
      const now = performance.now();
      if (!force && this.emitted.some((x) => x.doc !== this.doc && now - x.at < ECHO_MS && docsEqual(x.doc, next))) {
        // After the caller is done with this call (it may still be noting what it sent us).
        if (!this.keptEcho) {
          this.keptEcho = true;
          const kept = this.doc;
          this.later(() => {
            this.keptEcho = false;
            if (!this.dead && this.doc === kept) this.emitChange('type');
          }, 0);
        }
        return;
      }
    }
    const before = { doc: this.doc, sel: this.sel };
    // An open picker ("/", "[[", "@", "#") survives a change made elsewhere in the note (a save's refreshed
    // chip labels, sync, an AI): it moves with its text below (rebaseTrigger), or closes when that is gone.
    const keepTrigger = !switching && !!this.trigger;
    if (!keepTrigger) this.closeTrigger();
    if (switching) this.closeNotePicker();
    for (const t of this.sortTimers.values()) clearTimeout(t);
    this.sortTimers.clear();
    this.deferredSorts.clear();
    // Refreshed chip labels alone (the save step updates cached titles) are not an undo step.
    if (!switching && record !== false && !onlyLabelsDiffer(this.doc, next)) this.history.record(before, { kind: 'structure' });
    const oldDoc = this.doc;
    this.doc = next;
    this.emitted.length = 0; // the store moved past every earlier emission: none can be an echo now
    this.pending = null;
    this.lastAuto = null;
    if (switching) {
      this.noteId = noteId || null;
      this.history = this.adoptHistory(this.noteId);
      this.renderAll();
      this.refreshHighlights('all');
    } else {
      this.history.lastDoc = this.doc;
      this.patch();
    }
    let sel = null;
    if (keepSelection && !switching && this.sel) {
      const rebase = (p) => {
        const ob = oldDoc[idx(oldDoc, p.id)];
        const nb = this.block(p.id);
        if (ob && nb && isText(nb)) return { id: p.id, off: rebaseOff(blockText(ob), blockText(nb), p.off) };
        return null;
      };
      const a = rebase(this.sel.a);
      const f = rebase(this.sel.f);
      sel = a && f ? { a, f } : clampSel(this.doc, null, idx(oldDoc, this.sel.f.id));
    }
    this.sel = sel ? clampSel(this.doc, sel) : null;
    if (this.sel && document.activeElement === this.docEl) this.setDomSel(this.sel);
    if (keepTrigger) this.rebaseTrigger(oldDoc);
    if (this.findState) this.find(this.findState.query);
    this.refreshUI();
  }

  /** After an outside change: an open picker follows its trigger text, or closes when that text is gone. */
  rebaseTrigger(oldDoc) {
    const t = this.trigger;
    if (!t || t.kind === 'insert') return;
    const ob = oldDoc[idx(oldDoc, t.id)];
    const nb = this.block(t.id);
    if (!ob || !nb || !isText(nb)) return this.closeTrigger();
    t.off = rebaseOff(blockText(ob), blockText(nb), t.off);
    this.updateTriggers(null); // checks the trigger text and the caret, then refreshes or closes the list
  }

  setReadOnly(v) {
    this.readOnly = !!v;
    this.docEl.contentEditable = this.readOnly ? 'false' : 'true';
    this.docEl.toggleAttribute('aria-readonly', this.readOnly);
    if (this.readOnly) {
      this.hideToolbar();
      this.panel.close();
      this.closeTrigger();
    }
    this.renderAll();
    this.refreshHighlights('all');
    this.updateAccessory();
  }

  focus(where = 'end') {
    let sel;
    if (where && typeof where === 'object' && where.blockId) {
      const i = idx(this.doc, where.blockId);
      sel = i >= 0 ? clampSel(this.doc, caret(where.blockId, Math.max(0, +where.offset || 0))) : null;
    }
    if (!sel && where === 'start') {
      const i = isText(this.doc[0]) ? 0 : nextText(this.doc, 0) ?? 0;
      sel = caret(this.doc[i].id, 0);
    }
    if (!sel) {
      const i = prevText(this.doc, this.doc.length) ?? 0;
      sel = caret(this.doc[i].id, blockLen(this.doc[i]));
    }
    this.focusEditor(sel);
    const id = sel.f.id;
    const off = sel.f.off;
    const at = () => {
      const e = this.els.get(id);
      return e && e.isConnected ? caretRect(e, off) : null;
    };
    const r = at();
    const sc = this.scroller();
    const isDoc = sc === document.scrollingElement || sc === document.documentElement;
    const top = isDoc ? 0 : sc.getBoundingClientRect().top;
    const h = isDoc ? innerHeight : sc.clientHeight;
    if (r && (r.top < top || r.bottom > top + h)) this.scrollTarget(at, { smooth: false });
  }

  destroy() {
    if (this.dead) return;
    this.dead = true; // late async work (a picked link, a created note, a scroll settle) stops here
    this.history.lastDoc = this.doc; // what the note looked like when undo last applied to it
    this.closeNotePicker(false);
    for (const f of this.cleanup.splice(0)) f();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const t of this.sortTimers.values()) clearTimeout(t);
    if (this.selRaf) cancelAnimationFrame(this.selRaf);
    if (this.selEmitRaf) cancelAnimationFrame(this.selEmitRaf);
    this.mo.disconnect();
    for (const name of [...this.hlRanges.keys()]) this.clearRanges(name);
    this.pop.close();
    this.toolbar.hide();
    this.panel.close();
    if (this.acc.visible) {
      // The page hears that the bar is gone only from updateAccessory, whose blur timer was just cleared: tell
      // it here, or a phone shell keeps its own bottom bar hidden after leaving a note while typing. (A host
      // already taken out of the page can't bubble to it: the document hears it instead.)
      document.body.classList.remove('ne-acc-on');
      (this.host.isConnected ? this.host : document).dispatchEvent(new CustomEvent('editor:accessory', { detail: { visible: false }, bubbles: true }));
    }
    this.acc.hide();
    this.linkCard.hide();
    this.chipCard.hide();
    this.hideWikiCard();
    this.linkField?.close();
    clearTimeout(this.sayTimer);
    this.root.remove();
  }
}

/**
 * Which of a line's links to the same place (0, 1, …) the link extent `ext` is (linkExtent): with its href or
 * ref, a name for it that edits before it don't change.
 */
function linkNth(runs, ext) {
  const v = ext.href || ext.ref;
  let n = 0;
  let pos = 0;
  let prev = null;
  for (const r of runs || []) {
    if (pos >= ext.from) break;
    const k = r[2] && !r[2].atom ? r[2].href || r[2].ref || null : null;
    if (k === v && prev !== v) n++;
    prev = k;
    pos += r[0].length;
  }
  return n;
}

/** True when two docs differ only in the cached labels of chips. */
function onlyLabelsDiffer(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.t !== y.t || (x.in ?? 0) !== (y.in ?? 0) || !!x.ck !== !!y.ck || (x.task || null) !== (y.task || null)) return false;
    if (!x.c || !y.c || x.c.length !== y.c.length) return false;
    for (let k = 0; k < x.c.length; k++) {
      const r = x.c[k];
      const s = y.c[k];
      if (isAtom(r) && isAtom(s) && r[2].ref === s[2].ref) continue;
      if (r[0] !== s[0] || (r[1] || '') !== (s[1] || '') || JSON.stringify(r[2] || null) !== JSON.stringify(s[2] || null)) return false;
    }
  }
  return true;
}

/** Is a block's live DOM exactly one text node holding its single unformatted run (+ decorations)? */
function plainCanonical(e, b) {
  if (b.c.length !== 1 || b.c[0][1] || b.c[0][2] || b.c[0][0].includes('\n')) return false;
  const tx = e._tx;
  if (!tx || tx.parentNode !== e) return false;
  let text = null;
  const isDecoEl = (n) => n && n.nodeType === 1 && n.hasAttribute('data-deco');
  for (const n of tx.childNodes) {
    if (n.nodeType === 3) {
      if (text !== null) return false;
      text = n;
    } else if (isDecoEl(n)) continue;
    // The end <br> after a task label (render.js) is the renderer's own.
    else if (!(n === tx.lastChild && n.nodeName === 'BR' && n.classList.contains('ne-end') && isDecoEl(n.previousSibling))) return false;
  }
  if (!text || text.data !== b.c[0][0]) return false;
  // Nothing outside the text container but the checkbox.
  for (const n of e.childNodes) if (n !== tx && !(n.nodeType === 1 && n.hasAttribute('data-deco'))) return false;
  return true;
}

/** sliceRuns that tolerates atoms at the edges (an atom is copied whole when it starts inside). */
function sliceRunsSafe(runs, from, to) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const len = r[0].length;
    const s = Math.max(from, pos);
    const e = Math.min(to, pos + len);
    if (e > s) out.push(isAtom(r) ? r : mkRun(r[0].slice(s - pos, e - pos), r[1], r[2]));
    pos += len;
  }
  return out;
}

/** Case- and accent-insensitive text with a map back to original offsets. */
function fold(text) {
  let out = '';
  const map = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const f = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) {
      out += f[k];
      map.push(i);
    }
    i += ch.length;
  }
  map.push(text.length);
  return { out, map };
}

// ------------------------------------------------------------------ entry point

/** Pages normally link editor.css in <head>; if one doesn't, add it (CSP allows same-origin styles). */
function ensureStyles() {
  const href = new URL('./editor.css', import.meta.url).href;
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) if (l.href === href) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

/**
 * Create a notes editor inside `host`.
 * opts: { blocks, placeholder?, readOnly?, onChange(blocks, {kind}), onSelectionChange?, linkProvider?(query),
 *         onLinkActivate?(ref, ev), tagProvider?(prefix), onCheckToggle?(blockId, checked), onSendToTasks?(blockIds),
 *         taskLookup?(taskId),
 *         extra: noteId?, label?, refLookup?(ref) → {title, sub, color, missing, trashed}, onCreateNote?(title) →
 *         Promise<{id, title}>, onTaskToggle?(taskId), accessory?: 'auto'|true|false }
 * setBlocks(blocks, {keepSelection = true, noteId?, record?, force?}): only an explicit, different noteId
 * switches notes (undo history); a doc equal to one this editor emitted within the last 3 s is taken as a
 * late echo and kept back (the editor re-emits what it shows) unless `force` — pass force for deliberate
 * reverts (AI Undo, version Restore and its Undo) to make sure they always land.
 */
export function createEditor(host, opts = {}) {
  if (!(host instanceof Element)) throw new TypeError('createEditor: host must be an element');
  ensureStyles();
  const ed = new NotesEditor(host, opts);
  return {
    setBlocks: (blocks, o) => ed.setBlocks(blocks, o),
    getBlocks: () => ed.doc.slice(),
    focus: (where) => ed.focus(where),
    exec: (cmd, arg) => ed.exec(cmd, arg),
    state: () => {
      const s = ed.state();
      return { blockType: s.blockType, marks: s.marks, hl: s.hl, canUndo: s.canUndo, canRedo: s.canRedo, href: s.href, collapsed: s.collapsed, inList: s.inList, indent: s.indent };
    },
    undo: () => ed.undo(),
    redo: () => ed.redo(),
    scrollToBlock: (id, o) => ed.scrollToBlock(id, o),
    find: (q) => ed.find(q),
    findNext: () => ed.findNext(1),
    findPrev: () => ed.findNext(-1), // extra
    clearFind: () => ed.clearFind(), // extra
    setReadOnly: (v) => ed.setReadOnly(v), // extra
    refresh: () => ed.refreshDecor(), // extra: re-render chips / task info from the lookups
    get element() {
      return ed.docEl; // extra: the contenteditable host
    },
    destroy: () => ed.destroy(),
  };
}

export { blocksToHtml, htmlToBlocks, textToBlocks, markdownLite };
