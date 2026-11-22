// ecosys shell: theme, app switcher, toasts, menus, modals, command palette, shortcuts, settings, date picker.
import { db, settings, exportData, importData, resetData, seedIfEmpty, registerSeeder } from './store.js';
import { icon } from './icons.js';
import { seed } from './seed.js';
import { setHour12, todayYmd, addDaysYmd, parseYmd, ymd, addDays, fmt, WEEKDAY_SHORT, dayLabel } from './dates.js';
import { miniCalendar } from './minical.js';
import { parse } from './nlp.js';

// ---------------------------------------------------------------- tiny DOM helpers

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';
export const isTyping = (e) => {
  const t = e.target;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};
export function html(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (i < vals.length ? vals[i] ?? '' : ''), '');
}

// ---------------------------------------------------------------- apps registry & icons

export const APPS = [
  { id: 'home', name: 'Home', url: '/', blurb: 'Your day at a glance' },
  { id: 'tasks', name: 'Tasks', url: '/tasks/', blurb: 'To-dos, lists & plans' },
  { id: 'schedule', name: 'Schedule', url: '/schedule/', blurb: 'Calendar & time blocks' },
];

let gid = 0;
export function appIcon(id) {
  const g = `ecg${++gid}`;
  const grad = (a, b) =>
    `<defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#${g})"/>`;
  if (id === 'tasks') {
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${grad('#2aa8f5', '#5856f5')}<circle cx="32" cy="32" r="17" fill="none" stroke="#fff" stroke-width="5"/><path d="M24.2 32.6 29.8 38 40 27.2" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (id === 'schedule') {
    const now = new Date();
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${grad('#6d4aff', '#b14de0')}<text x="32" y="22" text-anchor="middle" font-family="-apple-system,Segoe UI,Inter,sans-serif" font-size="10.5" font-weight="700" letter-spacing=".5" fill="#fff" fill-opacity=".85">${WEEKDAY_SHORT[now.getDay()].toUpperCase()}</text><text x="32" y="50" text-anchor="middle" font-family="-apple-system,Segoe UI,Inter,sans-serif" font-size="29" font-weight="700" fill="#fff">${now.getDate()}</text></svg>`;
  }
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${grad('#1d9bf0', '#6d4aff')}<circle cx="32" cy="32" r="16" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="3"/><circle cx="32" cy="32" r="6.5" fill="#fff"/><circle cx="46" cy="24" r="4.5" fill="#fff"/><circle cx="20" cy="43" r="3.5" fill="#fff" fill-opacity=".85"/></svg>`;
}

export function setFavicon(id) {
  const svg = appIcon(id).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace('<rect width="64" height="64"', '<rect width="64" height="64" rx="15"');
  let link = $('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// ---------------------------------------------------------------- theme

export const ACCENTS = [
  { id: 'iris', name: 'Iris', color: '#5856f5' },
  { id: 'blue', name: 'Blue', color: '#1d9bf0' },
  { id: 'violet', name: 'Violet', color: '#6d4aff' },
  { id: 'pink', name: 'Pink', color: '#f91880' },
  { id: 'orange', name: 'Orange', color: '#f57600' },
  { id: 'green', name: 'Green', color: '#00a870' },
  { id: 'yellow', name: 'Yellow', color: '#e0a800' },
];
export const THEMES = [
  { id: 'system', name: 'Automatic' },
  { id: 'light', name: 'Light' },
  { id: 'dim', name: 'Dim' },
  { id: 'dark', name: 'Lights out' },
];
const darkMq = matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  const s = settings.get();
  const theme = s.theme === 'system' ? (darkMq.matches ? 'dark' : 'light') : s.theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = s.accent || 'iris';
  root.dataset.reduceMotion = String(!!s.reduceMotion);
  setHour12(s.timeFormat === 'auto' ? null : s.timeFormat === '12h');
  let meta = $('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#000';
}

// ---------------------------------------------------------------- layers (Esc closes the top one)

const layers = [];
export const hasOpenLayer = () => layers.length > 0;
function pushLayer(close) {
  const layer = { close };
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}
export function closeTopLayer() {
  const top = layers.at(-1);
  if (top) top.close();
  return !!top;
}

// ---------------------------------------------------------------- toasts

let toastBox = null;
export function toast(message, { action, onAction, duration = 4500, tone } = {}) {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }
  while (toastBox.children.length >= 2) toastBox.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast${tone ? ' ' + tone : ''}`;
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  toastBox.append(el);
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 230);
  };
  el.querySelector('button')?.addEventListener('click', () => {
    onAction?.();
    close();
  });
  const arm = () => (timer = setTimeout(close, duration));
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  arm();
  return close;
}

// Global undo stack (⌘Z) — every destructive action pushes its undo here.
const undoStack = [];
export function pushUndo(label, fn) {
  undoStack.push({ label, fn });
  if (undoStack.length > 50) undoStack.shift();
}
export function undoLast() {
  const u = undoStack.pop();
  if (!u) {
    toast('Nothing to undo', { tone: 'neutral', duration: 1800 });
    return;
  }
  u.fn();
  toast(`Undid ${u.label}`, { tone: 'neutral', duration: 2200 });
}
/** Show a toast with Undo and register the undo for ⌘Z. */
export function undoable(message, undoFn, label = message.toLowerCase()) {
  pushUndo(label, undoFn);
  toast(message, {
    action: 'Undo',
    onAction: () => {
      const i = undoStack.findIndex((u) => u.fn === undoFn);
      if (i >= 0) undoStack.splice(i, 1);
      undoFn();
    },
  });
}

// ---------------------------------------------------------------- popovers & menus

function place(el, anchor, { align = 'start', side = 'bottom', offset = 6 } = {}) {
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = innerWidth;
  const vh = innerHeight;
  let x = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
  let y = side === 'top' ? r.top - h - offset : r.bottom + offset;
  if (side === 'right') {
    x = r.right + offset;
    y = r.top;
  }
  if (y + h > vh - 8) y = Math.max(8, side === 'bottom' ? r.top - h - offset : vh - h - 8);
  if (y < 8) y = 8;
  x = Math.min(Math.max(8, x), vw - w - 8);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--origin', `${align === 'end' ? 'right' : 'left'} ${y < r.top ? 'bottom' : 'top'}`);
}

/** Open a floating panel. Returns {el, close}. */
export function openPopover(anchor, content, { className = '', align, side, onClose, onMount, focus = true } = {}) {
  const el = document.createElement('div');
  el.className = `menu ${className}`;
  el.setAttribute('role', 'dialog');
  el.innerHTML = content;
  document.body.append(el);
  place(el, anchor, { align, side });
  let closed = false;
  const prevFocus = document.activeElement;
  const close = () => {
    if (closed) return;
    closed = true;
    popLayer();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    el.remove();
    onClose?.();
    if (prevFocus && document.contains(prevFocus) && !document.activeElement?.closest?.('.menu, .modal')) prevFocus.focus?.({ preventScroll: true });
  };
  const popLayer = pushLayer(close);
  const outside = (e) => {
    if (!el.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) close();
  };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  window.addEventListener('resize', close);
  onMount?.(el, close);
  if (focus) (el.querySelector('[autofocus]') || el.querySelector('button, input, [tabindex]'))?.focus({ preventScroll: true });
  return { el, close, reposition: () => place(el, anchor, { align, side }) };
}

/**
 * items: [{label, icon, hint, danger, checked, disabled, onSelect}] | {sep:true} | {heading:'…'}
 */
export function openMenu(anchor, items, opts = {}) {
  const body = items
    .map((it, i) => {
      if (it.sep) return '<div class="menu-sep"></div>';
      if (it.heading) return `<div class="menu-label">${esc(it.heading)}</div>`;
      const role = it.checked !== undefined ? 'menuitemradio' : 'menuitem';
      return `<button type="button" class="menu-item${it.danger ? ' danger' : ''}" role="${role}" data-i="${i}" ${it.checked !== undefined ? `aria-checked="${!!it.checked}"` : ''} ${it.disabled ? 'disabled' : ''}>
        ${it.iconHtml || (it.icon ? icon(it.icon, { size: 18 }) : '')}
        <span class="grow truncate">${esc(it.label)}</span>
        ${it.hint ? `<span class="hint">${it.hint}</span>` : ''}
        ${it.checked !== undefined ? `<span class="check-mark">${icon('check', { size: 16 })}</span>` : ''}
      </button>`;
    })
    .join('');
  const pop = openPopover(anchor, `<div role="menu">${body}</div>`, {
    ...opts,
    onMount: (el, close) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (!b) return;
        const it = items[+b.dataset.i];
        close();
        it.onSelect?.();
      });
      el.addEventListener('keydown', (e) => {
        const btns = $$('.menu-item:not([disabled])', el);
        const i = btns.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          btns[(i + 1) % btns.length]?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          btns[(i - 1 + btns.length) % btns.length]?.focus();
        }
      });
    },
  });
  return pop;
}

// ---------------------------------------------------------------- modal / sheet

/** Opens a centered modal (a bottom sheet on phones). Returns {el, close}. */
export function openModal({ title = '', body = '', className = '', headExtra = '', onMount, onClose, label } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const el = document.createElement('div');
  el.className = `modal ${className}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', label || title || 'Dialog');
  el.innerHTML = `<div class="grabber" aria-hidden="true"></div>${
    title || headExtra
      ? `<div class="modal-head"><h2>${esc(title)}</h2>${headExtra}<button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>`
      : ''
  }${body}`;
  document.body.append(scrim, el);
  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    popLayer();
    scrim.remove();
    el.remove();
    onClose?.();
    prevFocus?.focus?.({ preventScroll: true });
  };
  const popLayer = pushLayer(close);
  scrim.addEventListener('pointerdown', close);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  // Swipe the grabber down to dismiss on touch screens.
  const grab = el.querySelector('.grabber');
  let startY = null;
  grab.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    const dy = Math.max(0, e.clientY - startY);
    el.style.transform = `translateY(${dy}px)`;
  });
  grab.addEventListener('pointerup', (e) => {
    if (startY !== null && e.clientY - startY > 80) close();
    else el.style.transform = '';
    startY = null;
  });
  onMount?.(el, close);
  requestAnimationFrame(() => (el.querySelector('[autofocus]') || el.querySelector('input, textarea, button:not([data-close])'))?.focus({ preventScroll: true }));
  return { el, close };
}

