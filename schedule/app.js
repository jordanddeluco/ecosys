// schedule — the ecosys calendar. Google Calendar's layout, quick-create card, detail cards and month view,
// with Apple Calendar's tinted events, red now line and Year view. Tasks share the timeline (drag one in to
// block time for it) and notes attach to days and events.
//
// First: the notes schema (pure, no DOM) registers the note fields (day, event, blocks) with the shared
// validators before the store loads, so the store here keeps them (daily-note marks, meeting notes).
import '../notes/core/schema.js';
import {
  initShell, esc, $, $$, icon, toast, undoable, openMenu, openPopover, openModal, openDatePicker, choiceDialog, confirmDialog,
  registerPaletteProvider, registerShortcuts, openPalette, score, sidebarHead, hasOpenLayer, isTyping, playDing, tipAttrs,
  selectField, timeField, dateField, checkField, setFieldValue, autosize, fmtClock, fmtTimeRange, openTimePicker,
  openRepeatPicker, singleKeyOff, announce, BASE,
} from '../shared/shell.js';
import { db, settings } from '../shared/store.js';
import {
  todayYmd, addDaysYmd, parseYmd, ymd, fmt, fmtTime, dayLabel, fmtDuration, diffDays, hour12, pad, startOfWeek, startOfMonth,
  addDays, parseDT, fmtDT, fromMinutes, toMinutes, WEEKDAY_SHORT, WEEKDAY_NARROW, WEEKDAY_LONG, daysInMonth,
} from '../shared/dates.js';
import { parse } from '../shared/nlp.js';
import { describe, presets, occurrencesBetween, shiftRule } from '../shared/recur.js';
import {
  eventInstances, layoutColumns, detachOccurrence, splitSeries, deleteOccurrence, trackChanges, shiftSeriesDates,
  seriesCopies, scheduledTasks, taskBlock, toggleTask, createTask, deleteTask, createEvent, scheduleTask, colorVar, COLORS,
  byTimeThenOrder, byOrder, isTaskListHidden, liveListIds, taskListKey, revertChange, busyDays,
} from '../shared/model.js';
import { miniCalendar, monthTitle } from '../shared/minical.js';
import { visualBottom, blockBox, untilAfter, bucketDays, tasksByDay } from './grid.js';
import { linkify } from './links.js';

initShell({ app: 'schedule' });

// ---------------------------------------------------------------- constants & small helpers

