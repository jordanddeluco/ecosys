// tasks — the ecosys to-do app.
import {
  initShell, esc, $, $$, icon, toast, undoable, openMenu, openModal, openDatePicker, choiceDialog,
  registerPaletteProvider, registerShortcuts, openPalette, openSettings, score, sidebarHead, sidebarFoot, hasOpenLayer, isTyping,
} from '../shared/shell.js';
import { db, settings, uid } from '../shared/store.js';
import { todayYmd, addDaysYmd, parseYmd, fmt, dayLabel, shortDate, fmtTime, fmtDuration, diffDays, hour12, pad } from '../shared/dates.js';
import { parse } from '../shared/nlp.js';
import { describe, presets } from '../shared/recur.js';
import {
  SMART_LISTS, tasksIn, byOrder, byTimeThenOrder, createTask, createList, toggleTask, deleteTask, allTags, COLORS, colorVar,
  eventInstances, dayInstances,
} from '../shared/model.js';

initShell({ app: 'tasks' });

const state = { view: 'today', tag: null, sel: null, open: null, showDone: false };
const pendingComplete = new Set();
let skipInspector = false;
const isDmy = !/^en-US|^en-CA|^en-PH/.test(navigator.language || 'en-US') && /^en|^de|^fr|^es|^it|^nl|^pt/.test(navigator.language || '');

// ---------------------------------------------------------------- layout

const appEl = $('#app');
appEl.innerHTML = `
<div class="shell" id="shell">
  <aside class="sidebar" id="sidebar">
    ${sidebarHead('tasks')}
    <div class="side-cta"><button type="button" class="btn btn-primary btn-block btn-lg" data-new>${icon('plus', { size: 20, stroke: 2.4 })}New task</button></div>
    <nav class="side-scroll" id="nav" aria-label="Lists"></nav>
    ${sidebarFoot()}
  </aside>
  <div class="side-overlay" data-close-nav></div>
  <main class="main" id="main">
    <header class="topbar" id="topbar">
      <button type="button" class="icon-btn menu-toggle" data-toggle-nav aria-label="Open menu">${icon('menu')}</button>
      <div class="compact-title" id="compact-title"></div>
      <span class="grow"></span>
      <button type="button" class="icon-btn" data-open-palette aria-label="Search" title="Search (/)">${icon('search')}</button>
      <button type="button" class="icon-btn" id="view-menu" aria-label="View options" title="View options">${icon('more')}</button>
    </header>
    <div class="content main-scroll">
      <div id="view-head"></div>
      <div id="qa-slot"></div>
      <div id="view-body"></div>
    </div>
  </main>
  <aside class="inspector" id="inspector" hidden aria-label="Task details"></aside>
  <nav class="tabbar" id="tabbar" aria-label="Views"></nav>
  <button type="button" class="fab" data-new aria-label="New task">${icon('plus', { size: 26, stroke: 2.4 })}</button>
</div>`;

const shellEl = $('#shell');
const mainEl = $('#main');
const navEl = $('#nav');
const headEl = $('#view-head');
const bodyEl = $('#view-body');
const inspEl = $('#inspector');
const topbar = $('#topbar');

// ---------------------------------------------------------------- helpers

const listsSorted = () => [...db.all('lists')].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const listMap = () => new Map(db.all('lists').map((l) => [l.id, l]));
const smart = (id) => SMART_LISTS.find((s) => s.id === id);
const isSmart = (v) => !!smart(v) || v === 'tag';
const currentList = () => (!isSmart(state.view) ? db.get('lists', state.view) : null);

function viewTitle() {
  if (state.view === 'tag') return `#${state.tag}`;
  return smart(state.view)?.name || currentList()?.name || 'Tasks';
}

function go(view, extra = {}) {
  const hash = view === 'tag' ? `#/tag/${encodeURIComponent(extra.tag)}` : isSmart(view) ? `#/${view}` : `#/list/${view}`;
  if (location.hash !== hash) location.hash = hash;
  else route();
  shellEl.classList.remove('nav-open');
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [a, b] = parts;
  if (a === 'list' && b && db.get('lists', b)) state.view = b;
  else if (a === 'tag' && b) {
    state.view = 'tag';
    state.tag = decodeURIComponent(b);
  } else if (a === 'task' && b) {
    const t = db.get('tasks', b);
    if (t) {
      state.view = viewForTask(t);
      state.sel = t.id;
      openInspector(t.id, { render: false });
      history.replaceState(null, '', isSmart(state.view) ? `#/${state.view}` : `#/list/${state.view}`);
    }
  } else if (smart(a)) state.view = a;
  else state.view = 'today';
  if (state.view !== 'tag') state.tag = null;
  state.showDone = false;
  render();
  mainEl.scrollTop = 0;
  if (state.sel) requestAnimationFrame(() => $(`.task[data-id="${state.sel}"]`)?.scrollIntoView({ block: 'center' }));
}

function viewForTask(t) {
  if (t.done) return 'logbook';
  if (t.someday) return 'someday';
  const today = todayYmd();
  if ((t.date && t.date <= today) || (t.deadline && t.deadline <= today)) return 'today';
  if (t.date) return 'upcoming';
  if (!t.listId) return 'inbox';
  return t.listId;
}

function deadlineInfo(dl) {
  const n = diffDays(todayYmd(), dl);
  if (n < 0) return { cls: 'danger', text: `${-n}d overdue` };
  if (n === 0) return { cls: 'danger', text: 'Due today' };
  if (n === 1) return { cls: 'warn', text: 'Due tomorrow' };
  if (n <= 3) return { cls: 'warn', text: `${n} days left` };
  return { cls: '', text: `Due ${shortDate(dl)}` };
}

function whenLabel(t) {
  if (t.someday) return 'Someday';
  if (!t.date) return 'Anytime';
  if (t.date === todayYmd() && t.evening) return 'This Evening';
  return dayLabel(t.date) + (t.evening ? ' · Evening' : '');
}

const meta = (ic, text, cls = '') => `<span class="m ${cls}">${ic ? icon(ic, { size: 13 }) : ''}${text ? esc(text) : ''}</span>`;

function update(id, patch, { undo, message } = {}) {
  const before = structuredClone(db.get('tasks', id));
  db.update('tasks', id, patch);
  if (undo !== false && message) undoable(message, () => db.put('tasks', before));
}

// ---------------------------------------------------------------- sidebar

