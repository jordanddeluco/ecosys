// schedule — the ecosys calendar. Shows events and the tasks from `tasks` on one timeline.
import {
  initShell, esc, $, $$, icon, toast, undoable, openMenu, openPopover, openModal, openDatePicker, choiceDialog, confirmDialog,
  registerPaletteProvider, registerShortcuts, openPalette, openSettings, score, sidebarHead, sidebarFoot, hasOpenLayer, isTyping,
} from '../shared/shell.js';
import { db, settings } from '../shared/store.js';
import {
  todayYmd, addDaysYmd, parseYmd, ymd, fmt, dayLabel, fmtTime, fmtDuration, diffDays, hour12, pad, startOfWeek, startOfMonth,
  addDays, parseDT, fmtDT, fromMinutes, WEEKDAY_SHORT, daysInMonth,
} from '../shared/dates.js';
import { parse } from '../shared/nlp.js';
import { describe, presets } from '../shared/recur.js';
import {
  eventInstances, dayInstances, layoutColumns, createEvent, detachOccurrence, splitSeries, scheduledTasks, toggleTask,
  createTask, colorVar, COLORS, scheduleTask, byTimeThenOrder, byOrder,
} from '../shared/model.js';
import { miniCalendar } from '../shared/minical.js';

initShell({ app: 'schedule' });

const VIEWS = [
  { id: 'day', label: 'Day', key: 'd', num: '1' },
  { id: 'days', label: '3 Days', key: 'x', num: '2' },
  { id: 'week', label: 'Week', key: 'w', num: '3' },
  { id: 'month', label: 'Month', key: 'm', num: '4' },
  { id: 'agenda', label: 'Agenda', key: 'a', num: '5' },
];

const state = {
  view: settings.get().scheduleView || 'week',
  date: todayYmd(),
  month: null,
  sel: null, // {kind:'event', key} | {kind:'task', id}
  panel: innerWidth > 1280,
  alldayOpen: false,
  scrolledOnce: false,
};
let instMap = new Map();
let gesture = null;
let pendingRender = false;
const isDmy = !/^en-US|^en-CA|^en-PH/.test(navigator.language || 'en-US') && /^en|^de|^fr|^es|^it|^nl|^pt/.test(navigator.language || '');
const narrow = () => innerWidth < 640;
const effView = () => (narrow() && state.view === 'week' ? 'days' : state.view);
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dtFrom = (dateYmd, minutes) => {
  const d = parseYmd(dateYmd);
  d.setMinutes(minutes);
  return fmtDT(d);
};
const listMap = () => new Map(db.all('lists').map((l) => [l.id, l]));
const calsSorted = () => [...db.all('calendars')].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const taskColor = (t, lists) => colorVar(lists.get(t.listId)?.color || 'iris');

// ---------------------------------------------------------------- layout

$('#app').innerHTML = `
<div class="shell" id="shell">
  <aside class="sidebar" id="sidebar">
    ${sidebarHead('schedule')}
    <div class="side-cta"><button type="button" class="btn btn-primary btn-block btn-lg" data-new-event>${icon('plus', { size: 20, stroke: 2.4 })}New event</button></div>
    <div class="side-scroll">
      <div class="side-cal" id="minical"></div>
      <div class="side-section">
        <div class="side-label"><span>Calendars</span><button type="button" class="icon-btn sm" data-add-cal aria-label="New calendar" title="New calendar">${icon('plus', { size: 16 })}</button></div>
        <div id="cal-list"></div>
      </div>
      <div class="side-section">
        <div class="side-label"><span>From tasks</span><a class="icon-btn sm" href="../tasks/" aria-label="Open tasks" title="Open tasks">${icon('arrow-up-right', { size: 15 })}</a></div>
        <div id="tasklist-toggles"></div>
      </div>
    </div>
    ${sidebarFoot()}
  </aside>
  <div class="side-overlay" data-close-nav></div>
  <main class="main" id="main">
    <header class="topbar" id="topbar">
      <button type="button" class="icon-btn menu-toggle" data-toggle-nav aria-label="Open menu">${icon('menu')}</button>
      <button type="button" class="range-title" id="range-title" title="Go to date (g)"></button>
      <div class="nav-btns">
        <button type="button" class="icon-btn" data-nav="-1" aria-label="Previous" title="Previous (k)">${icon('chevron-left')}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-today title="Today (t)">Today</button>
        <button type="button" class="icon-btn" data-nav="1" aria-label="Next" title="Next (j)">${icon('chevron-right')}</button>
      </div>
      <div class="nl-wrap" id="nl-wrap">
        <label class="search-pill">${icon('sparkle', { size: 17 })}<input id="nl" type="text" autocomplete="off" spellcheck="false" placeholder="New event — “Lunch with Sam fri 1pm at Cafe Luna”" aria-label="Quick add event"></label>
        <div class="nl-preview" id="nl-preview" hidden></div>
      </div>
      <div class="view-switch"><div class="segmented" id="view-seg" role="group" aria-label="View">${VIEWS.map((v) => `<button type="button" data-view="${v.id}" title="${v.label} (${v.key})">${v.label}</button>`).join('')}</div></div>
      <button type="button" class="icon-btn" data-toggle-panel aria-label="Tasks panel" title="Tasks panel (i)">${icon('checklist')}</button>
      <button type="button" class="icon-btn" id="more-menu" aria-label="More" title="More">${icon('more')}</button>
    </header>
    <div class="view" id="view"></div>
  </main>
  <aside class="taskpanel" id="panel" hidden aria-label="Tasks"></aside>
  <nav class="tabbar" id="tabbar" aria-label="Views"></nav>
  <button type="button" class="fab" data-new-event aria-label="New event">${icon('plus', { size: 26, stroke: 2.4 })}</button>
</div>`;

const shellEl = $('#shell');
const viewEl = $('#view');
const panelEl = $('#panel');
const nlInput = $('#nl');
const nlPreview = $('#nl-preview');

// ---------------------------------------------------------------- range & title

function range() {
  const v = effView();
  const s = settings.get();
  const d = parseYmd(state.date);
  let days = [];
  if (v === 'day') days = [state.date];
  else if (v === 'days') days = Array.from({ length: s.scheduleDays || 3 }, (_, i) => addDaysYmd(state.date, i));
  else if (v === 'week') {
    const start = ymd(startOfWeek(d, s.weekStart));
    days = Array.from({ length: 7 }, (_, i) => addDaysYmd(start, i));
  } else if (v === 'month') {
    const first = startOfMonth(d);
    const gridStart = startOfWeek(first, s.weekStart);
    const offset = diffDays(gridStart, first);
    const weeks = Math.ceil((offset + daysInMonth(first.getFullYear(), first.getMonth())) / 7);
    days = Array.from({ length: weeks * 7 }, (_, i) => ymd(addDays(gridStart, i)));
  } else {
    days = Array.from({ length: 60 }, (_, i) => addDaysYmd(state.date, i));
  }
  return { from: days[0], to: days.at(-1), days };
}

function rangeTitle() {
  const v = effView();
  const d = parseYmd(state.date);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  if (v === 'day') return `${fmt(d, { weekday: 'long', month: 'long', day: 'numeric' })}${thisYear ? '' : ` <span>${d.getFullYear()}</span>`}`;
  if (v === 'month') return `${fmt(d, { month: 'long' })} <span>${d.getFullYear()}</span>`;
  if (v === 'agenda') return `Agenda <span>from ${fmt(d, { month: 'short', day: 'numeric' })}</span>`;
  const { from, to } = range();
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (a.getMonth() === b.getMonth()) return `${fmt(a, { month: 'long' })} <span>${a.getFullYear()}</span>`;
  if (a.getFullYear() === b.getFullYear()) return `${fmt(a, { month: 'short' })} – ${fmt(b, { month: 'short' })} <span>${b.getFullYear()}</span>`;
  return `${fmt(a, { month: 'short', year: 'numeric' })} – ${fmt(b, { month: 'short', year: 'numeric' })}`;
}

function step(dir) {
  const v = effView();
  const s = settings.get();
  if (v === 'month') state.date = ymd(new Date(parseYmd(state.date).getFullYear(), parseYmd(state.date).getMonth() + dir, 1));
  else state.date = addDaysYmd(state.date, dir * (v === 'day' ? 1 : v === 'days' ? s.scheduleDays || 3 : v === 'week' ? 7 : 30));
  state.month = null;
  render();
}

function goToday() {
  state.date = todayYmd();
  state.month = null;
  state.scrolledOnce = false;
  render();
}

function setView(v) {
  state.view = v;
  if (settings.get().scheduleView !== v) settings.set({ scheduleView: v });
  else render();
}

