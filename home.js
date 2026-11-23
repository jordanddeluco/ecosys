// ecosys Home: the app launcher. Large app icons with their names beneath, centred under the date and a
// greeting, as on the classic iCloud.com home page and Proton's app chooser. Each icon opens its app's own
// start page; the last one, AI, is the plug-in spot for assistants: it opens Connect AI, and the line under
// its name says how the connection stands. No previews and no counts: the apps hold the data.
// The icons are the app logos from shared/shell.js appIcon(), the same art as the switcher, the sidebars and the
// favicons. index.html loads this module; there is no inline script anywhere (CSP script-src 'self').

import {
  initShell, APPS, appIcon, icon, esc, keys, isMac, tipAttrs, openMenu, registerShortcuts, settings, BASE, THEMES,
  isTyping, hasOpenLayer, singleKeyOff, fmt, ymd,
} from './shared/shell.js';
import * as shell from './shared/shell.js';

initShell({ app: 'home' });

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const prefs = () => settings.get() || {};

/**
 * Quick note: Notes' capture sheet, told where it was opened from so Done or Esc comes back here (the shell's
 * openQuickNote(), as Ctrl+Alt+N does). A shell without it just opens the sheet.
 */
const quickNote = () => (typeof shell.openQuickNote === 'function' ? shell.openQuickNote() : (location.href = `${BASE}notes/#/quick`));

// ---------------------------------------------------------------- the apps

/**
 * What the launcher lists, in order: every app but Home (shell.js APPS), each opening its own start page,
 * then AI, which has no page: it opens Connect AI (shared/ai.js through the shell's openAI()).
 */
const LAUNCHER = [...APPS.filter((a) => a.id !== 'home').map((a) => ({ id: a.id, name: a.name, href: a.url })), { id: 'ai', name: 'AI' }];

/**
 * What an icon offers besides opening its app, as on the iOS Home Screen: a long press (touch), a right-click or
 * the context-menu key (Shift+F10) opens a short menu under it. Notes offers the two ways in that Home's jot box
 * used to give: its capture sheet and today's note. On a keyboard N is Quick note too, and the palette has both.
 */
const QUICK_ACTIONS = {
  notes: [
    { label: 'Quick note', icon: 'quick-note', keys: 'n', run: () => quickNote() },
    { label: "Today's note", icon: 'today', run: () => (location.href = `${BASE}notes/#/today`) },
  ],
};

// ---------------------------------------------------------------- page

const root = document.getElementById('home');

/**
 * One launcher cell: the logo, the name, and a caption line (kept even when empty, so nothing shifts). AI's name
 * has room for the lock that marks read-only access, as iOS marks an app's name (renderAI shows it).
 */
function appCell(app, i) {
  const flag = app.id === 'ai' ? `<span class="launch-flag" data-ai-flag hidden>${icon('lock', { size: 12, stroke: 2.2 })}</span>` : '';
  const inner = `<span class="launch-icon app-icon">${appIcon(app.id)}</span><span class="launch-name">${flag}${esc(app.name)}</span><span class="launch-cap"${app.id === 'ai' ? ' data-ai-status' : ''}></span>`;
  const attrs = `class="launch-app" data-app="${esc(app.id)}"${QUICK_ACTIONS[app.id] ? ' data-actions' : ''} style="--i:${i}"`;
  return `<li>${
    app.href
      ? `<a ${attrs} href="${esc(app.href)}">${inner}</a>`
      : `<button type="button" ${attrs} data-open-ai aria-haspopup="dialog" aria-label="AI assistants">${inner}</button>`
  }</li>`;
}