function renderNav() {
  const counts = { inbox: tasksIn('inbox').length, today: tasksIn('today').length };
  const lists = listsSorted();
  const open = db.all('tasks').filter((t) => !t.done);
  const tags = allTags();
  const current = state.view === 'tag' ? `tag:${state.tag}` : state.view;
  const item = (id, label, ic, color, count, drop) =>
    `<a class="nav-item" href="${id.startsWith('tag:') ? `#/tag/${encodeURIComponent(id.slice(4))}` : isSmart(id) ? `#/${id}` : `#/list/${id}`}" data-nav="${esc(id)}" ${drop ? `data-drop="${esc(drop)}"` : ''} aria-current="${current === id}" style="--ic:${color}">
      ${ic}<span class="label">${esc(label)}</span>${count ? `<span class="badge">${count}</span>` : ''}</a>`;
  navEl.innerHTML = `
    ${SMART_LISTS.map((s) => item(s.id, s.name, icon(s.icon, { size: 21 }), colorVar(s.color), counts[s.id], s.id)).join('')}
    <div class="side-section">
      <div class="side-label"><span>Lists</span><button type="button" class="icon-btn sm" data-add-list aria-label="New list" title="New list">${icon('plus', { size: 16 })}</button></div>
      ${lists.map((l) => item(l.id, l.name, `<span class="swatch"></span>`, colorVar(l.color), open.filter((t) => t.listId === l.id).length, `list:${l.id}`)).join('') || `<p class="faint" style="padding:4px 12px;font-size:13px">No lists yet</p>`}
    </div>
    ${tags.length ? `<div class="side-section"><div class="side-label"><span>Tags</span></div>${tags.map((g) => item(`tag:${g}`, g, icon('tag', { size: 19 }), 'var(--text-3)', open.filter((t) => t.tags?.includes(g)).length)).join('')}</div>` : ''}
  `;
}

function renderTabbar() {
  const tabs = [
    ['inbox', 'Inbox', 'inbox'],
    ['today', 'Today', 'star'],
    ['upcoming', 'Upcoming', 'calendar'],
  ];
  $('#tabbar').innerHTML =
    tabs.map(([id, label, ic]) => `<a href="#/${id}" aria-current="${state.view === id}">${icon(ic)}<span>${label}</span></a>`).join('') +
    `<button type="button" data-toggle-nav aria-current="${!['inbox', 'today', 'upcoming'].includes(state.view)}">${icon('list')}<span>Lists</span></button>`;
}

// ---------------------------------------------------------------- header

function renderHead() {
  const s = smart(state.view);
  const list = currentList();
  const title = viewTitle();
  $('#compact-title').textContent = title;
  document.title = `${title} · tasks`;
  let ic = '';
  let color = 'var(--accent)';
  if (s) {
    ic = icon(s.icon, { size: 30 });
    color = colorVar(s.color);
  } else if (list) {
    ic = `<span style="width:22px;height:22px;border-radius:7px;background:${colorVar(list.color)};display:block;margin:0 4px"></span>`;
  } else ic = icon('tag', { size: 28 });
  let sub = '';
  if (state.view === 'today') {
    const today = tasksIn('today');
    const planned = today.reduce((sum, t) => sum + (t.duration || 0), 0);
    sub = `<span class="subtitle">${esc(fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }))}</span>
      ${planned ? `<span class="chip" title="Total duration of today's tasks">${icon('hourglass')}${fmtDuration(planned)} planned</span>` : ''}`;
  } else if (state.view === 'upcoming') sub = `<span class="subtitle">The next 7 days and beyond</span>`;
  else if (state.view === 'anytime') sub = `<span class="subtitle">Everything you could do now</span>`;
  else if (state.view === 'someday') sub = `<span class="subtitle">Ideas and maybes, out of sight until you're ready</span>`;
  else if (state.view === 'inbox') sub = `<span class="subtitle">Capture now, sort later</span>`;
  else if (state.view === 'logbook') sub = `<span class="subtitle">${tasksIn('logbook').length} completed</span>`;
  else if (list) {
    const n = tasksIn(list.id).length;
    sub = `<span class="subtitle">${n} ${n === 1 ? 'task' : 'tasks'}</span>`;
  }
  headEl.innerHTML = `<div class="view-head">
    <h1 class="large-title" style="--ic:${color}">${ic}<span class="truncate">${esc(title)}</span></h1>
    <div class="row-flex">${sub}</div>
  </div>`;
}

// ---------------------------------------------------------------- quick add

const qaSlot = $('#qa-slot');
qaSlot.innerHTML = `<div class="quick-add" id="qa">
  <div class="qa-row">
    <span class="qa-plus">${icon('plus', { size: 20, stroke: 2.2 })}</span>
    <div class="qa-field"><div class="qa-mirror" aria-hidden="true"></div><input id="qa-input" type="text" autocomplete="off" spellcheck="false" aria-label="New task"></div>
    <button type="button" class="btn btn-primary btn-sm qa-submit" data-qa-submit>Add</button>
  </div>
  <div class="qa-chips" id="qa-chips"></div>
</div>`;
const qa = $('#qa');
const qaInput = $('#qa-input');
const qaMirror = $('.qa-mirror', qa);
const qaChips = $('#qa-chips');

function qaPlaceholder() {
  const list = currentList();
  switch (state.view) {
    case 'today':
      return 'Add to Today — try “Call mom 6pm for 20m !!”';
    case 'inbox':
      return 'Add to Inbox — try “Pay rent every 1st #Personal”';
    case 'upcoming':
      return 'Add a task — try “Dentist next thu 10am”';
    case 'someday':
      return 'Add an idea for someday';
    case 'logbook':
      return 'Add a task';
    case 'tag':
      return `Add a task tagged @${state.tag}`;
    default:
      return list ? `Add to ${list.name} — try “Review notes tomorrow”` : 'Add a task';
  }
}

function qaDefaults() {
  switch (state.view) {
    case 'today':
      return { date: todayYmd() };
    case 'someday':
      return { someday: true };
    case 'tag':
      return { tags: [state.tag] };
    default:
      return isSmart(state.view) ? {} : { listId: state.view };
  }
}

function qaParse() {
  return parse(qaInput.value, { mode: 'task', lists: db.all('lists'), hour12: hour12(), dmy: isDmy });
}

function tokenLabel(tok, r) {
  const lists = listMap();
  switch (tok.kind) {
    case 'date':
      if (/some/i.test(tok.text)) return [icon('archive'), 'Someday'];
      if (/tonight|evening/i.test(tok.text)) return [icon('moon'), 'This Evening'];
      return [icon('calendar'), r.date ? dayLabel(r.date) : tok.text];
    case 'deadline':
      return [icon('flag'), `Deadline ${r.deadline ? dayLabel(r.deadline) : ''}`];
    case 'time':
      return [icon('clock'), r.time ? fmtTime(r.time) + (r.endTime ? ` – ${fmtTime(r.endTime)}` : '') : tok.text];
    case 'duration':
      return [icon('hourglass'), fmtDuration(r.duration)];
    case 'repeat':
      return [icon('repeat'), describe(r.repeat)];
    case 'list':
      return r.newList && !r.listId ? [icon('plus'), `New list “${r.newList}”`] : [`<span class="dot" style="color:${colorVar(lists.get(r.listId)?.color)}"></span>`, lists.get(r.listId)?.name || tok.label];
    case 'tag':
      return [icon('tag'), tok.text.trim().slice(1)];
    case 'priority':
      return [icon('bolt'), ['', 'Low', 'Medium', 'High'][r.priority] + ' priority'];
    default:
      return [icon('sparkle'), tok.text];
  }
}

function qaRender() {
  const v = qaInput.value;
  const r = qaParse();
  qa.classList.toggle('has-text', v.trim().length > 0);
  let html = '';
  let at = 0;
  for (const t of r.tokens) {
    html += esc(v.slice(at, t.start)) + `<mark class="k-${t.kind}">${esc(v.slice(t.start, t.end))}</mark>`;
    at = t.end;
  }
  qaMirror.innerHTML = html + esc(v.slice(at));
  qaMirror.scrollLeft = qaInput.scrollLeft;
  const chips = r.tokens.map((t, i) => {
    const [ic, label] = tokenLabel(t, r);
    return `<button type="button" class="chip accent" data-unparse="${i}" title="Click to keep “${esc(t.text.trim())}” in the title">${ic}${esc(label)}</button>`;
  });
  qaChips.innerHTML = chips.length ? chips.join('') + `<span class="hint">Click a chip to keep its words in the title</span>` : '';
  qa.classList.toggle('has-chips', chips.length > 0);
}

function qaSubmit() {
  const v = qaInput.value.trim();
  if (!v) return;
  const r = qaParse();
  if (!r.title) {
    toast('Add a title for the task', { tone: 'neutral', duration: 2000 });
    return;
  }
  const d = qaDefaults();
  const fields = {
    ...d,
    ...Object.fromEntries(Object.entries(r).filter(([k, val]) => val !== null && val !== false && !(Array.isArray(val) && !val.length) && k !== 'tokens')),
    tags: [...new Set([...(d.tags || []), ...r.tags])],
  };
  if (r.date) fields.someday = r.someday || false;
  if (r.someday) fields.date = null;
  if (r.listId || r.newList) fields.listId = r.listId || null;
  const t = createTask(fields);
  qaInput.value = '';
  qaRender();
  const dest = viewForTask(t);
  if (dest !== state.view && !(state.view === 'tag' && t.tags.includes(state.tag)) && !(state.view === 'anytime' && dest !== 'upcoming' && t.listId)) {
    const name = smart(dest)?.name || db.get('lists', dest)?.name || 'list';
    toast(`Added to ${name}`, { action: 'View', onAction: () => openTask(t.id) });
  }
  state.sel = t.id;
}

