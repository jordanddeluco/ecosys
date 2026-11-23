// tasks — the ecosys to-do app: Microsoft To Do's calm lists, detail pane and My Day suggestions,
// with Todoist's quick add, priorities, coloured dates, Upcoming week strip and keyboard flow.
//
// Security: every value that reaches innerHTML goes through esc() — text and attributes alike, ids and
// numbers included — and every selector built from data uses CSS.escape (see rowEl / sel).
import {
  initShell, esc, $, $$, icon, keys, toast, announce, undoable, openMenu, openPopover, openModal, openDatePicker, openRepeatPicker, choiceDialog,
  registerPaletteProvider, registerShortcuts, openPalette, openSettings, score, sidebarHead, hasOpenLayer, isTyping, playDing,
  tipAttrs, selectField, timeField, setFieldValue, attachSuggest, autosize, fmtClock, fmtTimeRange, singleKeyOff, todayGlyph,
} from '../shared/shell.js';
import { db, settings, uid } from '../shared/store.js';
import { isId, isYmd, isHHMM } from '../shared/sanitize.js';
import { todayYmd, addDaysYmd, parseYmd, fmt, dayLabel, shortDate, fmtDuration, diffDays, hour12, pad, fromMinutes, toMinutes } from '../shared/dates.js';
import { parse } from '../shared/nlp.js';
import { describe, presets, nextRepeatDates } from '../shared/recur.js';
import {
  SMART_LISTS, VIEW_ALIASES, PRIORITIES, SORTS, dateTone, tasksIn, completedIn, byOrder, byTimeThenOrder,
  createTask, createList, toggleTask, deleteTask, allTags, COLORS, colorVar, eventInstances, dayInstances, revertChange, isToday, plannedDay,
} from '../shared/model.js';

initShell({ app: 'tasks' });

// Long views draw their first rows and more on request: Completed 200 tasks at a time, and Upcoming's later
// months (after its two weeks of days) 50 tasks at first, then 200 more at a time.
const MORE_STEP = 200;
const LATER_FIRST = 50;

// sel: the highlighted row. reveal: a row to scroll into view once the next route() has drawn it (set only
// when a task is opened from elsewhere: a #/task/<id> link, search, a toast's View). upFocus: the Upcoming
// day the list is scrolled to, which the week strip follows. doneLimit / upLimit: how many rows Completed
// and Upcoming's later months draw.
const state = { view: 'today', tag: null, sel: null, reveal: null, open: null, showDone: new Set(), upStart: null, upFocus: null, composer: null, doneLimit: MORE_STEP, upLimit: LATER_FIRST };
const pending = new Set(); // ids playing the completion animation
const leaving = new Set(); // of those, the rows already folding away (kept folded if the list is rebuilt meanwhile)
const lang = navigator.language || 'en-US';
const isDmy = !/^en-US|^en-CA|^en-PH/.test(lang) && /^en|^de|^fr|^es|^it|^nl|^pt/.test(lang);

// ---------------------------------------------------------------- layout

$('#app').innerHTML = `
<div class="shell" id="shell">
  <aside class="sidebar" id="sidebar">
    ${sidebarHead('tasks')}
    <div class="create-wrap"><button type="button" class="create-btn" data-add-task ${tipAttrs('Add task', 'q')}>${icon('plus', { size: 22, stroke: 2.4 })}<span>Add task</span></button></div>
    <nav class="side-scroll" id="nav" aria-label="Lists"></nav>
  </aside>
  <div class="side-overlay" data-close-nav></div>
  <main class="main" id="main">
    <header class="topbar" id="topbar">
      <button type="button" class="icon-btn menu-toggle" data-toggle-nav aria-label="Hide sidebar" aria-controls="sidebar" ${tipAttrs('Hide sidebar', 'mod \\')}>${icon('sidebar')}</button>
      <div class="compact-title" id="compact-title" aria-hidden="true"></div>
      <span class="grow"></span>
      <div class="head-actions" id="head-actions"></div>
    </header>
    <div class="content main-scroll">
      <div id="view-head"></div>
      <div id="composer-slot"></div>
      <div id="view-body"></div>
    </div>
  </main>
  <div class="insp-scrim" data-close-insp></div>
  <aside class="inspector" id="inspector" hidden aria-label="Task details"></aside>
  <nav class="tabbar" id="tabbar" aria-label="Views"></nav>
  <button type="button" class="fab" data-add-task aria-label="Add task">${icon('plus', { size: 26, stroke: 2.4 })}</button>
</div>`;

const shellEl = $('#shell');
const mainEl = $('#main');
const navEl = $('#nav');
const headEl = $('#view-head');
const bodyEl = $('#view-body');
const inspEl = $('#inspector');
const topbar = $('#topbar');
const slotEl = $('#composer-slot');

// ---------------------------------------------------------------- helpers

/** Priority as stored (3 = P1 … 0 = none), clamped so it is always safe in a class name. */
const prio = (p) => ([0, 1, 2, 3].includes(p) ? p : 0);
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
/** The row for a task id (ids can be anything a backup held, so the selector is escaped). */
const rowEl = (id) => (id ? $(`.task[data-id="${CSS.escape(String(id))}"]`, bodyEl) : null);

const listsSorted = () => [...db.all('lists')].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const listMap = () => new Map(db.all('lists').map((l) => [l.id, l]));
const smart = (id) => SMART_LISTS.find((s) => s.id === id);
const isSmart = (v) => !!smart(v) || v === 'tag';
const currentList = () => (!isSmart(state.view) ? db.get('lists', state.view) : null);
const viewKey = () => (state.view === 'tag' ? `tag:${state.tag}` : state.view);
const listHref = (id) => `#/list/${encodeURIComponent(id)}`;
const tagHref = (tag) => `#/tag/${encodeURIComponent(tag)}`;
const hrefFor = (key) => (key.startsWith('tag:') ? tagHref(key.slice(4)) : isSmart(key) ? `#/${key}` : listHref(key));
const dotHtml = (color) => `<span class="swatch-dot" style="background:${esc(colorVar(color))}"></span>`;
const untitled = (t) => (String(t.title ?? '').trim() ? String(t.title) : 'Untitled task');

function viewTitle() {
  if (state.view === 'tag') return state.tag;
  return smart(state.view)?.name || currentList()?.name || 'Tasks';
}

/** Todoist-style relative date: Today, Tomorrow, Yesterday, a weekday this week, or "Dec 5". */
function relDate(s) {
  const n = diffDays(todayYmd(), s);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return fmt(parseYmd(s), { weekday: 'long' });
  return shortDate(s);
}
/** relDate inside a sentence: "today", "tomorrow", but "Friday" and "Dec 5" keep their capitals. */
const relLower = (s) => {
  const r = relDate(s);
  return r === 'Today' || r === 'Tomorrow' || r === 'Yesterday' ? r.toLowerCase() : r;
};

// Fields read defensively: a record that skipped validation (an old client, another same-origin page)
// must render as "no time" rather than as broken markup or NaN.
const dateOf = (t) => (isYmd(t.date) ? t.date : null);
const timeOf = (t) => (isHHMM(t.time) ? t.time : null);
const durOf = (t) => (Number.isInteger(t.duration) && t.duration > 0 ? t.duration : null);
const endTime = (t) => {
  const time = timeOf(t);
  const dur = durOf(t);
  return time && dur ? fromMinutes(Math.min(1439, toMinutes(time) + dur)) : null;
};

const flagIcon = (p, size = 18) => `<span class="flag-ic pr${prio(p)}">${icon(p ? 'flag-fill' : 'flag', { size })}</span>`;
/**
 * Menu hint for a key range: keycaps 1 and 4 with a quiet "to" between them, as one .keys group, so touch
 * screens (which hide keycaps in menus) hide the "to" along with them.
 */
const rangeHint = (a, b) => `<span class="keys">${keys(a)}<span class="kbd-to">to</span>${keys(b)}</span>`;