// The page is the app switcher, so the header has no switcher button: brand, Search, Appearance, Settings.
root.innerHTML = `
  <header class="home-bar" data-bar>
    <div class="home-wrap home-bar-in">
      <a class="home-brand" href="${esc(BASE)}" aria-label="ecosys home" aria-current="page"><span class="app-icon">${appIcon('home')}</span><span class="home-word">ecosys</span></a>
      <span class="grow"></span>
      <button type="button" class="home-search" data-open-palette aria-label="Search" aria-keyshortcuts="${isMac ? 'Meta+K' : 'Control+K'}">${icon('search', { size: 17 })}<span class="home-search-text">Search</span>${keys('mod K')}</button>
      <button type="button" class="icon-btn" data-appearance aria-label="Appearance" aria-haspopup="menu" aria-expanded="false" ${tipAttrs('Appearance')}>${icon('contrast')}</button>
      <button type="button" class="icon-btn" data-open-settings aria-label="Settings" ${tipAttrs('Settings', ',')}>${icon('gear')}</button>
    </div>
  </header>
  <main class="home-wrap home-main">
    <div class="home-hero">
      <p class="home-date"><time data-date></time></p>
      <h1 class="home-greeting" data-greeting></h1>
    </div>
    <nav class="launch" aria-label="Apps">
      <ul class="launch-grid" role="list" style="--cols:${Math.min(LAUNCHER.length, 6)}">${LAUNCHER.map(appCell).join('')}</ul>
    </nav>
  </main>`;

const el = {
  bar: $('[data-bar]', root),
  date: $('[data-date]', root),
  greeting: $('[data-greeting]', root),
  grid: $('.launch-grid', root),
  ai: $('.launch-app[data-app="ai"]', root),
  aiCap: $('[data-ai-status]', root),
  aiFlag: $('[data-ai-flag]', root),
};

// ---------------------------------------------------------------- date & greeting