const VIEWS = [
  { id: 'day', label: 'Day', key: 'd', num: '1', icon: 'today' },
  { id: 'days', label: 'days', key: 'x', num: '2', icon: 'calendar' },
  { id: 'week', label: 'Week', key: 'w', num: '3', icon: 'calendar-week' },
  { id: 'month', label: 'Month', key: 'm', num: '4', icon: 'calendar-month' },
  { id: 'year', label: 'Year', key: 'y', num: '5', icon: 'layers' },
  { id: 'agenda', label: 'Schedule', key: 'a', num: '6', icon: 'list' },
];
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (s) => typeof s === 'string' && YMD_RE.test(s) && ymd(parseYmd(s)) === s;
const prio = (p) => Math.min(3, Math.max(0, Math.trunc(+p) || 0));
const enc = encodeURIComponent;
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
/** Attribute selector with an escaped value (ids come from storage, the hash or other tabs). */
const sel = (attr, value) => `[${attr}="${CSS.escape(String(value ?? ''))}"]`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const clock = (d) => d.getHours() * 60 + d.getMinutes();
/** Wall-clock minutes from a to b (DST-proof: 9:00 → 10:00 is 60 even on a changeover day). */
const wallMinutes = (a, b) => diffDays(ymd(a), ymd(b)) * 1440 + clock(b) - clock(a);
/** `mins` wall-clock minutes after midnight of `dateYmd` (may run into the next days). */
const atMinutes = (dateYmd, mins) => {
  const d = parseYmd(dateYmd);
  d.setHours(0, mins, 0, 0);
  return d;
};
const shiftWall = (d, mins) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + mins);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nDays = () => Math.min(7, Math.max(2, Math.round(+settings.get().scheduleDays) || 4));
const viewLabel = (v) => (v.id === 'days' ? `${nDays()} days` : v.label);
const listMap = () => new Map(db.all('lists').map((l) => [l.id, l]));
const byOrderField = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const listsSorted = () => [...db.all('lists')].sort(byOrderField);
const calsSorted = () => [...db.all('calendars')].sort(byOrderField);
const taskColor = (t, lists) => colorVar(lists.get(t?.listId)?.color || 'iris');
const hourLabel = (h) => (hour12() ? `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:00`);
/** The red now label, in the hour labels' style: '7:24 PM' beside '7 PM' (or '19:24'); '7:24' in a phone's narrow gutter (iOS). */
const nowText = (d) => {
  const t = fmtTime(hhmm(d));
  return innerWidth <= 640 ? t.replace(/\s?[AP]M$/i, '') : t;
};
/** Scrolling that follows Reduce motion, in Settings or in the system. */
const smooth = () => (settings.get().reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
// The red now label's background (its 20px line, centred on the time) covers an hour label close to it, so
// that one hides (Apple). An hour label's digits (~8px) clear it from 20 minutes away: 15–16px at 46–48px an hour.
const nearNow = (h, mins) => Math.abs(h * 60 - mins) < 20;
const longDay = (s) => fmt(parseYmd(s), { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = (s) => fmt(parseYmd(s), { weekday: 'short', month: 'short', day: 'numeric' });
const isDmy = !/^en-US|^en-CA|^en-PH/.test(navigator.language || 'en-US') && /^en|^de|^fr|^es|^it|^nl|^pt/.test(navigator.language || '');
const narrow = () => innerWidth <= 640;
/** Touch screens and phone widths: no hover, and tasks can't be dragged onto the calendar there. */
const touchUI = () => narrow() || matchMedia('(hover: none)').matches;
const effView = () => (narrow() && state.view === 'week' ? 'days' : state.view);
const untitled = (t) => String(t || '').trim() || '(No title)';
/** Typed text (a description, a place) as HTML with its web, e-mail and ecosys links clickable. */
const withLinks = (text) => linkify(text, { base: BASE, origin: location.origin });
/** A long timed event (a full day or more by the clock) sits in the all-day row, as bucketDays decides. */
const longTimed = (i) => !i.allDay && wallMinutes(i.start, i.end) >= 1440;
const lastDayOf = (i) => (i.allDay ? ymd(i.end) : ymd(new Date(i.end.getTime() - 1)));

// Focusable calendar items. Events are buttons; a task item holds its own checkbox, so it is a group.
const itemA11y = (label) => `tabindex="0" role="button" aria-label="${esc(label)}"`;
const taskA11y = (label) => `tabindex="0" role="group" aria-roledescription="task" aria-label="${esc(label)}"`;
const checkBtn = (t, size = 10, cls = 'check sm') =>
  `<button type="button" class="${cls} p${prio(t.priority)}" role="checkbox" aria-checked="${!!t.done}" data-task-check aria-label="${esc(t.done ? `Mark “${t.title}” not completed` : `Complete “${t.title}”`)}">${icon('check', { size, stroke: 3.4 })}</button>`;

// ---------------------------------------------------------------- notes (daily notes and meeting notes live in the notes app)

const notesHref = {
  day: (d) => `../notes/#/day/${d}`,
  note: (id) => `../notes/#/n/${enc(id)}`,
  meeting: (id, d) => `../notes/#/new?event=${enc(id)}&date=${d}`,
};
function allNotes() {
  try {
    const a = db.all('notes');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
const noteLive = (n) => !!n && !n.trashedAt && !n.trashed && !n.deletedAt;
function dayNoteDays() {
  const out = new Set();
  for (const n of allNotes()) if (noteLive(n) && isYmd(n.day)) out.add(n.day);
  return out;
}
const noteKey = () => [...dayNoteDays()].sort().join(',');
/** The meeting note for one occurrence (an edited occurrence also finds the note made before it was split off). */
function meetingNote(e, occurrence) {
  const keys = [[e.id, occurrence]];
  if (e.seriesId && isYmd(e.occurrence)) keys.push([e.seriesId, e.occurrence]);
  let best = null;
  for (const n of allNotes()) {
    const ev = n?.event;
    if (!noteLive(n) || !ev || typeof ev !== 'object') continue;
    if (keys.some(([id, d]) => ev.id === id && ev.date === d) && (!best || (n.updatedAt || 0) > (best.updatedAt || 0))) best = n;
  }
  return best;
}
/** First line of body text (headings and the title skipped), for "Open meeting notes". */
function notePreview(n) {
  const title = String(n.title || '').trim();
  if (!Array.isArray(n.blocks)) return '';
  for (const b of n.blocks) {
    if (!b || /^h[1-3]$/.test(b.t) || !Array.isArray(b.c)) continue;
    const text = b.c.map((r) => (Array.isArray(r) ? String(r[0] ?? '') : '')).join('').replace(/\s+/g, ' ').trim();
    if (text && text !== title) return text.slice(0, 90);
  }
  return '';
}

// A meeting note is linked to one occurrence: {event: {id, date}}. When an event's dates move, its series
// is split ("this and following" makes a new series id) or one occurrence is edited on its own (a copy
// with its own id), the links move with it in the same change, so the card (and the notes app) still
// find the note. Notes of an edited occurrence move onto the copy itself.
const bumpRev = (n) => (Number.isInteger(n?.rev) ? n.rev : 0) + 1;
/** Re-point notes linked to `fromId`: linkFor(date) → the new {id, date}, or null to leave that note. → the moves made. */
function relinkNotes(fromId, linkFor) {
  const moves = [];
  if (!fromId) return moves;
  for (const n of allNotes()) {
    const ev = n?.event;
    if (!ev || typeof ev !== 'object' || ev.id !== fromId || !isYmd(ev.date)) continue;
    const link = linkFor(ev.date);
    if (!link?.id || !isYmd(link.date) || (link.id === ev.id && link.date === ev.date)) continue;
    const after = { id: link.id, date: link.date };
    db.update('notes', n.id, { event: after, rev: bumpRev(n) });
    moves.push({ id: n.id, before: { id: ev.id, date: ev.date }, after });
  }
  return moves;
}
/** The separately edited occurrences of a series (on or after `from`): original date → link to the copy. */
const copyLinks = (seriesId, from = null) =>
  new Map(seriesCopies(seriesId, from).filter((c) => isYmd(c.occurrence)).map((c) => [c.occurrence, { id: c.id, date: c.start.slice(0, 10) }]));
/** After detachOccurrence: the occurrence's notes go with its new copy. */
const linkToCopy = (seriesId, occurrence, copy) => (copy ? relinkNotes(seriesId, (d) => (d === occurrence ? { id: copy.id, date: copy.start.slice(0, 10) } : null)) : []);
/** An event undo that also puts back the note links moved with it (only links nobody has changed since). */
function withNoteLinks(undo, moves) {
  if (!moves.length) return undo;
  const all = () =>
    db.batch(() => {
      undo();
      for (const m of moves) {
        const n = db.get('notes', m.id);
        if (n?.event?.id === m.after.id && n.event.date === m.after.date) db.update('notes', m.id, { event: m.before, rev: bumpRev(n) });
      }
    });
  all.result = undo.result;
  return all;
}

// ---------------------------------------------------------------- state & layout

const s0 = settings.get();
const state = {
  view: VIEWS.some((v) => v.id === s0.scheduleView) ? s0.scheduleView : 'week',
  date: todayYmd(),
  month: null, // month shown in the sidebar mini calendar (null = the focused date's)
  miniFocus: null, // keyboard focus in the mini calendar
  sel: null, // {kind:'event', key} | {kind:'task', id} while its card is open
  yearFocus: null, // the Year view's keyboard focus (its one tab stop among the days)
  monthFocus: null, // the Month view's keyboard focus (likewise)
  panel: !!s0.schedulePanel && innerWidth > 1280,
  alldayOpen: false,
  scrolledOnce: false,
  agendaSpan: 60,
};
let instMap = new Map();
let gesture = null;
let pendingRender = false;

// The instances of the last few ranges drawn, until events or calendars change: stepping back and forth,
// opening the Tasks panel or resizing the window redraw the same days without expanding every series again.
// (A render in the same task as a change, before the store reports it, is redone when it does.)
const instCache = new Map();
function instancesOf(from, to) {
  const k = `${from}|${to}`;
  let v = instCache.get(k);
  if (!v) {
    v = eventInstances(from, to);
    instCache.set(k, v);
    if (instCache.size > 6) instCache.delete(instCache.keys().next().value);
  }
  return v;
}

let hourCache = 0;
/** The time grid's height of an hour in px (--hour: 48, or 46 on a phone), read from the styles once per size. */
const hourPx = () => hourCache || (hourCache = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 48);

// Cards (quick create, event and task details, a day's "more" list, a task's time list) are anchored to
// elements of the view. A render replaces those elements, which would close the card (and lose what was
// typed in it) whenever data changes in another tab, through sync or the AI, or the window resizes. So
// while a card is open, renders wait, and the one they owe runs when it closes. Dragging closes cards.
const openCards = new Set();
/** Hold renders while the card `close` belongs to is open. → release(), for the card's onClose. */
function holdView(close) {
  openCards.add(close);
  return () => {
    if (!openCards.delete(close) || openCards.size) return;
    // After the current event: the press that closed the card may be starting a drag on the blocks on screen.
    setTimeout(() => !openCards.size && pendingRender && render());
  };
}
const closeCards = () => [...openCards].forEach((close) => close());
/** Open a popover card that holds renders while it is open (see openCards). */
function openCard(anchor, html, opts = {}) {
  let release = () => {};
  const handle = openPopover(anchor, html, { ...opts, onClose: () => (release(), opts.onClose?.()) });
  if (handle.el.isConnected) release = holdView(handle.close); // not when this press closed the card instead
  return handle;
}

let lastRenderKey = '';
let lastNoteKey = '';
let lastToday = todayYmd();

$('#app').innerHTML = `
<div class="shell" id="shell">
  <aside class="sidebar" id="sidebar" aria-label="Calendars">
    ${sidebarHead('schedule')}
    <div class="create-wrap"><button type="button" class="create-btn" data-create ${tipAttrs('Create', 'c')}>${icon('plus', { size: 22, stroke: 2.4 })}<span>Create</span></button></div>
    <div class="side-scroll">
      <div class="side-views" id="side-views" role="group" aria-label="View" hidden></div>
      <div class="side-cal" id="minical"></div>
      <div class="side-section">
        <div class="side-label"><span id="cal-label">My calendars</span><button type="button" class="icon-btn sm" data-add-cal aria-label="New calendar" ${tipAttrs('New calendar')}>${icon('plus', { size: 16 })}</button></div>
        <div id="cal-list" role="group" aria-labelledby="cal-label"></div>
      </div>
    </div>
  </aside>
  <div class="side-overlay" data-close-nav></div>
  <main class="main" id="main">
    <header class="topbar cal-top" id="topbar">
      <button type="button" class="icon-btn menu-toggle" data-nav-toggle aria-controls="sidebar" aria-label="Main menu" ${tipAttrs('Main menu', 'mod \\')}>${icon('menu')}</button>
      <button type="button" class="btn btn-secondary today-btn" data-today aria-label="Today" ${tipAttrs('Today', 't')}>${icon('today', { size: 20 })}<span>Today</span></button>
      <div class="nav-arrows">
        <button type="button" class="icon-btn" data-step="-1" aria-label="Previous" ${tipAttrs('Previous', 'k')}>${icon('chevron-left')}</button>
        <button type="button" class="icon-btn" data-step="1" aria-label="Next" ${tipAttrs('Next', 'j')}>${icon('chevron-right')}</button>
      </div>
      <h1 class="range-h"><button type="button" class="range-title" id="range-title" aria-haspopup="dialog" ${tipAttrs('Go to date', 'g')}></button></h1>
      <span class="grow"></span>
      <button type="button" class="icon-btn top-search" data-open-palette aria-label="Search" ${tipAttrs('Search', '/')}>${icon('search')}</button>
      <button type="button" class="view-btn" id="view-btn" aria-haspopup="menu" aria-expanded="false"></button>
      <button type="button" class="icon-btn top-panel" data-toggle-panel aria-label="Tasks" aria-pressed="false" ${tipAttrs('Tasks', 'i')}>${icon('checklist')}</button>
      <button type="button" class="icon-btn top-create" data-create aria-label="Create" ${tipAttrs('Create', 'c')}>${icon('plus')}</button>
    </header>
    <div class="view" id="view" role="region"></div>
  </main>
  <div class="panel-scrim" data-close-panel></div>
  <aside class="taskpanel" id="panel" hidden aria-labelledby="tp-title" tabindex="-1"></aside>
  <nav class="tabbar" id="tabbar" aria-label="Views"></nav>
  <button type="button" class="fab" data-create aria-label="Create">${icon('plus', { size: 26, stroke: 2.4 })}</button>
</div>`;

const shellEl = $('#shell');
const viewEl = $('#view');
const panelEl = $('#panel');

/** Set innerHTML only when it changed, so focus, hover and selection survive unrelated renders. */
const lastHtml = new WeakMap();
function setHTML(el, html) {
  if (!el || lastHtml.get(el) === html) return false;
  el.innerHTML = html;
  lastHtml.set(el, html);
  return true;
}

// ---------------------------------------------------------------- range & title

function range() {
  const v = effView();
  const s = settings.get();
  const d = parseYmd(state.date);
  let days;
  if (v === 'day') days = [state.date];
  else if (v === 'days') days = Array.from({ length: nDays() }, (_, i) => addDaysYmd(state.date, i));
  else if (v === 'week') {
    const start = ymd(startOfWeek(d, s.weekStart));
    days = Array.from({ length: 7 }, (_, i) => addDaysYmd(start, i));
  } else if (v === 'month') {
    const first = startOfMonth(d);
    const gridStart = startOfWeek(first, s.weekStart);
    const weeks = Math.ceil((diffDays(gridStart, first) + daysInMonth(first.getFullYear(), first.getMonth())) / 7);
    days = Array.from({ length: weeks * 7 }, (_, i) => ymd(addDays(gridStart, i)));
  } else if (v === 'year') {
    const y = d.getFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31`, days: [] };
  } else days = Array.from({ length: state.agendaSpan }, (_, i) => addDaysYmd(state.date, i));
  return { from: days[0], to: days.at(-1), days };
}

/** "November 2026" with the year muted (HTML), or plain text. */
function rangeTitle(plain = false) {
  const v = effView();
  const d = parseYmd(state.date);
  const t = (x) => (plain ? String(x) : esc(x));
  const yr = (y) => (plain ? ` ${y}` : ` <span>${esc(y)}</span>`);
  if (v === 'year') return t(d.getFullYear());
  if (v === 'day') return `${t(fmt(d, { month: 'long', day: 'numeric' }))},${yr(d.getFullYear())}`;
  if (v === 'month' || v === 'agenda') return `${t(fmt(d, { month: 'long' }))}${yr(d.getFullYear())}`;
  const { from, to } = range();
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${t(fmt(a, { month: 'long' }))}${yr(a.getFullYear())}`;
  if (a.getFullYear() === b.getFullYear()) return `${t(fmt(a, { month: 'short' }))} – ${t(fmt(b, { month: 'short' }))}${yr(b.getFullYear())}`;
  return t(`${fmt(a, { month: 'short', year: 'numeric' })} – ${fmt(b, { month: 'short', year: 'numeric' })}`);
}

function step(dir) {
  const v = effView();
  const d = parseYmd(state.date);
  const inView = viewEl.contains(document.activeElement);
  if (v === 'month') state.date = ymd(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  else if (v === 'year') state.date = ymd(new Date(d.getFullYear() + dir, 0, 1));
  else state.date = addDaysYmd(state.date, dir * (v === 'day' ? 1 : v === 'days' ? nDays() : v === 'week' ? 7 : 30));
  state.month = null;
  state.agendaSpan = 60;
  render();
  // Focus was on an item of the range just left (j / k): it stays in the view, on the new range's first day.
  if (inView && !viewEl.contains(document.activeElement)) $('[data-goto-day]:not([tabindex="-1"])', viewEl)?.focus({ preventScroll: true });
}

function goToday() {
  state.date = todayYmd();
  state.month = null;
  state.scrolledOnce = false;
  state.agendaSpan = 60;
  render();
  // The Schedule view starts today: Today goes back to its top (it is redrawn in place, keeping its scroll).
  $('.agenda', viewEl)?.scrollTo({ top: 0, behavior: smooth() });
}

function goDay(d) {
  if (!isYmd(d)) return;
  state.date = d;
  state.month = null;
  setView('day');
}

function setView(v) {
  if (!VIEWS.some((x) => x.id === v)) return;
  state.view = v;
  if (settings.get().scheduleView !== v) settings.set({ scheduleView: v });
  else render();
}

function syncHash() {
  const h = `#/${state.view}/${state.date}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

/** The day new things default to: the focused date when it's on screen, else today. */
function focusDate() {
  const { days } = range();
  const today = todayYmd();
  if (effView() === 'day') return state.date;
  return days.includes(today) || effView() === 'year' ? today : days[0] || state.date;
}

// ---------------------------------------------------------------- drawer & Tasks sheet (modal layers)

// Up to 900px the sidebar is a drawer over the page, and on a phone the Tasks panel is a sheet over the
// calendar. Each is then a modal dialog: everything behind it is inert (out of the Tab order, the
// accessibility tree and the pointer's reach), focus moves in and stays in, and Esc, the scrim, × or a pick
// closes it, focus going back to the button that opened it. From 641px the Tasks panel sits beside the
// calendar, which moves over for it, so it covers nothing (tasks can be dragged onto every day); from 901 to
// 1280px it takes the sidebar's place, as Tasks' details pane does, so the days keep room to be read.
const narrowMq = matchMedia('(max-width: 900px)');
const midMq = matchMedia('(min-width: 901px) and (max-width: 1280px)');
const phoneMq = matchMedia('(max-width: 640px)');
let drawer = null; // { opener } while the drawer is open
let panelOpener = null; // { el, tok }: what had focus when the Tasks panel was opened
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]';
/** What Tab reaches in `root`: shown, enabled and in the tab order. */
const tabbables = (root) => $$(TABBABLE, root).filter((n) => n.tabIndex >= 0 && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
const usableFocus = (el) => !!el && el !== document.body && el.isConnected && !el.closest('[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const panelSheet = () => !panelEl.hidden && phoneMq.matches;
/** Controls on which the arrow keys still step the range: the range's own Today, Previous and Next. */
const FREE_KEYS = '#topbar .nav-arrows, #topbar [data-today]';

function syncLayers() {
  const sheet = panelSheet();
  if (sheet) {
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-modal', 'true');
  } else {
    panelEl.removeAttribute('role');
    panelEl.removeAttribute('aria-modal');
  }
  for (const n of [$('#main'), $('#tabbar'), $('.fab', shellEl)]) if (n) n.inert = sheet || !!drawer;
  $('#sidebar').inert = sheet && !drawer;
  panelEl.inert = !!drawer && !sheet;
  // The sheet takes focus itself, so no keyboard pops up (unless a menu or card opened from it has focus).
  if (sheet && !panelEl.contains(document.activeElement) && !hasOpenLayer()) panelEl.focus({ preventScroll: true });
}

/** Wide windows: the sidebar shows unless hidden by the user (Mod+\) or by the open Tasks panel (901–1280px). */
const sidebarShown = () => !narrowMq.matches && !settings.get().scheduleNavCollapsed && !(state.panel && midMq.matches);

/**
 * The menu button. Narrow, it opens the drawer (a dialog): expanded while it is open, with the menu glyph.
 * Wide, it hides or shows the sidebar and is named for that, with the sidebar glyph, as in Tasks and Notes
 * (no expanded state: the shell shows no tooltip on an expanded button, and the tooltip teaches Mod+\).
 */
function syncNavToggle() {
  const narrowNav = narrowMq.matches;
  const name = narrowNav ? 'Main menu' : sidebarShown() ? 'Hide sidebar' : 'Show sidebar';
  const glyph = narrowNav ? 'menu' : 'sidebar';
  for (const b of $$('[data-nav-toggle]')) {
    if (narrowNav) {
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-expanded', String(!!drawer));
    } else {
      b.removeAttribute('aria-haspopup');
      b.removeAttribute('aria-expanded');
    }
    b.setAttribute('aria-label', name);
    b.dataset.tip = name;
    if (b.dataset.glyph !== glyph) {
      b.innerHTML = icon(glyph);
      b.dataset.glyph = glyph;
    }
  }
}

/**
 * The menu button and Mod+\: the drawer when narrow; when wide, hide or show the sidebar (and keep it so).
 * From 901 to 1280px the open Tasks panel holds the sidebar's place: showing the sidebar closes it, as
 * showing Tasks' sidebar closes its details pane. `from` is the button pressed, if any.
 */
function toggleSidebar(from = null) {
  if (narrowMq.matches) {
    // Over the phone's Tasks sheet, the sheet closes first: two modal layers never stack.
    if (!drawer && panelSheet()) togglePanel(false);
    return drawer ? closeDrawer() : openDrawer(from);
  }
  if (sidebarShown()) {
    if ($('#sidebar').contains(document.activeElement)) $('#topbar [data-nav-toggle]')?.focus({ preventScroll: true });
    return settings.set({ scheduleNavCollapsed: true });
  }
  if (state.panel && midMq.matches) togglePanel(false);
  if (settings.get().scheduleNavCollapsed) settings.set({ scheduleNavCollapsed: false });
}

/** Open the drawer (≤900px). `opener` (the button pressed: Safari doesn't focus a tapped button) gets focus back. */
function openDrawer(opener = null) {
  if (drawer || !narrowMq.matches) return;
  const side = $('#sidebar');
  drawer = { opener: opener || document.activeElement };
  shellEl.classList.add('nav-open');
  side.setAttribute('role', 'dialog');
  side.setAttribute('aria-modal', 'true');
  syncLayers();
  syncNavToggle();
  requestAnimationFrame(() => drawer && ($('#side-views [aria-current="true"]', side) || tabbables(side)[0])?.focus({ preventScroll: true }));
}

/** Close the drawer. Focus goes back to its button, unless it already moved on (a dialog opened from it took it). */
function closeDrawer({ restoreFocus = true } = {}) {
  if (!drawer && !shellEl.classList.contains('nav-open')) return;
  const opener = drawer?.opener;
  drawer = null;
  const side = $('#sidebar');
  shellEl.classList.remove('nav-open');
  side.removeAttribute('role');
  side.removeAttribute('aria-modal');
  syncLayers();
  syncNavToggle();
  const a = document.activeElement;
  if (!restoreFocus || (a && a !== document.body && !side.contains(a))) return;
  (usableFocus(opener) ? opener : $('#topbar [data-nav-toggle]'))?.focus({ preventScroll: true });
}

/** Tab past either end of an open drawer or sheet wraps to its other end (the page behind is inert). */
function trapTab(e, root) {
  if (e.key !== 'Tab') return;
  const f = tabbables(root);
  if (!f.length) return;
  const a = document.activeElement;
  if (e.shiftKey ? a === f[0] || a === root : a === f.at(-1)) {
    e.preventDefault();
    (e.shiftKey ? f.at(-1) : f[0]).focus();
  }
}

/**
 * Show or hide the Tasks panel. Opened by a person (`focus`), the phone's sheet takes focus (the panel itself,
 * so no keyboard pops up and `i` still closes it); beside the calendar the panel takes it only when a button or
 * a focused control opened it: `i` with nothing focused leaves focus on the page, where the arrow keys keep
 * stepping the range. Closed while focus was in it, focus goes back to what opened it.
 */
function togglePanel(on = !state.panel, { from = null, focus = true } = {}) {
  // A sheet holds focus while open (a press on its scrim drops it to the page first).
  const hadFocus = panelSheet() || panelEl.contains(document.activeElement);
  if (on && !state.panel) {
    const el = from || document.activeElement;
    panelOpener = { el, tok: focusToken(el) };
  }
  state.panel = on;
  // Remember the choice on wide screens only: on a laptop the panel takes the calendar's room, on a phone it covers it.
  if (innerWidth > 1280 && !!settings.get().schedulePanel !== on) settings.set({ schedulePanel: on });
  else render();
  if (!focus) return;
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (on) {
      // From the page: `i` with nothing focused, or on the range's own Today / Previous / Next, where the arrow
      // keys step the range too (a control in the sidebar, which the panel may now hide, is not the page).
      const o = panelOpener?.el;
      const fromPage = !from && (!o || o === document.body || !!o.closest?.(FREE_KEYS));
      if (!panelEl.hidden && !panelEl.contains(a) && !hasOpenLayer() && (panelSheet() || !fromPage)) panelEl.focus({ preventScroll: true });
      return;
    }
    if (!hadFocus || !panelEl.hidden || (a && a !== document.body && !panelEl.contains(a))) return;
    const o = panelOpener;
    // A render may have replaced the opener (the tab bar's Tasks button): find it again by what it is.
    const again = o?.tok && document.getElementById(o.tok.root)?.querySelector(sel(o.tok.name, o.tok.value));
    [o?.el, again, $('#tabbar [data-tab="tasks"]'), $('#topbar [data-toggle-panel]')].find((x) => usableFocus(x) && !panelEl.contains(x))?.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------- chrome

// The mini month's dots (iOS) and the Year view's: the days that have plans, by the rule Home's mini month
// uses too (busyDays: events of the calendars shown, open time-blocked tasks). The last few ranges are kept
// until the data changes, as the arrow keys and stepping back and forth redraw the same months.
let busyMemo = new Map();
function markedDays(from, to, s) {
  const k = `${from}|${to}`;
  let days = busyMemo.get(k);
  if (!days) {
    days = busyDays(from, to, s);
    busyMemo.set(k, days);
    if (busyMemo.size > 4) busyMemo.delete(busyMemo.keys().next().value);
  }
  return days;
}

function renderSidebar() {
  const s = settings.get();
  shellEl.classList.toggle('nav-collapsed', !!s.scheduleNavCollapsed && innerWidth > 900);
  syncNavToggle();
  const v = effView();
  const { from, to } = range();
  const month = state.month || parseYmd(state.date);
  const ranged = v === 'week' || v === 'days';
  // The mini month's one tab stop: the day last moved to with the keys, else the date in focus (after j / k, t,
  // g or a link moved the range), whichever is in the month shown; else that month's first day.
  const inMonth = (k) => {
    const d = parseYmd(k);
    return d.getMonth() === month.getMonth() && d.getFullYear() === month.getFullYear();
  };
  const focusDay = [state.miniFocus, state.date].find((k) => isYmd(k) && inMonth(k)) || ymd(startOfMonth(month));
  // In the drawer (narrow windows and phones, where the top bar has no view switcher), every view is listed
  // first, as in Google Calendar. On a phone Week shows a few days, so it isn't listed beside "N days".
  const views = $('#side-views');
  views.hidden = innerWidth > 900;
  if (!views.hidden) {
    const list = VIEWS.filter((x) => !(narrow() && x.id === 'week'));
    setHTML(views, `${list.map((x) => `<button type="button" class="nav-item" data-view="${x.id}" aria-current="${v === x.id}">${icon(x.icon)}<span class="label">${esc(capital(viewLabel(x)))}</span></button>`).join('')}<div class="nav-sep" role="presentation"></div>`);
  }
  const gridFrom = ymd(startOfWeek(startOfMonth(month), s.weekStart)); // the mini month's first cell (it shows up to 6 weeks)
  setHTML(
    $('#minical'),
    miniCalendar({ month, selected: state.date, weekStart: s.weekStart, rangeFrom: ranged ? from : null, rangeTo: ranged ? to : null, compact: true, showToday: false, focusDate: focusDay, marks: markedDays(gridFrom, addDaysYmd(gridFrom, 41), s), markLabel: 'has plans' }),
  );
  const row = ({ attrs, color, label, checked, more, round = false }) =>
    `<div class="cal-row"><button type="button" class="cal-item${round ? ' round' : ''}" role="checkbox" aria-checked="${!!checked}" ${attrs} style="--cc:${color}"><span class="cal-box">${icon('check')}</span><span class="label">${esc(label)}</span></button>${more}</div>`;
  setHTML(
    $('#cal-list'),
    calsSorted()
      .map((c) =>
        row({
          attrs: `data-cal-toggle="${esc(c.id)}"`,
          color: colorVar(c.color),
          label: c.name,
          checked: c.visible !== false,
          more: `<button type="button" class="icon-btn sm more" data-cal-menu="${esc(c.id)}" aria-label="${esc(`Options for ${c.name}`)}" aria-haspopup="menu" ${tipAttrs('Options')}>${icon('more', { size: 16 })}</button>`,
        }),
      )
      .join('') +
      row({
        attrs: 'data-toggle-tasks',
        color: 'var(--c-graphite)',
        label: 'Tasks',
        checked: !!s.showTasksInSchedule,
        round: true,
        more: `<button type="button" class="icon-btn sm more" data-tasks-menu aria-label="Task lists shown on the calendar" aria-haspopup="menu" ${tipAttrs('Task lists')}>${icon('more', { size: 16 })}</button>`,
      }),
  );
}

const TABS = [
  { id: 'days', label: 'Days', icon: 'calendar', on: (v) => v === 'day' || v === 'days' || v === 'week' },
  { id: 'month', label: 'Month', icon: 'calendar-month', on: (v) => v === 'month' || v === 'year' },
  { id: 'agenda', label: 'Schedule', icon: 'list', on: (v) => v === 'agenda' },
];

function renderTopbar() {
  const v = effView();
  const title = $('#range-title');
  setHTML(title, rangeTitle());
  title.setAttribute('aria-label', `${rangeTitle(true)}. Go to date`);
  const vName = capital(viewLabel(VIEWS.find((x) => x.id === v)));
  setHTML($('#view-btn'), `<span>${esc(vName)}</span>${icon('chevron-down', { size: 16 })}`);
  $('#view-btn').setAttribute('aria-label', `View: ${vName}`);
  viewEl.setAttribute('aria-label', `${vName}, ${rangeTitle(true)}`);
  const pb = $('#topbar [data-toggle-panel]');
  pb.classList.toggle('active', state.panel);
  pb.setAttribute('aria-pressed', String(state.panel));
  $('#topbar [data-today]').dataset.tip = capital(longDay(todayYmd()));
  document.title = `${fmt(parseYmd(state.date), { month: 'long', year: 'numeric' })} · schedule`;
  setHTML(
    $('#tabbar'),
    TABS.map((t) => `<button type="button" data-tab="${t.id}" aria-current="${t.on(v)}">${icon(t.icon)}<span>${t.label}</span></button>`).join('') +
      `<button type="button" data-tab="tasks" aria-pressed="${state.panel}">${icon('checklist')}<span>Tasks</span></button>`,
  );
}

// ---------------------------------------------------------------- labels shared by the views and cards

function whenText(inst) {
  if (inst.allDay) {
    const a = ymd(inst.start);
    const b = ymd(inst.end);
    return a === b ? capital(longDay(a)) : `${fmt(inst.start, { month: 'long', day: 'numeric' })} – ${fmt(inst.end, { month: 'long', day: 'numeric' })}`;
  }
  const first = ymd(inst.start);
  if (first === lastDayOf(inst)) return `${capital(longDay(first))} · ${fmtTimeRange(inst.start, inst.end)}`;
  return `${shortDay(first)}, ${fmtClock(inst.start)} – ${shortDay(ymd(inst.end))}, ${fmtClock(inst.end)}`;
}
const evLabel = (i) => `${untitled(i.event.title)}, ${whenText(i)}${i.calendar ? `, ${i.calendar.name}` : ''}`;
const taskWhen = (t, s = settings.get()) =>
  t.date ? `${capital(longDay(t.date))}${t.time ? ` · ${fmtTimeRange(t.time, fromMinutes(toMinutes(t.time) + (t.duration || s.defaultTaskMinutes || 30)))}` : ''}` : 'No date';

function dayHeadHtml(d, today, noteDays) {
  const dt = parseYmd(d);
  const note = noteDays.has(d) ? `<a class="day-note" href="${esc(notesHref.day(d))}" aria-label="${esc(`Daily note, ${longDay(d)}`)}" ${tipAttrs('Daily note')}>${icon('note', { size: 14 })}</a>` : '';
  return `<div class="day-head${d === today ? ' today' : ''}${d < today ? ' past' : ''}"><button type="button" class="dh-btn" data-goto-day="${esc(d)}" aria-label="${esc(longDay(d))}"${d === today ? ' aria-current="date"' : ''}><span class="dow">${esc(WEEKDAY_SHORT[dt.getDay()])}</span><span class="dnum">${dt.getDate()}</span></button>${note}</div>`;
}

// ---------------------------------------------------------------- time grid (day / N days / week)

function renderGrid(days) {
  const s = settings.get();
  const from = days[0];
  const to = days.at(-1);
  const n = days.length;
  const inst = instancesOf(from, to);
  const tasks = scheduledTasks(from, to, s);
  const lists = listMap();
  const today = todayYmd();
  const now = new Date();
  const nowMins = clock(now);
  const showNow = days.includes(today);
  const noteDays = dayNoteDays();
  instMap = new Map(inst.map((i) => [i.key, i]));
  const byDay = bucketDays(inst, days);
  const tasksOn = tasksByDay(tasks);

  const head = days.map((d) => dayHeadHtml(d, today, noteDays)).join('');

  // All-day lanes: all-day and multi-day events span their columns; untimed tasks sit in their day.
  const adItems = [];
  for (const i of inst) {
    if (!i.allDay && !longTimed(i)) continue;
    const endYmd = lastDayOf(i);
    const a = Math.max(0, diffDays(from, ymd(i.start)));
    const b = Math.min(n - 1, diffDays(from, endYmd));
    if (b < 0 || a > n - 1) continue;
    adItems.push({ kind: 'event', i, a, b, contL: ymd(i.start) < from, contR: endYmd > to });
  }
  for (const t of tasks) {
    if (t.time) continue;
    const a = diffDays(from, t.date);
    if (a >= 0 && a < n) adItems.push({ kind: 'task', t, a, b: a });
  }
  adItems.sort((x, y) => x.a - y.a || y.b - y.a - (x.b - x.a) || (x.kind === 'task') - (y.kind === 'task'));
  const lanes = [];
  for (const it of adItems) {
    let l = lanes.findIndex((lane) => lane.every((o) => o.b < it.a || o.a > it.b));
    if (l < 0) {
      l = lanes.length;
      lanes.push([]);
    }
    lanes[l].push(it);
    it.lane = l;
  }
  const maxLanes = state.alldayOpen ? lanes.length : 3;
  const shownLanes = lanes.length > maxLanes ? maxLanes - 1 : lanes.length;
  const hiddenPerDay = new Array(n).fill(0);
  let adHtml = '';
  for (const it of adItems) {
    if (it.lane >= shownLanes) {
      for (let c = it.a; c <= it.b; c++) hiddenPerDay[c]++;
      continue;
    }
    const pos = `left:calc(${(it.a / n) * 100}% + 3px);width:calc(${((it.b - it.a + 1) / n) * 100}% - 6px);top:${it.lane * 24 + 3}px`;
    if (it.kind === 'event') {
      const i = it.i;
      const title = untitled(i.event.title);
      const time = i.allDay ? '' : `<span class="tm">${esc(fmtClock(i.start))}</span>`;
      adHtml += `<div class="ad-item${it.contL ? ' cont-l' : ''}${it.contR ? ' cont-r' : ''}" data-ev="${esc(i.key)}" ${itemA11y(evLabel(i))} ${tipAttrs(title)} style="--ev:${colorVar(i.color)};${pos}">${time}<span class="t">${esc(title)}</span></div>`;
    } else {
      const t = it.t;
      adHtml += `<div class="ad-item task${t.done ? ' done' : ''}" data-task="${esc(t.id)}" ${taskA11y(`${t.title}, ${dayLabel(t.date)}`)} ${tipAttrs(t.title)} draggable="true" style="--ev:${taskColor(t, lists)};${pos}">${checkBtn(t, 9)}<span class="t">${esc(t.title)}</span></div>`;
    }
  }
  hiddenPerDay.forEach((count, c) => {
    if (count) adHtml += `<button type="button" class="ad-more" data-expand-allday style="left:calc(${(c / n) * 100}% + 3px);top:${shownLanes * 24 + 4}px">${count} more</button>`;
  });
  if (state.alldayOpen && lanes.length > 3) adHtml += `<button type="button" class="ad-more" data-expand-allday style="right:4px;top:${lanes.length * 24 + 3}px">Show less</button>`;
  const adHeight = Math.max(28, (lanes.length > maxLanes ? shownLanes + 1 : shownLanes) * 24 + 6 + (state.alldayOpen && lanes.length > 3 ? 22 : 0));

  // Hour labels; the one the now label would sit on is hidden while it does.
  let gutter = '';
  for (let h = 1; h < 24; h++) gutter += `<span class="hr${showNow && nearNow(h, nowMins) ? ' near-now' : ''}" data-h="${h}" style="top:calc(var(--hour) * ${h})">${esc(hourLabel(h))}</span>`;

  const nowMs = now.getTime();
  const cols = days
    .map((d) => {
      const dayStart = parseYmd(d);
      const dayEnd = addDays(dayStart, 1);
      // Short items are drawn (and laid out) at least MIN_VIS minutes long; realBottom keeps the stored
      // length for dragging and resizing.
      const items = byDay.get(d).timed.map((i) => ({ ...i, kind: 'event', realBottom: i.bottom, bottom: visualBottom(i.top, i.bottom) }));
      for (const t of tasksOn.get(d) || []) {
        if (!t.time) continue;
        const b = taskBlock(t, s);
        items.push({ kind: 'task', t, top: b.top, realBottom: b.bottom, bottom: visualBottom(b.top, b.bottom) });
      }
      const laid = layoutColumns(items);
      const blocks = laid.map((it) => blockHtml(it, dayStart, dayEnd, lists, nowMs, laid)).join('');
      const nowLine = d === today ? `<div class="now-line" style="top:calc(var(--hour) * ${nowMins / 60})" aria-hidden="true"></div>` : '';
      return `<div class="col${d === today ? ' today' : ''}" data-date="${esc(d)}">${blocks}${nowLine}</div>`;
    })
    .join('');
  const nowLabel = showNow ? `<div class="now-label" style="top:calc(var(--hour) * ${nowMins / 60})" aria-hidden="true">${esc(nowText(now))}</div>` : '';
  const nowRule = showNow ? `<div class="now-rule" style="top:calc(var(--hour) * ${nowMins / 60})" aria-hidden="true"></div>` : '';

  const prevScroll = $('.grid-scroll', viewEl)?.scrollTop;
  viewEl.innerHTML = `
    <div class="grid-head${n === 1 ? ' single' : ''}" style="--days:${n}"><div class="gutter-head"></div>${head}</div>
    <div class="allday" style="--days:${n}"><div class="gutter-label">all-day</div>
      <div class="allday-lanes" style="height:${adHeight}px"><div class="allday-cells">${days.map((d) => `<div data-allday-date="${esc(d)}"></div>`).join('')}</div>${adHtml}</div></div>
    <div class="grid-scroll"><div class="grid-body" style="--days:${n}"><div class="gutter" aria-hidden="true">${gutter}${nowLabel}</div>${cols}${nowRule}</div></div>`;
  const scroller = $('.grid-scroll', viewEl);
  if (!state.scrolledOnce || prevScroll === undefined) {
    // A quarter hour above the day's start, so its hour label (centred on the line) isn't cut in half.
    scroller.scrollTop = (showNow ? Math.max(0, nowMins / 60 - 2.5) : (s.dayStartHour ?? 8) - 0.25) * hourPx();
    state.scrolledOnce = true;
  } else scroller.scrollTop = prevScroll;
}

/**
 * A block's time: the range, or just the start where the block is too narrow for the range (fitTimes picks
 * one, or neither), so a time is never cut off part-way ('1:…').
 */
const timeHtml = (a, b) => `<span class="t-range">${esc(fmtTimeRange(a, b))}</span><span class="t-start">${esc(fmtClock(a))}</span>`;
/**
 * A block's shape by its drawn length in minutes: short ones (under 45) are one line, tiny ones (under 25) in
 * smaller type; mid-length ones (45–89) have room for a title line above the time; longer ones for more.
 */
const blockSize = (dur) => ({ short: dur < 45, tiny: dur < 25, mid: dur >= 45 && dur < 90 });

function blockHtml(it, dayStart, dayEnd, lists, nowMs, items = []) {
  const dur = it.bottom - it.top; // the drawn length (at least MIN_VIS)
  const { short, tiny, mid } = blockSize(dur);
  const { left, width } = blockBox(it, items);
  const pos = `top:calc(var(--hour) * ${it.top / 60} + 1px);height:calc(var(--hour) * ${dur / 60} - 2px);left:calc(${left}% + 1px);width:calc(${width}% - 5px);z-index:${2 + it.col}`;
  const realBottom = it.realBottom ?? it.bottom;
  if (it.kind === 'event') {
    const e = it.event;
    const title = untitled(e.title);
    const contTop = it.start < dayStart;
    const contBottom = it.end > dayEnd;
    const cls = ['ev', short && 'short', tiny && 'tiny', mid && 'mid', it.end.getTime() < nowMs && 'past', contTop && 'cont-top', contBottom && 'cont-bottom'].filter(Boolean).join(' ');
    // A short block is one line: title, then the start time if all of it fits beside the title.
    const body = short
      ? `<div class="ev-line"><div class="ev-title">${esc(title)}</div>${it.cols > 1 ? '' : `<div class="ev-time">${esc(fmtClock(it.start))}</div>`}</div>`
      : `<div class="ev-title">${esc(title)}</div><div class="ev-time">${timeHtml(it.start, it.end)}</div>${!mid && e.location ? `<div class="ev-loc">${esc(e.location)}</div>` : ''}`;
    // Only the piece that holds the real end can be resized.
    const resize = contBottom ? '' : '<div class="ev-resize" data-resize aria-hidden="true"></div>';
    return `<div class="${cls}" data-ev="${esc(it.key)}" data-top="${it.top}" data-bottom="${realBottom}" data-end="${it.end.getTime()}" ${itemA11y(evLabel(it))}${short ? ` ${tipAttrs(title)}` : ''} style="--ev:${colorVar(it.color)};${pos}">${body}${resize}</div>`;
  }
  const t = it.t;
  const a = fromMinutes(it.top);
  const b = fromMinutes(realBottom);
  // Mid-length, like an event: the title on one line above the time (two, without the time, where it can't fit).
  const cls = ['ev', 'task-block', short && 'short', tiny && 'tiny', mid && 'mid', t.done && 'done'].filter(Boolean).join(' ');
  return `<div class="${cls}" data-task="${esc(t.id)}" data-top="${it.top}" data-bottom="${realBottom}" ${taskA11y(`${t.title}, ${fmtTimeRange(a, b)}`)}${short ? ` ${tipAttrs(t.title)}` : ''} style="--ev:${taskColor(t, lists)};${pos}">${checkBtn(t)}<div class="tb-text"><div class="ev-title">${esc(t.title)}</div>${short ? '' : `<div class="ev-time">${timeHtml(a, b)}</div>`}</div><div class="ev-resize" data-resize aria-hidden="true"></div></div>`;
}

/**
 * A block's time shows whole or not at all: the range where it fits, else the start time, else nothing
 * (then a mid-length block's title may take a second line). A time a title pushes below the block goes too.
 * One read pass over every block (the range, the start, the room for them, the title's lines, where the time
 * ends), then one write pass: a week of a busy calendar was laid out four times. `block`: fit just that one
 * (a ghost, a block being dragged); by default the whole view.
 */
function fitTimes(block = null) {
  // Narrow day columns (phones, a laptop with the Tasks panel open) give a mid-length block's title two lines
  // instead of a cut-off time when it doesn't fit on one, and all-day task pills their whole width (Apple, Google).
  // Tight ones (under 66px: the panel open on a small laptop) also lose the day head's note mark.
  if (!block) {
    const w = $('.grid-body .col', viewEl)?.getBoundingClientRect().width ?? 999;
    viewEl.classList.toggle('narrow-cols', w < 120);
    viewEl.classList.toggle('tight-cols', w < 66);
  }
  const narrowCols = viewEl.classList.contains('narrow-cols');
  const times = (block ? [$('.ev-time', block)] : $$('.ev-time', viewEl)).filter((t) => t?.querySelector('.t-range') && t.closest('.ev'));
  // A block fitted before (a ghost being resized) starts again from its full time. Blocks just drawn have none.
  for (const t of times) {
    const ev = t.closest('.ev');
    if (ev.classList.contains('start-only') || ev.classList.contains('no-time')) ev.classList.remove('start-only', 'no-time');
  }
  // Read: widths in fractions of a pixel (scrollWidth and clientWidth are rounded, so a time up to 1px too wide
  // kept its ellipsis). The start is measurable while hidden (schedule.css), and sits on the range's line.
  const fits = times.map((t) => {
    const ev = t.closest('.ev');
    const box = t.getBoundingClientRect();
    const title = $('.ev-title', ev);
    return {
      ev,
      // A mid-length block in narrow columns whose title doesn't fit on one line takes two, and no time.
      twoLines: narrowCols && ev.classList.contains('mid') && !!title && title.scrollHeight > title.clientHeight + 0.5,
      range: $('.t-range', t).getBoundingClientRect().width <= box.width + 0.01,
      start: $('.t-start', t)?.getBoundingClientRect().width <= box.width + 0.01,
      // A title on two lines can push the time below the block's bottom edge: then it goes.
      below: box.bottom > ev.getBoundingClientRect().bottom - 1,
    };
  });
  // Write.
  for (const f of fits) {
    if (f.twoLines || f.below || (!f.range && !f.start)) f.ev.classList.add('no-time');
    else if (!f.range) f.ev.classList.add('start-only');
  }
}

/** Move the now line, its label and the past state of events without re-rendering (every minute). */
function updateNow() {
  const now = new Date();
  const mins = clock(now);
  const top = `calc(var(--hour) * ${mins / 60})`;
  for (const el of $$('.now-line, .now-rule, .now-label', viewEl)) el.style.top = top;
  const label = $('.now-label', viewEl);
  if (label) label.textContent = nowText(now);
  for (const h of $$('.gutter .hr', viewEl)) h.classList.toggle('near-now', !!label && nearNow(+h.dataset.h, mins));
  const ms = now.getTime();
  for (const el of $$('[data-end]', viewEl)) el.classList.toggle('past', +el.dataset.end < ms);
}

// ---------------------------------------------------------------- month (Google)

/**
 * A day's items for a month cell or its "more" list: all-day events, untimed tasks, then everything timed by
 * start time. `slot` is the day's {allDay, timed} (bucketDays) and `tasks` the tasks dated that day.
 */
function dayItems(d, slot, tasks, lists, { col = null } = {}) {
  const nowMs = Date.now();
  const { allDay, timed } = slot;
  const dayTasks = [...tasks].sort(byTimeThenOrder);
  const taskItem = (t) =>
    `<div class="mitem task${t.done ? ' done' : ''}" data-task="${esc(t.id)}" ${taskA11y(`${t.title}, ${taskWhen(t)}`)} ${tipAttrs(t.title)} draggable="true" style="--ev:${taskColor(t, lists)}">${checkBtn(t, 8)}${t.time ? `<span class="t">${esc(fmtClock(t.time))}</span>` : ''}<span class="n">${esc(t.title)}</span></div>`;
  const timedItems = [
    ...timed.map((i) => {
      const title = untitled(i.event.title);
      // On the days after an overnight event's start it shows when it ends ("until 6:30am", Apple).
      const t = ymd(i.start) < d ? `until ${fmtClock(i.end)}` : fmtClock(i.start);
      return { m: i.top, html: `<div class="mitem${i.end.getTime() < nowMs ? ' past' : ''}" data-ev="${esc(i.key)}" data-end="${i.end.getTime()}" ${itemA11y(evLabel(i))} ${tipAttrs(title)} style="--ev:${colorVar(i.color)}"><span class="dot" aria-hidden="true"></span><span class="t">${esc(t)}</span><span class="n">${esc(title)}</span></div>` };
    }),
    ...dayTasks.filter((t) => t.time).map((t) => ({ m: toMinutes(t.time), html: taskItem(t) })),
  ].sort((a, b) => a.m - b.m); // stable: an event and a task at the same time keep that order
  return [
    ...allDay.map((i) => {
      const first = ymd(i.start);
      const last = lastDayOf(i);
      const contL = col !== null && first < d && col !== 0;
      const contR = col !== null && last > d && col !== 6;
      const title = untitled(i.event.title);
      // A bar shows its title where it starts and at the start of each week row.
      const label = col === null || !contL ? `<span class="n">${esc(title)}</span>` : '';
      return `<div class="mitem allday${contL ? ' cont-l' : ''}${contR ? ' cont-r' : ''}" data-ev="${esc(i.key)}" ${itemA11y(evLabel(i))} ${tipAttrs(title)} style="--ev:${colorVar(i.color)}">${label}</div>`;
    }),
    ...dayTasks.filter((t) => !t.time).map(taskItem),
    ...timedItems.map((x) => x.html),
  ];
}

function renderMonth(days) {
  const s = settings.get();
  const inst = instancesOf(days[0], days.at(-1));
  const tasks = scheduledTasks(days[0], days.at(-1), s);
  const lists = listMap();
  const today = todayYmd();
  const cur = parseYmd(state.date).getMonth();
  const noteDays = dayNoteDays();
  instMap = new Map(inst.map((i) => [i.key, i]));
  const byDay = bucketDays(inst, days);
  const tasksOn = tasksByDay(tasks);
  const weeks = days.length / 7;
  const head = Array.from({ length: 7 }, (_, i) => {
    const wd = (s.weekStart + i) % 7;
    return `<span role="columnheader" aria-label="${esc(WEEKDAY_LONG[wd])}">${esc(WEEKDAY_SHORT[wd])}</span>`;
  }).join('');
  // A grid (rows of day cells) with one tab stop for its days, like the Year view: arrow keys move between
  // days, Tab goes on to the focused day's items. The tab stop is the day last moved to, else today, else
  // the date in focus (when they are in the month shown).
  const focusDay = [state.monthFocus, today, state.date].find((k, i) => isYmd(k) && days.includes(k) && (i === 0 || parseYmd(k).getMonth() === cur)) || ymd(startOfMonth(parseYmd(state.date)));
  // Lay out the empty grid first and measure a row (the phone tab bar's space and safe area included),
  // so a cell shows only the items that fit and folds the rest into "N more".
  viewEl.innerHTML = `<div class="month" role="grid" aria-label="${esc(rangeTitle(true))}"><div class="month-head" role="row">${head}</div><div class="month-grid" role="rowgroup" style="grid-template-rows:repeat(${weeks},minmax(0,1fr))"></div></div>`;
  const grid = $('.month-grid', viewEl);
  const cellH = grid.clientHeight / weeks;
  // A cell's chrome: padding 4 + 2, the day number 24 + 2, the border 1 (phones: 2 + 1, 24 + 2, 1); then
  // 21px rows with a 1px gap (phones: 17 + 1).
  const cap = Math.max(1, Math.floor((cellH - (narrow() ? 30 : 33)) / (narrow() ? 18 : 22)));
  const cell = (d, idx) => {
    const dt = parseYmd(d);
    const items = dayItems(d, byDay.get(d), tasksOn.get(d) || [], lists, { col: idx % 7 });
    const shown = items.length > cap ? items.slice(0, cap - 1) : items;
    const more = items.length - shown.length;
    const label = dt.getDate() === 1 ? fmt(dt, { month: 'short', day: 'numeric' }) : String(dt.getDate());
    const note = noteDays.has(d) ? `<a class="day-note" href="${esc(notesHref.day(d))}" aria-label="${esc(`Daily note, ${longDay(d)}`)}" ${tipAttrs('Daily note')}>${icon('note', { size: 12 })}</a>` : '';
    return `<div class="mcell${dt.getMonth() !== cur ? ' out' : ''}${d === today ? ' today' : ''}" role="gridcell" data-mdate="${esc(d)}">
        <div class="mhead"><button type="button" class="mnum" data-goto-day="${esc(d)}" aria-label="${esc(longDay(d))}"${d === today ? ' aria-current="date"' : ''}>${esc(label)}</button>${note}</div>
        ${shown.join('')}${more ? `<button type="button" class="mmore" data-day-more="${esc(d)}" aria-label="${esc(`${more} more on ${longDay(d)}`)}">${more} more</button>` : ''}</div>`;
  };
  let rows = '';
  for (let w = 0; w < weeks; w++) rows += `<div class="mrow" role="row">${days.slice(w * 7, w * 7 + 7).map((d, i) => cell(d, w * 7 + i)).join('')}</div>`;
  grid.innerHTML = rows;
  rovingMonth(focusDay);
}

/** The month grid's tab stops: the day number and items of the focused day only. */
function rovingMonth(focusDay) {
  for (const c of $$('.mcell', viewEl)) {
    const on = c.dataset.mdate === focusDay;
    for (const el of $$('button, a[href], [tabindex]', c)) el.tabIndex = on ? 0 : -1;
  }
}

function openDayPopover(d, anchor) {
  const s = settings.get();
  const inst = instancesOf(d, d);
  for (const i of inst) instMap.set(i.key, i);
  const dt = parseYmd(d);
  const items = dayItems(d, bucketDays(inst, [d]).get(d), scheduledTasks(d, d, s), listMap());
  openCard(
    anchor,
    `<div class="dp-date${d === todayYmd() ? ' today' : ''}"><span>${esc(WEEKDAY_SHORT[dt.getDay()])}</span><button type="button" data-goto-day="${esc(d)}" aria-label="${esc(`Open ${longDay(d)}`)}">${dt.getDate()}</button></div><div class="dp-items">${items.join('')}</div>`,
    {
      className: 'day-pop',
      align: 'center',
      label: capital(longDay(d)),
      onMount: (el, close) => {
        const act = (t) => {
          const check = t.closest('[data-task-check]');
          if (check) return completeTask(check.closest('[data-task]')?.dataset.task), true;
          if (t.closest('[data-goto-day]')) return close(), goDay(d), true;
          const ev = t.closest('[data-ev]');
          if (ev) return close(), openEventPopover(ev.dataset.ev, anchor), true;
          const tk = t.closest('[data-task]');
          if (tk) return close(), openTaskPopover(tk.dataset.task, anchor), true;
          return false;
        };
        el.addEventListener('click', (e) => act(e.target));
        el.addEventListener('keydown', (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-ev], [data-task]') && act(e.target)) e.preventDefault();
        });
      },
    },
  );
}

// ---------------------------------------------------------------- year (Apple)

function renderYear() {
  const s = settings.get();
  const y = parseYmd(state.date).getFullYear();
  const today = todayYmd();
  const nowD = new Date();
  // One tab stop for the days (a roving tabindex, like the mini calendar): the day last moved to with the
  // arrow keys, else today, else the focused date.
  const focusKey = [state.yearFocus, today, state.date].find((k) => isYmd(k) && +k.slice(0, 4) === y) || `${y}-01-01`;
  const heads = Array.from({ length: 7 }, (_, i) => `<span class="h" aria-hidden="true">${esc(WEEKDAY_NARROW[(s.weekStart + i) % 7])}</span>`).join('');
  // Busy days get the mini month's grey dot (the same rule: events shown, open time-blocked tasks), once a year.
  const busy = markedDays(`${y}-01-01`, `${y}-12-31`, s);
  let html = '';
  for (let m = 0; m < 12; m++) {
    const first = new Date(y, m, 1);
    const offset = (first.getDay() - s.weekStart + 7) % 7;
    let cells = '';
    for (let i = 0; i < offset; i++) cells += '<span class="ym-day out"></span>';
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const key = `${y}-${pad(m + 1)}-${pad(d)}`;
      const wd = new Date(y, m, d).getDay();
      const planned = busy.has(key);
      cells += `<button type="button" class="ym-day${key === today ? ' today' : ''}${wd % 6 === 0 ? ' weekend' : ''}${planned ? ' busy' : ''}" data-goto-day="${esc(key)}" tabindex="${key === focusKey ? 0 : -1}" aria-label="${esc(longDay(key) + (planned ? ', has plans' : ''))}"${key === today ? ' aria-current="date"' : ''}>${d}</button>`;
    }
    const current = y === nowD.getFullYear() && m === nowD.getMonth();
    html += `<section class="ym${current ? ' current' : ''}"><h2><button type="button" class="ym-title" data-goto-month="${esc(`${y}-${pad(m + 1)}-01`)}" aria-label="${esc(fmt(first, { month: 'long', year: 'numeric' }))}">${esc(fmt(first, { month: 'long' }))}</button></h2><div class="ym-grid">${heads}${cells}</div></section>`;
  }
  viewEl.innerHTML = `<div class="year"><div class="year-grid">${html}</div></div>`;
}

// ---------------------------------------------------------------- schedule / agenda (Google)

// The Schedule view is drawn a week at a time, as it scrolls into view (Google's Schedule loads as you
// scroll): a few screens of rows at once, then the next week each time the end of what is drawn comes
// within AG_AHEAD of the screen; Show more, at the end, adds 60 days. A render redraws only the weeks drawn
// so far, in place, and swaps in only those whose rows changed: a change from another tab, sync or an
// assistant no longer rebuilds months of rows (a big calendar took seconds), and the scroll position stays.
const AG_WEEK = 7; // days in a chunk
const AG_FIRST_ROWS = 50; // rows drawn before any scrolling: a few screens
const AG_AHEAD = 1200; // px below the screen drawn ahead
let agenda = null; // the Schedule view on screen: {from, days, root, inner, tail, ahead, shown, month, io}

/** Instances (added to instMap, for the cards) and tasks of `days`, sorted into those days. */
function agendaData(days, s) {
  const inst = instancesOf(days[0], days.at(-1));
  for (const i of inst) instMap.set(i.key, i);
  return { byDay: bucketDays(inst, days), tasksOn: tasksByDay(scheduledTasks(days[0], days.at(-1), s)) };
}

/**
 * One chunk's rows: the days that have plans (and today), with a heading before the first day shown of each
 * month after `month` (the one the rows before it are in). → {html, month (where the next chunk goes on), rows}
 */
function agendaChunk(days, data, month) {
  const s = settings.get();
  const lists = listMap();
  const today = todayYmd();
  const nowMs = Date.now();
  const mark = (inner) => `<span class="mark">${inner}</span>`;
  const dot = mark('<span class="dot" aria-hidden="true"></span>');
  const where = (x) => (x ? `<span class="where">${esc(x)}</span>` : '');
  // A task's list as Tasks shows it (a coloured dot and its name), so it never reads like an event's place.
  const listOf = (t) => {
    const l = lists.get(t.listId);
    return `<span class="where list">${l ? `<span class="swatch-dot" style="background:${colorVar(l.color)}"></span>` : icon('inbox', { size: 13 })}<span class="truncate">${esc(l ? l.name : 'Inbox')}</span></span>`;
  };
  const taskRow = (t) =>
    `<div class="ag-item task${t.done ? ' done' : ''}" data-task="${esc(t.id)}" ${taskA11y(`${t.title}, ${taskWhen(t, s)}`)}>${mark(checkBtn(t))}<span class="when">${t.time ? esc(fmtClock(t.time) + (t.duration ? ` · ${fmtDuration(t.duration)}` : '')) : '<span class="faint">Any time</span>'}</span><span class="what">${esc(t.title)}</span>${listOf(t)}</div>`;
  let html = '';
  let rows = 0;
  for (const d of days) {
    const { allDay, timed } = data.byDay.get(d);
    const dayTasks = [...(data.tasksOn.get(d) || [])].sort(byTimeThenOrder);
    if (!allDay.length && !timed.length && !dayTasks.length && d !== today) continue;
    const dt = parseYmd(d);
    if (d.slice(0, 7) !== month) {
      month = d.slice(0, 7);
      html += `<h2 class="ag-month">${esc(fmt(dt, { month: 'long', year: 'numeric' }))}</h2>`;
    }
    // All-day events and untimed tasks first, then events and time-blocked tasks together by start time (Google).
    const timedRows = [
      ...timed.map((i) => ({
        m: i.top,
        // The days after an overnight event's start say when it ends, not its start again (Apple).
        html: `<div class="ag-item${i.end.getTime() < nowMs ? ' past' : ''}" data-ev="${esc(i.key)}" data-end="${i.end.getTime()}" ${itemA11y(evLabel(i))} style="--ev:${colorVar(i.color)}">${dot}<span class="when">${ymd(i.start) < d ? `<span class="start">Until ${esc(fmtClock(i.end))}</span>` : `<span class="start">${esc(fmtClock(i.start))}</span><span class="end"> – ${esc(fmtClock(i.end))}</span>`}</span><span class="what">${esc(untitled(i.event.title))}</span>${where(i.event.location)}</div>`,
      })),
      ...dayTasks.filter((t) => t.time).map((t) => ({ m: toMinutes(t.time), html: taskRow(t) })),
    ].sort((a, b) => a.m - b.m);
    const items = [
      ...allDay.map((i) => `<div class="ag-item" data-ev="${esc(i.key)}" ${itemA11y(evLabel(i))} style="--ev:${colorVar(i.color)}">${dot}<span class="when">All day</span><span class="what">${esc(untitled(i.event.title))}</span>${where(i.event.location)}</div>`),
      ...dayTasks.filter((t) => !t.time).map(taskRow),
      ...timedRows.map((x) => x.html),
    ];
    rows += Math.max(1, items.length);
    html += `<div class="ag-day${d === today ? ' today' : ''}"><button type="button" class="ag-date" data-goto-day="${esc(d)}" aria-label="${esc(longDay(d))}"${d === today ? ' aria-current="date"' : ''}><span class="n">${dt.getDate()}</span><span class="w">${esc(fmt(dt, { weekday: 'short' }))}</span></button>
      <div class="ag-items">${items.join('') || '<div class="ag-empty">Nothing planned. Enjoy the open time.</div>'}</div></div>`;
  }
  return { html, month, rows };
}

const agendaChunks = (a) => Math.ceil(a.days.length / AG_WEEK);
const chunkDays = (a, k) => a.days.slice(k * AG_WEEK, (k + 1) * AG_WEEK);

/** Draw the Schedule view's next week (at the end of what is drawn). → the rows it added (0: nothing left). */
function appendAgendaChunk() {
  const a = agenda;
  if (!a?.root.isConnected || a.shown >= agendaChunks(a)) return 0;
  const days = chunkDays(a, a.shown);
  const r = agendaChunk(days, agendaData(days, settings.get()), a.month);
  const el = document.createElement('div');
  el.className = 'ag-chunk';
  setHTML(el, r.html);
  a.tail.before(el);
  a.shown++;
  a.month = r.month;
  return r.rows;
}

/** The end of the Schedule view: watched while weeks are left to draw; Show more while it can grow. */
function syncAgendaTail() {
  const a = agenda;
  setHTML($('.ag-more', a.tail), state.agendaSpan < 366 ? '<button type="button" class="btn btn-secondary btn-sm" data-step-view>Show more</button>' : '');
  // The observer reports changes only: observed again, it reports where the end is now.
  a.io.unobserve(a.ahead);
  if (a.shown < agendaChunks(a)) a.io.observe(a.ahead);
}

/** Draw the Schedule view through `date` (a card or a flash is for an item there), if it is in the range. */
function agendaThrough(date) {
  const a = agenda;
  if (!a?.root.isConnected || !isYmd(date)) return;
  const before = a.shown;
  while (a.shown < agendaChunks(a) && a.days[a.shown * AG_WEEK] <= date) appendAgendaChunk();
  if (a.shown === before) return;
  syncAgendaTail();
  markSelection();
}

/** The first day row drawn on or after `date`, drawing more weeks until there is one (or none are left). */
function agendaRowFrom(date) {
  const find = () => $$('.ag-date[data-goto-day]', viewEl).find((b) => b.dataset.gotoDay >= date);
  agendaThrough(date);
  let row = find();
  if (row || !agenda?.root.isConnected) return row;
  while (!row && agenda.shown < agendaChunks(agenda)) {
    appendAgendaChunk();
    row = find();
  }
  syncAgendaTail();
  markSelection();
  return row;
}

function renderAgenda(days) {
  const s = settings.get();
  instMap = new Map();
  const live = agenda?.root.isConnected && agenda.root.parentElement === viewEl;
  if (!live || agenda.from !== days[0]) {
    agenda?.io.disconnect();
    // The top bar names the first month; its heading is for screen readers (heading navigation by month).
    viewEl.innerHTML = `<div class="agenda"><div class="agenda-inner"><h2 class="ag-month sr-only">${esc(fmt(parseYmd(days[0]), { month: 'long', year: 'numeric' }))}</h2><div class="ag-tail"><div class="ag-ahead" aria-hidden="true"></div><div class="ag-more"></div></div></div></div>`;
    const root = $('.agenda', viewEl);
    const tail = $('.ag-tail', root);
    agenda = { from: days[0], days, root, inner: $('.agenda-inner', root), tail, ahead: $('.ag-ahead', tail), shown: 0, month: days[0].slice(0, 7), io: null };
    const a = agenda;
    a.io = new IntersectionObserver(
      (entries) => {
        if (agenda !== a || !entries.some((x) => x.isIntersecting)) return;
        if (appendAgendaChunk()) markSelection();
        syncAgendaTail();
      },
      { root, rootMargin: `0px 0px ${AG_AHEAD}px 0px` },
    );
    for (let rows = 0; rows < AG_FIRST_ROWS && a.shown < agendaChunks(a); ) rows += appendAgendaChunk() || 1;
    return syncAgendaTail();
  }
  // The same range again (data changed, or Show more): redraw the weeks drawn so far, changing only those
  // whose rows did. Fewer days (Today resets Show more): the weeks past the end go.
  const a = agenda;
  a.days = days;
  const shown = Math.min(a.shown, agendaChunks(a));
  const els = $$(':scope > .ag-chunk', a.inner);
  const drawn = days.slice(0, shown * AG_WEEK);
  const data = drawn.length ? agendaData(drawn, s) : null;
  let month = days[0].slice(0, 7);
  for (let k = 0; k < shown; k++) {
    const r = agendaChunk(chunkDays(a, k), data, month);
    month = r.month;
    let el = els[k];
    if (!el) {
      el = document.createElement('div');
      el.className = 'ag-chunk';
      a.tail.before(el);
    }
    setHTML(el, r.html);
  }
  for (const el of els.slice(shown)) el.remove();
  a.shown = shown;
  a.month = month;
  syncAgendaTail();
}

// ---------------------------------------------------------------- tasks panel (Google Tasks)

// The head and the "Add a task" field are built once, so a render never wipes what is being typed.
function ensurePanel() {
  if ($('.tp-scroll', panelEl)) return;
  panelEl.innerHTML = `
    <div class="tp-head"><h2 id="tp-title">Tasks</h2>
      <a class="icon-btn" href="../tasks/#/today" aria-label="Open the tasks app" ${tipAttrs('Open Tasks')}>${icon('arrow-up-right', { size: 18 })}</a>
      <button type="button" class="icon-btn" data-toggle-panel aria-label="Close tasks" ${tipAttrs('Close', 'i')}>${icon('x')}</button></div>
    <div class="tp-add"><label>${icon('circle-plus', { size: 20 })}<input type="text" data-panel-add placeholder="Add a task" autocomplete="off" aria-label="Add a task"></label></div>
    <div class="tp-scroll"></div>`;
}

function panelListHtml() {
  const s = settings.get();
  const day = focusDate();
  const today = todayYmd();
  const ids = liveListIds();
  const all = db.all('tasks').filter((t) => !t.done);
  const open = all.filter((t) => !isTaskListHidden(t, s, ids));
  const hiddenCount = all.length - open.length;
  const toPlan = open.filter((t) => t.date && ((t.date === day && !t.time) || (day === today && t.date < today))).sort((a, b) => (a.date || '').localeCompare(b.date || '') || byTimeThenOrder(a, b));
  const undated = open.filter((t) => !t.date).sort((a, b) => (b.priority || 0) - (a.priority || 0) || byOrder(a, b)).slice(0, 80);
  const row = (t) => {
    const meta = [
      t.time ? `<span>${icon('clock')}${esc(fmtTimeRange(t.time, fromMinutes(toMinutes(t.time) + (t.duration || s.defaultTaskMinutes || 30))))}</span>` : t.duration ? `<span>${icon('duration')}${esc(fmtDuration(t.duration))}</span>` : '',
      t.date && t.date < today ? `<span class="overdue">${icon('calendar')}${esc(dayLabel(t.date))}</span>` : '',
      // A deadline has the deadline glyph, as in Tasks (the flag is priority there).
      t.deadline ? `<span>${icon('deadline')}${esc(`Deadline ${dayLabel(t.deadline)}`)}</span>` : '',
    ].join('');
    return `<div class="tp-task" draggable="true" data-ptask="${esc(t.id)}" ${taskA11y(t.title)} style="--ev:${taskColor(t, listMap())}">
      ${checkBtn(t, 11, 'check')}
      <div class="tt"><div class="tt-title">${esc(t.title)}</div>${meta ? `<div class="tt-meta">${meta}</div>` : ''}</div></div>`;
  };
  const notices = [
    s.showTasksInSchedule ? '' : `<div class="tp-note">Tasks are hidden on the calendar. <button type="button" class="link" data-show-tasks>Show them</button></div>`,
    hiddenCount ? `<div class="tp-note">${hiddenCount === 1 ? '1 task is' : `${hiddenCount} tasks are`} in lists hidden on the calendar. <button type="button" class="link" data-show-lists>Show all lists</button></div>` : '',
  ].join('');
  const dayName = dayLabel(day).toLowerCase() === 'today' ? 'today' : dayLabel(day);
  // Dragging needs a mouse (and on phones this panel is a sheet over the calendar): touch gets no drag hints.
  const empty = touchUI() ? `Nothing waiting for ${dayName}.` : `Nothing waiting. Drag a task here to plan it for ${dayName}.`;
  return `${notices}
    <section class="tp-section" data-panel-drop="${esc(day)}" aria-label="${esc(dayLabel(day))}">
      <div class="tp-label"><span>${esc(dayLabel(day))}</span><span class="count">${toPlan.length || ''}</span></div>
      ${toPlan.length ? `<div class="tp-hint">Drag onto the calendar to block time</div>${toPlan.map(row).join('')}` : `<div class="tp-empty">${esc(empty)}</div>`}
    </section>
    <section class="tp-section" data-panel-drop="" aria-label="No date">
      <div class="tp-label"><span>No date</span><span class="count">${undated.length || ''}</span></div>
      ${undated.map(row).join('') || '<div class="tp-empty">No undated tasks.</div>'}
    </section>`;
}

function renderPanel() {
  shellEl.classList.toggle('has-panel', state.panel);
  panelEl.hidden = !state.panel;
  if (state.panel) {
    ensurePanel();
    const sc = $('.tp-scroll', panelEl);
    const top = sc.scrollTop;
    if (setHTML(sc, panelListHtml())) sc.scrollTop = top;
  }
  syncLayers(); // a sheet on a phone: modal
}

// ---------------------------------------------------------------- render

const FOCUS_ATTRS = ['data-ev', 'data-task', 'data-ptask', 'data-goto-day', 'data-goto-month', 'data-day-more', 'data-cal-toggle', 'data-cal-menu', 'data-toggle-tasks', 'data-tasks-menu', 'data-date', 'data-mc', 'data-tab', 'data-view', 'data-expand-allday', 'data-step-view', 'data-show-tasks', 'data-show-lists'];
/** Where keyboard focus is (or element `a`), as something a re-render can find again. */
function focusToken(a = document.activeElement) {
  if (!a || a === document.body || !shellEl.contains(a)) return null;
  const root = a.closest('#view, #panel, #sidebar, #topbar, #tabbar');
  if (!root) return null;
  for (const name of FOCUS_ATTRS) if (a.hasAttribute(name)) return { root: root.id, name, value: a.getAttribute(name) };
  return null;
}
function restoreFocus(tok) {
  if (!tok) return;
  const a = document.activeElement;
  if (a && a !== document.body && document.contains(a)) return;
  document.getElementById(tok.root)?.querySelector(sel(tok.name, tok.value))?.focus({ preventScroll: true });
}

function markSelection() {
  for (const el of $$('.sel', viewEl)) el.classList.remove('sel');
  if (state.sel?.kind === 'event') for (const el of $$(sel('data-ev', state.sel.key), viewEl)) el.classList.add('sel');
  if (state.sel?.kind === 'task') for (const el of $$(sel('data-task', state.sel.id), viewEl)) el.classList.add('sel');
}

function render() {
  if (gesture || openCards.size) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  const v = effView();
  const { days } = range();
  // Year keeps its scroll position while the same year is re-rendered (the Schedule view is redrawn in place).
  const key = `${v}|${v === 'year' ? state.date.slice(0, 4) : state.date}`;
  const scroller = v === 'year' ? $('.year', viewEl) : null;
  const keepTop = key === lastRenderKey && scroller ? scroller.scrollTop : null;
  const tok = focusToken();
  if (v !== 'agenda' && agenda) {
    agenda.io.disconnect();
    agenda = null;
  }
  renderTopbar();
  renderSidebar();
  if (v === 'month') renderMonth(days);
  else if (v === 'year') renderYear();
  else if (v === 'agenda') renderAgenda(days);
  else renderGrid(days);
  if (keepTop !== null) {
    const sc = $('.year', viewEl);
    if (sc) sc.scrollTop = keepTop;
  } else if (v === 'year') {
    // Opening this year's Year view: the current month is in view (centred), even below the fold.
    const sc = $('.year', viewEl);
    const m = $('.ym.current', viewEl);
    if (sc && m) sc.scrollTop = Math.max(0, m.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - (sc.clientHeight - m.offsetHeight) / 2);
  }
  renderPanel();
  if (v !== 'month' && v !== 'year' && v !== 'agenda') fitTimes(); // after the panel: it changes the columns' width
  else viewEl.classList.remove('narrow-cols', 'tight-cols');
  markSelection();
  restoreFocus(tok);
  lastRenderKey = key;
  lastNoteKey = noteKey();
  lastToday = todayYmd();
  syncHash();
}

const VIEW_DATA = ['events', 'calendars', 'tasks', 'lists', 'settings'];
db.on(({ names }) => {
  if (names.has('events') || names.has('calendars')) instCache.clear();
  if (VIEW_DATA.some((n) => names.has(n))) {
    busyMemo.clear();
    return render();
  }
  // Notes change while someone types in the notes app: re-render only when a day gains or loses its note.
  if (names.has('notes') && noteKey() !== lastNoteKey) render();
});
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});
// Once a minute: move the now line in place (a full render only when the date changes).
function tick() {
  if (document.visibilityState !== 'visible') return;
  if (todayYmd() !== lastToday) render();
  else updateNow();
}
setInterval(tick, 60000);
document.addEventListener('visibilitychange', tick);

// ---------------------------------------------------------------- recurring helpers

/** The narrowest choice is the primary one (and has focus): "This event", or "This and following" when the rule changed. */
function askScope(action, { withThis = true } = {}) {
  return choiceDialog({
    title: `${action} recurring event`,
    choices: [
      ...(withThis ? [{ label: 'This event', value: 'this', tone: 'primary' }] : []),
      { label: 'This and following events', value: 'following', tone: withThis ? 'secondary' : 'primary' },
      { label: 'All events', value: 'all', tone: 'secondary' },
    ],
  });
}
const sameRule = (a, b) =>
  JSON.stringify(a && { f: a.freq, i: a.interval || 1, d: a.days ? [...a.days].sort() : null }) === JSON.stringify(b && { f: b.freq, i: b.interval || 1, d: b.days ? [...b.days].sort() : null });

/** Save a dragged or resized event. `newStart`/`newEnd` are its real times (an event may cross midnight). */
async function commitEventMove(key, newStart, newEnd) {
  const inst = instMap.get(key);
  if (!inst) return render();
  const e = inst.event;
  const start = fmtDT(newStart);
  const end = fmtDT(newEnd);
  let scope = 'all';
  if (e.repeat) {
    scope = await askScope('Change');
    if (!scope) return render();
  }
  const deltaDays = diffDays(ymd(inst.start), ymd(newStart));
  const moves = []; // meeting-note links moved along with the dates
  const undo = trackChanges(() => {
    if (!e.repeat) {
      moves.push(...relinkNotes(e.id, (d) => ({ id: e.id, date: addDaysYmd(d, deltaDays) })));
      return db.update('events', e.id, { start, end, allDay: false });
    }
    if (scope === 'this') {
      const copy = detachOccurrence(e.id, inst.occurrence, { start, end });
      moves.push(...linkToCopy(e.id, inst.occurrence, copy));
      return copy;
    }
    if (scope === 'following') {
      const copies = copyLinks(e.id, inst.occurrence);
      const next = splitSeries(e.id, inst.occurrence, { start, end, repeat: shiftRule(e.repeat, deltaDays, ymd(newStart)) });
      if (next && (next.id !== e.id || deltaDays)) moves.push(...relinkNotes(e.id, (d) => (d < inst.occurrence ? null : copies.get(d) || { id: next.id, date: addDaysYmd(d, deltaDays) })));
      return next;
    }
    // All events: move the series anchor by the same wall-clock change, so its length survives midnight.
    const cur = db.get('events', e.id);
    if (!cur) return null;
    const at = (dt, days, ref) => {
      const d = addDays(parseDT(dt), days);
      d.setHours(ref.getHours(), ref.getMinutes(), 0, 0);
      return fmtDT(d);
    };
    if (deltaDays) {
      const copies = copyLinks(e.id);
      moves.push(...relinkNotes(e.id, (d) => copies.get(d) || { id: e.id, date: addDaysYmd(d, deltaDays) }));
    }
    const seriesStart = at(cur.start, deltaDays, newStart);
    return db.update('events', e.id, {
      start: seriesStart,
      end: at(cur.end, diffDays(ymd(inst.end), ymd(newEnd)), newEnd),
      repeat: shiftRule(cur.repeat, deltaDays, seriesStart.slice(0, 10)),
      ...shiftSeriesDates(cur, deltaDays),
    });
  });
  undoable('Event updated', withNoteLinks(undo, moves));
}

async function deleteInstance(key) {
  const inst = instMap.get(key);
  if (!inst) return;
  const e = inst.event;
  let scope = 'all';
  if (e.repeat) {
    scope = await choiceDialog({
      title: 'Delete recurring event',
      choices: [
        { label: 'This event', value: 'this', tone: 'secondary' },
        { label: 'This and following events', value: 'following', tone: 'secondary' },
        { label: 'All events', value: 'all', tone: 'danger' },
      ],
    });
    if (!scope) return;
  }
  // deleteOccurrence also removes occurrences that were edited on their own.
  const undo = trackChanges(() => deleteOccurrence(e.id, inst.occurrence, scope));
  if (state.sel?.key === key) state.sel = null;
  undoable('Event deleted', undo);
}

function duplicateInstance(key) {
  const inst = instMap.get(key);
  if (!inst) return;
  const e = inst.event;
  const undo = trackChanges(() => {
    const { id: _id, seriesId: _s, occurrence: _o, createdAt: _c, updatedAt: _u, ...rest } = structuredClone(e);
    const shift = diffDays(e.start.slice(0, 10), inst.occurrence);
    const sh = (x) => (x.length > 10 ? fmtDT(addDays(parseDT(x), shift)) : addDaysYmd(x, shift));
    return db.insert('events', { ...rest, start: sh(e.start), end: sh(e.end), repeat: null, exdates: [], until: null });
  });
  undoable('Event duplicated', undo);
  if (undo.result?.id) flashEvent(undo.result.id, inst.occurrence);
}

// ---------------------------------------------------------------- detail cards (Google)

// Keyboard focus after the focused item goes away (deleted, completed off the panel, moved off screen):
// its neighbour takes focus, so a keyboard user keeps their place instead of landing on the page.
const ITEM_ATTRS = ['data-ev', 'data-task', 'data-ptask'];
const itemToken = (el) => {
  const name = el && ITEM_ATTRS.find((a) => el.hasAttribute(a));
  return name ? { name, value: el.getAttribute(name) } : null;
};
let keyboardUsed = false;
document.addEventListener('keydown', () => (keyboardUsed = true), true);
document.addEventListener('pointerdown', () => (keyboardUsed = false), true);
/** Run `fn` (sync or async), which may remove `item`; if focus is lost then, move it to the item's neighbour. */
function keepFocusNear(item, fn) {
  const root = item?.isConnected ? item.closest('#view, #panel') : null;
  const me = root && itemToken(item);
  let next = null;
  if (me) {
    const items = $$('[data-ev], [data-task], [data-ptask]', root).filter((x) => x.tabIndex >= 0 && x.getClientRects().length);
    const i = items.indexOf(item);
    const other = (x) => {
      const t = itemToken(x);
      return t && !(t.name === me.name && t.value === me.value); // not another piece of the same event
    };
    next = itemToken(items.slice(i + 1).find(other) || items.slice(0, Math.max(0, i)).reverse().find(other));
  }
  const settle = () =>
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!me || (a && a !== document.body && a.isConnected)) return;
      const target =
        (next && root.querySelector(sel(next.name, next.value))) ||
        root.querySelector('[data-ev], [data-task], [data-ptask]') ||
        root.querySelector(root === panelEl ? '[data-panel-add]' : '[data-goto-day]');
      if (!target) return;
      target.focus({ preventScroll: true });
      if (keyboardUsed) target.scrollIntoView({ block: 'nearest' });
    });
  let result;
  try {
    result = fn();
  } finally {
    if (typeof result?.then === 'function') result.then(settle, settle);
    else settle();
  }
  return result;
}

/** A card's anchor that a render has replaced since (a menu stayed open meanwhile): the item's current element. */
function liveAnchor(anchor, attr, value) {
  if (!anchor || anchor.isConnected) return anchor;
  const panelRow = () => (attr === 'data-task' ? $(sel('data-ptask', value), panelEl) : null);
  return (anchor.hasAttribute?.('data-ptask') && panelRow()) || $(sel(attr, value), viewEl) || panelRow() || null;
}

function openEventPopover(key, anchorEl) {
  const inst = instMap.get(key);
  const anchor = liveAnchor(anchorEl, 'data-ev', key);
  if (!inst || !anchor) return;
  const e = inst.event;
  state.sel = { kind: 'event', key };
  markSelection();
  const note = meetingNote(e, inst.occurrence);
  const noteHref = note ? notesHref.note(note.id) : notesHref.meeting(e.id, inst.occurrence);
  const preview = note ? notePreview(note) : '';
  const until = e.until ? `, until ${fmt(parseYmd(e.until), { month: 'short', day: 'numeric', ...(e.until.slice(0, 4) === String(new Date().getFullYear()) ? {} : { year: 'numeric' }) })}` : '';
  const remove = () => keepFocusNear(anchor, () => deleteInstance(key));
  openCard(
    anchor,
    `<div class="ep-actions">
       <button type="button" class="icon-btn" data-pop="edit" aria-label="Edit event" ${tipAttrs('Edit', 'e')}>${icon('edit', { size: 18 })}</button>
       <button type="button" class="icon-btn" data-pop="delete" aria-label="Delete event" ${tipAttrs('Delete', 'backspace')}>${icon('trash', { size: 18 })}</button>
       <button type="button" class="icon-btn" data-pop="dup" aria-label="Duplicate event" ${tipAttrs('Duplicate')}>${icon('copy', { size: 18 })}</button>
       <button type="button" class="icon-btn" data-pop="close" aria-label="Close" ${tipAttrs('Close', 'esc')}>${icon('x', { size: 18 })}</button>
     </div>
     <div class="ep-head" style="--ev:${colorVar(inst.color)}"><span class="sw" aria-hidden="true"></span><div class="ep-main"><h3>${esc(untitled(e.title))}</h3><div class="when">${esc(whenText(inst))}</div>${e.repeat ? `<div class="when">${esc(describe(e.repeat) + until)}</div>` : ''}</div></div>
     <div class="ep-rows">
       ${e.location ? `<div class="r">${icon('pin')}<span>${withLinks(e.location)}</span></div>` : ''}
       ${e.notes ? `<div class="r">${icon('text-lines')}<span class="notes">${withLinks(e.notes)}</span></div>` : ''}
       ${inst.calendar ? `<div class="r">${icon('calendar')}<span>${esc(inst.calendar.name)}</span></div>` : ''}
     </div>
     <a class="ep-notes${note ? ' has' : ''}" href="${esc(noteHref)}">${icon('note', { size: 18 })}<span class="grow"><span class="lbl">${note ? 'Open meeting notes' : 'Meeting notes'}</span>${preview ? `<span class="pv">${esc(preview)}</span>` : ''}</span>${icon('arrow-up-right', { size: 15 })}</a>`,
    {
      className: 'ev-pop',
      side: narrow() ? 'bottom' : 'right',
      label: untitled(e.title),
      focus: false,
      onClose: () => {
        if (state.sel?.key === key) state.sel = null;
        markSelection();
      },
      onMount: (el, close) => {
        // The card itself takes focus (no button is pre-focused): Tab reaches the actions, e edits, Delete deletes.
        el.tabIndex = -1;
        requestAnimationFrame(() => el.isConnected && !el.contains(document.activeElement) && el.focus({ preventScroll: true }));
        el.addEventListener('click', (ev) => {
          const a = ev.target.closest('[data-pop]')?.dataset.pop;
          if (!a) return;
          close();
          if (a === 'edit') openEditor({ key });
          else if (a === 'delete') remove();
          else if (a === 'dup') duplicateInstance(key);
        });
        el.addEventListener('keydown', (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev) || singleKeyOff(ev)) return;
          const k = ev.key;
          if (k !== 'e' && k !== 'Delete' && k !== 'Backspace') return;
          ev.preventDefault();
          ev.stopPropagation();
          close();
          if (k === 'e') openEditor({ key });
          else remove();
        });
      },
    },
  );
}

function unscheduleTask(id, { timeOnly = null } = {}) {
  const t = db.get('tasks', id);
  if (!t || (!t.date && !t.time)) return;
  const dropTime = timeOnly ?? !!t.time;
  if (dropTime) return undoable('Time block removed', scheduleTask(id, t.date, null, t.duration));
  const before = structuredClone(t);
  const after = db.update('tasks', id, { date: null, time: null });
  // The undo takes back only this change: edits made to the task since (any app, any tab) stay.
  undoable('Removed from calendar', () => revertChange('tasks', before, after));
}

/**
 * Block time for a task from a time list (the keyboard and touch way; a mouse can also drag it in).
 * A task on the calendar keeps its day; one from the panel (undated or overdue) goes on the panel's day.
 */
function pickTaskTime(id, anchorEl) {
  const t = db.get('tasks', id);
  const anchor = liveAnchor(anchorEl, 'data-task', id);
  if (!t || !anchor) return;
  const s = settings.get();
  const date = anchor.closest('#panel') || !t.date ? focusDate() : t.date;
  const dur = Math.min(1440, t.duration || s.defaultTaskMinutes || 30);
  let release = () => {};
  const handle = openTimePicker(anchor, {
    value: t.time || '',
    label: `Time for “${t.title}”`,
    onClose: () => release(),
    onPick: (time) => {
      if (!time) return;
      const undo = planTask(id, date, time, dur);
      if (!undo) return;
      undoable(`Blocked ${fmtDuration(dur)} for “${t.title}” · ${dayLabel(date)}`, undo);
      if (!range().days.includes(date) && !['month', 'year', 'agenda'].includes(effView())) {
        state.date = date;
        render();
      }
      requestAnimationFrame(() => {
        const block = $(`.ev${sel('data-task', id)}`, viewEl);
        if (!block) return;
        block.scrollIntoView({ block: 'center', behavior: smooth() });
        block.classList.add('flash');
      });
    },
  });
  if (handle?.el?.isConnected) release = holdView(handle.close);
}

function openTaskPopover(id, anchorEl) {
  const t = db.get('tasks', id);
  const anchor = liveAnchor(anchorEl, 'data-task', id);
  if (!t || !anchor) return;
  const s = settings.get();
  const l = listMap().get(t.listId);
  state.sel = { kind: 'task', id };
  markSelection();
  const steps = Array.isArray(t.checklist) ? t.checklist : [];
  const act = (fn) => keepFocusNear(anchor, fn);
  openCard(
    anchor,
    `<div class="ep-actions">
       <a class="icon-btn" href="${esc(`../tasks/#/task/${enc(t.id)}`)}" aria-label="Edit in Tasks" ${tipAttrs('Edit in Tasks')}>${icon('edit', { size: 18 })}</a>
       ${t.date ? `<button type="button" class="icon-btn" data-pop="undate" aria-label="Remove from calendar" ${tipAttrs('Remove from calendar', 'backspace')}>${icon('no-date', { size: 18 })}</button>` : ''}
       <button type="button" class="icon-btn" data-pop="close" aria-label="Close" ${tipAttrs('Close', 'esc')}>${icon('x', { size: 18 })}</button>
     </div>
     <div class="ep-head">${checkBtn(t, 12, 'check')}
       <div class="ep-main"><h3${t.done ? ' class="done"' : ''}>${esc(t.title)}</h3><div class="when">${esc(taskWhen(t, s))}${t.duration && !t.time ? ` · ${esc(fmtDuration(t.duration))}` : ''}</div>${t.repeat ? `<div class="when">${esc(describe(t.repeat))}</div>` : ''}</div></div>
     <div class="ep-rows">
       ${t.notes ? `<div class="r">${icon('text-lines')}<span class="notes">${withLinks(t.notes)}</span></div>` : ''}
       ${steps.length ? `<div class="r">${icon('checklist')}<span>${steps.filter((x) => x.done).length} of ${steps.length} steps done</span></div>` : ''}
       ${t.deadline ? `<div class="r">${icon('deadline')}<span>Deadline ${esc(dayLabel(t.deadline))}</span></div>` : ''}
       <div class="r">${icon('inbox')}<span>${esc(l?.name || 'Inbox')}</span></div>
     </div>
     <div class="ep-foot">
       <button type="button" class="btn btn-tint btn-sm" data-pop="toggle" ${tipAttrs(t.done ? 'Mark uncompleted' : 'Mark completed', 'x')}>${icon('done', { size: 15 })}${t.done ? 'Mark uncompleted' : 'Mark completed'}</button>
       ${t.time ? `<button type="button" class="btn btn-ghost btn-sm" data-pop="unblock">Remove time</button>` : t.done ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-pop="time">${icon('clock', { size: 15 })}Add time</button>`}
     </div>`,
    {
      className: 'ev-pop task-pop',
      side: narrow() ? 'bottom' : 'right',
      label: t.title,
      focus: false,
      onClose: () => {
        if (state.sel?.id === id) state.sel = null;
        markSelection();
      },
      onMount: (el, close) => {
        el.tabIndex = -1;
        requestAnimationFrame(() => el.isConnected && !el.contains(document.activeElement) && el.focus({ preventScroll: true }));
        el.addEventListener('click', (ev) => {
          const a = ev.target.closest('[data-pop], [data-task-check]');
          if (!a) return;
          const what = a.matches('[data-task-check]') ? 'toggle' : a.dataset.pop;
          close();
          if (what === 'toggle') act(() => completeTask(id));
          else if (what === 'unblock') act(() => unscheduleTask(id, { timeOnly: true }));
          else if (what === 'undate') act(() => unscheduleTask(id, { timeOnly: false }));
          else if (what === 'time') pickTaskTime(id, anchor);
        });
        el.addEventListener('keydown', (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev) || singleKeyOff(ev)) return;
          const k = ev.key;
          if (k !== 'x' && k !== 'Delete' && k !== 'Backspace') return;
          ev.preventDefault();
          ev.stopPropagation();
          close();
          if (k === 'x') act(() => completeTask(id));
          else act(() => unscheduleTask(id));
        });
      },
    },
  );
}

function completeTask(id) {
  const t = id && db.get('tasks', id);
  if (!t) return;
  if (!t.done) playDing();
  const undo = toggleTask(id);
  undoable(t.done ? 'Task reopened' : t.repeat ? 'Done. Moved to the next time' : 'Task completed', undo);
}

function removeTask(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  undoable(`Deleted “${t.title}”`, deleteTask(id));
}

// ---------------------------------------------------------------- Create (Google's quick card + Apple's typed quick event)

function defaultSlot() {
  const s = settings.get();
  const date = focusDate();
  const now = new Date();
  const start = date === todayYmd() ? Math.min(23 * 60, Math.ceil((clock(now) + 1) / 30) * 30) : 9 * 60;
  return { date, start, end: start + (s.defaultEventMinutes || 60), allDay: false };
}

/** A slot in minutes from the start of its day (the end may pass midnight): {day: 'Friday, November 27', span: '10pm – Sat 1am'}. */
function slotParts(c, mode) {
  const day = capital(longDay(c.date));
  // A typed date range ("Vacation dec 20-28") is all day over those days: "December 20 – December 28", as whenText shows it.
  if (c.allDay && mode === 'event' && c.endDate > c.date) return { day: `${fmt(parseYmd(c.date), { month: 'long', day: 'numeric' })} – ${fmt(parseYmd(c.endDate), { month: 'long', day: 'numeric' })}`, span: 'All day' };
  if (c.allDay) return { day, span: mode === 'event' ? 'All day' : 'Any time' };
  const endDay = addDaysYmd(c.date, Math.floor((c.end - 1) / 1440));
  const t1 = fromMinutes(c.start);
  const t2 = fromMinutes(c.end);
  return { day, span: endDay === c.date ? fmtTimeRange(t1, t2) : `${fmtClock(t1)} – ${fmt(parseYmd(endDay), { weekday: 'short' })} ${fmtClock(t2)}` };
}
/** "Friday, November 27 · 10pm – Sat 1am" (HTML). */
function slotText(c, mode) {
  const { day, span } = slotParts(c, mode);
  return `${esc(day)} <span class="sub">· ${esc(span)}</span>`;
}

// Words the parser read, by what they set in the card. A card line's × keeps them in the title instead
// (they are quoted, which the parser leaves alone), as Tasks' chips do.
const WHEN_KINDS = ['date', 'time', 'duration', 'allday'];
const keepButton = (what, words) => `<button type="button" class="icon-btn sm qc-x" data-keep="${what}" aria-label="${esc(`Keep “${words}” in the title`)}" ${tipAttrs('Keep in the title')}>${icon('x', { size: 14 })}</button>`;

function openCreate({ slot = defaultSlot(), anchor = null, ghost = null, mode: initialMode = 'event', prefill = '' } = {}) {
  const s = settings.get();
  let mode = initialMode;
  let parsed = null;
  let manual = null; // the date and times once they are set in the fields (they then win over typed words)
  let expanded = false;
  let endPicked = false; // an end time picked in the fields: a task keeps that length
  let cur = { ...slot };
  const timedSlot = !!anchor && !slot.allDay; // a slot picked on the grid keeps its time for tasks too
  // A task given a time without a slot on the grid gets the default task block, as in Tasks.
  const taskLength = () => s.defaultTaskMinutes || 30;
  const cals = calsSorted();
  let destCal = cals.find((c) => c.visible !== false)?.id || cals[0]?.id || '';
  let destList = '';
  let destPicked = false;
  const destField = () =>
    mode === 'event'
      ? selectField({ name: 'dest', value: destCal, options: cals.map((c) => ({ value: c.id, label: c.name, color: c.color })), ariaLabel: 'Calendar', className: 'flat qc-dest' })
      : selectField({ name: 'dest', value: destList, options: [{ value: '', label: 'Inbox', icon: 'inbox' }, ...listsSorted().map((l) => ({ value: l.id, label: l.name, color: l.color }))], ariaLabel: 'List', className: 'flat qc-dest' });
  const body = `<form class="qc" novalidate autocomplete="off">
      <button type="button" class="icon-btn sm qc-close" data-qc-close aria-label="Close" ${tipAttrs('Close', 'esc')}>${icon('x', { size: 16 })}</button>
      <div class="qc-field"><div class="qc-mirror" aria-hidden="true"></div><input class="qc-title" name="title" value="${esc(prefill)}" data-autofocus aria-label="Title" autocomplete="off" spellcheck="false"></div>
      <div class="segmented full qc-tabs" role="group" aria-label="Create"><button type="button" data-mode="event" aria-pressed="${mode === 'event'}">Event</button><button type="button" data-mode="task" aria-pressed="${mode === 'task'}">Task</button></div>
      <div class="qc-line qc-when-line">${icon('clock')}<div class="qc-when-box" data-when></div></div>
      <div class="qc-line parsed" data-where hidden>${icon('pin')}<span class="qc-val"></span><span class="qc-keep"></span></div>
      <div class="qc-line parsed" data-repeat hidden>${icon('repeat')}<span class="qc-val"></span><span class="qc-keep"></span></div>
      <div class="qc-line" data-dest>${icon(mode === 'event' ? 'calendar' : 'inbox')}${destField()}</div>
      <div class="qc-actions"><button type="button" class="btn btn-ghost btn-sm" data-more>More options</button><span class="grow"></span><button type="submit" class="btn btn-primary btn-sm">Save</button></div>
    </form>`;
  // The clicked slot (the ghost) anchors the card. Once the typed or picked time moves away from it, it
  // turns invisible, keeping its place for the card, and `preview` shows the new time if that day is on screen.
  let preview = null;
  let ghostLabel = '(No title)';
  let release = () => {};
  const onClose = () => {
    release();
    ghost?.remove();
    preview?.remove();
  };
  // Renders wait while the card is open (openCard), so the ghost and the typed title survive data changes.
  // Phones use the same sheet as the + button, also for a tapped slot (its ghost stays on the grid).
  const asCard = !!anchor && !narrow();
  const handle = asCard
    ? openCard(anchor, body, { className: 'qc-pop', side: 'right', label: 'Create', onClose, toggle: false })
    : openModal({ className: 'qc-modal', body, label: 'Create', onClose });
  if (!asCard && ghost) release = holdView(handle.close);
  const el = handle.el;
  const close = handle.close;
  const form = $('form', el);
  const F = form.elements; // never form.title — that's the element's tooltip property
  const mirror = $('.qc-mirror', el);
  const tokensOf = (kinds) => (parsed?.tokens || []).filter((t) => kinds.includes(t.kind));
  const wordsOf = (kinds) => tokensOf(kinds).sort((a, b) => a.start - b.start).map((t) => t.text.trim()).join(' ');

  // Recognised words are highlighted in the title as you type (a mirror behind the transparent input).
  const drawMirror = () => {
    const raw = F.title.value;
    let html = '';
    let at = 0;
    for (const t of [...(parsed?.tokens || [])].sort((a, b) => a.start - b.start)) {
      if (t.start < at) continue;
      const lead = raw.slice(t.start, t.end).match(/^\s*/)[0].length;
      html += `${esc(raw.slice(at, t.start + lead))}<mark>${esc(raw.slice(t.start + lead, t.end))}</mark>`;
      at = t.end;
    }
    mirror.innerHTML = html + esc(raw.slice(at));
    mirror.scrollLeft = F.title.scrollLeft;
  };

  const whenBox = $('[data-when]', el);
  const drawWhen = () => {
    if (!expanded) {
      const changed = !!manual || !!cur.endDate || cur.date !== slot.date || cur.start !== slot.start || cur.end !== slot.end || cur.allDay !== slot.allDay;
      const { day, span } = slotParts(cur, mode);
      const typed = !manual && tokensOf(WHEN_KINDS).length ? keepButton('when', wordsOf(WHEN_KINDS)) : '';
      whenBox.innerHTML = `<button type="button" class="qc-when${changed ? ' parsed' : ''}" data-when-edit aria-label="${esc(`Date and time: ${day}, ${span}. Change`)}">${slotText(cur, mode)}</button>${typed}`;
      return;
    }
    const st = fromMinutes(cur.start);
    const sameDay = cur.end <= 1440;
    whenBox.innerHTML = `<div class="qc-fields">
        ${dateField({ name: 'qcDate', value: cur.date, allowClear: false, ariaLabel: cur.endDate && mode === 'event' ? 'Start date' : 'Date', className: 'compact' })}
        ${cur.allDay && cur.endDate && mode === 'event' ? `<span class="dash" aria-hidden="true">–</span>${dateField({ name: 'qcEndDate', value: cur.endDate, allowClear: false, ariaLabel: 'End date', className: 'compact' })}` : ''}
        ${cur.allDay ? '' : `<span class="qc-times">${timeField({ name: 'qcStart', value: st, ariaLabel: 'Start time', className: 'compact' })}<span class="dash" aria-hidden="true">–</span>${timeField({ name: 'qcEnd', value: fromMinutes(cur.end), base: sameDay ? st : '', ariaLabel: 'End time', className: 'compact' })}</span>`}
        ${checkField({ name: 'qcAllDay', checked: cur.allDay, label: mode === 'event' ? 'All day' : 'Any time' })}
      </div>`;
  };

  const atSlot = () => cur.date === slot.date && cur.start === slot.start && cur.end === slot.end && cur.allDay === slot.allDay && !cur.endDate;
  const syncGhost = () => {
    if (!ghost) return;
    const here = atSlot();
    ghost.style.visibility = here ? '' : 'hidden'; // still laid out: the card stays anchored to it
    const col = here || cur.allDay ? null : $(`.col${sel('data-date', cur.date)}`, viewEl);
    if (col) {
      const bottom = Math.min(1440, Math.max(cur.end, cur.start + 15));
      if (!preview) preview = makeGhost(col, cur.start, bottom);
      else if (preview.parentElement !== col) col.append(preview);
      placeBlock(preview, cur.start, bottom);
      minutesTime(preview, cur.start, cur.end);
      preview.classList.toggle('cont-bottom', cur.end > 1440);
    } else {
      preview?.remove();
      preview = null;
    }
    for (const g of [ghost, preview]) {
      if (!g) continue;
      $('.ev-title', g).textContent = ghostLabel;
      fitTimes(g); // a title on two lines leaves no room for the time in a short slot
    }
  };
  // The ghost and the preview take the chosen calendar's (or list's) colour, as the saved item will.
  const paintGhosts = () => {
    const c = mode === 'event' ? cals.find((x) => x.id === F.dest.value) : listMap().get(F.dest.value);
    for (const g of [ghost, preview]) g?.style.setProperty('--ev', colorVar(c?.color));
  };

  // ranges: a typed date range is saved whole (an event's endDate below, a task's deadline)
  const parseOpts = () => (mode === 'event' ? { mode: 'event', calendars: cals, hour12: hour12(), dmy: isDmy, ranges: true } : { mode: 'task', lists: db.all('lists'), hour12: hour12(), dmy: isDmy, ranges: true });
  const update = () => {
    const raw = F.title.value;
    F.title.placeholder = mode === 'event' ? 'Add title and time' : 'Add a task';
    let r = parse(raw, parseOpts());
    // Only a typed day ("fri", "dec 5", "tomorrow", "tonight") moves the card off its day. Without one, the
    // words are read from the card's own day: "Lunch 1pm" stays on the day that was clicked (the parser
    // would put a bare time on today) and "every weekday" starts there.
    const typedDay = r.tokens.some((t) => t.kind === 'date' || (t.kind === 'time' && /^(tonight|this\s)/i.test(t.text)));
    if (!typedDay && (r.date || r.repeat)) r = parse(raw, { ...parseOpts(), now: parseYmd(manual?.date || slot.date) });
    parsed = r;
    if (manual) cur = { ...manual };
    else {
      const c = { ...slot };
      if (mode === 'task' && !timedSlot) c.allDay = true;
      if (r.time) {
        c.allDay = false;
        c.start = toMinutes(r.time);
        c.end = c.start + (r.duration || slot.end - slot.start || s.defaultEventMinutes || 60); // may run past midnight
      } else if (r.duration && !c.allDay) c.end = c.start + r.duration;
      if (r.date) {
        c.date = r.date;
        // A day typed without a time is all day (any time, for a task), unless a time was picked on the grid.
        if (typedDay && !r.time && !timedSlot) c.allDay = true;
      }
      if (mode === 'event' && r.tokens.some((t) => t.kind === 'allday')) c.allDay = true;
      // A typed date range without a time ("Vacation dec 20-28") is one all-day event over those days.
      // (With a time, r.duration already runs to the last day: "dec 3-5 9am-5pm".)
      if (mode === 'event' && r.endDate > c.date && !r.time) {
        c.allDay = true;
        c.endDate = r.endDate;
      }
      cur = c;
    }
    // A task timed here without a slot on the grid is as long as Tasks makes it: the default task block
    // (saved without a length of its own), unless a length was typed or an end time picked.
    if (mode === 'task' && !timedSlot && !cur.allDay && !r.duration && !endPicked) cur = { ...cur, end: cur.start + taskLength() };
    ghostLabel = (r.title || raw).trim() || '(No title)';
    syncGhost();
    if (!expanded) drawWhen();
    drawMirror();
    const line = (rowSel, text, kinds) => {
      const row = $(rowSel, el);
      row.hidden = !text;
      $('.qc-val', row).textContent = text || '';
      $('.qc-keep', row).innerHTML = text && tokensOf(kinds).length ? keepButton(kinds[0], wordsOf(kinds)) : '';
    };
    line('[data-where]', mode === 'event' ? r.location : '', ['location']);
    line('[data-repeat]', r.repeat ? describe(r.repeat) : '', ['repeat']);
    // Until a calendar or list is picked by hand, the destination follows what is typed ("#Work").
    if (!destPicked) setFieldValue(F.dest, mode === 'event' ? r.calendarId || destCal : r.listId || destList);
    paintGhosts();
  };

  /** Keep the words that set a line in the title: quote them, so the parser leaves them alone. */
  const keepWords = (what) => {
    const toks = tokensOf(what === 'when' ? WHEN_KINDS : [what]).sort((a, b) => b.start - a.start);
    let v = F.title.value;
    for (const t of toks) {
      const lead = v.slice(t.start, t.end).match(/^\s*/)[0].length;
      v = `${v.slice(0, t.start + lead)}"${v.slice(t.start + lead, t.end)}"${v.slice(t.end)}`;
    }
    F.title.value = v;
    update();
    F.title.focus();
  };

  const taskFields = (title) => {
    const r = parsed || {};
    return {
      title: title || 'New task',
      listId: F.dest.value || null,
      newList: F.dest.value ? null : r.newList,
      tags: r.tags,
      priority: r.priority,
      deadline: r.deadline,
      repeat: r.repeat,
      date: cur.date,
      time: cur.allDay ? null : fromMinutes(cur.start),
      // No length of its own unless one was typed, drawn on the grid or picked: it then follows Settings.
      duration: r.duration || (!cur.allDay && (timedSlot || endPicked) ? Math.min(10080, cur.end - cur.start) : null),
    };
  };

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-qc-close]')) return close();
    const keep = e.target.closest('[data-keep]');
    if (keep) return keepWords(keep.dataset.keep);
    if (e.target.closest('[data-when-edit]')) {
      expanded = true;
      manual = { ...cur }; // the fields now say when; typing no longer moves it
      drawWhen();
      return $('[data-date-field]', whenBox)?.focus();
    }
    const m = e.target.closest('[data-mode]');
    if (m) {
      if (m.dataset.mode === mode) return;
      mode = m.dataset.mode;
      $$('[data-mode]', el).forEach((b) => b.setAttribute('aria-pressed', String(b === m)));
      $('[data-dest]', el).innerHTML = `${icon(mode === 'event' ? 'calendar' : 'inbox')}${destField()}`;
      if (expanded) drawWhen();
      update();
      return F.title.focus();
    }
    if (e.target.closest('[data-more]')) {
      const title = (parsed?.title || F.title.value).trim();
      close();
      if (mode === 'event') {
        openEditor({ draft: { title, date: cur.date, endDate: cur.allDay ? cur.endDate : undefined, start: cur.start, end: cur.end, allDay: cur.allDay, calendarId: F.dest.value, location: parsed?.location || '', repeat: parsed?.repeat || null } });
      } else {
        const t = createTask(taskFields(title));
        location.href = `../tasks/#/task/${enc(t.id)}`;
      }
    }
  });
  form.addEventListener('change', (e) => {
    const name = e.target.getAttribute?.('name');
    if (name === 'dest') {
      destPicked = true;
      if (mode === 'event') destCal = F.dest.value;
      else destList = F.dest.value;
      return paintGhosts();
    }
    if (!['qcDate', 'qcEndDate', 'qcStart', 'qcEnd', 'qcAllDay'].includes(name)) return;
    const m = { ...cur };
    if (name === 'qcDate' && isYmd(F.qcDate.value)) {
      // a date range keeps its length when its first day moves
      if (m.endDate) {
        m.endDate = addDaysYmd(m.endDate, diffDays(m.date, F.qcDate.value));
        if (F.qcEndDate) setFieldValue(F.qcEndDate, m.endDate);
      }
      m.date = F.qcDate.value;
    }
    if (name === 'qcEndDate' && isYmd(F.qcEndDate.value)) {
      m.endDate = F.qcEndDate.value < m.date ? m.date : F.qcEndDate.value;
      if (m.endDate !== F.qcEndDate.value) setFieldValue(F.qcEndDate, m.endDate);
    }
    if (name === 'qcAllDay') {
      m.allDay = F.qcAllDay.value === 'true';
      if (!m.allDay) delete m.endDate; // the card's start and end times are for one day (More options sets more)
      if (!m.allDay && mode === 'task' && !timedSlot && !endPicked) m.end = m.start + taskLength();
      manual = m;
      cur = { ...m };
      drawWhen();
      update();
      $('[name="qcAllDay"]', whenBox)?.focus();
      return;
    }
    if (name === 'qcStart' && F.qcStart.value) {
      const dur = m.end - m.start; // Google keeps the length when the start moves
      m.start = toMinutes(F.qcStart.value);
      m.end = m.start + dur;
      setFieldValue(F.qcEnd, fromMinutes(m.end), { base: m.end <= 1440 ? F.qcStart.value : '' });
    }
    if (name === 'qcEnd' && F.qcEnd.value) {
      let end = toMinutes(F.qcEnd.value);
      if (end < m.start) end += 1440;
      if (end === m.start) end = m.start + 15;
      m.end = end;
      endPicked = true;
    }
    manual = m;
    cur = { ...m };
    update(); // moves the preview block, and a typed repeat follows the new day
  });
  F.title.addEventListener('input', update);
  const syncMirror = () => requestAnimationFrame(() => (mirror.scrollLeft = F.title.scrollLeft));
  F.title.addEventListener('scroll', syncMirror);
  F.title.addEventListener('keydown', syncMirror);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = F.title.value.trim();
    if (!raw) return F.title.focus();
    const title = parsed?.title || raw;
    const calendarId = F.dest.value;
    const task = mode === 'task' ? taskFields(title) : null;
    close(); // first: renders the card held run again, so the new item shows (and flashes) at once
    if (mode === 'event') {
      const undo = trackChanges(() => {
        const ev = createEvent(
          { title, location: parsed?.location || '', calendarId, date: cur.date, endDate: cur.allDay ? cur.endDate : undefined, time: cur.allDay ? null : fromMinutes(cur.start), duration: cur.end - cur.start, allDay: cur.allDay, repeat: parsed?.repeat || null },
          s,
        );
        revealCalendar(ev?.calendarId);
        return ev;
      }, ['events', 'calendars']);
      const ev = undo.result;
      if (!ev) return;
      const { days } = range();
      if (!days.includes(cur.date) && effView() !== 'year') {
        state.date = cur.date;
        state.scrolledOnce = false;
        render();
      }
      flashEvent(ev.id, cur.date);
      undoable(`Event added · ${dayLabel(cur.date)}`, undo);
    } else {
      const undo = trackChanges(() => createTask(task), ['tasks', 'lists']);
      undoable('Task added', undo);
    }
  });
  update();
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    F.title.focus();
    const n = F.title.value.length;
    F.title.setSelectionRange(n, n);
  });
}

