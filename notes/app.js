// notes — the ecosys notes app: Apple Notes' instant capture, title-from-first-line and checklists,
// plus what Apple and Samsung users keep asking for: backlinks, version history, nested coloured
// folders with counts that add up, a tag browser that stays put and one-click Markdown export.
// Daily notes show the day's plan, meeting notes hang off calendar events, checklist items can become
// tasks, and an AI assistant (over MCP) can read and write notes — every AI edit is labelled and undoable.
//
// Layout: ≥1100px three columns (sidebar · list · note), 700–1099px two (the sidebar is a drawer),
// <700px stacked iOS-style screens (Folders → List → Note) with push/pop transitions and bottom bars.
// Routes (hash, so GitHub Pages works and Back means "the previous note"):
//   #/all  #/day  #/today  #/day/<ymd>  #/folder/<id>  #/folder/notes  #/tag/<a+b>?mode=any  #/ai  #/trash
//   #/search?q=…&in=<folder>   + /n/<noteId> [+ /b/<blockId>]     #/n/<id> (from other apps)
//   #/new[?event=<id>&date=<ymd>]   #/quick   #/folders (phone)

// The schema goes first: it registers the notes fields with the shared validators before the store
// reads the cached notes, so blocks survive the load.
import * as schema from './core/schema.js';
import {
  initShell, esc, $, $$, icon, toast, undoable, openMenu, openPopover, openModal, confirmDialog,
  registerPaletteProvider, registerShortcuts, openShortcuts, score, sidebarHead, hasOpenLayer, closeTopLayer, isTyping, isMac,
  keys, tipAttrs, selectField, switchField, setFieldValue, attachSuggest, fmtTimeRange, fmtClock, playDing, BASE, singleKeyOff, announce, todayGlyph,
} from '../shared/shell.js';
import { hasIcon } from '../shared/icons.js';
import { db, settings } from '../shared/store.js';
import * as storeApi from '../shared/store.js';
import { todayYmd, addDays, addDaysYmd, addMonths, parseYmd, parseDT, ymd, fmt, fmtTime, dayLabel, diffDays, pad, toMinutes } from '../shared/dates.js';
import { parse as nlpParse } from '../shared/nlp.js';
import { miniCalendar, monthTitle } from '../shared/minical.js';
import { occurrencesBetween } from '../shared/recur.js';
import { COLORS, toggleTask, eventInstances, calendarMap } from '../shared/model.js';
import { cleanHref, isYmd } from '../shared/sanitize.js';
import * as core from './core/notes.js';
import { parseQuery, searchNotes, highlight } from './core/search.js';
import { blocksToMarkdown } from './core/markdown.js';
import { createEditor } from './editor/index.js';
import { tagFromInput } from './editor/model.js';
import * as ex from './export.js';
import * as hist from './history/revisions.js';

initShell({ app: 'notes' });

// ---------------------------------------------------------------- small helpers

const DAY_MS = 86400000;
const HL = ['purple', 'pink', 'orange', 'mint', 'blue'];
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
// isYmd (shared/sanitize.js): a real calendar date in 1000–9999, the dates the data validators keep.
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const reduceMotion = () => settings.get()?.reduceMotion === true || matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = () => matchMedia('(hover: none), (pointer: coarse)').matches;
const colorVar = (c) => (COLORS.includes(c) ? `var(--c-${c})` : 'var(--text-3)');
const sep = '<span class="n-sep" aria-hidden="true"></span>';
const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (err) {
    console.error('ecosys notes:', err);
    return fallback;
  }
};
/** core.saveBlocks / createNote refuse blocks that don't fit in one note (5,000 blocks, 256 KB) rather than cut them. */
const isTooLarge = (err) => err?.code === 'note_too_large';
/** safe(), except that a note_too_large refusal goes to onTooLarge(err) instead of the console. */
const tryWrite = (fn, onTooLarge, fallback = null) => {
  try {
    return fn();
  } catch (err) {
    if (isTooLarge(err)) onTooLarge?.(err);
    else console.error('ecosys notes:', err);
    return fallback;
  }
};
const tooLargeToast = (err) => toast(String(err?.message || 'This note is too long to save. Move some of it into a new note.'), { duration: 9000 });
const liveNotes = () => (db.all('notes') || []).filter((n) => n && !n.trashedAt);
const folders = () => db.all('folders') || [];
const folderById = (id) => (isId(id) ? db.get('folders', id) : null);
const noteById = (id) => (isId(id) ? safe(() => core.getNote(id), null) || db.get('notes', id) : null);
const blockText = (b) => safe(() => schema.blockText(b), '') || '';
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const nowStamp = () => Date.now();
const editedAt = (n) => n?.editedAt || n?.updatedAt || n?.createdAt || 0;
const AI_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok', other: 'AI assistant' };
function byLabel(by) {
  const s = String(by || 'user');
  if (s === 'user') return 'You';
  const m = /^mcp:([a-z]+)/.exec(s);
  return m ? AI_NAMES[m[1]] || 'AI assistant' : 'You';
}
const isAiBy = (by) => /^mcp:/.test(String(by || ''));
/** Shift with the platform modifier in each platform's own order: ⇧⌘X on a Mac, Ctrl+Shift+X elsewhere. */
const shiftMod = (key) => (isMac ? `shift mod ${key}` : `mod shift ${key}`);

/** Apple's list dates: a time today, "Yesterday", the weekday within a week, else a short date. */
function listDate(ts) {
  if (!ts) return '';
  // Rows re-render on every save: one formatting per minute shown, until the day or the clock setting changes.
  const today = todayYmd();
  if (dateMemoDay !== today || dateMemo.size > 5000) {
    dateMemo.clear();
    dateMemoDay = today;
  }
  const key = Math.floor(ts / 60000);
  let out = dateMemo.get(key);
  if (out === undefined) {
    const d = new Date(ts);
    const n = diffDays(ymd(d), today);
    if (n === 0) out = fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    else if (n === 1) out = 'Yesterday';
    else if (n > 1 && n < 7) out = fmt(d, { weekday: 'long' });
    // Older, or ahead of this device's clock (another device's time): the date.
    else out = fmt(d, { day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
    dateMemo.set(key, out);
  }
  return out;
}
const dateMemo = new Map();
let dateMemoDay = '';
/** "22 November 2026 at 14:02" (Apple's note header caption). */
function longStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${fmt(d, { day: 'numeric', month: 'long', year: 'numeric' })} at ${fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)}`;
}
const longDay = (s) => fmt(parseYmd(s), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return listDate(ts);
}

// ---------------------------------------------------------------- per-device UI state (never synced)

const UI_KEY = 'ecosys:v1:notes-ui';
function readUiRaw() {
  try {
    const v = JSON.parse(localStorage.getItem(UI_KEY) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
const ui = (() => {
  const o = readUiRaw();
  const ids = (a, max) => (Array.isArray(a) ? a.filter(isId).slice(0, max) : []);
  return {
    recent: ids(o.recent, 20),
    collapsed: ids(o.collapsed, 500),
    pinnedCollapsed: o.pinnedCollapsed === true,
    dayHeadCollapsed: o.dayHeadCollapsed === true,
    backlinksCollapsed: o.backlinksCollapsed === true,
    listW: clamp(Number(o.listW) || 320, 260, 420),
    lastQuickId: isId(o.lastQuickId) ? o.lastQuickId : null,
    lastQuickAt: Number(o.lastQuickAt) || 0,
    quickMode: o.quickMode === 'today' ? 'today' : 'new',
    lastTaskList: typeof o.lastTaskList === 'string' && (o.lastTaskList === 'inbox' || isId(o.lastTaskList)) ? o.lastTaskList : 'inbox',
    sideHidden: o.sideHidden === true,
    tagsAll: o.tagsAll === true,
    budgetAt: Number(o.budgetAt) || 0,
    searchSort: o.searchSort === 'date' ? 'date' : 'relevance',
  };
})();
function saveUi() {
  try {
    // Keep keys written by other notes modules (the editor keeps its own per-device bits here too).
    localStorage.setItem(UI_KEY, JSON.stringify({ ...readUiRaw(), ...ui }));
  } catch {
    /* private mode: per-device niceties are optional */
  }
}
function rememberRecent(id) {
  if (!isId(id)) return;
  ui.recent = [id, ...ui.recent.filter((x) => x !== id)].slice(0, 20);
  saveUi();
}

// ---------------------------------------------------------------- app-local icons (same 24-grid, 1.8 stroke)

const LOCAL_ICONS = {
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2.5 2.5 0 0 0-2.5 2.5v5.5A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V13a2.5 2.5 0 0 0-2.5-2.5h-1.5"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  rows: '<rect x="3.5" y="4" width="17" height="6" rx="2"/><rect x="3.5" y="14" width="17" height="6" rx="2"/>',
  print: '<path d="M7 8.5V3.5h10v5"/><rect x="3" y="8.5" width="18" height="8.5" rx="2.5"/><path d="M7 14h10v6.5H7z"/>',
  expand: '<path d="M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5 14 10M3.5 20.5 10 14"/>',
  shrink: '<path d="M20.5 3.5 14 10M14.5 4.5V10H20M3.5 20.5 10 14M9.5 19.5V14H4"/>',
  move: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M9.5 13.5h6M13.2 11.2l2.3 2.3-2.3 2.3"/>',
};
function lic(name, { size = 20, cls = '', stroke = 1.8 } = {}) {
  if (!Object.hasOwn(LOCAL_ICONS, name)) return icon(name, { size, cls, stroke });
  const c = String(cls).replace(/[^\w -]/g, '');
  return `<svg class="i ${c}" width="${+size || 20}" height="${+size || 20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${+stroke || 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${LOCAL_ICONS[name]}</svg>`;
}
/**
 * The suite's glyph names for what Notes shows (the logo family): each falls back to the older glyph
 * while shared/icons.js doesn't have the new one yet, so nothing ever shows the stand-in circle.
 */
const glyphName = (name, older) => (hasIcon(name) ? name : older);
const G = {
  ai: glyphName('ai', 'sparkle'), // AI edits, the AI review banner, AI versions
  aiOn: glyphName('ai', 'eye'), // Show to AI
  aiOff: glyphName('ai-off', 'eye-off'), // Hide from AI, hidden from AI
  alert: glyphName('alert', 'info'), // error banners
  quick: glyphName('quick-note', 'bolt'),
};
/** The Text styles button: the suite's text-style glyph, or "Aa" until it is there. */
const aaGlyph = (size) => (hasIcon('text-style') ? icon('text-style', { size }) : '<span aria-hidden="true">Aa</span>');
// Today's glyph is the shell's (as in Tasks and the date picker); another day's is a calendar. Decoration:
// the label beside it says which day (its number would be read out before the name).
const todayTile = (s = todayYmd(), size = 20) =>
  s === todayYmd() ? todayGlyph(size) : `<span class="today-glyph" aria-hidden="true" style="width:${size}px;height:${size}px">${icon('calendar', { size })}</span>`;

// ---------------------------------------------------------------- static rendering (gallery, history, cards)

const runText = (r) => (Array.isArray(r) && typeof r[0] === 'string' ? r[0] : '');
function runsHtml(c) {
  return (Array.isArray(c) ? c : [])
    .map((r) => {
      if (!Array.isArray(r)) return '';
      let t = esc(runText(r)).replace(/\n/g, '<br>');
      const m = typeof r[1] === 'string' ? r[1] : '';
      const a = r[2] && typeof r[2] === 'object' ? r[2] : null;
      if (a?.atom) t = `<span class="s-chip">${t}</span>`;
      if (m.includes('c')) t = `<code>${t}</code>`;
      if (m.includes('s')) t = `<s>${t}</s>`;
      if (m.includes('u')) t = `<u>${t}</u>`;
      if (m.includes('i')) t = `<i>${t}</i>`;
      if (m.includes('b')) t = `<b>${t}</b>`;
      if (a?.hl && HL.includes(a.hl)) t = `<mark class="s-hl hl-${a.hl}">${t}</mark>`;
      if (a?.href && !a.atom) t = `<span class="s-link">${t}</span>`;
      return t;
    })
    .join('');
}
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];
function numLabel(n, level) {
  const k = level % 3;
  if (k === 1) return `${String.fromCharCode(96 + (((n - 1) % 26) + 1))}.`;
  if (k === 2) return `${ROMAN[(n - 1) % ROMAN.length]}.`;
  return `${n}.`;
}
/** Read-only HTML for blocks (all text escaped; links are never live in previews). */
function staticHtml(blocks, { max = Infinity, changed = null } = {}) {
  let out = '';
  let counters = [];
  const list = Array.isArray(blocks) ? blocks.slice(0, max) : [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const ind = clamp(Number(b.in) || 0, 0, 6);
    const tint = changed?.has(b.id) ? ' s-changed' : '';
    const inner = runsHtml(b.c) || '<br>';
    if (b.t !== 'num') counters = [];
    switch (b.t) {
      case 'h1':
      case 'h2':
      case 'h3':
        out += `<div class="s-${b.t}${tint}">${inner}</div>`;
        break;
      case 'bullet':
      case 'dash':
        out += `<div class="s-li s-${b.t}${tint}" style="--in:${ind}"><span class="s-mark" aria-hidden="true"></span><span class="s-tx">${inner}</span></div>`;
        break;
      case 'num': {
        counters = counters.slice(0, ind + 1);
        const start = Number.isInteger(b.start) && b.start > 0 ? b.start : 1;
        counters[ind] = counters[ind] ? counters[ind] + 1 : start;
        out += `<div class="s-li s-num${tint}" style="--in:${ind}"><span class="s-mark tnum" aria-hidden="true">${esc(numLabel(counters[ind], ind))}</span><span class="s-tx">${inner}</span></div>`;
        break;
      }
      case 'check':
        out += `<div class="s-li s-check${b.ck ? ' done' : ''}${tint}" style="--in:${ind}"><span class="s-box" aria-hidden="true">${b.ck ? icon('check', { size: 10, stroke: 3 }) : ''}</span><span class="s-tx">${inner}</span></div>`;
        break;
      case 'quote':
        out += `<div class="s-quote${tint}">${inner}</div>`;
        break;
      case 'code':
        out += `<pre class="s-code${tint}">${esc((b.c || []).map(runText).join(''))}</pre>`;
        break;
      case 'hr':
        out += `<div class="s-hr${tint}" role="separator"></div>`;
        break;
      default:
        out += `<div class="s-p${tint}">${inner}</div>`;
    }
  }
  return out;
}

// ---------------------------------------------------------------- legacy notes (stored as HTML before blocks)

/** The note's blocks. The schema migrates stage-1 notes (HTML in `body`) on load; this covers any left. */
const legacyCache = new WeakMap();
function blocksOf(n) {
  if (Array.isArray(n?.blocks) && n.blocks.length) return n.blocks;
  if (typeof n?.body === 'string' && n.body.trim()) {
    let b = legacyCache.get(n);
    if (!b) {
      b = safe(() => schema.htmlToBlocks(n.body), []) || [];
      legacyCache.set(n, b);
    }
    return b;
  }
  return Array.isArray(n?.blocks) ? n.blocks : [];
}

/** Title, preview line, checklist progress and flags for a list row (cached per stored object). */
const metaCache = new WeakMap();
function meta(n) {
  const hit = metaCache.get(n);
  if (hit) return hit;
  const blocks = blocksOf(n);
  let title = oneLine(n.title);
  let preview = '';
  let seenTitle = false;
  let open = 0;
  let done = 0;
  for (const b of blocks) {
    const t = oneLine(blockText(b));
    // An empty item (a meeting note's template line) is nothing to do yet: it isn't counted.
    if (b?.t === 'check' && t) b.ck ? done++ : open++;
    if (!t) continue;
    if (!seenTitle) {
      seenTitle = true;
      if (!title) title = t.slice(0, 120);
      continue;
    }
    if (!preview) preview = t.slice(0, 160);
  }
  // The first line after the title (a title block can hold soft line breaks). A meeting note's template
  // headings ("Notes", "Action items") are not a preview: until something is written, the row shows
  // the meeting's time and place (rowFor).
  const own = n.event ? blocks.filter((b) => !meetingHeads().has(`${b?.t}|${oneLine(blockText(b))}`)) : blocks;
  const p = safe(() => schema.notePreview({ blocks: own }, 160), null);
  if (typeof p === 'string') preview = oneLine(p);
  else if (n.event) preview = own.slice(1).map((b) => oneLine(blockText(b))).find(Boolean)?.slice(0, 160) || '';
  const m = { title, preview, open, done };
  metaCache.set(n, m);
  return m;
}
let meetingHeadSet = null;
/** The headings a meeting note starts with ("h3|Notes", "h3|Action items"), not its title. */
function meetingHeads() {
  if (!meetingHeadSet) meetingHeadSet = new Set(meetingTemplate('').slice(1).filter((b) => oneLine(blockText(b))).map((b) => `${b.t}|${oneLine(blockText(b))}`));
  return meetingHeadSet;
}
const isHidden = (n) => !!n?.aiHidden || folderHidden(n?.folderId);
function folderHidden(id) {
  const seen = new Set();
  let f = folderById(id);
  while (f && !seen.has(f.id)) {
    if (f.aiHidden) return true;
    seen.add(f.id);
    f = folderById(f.parentId);
  }
  return false;
}
const displayTitle = (n) => meta(n).title || (n.day ? longDay(n.day) : 'New Note');

// ---------------------------------------------------------------- state

const state = {
  view: 'all', // all · today (daily notes) · folder · tag · ai · trash · search
  folderId: null, // folder view: a folder id or 'notes' (the default folder)
  tags: [],
  tagMode: 'all',
  q: '',
  scope: null, // search scope: a folder id / 'notes', or null for All Notes
  day: null, // daily view: the day whose note is open (null: list only)
  noteId: null,
  blockId: null,
  sel: new Set(), // multi-select (ids); the open note is separate
  anchor: null,
  selectMode: false, // phone "Select" mode
  info: false,
  focusMode: false,
  screen: 'list', // phone: folders · list · note
};
let searchFrom = null; // the list route a search started from (Esc / clear returns to it)
let lastHash = '';
// A link named a note this browser doesn't have yet (made by an assistant, or on another device): it
// waits for the first sync ("Loading note…") instead of opening another note. {id, blockId}
let pendingNote = null;
let routed = false; // the page's first route is done (a link opened from elsewhere is that first one)
let ctxRow = null; // the note whose row menu is open (its row is outlined: the menu acts on it, not on the open note)
const drafts = new Map(); // id → unsaved new note (nothing is stored until the first character)
const createdHere = new Set(); // notes made in this tab (one left empty is put away: see closeSession)

const mqWide = matchMedia('(min-width: 1100px)');
const mqMid = matchMedia('(min-width: 700px)');
const cols = () => (mqWide.matches ? 3 : mqMid.matches ? 2 : 1);

// ---------------------------------------------------------------- layout

$('#app').innerHTML = `
<div class="nshell no-anim" id="shell" data-cols="3" data-screen="list">
  <aside class="sidebar n-side" id="sidebar" aria-label="Folders and tags">
    ${sidebarHead('notes')}
    <div class="n-side-title" aria-hidden="true">Folders</div>
    <div class="create-wrap" id="createwrap"><button type="button" class="create-btn" data-new-note ${tipAttrs('New note', 'n')}>${icon('edit', { size: 20, stroke: 2 })}<span>New note</span></button></div>
    <nav class="side-scroll n-nav" id="nav" aria-label="Notes library"></nav>
    <div class="n-side-foot" id="sidefoot"></div>
    <div class="n-bottombar n-side-bar">
      <button type="button" class="n-barbtn" data-new-folder aria-label="New folder">${icon('folder-plus', { size: 22 })}<span>New Folder</span></button>
      <span class="grow"></span>
      <button type="button" class="icon-btn n-barcompose" data-new-note aria-label="New note">${icon('edit', { size: 22 })}</button>
    </div>
  </aside>
  <div class="n-overlay" data-close-nav></div>
  <section class="n-listcol" id="listcol" aria-label="Note list">
    <header class="n-listhead" id="listhead"></header>
    <div class="n-searchwrap" id="searchwrap">
      <div class="n-search" role="search">
        ${icon('search', { size: 16 })}
        <input type="text" id="q" class="n-q" placeholder="Search" aria-label="Search notes" autocomplete="off" spellcheck="false" enterkeyhint="search" />
        <button type="button" class="n-qclear" data-clear-search aria-label="Clear search" hidden>${icon('x', { size: 14, stroke: 2.4 })}</button>
      </div>
      <button type="button" class="icon-btn n-barcompose n-listcompose" data-new-note aria-label="New note">${icon('edit', { size: 22 })}</button>
    </div>
    <div class="n-searchopts" id="searchopts" hidden></div>
    <div class="n-list" id="list" role="listbox" aria-label="Notes" aria-multiselectable="true" tabindex="-1"></div>
    <div class="n-selbar" id="selbar" hidden></div>
  </section>
  <div class="n-resizer" id="resizer" role="separator" aria-orientation="vertical" aria-label="Resize the note list" tabindex="0"></div>
  <main class="n-notecol" id="notecol">
    <header class="n-notetop" id="notetop"></header>
    <div class="n-findbar" id="findbar" hidden></div>
    <div class="n-notescroll" id="notescroll">
      <div class="n-banners" id="banners"></div>
      <div class="n-page" id="page">
        <div class="n-caption" id="caption"></div>
        <div class="n-livehead" id="livehead"></div>
        <div class="n-editor" id="editorhost"></div>
        <div class="n-backlinks" id="backlinks"></div>
      </div>
    </div>
    <div class="n-noteempty" id="noteempty" hidden></div>
    <div class="n-bottombar n-notebar" id="notebar"></div>
    <aside class="n-info" id="info" hidden aria-label="Note info"></aside>
  </main>
</div>`;

const shellEl = $('#shell');
const navEl = $('#nav');
const sideFootEl = $('#sidefoot');
const listHeadEl = $('#listhead');
const listEl = $('#list');
const qEl = $('#q');
const searchOptsEl = $('#searchopts');
const selBarEl = $('#selbar');
const noteTopEl = $('#notetop');
const noteScrollEl = $('#notescroll');
const pageEl = $('#page');
const bannersEl = $('#banners');
const liveHeadEl = $('#livehead');
const captionEl = $('#caption');
const editorHost = $('#editorhost');
const backlinksEl = $('#backlinks');
const noteEmptyEl = $('#noteempty');
const noteBarEl = $('#notebar');
const infoEl = $('#info');
const findEl = $('#findbar');

function applyLayout() {
  const c = cols();
  shellEl.dataset.cols = String(c);
  shellEl.dataset.screen = c === 1 ? state.screen : 'all';
  // Phones make notes from the bottom bars (the Folders screen has its own compose button).
  $('#createwrap').hidden = c === 1;
  shellEl.classList.toggle('side-hidden', c === 3 && ui.sideHidden);
  shellEl.classList.toggle('focus-mode', state.focusMode && c > 1);
  shellEl.style.setProperty('--list-w-user', `${ui.listW}px`);
  const s = settings.get() || {};
  shellEl.dataset.textSize = ['s', 'm', 'l'].includes(s.notesTextSize) ? s.notesTextSize : 'm';
  // Off-screen phone screens and the closed drawer stay out of the tab order; the open drawer is
  // modal (what's under its scrim can't be reached by Tab or a screen reader).
  const drawer = c === 2 && shellEl.classList.contains('nav-open');
  const side = $('#sidebar');
  const hideSide = (c === 2 && !drawer) || (c === 1 && state.screen !== 'folders') || (c === 3 && (ui.sideHidden || state.focusMode));
  side.inert = hideSide;
  $('#listcol').inert = drawer || (c === 1 && state.screen !== 'list') || (c > 1 && state.focusMode);
  $('#notecol').inert = drawer || (c === 1 && state.screen !== 'note');
  $('#resizer').inert = drawer;
}
/** Close the folder drawer (700–1099px); focus goes back to the button that opens it. */
function closeDrawer({ focus = true } = {}) {
  if (!shellEl.classList.contains('nav-open')) return;
  shellEl.classList.remove('nav-open');
  applyLayout();
  if (focus) $('[data-toggle-nav]', listHeadEl)?.focus();
}

// ---------------------------------------------------------------- sorting, grouping & filtering

function sortCfg() {
  const s = settings.get() || {};
  let by = ['edited', 'created', 'title'].includes(s.notesSort) ? s.notesSort : 'edited';
  let dir = s.notesSortDir === 'asc' ? 'asc' : 'desc';
  let group = s.notesGroupByDate !== false;
  let view = s.notesView === 'gallery' ? 'gallery' : 'list';
  const f = state.view === 'folder' ? folderById(state.folderId) : null;
  if (f) {
    if (['edited', 'created', 'title'].includes(f.sort)) by = f.sort;
    if (f.sortDir === 'asc' || f.sortDir === 'desc') dir = f.sortDir;
    if (typeof f.groupByDate === 'boolean') group = f.groupByDate;
    if (f.view === 'list' || f.view === 'gallery') view = f.view;
  }
  if (by === 'title') group = false;
  return { by, dir, group, view, folder: f };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortKey(by) {
  if (by === 'created') return (n) => n.createdAt || 0;
  if (by === 'day') return (n) => (n.day ? parseYmd(n.day).getTime() : editedAt(n));
  if (by === 'trashed') return (n) => n.trashedAt || 0;
  if (by === 'ai') return (n) => n.aiPrev?.at || editedAt(n);
  return editedAt;
}
function sortNotes(list, by, dir) {
  if (by === 'title') {
    return list.sort((a, b) => {
      const ta = displayTitle(a);
      const tb = displayTitle(b);
      return (dir === 'desc' ? -1 : 1) * collator.compare(ta, tb) || editedAt(b) - editedAt(a);
    });
  }
  const k = sortKey(by);
  const sgn = dir === 'asc' ? 1 : -1;
  return list.sort((a, b) => sgn * (k(a) - k(b)) || editedAt(b) - editedAt(a));
}
/**
 * Apple's date groups: Today, Yesterday, Previous 7 Days, Previous 30 Days, months this year, then years.
 * Daily notes for days still to come (`ahead`) group as Upcoming; edit times from a clock that runs
 * ahead stay in Today.
 */
function groupLabel(ts, { ahead = false, today = todayYmd() } = {}) {
  if (!ts) return 'Earlier';
  const d = new Date(ts);
  const n = diffDays(ymd(d), today);
  if (n < 0) return ahead ? 'Upcoming' : 'Today';
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n <= 7) return 'Previous 7 Days';
  if (n <= 30) return 'Previous 30 Days';
  if (d.getFullYear() === new Date().getFullYear()) return fmt(d, { month: 'long' });
  return String(d.getFullYear());
}

/** A folder and all its subfolders. */
function folderSubtree(id) {
  const out = new Set();
  if (!isId(id)) return out;
  const kids = new Map();
  for (const f of folders()) {
    if (!kids.has(f.parentId)) kids.set(f.parentId, []);
    kids.get(f.parentId).push(f.id);
  }
  const stack = [id];
  while (stack.length && out.size < 5000) {
    const x = stack.pop();
    if (out.has(x)) continue;
    out.add(x);
    stack.push(...(kids.get(x) || []));
  }
  return out;
}
/** A note's effective folder: null (Notes) when its folder no longer exists. */
const noteFolder = (n) => (n.folderId && folderById(n.folderId) ? n.folderId : null);
const inNotesFolder = (n) => !noteFolder(n) && !n.day;
const normTag = (t) => String(t ?? '').trim().replace(/^#/, '').toLowerCase().slice(0, 64);
function hasTag(n, tag) {
  const tags = Array.isArray(n.tags) ? n.tags : [];
  return tags.some((t) => {
    const x = String(t).toLowerCase();
    return x === tag || x.startsWith(`${tag}/`);
  });
}

/** The notes of the current (non-search) view, unsorted. */
function viewNotes(v = state) {
  const all = db.all('notes') || [];
  switch (v.view) {
    case 'trash':
      return all.filter((n) => n && n.trashedAt);
    case 'today':
      return all.filter((n) => n && !n.trashedAt && n.day);
    case 'ai':
      return all.filter((n) => n && !n.trashedAt && n.aiPrev);
    case 'folder': {
      if (v.folderId === 'notes') return all.filter((n) => n && !n.trashedAt && inNotesFolder(n));
      const sub = folderSubtree(v.folderId);
      return all.filter((n) => n && !n.trashedAt && sub.has(n.folderId));
    }
    case 'tag': {
      const tags = v.tags || [];
      if (!tags.length) return [];
      return all.filter((n) => n && !n.trashedAt && (v.tagMode === 'any' ? tags.some((t) => hasTag(n, t)) : tags.every((t) => hasTag(n, t))));
    }
    default:
      return all.filter((n) => n && !n.trashedAt);
  }
}

function counts() {
  const c = { all: 0, notes: 0, ai: 0, trash: 0, daily: 0 };
  for (const n of db.all('notes') || []) {
    if (!n) continue;
    if (n.trashedAt) {
      c.trash++;
      continue;
    }
    c.all++;
    if (n.aiPrev) c.ai++;
    if (n.day) c.daily++;
    if (inNotesFolder(n)) c.notes++;
  }
  return c;
}

/** Folder rows: [{folder, depth, count}] (counts include subfolders), via core when it provides them. */
function tree() {
  const t = safe(() => core.folderTree(), null);
  if (Array.isArray(t) && t.every((x) => x && x.folder)) return t;
  // Fallback: build it here (depth-first, by order).
  const kids = new Map();
  for (const f of folders()) {
    const p = f.parentId && folderById(f.parentId) ? f.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f);
  }
  for (const k of kids.values()) k.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || collator.compare(a.name, b.name));
  const own = new Map();
  for (const n of liveNotes()) if (noteFolder(n)) own.set(n.folderId, (own.get(n.folderId) || 0) + 1);
  const out = [];
  const visit = (f, depth, seen) => {
    if (seen.has(f.id) || depth > 6) return 0;
    seen.add(f.id);
    const row = { folder: f, depth, count: own.get(f.id) || 0 };
    out.push(row);
    for (const k of kids.get(f.id) || []) row.count += visit(k, depth + 1, seen);
    return row.count;
  };
  const seen = new Set();
  for (const f of kids.get(null) || []) visit(f, 0, seen);
  return out;
}

function tagCounts() {
  const t = safe(() => core.allTagCounts(), null);
  if (Array.isArray(t)) return t.filter((x) => x && typeof x.tag === 'string');
  const m = new Map();
  for (const n of liveNotes()) for (const g of n.tags || []) m.set(g, (m.get(g) || 0) + 1);
  return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag));
}

function viewTitle(v = state) {
  switch (v.view) {
    case 'today':
      return 'Daily Notes';
    case 'ai':
      return 'Recent AI Edits';
    case 'trash':
      return 'Recently Deleted';
    case 'folder':
      return v.folderId === 'notes' ? 'Notes' : folderById(v.folderId)?.name || 'Folder';
    case 'tag': {
      // Tags show with the casing they were first written in.
      const labels = new Map(tagCounts().map((t) => [String(t.tag).toLowerCase(), t.label || t.tag]));
      return v.tags.map((t) => labels.get(t) || t).join(v.tagMode === 'any' ? ' or ' : ' and ') || 'Tags';
    }
    case 'search':
      return 'Search';
    default:
      return 'All Notes';
  }
}

// ---------------------------------------------------------------- routes