export function confirmDialog({ title, message = '', confirm = 'OK', danger = false, cancel = 'Cancel' }) {
  return choiceDialog({ title, message, choices: [{ label: confirm, value: true, tone: danger ? 'danger' : 'primary' }], cancel }).then((v) => v === true);
}

/** choices: [{label, value, tone:'primary'|'danger'|'secondary'}] → resolves to value or null. */
export function choiceDialog({ title, message = '', choices, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    let result = null;
    openModal({
      className: 'choice',
      label: title,
      body: `<div class="modal-body" style="padding-top:24px;text-align:center">
        <h2 style="font:var(--t-title3);margin:0 0 6px">${esc(title)}</h2>
        ${message ? `<p class="muted" style="margin:0 0 20px;font:var(--t-callout)">${esc(message)}</p>` : '<div style="height:14px"></div>'}
        <div style="display:flex;flex-direction:column;gap:8px">
          ${choices.map((c, i) => `<button type="button" class="btn btn-${c.tone === 'danger' ? 'danger' : c.tone === 'secondary' ? 'secondary' : 'primary'} btn-block" data-choice="${i}" ${i === 0 ? 'autofocus' : ''}>${esc(c.label)}</button>`).join('')}
          <button type="button" class="btn btn-ghost btn-block" data-close>${esc(cancel)}</button>
        </div>
      </div>`,
      onMount: (el, close) => {
        el.style.width = 'min(380px, calc(100vw - 32px))';
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-choice]');
          if (!b) return;
          result = choices[+b.dataset.choice].value;
          close();
        });
      },
      onClose: () => resolve(result),
    });
  });
}