qaInput.addEventListener('input', qaRender);
qaInput.addEventListener('scroll', () => (qaMirror.scrollLeft = qaInput.scrollLeft));
qaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    qaSubmit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    qaInput.value = '';
    qaRender();
    qaInput.blur();
  } else if (e.key === 'ArrowDown' && !qaInput.value) {
    e.preventDefault();
    qaInput.blur();
    moveSel(1);
  }
  requestAnimationFrame(() => (qaMirror.scrollLeft = qaInput.scrollLeft));
});
qa.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-unparse]');
  if (chip) {
    const tok = qaParse().tokens[+chip.dataset.unparse];
    if (!tok) return;
    const v = qaInput.value;
    // Wrap the token's words in quotes so the parser leaves them in the title.
    const lead = v.slice(tok.start, tok.end).match(/^\s*/)[0].length;
    qaInput.value = v.slice(0, tok.start + lead) + '"' + v.slice(tok.start + lead, tok.end) + '"' + v.slice(tok.end);
    qaRender();
    qaInput.focus();
    return;
  }
  if (e.target.closest('[data-qa-submit]')) qaSubmit();
});

function focusQuickAdd(prefill = '') {
  mainEl.scrollTo({ top: 0, behavior: 'smooth' });
  if (prefill) qaInput.value = prefill;
  qaInput.focus();
  qaRender();
}

// ---------------------------------------------------------------- task rows

function taskRow(t, ctx = {}) {
  const lists = ctx.lists || listMap();
  const today = todayYmd();
  const list = t.listId ? lists.get(t.listId) : null;
  const c = list ? colorVar(list.color) : 'var(--accent)';
  const done = t.done || pendingComplete.has(t.id);
  const parts = [];
  if (ctx.view === 'today' && t.date && t.date < today) parts.push(meta('', `from ${dayLabel(t.date)}`));
  if (ctx.showDate && t.date) parts.push(meta('calendar', dayLabel(t.date)));
  if (t.evening && ctx.view !== 'today' && !ctx.inEvening) parts.push(meta('moon', 'Evening'));
  if (t.time) parts.push(meta('clock', fmtTime(t.time) + (t.duration ? ` · ${fmtDuration(t.duration)}` : ''), 'accent'));
  else if (t.duration) parts.push(meta('hourglass', fmtDuration(t.duration)));
  if (t.repeat) parts.push(meta('repeat', describe(t.repeat)));
  if (t.checklist?.length) parts.push(meta('checklist', `${t.checklist.filter((x) => x.done).length}/${t.checklist.length}`));
  if (t.notes) parts.push(meta('note', ''));
  for (const g of t.tags || []) parts.push(meta('tag', g));
  if (ctx.showList !== false && list && ctx.view !== list.id) parts.push(`<span class="m list"><span class="dot" style="color:${c}"></span>${esc(list.name)}</span>`);
  if (t.deadline && !t.done) {
    const dl = deadlineInfo(t.deadline);
    parts.push(meta('flag', dl.text, dl.cls));
  }
  if (ctx.view === 'logbook' && t.completedAt) parts.push(meta('', fmt(new Date(t.completedAt), { hour: 'numeric', minute: '2-digit' })));
  const prio = t.priority ? `<span class="prio-flag p${t.priority}">${'!'.repeat(t.priority)}</span>` : '';
  const cls = ['task', t.done && 'is-done', pendingComplete.has(t.id) && 'completing', state.sel === t.id && 'sel', state.open === t.id && 'open'].filter(Boolean).join(' ');
  return `<div class="${cls}" data-id="${t.id}" draggable="${ctx.view !== 'logbook'}">
    <button type="button" class="check" role="checkbox" aria-checked="${done}" aria-label="${done ? 'Mark as not done' : 'Complete'}: ${esc(t.title)}" style="--c:${c}" data-check>${icon('check', { size: 13, stroke: 3 })}</button>
    <div class="task-main"><div class="task-title">${prio}${esc(t.title)}</div><div class="task-meta">${parts.join('')}</div></div>
    <div class="task-actions">
      <button type="button" class="icon-btn" data-row-date aria-label="When" title="When (r)">${icon('calendar', { size: 17 })}</button>
      <button type="button" class="icon-btn" data-row-more aria-label="More actions" title="More">${icon('more', { size: 17 })}</button>
    </div>
  </div>`;
}

const taskList = (tasks, ctx) => `<div class="task-list">${tasks.map((t) => taskRow(t, ctx)).join('')}</div>`;

function sectionAttrs(o) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `data-${k}="${esc(v)}"`)
    .join(' ');
}

// ---------------------------------------------------------------- events (from schedule)