/** Parse location.hash into a route object. Anything malformed falls back to All Notes. */
function parseHash(hash = location.hash) {
  let h = String(hash || '').replace(/^#\/?/, '');
  let query = '';
  const qi = h.indexOf('?');
  if (qi >= 0) {
    query = h.slice(qi + 1);
    h = h.slice(0, qi);
  }
  const raw = h.split('/').filter(Boolean);
  const seg = raw.map(safeDecode);
  let params;
  try {
    params = new URLSearchParams(query);
  } catch {
    params = new URLSearchParams();
  }
  const r = { view: 'all', folderId: null, tags: [], tagMode: 'all', q: '', scope: null, day: null, noteId: null, blockId: null, special: null, event: null, date: null };
  if (seg.some((s) => s === null)) return r;
  let i = 1;
  switch (seg[0]) {
    case undefined:
      r.special = 'root';
      break;
    case 'all':
      break;
    case 'folders':
      r.special = 'folders';
      break;
    case 'today':
      r.view = 'today';
      r.day = todayYmd();
      break;
    case 'day':
      r.view = 'today';
      if (isYmd(seg[1])) {
        r.day = seg[1];
        i = 2;
      }
      break;
    case 'folder':
      r.view = 'folder';
      r.folderId = seg[1] === 'notes' ? 'notes' : isId(seg[1]) ? seg[1] : null;
      if (!r.folderId) r.view = 'all';
      i = 2;
      break;
    case 'tag':
      r.view = 'tag';
      r.tags = [...new Set(String(seg[1] || '').split('+').map(normTag).filter(Boolean))].slice(0, 12);
      r.tagMode = params.get('mode') === 'any' ? 'any' : 'all';
      if (!r.tags.length) r.view = 'all';
      i = 2;
      break;
    case 'ai':
      r.view = 'ai';
      break;
    case 'trash':
      r.view = 'trash';
      break;
    case 'search': {
      r.view = 'search';
      r.q = String(params.get('q') || '').slice(0, 500);
      const scope = params.get('in');
      r.scope = scope === 'notes' || isId(scope) ? scope : null;
      break;
    }
    case 'n':
    case 'note':
      i = 0;
      break;
    case 'new':
      r.special = 'new';
      r.event = isId(params.get('event')) ? params.get('event') : null;
      r.date = isYmd(params.get('date')) ? params.get('date') : null;
      r.folderId = isId(params.get('folder')) ? params.get('folder') : null;
      break;
    case 'quick':
      r.special = 'quick';
      break;
    default:
      break;
  }
  for (; i < seg.length; i++) {
    if ((seg[i] === 'n' || seg[i] === 'note') && isId(seg[i + 1])) r.noteId = seg[++i];
    else if (seg[i] === 'b' && isId(seg[i + 1])) r.blockId = seg[++i];
  }
  return r;
}

/** The list part of a route, as a hash. */
function listHash(v = state) {
  switch (v.view) {
    case 'today':
      return '#/day';
    case 'folder':
      return `#/folder/${encodeURIComponent(v.folderId)}`;
    case 'tag':
      return `#/tag/${encodeURIComponent(v.tags.join('+'))}${v.tags.length > 1 && v.tagMode === 'any' ? '?mode=any' : ''}`;
    case 'ai':
      return '#/ai';
    case 'trash':
      return '#/trash';
    case 'search':
      return `#/search?q=${encodeURIComponent(v.q)}${v.scope ? `&in=${encodeURIComponent(v.scope)}` : ''}`;
    default:
      return '#/all';
  }
}
/** A note inside the current list context (daily notes in the Today view use #/day/<date>). */
function noteHash(id, { blockId = null, v = state } = {}) {
  const n = noteById(id) || drafts.get(id);
  if (v.view === 'today' && n?.day) return `#/day/${n.day}${blockId ? `/b/${encodeURIComponent(blockId)}` : ''}`;
  const [p, q] = listHash(v).split('?');
  return `${p}/n/${encodeURIComponent(id)}${blockId ? `/b/${encodeURIComponent(blockId)}` : ''}${q ? `?${q}` : ''}`;
}

/** Navigate (pushes a history entry unless `replace`). Always re-routes, even to the same hash. */
function nav(hash, { replace = false } = {}) {
  const h = hash.startsWith('#') ? hash : `#${hash}`;
  const st = { parent: replace ? history.state?.parent ?? null : location.hash || null };
  try {
    if (replace) history.replaceState(st, '', h);
    else if (location.hash !== h) history.pushState(st, '', h);
  } catch {
    location.hash = h;
    return;
  }
  route();
}
/** Back to the list on phones (a real Back when we came from it, so the history stays tidy). */
function backToList() {
  const target = listHash();
  if (history.state?.parent && history.state.parent === target) history.back();
  else nav(target);
}

// ---------------------------------------------------------------- sidebar

let lastNavHtml = '';
function renderSidebar() {
  const c = counts();
  const rows = tree();
  const cur = state.view;
  const drag = coarse() ? 'false' : 'true';
  // The name sits in its own span so a long one ends in "…" (the label is a flex row for the subtitle).
  const navItem = ({ key, href, glyph, label, count = '', sub = '', drop = '', current = false, cls = '' }) =>
    `<a class="nav-item n-item${cls ? ` ${cls}` : ''}" href="${esc(href)}" data-key="${esc(key)}"${drop ? ` data-drop="${esc(drop)}"` : ''} aria-current="${current}">
      ${glyph}<span class="label"><span class="truncate">${esc(label)}</span>${sub ? `<span class="n-item-sub">${esc(sub)}</span>` : ''}</span>${count !== '' ? `<span class="badge tnum" data-count>${esc(count)}</span>` : ''}</a>`;
  const kids = new Set(rows.filter((r) => r.folder.parentId).map((r) => r.folder.parentId));
  const collapsed = new Set(ui.collapsed);
  let html = `<div class="n-sec" role="group" aria-label="Library">
    ${navItem({ key: 'all', href: '#/all', glyph: icon('note'), label: 'All Notes', count: c.all, current: cur === 'all' })}
    ${navItem({ key: 'today', href: '#/today', glyph: todayTile(), label: 'Today', sub: fmt(new Date(), { weekday: 'short', day: 'numeric', month: 'short' }), current: cur === 'today' })}
    ${c.ai ? navItem({ key: 'ai', href: '#/ai', glyph: icon(G.ai), label: 'Recent AI edits', count: c.ai, current: cur === 'ai', cls: 'n-ai-item' }) : ''}
  </div>
  <div class="side-section n-folders" role="group" aria-labelledby="n-folders-label">
    <div class="side-label" data-drop="root"><span id="n-folders-label">Folders</span><button type="button" class="icon-btn sm" data-new-folder aria-label="New folder" ${tipAttrs('New folder')}>${icon('plus', { size: 16 })}</button></div>
    ${navItem({ key: 'folder:notes', href: '#/folder/notes', glyph: `<span class="n-fdot" style="--fc:var(--text-3)">${icon('folder', { size: 19 })}</span>`, label: 'Notes', count: c.notes, drop: 'notes', current: cur === 'folder' && state.folderId === 'notes' })}`;
  for (const r of rows) {
    const f = r.folder;
    // Hide rows under a collapsed folder.
    let p = f.parentId;
    let hidden = false;
    const seen = new Set();
    while (p && !seen.has(p)) {
      seen.add(p);
      if (collapsed.has(p)) {
        hidden = true;
        break;
      }
      p = folderById(p)?.parentId;
    }
    if (hidden) continue;
    const has = kids.has(f.id);
    const open = !collapsed.has(f.id);
    html += `<div class="n-frow" data-folder-row="${esc(f.id)}" style="--depth:${clamp(r.depth, 0, 6)}">
      ${has ? `<button type="button" class="n-disclose" data-disclose="${esc(f.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} subfolders of ${esc(f.name)}">${icon('chevron-right', { size: 14, stroke: 2.2 })}</button>` : '<span class="n-disclose-pad"></span>'}
      <a class="nav-item n-item n-folder" href="#/folder/${esc(encodeURIComponent(f.id))}" data-key="folder:${esc(f.id)}" data-folder="${esc(f.id)}" data-drop="${esc(f.id)}" draggable="${drag}" aria-current="${cur === 'folder' && state.folderId === f.id}">
        <span class="n-fdot" style="--fc:${colorVar(f.color)}">${icon('folder', { size: 19 })}</span><span class="label"><span class="truncate">${esc(f.name)}</span></span>${f.aiHidden ? `<span class="n-eye" role="img" aria-label="Hidden from AI" ${tipAttrs('Hidden from AI')}>${icon(G.aiOff, { size: 14 })}</span>` : ''}<span class="badge tnum" data-count>${esc(r.count)}</span>
      </a>
    </div>`;
  }
  html += '</div>';
  const tags = tagCounts();
  if (tags.length) {
    const shown = ui.tagsAll ? tags : tags.slice(0, 30);
    const sel = new Set(state.view === 'tag' ? state.tags : []);
    html += `<div class="side-section n-tagsec" role="group" aria-labelledby="n-tags-label">
      <div class="side-label"><span id="n-tags-label">Tags</span></div>
      <div class="n-tagcloud">${shown
        .map((t) => `<a class="n-tag" href="#/tag/${esc(encodeURIComponent(t.tag))}" data-tag="${esc(t.tag)}" aria-current="${sel.has(String(t.tag).toLowerCase())}" ${tipAttrs(`${plural(t.count, 'note')}`)}>${esc(t.label || t.tag)}</a>`)
        .join('')}${tags.length > 30 ? `<button type="button" class="n-tag n-tagmore" data-tags-all>${ui.tagsAll ? 'Show fewer' : `Show all ${tags.length}`}</button>` : ''}</div>
    </div>`;
  }
  // Recently Deleted stays put at the bottom of the sidebar (on phones it is the last card of the Folders screen).
  const trashItem = navItem({ key: 'trash', href: '#/trash', glyph: icon('trash'), label: 'Recently Deleted', count: c.trash || '', drop: 'trash', current: cur === 'trash' });
  const footHtml = cols() > 1 ? trashItem : '';
  if (!footHtml) html += `<div class="nav-sep"></div>${trashItem}`;
  if (sideFootEl.dataset.h !== footHtml) {
    const refocus = sideFootEl.contains(document.activeElement);
    sideFootEl.innerHTML = footHtml;
    sideFootEl.dataset.h = footHtml;
    if (refocus) $('[data-key]', sideFootEl)?.focus({ preventScroll: true });
  }
  if (html === lastNavHtml) return;
  const focusKey = document.activeElement?.closest?.('#nav [data-key], #nav [data-tag], #nav [data-disclose]');
  const fk = focusKey ? focusKey.dataset.key || focusKey.dataset.tag || focusKey.dataset.disclose : null;
  const scroll = navEl.scrollTop;
  navEl.innerHTML = html;
  navEl.scrollTop = scroll;
  lastNavHtml = html;
  if (fk) $(`[data-key="${CSS.escape(fk)}"], [data-tag="${CSS.escape(fk)}"], [data-disclose="${CSS.escape(fk)}"]`, navEl)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- list column

const CHUNK = 120;
let rendered = CHUNK; // rows rendered so far (more load as you scroll)
let listItems = []; // [{key, kind:'note'|'group'|..., id}] in display order
let listNoteIds = []; // note ids in display order (keyboard navigation, ranges)
let searchResults = null; // [{note, score, snippets}] while searching
let flipNext = false;

function renderListHead() {
  const c = cols();
  const cfg = sortCfg();
  const title = viewTitle();
  const n = state.view === 'search' ? searchResults?.length ?? 0 : listNoteIds.length;
  const noun = state.view === 'search' ? plural(n, 'result') : plural(n, 'note');
  const f = cfg.folder;
  const dot = state.view === 'folder' && f ? `<span class="n-titledot" style="background:${colorVar(f.color)}"></span>` : '';
  const back =
    c === 1
      ? `<button type="button" class="n-back" data-go-folders aria-label="Back to folders">${icon('chevron-left', { size: 22, stroke: 2.2 })}<span>Folders</span></button>`
      : c === 2
        ? `<button type="button" class="icon-btn" data-toggle-nav aria-label="Show folders" ${tipAttrs('Folders', 'mod \\')}>${icon('sidebar')}</button>`
        : `<button type="button" class="icon-btn${ui.sideHidden ? '' : ' n-quiet'}" data-toggle-side aria-label="${ui.sideHidden ? 'Show' : 'Hide'} the sidebar" ${tipAttrs(ui.sideHidden ? 'Show sidebar' : 'Hide sidebar', 'mod \\')}>${icon('sidebar')}</button>`;
  const canView = state.view !== 'trash';
  const actions = [];
  // Phones keep the bar to ⋯ (it holds the view, sort, select and Delete All), with Done while selecting (iOS).
  const wide = c > 1;
  if (wide && state.view === 'trash' && listNoteIds.length) actions.push(`<button type="button" class="btn btn-ghost btn-sm n-danger-ghost" data-empty-trash>Delete All</button>`);
  if (wide && canView && state.view !== 'search')
    actions.push(
      `<button type="button" class="icon-btn" data-toggle-view aria-label="${cfg.view === 'gallery' ? 'View as list' : 'View as gallery'}" ${tipAttrs(cfg.view === 'gallery' ? 'View as list' : 'View as gallery', 'v')}>${lic(cfg.view === 'gallery' ? 'rows' : 'grid')}</button>`,
      `<button type="button" class="icon-btn" data-sort-menu aria-label="Sort and group" aria-haspopup="menu" ${tipAttrs('Sort')}>${icon('sort')}</button>`,
    );
  if (state.view !== 'search' && (wide || state.selectMode)) actions.push(`<button type="button" class="btn btn-ghost btn-sm n-selectbtn" data-select-mode aria-pressed="${state.selectMode}">${state.selectMode ? 'Done' : 'Select'}</button>`);
  actions.push(`<button type="button" class="icon-btn" data-list-menu aria-label="More" aria-haspopup="menu" ${tipAttrs('More')}>${icon('more')}</button>`);
  const tagMode =
    state.view === 'tag' && state.tags.length > 1
      ? `<div class="segmented n-tagmode" role="group" aria-label="Match tags"><button type="button" data-tag-mode="all" aria-pressed="${state.tagMode === 'all'}">All</button><button type="button" data-tag-mode="any" aria-pressed="${state.tagMode === 'any'}">Any</button></div>`
      : '';
  const html = `<div class="n-lh-bar">${back}<div class="n-lh-compact truncate" aria-hidden="true">${esc(title)}</div><span class="grow"></span>${actions.join('')}</div>
    <div class="n-lh-big"><div class="n-lh-row"><h1 class="n-lh-title" tabindex="-1">${dot}<span class="truncate">${esc(title)}</span></h1><div class="n-lh-sub tnum">${esc(noun)}</div></div>${tagMode}</div>`;
  if (listHeadEl.dataset.h === html) return;
  // Keep focus on the same control across a re-render.
  const a = document.activeElement;
  const key = a && listHeadEl.contains(a) ? [...a.attributes].map((x) => x.name).find((nm) => nm.startsWith('data-') && nm !== 'data-tip' && nm !== 'data-keys') : null;
  listHeadEl.innerHTML = html;
  listHeadEl.dataset.h = html;
  if (key && /^data-[a-z-]{1,40}$/.test(key)) listHeadEl.querySelector(`[${key}]`)?.focus({ preventScroll: true });
}

/** What every row of one render shares (worked out once per list, not once per row). */
const rowCtx = () => ({ cfg: sortCfg(), drag: coarse() ? 'false' : 'true' });

// The list is drawn again after every save, every row of it (hundreds once you have scrolled far down):
// a row is built again only when its note (a new object on every change) or what else it shows changed.
// rowEpoch counts changes of what rows show besides their note: folders, events, calendars, settings.
const rowCache = new WeakMap(); // note → {key, html}
let rowEpoch = 0;
function rowFor(n, opts, ctx = rowCtx()) {
  const { showFolder, snippet = null, titleHtml = null, pill = '', group = '' } = opts;
  const date = listDate(state.view === 'trash' ? n.trashedAt : ctx.cfg.by === 'created' ? n.createdAt : editedAt(n));
  const key = [rowEpoch, state.view, state.folderId, n.id === state.noteId, state.selectMode, state.sel.has(n.id), ctxRow === n.id, !!showFolder, snippet, titleHtml, pill, group, ctx.drag, date, morphing].join('\u0001');
  const hit = rowCache.get(n);
  if (hit?.key === key) return hit.html;
  const html = buildRow(n, opts, ctx, date);
  rowCache.set(n, { key, html });
  return html;
}
function buildRow(n, { showFolder, snippet = null, titleHtml = null, pill = '', group = '' }, ctx, date) {
  const m = meta(n);
  // In Select mode only the picked rows are tinted (the open note is no different from the others).
  const open = n.id === state.noteId && !state.selectMode;
  const picked = state.sel.has(n.id);
  const ring = m.open + m.done ? checkRing(m.done, m.open + m.done) : '';
  // Inside a folder only notes of its subfolders name theirs (the title above names this one).
  const inFolder = state.view === 'folder' && noteFolder(n) === state.folderId;
  const folderShown = showFolder && !inFolder;
  const f = folderShown ? folderById(noteFolder(n)) : null;
  const folderLine = folderShown ? `<div class="nrow-folder">${f ? `<span class="n-fd" style="background:${colorVar(f.color)}"></span><span class="truncate">${esc(f.name)}</span>` : n.day ? 'Daily Notes' : 'Notes'}</div>` : '';
  // Indicators are images with a name (a label on a plain span is not announced).
  const ind = [
    n.pinned && state.view !== 'trash' && showFolder ? `<span class="nrow-pin" role="img" aria-label="Pinned">${icon('pushpin', { size: 13 })}</span>` : '',
    ring,
    n.event ? `<span class="nrow-ic" role="img" aria-label="Meeting notes">${icon('calendar', { size: 14 })}</span>` : '',
    n.aiPrev ? `<span class="nrow-ic n-ai" role="img" aria-label="Unreviewed AI edit">${icon(G.ai, { size: 14 })}</span>` : '',
    isHidden(n) ? `<span class="nrow-ic" role="img" aria-label="Hidden from AI">${icon(G.aiOff, { size: 14 })}</span>` : '',
    pill,
  ].join('');
  const line = !m.preview && n.event ? meetingLine(n.event) : '';
  const prev = snippet ?? (m.preview ? esc(m.preview) : line ? esc(line) : '<span class="nrow-none">No additional text</span>');
  return `<div class="nrow${open ? ' open' : ''}${picked ? ' picked' : ''}${ctxRow === n.id ? ' n-ctx' : ''}" role="option" id="row-${esc(n.id)}" data-id="${esc(n.id)}" aria-selected="${open || picked}"${group ? ` aria-describedby="${esc(group)}"` : ''} tabindex="${open ? 0 : -1}" draggable="${ctx.drag}" style="view-transition-name:${esc(vtName(n.id))}">
    ${state.selectMode ? `<span class="check sm nrow-pick" aria-hidden="true"${picked ? ' aria-checked="true"' : ''}>${icon('check')}</span>` : ''}
    <div class="nrow-main">
      <div class="nrow-title truncate">${titleHtml ?? esc(displayTitle(n))}</div>
      <div class="nrow-sub"><span class="nrow-date tnum">${esc(date)}</span><span class="nrow-prev">${prev}</span></div>
      ${folderLine}
    </div>
    ${ind ? `<div class="nrow-ind">${ind}</div>` : ''}
  </div>`;
}
function cardFor(n, ctx = rowCtx()) {
  const m = meta(n);
  const open = n.id === state.noteId && !state.selectMode;
  const picked = state.sel.has(n.id);
  const f = folderById(noteFolder(n));
  // The title is its own span so a long one ends in "…" (a centred flex row can't show the ellipsis).
  return `<div class="ncard${open ? ' open' : ''}${picked ? ' picked' : ''}${ctxRow === n.id ? ' n-ctx' : ''}" role="option" id="row-${esc(n.id)}" data-id="${esc(n.id)}" aria-selected="${open || picked}" tabindex="${open ? 0 : -1}" draggable="${ctx.drag}" style="--fc:${f ? colorVar(f.color) : 'transparent'};view-transition-name:${esc(vtName(n.id))}">
    <div class="ncard-page" aria-hidden="true"><div class="ncard-render">${cardHtml(n)}</div>${state.selectMode ? `<span class="check sm nrow-pick"${picked ? ' aria-checked="true"' : ''}>${icon('check')}</span>` : ''}</div>
    <div class="ncard-meta"><div class="ncard-title">${n.pinned ? `<span class="nrow-pin" role="img" aria-label="Pinned">${icon('pushpin', { size: 12 })}</span>` : ''}<span class="truncate">${esc(displayTitle(n))}</span></div><div class="ncard-date tnum">${esc(listDate(ctx.cfg.by === 'created' ? n.createdAt : editedAt(n)))}${m.open + m.done ? `${sep}${m.done}/${m.open + m.done}` : ''}</div></div>
  </div>`;
}
const cardCache = new WeakMap();
function cardHtml(n) {
  let h = cardCache.get(n);
  if (h === undefined) {
    h = staticHtml(blocksOf(n), { max: 12 });
    cardCache.set(n, h);
  }
  return h;
}
function checkRing(done, total) {
  const pct = Math.round((done / total) * 100);
  return `<span class="n-ring${done === total ? ' full' : ''}" role="img" aria-label="${esc(`${done} of ${total} checked`)}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.2" class="n-ring-bg"/><circle cx="8" cy="8" r="6.2" class="n-ring-fg" pathLength="100" stroke-dasharray="${esc(pct)} 100"/></svg><span class="tnum">${esc(`${done}/${total}`)}</span></span>`;
}
const vtName = (id) => (morphing ? `n-${String(id).replace(/[^a-z0-9_-]/gi, '')}` : 'none');
let morphing = false;

/** Days left before a deleted note is purged. */
const daysLeft = (n) => Math.max(0, 30 - Math.floor((Date.now() - (n.trashedAt || Date.now())) / DAY_MS));

function draftRow(d) {
  const live = session?.id === d.id && session.editor ? safe(() => session.editor.getBlocks(), d.blocks) : d.blocks;
  const title = oneLine(liveTitleOf(live)) || (d.day ? longDay(d.day) : 'New Note');
  return `<div class="nrow open n-draft" role="option" id="row-${esc(d.id)}" data-id="${esc(d.id)}" aria-selected="true" tabindex="0">
    <div class="nrow-main"><div class="nrow-title truncate">${esc(title)}</div><div class="nrow-sub"><span class="nrow-date tnum">${esc(listDate(Date.now()))}</span><span class="nrow-prev"><span class="nrow-none">No additional text</span></span></div></div></div>`;
}

/**
 * A list item whose HTML is only built when it is rendered: a list re-renders after every save, and
 * only the first rows (CHUNK, more as you scroll) ever reach the DOM.
 */
const lazyItem = (fields, make) => ({
  ...fields,
  get html() {
    if (this._html === undefined) this._html = make();
    return this._html;
  },
});
// Gallery grids come in pieces of 60 cards (a whole number of rows at 1–6 columns) so they load in chunks too.
const GRID_PIECE = 60;

/** Build the ordered items of the list (headers + rows), then patch the DOM by key. */
function buildList() {
  const ctx = rowCtx();
  const cfg = ctx.cfg;
  const items = [];
  const ids = [];
  const gallery = cfg.view === 'gallery' && state.view !== 'search' && state.view !== 'trash';
  const showFolder = state.view === 'all' || state.view === 'tag' || state.view === 'search' || state.view === 'ai' || (state.view === 'folder' && state.folderId !== 'notes');
  const dayDraft = state.view === 'today' && state.day && !safe(() => core.dailyNote(state.day, { create: false }), null) ? [...drafts.values()].find((x) => x.day === state.day) : null;
  const named = drafts.get(state.noteId);
  const d = named && !named.day && draftFits(named) ? named : dayDraft || null;
  if (d) items.push(lazyItem({ key: `d:${d.id}` }, () => draftRow(d)));
  if (state.view === 'search') {
    const res = runSearch();
    for (const r of res) {
      ids.push(r.note.id);
      items.push(lazyItem({ key: `n:${r.note.id}`, id: r.note.id }, () => rowFor(r.note, { showFolder: true, titleHtml: r.titleHtml, snippet: r.snippetHtml }, ctx)));
    }
    const title = createTitle(state.q);
    // The last result of a search: an option like the notes above it (Enter or a click creates it).
    if (title) items.push({ key: 'x:create', html: `<button type="button" class="nrow n-create" role="option" aria-selected="false" data-create-from-search>${icon('edit', { size: 18 })}<span class="truncate">New note “${esc(title)}”</span><span class="hint">${keys('enter')}</span></button>` });
    listItems = items;
    listNoteIds = ids;
    return { items, gallery: false };
  }
  let notes = viewNotes();
  let by = cfg.by;
  let dir = cfg.dir;
  let group = cfg.group;
  if (state.view === 'trash') {
    by = 'trashed';
    dir = 'desc';
    group = false;
  } else if (state.view === 'today') {
    by = 'day';
    dir = 'desc';
  } else if (state.view === 'ai') {
    by = 'ai';
    dir = 'desc';
    group = false;
  }
  sortNotes(notes, by, dir);
  const pinned = state.view === 'trash' ? [] : notes.filter((n) => n.pinned);
  const rest = state.view === 'trash' ? notes : notes.filter((n) => !n.pinned);
  // Rows name their group (Pinned, Today, Previous 7 Days…) as their description: a listbox holds options
  // only, so the headings themselves are drawn for the eye and kept out of the accessibility tree.
  let groupId = '';
  const gid = (label) => `ng-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const cell = (n, group = groupId) => (gallery ? cardFor(n, ctx) : rowFor(n, { showFolder, group, pill: state.view === 'trash' ? `<span class="n-pill tnum">${esc(plural(daysLeft(n), 'day'))}</span>` : '' }, ctx));
  const grid = (key, list) => {
    for (let i = 0; i < list.length; i += GRID_PIECE) {
      const piece = list.slice(i, i + GRID_PIECE);
      items.push(lazyItem({ key: i ? `${key}:${i}` : key, ids: piece.map((n) => n.id) }, () => `<div class="ngrid">${piece.map(cell).join('')}</div>`));
    }
  };
  if (pinned.length) {
    // A heading like the date groups; it folds on click, or from the list menu (Hide Pinned Notes).
    items.push({ key: 'g:pinned', html: `<div class="ngroup n-pinhead" role="presentation" aria-hidden="true" id="${gid('pinned')}" data-toggle-pinned data-collapsed="${ui.pinnedCollapsed}">${icon('chevron-down', { size: 14, stroke: 2.2 })}<span>Pinned</span><span class="ngroup-n tnum">${esc(pinned.length)}</span></div>` });
    if (!ui.pinnedCollapsed) {
      if (gallery) grid('grid:pinned', pinned);
      else for (const n of pinned) items.push(lazyItem({ key: `n:${n.id}`, id: n.id }, () => cell(n, gid('pinned'))));
      ids.push(...pinned.map((n) => n.id));
    }
  }
  let label = null;
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    if (gallery) grid(`grid:${label}`, bucket);
    bucket = [];
  };
  const k = sortKey(by === 'title' ? 'edited' : by);
  const today = todayYmd();
  const groups = new Map(); // day → label (one date format per day, not per note)
  const groupOf = (ts) => {
    if (!ts) return groupLabel(ts);
    const day = ymd(new Date(ts));
    let g = groups.get(day);
    if (g === undefined) groups.set(day, (g = groupLabel(ts, { ahead: by === 'day', today })));
    return g;
  };
  for (const n of rest) {
    if (group) {
      const g = groupOf(k(n));
      if (g !== label) {
        flush();
        label = g;
        groupId = gid(g);
        items.push({ key: `g:${g}`, html: `<div class="ngroup" role="presentation" aria-hidden="true" id="${groupId}"><span>${esc(g)}</span></div>` });
      }
    } else if (pinned.length && label === null) {
      label = 'Notes';
      if (state.view !== 'trash') {
        groupId = gid('notes');
        items.push({ key: 'g:notes', html: `<div class="ngroup" role="presentation" aria-hidden="true" id="${groupId}"><span>Notes</span></div>` });
      }
    }
    ids.push(n.id);
    if (gallery) bucket.push(n);
    else {
      const g = groupId;
      items.push(lazyItem({ key: `n:${n.id}`, id: n.id }, () => cell(n, g)));
    }
  }
  flush();
  listItems = items;
  listNoteIds = ids;
  return { items, gallery };
}
function draftFits(d) {
  if (state.view === 'all') return true;
  if (state.view === 'folder') return state.folderId === 'notes' ? !d.folderId : folderSubtree(state.folderId).has(d.folderId);
  if (state.view === 'tag') return !!d.tag && state.tags.includes(d.tag);
  return false;
}

function emptyHtml() {
  if (state.view === 'trash') return emptyState('trash', 'No deleted notes', 'Notes you delete stay here for 30 days.');
  if (state.view === 'search') return '';
  if (state.view === 'ai') return emptyState(G.ai, 'Nothing to review', 'When an AI assistant edits a note, it shows up here until you keep or undo the change.');
  if (state.view === 'today') return emptyState('calendar', 'No daily notes yet', 'Each day gets a note that shows its plan. Open Today to start one.', '<button type="button" class="btn btn-tint" data-go-today>Open Today</button>');
  if (state.view === 'tag' && state.tags.length > 1) {
    return state.tagMode === 'any'
      ? emptyState('hash', 'No notes', 'No note has any of these tags any more.')
      : emptyState('hash', 'No notes', 'No note has all of these tags.', '<button type="button" class="btn btn-tint" data-tag-mode="any">Show notes with any of them</button>');
  }
  if (state.view === 'tag') return emptyState('hash', 'No notes', 'No note has this tag any more.');
  return emptyState('note', 'No notes', state.view === 'folder' ? 'Notes you add to this folder show up here.' : 'Your notes show up here.', '<button type="button" class="btn btn-tint" data-new-note>New note</button>');
}
const emptyState = (glyph, title, text, extra = '') => `<div class="empty n-empty"><div class="glyph">${icon(glyph)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;

function renderList({ keepScroll = true } = {}) {
  const { items, gallery } = buildList();
  const visible = [];
  let rows = 0;
  for (const it of items) {
    if (rows >= rendered && (it.id || it.ids)) break;
    visible.push(it);
    if (it.id || it.ids) rows += it.ids ? it.ids.length : 1;
  }
  // A group heading must not dangle below the last rendered row.
  while (visible.length < items.length && visible.length && !visible.at(-1).id && !visible.at(-1).ids && visible.at(-1).key.startsWith('g:')) visible.pop();
  const more = visible.length < items.length;
  if (more) visible.push({ key: 'x:more', html: '<div class="n-more" data-more aria-hidden="true"></div>' });
  if (!items.length) visible.push({ key: 'x:empty', html: emptyHtml() });
  // Without notes the column shows a message (and maybe a button): a plain group then, not a listbox.
  listEl.setAttribute('role', items.length ? 'listbox' : 'group');
  if (items.length) listEl.setAttribute('aria-multiselectable', 'true');
  else listEl.removeAttribute('aria-multiselectable');
  listEl.classList.toggle('is-gallery', gallery);
  // Rows that change places glide there (once: the note you start typing in goes to the top of Today).
  // Only when some row does move: measuring the rows costs a layout of the page, a long note included.
  const before = flipNext && !reduceMotion() && rowsMove(visible) ? measureRows() : null;
  const scroll = listEl.scrollTop;
  // The focused row keeps the focus, also when it moves (a pinned note goes to the top: moving a node
  // in the DOM takes its focus away).
  const focusedId = listEl.contains(document.activeElement) ? document.activeElement.closest?.('[data-id]')?.dataset.id || null : null;
  patchKeyed(listEl, visible);
  if (keepScroll) listEl.scrollTop = scroll;
  if (more) watchMore();
  const focusedRow = focusedId ? $(`#row-${CSS.escape(focusedId)}`, listEl) : null;
  if (focusedRow && document.activeElement !== focusedRow && !focusedRow.contains(document.activeElement)) focusedRow.focus({ preventScroll: true });
  // One tab stop for the list: the focused row, else the open one, else the first.
  const rowEls = listEl.querySelectorAll('[data-id]');
  const stop = (focusedRow && listEl.contains(document.activeElement) ? focusedRow : null) || listEl.querySelector(`#row-${CSS.escape(state.noteId || '-')}`) || rowEls[0];
  for (const r of rowEls) r.tabIndex = r === stop ? 0 : -1;
  if (before) playFlip(before);
  flipNext = false;
  listEl.setAttribute('aria-activedescendant', state.noteId && $(`#row-${CSS.escape(state.noteId)}`, listEl) ? `row-${state.noteId}` : '');
  if (!listEl.getAttribute('aria-activedescendant')) listEl.removeAttribute('aria-activedescendant');
}

const htmlOf = new WeakMap(); // element → the HTML it was built from
/** Replace children by key, reusing nodes whose HTML didn't change (keeps focus, hover and FLIP). */
function patchKeyed(parent, items) {
  const old = new Map();
  for (const el of [...parent.children]) if (el.dataset.key) old.set(el.dataset.key, el);
  let ref = parent.firstElementChild;
  const tpl = document.createElement('template');
  for (const it of items) {
    let el = old.get(it.key);
    if (el && htmlOf.get(el) === it.html) old.delete(it.key);
    else {
      tpl.innerHTML = it.html.trim();
      const fresh = tpl.content.firstElementChild;
      if (!fresh) continue;
      fresh.dataset.key = it.key;
      htmlOf.set(fresh, it.html);
      if (el) {
        const hadFocus = el.contains(document.activeElement);
        el.replaceWith(fresh);
        old.delete(it.key);
        if (hadFocus) fresh.focus({ preventScroll: true });
        if (ref === el) ref = fresh;
      }
      el = fresh;
    }
    if (el !== ref) parent.insertBefore(el, ref);
    else ref = ref.nextElementSibling;
    if (el === ref) ref = ref.nextElementSibling;
  }
  for (const el of old.values()) el.remove();
  // Anything left after the last item (stale nodes without keys) goes too.
  let last = items.length ? parent.querySelector(`:scope > [data-key="${CSS.escape(items.at(-1).key)}"]`) : null;
  if (last) while (last.nextElementSibling) last.nextElementSibling.remove();
  else if (!items.length) parent.replaceChildren();
}

let moreObs = null;
function watchMore() {
  const s = $('[data-more]', listEl);
  if (!s) return;
  moreObs?.disconnect();
  moreObs = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      moreObs.disconnect();
      rendered += CHUNK;
      renderList();
    },
    { root: listEl, rootMargin: '600px' },
  );
  moreObs.observe(s);
}

/** Will the rows (and cards) about to be rendered come in another order than the ones on screen? (No layout read.) */
function rowsMove(items) {
  const next = [];
  for (const it of items) {
    if (it.ids) next.push(...it.ids);
    else if (it.id) next.push(it.id);
    else if (it.key.startsWith('d:')) next.push(it.key.slice(2));
  }
  const now = listEl.querySelectorAll('[data-id]');
  if (now.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) if (now[i].dataset.id !== next[i]) return true;
  return false;
}
function measureRows() {
  const m = new Map();
  for (const el of $$('[data-id]', listEl)) m.set(el.dataset.id, el.getBoundingClientRect().top);
  return m;
}
/**
 * FLIP: every new position is read first, then the animations start. (A read after an animation has
 * started makes the browser lay the page out again, once per row: with a long note open that was
 * most of a second on the first keystroke.) Only rows that can be seen move: one outside the list's
 * window, or travelling further than the list is tall (a streak says nothing), just takes its place.
 */
function playFlip(before) {
  const box = listEl.getBoundingClientRect();
  const moves = [];
  for (const el of listEl.querySelectorAll('[data-id]')) {
    const was = before.get(el.dataset.id);
    if (was === undefined) continue;
    const r = el.getBoundingClientRect();
    const dy = was - r.top;
    if (Math.abs(dy) < 2 || Math.abs(dy) > box.height) continue;
    if (Math.max(was, r.top) + r.height < box.top || Math.min(was, r.top) > box.bottom) continue;
    moves.push([el, dy]);
  }
  for (const [el, dy] of moves) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
}

// ---------------------------------------------------------------- search

const SEARCH_CHIPS = [
  { label: 'Checklists', op: 'has:todo' },
  { label: 'Pinned', op: 'is:pinned' },
  { label: 'Daily', op: 'is:daily' },
  { label: 'Edited this week', op: 'edited:7d' },
  { label: 'Edited by AI', op: 'is:ai' },
];
/**
 * The free text of a query, as typed: the title of "New note “…”". Operators the search understands
 * (in:, is:, has:, tag:, edited:, created:), #tags and excluded words or "phrases" are left out; a
 * quoted phrase keeps its words. Tokens are read the way parseQuery reads them (in:"My folder" is one).
 */
function createTitle(q) {
  const raw = String(q || '').slice(0, 1000);
  const words = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;
    let neg = false;
    if (raw[i] === '-' && i + 1 < raw.length && !/\s/.test(raw[i + 1])) {
      neg = true;
      i++;
    }
    if (raw[i] === '"') {
      const end = raw.indexOf('"', i + 1);
      const phrase = raw.slice(i + 1, end < 0 ? raw.length : end).trim();
      i = end < 0 ? raw.length : end + 1;
      if (!neg && phrase) words.push(phrase);
      continue;
    }
    const start = i;
    const op = /^[A-Za-z]+:"/.exec(raw.slice(i, i + 13));
    if (op) {
      const end = raw.indexOf('"', i + op[0].length);
      i = end < 0 ? raw.length : end + 1;
    } else while (i < raw.length && !/\s/.test(raw[i])) i++;
    const token = raw.slice(start, i);
    if (neg || !token) continue;
    // What parseQuery takes as an operator or a #tag leaves no free words behind.
    let p = null;
    try {
      p = parseQuery(token);
    } catch {
      p = null;
    }
    if (p && !p.terms.length && !p.phrases.length) continue;
    words.push(token);
  }
  return words.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}
let searchCache = { key: '', res: [] };
/**
 * The results of the query being typed: their order and count only. A result's snippet and marked title
 * are made when its row is first rendered (a keystroke renders the first screen of rows, not 300).
 */
function runSearch() {
  const q = state.q.trim();
  if (!q) return (searchResults = []);
  const key = `${q}\u0000${state.scope}\u0000${ui.searchSort}\u0000${db.all('notes').length}\u0000${notesVersion}`;
  if (searchCache.key === key) return (searchResults = searchCache.res);
  let pool = liveNotes();
  if (state.scope === 'notes') pool = pool.filter(inNotesFolder);
  else if (state.scope) {
    const sub = folderSubtree(state.scope);
    pool = pool.filter((n) => sub.has(n.folderId));
  }
  let parsed = null;
  try {
    parsed = parseQuery(q);
  } catch {
    parsed = null;
  }
  // One clock for the whole search, so a result's own lookup later judges `edited:7d` the same way.
  const opts = { folders: folders(), limit: 300, sort: ui.searchSort, now: Date.now() };
  const raw = safe(() => searchNotes(pool, parsed || q, { ...opts, snippets: false }), []) || [];
  const words = [...(parsed?.terms || []), ...(parsed?.phrases || [])].map((t) => String(t).toLowerCase()).filter(Boolean);
  const res = raw.filter((r) => r && r.note).map((r) => searchResult(r.note, r.score, parsed || q, opts, words));
  searchCache = { key, res };
  return (searchResults = res);
}
/** One search result; its marked title and snippet are worked out the first time its row asks for them. */
function searchResult(note, score, query, opts, words) {
  let hit;
  // This note alone, searched again with its snippets: the same matches, for one note instead of 300.
  const detail = () => (hit ??= safe(() => searchNotes([note], query, { ...opts, limit: 1 })[0], null) || { note });
  let titleHtml;
  let snippetHtml;
  return {
    note,
    score: score || 0,
    get titleHtml() {
      if (titleHtml === undefined) {
        const r = detail();
        const title = displayTitle(note);
        // The title as stored is what the ranges index; a note without one falls back to local marking.
        titleHtml = Array.isArray(r.titleRanges) && note.title && title === note.title ? safe(() => highlight(title, r.titleRanges), esc(title)) : markText(title, words);
      }
      return titleHtml;
    },
    get snippetHtml() {
      if (snippetHtml === undefined) {
        const sn = (detail().snippets || []).find((s) => s && typeof s.text === 'string');
        snippetHtml = sn ? safe(() => highlight(sn.text, sn.ranges || []), esc(sn.text)) : meta(note).preview ? esc(meta(note).preview) : '<span class="nrow-none">No additional text</span>';
      }
      return snippetHtml;
    },
  };
}
let notesVersion = 0;

/** Fold case and accents (é matches e) while keeping a map back to the original offsets. */
function foldMap(s) {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const f = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    out += f;
  }
  map.push(s.length);
  return { out, map };
}
/** Escape `text` and wrap every occurrence of `words` in <mark>. */
function markText(text, words) {
  const s = String(text ?? '');
  if (!words.length) return esc(s);
  const { out, map } = foldMap(s);
  const ranges = [];
  for (const w of words) {
    const f = foldMap(w).out;
    if (!f) continue;
    let i = out.indexOf(f);
    while (i >= 0 && ranges.length < 50) {
      ranges.push([map[i], map[i + f.length] ?? s.length]);
      i = out.indexOf(f, i + f.length);
    }
  }
  if (!ranges.length) return esc(s);
  ranges.sort((a, b) => a[0] - b[0]);
  let html = '';
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    html += esc(s.slice(at, a)) + `<mark>${esc(s.slice(a, b))}</mark>`;
    at = b;
  }
  return html + esc(s.slice(at));
}

/** Focus is in the search field or on its filter chips (Tab from the field reaches them). */
const searchAreaFocused = () => document.activeElement === qEl || searchOptsEl.contains(document.activeElement);
function renderSearchOpts() {
  const active = state.view === 'search' || searchAreaFocused();
  searchOptsEl.hidden = !active;
  $('[data-clear-search]').hidden = !qEl.value;
  if (!active) return;
  const q = qEl.value;
  const has = (op) => q.split(/\s+/).some((w) => w.toLowerCase() === op.toLowerCase());
  const tags = tagCounts().slice(0, 4);
  const from = searchFrom?.view === 'folder' && searchFrom.folderId ? searchFrom.folderId : state.scope;
  const scopeName = from === 'notes' ? 'Notes' : folderById(from)?.name;
  const scopeSeg = scopeName
    ? `<div class="segmented n-scope" role="group" aria-label="Search in"><button type="button" data-scope="" aria-pressed="${!state.scope}">All Notes</button><button type="button" data-scope="${esc(from)}" aria-pressed="${state.scope === from}"><span class="truncate">${esc(scopeName)}</span></button></div>`
    : '';
  const sortSeg =
    state.view === 'search' && state.q
      ? `<div class="segmented n-ssort" role="group" aria-label="Order results"><button type="button" data-search-sort="relevance" aria-pressed="${ui.searchSort !== 'date'}">Relevance</button><button type="button" data-search-sort="date" aria-pressed="${ui.searchSort === 'date'}">Date</button></div>`
      : '';
  const chips = [...SEARCH_CHIPS, ...tags.map((t) => ({ label: `#${t.tag}`, op: `#${t.tag}` }))]
    .map((c) => `<button type="button" class="chip n-schip" data-search-op="${esc(c.op)}" aria-pressed="${has(c.op)}">${esc(c.label)}</button>`)
    .join('');
  const html = `${scopeSeg || sortSeg ? `<div class="n-sorow">${scopeSeg}<span class="grow"></span>${sortSeg}</div>` : ''}<div class="n-schips" role="group" aria-label="Filters">${chips}</div>`;
  if (searchOptsEl.dataset.h !== html) {
    searchOptsEl.innerHTML = html;
    searchOptsEl.dataset.h = html;
  }
}