// ---------------------------------------------------------------- full event editor

/** When a series ends: "End repeat: Never / On [date] / After [n] times" (Apple's End Repeat, Google's Ends). */
const ENDS_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'on', label: 'On' },
  { value: 'after', label: 'After' },
];

function openEditor({ key = null, draft = null } = {}) {
  const s = settings.get();
  const inst = key ? instMap.get(key) : null;
  if (key && !inst) return;
  const e = inst?.event || null;
  const cals = calsSorted();
  let v;
  if (inst) {
    v = {
      title: e.title,
      location: e.location || '',
      notes: e.notes || '',
      calendarId: e.calendarId,
      allDay: inst.allDay,
      startDate: ymd(inst.start),
      startTime: inst.allDay ? '09:00' : hhmm(inst.start),
      // The real end, even at midnight: "11pm – 12am" with the next day as the end date.
      endDate: ymd(inst.end),
      endTime: inst.allDay ? '10:00' : hhmm(inst.end),
      repeat: e.repeat,
      until: e.until || '',
    };
  } else {
    const d = draft || {};
    const date = isYmd(d.date) ? d.date : focusDate();
    const sm = Number.isFinite(d.start) ? d.start : 9 * 60;
    const em = Number.isFinite(d.end) && d.end > sm ? d.end : sm + (s.defaultEventMinutes || 60);
    v = {
      title: d.title || '',
      location: d.location || '',
      notes: '',
      calendarId: d.calendarId || cals.find((c) => c.visible !== false)?.id || cals[0]?.id,
      allDay: !!d.allDay,
      startDate: date,
      startTime: fromMinutes(sm),
      endDate: d.allDay ? (isYmd(d.endDate) && d.endDate > date ? d.endDate : date) : addDaysYmd(date, Math.floor(em / 1440)),
      endTime: fromMinutes(em),
      repeat: d.repeat || null,
      until: '',
    };
  }
  let rp = presets(v.startDate);
  const rpIndex = rp.findIndex((p) => sameRule(p.rule, v.repeat));
  let customRule = v.repeat && rpIndex < 0 ? v.repeat : null;
  let customPicked = false; // a rule made in Custom repeat here (built for the form's start date, like a preset)
  const repeatOptions = () => [
    ...rp.map((p, i) => ({ value: String(i), label: i === 0 ? 'Does not repeat' : p.label })),
    ...(customRule ? [{ value: 'keep', label: describe(customRule) }] : []),
    { value: 'custom', label: 'Custom…' },
  ];
  const repeatValue = rpIndex >= 0 ? String(rpIndex) : customRule ? 'keep' : '0';
  const sameDayEnd = v.endDate === v.startDate;
  // Phones show Apple's two labelled rows ("Starts [date] [time]" / "Ends [date] [time]"): the labels and
  // the row break are hidden on wider screens, which keep Google's one row ("[date] [time] – [time] [date]").
  // The end time is moved to where it shows (placeEndTime), so focus order follows what is seen.
  const phoneRows = matchMedia('(max-width: 640px)');
  const { el, close } = openModal({
    title: e ? 'Edit event' : 'New event',
    className: 'editor',
    onClose: () => phoneRows.removeEventListener('change', placeEndTime),
    body: `<form class="modal-body" data-editor novalidate autocomplete="off">
      <input class="input title-input" name="title" placeholder="Add title" value="${esc(v.title)}" aria-label="Title" autocomplete="off" data-autofocus>
      <div class="ed-row ed-when">${icon('clock')}
        <span class="ed-ph ed-label" aria-hidden="true">Starts</span>
        ${dateField({ name: 'startDate', value: v.startDate, allowClear: false, ariaLabel: 'Start date', className: 'ed-date' })}
        <span class="ed-times"${v.allDay ? ' hidden' : ''}>${timeField({ name: 'startTime', value: v.startTime, ariaLabel: 'Start time' })}<span class="to" aria-hidden="true">–</span>${timeField({ name: 'endTime', value: v.endTime, base: sameDayEnd ? v.startTime : '', ariaLabel: 'End time' })}</span>
        <span class="to ed-date-to"${v.allDay ? '' : ' hidden'} aria-hidden="true">–</span>
        <span class="ed-break" aria-hidden="true"></span><span class="ed-ph ed-ends ed-label" aria-hidden="true">Ends</span>
        ${dateField({ name: 'endDate', value: v.endDate, allowClear: false, ariaLabel: 'End date', className: 'ed-date' })}
      </div>
      <div class="ed-row ed-opts">${checkField({ name: 'allDay', checked: v.allDay, label: 'All day' })}</div>
      <div class="ed-row">${icon('repeat')}${selectField({ name: 'repeat', value: repeatValue, options: repeatOptions(), ariaLabel: 'Repeat', className: 'ed-repeat' })}</div>
      <div class="ed-row ed-ends" data-until-row${v.repeat ? '' : ' hidden'}><span class="ed-label">End repeat</span>${selectField({ name: 'ends', value: v.until ? 'on' : 'never', options: ENDS_OPTIONS, ariaLabel: 'End repeat', className: 'ed-ends-mode' })}
        <span class="ed-ends-part" data-ends-part="on"${v.until ? '' : ' hidden'}>${dateField({ name: 'until', value: v.until || addDaysYmd(v.startDate, 91), allowClear: false, ariaLabel: 'Ends on' })}</span>
        <span class="ed-ends-part" data-ends-part="after" hidden><input class="input ed-count" name="count" inputmode="numeric" maxlength="3" value="10" aria-label="Number of times" autocomplete="off"><span class="ed-label">times</span></span>
      </div>
      <div class="ed-row">${icon('pin')}<input class="input" name="location" placeholder="Add location" value="${esc(v.location)}" aria-label="Location" autocomplete="off"></div>
      <div class="ed-row">${icon('calendar')}${selectField({ name: 'calendarId', value: v.calendarId || '', options: cals.map((c) => ({ value: c.id, label: c.name, color: c.color })), ariaLabel: 'Calendar' })}</div>
      <div class="ed-row ed-top">${icon('text-lines')}<textarea class="input" name="notes" placeholder="Add description" rows="2" data-autosize aria-label="Description">${esc(v.notes)}</textarea></div>
      <div class="ed-actions">
        ${e ? `<button type="button" class="btn btn-danger" data-ed-delete>${icon('trash', { size: 16 })}Delete</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`,
  });
  const form = $('[data-editor]', el);
  const F = form.elements; // never form.title — that's the element's tooltip property
  autosize(F.notes);
  // On a phone the end time comes after the end date, in the DOM too, so Tab, switch access and screen readers
  // meet the fields in the order they are shown; it moves back beside the start time if the phone turns.
  const placeEndTime = () => {
    const focused = document.activeElement === F.endTime;
    if (phoneRows.matches) F.endDate.after(F.endTime);
    else $('.ed-times', el).append(F.endTime);
    F.endTime.hidden = F.allDay.value === 'true'; // outside .ed-times on a phone, so it hides on its own
    if (focused) F.endTime.focus();
  };
  placeEndTime();
  phoneRows.addEventListener('change', placeEndTime);
  let repeatTouched = false;
  let repeatShown = repeatValue; // the Repeat field's value before "Custom…" was chosen
  let endsTouched = false;
  let lastStartDate = v.startDate;
  // When the series ends (stored as `until`): never, on a date (not before the series starts) or after N times.
  const untilFor = (rule, seriesStart) => {
    if (!rule || F.ends.value === 'never') return null;
    if (F.ends.value === 'after') return untilAfter(rule, seriesStart, Math.min(999, Math.max(1, Math.trunc(+F.count.value) || 1))) || null;
    return isYmd(F.until.value) ? (F.until.value < seriesStart ? seriesStart : F.until.value) : null;
  };
  F.count.addEventListener('input', () => {
    F.count.value = F.count.value.replace(/\D+/g, '').slice(0, 3);
    endsTouched = true;
  });
  F.count.addEventListener('blur', () => (F.count.value = String(Math.min(999, Math.max(1, Math.trunc(+F.count.value) || 1)))));
  const startAt = () => parseDT(`${F.startDate.value}T${F.startTime.value || '09:00'}`);
  const endAt = () => parseDT(`${F.endDate.value}T${F.endTime.value || F.startTime.value || '10:00'}`);
  let lengthMin = v.allDay ? 60 : Math.max(15, wallMinutes(parseDT(`${v.startDate}T${v.startTime}`), parseDT(`${v.endDate}T${v.endTime}`)));
  // The end time list shows lengths from the start (Google) while the event ends on its start day.
  const syncEndBase = () => setFieldValue(F.endTime, F.endTime.value, { base: F.endDate.value === F.startDate.value ? F.startTime.value : '' });
  form.addEventListener('change', (ev) => {
    const name = ev.target.getAttribute?.('name');
    if (name === 'allDay') {
      const on = F.allDay.value === 'true';
      $('.ed-times', el).hidden = on;
      F.endTime.hidden = on;
      $('.ed-date-to', el).hidden = !on;
      // An event that ends at midnight becomes one all-day event, not two days.
      if (on && F.endTime.value === '00:00' && F.endDate.value === addDaysYmd(F.startDate.value, 1)) setFieldValue(F.endDate, F.startDate.value);
    } else if (name === 'repeat') {
      if (F.repeat.value === 'custom') {
        // The shared Custom repeat picker (as in Tasks). The field keeps showing the current rule until one is
        // made there, so Cancel changes nothing.
        setFieldValue(F.repeat, repeatShown);
        const shown = F.repeat.value;
        return openRepeatPicker(F.repeat, {
          value: shown === 'keep' ? customRule : rp[+shown]?.rule || null,
          date: isYmd(F.startDate.value) ? F.startDate.value : v.startDate,
          onPick: (rule) => {
            if (!el.isConnected || !rule) return;
            const i = rp.findIndex((p) => sameRule(p.rule, rule));
            if (i < 0) {
              customRule = rule;
              customPicked = true;
            }
            repeatTouched = true;
            F.repeat.dataset.options = JSON.stringify(repeatOptions());
            setFieldValue(F.repeat, i >= 0 ? String(i) : 'keep');
            repeatShown = F.repeat.value;
            $('[data-until-row]', el).hidden = false;
            F.repeat.focus();
          },
        });
      }
      repeatTouched = true;
      repeatShown = F.repeat.value;
      $('[data-until-row]', el).hidden = F.repeat.value === '0';
    } else if (name === 'ends') {
      endsTouched = true;
      for (const part of $$('[data-ends-part]', el)) part.hidden = part.dataset.endsPart !== F.ends.value;
    } else if (name === 'until') {
      endsTouched = true;
    } else if (name === 'startDate') {
      const shift = diffDays(lastStartDate, F.startDate.value);
      lastStartDate = F.startDate.value;
      setFieldValue(F.endDate, addDaysYmd(F.endDate.value || F.startDate.value, shift)); // keep the length
      rp = presets(F.startDate.value); // "Weekly on Fri" follows the date
      F.repeat.dataset.options = JSON.stringify(repeatOptions());
      setFieldValue(F.repeat, F.repeat.value);
      syncEndBase();
    } else if (name === 'startTime') {
      const end = shiftWall(startAt(), lengthMin);
      setFieldValue(F.endDate, ymd(end));
      setFieldValue(F.endTime, hhmm(end));
      syncEndBase();
    } else if (name === 'endTime' || name === 'endDate') {
      if (F.endDate.value < F.startDate.value) setFieldValue(F.endDate, F.startDate.value);
      if (F.allDay.value !== 'true' && +endAt() === +startAt()) {
        const end = shiftWall(startAt(), 15); // "(0 mins)" means the shortest event, not a 24-hour one
        setFieldValue(F.endDate, ymd(end));
        setFieldValue(F.endTime, hhmm(end));
      } else if (F.allDay.value !== 'true' && endAt() < startAt()) {
        // An end before the start means the next day.
        const end = parseDT(`${addDaysYmd(F.startDate.value, 1)}T${F.endTime.value || '10:00'}`);
        setFieldValue(F.endDate, ymd(end));
      }
      lengthMin = Math.max(15, wallMinutes(startAt(), endAt()));
      syncEndBase();
    }
  });
  $('[data-ed-delete]', el)?.addEventListener('click', () => {
    const item = $(sel('data-ev', key), viewEl);
    close();
    keepFocusNear(item, () => deleteInstance(key));
  });
  let saving = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (saving) return;
    const allDay = F.allDay.value === 'true';
    const startDate = isYmd(F.startDate.value) ? F.startDate.value : v.startDate;
    let endDate = isYmd(F.endDate.value) ? F.endDate.value : startDate;
    if (endDate < startDate) endDate = startDate;
    const startT = F.startTime.value || '09:00';
    const endT = F.endTime.value || startT;
    const start = allDay ? startDate : `${startDate}T${startT}`;
    let end = allDay ? endDate : `${endDate}T${endT}`;
    if (!allDay && end <= start) end = fmtDT(shiftWall(parseDT(start), s.defaultEventMinutes || 60));
    const choice = F.repeat.value;
    const presetRule = choice === 'keep' ? customRule : rp[+choice]?.rule || null;
    const untilVal = untilFor(presetRule, startDate); // a new (or newly repeating) series starts on this date
    const patch = { title: F.title.value.trim() || 'New event', location: F.location.value.trim(), notes: F.notes.value, calendarId: F.calendarId.value || v.calendarId, allDay };
    let undo;
    if (!e) {
      undo = trackChanges(() => {
        const created = db.insert('events', { ...patch, start, end, repeat: presetRule, exdates: [], until: untilVal });
        revealCalendar(created.calendarId);
        return created;
      }, ['events', 'calendars']);
      close();
      const created = undo.result;
      if (!range().days.includes(startDate) && effView() !== 'year') {
        state.date = startDate;
        state.scrolledOnce = false;
        render();
      }
      if (created) flashEvent(created.id, startDate);
      undoable('Event added', undo);
      return;
    }
    const moves = []; // meeting-note links moved along with the dates
    if (!e.repeat) {
      // A separately edited occurrence that is given its own repeat becomes a series of its own.
      const detach = presetRule && e.seriesId ? { seriesId: undefined, occurrence: undefined } : {};
      const delta = diffDays(inst.occurrence, startDate);
      undo = trackChanges(() => {
        moves.push(...relinkNotes(e.id, (d) => ({ id: e.id, date: addDaysYmd(d, delta) })));
        // Notes found through the series it leaves now belong to this event.
        if (presetRule && e.seriesId) moves.push(...relinkNotes(e.seriesId, (d) => (d === e.occurrence ? { id: e.id, date: startDate } : null)));
        return db.update('events', e.id, { ...patch, ...detach, start, end, repeat: presetRule, until: untilVal });
      });
    } else {
      saving = true;
      // A preset or a custom rule made here is built for the form's date; the event's own rule is kept.
      const fresh = repeatTouched && (choice !== 'keep' || customPicked);
      const ruleChanged = fresh && !sameRule(presetRule, e.repeat);
      const scope = await askScope('Edit', { withThis: !ruleChanged });
      saving = false;
      if (!scope || !el.isConnected) return;
      const deltaDays = diffDays(inst.occurrence, startDate);
      // Untouched or kept custom rules move with the date; a rule picked here is already built for it.
      const ruleFor = (date) => (fresh ? presetRule : shiftRule(choice === 'keep' ? customRule : e.repeat, deltaDays, date));
      const keptRule = !fresh;
      undo = trackChanges(() => {
        if (scope === 'this') {
          const copy = detachOccurrence(e.id, inst.occurrence, { ...patch, start, end });
          moves.push(...linkToCopy(e.id, inst.occurrence, copy));
          return copy;
        }
        if (scope === 'following') {
          const rule = ruleFor(startDate);
          const copies = copyLinks(e.id, inst.occurrence);
          const next = splitSeries(e.id, inst.occurrence, { ...patch, start, end, repeat: rule, ...(endsTouched || !rule ? { until: untilFor(rule, startDate) } : {}) });
          if (next && (next.id !== e.id || deltaDays)) moves.push(...relinkNotes(e.id, (d) => (d < inst.occurrence ? null : copies.get(d) || { id: next.id, date: addDaysYmd(d, deltaDays) })));
          return next;
        }
        const cur = db.get('events', e.id);
        if (!cur) return null;
        if (deltaDays) {
          const copies = copyLinks(e.id);
          moves.push(...relinkNotes(e.id, (d) => copies.get(d) || { id: e.id, date: addDaysYmd(d, deltaDays) }));
        }
        const seriesStart = addDaysYmd(cur.start.slice(0, 10), deltaDays);
        const seriesEnd = addDaysYmd(seriesStart, diffDays(startDate, endDate));
        const rule = ruleFor(seriesStart);
        const moved = keptRule && rule ? shiftSeriesDates(cur, deltaDays) : {};
        // Fields changed here also reach separately edited occurrences that still had the old value.
        const changed = ['title', 'location', 'notes', 'calendarId'].filter((f) => patch[f] !== (f === 'title' ? v.title : v[f]));
        for (const c of seriesCopies(e.id)) {
          const p = {};
          for (const f of changed) if ((c[f] ?? '') === (cur[f] ?? '')) p[f] = patch[f];
          if (Object.keys(p).length) db.update('events', c.id, p);
        }
        return db.update('events', e.id, {
          ...patch,
          start: allDay ? seriesStart : `${seriesStart}T${startT}`,
          end: allDay ? seriesEnd : `${seriesEnd}T${endT}`,
          repeat: rule,
          exdates: rule ? moved.exdates ?? cur.exdates : cur.exdates,
          until: !rule ? null : endsTouched ? untilFor(rule, seriesStart) : moved.until !== undefined ? moved.until : cur.until ?? null,
        });
      });
    }
    close();
    undoable('Event saved', withNoteLinks(undo, moves));
  });
}

/** A new event goes on a hidden calendar: show that calendar, so the event doesn't vanish. */
function revealCalendar(id) {
  const c = id && db.get('calendars', id);
  if (c && c.visible === false) db.update('calendars', c.id, { visible: true });
}

/** Scroll a new or moved event into view and flash it. `date`: its day (the Schedule view draws on to it). */
function flashEvent(eventId, date = null) {
  if (agenda) agendaThrough(date);
  requestAnimationFrame(() => {
    const el = $(`[data-ev^="${CSS.escape(`${eventId}@`)}"]`, viewEl);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: smooth() });
    el.classList.add('flash');
  });
}

/**
 * Show an event's occurrence (palette, deep links): go to its day, then open its card. An event on a
 * hidden calendar can't be shown, so that calendar is shown again (undoably) first.
 */
function revealEvent(id, date) {
  if (isYmd(date)) state.date = date;
  state.month = null;
  state.scrolledOnce = false;
  if (state.view === 'agenda' || state.view === 'year') state.view = 'week';
  const cal = db.get('calendars', db.get('events', id)?.calendarId);
  if (cal?.visible === false) {
    const before = structuredClone(cal);
    const after = db.update('calendars', cal.id, { visible: true }); // renders
    undoable(`Showing “${cal.name}”`, () => revertChange('calendars', before, after));
  } else render();
  requestAnimationFrame(() => {
    const el = $(sel('data-ev', `${id}@${date}`), viewEl) || $(`[data-ev^="${CSS.escape(`${id}@`)}"]`, viewEl);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    openEventPopover(el.dataset.ev, el);
  });
}

// ---------------------------------------------------------------- grid gestures: click/drag to create, drag to move, drag edge to resize

function gridMetrics() {
  const body = $('.grid-body', viewEl);
  const cols = $$('.col', body);
  const r = body.getBoundingClientRect();
  const c0 = cols[0].getBoundingClientRect();
  return { body, cols, r, left: c0.left, colW: c0.width, hour: hourPx() };
}
function posAt(m, x, y, snap = 15) {
  const ci = Math.min(m.cols.length - 1, Math.max(0, Math.floor((x - m.left) / m.colW)));
  const raw = ((y - m.r.top) / m.hour) * 60;
  return { ci, date: m.cols[ci].dataset.date, raw, mins: Math.min(1440, Math.max(0, Math.round(raw / snap) * snap)) };
}
/**
 * Size a block. An event or task being moved keeps its drawn length (at least MIN_VIS); a ghost is drawn like
 * the block it will be: at least MIN_VIS long, one line when short, a title line above the time when mid-length.
 */
const placeBlock = (el, top, bottom, { minVis = false } = {}) => {
  const ghost = el.classList.contains('ghost');
  const b = minVis || ghost ? visualBottom(top, bottom) : bottom;
  el.style.top = `calc(var(--hour) * ${top / 60} + 1px)`;
  el.style.height = `calc(var(--hour) * ${(b - top) / 60} - 2px)`;
  if (ghost) for (const [cls, on] of Object.entries(blockSize(b - top))) el.classList.toggle(cls, on);
};
/**
 * The time a ghost or a dragged block would get ('HH:MM' or Dates), fitted like the others: whole, as the
 * start, or not at all. A short block's one line keeps plain text (it wraps out of sight unless it fits).
 */
const setTime = (el, a, b) => {
  const t = $('.ev-time', el);
  const range = fmtTimeRange(a, b);
  if (!t || t.dataset.range === range) return;
  t.dataset.range = range;
  if (el.classList.contains('short')) {
    el.classList.remove('start-only', 'no-time'); // a ghost dragged back to a short length
    t.textContent = range;
    return;
  }
  t.innerHTML = timeHtml(a, b);
  fitTimes(el);
};
const minutesTime = (el, a, b) => setTime(el, fromMinutes(a), fromMinutes(b));
/** The colour of the calendar a new event goes on. */
const defaultCalColor = () => {
  const cals = calsSorted();
  return colorVar((cals.find((c) => c.visible !== false) || cals[0])?.color);
};
function makeGhost(col, top, bottom, label = '(No title)', color = defaultCalColor()) {
  const g = document.createElement('div');
  g.className = 'ev ghost';
  g.setAttribute('aria-hidden', 'true');
  g.style.left = '1px';
  g.style.right = '4px';
  g.style.setProperty('--ev', color);
  // A short block's one line (title, then the time if it fits); longer, the line steps aside (CSS).
  g.innerHTML = '<div class="ev-line"><div class="ev-title"></div><div class="ev-time"></div></div>';
  $('.ev-title', g).textContent = label;
  col.append(g); // first: its time is fitted to it
  placeBlock(g, top, bottom);
  minutesTime(g, top, bottom);
  return g;
}
function autoScroll(y) {
  const sc = $('.grid-scroll', viewEl);
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  if (y < r.top + 28) sc.scrollTop -= 14;
  else if (y > r.bottom - 28) sc.scrollTop += 14;
}
const liveEl = (g) => (g.el && document.contains(g.el) ? g.el : (g.key ? $(sel('data-ev', g.key), viewEl) : g.id ? $(sel('data-task', g.id), viewEl) : null) || g.el);

function cancelGesture() {
  const g = gesture;
  if (!g) return;
  gesture = null;
  clearTimeout(g.hold);
  g.ghost?.remove();
  document.documentElement.classList.remove('sch-moving', 'sch-resizing');
  render(); // puts back a block that was being moved and applies deferred renders
}

// Touch: a finger that moves at once scrolls the grid (and swipes); one held still on an event or task for
// HOLD_MS lifts it, and the block then follows the finger (Apple and Google Calendar). A block lifted and
// let go without moving opens its menu, the long press touch screens use for the context menu.
const HOLD_MS = 400;
function liftBlock(g) {
  if (gesture !== g || g.moved) return;
  g.armed = true;
  swipe = null; // the finger now moves the block, not the range
  try {
    g.m.body.setPointerCapture(g.pointerId); // the block may move to another column: capture stays on the grid
  } catch {
    /* the pointer is already gone */
  }
  closeCards();
  g.el.classList.add('dragging');
  navigator.vibrate?.(10);
}

viewEl.addEventListener('pointerdown', (e) => {
  if (gesture) cancelGesture();
  const body = e.target.closest('.grid-body');
  if (!body || e.button !== 0 || e.target.closest('[data-task-check]')) return;
  const m = gridMetrics();
  const p = posAt(m, e.clientX, e.clientY);
  const block = e.target.closest('.ev[data-ev], .ev[data-task]');
  const base = { m, start: p, x0: e.clientX, y0: e.clientY, moved: false, touch: e.pointerType === 'touch', pointerId: e.pointerId };
  const type = e.target.closest('[data-resize]') ? 'resize' : 'move';
  if (block?.dataset.ev) {
    const inst = instMap.get(block.dataset.ev);
    if (!inst) return;
    gesture = { ...base, type, kind: 'event', el: block, key: block.dataset.ev, inst, crossing: ymd(inst.start) !== lastDayOf(inst), date: block.closest('.col').dataset.date, top: +block.dataset.top, bottom: +block.dataset.bottom };
  } else if (block?.dataset.task) {
    gesture = { ...base, type, kind: 'task', el: block, id: block.dataset.task, date: block.closest('.col').dataset.date, top: +block.dataset.top, bottom: +block.dataset.bottom };
  } else gesture = { ...base, type: 'create' };
  // Mouse and pen keep the pointer, so a release outside the window still ends the gesture here.
  if (!base.touch) {
    try {
      body.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
  } else if (gesture.el) {
    const g = gesture;
    g.hold = setTimeout(() => liftBlock(g), HOLD_MS);
  }
});
// While a lifted block follows the finger, the page must not scroll.
viewEl.addEventListener(
  'touchmove',
  (e) => {
    if (gesture?.armed && e.cancelable) e.preventDefault();
  },
  { passive: false },
);

viewEl.addEventListener('pointermove', (e) => {
  const g = gesture;
  if (!g || e.pointerId !== g.pointerId) return;
  if (!g.moved) {
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 5) return;
    if (g.touch && !g.armed) {
      clearTimeout(g.hold);
      return void (gesture = null); // touch scrolls (and swipes) instead, until a block is held still
    }
    g.moved = true;
    closeCards(); // dragging the block whose card is open (Google closes it too)
    if (g.el) {
      g.el.classList.add('dragging');
      document.documentElement.classList.add(g.type === 'resize' ? 'sch-resizing' : 'sch-moving');
      if (g.type === 'move') {
        g.el.style.left = '1px';
        g.el.style.width = 'calc(100% - 5px)';
        // Other pieces of an event that crosses midnight hide while it moves as one.
        if (g.kind === 'event') for (const o of $$(sel('data-ev', g.key), viewEl)) if (o !== g.el) o.classList.add('drag-hide');
      }
    }
  }
  autoScroll(e.clientY);
  g.m.r = g.m.body.getBoundingClientRect();
  const p = posAt(g.m, e.clientX, e.clientY);
  if (g.type === 'create') {
    const a = Math.min(g.start.mins, p.mins);
    let b = Math.max(g.start.mins, p.mins);
    if (b - a < 15) b = Math.min(1440, a + 15);
    if (!g.ghost) g.ghost = makeGhost(g.m.cols[g.start.ci], a, b);
    placeBlock(g.ghost, a, b);
    minutesTime(g.ghost, a, b);
    g.a = a;
    g.b = b;
    return;
  }
  const col = g.m.cols[p.ci];
  const snapped = Math.round((p.raw - g.start.raw) / 15) * 15;
  if (g.type === 'move' && g.kind === 'event') {
    const colDate = col.dataset.date;
    const dayStart = parseYmd(colDate);
    const dayEnd = addDays(dayStart, 1);
    const len = wallMinutes(g.inst.start, g.inst.end);
    let ns = shiftWall(g.inst.start, diffDays(g.date, colDate) * 1440 + snapped);
    if (g.crossing) {
      // Already runs past midnight: keep at least 15 minutes of it in the column under the pointer.
      if (shiftWall(ns, len) <= shiftWall(dayStart, 15)) ns = shiftWall(shiftWall(dayStart, 15), -len);
    } else if (ns < dayStart) ns = dayStart; // like Google, a same-day event stops at the top of the day
    if (ns > shiftWall(dayStart, 1425)) ns = shiftWall(dayStart, 1425);
    const ne = shiftWall(ns, len); // may now run into the next day; its real end is kept
    const top = ns <= dayStart ? 0 : clock(ns);
    const bottom = ne >= dayEnd ? 1440 : clock(ne);
    if (g.el.parentElement !== col) col.append(g.el);
    g.el.classList.toggle('cont-top', ns < dayStart);
    g.el.classList.toggle('cont-bottom', ne > dayEnd);
    placeBlock(g.el, top, Math.max(bottom, top + 15), { minVis: true });
    setTime(g.el, ns, ne);
    Object.assign(g, { newStart: ns, newEnd: ne });
  } else if (g.type === 'move') {
    const dur = g.bottom - g.top;
    const top = Math.min(1440 - dur, Math.max(0, g.top + snapped));
    if (g.el.parentElement !== col) col.append(g.el);
    placeBlock(g.el, top, top + dur, { minVis: true });
    minutesTime(g.el, top, top + dur);
    Object.assign(g, { newTop: top, newBottom: top + dur, newDate: col.dataset.date });
  } else {
    const bottom = Math.min(1440, Math.max(g.top + 15, Math.round(p.raw / 15) * 15));
    placeBlock(g.el, g.top, bottom, { minVis: true });
    if (g.kind === 'event') {
      const ne = atMinutes(g.date, bottom);
      setTime(g.el, g.inst.start, ne);
      Object.assign(g, { newStart: g.inst.start, newEnd: ne });
    } else {
      minutesTime(g.el, g.top, bottom);
      Object.assign(g, { newTop: g.top, newBottom: bottom, newDate: g.date });
    }
  }
});

function endGesture(e) {
  const g = gesture;
  if (!g || (e && e.pointerId !== g.pointerId)) return;
  if (e?.type === 'pointercancel') return cancelGesture();
  gesture = null;
  clearTimeout(g.hold);
  document.documentElement.classList.remove('sch-moving', 'sch-resizing');
  if (!g.moved) {
    if (g.kind) {
      if (pendingRender || g.armed) render(); // a block lifted by a long press goes back in place
      const anchor = liveEl(g);
      if (g.armed && anchor) return g.kind === 'event' ? eventMenu(g.key, menuPoint(e || {}, anchor), anchor) : taskMenu(g.id, menuPoint(e || {}, anchor), anchor);
      return g.kind === 'event' ? openEventPopover(g.key, anchor) : openTaskPopover(g.id, anchor);
    }
    if (pendingRender) render();
    const s = settings.get();
    const startMin = Math.min(1440 - 15, Math.floor(g.start.raw / 30) * 30);
    const endMin = startMin + (s.defaultEventMinutes || 60);
    const col = $(sel('data-date', g.start.date), viewEl);
    if (!col) return;
    const ghost = makeGhost(col, startMin, Math.min(1440, endMin));
    return openCreate({ slot: { date: g.start.date, start: startMin, end: endMin, allDay: false }, anchor: ghost, ghost });
  }
  if (g.type === 'create') return openCreate({ slot: { date: g.start.date, start: g.a, end: g.b, allDay: false }, anchor: g.ghost, ghost: g.ghost });
  if (g.kind === 'event') {
    if (!g.newStart || (+g.newStart === +g.inst.start && +g.newEnd === +g.inst.end)) return render();
    return commitEventMove(g.key, g.newStart, g.newEnd);
  }
  if (g.newDate === undefined || (g.newDate === g.date && g.newTop === g.top && g.newBottom === g.bottom)) return render();
  undoable(g.type === 'resize' ? 'Time block resized' : 'Time block moved', scheduleTask(g.id, g.newDate, fromMinutes(g.newTop), g.newBottom - g.newTop));
}
viewEl.addEventListener('pointerup', endGesture);
viewEl.addEventListener('pointercancel', endGesture);
// A gesture that ends anywhere else (released outside, window switch, lost capture) is dropped, never committed.
window.addEventListener('pointerup', (e) => {
  if (gesture && e.pointerId === gesture.pointerId && !viewEl.contains(e.target)) cancelGesture();
});
window.addEventListener('pointercancel', (e) => {
  if (gesture && e.pointerId === gesture.pointerId) cancelGesture();
});
viewEl.addEventListener('lostpointercapture', (e) => {
  const id = e.pointerId;
  setTimeout(() => {
    if (gesture && gesture.pointerId === id && gesture.moved) cancelGesture();
  });
});
window.addEventListener('blur', cancelGesture);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelGesture();
});

// Swipe left or right on a phone to go to the next or previous range (Apple, Google).
let swipe = null;
viewEl.addEventListener('pointerdown', (e) => {
  swipe = e.pointerType === 'touch' && e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() } : null;
});
viewEl.addEventListener('pointerup', (e) => {
  const sw = swipe;
  swipe = null;
  if (!sw || e.pointerId !== sw.id || hasOpenLayer()) return;
  const dx = e.clientX - sw.x;
  const dy = e.clientY - sw.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2 && Date.now() - sw.t < 800 && ['day', 'days', 'week', 'month'].includes(effView())) step(dx < 0 ? 1 : -1);
});
viewEl.addEventListener('pointercancel', () => (swipe = null));

// ---------------------------------------------------------------- clicks & keys in views

viewEl.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('a[href]')) return; // day-note links navigate
  const check = t.closest('[data-task-check]');
  if (check) {
    const id = check.closest('[data-task]')?.dataset.task;
    if (id) return completeTask(id);
  }
  if (t.closest('[data-expand-allday]')) {
    state.alldayOpen = !state.alldayOpen;
    return render();
  }
  const more = t.closest('[data-day-more]');
  if (more) return openDayPopover(more.dataset.dayMore, more.closest('.mcell'));
  const goto = t.closest('[data-goto-day]');
  if (goto) return goDay(goto.dataset.gotoDay);
  const gm = t.closest('[data-goto-month]');
  if (gm) {
    if (isYmd(gm.dataset.gotoMonth)) state.date = gm.dataset.gotoMonth;
    return setView('month');
  }
  if (t.closest('[data-step-view]')) {
    const first = addDaysYmd(state.date, state.agendaSpan); // the first of the days it adds
    state.agendaSpan = Math.min(366, state.agendaSpan + 60);
    render(); // the weeks drawn stay; the new ones are drawn as they come into view
    // From the keyboard, focus goes on to the first new day that has plans (the button stays at the end).
    if (e.detail === 0) agendaRowFrom(first)?.focus();
    return;
  }
  if (t.closest('.grid-body')) return; // handled by pointer gestures
  const ev = t.closest('[data-ev]');
  if (ev) return openEventPopover(ev.dataset.ev, ev);
  const tk = t.closest('[data-task]');
  if (tk) return openTaskPopover(tk.dataset.task, tk);
  // Click an empty month cell or all-day cell → quick create an all-day event (Google).
  const cell = t.closest('[data-mdate], [data-allday-date]');
  if (cell) {
    const date = cell.dataset.mdate || cell.dataset.alldayDate;
    if (isYmd(date)) openCreate({ slot: { date, start: 9 * 60, end: 10 * 60, allDay: true }, anchor: cell });
  }
});

// Year view: arrow keys move between days (a week up / down), Home / End go to the week's ends, Page Up /
// Page Down a month. Enter opens the day. Moving past December or January turns the year.
viewEl.addEventListener('keydown', (e) => {
  const day = e.target.closest?.('.ym-day[data-goto-day]');
  if (!day || e.metaKey || e.ctrlKey || e.altKey || !isYmd(day.dataset.gotoDay)) return;
  const cur = day.dataset.gotoDay;
  const d = parseYmd(cur);
  const col = (d.getDay() - settings.get().weekStart + 7) % 7;
  const month = (n) => {
    const m = new Date(d.getFullYear(), d.getMonth() + n, 1);
    return ymd(new Date(m.getFullYear(), m.getMonth(), Math.min(d.getDate(), daysInMonth(m.getFullYear(), m.getMonth()))));
  };
  const next = { ArrowLeft: () => addDaysYmd(cur, -1), ArrowRight: () => addDaysYmd(cur, 1), ArrowUp: () => addDaysYmd(cur, -7), ArrowDown: () => addDaysYmd(cur, 7), Home: () => addDaysYmd(cur, -col), End: () => addDaysYmd(cur, 6 - col), PageUp: () => month(-1), PageDown: () => month(1) }[e.key]?.();
  if (!next) return;
  e.preventDefault();
  e.stopPropagation(); // the page's own arrow keys step the range
  state.yearFocus = next;
  day.tabIndex = -1;
  if (next.slice(0, 4) !== cur.slice(0, 4)) {
    state.date = next;
    render();
  }
  const target = $(`.ym-day${sel('data-goto-day', next)}`, viewEl);
  if (!target) return;
  target.tabIndex = 0;
  target.focus();
});

// Month view: the same keys from a day (its number or any of its items) move between days; moving to a
// day of another month shows that month, and Page Up / Page Down go a month back or on.
viewEl.addEventListener('keydown', (e) => {
  const cell = e.target.closest?.('.mcell[data-mdate]');
  if (!cell || e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || !isYmd(cell.dataset.mdate)) return;
  const cur = cell.dataset.mdate;
  const d = parseYmd(cur);
  const col = (d.getDay() - settings.get().weekStart + 7) % 7;
  const month = (n) => {
    const m = new Date(d.getFullYear(), d.getMonth() + n, 1);
    return ymd(new Date(m.getFullYear(), m.getMonth(), Math.min(d.getDate(), daysInMonth(m.getFullYear(), m.getMonth()))));
  };
  const next = { ArrowLeft: () => addDaysYmd(cur, -1), ArrowRight: () => addDaysYmd(cur, 1), ArrowUp: () => addDaysYmd(cur, -7), ArrowDown: () => addDaysYmd(cur, 7), Home: () => addDaysYmd(cur, -col), End: () => addDaysYmd(cur, 6 - col), PageUp: () => month(-1), PageDown: () => month(1) }[e.key]?.();
  if (!next) return;
  e.preventDefault();
  e.stopPropagation();
  state.monthFocus = next;
  const shown = parseYmd(state.date);
  const nd = parseYmd(next);
  if (nd.getMonth() !== shown.getMonth() || nd.getFullYear() !== shown.getFullYear()) {
    state.date = next;
    state.month = null;
    render();
  } else rovingMonth(next);
  $(`.mnum${sel('data-goto-day', next)}`, viewEl)?.focus();
});

// Enter or Space on a focused event or task opens its card.
viewEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target.closest('[data-ev], [data-task]');
  if (!item || item !== e.target) return;
  e.preventDefault();
  e.stopPropagation();
  if (item.dataset.ev) openEventPopover(item.dataset.ev, item);
  else openTaskPopover(item.dataset.task, item);
});

function eventMenu(key, at, anchorEl) {
  const inst = instMap.get(key);
  if (!inst) return;
  const note = meetingNote(inst.event, inst.occurrence);
  openMenu(at, [
    { label: 'Open', icon: 'info', keys: 'enter', onSelect: () => openEventPopover(key, anchorEl) },
    { label: 'Edit…', icon: 'edit', keys: 'e', onSelect: () => openEditor({ key }) },
    { label: 'Duplicate', icon: 'copy', onSelect: () => duplicateInstance(key) },
    { label: note ? 'Open meeting notes' : 'Meeting notes', icon: 'note', onSelect: () => (location.href = note ? notesHref.note(note.id) : notesHref.meeting(inst.event.id, inst.occurrence)) },
    { sep: true },
    { label: 'Delete', icon: 'trash', keys: 'backspace', danger: true, onSelect: () => keepFocusNear(liveAnchor(anchorEl, 'data-ev', key), () => deleteInstance(key)) },
  ]);
}
function taskMenu(id, at, anchorEl) {
  const t = db.get('tasks', id);
  if (!t) return;
  const act = (fn) => () => keepFocusNear(liveAnchor(anchorEl, 'data-task', id), fn);
  openMenu(at, [
    { label: 'Open', icon: 'info', keys: 'enter', onSelect: () => openTaskPopover(id, anchorEl) },
    { label: 'Edit in Tasks', icon: 'edit', onSelect: () => (location.href = `../tasks/#/task/${enc(id)}`) },
    { label: t.done ? 'Mark uncompleted' : 'Mark completed', icon: 'done', keys: 'x', onSelect: act(() => completeTask(id)) },
    !t.time && !t.done && { label: 'Add time…', icon: 'clock', onSelect: () => pickTaskTime(id, anchorEl) },
    t.time && { label: 'Remove time', icon: 'clock', onSelect: act(() => unscheduleTask(id, { timeOnly: true })) },
    t.date && { label: 'Remove from calendar', icon: 'no-date', onSelect: act(() => unscheduleTask(id, { timeOnly: false })) },
    { sep: true },
    { label: 'Delete task', icon: 'trash', danger: true, onSelect: act(() => removeTask(id)) },
  ]);
}
const menuPoint = (e, el) => {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect(); // opened from the keyboard
  return { x: r.left + 8, y: r.bottom };
};
viewEl.addEventListener('contextmenu', (e) => {
  if (isTyping(e)) return;
  // A touch long press on the grid lifts the block instead; letting go without moving opens this menu.
  if (gesture?.touch && gesture.el) return void e.preventDefault();
  const ev = e.target.closest('[data-ev]');
  const tk = !ev && e.target.closest('[data-task]');
  if (!ev && !tk) return;
  e.preventDefault();
  if (ev) eventMenu(ev.dataset.ev, menuPoint(e, ev), ev);
  else taskMenu(tk.dataset.task, menuPoint(e, tk), tk);
});