function syncHash() {
  const h = `#/${state.view}/${state.date}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const s = settings.get();
  const { from, to } = range();
  const v = effView();
  const month = state.month || parseYmd(state.date);
  const mFrom = ymd(startOfWeek(startOfMonth(month), s.weekStart));
  const mTo = addDaysYmd(mFrom, 41);
  const marks = new Set();
  for (const i of eventInstances(mFrom, mTo)) {
    let d = ymd(i.start);
    const end = i.allDay ? ymd(i.end) : ymd(new Date(i.end - 1));
    for (let g = 0; d <= end && g < 42; g++, d = addDaysYmd(d, 1)) marks.add(d);
  }
  $('#minical').innerHTML = miniCalendar({
    month,
    selected: state.date,
    weekStart: s.weekStart,
    rangeFrom: v === 'week' || v === 'days' ? from : null,
    rangeTo: v === 'week' || v === 'days' ? to : null,
    marks,
    compact: true,
  });
  $('#cal-list').innerHTML = calsSorted()
    .map(
      (c) => `<div class="row-flex" style="gap:0"><button type="button" class="cal-item" role="checkbox" aria-checked="${c.visible !== false}" data-cal-toggle="${c.id}" style="--cc:${colorVar(c.color)}">
        <span class="cal-box">${icon('check')}</span><span class="label">${esc(c.name)}</span></button>
        <button type="button" class="icon-btn sm more" data-cal-menu="${c.id}" aria-label="Calendar options">${icon('more', { size: 16 })}</button></div>`,
    )
    .join('');
  const hidden = new Set(s.hiddenTaskLists || []);
  const lists = [{ id: 'inbox', name: 'Inbox', color: 'graphite' }, ...[...db.all('lists')].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))];
  $('#tasklist-toggles').innerHTML =
    `<button type="button" class="cal-item" role="checkbox" aria-checked="${s.showTasksInSchedule}" data-toggle-tasks style="--cc:var(--accent)"><span class="cal-box">${icon('check')}</span><span class="label">Show tasks on calendar</span></button>` +
    (s.showTasksInSchedule
      ? lists
          .map(
            (l) => `<button type="button" class="cal-item" role="checkbox" aria-checked="${!hidden.has(l.id)}" data-tasklist-toggle="${l.id}" style="--cc:${colorVar(l.color)};padding-left:28px">
              <span class="cal-box" style="border-radius:50%">${icon('check')}</span><span class="label">${esc(l.name)}</span></button>`,
          )
          .join('')
      : '');
}

function renderTopbar() {
  $('#range-title').innerHTML = rangeTitle();
  const v = effView();
  $$('#view-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('[data-toggle-panel]').classList.toggle('active', state.panel);
  document.title = `${fmt(parseYmd(state.date), { month: 'long', year: 'numeric' })} · schedule`;
  $('#tabbar').innerHTML = [
    ['today', 'Today', 'today', false],
    ['days', 'Days', 'calendar', v === 'days' || v === 'day'],
    ['month', 'Month', 'apps', v === 'month'],
    ['agenda', 'Agenda', 'list', v === 'agenda'],
    ['tasks', 'Tasks', 'checklist', state.panel],
  ]
    .map(([id, label, ic, cur]) => `<button type="button" data-tab="${id}" aria-current="${cur}">${icon(ic)}<span>${label}</span></button>`)
    .join('');
}

// ---------------------------------------------------------------- time grid (day / N days / week)

function workload(dayYmd, inst, tasks) {
  const { timed } = dayInstances(inst, dayYmd);
  const ev = timed.reduce((sum, i) => sum + (i.bottom - i.top), 0);
  const tk = tasks.filter((t) => t.date === dayYmd && !t.done).reduce((sum, t) => sum + (t.duration || (t.time ? settings.get().defaultTaskMinutes : 0)), 0);
  return { ev, tk, total: ev + tk };
}

function renderGrid(days) {
  const s = settings.get();
  const from = days[0];
  const to = days.at(-1);
  const inst = eventInstances(from, to);
  const tasks = scheduledTasks(from, to, s);
  const lists = listMap();
  const today = todayYmd();
  const now = new Date();
  const n = days.length;
  instMap = new Map(inst.map((i) => [i.key, i]));

  // header
  const head = days
    .map((d) => {
      const dt = parseYmd(d);
      const w = workload(d, inst, tasks);
      const pct = Math.min(100, Math.round((w.total / 480) * 100));
      return `<button type="button" class="day-head${d === today ? ' today' : ''}${dt.getDay() % 6 === 0 ? ' weekend' : ''}" data-goto-day="${d}" title="${esc(fmt(dt, { weekday: 'long', month: 'long', day: 'numeric' }))}${w.total ? ` · ${fmtDuration(w.total)} planned` : ''}">
        <span class="dow">${WEEKDAY_SHORT[dt.getDay()]}</span><span class="dnum">${dt.getDate()}</span>${pct ? `<span class="load"><i style="width:${pct}%"></i></span>` : ''}</button>`;
    })
    .join('');

  // all-day lanes: all-day/multi-day events span columns; untimed tasks sit in their day
  const adItems = [];
  for (const i of inst) {
    if (!i.allDay && i.end - i.start < 86400000) continue;
    const endYmd = i.allDay ? ymd(i.end) : ymd(new Date(i.end - 1));
    const a = Math.max(0, diffDays(from, ymd(i.start)));
    const b = Math.min(n - 1, diffDays(from, endYmd));
    if (b < 0 || a > n - 1) continue;
    adItems.push({ kind: 'event', i, a, b, contL: ymd(i.start) < from, contR: endYmd > to });
  }
  for (const t of tasks) {
    if (t.time) continue;
    const a = diffDays(from, t.date);
    if (a < 0 || a >= n) continue;
    adItems.push({ kind: 'task', t, a, b: a });
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
    const pos = `left:calc(${(it.a / n) * 100}% + 3px);width:calc(${((it.b - it.a + 1) / n) * 100}% - 6px);top:${it.lane * 24 + 4}px`;
    if (it.kind === 'event') {
      const sel = state.sel?.kind === 'event' && state.sel.key === it.i.key;
      adHtml += `<div class="ad-item${it.contL ? ' cont-l' : ''}${it.contR ? ' cont-r' : ''}${sel ? ' sel' : ''}" data-ev="${it.i.key}" style="--ev:${colorVar(it.i.color)};${pos}" title="${esc(it.i.event.title)}">${it.i.allDay ? '' : `<span style="opacity:.7">${fmtTime(hhmm(it.i.start), { compact: true })}</span>`}${esc(it.i.event.title)}</div>`;
    } else {
      const c = taskColor(it.t, lists);
      adHtml += `<div class="ad-item task${it.t.done ? ' done' : ''}" data-task="${it.t.id}" style="--ev:${c};${pos}" draggable="true" title="${esc(it.t.title)} — drag onto a time to block it">
        <button type="button" class="check sm" role="checkbox" aria-checked="${it.t.done}" style="--c:${c}" data-task-check aria-label="Complete">${icon('check', { size: 9, stroke: 3.4 })}</button>${esc(it.t.title)}</div>`;
    }
  }
  hiddenPerDay.forEach((count, c) => {
    if (count) adHtml += `<button type="button" class="ad-more" data-expand-allday style="left:calc(${(c / n) * 100}% + 3px);top:${shownLanes * 24 + 5}px">+${count} more</button>`;
  });
  if (state.alldayOpen && lanes.length > 3) adHtml += `<button type="button" class="ad-more" data-expand-allday style="right:4px;top:${lanes.length * 24 + 4}px">Show less</button>`;
  const adHeight = Math.max(30, (lanes.length > maxLanes ? shownLanes + 1 : shownLanes) * 24 + 8 + (state.alldayOpen && lanes.length > 3 ? 22 : 0));

  // hour gutter
  let gutter = '';
  for (let h = 1; h < 24; h++) gutter += `<span style="top:calc(var(--hour) * ${h})">${fmtTime(`${pad(h)}:00`, { compact: true })}</span>`;

  // columns
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const cols = days
    .map((d) => {
      const dt = parseYmd(d);
      const { timed } = dayInstances(inst, d);
      const items = timed.map((i) => ({ ...i, kind: 'event' }));
      for (const t of tasks) {
        if (t.date !== d || !t.time) continue;
        const [h, m] = t.time.split(':').map(Number);
        const top = h * 60 + m;
        const dur = t.duration || s.defaultTaskMinutes || 30;
        items.push({ kind: 'task', t, top, bottom: Math.min(1440, top + Math.max(15, dur)) });
      }
      layoutColumns(items);
      const blocks = items
        .map((it) => {
          const short = it.bottom - it.top < 45;
          const pos = `top:calc(var(--hour) * ${it.top / 60} + 1px);height:calc(var(--hour) * ${(it.bottom - it.top) / 60} - 2px);left:calc(${(it.col / it.cols) * 100}% + 2px);width:calc(${(it.span / it.cols) * 100}% - 4px)`;
          const t1 = fromMinutes(it.top);
          const t2 = fromMinutes(it.bottom);
          const timeText = `${fmtTime(t1, { compact: true })} – ${fmtTime(t2, { compact: true })}`;
          if (it.kind === 'event') {
            const e = it.event;
            const sel = state.sel?.kind === 'event' && state.sel.key === it.key;
            const past = it.end < now;
            return `<div class="ev${short ? ' short' : ''}${sel ? ' sel' : ''}${past ? ' past' : ''}" data-ev="${it.key}" data-top="${it.top}" data-bottom="${it.bottom}" style="--ev:${colorVar(it.color)};${pos}">
              <div class="ev-title">${esc(e.title)}</div><div class="ev-time">${short ? fmtTime(t1, { compact: true }) : timeText}</div>${e.location ? `<div class="ev-loc">${esc(e.location)}</div>` : ''}
              <div class="ev-resize" data-resize></div></div>`;
          }
          const t = it.t;
          const c = taskColor(t, lists);
          const sel = state.sel?.kind === 'task' && state.sel.id === t.id;
          return `<div class="ev task-block${short ? ' short' : ''}${t.done ? ' done' : ''}${sel ? ' sel' : ''}" data-task="${t.id}" data-top="${it.top}" data-bottom="${it.bottom}" style="--ev:${c};${pos}">
            <button type="button" class="check sm" role="checkbox" aria-checked="${t.done}" style="--c:${c}" data-task-check aria-label="Complete">${icon('check', { size: 10, stroke: 3.4 })}</button>
            <div class="tb-text"><div class="ev-title">${esc(t.title)}</div>${short ? '' : `<div class="ev-time">${timeText}</div>`}</div>
            <div class="ev-resize" data-resize></div></div>`;
        })
        .join('');
      const nowLine = d === today ? `<div class="now-line" style="top:calc(var(--hour) * ${nowMins / 60})"></div>` : '';
      return `<div class="col${dt.getDay() % 6 === 0 ? ' weekend' : ''}" data-date="${d}">${blocks}${nowLine}</div>`;
    })
    .join('');
  const nowLabel = days.includes(today) ? `<div class="now-label" style="top:calc(var(--hour) * ${nowMins / 60})">${fmtTime(hhmm(now), { compact: true })}</div>` : '';

  const prevScroll = $('.grid-scroll', viewEl)?.scrollTop;
  viewEl.innerHTML = `
    <div class="grid-head" style="--days:${n}"><div class="gutter-head">${esc(shortTz())}</div>${head}</div>
    <div class="allday" style="--days:${n}"><div class="gutter-label">all-day</div>
      <div class="allday-lanes" style="height:${adHeight}px"><div class="allday-cells">${days.map((d) => `<div data-allday-date="${d}"></div>`).join('')}</div>${adHtml}</div></div>
    <div class="grid-scroll"><div class="grid-body" style="--days:${n}"><div class="gutter">${gutter}${nowLabel}</div>${cols}</div></div>`;
  const scroller = $('.grid-scroll', viewEl);
  if (!state.scrolledOnce || prevScroll === undefined) {
    const hour = parseFloat(getComputedStyle(scroller.firstElementChild).getPropertyValue('--hour')) || 52;
    const target = days.includes(today) ? Math.max(0, nowMins / 60 - 2) : settings.get().dayStartHour || 8;
    scroller.scrollTop = target * hour;
    state.scrolledOnce = true;
  } else scroller.scrollTop = prevScroll;
}

function shortTz() {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- month

function renderMonth(days) {
  const s = settings.get();
  const inst = eventInstances(days[0], days.at(-1));
  const tasks = scheduledTasks(days[0], days.at(-1), s);
  const lists = listMap();
  const today = todayYmd();
  const cur = parseYmd(state.date).getMonth();
  instMap = new Map(inst.map((i) => [i.key, i]));
  const weeks = days.length / 7;
  const cellH = Math.max(60, (viewEl.clientHeight - 32) / weeks);
  const cap = Math.max(1, Math.floor((cellH - 30) / (narrow() ? 17 : 22)));
  const head = Array.from({ length: 7 }, (_, i) => `<span>${WEEKDAY_SHORT[(s.weekStart + i) % 7]}</span>`).join('');
  const cells = days
    .map((d) => {
      const dt = parseYmd(d);
      const { allDay, timed } = dayInstances(inst, d);
      const dayTasks = tasks.filter((t) => t.date === d).sort(byTimeThenOrder);
      const items = [
        ...allDay.map((i) => `<div class="mitem allday" data-ev="${i.key}" style="--ev:${colorVar(i.color)}"><span class="n">${esc(i.event.title)}</span></div>`),
        ...timed.map((i) => `<div class="mitem" data-ev="${i.key}" style="--ev:${colorVar(i.color)}"><span class="dot"></span><span class="t">${fmtTime(hhmm(i.start), { compact: true })}</span><span class="n">${esc(i.event.title)}</span></div>`),
        ...dayTasks.map((t) => {
          const c = taskColor(t, lists);
          return `<div class="mitem task${t.done ? ' done' : ''}" data-task="${t.id}" draggable="true"><button type="button" class="check sm" role="checkbox" aria-checked="${t.done}" style="--c:${c}" data-task-check aria-label="Complete">${icon('check', { size: 8, stroke: 3.4 })}</button>${t.time ? `<span class="t">${fmtTime(t.time, { compact: true })}</span>` : ''}<span class="n">${esc(t.title)}</span></div>`;
        }),
      ];
      const shown = items.length > cap ? items.slice(0, cap - 1) : items;
      const more = items.length - shown.length;
      return `<div class="mcell${dt.getMonth() !== cur ? ' out' : ''}${d === today ? ' today' : ''}" data-mdate="${d}">
        <button type="button" class="mnum" data-goto-day="${d}" aria-label="${esc(fmt(dt, { weekday: 'long', month: 'long', day: 'numeric' }))}">${dt.getDate()}</button>
        ${shown.join('')}${more ? `<button type="button" class="mmore" data-goto-day="${d}">+${more} more</button>` : ''}</div>`;
    })
    .join('');
  viewEl.innerHTML = `<div class="month"><div class="month-head">${head}</div><div class="month-grid" style="grid-template-rows:repeat(${weeks},minmax(0,1fr))">${cells}</div></div>`;
}

// ---------------------------------------------------------------- agenda

function renderAgenda(days) {
  const s = settings.get();
  const inst = eventInstances(days[0], days.at(-1));
  const tasks = scheduledTasks(days[0], days.at(-1), s);
  const lists = listMap();
  const today = todayYmd();
  instMap = new Map(inst.map((i) => [i.key, i]));
  let html = '';
  for (const d of days) {
    const { allDay, timed } = dayInstances(inst, d);
    const dayTasks = tasks.filter((t) => t.date === d).sort(byTimeThenOrder);
    if (!allDay.length && !timed.length && !dayTasks.length && d !== today) continue;
    const dt = parseYmd(d);
    const rows = [
      ...allDay.map((i) => `<div class="ag-item" data-ev="${i.key}" style="--ev:${colorVar(i.color)}"><span class="bar"></span><span class="when">All day</span><span class="what">${esc(i.event.title)}</span>${i.event.location ? `<span class="where">${esc(i.event.location)}</span>` : ''}</div>`),
      ...timed.map(
        (i) => `<div class="ag-item" data-ev="${i.key}" style="--ev:${colorVar(i.color)}"><span class="bar"></span><span class="when">${fmtTime(hhmm(i.start), { compact: true })} – ${fmtTime(hhmm(i.end), { compact: true })}</span><span class="what">${esc(i.event.title)}</span>${i.event.location ? `<span class="where">${esc(i.event.location)}</span>` : ''}</div>`,
      ),
      ...dayTasks.map((t) => {
        const c = taskColor(t, lists);
        return `<div class="ag-item task${t.done ? ' done' : ''}" data-task="${t.id}"><button type="button" class="check sm" role="checkbox" aria-checked="${t.done}" style="--c:${c}" data-task-check aria-label="Complete">${icon('check', { size: 10, stroke: 3.4 })}</button><span class="when">${t.time ? fmtTime(t.time, { compact: true }) + (t.duration ? ` · ${fmtDuration(t.duration)}` : '') : 'Task'}</span><span class="what">${esc(t.title)}</span>${t.listId && lists.get(t.listId) ? `<span class="where">${esc(lists.get(t.listId).name)}</span>` : ''}</div>`;
      }),
    ];
    html += `<div class="ag-day${d === today ? ' today' : ''}"><button type="button" class="ag-date" data-goto-day="${d}"><span class="n">${dt.getDate()}</span><span class="w">${esc(fmt(dt, { weekday: 'short', month: 'short' }))}</span></button>
      <div class="ag-items">${rows.join('') || '<div class="ag-empty">Nothing scheduled — enjoy the open time.</div>'}</div></div>`;
  }
  viewEl.innerHTML = `<div class="agenda"><div class="agenda-inner">${html}<div style="padding:20px 0;text-align:center"><button type="button" class="btn btn-secondary btn-sm" data-nav="1">Show the next 30 days</button></div></div></div>`;
}

// ---------------------------------------------------------------- task panel

/** The day the task panel plans for: today when it's on screen, otherwise the first visible day. */
function focusDay() {
  const { days } = range();
  const today = todayYmd();
  if (days.includes(today)) return today;
  return effView() === 'month' || effView() === 'agenda' ? state.date : days[0];
}

function renderPanel() {
  shellEl.classList.toggle('has-panel', state.panel);
  panelEl.hidden = !state.panel;
  if (!state.panel) return;
  const s = settings.get();
  const day = focusDay();
  const today = todayYmd();
  const lists = listMap();
  const open = db.all('tasks').filter((t) => !t.done);
  const dayTasks = open.filter((t) => !t.someday && t.date && (t.date === day || (day === today && t.date < today))).sort(byTimeThenOrder);
  const toSchedule = dayTasks.filter((t) => !t.time);
  const scheduled = dayTasks.filter((t) => t.time);
  const anytime = open.filter((t) => !t.date && !t.someday).sort(byOrder).slice(0, 50);
  const inst = eventInstances(day, day);
  const w = workload(day, inst, db.all('tasks').filter((t) => t.date === day || (day === today && t.date < today && !t.done)));
  const pct = Math.min(100, Math.round((w.total / 480) * 100));
  const row = (t) => {
    const c = taskColor(t, lists);
    const l = lists.get(t.listId);
    const metaParts = [
      t.time ? `<span>${icon('clock')}${fmtTime(t.time, { compact: true })}</span>` : '',
      t.duration ? `<span>${icon('hourglass')}${fmtDuration(t.duration)}</span>` : '',
      t.date && t.date < today ? `<span>from ${esc(dayLabel(t.date))}</span>` : '',
      t.deadline ? `<span style="color:var(--danger-text)">${icon('flag')}${esc(dayLabel(t.deadline))}</span>` : '',
      l ? `<span><span class="dot" style="color:${c};width:6px;height:6px"></span>${esc(l.name)}</span>` : '',
    ].join('');
    return `<div class="tp-task" draggable="true" data-ptask="${t.id}" title="Drag onto the calendar to block time">
      <button type="button" class="check" role="checkbox" aria-checked="false" style="--c:${c}" data-task-check aria-label="Complete">${icon('check', { size: 11, stroke: 3 })}</button>
      <div class="tt"><div class="tt-title">${esc(t.title)}</div>${metaParts ? `<div class="tt-meta">${metaParts}</div>` : ''}</div></div>`;
  };
  panelEl.innerHTML = `
    <div class="tp-head"><h2>${icon('checklist', { size: 20 })}Tasks</h2>
      <a class="icon-btn" href="../tasks/#/today" title="Open tasks" aria-label="Open tasks">${icon('arrow-up-right', { size: 18 })}</a>
      <button type="button" class="icon-btn" data-toggle-panel aria-label="Close tasks panel">${icon('x')}</button></div>
    <div class="tp-load">
      <div class="row-flex"><span><strong>${fmtDuration(w.tk) || '0m'}</strong> tasks · <strong>${fmtDuration(w.ev) || '0m'}</strong> events</span><span>${esc(dayLabel(day))}</span></div>
      <div class="bar" title="${pct}% of an 8-hour day"><i style="width:${pct}%"></i></div>
    </div>
    <div class="tp-scroll">
      <div class="tp-section" data-panel-drop="${day}">
        <div class="tp-label"><span>${esc(dayLabel(day))} · to schedule</span><span>${toSchedule.length || ''}</span></div>
        ${toSchedule.map(row).join('') || `<div class="tp-empty">Nothing waiting. Drag tasks from below onto the calendar to plan your ${day === today ? 'day' : 'time'}.</div>`}
      </div>
      ${scheduled.length ? `<div class="tp-section"><div class="tp-label"><span>Time-blocked</span><span>${scheduled.length}</span></div>${scheduled.map(row).join('')}</div>` : ''}
      <div class="tp-section" data-panel-drop="">
        <div class="tp-label"><span>Anytime &amp; Inbox</span><span>${anytime.length || ''}</span></div>
        ${anytime.map(row).join('') || '<div class="tp-empty">No undated tasks.</div>'}
      </div>
    </div>
    <div class="tp-add"><label class="search-pill">${icon('plus', { size: 17 })}<input type="text" data-panel-add placeholder="Add a task for ${esc(dayLabel(day).toLowerCase() === 'today' ? 'today' : dayLabel(day))}…" autocomplete="off" aria-label="Add a task"></label></div>`;
  if (!s.showTasksInSchedule) $('.tp-scroll', panelEl).insertAdjacentHTML('afterbegin', `<div class="tp-empty" style="padding-top:12px">Tasks are hidden on the calendar. <a href="#" data-toggle-tasks-link>Show them</a></div>`);
}

// ---------------------------------------------------------------- render

function render() {
  if (gesture) {
    pendingRender = true;
    return;
  }
  const v = effView();
  const { days } = range();
  renderTopbar();
  renderSidebar();
  if (v === 'month') renderMonth(days);
  else if (v === 'agenda') renderAgenda(days);
  else renderGrid(days);
  renderPanel();
  syncHash();
}

db.on(() => render());
window.addEventListener('resize', () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(render, 120);
});
setInterval(() => {
  if (!gesture && !hasOpenLayer() && document.visibilityState === 'visible') render();
}, 60000);

// ---------------------------------------------------------------- recurring helpers

function askScope(action) {
  return choiceDialog({
    title: `${action} a repeating event`,
    message: 'Apply this change to…',
    choices: [
      { label: 'This event only', value: 'this', tone: 'secondary' },
      { label: 'This and following events', value: 'following', tone: 'secondary' },
      { label: 'All events in the series', value: 'all', tone: 'primary' },
    ],
  });
}

function snapshotEvents() {
  return structuredClone(db.all('events'));
}
function restoreEvents(snap) {
  const ids = new Set(snap.map((e) => e.id));
  db.batch(() => {
    for (const e of [...db.all('events')]) if (!ids.has(e.id)) db.remove('events', e.id);
    for (const e of snap) db.put('events', e);
  });
}

function shiftRule(rule, deltaDays, newDate) {
  if (!rule) return rule;
  const r = { ...rule };
  if (r.freq === 'week' && r.days && deltaDays % 7) r.days = r.days.map((d) => (((d + deltaDays) % 7) + 7) % 7);
  if ((r.freq === 'month' || r.freq === 'year') && deltaDays && newDate) r.monthDay = parseYmd(newDate).getDate();
  return r;
}

/** Move/resize one instance to new start/end (minutes from the start of `dateYmd`). */
async function commitEventMove(key, dateYmd, startMin, endMin) {
  const inst = instMap.get(key);
  if (!inst) return render();
  const e = inst.event;
  const start = dtFrom(dateYmd, startMin);
  const end = dtFrom(dateYmd, endMin);
  const snap = snapshotEvents();
  if (e.repeat) {
    const scope = await askScope('Change');
    if (!scope) return render();
    const deltaDays = diffDays(inst.occurrence, dateYmd);
    if (scope === 'this') detachOccurrence(e.id, inst.occurrence, { start, end });
    else if (scope === 'following') splitSeries(e.id, inst.occurrence, { start, end, repeat: shiftRule(e.repeat, deltaDays, dateYmd) });
    else {
      const seriesDate = addDaysYmd(e.start.slice(0, 10), deltaDays);
      db.update('events', e.id, { start: dtFrom(seriesDate, startMin), end: dtFrom(seriesDate, endMin), repeat: shiftRule(e.repeat, deltaDays, seriesDate) });
    }
  } else db.update('events', e.id, { start, end, allDay: false });
  undoable('Event updated', () => restoreEvents(snap));
}

async function deleteInstance(key) {
  const inst = instMap.get(key);
  if (!inst) return;
  const e = inst.event;
  const snap = snapshotEvents();
  if (e.repeat) {
    const scope = await choiceDialog({
      title: `Delete “${e.title}”?`,
      message: 'This is a repeating event.',
      choices: [
        { label: 'Delete this event only', value: 'this', tone: 'secondary' },
        { label: 'Delete this and following', value: 'following', tone: 'secondary' },
        { label: 'Delete all events', value: 'all', tone: 'danger' },
      ],
    });
    if (!scope) return;
    if (scope === 'this') db.update('events', e.id, { exdates: [...(e.exdates || []), inst.occurrence] });
    else if (scope === 'following') {
      if (inst.occurrence === e.start.slice(0, 10)) db.remove('events', e.id);
      else db.update('events', e.id, { until: addDaysYmd(inst.occurrence, -1) });
    } else db.remove('events', e.id);
  } else db.remove('events', e.id);
  state.sel = null;
  undoable('Event deleted', () => restoreEvents(snap));
}

// ---------------------------------------------------------------- popovers

function whenText(inst) {
  const e = inst.event;
  if (inst.allDay) {
    const a = ymd(inst.start);
    const b = ymd(inst.end);
    return a === b ? `${fmt(inst.start, { weekday: 'long', month: 'long', day: 'numeric' })} · All day` : `${fmt(inst.start, { month: 'short', day: 'numeric' })} – ${fmt(inst.end, { month: 'short', day: 'numeric' })} · All day`;
  }
  const sameDay = ymd(inst.start) === ymd(new Date(inst.end - 1));
  const mins = Math.round((inst.end - inst.start) / 60000);
  if (sameDay) return `${fmt(inst.start, { weekday: 'long', month: 'short', day: 'numeric' })} · ${fmtTime(hhmm(inst.start))} – ${fmtTime(hhmm(inst.end))} (${fmtDuration(mins)})`;
  return `${fmt(inst.start, { month: 'short', day: 'numeric' })} ${fmtTime(hhmm(inst.start))} – ${fmt(inst.end, { month: 'short', day: 'numeric' })} ${fmtTime(hhmm(inst.end))}`;
}

function openEventPopover(key, anchor) {
  const inst = instMap.get(key);
  if (!inst) return;
  const e = inst.event;
  state.sel = { kind: 'event', key };
  markSelection();
  const cal = inst.calendar;
  openPopover(
    anchor,
    `<div class="ep-head" style="--ev:${colorVar(inst.color)}"><span class="sw"></span><h3>${esc(e.title)}</h3><button type="button" class="icon-btn sm" data-close-pop aria-label="Close">${icon('x', { size: 16 })}</button></div>
     <div class="ep-rows">
       <div class="r">${icon('clock')}<span>${esc(whenText(inst))}</span></div>
       ${e.repeat ? `<div class="r">${icon('repeat')}<span>${esc(describe(e.repeat))}${e.until ? ` · until ${esc(fmt(parseYmd(e.until), { month: 'short', day: 'numeric' }))}` : ''}</span></div>` : ''}
       ${e.location ? `<div class="r">${icon('pin')}<span>${esc(e.location)}</span></div>` : ''}
       ${cal ? `<div class="r">${icon('calendar')}<span>${esc(cal.name)}</span></div>` : ''}
       ${e.notes ? `<div class="r">${icon('note')}<span class="notes">${esc(e.notes)}</span></div>` : ''}
     </div>
     <div class="ep-actions">
       <button type="button" class="btn btn-tint btn-sm" data-pop="edit">${icon('edit', { size: 15 })}Edit</button>
       <button type="button" class="btn btn-ghost btn-sm" data-pop="dup">${icon('copy', { size: 15 })}Duplicate</button>
       <span class="grow"></span>
       <button type="button" class="icon-btn sm" data-pop="delete" aria-label="Delete event" title="Delete">${icon('trash', { size: 17 })}</button>
     </div>`,
    {
      className: 'ev-pop',
      side: narrow() ? 'bottom' : 'right',
      onClose: () => {
        if (state.sel?.key === key) state.sel = null;
        markSelection();
      },
      onMount: (el, close) => {
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('[data-close-pop]')) return close();
          const a = ev.target.closest('[data-pop]')?.dataset.pop;
          if (!a) return;
          close();
          if (a === 'edit') openEditor({ key });
          if (a === 'delete') deleteInstance(key);
          if (a === 'dup') {
            const { id: _omit, ...rest } = structuredClone(e);
            const startDate = e.start.slice(0, 10);
            const shift = diffDays(startDate, inst.occurrence);
            const sh = (x) => (x.length > 10 ? fmtDT(addDays(parseDT(x), shift)) : addDaysYmd(x, shift));
            const copy = db.insert('events', { ...rest, title: `${e.title} (copy)`, start: sh(e.start), end: sh(e.end), repeat: null, exdates: [], until: null });
            undoable('Event duplicated', () => db.remove('events', copy.id));
          }
        });
      },
    },
  );
}

function openTaskPopover(id, anchor) {
  const t = db.get('tasks', id);
  if (!t) return;
  const lists = listMap();
  const l = lists.get(t.listId);
  const c = taskColor(t, lists);
  state.sel = { kind: 'task', id };
  markSelection();
  const when = t.date ? `${fmt(parseYmd(t.date), { weekday: 'long', month: 'short', day: 'numeric' })}${t.time ? ` · ${fmtTime(t.time)}${t.duration ? ` – ${fmtTime(fromMinutes(parseInt(t.time) * 60 + +t.time.slice(3) + t.duration))}` : ''}` : ''}` : 'No date';
  openPopover(
    anchor,
    `<div class="ep-head" style="--ev:${c}"><button type="button" class="check" role="checkbox" aria-checked="${t.done}" style="--c:${c};margin-top:2px" data-pop="toggle" aria-label="Complete">${icon('check', { size: 13, stroke: 3 })}</button><h3>${esc(t.title)}</h3><button type="button" class="icon-btn sm" data-close-pop aria-label="Close">${icon('x', { size: 16 })}</button></div>
     <div class="ep-rows">
       <div class="r">${icon('clock')}<span>${esc(when)}${t.duration && !t.time ? ` · ${fmtDuration(t.duration)}` : ''}</span></div>
       ${t.repeat ? `<div class="r">${icon('repeat')}<span>${esc(describe(t.repeat))}</span></div>` : ''}
       ${t.deadline ? `<div class="r">${icon('flag')}<span>Deadline ${esc(dayLabel(t.deadline))}</span></div>` : ''}
       <div class="r">${icon('list')}<span>${esc(l?.name || 'Inbox')} · a task from <a href="../tasks/#/task/${t.id}">tasks</a></span></div>
       ${t.checklist?.length ? `<div class="r">${icon('checklist')}<span>${t.checklist.filter((x) => x.done).length} of ${t.checklist.length} done</span></div>` : ''}
       ${t.notes ? `<div class="r">${icon('note')}<span class="notes">${esc(t.notes)}</span></div>` : ''}
     </div>
     <div class="ep-actions">
       <a class="btn btn-tint btn-sm" href="../tasks/#/task/${t.id}">${icon('arrow-up-right', { size: 15 })}Open in tasks</a>
       ${t.time ? `<button type="button" class="btn btn-ghost btn-sm" data-pop="unblock">${icon('x', { size: 15 })}Remove time</button>` : ''}
       <span class="grow"></span>
       ${t.date ? `<button type="button" class="icon-btn sm" data-pop="undate" aria-label="Remove from calendar" title="Remove from calendar">${icon('calendar', { size: 17 })}</button>` : ''}
     </div>`,
    {
      className: 'ev-pop',
      side: narrow() ? 'bottom' : 'right',
      onClose: () => {
        if (state.sel?.id === id) state.sel = null;
        markSelection();
      },
      onMount: (el, close) => {
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('[data-close-pop]')) return close();
          const a = ev.target.closest('[data-pop]')?.dataset.pop;
          if (!a) return;
          close();
          if (a === 'toggle') completeTask(id);
          if (a === 'unblock') {
            const undo = scheduleTask(id, t.date, null, t.duration);
            undoable('Time block removed', undo);
          }
          if (a === 'undate') {
            const before = structuredClone(t);
            db.update('tasks', id, { date: null, time: null, evening: false });
            undoable('Removed from calendar', () => db.put('tasks', before));
          }
        });
      },
    },
  );
}

function markSelection() {
  $$('.ev.sel, .ad-item.sel', viewEl).forEach((el) => el.classList.remove('sel'));
  if (state.sel?.kind === 'event') $$(`[data-ev="${CSS.escape(state.sel.key)}"]`, viewEl).forEach((el) => el.classList.add('sel'));
  if (state.sel?.kind === 'task') $$(`.ev[data-task="${state.sel.id}"]`, viewEl).forEach((el) => el.classList.add('sel'));
}

function completeTask(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const undo = toggleTask(id);
  undoable(t.done ? 'Task reopened' : t.repeat ? 'Done — moved to next time' : 'Task completed', undo);
}

// ---------------------------------------------------------------- quick create (after click/drag on the grid)

function openQuickCreate({ date, start, end, allDay = false }, anchor, ghost) {
  const s = settings.get();
  const cals = calsSorted();
  const lists = [...db.all('lists')].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let mode = 'event';
  const meta = () =>
    allDay ? `${esc(dayLabel(date))} · All day` : `${esc(dayLabel(date))} · ${fmtTime(fromMinutes(start))} – ${fmtTime(fromMinutes(end))} · ${fmtDuration(end - start)}`;
  const selectHtml = () =>
    mode === 'event'
      ? `<select class="input" name="dest" aria-label="Calendar">${cals.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`
      : `<select class="input" name="dest" aria-label="List"><option value="">Inbox</option>${lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>`;
  openPopover(
    anchor,
    `<form class="qc" autocomplete="off">
      <div class="segmented full" style="margin-bottom:10px"><button type="button" data-mode="event" aria-pressed="true">Event</button><button type="button" data-mode="task" aria-pressed="false">Task block</button></div>
      <input name="title" placeholder="Add title" aria-label="Title" autofocus>
      <div class="qc-meta">${icon('clock', { size: 15 })}<span>${meta()}</span></div>
      <div class="qc-row" data-target-row>${selectHtml()}</div>
      <div class="qc-actions"><button type="button" class="btn btn-ghost btn-sm" data-more>More options</button><button type="submit" class="btn btn-primary btn-sm">Save</button></div>
    </form>`,
    {
      className: 'qc-pop',
      side: narrow() ? 'bottom' : 'right',
      onClose: () => ghost?.remove(),
      onMount: (el, close) => {
        const form = $('form', el);
        el.addEventListener('click', (e) => {
          const m = e.target.closest('[data-mode]');
          if (m) {
            mode = m.dataset.mode;
            $$('[data-mode]', el).forEach((b) => b.setAttribute('aria-pressed', String(b === m)));
            $('[data-target-row]', el).innerHTML = selectHtml();
            $('input[name="title"]', el).placeholder = mode === 'event' ? 'Add title' : 'What do you need to do?';
            $('input[name="title"]', el).focus();
          }
          if (e.target.closest('[data-more]')) {
            const title = form.elements.title.value.trim();
            const calendarId = mode === 'event' ? form.elements.dest.value : undefined;
            close();
            openEditor({ draft: { title, date, start, end, allDay, calendarId } });
          }
        });
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const F = form.elements;
          const raw = F.title.value.trim();
          if (!raw) return F.title.focus();
          const time = allDay ? null : fromMinutes(start);
          if (mode === 'event') {
            const p = parse(raw, { mode: 'event', calendars: cals, hour12: hour12() });
            const ev = createEvent({ title: p.title || raw, location: p.location || '', calendarId: p.calendarId || F.dest.value, date, time, duration: end - start, allDay }, s);
            close();
            undoable('Event added', () => db.remove('events', ev.id));
          } else {
            const p = parse(raw, { mode: 'task', lists });
            const t = createTask({ title: p.title || raw, listId: p.listId || F.dest.value || null, newList: p.newList, tags: p.tags, priority: p.priority, date, time, duration: allDay ? null : end - start });
            close();
            undoable('Task block added', () => db.remove('tasks', t.id));
          }
        });
      },
    },
  );
}

// ---------------------------------------------------------------- full event editor

function openEditor({ key = null, draft = null } = {}) {
  const s = settings.get();
  const inst = key ? instMap.get(key) : null;
  const e = inst?.event || null;
  const cals = calsSorted();
  // Values describe the occurrence being edited.
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
      endDate: inst.allDay ? ymd(inst.end) : ymd(new Date(inst.end - (hhmm(inst.end) === '00:00' ? 1 : 0))),
      endTime: inst.allDay ? '10:00' : hhmm(inst.end) === '00:00' ? '23:59' : hhmm(inst.end),
      repeat: e.repeat,
      until: e.until || '',
    };
  } else {
    const d = draft || {};
    const date = d.date || state.date;
    const sm = d.start ?? 9 * 60;
    const em = d.end ?? sm + (s.defaultEventMinutes || 60);
    v = {
      title: d.title || '',
      location: d.location || '',
      notes: '',
      calendarId: d.calendarId || cals.find((c) => c.visible !== false)?.id || cals[0]?.id,
      allDay: !!d.allDay,
      startDate: date,
      startTime: fromMinutes(sm),
      endDate: em >= 1440 ? addDaysYmd(date, 1) : date,
      endTime: fromMinutes(em >= 1440 ? em - 1440 : em),
      repeat: d.repeat || null,
      until: '',
    };
  }
  const rp = presets(v.startDate);
  const same = (a, b) => JSON.stringify(a && { f: a.freq, i: a.interval || 1, d: a.days ? [...a.days].sort() : null }) === JSON.stringify(b && { f: b.freq, i: b.interval || 1, d: b.days ? [...b.days].sort() : null });
  const rpIndex = rp.findIndex((p) => same(p.rule, v.repeat));
  const { el, close } = openModal({
    title: e ? 'Edit event' : 'New event',
    className: 'editor',
    body: `<form class="modal-body" data-editor autocomplete="off">
      <input class="input title-input" name="title" placeholder="Title" value="${esc(v.title)}" required autofocus>
      <input class="input" name="location" placeholder="Location" value="${esc(v.location)}">
      <div class="ed-sep"></div>
      <div class="ed-row"><label>All-day</label><label class="switch"><input type="checkbox" name="allDay" ${v.allDay ? 'checked' : ''}><span></span></label></div>
      <div class="ed-row"><label>Starts</label><input class="input" type="date" name="startDate" value="${v.startDate}" required><input class="input" type="time" name="startTime" value="${v.startTime}" step="300" ${v.allDay ? 'hidden' : ''}></div>
      <div class="ed-row"><label>Ends</label><input class="input" type="date" name="endDate" value="${v.endDate}" required><input class="input" type="time" name="endTime" value="${v.endTime}" step="300" ${v.allDay ? 'hidden' : ''}></div>
      <div class="ed-row"><label>Repeat</label><select class="input" name="repeat">${rp.map((p, i) => `<option value="${i}" ${i === rpIndex ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}${v.repeat && rpIndex < 0 ? `<option value="keep" selected>${esc(describe(v.repeat))}</option>` : ''}</select></div>
      <div class="ed-row" data-until-row ${v.repeat ? '' : 'hidden'}><label>Until</label><input class="input" type="date" name="until" value="${v.until}"><span class="faint" style="font-size:12px">optional</span></div>
      <div class="ed-row"><label>Calendar</label><select class="input" name="calendarId">${cals.map((c) => `<option value="${c.id}" ${c.id === v.calendarId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <textarea class="input" name="notes" placeholder="Notes" rows="3">${esc(v.notes)}</textarea>
      <div class="ed-actions">
        ${e ? `<button type="button" class="btn btn-danger" data-ed-delete>${icon('trash', { size: 16 })}Delete</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${e ? 'Save' : 'Add event'}</button>
      </div>
    </form>`,
  });
  const form = $('[data-editor]', el);
  const F = form.elements; // never form.title — that's the element's tooltip property
  F.allDay.addEventListener('change', () => {
    F.startTime.hidden = F.endTime.hidden = F.allDay.checked;
  });
  F.repeat.addEventListener('change', () => {
    $('[data-until-row]', el).hidden = F.repeat.value === '0';
  });
  F.startDate.addEventListener('change', () => {
    if (F.endDate.value < F.startDate.value) F.endDate.value = F.startDate.value;
  });
  $('[data-ed-delete]', el)?.addEventListener('click', () => {
    close();
    deleteInstance(key);
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = F;
    const allDay = f.allDay.checked;
    let startDate = f.startDate.value;
    let endDate = f.endDate.value || startDate;
    let startT = f.startTime.value || '09:00';
    let endT = f.endTime.value || startT;
    if (endDate < startDate) endDate = startDate;
    let start = allDay ? startDate : `${startDate}T${startT}`;
    let end = allDay ? endDate : `${endDate}T${endT}`;
    if (!allDay && end <= start) end = fmtDT(new Date(parseDT(start).getTime() + (s.defaultEventMinutes || 60) * 60000));
    const repeatRule = f.repeat.value === 'keep' ? v.repeat : rp[+f.repeat.value]?.rule || null;
    const patch = {
      title: f.title.value.trim() || 'New event',
      location: f.location.value.trim(),
      notes: f.notes.value,
      calendarId: f.calendarId.value,
      allDay,
      until: repeatRule ? f.until.value || null : null,
    };
    const snap = snapshotEvents();
    if (!e) {
      const created = db.insert('events', { ...patch, start, end, repeat: repeatRule, exdates: [] });
      close();
      state.date = startDate;
      render();
      flashEvent(created.id);
      undoable('Event added', () => db.remove('events', created.id));
      return;
    }
    if (e.repeat) {
      const scope = await askScope('Edit');
      if (!scope) return;
      if (scope === 'this') detachOccurrence(e.id, inst.occurrence, { ...patch, start, end, until: null });
      else if (scope === 'following') splitSeries(e.id, inst.occurrence, { ...patch, start, end, repeat: repeatRule });
      else {
        const deltaDays = diffDays(inst.occurrence, startDate);
        const seriesStart = addDaysYmd(e.start.slice(0, 10), deltaDays);
        const spanDays = diffDays(startDate, endDate);
        const seriesEnd = addDaysYmd(seriesStart, spanDays);
        db.update('events', e.id, {
          ...patch,
          start: allDay ? seriesStart : `${seriesStart}T${startT}`,
          end: allDay ? seriesEnd : `${seriesEnd}T${endT}`,
          repeat: repeatRule && same(repeatRule, e.repeat) ? shiftRule(e.repeat, deltaDays, seriesStart) : repeatRule,
        });
      }
    } else db.update('events', e.id, { ...patch, start, end, repeat: repeatRule });
    close();
    undoable('Event saved', () => restoreEvents(snap));
  });
}

function flashEvent(eventId) {
  requestAnimationFrame(() => {
    const el = $(`[data-ev^="${eventId}@"]`, viewEl);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
  });
}

// ---------------------------------------------------------------- grid pointer gestures

function gridMetrics() {
  const body = $('.grid-body', viewEl);
  const cols = $$('.col', body);
  const r = body.getBoundingClientRect();
  const c0 = cols[0].getBoundingClientRect();
  const hour = parseFloat(getComputedStyle(body).getPropertyValue('--hour')) || 52;
  return { body, cols, r, left: c0.left, colW: c0.width, hour };
}

function posAt(m, x, y, snap = 15) {
  const ci = Math.min(m.cols.length - 1, Math.max(0, Math.floor((x - m.left) / m.colW)));
  const raw = ((y - m.r.top) / m.hour) * 60;
  return { ci, date: m.cols[ci].dataset.date, raw, mins: Math.min(1440, Math.max(0, Math.round(raw / snap) * snap)) };
}

const placeBlock = (el, top, bottom) => {
  el.style.top = `calc(var(--hour) * ${top / 60} + 1px)`;
  el.style.height = `calc(var(--hour) * ${(bottom - top) / 60} - 2px)`;
};
const timeLabel = (a, b) => `${fmtTime(fromMinutes(a), { compact: true })} – ${fmtTime(fromMinutes(b), { compact: true })}`;

function makeGhost(col, top, bottom, label = 'New event') {
  const g = document.createElement('div');
  g.className = 'ev ghost';
  g.style.left = '2px';
  g.style.right = '2px';
  g.innerHTML = `<div class="ev-title">${esc(label)}</div><div class="ev-time"></div>`;
  placeBlock(g, top, bottom);
  $('.ev-time', g).textContent = timeLabel(top, bottom);
  col.append(g);
  return g;
}

viewEl.addEventListener('pointerdown', (e) => {
  const body = e.target.closest('.grid-body');
  if (!body || e.button !== 0 || e.target.closest('[data-task-check]')) return;
  const m = gridMetrics();
  const p = posAt(m, e.clientX, e.clientY);
  const block = e.target.closest('.ev[data-ev], .ev[data-task]');
  const base = { m, start: p, x0: e.clientX, y0: e.clientY, moved: false, touch: e.pointerType === 'touch', pointerId: e.pointerId };
  if (block) {
    gesture = {
      ...base,
      type: e.target.closest('[data-resize]') ? 'resize' : 'move',
      el: block,
      item: block.dataset.ev ? { kind: 'event', key: block.dataset.ev } : { kind: 'task', id: block.dataset.task },
      top: +block.dataset.top,
      bottom: +block.dataset.bottom,
      date: block.closest('.col').dataset.date,
    };
  } else gesture = { ...base, type: 'create' };
});

viewEl.addEventListener('pointermove', (e) => {
  const g = gesture;
  if (!g || e.pointerId !== g.pointerId) return;
  if (!g.moved) {
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 5) return;
    if (g.touch) {
      gesture = null; // let touch scroll
      return;
    }
    g.moved = true;
    try {
      g.m.body.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (g.el) {
      g.el.classList.add('dragging');
      if (g.type === 'move') {
        g.el.style.left = '2px';
        g.el.style.width = 'calc(100% - 4px)';
      }
    }
  }
  const p = posAt(g.m, e.clientX, e.clientY);
  if (g.type === 'create') {
    let a = Math.min(g.start.mins, p.mins);
    let b = Math.max(g.start.mins, p.mins);
    if (b - a < 15) b = a + 15;
    if (!g.ghost) g.ghost = makeGhost(g.m.cols[g.start.ci], a, b);
    placeBlock(g.ghost, a, b);
    $('.ev-time', g.ghost).textContent = timeLabel(a, b);
    g.a = a;
    g.b = b;
  } else if (g.type === 'move') {
    const dur = g.bottom - g.top;
    const delta = Math.round((p.raw - g.start.raw) / 15) * 15;
    const top = Math.min(1440 - dur, Math.max(0, g.top + delta));
    const col = g.m.cols[p.ci];
    if (g.el.parentElement !== col) col.append(g.el);
    placeBlock(g.el, top, top + dur);
    const tEl = $('.ev-time', g.el);
    if (tEl) tEl.textContent = timeLabel(top, top + dur);
    g.newTop = top;
    g.newBottom = top + dur;
    g.newDate = col.dataset.date;
  } else if (g.type === 'resize') {
    const bottom = Math.min(1440, Math.max(g.top + 15, Math.round(p.raw / 15) * 15));
    placeBlock(g.el, g.top, bottom);
    const tEl = $('.ev-time', g.el);
    if (tEl) tEl.textContent = timeLabel(g.top, bottom);
    g.newTop = g.top;
    g.newBottom = bottom;
    g.newDate = g.date;
  }
});

function endGesture(e) {
  const g = gesture;
  if (!g || (e && e.pointerId !== g.pointerId)) return;
  gesture = null;
  const flush = () => {
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  };
  if (e?.type === 'pointercancel') {
    g.ghost?.remove();
    render();
    return;
  }
  if (!g.moved) {
    flush();
    if (g.item?.kind === 'event') return openEventPopover(g.item.key, g.el);
    if (g.item?.kind === 'task') return openTaskPopover(g.item.id, g.el);
    if (g.type === 'create') {
      const s = settings.get();
      const startMin = Math.min(1440 - 15, Math.floor(g.start.raw / 30) * 30);
      const endMin = Math.min(1440, startMin + (s.defaultEventMinutes || 60));
      const ghost = makeGhost(g.m.cols[g.start.ci], startMin, endMin);
      return openQuickCreate({ date: g.start.date, start: startMin, end: endMin }, ghost, ghost);
    }
    return;
  }
  if (g.type === 'create') {
    flush();
    return openQuickCreate({ date: g.start.date, start: g.a, end: g.b }, g.ghost, g.ghost);
  }
  if (g.newDate === undefined || (g.newDate === g.date && g.newTop === g.top && g.newBottom === g.bottom)) return render();
  if (g.item.kind === 'event') commitEventMove(g.item.key, g.newDate, g.newTop, g.newBottom);
  else {
    const undo = scheduleTask(g.item.id, g.newDate, fromMinutes(g.newTop), g.newBottom - g.newTop);
    undoable(g.type === 'resize' ? 'Time block resized' : 'Time block moved', undo);
  }
}
viewEl.addEventListener('pointerup', endGesture);
viewEl.addEventListener('pointercancel', endGesture);

// ---------------------------------------------------------------- clicks

viewEl.addEventListener('click', (e) => {
  const t = e.target;
  const check = t.closest('[data-task-check]');
  if (check) {
    const id = check.closest('[data-task]')?.dataset.task;
    if (id) return completeTask(id);
  }
  if (t.closest('[data-expand-allday]')) {
    state.alldayOpen = !state.alldayOpen;
    return render();
  }
  const goto = t.closest('[data-goto-day]');
  if (goto) {
    state.date = goto.dataset.gotoDay;
    state.month = null;
    return setView('day');
  }
  if (t.closest('[data-nav]')) return step(+t.closest('[data-nav]').dataset.nav);
  if (t.closest('.grid-body')) return; // handled by pointer gestures
  const ev = t.closest('[data-ev]');
  if (ev) return openEventPopover(ev.dataset.ev, ev);
  const tk = t.closest('[data-task]');
  if (tk) return openTaskPopover(tk.dataset.task, tk);
});

viewEl.addEventListener('dblclick', (e) => {
  const cell = e.target.closest('[data-mdate], [data-allday-date]');
  if (!cell || e.target.closest('[data-ev], [data-task], [data-goto-day]')) return;
  openQuickCreate({ date: cell.dataset.mdate || cell.dataset.alldayDate, start: 0, end: 1440, allDay: true }, cell, null);
});

viewEl.addEventListener('contextmenu', (e) => {
  const ev = e.target.closest('[data-ev]');
  if (!ev) return;
  e.preventDefault();
  const key = ev.dataset.ev;
  openMenu({ x: e.clientX, y: e.clientY }, [
    { label: 'Open', icon: 'info', onSelect: () => openEventPopover(key, ev) },
    { label: 'Edit…', icon: 'edit', onSelect: () => openEditor({ key }) },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => deleteInstance(key) },
  ]);
});

// ---------------------------------------------------------------- drag tasks in (from the panel, the all-day row, or the tasks app in another window)

let dragTask = null;
let dropGhost = null;
const TASK_MIME = 'text/x-ecosys-task';
const hasTask = (e) => Array.from(e.dataTransfer?.types || []).includes(TASK_MIME);
const clearDrop = () => {
  dropGhost?.remove();
  dropGhost = null;
  $$('.drop').forEach((el) => el.classList.remove('drop'));
};

document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('[data-ptask], .ad-item[data-task], .mitem[data-task]');
  if (!el) return;
  dragTask = el.dataset.ptask || el.dataset.task;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(TASK_MIME, dragTask);
  e.dataTransfer.setData('text/plain', db.get('tasks', dragTask)?.title || '');
  requestAnimationFrame(() => el.classList.add('dragging'));
});
document.addEventListener('dragend', () => {
  $$('.dragging').forEach((el) => el.classList.remove('dragging'));
  clearDrop();
  dragTask = null;
});

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
    const dur = t?.duration || settings.get().defaultTaskMinutes || 30;
    const top = Math.min(1440 - dur, Math.max(0, Math.round((p.raw - 10) / 15) * 15));
    const target = m.cols[p.ci];
    if (!dropGhost || dropGhost.parentElement !== target) {
      dropGhost?.remove();
      dropGhost = makeGhost(target, top, top + dur, t?.title || 'Task');
    }
    placeBlock(dropGhost, top, top + dur);
    $('.ev-time', dropGhost).textContent = timeLabel(top, top + dur);
    dropGhost.dataset.top = top;
    dropGhost.dataset.dur = dur;
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
  if (!t) return toast('That task no longer exists', { tone: 'neutral' });
  if (col && ghostTop !== null) {
    const dur = t.duration || settings.get().defaultTaskMinutes || 30;
    const undo = scheduleTask(id, col.dataset.date, fromMinutes(ghostTop), dur);
    undoable(`Blocked ${fmtDuration(dur)} for “${t.title}”`, undo);
  } else if (cell) {
    const date = cell.dataset.alldayDate || cell.dataset.mdate;
    const undo = scheduleTask(id, date, null, t.duration);
    undoable(`“${t.title}” planned for ${dayLabel(date)}`, undo);
  }
});