let searchTimer = 0;
/** Characters of note text in this browser, worked out once per change of the notes (the search debounce). */
let corpus = { v: -1, chars: 0 };
function corpusChars() {
  if (corpus.v !== notesVersion) corpus = { v: notesVersion, chars: liveNotes().reduce((n, x) => n + charCount(blocksOf(x)), 0) };
  return corpus.chars;
}
/** The hash of the search being typed, keeping the open note (desktop). */
function searchHash(q, noteId = state.noteId) {
  const h = listHash({ ...state, view: 'search', q });
  const [p, query] = h.split('?');
  return noteId ? `${p}/n/${encodeURIComponent(noteId)}?${query}` : h;
}
/**
 * Wide layouts keep the note you were reading open while you search, as long as it matches; once it
 * stops matching the first result opens instead. (Phones show the results, not a note.)
 */
function keepOrFirstResult() {
  if (cols() === 1 || !state.noteId || drafts.has(state.noteId)) return;
  const res = searchResults || [];
  if (!res.length || res.some((r) => r.note.id === state.noteId)) return;
  openNote(res[0].note.id, { v: state, replace: true });
}
// The note column follows the results once typing pauses: opening a note mid-word would rebuild the
// editor on every keystroke (and show notes you never meant to look at).
const KEEP_MS = 300;
let keepTimer = 0;
function keepOrFirstResultSoon() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => {
    keepTimer = 0;
    if (state.view === 'search') keepOrFirstResult();
  }, KEEP_MS);
}
// A keystroke renders the first screen of results (and some); the rest load as the list scrolls.
const SEARCH_FIRST = 40;
let searchGo = null; // the search typed but not run yet (large libraries wait for a pause in typing)
/** Run the search waiting for a pause now (Enter or ↓ in the field act on what is typed). */
function flushSearch() {
  clearTimeout(searchTimer);
  const go = searchGo;
  searchGo = null;
  go?.();
}
function onSearchInput() {
  const q = qEl.value;
  renderSearchOpts();
  const go = () => {
    if (!q.trim()) {
      clearTimeout(keepTimer);
      if (state.view === 'search') exitSearch();
      return;
    }
    if (state.view !== 'search') {
      searchFrom = { view: state.view, folderId: state.folderId, tags: [...state.tags], tagMode: state.tagMode, noteId: state.noteId };
      // The note you are reading stays open (desktop): Esc brings you back to it.
      const keep = cols() > 1 && state.noteId && !drafts.has(state.noteId) && noteById(state.noteId) ? state.noteId : null;
      nav(keep ? searchHash(q, keep) : listHash({ ...state, view: 'search', q, scope: null }));
    } else {
      state.q = q;
      rendered = SEARCH_FIRST;
      // Back to the top before the rows change, so the new rows aren't laid out an extra time for it.
      listEl.scrollTop = 0;
      // Only the list changes with the query: the sidebar, the note and its chrome stay as they are.
      renderList({ keepScroll: false });
      history.replaceState(history.state, '', searchHash(q));
      lastHash = location.hash;
      renderListHead();
    }
    keepOrFirstResultSoon();
  };
  clearTimeout(searchTimer);
  searchGo = go;
  // Large libraries wait for a pause in typing (by the amount of text, not the number of notes).
  if (corpusChars() > 1000000) searchTimer = setTimeout(flushSearch, 60);
  else flushSearch();
}
function exitSearch() {
  const from = searchFrom;
  searchFrom = null;
  clearTimeout(keepTimer);
  qEl.value = '';
  const v = from ? { ...state, view: from.view, folderId: from.folderId, tags: from.tags, tagMode: from.tagMode, q: '', scope: null } : { ...state, view: 'all', q: '', scope: null };
  // Back to the note you were reading (or the result you opened, when it belongs to that list); phones
  // go back to the list.
  const fits = (id) => !!id && !drafts.has(id) && !!noteById(id) && !noteById(id).trashedAt && viewNotes(v).some((x) => x.id === id);
  const id = cols() > 1 ? [state.noteId, from?.noteId].find(fits) || null : null;
  nav(id ? noteHash(id, { v }) : listHash(v), { replace: true });
  renderSearchOpts();
}
function toggleSearchOp(op) {
  const words = qEl.value.split(/\s+/).filter(Boolean);
  const i = words.findIndex((w) => w.toLowerCase() === op.toLowerCase());
  if (i >= 0) words.splice(i, 1);
  else words.push(op);
  qEl.value = words.join(' ') + (words.length ? ' ' : '');
  qEl.focus();
  onSearchInput();
}
function createFromSearch() {
  const title = createTitle(state.q || qEl.value);
  if (!title) return;
  const exact = (searchResults || []).find((r) => displayTitle(r.note).toLowerCase() === title.toLowerCase());
  if (exact) return openNote(exact.note.id);
  newNote({ title, from: searchFrom });
}

// ---------------------------------------------------------------- multi-select bar

function renderSelBar() {
  const n = state.sel.size;
  // Desktop shows the actions in the note column (the stack of selected notes); phones and Select mode here.
  const show = n > 0 && (state.selectMode || (n > 1 && cols() === 1));
  selBarEl.hidden = !show;
  shellEl.classList.toggle('has-selbar', show);
  if (!show) return;
  const trash = state.view === 'trash';
  selBarEl.innerHTML = trash
    ? `<span class="n-selcount tnum">${esc(plural(n, 'note'))}</span><span class="grow"></span>
       <button type="button" class="btn btn-ghost btn-sm" data-bulk="recover">Recover</button>
       <button type="button" class="btn btn-ghost btn-sm n-danger-ghost" data-bulk="purge">Delete</button>`
    : `<span class="n-selcount tnum">${esc(plural(n, 'note'))}</span><span class="grow"></span>
       <button type="button" class="icon-btn" data-bulk="pin" aria-label="Pin or unpin" ${tipAttrs('Pin')}>${icon('pushpin')}</button>
       <button type="button" class="icon-btn" data-bulk="move" aria-label="Move to folder" ${tipAttrs('Move')}>${lic('move')}</button>
       <button type="button" class="icon-btn" data-bulk="tag" aria-label="Add tag" ${tipAttrs('Add tag')}>${icon('hash')}</button>
       <button type="button" class="icon-btn n-danger-ic" data-bulk="delete" aria-label="Delete" ${tipAttrs('Delete')}>${icon('trash')}</button>`;
}

// ---------------------------------------------------------------- editor sessions

const SAVE_MS = 400;
const IDLE_SNAPSHOT_MS = 5 * 60000;
let session = null; // the note in the main editor
let quick = null; // the Quick Note sheet's session

const textSig = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && (b.t === 'hr' || oneLine(blockText(b))))
    .map((b) => (b.t === 'hr' ? '---' : `${b.t}|${b.ck ? 1 : 0}|${oneLine(blockText(b))}`))
    .join('\n');
const charCount = (blocks) => (Array.isArray(blocks) ? blocks : []).reduce((n, b) => n + blockText(b).length, 0);
function liveTitleOf(blocks) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const t = oneLine(blockText(b));
    if (t) return t.slice(0, 120);
  }
  return '';
}

/**
 * A 3-way merge of a note's blocks (base: what the editor started from; mine: the editor now; theirs:
 * the note as stored now). Blocks only one side changed take that side's version. A block both
 * changed is merged field by field: each side's change of a field wins over the base (your text and
 * their check, when a task was completed elsewhere while you typed in its item), and the text itself
 * is merged where the two changed different parts of it (one typed at the start of a line, the other
 * at its end). Only where both changed the same words, or the same field differently, yours are kept
 * and `conflict` is set. Blocks only you added go after the block they followed in your copy, and a
 * block you changed that they deleted stays (no text is lost). → blocks, or {blocks, conflict}.
 */
function mergeBlocks(base, mine, theirs, { withConflicts = false } = {}) {
  const key = (b) => JSON.stringify(b);
  const baseById = new Map((base || []).map((b) => [b.id, b]));
  const baseMap = new Map((base || []).map((b) => [b.id, key(b)]));
  const mineMap = new Map((mine || []).map((b) => [b.id, b]));
  const theirIds = new Set((theirs || []).map((b) => b.id));
  const changed = new Set((mine || []).filter((b) => baseMap.get(b.id) !== key(b)).map((b) => b.id));
  const deletedByMe = new Set([...baseMap.keys()].filter((id) => !mineMap.has(id)));
  let conflict = false;
  const out = [];
  for (const b of theirs || []) {
    if (changed.has(b.id)) {
      const b0 = baseById.get(b.id);
      // Changed on their side too (not only on mine): merge the two.
      if (b0 && baseMap.get(b.id) !== key(b)) {
        const r = mergeBlock(b0, mineMap.get(b.id), b);
        if (r.conflict) conflict = true;
        out.push(r.block);
      } else out.push(mineMap.get(b.id));
    } else if (deletedByMe.has(b.id) && baseMap.get(b.id) === key(b)) continue;
    else out.push(b);
  }
  // Blocks only I added (or changed while they deleted them) go after the block they followed in my copy.
  const mineList = mine || [];
  mineList.forEach((b, i) => {
    if (theirIds.has(b.id) || (baseMap.has(b.id) && !changed.has(b.id))) return;
    let at = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === mineList[j].id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, b);
  });
  return withConflicts ? { blocks: out, conflict } : out;
}
/** One block both sides changed: field by field, and its text by the parts each side changed. */
function mergeBlock(b0, m, t) {
  let conflict = false;
  const out = {};
  for (const k of new Set([...Object.keys(b0), ...Object.keys(m), ...Object.keys(t)])) {
    if (k === 'c') continue;
    const mineChanged = !sameJson(m[k], b0[k]);
    const theirsChanged = !sameJson(t[k], b0[k]);
    if (mineChanged && theirsChanged && !sameJson(m[k], t[k])) conflict = true;
    const v = mineChanged ? m[k] : t[k];
    if (v !== undefined) out[k] = v;
  }
  const c = mergeRuns(b0.c, m.c, t.c);
  if (c) out.c = c;
  else {
    out.c = m.c;
    conflict = true;
  }
  return { block: out, conflict };
}
/**
 * The text of one block (its runs: [text, marks?, attrs?]) merged three ways, by character with its
 * formatting (a chip is one unit). Each side's change is the stretch of the base it replaced; when the
 * two stretches don't overlap both are applied. → runs, or null when they overlap.
 */
function mergeRuns(c0, cm, ct) {
  const A = Array.isArray(c0) ? c0 : [];
  const M = Array.isArray(cm) ? cm : [];
  const T = Array.isArray(ct) ? ct : [];
  if (sameJson(M, A)) return T;
  if (sameJson(T, A) || sameJson(M, T)) return M;
  const units = (runs) => {
    const u = [];
    for (const r of runs) {
      if (!Array.isArray(r)) continue;
      const fmtKey = JSON.stringify([r[1] || '', r[2] ?? null]);
      if (r[2]?.atom) u.push({ s: String(r[0] ?? ''), k: fmtKey, r });
      else for (const ch of String(r[0] ?? '')) u.push({ s: ch, k: fmtKey, r });
    }
    return u;
  };
  const a = units(A);
  const m = units(M);
  const t = units(T);
  const same = (x, y) => x.s === y.s && x.k === y.k;
  /** The stretch of the base [from, to) that `x` replaced, and what it put there. */
  const change = (x) => {
    let p = 0;
    while (p < a.length && p < x.length && same(a[p], x[p])) p++;
    let q = 0;
    while (q < a.length - p && q < x.length - p && same(a[a.length - 1 - q], x[x.length - 1 - q])) q++;
    return { from: p, to: a.length - q, put: x.slice(p, x.length - q) };
  };
  const cm2 = change(m);
  const ct2 = change(t);
  // In base order (an insertion before a replacement that starts at the same place).
  const [first, second] = cm2.from < ct2.from || (cm2.from === ct2.from && cm2.to <= ct2.to) ? [cm2, ct2] : [ct2, cm2];
  // Overlapping stretches are a real conflict.
  if (first.to > second.from) return null;
  if (first.from === first.to && second.from === second.to && first.from === second.from) {
    // Two insertions at the same place: both, in an order every tab works out alike (so they agree).
    const text = (x) => x.put.map((u) => u.s).join('');
    const [x, y] = text(cm2) <= text(ct2) ? [cm2, ct2] : [ct2, cm2];
    return toRuns([...a.slice(0, x.from), ...x.put, ...y.put, ...a.slice(x.from)]);
  }
  return toRuns([...a.slice(0, first.from), ...first.put, ...a.slice(first.to, second.from), ...second.put, ...a.slice(second.to)]);
}
/** Units back to runs: neighbours with the same formatting join up again. */
function toRuns(units) {
  const out = [];
  let cur = null;
  for (const u of units) {
    if (u.r[2]?.atom) {
      out.push(clone(u.r));
      cur = null;
      continue;
    }
    if (cur && cur.k === u.k) {
      cur.run[0] += u.s;
      continue;
    }
    const run = [u.s];
    if (u.r[1] || u.r[2] != null) run.push(u.r[1] || '');
    if (u.r[2] != null) run.push(clone(u.r[2]));
    cur = { k: u.k, run };
    out.push(run);
  }
  return out;
}

/**
 * One open note in an editor (the main column or the Quick Note sheet). Saves 400 ms after the last
 * change (and on switch / hide / close), turns a draft into a stored note on its first real edit,
 * takes changes made elsewhere (another tab, an AI, a linked task) without losing what you typed,
 * and feeds version history.
 */
function openSession(host, { note = null, draft = null, readOnly = false, main = true, focus = null, extra = null } = {}) {
  const s = {
    id: note ? note.id : draft.id,
    historyId: note ? note.id : draft.id, // the editor keeps its undo stack under this id (a draft keeps its own)
    draft,
    main,
    readOnly: !!readOnly || !!note?.trashedAt,
    base: clone(note ? blocksOf(note) : draft.blocks),
    // The stored version the editor started from: rev and updatedAt together (two tabs can each write
    // the rev after the same one, and the editor must not take the other tab's for its own).
    baseRev: note ? note.rev : null,
    baseAt: note ? note.updatedAt ?? null : null,
    legacy: !!note && !(Array.isArray(note.blocks) && note.blocks.length) && typeof note.body === 'string' && !!note.body.trim(),
    dirty: false,
    timer: 0,
    lastEditAt: 0,
    edited: false,
    editor: null,
    closed: false,
    titleTimer: 0,
  };
  s.note = () => (s.draft ? null : noteById(s.id));
  const opts = {
    // `extra`: a block shown at the end but not stored until something is typed (Quick Note's Add to Today line).
    blocks: extra ? [...clone(s.base), clone(extra)] : clone(s.base),
    placeholder: placeholderFor(note, draft),
    readOnly: s.readOnly,
    onChange: (blocks, info) => onChange(s, blocks, info),
    onSelectionChange: (sel) => (s.caret = sel?.blockId || null),
    linkProvider: (q) => linkProvider(q, s),
    onLinkActivate: (ref, ev) => activateRef(ref, ev),
    tagProvider: (prefix) => tagProvider(prefix),
    onCheckToggle: (blockId, checked) => onCheckToggle(s, blockId, checked),
    onSendToTasks: (blockIds) => sendToTasksDialog(s, blockIds),
    taskLookup: (taskId) => taskLookup(taskId),
    // Editor extras: per-note undo history, live chip labels, create-from-link, task circles in chips.
    noteId: s.id,
    // The text box is named after the note (kept up to date as its first line changes: liveTitle).
    label: main ? editorLabel(note ? displayTitle(note) : liveTitleOf(draft?.blocks) || (draft?.day ? longDay(draft.day) : '')) : 'Quick note',
    refLookup: (ref) => refLookup(ref),
    onCreateNote: (title) => createLinkedNote(title, s),
    onTaskToggle: (taskId) => toggleTaskFromChip(taskId),
  };
  try {
    s.editor = createEditor(host, opts);
  } catch (err) {
    console.error('ecosys notes: the editor failed to start', err);
    host.innerHTML = `<div class="n-editor-error">This note can't be shown right now.</div>`;
    s.editor = null;
  }
  // (Not once another note has replaced it in that frame: stepping quickly through days does that.)
  if (focus && s.editor && !s.readOnly) requestAnimationFrame(() => !s.closed && s.editor && safe(() => s.editor.focus(focus)));
  return s;
}

/** The block holding the caret in an editor showing this note (linked tasks don't overwrite it). */
function caretBlock(noteId) {
  for (const s of [session, quick]) {
    if (s && !s.closed && s.id === noteId && s.caret && s.editor?.element && document.activeElement === s.editor.element) return s.caret;
  }
  return null;
}

function placeholderFor(note, draft) {
  if (note && blocksOf(note).length) return '';
  const style = draft?.style || settings.get()?.notesNewStyle || 'h1';
  return style === 'p' ? 'Start typing' : 'Title';
}

function onChange(s, blocks, info = {}) {
  if (s.closed || s.readOnly) return;
  const now = Date.now();
  const n = s.note();
  // Version history: the state before the first edit after 5+ idle minutes, and before any single
  // change that removes 30% (or 2,000 characters) of the note.
  if (n && !s.edited && now - editedAt(n) >= IDLE_SNAPSHOT_MS) hist.snapshot(n, { blocks: s.base, reason: 'idle', by: n.editedBy });
  else if (n && s.lastEditAt && now - s.lastEditAt >= IDLE_SNAPSHOT_MS) hist.snapshot(n, { blocks: s.base, reason: 'idle', by: 'user' });
  if (n && info.kind !== 'type') {
    const before = charCount(s.base);
    const after = charCount(blocks);
    if (before - after >= 2000 || (before > 200 && after < before * 0.7)) hist.snapshot(n, { blocks: s.base, reason: 'bulk', by: 'user' });
  }
  if (!s.edited && s.main && n) flipNext = true; // the row glides to the top of Today once
  s.edited = true;
  s.lastEditAt = now;
  s.dirty = true;
  s.pending = blocks;
  if (s.main) {
    clearFindMarks();
    liveTitle(s, blocks);
  }
  clearTimeout(s.timer);
  s.timer = setTimeout(() => save(s), SAVE_MS);
}

function liveTitle(s, blocks) {
  const title = liveTitleOf(blocks) || (s.draft?.day ? longDay(s.draft.day) : 'New Note');
  const row = $(`#row-${CSS.escape(s.id)} .nrow-title, #row-${CSS.escape(s.id)} .ncard-title > .truncate`, listEl);
  if (row && row.textContent !== title) row.textContent = title;
  document.title = `${title} · notes`;
  const compact = $('.nt-compact', noteTopEl);
  if (compact) compact.textContent = title;
  const label = editorLabel(liveTitleOf(blocks));
  const ed = s.editor?.element;
  if (ed && ed.getAttribute('aria-label') !== label) ed.setAttribute('aria-label', label);
}
/** The note's text box is named after it: "Note: Groceries" ("New note" while it has no text). */
const editorLabel = (title) => (oneLine(title) ? `Note: ${oneLine(title).slice(0, 80)}` : 'New note');

/** Write the editor's blocks (or create the note from a draft). */
function save(s) {
  clearTimeout(s.timer);
  if (!s.dirty || s.readOnly) return;
  const blocks = s.pending || safe(() => s.editor?.getBlocks(), null);
  if (!Array.isArray(blocks)) return;
  s.dirty = false;
  s.pending = null;
  if (s.draft) {
    if (textSig(blocks) === textSig(s.draft.blocks)) return fits(s); // still only the template
    materialize(s, blocks);
    return;
  }
  if (!s.note()) return;
  // saveBlocks also renames / completes linked tasks and refreshes chip labels, so the stored blocks
  // can differ from ours (a repeating task's item unchecks itself): the editor takes those back.
  let over = null;
  const saved = tryWrite(() => core.saveBlocks(s.id, blocks, { by: 'user' }), (err) => (over = err));
  if (over) return tooLarge(s, over, blocks);
  fits(s);
  const stored = Array.isArray(saved?.blocks) ? saved.blocks : blocks;
  s.base = clone(stored);
  s.baseRev = saved?.rev ?? s.note()?.rev ?? null;
  s.baseAt = (saved || s.note())?.updatedAt ?? null;
  s.legacy = false;
  if (createdHere.has(s.id)) noteText(s.id, saved || s.note(), stored);
  if (stored !== blocks && !sameJson(stored, blocks) && s.editor && !s.dirty) showStored(s, stored);
}

/**
 * Put what the save stored into the editor, without an undo step: undoing it would re-apply the
 * check that completed a repeating task, and the next save would complete the task again. `force`:
 * the editor would otherwise ignore blocks equal to a version it sent moments ago (it takes them for
 * a late echo of its own typing), which is exactly what an item that unchecked itself looks like, and
 * a linked item left showing the old check would complete its task again on the next save.
 */
function showStored(s, stored) {
  safe(() => s.editor?.setBlocks(clone(stored), { keepSelection: true, record: false, force: true }));
}

/**
 * The note doesn't fit (note_too_large: over 5,000 blocks or 256 KB). Nothing was saved and nothing
 * was cut: the text stays in the editor, the next edit (or leaving the note) tries again, and a banner
 * says why until a save fits.
 */
function tooLarge(s, err, blocks) {
  s.dirty = true;
  s.pending = blocks;
  const msg = String(err?.message || 'This note is too long to save. Move some of it into a new note.');
  if (s.tooLarge === msg) return;
  s.tooLarge = msg;
  showTooLarge(s);
}
/** A save fitted again: the banner goes. */
function fits(s) {
  if (!s) return;
  s.kept = null; // text that didn't fit and was kept in version history: what is on screen now is saved
  if (!s.tooLarge) return;
  s.tooLarge = '';
  showTooLarge(s);
}
// Can version history keep copies in this browser (IndexedDB)? null until known. Where it can't, text
// too long to save is lost when you leave the note, and the banner and the toast say so.
let histOk = null;
hist.historyAvailable().then(
  (ok) => (histOk = !!ok),
  () => (histOk = false),
);
const NO_HISTORY = " Version history isn't available in this browser mode, so if you leave this note now, the changes that don't fit are lost.";
const tooLargeBanner = (msg) => `<div class="n-banner n-banner-err" role="alert">${icon(G.alert, { size: 16 })}<span class="grow">${esc(msg)}${histOk === false ? esc(NO_HISTORY) : ''}</span></div>`;
function showTooLarge(s) {
  if (s.closed) return;
  if (s === session) return renderBanners(s.note());
  const slot = s === quick && quickEl ? $('[data-quick-banner]', quickEl) : null;
  if (!slot) return;
  slot.innerHTML = s.tooLarge ? tooLargeBanner(s.tooLarge) : '';
  slot.hidden = !s.tooLarge;
}
/** An open editor on this note holds text too long to save (a revert or a leave sends it to version history). */
const unsavedOn = (id) => [session, quick].some((s) => s && !s.closed && s.id === id && !s.readOnly && !!s.tooLarge && s.dirty);
const KEPT_ASIDE = "The changes that didn't fit are in Version history.";
const LOST_ASIDE = "The changes that didn't fit are lost: Version history isn't available in this browser mode.";
const asideOf = () => (histOk === false ? LOST_ASIDE : KEPT_ASIDE);
/** A revert's toast, saying where the text too long to save that it replaced went (lost: see unsavedOn). */
const revertMsg = (msg, lost) => (lost ? `${msg}. ${asideOf()}` : msg);
/**
 * Leaving a note whose latest text didn't fit: the note keeps what it last saved, version history
 * keeps the rest, and a toast says so (or that it couldn't: no version history in this browser mode).
 * quiet: no toast (the tab is hidden, or a revert says it in its own toast). → true when the text is
 * in version history (or on its way there).
 */
function keepUnsaved(s, { quiet = false } = {}) {
  const n = s.note();
  const blocks = s.pending || safe(() => s.editor?.getBlocks(), null);
  const kept = !!n && Array.isArray(blocks) && histOk !== false;
  // A note made here that holds nothing of yours yet (closeSession puts it away unless the text is kept).
  const fresh = !n || (createdHere.has(n.id) && (!textSig(blocksOf(n)) || isTemplateOnly(n)));
  if (kept) {
    // One copy per text: hiding the tab again and again, or hiding it and then leaving, stores it once.
    if (!(s.kept && (s.kept === blocks || sameJson(s.kept, blocks)))) {
      s.kept = blocks;
      hist.snapshot(n, { blocks, reason: 'unsaved', by: 'user' }).then((rec) => {
        if (!rec && s.kept === blocks) s.kept = null; // a copy of the newest version, or not stored: check again next time
      });
    }
    // Its version history now holds text you wrote: from here on it is a real note, never put away as
    // a new note left empty (removed or purged from Recently Deleted, its history would go with it).
    createdHere.delete(n.id);
    lastText.delete(n.id);
    hadText.delete(n.id);
  }
  if (quiet) return kept;
  const title = n ? `“${displayTitle(n)}”` : '';
  toast(
    kept
      ? `Your latest changes to ${title} weren't saved: the note is too long. They're in Version history.`
      : fresh
        ? `Your new note wasn't saved: it's too long for one note.${histOk === false ? " Version history isn't available in this browser mode." : ''}`
        : `Your latest changes to ${title} weren't saved: the note is too long${histOk === false ? ", and Version history isn't available in this browser mode" : ''}.`,
    { duration: 10000 },
  );
  return kept;
}

/**
 * Notes made in this tab: what each last held, and whether it ever held more than a stray key or two.
 * One that did is moved to Recently Deleted when it is left empty (its version history stays with it);
 * one that didn't just goes.
 */
const lastText = new Map(); // id → the last stored blocks with text in them
const hadText = new Set();
function noteText(id, n, blocks) {
  const len = userTextLen(n, blocks);
  if (!len) return;
  lastText.set(id, blocks);
  if (len >= 8) hadText.add(id);
}
/** Characters typed into a note beyond its template (a daily note's date, a meeting note's headings). */
function userTextLen(n, blocks) {
  const tpl = n?.day ? dailyTemplate(n.day) : n?.event ? meetingTemplate(db.get('events', n.event.id)?.title || n.title || 'Meeting') : [];
  const skip = new Set(textSig(tpl).split('\n'));
  let len = 0;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const t = oneLine(blockText(b));
    if (t && !skip.has(`${b.t}|${b.ck ? 1 : 0}|${t}`)) len += t.length;
  }
  return len;
}
function flush(s) {
  if (!s || s.closed) return;
  if (s.dirty) save(s);
}

/**
 * First real edit of a draft: store it as a note (daily / meeting notes stay unique per day / event).
 * Too long for one note (note_too_large): nothing is cut and the text stays in the editor (see
 * tooLarge), but the note is still made, as the draft began (its template, title line or tag), so the
 * text has a note whose version history keeps it if you leave before it fits.
 */
function materialize(s, blocks) {
  const d = s.draft;
  let note = null;
  let over = null;
  const tooBig = (err) => (over = err);
  let merged = null; // ours added to a day's note someone else started: the editor shows the result
  if (d.day) {
    const existing = safe(() => core.dailyNote(d.day, { create: false }), null);
    if (existing && !existing.trashedAt) {
      // Someone (another tab, an AI) started this day's note meanwhile: add ours below theirs.
      const extra = blocks.filter((b) => !textSig([b]) || !textSig(blocksOf(existing)).includes(textSig([b])));
      merged = [...blocksOf(existing), ...extra];
      note = tryWrite(() => core.saveBlocks(existing.id, merged, { by: 'user' }), tooBig, existing);
    } else {
      const created = safe(() => core.dailyNote(d.day, { create: true }), null);
      note = created ? tryWrite(() => core.saveBlocks(created.id, blocks, { by: 'user' }), tooBig, created) : null;
    }
  } else if (d.event) {
    // meetingNote() files it in the Meeting notes folder (Settings) by itself.
    const created = safe(() => core.meetingNote(d.event.id, d.event.date, { create: true, title: d.event.title }), null);
    note = created ? tryWrite(() => core.saveBlocks(created.id, blocks, { by: 'user' }), tooBig, created) : null;
  } else {
    note = tryWrite(() => core.createNote({ folderId: d.folderId || null, blocks }), tooBig);
    if (!note && over) note = safe(() => core.createNote({ folderId: d.folderId || null, blocks: clone(d.blocks) }), null);
  }
  if (!note) {
    s.dirty = true; // keep it; try again on the next change
    s.pending = blocks;
    if (over) tooLarge(s, over, blocks);
    return;
  }
  const draftId = d.id;
  drafts.delete(draftId);
  createdHere.add(note.id);
  noteText(note.id, note, blocksOf(note));
  s.id = note.id;
  s.draft = null;
  // Whose first save didn't fit, the note holds what the draft began with (or, for a day's note
  // started elsewhere, theirs); merged into theirs, it holds both.
  s.base = clone(over || merged ? blocksOf(note) : blocks);
  s.baseRev = note.rev ?? null;
  s.baseAt = note.updatedAt ?? null;
  if (over) tooLarge(s, over, merged || blocks);
  else fits(s);
  // Theirs must show in the editor too: the next save sends what the editor holds, and would drop it.
  if (merged && s.editor) safe(() => s.editor.setBlocks(clone(over ? merged : blocksOf(note)), { keepSelection: true }));
  // Quick Note's "New note" picks this up again for a few minutes (never a day's note: see closeQuick).
  if (s === quick && !note.day && !note.event && s.mode !== 'today') {
    ui.lastQuickId = note.id;
    ui.lastQuickAt = Date.now();
    saveUi();
  }
  if (s.main) {
    state.noteId = note.id;
    rememberRecent(note.id);
    // The URL named the draft: point it at the stored note (no new history entry).
    if (!d.day && draftId !== note.id) {
      history.replaceState(history.state, '', noteHash(note.id));
      lastHash = location.hash;
    }
  }
  scheduleRender();
}

/**
 * Something else changed this note (another tab, sync, an AI, a linked task, a restore). force: a
 * deliberate revert (see showRevert): the editor shows it even if it equals a doc the editor sent
 * moments ago, and unsaved text that was too long to save gives way to it (version history keeps it;
 * the revert's own toast says so, see unsavedOn).
 */
function external(s, note, { force = false } = {}) {
  if (!s || s.closed || s.draft) return;
  if (!note) {
    s.gone = true;
    return;
  }
  if (note.trashedAt && !s.readOnly) {
    // Deleted elsewhere (or by the Undo of an AI edit that made the note, which says so itself): stop editing.
    flush(s);
    if (s.tooLarge && s.dirty) keepUnsaved(s, { quiet: force });
    s.readOnly = true;
    if (s.main) reopen();
    return;
  }
  const theirs = blocksOf(note);
  // The version the editor has (same rev and same write), or the same text: nothing to do.
  if (!force && ((note.rev != null && note.rev === s.baseRev && (note.updatedAt ?? null) === s.baseAt) || sameJson(theirs, s.base))) {
    s.baseRev = note.rev ?? s.baseRev;
    s.baseAt = note.updatedAt ?? s.baseAt;
    return;
  }
  if (!s.editor) return;
  if (force && s.dirty && s.tooLarge) {
    keepUnsaved(s, { quiet: true });
    clearTimeout(s.timer);
    s.dirty = false;
    s.pending = null;
  }
  const mine = s.dirty ? s.pending || safe(() => s.editor.getBlocks(), s.base) : null;
  if (mine && !sameJson(mine, s.base)) {
    const { blocks: merged, conflict } = mergeBlocks(s.base, mine, theirs, { withConflicts: true });
    hist.snapshot(note, { blocks: theirs, reason: 'remote', by: note.editedBy });
    safe(() => s.editor.setBlocks(merged, { keepSelection: true }));
    s.base = clone(theirs);
    s.baseRev = note.rev ?? null;
    s.baseAt = note.updatedAt ?? null;
    s.pending = merged;
    s.dirty = true;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => save(s), SAVE_MS);
    // Edits in different lines, or in different parts of one line, are simply both kept. Where both
    // changed the same words, yours stay on screen and theirs are in Version history: say so.
    if (isAiBy(note.editedBy)) toast(`${byLabel(note.editedBy)} also edited this note — their version is in Version history`, { duration: 6000 });
    else if (conflict) toast('This note also changed somewhere else — that version is in Version history', { duration: 6000 });
  } else {
    // Quick Note's Add to Today line stays below the day's note until something is typed in it.
    const blank = s.blankId && !theirs.some((b) => b.id === s.blankId) ? safe(() => s.editor.getBlocks(), []).find((b) => b.id === s.blankId && !oneLine(blockText(b))) : null;
    safe(() => s.editor.setBlocks(blank ? [...clone(theirs), blank] : clone(theirs), { keepSelection: true, force }));
    s.base = clone(theirs);
    s.baseRev = note.rev ?? null;
    s.baseAt = note.updatedAt ?? null;
    s.dirty = false;
    if (force) fits(s);
  }
}

/**
 * A deliberate revert of note `id` (AI review Undo, a version Restore, the Undo of either) was just
 * written: the open editors show it now (external's force), even when it brings back a doc an editor
 * sent moments ago, which it would otherwise keep back as a late echo of its own typing (the editor's
 * 3-second guard), and unsaved text too long to save gives way to it (version history keeps it). Done
 * right after the write, not from the store's change event: that event can come later (an Undo from a
 * toast or mod Z runs inside one db.batch, shell's trackChanges, and the store tells its listeners when
 * the batch ends), or not at all (a Restore of the version the note already holds writes nothing). The
 * event that follows finds the editors up to date.
 */
function showRevert(id) {
  const n = noteById(id);
  for (const s of [session, quick]) if (s && !s.closed && !s.draft && s.id === id) external(s, n, { force: true });
}

/** Leave a note: save it, put it away if it was left empty, and keep a snapshot of the session. */
function closeSession(s, { discard = true } = {}) {
  if (!s || s.closed) return;
  flush(s);
  // Its latest text still doesn't fit in a note: version history keeps it, and the note stays (where
  // there is no version history, nothing can keep it, and a new note left empty goes as usual).
  const unsaved = !!s.tooLarge && s.dirty && !s.readOnly;
  const kept = unsaved && keepUnsaved(s);
  s.closed = true;
  clearTimeout(s.timer);
  const n = s.note();
  if (n && discard && !kept && createdHere.has(n.id) && !n.trashedAt && (!textSig(blocksOf(n)) || isTemplateOnly(n))) {
    // A new note left empty. If it only ever held a stray key or two it just goes (it never reaches
    // Recently Deleted); one that held real text moves there with Undo, its version history intact.
    createdHere.delete(n.id);
    ui.recent = ui.recent.filter((x) => x !== n.id);
    saveUi();
    if (hadText.has(n.id)) retireEmptied(n);
    else safe(() => db.remove('notes', n.id));
    lastText.delete(n.id);
    hadText.delete(n.id);
  } else if (n) {
    // (Not when the latest text didn't fit: that copy, just kept, stays the newest version. s.kept: it
    // was kept a moment ago, as the note was deleted elsewhere and this editor became read-only.)
    if (s.edited && !unsaved && !s.kept) hist.snapshot(n, { reason: 'session', by: 'user' });
    // Left with text in it: from now on it is a real note, whatever happens to it later.
    if (createdHere.has(n.id) && userTextLen(n, blocksOf(n))) hadText.add(n.id);
  }
  if (s.draft) drafts.delete(s.draft.id);
  safe(() => s.editor?.destroy());
  s.editor = null;
}
/** Move a new note that was emptied to Recently Deleted. Undo brings it back with what it last held. */
function retireEmptied(n) {
  const id = n.id;
  const last = lastText.get(id) || null;
  // Version history keeps the last text whatever happens next (the note itself is empty now).
  if (last) hist.snapshot(n, { blocks: last, reason: 'bulk', by: 'user' });
  const t = Date.now();
  safe(() => db.update('notes', id, { trashedAt: t, trashedFrom: n.folderId || null, rev: (Number(n.rev) || 0) + 1 }));
  undoable(
    'Empty note moved to Recently Deleted',
    () => {
      const cur = noteById(id);
      if (!cur || cur.trashedAt !== t) return;
      db.batch(() => {
        safe(() => core.restoreNote(id));
        if (last) safe(() => core.saveBlocks(id, clone(last), { by: 'user' }));
      });
    },
    'delete note',
  );
}
function isTemplateOnly(n) {
  if (n.day) return textSig(blocksOf(n)) === textSig(dailyTemplate(n.day));
  if (n.event) {
    const ev = db.get('events', n.event.id);
    return textSig(blocksOf(n)) === textSig(meetingTemplate(ev?.title || n.title || 'Meeting'));
  }
  return false;
}