// ---------------------------------------------------------------- drag tasks in (panel, all-day row, month, or a tasks window)

let dragTask = null;
let dropGhost = null;
const TASK_MIME = 'text/x-ecosys-task';
const hasTask = (e) => Array.from(e.dataTransfer?.types || []).includes(TASK_MIME);
const clearDrop = () => {
  dropGhost?.remove();
  dropGhost = null;
  $$('.drop').forEach((el) => el.classList.remove('drop'));
};
/** A small themed chip under the pointer instead of the browser's snapshot of the row. */
function dragChip(title, color) {
  const c = document.createElement('div');
  c.className = 'drag-chip';
  c.style.setProperty('--ev', color);
  c.innerHTML = '<span class="dc-dot" aria-hidden="true"></span><span class="dc-t"></span>';
  $('.dc-t', c).textContent = title;
  document.body.append(c);
  return c;
}

document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('[data-ptask], .ad-item[data-task], .mitem[data-task]');
  if (!el) return;
  const id = el.dataset.ptask || el.dataset.task;
  const t = db.get('tasks', id);
  dragTask = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(TASK_MIME, id);
  e.dataTransfer.setData('text/plain', t?.title || '');
  const chip = dragChip(t?.title || 'Task', taskColor(t, listMap()));
  try {
    e.dataTransfer.setDragImage(chip, 16, 16);
  } catch {
    /* older browsers keep their own image */
  }
  setTimeout(() => chip.remove());
  requestAnimationFrame(() => el.classList.add('dragging'));
});
document.addEventListener('dragend', () => {
  $$('.dragging').forEach((el) => el.classList.remove('dragging'));
  clearDrop();
  dragTask = null;
});