function eventsStrip(dayYmd, instances) {
  if (!settings.get().showEventsInToday) return '';
  const { allDay, timed } = dayInstances(instances, dayYmd);
  if (!allDay.length && !timed.length) return '';
  const now = new Date();
  const row = (i, when) => {
    const past = !i.allDay && i.end < now;
    const isNow = !i.allDay && i.start <= now && i.end > now;
    return `<a class="event-row${past ? ' past' : ''}${isNow ? ' now' : ''}" href="/schedule/#/day/${dayYmd}/event/${encodeURIComponent(i.event.id)}" style="--ev:${colorVar(i.color)}" title="Open in schedule">
      <span class="bar"></span><span class="when">${when}</span><span class="what">${esc(i.event.title)}</span>${i.event.location ? `<span class="where">${esc(i.event.location)}</span>` : ''}</a>`;
  };
  const t = (d) => fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`, { compact: true });
  return `<div class="events" aria-label="Events from schedule">
    ${allDay.map((i) => row(i, 'All day')).join('')}
    ${timed.map((i) => row(i, `${t(i.start)} – ${t(i.end)}`)).join('')}
  </div>`;
}

// ---------------------------------------------------------------- views

function emptyState(ic, title, text) {
  return `<div class="empty"><div class="glyph">${icon(ic)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

function renderBody() {
  const lists = listMap();
  const today = todayYmd();
  const v = state.view;
  let html = '';

  if (v === 'today') {
    const tasks = tasksIn('today').sort(byTimeThenOrder);
    const day = tasks.filter((t) => !t.evening);
    const eve = tasks.filter((t) => t.evening);
    const events = eventsStrip(today, eventInstances(today, today));
    html += `<section class="section" ${sectionAttrs({ date: today, evening: '0' })}>${events}${day.length ? taskList(day, { view: v, lists }) : !eve.length ? emptyState('star', 'All clear for today', 'Enjoy the space — or pull something in from Anytime or Upcoming.') : ''}</section>`;
    if (eve.length)
      html += `<section class="section" ${sectionAttrs({ date: today, evening: '1' })}><div class="section-head" style="--ic:var(--c-blue)">${icon('moon')}This Evening<span class="count">${eve.length}</span></div>${taskList(eve, { view: v, lists, inEvening: true })}</section>`;
  } else if (v === 'upcoming') {
    const tasks = tasksIn('upcoming');
    const end = addDaysYmd(today, 7);
    const instances = eventInstances(addDaysYmd(today, 1), end);
    for (let i = 1; i <= 7; i++) {
      const d = addDaysYmd(today, i);
      const dt = parseYmd(d);
      const dayTasks = tasks.filter((t) => t.date === d).sort(byTimeThenOrder);
      const events = eventsStrip(d, instances);
      const name = i === 1 ? 'Tomorrow' : fmt(dt, { weekday: 'long' });
      const sub = i === 1 ? fmt(dt, { weekday: 'long' }) : fmt(dt, { month: 'short' });
      html += `<section class="section${!dayTasks.length && !events ? ' empty-day' : ''}" ${sectionAttrs({ date: d })}>
        <div class="section-head day-head" data-drop-head><span class="daynum">${dt.getDate()}</span><span class="dayname">${esc(name)}</span><span class="daysub">${esc(sub)}</span><span class="grow"></span>
        <button type="button" class="icon-btn sm" data-add-on="${d}" aria-label="Add a task on ${esc(name)}">${icon('plus', { size: 16 })}</button></div>
        ${events}${taskList(dayTasks, { view: v, lists })}</section>`;
    }
    const later = tasks.filter((t) => t.date > end).sort((a, b) => a.date.localeCompare(b.date) || byTimeThenOrder(a, b));
    const groups = new Map();
    for (const t of later) {
      const dt = parseYmd(t.date);
      const key = `${dt.getFullYear()}-${dt.getMonth()}`;
      if (!groups.has(key)) groups.set(key, { label: fmt(dt, dt.getFullYear() === new Date().getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' }), tasks: [] });
      groups.get(key).tasks.push(t);
    }
    for (const g of groups.values()) html += `<section class="section"><div class="section-head">${esc(g.label)}<span class="count">${g.tasks.length}</span></div>${taskList(g.tasks, { view: v, lists, showDate: true })}</section>`;
  } else if (v === 'anytime' || v === 'someday') {
    const tasks = tasksIn(v).sort(byOrder);
    const groups = [...listsSorted().map((l) => ({ list: l, tasks: tasks.filter((t) => t.listId === l.id) })), { list: null, tasks: tasks.filter((t) => !t.listId || !lists.has(t.listId)) }].filter((g) => g.tasks.length);
    if (!groups.length) html = v === 'someday' ? emptyState('archive', 'Nothing for someday', 'Park ideas here to keep them out of your way. Type “someday” when adding a task.') : emptyState('layers', 'Nothing to do anytime', 'Tasks in your lists without a future date show up here.');
    for (const g of groups) {
      const head = g.list
        ? `<div class="section-head"><span class="swatch" style="width:10px;height:10px;border-radius:3px;background:${colorVar(g.list.color)}"></span><a href="#/list/${g.list.id}" style="color:inherit">${esc(g.list.name)}</a><span class="count">${g.tasks.length}</span></div>`
        : `<div class="section-head">${icon('inbox')}No list<span class="count">${g.tasks.length}</span></div>`;
      html += `<section class="section" ${sectionAttrs({ list: g.list?.id ?? '', someday: v === 'someday' ? '1' : undefined })}>${head}${taskList(g.tasks, { view: v, lists, showList: false, showDate: true })}</section>`;
    }
  } else if (v === 'logbook') {
    const tasks = tasksIn('logbook');
    if (!tasks.length) html = emptyState('check-circle', 'No completed tasks yet', 'Everything you finish is kept here.');
    const groups = new Map();
    for (const t of tasks) {
      const d = new Date(t.completedAt || t.updatedAt);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const [key, ts] of groups) html += `<section class="section"><div class="section-head">${esc(dayLabel(key, { long: true }))}<span class="count">${ts.length}</span></div>${taskList(ts, { view: v, lists, showDate: false })}</section>`;
  } else if (v === 'inbox') {
    const tasks = tasksIn('inbox').sort(byOrder);
    html = tasks.length ? `<section class="section">${taskList(tasks, { view: v, lists })}</section>` : emptyState('inbox', 'Inbox zero', 'New tasks without a list or date land here. Press N to capture one.');
  } else if (v === 'tag') {
    const tasks = tasksIn('tag', { tag: state.tag }).sort(byOrder);
    html = tasks.length ? `<section class="section">${taskList(tasks, { view: v, lists, showDate: true })}</section>` : emptyState('tag', `Nothing tagged @${state.tag}`, 'Add @tag to a task to see it here.');
  } else {
    const list = currentList();
    if (!list) return go('today');
    const tasks = tasksIn(list.id).sort((a, b) => byOrder(a, b));
    const done = db.all('tasks').filter((t) => t.listId === list.id && t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    html = `<section class="section" ${sectionAttrs({ list: list.id })}>${tasks.length ? taskList(tasks, { view: v, lists, showDate: true }) : emptyState('list', 'No tasks in this list', 'Add one above, or drag tasks onto the list in the sidebar.')}</section>`;
    if (done.length)
      html += `<div class="list-foot"><button type="button" class="btn btn-ghost btn-sm" data-toggle-done>${icon(state.showDone ? 'eye-off' : 'eye', { size: 16 })}${state.showDone ? 'Hide' : 'Show'} ${done.length} completed</button></div>${state.showDone ? `<section class="section">${taskList(done, { view: 'logbook', lists })}</section>` : ''}`;
  }
  bodyEl.innerHTML = html;
}

function render() {
  renderNav();
  renderHead();
  renderBody();
  renderTabbar();
  qaInput.placeholder = qaPlaceholder();
  if (state.open) {
    if (skipInspector) skipInspector = false;
    else renderInspector();
  }
}

db.on(({ names }) => {
  if (['tasks', 'lists', 'events', 'calendars', 'settings'].some((n) => names.has(n))) render();
});
window.addEventListener('hashchange', route);
// Re-render at midnight and every minute (now line in events, "from yesterday" labels).
let lastDay = todayYmd();
setInterval(() => {
  if (todayYmd() !== lastDay) {
    lastDay = todayYmd();
    render();
  }
}, 60000);

// ---------------------------------------------------------------- completing

function complete(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  if (t.done) {
    const undo = toggleTask(id);
    undoable(`“${t.title}” restored`, undo, 'restore');
    return;
  }
  if (pendingComplete.has(id)) {
    pendingComplete.delete(id);
    renderBody();
    return;
  }
  pendingComplete.add(id);
  const row = $(`.task[data-id="${id}"]`);
  if (row) {
    const chk = $('.check', row);
    chk.setAttribute('aria-checked', 'true');
    chk.classList.add('pop');
    row.classList.add('completing');
  }
  setTimeout(() => row?.isConnected && pendingComplete.has(id) && row.classList.add('leaving'), 520);
  setTimeout(() => {
    if (!pendingComplete.has(id)) return;
    pendingComplete.delete(id);
    const undo = toggleTask(id);
    if (state.sel === id) state.sel = null;
    undoable(t.repeat ? `Done — next: ${dayLabel(db.get('tasks', id)?.date || todayYmd())}` : 'Task completed', undo, 'complete');
  }, 820);
}

// ---------------------------------------------------------------- selection & keyboard

const visibleIds = () => $$('.task[data-id]', bodyEl).map((r) => r.dataset.id);

function select(id, { scroll = true } = {}) {
  state.sel = id;
  $$('.task.sel', bodyEl).forEach((r) => r.classList.remove('sel'));
  const row = id && $(`.task[data-id="${id}"]`, bodyEl);
  if (row) {
    row.classList.add('sel');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }
  if (state.open && id && state.open !== id) openInspector(id);
}

function moveSel(dir) {
  const ids = visibleIds();
  if (!ids.length) return;
  const i = ids.indexOf(state.sel);
  const next = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + dir));
  select(ids[next]);
}

function reorderSel(dir) {
  const row = state.sel && $(`.task[data-id="${state.sel}"]`, bodyEl);
  if (!row) return;
  const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sib?.dataset.id) return;
  const a = db.get('tasks', state.sel);
  const b = db.get('tasks', sib.dataset.id);
  db.batch(() => {
    db.update('tasks', a.id, { order: b.order });
    db.update('tasks', b.id, { order: a.order });
  });
}

function shiftDate(id, days) {
  const t = db.get('tasks', id);
  const base = t.date || todayYmd();
  const date = addDaysYmd(base, t.date ? days : Math.max(0, days));
  update(id, { date, someday: false }, { message: `Moved to ${dayLabel(date)}` });
}

function setWhen(id, { date, evening = false, someday = false }) {
  const t = db.get('tasks', id);
  if (!t) return;
  update(id, { date, evening: date ? evening : false, someday, time: date ? t.time : null }, { message: someday ? 'Moved to Someday' : date ? `Scheduled for ${evening ? 'this evening' : dayLabel(date)}` : 'Date removed' });
}

function cyclePriority(id) {
  const t = db.get('tasks', id);
  update(id, { priority: ((t.priority || 0) + 1) % 4 });
}

function duplicate(id) {
  const t = db.get('tasks', id);
  const copy = createTask({ ...structuredClone(t), title: t.title, checklist: (t.checklist || []).map((c) => ({ ...c, id: uid(), done: false })), order: t.order + 0.001 });
  select(copy.id);
  undoable('Task duplicated', () => db.remove('tasks', copy.id));
}

function remove(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const ids = visibleIds();
  const next = ids[ids.indexOf(id) + 1] || ids[ids.indexOf(id) - 1] || null;
  const undo = deleteTask(id);
  if (state.open === id) closeInspector();
  state.sel = next;
  render();
  undoable(`Deleted “${t.title}”`, undo, 'delete');
}

function moveToListMenu(anchor, id) {
  const t = db.get('tasks', id);
  openMenu(anchor, [
    { heading: 'Move to' },
    { label: 'Inbox', icon: 'inbox', checked: !t.listId, onSelect: () => update(id, { listId: null }, { message: 'Moved to Inbox' }) },
    ...listsSorted().map((l) => ({
      label: l.name,
      iconHtml: `<span class="dot" style="color:${colorVar(l.color)};width:10px;height:10px;margin:0 4px"></span>`,
      checked: t.listId === l.id,
      onSelect: () => update(id, { listId: l.id }, { message: `Moved to ${l.name}` }),
    })),
    { sep: true },
    { label: 'New list…', icon: 'plus', onSelect: () => editListDialog(null, (l) => update(id, { listId: l.id })) },
  ]);
}

function rowMenu(anchor, id) {
  const t = db.get('tasks', id);
  openMenu(anchor, [
    { label: 'Open details', icon: 'edit', hint: '<kbd>↵</kbd>', onSelect: () => openInspector(id, { focus: true }) },
    { label: t.done ? 'Mark as not done' : 'Complete', icon: 'check-circle', hint: '<kbd>x</kbd>', onSelect: () => complete(id) },
    { sep: true },
    { label: 'Today', icon: 'star', hint: '<kbd>t</kbd>', onSelect: () => setWhen(id, { date: todayYmd() }) },
    { label: 'This Evening', icon: 'moon', onSelect: () => setWhen(id, { date: todayYmd(), evening: true }) },
    { label: 'Tomorrow', icon: 'sun', hint: '<kbd>]</kbd>', onSelect: () => setWhen(id, { date: addDaysYmd(todayYmd(), 1) }) },
    { label: 'Pick a date…', icon: 'calendar', hint: '<kbd>r</kbd>', onSelect: () => pickWhen(anchor, id) },
    { label: 'Someday', icon: 'archive', hint: '<kbd>s</kbd>', onSelect: () => setWhen(id, { date: null, someday: true }) },
    { sep: true },
    { label: 'Move to list…', icon: 'list', hint: '<kbd>l</kbd>', onSelect: () => moveToListMenu(anchor, id) },
    { label: 'Plan in schedule', icon: 'calendar-plus', onSelect: () => (location.href = `/schedule/#/day/${t.date || todayYmd()}/task/${t.id}`) },
    { label: 'Duplicate', icon: 'copy', hint: '<kbd>d</kbd>', onSelect: () => duplicate(id) },
    { label: 'Delete', icon: 'trash', danger: true, hint: '<kbd>⌫</kbd>', onSelect: () => remove(id) },
  ]);
}

function pickWhen(anchor, id) {
  const t = db.get('tasks', id);
  openDatePicker(anchor, { value: t.date, title: 'When', allowEvening: true, allowSomeday: true, someday: t.someday, onPick: (v) => setWhen(id, v) });
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || hasOpenLayer()) return;
  if (isTyping(e)) return;
  if (e.metaKey || e.ctrlKey) return;
  const k = e.key;
  const sel = state.sel && db.get('tasks', state.sel) ? state.sel : null;
  const rowAnchor = () => (sel && $(`.task[data-id="${sel}"] [data-row-date]`, bodyEl)) || $(`.task[data-id="${sel}"]`, bodyEl) || qa;
  if (e.altKey) {
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      reorderSel(k === 'ArrowUp' ? -1 : 1);
    }
    return;
  }
  const map = {
    n: () => focusQuickAdd(),
    q: () => focusQuickAdd(),
    '/': () => openPalette(),
    j: () => moveSel(1),
    ArrowDown: () => moveSel(1),
    k: () => moveSel(-1),
    ArrowUp: () => moveSel(-1),
    Escape: () => (state.open ? closeInspector() : select(null)),
  };
  for (const s of SMART_LISTS) map[s.key] = () => go(s.id);
  if (sel) {
    Object.assign(map, {
      Enter: () => openInspector(sel, { focus: true }),
      e: () => openInspector(sel, { focus: true }),
      x: () => complete(sel),
      t: () => setWhen(sel, { date: todayYmd() }),
      s: () => setWhen(sel, { date: null, someday: true }),
      r: () => pickWhen(rowAnchor(), sel),
      '[': () => shiftDate(sel, -1),
      ']': () => shiftDate(sel, 1),
      p: () => cyclePriority(sel),
      l: () => moveToListMenu(rowAnchor(), sel),
      d: () => duplicate(sel),
      Delete: () => remove(sel),
      Backspace: () => remove(sel),
    });
  }
  const fn = map[k];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

registerShortcuts([
  {
    title: 'Navigate',
    items: [
      ['Inbox · Today · Upcoming', '1 / 2 / 3'],
      ['Anytime · Someday · Logbook', '4 / 5 / 6'],
      ['Next / previous task', 'j / k'],
      ['Search', '/'],
    ],
  },
  {
    title: 'Tasks',
    items: [
      ['New task', 'n / q'],
      ['Open details', '↵ / e'],
      ['Complete', 'x'],
      ['Move to Today', 't'],
      ['Pick a date', 'r'],
      ['Earlier / later by a day', '[ / ]'],
      ['Someday', 's'],
      ['Cycle priority', 'p'],
      ['Move to list', 'l'],
      ['Duplicate', 'd'],
      ['Reorder', 'alt ↑ / alt ↓'],
      ['Delete', '⌫'],
    ],
  },
  {
    title: 'Quick add',
    items: [
      ['Date', 'tomorrow · fri · dec 5'],
      ['Time & length', '6pm · for 30m'],
      ['Repeat', 'every weekday'],
      ['Deadline', 'by friday'],
      ['List · tag · priority', '#Work · @phone · !!'],
      ['Evening · someday', 'tonight · someday'],
    ],
  },
]);

// ---------------------------------------------------------------- pointer: clicks, swipe

mainEl.addEventListener('scroll', () => topbar.classList.toggle('scrolled', mainEl.scrollTop > 44), { passive: true });

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-new]')) return focusQuickAdd();
  if (t.closest('[data-toggle-nav]')) return shellEl.classList.toggle('nav-open');
  if (t.closest('[data-close-nav]')) return shellEl.classList.remove('nav-open');
  if (t.closest('[data-add-list]')) return editListDialog(null, (l) => go(l.id));
  if (t.closest('.nav-item')) shellEl.classList.remove('nav-open');
});