// ---------------------------------------------------------------- app switcher (Proton)

export function switcherButton() {
  return `<button type="button" class="icon-btn" data-app-switcher aria-label="Switch app" title="Apps">${icon('apps', { size: 20 })}</button>`;
}

export function openSwitcher(anchor, current) {
  const tiles = APPS.map(
    (a) => `<a class="switcher-app" href="${a.url}" ${a.id === current ? 'aria-current="page"' : ''}>
      <span class="app-icon">${appIcon(a.id)}</span>${esc(a.name)}</a>`,
  ).join('');
  return openPopover(
    anchor,
    `<div class="switcher-head"><strong>ecosys</strong><span class="faint" style="font-size:12px">${APPS.length} apps</span></div>
     <div class="switcher-grid">${tiles}</div>
     <div class="switcher-foot">${icon('shield', { size: 16 })}<span>Everything syncs live between apps — and stays on this device.</span></div>`,
    { className: 'switcher' },
  );
}

export function sidebarHead(appId) {
  const app = APPS.find((a) => a.id === appId);
  return `<div class="side-head">
    <a class="brand" href="${app.url}" aria-label="${esc(app.name)}"><span class="app-icon">${appIcon(appId)}</span><span class="truncate">${esc(app.name.toLowerCase())}</span></a>
    <span class="grow"></span>
    ${switcherButton()}
  </div>`;
}