// ---------------------------------------------------------------- templates & drafts

const nb = (t, text = '', extra = {}) => safe(() => schema.newBlock(t, text, extra), { id: Math.random().toString(36).slice(2, 10), t, c: text ? [[text]] : [], ...extra });
const dailyTemplate = (day) => safe(() => schema.dailyNoteBlocks(day), null) || [nb('h1', longDay(day)), nb('p', '')];
const meetingTemplate = (title) => safe(() => schema.meetingNoteBlocks(title), null) || [nb('h1', title || 'Meeting notes'), nb('h3', 'Notes'), nb('p', ''), nb('h3', 'Action items'), nb('check', '', { ck: false, in: 0 })];

function makeDraft({ folderId = null, day = null, event = null, tag = null, title = '' } = {}) {
  const id = safe(() => core.newId?.(), null) || randomId();
  const style = ['h1', 'h2', 'p'].includes(settings.get()?.notesNewStyle) ? settings.get().notesNewStyle : 'h1';
  let blocks;
  if (day) blocks = dailyTemplate(day);
  else if (event) blocks = meetingTemplate(event.title);
  else {
    blocks = [nb(style, title)];
    if (title) blocks.push(nb('p', ''));
    if (tag) blocks.push(nb('p', `#${tag}`));
  }
  const d = { id, folderId: isId(folderId) ? folderId : null, day, event, tag, style, blocks, created: Date.now() };
  drafts.set(id, d);
  return d;
}
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/** "New note": in a folder view it goes there, in a tag view it gets the tag, else it goes to Notes. */
function newNote({ title = '', from = null } = {}) {
  // A search started in a folder creates the note there too.
  const v = from || state;
  const folderId = v.view === 'folder' && v.folderId !== 'notes' && folderById(v.folderId) ? v.folderId : null;
  const tag = v.view === 'tag' && v.tags?.length === 1 ? v.tags[0] : null;
  const name = oneLine(title).slice(0, 120);
  if (state.view === 'search' || qEl.value) {
    qEl.value = '';
    searchFrom = null;
  }
  // The new note shows in its own list: the folder, the tag, else All Notes.
  const ctx = folderId ? { ...state, view: 'folder', folderId } : tag ? { ...state, view: 'tag', tags: [tag], tagMode: 'all' } : { ...state, view: 'all' };
  if (quickEl) closeQuick();
  if (name) {
    // Named from search or the palette ("New note “…”"): it exists right away, caret on the line below.
    const style = ['h1', 'h2', 'p'].includes(settings.get()?.notesNewStyle) ? settings.get().notesNewStyle : 'h1';
    const body = nb('p', '');
    const blocks = [nb(style, name), body, ...(tag ? [nb('p', `#${tag}`)] : [])];
    const n = safe(() => core.createNote({ folderId, blocks }), null);
    if (n) {
      createdHere.add(n.id);
      noteText(n.id, n, blocksOf(n));
      pendingFocus = blocksOf(n).some((b) => b.id === body.id) ? { blockId: body.id, offset: 0 } : 'end';
      return nav(noteHash(n.id, { v: ctx }));
    }
  }
  const d = makeDraft({ folderId, tag, title: name });
  pendingFocus = name ? 'end' : 'start';
  nav(noteHash(d.id, { v: ctx }));
}
let pendingFocus = null;
// '-1' | '1' while a day header's Previous/Next day was pressed from the keyboard: the route that follows
// keeps the keyboard on that button in the new day's header (the day's note doesn't take the caret).
let keepDayStep = null;

// ---------------------------------------------------------------- the note column

/** Open whatever the route names in the main editor (or show the empty / multi-select state). */
function syncEditor() {
  let targetId = state.noteId;
  let draft = null;
  if (state.view === 'today' && state.day) {
    const dn = safe(() => core.dailyNote(state.day, { create: false }), null);
    if (dn && !dn.trashedAt) targetId = dn.id;
    else {
      draft = session?.draft?.day === state.day ? session.draft : [...drafts.values()].find((d) => d.day === state.day) || makeDraft({ day: state.day });
      targetId = draft.id;
    }
  } else if (targetId && drafts.has(targetId)) draft = drafts.get(targetId);
  const note = draft ? null : targetId ? noteById(targetId) : null;
  if (!draft && targetId && !note) targetId = null;
  // Same note: keep the editor, unless it was recovered from (or moved to) Recently Deleted.
  if (session && !session.closed && session.id === targetId && session.readOnly === !!note?.trashedAt) return false;
  if (session) closeSession(session);
  session = null;
  reviewing = false;
  stopFind();
  if (!targetId) {
    editorHost.replaceChildren();
    renderNoteChrome();
    return true;
  }
  const readOnly = !!note?.trashedAt;
  const focus = pendingFocus || (draft && !draft.day ? 'start' : null);
  pendingFocus = null;
  const hadNote = editorHost.childElementCount > 0;
  editorHost.replaceChildren();
  // A day's empty note takes the caret, unless the day was stepped to from the keyboard (see keepDayStep).
  const caret = draft?.event ? { blockId: draft.blocks.find((b) => b.t === 'p')?.id, offset: 0 } : draft?.day ? (keepDayStep ? null : 'end') : focus;
  session = openSession(editorHost, { note, draft, readOnly, focus: caret });
  if (note) rememberRecent(note.id);
  noteScrollEl.scrollTop = 0;
  renderNoteChrome();
  if (note?.aiPrev && !readOnly) revealAiChanges(note);
  // Desktop: switching notes cross-fades quickly.
  if (hadNote && cols() > 1 && !reduceMotion()) {
    pageEl.classList.remove('n-fade');
    void pageEl.offsetWidth;
    pageEl.classList.add('n-fade');
  }
  return true;
}
/** Re-open the current note (e.g. it was deleted elsewhere, so it becomes read-only). */
function reopen() {
  if (session) closeSession(session, { discard: false });
  session = null;
  syncEditor();
}

function renderNoteChrome() {
  const s = session;
  const n = s?.note() || null;
  const d = s?.draft || null;
  const multi = multiSel();
  // Several notes selected: the column shows their stack, and the open note's tools go with it (they
  // would edit a note that isn't on screen).
  shellEl.classList.toggle('no-note', !s || multi);
  noteEmptyEl.hidden = !!s && !multi;
  $('#notescroll').hidden = !s || multi;
  if (multi) noteEmptyEl.innerHTML = multiHtml();
  else if (!s) noteEmptyEl.innerHTML = noNoteHtml();
  if (multi) stopFind();
  renderNoteTop(n, d);
  renderBanners(n);
  renderLiveHead(n, d);
  renderCaption(n, d);
  renderBacklinks(n);
  renderNoteBar(n, d);
  if (state.info) renderInfo();
  const title = n ? displayTitle(n) : d ? liveTitleOf(safe(() => s.editor.getBlocks(), d.blocks)) || (d.day ? longDay(d.day) : 'New Note') : viewTitle();
  document.title = `${title} · notes`;
}
function noNoteHtml() {
  if (pendingNote) {
    const s = syncStatus();
    // Not connected (pairing, see shared/pair.js): the note comes with ecosys's copy once this browser is.
    const [head, text] =
      s === 'unpaired'
        ? ["This browser isn't connected yet", 'This note is in ecosys on this computer. Open the link shown where ecosys is running to connect this browser, and it opens here.']
        : s === 'offline'
          ? ['Waiting for ecosys', "This note isn't in this browser yet. It opens as soon as ecosys on this computer answers."]
          : ['Loading note…', 'Getting it from ecosys on this computer.'];
    return `<div class="empty n-empty" role="status"><div class="glyph">${icon('note')}</div><h3>${esc(head)}</h3><p>${esc(text)}</p></div>`;
  }
  // An empty list already offers "New note"; the note column stays quiet then.
  if (!listNoteIds.length && state.view !== 'search') return '';
  return `<div class="empty n-empty"><div class="glyph">${icon('note')}</div><h3>No note selected</h3><p>Pick a note from the list, or start a new one.</p><button type="button" class="btn btn-tint" data-new-note>New note</button></div>`;
}
function multiHtml() {
  const ids = [...state.sel];
  const stack = ids
    .slice(0, 3)
    .map((id, i) => {
      const n = noteById(id);
      return n ? `<div class="n-stackcard" style="--i:${i}"><div class="ncard-render">${cardHtml(n)}</div></div>` : '';
    })
    .join('');
  return `<div class="n-multi"><div class="n-stack" aria-hidden="true">${stack}</div><h3>${esc(plural(ids.length, 'note'))} selected</h3>
    <div class="n-multi-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-bulk="pin">${icon('pushpin', { size: 16 })}Pin</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk="move">${lic('move', { size: 16 })}Move</button>
      <button type="button" class="btn btn-secondary btn-sm" data-bulk="tag">${icon('hash', { size: 16 })}Add tag</button>
      <button type="button" class="btn btn-danger btn-sm" data-bulk="delete">${icon('trash', { size: 16 })}Delete</button>
    </div></div>`;
}

function breadcrumb(n, d) {
  if (d?.day || n?.day) return { label: 'Daily Notes', href: '#/day', color: null };
  const fid = n ? noteFolder(n) : d?.folderId;
  const f = folderById(fid);
  if (f) {
    const path = [];
    let x = f;
    const seen = new Set();
    while (x && !seen.has(x.id) && path.length < 4) {
      seen.add(x.id);
      path.unshift(x);
      x = folderById(x.parentId);
    }
    return { label: f.name, href: `#/folder/${encodeURIComponent(f.id)}`, color: f.color, path };
  }
  return { label: 'Notes', href: '#/folder/notes', color: null };
}

function renderNoteTop(n, d) {
  const c = cols();
  if (!session || multiSel()) {
    // A phone waiting for a linked note still has its way back to the list.
    const back = c === 1 && pendingNote ? `<div class="nt-left"><button type="button" class="n-back" data-back-to-list aria-label="Back to ${esc(viewTitle())}">${icon('chevron-left', { size: 22, stroke: 2.2 })}<span class="truncate">${esc(viewTitle())}</span></button></div>` : '';
    noteTopEl.innerHTML = c === 1 ? back : `<div class="nt-left"></div>`;
    return;
  }
  const crumb = breadcrumb(n, d);
  const trashed = !!n?.trashedAt;
  const back = c === 1 ? `<button type="button" class="n-back" data-back-to-list aria-label="Back to ${esc(viewTitle())}">${icon('chevron-left', { size: 22, stroke: 2.2 })}<span class="truncate">${esc(viewTitle())}</span></button>` : '';
  const histBtns =
    c > 1
      ? `<button type="button" class="icon-btn sm" data-hist="back" aria-label="Back" ${tipAttrs('Back', isMac ? 'alt mod [' : 'alt left')}>${icon('chevron-left', { size: 18 })}</button>
         <button type="button" class="icon-btn sm" data-hist="forward" aria-label="Forward" ${tipAttrs('Forward', isMac ? 'alt mod ]' : 'alt right')}>${icon('chevron-right', { size: 18 })}</button>`
      : '';
  const path = crumb.path?.length > 1 ? crumb.path : null;
  const crumbHtml =
    c > 1
      ? `<nav class="nt-crumb" aria-label="Folder">${
          path
            ? path.map((f, i) => `${i ? icon('chevron-right', { size: 12, cls: 'nt-crumbsep' }) : ''}<a href="#/folder/${esc(encodeURIComponent(f.id))}">${i === 0 ? `<span class="n-fd" style="background:${colorVar(f.color)}"></span>` : ''}${esc(f.name)}</a>`).join('')
            : `<a href="${esc(crumb.href)}">${crumb.color ? `<span class="n-fd" style="background:${colorVar(crumb.color)}"></span>` : ''}${esc(crumb.label)}</a>`
        }</nav>`
      : '';
  const tools = trashed
    ? ''
    : `${c > 1 ? `<button type="button" class="icon-btn" data-exec="checklist" aria-label="Checklist" ${tipAttrs('Checklist', isMac ? 'shift mod L' : 'mod alt 4')}>${icon('checklist')}</button>
       <button type="button" class="icon-btn n-aa" data-aa aria-label="Text styles" aria-haspopup="dialog" ${tipAttrs('Text styles')}>${aaGlyph(20)}</button>
       <button type="button" class="icon-btn" data-insert aria-label="Insert" aria-haspopup="menu" ${tipAttrs('Insert')}>${icon('plus')}</button>` : ''}
       <button type="button" class="icon-btn" data-share aria-label="Share" aria-haspopup="menu" ${tipAttrs('Share')}>${lic('share')}</button>`;
  noteTopEl.innerHTML = `<div class="nt-left">${back}${histBtns}${crumbHtml}</div>
    <div class="nt-compact truncate" aria-hidden="true">${esc(n ? displayTitle(n) : liveTitleOf(d?.blocks) || 'New Note')}</div>
    <span class="grow"></span>
    <div class="nt-actions">${tools}
      ${state.focusMode ? `<button type="button" class="icon-btn" data-focus-mode aria-label="Exit focus mode" ${tipAttrs('Exit focus mode', shiftMod('\\'))}>${lic('shrink')}</button>` : ''}
      <button type="button" class="icon-btn" data-note-menu aria-label="More" aria-haspopup="menu" ${tipAttrs('More')}>${icon('more')}</button>
    </div>`;
}

function renderBanners(n) {
  const out = [];
  if (storageBanner) out.push(storageBanner);
  if (session?.tooLarge && !session.closed) out.push(tooLargeBanner(session.tooLarge));
  if (n?.trashedAt) {
    out.push(`<div class="n-banner n-banner-trash" role="status">${icon('trash', { size: 16 })}<span class="grow">In Recently Deleted${sep}${esc(plural(daysLeft(n), 'day'))} left</span><button type="button" class="btn btn-ghost btn-sm n-danger-ghost" data-delete-now>Delete Now</button><button type="button" class="btn btn-tint btn-sm" data-recover>Recover</button></div>`);
  } else if (n?.aiPrev) {
    const by = byLabel(n.aiPrev.by || n.editedBy);
    const at = n.aiPrev.at || editedAt(n);
    out.push(`<div class="n-banner n-banner-ai" role="status">${icon(G.ai, { size: 16 })}<span class="grow">Edited by ${esc(by)}${sep}<span class="tnum">${esc(ago(at))}</span></span>
      <button type="button" class="btn btn-ghost btn-sm" data-ai="review" aria-pressed="${reviewing}">Review</button>
      <button type="button" class="btn btn-ghost btn-sm" data-ai="undo">Undo</button>
      <button type="button" class="btn btn-tint btn-sm" data-ai="keep">Keep</button></div>`);
  }
  const html = out.join('');
  if (bannersEl.dataset.h !== html) {
    bannersEl.innerHTML = html;
    bannersEl.dataset.h = html;
  }
}
let storageBanner = '';
let reviewing = false;

/** When a note was made: never after its last edit (sample notes carry an earlier edit date). */
const createdAt = (n) => (n?.createdAt && editedAt(n) ? Math.min(n.createdAt, editedAt(n)) : n?.createdAt || editedAt(n) || 0);
function renderCaption(n, d) {
  const ts = n ? editedAt(n) : d?.created || Date.now();
  const created = n ? createdAt(n) : null;
  const html = `<span ${created && n && Math.abs(created - ts) > 60000 ? tipAttrs(`Created ${longStamp(created)}`) : ''} tabindex="-1">${esc(longStamp(ts))}</span>${n && isAiBy(n.editedBy) ? `${sep}<span class="n-cap-ai">${icon(G.ai, { size: 12 })}${esc(byLabel(n.editedBy))}</span>` : ''}`;
  if (captionEl.dataset.h !== html) {
    captionEl.innerHTML = html;
    captionEl.dataset.h = html;
  }
}

function renderBacklinks(n) {
  // [{note, blockId, text}]: the linking notes with the block that links here (core.backlinkEntries).
  const list = n && !n.trashedAt ? (safe(() => core.backlinkEntries(n.id), []) || []).filter((x) => x?.note && !x.note.trashedAt && x.note.id !== n.id) : [];
  if (!list.length) {
    if (backlinksEl.dataset.h !== '') {
      backlinksEl.replaceChildren();
      backlinksEl.dataset.h = '';
    }
    return;
  }
  const items = list
    .slice(0, 50)
    .map(({ note: x, blockId, text }) => {
      const snippet = oneLine(text) || meta(x).preview;
      return `<li><a href="${esc(noteHash(x.id, { blockId, v: { ...state, view: 'all' } }))}" data-backlink="${esc(x.id)}"${blockId ? ` data-block="${esc(blockId)}"` : ''}><span class="bl-title truncate">${esc(displayTitle(x))}</span>${snippet ? `<span class="bl-snip truncate">${esc(snippet)}</span>` : ''}</a></li>`;
    })
    .join('');
  const html = `<button type="button" class="n-bl-head" data-toggle-backlinks aria-expanded="${!ui.backlinksCollapsed}">${icon('link', { size: 15 })}<span>Linked from ${esc(plural(list.length, 'note'))}</span>${icon('chevron-down', { size: 14, cls: 'n-bl-chev' })}</button>${ui.backlinksCollapsed ? '' : `<ul class="n-bl-list">${items}</ul>`}`;
  if (backlinksEl.dataset.h !== html) {
    backlinksEl.innerHTML = html;
    backlinksEl.dataset.h = html;
  }
}

/** Phone bottom toolbar on the note screen: Checklist · Aa · + · New note. */
function renderNoteBar(n, d) {
  if (cols() !== 1 || !session || n?.trashedAt) {
    if (noteBarEl.dataset.h !== '') {
      noteBarEl.replaceChildren();
      noteBarEl.dataset.h = '';
    }
    return;
  }
  const html = `<button type="button" class="n-barbtn" data-exec="checklist" aria-label="Checklist">${icon('checklist', { size: 22 })}</button>
    <button type="button" class="n-barbtn n-aa" data-aa aria-label="Text styles">${aaGlyph(22)}</button>
    <button type="button" class="n-barbtn" data-insert aria-label="Insert">${icon('plus', { size: 22 })}</button>
    <button type="button" class="n-barbtn" data-new-note aria-label="New note">${icon('edit', { size: 22 })}</button>`;
  if (noteBarEl.dataset.h !== html) {
    noteBarEl.innerHTML = html;
    noteBarEl.dataset.h = html;
  }
}

// ---------------------------------------------------------------- live headers (daily · meeting), never stored

function renderLiveHead(n, d) {
  const day = n?.day || d?.day || null;
  const ev = n?.event || d?.event || null;
  let html = '';
  if (day) html = dayHeadHtml(day);
  else if (ev) html = eventHeadHtml(ev);
  if (liveHeadEl.dataset.h !== html) {
    liveHeadEl.innerHTML = html;
    liveHeadEl.dataset.h = html;
  }
}

function dayPlan(day) {
  const inst = visibleOn(day);
  const today = todayYmd();
  const tasks = (db.all('tasks') || []).filter((t) => t && (t.date === day || t.deadline === day || (day === today && !t.done && ((t.date && t.date < today) || (t.deadline && t.deadline < today)))));
  tasks.sort((a, b) => !!a.done - !!b.done || String(a.time || '99').localeCompare(String(b.time || '99')) || (a.order ?? 0) - (b.order ?? 0));
  return { inst, tasks };
}
function dayHeadHtml(day) {
  const d = parseYmd(day);
  const isToday = day === todayYmd();
  const { inst, tasks } = dayPlan(day);
  const rows = [];
  for (const i of inst) {
    const color = colorVar(i.color);
    const time = i.allDay ? 'All day' : fmtTimeRange(i.start, i.end);
    rows.push(`<a class="dh-row" href="${esc(`${BASE}schedule/#/day/${i.occurrence}/event/${encodeURIComponent(i.event.id)}`)}"><span class="dh-bar" style="background:${color}"></span><span class="dh-time tnum">${esc(time)}</span><span class="dh-title truncate">${esc(i.event.title || 'Untitled event')}</span></a>`);
  }
  for (const t of tasks) {
    rows.push(`<div class="dh-row dh-task${t.done ? ' done' : ''}"><button type="button" class="check sm" role="checkbox" aria-checked="${!!t.done}" data-plan-task="${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Complete'}: ${esc(t.title || 'task')}">${icon('check')}</button><a class="dh-title truncate" href="${esc(`${BASE}tasks/#/task/${encodeURIComponent(t.id)}`)}">${esc(t.title || 'Untitled task')}</a>${t.time ? `<span class="dh-time tnum">${esc(fmtClock(t.time))}</span>` : t.date && t.date < day ? '<span class="dh-time dh-late">Overdue</span>' : ''}</div>`);
  }
  const shown = rows.slice(0, 6).join('');
  const more = rows.length > 6 ? `<div class="dh-more">${esc(`${rows.length - 6} more`)}${sep}<a href="${esc(`${BASE}schedule/#/day/${day}`)}">Open in Schedule</a>${sep}<a href="${esc(`${BASE}tasks/#/today`)}">Tasks</a></div>` : '';
  const empty = !rows.length ? `<div class="dh-empty">Nothing planned${sep}<a href="${esc(`${BASE}schedule/#/day/${day}`)}">Open in Schedule</a></div>` : '';
  const collapsed = ui.dayHeadCollapsed;
  return `<section class="n-dayhead${collapsed ? ' collapsed' : ''}" aria-label="${esc(`Plan for ${longDay(day)}`)}">
    <div class="dh-top">
      <div class="dh-tile" aria-hidden="true"><span class="dh-wd">${esc(fmt(d, { weekday: 'short' }).toUpperCase())}</span><span class="dh-dn tnum">${d.getDate()}</span></div>
      <div class="dh-name"><strong>${esc(isToday ? 'Today' : dayLabel(day, { long: true }))}</strong><span>${esc(fmt(d, { day: 'numeric', month: 'long', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }))}</span></div>
      <span class="grow"></span>
      <button type="button" class="icon-btn sm" data-day-step="-1" aria-label="Previous day" ${tipAttrs('Previous day')}>${icon('chevron-left', { size: 18 })}</button>
      <button type="button" class="icon-btn sm" data-day-cal aria-label="Choose a day" aria-haspopup="dialog" ${tipAttrs('Choose a day')}>${icon('calendar', { size: 18 })}</button>
      <button type="button" class="icon-btn sm" data-day-step="1" aria-label="Next day" ${tipAttrs('Next day')}>${icon('chevron-right', { size: 18 })}</button>
      <button type="button" class="icon-btn sm dh-fold" data-day-fold aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Show' : 'Hide'} the plan">${icon('chevron-down', { size: 16 })}</button>
    </div>
    ${collapsed ? '' : `<div class="dh-plan"><div class="dh-label">${isToday ? "Today's plan" : 'Plan'}</div>${shown}${more}${empty}</div>`}
  </section>`;
}

// Event lookups for chips, the day plan and meeting-note headers. A note can hold a hundred chips, each
// on a day of its own, and every save re-renders them, so nothing here expands every event for each day
// it is asked about (eventInstances takes ~15 ms a call with 3,000 events, whatever the days): an event
// chip works out its one event alone (occurrenceOn), and a day's list comes from an index of the events
// made in one pass (eventIndex). Both are kept until an event or a calendar changes (clearEventMemo,
// from the store listener).
const dayMemo = new Map(); // ymd → that day's instances
let dayIndex = null;
let calMemo = null;
function clearEventMemo() {
  dayMemo.clear();
  dayIndex = null;
  calMemo = null;
  pickerMemo = null;
}
const cals = () => (calMemo ??= safe(() => calendarMap(), new Map()) || new Map());
let pickerMemo = null;
/** Events 30 days either side of today, for the [[ picker (kept while you type in it). */
function pickerEvents(today) {
  if (pickerMemo?.today !== today) pickerMemo = { today, list: safe(() => eventInstances(addDaysYmd(today, -30), addDaysYmd(today, 30)), []) || [] };
  return pickerMemo.list;
}
/** 'YYYY-MM-DD' `n` days from `s`, by the calendar alone (no clock involved, so no time zone or DST either). */
function shiftYmd(s, n) {
  const out = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n)).toISOString().slice(0, 10);
  return isYmd(out) ? out : n < 0 ? '1000-01-01' : '9999-12-31';
}
const SPREAD_DAYS = 62; // a single event is filed under each of its days up to this many; a longer one is checked on every day
/**
 * Every event, filed in one pass: a single event under each day from its start date to its end date (the
 * model shows it on no other), a longer one and every series apart. `i` is the event's place among all
 * events, so a day lists its instances in the model's order.
 */
function eventIndex() {
  if (dayIndex) return dayIndex;
  const byDay = new Map();
  const long = [];
  const series = [];
  const file = (d, x) => {
    const l = byDay.get(d);
    if (l) l.push(x);
    else byDay.set(d, [x]);
  };
  const list = db.all('events') || [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (typeof e?.start !== 'string' || typeof e.end !== 'string' || e.start.length < 10 || e.end.length < 10) continue;
    const x = { e, i, a: e.start.slice(0, 10), b: e.end.slice(0, 10), span: null };
    if (e.repeat) series.push(x);
    else if (x.a === x.b) file(x.a, x);
    else if (!isYmd(x.a) || !isYmd(x.b) || shiftYmd(x.a, SPREAD_DAYS) < x.b) long.push(x);
    else for (let d = x.a; d <= x.b; d = shiftYmd(d, 1)) file(d, x);
  }
  return (dayIndex = { byDay, long, series });
}
/**
 * Every instance on a day, hidden calendars included: what eventInstances(day, day, {includeHidden: true})
 * gives, in its order, from the day's own events and each series' occurrences next to it only.
 */
function instancesOn(day) {
  let list = dayMemo.get(day);
  if (!list) {
    if (dayMemo.size > 1000) dayMemo.clear();
    list = safe(() => dayInstances(day), []) || [];
    dayMemo.set(day, list);
  }
  return list;
}
function dayInstances(day) {
  const { byDay, long, series } = eventIndex();
  const hits = [];
  const add = (x, d) => {
    const at = instanceAt(x.e, d, x.a, x.b);
    if (at && at.first <= day && at.last >= day) hits.push([at.inst, x.i]);
  };
  for (const x of byDay.get(day) || []) add(x, x.a);
  for (const x of long) if (x.a <= day && day <= x.b) add(x, x.a);
  for (const x of series) {
    // As the model looks for them: the occurrences that start up to the series' length before the day
    // (a series that can't be read costs only its own instances).
    x.span ??= Math.max(0, diffDays(x.a, x.b));
    const dates = safe(() => occurrencesBetween(x.e.repeat, x.a, x.span ? shiftYmd(day, -x.span) : day, day, { exdates: x.e.exdates, until: x.e.until }), []) || [];
    for (const d of dates) add(x, d);
  }
  hits.sort(([p, i], [q, j]) => p.start - q.start || q.end - p.end || i - j);
  return hits.map((h) => h[0]);
}
/**
 * Event `e`'s instance on date `d` (startDate/endDate: its own first and last date), made the way
 * eventInstances makes them ({key, event, occurrence, start, end, allDay, calendar, color}), with the first
 * and last day it touches; null for a time that can't be read. A series keeps its clock time on every
 * date (also across DST) and its length by the clock.
 */
function instanceAt(e, d, startDate, endDate) {
  let start;
  let end;
  if (e.allDay) {
    start = parseYmd(d);
    end = addDays(parseYmd(endDate), diffDays(startDate, d));
  } else {
    start = parseDT(`${d}${e.start.slice(10)}`);
    const wall = diffDays(startDate, endDate) * 1440 + toMinutes(e.end.slice(11, 16)) - toMinutes(e.start.slice(11, 16));
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + wall);
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const cal = cals().get(e.calendarId);
  return {
    inst: { key: `${e.id}@${d}`, event: e, occurrence: d, start, end, allDay: !!e.allDay, calendar: cal, color: cal?.color || 'iris' },
    first: ymd(start),
    last: e.allDay ? ymd(end) : ymd(new Date(end.getTime() - 1)),
  };
}
/** The day's instances on calendars that are shown (what Schedule shows that day). */
const visibleOn = (day) => instancesOn(day).filter((i) => i.calendar?.visible !== false);
/**
 * Event `e`'s occurrence that starts on `day` (an instance as eventInstances makes them), or null when it
 * has none that day. One event only, the same rules as the model.
 */
function occurrenceOn(e, day) {
  if (typeof e?.start !== 'string' || typeof e?.end !== 'string' || !isYmd(day)) return null;
  const startDate = e.start.slice(0, 10);
  const endDate = e.end.slice(0, 10);
  if (e.repeat) {
    const dates = safe(() => occurrencesBetween(e.repeat, startDate, day, day, { exdates: e.exdates, until: e.until }), []) || [];
    if (!dates.includes(day)) return null;
  } else if (startDate !== day) return null;
  return instanceAt(e, day, startDate, endDate)?.inst || null;
}
/**
 * A linked event (a chip's event:<id>@<date>, a meeting note's {id, date}) as it is now: {e, date, inst,
 * color}. The event moved since the link was made: a single event shows its new date; a repeating one
 * whose occurrence was moved on its own ("This event") shows that copy (seriesId + occurrence, as
 * Schedule's meeting notes follow it). Null when the event is gone.
 */