// The panel accepts tasks too: drop on "to schedule" to remove the time, on "Anytime" to remove the date.
panelEl.addEventListener('dragover', (e) => {
  if (!hasTask(e)) return;
  const sec = e.target.closest('[data-panel-drop]');
  if (!sec) return;
  e.preventDefault();
  $$('.drop', panelEl).forEach((el) => el !== sec && el.classList.remove('drop'));
  sec.classList.add('drop');
});
panelEl.addEventListener('drop', (e) => {
  const sec = e.target.closest('[data-panel-drop]');
  if (!sec || !hasTask(e)) return;
  e.preventDefault();
  clearDrop();
  const id = e.dataTransfer.getData(TASK_MIME);
  const t = db.get('tasks', id);
  if (!t) return;
  const before = structuredClone(t);
  const date = sec.dataset.panelDrop || null;
  db.update('tasks', id, { date, time: null, someday: false, evening: date ? t.evening : false });
  undoable(date ? 'Moved back to the list' : 'Date removed', () => db.put('tasks', before));
});

panelEl.addEventListener('click', (e) => {
  const check = e.target.closest('[data-task-check]');
  if (check) return completeTask(check.closest('[data-ptask]').dataset.ptask);
  if (e.target.closest('[data-toggle-tasks-link]')) {
    e.preventDefault();
    return settings.set({ showTasksInSchedule: true });
  }
  const row = e.target.closest('[data-ptask]');
  if (row) {
    const t = db.get('tasks', row.dataset.ptask);
    if (t?.time && t.date) {
      const block = $(`.ev[data-task="${t.id}"]`, viewEl);
      if (block) {
        block.scrollIntoView({ block: 'center', behavior: 'smooth' });
        block.classList.add('flash');
        return;
      }
    }
    openTaskPopover(row.dataset.ptask, row);
  }
});
panelEl.addEventListener('keydown', (e) => {
  const input = e.target.closest('[data-panel-add]');
  if (!input || e.key !== 'Enter' || !input.value.trim()) return;
  e.preventDefault();
  const p = parse(input.value, { mode: 'task', lists: db.all('lists'), hour12: hour12(), dmy: isDmy });
  const t = createTask({ ...p, title: p.title || input.value.trim(), date: p.someday ? null : p.date || focusDay() });
  input.value = '';
  undoable(`Added “${t.title}”`, () => db.remove('tasks', t.id));
  requestAnimationFrame(() => $('[data-panel-add]', panelEl)?.focus());
});