export function sidebarFoot() {
  return `<div class="side-foot">
    <button type="button" class="icon-btn" data-open-settings aria-label="Settings" title="Settings">${icon('gear')}</button>
    <button type="button" class="icon-btn" data-cycle-theme aria-label="Change appearance" title="Appearance">${icon('contrast')}</button>
    <button type="button" class="icon-btn" data-open-shortcuts aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon('keyboard')}</button>
    <span class="grow"></span>
    <button type="button" class="btn btn-ghost btn-sm" data-open-palette title="Command menu">${icon('search', { size: 15 })}<kbd>${MOD === '⌘' ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd></button>
  </div>`;
}

// ---------------------------------------------------------------- command palette

let paletteProviders = [];
/** provider(query) → [{group, label, sub?, icon?, iconHtml?, hint?, run}] */
export function registerPaletteProvider(fn, { prepend = false } = {}) {
  if (prepend) paletteProviders.unshift(fn);
  else paletteProviders.push(fn);
}

export function score(text, q) {
  if (!q) return 1;
  const t = text.toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const term of terms) {
    const i = t.indexOf(term);
    if (i < 0) return 0;
    s += i === 0 ? 3 : t[i - 1] === ' ' ? 2 : 1;
  }
  return s;
}

export function openPalette(initial = '') {
  if ($('.palette')) return;
  let results = [];
  let hl = 0;
  const { el, close } = openModal({
    className: 'palette',
    label: 'Command menu',
    body: `<div class="palette-input">${icon('search')}<input type="text" placeholder="Search or type a command…" autocomplete="off" spellcheck="false" value="${esc(initial)}" autofocus><kbd>esc</kbd></div>
      <div class="palette-list" role="listbox"></div>
      <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>`,
  });
  const input = $('input', el);
  const list = $('.palette-list', el);
  const render = () => {
    const q = input.value.trim();
    results = paletteProviders.flatMap((p) => p(q) || []);
    if (!results.length) {
      list.innerHTML = `<div class="empty" style="padding:32px"><p>No results for “${esc(q)}”</p></div>`;
      return;
    }
    hl = Math.min(hl, results.length - 1);
    let lastGroup = null;
    list.innerHTML = results
      .map((r, i) => {
        const head = r.group !== lastGroup ? `<div class="menu-label">${esc(r.group)}</div>` : '';
        lastGroup = r.group;
        return `${head}<button type="button" class="menu-item${i === hl ? ' hl' : ''}" data-r="${i}" role="option">
          ${r.iconHtml || icon(r.icon || 'arrow-right', { size: 18 })}
          <span class="grow truncate">${esc(r.label)}${r.sub ? ` <span class="faint" style="font-size:12px">· ${esc(r.sub)}</span>` : ''}</span>
          ${r.hint ? `<span class="hint">${r.hint}</span>` : ''}
        </button>`;
      })
      .join('');
    list.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => {
    const r = results[i];
    if (!r) return;
    close();
    r.run();
  };
  input.addEventListener('input', () => {
    hl = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      hl = Math.min(results.length - 1, hl + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      hl = Math.max(0, hl - 1);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(hl);
    }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (b) run(+b.dataset.r);
  });
  list.addEventListener('mousemove', (e) => {
    const b = e.target.closest('[data-r]');
    if (b && +b.dataset.r !== hl) {
      hl = +b.dataset.r;
      $$('.menu-item', list).forEach((x) => x.classList.toggle('hl', x === b));
    }
  });
  render();
}

// Built-in palette entries: apps, appearance, settings.
registerPaletteProvider((q) => {
  const items = [];
  for (const a of APPS) {
    const label = `Open ${a.name}`;
    if (score(label + ' ' + a.blurb + ' switch app', q))
      items.push({ group: 'Apps', label, sub: a.blurb, iconHtml: `<span class="app-icon sm">${appIcon(a.id)}</span>`, run: () => (location.href = a.url) });
  }
  const cmds = [
    { label: 'Settings', icon: 'gear', hint: '<kbd>,</kbd>', run: () => openSettings() },
    { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '<kbd>?</kbd>', run: () => openShortcuts() },
    ...THEMES.map((t) => ({ label: `Appearance: ${t.name}`, icon: 'contrast', run: () => settings.set({ theme: t.id }) })),
    ...ACCENTS.map((a) => ({ label: `Accent colour: ${a.name}`, iconHtml: `<span class="dot" style="color:${a.color};width:12px;height:12px;margin:0 3px"></span>`, run: () => settings.set({ accent: a.id }) })),
    { label: 'Export backup', icon: 'download', run: () => downloadBackup() },
  ];
  for (const c of cmds) if (q && score(c.label, q)) items.push({ group: 'Commands', ...c });
  if (!q) items.push({ group: 'Commands', ...cmds[0] }, { group: 'Commands', ...cmds[1] });
  return items;
});

// ---------------------------------------------------------------- keyboard shortcuts sheet

let shortcutGroups = [];
export function registerShortcuts(groups) {
  shortcutGroups = groups;
}
const keyHtml = (k) =>
  k
    .split(' ')
    .map((p) => `<kbd>${esc(p === 'mod' ? MOD : p)}</kbd>`)
    .join('');
export function openShortcuts() {
  const global = {
    title: 'Everywhere',
    items: [
      ['Command menu', `mod K`],
      ['Undo', `mod Z`],
      ['Keyboard shortcuts', '?'],
      ['Settings', ','],
      ['Close / cancel', 'esc'],
    ],
  };
  const body = [...shortcutGroups, global]
    .map((g) => `<h4>${esc(g.title)}</h4>` + g.items.map(([label, keys]) => `<div class="shortcut"><span>${esc(label)}</span><span class="keys">${keys.split(' / ').map(keyHtml).join('<span class="faint">or</span>')}</span></div>`).join(''))
    .join('');
  openModal({ title: 'Keyboard shortcuts', className: 'wide', body: `<div class="modal-body"><div class="shortcuts">${body}</div></div>` });
}

// ---------------------------------------------------------------- settings

export function downloadBackup() {
  const blob = new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ecosys-backup-${todayYmd()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup downloaded', { tone: 'neutral' });
}

export function openSettings() {
  if ($('.modal.settings')) return;
  const preview = {
    system: 'linear-gradient(135deg,#fff 50%,#000 50%)',
    light: '#fff',
    dim: '#15172a',
    dark: '#000',
  };
  const bar = { system: '#d0d2dc', light: '#e3e4ec', dim: '#2b2f4a', dark: '#24242c' };
  const render = () => {
    const s = settings.get();
    const seg = (key, opts) =>
      `<div class="segmented">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${String(s[key]) === String(v)}">${l}</button>`).join('')}</div>`;
    const sw = (key) => `<label class="switch"><input type="checkbox" data-toggle="${key}" ${s[key] ? 'checked' : ''}><span></span></label>`;
    const counts = { tasks: db.all('tasks').length, events: db.all('events').length };
    return `<div class="settings-body">
      <div class="group-title">Appearance</div>
      <div class="group">
        <div class="theme-cards" role="radiogroup" aria-label="Theme">
          ${THEMES.map(
            (t) => `<button type="button" class="theme-card" role="radio" data-set="theme" data-val="${t.id}" aria-checked="${s.theme === t.id}">
              <span class="preview" style="background:${preview[t.id]}"><i style="top:18%;background:${bar[t.id]}"></i><i style="top:36%;right:40%;background:${bar[t.id]}"></i><i style="top:62%;left:14%;right:52%;height:12%;background:var(--accent)"></i></span>${t.name}</button>`,
          ).join('')}
        </div>
        <div class="item"><span class="grow">Accent colour</span>
          <div class="swatches" role="radiogroup" aria-label="Accent colour">
            ${ACCENTS.map((a) => `<button type="button" class="swatch-btn" role="radio" style="--sw:${a.color}" data-set="accent" data-val="${a.id}" aria-checked="${s.accent === a.id}" aria-label="${a.name}" title="${a.name}">${icon('check')}</button>`).join('')}
          </div>
        </div>
        <div class="item"><span class="grow">Reduce motion</span>${sw('reduceMotion')}</div>
      </div>

      <div class="group-title">Date &amp; time</div>
      <div class="group">
        <div class="item"><span class="grow">Week starts on</span>${seg('weekStart', [[0, 'Sun'], [1, 'Mon'], [6, 'Sat']])}</div>
        <div class="item"><span class="grow">Time format</span>${seg('timeFormat', [['auto', 'Auto'], ['12h', '12h'], ['24h', '24h']])}</div>
        <div class="item"><span class="grow">Default event length</span>
          <select class="input" style="width:auto;height:32px" data-select="defaultEventMinutes">${[15, 30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${s.defaultEventMinutes === m ? 'selected' : ''}>${m < 60 ? m + ' min' : m / 60 + ' hr'}</option>`).join('')}</select></div>
        <div class="item"><span class="grow">Default task block</span>
          <select class="input" style="width:auto;height:32px" data-select="defaultTaskMinutes">${[15, 30, 45, 60, 90].map((m) => `<option value="${m}" ${s.defaultTaskMinutes === m ? 'selected' : ''}>${m < 60 ? m + ' min' : m / 60 + ' hr'}</option>`).join('')}</select></div>
      </div>

      <div class="group-title">Working together</div>
      <div class="group">
        <div class="item"><span class="grow">Show schedule events in Today &amp; Upcoming</span>${sw('showEventsInToday')}</div>
        <div class="item"><span class="grow">Show tasks on the calendar</span>${sw('showTasksInSchedule')}</div>
      </div>
      <div class="group-foot">Tasks with a date appear on the calendar; drag one onto a time to block it out. Checking it off anywhere completes it everywhere.</div>

      <div class="group-title">Your data</div>
      <div class="group">
        <button type="button" class="item icon-row" data-action="export"><span class="tile-icon" style="background:var(--c-blue)">${icon('download')}</span><span class="grow">Export backup</span><span class="value">${counts.tasks} tasks · ${counts.events} events</span></button>
        <label class="item icon-row"><span class="tile-icon" style="background:var(--c-green)">${icon('upload')}</span><span class="grow">Import backup…</span><input type="file" accept="application/json,.json" data-action="import" hidden></label>
        <button type="button" class="item icon-row" data-action="samples"><span class="tile-icon" style="background:var(--c-orange)">${icon('sparkle')}</span><span class="grow">Start over with sample data</span></button>
        <button type="button" class="item icon-row" data-action="erase"><span class="tile-icon" style="background:var(--c-red)">${icon('trash')}</span><span class="grow danger-text">Erase everything</span></button>
      </div>
      <div class="privacy-note">${icon('shield')}<div><strong style="color:var(--text)">Private by design.</strong> Everything lives in this browser on this device — no account, no tracking, no servers. Export a backup to move it elsewhere.</div></div>
    </div>`;
  };
  const { el, close } = openModal({
    title: 'Settings',
    className: 'settings grouped',
    body: `<div class="modal-body" style="padding:0">${render()}</div>`,
  });
  const bodyEl = $('.modal-body', el);
  const rerender = () => {
    const top = bodyEl.scrollTop;
    bodyEl.innerHTML = render();
    bodyEl.scrollTop = top;
  };
  const off = db.on(({ names }) => {
    if (names.has('settings') && document.contains(el)) rerender();
  });
  const obs = new MutationObserver(() => {
    if (!document.contains(el)) {
      off();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
  el.addEventListener('click', async (e) => {
    const set = e.target.closest('[data-set]');
    if (set) {
      const key = set.dataset.set;
      let val = set.dataset.val;
      if (key === 'weekStart') val = +val;
      settings.set({ [key]: val });
      return;
    }
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (act === 'export') downloadBackup();
    if (act === 'samples') {
      if (await confirmDialog({ title: 'Start over with sample data?', message: 'This replaces all your tasks, lists, events and calendars with the sample set.', confirm: 'Replace everything', danger: true })) {
        resetData({ withSamples: true });
        close();
        toast('Sample data loaded', { tone: 'neutral' });
      }
    }
    if (act === 'erase') {
      if (await confirmDialog({ title: 'Erase everything?', message: 'All tasks, lists, events and calendars will be deleted from this device. Consider exporting a backup first.', confirm: 'Erase everything', danger: true })) {
        resetData();
        close();
        toast('All data erased', { tone: 'neutral' });
      }
    }
  });
  el.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.toggle) settings.set({ [t.dataset.toggle]: t.checked });
    if (t.dataset.select) settings.set({ [t.dataset.select]: +t.value });
    if (t.dataset.action === 'import' && t.files?.[0]) {
      try {
        const data = JSON.parse(await t.files[0].text());
        if (!(await confirmDialog({ title: 'Import this backup?', message: `It contains ${data.tasks?.length ?? 0} tasks and ${data.events?.length ?? 0} events, and will replace what's here now.`, confirm: 'Import', danger: true }))) return;
        importData(data);
        toast('Backup imported', { tone: 'neutral' });
        close();
      } catch (err) {
        toast(err.message || 'Could not read that file', { tone: 'neutral' });
      }
    }
  });
}

// ---------------------------------------------------------------- "When" date picker (Things-style)

/**
 * opts: { value:'YYYY-MM-DD'|null, title, evening, someday, allowEvening, allowSomeday, allowClear, weekStart, onPick({date, evening, someday}) }
 */
export function openDatePicker(anchor, opts) {
  const s = settings.get();
  let month = opts.value ? parseYmd(opts.value) : new Date();
  const today = todayYmd();
  const wd = new Date().getDay();
  const weekendDelta = wd === 6 ? 0 : wd === 0 ? 0 : 6 - wd;
  const nextWeekDelta = ((1 - wd + 7) % 7) || 7;
  const quick = [
    { k: 'today', label: 'Today', icon: 'star', color: 'var(--c-yellow)', date: today },
    opts.allowEvening && { k: 'evening', label: 'This Evening', icon: 'moon', color: 'var(--c-blue)', date: today, evening: true },
    { k: 'tomorrow', label: 'Tomorrow', icon: 'sun', color: 'var(--c-orange)', date: addDaysYmd(today, 1) },
    { k: 'weekend', label: 'This Weekend', icon: 'calendar', color: 'var(--c-teal)', date: addDaysYmd(today, weekendDelta) },
    { k: 'nextweek', label: 'Next Week', icon: 'arrow-right', color: 'var(--c-purple)', date: addDaysYmd(today, nextWeekDelta) },
    opts.allowSomeday && { k: 'someday', label: 'Someday', icon: 'archive', color: 'var(--c-graphite)', someday: true },
  ].filter(Boolean);
  const content = () => `<div class="datepicker">
      ${opts.title ? `<div class="menu-label">${esc(opts.title)}</div>` : ''}
      <div class="dp-type"><input type="text" class="input" placeholder="Type a date… “fri”, “in 3 days”, “dec 5”" data-dp-type autocomplete="off"></div>
      <div class="dp-quick">
        ${quick.map((q) => `<button type="button" class="menu-item" data-dp="${q.k}" style="--ic:${q.color}">${icon(q.icon, { size: 18 }).replace('class="i ', `class="i " style="color:${q.color}" `)}<span class="grow">${q.label}</span><span class="hint">${q.date ? esc(dayShort(q.date)) : ''}</span></button>`).join('')}
      </div>
      <div class="menu-sep"></div>
      <div data-dp-cal>${miniCalendar({ month, selected: opts.value, weekStart: s.weekStart })}</div>
      ${opts.allowClear !== false && (opts.value || opts.someday) ? `<div class="menu-sep"></div><button type="button" class="menu-item" data-dp="clear">${icon('x', { size: 18 })}<span class="grow">Clear</span></button>` : ''}
    </div>`;
  const pop = openPopover(anchor, content(), {
    className: 'dp-pop',
    onMount: (el, close) => {
      const pick = (v) => {
        close();
        opts.onPick(v);
      };
      el.addEventListener('click', (e) => {
        const q = e.target.closest('[data-dp]');
        if (q) {
          const k = q.dataset.dp;
          if (k === 'clear') return pick({ date: null, evening: false, someday: false });
          const item = quick.find((x) => x.k === k);
          return pick({ date: item.date || null, evening: !!item.evening, someday: !!item.someday });
        }
        const d = e.target.closest('[data-date]');
        if (d) return pick({ date: d.dataset.date, evening: false, someday: false });
        const nav = e.target.closest('[data-mc]');
        if (nav) {
          const k = nav.dataset.mc;
          month = k === 'today' ? new Date() : new Date(month.getFullYear(), month.getMonth() + (k === 'next' ? 1 : -1), 1);
          $('[data-dp-cal]', el).innerHTML = miniCalendar({ month, selected: opts.value, weekStart: s.weekStart });
        }
      });
      const typeInput = $('[data-dp-type]', el);
      typeInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const r = parse(typeInput.value, { mode: 'task' });
        if (r.someday) return pick({ date: null, evening: false, someday: true });
        if (r.date || r.deadline) return pick({ date: r.date || r.deadline, evening: r.evening, someday: false });
        typeInput.select();
      });
      typeInput.addEventListener('input', () => {
        const r = parse(typeInput.value, { mode: 'task' });
        const d = r.date || r.deadline;
        if (d) {
          month = parseYmd(d);
          $('[data-dp-cal]', el).innerHTML = miniCalendar({ month, selected: d, weekStart: s.weekStart });
        }
      });
    },
  });
  return pop;
}