function eventInfo(ref) {
  let e = isId(ref?.id) ? db.get('events', ref.id) : null;
  if (!e) return null;
  const at = isYmd(ref.date) ? ref.date : String(e.start || '').slice(0, 10);
  let date = at;
  let inst = occurrenceOn(e, at);
  if (!inst) {
    const copy = e.repeat && (e.exdates || []).includes(at) ? (db.all('events') || []).find((x) => x?.seriesId === e.id && x.occurrence === at) : null;
    if (copy) e = copy;
    if (copy || !e.repeat) {
      date = String(e.start || '').slice(0, 10) || at;
      inst = occurrenceOn(e, date);
    }
  }
  return { e, date, inst, color: inst?.color || cals().get(e.calendarId)?.color || 'iris' };
}
function eventHeadHtml(ref) {
  const info = eventInfo(ref);
  if (!info) return `<section class="n-evhead gone" aria-label="Linked event"><span class="eh-bar"></span><div class="eh-main"><strong>Event deleted</strong><span>The meeting notes stay here.</span></div></section>`;
  const { e, date, inst, color } = info;
  const time = eventTime(info);
  const place = e.location ? esc(e.location) : '';
  // The note's title says what the meeting is (the event's name to begin with): the card shows when and where.
  return `<section class="n-evhead" aria-label="${esc(`Linked event: ${e.title || 'Untitled event'}`)}"><span class="eh-bar" style="background:${colorVar(color)}"></span>
    <div class="eh-main"><strong class="truncate">${esc(fmt(parseYmd(date), { weekday: 'long', day: 'numeric', month: 'long', ...(parseYmd(date).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }))}</strong><span class="truncate"><span class="tnum">${esc(time)}</span>${place ? `${sep}${place}` : ''}</span></div>
    <a class="btn btn-ghost btn-sm" href="${esc(`${BASE}schedule/#/day/${date}/event/${encodeURIComponent(e.id)}`)}">Open in Schedule</a></section>`;
}
/** '9:30 – 9:45am', 'All day': a linked event's time on its date. */
function eventTime({ e, inst }) {
  if (inst) return inst.allDay ? 'All day' : fmtTimeRange(inst.start, inst.end);
  return e.allDay ? 'All day' : fmtTimeRange(String(e.start).slice(11, 16), String(e.end).slice(11, 16));
}
/** 'Sun, Nov 22 · 9:30 – 9:45am · Zoom': a meeting note's line in the list while it holds only the template. */
function meetingLine(ref) {
  const info = eventInfo(ref);
  if (!info) return '';
  const day = fmt(parseYmd(info.date), { weekday: 'short', day: 'numeric', month: 'short' });
  return [day, eventTime(info), oneLine(info.e.location)].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- AI review

/** Block ids that differ between the AI's version and the copy from before it. */
function aiChangedIds(n) {
  const prev = new Map((n.aiPrev?.blocks || []).map((b) => [b.id, JSON.stringify(b)]));
  return new Set(blocksOf(n).filter((b) => prev.get(b.id) !== JSON.stringify(b)).map((b) => b.id));
}
function blockEl(id) {
  if (!isId(id)) return null;
  const e = CSS.escape(id);
  return editorHost.querySelector(`[data-block-id="${e}"], [data-block="${e}"], [data-bid="${e}"], [data-id="${e}"]`);
}
/** Delight: changed blocks get a violet margin bar that fades out over four seconds. */
function revealAiChanges(n) {
  if (reduceMotion()) return;
  requestAnimationFrame(() => {
    // Bars live in their own layer beside the text, so the editor's layout is never touched.
    $('.n-ai-bars', pageEl)?.remove();
    const base = pageEl.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'n-ai-bars';
    layer.setAttribute('aria-hidden', 'true');
    for (const id of aiChangedIds(n)) {
      const r = blockEl(id)?.getBoundingClientRect();
      if (!r || !r.height) continue;
      const bar = document.createElement('span');
      bar.style.top = `${Math.round(r.top - base.top)}px`;
      bar.style.height = `${Math.round(r.height)}px`;
      bar.style.left = `${Math.max(2, Math.round(r.left - base.left) - 12)}px`;
      layer.append(bar);
    }
    if (!layer.childElementCount) return;
    pageEl.append(layer);
    setTimeout(() => layer.remove(), 4300);
  });
}
function setReviewTint(on) {
  reviewing = on;
  for (const el of $$('.n-ai-tint', editorHost)) el.classList.remove('n-ai-tint');
  const n = session?.note();
  if (on && n?.aiPrev) for (const id of aiChangedIds(n)) blockEl(id)?.classList.add('n-ai-tint');
  renderBanners(n);
}
async function reviewAi(kind) {
  if (!session?.note()?.aiPrev) return;
  if (kind === 'review') return setReviewTint(!reviewing);
  flush(session);
  const id = session.id;
  let n = noteById(id);
  if (!n?.aiPrev) return;
  const who = byLabel(n.aiPrev.by || n.editedBy);
  if (kind === 'undo') {
    // Undo puts back the note as it was before the AI edit: whatever you typed since goes too (also
    // text too long to save, which is still only in the editor).
    if (n.editedBy === 'user' || unsavedOn(id)) {
      const ok = await confirmDialog({
        title: `Undo ${who}'s edit?`,
        message: `Your changes since ${who}'s edit will be undone too. ${histOk === false ? (unsavedOn(id) ? LOST_ASIDE : '') : 'They stay in Version history.'}`.trim(),
        confirm: 'Undo Edit',
      });
      if (!ok) return;
      if (session?.id === id) flush(session);
      n = noteById(id);
      if (!n?.aiPrev) return;
    }
    const before = clone(n);
    hist.snapshot(n, { reason: 'ai', by: n.editedBy });
    const lost = unsavedOn(id);
    safe(() => core.reviewAiEdit(id, 'undo'));
    showRevert(id);
    undoable(
      revertMsg(`Undid ${who}'s edit`, lost),
      () => {
        if (session?.id === id) flush(session);
        const gone = unsavedOn(id);
        const cur = noteById(id);
        db.put('notes', { ...before, rev: Math.max(Number(cur?.rev) || 0, Number(before.rev) || 0) + 1 });
        showRevert(id);
        if (gone) toast(asideOf(), { duration: 8000 });
        // A note the AI had created went to Recently Deleted: its editor opens for writing again.
        if (session?.id === id && session.readOnly && !noteById(id)?.trashedAt) reopen();
      },
      'undo AI edit',
    );
  } else {
    safe(() => core.reviewAiEdit(id, 'keep'));
    toast('Kept the AI edit');
  }
  reviewing = false;
  scheduleRender();
}

// ---------------------------------------------------------------- editor callbacks: links, tags, tasks

function taskLookup(id) {
  const t = isId(id) ? db.get('tasks', id) : null;
  return t ? { title: t.title || '', done: !!t.done, date: t.date || null, repeat: t.repeat || null } : null;
}

/** `[[` / `>>` picker: recent notes when empty, else notes by title, then open tasks, events (±30 days), create. */
async function linkProvider(query, s) {
  const q = oneLine(query);
  const self = s?.id;
  const notes = liveNotes().filter((n) => n.id !== self);
  const out = [];
  if (!q) {
    sortNotes(notes, 'edited', 'desc');
    for (const n of notes.slice(0, 6)) out.push({ kind: 'note', id: n.id, title: displayTitle(n), sub: listDate(editedAt(n)), ref: `note:${n.id}` });
    return out;
  }
  const scored = notes
    .map((n) => ({ n, s: score(displayTitle(n), q) }))
    .filter((x) => x.s)
    .sort((a, b) => b.s - a.s || editedAt(b.n) - editedAt(a.n))
    .slice(0, 8);
  for (const { n } of scored) out.push({ kind: 'note', id: n.id, title: displayTitle(n), sub: folderById(noteFolder(n))?.name || (n.day ? 'Daily Notes' : 'Notes'), ref: `note:${n.id}` });
  const tasks = (db.all('tasks') || [])
    .filter((t) => t && !t.done && score(t.title, q))
    .sort((a, b) => score(b.title, q) - score(a.title, q))
    .slice(0, 5);
  for (const t of tasks) out.push({ kind: 'task', id: t.id, title: t.title || 'Untitled task', sub: t.date ? dayLabel(t.date) : 'Task', ref: `task:${t.id}` });
  const today = todayYmd();
  const evs = pickerEvents(today)
    .filter((i) => score(i.event.title, q))
    .sort((a, b) => Math.abs(diffDays(today, a.occurrence)) - Math.abs(diffDays(today, b.occurrence)))
    .slice(0, 5);
  for (const i of evs) out.push({ kind: 'event', id: i.event.id, title: i.event.title || 'Untitled event', sub: `${dayLabel(i.occurrence)}${i.allDay ? '' : ` ${fmtClock(i.start)}`}`, ref: `event:${i.event.id}@${i.occurrence}` });
  const parsed = safe(() => nlpParse(q, { mode: 'task' }), null);
  if (parsed?.date && isYmd(parsed.date) && !parsed.title) out.push({ kind: 'day', id: parsed.date, title: dayLabel(parsed.date), sub: 'Daily note', ref: `day:${parsed.date}` });
  if (!scored.some(({ n }) => displayTitle(n).toLowerCase() === q.toLowerCase())) out.push({ kind: 'create', id: '', title: q, sub: 'New note', ref: null });
  return out;
}
/** "Create note “X”" from the link picker: makes the note now, you stay where you are. */
function createLinkedNote(title, s) {
  const t = oneLine(title).slice(0, 120);
  if (!t) return null;
  // A note with that exact title already exists: link to it instead of making a twin.
  const same = noteByTitle(t);
  if (same) return { kind: 'note', id: same.id, title: same.title, ref: `note:${same.id}` };
  const folderId = s?.draft ? s.draft.folderId || null : s?.note?.()?.folderId ?? null;
  const n = safe(() => core.createNote({ folderId: folderId && folderById(folderId) ? folderId : null, blocks: [nb('h1', t), nb('p', '')] }), null);
  if (!n) return null;
  toast(`Created “${t}”`, { action: 'Open', onAction: () => openNote(n.id) });
  return { kind: 'note', id: n.id, title: t, ref: `note:${n.id}` };
}
function tagProvider(prefix) {
  const p = normTag(prefix);
  return tagCounts()
    .filter((t) => String(t.tag).toLowerCase().startsWith(p) && String(t.tag).toLowerCase() !== p)
    .slice(0, 8)
    .map((t) => t.label || t.tag);
}

/**
 * Checking a task-linked item completes the task too (one object, two views): the save does it
 * (saveBlocks pushes checks to linked tasks), so save now. A repeating task moves to its next date
 * and its item unchecks itself.
 */
function onCheckToggle(s, blockId, checked) {
  if (s.closed || s.readOnly) return;
  const blocks = s.pending || safe(() => s.editor.getBlocks(), []);
  const b = blocks.find((x) => x.id === blockId);
  if (!b?.task) return;
  const before = clone(db.get('tasks', b.task));
  if (!before) return;
  // Completing a repeating task files a completed copy of it (repeatOf): Undo removes that copy too.
  const copiesOf = () => (db.all('tasks') || []).filter((t) => t?.repeatOf === before.id).map((t) => t.id);
  const had = new Set(copiesOf());
  if (!s.dirty) {
    s.dirty = true;
    s.pending = blocks;
  }
  save(s);
  const after = db.get('tasks', b.task);
  if (checked && !before.done) playDing();
  if (checked && before.repeat && after && !after.done && after.date && after.date !== before.date) {
    const added = copiesOf().filter((id) => !had.has(id));
    undoable(
      `Next: ${dayLabel(after.date)}`,
      () =>
        db.batch(() => {
          for (const id of added) if (db.get('tasks', id)) db.remove('tasks', id);
          db.put('tasks', before);
        }),
      'complete task',
    );
  }
}

// ---------------------------------------------------------------- chips (note · task · event · date)

/**
 * A chip or link was activated: the editor's card asked to open it (or Mod-click), to recover a
 * deleted note, or to check a task. ev is the click, or {action:'recover'|'toggle'}.
 */
function activateRef(ref, ev) {
  const r = String(ref || '');
  const action = ev?.action || 'open';
  let m;
  if ((m = /^note:([A-Za-z0-9_-]{1,40})(?:#([A-Za-z0-9_-]{1,40}))?$/.exec(r))) {
    const n = noteById(m[1]);
    if (!n) return toast('That note was deleted.');
    if (action === 'recover' || n.trashedAt) {
      if (action === 'recover') recover(n.id);
      else return toast('That note is in Recently Deleted.', { action: 'Recover', onAction: () => recover(n.id) });
    }
    return openNote(n.id, { blockId: m[2] || null });
  }
  if ((m = /^task:([A-Za-z0-9_-]{1,40})$/.exec(r))) {
    if (action === 'toggle') return toggleTaskFromChip(m[1]);
    if (!db.get('tasks', m[1])) return toast('That task was deleted.');
    return void (location.href = `${BASE}tasks/#/task/${encodeURIComponent(m[1])}`);
  }
  if ((m = /^event:([A-Za-z0-9_-]{1,40})(?:@(\d{4}-\d{2}-\d{2}))?$/.exec(r))) {
    const info = eventInfo({ id: m[1], date: m[2] });
    if (!info) return toast('That event was deleted.');
    // The event as it is now: an occurrence moved on its own opens its copy (Schedule finds it by id and day).
    return void (location.href = `${BASE}schedule/#/day/${info.date}/event/${encodeURIComponent(info.e.id)}`);
  }
  if ((m = /^day:(\d{4}-\d{2}-\d{2})$/.exec(r)) && isYmd(m[1])) return nav(`#/day/${m[1]}`);
}
/** The task circle in a chip (or its card) checks the task in place. */
function toggleTaskFromChip(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const was = !!t.done;
  const undo = toggleTask(id);
  if (!was) playDing();
  const next = db.get('tasks', id);
  undoable(!was && t.repeat && next?.date ? `Next: ${dayLabel(next.date)}` : was ? 'Marked not done' : 'Task completed', undo, 'complete task');
}
/** Live labels for chips: {title, sub, color, missing, trashed}. */
function refLookup(ref) {
  const r = String(ref || '');
  let m;
  if ((m = /^note:([A-Za-z0-9_-]{1,40})/.exec(r))) {
    const n = noteById(m[1]);
    if (!n) return { missing: true };
    return { title: displayTitle(n), sub: n.trashedAt ? 'In Recently Deleted' : folderById(noteFolder(n))?.name || (n.day ? 'Daily Notes' : 'Notes'), trashed: !!n.trashedAt };
  }
  if ((m = /^event:([A-Za-z0-9_-]{1,40})(?:@(\d{4}-\d{2}-\d{2}))?$/.exec(r))) {
    const info = eventInfo({ id: m[1], date: m[2] });
    if (!info) return { missing: true };
    const { e, date, inst, color } = info;
    const time = inst && !inst.allDay ? fmtClock(inst.start) : '';
    return { title: e.title || 'Untitled event', sub: `${fmt(parseYmd(date), { weekday: 'short', day: 'numeric', month: 'short' })}${time ? ` ${time}` : ''}`, color };
  }
  if ((m = /^day:(\d{4}-\d{2}-\d{2})$/.exec(r)) && isYmd(m[1])) {
    const day = m[1];
    let sub;
    return {
      title: fmt(parseYmd(day), { weekday: 'long', day: 'numeric', month: 'long' }),
      // A day chip shows its date alone: the day's events are counted when its card asks for them, so
      // a note full of day chips costs nothing more to open.
      get sub() {
        if (sub === undefined) {
          const n = visibleOn(day).length;
          const rel = dayLabel(day);
          sub = n ? `${rel}, ${plural(n, 'event')}` : rel;
        }
        return sub;
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------- Send to Tasks

function sendToTasksDialog(s, blockIds) {
  flush(s);
  if (s.draft) save(s);
  const n = s.note();
  if (!n) return toast('Type something first, then send it to Tasks.');
  const blocks = blocksOf(n).filter((b) => blockIds.includes(b.id) && oneLine(blockText(b)) && !b.task);
  if (!blocks.length) return toast(blockIds.length ? 'Those items are already in Tasks.' : 'Select checklist items to send.');
  const lists = [...(db.all('lists') || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const options = [{ value: 'inbox', label: 'Inbox', icon: 'inbox' }, ...lists.map((l) => ({ value: l.id, label: l.name, color: l.color }))];
  const value = options.some((o) => o.value === ui.lastTaskList) ? ui.lastTaskList : 'inbox';
  const preview = blocks
    .slice(0, 6)
    .map((b) => {
      const p = safe(() => nlpParse(blockText(b), { mode: 'task', lists }), null) || {};
      const chips = [p.date ? `<span class="chip accent">${icon('calendar', { size: 12 })}${esc(dayLabel(p.date))}${p.time ? ` ${esc(fmtClock(p.time))}` : ''}</span>` : '', p.repeat ? `<span class="chip">${icon('repeat', { size: 12 })}Repeats</span>` : ''].join('');
      return `<li><span class="check sm" aria-hidden="true"></span><span class="truncate">${esc(p.title || blockText(b))}</span>${chips}</li>`;
    })
    .join('');
  openModal({
    title: `Send ${plural(blocks.length, 'item')} to Tasks`,
    className: 'n-sendmodal',
    body: `<form class="modal-body n-send" novalidate>
      <ul class="n-send-list">${preview}${blocks.length > 6 ? `<li class="faint">${esc(`${blocks.length - 6} more`)}</li>` : ''}</ul>
      <div class="n-field"><span class="n-label" id="send-list-l">List</span>${selectField({ name: 'list', value, options, ariaLabel: 'List' })}</div>
      <p class="faint n-hint">Dates and repeats in the text are understood (“tomorrow 9am”, “every friday”).</p>
      <div class="n-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Send</button></div>
    </form>`,
    onMount: (el, close) => {
      $('form', el).addEventListener('submit', (e) => {
        e.preventDefault();
        const listId = $('[name="list"]', el).value || 'inbox';
        ui.lastTaskList = listId;
        saveUi();
        const made = safe(() => core.sendBlocksToTasks(n.id, blocks.map((b) => b.id), { listId: listId === 'inbox' ? null : listId }), []) || [];
        close();
        if (!made.length) return toast('Could not send those items.');
        toast(`Sent ${plural(made.length, 'item')} to Tasks`, { action: 'Open', onAction: () => (location.href = `${BASE}tasks/#/task/${encodeURIComponent(made[0].id)}`) });
      });
    },
  });
}

// ---------------------------------------------------------------- note actions

function openNote(id, { blockId = null, v = null, replace = false } = {}) {
  const n = noteById(id);
  if (!n) return;
  let ctx = v || state;
  // Stay in the current list when the note belongs to it; otherwise show it in All Notes (or Today).
  if (!v) {
    const inView = ctx.view === 'search' || viewNotes(ctx).some((x) => x.id === id);
    if (!inView) ctx = n.trashedAt ? { ...state, view: 'trash' } : n.day ? { ...state, view: 'today' } : { ...state, view: 'all' };
  }
  state.sel.clear();
  nav(noteHash(id, { blockId, v: ctx }), { replace });
}

function togglePin(ids) {
  const list = ids.map(noteById).filter((n) => n && !n.trashedAt);
  if (!list.length) return;
  const on = list.some((n) => !n.pinned);
  flipNext = true;
  db.batch(() => list.forEach((n) => safe(() => core.setPinned(n.id, on))));
  undoable(on ? (list.length > 1 ? `Pinned ${list.length} notes` : 'Pinned') : list.length > 1 ? `Unpinned ${list.length} notes` : 'Unpinned', () => db.batch(() => list.forEach((n) => safe(() => core.setPinned(n.id, n.pinned)))), on ? 'pin' : 'unpin');
}

/** After deleting from the list, keep the keyboard there (the focused row itself is gone). */
function refocusList(had) {
  if (had) requestAnimationFrame(() => focusList());
}
function trash(ids, { silent = false } = {}) {
  const list = ids.map(noteById).filter((n) => n && !n.trashedAt);
  if (!list.length) return;
  const hadFocus = listEl.contains(document.activeElement);
  if (session && list.some((n) => n.id === session.id)) flush(session);
  // Empty notes are discarded rather than kept in Recently Deleted (core does that, with undo too).
  const undo = safe(() => core.trashNotes(list.map((n) => n.id)), null);
  state.sel.clear();
  const openGone = list.some((n) => n.id === state.noteId);
  if (openGone) {
    const next = nextAfter(list.map((n) => n.id));
    if (cols() > 1 && next) openNote(next, { replace: true });
    else nav(listHash(), { replace: cols() > 1 });
  }
  refocusList(hadFocus);
  if (!silent && typeof undo === 'function') undoable(list.length > 1 ? `Deleted ${list.length} notes` : 'Note deleted', () => safe(undo), list.length > 1 ? 'delete notes' : 'delete note');
}
/** The note shown after deleting: the next one in the list, else the previous. */
function nextAfter(ids) {
  const gone = new Set(ids);
  const i = listNoteIds.findIndex((x) => gone.has(x));
  if (i < 0) return null;
  for (let j = i + 1; j < listNoteIds.length; j++) if (!gone.has(listNoteIds[j])) return listNoteIds[j];
  for (let j = i - 1; j >= 0; j--) if (!gone.has(listNoteIds[j])) return listNoteIds[j];
  return null;
}
function recover(id) {
  const n = noteById(id);
  if (!n?.trashedAt) return;
  safe(() => core.restoreNote(id));
  const r = noteById(id);
  const f = folderById(r?.folderId);
  toast(`Recovered to ${f ? f.name : r?.day ? 'Daily Notes' : 'Notes'}`, { action: 'Show', onAction: () => openNote(id, { v: { ...state, view: f ? 'folder' : r?.day ? 'today' : 'folder', folderId: f ? f.id : 'notes' } }) });
  if (state.view === 'trash' && state.noteId === id) {
    // Show the next deleted note, or follow the recovered one to where it now lives.
    const next = nextAfter([id]);
    if (cols() > 1 && next) openNote(next, { replace: true });
    else openNote(id, { replace: true });
  } else if (session?.id === id) reopen();
}
async function deleteNow(ids) {
  const list = ids.map(noteById).filter(Boolean);
  if (!list.length) return;
  const hadFocus = listEl.contains(document.activeElement);
  const ok = await confirmDialog({ title: list.length > 1 ? `Delete ${list.length} notes now?` : 'Delete this note now?', message: "This can't be undone.", confirm: 'Delete', danger: true });
  if (!ok) return;
  const next = nextAfter(list.map((n) => n.id));
  db.batch(() => list.forEach((n) => safe(() => core.deleteForever(n.id))));
  recheckSaved();
  state.sel.clear();
  if (list.some((n) => n.id === state.noteId)) {
    if (cols() > 1 && next) openNote(next, { replace: true });
    else nav(listHash(), { replace: true });
  }
  refocusList(hadFocus);
}
async function emptyTrash() {
  const list = (db.all('notes') || []).filter((n) => n?.trashedAt);
  if (!list.length) return;
  const ok = await confirmDialog({ title: `Delete ${plural(list.length, 'note')} now?`, message: "Everything in Recently Deleted is erased. This can't be undone.", confirm: 'Delete All', danger: true });
  if (!ok) return;
  safe(() => core.emptyTrash());
  if (state.view === 'trash') nav('#/trash', { replace: true });
  toast('Recently Deleted is empty');
  // The room that freed may have let the notes be saved: the storage banner says so now, not at its next check.
  recheckSaved();
}

function duplicate(id) {
  flush(session);
  const copy = safe(() => core.duplicateNote(id), null);
  if (copy) openNote(copy.id);
}
function hideFromAi(ids) {
  const list = ids.map(noteById).filter(Boolean);
  if (!list.length) return;
  const on = list.some((n) => !n.aiHidden);
  db.batch(() => list.forEach((n) => safe(() => core.setNoteAiHidden(n.id, on))));
  toast(on ? 'Hidden from AI assistants' : 'AI assistants can see this again');
}
/** Fresh titles for note chips in exported Markdown, and [[Title]] resolution on import. */
const currentTitle = (id) => {
  const n = noteById(id);
  return n && !n.trashedAt ? displayTitle(n) : null;
};
function noteByTitle(title) {
  const t = oneLine(title).toLowerCase();
  const n = t ? liveNotes().find((x) => displayTitle(x).toLowerCase() === t) : null;
  return n ? { id: n.id, title: displayTitle(n) } : null;
}
const noteUrl = (id) => new URL(`${BASE}notes/#/n/${encodeURIComponent(id)}`, location.origin).href;
async function copyLink(id) {
  const ok = await ex.copyText(noteUrl(id));
  toast(ok ? 'Link copied' : 'Could not copy the link');
}
async function copyMd(id) {
  flush(session);
  const n = noteById(id);
  if (!n) return;
  const ok = await ex.copyMarkdown(n, folders(), { noteTitle: currentTitle });
  toast(ok ? 'Copied as Markdown' : 'Could not copy');
}
function exportMd(id) {
  flush(session);
  const n = noteById(id);
  if (n) ex.downloadNote(n, folders(), { noteTitle: currentTitle });
}
function printNote() {
  flush(session);
  window.print();
}

/** Move notes to a folder ('notes' = the default folder). Undo puts each back. */
function moveNotes(ids, target) {
  const fid = target === 'notes' ? null : target;
  const list = ids.map(noteById).filter((n) => n && !n.trashedAt && (n.folderId || null) !== fid);
  if (!list.length) return;
  const undo = safe(() => core.moveNotes(list.map((n) => n.id), fid), null);
  const name = fid ? folderById(fid)?.name || 'folder' : 'Notes';
  rollCount(target);
  undoable(list.length > 1 ? `Moved ${list.length} notes to ${name}` : `Moved to ${name}`, () => safe(() => (typeof undo === 'function' ? undo() : null)), 'move');
}
/** Delight: the target folder's count rolls up to its new number. */
function rollCount(target) {
  if (reduceMotion()) return;
  requestAnimationFrame(() => {
    const el = $(`[data-drop="${CSS.escape(String(target))}"] [data-count]`, navEl);
    if (!el) return;
    el.classList.remove('n-roll');
    void el.offsetWidth;
    el.classList.add('n-roll');
  });
}

/** A menu of folders (indented, with colour dots). onPick(folderId | 'notes'). */
function folderPicker(anchor, { current = null, title = 'Move to', onPick, allowNew = true }) {
  const rows = tree();
  const items = [
    { heading: title },
    { label: 'Notes', iconHtml: `<span class="n-fdot" style="--fc:var(--text-3)">${icon('folder', { size: 18 })}</span>`, checked: current === 'notes' || current === null, onSelect: () => onPick('notes') },
    ...rows.map((r) => ({
      label: r.folder.name,
      // Top-level folders line up with Notes: only nested ones get an indent (and the gap after it).
      iconHtml: `${r.depth ? `<span class="n-mi-indent" style="width:${r.depth * 14}px"></span>` : ''}<span class="n-fdot" style="--fc:${colorVar(r.folder.color)}">${icon('folder', { size: 18 })}</span>`,
      checked: current === r.folder.id,
      onSelect: () => onPick(r.folder.id),
    })),
  ];
  if (allowNew) items.push({ sep: true }, { label: 'New folder…', icon: 'folder-plus', onSelect: () => folderDialog({ onDone: (f) => onPick(f.id) }) });
  return openMenu(anchor, items, { label: title, className: 'n-folderpick' });
}

// ---------------------------------------------------------------- tags

/**
 * A tag as typed → the tag text (tagFromInput): no leading '#', spaces become '-', only what a tag can
 * hold (letters, combining marks such as Hindi vowel signs or Arabic harakat, digits, _ - /).
 */
const cleanTagInput = tagFromInput;
/** "1 note is" / "3 notes are": for notes a tag change skipped because they are at the size limit. */
const notesAre = (n) => (n === 1 ? '1 note is' : `${n} notes are`);

function addTagDialog(ids) {
  const list = ids.map(noteById).filter((n) => n && !n.trashedAt);
  if (!list.length) return;
  openModal({
    title: list.length > 1 ? `Add a tag to ${list.length} notes` : 'Add a tag',
    className: 'n-smallmodal',
    body: `<form class="modal-body n-form" novalidate autocomplete="off">
      <div class="n-hashfield">${icon('hash', { size: 16 })}<input class="input" name="noteTag" placeholder="tag or area/topic" maxlength="64" aria-label="Tag" autocomplete="off" spellcheck="false" data-autofocus /></div>
      <p class="faint n-hint">It's added as #tag at the end of each note.</p>
      <div class="n-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary" disabled>Add</button></div></form>`,
    onMount: (el, close) => {
      const input = $('input', el);
      const btn = $('[type="submit"]', el);
      const clean = () => cleanTagInput(input.value);
      input.addEventListener('input', () => (btn.disabled = !/\p{L}/u.test(clean())));
      attachSuggest(input, (q) => tagProvider(q.replace(/^#/, '')).map((t) => ({ value: t, label: t, icon: 'hash' })), { onPick: () => (btn.disabled = false) });
      $('form', el).addEventListener('submit', (e) => {
        e.preventDefault();
        const tag = clean();
        if (!/\p{L}/u.test(tag)) return;
        close();
        flush(session);
        const undo = safe(() => core.addTagToNotes(list.map((n) => n.id), tag), null);
        // Notes at the size limit are left alone (one more line wouldn't fit): say so, never "already tagged".
        const long = typeof undo === 'function' ? undo.tooLarge || 0 : 0;
        const longMsg = long ? `${list.length === 1 ? 'This note is' : notesAre(long)} too long to add a tag to.` : '';
        if (typeof undo !== 'function' || !undo.count) return toast(longMsg || (list.length > 1 ? 'Those notes already have that tag.' : 'That note already has this tag.'), long ? { duration: 8000 } : undefined);
        undoable(`${undo.count > 1 ? `Tagged ${undo.count} notes #${tag}` : `Tagged #${tag}`}${longMsg ? `. ${longMsg}` : ''}`, () => safe(undo), 'add tag');
      });
    },
  });
}

function tagMenu(anchor, tag) {
  const onClose = markTarget({ el: $(`#nav [data-tag="${CSS.escape(tag)}"]`) });
  openMenu(
    anchor,
    [
      { label: 'Show notes', icon: 'hash', onSelect: () => nav(`#/tag/${encodeURIComponent(tag)}`) },
      { label: 'Rename tag…', icon: 'edit', onSelect: () => renameTagDialog(tag) },
      { sep: true },
      { label: 'Delete tag', icon: 'trash', danger: true, onSelect: () => deleteTag(tag) },
    ],
    { label: `Tag ${tag}`, onClose },
  );
}
function notesWithTag(tag) {
  const t = normTag(tag);
  return liveNotes().filter((n) => hasTag(n, t));
}
function renameTagDialog(tag) {
  openModal({
    title: 'Rename tag',
    className: 'n-smallmodal',
    body: `<form class="modal-body n-form" novalidate autocomplete="off">
      <div class="n-hashfield">${icon('hash', { size: 16 })}<input class="input" name="tagName" value="${esc(tag)}" maxlength="64" aria-label="New name" autocomplete="off" spellcheck="false" data-autofocus /></div>
      <p class="faint n-hint">Rewrites #${esc(tag)} in ${esc(plural(notesWithTag(tag).length, 'note'))}.</p>
      <div class="n-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Rename</button></div></form>`,
    onMount: (el, close) => {
      const input = $('input', el);
      input.select();
      $('form', el).addEventListener('submit', (e) => {
        e.preventDefault();
        const to = cleanTagInput(input.value);
        if (!/\p{L}/u.test(to) || to === tag) return close();
        close();
        flush(session);
        const undo = safe(() => core.renameTag(tag, to), null);
        if (typeof undo !== 'function') return;
        // A longer name that would push a note over the size limit leaves that note with the old tag.
        const long = undo.tooLarge || 0;
        const longMsg = long ? `${notesAre(long)} too long for the new name and kept #${tag}.` : '';
        if (!undo.count) return toast(longMsg || `No notes use #${tag} any more.`, long ? { duration: 8000 } : undefined);
        if (!long && state.view === 'tag' && state.tags.includes(normTag(tag))) nav(`#/tag/${encodeURIComponent(normTag(to))}`, { replace: true });
        undoable(`Renamed #${tag} to #${to}${longMsg ? `. ${longMsg}` : ''}`, () => safe(undo), 'rename tag');
      });
    },
  });
}
function deleteTag(tag) {
  flush(session);
  const undo = safe(() => core.removeTag(tag), null);
  if (typeof undo !== 'function') return;
  const long = undo.tooLarge || 0;
  const longMsg = long ? `${notesAre(long)} too long to change and kept it.` : '';
  if (!long && state.view === 'tag' && state.tags.includes(normTag(tag))) nav('#/all', { replace: true });
  if (!undo.count) return toast(longMsg || `No notes use #${tag} any more.`, long ? { duration: 8000 } : undefined);
  undoable(`Deleted #${tag} from ${plural(undo.count, 'note')}${longMsg ? `. ${longMsg}` : ''}`, () => safe(undo), 'delete tag');
}

// ---------------------------------------------------------------- folders

const MAX_DEPTH = 3;
function folderDepth(id) {
  return schema.folderDepth(id, folders()); // 1 = top level; a parent cycle is cut as in the folder tree
}
/** The folders shown under `parentId` (null: the top level), as the folder tree shows them (a parent cycle cut). */
const siblingsOf = (parentId) => {
  const parents = schema.folderParents(folders());
  return folders().filter((f) => (parents.get(f.id) ?? null) === (parentId || null));
};

/** New folder / rename: name (1–60, unique among siblings) and colour. */
function folderDialog({ folder = null, parentId = null, onDone } = {}) {
  const parent = folder ? (schema.folderParents(folders()).get(folder.id) ?? null) : parentId;
  const used = new Set(folders().map((f) => f.color));
  let color = folder?.color || COLORS.find((c) => !used.has(c)) || 'iris';
  openModal({
    title: folder ? 'Rename folder' : parent ? 'New subfolder' : 'New folder',
    className: 'n-smallmodal',
    body: `<form class="modal-body n-form" novalidate autocomplete="off">
      <input class="input" name="folderName" value="${esc(folder?.name || '')}" placeholder="Name" maxlength="60" aria-label="Folder name" autocomplete="off" spellcheck="false" data-autofocus />
      <div class="n-err" role="alert" hidden></div>
      <div class="n-colors" role="radiogroup" aria-label="Colour">${COLORS.map((c) => `<button type="button" class="swatch-btn" role="radio" style="--sw:${colorVar(c)}" data-color="${esc(c)}" aria-checked="${c === color}" aria-label="${esc(colorName(c))}" ${tipAttrs(colorName(c))} tabindex="${c === color ? 0 : -1}">${icon('check')}</button>`).join('')}</div>
      <div class="n-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary"${folder ? '' : ' disabled'}>${folder ? 'Save' : 'Create'}</button></div></form>`,
    onMount: (el, close) => {
      const input = $('input', el);
      const btn = $('[type="submit"]', el);
      const err = $('.n-err', el);
      if (folder) input.select();
      const check = () => {
        const name = input.value.trim();
        // Keeping the folder's own name is never a clash, even beside a folder of the same name (one an AI
        // assistant made beside a folder hidden from it, which stays a secret): core.renameFolder accepts it.
        const same = !!folder && name.toLowerCase() === folder.name.trim().toLowerCase();
        const dup = !same && siblingsOf(parent).some((f) => f.id !== folder?.id && f.name.trim().toLowerCase() === name.toLowerCase());
        err.hidden = !dup;
        err.textContent = dup ? 'A folder with this name is already here.' : '';
        btn.disabled = !name || dup;
        return !btn.disabled;
      };
      input.addEventListener('input', check);
      const radios = $$('[data-color]', el);
      const pick = (c) => {
        color = c;
        for (const r of radios) {
          r.setAttribute('aria-checked', String(r.dataset.color === c));
          r.tabIndex = r.dataset.color === c ? 0 : -1;
        }
      };
      el.addEventListener('click', (e) => {
        const r = e.target.closest('[data-color]');
        if (r) pick(r.dataset.color);
      });
      $('.n-colors', el).addEventListener('keydown', (e) => {
        const i = radios.indexOf(document.activeElement);
        if (i < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const next = radios[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + radios.length) % radios.length];
        next.focus();
        pick(next.dataset.color);
      });
      $('form', el).addEventListener('submit', (e) => {
        e.preventDefault();
        if (!check()) return;
        const name = input.value.trim().slice(0, 60);
        // The core refuses a duplicate, reserved ("Notes") or too-deep folder with a friendly message.
        let f = null;
        try {
          if (folder) {
            core.renameFolder(folder.id, name);
            if (folder.color !== color) core.updateFolder(folder.id, { color });
            f = folderById(folder.id);
          } else f = core.createFolder({ name, parentId: parent || null, color });
        } catch (err) {
          err2(err?.message || 'Could not save the folder.');
          return;
        }
        close();
        if (!f) return;
        if (folder) return onDone?.(f);
        if (parent && ui.collapsed.includes(parent)) {
          ui.collapsed = ui.collapsed.filter((x) => x !== parent);
          saveUi();
        }
        onDone ? onDone(f) : nav(`#/folder/${encodeURIComponent(f.id)}`);
      });
      const err2 = (msg) => {
        err.hidden = false;
        err.textContent = msg;
        input.focus();
      };
    },
  });
}

function folderMenu(anchor, id) {
  const f = folderById(id);
  if (!f) return;
  const canNest = folderDepth(id) < MAX_DEPTH;
  const sibs = orderedSiblings(shownParent(f.id));
  const i = sibs.findIndex((x) => x.id === id);
  const onClose = markTarget({ el: $(`#nav [data-folder="${CSS.escape(id)}"]`) });
  openMenu(
    anchor,
    [
      canNest && { label: 'New subfolder…', icon: 'folder-plus', onSelect: () => folderDialog({ parentId: id }) },
      { label: 'Rename…', icon: 'edit', onSelect: () => folderDialog({ folder: f }) },
      { label: 'Colour', icon: 'contrast', onSelect: () => colorMenu(anchor, f) },
      { label: 'Sort & view…', icon: 'sort', onSelect: () => sortMenu(anchor, f) },
      { label: f.aiHidden ? 'Show to AI' : 'Hide from AI', icon: f.aiHidden ? G.aiOn : G.aiOff, onSelect: () => safe(() => core.setFolderAiHidden(id, !f.aiHidden)) },
      { sep: true },
      // Reorder and nest without dragging (keyboard, one finger): the same moves a drop makes.
      { label: 'Move to…', iconHtml: lic('move', { size: 18 }), onSelect: () => moveFolderPicker(anchor, id) },
      i > 0 && { label: 'Move up', icon: 'arrow-up', keys: 'alt shift up', onSelect: () => stepFolder(id, -1) },
      i >= 0 && i < sibs.length - 1 && { label: 'Move down', icon: 'arrow-down', keys: 'alt shift down', onSelect: () => stepFolder(id, 1) },
      { sep: true },
      { label: 'Delete folder…', icon: 'trash', danger: true, onSelect: () => deleteFolder(id) },
    ],
    { label: `Folder ${f.name}`, onClose },
  );
}
/** The folder a folder is shown in (null: the top level), a parent cycle cut as in the tree. */
const shownParent = (id) => schema.folderParents(folders()).get(id) ?? null;
/** A folder's siblings in the sidebar's order. */
const orderedSiblings = (parentId) => siblingsOf(parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || collator.compare(a.name, b.name));
/** Move a folder one place up or down among its siblings; the keyboard stays on it. */
function stepFolder(id, dir) {
  const f = folderById(id);
  if (!f) return;
  const sibs = orderedSiblings(shownParent(f.id));
  const i = sibs.findIndex((x) => x.id === id);
  const other = sibs[i + dir];
  if (!other) return;
  moveFolder(id, other.id, dir < 0 ? 'before' : 'after');
  renderSidebar();
  $(`#nav [data-folder="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
}
/**
 * "Move to…" for a folder: the top level or another folder it can go inside (not itself or one of its
 * own subfolders, and three levels deep at most, counting the subfolders it brings along).
 */
function moveFolderPicker(anchor, id) {
  const f = folderById(id);
  if (!f) return;
  const own = folderSubtree(id);
  const below = (fid) => {
    let d = 1;
    const kids = (x) => folders().filter((k) => k.parentId === x);
    const walk = (x, depth) => {
      d = Math.max(d, depth);
      if (depth < 8) for (const k of kids(x)) walk(k.id, depth + 1);
    };
    walk(fid, 1);
    return d;
  };
  const height = below(id);
  const rows = tree().filter((r) => !own.has(r.folder.id) && folderDepth(r.folder.id) + height <= MAX_DEPTH);
  openMenu(
    anchor,
    [
      { heading: `Move “${f.name}” to` },
      { label: 'Top level', iconHtml: `<span class="n-fdot" style="--fc:var(--text-3)">${icon('folder', { size: 18 })}</span>`, checked: !shownParent(id), onSelect: () => shownParent(id) && moveFolder(id, null, 'root') },
      ...rows.map((r) => ({
        label: r.folder.name,
        iconHtml: `${r.depth ? `<span class="n-mi-indent" style="width:${r.depth * 14}px"></span>` : ''}<span class="n-fdot" style="--fc:${colorVar(r.folder.color)}">${icon('folder', { size: 18 })}</span>`,
        checked: shownParent(id) === r.folder.id,
        onSelect: () => shownParent(id) !== r.folder.id && moveFolder(id, r.folder.id, 'inside'),
      })),
    ],
    { label: `Move folder ${f.name}`, className: 'n-folderpick' },
  );
}
/** 'iris' → 'Iris': a colour's name as people read it. */
const colorName = (c) => String(c).charAt(0).toUpperCase() + String(c).slice(1);
function colorMenu(anchor, f) {
  openMenu(
    anchor,
    COLORS.map((c) => ({ label: colorName(c), iconHtml: `<span class="swatch-dot" style="background:${colorVar(c)}"></span>`, checked: f.color === c, onSelect: () => safe(() => core.updateFolder(f.id, { color: c })) })),
    { label: 'Folder colour' },
  );
}
async function deleteFolder(id) {
  const f = folderById(id);
  if (!f) return;
  const sub = folderSubtree(id);
  const subCount = folders().filter((x) => sub.has(x.id)).length - 1;
  const noteCount = liveNotes().filter((n) => sub.has(n.folderId)).length;
  const ok = await confirmDialog({
    title: `Delete “${f.name}”?`,
    message: noteCount ? `${plural(noteCount, 'note')} will move to Recently Deleted${subCount ? `, and ${plural(subCount, 'subfolder')} will be removed` : ''}.` : subCount ? `${plural(subCount, 'subfolder')} will be removed too.` : 'The folder is empty.',
    confirm: 'Delete',
    danger: true,
  });
  if (!ok) return;
  flush(session);
  const undo = safe(() => core.deleteFolder(id), null);
  if (state.view === 'folder' && sub.has(state.folderId)) nav('#/all', { replace: true });
  if (typeof undo === 'function') undoable(`Deleted “${f.name}”`, () => safe(undo), 'delete folder');
}
/** Drop a folder before / after / inside another one, or on the Folders header (top level). Max three levels. */
function moveFolder(id, targetId, where) {
  const f = folderById(id);
  if (!f || id === targetId) return;
  let parent = null;
  if (where !== 'root') {
    const t = folderById(targetId);
    if (!t) return;
    parent = where === 'inside' ? t.id : t.parentId || null;
  }
  // Undo restores place and order of just the folders this touches (never resurrects deleted ones).
  const touched = new Set([id, ...siblingsOf(f.parentId).map((x) => x.id), ...siblingsOf(parent).map((x) => x.id)]);
  const before = folders().filter((x) => touched.has(x.id)).map(clone);
  try {
    db.batch(() => {
      core.moveFolder(id, parent); // refuses cycles and a fourth level; renames a clash ("Work 2")
      const sibs = siblingsOf(parent)
        .filter((x) => x.id !== id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      let at = sibs.length;
      if (where === 'before' || where === 'after') {
        const i = sibs.findIndex((x) => x.id === targetId);
        at = i < 0 ? sibs.length : where === 'before' ? i : i + 1;
      }
      sibs.splice(at, 0, folderById(id));
      sibs.forEach((x, i) => (x.order ?? 0) !== i && core.updateFolder(x.id, { order: i }));
    });
  } catch (err) {
    return toast(err?.message || 'Could not move the folder.');
  }
  if (where === 'inside' && ui.collapsed.includes(targetId)) {
    ui.collapsed = ui.collapsed.filter((x) => x !== targetId);
    saveUi();
  }
  undoable(`Moved “${f.name}”`, () => db.batch(() => before.forEach((x) => folderById(x.id) && db.update('folders', x.id, { parentId: x.parentId, order: x.order, name: x.name }))), 'move folder');
}

// ---------------------------------------------------------------- menus

/**
 * While a row, folder or tag menu is open, what it acts on is outlined (n-ctx), as Apple rings the item
 * you right-clicked: it is often not the open note. → the menu's onClose.
 */
function markTarget({ row = null, el = null } = {}) {
  if (row) {
    ctxRow = row;
    $(`#row-${CSS.escape(row)}`, listEl)?.classList.add('n-ctx');
  }
  el?.classList.add('n-ctx');
  return () => {
    if (row && ctxRow === row) {
      ctxRow = null;
      $(`#row-${CSS.escape(row)}`, listEl)?.classList.remove('n-ctx');
    }
    el?.classList.remove('n-ctx');
  };
}
/** Right-click on a row (Apple: no hover actions). */
function rowMenu(anchor, id) {
  const n = noteById(id);
  if (!n) return;
  const ids = state.sel.size > 1 && state.sel.has(id) ? [...state.sel] : [id];
  const many = ids.length > 1;
  const onClose = markTarget({ row: id });
  if (n.trashedAt) {
    return openMenu(anchor, [{ label: many ? `Recover ${ids.length} notes` : 'Recover', icon: 'undo', onSelect: () => ids.forEach(recover) }, { sep: true }, { label: many ? `Delete ${ids.length} now…` : 'Delete Now…', icon: 'trash', danger: true, onSelect: () => deleteNow(ids) }], { label: 'Note actions', onClose });
  }
  openMenu(
    anchor,
    [
      { label: n.pinned ? (many ? 'Unpin notes' : 'Unpin') : many ? 'Pin notes' : 'Pin', icon: 'pushpin', keys: 'p', onSelect: () => togglePin(ids) },
      { label: 'Move…', iconHtml: lic('move', { size: 18 }), keys: 'm', onSelect: () => folderPicker(anchor, { current: ids.length === 1 ? noteFolder(n) || 'notes' : null, onPick: (f) => moveNotes(ids, f) }) },
      !many && { label: 'Duplicate', icon: 'copy', onSelect: () => duplicate(id) },
      { label: n.aiHidden ? 'Show to AI' : 'Hide from AI', icon: n.aiHidden ? G.aiOn : G.aiOff, onSelect: () => hideFromAi(ids) },
      { sep: true },
      !many && { label: 'Copy link', icon: 'link', onSelect: () => copyLink(id) },
      !many && { label: 'Export as Markdown', icon: 'download', onSelect: () => exportMd(id) },
      { sep: true },
      { label: many ? `Delete ${ids.length} notes` : 'Delete', icon: 'trash', danger: true, keys: isMac ? 'mod backspace' : 'delete', onSelect: () => trash(ids) },
    ],
    { label: 'Note actions', onClose },
  );
}

/** The note's ⋯ menu. */
function noteMenu(anchor) {
  const n = session?.note();
  const d = session?.draft;
  if (!n && !d) return;
  if (n?.trashedAt) return openMenu(anchor, [{ label: 'Recover', icon: 'undo', onSelect: () => recover(n.id) }, { label: 'Delete Now…', icon: 'trash', danger: true, onSelect: () => deleteNow([n.id]) }], { label: 'Note' });
  const items = n
    ? [
        { label: n.pinned ? 'Unpin' : 'Pin', icon: 'pushpin', keys: 'p', onSelect: () => togglePin([n.id]) },
        { label: 'Move…', iconHtml: lic('move', { size: 18 }), keys: 'm', onSelect: () => folderPicker(anchor, { current: noteFolder(n) || 'notes', onPick: (f) => moveNotes([n.id], f) }) },
        { label: n.aiHidden ? 'Show to AI' : 'Hide from AI', icon: n.aiHidden ? G.aiOn : G.aiOff, onSelect: () => hideFromAi([n.id]) },
        { sep: true },
        { label: 'Find in note', icon: 'search', keys: 'mod F', onSelect: () => openFind() },
        { label: 'Version history', icon: 'history', onSelect: () => openHistory(n.id) },
        { label: state.info ? 'Hide info' : 'Info', icon: 'info', keys: 'i', onSelect: () => toggleInfo() },
        cols() > 1 && { label: state.focusMode ? 'Exit focus mode' : 'Focus mode', iconHtml: lic(state.focusMode ? 'shrink' : 'expand', { size: 18 }), keys: shiftMod('\\'), onSelect: () => toggleFocusMode() },
        { sep: true },
        { label: 'Duplicate', icon: 'copy', onSelect: () => duplicate(n.id) },
        { label: 'Delete', icon: 'trash', danger: true, keys: isMac ? 'mod backspace' : 'delete', onSelect: () => trash([n.id]) },
      ]
    : [
        { label: 'Find in note', icon: 'search', keys: 'mod F', onSelect: () => openFind() },
        cols() > 1 && { label: state.focusMode ? 'Exit focus mode' : 'Focus mode', iconHtml: lic(state.focusMode ? 'shrink' : 'expand', { size: 18 }), onSelect: () => toggleFocusMode() },
      ];
  openMenu(anchor, items, { label: 'Note' });
}

function shareMenu(anchor) {
  const id = session?.id;
  const n = session?.note();
  if (!n) return toast('Type something first.');
  openMenu(
    anchor,
    [
      { label: 'Download as Markdown', icon: 'download', onSelect: () => exportMd(id) },
      { label: 'Copy as Markdown', icon: 'copy', onSelect: () => copyMd(id) },
      { label: 'Copy link', icon: 'link', onSelect: () => copyLink(id) },
      { sep: true },
      { label: 'Print…', iconHtml: lic('print', { size: 18 }), onSelect: () => printNote() },
    ],
    { label: 'Share' },
  );
}

function listMenu(anchor) {
  const cfg = sortCfg();
  const items = [];
  if (state.view !== 'trash' && state.view !== 'search') {
    items.push(
      { label: 'View as List', iconHtml: lic('rows', { size: 18 }), checked: cfg.view === 'list', onSelect: () => setView('list') },
      { label: 'View as Gallery', iconHtml: lic('grid', { size: 18 }), checked: cfg.view === 'gallery', onSelect: () => setView('gallery') },
      { sep: true },
      { label: 'Sort & group…', icon: 'sort', onSelect: () => sortMenu(anchor, cfg.folder) },
      { label: state.selectMode ? 'Done selecting' : 'Select notes', icon: 'check-circle', onSelect: () => setSelectMode(!state.selectMode) },
    );
    if (viewNotes().some((n) => n.pinned)) items.push({ label: ui.pinnedCollapsed ? 'Show Pinned Notes' : 'Hide Pinned Notes', icon: 'pushpin', onSelect: () => togglePinnedSection() });
  }
  if (state.view === 'folder' && cfg.folder) items.push({ sep: true }, { label: 'Folder…', icon: 'folder', onSelect: () => folderMenu(anchor, cfg.folder.id) });
  if (state.view === 'trash') items.push({ label: 'Delete All…', icon: 'trash', danger: true, onSelect: () => emptyTrash() });
  items.push({ sep: true }, { label: 'Import Markdown…', icon: 'upload', onSelect: () => pickImport() }, { label: 'Export all notes (.zip)', icon: 'download', onSelect: () => exportAllNotes() }, { label: 'Notes settings', icon: 'gear', onSelect: () => notesSettings() });
  openMenu(anchor, items, { label: 'List options' });
}

/** Fold or unfold the Pinned section of the list (per device). */
function togglePinnedSection() {
  ui.pinnedCollapsed = !ui.pinnedCollapsed;
  saveUi();
  renderList();
}

function setView(view) {
  const cfg = sortCfg();
  const apply = () => {
    if (cfg.folder) safe(() => core.updateFolder(cfg.folder.id, { view }));
    else settings.set({ notesView: view });
  };
  if (!reduceMotion() && document.startViewTransition) {
    morphing = true;
    renderList();
    try {
      const t = document.startViewTransition(() => {
        apply();
        renderAll();
      });
      t.finished.finally(() => {
        morphing = false;
        renderList();
      });
    } catch {
      morphing = false;
      apply();
    }
  } else apply();
}

/** Sort & group for the current folder (or the app default elsewhere). */
function sortMenu(anchor, folder = sortCfg().folder) {
  const s = settings.get() || {};
  const cur = folder
    ? { by: folder.sort || s.notesSort || 'edited', dir: folder.sortDir || s.notesSortDir || 'desc', group: typeof folder.groupByDate === 'boolean' ? folder.groupByDate : s.notesGroupByDate !== false }
    : { by: s.notesSort || 'edited', dir: s.notesSortDir || 'desc', group: s.notesGroupByDate !== false };
  const set = (patch) => {
    if (folder) {
      const map = { by: 'sort', dir: 'sortDir', group: 'groupByDate' };
      safe(() => core.updateFolder(folder.id, Object.fromEntries(Object.entries(patch).map(([k, v]) => [map[k], v]))));
    } else settings.set(Object.fromEntries(Object.entries(patch).map(([k, v]) => [{ by: 'notesSort', dir: 'notesSortDir', group: 'notesGroupByDate' }[k], v])));
  };
  const dirLabels = cur.by === 'title' ? ['A to Z', 'Z to A'] : ['Newest first', 'Oldest first'];
  openMenu(
    anchor,
    [
      { heading: folder ? `Sort “${folder.name}” by` : 'Sort by' },
      { label: 'Date Edited', checked: cur.by === 'edited', onSelect: () => set({ by: 'edited' }) },
      { label: 'Date Created', checked: cur.by === 'created', onSelect: () => set({ by: 'created' }) },
      { label: 'Title', checked: cur.by === 'title', onSelect: () => set({ by: 'title', dir: 'asc' }) },
      { sep: true },
      { label: dirLabels[0], checked: cur.by === 'title' ? cur.dir !== 'desc' : cur.dir !== 'asc', onSelect: () => set({ dir: cur.by === 'title' ? 'asc' : 'desc' }) },
      { label: dirLabels[1], checked: cur.by === 'title' ? cur.dir === 'desc' : cur.dir === 'asc', onSelect: () => set({ dir: cur.by === 'title' ? 'desc' : 'asc' }) },
      cur.by !== 'title' && { sep: true },
      cur.by !== 'title' && { label: 'Group by date', checked: !!cur.group, onSelect: () => set({ group: !cur.group }) },
      folder && (folder.sort || folder.sortDir || typeof folder.groupByDate === 'boolean' || folder.view) && { sep: true },
      folder && (folder.sort || folder.sortDir || typeof folder.groupByDate === 'boolean' || folder.view) && { label: 'Use the default', icon: 'refresh', onSelect: () => safe(() => core.updateFolder(folder.id, { sort: null, sortDir: null, groupByDate: null, view: null })) },
    ],
    { label: 'Sort' },
  );
}

// ---------------------------------------------------------------- formatting (the editor's Aa panel and insert sheet)

function exec(cmd, arg) {
  // Not while several notes are selected: the open note isn't on screen then.
  if (!session?.editor || session.readOnly || multiSel()) return false;
  return safe(() => session.editor.exec(cmd, arg), false);
}
/** Aa: the editor's format panel, anchored to the button. */
function openAa(anchor) {
  exec('aa', anchor);
}
/** +: the editor's insert sheet (Checklist, lists, divider, link, date, Send to Tasks…). */
function insertMenu(anchor) {
  exec('insert', anchor);
}

// ---------------------------------------------------------------- find in note

let findQuery = '';
function openFind(prefill = '', { focus = true } = {}) {
  if (!session?.editor) return;
  findEl.hidden = false;
  shellEl.classList.add('has-find');
  if (!$('input', findEl)) {
    findEl.innerHTML = `${icon('search', { size: 15 })}<input type="text" class="n-findq" aria-label="Find in note" placeholder="Find in note" autocomplete="off" spellcheck="false" enterkeyhint="search" />
      <span class="n-findn tnum" aria-live="polite"></span>
      <button type="button" class="icon-btn sm" data-find="prev" aria-label="Previous match" ${tipAttrs('Previous', 'shift enter')}>${icon('chevron-up', { size: 16 })}</button>
      <button type="button" class="icon-btn sm" data-find="next" aria-label="Next match" ${tipAttrs('Next', 'enter')}>${icon('chevron-down', { size: 16 })}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-find="close">Done</button>`;
    const inp = $('input', findEl);
    inp.addEventListener('input', () => runFind(inp.value));
    inp.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' || e.key === 'F3' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g')) {
        e.preventDefault();
        findStep(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopFind();
        safe(() => session?.editor?.focus('end'));
      }
    });
  }
  const input = $('input', findEl);
  if (prefill) input.value = prefill;
  if (focus) {
    input.focus();
    input.select();
  }
  runFind(input.value);
}
function runFind(q) {
  findQuery = q;
  const ed = session?.editor;
  findCount = q && ed ? Number(safe(() => ed.find(q), 0)) || 0 : 0;
  if (!q && ed) safe(() => (ed.clearFind ? ed.clearFind() : ed.find('')));
  findIndex = 0;
  // Go to the first match (it scrolls into view and pulses once).
  if (findCount) {
    const r = safe(() => ed.findNext(), null);
    findIndex = Number.isFinite(r?.index) ? r.index : 1; // the editor counts from 1
  }
  updateFindCount();
}
let findCount = 0;
let findIndex = 0;
function updateFindCount() {
  const el = $('.n-findn', findEl);
  if (!el) return;
  el.textContent = findQuery ? (findCount ? `${findIndex} of ${findCount}` : 'No matches') : '';
}
function findStep(dir) {
  if (!findCount || !session?.editor) return;
  const ed = session.editor;
  const r = safe(() => (dir < 0 && typeof ed.findPrev === 'function' ? ed.findPrev() : ed.findNext()), null);
  if (Number.isFinite(r?.count)) findCount = r.count;
  if (Number.isFinite(r?.index)) findIndex = r.index;
  else findIndex = dir < 0 ? (findIndex <= 1 ? findCount : findIndex - 1) : findIndex >= findCount ? 1 : findIndex + 1;
  updateFindCount();
}
function stopFind() {
  if (findEl.hidden) return;
  findEl.hidden = true;
  shellEl.classList.remove('has-find');
  findQuery = '';
  const ed = session?.editor;
  if (ed) safe(() => (ed.clearFind ? ed.clearFind() : ed.find('')));
}
function clearFindMarks() {
  if (!findEl.hidden && document.activeElement !== $('input', findEl)) stopFind();
}

// ---------------------------------------------------------------- info panel

function toggleInfo(force) {
  state.info = force ?? !state.info;
  if (cols() === 1 && state.info) {
    state.info = false;
    return openInfoSheet();
  }
  infoEl.hidden = !state.info;
  shellEl.classList.toggle('has-info', state.info);
  if (state.info) renderInfo();
}
function infoHtml() {
  const n = session?.note();
  if (!n) return `<div class="n-info-empty faint">Start typing to see this note's details.</div>`;
  const blocks = blocksOf(n);
  const st = safe(() => schema.noteStats(n), null) || { words: 0, chars: charCount(blocks), checks: { open: 0, done: 0 } };
  const heads = blocks.filter((b) => /^h[123]$/.test(b.t) && oneLine(blockText(b)));
  const outline = heads.length > 1 ? `<div class="group-title">Outline</div><div class="group n-outline">${heads.map((b) => `<button type="button" class="item n-ol-${b.t}" data-outline="${esc(b.id)}"><span class="truncate">${esc(oneLine(blockText(b)))}</span></button>`).join('')}</div>` : '';
  const f = folderById(noteFolder(n));
  const tasks = blocks.filter((b) => b.task).map((b) => db.get('tasks', b.task)).filter(Boolean);
  const ev = n.event ? eventInfo(n.event) : null;
  const size = JSON.stringify(n).length;
  const kb = size < 1024 ? `${size} bytes` : `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  const inheritHidden = !n.aiHidden && folderHidden(n.folderId);
  // Labels keep their width; a long value wraps (dates) or ends in "…" (a folder name) beside it.
  const row = (label, value) => `<div class="item"><span class="grow n-il">${esc(label)}</span><span class="value n-iv">${value}</span></div>`;
  const checks = st.checks?.open + st.checks?.done ? row('Checklist', `${esc(`${st.checks.done} of ${st.checks.open + st.checks.done} done`)}`) : '';
  return `${outline}
    <div class="group-title">Details</div>
    <div class="group">
      ${row('Words', `<span class="tnum">${esc(st.words ?? 0)}</span>`)}
      ${row('Characters', `<span class="tnum">${esc(st.chars ?? 0)}</span>`)}
      ${checks}
      ${row('Size', `<span class="tnum${size > 128 * 1024 ? ' danger-text' : ''}">${esc(kb)}</span>`)}
    </div>
    ${size > 128 * 1024 ? '<div class="group-foot danger-text">This note is getting large. Notes are limited to 256 KB.</div>' : ''}
    <div class="group-title">Dates</div>
    <div class="group">
      ${row('Created', esc(longStamp(createdAt(n))))}
      ${row('Edited', esc(longStamp(editedAt(n))))}
      ${row('Edited by', esc(byLabel(n.editedBy)))}
    </div>
    <div class="group-title">Where</div>
    <div class="group">
      <button type="button" class="item" data-info-move><span class="grow n-il">Folder</span><span class="value n-iv">${f ? `<span class="n-fd" style="background:${colorVar(f.color)}"></span>` : ''}<span class="truncate">${esc(f ? f.name : n.day ? 'Daily Notes' : 'Notes')}</span>${icon('chevron-right', { size: 16 })}</span></button>
      ${(n.tags || []).length ? `<div class="item n-info-tags">${(n.tags || []).map((t) => `<a class="n-tag" href="#/tag/${esc(encodeURIComponent(String(t).toLowerCase()))}">${esc(t)}</a>`).join('')}</div>` : ''}
    </div>
    ${ev || tasks.length ? `<div class="group-title">Linked</div><div class="group">
      ${ev ? `<a class="item" href="${esc(`${BASE}schedule/#/day/${ev.date}/event/${encodeURIComponent(ev.e.id)}`)}"><span class="eh-bar sm" style="background:${colorVar(ev.color)}"></span><span class="grow truncate">${esc(ev.e.title || 'Event')}</span><span class="value">${esc(dayLabel(ev.date))}</span></a>` : ''}
      ${tasks.map((t) => `<a class="item" href="${esc(`${BASE}tasks/#/task/${encodeURIComponent(t.id)}`)}">${icon(t.done ? 'check-circle' : 'circle', { size: 18 })}<span class="grow truncate">${esc(t.title || 'Task')}</span>${t.date ? `<span class="value">${esc(dayLabel(t.date))}</span>` : ''}</a>`).join('')}
    </div>` : ''}
    <div class="group-title">AI assistants</div>
    <div class="group">
      <div class="item"><span class="grow" id="info-ai-l">Hide from AI</span>${switchField({ name: 'infoAiHidden', checked: !!n.aiHidden || inheritHidden, labelledBy: 'info-ai-l', disabled: inheritHidden })}</div>
    </div>
    ${inheritHidden ? '<div class="group-foot">Hidden because its folder is hidden from AI.</div>' : ''}
    <div class="group n-info-hist"><button type="button" class="item" data-open-history><span class="grow">Version history</span><span class="value">${icon('history', { size: 16 })}${icon('chevron-right', { size: 16 })}</span></button></div>`;
}
function renderInfo() {
  if (!state.info) return;
  const html = `<div class="n-info-head"><h2>Info</h2><button type="button" class="icon-btn sm" data-close-info aria-label="Close info" ${tipAttrs('Close', 'i')}>${icon('x', { size: 18 })}</button></div><div class="n-info-body">${infoHtml()}</div>`;
  if (infoEl.dataset.h === html) return;
  const sc = $('.n-info-body', infoEl)?.scrollTop || 0;
  infoEl.innerHTML = html;
  infoEl.dataset.h = html;
  const body = $('.n-info-body', infoEl);
  if (body) body.scrollTop = sc;
}
function openInfoSheet() {
  openModal({
    title: 'Info',
    className: 'grouped n-infosheet',
    body: `<div class="modal-body n-info-body">${infoHtml()}</div>`,
    onMount: (el, close) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-outline]')) {
          close();
          safe(() => session?.editor?.scrollToBlock(e.target.closest('[data-outline]').dataset.outline, { flash: true }));
        } else if (e.target.closest('[data-open-history]')) {
          close();
          openHistory(session?.id);
        } else if (e.target.closest('[data-info-move]')) {
          close();
          const n = session?.note();
          if (n) folderPicker(noteTopEl, { current: noteFolder(n) || 'notes', onPick: (f) => moveNotes([n.id], f) });
        }
      });
      el.addEventListener('change', (e) => {
        if (e.target.matches('[name="infoAiHidden"]') && session?.note()) safe(() => core.setNoteAiHidden(session.id, e.target.value === 'true'));
      });
    },
  });
}

// ---------------------------------------------------------------- version history

async function openHistory(id) {
  const n = noteById(id);
  if (!n) return;
  flush(session);
  const available = await hist.historyAvailable();
  if (!available) {
    openModal({ title: 'Version history', body: `<div class="modal-body"><p class="muted">Version history isn't available in this browser mode.${n.aiPrev ? ' You can still undo the last AI edit from the banner.' : ''}</p></div>` });
    return;
  }
  // Earlier versions only (a restore snapshots the current state first, so it can be undone).
  const list = await hist.listRevisions(id);
  let sel = list[0]?.id || null;
  const current = blocksOf(n);
  const groupDay = (ts) => {
    const d = ymd(new Date(ts));
    const k = diffDays(d, todayYmd());
    return k === 0 ? 'Today' : k === 1 ? 'Yesterday' : fmt(new Date(ts), { weekday: 'short', day: 'numeric', month: 'short', ...(new Date(ts).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
  };
  const listHtml = () => {
    let last = '';
    return list
      .map((r) => {
        const g = groupDay(r.at);
        const head = g !== last ? `<div class="menu-label">${esc(g)}</div>` : '';
        last = g;
        const d = new Date(r.at);
        return `${head}<button type="button" class="menu-item n-hrow" role="option" data-rev="${esc(r.id)}" aria-selected="${r.id === sel}"><span class="grow truncate"><span class="tnum">${esc(fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`))}</span>${sep}${esc(byLabel(r.by))}</span>${isAiBy(r.by) ? icon(G.ai, { size: 14 }) : ''}</button>`;
      })
      .join('');
  };
  const changedVs = (blocks) => {
    const cur = new Map(current.map((b) => [b.id, JSON.stringify(b)]));
    return new Set(blocks.filter((b) => cur.get(b.id) !== JSON.stringify(b)).map((b) => b.id));
  };
  const previewHtml = () => {
    const r = list.find((x) => x.id === sel);
    if (!r) return '<p class="faint n-hist-none">No earlier versions yet. Versions are kept as you edit.</p>';
    return `<div class="n-hist-meta">${esc(longStamp(r.at))}${sep}${esc(byLabel(r.by))}</div><div class="n-static">${staticHtml(r.blocks, { changed: changedVs(r.blocks) })}</div>`;
  };
  // Nothing kept yet: one message, not an empty list beside disabled buttons.
  if (!list.length) {
    openModal({
      title: 'Version history',
      className: 'n-hist-emptymodal',
      body: `<div class="modal-body">${emptyState('history', 'No earlier versions yet', 'Versions are kept as you edit, in this browser.')}</div>`,
    });
    return;
  }
  openModal({
    title: 'Version history',
    className: 'wide n-histmodal',
    body: `<div class="n-hist">
      <div class="n-hist-list" role="listbox" aria-label="Versions">${listHtml()}</div>
      <div class="n-hist-preview" tabindex="0" aria-label="Preview">${previewHtml()}</div>
    </div>
    <div class="n-hist-actions"><span class="faint n-hint">Tinted blocks differ from the current note.</span><span class="grow"></span>
      <button type="button" class="btn btn-ghost btn-sm" data-h="copy"${sel ? '' : ' disabled'}>Copy as Markdown</button>
      <button type="button" class="btn btn-secondary btn-sm" data-h="copyas"${sel ? '' : ' disabled'}>Restore as copy</button>
      <button type="button" class="btn btn-primary btn-sm" data-h="restore"${sel ? '' : ' disabled'}>Restore</button></div>`,
    onMount: (el, close) => {
      const draw = () => {
        $('.n-hist-list', el).innerHTML = listHtml();
        $('.n-hist-preview', el).innerHTML = previewHtml();
        for (const b of $$('[data-h]', el)) b.disabled = !sel;
      };
      el.addEventListener('click', async (e) => {
        const row = e.target.closest('[data-rev]');
        if (row) {
          sel = row.dataset.rev;
          return draw();
        }
        const act = e.target.closest('[data-h]')?.dataset.h;
        const r = list.find((x) => x.id === sel);
        if (!act || !r) return;
        if (act === 'copy') {
          const ok = await ex.copyText(safe(() => blocksToMarkdown(r.blocks), ''));
          return toast(ok ? 'Copied as Markdown' : 'Could not copy');
        }
        if (act === 'copyas') {
          const title = `${r.title || displayTitle(n)} (restored ${fmt(new Date(), { day: 'numeric', month: 'short' })})`;
          const blocks = clone(r.blocks);
          const first = blocks.findIndex((b) => oneLine(blockText(b)));
          if (first >= 0) blocks[first] = { ...blocks[first], c: [[title]] };
          // A version too long for one note (text kept when a save didn't fit) can't come back as one.
          const copy = tryWrite(() => core.createNote({ folderId: n.folderId || null, blocks }), tooLargeToast);
          if (!copy) return;
          close();
          openNote(copy.id);
          return;
        }
        // Restore: snapshot what's there now first (with your latest typing saved), so it can be undone.
        if (session?.id === id) flush(session);
        const now = noteById(id);
        if (!now) return close();
        await hist.snapshot(now, { reason: 'restore', by: now.editedBy, force: true });
        const before = clone(noteById(id) || now);
        // Text too long to save, still only in the editor, gives way to the version (history keeps it).
        const lost = unsavedOn(id);
        let over = null;
        tryWrite(() => core.saveBlocks(id, clone(r.blocks), { by: 'user' }), (err) => (over = err));
        if (over) return tooLargeToast(over);
        // Also when the version is what the note holds already (nothing written): an editor still
        // holding text too long to save goes back to the note.
        showRevert(id);
        close();
        undoable(
          revertMsg('Restored this version', lost),
          () => {
            if (session?.id === id) flush(session);
            const gone = unsavedOn(id);
            const cur = noteById(id);
            // Back to the note as it was, with a newer rev (rev only goes up: an AI's ifRev relies on it).
            db.put('notes', { ...before, rev: Math.max(Number(cur?.rev) || 0, Number(before.rev) || 0) + 1 });
            showRevert(id);
            if (gone) toast(asideOf(), { duration: 8000 });
          },
          'restore',
        );
      });
      el.addEventListener('keydown', (e) => {
        if (!e.target.closest('.n-hist-list') || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
        e.preventDefault();
        const i = list.findIndex((x) => x.id === sel) + (e.key === 'ArrowDown' ? 1 : -1);
        if (i < 0 || i >= list.length) return;
        sel = list[i].id;
        draw();
        $(`[data-rev="${CSS.escape(sel)}"]`, el)?.focus();
      });
      list.length && $(`[data-rev="${CSS.escape(sel)}"]`, el)?.focus({ preventScroll: true });
    },
  });
}

// ---------------------------------------------------------------- import / export

function pickImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip';
  input.multiple = true;
  input.hidden = true;
  const cleanup = () => input.remove();
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    cleanup();
    if (files.length) importFiles(files);
  }, { once: true });
  input.addEventListener('cancel', cleanup, { once: true });
  document.body.append(input);
  input.click();
}
/**
 * The folder for an imported note's `folder:` path ('Work/Clients'), made when missing (three levels
 * at most; deeper parts land in the third). 'Notes' is the default folder → null.
 */
function importFolder(path, made) {
  const parts = String(path || '').split('/').map((s) => s.trim()).filter(Boolean).slice(0, MAX_DEPTH);
  if (!parts.length || (parts.length === 1 && parts[0].toLowerCase() === 'notes')) return null;
  const key = parts.join('/').toLowerCase();
  if (made.has(key)) return made.get(key);
  let parent = null;
  for (let i = 0; i < parts.length; i++) {
    const hit = safe(() => schema.resolveFolderPath(parts.slice(0, i + 1).join('/'), folders()), null);
    // resolveFolderPath falls back to a unique name anywhere: only accept the folder at this level.
    if (hit && (hit.parentId || null) === (parent?.id || null)) {
      parent = hit;
      continue;
    }
    try {
      parent = core.createFolder({ name: parts[i], parentId: parent?.id || null });
    } catch {
      break; // too deep or refused: the levels made so far will do
    }
  }
  const id = parent?.id || null;
  made.set(key, id);
  return id;
}
async function importFiles(files) {
  const drafts2 = await ex.readMarkdownFiles(files, { resolveNote: noteByTitle });
  if (!drafts2.length) return toast('Only Markdown (.md), text (.txt) and Export all (.zip) files can be imported.');
  const here = state.view === 'folder' && state.folderId !== 'notes' ? state.folderId : null;
  const made = [];
  const madeFolders = new Map();
  // Files that don't fit in one note are named, not cut short (readMarkdownFiles flags them first).
  const tooLong = drafts2.filter((d) => d.tooLong).map((d) => d.name);
  // A checklist item stays linked to its task only when this browser has the task and no other note
  // links it already (an imported copy of a note must not drive the same tasks as the original).
  const linked = new Set(liveNotes().flatMap((n) => blocksOf(n).filter((b) => b?.task).map((b) => b.task)));
  const unlinkTaken = (blocks) =>
    blocks.map((b) => {
      if (!b?.task) return b;
      if (!linked.has(b.task) && db.get('tasks', b.task)) {
        linked.add(b.task);
        return b;
      }
      const { task: _drop, ...rest } = b;
      return rest;
    });
  db.batch(() => {
    for (const d of drafts2) {
      if (d.tooLong) continue;
      // An exported daily note comes back as that day's note, unless the day has one already.
      const day = d.day && !safe(() => core.dailyNote(d.day, { create: false }), null) && !made.some((x) => x.day === d.day) ? d.day : null;
      // Meeting notes come back linked to their event, when it is here and has no meeting notes yet.
      const ev = !day && d.event && db.get('events', d.event.id) && !safe(() => core.meetingNote(d.event.id, d.event.date, { create: false }), null) && !made.some((x) => x.event?.id === d.event.id && x.event?.date === d.event.date) ? d.event : null;
      const folderId = day ? null : d.folder ? importFolder(d.folder, madeFolders) : here;
      const blocks = unlinkTaken(d.blocks);
      const n = tryWrite(() => core.createNote({ folderId, day, event: ev, blocks, pinned: d.pinned }), () => tooLong.push(d.name));
      if (!n) continue;
      // Keep the dates from the file's front matter.
      const dates = {};
      if (d.createdAt) dates.createdAt = d.createdAt;
      if (d.editedAt) dates.editedAt = d.editedAt;
      made.push(Object.keys(dates).length ? db.update('notes', n.id, dates) || n : n);
    }
  });
  const longMsg = tooLongMessage(tooLong);
  if (!made.length) return toast(longMsg || 'Could not import those files.', longMsg ? { duration: 10000 } : undefined);
  const folderCount = madeFolders.size ? new Set([...madeFolders.values()].filter(Boolean)).size : 0;
  toast(`Imported ${plural(made.length, 'note')}${folderCount ? ` into ${plural(folderCount, 'folder')}` : ''}${longMsg ? `. ${longMsg}` : ''}`, { action: 'Show', onAction: () => openNote(made[0].id), ...(longMsg ? { duration: 10000 } : {}) });
}
/** “Big.md” is too long… / 3 files (“a.md”, “b.md” and 1 more) are too long… → '' when none. */
function tooLongMessage(names) {
  if (!names.length) return '';
  const q = (s) => `“${String(s || 'file').slice(0, 60)}”`;
  if (names.length === 1) return `${q(names[0])} is too long for one note, so it wasn't imported. Split it into smaller files.`;
  const shown = names.slice(0, 2).map(q).join(', ');
  const rest = names.length > 2 ? ` and ${names.length - 2} more` : '';
  return `${names.length} files (${shown}${rest}) are too long for one note, so they weren't imported. Split them into smaller files.`;
}
function exportAllNotes() {
  flush(session);
  const n = ex.exportAll(db.all('notes') || [], folders(), { noteTitle: currentTitle });
  toast(n ? `Exported ${plural(n, 'note')}` : 'There are no notes to export yet.');
}

// ---------------------------------------------------------------- notes settings

function storageUsage() {
  let total = 0;
  let notes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      const v = localStorage.getItem(k) || '';
      const bytes = (k.length + v.length) * 2;
      total += bytes;
      if (/^ecosys:v1:notes(\/|$)/.test(k)) notes += bytes;
    }
  } catch {
    /* blocked */
  }
  return { total, notes, limit: 5 * 1024 * 1024 };
}
const mb = (b) => (b < 1024 * 1024 ? `${Math.max(0.1, b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

function notesSettings() {
  const s = settings.get() || {};
  const seg = (key, opts, label, cur) => `<div class="segmented" role="group" aria-label="${esc(label)}">${opts.map(([v, l]) => `<button type="button" data-ns="${esc(key)}" data-val="${esc(v)}" aria-pressed="${String(cur) === String(v)}">${esc(l)}</button>`).join('')}</div>`;
  const row = (label, control, id = '') => `<div class="item"><span class="grow"${id ? ` id="${id}"` : ''}>${esc(label)}</span>${control}</div>`;
  const folderOpts = [{ value: '', label: 'Notes' }, ...tree().map((r) => ({ value: r.folder.id, label: r.folder.name, color: r.folder.color }))];
  const u = storageUsage();
  const pct = Math.min(100, Math.round((u.total / u.limit) * 100));
  const trashN = (db.all('notes') || []).filter((n) => n?.trashedAt).length;
  openModal({
    title: 'Notes settings',
    className: 'settings grouped n-settings',
    body: `<div class="modal-body"><div class="settings-body">
      <div class="group-title">Writing</div>
      <div class="group">
        ${row('New notes start with', seg('notesNewStyle', [['h1', 'Title'], ['h2', 'Heading'], ['p', 'Body']], 'New notes start with', s.notesNewStyle || 'h1'))}
        ${row('Markdown shortcuts', switchField({ name: 'notesMarkdown', checked: s.notesMarkdown !== false, labelledBy: 'ns-md' }), 'ns-md')}
        ${row('Sort checked items', seg('notesCheckedSort', [['auto', 'Automatically'], ['manual', 'Manually']], 'Sort checked items', s.notesCheckedSort || 'auto'))}
        ${row('Text size', seg('notesTextSize', [['s', 'S'], ['m', 'M'], ['l', 'L']], 'Text size', s.notesTextSize || 'm'))}
      </div>
      <div class="group-foot">Markdown shortcuts turn “# ”, “- [ ] ”, “**bold**” and friends into formatting as you type.</div>
      <div class="group-title">Lists</div>
      <div class="group">
        ${row('Sort notes by', selectField({ name: 'notesSort', value: s.notesSort || 'edited', options: [{ value: 'edited', label: 'Date Edited' }, { value: 'created', label: 'Date Created' }, { value: 'title', label: 'Title' }], ariaLabel: 'Sort notes by', className: 'compact' }))}
        ${row('Group by date', switchField({ name: 'notesGroupByDate', checked: s.notesGroupByDate !== false, labelledBy: 'ns-group' }), 'ns-group')}
        ${row('Show notes as', seg('notesView', [['list', 'List'], ['gallery', 'Gallery']], 'Show notes as', s.notesView || 'list'))}
      </div>
      <div class="group-foot">Folders can override these from their Sort menu.</div>
      <div class="group-title">Meetings &amp; AI</div>
      <div class="group">
        ${row('Meeting notes go to', selectField({ name: 'notesMeetingFolder', value: s.notesMeetingFolder || '', options: folderOpts, ariaLabel: 'Meeting notes folder', className: 'compact' }))}
        ${row('AI assistants can', seg('notesAi', [['edit', 'Read & edit'], ['read', 'Read'], ['off', 'Off']], 'AI access to notes', s.notesAi || 'edit'))}
      </div>
      <div class="group-foot">Notes and folders you hide from AI are never shown to assistants, whatever this is set to.</div>
      <div class="group-title">Your data</div>
      <div class="group">
        <div class="item n-usage"><span class="grow">Storage</span><span class="value tnum">Notes ${esc(mb(u.notes))} of ~5 MB</span></div>
        <div class="n-meter" role="meter" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"${pct >= 80 ? ' class="hot"' : ''}></span></div>
        <button type="button" class="item" data-ns-act="export"><span class="grow">Export all notes (.zip)</span><span class="value">${icon('download', { size: 16 })}</span></button>
        <button type="button" class="item" data-ns-act="import"><span class="grow">Import Markdown…</span><span class="value">${icon('upload', { size: 16 })}</span></button>
        <button type="button" class="item" data-ns-act="trash"${trashN ? '' : ' disabled'}><span class="grow danger-text">Empty Recently Deleted</span><span class="value tnum">${trashN || ''}</span></button>
      </div>
    </div></div>`,
    onMount: (el, close) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ns]');
        if (b) {
          settings.set({ [b.dataset.ns]: b.dataset.val });
          for (const x of $$(`[data-ns="${CSS.escape(b.dataset.ns)}"]`, el)) x.setAttribute('aria-pressed', String(x === b));
          return;
        }
        const a = e.target.closest('[data-ns-act]')?.dataset.nsAct;
        if (a === 'export') exportAllNotes();
        else if (a === 'import') {
          close();
          pickImport();
        } else if (a === 'trash') {
          close();
          emptyTrash();
        }
      });
      el.addEventListener('change', (e) => {
        const t = e.target;
        const name = t.getAttribute?.('name');
        if (!name) return;
        if (t.matches('[role="switch"]')) settings.set({ [name]: t.value === 'true' });
        else if (t.matches('[data-select]')) settings.set({ [name]: t.value || null });
      });
    },
  });
}

// ---------------------------------------------------------------- Quick Note (#/quick)

let quickEl = null;
let quickScrim = null;
let quickBack = null; // what had the focus before Quick Note opened (it gets it back)
let quickInert = []; // phones: what the sheet made inert
const phoneSheet = () => matchMedia('(max-width: 699px)').matches;
/**
 * On a phone Quick Note is a sheet over a scrim: modal, the page behind out of reach until it closes. On
 * a desk it floats beside the notes and the page stays usable. Follows the layout (a turned phone, a
 * resized window).
 */
function quickModality() {
  if (!quickEl) return;
  const sheet = phoneSheet();
  if (sheet) quickEl.setAttribute('aria-modal', 'true');
  else quickEl.removeAttribute('aria-modal');
  if (sheet && !quickInert.length) {
    quickInert = [...document.body.children].filter((n) => n !== quickEl && n !== quickScrim && !n.inert && !n.matches('.toasts, .tooltip, [data-announcer], script'));
    for (const n of quickInert) n.inert = true;
  } else if (!sheet && quickInert.length) {
    for (const n of quickInert) n.inert = false;
    quickInert = [];
  }
}
function openQuick() {
  if (quickEl) return void $('[data-quick-editor] .ne-doc, [data-quick-editor]', quickEl)?.focus();
  quickBack = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const wrap = document.createElement('div');
  wrap.className = 'n-quick';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'Quick note');
  wrap.innerHTML = `<div class="grabber" aria-hidden="true"></div><div class="n-quick-head">
      <div class="segmented" role="group" aria-label="Quick note goes to"><button type="button" data-qmode="new" aria-pressed="${ui.quickMode === 'new'}">New note</button><button type="button" data-qmode="today" aria-pressed="${ui.quickMode === 'today'}">Add to Today</button></div>
      <span class="grow"></span>
      <button type="button" class="btn btn-ghost btn-sm" data-quick="open">Open in Notes</button>
      <button type="button" class="btn btn-tint btn-sm" data-quick="done">Done</button>
    </div>
    <div class="n-quick-body"><div class="n-quick-banner" data-quick-banner hidden></div><div class="n-editor" data-quick-editor></div></div>`;
  quickScrim = document.createElement('div');
  quickScrim.className = 'scrim n-quick-scrim';
  quickScrim.setAttribute('aria-hidden', 'true');
  quickScrim.addEventListener('click', () => closeQuick());
  document.body.append(quickScrim, wrap);
  quickEl = wrap;
  quickModality();
  startQuick();
  wrap.addEventListener('click', (e) => {
    const m = e.target.closest('[data-qmode]');
    if (m) {
      if (ui.quickMode === m.dataset.qmode) return;
      ui.quickMode = m.dataset.qmode;
      saveUi();
      for (const b of $$('[data-qmode]', wrap)) b.setAttribute('aria-pressed', String(b === m));
      return startQuick();
    }
    const a = e.target.closest('[data-quick]')?.dataset.quick;
    if (a === 'done') closeQuick();
    else if (a === 'open') {
      const id = quick?.id;
      const wasDraft = !!quick?.draft;
      closeQuick();
      if (id && !wasDraft && noteById(id)) openNote(id);
    }
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !hasOpenLayer()) {
      e.preventDefault();
      closeQuick();
    }
  });
}
function startQuick() {
  if (quick) closeQuickSession(quick);
  const host = $('[data-quick-editor]', quickEl);
  host.replaceChildren();
  const banner = $('[data-quick-banner]', quickEl);
  if (banner) {
    banner.replaceChildren();
    banner.hidden = true;
  }
  let note = null;
  let draft = null;
  const mode = ui.quickMode;
  if (mode === 'today') {
    const day = todayYmd();
    note = safe(() => core.dailyNote(day, { create: false }), null);
    if (!note || note.trashedAt) {
      note = null;
      draft = makeDraft({ day });
    }
  } else {
    const last = noteById(ui.lastQuickId);
    // Resume the last quick note if it was edited less than 5 minutes ago (the Drafts idea): a note of
    // its own only, never a day's note or meeting notes.
    if (last && !last.trashedAt && !last.day && !last.event && Date.now() - Math.max(ui.lastQuickAt, editedAt(last)) < 5 * 60000) note = last;
    else draft = makeDraft({});
  }
  // The main editor can't hold the same note at the same time.
  if (note && session?.id === note.id) flush(session);
  // Add to Today: what you type is a line of its own below the day's note (a Body line), never the end
  // of its last line. That line is only stored once something is typed in it (see closeQuick).
  let blank = null;
  if (mode === 'today' && note) {
    const last = blocksOf(note).at(-1);
    blank = last && last.t === 'p' && !oneLine(blockText(last)) && !last.task ? null : nb('p', '');
    const at = blank || last;
    quick = openSession(host, { note, main: false, extra: blank, focus: at ? { blockId: at.id, offset: 0 } : 'end' });
  } else quick = openSession(host, { note, draft, main: false, focus: 'end' });
  quick.mode = mode;
  quick.blankId = blank?.id || null;
}
/** Close Quick Note's editor. The line Add to Today began with, if it was stored but left empty, goes (nothing of yours is in it). */
function closeQuickSession(q) {
  const { id, blankId } = q;
  closeSession(q);
  const n = noteById(id);
  const b = n && blankId ? blocksOf(n).find((x) => x.id === blankId) : null;
  if (b && blocksOf(n).at(-1)?.id === blankId && !oneLine(blockText(b)) && blocksOf(n).length > 1) safe(() => core.saveBlocks(id, blocksOf(n).filter((x) => x.id !== blankId), { by: 'user' }));
  return n ? noteById(id) : null;
}
function closeQuick() {
  if (!quickEl) return;
  if (quick) {
    const { id, mode } = quick;
    const n = closeQuickSession(quick);
    // "New note" picks up where you left off for a few minutes; Add to Today never takes its place.
    if (n && mode !== 'today' && !n.day && !n.event) {
      ui.lastQuickId = id;
      ui.lastQuickAt = Date.now();
      saveUi();
    }
    if (n && session?.id === id) external(session, noteById(id));
  }
  quick = null;
  quickEl.remove();
  quickEl = null;
  quickScrim?.remove();
  quickScrim = null;
  for (const n of quickInert) n.inert = false;
  quickInert = [];
  // The keyboard goes back where it was (the list, the note, the button that opened it).
  const back = quickBack;
  quickBack = null;
  if (back && document.contains(back) && !back.closest('[inert]')) back.focus({ preventScroll: true });
  else if (cols() === 1 && state.screen !== 'note') focusList();
  else if (session?.editor && !session.readOnly) safe(() => session.editor.focus());
  else focusList();
  scheduleRender();
}

// ---------------------------------------------------------------- routing

function route() {
  lastHash = location.hash;
  const r = parseHash();
  if (r.special === 'quick') {
    history.replaceState(history.state, '', history.state?.parent && !/quick/.test(history.state.parent) ? history.state.parent : '#/all');
    route();
    return openQuick();
  }
  if (r.special === 'new') return routeNew(r);
  if (r.special === 'folders') {
    if (cols() > 1) return nav('#/all', { replace: true });
  }
  if (r.special === 'root' && cols() > 1) return nav('#/all', { replace: true });
  // A folder or tag that no longer exists shows All Notes.
  if (r.view === 'folder' && r.folderId !== 'notes' && !folderById(r.folderId)) r.view = 'all';
  const prevKey = `${state.view}|${state.folderId}|${state.tags.join('+')}|${state.tagMode}|${state.scope}`;
  const prevScreen = state.screen;
  const prevNote = state.noteId;
  Object.assign(state, { view: r.view, folderId: r.folderId, tags: r.tags, tagMode: r.tagMode, scope: r.scope, day: r.view === 'today' ? r.day : null, noteId: r.noteId, blockId: r.blockId });
  if (r.view === 'search') {
    state.q = r.q;
    if (qEl.value !== r.q && document.activeElement !== qEl) qEl.value = r.q;
  } else {
    state.q = '';
    if (document.activeElement !== qEl) qEl.value = '';
    searchFrom = null;
  }
  const key = `${state.view}|${state.folderId}|${state.tags.join('+')}|${state.tagMode}|${state.scope}`;
  if (key !== prevKey) {
    rendered = state.view === 'search' ? SEARCH_FIRST : CHUNK;
    state.sel.clear();
    state.anchor = null;
    if (state.selectMode && state.view === 'search') state.selectMode = false;
  }
  // Daily notes are routed by date; the stored note (if any) is the open row.
  if (state.view === 'today' && state.day) {
    const dn = safe(() => core.dailyNote(state.day, { create: false }), null);
    state.noteId = dn && !dn.trashedAt ? dn.id : null;
  }
  // A link to a note this browser doesn't have: it may be on its way (made elsewhere and not synced here
  // yet), so it waits for the first sync; once that is in and the note still isn't, the list shows.
  const waiting = pendingNote;
  pendingNote = null;
  if (state.noteId && !drafts.has(state.noteId) && !noteById(state.noteId)) {
    if (!syncSettled()) pendingNote = { id: state.noteId, blockId: state.blockId };
    else {
      // Said when a link (the page's first, or one that waited for sync) found nothing; Back to a
      // note left empty and put away just shows the list.
      if (waiting?.id === state.noteId || !routed) toast('That note no longer exists.');
      state.noteId = null;
      state.blockId = null;
      history.replaceState(history.state, '', listHash());
      lastHash = location.hash;
    }
  }
  routed = true;
  // Phones: which screen.
  if (cols() === 1) state.screen = r.special === 'folders' || r.special === 'root' ? 'folders' : state.noteId || state.day ? 'note' : 'list';
  else state.screen = 'list';
  shellEl.classList.remove('nav-open');
  applyLayout();
  // Desktop: like Apple Notes, a list always shows a note — the first one when none is named.
  if (cols() > 1 && !state.noteId && !state.day && state.view !== 'search') {
    const first = buildList().items.find((it) => it.id)?.id || listNoteIds[0];
    if (first) {
      history.replaceState(history.state, '', noteHash(first));
      lastHash = location.hash;
      state.noteId = first;
      if (state.view === 'today') state.day = noteById(first)?.day || null;
    }
  }
  const switched = syncEditor();
  renderSidebar();
  renderList({ keepScroll: key === prevKey });
  renderListHead();
  if (key !== prevKey) listEl.scrollTop = 0;
  renderSearchOpts();
  renderSelBar();
  if (!switched) renderNoteChrome();
  if (state.blockId && session?.editor) {
    const b = state.blockId;
    requestAnimationFrame(() => safe(() => session.editor.scrollToBlock(b, { flash: true })));
  }
  if (switched && state.view === 'search' && state.q && session?.editor && !session.draft) {
    // Opened from search: mark every match and show the find bar ("1 of 7"), without taking focus.
    const hit = searchHitTerm(state.q);
    if (hit) requestAnimationFrame(() => openFind(hit, { focus: false }));
  }
  // Keep the open row in view.
  if (state.noteId) $(`#row-${CSS.escape(state.noteId)}`, listEl)?.scrollIntoView({ block: 'nearest' });
  if (keepDayStep) {
    // A day stepped from the keyboard: the header was drawn again for the new day; its button keeps the keyboard.
    const dir = keepDayStep;
    keepDayStep = null;
    $(`[data-day-step="${dir === '-1' ? '-1' : '1'}"]`, liveHeadEl)?.focus({ preventScroll: true });
  }
  if (cols() === 1 && prevScreen !== state.screen) focusScreen(prevNote);
}
/**
 * Phones: the screen changed (Folders → List → Note and back), and the one you left is inert now. The
 * keyboard (and a screen reader) moves to the new one: the note's Back button (unless its editor takes
 * the caret), the row of the note you came back from, or the open folder.
 */
function focusScreen(fromNote) {
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest('[inert]')) return; // something took it already (the editor, a dialog)
    if (hasOpenLayer() || quickEl) return;
    if (state.screen === 'note') return void $('[data-back-to-list]', noteTopEl)?.focus({ preventScroll: true });
    if (state.screen === 'list') {
      if (fromNote && focusRow(fromNote, { scroll: true })) return;
      return void ($('.n-lh-title', listHeadEl) || listEl).focus({ preventScroll: true });
    }
    ($('#nav .nav-item[aria-current="true"]') || $('#nav .nav-item'))?.focus({ preventScroll: true });
  });
}
/** The word or phrase to mark in a note opened from search. */
function searchHitTerm(q) {
  let p = null;
  try {
    p = parseQuery(q);
  } catch {
    p = null;
  }
  const words = [...(p?.phrases || []), ...(p?.terms || [])].map(String).filter(Boolean);
  return words.sort((a, b) => b.length - a.length)[0] || createTitle(q);
}

/** #/new and #/new?event=<id>&date=<ymd>: a new note, or the meeting notes of an event (created on first edit). */
function routeNew(r) {
  if (r.event) {
    const e = db.get('events', r.event);
    const date = r.date || (e ? String(e.start).slice(0, 10) : todayYmd());
    const existing = safe(() => core.meetingNote(r.event, date, { create: false }), null);
    if (existing) return openNote(existing.id, { replace: true, v: { ...state, view: 'all' } });
    if (!e) {
      toast('That event no longer exists.');
      return nav('#/all', { replace: true });
    }
    const d = makeDraft({ event: { id: e.id, date, title: e.title || 'Meeting' } });
    return nav(noteHash(d.id, { v: { ...state, view: 'all' } }), { replace: true });
  }
  const d = makeDraft({ folderId: r.folderId && folderById(r.folderId) ? r.folderId : null });
  pendingFocus = 'start';
  nav(noteHash(d.id, { v: d.folderId ? { ...state, view: 'folder', folderId: d.folderId } : { ...state, view: 'all' } }), { replace: true });
}

function renderAll() {
  applyLayout();
  renderSidebar();
  renderList();
  renderListHead();
  renderSearchOpts();
  renderSelBar();
  renderNoteChrome();
}
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

// ---------------------------------------------------------------- selection & keyboard navigation

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.sel.clear();
  renderListHead();
  renderList();
  renderSelBar();
  renderNoteChrome();
}
function clickRow(id, e) {
  const mod = e && (isMac ? e.metaKey : e.ctrlKey);
  if (state.selectMode || mod || (e?.shiftKey && (state.anchor || state.noteId))) {
    if (e?.shiftKey && !state.selectMode) {
      const a = listNoteIds.indexOf(state.anchor || state.noteId);
      const b = listNoteIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        state.sel = new Set(listNoteIds.slice(Math.min(a, b), Math.max(a, b) + 1));
        if (state.noteId) state.sel.add(state.noteId);
      }
    } else {
      if (!state.sel.size && state.noteId && !state.selectMode) state.sel.add(state.noteId);
      state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
      state.anchor = id;
    }
    renderList();
    renderSelBar();
    renderNoteChrome();
    return;
  }
  state.sel.clear();
  state.anchor = id;
  if (drafts.has(id)) return;
  if (id === state.noteId && cols() > 1) return renderSelBar();
  openNote(id, { v: state });
}
/**
 * Move through the list from the focused row (else the open note): a number of rows (j k ↑ ↓, or a page),
 * or 'first' / 'last' (Home / End). Wide layouts open the note there (Apple Notes); phones and Select
 * mode move the focus only, and Enter or Space opens (or picks) it.
 */
function moveSel(step) {
  const ids = listNoteIds;
  if (!ids.length) return;
  const focused = document.activeElement?.closest?.('#list [data-id]')?.dataset.id;
  const from = focused && ids.includes(focused) ? focused : state.noteId;
  const i = ids.indexOf(from);
  const j = step === 'first' ? 0 : step === 'last' ? ids.length - 1 : i < 0 ? 0 : clamp(i + step, 0, ids.length - 1);
  const next = ids[j];
  if (!next) return;
  if (cols() === 1 || state.selectMode) return focusRow(next);
  if (next !== state.noteId) openNote(next, { v: state, replace: true });
  requestAnimationFrame(() => focusRow(next));
}
/** Focus a row (rendering more of the list first when it is further down), and make it the list's tab stop. */
function focusRow(id, { scroll = true } = {}) {
  let row = $(`#row-${CSS.escape(id)}`, listEl);
  if (!row) {
    const i = listNoteIds.indexOf(id);
    if (i >= 0 && i >= rendered) {
      rendered = i + CHUNK;
      renderList();
      row = $(`#row-${CSS.escape(id)}`, listEl);
    }
  }
  if (!row) return false;
  for (const r of listEl.querySelectorAll('[data-id][tabindex="0"]')) if (r !== row) r.tabIndex = -1;
  row.tabIndex = 0;
  row.focus({ preventScroll: true });
  if (scroll) row.scrollIntoView({ block: 'nearest' });
  return true;
}
function focusList() {
  const row = (state.noteId && $(`#row-${CSS.escape(state.noteId)}`, listEl)) || $('[data-id]', listEl);
  (row || listEl).focus({ preventScroll: false });
}
function toggleSidebar() {
  const c = cols();
  if (c === 3) {
    ui.sideHidden = !ui.sideHidden;
    saveUi();
    applyLayout();
    renderListHead();
  } else if (c === 2) {
    if (shellEl.classList.contains('nav-open')) return closeDrawer();
    shellEl.classList.add('nav-open');
    applyLayout();
    ($('#sidebar .nav-item[aria-current="true"]') || $('#nav .nav-item'))?.focus();
  }
}
function toggleFocusMode() {
  state.focusMode = !state.focusMode;
  applyLayout();
  renderNoteChrome();
  if (state.focusMode) safe(() => session?.editor?.focus('end'));
}
function goToday() {
  nav('#/today');
}

const typingIn = (e) => isTyping(e) || !!e.target?.closest?.('[contenteditable="true"]');
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const altGr = !isMac && e.getModifierState?.('AltGraph');
  // Everywhere (also while typing): new note, search, sidebar, focus mode, find, history.
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyN' && !altGr) {
    e.preventDefault();
    return newNote();
  }
  if ((isMac && mod && e.altKey && e.code === 'KeyF') || (!isMac && mod && e.shiftKey && e.code === 'KeyF')) {
    e.preventDefault();
    return focusSearch();
  }
  if (mod && e.code === 'Backslash' && !altGr) {
    e.preventDefault();
    return e.shiftKey ? toggleFocusMode() : toggleSidebar();
  }
  if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyF') {
    // A second Mod+F while the find bar has focus is the browser's own find.
    if (document.activeElement === $('input', findEl)) return;
    if (session?.editor && !quickEl && !multiSel()) {
      e.preventDefault();
      return openFind(safe(() => getSelection()?.toString(), '').slice(0, 80));
    }
  }
  if (isMac && mod && e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    return e.code === 'BracketLeft' ? history.back() : history.forward();
  }
  if (e.defaultPrevented || hasOpenLayer() || quickEl) return;
  // The folder drawer (700–1099px) is modal: Esc closes it.
  if (e.key === 'Escape' && shellEl.classList.contains('nav-open')) {
    e.preventDefault();
    return closeDrawer();
  }
  // Esc in the editor goes back to the list.
  if (e.key === 'Escape' && e.target.closest?.('#editorhost')) {
    e.preventDefault();
    if (cols() === 1) return backToList();
    return focusList();
  }
  if (typingIn(e)) return;
  // Enter and Space belong to the focused link, button or field control (the browser activates it): the
  // shortcuts below never cancel that. A list row handles its own Enter (see the list's keydown).
  if ((e.key === 'Enter' || e.key === ' ') && onControl(e.target)) return;
  if (mod && e.key.toLowerCase() === 'a' && e.target.closest?.('#list')) {
    e.preventDefault();
    state.sel = new Set(listNoteIds);
    renderList();
    renderSelBar();
    return renderNoteChrome();
  }
  const delKey = isMac ? mod && e.key === 'Backspace' : e.key === 'Delete' && !mod;
  // Only from the list or the note: on a folder, a tag or a button elsewhere it must not delete the open note.
  if (delKey && e.target.closest?.('#list, #notecol')) {
    const ids = state.sel.size ? [...state.sel] : state.noteId && !drafts.has(state.noteId) ? [state.noteId] : [];
    if (!ids.length) return;
    e.preventDefault();
    return state.view === 'trash' ? deleteNow(ids) : trash(ids);
  }
  if (mod || e.altKey) return;
  // Settings > Keyboard > Single-key shortcuts off: N, T, /, J, K, P, M, V and I do nothing (WCAG 2.1.4);
  // Enter, Esc and the arrows keep working.
  if (singleKeyOff(e)) return;
  const k = e.key;
  // The note-to-note keys work from the list and the page itself, never from the sidebar, a toolbar or a
  // link (an arrow there is that control's, or nothing).
  const fromList = e.target === document.body || e.target === document.documentElement || !!e.target.closest?.('#list');
  const map = {
    n: () => newNote(),
    t: () => goToday(),
    '/': () => focusSearch(),
    j: () => fromList && moveSel(1),
    k: () => fromList && moveSel(-1),
    ArrowDown: () => fromList && moveSel(1),
    ArrowUp: () => fromList && moveSel(-1),
    // Enter on the page (nothing focused) edits the note; a focused row or control handles its own Enter.
    Enter: () => fromList && !multiSel() && session?.editor && !session.readOnly && safe(() => session.editor.focus('end')),
    Escape: () => {
      if (state.sel.size || state.selectMode) return setSelectMode(false);
      if (state.info) return toggleInfo(false);
      if (state.view === 'search') return exitSearch();
      if (cols() === 1 && state.screen === 'note') return backToList();
    },
    p: () => state.noteId && !drafts.has(state.noteId) && togglePin(state.sel.size ? [...state.sel] : [state.noteId]),
    m: () => {
      const ids = state.sel.size ? [...state.sel] : state.noteId && !drafts.has(state.noteId) ? [state.noteId] : [];
      if (!ids.length) return;
      const anchor = (state.noteId && $(`#row-${CSS.escape(state.noteId)}`, listEl)) || noteTopEl;
      folderPicker(anchor, { current: ids.length === 1 ? noteFolder(noteById(ids[0])) || 'notes' : null, onPick: (f) => moveNotes(ids, f) });
    },
    v: () => state.view !== 'trash' && state.view !== 'search' && setView(sortCfg().view === 'gallery' ? 'list' : 'gallery'),
    i: () => session && !multiSel() && toggleInfo(),
  };
  if (!Object.hasOwn(map, k)) return;
  // An arrow or J/K away from the list is left to the browser (and the control under it).
  if (!fromList && ['j', 'k', 'ArrowDown', 'ArrowUp', 'Enter'].includes(k)) return;
  e.preventDefault();
  map[k]();
});
/** A control that owns Enter and Space: a link, button, field or widget role (not a list row: see the list's keydown). */
const CONTROL = 'a[href], button, summary, input, select, textarea, label, [contenteditable="true"], [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"], [role="separator"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="treeitem"]';
function onControl(t) {
  return !!t?.closest?.(CONTROL) && !(t.closest('#list [data-id]') && !t.closest('#list [data-id] :is(a[href], button, input)'));
}
/** Several notes are selected on a wide layout: the note column shows them as a stack, and the note's own tools are off. */
function multiSel() {
  return state.sel.size > 1 && cols() > 1;
}
function focusSearch() {
  if (cols() === 1 && state.screen !== 'list') {
    nav(listHash());
  }
  requestAnimationFrame(() => {
    qEl.focus();
    qEl.select();
    renderSearchOpts();
  });
}

qEl.addEventListener('input', onSearchInput);
qEl.addEventListener('focus', renderSearchOpts);
// The filter chips stay while focus is on them (Tab from the field), and go once it leaves both. The
// pause lets a click on a chip land first (Safari never focuses a clicked button).
const searchBlur = (e) => {
  if (e.relatedTarget instanceof Element && (e.relatedTarget === qEl || searchOptsEl.contains(e.relatedTarget))) return;
  setTimeout(renderSearchOpts, 150);
};
qEl.addEventListener('blur', searchBlur);
searchOptsEl.addEventListener('focusout', searchBlur);
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (!qEl.value.trim()) return;
    flushSearch();
    clearTimeout(keepTimer);
    createFromSearch();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    flushSearch();
    clearTimeout(keepTimer);
    const first = $('[data-id]', listEl);
    if (first) {
      const id = first.dataset.id;
      // Phones move to the results (Enter opens one); wide layouts show the first one.
      if (cols() > 1 && id !== state.noteId && !drafts.has(id)) openNote(id, { v: state, replace: true });
      requestAnimationFrame(() => focusRow(id));
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(searchTimer);
    searchGo = null;
    clearTimeout(keepTimer);
    if (qEl.value || state.view === 'search') {
      qEl.value = '';
      if (state.view === 'search') exitSearch();
      else renderSearchOpts();
    }
    // The keyboard goes to the list (the open note's row), never to the page.
    focusList();
    renderSearchOpts();
  }
});