function greeting(h) {
  if (h < 5) return 'Hello, night owl';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderHero() {
  const now = new Date();
  const date = fmt(now, { weekday: 'long', month: 'long', day: 'numeric' });
  if (el.date.textContent !== date) {
    el.date.textContent = date;
    el.date.setAttribute('datetime', ymd(now));
  }
  const hello = greeting(now.getHours());
  if (el.greeting.textContent !== hello) el.greeting.textContent = hello;
}

// ---------------------------------------------------------------- AI: the plug-in spot's caption

// Why the status is unavailable, by shared/ai.js's reason; anything else reads "ecosys isn't answering".
// ecosys answered but turned this browser away ('refused', or 'unpaired'): it isn't paired with the server yet
// (shared/pair.js), and the pairing notice says how to connect it.
const NOT_PAIRED = 'this browser isn’t connected to ecosys on this computer';
const UNAVAILABLE = {
  lan: 'AI connections are managed on the computer that runs ecosys',
  static: 'AI assistants need the ecosys app running on your computer',
  refused: NOT_PAIRED,
  unpaired: NOT_PAIRED,
};

/** An assistant's name (set once shared/ai.js has loaded, from its ASSISTANTS). */
let aiName = (c) => String(c?.label || '').trim() || 'An AI app';
const listJoin = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * The AI caption for `st`, the status from shared/ai.js (undefined until it is known, null if ai.js could not
 * load): {text, tone, said, readOnly}. `text` is what shows under "AI"; `said` completes the button's accessible
 * name, which starts with the visible words, so "click Connect" works with voice control. `readOnly`: AI access is
 * read only (Connect AI › Access), shown by the lock before "AI" and said after the state. Null while the status is
 * still being checked, so the line stays empty: it never guesses.
 */
function aiCaption(st) {
  if (st === undefined || st?.reason === 'unknown') return null;
  if (!st) return { text: 'Unavailable', tone: 'quiet', said: 'Unavailable: AI connections couldn’t load' };
  if (st.online !== true) return { text: 'Unavailable', tone: 'quiet', said: `Unavailable: ${UNAVAILABLE[st.reason] || 'ecosys isn’t answering on this computer'}` };
  if (st.mode === 'off') return { text: 'Off', tone: 'quiet', said: 'Off: AI access is turned off' };
  const readOnly = st.mode === 'read';
  const ro = readOnly ? ', read only' : '';
  const names = (cs) => [...new Set(cs.map((c) => aiName(c)))];
  if (st.connected.length) {
    const ns = names(st.connected);
    // A phone's cell is about 80px wide, so two or more read as the shortest name and a count ("Grok +1").
    const text = ns.length > 1 ? `${[...ns].sort((a, b) => a.length - b.length)[0]} +${ns.length - 1}` : ns[0];
    return { text, tone: 'on', said: `${listJoin(ns)} ${ns.length > 1 ? 'are' : 'is'} connected${ro}`, readOnly };
  }
  if (st.clients.length) return { text: 'Ready', tone: 'quiet', said: `Ready for ${listJoin(names(st.clients))}${ro}`, readOnly };
  return { text: 'Connect', tone: 'connect', said: `Connect Claude, ChatGPT or Grok${ro}`, readOnly };
}

let aiShown = null;
function renderAI(st) {
  const cap = aiCaption(st);
  // A green dot when an assistant is connected; the plug before "Connect" marks the plug-in spot.
  const lead = cap?.tone === 'on' ? '<span class="launch-dot"></span>' : cap?.tone === 'connect' ? icon('plug', { size: 13, stroke: 2.2 }) : '';
  const html = cap ? `${lead}<span class="launch-cap-text">${esc(cap.text)}</span>` : '';
  const label = cap ? `AI assistants, ${cap.said}` : 'AI assistants';
  const key = `${html}\n${label}\n${!!cap?.readOnly}`;
  if (aiShown === key) return;
  aiShown = key;
  el.aiCap.innerHTML = html;
  el.aiCap.dataset.tone = cap?.tone || '';
  el.aiFlag.hidden = !cap?.readOnly;
  el.ai.setAttribute('aria-label', label);
}

/** The status comes from shared/ai.js, loaded after the first paint. Without it the shell's openAI() explains. */
function watchAI() {
  import('./shared/ai.js')
    .then((m) => {
      if (typeof m.onAIStatus !== 'function') throw new Error('shared/ai.js has no onAIStatus()');
      const known = m.ASSISTANTS || {};
      aiName = (c) => (c?.kind !== 'other' && known[c?.kind]?.name) || String(c?.label || '').trim() || 'An AI app';
      m.onAIStatus(renderAI);
    })
    .catch((err) => {
      console.warn('ecosys home: the AI status could not load', err);
      renderAI(null);
    });
}

// ---------------------------------------------------------------- keyboard

// Arrow keys move between the apps, as in the app switcher. Left and Right go along the row (and wrap); Up and
// Down go by row once the apps wrap onto more than one (four across on a phone, six on a desktop), and along the
// row while they all fit on one. Home and End jump to the first and last.
el.grid.addEventListener('keydown', (e) => {
  const cur = e.target.closest('.launch-app');
  if (!cur || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const apps = $$('.launch-app', el.grid);
  const n = apps.length;
  const i = apps.indexOf(cur);
  const cols = apps.filter((a) => a.offsetTop === apps[0].offsetTop).length || n; // as laid out right now
  const byRow = n > cols;
  const to = {
    ArrowRight: (i + 1) % n,
    ArrowLeft: (i - 1 + n) % n,
    ArrowDown: byRow ? (i + cols < n ? i + cols : i) : (i + 1) % n,
    ArrowUp: byRow ? (i - cols >= 0 ? i - cols : i) : (i - 1 + n) % n,
    Home: 0,
    End: n - 1,
  }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  apps[to].focus();
});

// ---------------------------------------------------------------- quick actions (QUICK_ACTIONS)

let actions = null; // the open quick-actions menu: { cell, close }

/** Open `cell`'s quick actions under it (the shared menu); while they are open, asking again changes nothing. */
function openActions(cell) {
  const list = QUICK_ACTIONS[cell?.dataset.app];
  if (!list || actions?.cell === cell) return;
  actions?.close();
  cell.classList.add('actions-open');
  const menu = openMenu(
    cell,
    list.map((a) => ({ label: a.label, icon: a.icon, keys: a.keys, onSelect: a.run })),
    {
      label: `${$('.launch-name', cell).textContent} quick actions`,
      align: 'center',
      className: 'launch-actions',
      onClose: () => {
        cell.classList.remove('actions-open');
        if (actions?.cell === cell) actions = null;
      },
    },
  );
  actions = { cell, close: menu.close };
}

// A long press opens them on touch, as on iOS (a mouse has its right button). They open while the finger is still
// down, so the click that ends that press is not a tap on the icon: it doesn't open the app.
const LONG_PRESS = 500; // ms, as iOS and Android time theirs
let press = null; // the touch that may become a long press: { id, x, y, timer, fired }
let eatClickUntil = 0;
const endPress = () => {
  clearTimeout(press?.timer);
  press = null;
};
el.grid.addEventListener('pointerdown', (e) => {
  endPress();
  const cell = e.target.closest('.launch-app[data-actions]');
  if (!cell || e.pointerType === 'mouse' || !e.isPrimary) return;
  const p = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false };
  p.timer = setTimeout(() => {
    p.fired = true;
    openActions(cell);
  }, LONG_PRESS);
  press = p;
});
el.grid.addEventListener(
  'pointermove',
  (e) => {
    // Moving more than a few pixels first is a scroll or a drag, not a long press.
    if (press && !press.fired && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) endPress();
  },
  { passive: true },
);
const liftPress = (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (press.fired) eatClickUntil = performance.now() + 700;
  endPress();
};
el.grid.addEventListener('pointerup', liftPress);
el.grid.addEventListener('pointercancel', liftPress);
el.grid.addEventListener(
  'click',
  (e) => {
    if (performance.now() > eatClickUntil) return;
    eatClickUntil = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);
// A right-click, the context-menu key or Shift+F10 (on the focused icon), and Android's own long press.
el.grid.addEventListener('contextmenu', (e) => {
  const cell = e.target.closest('.launch-app[data-actions]');
  if (!cell) return;
  e.preventDefault();
  if (press) {
    clearTimeout(press.timer);
    press.fired = true;
  }
  openActions(cell);
});

registerShortcuts([
  {
    title: 'Home',
    items: [
      ['Quick note', 'n'],
      ['Move between apps', 'left / right'],
      // The context-menu key does the same; a Mac has neither (Control-click there).
      ...(isMac ? [] : [['Notes quick actions', 'shift F10']]),
    ],
  },
]);

// N: a quick note (Notes' capture sheet), like the shared Quick note command. A single-key shortcut: off with the
// rest of them in Settings › Keyboard (WCAG 2.1.4), as in Tasks and Schedule.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || hasOpenLayer() || singleKeyOff(e)) return;
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    quickNote();
  }
});