function dayShort(s) {
  const n = Math.round((parseYmd(s) - parseYmd(todayYmd())) / 86400000);
  if (n === 0) return '';
  return fmt(parseYmd(s), n < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- init

let shellReady = false;
/**
 * Call once per app. opts: { app: 'tasks' | 'schedule' | 'home' }
 */
export function initShell({ app }) {
  if (shellReady) return;
  shellReady = true;
  registerSeeder(seed);
  seedIfEmpty();
  applyTheme();
  setFavicon(app);
  darkMq.addEventListener('change', applyTheme);
  db.on(({ names }) => {
    if (names.has('settings')) applyTheme();
  });
  window.addEventListener('ecosys:save-error', () => toast('Could not save — storage may be full. Export a backup.', { tone: 'neutral', duration: 8000 }));

  document.addEventListener('click', (e) => {
    const t = e.target;
    const sw = t.closest('[data-app-switcher]');
    if (sw) return void openSwitcher(sw, app);
    if (t.closest('[data-open-settings]')) return void openSettings();
    if (t.closest('[data-open-shortcuts]')) return void openShortcuts();
    if (t.closest('[data-open-palette]')) return void openPalette();
    if (t.closest('[data-cycle-theme]')) {
      const order = ['system', 'light', 'dim', 'dark'];
      const cur = settings.get().theme;
      const next = order[(order.indexOf(cur) + 1) % order.length];
      settings.set({ theme: next });
      toast(`Appearance: ${THEMES.find((x) => x.id === next).name}`, { tone: 'neutral', duration: 1600 });
    }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && layers.length) {
      e.preventDefault();
      closeTopLayer();
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('.palette')) closeTopLayer();
      else openPalette();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !isTyping(e)) {
      e.preventDefault();
      undoLast();
      return;
    }
    if (isTyping(e) || mod || e.altKey || layers.length) return;
    if (e.key === '?') {
      e.preventDefault();
      openShortcuts();
    } else if (e.key === ',') {
      e.preventDefault();
      openSettings();
    }
  });
}

export { icon, db, settings, todayYmd, addDaysYmd, parseYmd, ymd, addDays, fmt, dayLabel };