bodyEl.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-toggle-done]')) {
    state.showDone = !state.showDone;
    return renderBody();
  }
  const addOn = t.closest('[data-add-on]');
  if (addOn) {
    const d = addOn.dataset.addOn;
    const label = diffDays(todayYmd(), d) === 1 ? 'tomorrow' : fmt(parseYmd(d), { month: 'short', day: 'numeric' }).toLowerCase();
    return focusQuickAdd(`${label} `);
  }
  const row = t.closest('.task[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  if (t.closest('[data-check]')) return complete(id);
  if (t.closest('[data-row-date]')) {
    select(id, { scroll: false });
    return pickWhen(t.closest('[data-row-date]'), id);
  }
  if (t.closest('[data-row-more]')) {
    select(id, { scroll: false });
    return rowMenu(t.closest('[data-row-more]'), id);
  }
  select(id, { scroll: false });
  openInspector(id);
});

bodyEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.task[data-id]');
  if (!row) return;
  e.preventDefault();
  select(row.dataset.id, { scroll: false });
  rowMenu({ x: e.clientX, y: e.clientY }, row.dataset.id);
});

// Swipe right to complete, left to reschedule (touch).
let swipe = null;
bodyEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const row = e.target.closest('.task[data-id]');
  if (!row || e.target.closest('button')) return;
  swipe = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, active: false, bg: null };
});
bodyEl.addEventListener('pointermove', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 10) return void (swipe = null);
    if (Math.abs(dx) < 12) return;
    swipe.active = true;
    const bg = document.createElement('div');
    swipe.row.parentElement.style.position = 'relative';
    bg.style.cssText = `top:${swipe.row.offsetTop}px;height:${swipe.row.offsetHeight}px;left:-6px;right:-6px;bottom:auto;`;
    swipe.row.before(bg);
    swipe.bg = bg;
    swipe.row.classList.add('swiping');
  }
  swipe.dx = dx;
  swipe.bg.className = `swipe-bg ${dx > 0 ? 'right' : 'left'}`;
  swipe.bg.innerHTML = dx > 0 ? `${icon('check', { stroke: 3 })}<span></span>` : `<span>${icon('calendar')}</span>`;
  swipe.row.style.transform = `translateX(${dx}px)`;
});
const endSwipe = () => {
  if (!swipe) return;
  const { row, bg, dx, id, active } = swipe;
  swipe = null;
  if (!active) return;
  row.style.transition = 'transform 260ms var(--ease-out)';
  row.style.transform = '';
  setTimeout(() => {
    bg?.remove();
    row.classList.remove('swiping');
    row.style.transition = '';
  }, 260);
  if (dx > 90) complete(id);
  else if (dx < -90) pickWhen(row, id);
};
bodyEl.addEventListener('pointerup', endSwipe);
bodyEl.addEventListener('pointercancel', endSwipe);