// ---------------------------------------------------------------- header: appearance menu, scroll edge

const THEME_SWATCH = { system: 'linear-gradient(135deg,#ffffff 50%,#0b0a12 50%)', light: '#ffffff', dim: '#1b1e34', dark: '#000000' };
$('[data-appearance]', root).addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const cur = THEMES.some((t) => t.id === prefs().theme) ? prefs().theme : 'system';
  btn.setAttribute('aria-expanded', 'true');
  openMenu(
    btn,
    THEMES.map((t) => ({
      label: t.name,
      iconHtml: `<span class="theme-dot" style="background:${THEME_SWATCH[t.id] || THEME_SWATCH.system}" aria-hidden="true"></span>`,
      checked: t.id === cur,
      onSelect: () => settings.set({ theme: t.id }),
    })),
    { label: 'Appearance', align: 'end', className: 'appearance-menu', onClose: () => btn.setAttribute('aria-expanded', 'false') },
  );
});

const onScroll = () => el.bar.classList.toggle('scrolled', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ---------------------------------------------------------------- render & time

renderHero();
renderAI(undefined);
document.title = 'ecosys';
setTimeout(watchAI, 0);

// Time moves on: the greeting and the date. (The logos show no date, so nothing else changes at midnight.)
// Coming back to the tab, or Back from an app (the page may come back from the browser's cache), shows them anew.
setInterval(renderHero, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderHero();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) renderHero();
});
// Leaving the page: a press in progress ends there, and quick actions are not open when Back brings Home back.
window.addEventListener('pagehide', () => {
  endPress();
  actions?.close();
});