// ---------------------------------------------------------------- natural-language quick add (Fantastical-style)

const TASK_PREFIX = /^(task|todo|to-do|reminder)\s*:?\s+/i;
function nlParse() {
  const raw = nlInput.value;
  if (TASK_PREFIX.test(raw)) return { kind: 'task', r: parse(raw.replace(TASK_PREFIX, ''), { mode: 'task', lists: db.all('lists'), hour12: hour12(), dmy: isDmy }) };
  return { kind: 'event', r: parse(raw, { mode: 'event', calendars: db.all('calendars'), hour12: hour12(), dmy: isDmy }) };
}

function nlRender() {
  if (!nlInput.value.trim()) {
    nlPreview.hidden = true;
    return;
  }
  const s = settings.get();
  const { kind, r } = nlParse();
  const chips = [];
  if (kind === 'event') {
    const cal = db.get('calendars', r.calendarId) || calsSorted().find((c) => c.visible !== false) || calsSorted()[0];
    const date = r.date || todayYmd();
    const dur = r.duration || s.defaultEventMinutes || 60;
    chips.push(`<span class="chip accent">${icon('calendar')}${esc(dayLabel(date))}</span>`);
    chips.push(
      r.time
        ? `<span class="chip accent">${icon('clock')}${fmtTime(r.time)} – ${fmtTime(r.endTime || fromMinutes(parseInt(r.time) * 60 + +r.time.slice(3) + dur))}</span>`
        : `<span class="chip">${icon('sun')}All day</span>`,
    );
    if (r.repeat) chips.push(`<span class="chip accent">${icon('repeat')}${esc(describe(r.repeat))}</span>`);
    if (r.location) chips.push(`<span class="chip accent">${icon('pin')}${esc(r.location)}</span>`);
    if (cal) chips.push(`<span class="chip"><span class="dot" style="color:${colorVar(cal.color)}"></span>${esc(cal.name)}</span>`);
    nlPreview.innerHTML = `<div class="np-title"><span class="dot" style="color:${colorVar(cal?.color)}"></span>${esc(r.title || 'New event')}</div><div class="np-chips">${chips.join('')}</div>
      <div class="np-hint"><kbd>↵</kbd> add event · start with <strong>task</strong> to add a task instead · “quotes” keep words literal</div>`;
  } else {
    const l = db.get('lists', r.listId);
    if (r.date) chips.push(`<span class="chip accent">${icon('calendar')}${esc(dayLabel(r.date))}</span>`);
    if (r.time) chips.push(`<span class="chip accent">${icon('clock')}${fmtTime(r.time)}</span>`);
    if (r.duration) chips.push(`<span class="chip accent">${icon('hourglass')}${fmtDuration(r.duration)}</span>`);
    if (r.repeat) chips.push(`<span class="chip accent">${icon('repeat')}${esc(describe(r.repeat))}</span>`);
    if (r.deadline) chips.push(`<span class="chip danger">${icon('flag')}Deadline ${esc(dayLabel(r.deadline))}</span>`);
    if (r.someday) chips.push(`<span class="chip">${icon('archive')}Someday</span>`);
    if (r.priority) chips.push(`<span class="chip danger">${'!'.repeat(r.priority)}</span>`);
    chips.push(`<span class="chip">${l ? `<span class="dot" style="color:${colorVar(l.color)}"></span>${esc(l.name)}` : r.newList ? `${icon('plus')}New list “${esc(r.newList)}”` : `${icon('inbox')}Inbox`}</span>`);
    nlPreview.innerHTML = `<div class="np-title">${icon('check-circle', { size: 18 })}${esc(r.title || 'New task')}</div><div class="np-chips">${chips.join('')}</div>
      <div class="np-hint"><kbd>↵</kbd> add task to <strong>tasks</strong></div>`;
  }
  nlPreview.hidden = false;
}