/** Plan a dropped task; if its list (or all tasks) is hidden on the calendar, show it so the block never vanishes. */
function planTask(id, date, time, dur) {
  const t = db.get('tasks', id);
  if (!t) return null;
  const s = settings.get();
  const undoTask = scheduleTask(id, date, time, time ? dur : t.duration);
  const reveal = {};
  if (!s.showTasksInSchedule) reveal.showTasksInSchedule = true;
  const k = taskListKey(t);
  if ((s.hiddenTaskLists || []).includes(k)) reveal.hiddenTaskLists = s.hiddenTaskLists.filter((x) => x !== k);
  if (Object.keys(reveal).length) settings.set(reveal);
  // The undo hides again only what this showed, and only while it is still shown: other changes to these
  // settings made since (here or in another tab) stay.
  return () => {
    undoTask();
    const now = settings.get();
    const back = {};
    if (reveal.showTasksInSchedule && now.showTasksInSchedule) back.showTasksInSchedule = false;
    if (reveal.hiddenTaskLists && !(now.hiddenTaskLists || []).includes(k)) back.hiddenTaskLists = [...(now.hiddenTaskLists || []), k];
    if (Object.keys(back).length) settings.set(back);
  };
}

viewEl.addEventListener('dragover', (e) => {
  if (!hasTask(e)) return;
  const col = e.target.closest('.col');
  const cell = e.target.closest('[data-allday-date], [data-mdate]');
  if (!col && !cell) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (col) {
    const m = gridMetrics();
    const p = posAt(m, e.clientX, e.clientY);
    const t = dragTask && db.get('tasks', dragTask);
    const dur = Math.min(1440, t?.duration || settings.get().defaultTaskMinutes || 30);
    const top = Math.min(1440 - dur, Math.max(0, Math.round((p.raw - 10) / 15) * 15));
    const target = m.cols[p.ci];
    if (!dropGhost || dropGhost.parentElement !== target) {
      dropGhost?.remove();
      dropGhost = makeGhost(target, top, top + dur, t?.title || 'Task', taskColor(t, listMap()));
    }
    placeBlock(dropGhost, top, top + dur);
    minutesTime(dropGhost, top, top + dur);
    dropGhost.dataset.top = top;
  } else {
    $$('.drop').forEach((el) => el !== cell && el.classList.remove('drop'));
    cell.classList.add('drop');
  }
});
viewEl.addEventListener('dragleave', (e) => {
  if (!viewEl.contains(e.relatedTarget)) clearDrop();
});
viewEl.addEventListener('drop', (e) => {
  if (!hasTask(e)) return;
  e.preventDefault();
  const id = e.dataTransfer.getData(TASK_MIME);
  const t = db.get('tasks', id);
  const col = e.target.closest('.col');
  const cell = e.target.closest('[data-allday-date], [data-mdate]');
  const ghostTop = dropGhost ? +dropGhost.dataset.top : null;
  clearDrop();
  if (!t) return toast('That task no longer exists');
  if (col && ghostTop !== null && isYmd(col.dataset.date)) {
    const dur = t.duration || settings.get().defaultTaskMinutes || 30;
    const undo = planTask(id, col.dataset.date, fromMinutes(ghostTop), dur);
    if (undo) undoable(`Blocked ${fmtDuration(dur)} for “${t.title}”`, undo);
  } else if (cell) {
    const date = cell.dataset.alldayDate || cell.dataset.mdate;
    if (!isYmd(date) || (date === t.date && !t.time)) return;
    const undo = planTask(id, date, null, t.duration);
    if (undo) undoable(`“${t.title}” planned for ${dayLabel(date)}`, undo);
  }
});