registerShortcuts([
  {
    title: 'Notes',
    items: [
      ['New note', isMac ? 'n / alt mod N' : 'n / ctrl alt N'],
      ["Today's note", 't'],
      ['Search notes', isMac ? '/ / alt mod F' : '/ / ctrl shift F'],
      ['Next / previous note', 'j / k'],
      ['Edit the note / back to the list', 'enter / esc'],
      ['Pin', 'p'],
      ['Move to a folder', 'm'],
      ['List or gallery', 'v'],
      ['Info', 'i'],
      ['Delete', isMac ? 'mod backspace' : 'delete'],
      ['Select all in the list', 'mod A'],
      ['Sidebar', 'mod \\'],
      ['Focus mode', shiftMod('\\')],
      ['Back / forward', isMac ? 'alt mod [ / alt mod ]' : 'alt left / alt right'],
    ],
  },
  {
    title: 'Writing',
    items: [
      ['Bold, italic, underline', 'mod B / mod I / mod U'],
      ['Strikethrough', shiftMod('X')],
      ['Inline code', 'mod E'],
      ['Highlight', shiftMod('H')],
      ['Link', 'mod K'],
      ['Title, heading, subheading', isMac ? 'alt mod 1 / alt mod 2 / alt mod 3' : 'ctrl alt 1 / ctrl alt 2 / ctrl alt 3'],
      ['Body', isMac ? 'alt mod 0' : 'ctrl alt 0'],
      ['Checklist', isMac ? 'shift mod L' : 'ctrl alt 4'],
      ['Check or uncheck', 'mod enter'],
      ['Indent / outdent', 'tab / shift tab'],
      ['Move item up / down', 'alt shift up / alt shift down'],
      ['Line break in a block', 'shift enter'],
      ['Find in note', 'mod F'],
      ['Undo / redo', isMac ? 'mod Z / shift mod Z' : 'ctrl Z / ctrl Y'],
    ],
  },
  { title: 'Markdown as you type', examples: true, items: [['Title', '# '], ['Heading', '## '], ['Checklist', '[] '], ['Bulleted list', '* '], ['Numbered list', '1. '], ['Quote', '> '], ['Code block', '```'], ['Divider', '---'], ['Link to a note', '[['], ['Bold', '**bold**'], ['Italic', '*italic*'], ['Highlight', '==highlight==']] },
]);