function nlSubmit() {
  if (!nlInput.value.trim()) return;
  const s = settings.get();
  const { kind, r } = nlParse();
  if (kind === 'task') {
    const t = createTask({ ...r, title: r.title || 'New task' });
    undoable(`Task added to ${db.get('lists', t.listId)?.name || 'Inbox'}`, () => db.remove('tasks', t.id));
  } else {
    const ev = createEvent({ ...r, title: r.title || 'New event' }, s);
    const date = ev.start.slice(0, 10);
    const { days } = range();
    if (!days.includes(date)) state.date = date;
    state.scrolledOnce = false;
    render();
    flashEvent(ev.id);
    undoable(`Added “${ev.title}” on ${dayLabel(date)}`, () => db.remove('events', ev.id));
  }
  nlInput.value = '';
  nlRender();
  nlInput.blur();
  $('#nl-wrap').classList.remove('mobile-open');
}

nlInput.addEventListener('input', nlRender);
nlInput.addEventListener('focus', nlRender);
nlInput.addEventListener('blur', () => setTimeout(() => (nlPreview.hidden = true), 150));
nlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    nlSubmit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    nlInput.value = '';
    nlRender();
    nlInput.blur();
    $('#nl-wrap').classList.remove('mobile-open');
  }
});

function newEvent() {
  if (innerWidth <= 900) {
    $('#nl-wrap').classList.add('mobile-open');
  }
  nlInput.focus();
}