/** Smooth scrolling unless the user asked for less motion (setting or system). */
const smooth = () => (settings.get().reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/**
 * Change a task and (optionally) offer Undo. Returns the updated task. The undo takes back only this
 * change (revertChange), so edits made since, here or in another tab, app or assistant, stay. `undo` words
 * the change for Ctrl+Z's "Undid …" and "Redid …": a function of the task's quoted name, as in
 * (n) => `moving ${n} to Inbox` ("Undid moving “Pay rent” to Inbox").
 */
function update(id, patch, message, undo) {
  const prev = db.get('tasks', id);
  if (!prev) return null;
  const before = structuredClone(prev);
  const next = db.update('tasks', id, patch);
  if (message && next) {
    const after = structuredClone(next);
    undoable(message, () => revertChange('tasks', before, after), undo?.(`“${untitled(prev)}”`));
  }
  return next;
}

const sortable = () => !['upcoming', 'completed'].includes(state.view);
function sortMode() {
  const m = settings.get().taskSort?.[viewKey()];
  return typeof m === 'string' && Object.hasOwn(SORTS, m) ? m : 'manual';
}
function sorter() {
  const mode = sortMode();
  if (mode === 'manual') return state.view === 'today' ? byTimeThenOrder : byOrder;
  return SORTS[mode].fn;
}
function setSort(mode) {
  settings.set({ taskSort: { ...settings.get().taskSort, [viewKey()]: mode } });
}

/**
 * Where a task came from, when it was sent over from a note: {href, title, trashed, missing} or null.
 * A note that is gone (deleted for good, or not synced here yet) reads as deleted and has no link.
 */
function noteSource(t) {
  const s = t.source;
  if (!s || typeof s !== 'object' || s.app !== 'notes' || !isId(s.noteId)) return null;
  const blockId = isId(s.blockId) ? s.blockId : null;
  let note = null;
  try {
    note = db.get('notes', s.noteId);
  } catch {
    note = null;
  }
  const title = typeof note?.title === 'string' && note.title.trim() ? note.title.trim() : note ? 'Untitled note' : '';
  return {
    href: `../notes/#/n/${encodeURIComponent(s.noteId)}${blockId ? `/b/${encodeURIComponent(blockId)}` : ''}`,
    title,
    missing: !note,
    trashed: !note || !!(note.trashedAt || note.trashed),
  };
}
const scheduleHref = (t) => `../schedule/#/day/${encodeURIComponent(isYmd(t.date) ? t.date : todayYmd())}/task/${encodeURIComponent(t.id)}`;

/** A block's text on one line (a [[chip]] reads as its label). */
const blockLine = (b) => (Array.isArray(b?.c) ? b.c.map((r) => (typeof r?.[0] === 'string' ? r[0] : '')).join('') : '').replace(/\s+/g, ' ').trim();

/**
 * The notes that mention a task, most recently edited first: a [[task]] chip in a line, or a checklist
 * line linked to it (each note keeps them in its derived `links`). Each opens at that line. Notes in
 * Recently Deleted are left out, and so is the note the task was sent from (the "From note" row).
 */
function noteMentions(t) {
  let notes = [];
  try {
    notes = db.all('notes') || [];
  } catch {
    return [];
  }
  const ref = `task:${t.id}`;
  const from = t.source?.app === 'notes' ? t.source.noteId : null;
  const out = [];
  for (const n of notes) {
    if (!n || n.trashedAt || n.trashed || !isId(n.id) || n.id === from || !Array.isArray(n.links) || !n.links.includes(ref)) continue;
    const block = Array.isArray(n.blocks) ? n.blocks.find((b) => b && ((b.t === 'check' && b.task === t.id) || (Array.isArray(b.c) && b.c.some((r) => r?.[2]?.ref === ref)))) : null;
    const title = typeof n.title === 'string' && n.title.trim() ? n.title.trim() : 'Untitled note';
    const line = blockLine(block);
    out.push({
      id: n.id,
      title,
      line: line && line !== title ? line.slice(0, 160) : '',
      at: Number(n.updatedAt) || 0,
      href: `../notes/#/n/${encodeURIComponent(n.id)}${block && isId(block.id) ? `/b/${encodeURIComponent(block.id)}` : ''}`,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Labels as the store keeps them: lowercase words joined by dashes, no leading @ or #. */
const normTag = (s) =>
  String(s ?? '')
    .trim()
    .replace(/^[@#]+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 60);
// Bumped on every change to tasks (see db.on below): what is counted from them is kept until the next one.
let tasksRev = 0;
let tagCache = null;
/** Open tasks per label. The @ completions ask on every key typed after "@", so the count is kept. */
function tagCounts() {
  if (tagCache?.rev === tasksRev) return tagCache.counts;
  const m = new Map();
  for (const t of db.all('tasks')) if (!t.done) for (const g of t.tags || []) m.set(g, (m.get(g) || 0) + 1);
  tagCache = { rev: tasksRev, counts: m };
  return m;
}

/** The sidebar's counts and Today's planned minutes, in one pass over the tasks. */
function navCounts() {
  const today = todayYmd();
  const live = new Set(db.all('lists').map((l) => l.id));
  const c = { inbox: 0, today: 0, important: 0, planned: 0, perList: new Map(), perTag: new Map() };
  for (const t of db.all('tasks')) {
    if (t.done) continue;
    if (t.listId && live.has(t.listId)) c.perList.set(t.listId, (c.perList.get(t.listId) || 0) + 1);
    else c.inbox++;
    if (isToday(t, today)) {
      c.today++;
      if (Number.isFinite(t.duration) && t.duration > 0) c.planned += t.duration;
    }
    if (t.priority === 3) c.important++;
    for (const g of t.tags || []) c.perTag.set(g, (c.perTag.get(g) || 0) + 1);
  }
  return c;
}

/** Durations typed by hand: '75', '75m', '1h', '1.5h', '1h 20m', '1:20', 'for 90 mins' → minutes. */
function parseDuration(input) {
  const s = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^for\s+/, '');
  if (!s) return null;
  let m = s.match(/^(\d{1,2}):([0-5]\d)$/);
  let mins = null;
  if (m) mins = +m[1] * 60 + +m[2];
  else if (/^\d{1,4}$/.test(s)) mins = +s;
  else {
    const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?![a-z])/g;
    let total = 0;
    let used = '';
    while ((m = re.exec(s))) {
      total += m[2].startsWith('h') ? +m[1] * 60 : +m[1];
      used += m[0];
    }
    if (used && s.replace(/\s+|and/g, '').length === used.replace(/\s+/g, '').length) mins = total;
  }
  return mins && mins > 0 ? Math.min(1440, Math.round(mins)) : null;
}

const sameRule = (a, b) => {
  if (!a || !b) return !a && !b;
  const norm = (r) => JSON.stringify({ f: r.freq, i: r.interval || 1, d: r.days ? [...r.days].sort() : null, m: r.freq === 'month' || r.freq === 'year' ? r.monthDay || null : null });
  return norm(a) === norm(b);
};

// Skip DOM rebuilds that would produce the same markup (keeps hover, focus and scroll where they are).
const lastHtml = new WeakMap();
function setHtml(el, html) {
  if (lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

// ---------------------------------------------------------------- keyed list drawing
//
// A view is drawn from blocks: { key, html } for a section's frame, a header, a button or an empty state,
// with `rows` ({ id, html } per task) when the block's html holds one empty LIST_SLOT for its rows to fill,
// and `count` when it holds a COUNT_SLOT.
// A redraw keeps every element whose html didn't change, a row that moved to another section included,
// updates in place the ones whose html did (a row, or a section's frame around its rows), and parses only
// what that needs, in one go: completing, adding or moving a task redraws a row or two, not the hundreds a
// long view holds. Elements are never moved needlessly (taken out and put back, a row is laid out afresh,
// and one out of view would first be drawn at its estimated height), and hover, focus and scroll stay put.
const LIST_SLOT = '<div class="task-list" role="list"></div>';
// A section's count changes with almost every edit: it is left out of the html (a block's `count` fills
// it in place), so a new count never rebuilds the section, which would move all its rows into a new one.
const COUNT_SLOT = '<span class="count" data-count></span>';
const builtFrom = new WeakMap(); // element → the html it was built from
const parseBox = document.createElement('div');

/** One element per html string (each is a single element), parsed together. */
function buildAll(htmls) {
  if (!htmls.length) return [];
  parseBox.innerHTML = htmls.join('');
  let els = [...parseBox.children];
  // Markup that is not one element each (it never should be) is parsed piece by piece instead.
  if (els.length !== htmls.length)
    els = htmls.map((h) => {
      parseBox.innerHTML = h;
      return parseBox.firstElementChild || document.createElement('div');
    });
  els.forEach((el, i) => builtFrom.set(el, htmls[i]));
  return els;
}

/**
 * Put `kids` in `parent` in this order. What isn't one of them goes first, so the ones that stay keep their
 * order and only new or reordered ones are inserted (removing a row never moves the rows after it).
 */
function placeChildren(parent, kids) {
  if (!parent) return;
  const keep = new Set(kids);
  for (const el of [...parent.children]) if (!keep.has(el)) el.remove();
  let ref = parent.firstElementChild;
  for (const el of kids) {
    if (el === ref) ref = ref.nextElementSibling;
    else parent.insertBefore(el, ref);
  }
}

/** The markup after an element's opening tag: what a change of its attributes alone leaves as it was. */
const innerOf = (html) => (typeof html === 'string' ? html.slice(html.indexOf('>') + 1) : null);

/** Give `el` the attributes `fresh` has (its key aside). */
function syncAttrs(el, fresh) {
  for (const a of [...el.attributes]) if (a.name !== 'data-key' && !fresh.hasAttribute(a.name)) el.removeAttribute(a.name);
  for (const a of fresh.attributes) if (el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
}

/**
 * Make `el` what `fresh` (just parsed) is, in place: its attributes, and its contents unless only the
 * attributes changed (a row selected or opened). A section keeps its own list of rows where it is.
 */
function morph(el, fresh) {
  const was = builtFrom.get(el);
  const html = builtFrom.get(fresh);
  syncAttrs(el, fresh);
  if (was === undefined || innerOf(was) !== innerOf(html)) {
    const list = $(':scope > .task-list', el);
    const slot = list && $(':scope > .task-list', fresh);
    if (!slot) el.replaceChildren(...fresh.childNodes);
    else {
      for (const n of [...el.childNodes]) if (n !== list) n.remove();
      let before = true;
      for (const n of [...fresh.childNodes]) {
        if (n === slot) before = false;
        else if (before) el.insertBefore(n, list);
        else el.append(n);
      }
    }
  }
  builtFrom.set(el, html);
}

/** Draw the view's blocks into the list (see above). */
function patchBody(blocks) {
  const oldBlocks = new Map();
  for (const el of bodyEl.children) if (el.dataset.key && !oldBlocks.has(el.dataset.key)) oldBlocks.set(el.dataset.key, el);
  const oldRows = new Map();
  for (const r of bodyEl.querySelectorAll('.task[data-id]')) if (!oldRows.has(r.dataset.id)) oldRows.set(r.dataset.id, r);
  // Blocks: kept as they are, updated in place, or built.
  const els = [];
  const changed = [];
  blocks.forEach((b, i) => {
    const el = oldBlocks.get(b.key);
    if (el && builtFrom.get(el) === b.html) els[i] = el;
    else changed.push(i);
  });
  buildAll(changed.map((i) => blocks[i].html)).forEach((fresh, k) => {
    const i = changed[k];
    const old = oldBlocks.get(blocks[i].key);
    if (old && old.tagName === fresh.tagName) {
      morph(old, fresh);
      els[i] = old;
    } else {
      fresh.dataset.key = blocks[i].key;
      els[i] = fresh;
    }
  });
  // Rows (wherever they were before): kept, updated in place, or built.
  const rowEls = blocks.map((b) => (b.rows ? [] : null));
  const todo = [];
  blocks.forEach((b, i) =>
    b.rows?.forEach((r, j) => {
      const el = oldRows.get(r.id);
      if (el) oldRows.delete(r.id);
      if (el && builtFrom.get(el) === r.html) rowEls[i][j] = el;
      else todo.push([i, j, el]);
    }),
  );
  buildAll(todo.map(([i, j]) => blocks[i].rows[j].html)).forEach((fresh, k) => {
    const [i, j, old] = todo[k];
    if (old) morph(old, fresh);
    rowEls[i][j] = old || fresh;
  });
  placeChildren(bodyEl, els);
  blocks.forEach((b, i) => {
    if (b.rows) placeChildren($(':scope > .task-list', els[i]) || $('.task-list', els[i]), rowEls[i]);
    const count = b.count === undefined ? null : $('[data-count]', els[i]);
    if (count && count.textContent !== String(b.count)) count.textContent = String(b.count);
  });
  // A row kept as it was may still carry a highlight set on it directly (select(), the open pane) that the
  // state has dropped since (a view switch clears the selection): the marks follow the state.
  for (const r of $$('.task.sel, .task.open', bodyEl)) {
    if (r.dataset.id !== state.sel) r.classList.remove('sel');
    if (r.dataset.id !== state.open) r.classList.remove('open');
  }
  rowEl(state.sel)?.classList.add('sel');
  rowEl(state.open)?.classList.add('open');
}

// ---------------------------------------------------------------- routing

function go(view, extra = {}) {
  const hash = view === 'tag' ? tagHref(extra.tag) : isSmart(view) ? `#/${view}` : listHref(view);
  if (location.hash !== hash) location.hash = hash;
  else route();
  closeDrawer();
}

function viewForTask(t) {
  if (t.done) return 'completed';
  const today = todayYmd();
  if ((t.date && t.date <= today) || (t.deadline && t.deadline <= today)) return 'today';
  if (t.date) return 'upcoming';
  return t.listId && db.get('lists', t.listId) ? t.listId : 'inbox';
}

function route() {
  const [a, rawB] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  // A malformed escape (#/tag/%) must not take the app down: it falls through to Today.
  const b = rawB === undefined ? null : safeDecode(rawB);
  const prev = viewKey();
  let view = 'today';
  let tag = null;
  if (a === 'list' && b && db.get('lists', b)) view = b;
  else if (a === 'tag' && b) {
    view = 'tag';
    tag = b;
  } else if (a === 'task' && b) {
    const t = db.get('tasks', b);
    if (t) {
      view = viewForTask(t);
      state.sel = t.id;
      state.reveal = t.id;
      openInspector(t.id, { render: false });
      history.replaceState(null, '', isSmart(view) ? `#/${view}` : listHref(view));
    } else toast('That task no longer exists');
  } else if (a && Object.hasOwn(VIEW_ALIASES, a)) view = VIEW_ALIASES[a];
  else if (a && smart(a)) view = a;
  state.view = view;
  state.tag = tag;
  if (viewKey() !== prev) {
    closeComposer();
    state.doneLimit = MORE_STEP;
    state.upLimit = LATER_FIRST;
    if (state.view === 'upcoming') state.upStart = state.upFocus = null;
    // A row picked in another view is not carried over: the new view opens at its top, nothing highlighted.
    if (!state.reveal) state.sel = null;
  }
  // Back to the top before the view is drawn: scrolling after it forced a layout of the whole new list
  // right here (most of a second for a long Upcoming), on top of the one the next frame does anyway.
  mainEl.scrollTop = 0;
  render();
  if (state.reveal) {
    const id = state.reveal;
    state.reveal = null;
    requestAnimationFrame(() => rowEl(id)?.scrollIntoView({ block: 'center' }));
  }
}

// ---------------------------------------------------------------- sidebar & tab bar

function renderNav(c = navCounts()) {
  const current = viewKey();
  const item = (key, label, glyph, { drop, color } = {}) =>
    `<a class="nav-item" href="${esc(hrefFor(key))}" data-nav="${esc(key)}"${drop ? ` data-drop="${esc(drop)}"` : ''} aria-current="${current === key}"${color ? ` style="--ic:${esc(color)}"` : ''}>${glyph}<span class="label">${esc(label)}</span></a>`;
  const lists = listsSorted();
  const tags = [...c.perTag.keys()].sort();
  setHtml(
    navEl,
    `<button type="button" class="nav-item" data-open-palette>${icon('search')}<span class="label">Search</span><span class="nav-keys" aria-hidden="true">${keys('mod K')}</span></button>
    <div class="nav-sep" role="separator"></div>
    ${SMART_LISTS.map((s) => item(s.id, s.name, s.id === 'today' ? todayGlyph() : icon(s.icon), { drop: s.id })).join('')}
    <div class="side-section">
      <div class="side-label"><span>My lists</span><button type="button" class="icon-btn sm" data-add-list aria-label="New list" ${tipAttrs('New list')}>${icon('plus', { size: 16 })}</button></div>
      ${lists.map((l) => item(l.id, l.name, '<span class="swatch" aria-hidden="true"></span>', { drop: `list:${l.id}`, color: colorVar(l.color) })).join('') || '<p class="side-empty">No lists yet</p>'}
    </div>
    ${tags.length ? `<div class="side-section"><div class="side-label"><span>Labels</span></div>${tags.map((g) => item(`tag:${g}`, g, icon('tag', { size: 16 }), { drop: `tag:${g}` })).join('')}</div>` : ''}`,
  );
  // The counts change with almost every edit: they are set in place, so the sidebar itself (and the focus
  // and hover in it) is rebuilt only when its lists, labels or current view change.
  const smartCount = { inbox: c.inbox, today: c.today, important: c.important };
  const count = (key) => (Object.hasOwn(smartCount, key) ? smartCount[key] : key.startsWith('tag:') ? c.perTag.get(key.slice(4)) : c.perList.get(key));
  for (const a of $$('a.nav-item[data-nav]', navEl)) {
    const n = count(a.dataset.nav) || 0;
    let badge = $(':scope > .badge', a);
    if (!n) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      a.append(badge);
    }
    if (badge.textContent !== String(n)) badge.textContent = String(n);
  }
}

function renderTabbar() {
  const tabs = [
    ['inbox', 'Inbox', icon('inbox')],
    ['today', 'Today', todayGlyph(24)],
    ['upcoming', 'Upcoming', icon('upcoming')],
  ];
  // A tab that has focus (Browse, after a list was picked in the drawer it opened) keeps it across the rebuild.
  const bar = $('#tabbar');
  const a = document.activeElement;
  const had = a && bar.contains(a) ? (a.matches('[data-toggle-nav]') ? '[data-toggle-nav]' : `a[href="${CSS.escape(a.getAttribute('href') || '')}"]`) : null;
  const rebuilt = setHtml(
    bar,
    tabs.map(([id, label, glyph]) => `<a href="#/${id}" aria-current="${state.view === id}">${glyph}<span>${label}</span></a>`).join('') +
      `<button type="button" data-toggle-nav aria-controls="sidebar" aria-haspopup="dialog" aria-expanded="${!!drawer}" aria-current="${!['inbox', 'today', 'upcoming'].includes(state.view)}">${icon('list')}<span>Browse</span></button>`,
  );
  if (rebuilt && had) $(had, bar)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- sidebar: a drawer when narrow, collapsible when wide

// ≤900px the sidebar is a drawer over the page, and the details pane covers the list (a sheet); from 901 to
// 1100px the pane takes the sidebar's place instead of covering the list; wider, all three fit side by side.
const narrowMq = matchMedia('(max-width: 900px)');
const midMq = matchMedia('(min-width: 901px) and (max-width: 1100px)');
const phoneMq = matchMedia('(max-width: 640px)');
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusablesIn = (root) => $$(FOCUSABLE, root).filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');

let drawer = null; // { opener } while the drawer is open

/**
 * The page behind a modal layer of ours (the lists drawer, or the details pane while it covers the list)
 * is inert: out of the Tab order, the accessibility tree and the pointer's reach.
 */
function syncInert() {
  const sheet = !!state.open && narrowMq.matches;
  const covered = sheet || !!drawer;
  $('#sidebar').inert = sheet && !drawer;
  for (const n of [mainEl, $('#tabbar'), $('.fab', shellEl)]) if (n) n.inert = covered;
}

/** Wide screens: the sidebar shows unless hidden by the user (Mod+\) or by the details pane (901–1100px). */
const sidebarShown = () => !narrowMq.matches && !settings.get().tasksNavCollapsed && !(state.open && midMq.matches);

/**
 * The sidebar buttons say what they do. Narrow, they open the "Lists" drawer (a dialog): expanded while it is
 * open. Wide, the menu button hides or shows the sidebar and is named for that, as Notes' is ("Hide sidebar"),
 * with no expanded state: the shell shows no tooltip on an expanded button, and the tooltip teaches Mod+\.
 */
function syncNav() {
  const narrow = narrowMq.matches;
  shellEl.classList.toggle('nav-collapsed', !narrow && !!settings.get().tasksNavCollapsed);
  for (const b of $$('[data-toggle-nav]')) {
    if (narrow || !b.closest('#topbar')) {
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-expanded', String(!!drawer));
    } else {
      b.removeAttribute('aria-haspopup');
      b.removeAttribute('aria-expanded');
    }
    if (!b.closest('#topbar')) continue;
    const name = narrow ? 'Lists' : sidebarShown() ? 'Hide sidebar' : 'Show sidebar';
    b.setAttribute('aria-label', name);
    b.dataset.tip = name;
  }
}

/**
 * Open the lists drawer (≤900px) as a modal dialog: focus moves in and stays in, Esc or a pick closes it.
 * `opener` (the button pressed; Safari doesn't focus a tapped button) gets focus back when it closes.
 */
function openDrawer(opener = null) {
  if (drawer || !narrowMq.matches) return;
  const side = $('#sidebar');
  drawer = { opener: opener || document.activeElement };
  shellEl.classList.add('nav-open');
  side.setAttribute('role', 'dialog');
  side.setAttribute('aria-modal', 'true');
  side.setAttribute('aria-label', 'Lists');
  syncInert();
  syncNav();
  requestAnimationFrame(() => {
    if (!drawer) return;
    ($('.nav-item[aria-current="true"]', side) || focusablesIn(side)[0])?.focus({ preventScroll: true });
  });
}

/**
 * Close the drawer. Focus goes back to the button that opened it, unless it already moved on (a list
 * picked opens the palette, a dialog took it): only focus left in the drawer, or dropped, is moved.
 */
function closeDrawer({ restoreFocus = true } = {}) {
  if (!drawer && !shellEl.classList.contains('nav-open')) return;
  const opener = drawer?.opener;
  drawer = null;
  const side = $('#sidebar');
  shellEl.classList.remove('nav-open');
  side.removeAttribute('role');
  side.removeAttribute('aria-modal');
  side.removeAttribute('aria-label');
  syncInert();
  syncNav();
  const a = document.activeElement;
  if (!restoreFocus || (a && a !== document.body && !side.contains(a))) return;
  const usable = opener && opener !== document.body && opener.isConnected && !opener.closest('[inert]') && opener.getClientRects().length;
  (usable ? opener : $('.menu-toggle', topbar))?.focus({ preventScroll: true });
}

/**
 * The sidebar buttons and Mod+\: the drawer when narrow; when wide, hide or show the sidebar (and keep it
 * so). `from` is the button pressed, if any.
 */
function toggleSidebar(from = null) {
  if (narrowMq.matches) {
    // Mod+\ over the details sheet: the sheet closes first (focus back on its row, which gets it again when
    // the drawer closes), as showing the sidebar closes the pane from 901 to 1100px. Two modals never stack.
    if (!drawer && state.open) closeInspector({ restoreFocus: true });
    return drawer ? closeDrawer() : openDrawer(from);
  }
  const side = $('#sidebar');
  if (sidebarShown()) {
    if (side.contains(document.activeElement)) $('.menu-toggle', topbar)?.focus({ preventScroll: true });
    return settings.set({ tasksNavCollapsed: true });
  }
  // 901–1100px the open details pane holds the sidebar's place: showing the sidebar closes it.
  if (state.open && midMq.matches) closeInspector();
  if (settings.get().tasksNavCollapsed) settings.set({ tasksNavCollapsed: false });
  else syncNav();
}

// Trap Tab inside the open drawer (the page behind is inert, so focus would leave for the browser's UI).
$('#sidebar').addEventListener('keydown', (e) => {
  if (!drawer || e.key !== 'Tab') return;
  const f = focusablesIn($('#sidebar'));
  if (!f.length) return;
  if (document.activeElement === (e.shiftKey ? f[0] : f.at(-1))) {
    e.preventDefault();
    (e.shiftKey ? f.at(-1) : f[0]).focus();
  }
});
// Search in the drawer: close the drawer first (focus back on its button), so the palette, which opens on
// the same click, returns focus there rather than to a button in a closed drawer.
$('#sidebar').addEventListener('click', (e) => drawer && e.target.closest?.('[data-open-palette]') && closeDrawer(), true);
// Crossing 900px: a drawer left open becomes the sidebar again, and a pane sheet becomes a side panel.
narrowMq.addEventListener('change', () => {
  if (!narrowMq.matches) closeDrawer({ restoreFocus: false });
  syncSheet();
  syncNav();
});
midMq.addEventListener('change', syncNav);

// ---------------------------------------------------------------- header

function renderHead(c = navCounts()) {
  const list = currentList();
  const title = viewTitle();
  $('#compact-title').textContent = title;
  document.title = `${title} · tasks`;
  const parts = [];
  if (state.view === 'today') {
    const planned = c.planned;
    parts.push(`<span>${esc(fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }))}</span>`);
    if (planned) parts.push(`<span>${esc(`${fmtDuration(planned)} planned`)}</span>`);
  }
  const mode = sortMode();
  if (sortable() && mode !== 'manual')
    parts.push(
      `<span class="sort-chip"><button type="button" class="sort-chip-btn" data-sort aria-haspopup="menu" aria-label="${esc(`Sorted by ${SORTS[mode].label}. Change sort`)}">${icon('sort', { size: 14 })}<span>${esc(SORTS[mode].label)}</span></button><button type="button" class="sort-chip-x" data-sort-reset aria-label="Back to my order" ${tipAttrs('Back to my order')}>${icon('x', { size: 13 })}</button></span>`,
    );
  const lead = list ? `<span class="list-dot" style="background:${esc(colorVar(list.color))}" aria-hidden="true"></span>` : state.view === 'tag' ? `<span class="tag-glyph" aria-hidden="true">${icon('tag', { size: 22 })}</span>` : '';
  setHtml(
    headEl,
    `<div class="view-head">
    <h1 class="view-title">${lead}<span class="truncate">${esc(title)}</span></h1>
    ${parts.length ? `<div class="vh-sub">${parts.join('<span class="sep" aria-hidden="true"></span>')}</div>` : ''}
  </div>`,
  );
  const actions = [];
  if (state.view === 'today') actions.push(`<button type="button" class="btn btn-ghost" data-suggestions aria-haspopup="dialog" aria-label="Suggestions">${icon('bulb', { size: 17 })}<span>Suggestions</span></button>`);
  actions.push(`<button type="button" class="icon-btn" data-view-menu aria-label="More options" aria-haspopup="menu" ${tipAttrs('More options')}>${icon('more')}</button>`);
  setHtml($('#head-actions'), actions.join(''));
}

// ---------------------------------------------------------------- composer (To Do's "Add a task" → Todoist's quick add)

const composerEl = document.createElement('div');
composerEl.className = 'composer';
composerEl.innerHTML = `
  <button type="button" class="add-row" data-composer-open><span class="plus">${icon('plus', { size: 15, stroke: 2.4 })}</span><span>Add task</span></button>
  <form class="composer-box" hidden autocomplete="off" novalidate>
    <div class="qa-field"><div class="qa-mirror" aria-hidden="true"></div><textarea name="title" rows="1" spellcheck="false" autocomplete="off" maxlength="1000" aria-label="Task name" enterkeyhint="done"></textarea></div>
    <textarea class="cb-notes" name="notes" rows="1" placeholder="Description" aria-label="Description" maxlength="20000"></textarea>
    <div class="cb-chips"></div>
    <div class="cb-foot"><span class="grow"></span>
      <button type="button" class="btn btn-ghost btn-sm" data-composer-cancel>Cancel</button>
      <button type="submit" class="btn btn-primary btn-sm" data-composer-submit disabled>Add task</button></div>
  </form>`;
slotEl.append(composerEl);
const cForm = $('form', composerEl);
const cTitle = cForm.elements.title;
const cNotes = cForm.elements.notes;
const cMirror = $('.qa-mirror', composerEl);
const cChips = $('.cb-chips', composerEl);
const cAddRow = $('.add-row', composerEl);
let co = {}; // chip overrides: { date, time, priority, listId, dropTags: labels the view adds that were taken off }

function composerDefaults() {
  const host = state.composer?.host;
  if (host && host !== 'top') return { date: host };
  switch (state.view) {
    case 'today':
    case 'upcoming':
      return { date: todayYmd() };
    case 'important':
      return { priority: 3 };
    case 'tag':
      return { tags: [state.tag] };
    default:
      return isSmart(state.view) ? {} : { listId: state.view };
  }
}

function composerValues() {
  const r = parse(cTitle.value, { mode: 'task', lists: db.all('lists'), hour12: hour12(), dmy: isDmy, ranges: true }); // "dec 3-5": planned Dec 3, due Dec 5
  const d = composerDefaults();
  return {
    r,
    title: r.title,
    // A bare time ("Lunch at noon") shows the day createTask will give it (plannedDay), before Enter.
    date: co.date !== undefined ? co.date : r.date ?? (r.someday ? null : d.date ?? plannedDay(r)),
    time: co.date === null ? null : co.time !== undefined ? co.time : r.time,
    duration: r.duration,
    repeat: r.repeat,
    deadline: r.deadline,
    priority: prio(co.priority !== undefined ? co.priority : r.priority || d.priority || 0),
    listId: co.listId !== undefined ? co.listId : r.listId ?? d.listId ?? null,
    newList: co.listId === undefined && !r.listId ? r.newList : null,
    tags: [...new Set([...viewTags(d), ...r.tags])],
    notes: cNotes.value.trim(),
  };
}
/** The labels the view adds by itself (a label's page adds that label), less any the user took off. */
const viewTags = (d = composerDefaults()) => (d.tags || []).filter((g) => !co.dropTags?.includes(g));

function composerPlaceholder() {
  const list = currentList();
  const host = state.composer?.host;
  if (host && host !== 'top') return `Task for ${relLower(host)}`;
  if (list) return `Add to ${list.name}, e.g. “Review notes tomorrow p2”`;
  if (state.view === 'today') return 'Task name, e.g. “Call mom 6pm for 20m p1”';
  return 'Task name, e.g. “Pay rent every 1st #Personal”';
}

const xButton = (attr, label, tip = label) => `<button type="button" class="cb-x" ${attr} aria-label="${esc(label)}" ${tipAttrs(tip)}>${icon('x', { size: 13 })}</button>`;

function renderComposer() {
  composerStale = false;
  const v = composerValues();
  const raw = cTitle.value;
  const placeholder = composerPlaceholder();
  if (cTitle.placeholder !== placeholder) cTitle.placeholder = placeholder;
  // The mirror wraps exactly like the title over it and sets the field's height: the highlights sit under
  // the words they mark, and a long title grows onto new lines instead of scrolling out of sight (the field
  // never keeps a scroll of its own: see the scroll listener below). Empty, it holds the (invisible)
  // placeholder, so a placeholder that wraps on a phone still fits.
  let mirror = '';
  let at = 0;
  for (const t of v.r.tokens) {
    mirror += `${esc(raw.slice(at, t.start))}<mark>${esc(raw.slice(t.start, t.end))}</mark>`;
    at = t.end;
  }
  setHtml(cMirror, raw ? `${mirror}${esc(raw.slice(at))}&#8203;` : esc(placeholder));
  $('[data-composer-submit]', composerEl).disabled = !v.title;
  const lists = listMap();
  const p = PRIORITIES.find((x) => x.value === v.priority) || PRIORITIES[3];
  const list = v.listId ? lists.get(v.listId) : null;
  const dateText = v.date ? `${relDate(v.date)}${v.time ? ` ${fmtClock(v.time)}` : ''}` : 'Date';
  const chips = [
    `<span class="cb-group"><button type="button" class="cb-chip${v.date ? ` tone-${dateTone(v.date)} has-x` : ''}" data-cc="date" aria-haspopup="dialog" aria-label="${esc(v.date ? `Date: ${dateText}` : 'Set date')}">${v.date === todayYmd() ? todayGlyph(15) : icon('calendar', { size: 15 })}<span class="truncate">${esc(dateText)}</span></button>${v.date ? xButton('data-cc-clear="date"', 'Clear date') : ''}</span>`,
    `<button type="button" class="cb-chip pr${v.priority}" data-cc="priority" aria-haspopup="menu" aria-label="${esc(v.priority ? `Priority: ${p.label}` : 'Set priority')}">${icon(v.priority ? 'flag-fill' : 'flag', { size: 15 })}<span>${esc(v.priority ? p.short : 'Priority')}</span></button>`,
    `<button type="button" class="cb-chip" data-cc="list" aria-haspopup="menu" aria-label="${esc(`List: ${v.newList ? `new list ${v.newList}` : list ? list.name : 'Inbox'}`)}">${
      v.newList ? `${icon('plus', { size: 15 })}<span class="truncate">${esc(v.newList)}</span>` : list ? `${dotHtml(list.color)}<span class="truncate">${esc(list.name)}</span>` : `${icon('inbox', { size: 15 })}<span>Inbox</span>`
    }</button>`,
  ];
  // The label a label's page adds by itself shows too, so it can be seen and taken off.
  for (const g of viewTags()) {
    if (!v.r.tags.includes(g)) chips.push(`<span class="cb-chip is-parsed">${icon('tag', { size: 15 })}<span class="truncate">${esc(g)}</span>${xButton(`data-cc-untag="${esc(g)}"`, `Remove label ${g}`, 'Remove label')}</span>`);
  }
  // Words the parser picked up that have no chip of their own; × keeps the words in the task name.
  const extra = { repeat: ['repeat', v.repeat && describe(v.repeat)], duration: ['duration', v.duration && fmtDuration(v.duration)], deadline: ['deadline', v.deadline && `Deadline ${relDate(v.deadline)}`] };
  v.r.tokens.forEach((t, i) => {
    const words = String(t.text || '').trim();
    const keep = xButton(`data-unparse="${i}"`, `Keep “${words}” in the task name`, 'Keep in the name');
    if (extra[t.kind]?.[1]) chips.push(`<span class="cb-chip is-parsed">${icon(extra[t.kind][0], { size: 15 })}<span class="truncate">${esc(extra[t.kind][1])}</span>${keep}</span>`);
    if (t.kind === 'tag') chips.push(`<span class="cb-chip is-parsed">${icon('tag', { size: 15 })}<span class="truncate">${esc(words.slice(1))}</span>${keep}</span>`);
  });
  // Most keys change no chip: the chips (and a focused one) are rebuilt only when they do.
  setHtml(cChips, chips.join(''));
}

// Typing draws at once; more input within the same frame (a key held down, an IME) is drawn by that frame.
let composerFrame = 0;
let composerStale = false;
function composerInput() {
  if (composerFrame) return void (composerStale = true);
  renderComposer();
  composerFrame = requestAnimationFrame(() => {
    composerFrame = 0;
    if (composerStale) renderComposer();
  });
}

function placeComposer() {
  const host = state.composer?.host;
  const target = host && host !== 'top' ? $(`[data-composer-host="${CSS.escape(host)}"]`, bodyEl) : slotEl;
  if (target && composerEl.parentElement !== target) target.append(composerEl);
  const open = !!state.composer;
  cForm.hidden = !open;
  cAddRow.hidden = open;
  shellEl.classList.toggle('composing', open); // phones: the floating + would cover the composer's buttons
  slotEl.hidden = state.view === 'completed' || state.view === 'upcoming';
}

function openComposer(host = 'top', prefill = '') {
  // Completed has no composer, so adding starts in Inbox. Switch synchronously: the hashchange from go()
  // would arrive after the composer opened and close it again (losing a palette prefill with it).
  if (state.view === 'completed') {
    history.pushState(null, '', '#/inbox');
    closeDrawer({ restoreFocus: false });
    route();
  }
  // Upcoming has an "Add task" under every day; the global shortcut adds to the first visible day.
  if (state.view === 'upcoming' && host === 'top') host = state.upStart || todayYmd();
  const moved = (state.composer?.host || null) !== host;
  state.composer = { host };
  if (moved) co = {};
  if (host !== 'top') renderBody();
  if (prefill) cTitle.value = prefill;
  placeComposer();
  renderComposer();
  // Focus first without scrolling, then scroll: a focus() scroll would cut the smooth scroll short.
  requestAnimationFrame(() => {
    cTitle.focus({ preventScroll: true });
    if (host === 'top') mainEl.scrollTo({ top: 0, behavior: smooth() });
    else composerEl.scrollIntoView({ block: 'nearest', behavior: smooth() });
  });
}

/** Forget the draft, its chips and any open suggestion list (closeComposer also puts the composer back). */
function resetComposer() {
  state.composer = null;
  cTitle.value = '';
  cNotes.value = '';
  cNotes.style.height = '';
  co = {};
  autoPick = false;
  titleSuggest.close();
}

/**
 * Put the composer away. With `focus` (Esc, Cancel) focus goes back to what opens it again: the day's
 * "Add task" in Upcoming, the + button on phones, else the "Add task" row, never dropped to the page.
 */
function closeComposer({ focus = false } = {}) {
  const host = state.composer?.host;
  const wasDay = state.composer && host !== 'top';
  resetComposer();
  if (composerEl.parentElement !== slotEl) slotEl.append(composerEl);
  placeComposer();
  if (wasDay) renderBody();
  if (!focus) return;
  const back = wasDay ? $(`[data-add-on="${CSS.escape(host)}"]`, bodyEl) : phoneMq.matches ? $('.fab', shellEl) : cAddRow;
  back?.focus({ preventScroll: true });
}

function submitComposer() {
  const v = composerValues();
  if (!v.title) return;
  const t = createTask(v);
  cTitle.value = '';
  cNotes.value = '';
  cNotes.style.height = '';
  co = {};
  autoPick = false;
  titleSuggest.close(); // a #/@ list left open would offer the previous task's words again
  renderComposer();
  const dest = viewForTask(t);
  const visible =
    state.view === 'upcoming'
      ? upcomingShows(t)
      : dest === state.view || (state.view === 'inbox' && !t.listId) || state.view === t.listId || (state.view === 'important' && t.priority === 3) || (state.view === 'tag' && t.tags.includes(state.tag));
  // Upcoming draws only the first of its later months' tasks: one added past them is named by its day.
  const where = dest === state.view && isYmd(t.date) ? `Added for ${relDate(t.date)}` : `Added to ${smart(dest)?.name || db.get('lists', dest)?.name || 'Inbox'}`;
  if (!visible) toast(where, { action: 'View', onAction: () => openTask(t.id) });
  requestAnimationFrame(() => cTitle.focus());
}

// "#" completes list names and "@" labels, in place, without leaving the title field. As in Todoist the
// first suggestion is highlighted, so Enter takes it: "#Wo" becomes "#Work", never a new list "Wo". A name
// typed out in full needs no completing, so there Enter adds the task (longer names such as "Workshop"
// under "#Work" are still listed, unhighlighted, for the arrow keys).
const completions = new Map();
let autoPick = false; // the open list completes a partial word: highlight its first row, Enter takes it
const titleSuggest = attachSuggest(
  cTitle,
  (q) => {
    completions.clear();
    autoPick = false;
    const caret = cTitle.selectionStart ?? q.length;
    const m = q.slice(0, caret).match(/(?:^|\s)([#@])([\p{L}\p{N}_-]*)$/u);
    if (!m) return [];
    const [, sigil, typed] = m;
    const word = typed.toLowerCase();
    const start = caret - typed.length - 1;
    const rest = q.slice(caret).replace(/^[\p{L}\p{N}_-]*\s*/u, '');
    const pool = [...new Set(sigil === '#' ? listsSorted().map((l) => l.name) : [...tagCounts().keys()].sort())];
    const others = pool.filter((n) => n.toLowerCase() !== word);
    const names = [...others.filter((n) => n.toLowerCase().startsWith(word)), ...others.filter((n) => !n.toLowerCase().startsWith(word) && n.toLowerCase().includes(word))].slice(0, 6);
    autoPick = names.length > 0 && others.length === pool.length;
    return names.map((n) => {
      const insert = `${sigil}${n} `;
      const value = q.slice(0, start) + insert + rest;
      completions.set(value, start + insert.length);
      return { value, label: n, icon: sigil === '#' ? 'list' : 'tag', hint: sigil === '#' ? 'List' : 'Label' };
    });
  },
  {
    max: 6,
    // A partial word is highlighted on each refresh (so Enter completes it); a name typed in full is not.
    autoHighlight: () => autoPick,
    onPick: (value) => {
      const at = completions.get(value);
      if (at != null) cTitle.setSelectionRange(at, at);
      renderComposer();
    },
  },
);

/** The row of the open #/@ list at `i`, or null when the list is closed. */
const suggestionRow = (i) => (cTitle.getAttribute('aria-expanded') === 'true' ? document.getElementById(cTitle.getAttribute('aria-controls') || '')?.querySelector(`[data-s="${i}"]`) || null : null);

// attachSuggest's own input listener runs first (it was attached first), so the list is current here.
cTitle.addEventListener('input', () => {
  // The name is one line that wraps: a pasted line break becomes a space.
  if (/[\r\n]/.test(cTitle.value)) {
    const flat = (s) => s.replace(/\r\n?|\n/g, ' ');
    const at = flat(cTitle.value.slice(0, cTitle.selectionStart)).length;
    cTitle.value = flat(cTitle.value);
    cTitle.setSelectionRange(at, at);
    titleSuggest.refresh();
  }
  composerInput();
});
// The name grows with its mirror rather than scrolling: a caret that ran onto a new line before the mirror
// grew scrolled the field, so it is put back (only then: setting it on every key forced a layout of the page).
cTitle.addEventListener('scroll', () => cTitle.scrollTop && (cTitle.scrollTop = 0), { passive: true });
cNotes.addEventListener('input', () => autosize(cNotes));
cForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitComposer();
});
composerEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // The shell closes the open suggestion list or menu first. On the closed composer's "Add task" row, Esc
    // is the page's (it closes the details pane), as on any other row.
    if (hasOpenLayer() || !state.composer) return;
    e.preventDefault();
    e.stopPropagation();
    closeComposer({ focus: true });
  } else if (e.key === 'Enter' && e.target === cTitle && !e.isComposing) {
    // Enter (Shift+Enter too) adds the task: the name never takes a line break.
    e.preventDefault();
    // attachSuggest takes Enter itself when a row is highlighted; a completing list that somehow has none
    // still completes the word rather than submit the half-typed "#Wo".
    if (autoPick && suggestionRow(0)) return suggestionRow(0).click();
    submitComposer();
  } else if (e.key === 'Enter' && e.target === cNotes && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitComposer();
  }
});
composerEl.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-composer-open]')) return openComposer(state.composer?.host || 'top');
  if (t.closest('[data-composer-cancel]')) return closeComposer({ focus: true });
  if (t.closest('[data-cc-clear]')) {
    // The day goes with any time picked for it: the next day picked doesn't bring that time back.
    co.date = null;
    delete co.time;
    renderComposer();
    return $('[data-cc="date"]', composerEl)?.focus();
  }
  const untag = t.closest('[data-cc-untag]');
  if (untag) {
    co.dropTags = [...new Set([...(co.dropTags || []), untag.dataset.ccUntag])];
    renderComposer();
    return cTitle.focus();
  }
  const un = t.closest('[data-unparse]');
  if (un) {
    const tok = composerValues().r.tokens[+un.dataset.unparse];
    if (!tok) return;
    const v = cTitle.value;
    const lead = v.slice(tok.start, tok.end).match(/^\s*/)[0].length;
    cTitle.value = `${v.slice(0, tok.start + lead)}"${v.slice(tok.start + lead, tok.end)}"${v.slice(tok.end)}`;
    renderComposer();
    return cTitle.focus();
  }
  const chip = t.closest('[data-cc]');
  if (!chip) return;
  const v = composerValues();
  const done = () => (renderComposer(), cTitle.focus());
  // The date menu sets a time too (Todoist). A time left as it was stays the typed one, so editing "3pm" in
  // the name after picking a day still counts; a time picked or cleared here wins over the name's. "No date"
  // drops a time picked here with the day, as the chip's × does (a time typed in the name stays in the name).
  if (chip.dataset.cc === 'date')
    openDatePicker(chip, {
      value: v.date,
      withTime: true,
      time: v.time,
      title: 'Date',
      onPick: ({ date, time }) => {
        co.date = date;
        if (!date) delete co.time;
        else if (time !== (v.time ?? null)) co.time = time;
        done();
      },
    });
  if (chip.dataset.cc === 'priority') openMenu(chip, PRIORITIES.map((p) => ({ label: p.label, iconHtml: flagIcon(p.value), checked: v.priority === p.value, onSelect: () => ((co.priority = p.value), done()) })), { label: 'Priority' });
  if (chip.dataset.cc === 'list')
    openMenu(
      chip,
      [
        { label: 'Inbox', icon: 'inbox', checked: !v.listId && !v.newList, onSelect: () => ((co.listId = null), done()) },
        ...listsSorted().map((l) => ({ label: l.name, iconHtml: dotHtml(l.color), checked: v.listId === l.id, onSelect: () => ((co.listId = l.id), done()) })),
      ],
      { label: 'List' },
    );
});

// ---------------------------------------------------------------- task rows

function taskRow(t, ctx) {
  const today = ctx.today;
  const id = String(t.id);
  const list = t.listId ? ctx.lists.get(t.listId) : null;
  const done = !!t.done || pending.has(id);
  const p = prio(t.priority);
  const meta = [];
  const date = dateOf(t);
  const time = timeOf(t);
  const dur = durOf(t);
  const hideDate = ctx.hideDateFor && date === ctx.hideDateFor;
  const completedView = ctx.view === 'completed';
  if (!completedView) {
    const showDate = date && !hideDate;
    if (showDate || time) {
      const tone = date && !t.done ? dateTone(date, today) : 'later';
      const label = [showDate ? relDate(date) : '', time ? fmtTimeRange(time, endTime(t)) : ''].filter(Boolean).join(' ');
      meta.push(`<span class="m tone-${tone}">${icon(showDate ? 'calendar' : 'clock')}${esc(label)}${t.repeat ? icon('repeat') : ''}</span>`);
    } else if (t.repeat) meta.push(`<span class="m">${icon('repeat')}${esc(describe(t.repeat))}</span>`);
    if (dur && !time) meta.push(`<span class="m">${icon('duration')}${esc(fmtDuration(dur))}</span>`);
    // "Deadline", never "Due": the date is the day you plan to do it, the deadline the day it must be done.
    if (isYmd(t.deadline) && !t.done) {
      const n = diffDays(today, t.deadline);
      meta.push(`<span class="m${n < 0 ? ' tone-overdue' : n <= 2 ? ' tone-tomorrow' : ''}">${icon('deadline', { size: 13 })}${esc(n < 0 ? `${-n}d overdue` : `Deadline ${relDate(t.deadline)}`)}</span>`);
    }
    // Priority 2 and 3 in words as well as in the ring's colour (priority 1 has its filled star).
    if ((p === 1 || p === 2) && !t.done) meta.push(`<span class="m pr${p}">${icon('flag-fill', { size: 13 })}${esc(PRIORITIES.find((x) => x.value === p).short)}</span>`);
  }
  const steps = Array.isArray(t.checklist) ? t.checklist : [];
  if (steps.length) meta.push(`<span class="m">${icon('checklist')}${esc(`${steps.filter((x) => x.done).length}/${steps.length}`)}</span>`);
  for (const g of t.tags || []) if (!(ctx.view === 'tag' && g === state.tag)) meta.push(`<span class="m">${icon('tag')}${esc(g)}</span>`);
  if ((completedView || ctx.done) && t.done && t.completedAt) {
    const cd = new Date(t.completedAt);
    if (!Number.isNaN(cd.getTime())) meta.push(`<span class="m">${icon('check')}${esc(fmtClock(`${pad(cd.getHours())}:${pad(cd.getMinutes())}`))}</span>`);
  }
  const where =
    ctx.showList === false || (list && ctx.view === list.id) || (!list && ctx.view === 'inbox')
      ? ''
      : `<span class="where">${list ? `<span class="dot" style="color:${esc(colorVar(list.color))}"></span><span class="truncate">${esc(list.name)}</span>` : `${icon('inbox', { size: 12 })}<span class="truncate">Inbox</span>`}</span>`;
  // The name is a button (it opens the details) described by the note's first line and the meta line.
  const descId = t.notes ? `td-${id}` : '';
  const metaId = meta.length || where ? `tm-${id}` : '';
  const desc = descId ? `<div class="task-desc" id="${esc(descId)}">${esc(String(t.notes).split('\n')[0])}</div>` : '';
  const describedBy = [descId, metaId].filter(Boolean).join(' ');
  const cls = ['task', t.done && 'is-done', pending.has(id) && 'completing', pending.has(id) && leaving.has(id) && 'leaving gone', state.sel === id && 'sel', state.open === id && 'open', p === 3 && 'is-starred']
    .filter(Boolean)
    .join(' ');
  const name = untitled(t);
  const pName = p && !done ? `, ${PRIORITIES.find((x) => x.value === p).label.toLowerCase()}` : '';
  return `<div class="${cls}" role="listitem" data-id="${esc(id)}" draggable="${!t.done}">
    <button type="button" class="check p${p}" role="checkbox" aria-checked="${done}" aria-label="${esc(`${done ? 'Mark as not done' : 'Complete'}: ${name}${pName}`)}" data-check>${icon('check', { size: 12, stroke: 3 })}</button>
    <div class="task-main"><button type="button" class="task-title" data-open${describedBy ? ` aria-describedby="${esc(describedBy)}"` : ''}>${t.title ? esc(t.title) : `<span class="faint">${esc(name)}</span>`}</button>${desc}${metaId ? `<div class="task-meta" id="${esc(metaId)}">${meta.join('')}${where}</div>` : ''}</div>
    <div class="task-actions">
      <button type="button" class="icon-btn" data-row-date aria-haspopup="dialog" aria-label="${esc(`Set date: ${name}`)}" ${tipAttrs('Date', 'r')}>${icon('calendar', { size: 16 })}</button>
      <button type="button" class="icon-btn" data-row-more aria-haspopup="menu" aria-label="${esc(`More actions: ${name}`)}" ${tipAttrs('More')}>${icon('more', { size: 16 })}</button>
    </div>
    ${t.done ? '' : `<button type="button" class="star${p === 3 ? ' on' : ''}" data-star aria-pressed="${p === 3}" aria-label="${esc(`Important: ${name}`)}" ${tipAttrs('Important', 's')}>${icon(p === 3 ? 'star-fill' : 'star', { size: 18 })}</button>`}
  </div>`;
}

// A row's html is kept with its task (the store makes a new object for every change to a task) for as long
// as nothing else it shows changes: the day, the lists, the clock format, the view and section, the label
// page, and the row's selected, open and completing state.
const rowCache = new WeakMap();
/** What every row of this redraw shows besides its own task (see rowCache). */
const rowsSig = (lists, today) => `${today}\u0001${state.tag ?? ''}\u0001${hour12()}\u0001${[...lists.values()].map((l) => `${l.id}\u0002${l.name}\u0002${l.color}`).join('\u0003')}`;

/** A list's rows, for a block's LIST_SLOT (see patchBody). */
const rowsOf = (tasks, ctx) =>
  tasks.map((t) => {
    const id = String(t.id);
    const key = `${ctx.sig}\u0001${ctx.view}\u0001${ctx.hideDateFor ?? ''}\u0001${ctx.done ? 1 : 0}${state.sel === id ? 1 : 0}${state.open === id ? 1 : 0}${pending.has(id) ? 1 : 0}${leaving.has(id) ? 1 : 0}`;
    const hit = rowCache.get(t);
    if (hit?.key === key) return { id, html: hit.html };
    const html = taskRow(t, ctx);
    rowCache.set(t, { key, html });
    return { id, html };
  });
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `data-${k}="${esc(v)}"`)
    .join(' ');

/** The collapsible "Completed" under a view (Microsoft To Do): its toggle, and its rows while open. */
function doneBlocks(view, ctx, opts = {}) {
  const done = completedIn(view, { tag: state.tag });
  if (!done.length) return [];
  const expanded = state.showDone.has(viewKey());
  const out = [
    {
      key: 'done-toggle',
      html: `<button type="button" class="done-toggle" data-toggle-done aria-expanded="${expanded}">${icon('chevron-right', { size: 16 })}<span>Completed</span><span class="count">${esc(done.length)}</span></button>`,
    },
  ];
  // ctx.view stays the page's view, so done tasks in a list don't repeat that list's name.
  if (expanded) out.push({ key: 'done-list', html: `<div class="done-list">${LIST_SLOT}</div>`, rows: rowsOf(done.slice(0, 100), { ...ctx, ...opts, done: true }) });
  return out;
}

const sectionHead = (inner, id = '') => `<h2 class="section-head"${id ? ` id="${esc(id)}"` : ''}>${inner}</h2>`;
const overdueBlock = (overdue, ctx) => ({
  key: 'overdue',
  html: `<section class="section" aria-label="Overdue">${sectionHead(`<span class="tone-overdue">Overdue</span>${COUNT_SLOT}<button type="button" class="link" data-reschedule aria-haspopup="menu">Reschedule</button>`)}${LIST_SLOT}</section>`,
  rows: rowsOf(overdue, { ...ctx, view: 'overdue' }),
  count: overdue.length,
});

/** Day header: the locale's "Sun, Nov 22" plus Today / Tomorrow. */
function dayHead(d) {
  const rel = diffDays(todayYmd(), d);
  const tag = rel === 0 ? 'Today' : rel === 1 ? 'Tomorrow' : '';
  return `<span>${esc(fmt(parseYmd(d), { weekday: 'short', month: 'short', day: 'numeric' }))}</span>${tag ? `<span class="sep" aria-hidden="true"></span><span class="rel">${tag}</span>` : ''}`;
}

// ---------------------------------------------------------------- events from schedule

// Events change far less often than tasks: a day range's instances are kept until events or calendars do
// (eventsRev, bumped in db.on below), instead of being worked out from every event on each redraw.
let eventsRev = 0;
let instCache = null;
function instancesFor(from, to) {
  if (instCache?.rev === eventsRev && instCache.from === from && instCache.to === to) return instCache.list;
  const list = eventInstances(from, to);
  instCache = { rev: eventsRev, from, to, list };
  return list;
}

function eventsFor(dayYmd, instances) {
  if (!settings.get().showEventsInToday) return '';
  const { allDay, timed } = dayInstances(instances, dayYmd);
  if (!allDay.length && !timed.length) return '';
  const now = Date.now();
  const row = (i, when) => {
    const s = i.start.getTime();
    const e = i.end.getTime();
    const cls = i.allDay ? '' : e <= now ? ' past' : s <= now ? ' now' : '';
    const href = `../schedule/#/day/${encodeURIComponent(dayYmd)}/event/${encodeURIComponent(i.event.id)}`;
    return `<a class="event-row${cls}" href="${esc(href)}" style="--ev:${esc(colorVar(i.color))}"${i.allDay ? '' : ` data-start="${esc(s)}" data-end="${esc(e)}"`} ${tipAttrs('Open in schedule')}>
      <span class="bar" aria-hidden="true"></span><span class="when">${esc(when)}</span><span class="what">${esc(i.event.title || 'Untitled event')}</span>${i.event.location ? `<span class="where">${esc(i.event.location)}</span>` : ''}</a>`;
  };
  const rows = [...allDay.map((i) => row(i, 'All day')), ...timed.map((i) => row(i, fmtTimeRange(i.start, i.end)))].join('');
  return `<div class="day-events">${rows}</div>`;
}

// ---------------------------------------------------------------- views

const emptyState = (glyph, title, text) => `<div class="empty"><div class="glyph">${glyph}</div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

/** True for focus the keyboard put there (a click focuses buttons too, without :focus-visible). */
const keyboardFocus = (el) => {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
};

/**
 * What has keyboard focus in the list, so a rebuild can put it back on the same row and control. Focus a
 * click left behind is not carried over: moved onto the next row it would select that row and, with the
 * details pane open, switch the pane to it (a mouse completion must leave the pane alone).
 */
let bodyView = null; // the view the list was last built for (route() changes state.view before the rebuild)
function captureBodyFocus() {
  const a = document.activeElement;
  if (!a || !bodyEl.contains(a) || composerEl.contains(a) || !keyboardFocus(a)) return null;
  const row = a.closest('.task[data-id]');
  const dataAttr = (el) => [...el.attributes].find((x) => x.name.startsWith('data-') && x.name !== 'data-tip' && x.name !== 'data-keys');
  if (row) {
    const ctl = dataAttr(a);
    return { view: bodyView, id: row.dataset.id, index: visibleIds().indexOf(row.dataset.id), ctl: ctl ? `[${CSS.escape(ctl.name)}]` : '[data-check]' };
  }
  const own = dataAttr(a);
  return own ? { view: bodyView, selector: `[${CSS.escape(own.name)}="${CSS.escape(own.value)}"]` } : null;
}
/**
 * Put focus back after a redraw: on the same task's row, else (same view only) on the row now at that
 * position, as when the focused task was completed. After a switch to another view, a row that merely sits
 * at the same position is a different task, so focus is not moved onto it (that would also select it). A
 * task picked meanwhile (from search, a #/task link, a duplicate) takes the focus, so focus, selection and
 * the details pane agree, and the single-key shortcuts act on the task a screen reader is on.
 */
function restoreBodyFocus(f) {
  if (!f || (document.activeElement && document.activeElement !== document.body && !bodyEl.contains(document.activeElement))) return;
  const sameView = f.view === viewKey();
  let el = null;
  if (f.selector) el = sameView ? $(f.selector, bodyEl) : null;
  else {
    const ids = visibleIds();
    const picked = state.sel && f.id && state.sel !== f.id && ids.includes(state.sel) ? state.sel : null;
    const id = picked || (ids.includes(f.id) ? f.id : sameView ? ids[Math.min(f.index, ids.length - 1)] : null);
    const row = rowEl(id);
    el = row && ($(f.ctl, row) || $('[data-check]', row));
  }
  if (el && document.activeElement !== el) el.focus({ preventScroll: true });
}

function renderBody() {
  const lists = listMap();
  const today = todayYmd();
  const v = state.view;
  const ctx = { lists, today, view: v, sig: rowsSig(lists, today) };
  const sort = sorter();
  const blocks = [];

  if (v === 'today') {
    const all = tasksIn('today').sort(sort);
    const overdue = [];
    const todays = [];
    for (const t of all) ((t.date ? t.date < today : t.deadline < today) ? overdue : todays).push(t);
    const events = eventsFor(today, instancesFor(today, today));
    if (events) blocks.push({ key: 'events', html: events });
    if (overdue.length) blocks.push(overdueBlock(overdue, ctx));
    if (todays.length)
      blocks.push({
        key: 'today',
        html: `<section class="section" ${attrs({ date: today })} aria-label="Today">${overdue.length ? sectionHead(`<span>Today</span>${COUNT_SLOT}`) : ''}${LIST_SLOT}</section>`,
        rows: rowsOf(todays, { ...ctx, hideDateFor: today }),
        count: todays.length,
      });
    if (!all.length) blocks.push({ key: 'empty', html: emptyState(todayGlyph(30), 'Enjoy your day', 'Nothing left for today. Add a task, or open Suggestions to plan ahead.') });
    blocks.push(...doneBlocks('today', ctx, { hideDateFor: today }));
  } else if (v === 'upcoming') {
    blocks.push(...upcomingBlocks(ctx));
  } else if (v === 'completed') {
    const done = tasksIn('completed');
    if (!done.length) blocks.push({ key: 'empty', html: emptyState(icon('done'), 'Nothing completed yet', 'Tasks you finish are kept here.') });
    const groups = new Map();
    for (const t of done.slice(0, state.doneLimit)) {
      const d = new Date(t.completedAt || t.updatedAt || 0);
      const key = Number.isNaN(d.getTime()) ? today : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const [key, ts] of groups) blocks.push({ key: `done:${key}`, html: `<section class="section">${sectionHead(`<span>${esc(dayLabel(key, { long: true }))}</span>${COUNT_SLOT}`)}${LIST_SLOT}</section>`, rows: rowsOf(ts, ctx), count: ts.length });
    if (done.length > state.doneLimit) blocks.push({ key: 'more', html: '<button type="button" class="btn btn-secondary btn-sm show-more" data-more-done>Show older</button>' });
  } else {
    let tasks;
    let empty;
    if (v === 'inbox') {
      tasks = tasksIn('inbox');
      empty = emptyState(icon('inbox'), 'Your inbox is clear', 'Capture anything here, then sort it into lists or give it a date.');
    } else if (v === 'important') {
      tasks = tasksIn('important');
      empty = emptyState(icon('star'), 'Nothing marked important', 'Star a task, or give it priority 1, to see it here.');
    } else if (v === 'tag') {
      tasks = tasksIn('tag', { tag: state.tag });
      empty = emptyState(icon('tag'), `Nothing labelled ${state.tag}`, 'Add a label to a task to see it here.');
    } else {
      if (!currentList()) return go('inbox');
      tasks = tasksIn(v);
      empty = emptyState(icon('list'), 'No tasks yet', 'Add one above, or drag tasks onto this list in the sidebar.');
    }
    tasks.sort(sort);
    blocks.push(tasks.length ? { key: 'list', html: `<section class="section" ${attrs({ list: isSmart(v) ? undefined : v })}>${LIST_SLOT}</section>`, rows: rowsOf(tasks, ctx) } : { key: 'empty', html: empty });
    blocks.push(...doneBlocks(v, ctx));
  }
  // The composer may live inside a day of Upcoming. It stays there when that day is unchanged; a day that
  // is rebuilt gets it back after (with its focus and caret).
  const typing = composerEl.contains(document.activeElement) ? document.activeElement : null;
  const caret = typing && typeof typing.selectionStart === 'number' ? [typing.selectionStart, typing.selectionEnd] : null;
  const focus = captureBodyFocus();
  const host = composerEl.closest('.section[data-key]');
  if (bodyEl.contains(composerEl) && !blocks.some((b) => b.key === host?.dataset.key && builtFrom.get(host) === b.html)) slotEl.append(composerEl);
  patchBody(blocks);
  bodyView = viewKey();
  placeComposer();
  if (typing && document.contains(typing) && document.activeElement !== typing) {
    typing.focus({ preventScroll: true });
    if (caret) typing.setSelectionRange(caret[0], caret[1]);
  }
  restoreBodyFocus(focus);
}

// Upcoming lists two weeks of days from state.upStart, under a strip of seven. The strip follows the list:
// it shows the week of the day scrolled to (state.upFocus), marks that day and names its month.
const UP_SPAN = 14;
const upDates = () => new Set(db.all('tasks').flatMap((t) => (!t.done && isYmd(t.date) ? [t.date] : [])));
/** The day the strip marks: the one scrolled to, if it is still in the list, else the list's first day. */
function upFocusDay(start = state.upStart) {
  const f = state.upFocus;
  return f && start && f >= start && f <= addDaysYmd(start, UP_SPAN - 1) ? f : start;
}

function upBarInner(start, focus, dates = upDates()) {
  const today = todayYmd();
  const week = addDaysYmd(start, Math.floor(diffDays(start, focus) / 7) * 7);
  const month = fmt(parseYmd(focus), { month: 'long', year: 'numeric' });
  const days = Array.from({ length: 7 }, (_, i) => addDaysYmd(week, i));
  return `<div class="up-nav"><button type="button" class="up-month" data-up-pick aria-haspopup="dialog" aria-label="${esc(`${month}. Jump to a date`)}">${esc(month)}${icon('chevron-down', { size: 15 })}</button>
      <span class="grow"></span>
      <button type="button" class="icon-btn sm" data-up-step="-7" aria-label="Previous week" ${tipAttrs('Previous week')}${week <= today ? ' disabled' : ''}>${icon('chevron-left', { size: 18 })}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-up-today>Today</button>
      <button type="button" class="icon-btn sm" data-up-step="7" aria-label="Next week" ${tipAttrs('Next week')}>${icon('chevron-right', { size: 18 })}</button></div>
    <div class="up-days" role="group" aria-label="Week" data-week="${esc(week)}">${days
      .map((d) => {
        const dt = parseYmd(d);
        return `<button type="button" class="up-day${d === today ? ' today' : ''}${d === focus ? ' active' : ''}" data-up-jump="${esc(d)}"${d === today ? ' aria-current="date"' : ''} aria-label="${esc(`${dayLabel(d, { long: true })}${dates.has(d) ? ', has tasks' : ''}`)}"><span class="dow">${esc(fmt(dt, { weekday: 'short' }))}</span><span class="dnum">${esc(dt.getDate())}</span>${dates.has(d) ? '<i aria-hidden="true"></i>' : ''}</button>`;
      })
      .join('')}</div>`;
}

/** Mark `day` in the strip, turning the strip to its week (and keeping keyboard focus on the same control). */
function setUpFocus(day) {
  const bar = $('.up-bar', bodyEl);
  if (!bar || !state.upStart || !day) return;
  state.upFocus = day;
  const focus = upFocusDay();
  const week = addDaysYmd(state.upStart, Math.floor(diffDays(state.upStart, focus) / 7) * 7);
  if ($('.up-days', bar)?.dataset.week === week) {
    for (const b of $$('[data-up-jump]', bar)) b.classList.toggle('active', b.dataset.upJump === focus);
    const month = fmt(parseYmd(focus), { month: 'long', year: 'numeric' });
    const m = $('.up-month', bar);
    if (m && m.firstChild?.nodeType === 3 && m.firstChild.data !== month) {
      m.firstChild.data = month;
      m.setAttribute('aria-label', `${month}. Jump to a date`);
    }
    return;
  }
  const a = document.activeElement;
  const key = a && bar.contains(a) ? ['data-up-pick', 'data-up-today', 'data-up-step'].find((n) => a.hasAttribute(n)) : null;
  const keySel = key ? (key === 'data-up-step' ? `[data-up-step="${CSS.escape(a.dataset.upStep)}"]` : `[${key}]`) : null;
  const dayIndex = a && bar.contains(a) && a.dataset.upJump ? $$('[data-up-jump]', bar).indexOf(a) : -1;
  bar.innerHTML = upBarInner(state.upStart, focus);
  const back = keySel ? $(keySel, bar) : dayIndex >= 0 ? $$('[data-up-jump]', bar)[dayIndex] : null;
  back?.focus({ preventScroll: true });
}

// The day under the strip as the list scrolls (a jump from the strip keeps its day until it has landed).
let upJumping = 0;
let upSpyFrame = 0;
function upSpy() {
  upSpyFrame = 0;
  if (state.view !== 'upcoming' || upJumping) return;
  const bar = $('.up-bar', bodyEl);
  if (!bar) return;
  const line = bar.getBoundingClientRect().bottom + 12;
  let day = null;
  for (const s of $$('.section.day', bodyEl)) {
    if (s.getBoundingClientRect().top > line) break;
    day = s.dataset.date;
  }
  setUpFocus(day || state.upStart);
}
mainEl.addEventListener('scroll', () => upSpyFrame || (upSpyFrame = requestAnimationFrame(upSpy)), { passive: true });

/** Keep the strip's day while the list scrolls to it (until the scroll ends, or a second at most). */
function holdUpFocus() {
  clearTimeout(upJumping);
  const done = () => {
    clearTimeout(upJumping);
    upJumping = 0;
    mainEl.removeEventListener('scrollend', done);
  };
  upJumping = setTimeout(done, 1000);
  mainEl.addEventListener('scrollend', done, { once: true });
}
/** Scroll the list to `day` from the strip: the strip marks it at once and holds it while the list moves. */
function jumpToDay(day) {
  const head = document.getElementById(`day-${day}`);
  if (!head) return;
  setUpFocus(day);
  holdUpFocus();
  head.scrollIntoView({ behavior: smooth(), block: 'start' });
}

/** The first and last day of Upcoming's two weeks. */
function upWindow() {
  const today = todayYmd();
  const start = state.upStart && state.upStart >= today ? state.upStart : today;
  return { start, end: addDaysYmd(start, UP_SPAN - 1) };
}
/** The open dated tasks after `end`, in the order Upcoming lists them. */
const laterTasks = (open, end) => open.filter((t) => t.date > end).sort((a, b) => a.date.localeCompare(b.date) || byTimeThenOrder(a, b));

/** Is this task drawn in Upcoming as it stands: in its Overdue, its two weeks, or the later tasks shown? */
function upcomingShows(t) {
  const today = todayYmd();
  const { start, end } = upWindow();
  if (!t || t.done || !t.date) return false;
  if (t.date < start) return start === today;
  if (t.date <= end) return true;
  return laterTasks(db.all('tasks').filter((x) => !x.done && x.date), end).findIndex((x) => x.id === t.id) < state.upLimit;
}

function upcomingBlocks(ctx) {
  const today = todayYmd();
  if (!state.upStart || state.upStart < today) state.upStart = today;
  const { start, end } = upWindow();
  const all = db.all('tasks').filter((t) => !t.done && t.date);
  const blocks = [{ key: 'up-bar', html: `<div class="up-bar">${upBarInner(start, upFocusDay(start), new Set(all.map((t) => t.date)))}</div>` }];
  if (start === today) {
    const overdue = all.filter((t) => t.date < today).sort(byTimeThenOrder);
    if (overdue.length) blocks.push(overdueBlock(overdue, ctx));
  }
  // A day's composer goes when its day leaves the page (another week, a jump, midnight) instead of staying
  // open unseen, which on phones would also keep the floating + hidden.
  const host = state.composer?.host;
  if (host && host !== 'top' && (host < start || host > end)) resetComposer();
  const instances = instancesFor(start, end);
  const byDay = new Map();
  for (const t of all) if (t.date >= start && t.date <= end) byDay.has(t.date) ? byDay.get(t.date).push(t) : byDay.set(t.date, [t]);
  for (let i = 0; i < UP_SPAN; i++) {
    const d = addDaysYmd(start, i);
    const dayTasks = (byDay.get(d) || []).sort(byTimeThenOrder);
    blocks.push({
      key: `day:${d}`,
      html: `<section class="section day" ${attrs({ date: d })} aria-labelledby="${esc(`day-${d}`)}">
      ${sectionHead(`${dayHead(d)}${dayTasks.length ? COUNT_SLOT : ''}`, `day-${d}`)}
      ${eventsFor(d, instances)}
      ${dayTasks.length ? LIST_SLOT : ''}
      <div data-composer-host="${esc(d)}">${state.composer?.host === d ? '' : `<button type="button" class="add-row inline" data-add-on="${esc(d)}"><span class="plus">${icon('plus', { size: 15, stroke: 2.4 })}</span><span>Add task</span></button>`}</div>
    </section>`,
      ...(dayTasks.length ? { rows: rowsOf(dayTasks, { ...ctx, hideDateFor: d }), count: dayTasks.length } : {}),
    });
  }
  // After the two weeks come the later months, which can run to thousands of tasks: the first of them are
  // drawn, and more on request ("Show later"). A task opened from elsewhere (search, a link, a toast's View)
  // or open in the details pane is always drawn, with those before it.
  const later = laterTasks(all, end);
  for (const id of [state.reveal, state.open, state.sel]) {
    const i = id ? later.findIndex((t) => t.id === id) : -1;
    if (i >= state.upLimit) state.upLimit = i + 1;
  }
  const groups = new Map();
  later.forEach((t, i) => {
    const dt = parseYmd(t.date);
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    if (!groups.has(key)) groups.set(key, { key, label: fmt(dt, dt.getFullYear() === new Date().getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' }), total: 0, tasks: [] });
    const g = groups.get(key);
    g.total++;
    if (i < state.upLimit) g.tasks.push(t);
  });
  // A month's header counts all its tasks, also while only its first ones are drawn.
  for (const g of groups.values()) if (g.tasks.length) blocks.push({ key: `month:${g.key}`, html: `<section class="section">${sectionHead(`<span>${esc(g.label)}</span>${COUNT_SLOT}`)}${LIST_SLOT}</section>`, rows: rowsOf(g.tasks, ctx), count: g.total });
  if (later.length > state.upLimit) blocks.push({ key: 'more', html: '<button type="button" class="btn btn-secondary btn-sm show-more" data-more-later>Show later</button>' });
  return blocks;
}

// Changes made here draw at once (in the store's microtask, before the next frame). Changes from elsewhere
// (the server, another tab, an assistant) can arrive several to a frame: they draw once, in the next frame.
let drawQueued = false;
function queueRender() {
  if (drawQueued) return;
  drawQueued = true;
  const run = () => drawQueued && render();
  requestAnimationFrame(run);
  setTimeout(run, 250); // a hidden tab gets no frames
}

function render() {
  drawQueued = false;
  const counts = navCounts();
  renderNav(counts);
  renderHead(counts);
  renderBody();
  renderTabbar();
  syncNav();
  if (state.composer) renderComposer();
  else cTitle.placeholder = composerPlaceholder();
  if (state.open) renderInspector();
}

db.on(({ names, remote }) => {
  if (names.has('tasks')) tasksRev++;
  if (names.has('events') || names.has('calendars')) eventsRev++;
  if (['tasks', 'lists', 'events', 'calendars', 'settings'].some((n) => names.has(n))) remote ? queueRender() : render();
  else if (names.has('notes') && state.open) renderInspector(); // its "From note" and "Mentioned in" rows
});
window.addEventListener('hashchange', route);

// Each minute: past / now on today's events, and a full refresh when the day changes.
let lastDay = todayYmd();
setInterval(() => {
  if (todayYmd() !== lastDay) {
    lastDay = todayYmd();
    return render();
  }
  const now = Date.now();
  for (const r of $$('.event-row[data-start]', bodyEl)) {
    r.classList.toggle('past', +r.dataset.end <= now);
    r.classList.toggle('now', +r.dataset.start <= now && +r.dataset.end > now);
  }
}, 60000);

// ---------------------------------------------------------------- actions

/** A row on its way out folds up (fading as it goes), so the rows below glide up instead of jumping. */
function foldRow(r) {
  r.style.height = `${r.offsetHeight}px`;
  void r.offsetHeight; // start the fold from the measured height
  r.classList.add('leaving', 'gone');
  r.style.height = '';
}

/**
 * Where an open task's row sits in this view, as renderBody groups it: in Today overdue or today, in Upcoming
 * the overdue section, a day or a later month, else the list itself; null when the view doesn't show it.
 */
function rowGroup(t) {
  const today = todayYmd();
  if (state.view === 'today') return isToday(t, today) ? ((t.date ? t.date < today : t.deadline < today) ? 'overdue' : 'today') : null;
  if (state.view === 'upcoming') {
    const start = state.upStart || today;
    if (!t.date) return null;
    if (t.date < start) return start === today && t.date < today ? 'overdue' : null;
    return t.date <= addDaysYmd(start, UP_SPAN - 1) ? t.date : t.date.slice(0, 7);
  }
  return 'list';
}

/** Does a repeating task's row stay put once it is completed and moves on to its next date? */
function repeatStays(t) {
  if (!t.repeat) return false;
  const group = rowGroup(t);
  return group !== null && group === rowGroup({ ...t, ...nextRepeatDates(t, todayYmd()) });
}

function complete(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const name = untitled(t);
  if (t.done) {
    const undo = toggleTask(id);
    undoable('Task restored', undo, `marking “${name}” as not done`);
    return;
  }
  if (pending.has(id)) {
    pending.delete(id);
    leaving.delete(id);
    return renderBody();
  }
  pending.add(id);
  playDing();
  const row = rowEl(id);
  if (row) {
    const chk = $('.check', row);
    chk.setAttribute('aria-checked', 'true');
    chk.classList.add('pop');
    row.classList.add('completing');
    builtFrom.delete(row); // changed here, not from its html: a redraw (a second click undoing it) rebuilds it
  }
  // A repeating task moves on to its next date: in a list its row stays (and only fades for a moment), but in
  // Today and Upcoming, which group by day, it leaves its place, so it folds away like any other.
  let stays = false;
  setTimeout(() => {
    const r = rowEl(id);
    if (!pending.has(id)) return;
    stays = repeatStays(db.get('tasks', id) || t);
    if (!stays) leaving.add(id);
    if (!r) return;
    builtFrom.delete(r);
    if (stays) r.classList.add('leaving');
    else foldRow(r);
  }, 450);
  setTimeout(() => {
    if (!pending.has(id)) return;
    pending.delete(id);
    leaving.delete(id);
    const undo = toggleTask(id);
    if (state.sel === id && !stays) state.sel = null;
    const next = db.get('tasks', id);
    undoable(t.repeat ? `Done. Next one ${relLower(next?.date || next?.deadline || todayYmd())}` : '1 task completed', undo, `completing “${name}”`);
  }, 720);
}

function toggleStar(id) {
  const t = db.get('tasks', id);
  if (!t || t.done) return;
  update(id, { priority: prio(t.priority) === 3 ? 0 : 3 });
}

const visibleIds = () => $$('.task[data-id]', bodyEl).map((r) => r.dataset.id);

function select(id, { scroll = true } = {}) {
  state.sel = id;
  $$('.task.sel', bodyEl).forEach((r) => r.classList.remove('sel'));
  const row = rowEl(id);
  if (row) {
    row.classList.add('sel');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }
  if (state.open && id && state.open !== id) openInspector(id);
}

const ROW_CONTROLS = ['[data-check]', '[data-open]', '[data-row-date]', '[data-row-more]', '[data-star]'];
function moveSel(dir) {
  const ids = visibleIds();
  if (!ids.length) return;
  const i = ids.indexOf(state.sel);
  const next = ids[i < 0 ? (dir > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + dir))];
  // Arrow keys on a row's button move to the same button on the next row (one list, like a grid).
  const a = document.activeElement;
  const ctl = a && bodyEl.contains(a) && a.closest('.task[data-id]') ? ROW_CONTROLS.find((s) => a.matches(s)) : null;
  select(next);
  if (ctl) (rowEl(next)?.querySelector(ctl) || rowEl(next)?.querySelector('[data-check]'))?.focus({ preventScroll: true });
}

function useManualOrder() {
  if (sortMode() !== 'manual') setSort('manual');
}

function reorderSel(dir) {
  const row = rowEl(state.sel);
  const sib = row && (dir < 0 ? row.previousElementSibling : row.nextElementSibling);
  if (!sib?.dataset.id) return;
  const a = db.get('tasks', state.sel);
  const b = db.get('tasks', sib.dataset.id);
  if (!a || !b) return;
  db.batch(() => {
    db.update('tasks', a.id, { order: b.order });
    db.update('tasks', b.id, { order: a.order });
  });
  useManualOrder();
  // Say where it went, once the list is redrawn (the store's change notice comes before the next frame).
  requestAnimationFrame(() => {
    const moved = rowEl(a.id);
    const rows = moved ? [...moved.parentElement.children].filter((r) => r.matches('.task[data-id]')) : [];
    if (rows.length) announce(`Moved to position ${rows.indexOf(moved) + 1} of ${rows.length}`);
  });
}

function setDate(id, date) {
  const t = db.get('tasks', id);
  if (!t) return;
  if (date) update(id, { date, time: t.time }, `Scheduled for ${relLower(date)}`, (n) => `scheduling ${n} for ${relLower(date)}`);
  else update(id, { date: null, time: null }, 'Date removed', (n) => `removing the date from ${n}`);
}

function shiftDate(id, days) {
  const t = db.get('tasks', id);
  if (!t) return;
  setDate(id, addDaysYmd(t.date || todayYmd(), t.date ? days : Math.max(0, days)));
}

/**
 * The date menu, with a time row (Todoist): a day picked keeps the task's time (setDate); a time picked,
 * typed ("fri 3pm") or cleared changes it with the day.
 */
function pickDate(anchor, id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const time = timeOf(t);
  openDatePicker(anchor, {
    value: t.date,
    withTime: true,
    time,
    title: 'Date',
    onPick: ({ date, time: next }) => {
      if (!date || next === time) return setDate(id, date);
      if (!next) return update(id, { time: null }, 'Time removed', (n) => `removing the time from ${n}`);
      const when = `${relLower(date)}, ${fmtClock(next)}`;
      update(id, { date, time: next }, `Scheduled for ${when}`, (n) => `scheduling ${n} for ${when}`);
    },
  });
}

function priorityMenu(anchor, id) {
  const t = db.get('tasks', id);
  if (!t) return;
  openMenu(anchor, PRIORITIES.map((p) => ({ label: p.label, iconHtml: flagIcon(p.value), checked: prio(t.priority) === p.value, keys: String(4 - p.value), onSelect: () => update(id, { priority: p.value }) })), { label: 'Priority' });
}

function duplicate(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const copy = createTask({ ...structuredClone(t), checklist: (t.checklist || []).map((c) => ({ ...c, id: uid(), done: false })), order: (t.order ?? 0) + 0.001 });
  select(copy.id);
  undoable('Task duplicated', () => revertChange('tasks', null, copy), `duplicating “${untitled(t)}”`);
}

function remove(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const ids = visibleIds();
  const next = ids[ids.indexOf(id) + 1] || ids[ids.indexOf(id) - 1] || null;
  const hadFocus = inspEl.contains(document.activeElement) || !!rowEl(id)?.contains(document.activeElement);
  const undo = deleteTask(id);
  if (state.open === id) closeInspector();
  state.sel = next;
  render();
  if (hadFocus) rowEl(next)?.querySelector('[data-check]')?.focus({ preventScroll: true });
  undoable(`Deleted “${untitled(t)}”`, undo, `deleting “${untitled(t)}”`);
}

function moveToListMenu(anchor, id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const live = t.listId && db.get('lists', t.listId) ? t.listId : null;
  openMenu(
    anchor,
    [
      { heading: 'Move to' },
      { label: 'Inbox', icon: 'inbox', checked: !live, onSelect: () => update(id, { listId: null }, 'Moved to Inbox', (n) => `moving ${n} to Inbox`) },
      ...listsSorted().map((l) => ({ label: l.name, iconHtml: dotHtml(l.color), checked: live === l.id, onSelect: () => update(id, { listId: l.id }, `Moved to ${l.name}`, (n) => `moving ${n} to ${l.name}`) })),
      { sep: true },
      { label: 'New list…', icon: 'plus', onSelect: () => editListDialog(null, (l) => update(id, { listId: l.id })) },
    ],
    { label: 'Move to list' },
  );
}

/** A task's actions: the row's … button and right click, and the details pane's … (`inPane`: already open there). */
function rowMenu(anchor, id, { inPane = false } = {}) {
  const t = db.get('tasks', id);
  if (!t) return;
  const today = todayYmd();
  const p = prio(t.priority);
  const src = noteSource(t);
  openMenu(
    anchor,
    [
      !inPane && { label: 'Open details', icon: 'edit', keys: 'enter', onSelect: () => openInspector(id, { focus: true }) },
      { label: t.done ? 'Mark as not done' : 'Complete', icon: 'done', keys: 'e', onSelect: () => complete(id) },
      !t.done && { label: p === 3 ? 'Remove importance' : 'Mark as important', icon: p === 3 ? 'star-fill' : 'star', keys: 's', onSelect: () => toggleStar(id) },
      { sep: true },
      { label: t.date === today ? 'Remove from Today' : 'Add to Today', iconHtml: todayGlyph(18), keys: 't', onSelect: () => setDate(id, t.date === today ? null : today) },
      { label: 'Tomorrow', icon: 'tomorrow', onSelect: () => setDate(id, addDaysYmd(today, 1)) },
      { label: 'Pick a date…', icon: 'calendar', keys: 'r', onSelect: () => pickDate(anchor, id) },
      { label: 'Priority…', icon: 'flag', hint: rangeHint('1', '4'), onSelect: () => priorityMenu(anchor, id) },
      { label: 'Move to list…', icon: 'list', keys: 'v', onSelect: () => moveToListMenu(anchor, id) },
      { sep: true },
      src && !src.missing && { label: 'Open source note', icon: 'note', onSelect: () => (location.href = src.href) },
      { label: 'Plan in schedule', icon: 'calendar-plus', onSelect: () => (location.href = scheduleHref(t)) },
      { label: 'Duplicate', icon: 'copy', keys: 'd', onSelect: () => duplicate(id) },
      { label: 'Delete', icon: 'trash', danger: true, keys: 'backspace', onSelect: () => remove(id) },
    ],
    { label: 'Task actions' },
  );
}

function rescheduleOverdue(anchor) {
  const today = todayYmd();
  const overdue = db.all('tasks').filter((t) => !t.done && ((t.date && t.date < today) || (!t.date && t.deadline && t.deadline < today)));
  if (!overdue.length) return;
  const apply = (date) => {
    // Read again at the pick: the menu may have stayed open while a task changed elsewhere.
    const before = structuredClone(overdue.map((t) => db.get('tasks', t.id)).filter(Boolean));
    if (!before.length) return;
    const after = structuredClone(db.batch(() => before.map((t) => db.update('tasks', t.id, { date }))));
    const n = `${before.length} ${before.length === 1 ? 'task' : 'tasks'}`;
    // Each task gets back only its old date: a task edited or done since keeps that.
    undoable(`${n} rescheduled`, () => db.batch(() => before.forEach((b, i) => after[i] && revertChange('tasks', b, after[i]))), `rescheduling ${n}`);
  };
  openMenu(
    anchor,
    [
      { heading: `Move ${overdue.length} overdue to` },
      { label: 'Today', iconHtml: todayGlyph(18), onSelect: () => apply(today) },
      { label: 'Tomorrow', icon: 'tomorrow', onSelect: () => apply(addDaysYmd(today, 1)) },
      { label: 'Pick a date…', icon: 'calendar', onSelect: () => openDatePicker(anchor, { title: 'Reschedule to', allowClear: false, onPick: ({ date }) => date && apply(date) }) },
    ],
    { align: 'end', label: 'Reschedule overdue tasks' },
  );
}

// Microsoft To Do's "Suggestions" for planning the day.
function openSuggestions(anchor) {
  const today = todayYmd();
  const content = () => {
    const lists = listMap();
    const open = db.all('tasks').filter((t) => !t.done && !(t.date && t.date <= today));
    const groups = [
      { title: 'Coming up', items: open.filter((t) => t.date && diffDays(today, t.date) <= 7).sort((a, b) => a.date.localeCompare(b.date)) },
      { title: 'Important', items: open.filter((t) => t.priority === 3 && !(t.date && diffDays(today, t.date) <= 7)) },
      { title: 'No date yet', items: open.filter((t) => !t.date && t.priority !== 3).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) },
    ].filter((g) => g.items.length);
    if (!groups.length) return `<div class="sugg-head">${icon('bulb')}<strong>Suggestions</strong></div><div class="sugg-empty">You’re all caught up. Nothing else to suggest.</div>`;
    return `<div class="sugg-head">${icon('bulb')}<strong>Suggestions for today</strong></div>${groups
      .map(
        (g) =>
          `<div class="menu-label">${esc(g.title)}</div>` +
          g.items
            .slice(0, 5)
            .map((t) => {
              const sub = [t.date ? relDate(t.date) : '', lists.get(t.listId)?.name || 'Inbox'].filter(Boolean).join(', ');
              return `<div class="sugg-row"><div class="t"><div>${esc(untitled(t))}</div><div>${esc(sub)}</div></div><button type="button" class="add" data-sugg-add="${esc(t.id)}" aria-label="${esc(`Add “${untitled(t)}” to Today`)}" ${tipAttrs('Add to Today')}>${icon('plus', { size: 16, stroke: 2.4 })}</button></div>`;
            })
            .join(''),
      )
      .join('')}`;
  };
  openPopover(anchor, content(), {
    className: 'sugg',
    align: 'end',
    label: 'Suggestions',
    onMount: (el) => {
      // A list taller than the card fades out at its foot, so a row cut off there reads as "scroll for more".
      const fade = () => el.classList.toggle('more', el.scrollHeight - el.clientHeight - el.scrollTop > 2);
      el.addEventListener('scroll', fade, { passive: true });
      requestAnimationFrame(fade);
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-sugg-add]');
        if (!b) return;
        const id = b.dataset.suggAdd;
        const all = $$('[data-sugg-add]', el);
        const at = all.indexOf(b);
        update(id, { date: today }, 'Added to Today', (n) => `adding ${n} to Today`);
        el.innerHTML = content();
        fade();
        const rest = $$('[data-sugg-add]', el);
        (rest[Math.min(at, rest.length - 1)] || el).focus?.({ preventScroll: true });
      });
    },
  });
}

function sortMenu(anchor) {
  const mode = sortMode();
  openMenu(anchor, [{ heading: 'Sort by' }, ...Object.entries(SORTS).map(([id, s]) => ({ label: s.label, checked: mode === id, onSelect: () => setSort(id) }))], { align: 'end', label: 'Sort by' });
}

function viewMenu(anchor) {
  const list = currentList();
  const items = [];
  if (list) items.push({ label: 'Rename or recolour…', icon: 'edit', onSelect: () => editListDialog(list) }, { label: 'Delete list…', icon: 'trash', danger: true, onSelect: () => deleteList(list) }, { sep: true });
  if (state.view === 'tag' && state.tag) items.push(...labelItems(state.tag), { sep: true });
  if (state.view === 'completed' && tasksIn('completed').length)
    items.push(
      {
        label: 'Clear completed…',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const done = tasksIn('completed');
          const ok = await choiceDialog({ title: 'Clear completed tasks?', message: `${done.length} completed ${done.length === 1 ? 'task' : 'tasks'} will be deleted.`, choices: [{ label: 'Clear completed', value: true, tone: 'danger' }] });
          if (!ok) return;
          // The tasks the dialog counted, if still done (it may have stayed open while things changed elsewhere).
          const gone = structuredClone(db.batch(() => done.filter((t) => db.get('tasks', t.id)?.done).map((t) => db.remove('tasks', t.id)).filter(Boolean)));
          // The undo puts each back unless it was re-created (or restored) since.
          undoable('Completed tasks cleared', () => db.batch(() => gone.forEach((t) => revertChange('tasks', t, null))), 'clearing completed tasks');
        },
      },
      { sep: true },
    );
  if (sortable()) {
    const key = viewKey();
    const shown = state.showDone.has(key);
    items.push(
      { label: 'Sort by…', icon: 'sort', onSelect: () => sortMenu(anchor) },
      { label: shown ? 'Hide completed' : 'Show completed', icon: shown ? 'eye-off' : 'eye', onSelect: () => (shown ? state.showDone.delete(key) : state.showDone.add(key), renderBody()) },
      { sep: true },
    );
  }
  items.push(
    { label: 'New list…', icon: 'plus', onSelect: () => editListDialog(null, (l) => go(l.id)) },
    { label: 'Open schedule', icon: 'calendar', onSelect: () => (location.href = '../schedule/') },
    // The same key spec as the shell's own Settings item, so both menus show it alike.
    { label: 'Settings', icon: 'gear', keys: 'comma', onSelect: () => openSettings() },
  );
  openMenu(anchor, items, { align: 'end', label: 'More options' });
}

// ---------------------------------------------------------------- keyboard

let chord = null;
let chordTimer = 0;
document.addEventListener('keydown', (e) => {
  // Mod+\ hides or shows the sidebar (opens the drawer when narrow), as in Notes; also while typing.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'Backslash' && !e.defaultPrevented && !hasOpenLayer()) {
    e.preventDefault();
    return toggleSidebar();
  }
  // Single-key shortcuts can be turned off (Settings > Keyboard): then only Esc, Enter, arrows and Delete act.
  if (e.defaultPrevented || hasOpenLayer() || isTyping(e) || e.metaKey || e.ctrlKey || singleKeyOff(e)) return;
  // The drawer is modal: Esc closes it, and the list's keys wait until it has closed.
  if (drawer) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawer();
    }
    return;
  }
  const k = e.key;
  const target = e.target instanceof Element ? e.target : null;
  // The details pane and the open composer keep their keys: a stray "d" or Backspace on one of their
  // buttons (a composer chip, the pane's star) must not reach the task selected in the list. Escape in the
  // pane closes it; the composer handles its own Escape.
  if (target && (inspEl.contains(target) || cForm.contains(target))) {
    if (k === 'Escape' && state.open && inspEl.contains(target)) {
      e.preventDefault();
      closeInspector({ restoreFocus: true });
    }
    return;
  }
  const onControl = !!target?.closest('button, a[href], [role="button"], [role="checkbox"], [role="radio"]');
  const inList = !!target && bodyEl.contains(target);
  // Keys that delete or open menus act from the list (or with nothing focused), never from a sidebar link
  // or a header button, where Backspace would otherwise delete a task the user isn't looking at.
  const listKeys = !onControl || inList;
  if (e.altKey) {
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      reorderSel(k === 'ArrowUp' ? -1 : 1);
    }
    return;
  }
  if (chord === 'g') {
    chord = null;
    clearTimeout(chordTimer);
    const dest = { i: 'inbox', t: 'today', u: 'upcoming', s: 'important', c: 'completed' }[k.toLowerCase()];
    if (dest) {
      e.preventDefault();
      go(dest);
    }
    return;
  }
  // A row's circle is a checkbox: Space toggles it (natively), while Enter opens the task, as the row menu
  // and the shortcuts sheet say. Tab into the list lands on the circle, so Enter must not complete.
  const checkRow = k === 'Enter' && !e.shiftKey && inList && target.matches('[data-check]') ? target.closest('.task[data-id]') : null;
  if (checkRow) {
    e.preventDefault(); // also stops the button's own click
    select(checkRow.dataset.id, { scroll: false });
    return openInspector(checkRow.dataset.id, { focus: true });
  }
  // Shortcuts act on the selected row only while it's on screen: a selection left behind in another view
  // (or under a collapsed "Completed") is not something the user can see they are about to change.
  const sel = state.sel && db.get('tasks', state.sel) && rowEl(state.sel) ? state.sel : null;
  const anchor = () => (sel && rowEl(sel)?.querySelector('[data-row-date]')) || rowEl(sel) || composerEl;
  const rowMenuKey = () => rowMenu(rowEl(sel)?.querySelector('[data-row-more]') || anchor(), sel);
  const map = {
    q: () => openComposer('top'),
    a: () => openComposer('top'),
    n: () => openComposer('top'),
    '/': () => openPalette(),
    g: () => {
      chord = 'g';
      clearTimeout(chordTimer);
      chordTimer = setTimeout(() => (chord = null), 1200);
    },
    j: () => moveSel(1),
    k: () => moveSel(-1),
    // Arrows move through the list only when nothing else (the sidebar, a header button) has focus.
    ...(listKeys ? { ArrowDown: () => moveSel(1), ArrowUp: () => moveSel(-1) } : {}),
    Escape: () => (state.open ? closeInspector({ restoreFocus: true }) : select(null)),
  };
  if (sel)
    Object.assign(map, {
      // Enter and Space on a focused button press that button; Enter opens details only from the list itself.
      ...(onControl ? {} : { Enter: () => openInspector(sel, { focus: true }) }),
      e: () => complete(sel),
      x: () => complete(sel),
      s: () => toggleStar(sel),
      t: () => setDate(sel, db.get('tasks', sel).date === todayYmd() ? null : todayYmd()),
      r: () => pickDate(anchor(), sel),
      '[': () => shiftDate(sel, -1),
      ']': () => shiftDate(sel, 1),
      1: () => update(sel, { priority: 3 }),
      2: () => update(sel, { priority: 2 }),
      3: () => update(sel, { priority: 1 }),
      4: () => update(sel, { priority: 0 }),
      v: () => moveToListMenu(anchor(), sel),
      l: () => moveToListMenu(anchor(), sel),
      d: () => duplicate(sel),
      ...(listKeys ? { Delete: () => remove(sel), Backspace: () => remove(sel), ContextMenu: rowMenuKey, ...(e.shiftKey ? { F10: rowMenuKey } : {}) } : {}),
    });
  const fn = Object.hasOwn(map, k) ? map[k] : null;
  if (fn) {
    e.preventDefault();
    fn();
  }
});

registerShortcuts([
  {
    title: 'Go to',
    items: [
      ['Inbox', 'g i'],
      ['Today', 'g t'],
      ['Upcoming', 'g u'],
      ['Important', 'g s'],
      ['Completed', 'g c'],
      ['Next or previous task', 'j / k'],
      ['Search', '/'],
      ['Sidebar', 'mod \\'],
    ],
  },
  {
    title: 'Tasks',
    items: [
      ['Add task', 'q / a'],
      ['Open details', 'enter'],
      ['Complete', 'e / x'],
      ['Important', 's'],
      ['Today on or off', 't'],
      ['Pick a date', 'r'],
      ['A day earlier or later', '[ / ]'],
      ['Priority 1 to 4', '1 / 2 / 3 / 4'],
      ['Move to list', 'v'],
      ['Duplicate', 'd'],
      ['Reorder', 'alt up / alt down'],
      ['Delete', 'backspace'],
    ],
  },
  {
    title: 'Quick add',
    examples: true,
    items: [
      ['Date and time', 'tomorrow 6pm'],
      ['Day or date', 'fri, dec 5'],
      ['Length', 'for 30m'],
      ['Repeat', 'every weekday'],
      ['Deadline', 'by friday'],
      ['List', '#Work'],
      ['Label', '@phone'],
      ['Priority', 'p1'],
    ],
  },
]);

// ---------------------------------------------------------------- pointer

mainEl.addEventListener('scroll', () => topbar.classList.toggle('scrolled', mainEl.scrollTop > 40), { passive: true });

let pointerAt = 0;
document.addEventListener('pointerdown', () => (pointerAt = Date.now()), true);

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-add-task]')) {
    closeDrawer({ restoreFocus: false });
    return openComposer('top');
  }
  if (t.closest('[data-toggle-nav]')) return toggleSidebar(t.closest('[data-toggle-nav]'));
  if (t.closest('[data-close-nav]')) return closeDrawer();
  if (t.closest('[data-close-insp]')) return closeInspector({ restoreFocus: true });
  if (t.closest('[data-add-list]')) return editListDialog(null, (l) => go(l.id));
  if (t.closest('.nav-item')) closeDrawer();
  if (t.closest('[data-suggestions]')) return openSuggestions(t.closest('[data-suggestions]'));
  if (t.closest('[data-sort-reset]')) return setSort('manual');
  if (t.closest('[data-sort]')) return sortMenu(t.closest('[data-sort]'));
  if (t.closest('[data-view-menu]')) return viewMenu(t.closest('[data-view-menu]'));
});

// Keyboard focus on a row's button selects that row, so the single-key shortcuts act on it.
bodyEl.addEventListener('focusin', (e) => {
  const row = e.target.closest?.('.task[data-id]');
  if (!row || state.sel === row.dataset.id || Date.now() - pointerAt < 300) return;
  select(row.dataset.id, { scroll: false });
});

/**
 * "Show older" (Completed) and "Show later" (Upcoming's later months) draw 200 more rows. The button keeps
 * the focus while there is more; once everything is drawn, focus goes on to the first row it brought in.
 */
function showMore(btn) {
  const had = btn.contains(document.activeElement);
  const first = visibleIds().length;
  if (btn.hasAttribute('data-more-later')) state.upLimit += MORE_STEP;
  else state.doneLimit += MORE_STEP;
  renderBody();
  if (had && !bodyEl.contains(document.activeElement)) rowEl(visibleIds()[first])?.querySelector('[data-check]')?.focus({ preventScroll: true });
}

bodyEl.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-toggle-done]')) {
    const key = viewKey();
    state.showDone.has(key) ? state.showDone.delete(key) : state.showDone.add(key);
    return renderBody();
  }
  const more = t.closest('[data-more-done], [data-more-later]');
  if (more) return showMore(more);
  if (t.closest('[data-reschedule]')) return rescheduleOverdue(t.closest('[data-reschedule]'));
  const addOn = t.closest('[data-add-on]');
  if (addOn) return isYmd(addOn.dataset.addOn) && openComposer(addOn.dataset.addOn);
  // A new week starts the list over at its top (scrolled there before it is drawn), with its later months
  // drawn from their first tasks again. The arrows step from the week the strip shows.
  const showWeek = (start) => {
    state.upStart = start < todayYmd() ? todayYmd() : start;
    state.upFocus = null;
    state.upLimit = LATER_FIRST;
    mainEl.scrollTo({ top: 0 });
    renderBody();
  };
  const step = t.closest('[data-up-step]');
  if (step) return showWeek(addDaysYmd($('.up-days', bodyEl)?.dataset.week || state.upStart || todayYmd(), +step.dataset.upStep === -7 ? -7 : 7));
  if (t.closest('[data-up-today]')) {
    if (state.upStart !== todayYmd()) return showWeek(todayYmd());
    setUpFocus(todayYmd());
    holdUpFocus();
    return mainEl.scrollTo({ top: 0, behavior: smooth() });
  }
  const jump = t.closest('[data-up-jump]');
  if (jump) return isYmd(jump.dataset.upJump) && jumpToDay(jump.dataset.upJump);
  const pick = t.closest('[data-up-pick]');
  if (pick)
    return openDatePicker(pick, {
      value: upFocusDay(),
      title: 'Jump to',
      allowClear: false,
      onPick: ({ date }) => date && showWeek(date),
    });
  const row = t.closest('.task[data-id]');
  if (!row || Date.now() - swipeEndedAt < 400) return; // the click a short swipe can end with
  const id = row.dataset.id;
  if (t.closest('[data-check]')) return complete(id);
  if (t.closest('[data-star]')) return toggleStar(id);
  if (t.closest('[data-row-date]')) {
    select(id, { scroll: false });
    return pickDate(t.closest('[data-row-date]'), id);
  }
  if (t.closest('[data-row-more]')) {
    select(id, { scroll: false });
    return rowMenu(t.closest('[data-row-more]'), id);
  }
  select(id, { scroll: false });
  // The name is a button: pressed from the keyboard (no pointer, detail 0), the details open with focus in them.
  openInspector(id, { focus: !!t.closest('[data-open]') && e.detail === 0 });
});

bodyEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.task[data-id]');
  if (!row) return;
  e.preventDefault();
  select(row.dataset.id, { scroll: false });
  rowMenu({ x: e.clientX, y: e.clientY }, row.dataset.id);
});

// Swipe right to complete, left to pick a date (touch). A swipe starts anywhere on the row but its small
// buttons (circle, date, …, star): the name is a button too, and most of the row. A tap on the name still
// opens the task, while a swipe, even a short one that the browser could take for a tap, opens nothing.
let swipe = null;
let swipeEndedAt = 0;
bodyEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const row = e.target.closest('.task[data-id]');
  const btn = e.target.closest('button');
  if (!row || (btn && !btn.matches('.task-title'))) return;
  swipe = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, active: false, bg: null };
});
bodyEl.addEventListener('pointermove', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  if (!swipe.active) {
    if (Math.abs(e.clientY - swipe.y) > 10) return void (swipe = null);
    if (Math.abs(dx) < 12) return;
    swipe.active = true;
    const bg = document.createElement('div');
    bg.setAttribute('aria-hidden', 'true');
    bg.setAttribute('role', 'presentation');
    swipe.row.parentElement.style.position = 'relative';
    bg.style.cssText = `top:${swipe.row.offsetTop}px;height:${swipe.row.offsetHeight}px;left:0;right:0;`;
    swipe.row.before(bg);
    swipe.bg = bg;
    swipe.row.classList.add('swiping');
  }
  swipe.dx = dx;
  swipe.bg.className = `swipe-bg ${dx > 0 ? 'right' : 'left'}`;
  swipe.bg.innerHTML = dx > 0 ? icon('check', { stroke: 3 }) : icon('calendar');
  swipe.row.style.transform = `translateX(${dx}px)`;
});
const endSwipe = () => {
  if (!swipe) return;
  const { row, bg, dx, id, active } = swipe;
  swipe = null;
  if (!active) return;
  swipeEndedAt = Date.now();
  row.style.transition = 'transform 260ms var(--ease-out)';
  row.style.transform = '';
  setTimeout(() => {
    bg?.remove();
    row.classList.remove('swiping');
    row.style.transition = '';
  }, 260);
  if (dx > 90) complete(id);
  else if (dx < -90) pickDate(row, id);
};
bodyEl.addEventListener('pointerup', endSwipe);
bodyEl.addEventListener('pointercancel', endSwipe);

// ---------------------------------------------------------------- drag & drop

let dragId = null;
const clearDropMarks = () => $$('.drop-before, .drop-after, .drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));

/** The drag preview: a small pill with the task's ring and title (instead of a browser snapshot). */
function dragChip(t) {
  const el = document.createElement('div');
  el.className = 'drag-chip';
  el.innerHTML = `<span class="check p${prio(t.priority)}" aria-hidden="true"></span><span class="truncate">${esc(untitled(t))}</span>`;
  document.body.append(el);
  setTimeout(() => el.remove(), 0);
  return el;
}

document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.task[data-id]');
  if (!row) return;
  const t = db.get('tasks', row.dataset.id);
  if (!t) return;
  dragId = t.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/x-ecosys-task', dragId);
  e.dataTransfer.setData('text/plain', untitled(t));
  try {
    e.dataTransfer.setDragImage(dragChip(t), 16, 18);
  } catch {
    /* the default preview is fine */
  }
  requestAnimationFrame(() => row.classList.add('dragging'));
});
document.addEventListener('dragend', () => {
  $$('.dragging').forEach((r) => r.classList.remove('dragging'));
  clearDropMarks();
  dragId = null;
});
document.addEventListener('dragover', (e) => {
  if (!dragId) return;
  clearDropMarks();
  const accept = () => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const nav = e.target.closest?.('.nav-item[data-drop]');
  if (nav) {
    accept();
    return nav.classList.add('drop-target');
  }
  const row = e.target.closest?.('.task[data-id]');
  if (row && row.dataset.id !== dragId && bodyEl.contains(row)) {
    accept();
    const r = row.getBoundingClientRect();
    return row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  }
  const section = e.target.closest?.('.section[data-date], .section[data-list]');
  if (section) {
    accept();
    section.classList.add('drop-target');
  }
});
document.addEventListener('drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const id = dragId;
  const t = db.get('tasks', id);
  clearDropMarks();
  if (!t) return;
  const nav = e.target.closest?.('.nav-item[data-drop]');
  if (nav) {
    const target = nav.dataset.drop;
    const today = todayYmd();
    if (target === 'completed') return complete(id);
    if (target.startsWith('tag:')) {
      const g = target.slice(4);
      if (!(t.tags || []).includes(g)) update(id, { tags: [...(t.tags || []), g] }, `Labelled ${g}`, (n) => `adding the label ${g} to ${n}`);
      return;
    }
    const listId = target.startsWith('list:') ? target.slice(5) : null;
    if (listId && !db.get('lists', listId)) return;
    const patch = target === 'inbox' ? { listId: null } : target === 'today' ? { date: today } : target === 'upcoming' ? { date: addDaysYmd(today, 1) } : target === 'important' ? { priority: 3 } : listId ? { listId } : null;
    const dest = listId ? db.get('lists', listId)?.name : smart(target)?.name;
    if (patch && target === 'important') update(id, patch, 'Marked as important', (n) => `marking ${n} as important`);
    else if (patch) update(id, patch, `Moved to ${dest}`, (n) => `moving ${n} to ${dest}`);
    return;
  }
  const row = e.target.closest?.('.task[data-id]');
  const section = e.target.closest?.('.section');
  const patch = {};
  if (section?.dataset.date !== undefined && isYmd(section.dataset.date)) patch.date = section.dataset.date;
  if (section?.dataset.list !== undefined) patch.listId = db.get('lists', section.dataset.list) ? section.dataset.list : null;
  if (row && row.dataset.id !== id) {
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const target = db.get('tasks', row.dataset.id);
    const sib = before ? row.previousElementSibling : row.nextElementSibling;
    const sibTask = sib?.dataset?.id && sib.dataset.id !== id ? db.get('tasks', sib.dataset.id) : null;
    const o = target?.order ?? 0;
    patch.order = sibTask ? (o + (sibTask.order ?? 0)) / 2 : before ? o - 1 : o + 1;
    useManualOrder();
  }
  const moved = patch.date && patch.date !== t.date;
  if (Object.keys(patch).length) update(id, patch, moved ? `Moved to ${relLower(patch.date)}` : null, (n) => `moving ${n} to ${relLower(patch.date)}`);
});

// ---------------------------------------------------------------- detail pane (Microsoft To Do)

let inspFor = null; // task id the pane was last built for
let inspSig = ''; // what it showed (see inspectorSignature)
let composing = false; // an IME composition is under way in the pane
let rebuildAfterIme = false;
let tagSuggest = null;
let retryTimer = 0;

function openTask(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  state.sel = id;
  state.reveal = id;
  openInspector(id, { render: false });
  go(viewForTask(t));
}

// Up to 900px the pane covers the list (a full-screen sheet on phones, a panel over a dimmed list wider),
// so it behaves as a modal: everything behind it is inert (out of the Tab order, the accessibility tree and
// the pointer's reach), focus moves into it, Esc, × or a press on the dimmed list closes it. Wider, it sits
// beside the list (901–1100px in the sidebar's place) and the list stays usable.
function syncSheet() {
  const sheet = !!state.open && narrowMq.matches;
  syncInert();
  // The sheet itself can take focus (never in the Tab order); the side panel stays as before.
  if (sheet) {
    inspEl.tabIndex = -1;
    inspEl.setAttribute('role', 'dialog');
    inspEl.setAttribute('aria-modal', 'true');
  } else {
    inspEl.removeAttribute('tabindex');
    inspEl.removeAttribute('role');
    inspEl.removeAttribute('aria-modal');
  }
  if (sheet && !inspEl.contains(document.activeElement)) inspEl.focus({ preventScroll: true });
  return sheet;
}

function openInspector(id, { focus = false, render: doRender = true } = {}) {
  if (!db.get('tasks', id)) return;
  if (state.open && state.open !== id) db.flush();
  state.open = id;
  inspEl.hidden = false;
  shellEl.classList.add('has-inspector');
  renderInspector();
  syncNav();
  // As a sheet (≤900px) the pane covers the row that had focus (now inert) and takes focus itself, without
  // raising a keyboard; `focus` then moves it on into the name.
  syncSheet();
  if (doRender) {
    $$('.task.open', bodyEl).forEach((r) => r.classList.remove('open'));
    rowEl(id)?.classList.add('open');
  }
  if (focus)
    requestAnimationFrame(() => {
      // Not when the pane moved on to another task, or focus moved on to another task's row meanwhile.
      const row = document.activeElement?.closest?.('.task[data-id]');
      if (state.open !== id || (row && row.dataset.id !== String(id))) return;
      const ta = $('[data-f="title"]', inspEl);
      if (!ta) return;
      ta.focus({ preventScroll: true }); // the pane may still be sliding in: nothing should scroll to it
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
}

function closeInspector({ restoreFocus = false } = {}) {
  db.flush();
  clearTimeout(retryTimer);
  const id = state.open;
  const hadFocus = inspEl.contains(document.activeElement);
  tagSuggest?.destroy();
  tagSuggest = null;
  state.open = null;
  inspFor = null;
  inspSig = '';
  inspEl.hidden = true;
  inspEl.innerHTML = '';
  shellEl.classList.remove('has-inspector');
  syncSheet(); // before focus goes back to the row: an inert row can't take it
  syncNav();
  $$('.task.open', bodyEl).forEach((r) => r.classList.remove('open'));
  if ((restoreFocus || hadFocus) && id) rowEl(id)?.querySelector('[data-check]')?.focus({ preventScroll: true });
}

/**
 * Everything the pane shows, as a string. Text the user is typing (title, note, step names) is left
 * out while the field already shows it, so saving a keystroke never rebuilds the pane under the caret;
 * a change made elsewhere (another tab, an AI) does.
 */
function inspectorSignature(t) {
  const shows = (selector, v) => {
    const el = $(selector, inspEl);
    return !!el && el.value === String(v ?? '');
  };
  const copy = { ...t, updatedAt: 0 };
  if (shows('[data-f="title"]', t.title)) copy.title = 0;
  if (shows('[data-f="notes"]', t.notes)) copy.notes = 0;
  copy.checklist = (Array.isArray(t.checklist) ? t.checklist : []).map((s) => ({ ...s, title: shows(`[data-step="${CSS.escape(String(s.id))}"] [data-step-title]`, s.title) ? 0 : s.title }));
  const src = noteSource(t);
  return JSON.stringify([copy, db.all('lists').map((l) => [l.id, l.name, l.color]), todayYmd(), hour12(), src && [src.title, src.trashed, src.missing], noteMentions(t).map((m) => [m.href, m.title, m.line])]);
}

/** A selector that finds the same control again after the pane is rebuilt. */
function paneKey(el) {
  const d = el.dataset || {};
  if (d.f) return `[data-f="${CSS.escape(d.f)}"]`;
  const step = el.closest('[data-step]');
  if (step) {
    const sid = CSS.escape(step.dataset.step);
    for (const a of ['data-step-title', 'data-step-check', 'data-step-del']) if (el.hasAttribute(a)) return `[data-step="${sid}"] [${a}]`;
  }
  if (d.stepNew !== undefined) return '[data-step-new]';
  if (d.tagNew !== undefined) return '[data-tag-new]';
  const name = el.getAttribute('name');
  if (name) return `[name="${CSS.escape(name)}"]`;
  for (const a of ['data-ment', 'data-dp', 'data-prio', 'data-clear', 'data-tag-del', 'data-from']) if (el.hasAttribute(a)) return `[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  return null;
}
// Where focus goes when its control is gone after the rebuild (a cleared date, a removed label…).
const PANE_FALLBACK = [
  [/data-clear="date"/, '[data-dp="date"]'],
  [/data-clear="deadline"/, '[data-dp="deadline"]'],
  [/data-tag-del/, '[data-tag-new]'],
  [/data-step/, '[data-step-new]'],
];

function renderInspector({ force = false } = {}) {
  const t = state.open && db.get('tasks', state.open);
  if (!t) return closeInspector();
  if (composing && inspEl.contains(document.activeElement)) {
    rebuildAfterIme = true;
    return;
  }
  const same = inspFor === t.id;
  if (!force && same && inspectorSignature(t) === inspSig) return;
  // A field's list (time, length, repeat) is open: its choice arrives as a change event on the field,
  // so rebuild once it closes rather than detach the field under it. Only those fields: the label input is
  // a combobox too (aria-expanded while its suggestions show), and waiting on it would hold the pane stale.
  clearTimeout(retryTimer);
  if (!force && same && $('[data-select][aria-expanded="true"], [data-time-field][aria-expanded="true"]', inspEl)) {
    retryTimer = setTimeout(() => state.open && renderInspector(), 400);
    return;
  }
  // Keep what the user was doing: focus, caret, scroll, and half-typed step / label (same task only).
  const active = document.activeElement;
  const key = same && active && inspEl.contains(active) ? paneKey(active) : null;
  const caret = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const scroll = same ? $('.dp-scroll', inspEl)?.scrollTop || 0 : 0;
  const drafts = same ? { step: $('[data-step-new]', inspEl)?.value || '', tag: $('[data-tag-new]', inspEl)?.value || '' } : { step: '', tag: '' };
  const tagListOpen = same && $('[data-tag-new]', inspEl)?.getAttribute('aria-expanded') === 'true';
  tagSuggest?.destroy();
  tagSuggest = null;
  inspEl.innerHTML = inspectorHtml(t);
  inspFor = t.id;
  $$('textarea', inspEl).forEach(autosize);
  const stepNew = $('[data-step-new]', inspEl);
  const tagNew = $('[data-tag-new]', inspEl);
  if (stepNew) stepNew.value = drafts.step;
  if (tagNew) {
    tagNew.value = drafts.tag;
    tagSuggest = attachTagSuggest(tagNew, t.id);
  }
  const sc = $('.dp-scroll', inspEl);
  if (sc) sc.scrollTop = scroll;
  if (key) {
    const el = $(key, inspEl) || $(PANE_FALLBACK.find(([re]) => re.test(key))?.[1] || '[data-dp="close"]', inspEl);
    el?.focus({ preventScroll: true });
    if (el && caret && typeof el.setSelectionRange === 'function' && el.matches(key)) {
      const n = el.value.length;
      el.setSelectionRange(Math.min(caret[0], n), Math.min(caret[1], n), caret[2] || 'none');
    }
    // A change from elsewhere (another tab, an AI) arrived mid-label: bring its suggestions back.
    if (tagListOpen && el === tagNew && tagNew.value.trim()) tagSuggest?.refresh();
  }
  inspSig = inspectorSignature(t);
}

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

/** The pane's Time field opens a list like Length and Repeat beside it, so it carries the same chevron. */
const withChevron = (fieldHtml) => (fieldHtml.includes('fb-chev') ? fieldHtml : fieldHtml.replace(/<\/button>\s*$/, `${icon('chevron-down', { size: 16, cls: 'fb-chev' })}</button>`));

function inspectorHtml(t) {
  const today = todayYmd();
  const list = t.listId ? db.get('lists', t.listId) : null;
  const p = prio(t.priority);
  const done = !!t.done;
  const date = dateOf(t);
  const deadline = isYmd(t.deadline) ? t.deadline : null;
  const dlN = deadline ? diffDays(today, deadline) : null;
  const rp = presets(isYmd(t.date) ? t.date : today);
  const rpIndex = rp.findIndex((x) => sameRule(x.rule, t.repeat));
  const steps = Array.isArray(t.checklist) ? t.checklist : [];
  const tags = Array.isArray(t.tags) ? t.tags : [];
  const src = noteSource(t);
  const mentions = noteMentions(t);
  const clearBtn = (what, label) => `<button type="button" class="icon-btn dp-clear" data-clear="${what}" aria-label="${esc(label)}" ${tipAttrs(label)}>${icon('x', { size: 15 })}</button>`;
  const dur = durOf(t);
  const time = timeOf(t);
  const durOptions = [
    { value: '', label: 'No length' },
    ...[...new Set([...DURATIONS, ...(dur ? [dur] : [])])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: fmtDuration(m) })),
    { value: 'custom', label: 'Custom…' },
  ];
  // A repeat no preset matches is listed as itself; "Custom…" builds one (Todoist, Google Calendar).
  const rpOptions = [...rp.map((x, i) => ({ value: String(i), label: x.label })), ...(t.repeat && rpIndex < 0 ? [{ value: 'custom', label: describe(t.repeat) }] : []), { value: 'pick', label: 'Custom…' }];
  const created = fmt(new Date(t.createdAt), { weekday: 'short', month: 'short', day: 'numeric' });
  const finished = done && t.completedAt ? fmt(new Date(t.completedAt), { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  const listName = list ? list.name : 'Inbox';

  return `
    <div class="dp-head">
      <button type="button" class="dp-crumb" data-dp="list" aria-haspopup="menu" aria-label="${esc(`List: ${listName}. Move to another list`)}">${list ? dotHtml(list.color) : icon('inbox', { size: 15 })}<span class="truncate">${esc(listName)}</span>${icon('chevron-down', { size: 14 })}</button>
      <span class="grow"></span>
      <button type="button" class="icon-btn" data-dp="more" aria-haspopup="menu" aria-label="More actions" ${tipAttrs('More')}>${icon('more')}</button>
      <button type="button" class="icon-btn" data-dp="close" aria-label="Close details" ${tipAttrs('Close', 'esc')}>${icon('x')}</button>
    </div>
    <div class="dp-scroll">
      <div class="dp-card">
        <div class="dp-title">
          <button type="button" class="check p${p}" role="checkbox" aria-checked="${done}" aria-label="${done ? 'Mark as not done' : 'Complete'}" data-dp="check">${icon('check', { size: 14, stroke: 3 })}</button>
          <textarea rows="1" data-f="title" placeholder="Task name" aria-label="Task name" maxlength="500">${esc(t.title)}</textarea>
          ${done ? '' : `<button type="button" class="star${p === 3 ? ' on' : ''}" data-dp="star" aria-pressed="${p === 3}" aria-label="Important" ${tipAttrs('Important', 's')}>${icon(p === 3 ? 'star-fill' : 'star', { size: 20 })}</button>`}
        </div>
        <div class="steps">
          ${steps
            .map((s) => {
              const sid = String(s.id);
              return `<div class="step${s.done ? ' done' : ''}" data-step="${esc(sid)}">
                <button type="button" class="check sm" role="checkbox" aria-checked="${!!s.done}" data-step-check aria-labelledby="${esc(`st-${sid}`)}">${icon('check', { size: 10, stroke: 3.4 })}</button>
                <input type="text" id="${esc(`st-${sid}`)}" value="${esc(s.title)}" data-step-title aria-label="Step" maxlength="500" autocomplete="off">
                <button type="button" class="icon-btn" data-step-del aria-label="${esc(`Remove step ${s.title}`)}" ${tipAttrs('Remove step')}>${icon('x', { size: 14 })}</button></div>`;
            })
            .join('')}
          <div class="step add"><span class="plus" aria-hidden="true">${icon('plus', { size: 16, stroke: 2.4 })}</span><input type="text" placeholder="${steps.length ? 'Next step' : 'Add step'}" data-step-new aria-label="Add step" maxlength="500" autocomplete="off"></div>
        </div>
      </div>

      <div class="dp-card dp-props">
        <div class="dp-line">
          <button type="button" class="dp-row${date ? ` tone-${dateTone(date)} has-clear` : ''}" data-dp="date" aria-haspopup="dialog"${date ? ` aria-label="${esc(`Date: ${dayLabel(date, { long: true })}`)}"` : ''}>${date === today ? todayGlyph() : icon('calendar')}<span class="lbl">${date ? esc(dayLabel(date, { long: true })) : 'Add date'}</span></button>
          ${date ? clearBtn('date', 'Remove date') : ''}
        </div>
        <div class="dp-row" data-primary="time">${icon('clock')}<span class="lbl">Time</span><span class="ctl">
          ${withChevron(timeField({ name: 'time', value: time || '', placeholder: 'No time', className: 'flat compact', ariaLabel: 'Start time' }))}
          ${time || dur ? selectField({ name: 'duration', value: dur ? String(dur) : '-', options: durOptions, placeholder: 'Length', className: 'flat compact', ariaLabel: 'Length' }) : ''}
        </span></div>
        <div class="dp-line">
          <button type="button" class="dp-row${dlN !== null && dlN < 0 ? ' tone-overdue' : ''}${deadline ? ' has-clear' : ''}" data-dp="deadline" aria-haspopup="dialog">${icon('deadline')}<span class="lbl">${deadline ? esc(`Deadline ${dayLabel(deadline, { long: true })}${dlN < 0 ? `, ${-dlN}d overdue` : ''}`) : 'Add deadline'}</span></button>
          ${deadline ? clearBtn('deadline', 'Remove deadline') : ''}
        </div>
        <div class="dp-row" data-primary="repeat">${icon('repeat')}<span class="lbl">Repeat</span><span class="ctl">
          ${selectField({ name: 'repeat', value: rpIndex >= 0 ? String(rpIndex) : t.repeat ? 'custom' : '0', options: rpOptions, className: 'flat compact', ariaLabel: 'Repeat' })}
        </span></div>
        ${
          t.repeat
            ? `<div class="dp-row dp-sub"><span class="lbl" id="dp-from-lbl">Next one</span><span class="segmented" role="group" aria-labelledby="dp-from-lbl">${[
                ['due', 'On schedule'],
                ['done', 'After done'],
              ]
                .map(([v, l]) => `<button type="button" data-from="${v}" aria-pressed="${(t.repeat.from === 'done' ? 'done' : 'due') === v}">${l}</button>`)
                .join('')}</span></div>`
            : ''
        }
        <div class="dp-row">${icon('flag')}<span class="lbl" id="dp-prio-lbl">Priority</span><span class="prio-pick" role="radiogroup" aria-labelledby="dp-prio-lbl">${PRIORITIES.map(
          (x) => `<button type="button" role="radio" class="pr${x.value}" data-prio="${x.value}" aria-checked="${p === x.value}" tabindex="${p === x.value ? 0 : -1}" aria-label="${esc(x.label)}" ${tipAttrs(x.label, String(4 - x.value))}>${esc(x.short)}</button>`,
        ).join('')}</span></div>
        <div class="dp-row dp-tags">${icon('tag')}<span class="ctl tags">${tags
          .map((g) => `<button type="button" class="chip" data-tag-del="${esc(g)}" aria-label="${esc(`Remove label ${g}`)}" ${tipAttrs('Remove label')}><span class="truncate">${esc(g)}</span>${icon('x', { size: 11 })}</button>`)
          .join('')}<input class="tag-input" placeholder="Add label" data-tag-new aria-label="Add label" maxlength="60" autocomplete="off" spellcheck="false"></span></div>
        ${
          // A note that's gone has nothing to open: a plain row, no link and no chevron.
          src?.missing
            ? `<div class="dp-row dp-link is-missing">${icon('note')}<span class="lbl"><span class="muted">From note</span><span class="faint">(deleted)</span></span></div>`
            : src
              ? `<a class="dp-row dp-link" href="${esc(src.href)}" data-dp="note">${icon('note')}<span class="lbl"><span class="muted">From note</span>${src.title ? `<span class="dp-link-title truncate">${esc(src.title)}</span>` : ''}${src.trashed ? '<span class="faint">(deleted)</span>' : ''}</span>${icon('chevron-right', { size: 16 })}</a>`
              : ''
        }
      </div>

      <div class="dp-card"><textarea class="dp-note" data-f="notes" placeholder="Add note" aria-label="Note" maxlength="20000">${esc(t.notes || '')}</textarea></div>
      ${
        // The notes that mention this task, as Notes shows "Linked from" under a note.
        mentions.length
          ? `<div class="dp-card dp-mentions" role="group" aria-labelledby="dp-ment-lbl"><div class="dp-mentions-head" id="dp-ment-lbl">${icon('link', { size: 15 })}<span>${esc(`Mentioned in ${mentions.length} ${mentions.length === 1 ? 'note' : 'notes'}`)}</span></div>${mentions
              .map(
                (m) =>
                  `<a class="dp-row dp-link" href="${esc(m.href)}" data-dp="note" data-ment="${esc(m.id)}">${icon('note')}<span class="lbl"><span class="dp-link-title truncate">${esc(m.title)}</span>${m.line ? `<span class="dp-ment-line truncate">${esc(m.line)}</span>` : ''}</span>${icon('chevron-right', { size: 16 })}</a>`,
              )
              .join('')}</div>`
          : ''
      }
    </div>
    <div class="dp-foot"><span>${esc(finished ? `Completed ${finished}` : created ? `Created ${created}` : '')}</span><span class="grow"></span>
      <button type="button" class="icon-btn" data-dp="delete" aria-label="Delete task" ${tipAttrs('Delete task')}>${icon('trash')}</button></div>`;
}

function attachTagSuggest(input, taskId) {
  return attachSuggest(
    input,
    (q) => {
      const t = db.get('tasks', taskId);
      const word = normTag(q);
      if (!t || !word || q.includes(',')) return []; // "a, b" is two labels: Enter adds both
      const have = new Set(t.tags || []);
      const counts = tagCounts();
      const pool = [...counts.keys()].filter((g) => !have.has(g)).sort();
      const hits = [...pool.filter((g) => g.startsWith(word)), ...pool.filter((g) => !g.startsWith(word) && g.includes(word))];
      const items = hits.slice(0, 6).map((g) => ({ value: g, label: g, icon: 'tag', hint: String(counts.get(g)) }));
      if (!counts.has(word) && !have.has(word)) items.push({ value: word, label: `Create “${word}”`, icon: 'plus' });
      return items;
    },
    { max: 7, onPick: (value) => addTag(taskId, value) },
  );
}

function addTag(taskId, raw) {
  const t = db.get('tasks', taskId);
  const input = $('[data-tag-new]', inspEl);
  if (input) input.value = '';
  // Emptying the field fires no input event, so its suggestions would stay open over the pane.
  tagSuggest?.close();
  if (!t) return;
  const have = Array.isArray(t.tags) ? t.tags : [];
  // Typed or pasted "home, errands" adds two labels; a comma never ends up inside one.
  const add = [...new Set(String(raw ?? '').split(',').map(normTag).filter(Boolean))].filter((g) => !have.includes(g));
  if (add.length) update(taskId, { tags: [...have, ...add] });
}

/** The "Custom…" length: a small field that takes "75m", "1h 20m" or "1:15". */
function customDuration(anchor, id) {
  const t = db.get('tasks', id);
  openPopover(
    anchor,
    `<form class="dur-form" novalidate autocomplete="off"><input class="input" name="dur" placeholder="e.g. 75m or 1h 20m" aria-label="Custom length" value="${esc(t?.duration ? fmtDuration(t.duration) : '')}" data-autofocus><button type="submit" class="btn btn-primary btn-sm">Set</button></form><p class="dur-err" role="alert" hidden>Try “45m”, “1h 30m” or “1:15”.</p>`,
    {
      className: 'dur-pop',
      label: 'Custom length',
      onMount: (el, close) => {
        const input = $('input', el);
        input.focus({ preventScroll: true });
        input.select();
        $('form', el).addEventListener('submit', (e) => {
          e.preventDefault();
          const mins = parseDuration(input.value);
          if (!mins) {
            $('.dur-err', el).hidden = false;
            return input.select();
          }
          close();
          update(id, { duration: mins });
        });
      },
    },
  );
}

// Typing saves through the store's deferred write: one save (and one re-render elsewhere) per pause,
// not per keystroke. Leaving the field saves at once.
inspEl.addEventListener('input', (e) => {
  const id = state.open;
  if (!id || !db.get('tasks', id)) return;
  const el = e.target;
  if (el.tagName === 'TEXTAREA') autosize(el);
  if (el.dataset.f === 'title') db.update('tasks', id, { title: el.value }, { defer: true });
  else if (el.dataset.f === 'notes') db.update('tasks', id, { notes: el.value }, { defer: true });
  else if (el.dataset.stepTitle !== undefined) {
    const sid = el.closest('[data-step]')?.dataset.step;
    db.update('tasks', id, (prev) => ({ checklist: (prev.checklist || []).map((c) => (c.id === sid ? { ...c, title: el.value } : c)) }), { defer: true });
  }
});
inspEl.addEventListener('focusout', (e) => {
  if (e.target.matches?.('[data-f], [data-step-title]')) db.flush();
});
inspEl.addEventListener('compositionstart', () => (composing = true));
inspEl.addEventListener('compositionend', () => {
  composing = false;
  if (rebuildAfterIme) {
    rebuildAfterIme = false;
    requestAnimationFrame(() => renderInspector());
  }
});

// Custom fields (time, length, repeat) report through bubbling `change` events.
inspEl.addEventListener('change', (e) => {
  const t = db.get('tasks', state.open);
  const el = e.target;
  const name = el.getAttribute?.('name');
  if (!t || !name || !el.matches('[data-select], [data-time-field]')) return;
  if (name === 'time') update(t.id, { time: el.value || null, date: el.value && !t.date ? todayYmd() : t.date });
  else if (name === 'duration') {
    if (el.value === 'custom') {
      setFieldValue(el, t.duration ? String(t.duration) : '-');
      return customDuration(el, t.id);
    }
    update(t.id, { duration: el.value ? Math.max(1, Math.min(1440, +el.value || 0)) || null : null });
  } else if (name === 'repeat') {
    if (el.value === 'pick') {
      // The field keeps showing the current repeat while the builder is open. No rebuild before opening it:
      // the builder is anchored to this field.
      const day = isYmd(t.date) ? t.date : todayYmd();
      const at = presets(day).findIndex((x) => sameRule(x.rule, t.repeat));
      setFieldValue(el, at >= 0 ? String(at) : t.repeat ? 'custom' : '0');
      return openRepeatPicker(el, {
        value: t.repeat,
        date: day,
        onPick: (rule) => {
          const cur = db.get('tasks', t.id); // read again: the task may have changed while the builder was open
          if (cur) update(cur.id, { repeat: { ...rule, from: cur.repeat?.from === 'done' ? 'done' : 'due' }, date: cur.date || todayYmd() });
        },
      });
    }
    if (el.value === 'custom') return;
    const i = Number(el.value);
    const preset = Number.isInteger(i) ? presets(isYmd(t.date) ? t.date : todayYmd())[i] : null;
    if (!preset) return;
    const rule = preset.rule;
    update(t.id, { repeat: rule ? { ...rule, from: t.repeat?.from === 'done' ? 'done' : 'due' } : null, date: rule && !t.date ? todayYmd() : t.date });
  }
});

inspEl.addEventListener('keydown', (e) => {
  const t = db.get('tasks', state.open);
  if (!t) return;
  const el = e.target;
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    if (hasOpenLayer()) return; // the shell closes the open popover first
    e.preventDefault();
    e.stopPropagation();
    // One Esc closes the pane from anywhere in it, a text field included (what was typed is saved), and
    // focus goes back to the task's row, as in To Do.
    return closeInspector({ restoreFocus: true });
  }
  if (el.dataset.f === 'title' && e.key === 'Enter') {
    e.preventDefault();
    return $('[data-step-new]', inspEl)?.focus();
  }
  if (el.dataset.stepNew !== undefined && e.key === 'Enter') {
    e.preventDefault();
    const title = el.value.trim();
    if (!title) return;
    el.value = '';
    return update(t.id, { checklist: [...(t.checklist || []), { id: uid(), title, done: false }] });
  }
  if (el.dataset.stepTitle !== undefined && e.key === 'Enter') {
    e.preventDefault();
    return $('[data-step-new]', inspEl)?.focus();
  }
  if (el.dataset.stepTitle !== undefined && e.key === 'Backspace' && !el.value) {
    e.preventDefault();
    const sid = el.closest('[data-step]')?.dataset.step;
    const prevStep = el.closest('[data-step]')?.previousElementSibling?.querySelector('[data-step-title]');
    db.update('tasks', t.id, (prev) => ({ checklist: (prev.checklist || []).filter((c) => c.id !== sid) }));
    const target = prevStep && $(`[data-step="${CSS.escape(prevStep.closest('[data-step]').dataset.step)}"] [data-step-title]`, inspEl);
    const next = target || $('[data-step-new]', inspEl);
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
    return;
  }
  if (el.dataset.tagNew !== undefined && (e.key === 'Enter' || e.key === ',') && el.value.trim()) {
    e.preventDefault();
    return addTag(t.id, el.value);
  }
  if (el.dataset.tagNew !== undefined && e.key === 'Backspace' && !el.value && (t.tags || []).length) {
    e.preventDefault();
    const g = t.tags.at(-1);
    return update(t.id, { tags: t.tags.slice(0, -1) }, `Removed label ${g}`, (n) => `removing the label ${g} from ${n}`);
  }
  // Priority radios: arrows move the choice (WAI-ARIA radio group).
  const radio = el.closest('[data-prio]');
  if (radio && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const all = $$('[data-prio]', inspEl);
    const next = all[(all.indexOf(radio) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
    update(t.id, { priority: prio(+next.dataset.prio) });
    $(`[data-prio="${CSS.escape(next.dataset.prio)}"]`, inspEl)?.focus();
  }
});

inspEl.addEventListener('click', (e) => {
  const t = db.get('tasks', state.open);
  if (!t) return;
  const el = e.target;
  const clearWhat = el.closest('[data-clear]')?.dataset.clear;
  if (clearWhat === 'deadline') return update(t.id, { deadline: null }, 'Deadline removed', (n) => `removing the deadline from ${n}`);
  if (clearWhat === 'date') return setDate(t.id, null);
  const dp = el.closest('[data-dp]');
  const a = dp?.dataset.dp;
  if (a === 'close') return closeInspector({ restoreFocus: true });
  if (a === 'check') return complete(t.id);
  if (a === 'star') return toggleStar(t.id);
  if (a === 'delete') return remove(t.id);
  if (a === 'more') return rowMenu(dp, t.id, { inPane: true });
  if (a === 'list') return moveToListMenu(dp, t.id);
  if (a === 'date') return pickDate(dp, t.id);
  if (a === 'deadline') return openDatePicker(dp, { value: t.deadline, title: 'Deadline', clearLabel: 'No deadline', onPick: ({ date }) => update(t.id, { deadline: date }) });
  if (a === 'note') return db.flush();
  const pr = el.closest('[data-prio]');
  if (pr) return update(t.id, { priority: prio(+pr.dataset.prio) });
  const from = el.closest('[data-from]')?.dataset.from;
  if (from && t.repeat && (from === 'due' || from === 'done')) return update(t.id, { repeat: { ...t.repeat, from } });
  const tagDel = el.closest('[data-tag-del]');
  if (tagDel) return update(t.id, { tags: (t.tags || []).filter((g) => g !== tagDel.dataset.tagDel) });
  const step = el.closest('[data-step]');
  const sid = step?.dataset.step;
  if (step && el.closest('[data-step-check]')) return db.update('tasks', t.id, (prev) => ({ checklist: (prev.checklist || []).map((c) => (c.id === sid ? { ...c, done: !c.done } : c)) }));
  if (step && el.closest('[data-step-del]')) return db.update('tasks', t.id, (prev) => ({ checklist: (prev.checklist || []).filter((c) => c.id !== sid) }));
  // A click on a row's label opens its control (the time list, the repeat menu).
  const row = el.closest('.dp-row[data-primary]');
  if (row && !el.closest('button, a, input, textarea')) $('.field-btn', row)?.click();
});

// ---------------------------------------------------------------- lists

const colorName = (c) => c.charAt(0).toUpperCase() + c.slice(1);

function editListDialog(list, onDone) {
  let color = list?.color && COLORS.includes(list.color) ? list.color : COLORS.find((c) => !db.all('lists').some((l) => l.color === c)) || 'iris';
  const { el, close } = openModal({
    title: list ? 'Edit list' : 'New list',
    body: `<div class="modal-body"><form data-list-form class="list-form" novalidate autocomplete="off">
      <input class="input list-name" name="listName" placeholder="List name" value="${esc(list?.name || '')}" maxlength="60" autocomplete="off" spellcheck="false" aria-label="List name" data-autofocus>
      <div class="group-title" id="list-color-lbl">Colour</div>
      <div class="swatches" role="radiogroup" aria-labelledby="list-color-lbl">${COLORS.map(
        (c) => `<button type="button" class="swatch-btn" role="radio" style="--sw:${esc(colorVar(c))}" data-color="${esc(c)}" aria-checked="${c === color}" tabindex="${c === color ? 0 : -1}" aria-label="${esc(colorName(c))}" ${tipAttrs(colorName(c))}>${icon('check')}</button>`,
      ).join('')}</div>
      <div class="list-form-foot"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary" data-list-save>${list ? 'Save' : 'Create list'}</button></div>
    </form></div>`,
  });
  const form = $('[data-list-form]', el);
  const input = form.elements.listName;
  const save = $('[data-list-save]', el);
  const sync = () => (save.disabled = !input.value.trim());
  sync();
  input.addEventListener('input', sync);
  const choose = (b, focus = false) => {
    color = b.dataset.color;
    $$('[data-color]', el).forEach((x) => {
      x.setAttribute('aria-checked', String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    });
    if (focus) b.focus();
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (b) choose(b);
  });
  el.addEventListener('keydown', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const all = $$('[data-color]', el);
    choose(all[(all.indexOf(b) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length], true);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    const saved = list ? db.update('lists', list.id, { name, color }) : createList({ name, color });
    close();
    if (saved) onDone?.(saved);
  });
}

async function deleteList(list) {
  const tasks = db.all('tasks').filter((t) => t.listId === list.id);
  const open = tasks.filter((t) => !t.done).length;
  const choice = tasks.length
    ? await choiceDialog({
        title: `Delete “${list.name}”?`,
        message: `It has ${open} open ${open === 1 ? 'task' : 'tasks'}.`,
        choices: [
          { label: 'Delete list, move tasks to Inbox', value: 'keep', tone: 'secondary' },
          { label: `Delete list and its ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`, value: 'all', tone: 'danger' },
        ],
      })
    : 'all';
  if (!choice) return;
  // Read again after the dialog: the list and its tasks may have changed while it was open.
  const live = db.get('lists', list.id);
  if (!live) return;
  const before = { list: structuredClone(live), tasks: structuredClone(db.all('tasks').filter((t) => t.listId === list.id)) };
  const s = settings.get();
  const hidden = (s.hiddenTaskLists || []).includes(list.id);
  const sort = s.taskSort?.[list.id];
  const after = structuredClone(
    db.batch(() => {
      db.remove('lists', list.id);
      const changed = before.tasks.map((t) => (choice === 'all' ? (db.remove('tasks', t.id), null) : db.update('tasks', t.id, { listId: null })));
      // Forget the list in settings too (calendar visibility, sort order), so nothing points at it.
      settings.set({
        hiddenTaskLists: (s.hiddenTaskLists || []).filter((id) => id !== list.id),
        taskSort: Object.fromEntries(Object.entries(s.taskSort || {}).filter(([k]) => k !== list.id)),
      });
      return changed;
    }),
  );
  if (state.view === list.id) go('inbox'); // leave only a page that no longer exists
  // The undo takes back just this: the list comes back (unless re-created since), its tasks come back or
  // return to it (one moved elsewhere since stays there), and its two settings return beside any made since.
  undoable(
    `Deleted “${live.name}”`,
    () =>
      db.batch(() => {
        const back = revertChange('lists', before.list, null);
        before.tasks.forEach((t, i) => revertChange('tasks', t, after[i]));
        if (!back) return;
        const cur = settings.get();
        const patch = {};
        if (hidden && !(cur.hiddenTaskLists || []).includes(list.id)) patch.hiddenTaskLists = [...(cur.hiddenTaskLists || []), list.id];
        if (sort && !cur.taskSort?.[list.id]) patch.taskSort = { ...(cur.taskSort || {}), [list.id]: sort };
        if (Object.keys(patch).length) settings.set(patch);
      }),
    `deleting the list “${live.name}”`,
  );
}

// ---------------------------------------------------------------- labels (as Notes' tags: rename or delete one everywhere)

/** Every task with the label, open or done. */
const tasksLabelled = (g) => db.all('tasks').filter((t) => Array.isArray(t.tags) && t.tags.includes(g));
const nTasks = (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/** A label's actions: its page's More menu and a right click on it in the sidebar. */
const labelItems = (g) => [
  { label: 'Rename label…', icon: 'edit', onSelect: () => renameLabelDialog(g) },
  { label: 'Delete label', icon: 'trash', danger: true, onSelect: () => deleteLabel(g) },
];

/**
 * Put `to` in place of label `g` on every task that has it (no `to`: take it off), in one write. The undo
 * gives each task back only this change: a label added or removed there since stays.
 */
function relabel(g, to) {
  const before = structuredClone(tasksLabelled(g));
  if (!before.length) return null;
  const after = structuredClone(db.batch(() => before.map((t) => db.update('tasks', t.id, (prev) => ({ tags: [...new Set((prev.tags || []).flatMap((x) => (x === g ? (to ? [to] : []) : [x])))] })))));
  return { count: before.length, undo: () => db.batch(() => before.forEach((b, i) => after[i] && revertChange('tasks', b, after[i]))) };
}

function renameLabelDialog(g) {
  const { el, close } = openModal({
    title: 'Rename label',
    className: 'label-modal',
    body: `<form data-label-form class="modal-body label-form" novalidate autocomplete="off">
      <div class="label-field">${icon('tag', { size: 16 })}<input class="input" name="labelName" value="${esc(g)}" maxlength="60" autocomplete="off" spellcheck="false" aria-label="New name" data-autofocus></div>
      <p class="label-hint">${esc(`Renames the label on ${nTasks(tasksLabelled(g).length)}.`)}</p>
      <div class="label-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary" data-label-save>Rename</button></div>
    </form>`,
  });
  const form = $('[data-label-form]', el);
  const input = form.elements.labelName;
  const save = $('[data-label-save]', el);
  const sync = () => (save.disabled = !normTag(input.value));
  sync();
  input.select();
  input.addEventListener('input', sync);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const to = normTag(input.value);
    if (!to) return input.focus();
    close();
    if (to === g) return;
    const done = relabel(g, to);
    if (!done) return toast(`No tasks have the label ${g} any more`);
    // Its page follows it (the old name has no tasks left).
    if (state.view === 'tag' && state.tag === g) go('tag', { tag: to });
    undoable(`Renamed ${g} to ${to}`, done.undo, `renaming the label ${g} to ${to}`);
  });
}

function deleteLabel(g) {
  const done = relabel(g, null);
  if (!done) return toast(`No tasks have the label ${g} any more`);
  if (state.view === 'tag' && state.tag === g) go('inbox'); // leave only a page that no longer has tasks
  undoable(`Deleted the label ${g} from ${nTasks(done.count)}`, done.undo, `deleting the label ${g}`);
}

navEl.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.nav-item[data-nav]');
  if (!item) return;
  const key = item.dataset.nav;
  if (key.startsWith('tag:') && key.length > 4) {
    e.preventDefault();
    return openMenu({ x: e.clientX, y: e.clientY }, labelItems(key.slice(4)), { label: 'Label actions' });
  }
  const list = db.get('lists', key);
  if (!list) return;
  e.preventDefault();
  openMenu(
    { x: e.clientX, y: e.clientY },
    [
      { label: 'Rename or recolour…', icon: 'edit', onSelect: () => editListDialog(list) },
      { label: 'Delete list…', icon: 'trash', danger: true, onSelect: () => deleteList(list) },
    ],
    { label: 'List actions' },
  );
});