// ---------------------------------------------------------------- command palette (⌘K)

registerPaletteProvider(
  (q) => {
    const out = [];
    const query = String(q || '').trim();
    const cmd = (label, iconHtml, run, keySpec, words = '') => ({ group: 'Notes', label, iconHtml, run, keys: keySpec, words });
    const cmds = [
      cmd('New note', icon('edit', { size: 18 }), () => newNote(), 'n', 'create compose write'),
      // No key hint: in the notes app Mod+Alt+N is New note (it opens Quick Note only from the other apps).
      cmd('Quick note', icon(G.quick, { size: 18 }), () => openQuick(), '', 'jot capture'),
      cmd("Today's note", todayTile(todayYmd(), 18), () => goToday(), 't', 'daily journal day'),
      cmd('New folder', icon('folder-plus', { size: 18 }), () => folderDialog({}), '', 'create'),
      cmd('Recently Deleted', icon('trash', { size: 18 }), () => nav('#/trash'), '', 'trash bin'),
      cmd('Export all notes (.zip)', icon('download', { size: 18 }), () => exportAllNotes(), '', 'markdown backup download'),
      cmd('Import Markdown…', icon('upload', { size: 18 }), () => pickImport(), '', 'md files'),
      cmd('Notes settings', icon('gear', { size: 18 }), () => notesSettings(), '', 'preferences options'),
    ];
    if (!query) {
      const recent = ui.recent
        .filter((id) => id !== state.noteId)
        .map(noteById)
        .filter((n) => n && !n.trashedAt)
        .slice(0, 5);
      for (const n of recent) out.push({ group: 'Recent notes', label: displayTitle(n), sub: listDate(editedAt(n)), icon: 'note', run: () => openNote(n.id) });
      out.push(...cmds.slice(0, 3).map((c) => ({ ...c, group: 'Notes' })));
      return out;
    }
    // "today", "tomorrow", "fri", "dec 3" → that day's note.
    const p = /^(today|tomorrow|yesterday)$/i.test(query) ? { date: addDaysYmd(todayYmd(), { today: 0, tomorrow: 1, yesterday: -1 }[query.toLowerCase()]), title: '' } : safe(() => nlpParse(query, { mode: 'task' }), null);
    // (Today has its own command, "Today's note", below.)
    if (p?.date && isYmd(p.date) && !oneLine(p.title) && p.date !== todayYmd()) out.push({ group: 'Daily note', label: `Note for ${dayLabel(p.date, { long: true })}`, iconHtml: todayTile(p.date, 18), run: () => nav(`#/day/${p.date}`) });
    const notes = liveNotes()
      .map((n) => ({ n, s: score(displayTitle(n), query) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s - a.s || editedAt(b.n) - editedAt(a.n))
      .slice(0, 8);
    for (const { n } of notes) out.push({ group: 'Notes', label: displayTitle(n), sub: folderById(noteFolder(n))?.name || (n.day ? 'Daily Notes' : 'Notes'), icon: n.day ? 'calendar' : 'note', run: () => openNote(n.id) });
    for (const c of cmds) if (score(`${c.label} ${c.words}`, query)) out.push({ ...c, group: 'Commands' });
    out.push({ group: 'Commands', label: `Search notes for “${query}”`, icon: 'search', run: () => {
      qEl.value = query;
      onSearchInput();
    } });
    if (!notes.some(({ n }) => displayTitle(n).toLowerCase() === query.toLowerCase())) out.push({ group: 'Commands', label: `New note “${query.slice(0, 80)}”`, icon: 'edit', run: () => newNote({ title: query.slice(0, 120) }) });
    return out;
  },
  { prepend: true },
);

// ---------------------------------------------------------------- clicks

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  // The tap only put a row's swipe actions away.
  if (swallowTap && t.closest('#list')) {
    swallowTap = false;
    return;
  }
  if (t.closest('[data-new-note]')) return newNote();
  if (t.closest('[data-new-folder]')) return folderDialog({});
  if (t.closest('[data-toggle-nav]')) return toggleSidebar();
  if (t.closest('[data-toggle-side]')) return toggleSidebar();
  if (t.closest('[data-close-nav]')) return closeDrawer();
  if (t.closest('[data-go-folders]')) return nav('#/folders');
  if (t.closest('[data-go-today]')) return goToday();
  if (t.closest('[data-back-to-list]')) return backToList();
  if (t.closest('[data-recover]')) return session && recover(session.id);
  if (t.closest('[data-delete-now]')) return session && deleteNow([session.id]);
  if (t.closest('[data-empty-trash]')) return emptyTrash();
  const ai = t.closest('[data-ai]');
  if (ai) return reviewAi(ai.dataset.ai);
  const hb = t.closest('[data-hist]');
  if (hb) return hb.dataset.hist === 'back' ? history.back() : history.forward();
  if (t.closest('[data-note-menu]')) return noteMenu(t.closest('[data-note-menu]'));
  if (t.closest('[data-share]')) return shareMenu(t.closest('[data-share]'));
  if (t.closest('[data-aa]')) return openAa(t.closest('[data-aa]'));
  if (t.closest('[data-insert]')) return insertMenu(t.closest('[data-insert]'));
  const ex2 = t.closest('[data-exec]');
  if (ex2) return exec(ex2.dataset.exec);
  if (t.closest('[data-focus-mode]')) return toggleFocusMode();
  if (t.closest('[data-close-info]')) return toggleInfo(false);
  if (t.closest('[data-open-history]')) return session && openHistory(session.id);
  if (t.closest('[data-info-move]')) {
    const n = session?.note();
    if (n) folderPicker(t.closest('[data-info-move]'), { current: noteFolder(n) || 'notes', onPick: (f) => moveNotes([n.id], f) });
    return;
  }
  const ol = t.closest('[data-outline]');
  if (ol) return safe(() => session?.editor?.scrollToBlock(ol.dataset.outline, { flash: true }));
  if (t.closest('[data-toggle-backlinks]')) {
    ui.backlinksCollapsed = !ui.backlinksCollapsed;
    saveUi();
    return renderBacklinks(session?.note());
  }
  const bl = t.closest('[data-backlink]');
  if (bl) {
    e.preventDefault();
    return openNote(bl.dataset.backlink, { blockId: bl.dataset.block || null, v: { ...state, view: 'all' } });
  }
  if (t.closest('[data-day-fold]')) {
    ui.dayHeadCollapsed = !ui.dayHeadCollapsed;
    saveUi();
    return renderLiveHead(session?.note(), session?.draft);
  }
  const step = t.closest('[data-day-step]');
  if (step) {
    const day = session?.note()?.day || session?.draft?.day || state.day || todayYmd();
    // Stepped from the keyboard (Enter or Space: a click without a pointer): the keyboard stays on the
    // button, so the next press steps again, instead of going into the day's note.
    keepDayStep = e.detail === 0 ? step.dataset.dayStep : null;
    return nav(`#/day/${addDaysYmd(day, +step.dataset.dayStep)}`);
  }
  if (t.closest('[data-day-cal]')) return dayCalendar(t.closest('[data-day-cal]'));
  const pt = t.closest('[data-plan-task]');
  if (pt) {
    const id = pt.dataset.planTask;
    const was = !!db.get('tasks', id)?.done;
    const undo = toggleTask(id);
    if (!was) playDing();
    pt.classList.add('pop');
    return undoable(was ? 'Marked not done' : 'Task completed', undo, 'complete task');
  }
  const findBtn = t.closest('[data-find]');
  if (findBtn) {
    const a = findBtn.dataset.find;
    if (a === 'close') return stopFind();
    return findStep(a === 'prev' ? -1 : 1);
  }
  // Sidebar
  const disc = t.closest('[data-disclose]');
  if (disc) {
    const id = disc.dataset.disclose;
    ui.collapsed = ui.collapsed.includes(id) ? ui.collapsed.filter((x) => x !== id) : [...ui.collapsed, id];
    saveUi();
    return renderSidebar();
  }
  if (t.closest('[data-tags-all]')) {
    ui.tagsAll = !ui.tagsAll;
    saveUi();
    return renderSidebar();
  }
  const tag = t.closest('#nav [data-tag]');
  if (tag) {
    e.preventDefault();
    const name = String(tag.dataset.tag).toLowerCase();
    // Shift- or Mod-click adds the tag to a multi-tag filter.
    if ((e.shiftKey || e.metaKey || e.ctrlKey) && state.view === 'tag') {
      const tags = state.tags.includes(name) ? state.tags.filter((x) => x !== name) : [...state.tags, name];
      return nav(tags.length ? listHash({ ...state, tags }) : '#/all');
    }
    if (state.view === 'tag' && state.tags.length === 1 && state.tags[0] === name) return nav('#/all');
    return nav(`#/tag/${encodeURIComponent(name)}`);
  }
  if (t.closest('#nav .nav-item, #sidefoot .nav-item')) closeDrawer({ focus: false });
  const tm = t.closest('[data-tag-mode]');
  if (tm) return nav(listHash({ ...state, tagMode: tm.dataset.tagMode }), { replace: true });
  // List header
  if (t.closest('[data-toggle-view]')) return setView(sortCfg().view === 'gallery' ? 'list' : 'gallery');
  if (t.closest('[data-sort-menu]')) return sortMenu(t.closest('[data-sort-menu]'));
  if (t.closest('[data-select-mode]')) return setSelectMode(!state.selectMode);
  if (t.closest('[data-list-menu]')) return listMenu(t.closest('[data-list-menu]'));
  if (t.closest('[data-toggle-pinned]')) return togglePinnedSection();
  if (t.closest('[data-create-from-search]')) return createFromSearch();
  const so = t.closest('[data-search-op]');
  if (so) return toggleSearchOp(so.dataset.searchOp);
  const sc = t.closest('[data-scope]');
  if (sc) return nav(listHash({ ...state, scope: sc.dataset.scope || null }), { replace: true });
  const ss = t.closest('[data-search-sort]');
  if (ss) {
    ui.searchSort = ss.dataset.searchSort === 'date' ? 'date' : 'relevance';
    saveUi();
    return renderAll();
  }
  if (t.closest('[data-clear-search]')) {
    qEl.value = '';
    onSearchInput();
    return qEl.focus();
  }
  // Bulk actions (multi-select)
  const bulk = t.closest('[data-bulk]');
  if (bulk) {
    const ids = [...state.sel];
    const a = bulk.dataset.bulk;
    if (a === 'pin') togglePin(ids);
    else if (a === 'move') folderPicker(bulk, { onPick: (f) => moveNotes(ids, f) });
    else if (a === 'tag') addTagDialog(ids);
    else if (a === 'delete') trash(ids);
    else if (a === 'recover') ids.forEach(recover);
    else if (a === 'purge') deleteNow(ids);
    if (a !== 'move' && a !== 'tag') setSelectMode(false);
    return;
  }
  // A click in the empty space below the text puts the caret at the end (Apple Notes).
  if (t.closest('#page') && !t.closest('.ne-doc, a, button, input, .n-livehead, .n-backlinks, .n-caption') && session?.editor && !session.readOnly) {
    const doc = session.editor.element;
    if (doc && e.clientY > doc.getBoundingClientRect().bottom) {
      safe(() => session.editor.focus('end'));
      return;
    }
  }
  // Rows
  const row = t.closest('#list [data-id]');
  if (row) {
    if (swipeJustEnded) return;
    const act = t.closest('[data-swipe-act]');
    if (act) return swipeAction(act.dataset.swipeAct, row.dataset.id);
    return clickRow(row.dataset.id, e);
  }
});