// ---------------------------------------------------------------- calendars

function editCalendarDialog(cal) {
  let color = cal?.color || COLORS.find((c) => !db.all('calendars').some((x) => x.color === c)) || 'iris';
  const { el, close } = openModal({
    title: cal ? 'Edit calendar' : 'New calendar',
    body: `<div class="modal-body"><form data-cal-form>
      <input class="input" name="name" placeholder="Calendar name" value="${esc(cal?.name || '')}" autofocus required maxlength="60" style="height:46px;font-size:17px">
      <div class="group-title" style="padding-left:2px">Colour</div>
      <div class="swatches" style="padding:2px">${COLORS.map((c) => `<button type="button" class="swatch-btn" style="--sw:${colorVar(c)}" data-color="${c}" aria-checked="${c === color}" aria-label="${c}">${icon('check')}</button>`).join('')}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">${cal ? 'Save' : 'Create calendar'}</button></div>
    </form></div>`,
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    color = b.dataset.color;
    $$('[data-color]', el).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  });
  $('[data-cal-form]', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').toString().trim();
    if (!name) return;
    if (cal) db.update('calendars', cal.id, { name, color });
    else db.insert('calendars', { name, color, visible: true, order: db.all('calendars').length });
    close();
  });
}

async function deleteCalendar(cal) {
  if (db.all('calendars').length <= 1) return toast('You need at least one calendar', { tone: 'neutral' });
  const events = db.all('events').filter((e) => e.calendarId === cal.id);
  const ok = await confirmDialog({ title: `Delete “${cal.name}”?`, message: events.length ? `Its ${events.length} ${events.length === 1 ? 'event' : 'events'} will be deleted too.` : '', confirm: 'Delete calendar', danger: true });
  if (!ok) return;
  const snap = { cal: structuredClone(cal), events: structuredClone(events) };
  db.batch(() => {
    db.remove('calendars', cal.id);
    events.forEach((e) => db.remove('events', e.id));
  });
  undoable(`Deleted “${cal.name}”`, () =>
    db.batch(() => {
      db.put('calendars', snap.cal);
      snap.events.forEach((e) => db.put('events', e));
    }),
  );
}