// ---------------------------------------------------------------- command palette

registerPaletteProvider(
  (q) => {
    const out = [];
    const lists = listMap();
    if (q) {
      const hits = db
        .all('tasks')
        .map((t) => ({ t, s: score(`${t.title} ${t.notes || ''} ${(t.tags || []).join(' ')} ${lists.get(t.listId)?.name || ''}`, q) }))
        .filter((x) => x.s)
        .sort((a, b) => !!a.t.done - !!b.t.done || b.s - a.s)
        .slice(0, 8);
      for (const { t } of hits) out.push({ group: 'Tasks', label: untitled(t), sub: t.done ? 'Completed' : t.date ? relDate(t.date) : lists.get(t.listId)?.name || 'Inbox', icon: t.done ? 'check-circle' : 'circle', run: () => openTask(t.id) });
    }
    // The group already says "Go to", so rows carry just the name.
    const nav = [
      ...SMART_LISTS.map((s) => ({ label: s.name, ...(s.id === 'today' ? { iconHtml: todayGlyph(18) } : { icon: s.icon }), run: () => go(s.id) })),
      ...listsSorted().map((l) => ({ label: l.name, iconHtml: dotHtml(l.color), run: () => go(l.id) })),
    ];
    for (const n of nav) if (!q || score(`${n.label} go to`, q)) out.push({ group: 'Go to', ...n });
    // Creating from the query is the fallback, as in Schedule: it comes after every match (tasks, events,
    // built-in commands), so Enter on "settings" opens Settings. Both "Create" rows stay under one heading.
    if (q) out.push({ group: 'Create', label: `Add task “${q}”`, icon: 'plus', fallback: true, run: () => openComposer('top', q) });
    if (!q || score('new list create', q)) out.push({ group: 'Create', label: 'New list…', icon: 'plus', fallback: !!q, run: () => editListDialog(null, (l) => go(l.id)) });
    return q ? out : out.slice(0, 8);
  },
  { prepend: true },
);

route();
// The columns slide (sidebar hidden or shown, details opened) only once the first view is on screen.
requestAnimationFrame(() => requestAnimationFrame(() => shellEl.classList.add('ready')));