panelEl.addEventListener('dragover', (e) => {
  if (!hasTask(e)) return;
  const sec = e.target.closest('[data-panel-drop]');
  if (!sec) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  $$('.drop', panelEl).forEach((el) => el !== sec && el.classList.remove('drop'));
  sec.classList.add('drop');
});
panelEl.addEventListener('dragleave', (e) => {
  if (!panelEl.contains(e.relatedTarget)) $$('.drop', panelEl).forEach((el) => el.classList.remove('drop'));
});
panelEl.addEventListener('drop', (e) => {
  const sec = e.target.closest('[data-panel-drop]');
  if (!sec || !hasTask(e)) return;
  e.preventDefault();
  clearDrop();
  const t = db.get('tasks', e.dataTransfer.getData(TASK_MIME));
  if (!t) return;
  const date = isYmd(sec.dataset.panelDrop) ? sec.dataset.panelDrop : null;
  if (t.date === date && !t.time) return;
  const before = structuredClone(t);
  const after = db.update('tasks', t.id, { date, time: null });
  undoable(date ? `“${t.title}” planned for ${dayLabel(date)}` : 'Date removed', () => revertChange('tasks', before, after));
});

function openPanelTask(row) {
  const id = row.dataset.ptask;
  const t = db.get('tasks', id);
  if (!t) return;
  const block = t.time && $(`.ev${sel('data-task', id)}`, viewEl);
  if (block) {
    block.scrollIntoView({ block: 'center', behavior: smooth() });
    block.classList.remove('flash');
    void block.offsetWidth;
    return block.classList.add('flash');
  }
  openTaskPopover(id, row);
}
panelEl.addEventListener('click', (e) => {
  const check = e.target.closest('[data-task-check]');
  if (check) return completeTask(check.closest('[data-ptask]')?.dataset.ptask);
  if (e.target.closest('[data-show-tasks]')) return settings.set({ showTasksInSchedule: true });
  if (e.target.closest('[data-show-lists]')) return settings.set({ hiddenTaskLists: [] });
  const row = e.target.closest('[data-ptask]');
  if (row) openPanelTask(row);
});
panelEl.addEventListener('keydown', (e) => {
  // The phone sheet is a modal dialog: Tab stays in it, and Esc closes it from its text field too.
  if (panelEl.getAttribute('aria-modal') === 'true') {
    trapTab(e, panelEl);
    if (e.key === 'Escape' && isTyping(e) && !e.isComposing && !e.defaultPrevented && !hasOpenLayer()) {
      e.preventDefault();
      return togglePanel(false);
    }
  }
  const row = e.target.closest('[data-ptask]');
  if (row && row === e.target && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    e.stopPropagation();
    return openPanelTask(row);
  }
  const input = e.target.closest('[data-panel-add]');
  if (!input || e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
  e.preventDefault();
  const p = parse(input.value, { mode: 'task', lists: db.all('lists'), hour12: hour12(), dmy: isDmy });
  const undo = trackChanges(() => createTask({ ...p, title: p.title || input.value.trim() }), ['tasks', 'lists']);
  input.value = '';
  const t = undo.result;
  // A task planned for another day than the panel's (a time already past today goes to tomorrow) says where it went.
  if (t) undoable(t.date && t.date !== focusDate() ? `Added “${t.title}” · ${dayLabel(t.date)}${t.time ? `, ${fmtClock(t.time)}` : ''}` : `Added “${t.title}”`, undo, `added “${t.title}”`);
});
panelEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-ptask]');
  if (!row || isTyping(e)) return;
  e.preventDefault();
  taskMenu(row.dataset.ptask, menuPoint(e, row), row);
});