// ---------------------------------------------------------------- chrome events

let miniMonth = null;
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-new-event]')) return newEvent();
  if (t.closest('[data-toggle-nav]')) return shellEl.classList.toggle('nav-open');
  if (t.closest('[data-close-nav]')) return shellEl.classList.remove('nav-open');
  if (t.closest('[data-toggle-panel]')) {
    state.panel = !state.panel;
    return render();
  }
  if (t.closest('[data-today]')) return goToday();
  const nav = t.closest('.nav-btns [data-nav]');
  if (nav) return step(+nav.dataset.nav);
  const vb = t.closest('[data-view]');
  if (vb) return setView(vb.dataset.view);
  const tab = t.closest('[data-tab]')?.dataset.tab;
  if (tab) {
    if (tab === 'today') return goToday();
    if (tab === 'tasks') {
      state.panel = !state.panel;
      return render();
    }
    return setView(tab);
  }
  if (t.closest('#range-title')) return goToDatePicker(t.closest('#range-title'));
  // sidebar
  const mc = t.closest('#minical [data-mc]');
  if (mc) {
    const base = state.month || parseYmd(state.date);
    state.month = mc.dataset.mc === 'today' ? new Date() : new Date(base.getFullYear(), base.getMonth() + (mc.dataset.mc === 'next' ? 1 : -1), 1);
    return renderSidebar();
  }
  const md = t.closest('#minical [data-date]');
  if (md) {
    state.date = md.dataset.date;
    state.month = null;
    shellEl.classList.remove('nav-open');
    return render();
  }
  const calT = t.closest('[data-cal-toggle]');
  if (calT) {
    const c = db.get('calendars', calT.dataset.calToggle);
    return db.update('calendars', c.id, { visible: c.visible === false });
  }
  const calM = t.closest('[data-cal-menu]');
  if (calM) {
    const c = db.get('calendars', calM.dataset.calMenu);
    return openMenu(calM, [
      { label: 'Show only this calendar', icon: 'eye', onSelect: () => db.batch(() => db.all('calendars').forEach((x) => db.update('calendars', x.id, { visible: x.id === c.id }))) },
      { label: 'Edit…', icon: 'edit', onSelect: () => editCalendarDialog(c) },
      { sep: true },
      { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => deleteCalendar(c) },
    ]);
  }
  if (t.closest('[data-add-cal]')) return editCalendarDialog(null);
  if (t.closest('[data-toggle-tasks]')) return settings.set({ showTasksInSchedule: !settings.get().showTasksInSchedule });
  const tl = t.closest('[data-tasklist-toggle]');
  if (tl) {
    const hidden = new Set(settings.get().hiddenTaskLists || []);
    hidden.has(tl.dataset.tasklistToggle) ? hidden.delete(tl.dataset.tasklistToggle) : hidden.add(tl.dataset.tasklistToggle);
    return settings.set({ hiddenTaskLists: [...hidden] });
  }
});