// ---------------------------------------------------------------- drag & drop

let dragId = null;
const clearDropMarks = () => $$('.drop-before, .drop-after, .drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));

document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.task[data-id]');
  if (!row) return;
  dragId = row.dataset.id;
  const t = db.get('tasks', dragId);
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/x-ecosys-task', dragId);
  e.dataTransfer.setData('text/plain', t?.title || '');
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
  const nav = e.target.closest?.('.nav-item[data-drop]');
  if (nav) {
    e.preventDefault();
    nav.classList.add('drop-target');
    return;
  }
  const row = e.target.closest?.('.task[data-id]');
  if (row && row.dataset.id !== dragId && bodyEl.contains(row)) {
    e.preventDefault();
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    return;
  }
  const section = e.target.closest?.('.section[data-date], .section[data-list]');
  if (section) {
    e.preventDefault();
    section.querySelector('.section-head')?.classList.add('drop-target');
  }
});
document.addEventListener('drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const id = dragId;
  const t = db.get('tasks', id);
  clearDropMarks();
  const nav = e.target.closest?.('.nav-item[data-drop]');
  if (nav) {
    const target = nav.dataset.drop;
    const today = todayYmd();
    if (target === 'logbook') return complete(id);
    const patch =
      target === 'inbox'
        ? { listId: null, date: null, time: null, someday: false, evening: false }
        : target === 'today'
          ? { date: today, someday: false, evening: false }
          : target === 'upcoming'
            ? { date: addDaysYmd(today, 1), someday: false }
            : target === 'anytime'
              ? { date: null, time: null, someday: false, evening: false }
              : target === 'someday'
                ? { someday: true, date: null, time: null, evening: false }
                : target.startsWith('list:')
                  ? { listId: target.slice(5) }
                  : null;
    if (patch) {
      const label = target.startsWith('list:') ? db.get('lists', target.slice(5))?.name : smart(target)?.name;
      update(id, patch, { message: `Moved to ${label}` });
    }
    return;
  }
  const row = e.target.closest?.('.task[data-id]');
  const section = e.target.closest?.('.section');
  const patch = {};
  if (section) {
    const ds = section.dataset;
    if (ds.date !== undefined) {
      patch.date = ds.date;
      patch.someday = false;
    }
    if (ds.evening !== undefined) patch.evening = ds.evening === '1';
    if (ds.list !== undefined) patch.listId = ds.list || null;
    if (ds.someday === '1') patch.someday = true;
  }
  if (row && row.dataset.id !== id) {
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const target = db.get('tasks', row.dataset.id);
    const sib = before ? row.previousElementSibling : row.nextElementSibling;
    const sibTask = sib?.dataset?.id && sib.dataset.id !== id ? db.get('tasks', sib.dataset.id) : null;
    const o = target.order ?? 0;
    patch.order = sibTask ? (o + (sibTask.order ?? 0)) / 2 : before ? o - 1 : o + 1;
  }
  if (Object.keys(patch).length) {
    const changedDay = patch.date && patch.date !== t.date;
    update(id, patch, changedDay ? { message: `Moved to ${dayLabel(patch.date)}` } : {});
  }
});

// ---------------------------------------------------------------- inspector

function openTask(id) {
  const t = db.get('tasks', id);
  if (!t) return;
  const v = viewForTask(t);
  state.sel = id;
  openInspector(id, { render: false });
  go(v);
}

function openInspector(id, { focus = false, render: doRender = true } = {}) {
  state.open = id;
  inspEl.hidden = false;
  shellEl.classList.add('has-inspector');
  renderInspector();
  if (doRender) {
    $$('.task.open', bodyEl).forEach((r) => r.classList.remove('open'));
    $(`.task[data-id="${id}"]`, bodyEl)?.classList.add('open');
  }
  if (focus) requestAnimationFrame(() => $('[data-f="title"]', inspEl)?.focus());
}

function closeInspector() {
  state.open = null;
  inspEl.hidden = true;
  inspEl.innerHTML = '';
  shellEl.classList.remove('has-inspector');
  $$('.task.open', bodyEl).forEach((r) => r.classList.remove('open'));
}

const sameRule = (a, b) => {
  if (!a || !b) return !a && !b;
  const norm = (r) => JSON.stringify({ f: r.freq, i: r.interval || 1, d: r.days ? [...r.days].sort() : null, m: r.freq === 'month' || r.freq === 'year' ? r.monthDay || null : null });
  return norm(a) === norm(b);
};