// ---------------------------------------------------------------- calendars

function editCalendarDialog(cal) {
  let color = cal?.color || COLORS.find((c) => !db.all('calendars').some((x) => x.color === c)) || 'iris';
  const { el, close } = openModal({
    title: cal ? 'Edit calendar' : 'New calendar',
    className: 'cal-dialog',
    body: `<form class="modal-body" data-cal-form novalidate autocomplete="off">
      <input class="input cd-name" name="calName" placeholder="Calendar name" value="${esc(cal?.name || '')}" maxlength="60" aria-label="Calendar name" autocomplete="off" data-autofocus>
      <div class="cd-label" id="cd-colour">Colour</div>
      <div class="swatches" role="radiogroup" aria-labelledby="cd-colour">${COLORS.map((c) => `<button type="button" class="swatch-btn" role="radio" style="--sw:${colorVar(c)}" data-color="${esc(c)}" aria-checked="${c === color}" tabindex="${c === color ? 0 : -1}" aria-label="${esc(capital(c))}" ${tipAttrs(capital(c))}>${icon('check')}</button>`).join('')}</div>
      <div class="cd-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary" data-cd-save${String(cal?.name || '').trim() ? '' : ' disabled'}>${cal ? 'Save' : 'Create calendar'}</button></div>
    </form>`,
  });
  const form = $('[data-cal-form]', el);
  const nameEl = form.elements.calName;
  const save = $('[data-cd-save]', el);
  nameEl.addEventListener('input', () => (save.disabled = !nameEl.value.trim()));
  const pick = (b) => {
    color = b.dataset.color;
    $$('[data-color]', el).forEach((x) => {
      x.setAttribute('aria-checked', String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    });
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (b) pick(b);
  });
  $('.swatches', el).addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const all = $$('[data-color]', el);
    const next = all[(all.indexOf(document.activeElement) + dir + all.length) % all.length];
    pick(next);
    next.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameEl.value.trim();
    if (!name) return nameEl.focus();
    if (cal) db.update('calendars', cal.id, { name, color });
    else db.insert('calendars', { name, color, visible: true, order: db.all('calendars').length });
    close();
  });
}