function goToDatePicker(anchor) {
  openDatePicker(anchor, { value: state.date, title: 'Go to date', allowClear: false, onPick: ({ date }) => {
    if (!date) return;
    state.date = date;
    state.month = null;
    render();
  } });
}

$('#more-menu').addEventListener('click', (e) => {
  const s = settings.get();
  openMenu(e.currentTarget, [
    { heading: 'View' },
    ...VIEWS.map((v) => ({ label: v.label, checked: state.view === v.id, hint: `<kbd>${v.key}</kbd>`, onSelect: () => setView(v.id) })),
    { sep: true },
    { label: 'Days in N-day view', icon: 'layers', hint: `${s.scheduleDays || 3}`, onSelect: () => settings.set({ scheduleDays: ((s.scheduleDays || 3) % 7) + 1 === 1 ? 2 : ((s.scheduleDays || 3) % 7) + 1 }) },
    { label: s.showTasksInSchedule ? 'Hide tasks on calendar' : 'Show tasks on calendar', icon: 'checklist', onSelect: () => settings.set({ showTasksInSchedule: !s.showTasksInSchedule }) },
    { label: 'Go to date…', icon: 'calendar', hint: '<kbd>g</kbd>', onSelect: () => goToDatePicker($('#range-title')) },
    { sep: true },
    { label: 'New calendar…', icon: 'plus', onSelect: () => editCalendarDialog(null) },
    { label: 'Open tasks', icon: 'arrow-up-right', onSelect: () => (location.href = '../tasks/') },
    { label: 'Settings', icon: 'gear', hint: '<kbd>,</kbd>', onSelect: () => openSettings() },
  ], { align: 'end' });
});

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || hasOpenLayer() || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  const map = {
    t: goToday,
    j: () => step(1),
    n: () => step(1),
    ArrowRight: () => step(1),
    k: () => step(-1),
    p: () => step(-1),
    ArrowLeft: () => step(-1),
    c: newEvent,
    g: () => goToDatePicker($('#range-title')),
    i: () => ((state.panel = !state.panel), render()),
    '/': () => openPalette(),
    Escape: () => {
      state.sel = null;
      markSelection();
    },
  };
  for (const v of VIEWS) {
    map[v.key] = () => setView(v.id);
    map[v.num] = () => setView(v.id);
  }
  if (state.sel?.kind === 'event') {
    map.Enter = map.e = () => openEditor({ key: state.sel.key });
    map.Delete = map.Backspace = () => deleteInstance(state.sel.key);
  }
  if (state.sel?.kind === 'task') {
    map.x = () => completeTask(state.sel.id);
    map.Delete = map.Backspace = () => {
      const t = db.get('tasks', state.sel.id);
      const undo = scheduleTask(t.id, t.date, null, t.duration);
      undoable('Time block removed', undo);
    };
  }
  const fn = map[k];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

registerShortcuts([
  {
    title: 'Views',
    items: [
      ['Day · 3 days · week', 'd / x / w'],
      ['Month · agenda', 'm / a'],
      ['Same, by number', '1 / 2 / 3 / 4 / 5'],
      ['Today', 't'],
      ['Next / previous', 'j / k'],
      ['Go to date', 'g'],
      ['Tasks panel', 'i'],
    ],
  },
  {
    title: 'Events',
    items: [
      ['New event (natural language)', 'c'],
      ['Edit selected', '↵ / e'],
      ['Delete selected', '⌫'],
      ['Complete selected task', 'x'],
      ['Deselect', 'esc'],
    ],
  },
  {
    title: 'Natural language',
    items: [
      ['Event', 'Lunch fri 1pm at Cafe Luna'],
      ['Range & repeat', 'Standup 9:30-9:45 every weekday'],
      ['Calendar', 'Gym tomorrow 6pm #Personal'],
      ['Add a task instead', 'task Buy milk tonight'],
    ],
  },
]);

// ---------------------------------------------------------------- palette

registerPaletteProvider(
  (q) => {
    const out = [];
    if (q) {
      const today = todayYmd();
      const seen = new Set();
      const hits = db
        .all('events')
        .map((e) => ({ e, s: score(`${e.title} ${e.location || ''} ${e.notes || ''}`, q) }))
        .filter((x) => x.s)
        .sort((a, b) => b.s - a.s)
        .slice(0, 8);
      for (const { e } of hits) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const next = e.repeat ? eventInstances(today, addDaysYmd(today, 400), { includeHidden: true }).find((i) => i.event.id === e.id) : null;
        const date = next ? next.occurrence : e.start.slice(0, 10);
        out.push({
          group: 'Events',
          label: e.title,
          sub: `${dayLabel(date)}${e.repeat ? ' · repeats' : ''}`,
          iconHtml: `<span class="dot" style="color:${colorVar(db.get('calendars', e.calendarId)?.color)};width:10px;height:10px;margin:0 4px"></span>`,
          run: () => {
            state.date = date;
            state.scrolledOnce = false;
            if (state.view === 'agenda') state.view = 'week';
            render();
            flashEvent(e.id);
          },
        });
      }
      out.push({ group: 'Create', label: `New event “${q}”`, icon: 'calendar-plus', run: () => ((nlInput.value = q), newEvent(), nlRender()) });
    }
    const cmds = [
      ...VIEWS.map((v) => ({ label: `${v.label} view`, icon: 'calendar', hint: `<kbd>${v.key}</kbd>`, run: () => setView(v.id) })),
      { label: 'Go to today', icon: 'today', hint: '<kbd>t</kbd>', run: goToday },
      { label: 'Go to date…', icon: 'calendar', hint: '<kbd>g</kbd>', run: () => goToDatePicker($('#range-title')) },
      { label: 'Toggle tasks panel', icon: 'checklist', hint: '<kbd>i</kbd>', run: () => ((state.panel = !state.panel), render()) },
      { label: 'New calendar', icon: 'plus', run: () => editCalendarDialog(null) },
    ];
    for (const c of cmds) if (!q || score(c.label, q)) out.push({ group: 'Schedule', ...c });
    return q ? out : out.slice(0, 7);
  },
  { prepend: true },
);

// ---------------------------------------------------------------- routing

function route() {
  const [a, b, c, d] = location.hash.replace(/^#\/?/, '').split('/');
  if (VIEWS.some((v) => v.id === a)) {
    if (a !== state.view) state.view = a;
    if (b && /^\d{4}-\d{2}-\d{2}$/.test(b)) state.date = b;
  }
  state.month = null;
  render();
  if (c === 'event' && d) {
    const id = decodeURIComponent(d);
    requestAnimationFrame(() => {
      const el = $(`[data-ev^="${id}@"]`, viewEl);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        openEventPopover(el.dataset.ev, el);
      }
    });
  }
  if (c === 'task' && d) {
    const t = db.get('tasks', d);
    if (!t) return;
    requestAnimationFrame(() => {
      const block = $(`[data-task="${t.id}"]`, viewEl);
      if (block && t.time) {
        block.scrollIntoView({ block: 'center' });
        block.classList.add('flash');
        return;
      }
      state.panel = true;
      render();
      const row = $(`[data-ptask="${t.id}"]`, panelEl);
      row?.scrollIntoView({ block: 'center' });
      row?.classList.add('flash');
      toast(`Drag “${t.title}” onto the calendar to block time for it`, { tone: 'neutral', duration: 6000 });
    });
  }
}
window.addEventListener('hashchange', route);
route();