function renderInspector() {
  const t = state.open && db.get('tasks', state.open);
  if (!t) return closeInspector();
  const lists = listsSorted();
  const list = t.listId ? db.get('lists', t.listId) : null;
  const c = list ? colorVar(list.color) : 'var(--accent)';
  const rp = presets(t.date || todayYmd());
  const rpIndex = rp.findIndex((p) => sameRule(p.rule, t.repeat));
  const durations = [15, 30, 45, 60, 90, 120, 180, 240];
  const activeEl = document.activeElement;
  const focusKey = inspEl.contains(activeEl) ? activeEl.dataset.f || (activeEl.dataset.clTitle !== undefined ? `cl:${activeEl.closest('[data-cl]')?.dataset.cl}` : null) : null;
  const dl = t.deadline ? deadlineInfo(t.deadline) : null;

  inspEl.innerHTML = `
    <div class="insp-head">
      <div class="crumb">${list ? `<span class="dot" style="color:${c}"></span>${esc(list.name)}` : `${icon('inbox', { size: 15 })}Inbox`}</div>
      <span class="grow"></span>
      <button type="button" class="icon-btn" data-insp-more aria-label="More">${icon('more')}</button>
      <button type="button" class="icon-btn" data-insp-close aria-label="Close details">${icon('x')}</button>
    </div>
    <div class="insp-scroll">
      <div class="insp-title">
        <button type="button" class="check" role="checkbox" aria-checked="${t.done}" aria-label="Complete" style="--c:${c}" data-insp-check>${icon('check', { size: 14, stroke: 3 })}</button>
        <textarea rows="1" data-f="title" placeholder="Task name" aria-label="Task name">${esc(t.title)}</textarea>
      </div>
      <div class="insp-notes"><textarea rows="1" data-f="notes" placeholder="Notes" aria-label="Notes">${esc(t.notes || '')}</textarea></div>
      <div class="checklist">
        ${(t.checklist || [])
          .map(
            (c2) => `<div class="cl-item${c2.done ? ' done' : ''}" data-cl="${c2.id}">
              <button type="button" class="check sm" role="checkbox" aria-checked="${c2.done}" style="--c:${c}" data-cl-check aria-label="Toggle item">${icon('check', { size: 10, stroke: 3.4 })}</button>
              <input type="text" value="${esc(c2.title)}" data-cl-title aria-label="Checklist item">
              <button type="button" class="icon-btn" data-cl-del aria-label="Remove item">${icon('x', { size: 14 })}</button>
            </div>`,
          )
          .join('')}
        <div class="cl-item cl-add"><span class="check sm"></span><input type="text" placeholder="Add checklist item" data-cl-new aria-label="Add checklist item"></div>
      </div>

      <div class="group insp-props">
        <div class="item"><span class="label">${icon('calendar')}When</span><div class="ctl">
          <button type="button" class="prop-btn${!t.date && !t.someday ? ' empty' : ''}" data-prop="when">${t.evening ? icon('moon') : t.someday ? icon('archive') : t.date === todayYmd() ? icon('star') : ''}${esc(whenLabel(t))}</button>
        </div></div>
        <div class="item"><span class="label">${icon('clock')}Time</span><div class="ctl">
          <input type="time" class="input" data-f="time" value="${t.time || ''}" aria-label="Start time" step="300">
          <select class="input" data-f="duration" aria-label="Duration">
            <option value="">No length</option>
            ${durations.map((m) => `<option value="${m}" ${t.duration === m ? 'selected' : ''}>${fmtDuration(m)}</option>`).join('')}
            ${t.duration && !durations.includes(t.duration) ? `<option value="${t.duration}" selected>${fmtDuration(t.duration)}</option>` : ''}
          </select>
        </div></div>
        <div class="item"><span class="label">${icon('flag')}Deadline</span><div class="ctl">
          <button type="button" class="prop-btn${!t.deadline ? ' empty' : dl.cls === 'danger' ? ' danger' : ''}" data-prop="deadline">${t.deadline ? `${esc(dayLabel(t.deadline))}${dl.cls ? ` · ${esc(dl.text)}` : ''}` : 'Add deadline'}</button>
          ${t.deadline ? `<button type="button" class="icon-btn sm" data-clear="deadline" aria-label="Remove deadline">${icon('x', { size: 14 })}</button>` : ''}
        </div></div>
        <div class="item"><span class="label">${icon('repeat')}Repeat</span><div class="ctl">
          <select class="input" data-f="repeat" aria-label="Repeat">
            ${rp.map((p, i) => `<option value="${i}" ${i === rpIndex || (rpIndex < 0 && !t.repeat && i === 0) ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
            ${t.repeat && rpIndex < 0 ? `<option value="custom" selected>${esc(describe(t.repeat))}</option>` : ''}
          </select>
          ${t.repeat ? `<select class="input" data-f="repeatFrom" aria-label="Repeat from"><option value="due" ${t.repeat.from !== 'done' ? 'selected' : ''}>On schedule</option><option value="done" ${t.repeat.from === 'done' ? 'selected' : ''}>After completion</option></select>` : ''}
        </div></div>
        <div class="item"><span class="label">${icon('list')}List</span><div class="ctl">
          <select class="input" data-f="listId" aria-label="List"><option value="">Inbox</option>${lists.map((l) => `<option value="${l.id}" ${t.listId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        </div></div>
        <div class="item"><span class="label">${icon('tag')}Tags</span><div class="ctl">
          ${(t.tags || []).map((g) => `<button type="button" class="chip" data-tag-del="${esc(g)}" title="Remove tag">${esc(g)} ${icon('x', { size: 11 })}</button>`).join('')}
          <input class="tag-input" placeholder="Add tag" data-tag-new aria-label="Add tag" list="tag-suggest"><datalist id="tag-suggest">${allTags().map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
        </div></div>
        <div class="item"><span class="label">${icon('bolt')}Priority</span><div class="ctl">
          <div class="segmented">${['None', '!', '!!', '!!!'].map((l, i) => `<button type="button" data-prio="${i}" aria-pressed="${(t.priority || 0) === i}">${l}</button>`).join('')}</div>
        </div></div>
      </div>
      ${
        !t.done
          ? `<a class="btn btn-tint btn-block" style="margin-top:16px" href="/schedule/#/day/${t.date || todayYmd()}/task/${t.id}">${icon('calendar-plus', { size: 18 })}${t.time ? 'See the time block in schedule' : 'Plan time for it in schedule'}</a>`
          : ''
      }
    </div>
    <div class="insp-foot"><span>${t.done && t.completedAt ? `Completed ${esc(fmt(new Date(t.completedAt), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : `Created ${esc(fmt(new Date(t.createdAt), { month: 'short', day: 'numeric' }))}`}</span><span class="grow"></span>
      <button type="button" class="btn btn-danger btn-sm" data-insp-delete>${icon('trash', { size: 15 })}Delete</button></div>`;

  $$('textarea', inspEl).forEach(autosize);
  if (focusKey) {
    const el = focusKey.startsWith('cl:') ? $(`[data-cl="${focusKey.slice(3)}"] [data-cl-title]`, inspEl) : $(`[data-f="${focusKey}"]`, inspEl);
    el?.focus();
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

const quiet = (fn) => {
  skipInspector = true;
  fn();
};

inspEl.addEventListener('input', (e) => {
  const t = db.get('tasks', state.open);
  if (!t) return;
  const el = e.target;
  if (el.tagName === 'TEXTAREA') autosize(el);
  if (el.dataset.f === 'title') quiet(() => db.update('tasks', t.id, { title: el.value }));
  else if (el.dataset.f === 'notes') quiet(() => db.update('tasks', t.id, { notes: el.value }));
  else if (el.dataset.clTitle !== undefined) {
    const cid = el.closest('[data-cl]').dataset.cl;
    quiet(() => db.update('tasks', t.id, { checklist: t.checklist.map((c) => (c.id === cid ? { ...c, title: el.value } : c)) }));
  }
});

inspEl.addEventListener('change', (e) => {
  const t = db.get('tasks', state.open);
  if (!t) return;
  const el = e.target;
  const f = el.dataset.f;
  if (f === 'time') db.update('tasks', t.id, { time: el.value || null, date: el.value && !t.date ? todayYmd() : t.date, someday: el.value ? false : t.someday });
  else if (f === 'duration') db.update('tasks', t.id, { duration: el.value ? +el.value : null });
  else if (f === 'listId') db.update('tasks', t.id, { listId: el.value || null });
  else if (f === 'repeat') {
    if (el.value === 'custom') return;
    const rule = presets(t.date || todayYmd())[+el.value].rule;
    db.update('tasks', t.id, { repeat: rule ? { ...rule, from: t.repeat?.from || 'due' } : null, date: rule && !t.date ? todayYmd() : t.date, someday: rule ? false : t.someday });
  } else if (f === 'repeatFrom') db.update('tasks', t.id, { repeat: { ...t.repeat, from: el.value } });
});

inspEl.addEventListener('keydown', (e) => {
  const t = db.get('tasks', state.open);
  if (!t) return;
  const el = e.target;
  if (el.dataset.f === 'title' && e.key === 'Enter') {
    e.preventDefault();
    $('[data-f="notes"]', inspEl).focus();
  }
  if (el.dataset.clNew !== undefined && e.key === 'Enter' && el.value.trim()) {
    e.preventDefault();
    db.update('tasks', t.id, { checklist: [...(t.checklist || []), { id: uid(), title: el.value.trim(), done: false }] });
    requestAnimationFrame(() => $('[data-cl-new]', inspEl)?.focus());
  }
  if (el.dataset.clTitle !== undefined && e.key === 'Enter') {
    e.preventDefault();
    $('[data-cl-new]', inspEl).focus();
  }
  if (el.dataset.clTitle !== undefined && e.key === 'Backspace' && !el.value) {
    e.preventDefault();
    const cid = el.closest('[data-cl]').dataset.cl;
    db.update('tasks', t.id, { checklist: t.checklist.filter((c) => c.id !== cid) });
  }
  if (el.dataset.tagNew !== undefined && (e.key === 'Enter' || e.key === ',') && el.value.trim()) {
    e.preventDefault();
    const g = el.value.trim().replace(/^[@#]/, '').toLowerCase().replace(/\s+/g, '-');
    if (!t.tags.includes(g)) db.update('tasks', t.id, { tags: [...t.tags, g] });
    requestAnimationFrame(() => $('[data-tag-new]', inspEl)?.focus());
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    el.blur();
  }
});

inspEl.addEventListener('click', (e) => {
  const t = db.get('tasks', state.open);
  if (!t) return;
  const el = e.target;
  if (el.closest('[data-insp-close]')) return closeInspector();
  if (el.closest('[data-insp-check]')) return complete(t.id);
  if (el.closest('[data-insp-delete]')) return remove(t.id);
  if (el.closest('[data-insp-more]')) return rowMenu(el.closest('[data-insp-more]'), t.id);
  const prop = el.closest('[data-prop]')?.dataset.prop;
  if (prop === 'when') return pickWhen(el.closest('[data-prop]'), t.id);
  if (prop === 'deadline')
    return openDatePicker(el.closest('[data-prop]'), { value: t.deadline, title: 'Deadline', onPick: ({ date }) => db.update('tasks', t.id, { deadline: date }) });
  if (el.closest('[data-clear="deadline"]')) return db.update('tasks', t.id, { deadline: null });
  const prio = el.closest('[data-prio]');
  if (prio) return db.update('tasks', t.id, { priority: +prio.dataset.prio });
  const tagDel = el.closest('[data-tag-del]');
  if (tagDel) return db.update('tasks', t.id, { tags: t.tags.filter((g) => g !== tagDel.dataset.tagDel) });
  const cl = el.closest('[data-cl]');
  if (cl && el.closest('[data-cl-check]')) return db.update('tasks', t.id, { checklist: t.checklist.map((c) => (c.id === cl.dataset.cl ? { ...c, done: !c.done } : c)) });
  if (cl && el.closest('[data-cl-del]')) return db.update('tasks', t.id, { checklist: t.checklist.filter((c) => c.id !== cl.dataset.cl) });
});

// ---------------------------------------------------------------- lists

function editListDialog(list, onDone) {
  let color = list?.color || COLORS.find((c) => !db.all('lists').some((l) => l.color === c)) || 'iris';
  const { el, close } = openModal({
    title: list ? 'Edit list' : 'New list',
    body: `<div class="modal-body">
      <form data-list-form>
        <input class="input" name="name" placeholder="List name" value="${esc(list?.name || '')}" autofocus required maxlength="60" style="height:46px;font-size:17px">
        <div class="group-title" style="padding-left:2px">Colour</div>
        <div class="swatches" style="padding:2px">${COLORS.map((c) => `<button type="button" class="swatch-btn" style="--sw:${colorVar(c)}" data-color="${c}" aria-checked="${c === color}" aria-label="${c}">${icon('check')}</button>`).join('')}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:22px">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${list ? 'Save' : 'Create list'}</button>
        </div>
      </form></div>`,
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    color = b.dataset.color;
    $$('[data-color]', el).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  });
  $('[data-list-form]', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').toString().trim();
    if (!name) return;
    const saved = list ? db.update('lists', list.id, { name, color }) : createList({ name, color });
    close();
    onDone?.(saved);
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
          { label: 'Delete list, keep tasks in Inbox', value: 'keep', tone: 'secondary' },
          { label: `Delete list and its ${tasks.length} tasks`, value: 'all', tone: 'danger' },
        ],
      })
    : 'all';
  if (!choice) return;
  const snapshot = { list: structuredClone(list), tasks: structuredClone(tasks) };
  db.batch(() => {
    db.remove('lists', list.id);
    for (const t of tasks) choice === 'all' ? db.remove('tasks', t.id) : db.update('tasks', t.id, { listId: null });
  });
  go('inbox');
  undoable(`Deleted “${list.name}”`, () =>
    db.batch(() => {
      db.put('lists', snapshot.list);
      for (const t of snapshot.tasks) db.put('tasks', t);
    }),
  );
}

$('#view-menu').addEventListener('click', (e) => {
  const list = currentList();
  const items = [];
  if (list) {
    items.push(
      { label: 'Rename or recolour…', icon: 'edit', onSelect: () => editListDialog(list) },
      { label: state.showDone ? 'Hide completed' : 'Show completed', icon: state.showDone ? 'eye-off' : 'eye', onSelect: () => ((state.showDone = !state.showDone), renderBody()) },
      { label: 'Open in schedule', icon: 'calendar', onSelect: () => (location.href = '/schedule/') },
      { sep: true },
      { label: 'Delete list…', icon: 'trash', danger: true, onSelect: () => deleteList(list) },
      { sep: true },
    );
  }
  if (state.view === 'logbook' && tasksIn('logbook').length) {
    items.push(
      {
        label: 'Clear Logbook…',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const done = tasksIn('logbook');
          const ok = await choiceDialog({ title: 'Clear the Logbook?', message: `${done.length} completed tasks will be deleted.`, choices: [{ label: 'Clear Logbook', value: true, tone: 'danger' }] });
          if (!ok) return;
          const snap = structuredClone(done);
          db.batch(() => done.forEach((t) => db.remove('tasks', t.id)));
          undoable('Logbook cleared', () => db.batch(() => snap.forEach((t) => db.put('tasks', t))));
        },
      },
      { sep: true },
    );
  }
  items.push(
    { label: 'New list…', icon: 'plus', onSelect: () => editListDialog(null, (l) => go(l.id)) },
    { label: 'Open schedule', iconHtml: icon('calendar', { size: 18 }), onSelect: () => (location.href = '/schedule/') },
    { label: 'Settings', icon: 'gear', hint: '<kbd>,</kbd>', onSelect: () => openSettings() },
  );
  openMenu(e.currentTarget, items, { align: 'end' });
});

navEl.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.nav-item[data-nav]');
  const list = item && db.get('lists', item.dataset.nav);
  if (!list) return;
  e.preventDefault();
  openMenu({ x: e.clientX, y: e.clientY }, [
    { label: 'Rename or recolour…', icon: 'edit', onSelect: () => editListDialog(list) },
    { label: 'Delete list…', icon: 'trash', danger: true, onSelect: () => deleteList(list) },
  ]);
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
        .sort((a, b) => a.t.done - b.t.done || b.s - a.s)
        .slice(0, 8);
      for (const { t } of hits)
        out.push({
          group: 'Tasks',
          label: t.title,
          sub: t.done ? 'Completed' : t.someday ? 'Someday' : t.date ? dayLabel(t.date) : lists.get(t.listId)?.name || 'Inbox',
          icon: t.done ? 'check-circle' : 'circle',
          run: () => openTask(t.id),
        });
      out.push({ group: 'Create', label: `New task “${q}”`, icon: 'plus', run: () => focusQuickAdd(q) });
    }
    const nav = [
      ...SMART_LISTS.map((s) => ({ label: `Go to ${s.name}`, icon: s.icon, hint: `<kbd>${s.key}</kbd>`, run: () => go(s.id) })),
      ...listsSorted().map((l) => ({ label: `Go to ${l.name}`, iconHtml: `<span class="dot" style="color:${colorVar(l.color)};width:10px;height:10px;margin:0 4px"></span>`, run: () => go(l.id) })),
      { label: 'New list', icon: 'plus', run: () => editListDialog(null, (l) => go(l.id)) },
    ];
    for (const n of nav) if (!q || score(n.label, q)) out.push({ group: 'Go to', ...n });
    return q ? out : out.slice(0, 8);
  },
  { prepend: true },
);

// ---------------------------------------------------------------- go

route();