async function deleteCalendar(cal) {
  if (db.all('calendars').length <= 1) return toast('You need at least one calendar');
  const events = db.all('events').filter((e) => e.calendarId === cal.id);
  const ok = await confirmDialog({ title: `Delete “${cal.name}”?`, message: events.length ? `Its ${events.length} ${events.length === 1 ? 'event' : 'events'} will be deleted too.` : '', confirm: 'Delete calendar', danger: true });
  if (!ok) return;
  const undo = trackChanges(() => {
    db.remove('calendars', cal.id);
    for (const e of events) db.remove('events', e.id);
  }, ['calendars', 'events']);
  undoable(`Deleted “${cal.name}”`, undo);
}

function taskListsMenu(anchor) {
  const hidden = new Set(settings.get().hiddenTaskLists || []);
  const toggle = (id) => {
    const h = new Set(settings.get().hiddenTaskLists || []);
    if (h.has(id)) h.delete(id);
    else h.add(id);
    settings.set({ hiddenTaskLists: [...h] });
  };
  openMenu(
    anchor,
    [
      { heading: 'Show tasks from' },
      // Several can be on at once: checkboxes, not radios (multi).
      { label: 'Inbox', icon: 'inbox', checked: !hidden.has('inbox'), multi: true, onSelect: () => toggle('inbox') },
      ...listsSorted().map((l) => ({ label: l.name, iconHtml: `<span class="swatch-dot" style="background:${colorVar(l.color)}"></span>`, checked: !hidden.has(l.id), multi: true, onSelect: () => toggle(l.id) })),
      { sep: true },
      { label: 'Open Tasks', icon: 'arrow-up-right', onSelect: () => (location.href = '../tasks/') },
    ],
    { label: 'Task lists' },
  );
}

// ---------------------------------------------------------------- chrome events

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-create]')) {
    closeDrawer(); // Create in the drawer: the drawer goes first, and Create gives focus back to the menu button
    return openCreate();
  }
  if (t.closest('[data-nav-toggle]')) return toggleSidebar(t.closest('[data-nav-toggle]'));
  if (t.closest('[data-close-nav]')) return closeDrawer();
  if (t.closest('[data-toggle-panel]')) return togglePanel(undefined, { from: t.closest('[data-toggle-panel]') });
  if (t.closest('[data-close-panel]')) return togglePanel(false);
  if (t.closest('[data-today]')) return goToday();
  const st = t.closest('.nav-arrows [data-step]');
  if (st) return step(+st.dataset.step);
  const vb = t.closest('#view-btn');
  if (vb) return viewMenu(vb);
  const tab = t.closest('[data-tab]')?.dataset.tab;
  if (tab === 'tasks') return togglePanel(undefined, { from: t.closest('[data-tab]') });
  // Month again zooms out to the year, and back (Apple).
  if (tab === 'month') return setView(effView() === 'month' ? 'year' : 'month');
  // On a phone, Week already shows as a few days: "Days" saves Week, so a desktop keeps opening in Week.
  if (tab) return setView(tab === 'days' && narrow() ? 'week' : tab);
  const dv = t.closest('#side-views [data-view]');
  if (dv) {
    closeDrawer(); // focus goes back to its button
    return setView(dv.dataset.view);
  }
  const rt = t.closest('#range-title');
  if (rt) return goToDatePicker(rt);
  const mc = t.closest('#minical [data-mc]');
  if (mc) {
    const k = mc.dataset.mc;
    const base = state.month || parseYmd(state.date);
    state.month = k === 'today' ? new Date() : new Date(base.getFullYear(), base.getMonth() + (k === 'next' ? 1 : -1), 1);
    state.miniFocus = null;
    const hadFocus = mc === document.activeElement || e.detail === 0;
    renderSidebar();
    // The month's heading is redrawn with it, so it isn't read: the new month is announced, and the
    // arrow that was pressed (redrawn too) keeps focus.
    announce(monthTitle(state.month));
    if (hadFocus) $(`#minical ${sel('data-mc', k)}`)?.focus({ preventScroll: true });
    return;
  }
  const md = t.closest('#minical [data-date]');
  if (md && isYmd(md.dataset.date)) {
    state.date = md.dataset.date;
    state.month = null;
    state.miniFocus = null;
    closeDrawer();
    return render();
  }
  const calT = t.closest('[data-cal-toggle]');
  if (calT) {
    const c = db.get('calendars', calT.dataset.calToggle);
    return c && db.update('calendars', c.id, { visible: c.visible === false });
  }
  const calM = t.closest('[data-cal-menu]');
  if (calM) {
    const c = db.get('calendars', calM.dataset.calMenu);
    if (!c) return;
    return openMenu(calM, [
      { label: 'Display this only', icon: 'eye', onSelect: () => db.batch(() => db.all('calendars').forEach((x) => db.update('calendars', x.id, { visible: x.id === c.id }))) },
      { label: 'Edit…', icon: 'edit', onSelect: () => editCalendarDialog(c) },
      { sep: true },
      { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => deleteCalendar(c) },
    ], { label: c.name });
  }
  if (t.closest('[data-add-cal]')) return editCalendarDialog(null);
  if (t.closest('[data-toggle-tasks]')) return settings.set({ showTasksInSchedule: !settings.get().showTasksInSchedule });
  const tm = t.closest('[data-tasks-menu]');
  if (tm) return taskListsMenu(tm);
});

// Mini calendar: one tab stop; arrow keys move through the days, Home / End go to the week's ends, Page Up /
// Page Down a month (the same day, or that month's last). Enter picks one. As in Home and the date picker.
$('#minical').addEventListener('keydown', (e) => {
  const day = e.target.closest('.mc-day');
  if (!day || e.metaKey || e.ctrlKey || e.altKey || !isYmd(day.dataset.date)) return;
  const cur = day.dataset.date;
  const d = parseYmd(cur);
  const col = (d.getDay() - settings.get().weekStart + 7) % 7;
  const month = (n) => {
    const m = new Date(d.getFullYear(), d.getMonth() + n, 1);
    return ymd(new Date(m.getFullYear(), m.getMonth(), Math.min(d.getDate(), daysInMonth(m.getFullYear(), m.getMonth()))));
  };
  const next = { ArrowLeft: () => addDaysYmd(cur, -1), ArrowRight: () => addDaysYmd(cur, 1), ArrowUp: () => addDaysYmd(cur, -7), ArrowDown: () => addDaysYmd(cur, 7), Home: () => addDaysYmd(cur, -col), End: () => addDaysYmd(cur, 6 - col), PageUp: () => month(-1), PageDown: () => month(1) }[e.key]?.();
  if (!next) return;
  e.preventDefault(); // the document keydown handler skips defaultPrevented events
  const nd = parseYmd(next);
  const m = state.month || parseYmd(state.date);
  if (nd.getMonth() !== m.getMonth() || nd.getFullYear() !== m.getFullYear()) state.month = new Date(nd.getFullYear(), nd.getMonth(), 1);
  state.miniFocus = next;
  renderSidebar();
  $(`#minical ${sel('data-date', next)}`)?.focus();
});

$('#sidebar').addEventListener('keydown', (e) => drawer && trapTab(e, e.currentTarget));
// Crossing 900px: a drawer left open becomes the sidebar again. Crossing 640px: the Tasks panel becomes a
// sheet (modal) or a side panel.
narrowMq.addEventListener('change', () => {
  if (!narrowMq.matches) closeDrawer({ restoreFocus: false });
  syncNavToggle();
});
midMq.addEventListener('change', syncNavToggle); // the open panel holds the sidebar's place from 901 to 1280px
phoneMq.addEventListener('change', () => {
  hourCache = 0; // --hour is 46px on a phone, 48px wider
  syncLayers();
});

function viewMenu(anchor) {
  const cur = effView();
  anchor.setAttribute('aria-expanded', 'true');
  openMenu(
    anchor,
    VIEWS.map((v) => ({ label: capital(viewLabel(v)), checked: cur === v.id, keys: v.key, onSelect: () => setView(v.id) })),
    { align: 'end', label: 'View', onClose: () => anchor.setAttribute('aria-expanded', 'false') },
  );
}

function goToDatePicker(anchor) {
  openDatePicker(anchor, {
    value: state.date,
    title: 'Go to date',
    allowClear: false,
    onPick: ({ date }) => {
      if (!isYmd(date)) return;
      state.date = date;
      state.month = null;
      state.agendaSpan = 60;
      render();
    },
  });
}

// ---------------------------------------------------------------- keyboard (Google Calendar's keys)

document.addEventListener('keydown', (e) => {
  // Mod+\ hides or shows the sidebar (opens the drawer when narrow), as in Tasks and Notes; also while typing.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'Backslash' && !e.defaultPrevented && !hasOpenLayer()) {
    e.preventDefault();
    return toggleSidebar();
  }
  // Single-key shortcuts can be turned off in Settings (WCAG 2.1.4); arrows, Delete and Escape still work.
  if (e.defaultPrevented || hasOpenLayer() || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || singleKeyOff(e)) return;
  // Keys for the focused event or task.
  const a = document.activeElement;
  const item = a && a !== document.body && a.matches?.('[data-ev], [data-task], [data-ptask]') ? a : null;
  if (item) {
    const key = item.dataset.ev;
    const tid = item.dataset.task || item.dataset.ptask;
    let fn = null;
    // Deleting, completing off the panel or unscheduling removes the item: focus moves to its neighbour.
    const near = (action) => () => keepFocusNear(item, action);
    if (key && e.key === 'e') fn = () => openEditor({ key });
    else if (key && (e.key === 'Delete' || e.key === 'Backspace')) fn = near(() => deleteInstance(key));
    else if (tid && e.key === 'x') fn = near(() => completeTask(tid));
    else if (tid && (e.key === 'Delete' || e.key === 'Backspace')) fn = near(() => unscheduleTask(tid));
    // Esc deselects and keeps focus on the item; with nothing selected it goes on to close the Tasks panel.
    else if (e.key === 'Escape' && state.sel)
      fn = () => {
        state.sel = null;
        markSelection();
      };
    if (fn) {
      e.preventDefault();
      return fn();
    }
  }
  if (e.key === 'Escape') {
    if (drawer) closeDrawer();
    else if (state.panel && innerWidth <= 1280) togglePanel(false);
    return;
  }
  // The page behind an open drawer or phone sheet is inert: its keys wait (i still closes the sheet).
  if (drawer || (panelSheet() && e.key !== 'i')) return;
  // The arrow keys step the range only while nothing has focus (or the range's own Today / Previous / Next
  // buttons do): on any other control (an event, a day, a checkbox in the sidebar) they belong to that
  // control, and screen readers send them in focus mode.
  const free = !a || a === document.body || !!a.closest?.(FREE_KEYS);
  const map = {
    t: goToday,
    j: () => step(1),
    n: () => step(1),
    k: () => step(-1),
    p: () => step(-1),
    ...(free ? { ArrowRight: () => step(1), ArrowLeft: () => step(-1) } : {}),
    c: () => openCreate(),
    g: () => goToDatePicker($('#range-title')),
    i: () => togglePanel(),
    '/': () => openPalette(),
  };
  for (const v of VIEWS) map[v.key] = map[v.num] = () => setView(v.id);
  const fn = Object.hasOwn(map, e.key) ? map[e.key] : null;
  if (fn) {
    e.preventDefault();
    fn();
  }
});

registerShortcuts([
  {
    title: 'Navigate',
    items: [
      ['Today', 't'],
      ['Next / previous', 'j / k'],
      ['Go to date', 'g'],
      ['Search', '/'],
      ['Tasks panel', 'i'],
      ['Sidebar', 'mod \\'],
    ],
  },
  {
    title: 'Views',
    items: [
      ['Day', 'd'],
      ['Days', 'x'],
      ['Week', 'w'],
      ['Month', 'm'],
      ['Year', 'y'],
      ['Schedule', 'a'],
    ],
  },
  {
    title: 'Events and tasks',
    items: [
      ['Create', 'c'],
      ['Open the focused item', 'enter'],
      ['Edit the event', 'e'],
      ['Delete the event', 'backspace'],
      ['Complete the task', 'x'],
      ['Deselect', 'esc'],
    ],
  },
  {
    title: 'Type it in Create',
    examples: true,
    items: [
      ['Day & time', 'Lunch fri 1pm'],
      ['Length & place', 'for 90m at Cafe Luna'],
      ['Repeat', 'every weekday'],
      ['Calendar', '#Work'],
    ],
  },
]);

// ---------------------------------------------------------------- palette

/** The occurrence of `e` to show for search: its next one from today, else its start. Expands only this event. */
function nextOccurrenceDate(e, today) {
  const start = e.start.slice(0, 10);
  if (!e.repeat) return start;
  const span = Math.max(0, diffDays(start, e.end.slice(0, 10)));
  return occurrencesBetween(e.repeat, start, addDaysYmd(today, -span), addDaysYmd(today, 400), { exdates: e.exdates || [], until: e.until || null })[0] || start;
}

registerPaletteProvider(
  (q) => {
    const out = [];
    const s = settings.get();
    if (q) {
      const today = todayYmd();
      const cals = new Map(db.all('calendars').map((c) => [c.id, c]));
      const hits = db
        .all('events')
        .map((e) => ({ e, sc: score(`${e.title} ${e.location || ''} ${e.notes || ''}`, q) }))
        .filter((x) => x.sc)
        .sort((a, b) => b.sc - a.sc)
        .slice(0, 8);
      for (const { e } of hits) {
        const date = nextOccurrenceDate(e, today);
        const time = !e.allDay && e.start.length > 10 ? ` ${fmtClock(e.start.slice(11, 16))}` : '';
        out.push({
          group: 'Events',
          label: untitled(e.title),
          sub: `${dayLabel(date)}${time}${e.repeat ? ' · repeats' : ''}`,
          iconHtml: `<span class="swatch-dot" style="background:${colorVar(cals.get(e.calendarId)?.color)}"></span>`,
          run: () => revealEvent(e.id, date),
        });
      }
    }
    const day = focusDate();
    const cmds = [
      { label: 'Create event', icon: 'calendar-plus', keys: 'c', run: () => openCreate() },
      { label: 'Go to today', icon: 'today', keys: 't', run: goToday },
      { label: 'Go to date…', icon: 'calendar', keys: 'g', run: () => goToDatePicker($('#range-title')) },
      { label: 'Open day note', sub: dayLabel(day), words: 'daily journal notes', icon: 'note', run: () => (location.href = notesHref.day(day)) },
      { label: state.panel ? 'Hide tasks panel' : 'Show tasks panel', icon: 'checklist', keys: 'i', run: () => togglePanel() },
      ...VIEWS.map((v) => ({ label: `${capital(viewLabel(v))} view`, icon: v.icon, keys: v.key, run: () => setView(v.id) })),
      { label: s.showTasksInSchedule ? 'Hide tasks on the calendar' : 'Show tasks on the calendar', icon: s.showTasksInSchedule ? 'eye-off' : 'eye', run: () => settings.set({ showTasksInSchedule: !s.showTasksInSchedule }) },
      { label: 'New calendar', icon: 'plus', run: () => editCalendarDialog(null) },
    ];
    for (const c of cmds) if (!q || score(`${c.label} ${c.words || ''}`, q)) out.push({ group: 'Schedule', ...c });
    if (!q) return out.slice(0, 5);
    // Creating from the query is the fallback, after the matching events and commands, so Enter on
    // "settings" or "week view" runs the command. `fallback` asks the palette to keep these after the
    // other apps' search results and the built-in commands too.
    out.push(
      { group: 'Create', label: `Create event “${q}”`, icon: 'calendar-plus', fallback: true, run: () => openCreate({ prefill: q }) },
      { group: 'Create', label: `Create task “${q}”`, icon: 'circle-plus', fallback: true, run: () => openCreate({ prefill: q, mode: 'task' }) },
    );
    return out;
  },
  { prepend: true },
);

// ---------------------------------------------------------------- routing

function route() {
  closeCards(); // back / forward while a card is open: the card belongs to the view being left
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [a, b, c, d] = path.split('/');
  if (VIEWS.some((v) => v.id === a)) state.view = a;
  if (b && isYmd(b)) state.date = b;
  state.month = null;
  state.scrolledOnce = false;
  render();
  const id = d ? safeDecode(d) : null;
  if (!id) return;
  if (c === 'event') return revealEvent(id, state.date);
  if (c !== 'task') return;
  const t = db.get('tasks', id);
  if (!t) return;
  requestAnimationFrame(() => {
    const block = t.time && $(`.ev${sel('data-task', t.id)}`, viewEl);
    if (block) {
      block.scrollIntoView({ block: 'center' });
      block.focus({ preventScroll: true });
      return block.classList.add('flash');
    }
    if (!state.panel) {
      togglePanel(true, { focus: false });
      if (panelEl.hidden) render(); // wide screens show it on the settings change, a moment later: now, so the row is there
    }
    const row = $(sel('data-ptask', t.id), panelEl);
    row?.scrollIntoView({ block: 'center' });
    row?.classList.add('flash');
    toast(touchUI() ? `Tap “${t.title}”, then Add time, to block time for it` : `Drag “${t.title}” onto the calendar to block time for it`, { duration: 6000 });
  });
}
window.addEventListener('hashchange', route);
route();