// Formatting buttons never take focus from the note (the caret, selection and phone keyboard stay put).
for (const bar of [noteTopEl, noteBarEl]) {
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-exec], [data-aa], [data-insert]') && document.activeElement?.closest?.('#editorhost')) e.preventDefault();
  });
}
infoEl.addEventListener('change', (e) => {
  if (e.target.matches('[name="infoAiHidden"]') && session?.note()) safe(() => core.setNoteAiHidden(session.id, e.target.value === 'true'));
});

document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const row = t.closest('#list [data-id]');
  if (row && !drafts.has(row.dataset.id)) {
    e.preventDefault();
    return rowMenu({ x: e.clientX, y: e.clientY }, row.dataset.id);
  }
  const folder = t.closest('#nav [data-folder]');
  if (folder) {
    e.preventDefault();
    return folderMenu({ x: e.clientX, y: e.clientY }, folder.dataset.folder);
  }
  const tag = t.closest('#nav [data-tag]');
  if (tag) {
    e.preventDefault();
    return tagMenu({ x: e.clientX, y: e.clientY }, tag.dataset.tag);
  }
});

// Sidebar keys: ↑ / ↓ move between its items (folders included), Alt+Shift+↑ / ↓ moves a folder up or
// down among its siblings (as dragging it does).
for (const box of [navEl, sideFootEl]) {
  box.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const item = e.target.closest?.('.nav-item');
    if (!item) return;
    if (e.altKey && e.shiftKey) {
      if (!item.dataset.folder) return;
      e.preventDefault();
      return stepFolder(item.dataset.folder, e.key === 'ArrowUp' ? -1 : 1);
    }
    if (e.altKey || e.shiftKey) return;
    const items = $$('#nav .nav-item, #sidefoot .nav-item').filter((x) => x.offsetParent !== null);
    const next = items[items.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1)];
    e.preventDefault();
    next?.focus();
  });
}

// Long-press on touch opens the same menus.
let press = null;
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const el = e.target.closest?.('#nav [data-folder], #nav [data-tag]');
  if (!el) return;
  press = { el, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
    press = null;
    navigator.vibrate?.(8);
    if (el.dataset.folder) folderMenu(el, el.dataset.folder);
    else tagMenu(el, el.dataset.tag);
  }, 500) };
});
const endPress = (e) => {
  if (!press) return;
  if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8) return;
  clearTimeout(press.timer);
  press = null;
};
document.addEventListener('pointermove', endPress, { passive: true });
document.addEventListener('pointerup', endPress);
document.addEventListener('pointercancel', endPress);

/**
 * Choose a day (Daily Notes): a month whose days with a note have a dot (and say so), one tab stop for
 * the grid with the arrows, Page Up / Down (a month) and Home / End (the week) to move, as the shell's
 * date picker. It opens on the day shown.
 */
function dayCalendar(anchor) {
  const day = session?.note()?.day || session?.draft?.day || state.day || todayYmd();
  let month = parseYmd(day);
  let focusDate = day;
  const marks = new Set(liveNotes().filter((n) => n.day).map((n) => n.day));
  const s = settings.get() || {};
  const weekStart = [0, 1, 6].includes(s.weekStart) ? s.weekStart : 0;
  const draw = () => miniCalendar({ month, selected: day, marks, weekStart, focusDate, markLabel: 'has a note' });
  openPopover(anchor, `<div class="n-daycal">${draw()}</div>`, {
    className: 'dp-pop',
    label: 'Choose a day',
    focus: false,
    onMount: (el, close) => {
      const cal = $('.n-daycal', el);
      const redraw = () => (cal.innerHTML = draw());
      el.addEventListener('click', (e) => {
        const d = e.target.closest('[data-date]');
        if (d) {
          close();
          return nav(`#/day/${d.dataset.date}`);
        }
        const m = e.target.closest('[data-mc]');
        if (!m) return;
        const k = m.dataset.mc;
        month = k === 'today' ? new Date() : new Date(month.getFullYear(), month.getMonth() + (k === 'next' ? 1 : -1), 1);
        focusDate = k === 'today' ? todayYmd() : ymd(month);
        redraw();
        announce(monthTitle(month));
      });
      cal.addEventListener('keydown', (e) => {
        if (!e.target.closest('.mc-day') || e.altKey || e.ctrlKey || e.metaKey) return;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        const wd = (parseYmd(focusDate).getDay() - weekStart + 7) % 7;
        let next = null;
        if (step) next = addDaysYmd(focusDate, step);
        else if (e.key === 'PageUp' || e.key === 'PageDown') next = ymd(addMonths(parseYmd(focusDate), e.key === 'PageDown' ? 1 : -1));
        else if (e.key === 'Home') next = addDaysYmd(focusDate, -wd);
        else if (e.key === 'End') next = addDaysYmd(focusDate, 6 - wd);
        if (!next) return;
        e.preventDefault();
        focusDate = next;
        const d = parseYmd(next);
        const moved = d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear();
        if (moved) month = new Date(d.getFullYear(), d.getMonth(), 1);
        redraw();
        if (moved) announce(monthTitle(month));
        $(`[data-date="${next}"]`, cal)?.focus();
      });
      $(`[data-date="${day}"]`, cal)?.focus({ preventScroll: true });
    },
  });
}

// ---------------------------------------------------------------- list keyboard

listEl.addEventListener('keydown', (e) => {
  if (e.isComposing || e.defaultPrevented) return;
  const row = e.target.closest?.('[data-id]');
  // A control inside a row (a swipe action) keeps its own keys.
  if (row && e.target !== row && e.target.closest?.('button, a[href], input')) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && (row || state.noteId)) {
    e.preventDefault();
    const id = row?.dataset.id || state.noteId;
    const el = $(`#row-${CSS.escape(id)}`, listEl);
    if (el && !drafts.has(id)) rowMenu(el, id);
    return;
  }
  if (!row || mod || e.altKey) return;
  const id = row.dataset.id;
  if (e.key === 'Enter' || e.key === ' ') {
    if (e.shiftKey) return;
    e.preventDefault();
    if (state.selectMode) return clickRow(id, { metaKey: isMac, ctrlKey: !isMac });
    // Phones: Enter or Space opens the note. Wide layouts show it already: Enter edits it (Apple Notes).
    if (cols() === 1 || id !== state.noteId) return clickRow(id, null);
    if (e.key === 'Enter' && session?.editor && !session.readOnly && !multiSel()) safe(() => session.editor.focus('end'));
    return;
  }
  const gallery = listEl.classList.contains('is-gallery');
  let step = null;
  if (e.key === 'Home') step = 'first';
  else if (e.key === 'End') step = 'last';
  else if (e.key === 'PageDown' || e.key === 'PageUp') step = (e.key === 'PageDown' ? 1 : -1) * pageRows(gallery);
  else if (gallery && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) step = e.key === 'ArrowRight' ? 1 : -1;
  else if (gallery && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) step = (e.key === 'ArrowDown' ? 1 : -1) * galleryCols();
  if (step === null || e.shiftKey) return;
  e.preventDefault();
  moveSel(step);
});
/** Rows (or, in the gallery, cards) that fit in the list's height: one PageDown's worth. */
function pageRows(gallery) {
  const first = $('[data-id]', listEl);
  const h = first?.offsetHeight || 60;
  const rows = Math.max(1, Math.floor(listEl.clientHeight / Math.max(24, h)) - (gallery ? 0 : 1));
  return gallery ? rows * galleryCols() : rows;
}
/** Cards across one row of the gallery. */
function galleryCols() {
  const grid = $('.ngrid', listEl);
  const cards = grid ? [...grid.children] : [];
  if (!cards.length) return 1;
  const top = cards[0].offsetTop;
  const n = cards.findIndex((c) => c.offsetTop !== top);
  return n < 0 ? cards.length : Math.max(1, n);
}
listEl.addEventListener('focus', () => {
  // The list itself is one tab stop; focus lands on the open row.
  const row = state.noteId && $(`#row-${CSS.escape(state.noteId)}`, listEl);
  if (row) row.focus({ preventScroll: true });
});

// ---------------------------------------------------------------- swipe actions (touch)

let swipe = null;
let swipeJustEnded = false;
// A tap that only put revealed actions away (iOS): its click opens nothing.
let swallowTap = false;
let swallowTimer = 0;
function swallowNextTap() {
  swallowTap = true;
  clearTimeout(swallowTimer);
  swallowTimer = setTimeout(() => (swallowTap = false), 600);
}
const SWIPE_ACT = 74;
listEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || state.selectMode) return;
  const row = e.target.closest('.nrow[data-id]');
  if (e.target.closest('[data-swipe-act]')) return;
  // Actions are showing on another row: this tap puts them away, and does nothing else.
  if ($$('.nrow[data-swipe]', listEl).some((r) => r._open && r !== row)) {
    closeOpenSwipe(null);
    swallowNextTap();
    return;
  }
  if (!row || drafts.has(row.dataset.id)) return;
  swipe = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, active: false, ticked: false, base: row._open || 0, wasOpen: !!row._open };
});
// A tap outside the list puts revealed actions away too, and does nothing else (as on iOS): the click it
// makes (on ⋯, a link, the search field) goes nowhere. Any later touch starts afresh.
let swallowOutside = null; // {pointerId, until}
document.addEventListener('pointerdown', (e) => {
  swallowOutside = null;
  if (e.pointerType !== 'touch' || listEl.contains(e.target)) return;
  if (!$$('.nrow[data-swipe]', listEl).some((r) => r._open)) return;
  closeOpenSwipe(null);
  swallowOutside = { pointerId: e.pointerId, until: Date.now() + 1000 };
  // No focus move either (the search field would bring up the keyboard).
  e.preventDefault();
}, true);
document.addEventListener('click', (e) => {
  const s = swallowOutside;
  if (!s) return;
  swallowOutside = null;
  if (Date.now() > s.until || (Number.isInteger(e.pointerId) && e.pointerId > 0 && e.pointerId !== s.pointerId)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
listEl.addEventListener('pointermove', (e) => {
  if (!swipe) return;
  let dx = e.clientX - swipe.x + swipe.base;
  if (!swipe.active) {
    if (Math.abs(e.clientY - swipe.y) > 10) return void (swipe = null);
    if (Math.abs(e.clientX - swipe.x) < 12) return;
    swipe.active = true;
    swipe.row.classList.add('swiping');
  }
  ensureSwipeBg(swipe.row, dx > 0 ? 'right' : 'left');
  const w = swipe.row.offsetWidth;
  // Rubber-band past 80px of travel beyond the actions.
  const lim = dx < 0 ? SWIPE_ACT * 2 + 80 : 80;
  if (Math.abs(dx) > lim) dx = Math.sign(dx) * (lim + (Math.abs(dx) - lim) * 0.35);
  swipe.dx = dx;
  const full = dx > 0 ? dx > 90 : -dx > w * 0.55;
  if (full !== swipe.ticked) {
    swipe.ticked = full;
    if (full) navigator.vibrate?.(8);
  }
  swipe.row.dataset.swipe = dx > 0 ? 'right' : 'left';
  swipe.row.classList.toggle('swipe-full', full);
  swipe.row.style.setProperty('--sx', `${dx}px`);
});
/**
 * The actions under a swiped row, for the side being revealed only (right: Pin or Recover; left: Move
 * and Delete, or Delete Now): the other side's colour never shows at the row's rounded corners.
 */
function ensureSwipeBg(row, dir) {
  const have = $('.n-swipebg', row);
  if (have && have.dataset.dir === dir) return;
  have?.remove();
  const n = noteById(row.dataset.id);
  const trashed = !!n?.trashedAt;
  const bg = document.createElement('div');
  bg.className = 'n-swipebg';
  bg.dataset.dir = dir;
  const right = trashed
    ? `<button type="button" class="n-sw-pin" data-swipe-act="recover" aria-label="Recover">${icon('undo')}</button>`
    : `<button type="button" class="n-sw-pin" data-swipe-act="pin" aria-label="${n?.pinned ? 'Unpin' : 'Pin'}">${icon('pushpin')}</button>`;
  const left = trashed
    ? `<button type="button" class="n-sw-del" data-swipe-act="purge" aria-label="Delete now">${icon('trash')}</button>`
    : `<button type="button" class="n-sw-move" data-swipe-act="move" aria-label="Move">${lic('move')}</button><button type="button" class="n-sw-del" data-swipe-act="delete" aria-label="Delete">${icon('trash')}</button>`;
  bg.innerHTML = dir === 'right' ? `${right}<span class="grow"></span>` : `<span class="grow"></span>${left}`;
  row.prepend(bg);
}
const endSwipe = () => {
  if (!swipe) return;
  const { row, dx, id, active, wasOpen } = swipe;
  swipe = null;
  if (!active) {
    // A tap on the row whose actions show puts them away (it doesn't open the note).
    if (wasOpen) {
      settle(row, 0);
      swallowNextTap();
    }
    return;
  }
  swipeJustEnded = true;
  setTimeout(() => (swipeJustEnded = false), 60);
  row.classList.remove('swiping', 'swipe-full');
  const w = row.offsetWidth;
  const n = noteById(id);
  if (dx > 90) {
    settle(row, 0);
    if (n?.trashedAt) recover(id);
    else togglePin([id]);
  } else if (-dx > w * 0.55) {
    // A full swipe deletes: the row collapses and Undo appears.
    row.style.setProperty('--sx', `${-w}px`);
    row.classList.add('n-collapse');
    setTimeout(() => (n?.trashedAt ? deleteNow([id]) : trash([id])), reduceMotion() ? 0 : 200);
  } else if (dx < -50) settle(row, -(n?.trashedAt ? SWIPE_ACT : SWIPE_ACT * 2));
  else settle(row, 0);
};
function settle(row, x) {
  row._open = x;
  row.classList.add('settling');
  row.style.setProperty('--sx', `${x}px`);
  setTimeout(() => {
    row.classList.remove('settling');
    if (!x) {
      $('.n-swipebg', row)?.remove();
      row.style.removeProperty('--sx');
      delete row.dataset.swipe;
    }
  }, 260);
}
function closeOpenSwipe(except) {
  for (const r of $$('.nrow[data-swipe]', listEl)) if (r !== except && r._open) settle(r, 0);
}
function swipeAction(act, id) {
  const row = $(`#row-${CSS.escape(id)}`, listEl);
  if (row) settle(row, 0);
  if (act === 'pin') togglePin([id]);
  else if (act === 'move') folderPicker(row || listEl, { current: noteFolder(noteById(id)) || 'notes', onPick: (f) => moveNotes([id], f) });
  else if (act === 'delete') trash([id]);
  else if (act === 'recover') recover(id);
  else if (act === 'purge') deleteNow([id]);
}
listEl.addEventListener('pointerup', endSwipe);
listEl.addEventListener('pointercancel', endSwipe);

// ---------------------------------------------------------------- drag & drop (notes → folders, folders → folders, files → list)

let drag = null;
function dragChip(e, title) {
  const chip = document.createElement('div');
  chip.className = 'n-dragchip';
  chip.textContent = title;
  document.body.append(chip);
  try {
    e.dataTransfer.setDragImage(chip, 14, 16);
  } catch {
    /* older browsers */
  }
  setTimeout(() => chip.remove(), 0);
}
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('#list [data-id]');
  const folder = e.target.closest?.('#nav [data-folder]');
  if (row && !drafts.has(row.dataset.id)) {
    const id = row.dataset.id;
    const ids = state.sel.size > 1 && state.sel.has(id) ? [...state.sel] : [id];
    drag = { kind: 'notes', ids };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-ecosys-notes', ids.join(','));
    e.dataTransfer.setData('text/plain', ids.map((x) => displayTitle(noteById(x) || {})).join('\n'));
    dragChip(e, ids.length > 1 ? `${ids.length} notes` : displayTitle(noteById(id) || {}));
    shellEl.classList.add('dragging-notes');
  } else if (folder) {
    drag = { kind: 'folder', id: folder.dataset.folder };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-ecosys-folder', drag.id);
    dragChip(e, folderById(drag.id)?.name || 'Folder');
    shellEl.classList.add('dragging-folder');
  }
});
const clearDrops = () => $$('.n-drop, .n-drop-before, .n-drop-after, .n-drop-inside').forEach((x) => x.classList.remove('n-drop', 'n-drop-before', 'n-drop-after', 'n-drop-inside'));
function dropZone(e) {
  const el = e.target.closest?.('#nav [data-drop], #sidefoot [data-drop]');
  if (!el || !drag) return null;
  const key = el.dataset.drop;
  if (drag.kind === 'notes') return key === 'root' ? null : { el, key };
  // Folders: before / after / inside another folder, or the Folders header (top level).
  if (key === 'root') return { el, key, where: 'root' };
  if (!folderById(key) || key === drag.id) return null;
  const r = el.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  return { el, key, where: y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside' };
}
const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
/**
 * Files dragged in from outside: Markdown dropped on the note list is imported. Anywhere else the drop
 * is refused (the browser would otherwise open the file and leave the app); the editor handles its own.
 */
function fileDragOver(e) {
  if (drag || e.defaultPrevented || !carriesFiles(e)) return false;
  e.preventDefault();
  const over = !!e.target.closest?.('#listcol');
  e.dataTransfer.dropEffect = over ? 'copy' : 'none';
  $('#listcol').classList.toggle('n-filedrop', over);
  return true;
}
document.addEventListener('dragenter', fileDragOver);
document.addEventListener('dragover', (e) => {
  if (!drag) return void fileDragOver(e);
  const z = dropZone(e);
  clearDrops();
  if (!z) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  z.el.classList.add(drag.kind === 'folder' ? `n-drop-${z.where === 'root' ? 'inside' : z.where}` : 'n-drop');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !$('#listcol').contains(e.relatedTarget)) $('#listcol').classList.remove('n-filedrop');
});
document.addEventListener('drop', (e) => {
  $('#listcol').classList.remove('n-filedrop');
  if (!drag) {
    if (e.defaultPrevented || !(e.dataTransfer?.files?.length || carriesFiles(e))) return;
    e.preventDefault();
    if (e.target.closest?.('#listcol')) importFiles([...(e.dataTransfer.files || [])]);
    else toast('Drop Markdown files on the note list to import them.');
    return;
  }
  const z = dropZone(e);
  clearDrops();
  if (!z) return;
  e.preventDefault();
  if (drag.kind === 'notes') {
    if (z.key === 'trash') trash(drag.ids);
    else moveNotes(drag.ids, z.key);
  } else moveFolder(drag.id, z.key === 'root' ? null : z.key, z.where);
});
document.addEventListener('dragend', () => {
  drag = null;
  clearDrops();
  shellEl.classList.remove('dragging-notes', 'dragging-folder');
});

// ---------------------------------------------------------------- list width (desktop)

const resizer = $('#resizer');
resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = ui.listW;
  shellEl.classList.add('resizing');
  const move = (ev) => {
    ui.listW = clamp(startW + ev.clientX - startX, 260, 420);
    shellEl.style.setProperty('--list-w-user', `${ui.listW}px`);
    resizer.setAttribute('aria-valuenow', String(ui.listW));
  };
  const up = () => {
    resizer.removeEventListener('pointermove', move);
    resizer.removeEventListener('pointerup', up);
    resizer.removeEventListener('pointercancel', up);
    shellEl.classList.remove('resizing');
    saveUi();
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up);
  resizer.addEventListener('pointercancel', up);
});
resizer.addEventListener('keydown', (e) => {
  const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
  if (!d) return;
  e.preventDefault();
  ui.listW = clamp(ui.listW + d, 260, 420);
  shellEl.style.setProperty('--list-w-user', `${ui.listW}px`);
  resizer.setAttribute('aria-valuenow', String(ui.listW));
  saveUi();
});
resizer.setAttribute('aria-valuemin', '260');
resizer.setAttribute('aria-valuemax', '420');
resizer.setAttribute('aria-valuenow', String(ui.listW));

// ---------------------------------------------------------------- phones: edge swipe back, large title, accessory bar

let edge = null;
$('#notecol').addEventListener('pointerdown', (e) => {
  if (cols() !== 1 || state.screen !== 'note' || e.pointerType !== 'touch' || e.clientX > 24) return;
  edge = { x: e.clientX, y: e.clientY, dx: 0, active: false, t: performance.now() };
});
$('#notecol').addEventListener('pointermove', (e) => {
  if (!edge) return;
  const dx = Math.max(0, e.clientX - edge.x);
  if (!edge.active) {
    if (Math.abs(e.clientY - edge.y) > 14) return void (edge = null);
    if (dx < 10) return;
    edge.active = true;
    shellEl.classList.add('edge-swiping');
  }
  edge.dx = dx;
  shellEl.style.setProperty('--edge', `${dx}px`);
});
const endEdge = () => {
  if (!edge) return;
  const { dx, active, t } = edge;
  edge = null;
  shellEl.classList.remove('edge-swiping');
  shellEl.style.removeProperty('--edge');
  if (!active) return;
  const fast = dx / Math.max(1, performance.now() - t) > 0.6;
  if (dx > innerWidth * 0.35 || (fast && dx > 40)) backToList();
};
$('#notecol').addEventListener('pointerup', endEdge);
$('#notecol').addEventListener('pointercancel', endEdge);

listEl.addEventListener('scroll', () => $('#listcol').classList.toggle('scrolled', listEl.scrollTop > 36), { passive: true });
noteScrollEl.addEventListener('scroll', () => noteTopEl.classList.toggle('scrolled', noteScrollEl.scrollTop > 60), { passive: true });

// The editor shows its own keyboard accessory bar on phones; the note screen's bottom toolbar steps
// aside while it is up.
document.addEventListener('editor:accessory', (e) => shellEl.classList.toggle('kb-up', !!e.detail?.visible));

// ---------------------------------------------------------------- store changes

let taskLinked = null; // ids of notes with task-linked checklist items (rebuilt when notes change)
db.on(({ names, remote }) => {
  // Chip and plan lookups are kept per event change, not worked out again on every save.
  if (names.has('events') || names.has('calendars')) clearEventMemo();
  // Rows show folders (name, colour, hidden from AI), meeting times and the clock format: built again.
  if (names.has('folders') || names.has('events') || names.has('calendars') || names.has('settings')) rowEpoch++;
  if (names.has('notes')) {
    notesVersion++;
    taskLinked = null;
    savedAgain();
    // A link to a note this browser didn't have yet: it has arrived.
    if (pendingNote && noteById(pendingNote.id)) route();
    // (A deliberate revert has reached the editors already: see showRevert.)
    if (session && !session.draft) external(session, noteById(session.id));
    if (quick && !quick.draft) external(quick, noteById(quick.id));
    if (session?.gone) {
      // The open note was deleted for good elsewhere: drop its editor and show another note.
      session.closed = true;
      safe(() => session.editor?.destroy());
      session = null;
      if (cols() > 1) {
        const next = listNoteIds.find((id) => noteById(id) && !noteById(id).trashedAt);
        if (next) openNote(next, { replace: true });
        else nav(listHash(), { replace: true });
      } else nav(listHash(), { replace: true });
    }
  }
  // A task changed. Here: mirror it now. From another tab, the server or an AI: a moment later, so the
  // notes that came with it are in first (another tab writes its tasks and its notes as two storage
  // events; mirroring between them would rewrite a note from the copy before, undoing a Restore there).
  if (names.has('tasks')) remote ? scheduleMirror() : syncLinkedTasks();
  if (names.has('settings')) {
    dateMemo.clear(); // the 12/24-hour clock may have changed
    applyLayout();
  }
  if (remote && names.has('folders') && state.view === 'folder' && state.folderId !== 'notes' && !folderById(state.folderId)) return nav('#/all', { replace: true });
  if (names.has('notes') || names.has('folders') || names.has('tasks') || names.has('events') || names.has('calendars') || names.has('settings')) scheduleRender();
});
/**
 * Mirror linked tasks into their checklist items (done → checked, title → text; a deleted task leaves
 * the text unlinked), for every note that has one. A system change, and only on a copy that is current:
 * not before the first sync is in (it would rewrite notes from this browser's old copy) and never in
 * the item being edited.
 */
function syncLinkedTasks() {
  if (!backgroundWritesOk()) return;
  if (!taskLinked) taskLinked = new Set(liveNotes().filter((n) => blocksOf(n).some((b) => b?.task)).map((n) => n.id));
  if (!taskLinked.size) return;
  db.batch(() => {
    for (const id of taskLinked) {
      const n = noteById(id);
      if (n && !n.trashedAt) safe(() => core.syncTaskChecks(n, { skipBlockId: caretBlock(n.id) }));
    }
  });
}
let mirrorTimer = 0;
const MIRROR_MS = 250;
function scheduleMirror(ms = MIRROR_MS) {
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    mirrorTimer = 0;
    syncLinkedTasks();
  }, ms);
}

// ---------------------------------------------------------------- sync readiness

/**
 * Background writes (the AI-review expiry, the 30-day purge, linked items catching up with their tasks)
 * run on this browser's copy, which must be current: the server's own (sync online since the first
 * load), or the only one (no server: 'off'). While sync is connecting, offline or refused, the copy may
 * be days old, and what they write would undo what another browser or an assistant changed meanwhile.
 */
// The shell loads sync.js lazily: until it is there, nothing is known yet ('loading'), and a page that
// can't load it is on its own ('off').
let syncLoad = 'loading';
const syncStatus = () => (window.ecosysSync ? String(window.ecosysSync.status || 'off') : syncLoad);
let syncSeen = false; // the first load from ecosys has arrived (status 'online' at least once)
let lastSync = null;
const backgroundWritesOk = () => ['off', 'online'].includes(syncStatus());
/**
 * Sync has caught up since this page loaded, or there is nothing to wait for (no server, or it failed for
 * good). A browser that isn't paired yet ('unpaired') still waits: sync starts by itself once it is
 * connected, and a note it doesn't have may well be in ecosys (the note column says how to connect).
 */
const syncSettled = () => syncSeen || ['off', 'error'].includes(syncStatus());
// After a reconnect the page reloads the server's state: periodic housekeeping waits a minute for that.
const STABLE_MS = 60000;
let housekeepDue = true;
let housekeepTimer = 0;
function tryHousekeep({ wait = 0 } = {}) {
  clearTimeout(housekeepTimer);
  housekeepTimer = setTimeout(() => {
    if (!housekeepDue || !backgroundWritesOk()) return;
    housekeepDue = false;
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => (backgroundWritesOk() ? housekeeping() : (housekeepDue = true)), { timeout: 5000 });
  }, wait);
}
/** Sync's status changed (or became known): run what was waiting for a current copy. */
function onSyncStatus() {
  const s = syncStatus();
  if (s === lastSync) return;
  const prev = lastSync;
  lastSync = s;
  const first = s === 'online' && !syncSeen;
  if (s === 'online') syncSeen = true;
  // A link to a note this browser didn't have: shown now, or reported missing (or still waiting: the
  // message says whether ecosys answers).
  if (pendingNote) syncSettled() ? route() : renderNoteChrome();
  if (!backgroundWritesOk()) return;
  if (first || (s === 'off' && prev !== 'online')) {
    // The first load is in (or there is no server): linked items catch up with what their tasks did
    // while Notes was closed or elsewhere, and housekeeping runs.
    syncLinkedTasks();
    tryHousekeep();
  } else {
    // Back after a gap: the page reloads the server's state first.
    scheduleMirror(5000);
    tryHousekeep({ wait: STABLE_MS });
  }
}
window.addEventListener('ecosys:sync', onSyncStatus);
import('../shared/sync.js')
  .then((m) => m.startSync?.())
  .catch(() => (syncLoad = 'off'))
  .finally(onSyncStatus);

window.addEventListener('ecosys:data-replaced', () => {
  // Import, reset or another device replaced everything: drop the editor without saving over it.
  if (session) {
    session.dirty = false;
    closeSession(session, { discard: false });
    session = null;
  }
  drafts.clear();
  createdHere.clear();
  hadText.clear();
  lastText.clear();
  // Erase everything, sample data, an import: version history must not outlive the notes it copies.
  hist.purgeOrphans(new Set((db.all('notes') || []).map((n) => n?.id)));
  route();
  // What arrived may hold tasks that changed while their notes didn't: the items catch up.
  scheduleMirror();
});
// Notes deleted for good (Delete Now, Delete All, the 30-day purge) take their version history along.
window.addEventListener('ecosys:notes-purged', (e) => {
  for (const id of Array.isArray(e.detail?.ids) ? e.detail.ids : []) hist.deleteRevisions(id);
});
window.addEventListener('ecosys:save-error', () => {
  storageFull = true;
  retryDelay = 5000;
  // With ecosys online the edit is on its way there: only an edit saved nowhere shows the error (the
  // first check tells), and this browser's own storage gets the quieter "almost full" note.
  if (window.ecosysSync?.online) checkBudget();
  else showStorageError();
  retrySave();
});
let storageFull = false; // a save to this browser's storage failed and hasn't succeeded since
function showStorageError() {
  storageBanner = `<div class="n-banner n-banner-err" role="alert">${icon(G.alert, { size: 16 })}<span class="grow">Not saved: storage is full. Your edits are kept here until there's room.</span><button type="button" class="btn btn-ghost btn-sm" data-empty-trash>Empty Recently Deleted</button></div>`;
  renderBanners(session?.note());
}
/**
 * After a failed save to this browser's storage: check now and then whether the notes made it after all
 * (the store saves them again with the next change, e.g. once Recently Deleted is emptied), and take the
 * banner down when they did, or when ecosys has every edit (sync online with nothing left to send).
 * A check never writes anything: it compares what is stored with what is here, at most once per try,
 * with the tries further and further apart (5 s, 10 s, 20 s … every 5 minutes), and not while the tab is hidden.
 */
let retryTimer = 0;
let retryDelay = 5000;
const synced = () => !!window.ecosysSync?.online && !window.ecosysSync.pending;
function retrySave() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(checkSaved, retryDelay);
}
/** Check now, and then again 5 s, 10 s, 20 s … later if the notes are still not saved. */
function checkSavedNow() {
  retryDelay = 5000;
  clearTimeout(retryTimer);
  checkSaved();
}
/** Space was freed (Delete Now, Delete All): the notes may fit now. */
function recheckSaved() {
  if (!storageFull) return;
  // A store that pauses a while after a big write failed can be asked to try the notes again at once.
  if (typeof storeApi.saveAgain === 'function') safe(() => storeApi.saveAgain(['notes']));
  checkSavedNow();
}
/**
 * The notes changed while a save had failed: the store has just tried to save them again. When that
 * worked the banner goes now. (The store's own answer, so this costs nothing per keystroke; the
 * timed checks go on otherwise.)
 */
function savedAgain() {
  if (storageFull && typeof storeApi.cacheSaved === 'function' && storeApi.cacheSaved('notes')) checkSavedNow();
}
function checkSaved() {
  retryTimer = 0;
  if (!storageFull) return;
  if (document.visibilityState === 'hidden') return retrySave();
  const onServer = synced();
  let stored = false;
  if (!onServer) {
    try {
      // The store knows (cacheSaved); an older store is asked the long way, by comparing the copies.
      stored = typeof storeApi.cacheSaved === 'function' ? storeApi.cacheSaved('notes') : localStorage.getItem('ecosys:v1:notes') === JSON.stringify(db.all('notes'));
    } catch {
      stored = false;
    }
  }
  if (!onServer && !stored) {
    if (!storageBanner.includes('n-banner-err')) showStorageError();
    retryDelay = Math.min(retryDelay * 2, 5 * 60000);
    return retrySave();
  }
  // Saved here, or ecosys has every edit: no more checks (a later failure is reported again).
  const shown = storageBanner.includes('n-banner-err');
  storageFull = false;
  retryDelay = 5000;
  if (shown) storageBanner = '';
  checkBudget();
  renderBanners(session?.note());
  if (shown) toast(stored ? 'Saved' : 'Saved in ecosys on this computer');
}
function checkBudget() {
  const u = storageUsage();
  const hot = u.total >= u.limit * 0.8;
  const was = storageBanner && !storageBanner.includes('n-banner-err');
  if (storageBanner.includes('n-banner-err')) return;
  storageBanner = hot
    ? `<div class="n-banner n-banner-warn" role="status">${icon('info', { size: 16 })}<span class="grow">Storage is almost full (${esc(mb(u.total))} of ~5 MB). Export your notes or empty Recently Deleted.</span><button type="button" class="btn btn-ghost btn-sm" data-empty-trash>Empty</button></div>`
    : '';
  if (!!was !== hot) renderBanners(session?.note());
}

// Save when switching away, hiding the tab or closing it.
document.addEventListener('visibilitychange', () => {
  // Back to the tab: linked items catch up with tasks changed meanwhile (in Tasks, by an assistant).
  if (document.visibilityState === 'visible') return void scheduleMirror();
  if (document.visibilityState !== 'hidden') return;
  flush(session);
  flush(quick);
  const n = session?.note();
  // (Not while its latest text is too long to save: the stored note hasn't changed, and a copy of it
  // between the copies of that text would only fill version history.)
  if (n && session.edited && !(session.tooLarge && session.dirty)) hist.snapshot(n, { reason: 'session', by: 'user' });
  // Text too long to save survives the tab being closed from here: version history keeps it (once).
  for (const s of [session, quick]) if (s && !s.closed && s.tooLarge && s.dirty) keepUnsaved(s, { quiet: true });
});
window.addEventListener('pagehide', () => {
  flush(session);
  flush(quick);
});
window.addEventListener('popstate', () => {
  if (location.hash !== lastHash) route();
});
window.addEventListener('hashchange', () => {
  if (location.hash !== lastHash) route();
});
const relayout = () => {
  const c = shellEl.dataset.cols;
  applyLayout();
  quickModality();
  if (c !== String(cols())) route();
};
mqWide.addEventListener('change', relayout);
mqMid.addEventListener('change', relayout);

// ---------------------------------------------------------------- start

/**
 * Background upkeep, only on a current copy (see backgroundWritesOk; tryHousekeep waits for one).
 * Recently Deleted: notes deleted over 30 days ago go for good (their history follows: see
 * ecosys:notes-purged) — in this browser only when there is no server; with ecosys the server does it,
 * under its data lock, so a note recovered elsewhere a moment ago is never deleted from an old copy.
 * Unreviewed AI edits older than a week move into version history (the pre-AI copy is kept there).
 */
function housekeeping() {
  if (!backgroundWritesOk()) {
    housekeepDue = true;
    return;
  }
  if (syncStatus() === 'off') safe(() => core.purgeTrash(30));
  const live = new Set((db.all('notes') || []).map((n) => n.id));
  hist.purgeOrphans(live);
  for (const n of safe(() => core.expireAiReviews(7), []) || []) {
    if (n?.aiPrev?.blocks) hist.snapshot(n, { blocks: n.aiPrev.blocks, reason: 'ai', by: 'user', force: true });
  }
  checkBudget();
  if (Date.now() - ui.budgetAt > DAY_MS) {
    ui.budgetAt = Date.now();
    saveUi();
    hist.enforceBudget();
  }
}
applyLayout();
route();
// No slide-in on first paint: transitions start once the first screen is in place.
requestAnimationFrame(() => requestAnimationFrame(() => shellEl.classList.remove('no-anim')));
// Housekeeping runs once the first sync is in (onSyncStatus), and every 6 hours while the copy is current.
setInterval(() => {
  housekeepDue = true;
  tryHousekeep();
}, 6 * 3600 * 1000);
// The day changes at midnight: Today, the date groups and relative dates move with it.
let today0 = todayYmd();
setInterval(() => {
  if (todayYmd() === today0) return;
  today0 = todayYmd();
  scheduleRender();
}, 60000);
