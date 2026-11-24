// ecosys shell: theme, app switcher, toasts, menus, modals, tooltips, custom fields, command palette,
// shortcuts, settings, date, time & repeat pickers, and the hooks that start sync and AI.
import * as store from './store.js';
import { db, settings } from './store.js';
import { icon } from './icons.js';
import { seed } from './seed.js';
import {
  setHour12, hour12, todayYmd, addDaysYmd, addMonths, parseYmd, ymd, addDays, fmt, fmtTime, fmtDuration, WEEKDAY_NARROW,
  WEEKDAY_LONG, dayLabel, diffDays, pad, toMinutes, fromMinutes,
} from './dates.js';
import { occurrencesBetween, describe as describeRule } from './recur.js';
import { miniCalendar, monthTitle } from './minical.js';
import { parse } from './nlp.js';
import { htmlToText, COLLECTIONS } from './sanitize.js';
import { trackChanges } from './model.js';

// ---------------------------------------------------------------- tiny DOM helpers

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
/** Plain-text name of the platform modifier, for aria-labels and prose. Visual keycaps use keys('mod K'). */
export const MOD = isMac ? 'Cmd' : 'Ctrl';
export const isTyping = (e) => {
  const t = e.target;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};
/** Are single-key shortcuts on (Settings > Keyboard)? They are unless turned off. */
export const singleKeys = () => settings.get()?.shellSingleKeys !== false;
/**
 * True for a single-key shortcut (a character typed without Ctrl, Cmd or Alt: E, T, ?, 1) while those are
 * turned off, so a shortcut handler ignores it (WCAG 2.1.4). Shortcuts with Ctrl or Cmd, arrows, Enter,
 * Delete and Escape keep working.
 */
export const singleKeyOff = (e) => !singleKeys() && [...String(e?.key ?? '')].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
export function html(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (i < vals.length ? vals[i] ?? '' : ''), '');
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isId = (s) => typeof s === 'string' && /^[a-z0-9_-]{1,40}$/i.test(s);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fire = (el) => {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const coarse = () => matchMedia('(hover: none), (pointer: coarse)').matches;
/** The phone layout (ui.css's 640px breakpoint), where modals and pickers are bottom sheets. */
const phoneLayout = () => matchMedia('(max-width: 640px)').matches;
const all = (name) => {
  try {
    const a = db.all(name);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/** Named colours shared by lists and calendars → CSS custom property. Anything else is rejected. */
const COLOR_NAMES = ['iris', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'graphite'];
export function cssColor(c) {
  const s = String(c ?? '').trim();
  if (COLOR_NAMES.includes(s)) return `var(--c-${s})`;
  if (/^var\(--[a-z0-9-]{1,40}\)$/i.test(s) || /^#[0-9a-f]{3,8}$/i.test(s)) return s;
  return '';
}

// ---------------------------------------------------------------- keycaps

const KEY_ALIASES = { '↵': 'enter', '⏎': 'enter', '⌫': 'backspace', '⌦': 'delete', '↑': 'up', '↓': 'down', '←': 'left', '→': 'right', '⌘': 'mod', '⌥': 'alt', '⇧': 'shift', '⎋': 'esc' };
const KEY_DEFS = {
  mod: () => (isMac ? ['key-command', 'Command'] : 'Ctrl'),
  cmd: () => (isMac ? ['key-command', 'Command'] : 'Ctrl'),
  command: () => (isMac ? ['key-command', 'Command'] : 'Ctrl'),
  meta: () => (isMac ? ['key-command', 'Command'] : 'Win'),
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: () => (isMac ? ['key-option', 'Option'] : 'Alt'),
  opt: () => (isMac ? ['key-option', 'Option'] : 'Alt'),
  option: () => (isMac ? ['key-option', 'Option'] : 'Alt'),
  shift: ['key-shift', 'Shift'],
  enter: ['key-return', 'Enter'],
  return: ['key-return', 'Return'],
  backspace: ['key-delete-left', 'Backspace'],
  delete: () => (isMac ? ['key-delete-left', 'Delete'] : 'Del'),
  del: () => (isMac ? ['key-delete-left', 'Delete'] : 'Del'),
  esc: 'Esc',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  // A keycap of its own: a lone punctuation mark (',', '?') is drawn as a cap, also in menu hints (.kbd-punct).
  comma: ',',
  up: ['arrow-up', 'Up arrow'],
  down: ['arrow-down', 'Down arrow'],
  left: ['arrow-left', 'Left arrow'],
  right: ['arrow-right', 'Right arrow'],
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};
// Own-property lookups only: words like 'constructor' or '__proto__' are text, not keys.
const keyDef = (tok) => {
  const t = String(tok ?? '');
  const name = (Object.hasOwn(KEY_ALIASES, t) ? KEY_ALIASES[t] : t).toLowerCase();
  if (!Object.hasOwn(KEY_DEFS, name)) return null;
  const d = KEY_DEFS[name];
  return typeof d === 'function' ? d() : d;
};
/** True when a token is something keys() renders as a key (single characters always are). */
export const isKeyToken = (tok) => [...String(tok)].length === 1 || keyDef(String(tok)) !== null;

function keycap(tok) {
  const def = keyDef(tok);
  if (Array.isArray(def)) return `<kbd class="kbd kbd-glyph">${icon(def[0], { size: 12, stroke: 2.2 })}<span class="sr-only">${def[1]}</span></kbd>`;
  const text = def || ([...tok].length === 1 ? tok.toUpperCase() : tok);
  // A single punctuation mark would be a speck where keycaps are plain text (menu hints): ui.css gives it a cap.
  const punct = [...text].length === 1 && /[^\p{L}\p{N}]/u.test(text);
  return `<kbd class="kbd${punct ? ' kbd-punct' : ''}">${esc(text)}</kbd>`;
}

/**
 * Keycaps from a key spec: 'mod K', 'alt up', 'enter', 'shift ?', and alternatives with ' / ' ('j / down').
 * Special keys render SVG glyphs (never the Unicode symbols); `mod` is the command glyph on Mac and "Ctrl" elsewhere.
 */
const MODIFIERS = new Set(['mod', 'cmd', 'command', 'meta', 'ctrl', 'control', 'alt', 'opt', 'option', 'shift', '⌘', '⌥', '⇧']);
export function keys(spec) {
  // Outside macOS a modifier combo reads "Ctrl+K" where keycaps are drawn as plain text (menu hints).
  const plus = isMac ? '' : '<span class="kbd-plus" aria-hidden="true">+</span>';
  const alts = String(spec ?? '')
    .trim()
    .split(/\s+\/\s+/)
    .map((a) =>
      a
        .split(/\s+/)
        .filter(Boolean)
        .map((tok, i, arr) => keycap(tok) + (i < arr.length - 1 && MODIFIERS.has(tok.toLowerCase()) ? plus : ''))
        .join(''),
    )
    .filter(Boolean);
  if (!alts.length) return '';
  return `<span class="keys">${alts.join('<span class="keys-or"><span aria-hidden="true">/</span><span class="sr-only"> or </span></span>')}</span>`;
}

// Key names in aria-keyshortcuts (UI Events key values; modifiers first, joined with '+').
const ARIA_KEY = {
  mod: () => (isMac ? 'Meta' : 'Control'), cmd: 'Meta', command: 'Meta', meta: 'Meta', ctrl: 'Control', control: 'Control',
  alt: 'Alt', opt: 'Alt', option: 'Alt', shift: 'Shift', enter: 'Enter', return: 'Enter', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', comma: ',',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
};
/** A key spec as an aria-keyshortcuts value: 'mod K' → 'Control+K' ('Meta+K' on a Mac), 'j / down' → 'J ArrowDown'. */
export function ariaKeys(spec) {
  return String(spec ?? '')
    .trim()
    .split(/\s+\/\s+/)
    .map((alt) =>
      alt
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => {
          const t = Object.hasOwn(KEY_ALIASES, tok) ? KEY_ALIASES[tok] : tok;
          const k = t.toLowerCase();
          if (Object.hasOwn(ARIA_KEY, k)) return typeof ARIA_KEY[k] === 'function' ? ARIA_KEY[k]() : ARIA_KEY[k];
          return [...t].length === 1 ? t.toUpperCase() : '';
        }),
    )
    .filter((parts) => parts.length && parts.every(Boolean))
    .map((parts) => parts.join('+'))
    .join(' ');
}

// One-key shortcuts: a character with or without Shift ('e', 'shift ?', 'comma', 'space'), not a key such
// as Enter, Esc or an arrow (those keep working when single-key shortcuts are off; see singleKeyOff).
const CHARACTER_KEYS = new Set(['comma', 'space']);
const isOneKey = (alt) => {
  const toks = alt.split(/\s+/).filter((t) => t && t !== '⇧' && t.toLowerCase() !== 'shift');
  if (toks.length !== 1) return false;
  return [...toks[0]].length === 1 ? !Object.hasOwn(KEY_ALIASES, toks[0]) : CHARACTER_KEYS.has(toks[0].toLowerCase());
};
/**
 * The alternatives of a key spec that work right now: with single-key shortcuts off (Settings > Keyboard),
 * the one-key ones are left out ('e' → '', 'j / down' → 'down'), so menus, tooltips and the palette never
 * show a shortcut that does nothing.
 */
export function liveKeys(spec) {
  const s = String(spec ?? '').trim();
  if (!s || singleKeys()) return s;
  return s.split(/\s+\/\s+/).filter((alt) => !isOneKey(alt)).join(' / ');
}
// A hint drawn only from one-character keycaps (Tasks' "1 to 4") advertises single-key shortcuts too.
const oneKeyHint = (h) => /<kbd class="kbd(?: kbd-punct)?">[^<]<\/kbd>/.test(h) && !/<kbd class="kbd">[^<]{2,}<\/kbd>|kbd-glyph/.test(h);

/** Trusted glyph markup with aria-hidden on its outer element: a glyph's text (a date's number) is decoration. */
const hideMark = (h) => String(h ?? '').replace(/^(\s*<[a-z][\w-]*)(?![^>]*\saria-hidden=)/i, '$1 aria-hidden="true"');

// ---------------------------------------------------------------- time formatting (one compact style everywhere)

const asHHMM = (t) => (t instanceof Date ? `${pad(t.getHours())}:${pad(t.getMinutes())}` : HHMM.test(t ?? '') ? t : '');
/** Compact clock time: '9am', '9:30pm' (12h) or '09:30' (24h). Accepts 'HH:MM' or a Date. */
export const fmtClock = (t) => {
  const v = asHHMM(t);
  return v ? fmtTime(v, { compact: true }) : '';
};
/** '9 – 10:30am', '11am – 1pm', '09:00 – 10:30'. Accepts 'HH:MM' strings or Dates. */
export function fmtTimeRange(a, b) {
  const A = asHHMM(a);
  const B = asHHMM(b);
  if (!A) return '';
  if (!B || B === A) return fmtClock(A);
  if (!hour12()) return `${fmtTime(A)} – ${fmtTime(B)}`;
  const am = (x) => +x.slice(0, 2) < 12;
  const first = am(A) === am(B) ? fmtClock(A).replace(/(am|pm)$/, '') : fmtClock(A);
  return `${first} – ${fmtClock(B)}`;
}
/** Google Calendar's duration labels: '0 mins', '45 mins', '1 hr', '1.5 hrs', '2 hrs'. */
export function durationLabel(mins) {
  const m = Math.max(0, Math.round(+mins || 0));
  if (m < 60) return `${m} min${m === 1 ? '' : 's'}`;
  const h = +(m / 60).toFixed(2);
  return `${h} ${h === 1 ? 'hr' : 'hrs'}`;
}
/**
 * Parse a typed time: '9', '9:45', '945p', '9.45 pm', '21:30', 'noon', 'midnight' → 'HH:MM' (or null).
 * With `base` (12-hour clocks only) an ambiguous hour is moved after it: base 14:00 + '3' → 15:00.
 */
export function parseTimeInput(str, { base = '' } = {}) {
  const s = String(str ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/a\.?m\.?$/, 'am')
    .replace(/p\.?m\.?$/, 'pm')
    .replace(/\./g, ':');
  if (!s) return null;
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = s.match(/^(\d{1,2})(?:[:h]?(\d{2}))?(a|am|p|pm)?$/);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3][0] === 'p' ? 12 : 0);
  } else {
    if (h > 23) return null;
    if (HHMM.test(base) && h < 12 && hour12()) {
      const b = toMinutes(base);
      if (h * 60 + min < b && (h + 12) * 60 + min >= b) h += 12;
    }
  }
  return `${pad(h)}:${pad(min)}`;
}

// ---------------------------------------------------------------- apps registry & icons

// The site root, wherever it's hosted: '/' locally, '/ecosys/' on GitHub Pages.
export const BASE = new URL('../', import.meta.url).pathname;

export const APPS = [
  { id: 'home', name: 'Home', url: BASE, blurb: 'All your apps' },
  { id: 'tasks', name: 'Tasks', url: `${BASE}tasks/`, blurb: 'To-dos, lists & plans' },
  { id: 'schedule', name: 'Schedule', url: `${BASE}schedule/`, blurb: 'Calendar & time blocks' },
  { id: 'notes', name: 'Notes', url: `${BASE}notes/`, blurb: 'Ideas, lists & meeting notes' },
  { id: 'photos', name: 'Photos', url: `${BASE}photos/`, blurb: 'Photos, albums & cloud backup' },
];

let currentApp = 'home';
let gid = 0;
/**
 * App logos: 64×64 SVG strings, full bleed (CSS rounds .app-icon; setFavicon rounds the first <rect>, the tile).
 * One family, drawn the Proton way: a two-stop tile lit from 11 o'clock (the light stop is the app's accent, the
 * deep stop a darker turn of it), a white back plane at 55% and a solid white front mark that overlaps or meets it,
 * round strokes of 6.25 to 8.5 units, gaps of about 4, and the dot, which always means "now" or "you". The Notes
 * writing is painted with the tile's own user-space gradient and the Schedule now-line is a gap, so both read as cuts.
 * Ink coverage stays within ±6% of the set's mean, and every glyph stays inside the maskable safe circle (r 25.6).
 * From 32px a faint top sheen and one soft shadow under the front mark add depth. `small` (favicons, anything under
 * 32px) drops both and sits on the 4-unit lattice (whole pixels at 16px), so no feature falls under a pixel.
 * No text, so nothing depends on a font or the date.
 *   home (ecosys)  ink: a lowercase e drawn as an open orbit, its satellite the Iris dot (a lighter Iris when small)
 *   tasks          blue: a heavy check with the dot for a head (you, done)
 *   schedule       violet: the day view: an earlier block (55%) behind the current one, and the now-line leaving its
 *                  dot and running on through the current block as a cut, the way the app draws it over your events
 *   notes          orange: a sheet with its corner folded forward, one handwritten stroke and the caret dot, cut
 *                  through it (a dash, a gap and the dot when small)
 *   ai             pink: an ecosys squircle (55%) with a round socket, and an assistant's circle docked in it, more
 *                  than half inside the squircle (apps are squircles, assistants are circles)
 */
export function appIcon(id, { small = false } = {}) {
  const tiles = { home: ['#3e4266', '#1d2036'], tasks: ['#1d9bf0', '#1660c2'], schedule: ['#8a6eff', '#5534e0'], notes: ['#ff9214', '#e0560a'], photos: ['#22c38e', '#0b8a6a'], ai: ['#ff4f9a', '#d8146b'] };
  if (!tiles[id]) id = 'home';
  const [lit, deep] = tiles[id];
  const g = `ecg${++gid}`;
  const cut = `url(#${g})`; // the tile's own paint: a mark drawn in it reads as a hole
  const line = (d, w, c = '#fff', cap = 'round') => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="round"/>`;
  const dot = (x, y, r, fill = '#fff') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
  const box = (x, y, w, h, rx, op) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="#fff"${op ? ` fill-opacity="${op}"` : ''}/>`;
  let back = '';
  let front = '';
  let shade = true; // the front mark casts the one soft shadow
  if (id === 'tasks') {
    front = small ? line('M16.5 33.5 27.5 44.5 47.5 21', 10) + dot(26.5, 20.5, 7) : line('M16.5 34 27.5 45 47 21.5', 8.5) + dot(26.75, 21.25, 7.5);
  } else if (id === 'schedule') {
    // The current block is drawn in two pieces around the now-line's path, so the line runs on through it as a cut
    // (and the shadow keeps the gap). Large: the cut's exit corners are rounded; small: square, on whole pixels.
    back = small ? box(16, 12, 20, 12, 4, '.55') : box(17.5, 13, 17.5, 12.5, 4.5, '.55');
    front = small
      ? `<path d="M38.5 20H45.5A6.5 6.5 0 0 1 52 26.5V36H32V26.5A6.5 6.5 0 0 1 38.5 20ZM32 40H52V45.5A6.5 6.5 0 0 1 45.5 52H38.5A6.5 6.5 0 0 1 32 45.5Z" fill="#fff"/>${line('M18 38H32', 4, '#fff', 'butt')}${dot(18, 38, 6)}`
      : `<path d="M39.5 21.5H45.5A6.5 6.5 0 0 1 52 28V30.75A2 2 0 0 1 50 32.75H33V28A6.5 6.5 0 0 1 39.5 21.5ZM33 39.25H50A2 2 0 0 1 52 41.25V44A6.5 6.5 0 0 1 45.5 50.5H39.5A6.5 6.5 0 0 1 33 44Z" fill="#fff"/>${line('M18 36H33', 6.5, '#fff', 'butt')}${dot(18, 36, 5.5)}`;
  } else if (id === 'notes') {
    // The flap is the tile seen through 55% white, and its shadow stays on the sheet. Writing and caret are cut through.
    front = small
      ? `<path d="M23.5 14H34L46 26V44.5a5.5 5.5 0 0 1-5.5 5.5H23.5a5.5 5.5 0 0 1-5.5-5.5V19.5a5.5 5.5 0 0 1 5.5-5.5z" fill="#fff"/><path d="M34 14 46 26H36a2 2 0 0 1-2-2z" fill="${cut}" fill-opacity=".45"/>${line('M24 38H29', 4, cut)}${dot(39, 38, 4, cut)}`
      : `<path d="M24.5 15H33.5L45 26.5V43.5a5.5 5.5 0 0 1-5.5 5.5H24.5a5.5 5.5 0 0 1-5.5-5.5V20.5a5.5 5.5 0 0 1 5.5-5.5z" fill="#fff"/><path d="M34.3 16.6 45 27.3V28.1H36.3a2 2 0 0 1-2-2z" fill="${deep}" fill-opacity=".3"/><path d="M33.5 15 45 26.5H35.5a2 2 0 0 1-2-2z" fill="${cut}" fill-opacity=".45"/>${line('M23.4 38c1.22-2.9 2.58-2.9 3.8 0s2.58 2.9 3.8 0', 4.5, cut)}${dot(39.2, 38, 3.6, cut)}`;
    shade = false;
  } else if (id === 'photos') {
    // A print (55%) tucked behind the current photo, which has a sun dot and a ridge cut through it.
    back = small ? box(12, 12, 24, 20, 4, '.55') : box(13, 14, 25, 21, 5, '.55');
    front = small
      ? `<rect x="22" y="24" width="30" height="28" rx="6" fill="#fff"/><path d="M26 48 34 38 40 44 44 40 48 44V48Z" fill="${cut}"/>${dot(43, 31, 3.5, cut)}`
      : `<rect x="21.5" y="23.5" width="29.5" height="27" rx="6" fill="#fff"/><path d="M25.5 46.5 33.2 37.6 38.6 43 42.4 39.6 47 44.2V46.5Z" fill="${cut}" stroke="${cut}" stroke-width="1.5" stroke-linejoin="round"/>${dot(42.6, 31, 3.4, cut)}`;
    shade = false;
  } else if (id === 'ai') {
    back = `<path d="${
      small
        ? 'M21 20H22.11A2 2 0 0 1 24.1 22.22A16 16 0 0 0 41.78 39.9A2 2 0 0 1 44 41.89V43A9 9 0 0 1 35 52H21A9 9 0 0 1 12 43V29A9 9 0 0 1 21 20Z'
        : 'M23 20H23.37A2 2 0 0 1 25.36 22.24A14.75 14.75 0 0 0 41.76 38.64A2 2 0 0 1 44 40.63V41A9 9 0 0 1 35 50H23A9 9 0 0 1 14 41V29A9 9 0 0 1 23 20Z'
    }" fill="#fff" fill-opacity=".55"/>`;
    front = dot(40, 24, small ? 10 : 10.25);
  } else {
    front = small
      ? `${line('M16 32H48A16 16 0 1 0 27.86 47.45', 8)}${dot(41.74, 44.69, 5.5, '#a5a3ff')}`
      : `${line('M17 32H47A15 15 0 1 0 32 47', 6.25)}${dot(42.61, 42.61, 4.6, '#7d7bff')}`;
    shade = false; // a shadow in ink on ink is invisible
  }
  const depth = !small;
  return (
    `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${g}" x1="12.8" y1="0" x2="51.2" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${lit}"/><stop offset="1" stop-color="${deep}"/></linearGradient>` +
    (depth ? `<linearGradient id="${g}s" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>` : '') +
    `</defs><rect width="64" height="64" fill="url(#${g})"/>` +
    (depth ? `<rect width="64" height="64" rx="15" fill="url(#${g}s)"/>` : '') + // rounded like the tile, so it never paints a corner
    back +
    (depth && shade ? `<g opacity=".3" transform="translate(1 1.6)">${front.replaceAll('#fff', deep)}</g>` : '') +
    front +
    '</svg>'
  );
}

/**
 * The tab's icon: the small logo with the tile's corners rounded, and a faint rim so the tile shows on a dark tab bar.
 * shared/icons/<app>.svg carry this same small cut (and switch to it under 32px), so the tab doesn't change when JS runs.
 */
export function setFavicon(id) {
  const svg = appIcon(id, { small: true })
    .replace('<svg viewBox="0 0 64 64" aria-hidden="true">', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">')
    .replace('<rect width="64" height="64"', '<rect width="64" height="64" rx="15"')
    .replace('</svg>', '<rect x=".75" y=".75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.5"/></svg>');
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
  const s = settings.get() || {};
  const theme = THEMES.some((t) => t.id === s.theme && t.id !== 'system') ? s.theme : darkMq.matches ? 'dark' : 'light';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = ACCENTS.some((a) => a.id === s.accent) ? s.accent : 'iris';
  root.dataset.reduceMotion = String(s.reduceMotion === true);
  setHour12(s.timeFormat === '12h' ? true : s.timeFormat === '24h' ? false : null);
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
/** `popover` layers (menus, pickers) are closed when a modal opens: they would float above its scrim. */
function pushLayer(close, { popover = false } = {}) {
  const layer = { close, popover };
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
function closePopovers() {
  for (const l of [...layers].reverse()) if (l.popover) l.close();
}
// The pointerdown that last light-dismissed a popover. A modal's scrim ignores it, so a tap outside an
// open menu closes just the menu (as on iOS), and the next tap closes the modal.
let dismissedBy = null;
// Set while a press on a picker sheet's scrim closes sheets (one opened from another closes with it): each
// of them leaves its scrim up for the rest of that tap, so its click lands on a scrim, not on the page.
let closingByScrim = false;

// ---------------------------------------------------------------- toasts & undo

let toastBox = null;
// The toasts' live region exists from the start (initShell): screen readers skip a message that arrives
// together with the region that holds it, so the first toast of a page would go unheard.
function toastRegion() {
  if (!toastBox || !document.contains(toastBox)) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }
  return toastBox;
}
/**
 * Show a toast. `tone` is accepted for compatibility; every toast uses the same quiet style.
 * `duration: 0` keeps it up until the returned close() is called (a status such as "offline").
 */
export function toast(message, { action, onAction, duration = 4500 } = {}) {
  const box = toastRegion();
  // Two at a time; a sticky status stays while newer messages come and go.
  for (const old of [...box.children].filter((n) => !n.classList.contains('sticky')).slice(0, Math.max(0, box.children.length - 1))) old.remove();
  const el = document.createElement('div');
  el.className = `toast${duration === 0 ? ' sticky' : ''}`;
  el.innerHTML = `<span class="toast-msg">${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  box.append(el);
  let timer;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 230);
  };
  el.querySelector('button')?.addEventListener('click', () => {
    onAction?.();
    close();
  });
  const arm = () => {
    clearTimeout(timer);
    if (duration > 0) timer = setTimeout(close, duration);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  arm();
  return close;
}

let announcer = null;
let announceTimer = 0;
/**
 * Tell screen readers something without showing it, e.g. the month a calendar moved to (a polite status
 * message). The region is created at startup and kept, so every message is heard.
 */
export function announce(message) {
  if (!announcer || !document.contains(announcer)) {
    announcer = document.createElement('div');
    announcer.className = 'sr-only';
    announcer.dataset.announcer = '';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    document.body.append(announcer);
  }
  clearTimeout(announceTimer);
  // Emptied first, so the same words said twice in a row are read twice.
  announcer.textContent = '';
  const text = String(message ?? '');
  if (text) announceTimer = setTimeout(() => (announcer.textContent = text), 80);
}

// Global undo stack (mod Z): every destructive action pushes its undo here. An undo can be redone
// (shift mod Z, or Ctrl+Y outside macOS): it runs under trackChanges, whose result takes back exactly
// what the undo changed, record by record (edits made since stay). That is the redo, and redoing in
// turn gives the undo again. A new change ends the redo chain. An undo or redo that finds nothing left
// to take back (it was all changed or deleted since, here, in another tab or by an assistant) says so,
// and leaves nothing to redo or undo in turn.
const undoStack = [];
const redoStack = [];
const undoToasts = new Set();
export function pushUndo(label, fn) {
  undoStack.push({ label, fn });
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
}
/** Run an undo or a redo; returns what takes it back, or null if it failed (it is logged). */
function reversibly(fn) {
  try {
    return trackChanges(fn, COLLECTIONS);
  } catch (err) {
    console.error('ecosys: undo failed', err);
    return null;
  }
}
/**
 * Run an undo; returns what takes it back (the redo), or null if it failed. An undo that found nothing
 * left to take back (all of it changed or deleted since, so it wrote nothing: trackChanges' .count is 0)
 * leaves no redo.
 */
function runUndo(u) {
  const redo = reversibly(u.fn);
  if (redo && redo.count !== 0) redoStack.push({ label: u.label, fn: redo });
  return redo;
}
const NOTHING_LEFT = 'Nothing to undo: it was changed or deleted since';
export function undoLast() {
  const u = undoStack.pop();
  if (!u) {
    toast('Nothing to undo', { duration: 1800 });
    return;
  }
  u.closeToast?.(); // its "… Undo" toast would offer an undo that is already done
  const redo = runUndo(u);
  if (redo) toast(redo.count === 0 ? NOTHING_LEFT : `Undid ${u.label}`, { duration: 2200 });
}
export function redoLast() {
  const r = redoStack.pop();
  if (!r) {
    toast('Nothing to redo', { duration: 1800 });
    return;
  }
  const undo = reversibly(r.fn);
  if (!undo) return;
  // Everything it would redo was changed or deleted since: there is nothing to undo again either.
  if (undo.count === 0) return void toast('Nothing to redo: it was changed or deleted since', { duration: 2200 });
  undoStack.push({ label: r.label, fn: undo });
  if (undoStack.length > 50) undoStack.shift();
  toast(`Redid ${r.label}`, { duration: 2200 });
}
/** Forget every undo and redo step and disarm visible Undo buttons (the data they would restore is gone). */
export function clearUndo() {
  undoStack.length = 0;
  redoStack.length = 0;
  for (const close of [...undoToasts]) close();
  undoToasts.clear();
}
/**
 * Show a toast with Undo and register the undo for mod Z. The default `label` keeps the message's
 * case after its first letter, so names stay as typed: 'Undid deleted “Errands”'.
 */
export function undoable(message, undoFn, label = String(message).charAt(0).toLowerCase() + String(message).slice(1)) {
  pushUndo(label, undoFn);
  const entry = undoStack.at(-1);
  const close = toast(message, {
    action: 'Undo',
    onAction: () => {
      const i = undoStack.findIndex((u) => u.fn === undoFn);
      if (i < 0) return;
      const [u] = undoStack.splice(i, 1);
      if (runUndo(u)?.count === 0) toast(NOTHING_LEFT, { duration: 2200 });
    },
  });
  if (entry?.fn === undoFn) entry.closeToast = close;
  undoToasts.add(close);
  setTimeout(() => undoToasts.delete(close), 6000);
}

// ---------------------------------------------------------------- popovers & menus

// Below this much room a list is not shrunk to fit beside its anchor: it may cover the anchor instead.
const MIN_LIST_ROOM = 160;
function place(el, anchor, { align = 'start', side = 'bottom', offset = 6 } = {}) {
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
  // Lists (menus, the time list, suggestions) can shrink to the room there is and scroll; other panels keep their size.
  const list = !!el.querySelector('[role="menu"], [role="listbox"]');
  const scrolled = el.scrollTop;
  if (list) el.style.maxHeight = '';
  const w = el.offsetWidth;
  let h = el.offsetHeight;
  const vw = innerWidth;
  const vh = innerHeight;
  // Beside the anchor, on the preferred side if the panel fits there, else the other; null if neither fits.
  const beside = (prefer) => {
    const right = r.right + offset;
    const left = r.left - w - offset;
    const fits = { right: right + w <= vw - 8, left: left >= 8 };
    const first = prefer === 'right' ? 'right' : 'left';
    const second = first === 'right' ? 'left' : 'right';
    const pickSide = fits[first] ? first : fits[second] ? second : null;
    return pickSide === 'right' ? right : pickSide === 'left' ? left : null;
  };
  let x = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
  let y;
  const bx = side === 'right' ? beside('right') : null;
  if (bx !== null) {
    x = bx;
    y = r.top;
  } else {
    // A card meant to sit beside its anchor that fits on neither side (a wide event in Day view) goes
    // above or below it instead, so it never covers the anchor.
    if (side === 'right') x = r.left + 16;
    // The preferred side if the panel fits there, else the other side if it fits there, else the roomier
    // side, with a list shrunk to fit: a tall menu near the bottom never covers the row that opened it.
    const room = { bottom: vh - 8 - offset - r.bottom, top: r.top - offset - 8 };
    const want = side === 'top' ? 'top' : 'bottom';
    const other = want === 'top' ? 'bottom' : 'top';
    const at = h <= room[want] ? want : h <= room[other] ? other : room[want] >= room[other] ? want : other;
    if (h > room[at] && list && room[at] >= MIN_LIST_ROOM) {
      el.style.maxHeight = `${Math.floor(room[at])}px`;
      h = el.offsetHeight;
    }
    y = at === 'top' ? r.top - offset - h : r.bottom + offset;
    // A panel that keeps its size (a date picker, a card) and fits neither above nor below sits beside
    // the anchor, centred on it, rather than over it: the row being edited stays in view.
    if (h > room[at] && !list && side !== 'right') {
      const sx = beside('left');
      if (sx !== null) {
        x = sx;
        y = r.top + r.height / 2 - h / 2;
      }
    }
  }
  y = Math.min(Math.max(8, y), Math.max(8, vh - h - 8));
  x = Math.min(Math.max(8, x), vw - w - 8);
  if (list && scrolled) el.scrollTop = scrolled;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  // Grow from the corner or edge nearest the anchor.
  const ox = x + w <= r.left ? 'right' : x >= r.right ? 'left' : align === 'end' ? 'right' : 'left';
  const oy = y + h <= r.top ? 'bottom' : y >= r.bottom ? 'top' : 'center';
  el.style.setProperty('--origin', `${ox} ${oy}`);
}

// Anchor element → its open popover. Opening a popover for an anchor that already has one closes it
// instead (menu-button toggle), so clicking an open field or button never stacks a second copy.
const popoverFor = new WeakMap();
// Open popovers, oldest first. One opened from inside another (the menu of a field in a popover card,
// suggestions under an input in a popover) sits above it: a press inside it is not outside the popovers
// below, and it closes along with the popover that holds its anchor.
const openPops = [];

/**
 * Open a floating panel anchored to an element (or {x, y}). Returns {el, close, reposition}.
 * If the anchor element's popover is already open, that one is closed instead and its handle returned
 * (pass `toggle: false` for a popover that manages its own lifecycle and must not take part).
 * opts: { className, align, side, onClose, onMount(el, close), focus, restoreFocus, role, label, minWidth, toggle, sheet }
 * `sheet`: on a phone-sized screen the panel is a bottom sheet over a scrim (iOS), as the date and time
 * pickers are: it gets the class `as-sheet`, which ui.css lays out.
 */
export function openPopover(anchor, content, { className = '', align, side, onClose, onMount, focus = true, restoreFocus = true, role = 'dialog', label = '', minWidth = 0, toggle = true, sheet = false } = {}) {
  const anchorEl = anchor instanceof Element ? anchor : null;
  const owner = toggle ? anchorEl : null;
  const open = owner && popoverFor.get(owner);
  if (open) {
    open.close();
    return open;
  }
  const asSheet = !!sheet && phoneLayout();
  const el = document.createElement('div');
  el.className = `menu ${className}${asSheet ? ' as-sheet' : ''}`.trim();
  if (role) el.setAttribute('role', role);
  if (label) el.setAttribute('aria-label', label);
  el.innerHTML = content;
  if (minWidth) el.style.minWidth = `${Math.ceil(minWidth)}px`;
  // A sheet's scrim sits over the page and any open sheet or modal (z-index 60–61), under the menus (70).
  // A tap on it closes the sheet (as a press outside) and nothing under it: it lingers, clear, for that tap.
  // Closed any other way (Escape, a day picked in it), the sheet takes its scrim along at once.
  const scrim = asSheet ? document.createElement('div') : null;
  if (scrim) {
    scrim.className = 'scrim pop-scrim';
    scrim.style.zIndex = '69';
    scrim.setAttribute('aria-hidden', 'true');
    document.body.append(scrim);
  }
  document.body.append(el);
  place(el, anchor, { align, side });
  let closed = false;
  // Set when focus has already moved on (focusout): closing then leaves it where it went.
  let keepFocus = false;
  // Menu-button pattern: focus returns to the anchor (Safari never focuses a clicked button), else to what had it.
  const prevFocus = anchor instanceof Element && anchor.matches('button:not([disabled]), a[href], input, [tabindex]') ? anchor : document.activeElement;
  const reposition = () => {
    if (anchor instanceof Element && !document.contains(anchor)) return close();
    place(el, anchor, { align, side });
  };
  const onScroll = (e) => {
    if (!el.contains(e.target)) reposition();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    // Popovers anchored inside this one go first (top down), so focus unwinds back to here and then on.
    const at = openPops.indexOf(rec);
    if (at >= 0) {
      for (const p of openPops.slice(at + 1).reverse()) if (p.anchorEl && el.contains(p.anchorEl)) p.close();
      openPops.splice(openPops.indexOf(rec), 1);
    }
    popLayer();
    if (owner && popoverFor.get(owner) === handle) popoverFor.delete(owner);
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', onScroll, true);
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    if (scrim) {
      scrim.style.transition = 'opacity 160ms';
      scrim.style.opacity = '0';
      const lifted = () => setTimeout(remove, 400);
      const remove = () => {
        scrim.remove();
        removeEventListener('click', remove, true);
        removeEventListener('pointerup', lifted, true);
        removeEventListener('pointercancel', remove, true);
      };
      if (closingByScrim) {
        // The tap that closed the sheet has its click still to come (a slow tap's, too): a scrim takes it,
        // then they go. Once the finger is up they go regardless, as when the press turns into a scroll.
        addEventListener('click', remove, true);
        addEventListener('pointerup', lifted, true);
        addEventListener('pointercancel', remove, true);
        setTimeout(remove, 1500);
      } else {
        // The next tap goes straight through to the page while the scrim fades.
        scrim.style.pointerEvents = 'none';
        setTimeout(remove, 170);
      }
    }
    onClose?.();
    const active = document.activeElement;
    if (restoreFocus && !keepFocus && prevFocus && document.contains(prevFocus) && (hadFocus || !active || active === document.body)) prevFocus.focus?.({ preventScroll: true });
  };
  const handle = { el, close, reposition };
  const rec = { el, anchorEl, close };
  openPops.push(rec);
  if (owner) popoverFor.set(owner, handle);
  const popLayer = pushLayer(close, { popover: true });
  const outside = (e) => {
    const t = e.target;
    if (el.contains(t) || anchorEl?.contains(t)) return;
    // A press in a popover opened after this one (a select menu opened from a field in this card) is
    // inside that one; it closes it or picks from it, and this one stays.
    const at = openPops.indexOf(rec);
    if (at >= 0 && openPops.slice(at + 1).some((p) => p.el.contains(t))) return;
    dismissedBy = e;
    closingByScrim = !!t?.classList?.contains('pop-scrim');
    try {
      close();
    } finally {
      closingByScrim = false;
    }
  };
  setTimeout(() => {
    if (!closed) document.addEventListener('pointerdown', outside, true);
  });
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  if (role === 'dialog') {
    // Cards and pickers sit at the end of the page, so Tab would walk out of them to the top of the page
    // while they stay open. Instead (disclosure pattern) Tab past the last control closes the card and goes
    // on from its anchor, and Shift+Tab past the first returns to the anchor. A card holding a form keeps
    // Tab inside (its typing would be lost), and focus that moves anywhere else closes the card.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || closed || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      if (!el.contains(active)) return;
      const f = tabbables(el);
      const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const edge = e.shiftKey ? !f.some((n) => n !== active && before(n, active)) : !f.some((n) => n !== active && before(active, n));
      if (!edge) return;
      if (el.querySelector('form') && f.length) {
        e.preventDefault();
        (e.shiftKey ? f.at(-1) : f[0]).focus();
        return;
      }
      close();
      const back = document.activeElement;
      if (e.shiftKey || !back || back === document.body) {
        e.preventDefault();
        if (anchorEl && document.contains(anchorEl) && back !== anchorEl && anchorEl.matches(FOCUSABLE)) anchorEl.focus({ preventScroll: true });
      }
      // Tab without preventDefault: focus is back on the anchor, and the browser moves on from there.
    });
    el.addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      // Focus leaving the window, or a press on the page (`outside` handles that), has no target here.
      if (closed || !(to instanceof Element) || el.contains(to) || anchorEl?.contains(to)) return;
      const at = openPops.indexOf(rec);
      if (at >= 0 && openPops.slice(at + 1).some((p) => p.el.contains(to))) return; // into a picker opened from this card
      keepFocus = true;
      close();
    });
  }
  onMount?.(el, close);
  if (focus && !closed) (el.querySelector(AUTOFOCUS) || el.querySelector('button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'))?.focus({ preventScroll: true });
  return handle;
}

/**
 * items: [{label, icon, iconHtml, keys, hint, danger, checked, multi, disabled, className, onSelect}] | {sep:true} | {heading:'…'}
 * `keys` is a key spec rendered with keys(); `hint` is trusted HTML (e.g. a keys() string).
 * An item with `checked` is a radio choice (menuitemradio), or with `multi: true` one of several that can
 * be on together (menuitemcheckbox).
 * An item's accessible name is its label: keycaps are announced as aria-keyshortcuts, not read as text.
 */
export function openMenu(anchor, items, opts = {}) {
  const list = items.filter(Boolean);
  const withIcons = list.some((it) => it.icon || it.iconHtml);
  const body = list
    .map((it, i) => {
      if (it.sep) return '<div class="menu-sep" role="separator"></div>';
      if (it.heading) return `<div class="menu-label" role="presentation">${esc(it.heading)}</div>`;
      const checkable = it.checked !== undefined;
      const role = !checkable ? 'menuitem' : it.multi ? 'menuitemcheckbox' : 'menuitemradio';
      // Only shortcuts that work: none of the one-key ones while those are off (Settings > Keyboard).
      const spec = liveKeys(it.keys);
      const hint = spec ? keys(spec) : it.keys ? '' : !singleKeys() && oneKeyHint(it.hint || '') ? '' : it.hint || '';
      // Keycaps (and any glyph) are visual: the shortcut is exposed as aria-keyshortcuts instead.
      const capsOnly = !!spec || /class="keys"/.test(hint);
      const shortcut = spec ? ariaKeys(spec) : '';
      const lead = it.iconHtml ? hideMark(it.iconHtml) : it.icon ? icon(it.icon, { size: 18 }) : withIcons ? '<span class="mi-pad" aria-hidden="true"></span>' : '';
      return `<button type="button" class="menu-item${it.danger ? ' danger' : ''}${it.className ? ` ${esc(it.className)}` : ''}" role="${role}" data-i="${i}" tabindex="-1"${checkable ? ` aria-checked="${!!it.checked}"` : ''}${shortcut ? ` aria-keyshortcuts="${esc(shortcut)}"` : ''}${it.disabled ? ' disabled' : ''}>
        ${lead}<span class="grow truncate">${esc(it.label)}</span>${hint ? `<span class="hint"${capsOnly ? ' aria-hidden="true"' : ''}>${hint}</span>` : ''}${checkable ? `<span class="check-mark">${icon('check', { size: 16 })}</span>` : ''}
      </button>`;
    })
    .join('');
  let typed = '';
  let typedAt = 0;
  return openPopover(anchor, `<div role="menu"${opts.label ? ` aria-label="${esc(opts.label)}"` : ''}>${body}</div>`, {
    ...opts,
    role: '',
    focus: false,
    onMount: (el, close) => {
      const btns = () => $$('.menu-item:not([disabled])', el).filter((b) => b.offsetParent !== null);
      const first = $('.menu-item[aria-checked="true"]:not([disabled])', el) || btns()[0];
      first?.focus({ preventScroll: true });
      first?.scrollIntoView({ block: 'nearest' });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (!b || b.disabled) return;
        const it = list[+b.dataset.i];
        close();
        it.onSelect?.();
      });
      el.addEventListener('pointermove', (e) => {
        const b = e.target.closest('.menu-item:not([disabled])');
        if (b && document.activeElement !== b) b.focus({ preventScroll: true });
      });
      el.addEventListener('keydown', (e) => {
        const bs = btns();
        const i = bs.indexOf(document.activeElement);
        const go = (j) => bs[(j + bs.length) % bs.length]?.focus();
        if (e.key === 'ArrowDown') go(i + 1);
        else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(-1);
        else if (e.key === 'Tab') close();
        else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          typed = now - typedAt < 700 ? typed + e.key.toLowerCase() : e.key.toLowerCase();
          typedAt = now;
          const start = typed.length > 1 ? i : i + 1;
          const order = [...bs.slice(Math.max(0, start)), ...bs.slice(0, Math.max(0, start))];
          // By label: a lead glyph's text (the day in a Today icon) is not part of the name.
          order.find((b) => String(list[+b.dataset.i]?.label ?? '').trim().toLowerCase().startsWith(typed))?.focus();
        } else return;
        e.preventDefault();
      });
      opts.onMount?.(el, close);
    },
  });
}

// ---------------------------------------------------------------- modal / sheet

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
// Popovers and modals focus this element when they open. Prefer `data-autofocus` in markup: the shell
// focuses it itself, while a real `autofocus` attribute also makes the browser log a blocked-autofocus notice.
const AUTOFOCUS = '[data-autofocus], [autofocus]';
const focusables = (root) => $$(FOCUSABLE, root).filter((n) => n.offsetParent !== null || n === document.activeElement);
/** The controls Tab stops at (a button with tabindex="-1", like a time list row, is focusable but not one). */
const tabbables = (root) => focusables(root).filter((n) => n.tabIndex >= 0);

/**
 * A centered modal (a bottom sheet on phones). Focus is trapped inside and the page behind is inert;
 * closing restores focus. Returns {el, close}.
 */
export function openModal({ title = '', body = '', className = '', headExtra = '', onMount, onClose, label, role = 'dialog' } = {}) {
  closePopovers();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const el = document.createElement('div');
  el.className = `modal ${className}`.trim();
  el.setAttribute('role', role);
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', label || title || 'Dialog');
  el.tabIndex = -1;
  el.innerHTML = `<div class="grabber" aria-hidden="true"></div>${
    title || headExtra
      ? `<div class="modal-head"><h2>${esc(title)}</h2>${headExtra}<button type="button" class="icon-btn" data-close aria-label="Close" data-tip="Close" data-keys="esc">${icon('x')}</button></div>`
      : ''
  }${body}`;
  const prevFocus = document.activeElement;
  // A modal over another one (a confirm over Settings) gets its own scrim over the first: the sheet
  // beneath dims instead of staying bright around it.
  const depth = document.querySelectorAll('body > .modal').length;
  if (depth) {
    scrim.style.zIndex = String(60 + depth * 2);
    el.style.zIndex = String(61 + depth * 2);
  }
  document.body.append(scrim, el);
  // Make everything behind the modal inert (stacks: a confirm over Settings makes Settings inert too), once
  // the modal has painted: inert restyles the whole page, which takes a while on a large one (with 5,000
  // tasks the palette showed 40-60 ms later), and the modal should not wait for it. Until then the scrim
  // takes the pointer, focus is in the modal and Tab is kept there (below), and aria-modal keeps screen
  // readers in it. "Behind" is the page's elements before its scrim, taken when it is applied: a modal opened
  // over this one meanwhile then finds the page already inert, and a menu or confirm on top stays usable.
  let madeInert = [];
  const makeInert = () => {
    if (closed) return;
    const behind = (n) => !!(n.compareDocumentPosition(scrim) & Node.DOCUMENT_POSITION_FOLLOWING);
    madeInert = [...document.body.children].filter((n) => n !== scrim && n !== el && behind(n) && !n.inert && !n.matches('.toasts, .tooltip, [data-announcer], script'));
    for (const n of madeInert) n.inert = true;
  };
  requestAnimationFrame(() => setTimeout(makeInert, 0));
  hideTip();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    popLayer();
    scrim.remove();
    el.remove();
    for (const n of madeInert) n.inert = false;
    onClose?.();
    if (prevFocus && document.contains(prevFocus) && !document.activeElement?.closest?.('.modal')) prevFocus.focus?.({ preventScroll: true });
  };
  const popLayer = pushLayer(close);
  // Dismiss on a click that began on the scrim. Closing on pointerdown let a touch tap fall through to
  // the page once the scrim was gone; requiring the press here also keeps the tap that opened the modal
  // from closing it, and a tap that only dismissed a menu inside the modal leaves the modal open.
  let pressed = false;
  scrim.addEventListener('pointerdown', (e) => (pressed = e !== dismissedBy));
  scrim.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the modal
  scrim.addEventListener('click', () => {
    if (pressed) close();
    pressed = false;
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = focusables(el);
    if (!f.length) return e.preventDefault();
    const first = f[0];
    const last = f.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  // Separator under the head once the body scrolls.
  const scroller = el.querySelector('.modal-body');
  scroller?.addEventListener('scroll', () => el.classList.toggle('scrolled', scroller.scrollTop > 2), { passive: true });
  // Swipe the grabber down to dismiss on touch screens.
  const grab = el.querySelector('.grabber');
  let startY = null;
  grab.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    el.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  grab.addEventListener('pointerup', (e) => {
    if (startY !== null && e.clientY - startY > 80) close();
    else el.style.transform = '';
    startY = null;
  });
  onMount?.(el, close);
  if (!el.contains(document.activeElement)) (el.querySelector(AUTOFOCUS) || el.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])') || el).focus({ preventScroll: true });
  return { el, close };
}

export function confirmDialog({ title, message = '', confirm = 'OK', danger = false, cancel = 'Cancel' }) {
  return choiceDialog({ title, message, choices: [{ label: confirm, value: true, tone: danger ? 'danger' : 'primary' }], cancel }).then((v) => v === true);
}

/** choices: [{label, value, tone:'primary'|'danger'|'secondary'}] → resolves to value or null. Cancel is focused when a choice is destructive. */
export function choiceDialog({ title, message = '', choices, cancel = 'Cancel' }) {
  const risky = choices.some((c) => c.tone === 'danger');
  const id = `cd${++gid}`;
  return new Promise((resolve) => {
    let result = null;
    openModal({
      className: 'choice',
      label: title,
      role: 'alertdialog',
      body: `<div class="modal-body">
        <h2 class="choice-title" id="${id}-t">${esc(title)}</h2>
        ${message ? `<p class="choice-msg" id="${id}-d">${esc(message)}</p>` : ''}
        <div class="choice-actions">
          ${choices.map((c, i) => `<button type="button" class="btn btn-${c.tone === 'danger' ? 'danger' : c.tone === 'secondary' ? 'secondary' : 'primary'} btn-block" data-choice="${i}"${!risky && i === 0 ? ' data-autofocus' : ''}>${esc(c.label)}</button>`).join('')}
          <button type="button" class="btn btn-ghost btn-block" data-close${risky ? ' data-autofocus' : ''}>${esc(cancel)}</button>
        </div>
      </div>`,
      onMount: (el, close) => {
        // An alert dialog is named by its title and described by its message, so the warning is read out
        // with the dialog (focus starts on Cancel when the choice is destructive).
        el.removeAttribute('aria-label');
        el.setAttribute('aria-labelledby', `${id}-t`);
        if (message) el.setAttribute('aria-describedby', `${id}-d`);
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

// ---------------------------------------------------------------- tooltips (data-tip + optional data-keys; replaces title=)

let tipEl = null;
let tipTimer = 0;
let tipTarget = null;
let tipWarmUntil = 0;
let lastPointer = 'mouse';
let tipMuted = null;
let viaTab = false;
let tipByPointer = false; // the shown tooltip was opened by the pointer, so it is hoverable (tipHolds)

/** Attribute string for a tooltip: `<button ${tipAttrs('Search', 'mod K')}>`. */
export const tipAttrs = (text, keySpec = '') => `data-tip="${esc(text)}"${keySpec ? ` data-keys="${esc(keySpec)}"` : ''}`;

function adoptTitle(el) {
  const t = el.getAttribute('title');
  if (t === null) return;
  el.removeAttribute('title');
  if (!t) return;
  if (!el.dataset.tip) el.dataset.tip = t;
  if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent.trim()) el.setAttribute('aria-label', t);
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl?.classList.contains('on')) tipWarmUntil = Date.now() + 300;
  tipTarget = null;
  tipByPointer = false;
  tipEl?.classList.remove('on');
}
/**
 * `byPointer`: the pointer opened it, so it is hoverable (WCAG 1.4.13): it stays up while the pointer is over
 * its trigger or over it (tipHolds). The tooltip itself never takes the pointer (ui.css), so a click or a wheel
 * turn over it reaches the control it covers. One that keyboard focus opened goes once the pointer moves on.
 */
function showTip(el, byPointer = false) {
  if (!document.contains(el) || el.getAttribute('aria-expanded') === 'true') return;
  const text = el.dataset.tip;
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.setAttribute('aria-hidden', 'true');
    document.body.append(tipEl);
  } else if (tipEl.parentNode !== document.body || tipEl.nextElementSibling) document.body.append(tipEl);
  tipEl.innerHTML = `<span>${esc(text)}</span>${keys(liveKeys(el.dataset.keys))}`;
  const r = el.getBoundingClientRect();
  tipEl.style.left = '0px';
  tipEl.style.top = '0px';
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const below = el.dataset.tipSide === 'bottom' || r.top - h - 8 < 4;
  const x = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), innerWidth - w - 6);
  const y = below ? r.bottom + 6 : r.top - h - 6;
  tipEl.style.left = `${Math.round(x)}px`;
  tipEl.style.top = `${Math.round(y)}px`;
  tipByPointer = !!byPointer;
  tipEl.classList.add('on');
}
/**
 * Where a shown, pointer-opened tooltip holds: 'tip' over it or within 6px of it (which spans the gap to its
 * trigger), 'near' elsewhere in the box around it and its trigger (a diagonal path between the two), else ''.
 */
function tipHolds(x, y) {
  if (!tipByPointer || !tipTarget || !tipEl?.classList.contains('on')) return '';
  const t = tipEl.getBoundingClientRect();
  if (x >= t.left - 6 && x <= t.right + 6 && y >= t.top - 6 && y <= t.bottom + 6) return 'tip';
  const r = tipTarget.getBoundingClientRect();
  const inBox = x >= Math.min(t.left, r.left) && x <= Math.max(t.right, r.right) && y >= Math.min(t.top, r.top) && y <= Math.max(t.bottom, r.bottom);
  return inBox ? 'near' : '';
}
function scheduleTip(el, byPointer = false) {
  clearTimeout(tipTimer);
  tipTarget = el;
  const delay = Date.now() < tipWarmUntil ? 60 : 450;
  tipTimer = setTimeout(() => tipTarget === el && showTip(el, byPointer), delay);
}
function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    lastPointer = e.pointerType || 'mouse';
    const el = e.target.closest?.('[data-tip], [title]');
    if (el === tipTarget) return;
    // Over the tooltip (whatever it covers gets the pointer), or on the way to it: it stays, so it can be read
    // (WCAG 1.4.13). Another control with a tooltip, off the tooltip, takes over.
    const holds = tipHolds(e.clientX, e.clientY);
    if (holds === 'tip' || (holds === 'near' && !el)) return;
    hideTip();
    if (!el) return;
    adoptTitle(el);
    if (lastPointer === 'touch' || lastPointer === 'pen' || !el.dataset.tip || el === tipMuted) return;
    scheduleTip(el, true);
  });
  document.addEventListener('pointerout', (e) => {
    if (tipMuted && !tipMuted.contains(e.relatedTarget)) tipMuted = null;
    // Leaving the trigger for its tooltip (or on the way to it) keeps it; leaving both hides it.
    if (tipTarget && !tipTarget.contains(e.relatedTarget) && !tipHolds(e.clientX, e.clientY)) hideTip();
  });
  // A pointer-opened tooltip goes once the pointer is off both it and its trigger. A control it covered may
  // have a tooltip of its own, skipped while the pointer was over this one: it shows now.
  document.addEventListener('pointermove', (e) => {
    if (!tipByPointer || tipTarget?.contains(e.target) || tipHolds(e.clientX, e.clientY)) return;
    hideTip();
    const el = e.target.closest?.('[data-tip], [title]');
    if (!el || e.pointerType === 'touch' || e.pointerType === 'pen' || el === tipMuted) return;
    adoptTitle(el);
    if (el.dataset.tip) scheduleTip(el, true);
  }, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType || lastPointer;
    viaTab = false;
    tipMuted = e.target.closest?.('[data-tip]') || null;
    hideTip();
  }, true);
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip], [title]');
    if (!el) return;
    adoptTitle(el);
    if (viaTab && el.dataset.tip) scheduleTip(el);
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('keydown', (e) => {
    viaTab = e.key === 'Tab';
    hideTip();
  }, true);
  window.addEventListener('scroll', hideTip, { capture: true, passive: true });
  window.addEventListener('blur', hideTip);
}

// ---------------------------------------------------------------- custom fields (no native select / date / time / checkbox)

const attr = (name, value) => (value === undefined || value === null || value === '' ? '' : ` ${name}="${esc(value)}"`);
const fieldLabel = (el, text) => {
  if (el.dataset.label) el.setAttribute('aria-label', text ? `${el.dataset.label}: ${text}` : el.dataset.label);
};
const normOptions = (options) =>
  (Array.isArray(options) ? options : []).map((o) => {
    const x = o && typeof o === 'object' ? o : { value: o, label: o };
    const out = { value: String(x.value ?? ''), label: String(x.label ?? x.value ?? '') };
    if (x.icon) out.icon = String(x.icon);
    const c = x.color ? cssColor(x.color) : '';
    if (c) out.color = c;
    if (x.hint) out.hint = String(x.hint);
    return out;
  });
const readOptions = (el) => {
  try {
    return normOptions(JSON.parse(el.dataset.options || '[]'));
  } catch {
    return [];
  }
};
const optionLead = (o) => (o?.color ? `<span class="swatch-dot" style="background:${o.color}"></span>` : o?.icon ? icon(o.icon, { size: 16 }) : '');
const selectLabel = (o, placeholder) => (o ? `${optionLead(o)}<span class="truncate">${esc(o.label)}</span>` : `<span class="truncate fb-ph">${esc(placeholder || 'Select')}</span>`);
const dateText = (v) => {
  const d = parseYmd(v);
  return fmt(d, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
};

/**
 * A styled select: `<button class="select-field" data-select name value>`; read it with `form.elements[name].value`.
 * Opens a themed menu; choosing dispatches bubbling `input` + `change` events.
 * options: [{value, label, icon?, color?, hint?}]
 */
export function selectField({ name = '', value = '', options = [], placeholder = 'Select', className = '', ariaLabel = '', id = '', disabled = false } = {}) {
  const opts = normOptions(options);
  const cur = opts.find((o) => o.value === String(value ?? ''));
  return `<button type="button" class="field-btn select-field${className ? ` ${esc(className)}` : ''}" data-select${attr('id', id)}${attr('name', name)} value="${esc(cur ? cur.value : '')}" data-options="${esc(JSON.stringify(opts))}" data-placeholder="${esc(placeholder)}"${attr('data-label', ariaLabel)}${ariaLabel ? attr('aria-label', `${ariaLabel}: ${cur ? cur.label : placeholder}`) : ''} aria-haspopup="menu" aria-expanded="false"${disabled ? ' disabled' : ''}><span class="fb-label">${selectLabel(cur, placeholder)}</span>${icon('chevron-down', { size: 16, cls: 'fb-chev' })}</button>`;
}

/**
 * Time button in the compact style rows and events use ('9:30am', '9am' or '09:30'); opens a Google
 * Calendar-style list every `step` minutes. With `base` ('HH:MM') the list starts there and each row
 * shows the duration: '10am (30 mins)'.
 * A `placeholder` (the empty field's text) makes the field clearable; the list's clear row repeats it,
 * or says `clearLabel` when that is given ('Add time' on the button, 'No time' in the list).
 */
export function timeField({ name = '', value = '', base = '', step = 15, placeholder = '', clearLabel = '', className = '', ariaLabel = '', id = '', disabled = false } = {}) {
  const v = HHMM.test(value ?? '') ? value : '';
  const text = v ? fmtClock(v) : placeholder || 'Time';
  return `<button type="button" class="field-btn time-field${v ? '' : ' is-empty'}${className ? ` ${esc(className)}` : ''}" data-time-field${attr('id', id)}${attr('name', name)} value="${v}"${HHMM.test(base ?? '') ? ` data-base="${base}"` : ''} data-step="${Math.min(60, Math.max(5, Math.round(+step) || 15))}"${attr('data-placeholder', placeholder)}${attr('data-clear-label', clearLabel)}${attr('data-label', ariaLabel)}${ariaLabel ? attr('aria-label', `${ariaLabel}: ${text}`) : ''} aria-haspopup="dialog" aria-expanded="false"${disabled ? ' disabled' : ''}><span class="fb-label tnum">${esc(text)}</span></button>`;
}

/** Date button ('Tue, Nov 24') that opens the custom date picker. */
export function dateField({ name = '', value = '', placeholder = 'No date', allowClear = true, className = '', ariaLabel = '', id = '', disabled = false } = {}) {
  const v = YMD.test(value ?? '') ? value : '';
  const text = v ? dateText(v) : placeholder;
  return `<button type="button" class="field-btn date-field${v ? '' : ' is-empty'}${className ? ` ${esc(className)}` : ''}" data-date-field${attr('id', id)}${attr('name', name)} value="${v}" data-placeholder="${esc(placeholder)}" data-allow-clear="${allowClear ? 'true' : 'false'}"${attr('data-label', ariaLabel)}${ariaLabel ? attr('aria-label', `${ariaLabel}: ${text}`) : ''} aria-haspopup="dialog" aria-expanded="false"${disabled ? ' disabled' : ''}>${icon('calendar', { size: 16, cls: 'fb-ic' })}<span class="fb-label">${esc(text)}</span></button>`;
}

/** Checkbox: `<button role="checkbox" class="check-field">`; `.value` is 'true' / 'false'; toggling dispatches `change`. */
export function checkField({ name = '', checked = false, label = '', className = '', ariaLabel = '', id = '', disabled = false } = {}) {
  const on = checked === true || checked === 'true';
  return `<button type="button" role="checkbox" class="check-field${className ? ` ${esc(className)}` : ''}"${attr('id', id)}${attr('name', name)} value="${on}" aria-checked="${on}"${!label && ariaLabel ? attr('aria-label', ariaLabel) : ''}${disabled ? ' disabled' : ''}><span class="cf-box">${icon('check', { size: 12, stroke: 3 })}</span>${label ? `<span class="cf-label">${esc(label)}</span>` : ''}</button>`;
}

/** iOS switch: `<button role="switch" class="switch">`; same contract as checkField. */
export function switchField({ name = '', checked = false, ariaLabel = '', labelledBy = '', id = '', disabled = false } = {}) {
  const on = checked === true || checked === 'true';
  return `<button type="button" role="switch" class="switch"${attr('id', id)}${attr('name', name)} value="${on}" aria-checked="${on}"${attr('aria-label', ariaLabel)}${attr('aria-labelledby', labelledBy)}${disabled ? ' disabled' : ''}><span></span></button>`;
}

/** Update any custom field's value and label without dispatching events. `opts.base` re-anchors a time field. */
export function setFieldValue(el, value, { base } = {}) {
  if (!el) return;
  if (el.matches('[data-select]')) {
    const v = String(value ?? '');
    const cur = readOptions(el).find((o) => o.value === v);
    el.value = cur ? v : '';
    $('.fb-label', el).innerHTML = selectLabel(cur, el.dataset.placeholder);
    fieldLabel(el, cur ? cur.label : el.dataset.placeholder);
  } else if (el.matches('[data-time-field]')) {
    if (base !== undefined) {
      if (HHMM.test(base || '')) el.dataset.base = base;
      else delete el.dataset.base;
    }
    const v = HHMM.test(value ?? '') ? value : '';
    el.value = v;
    const text = v ? fmtClock(v) : el.dataset.placeholder || 'Time';
    $('.fb-label', el).textContent = text;
    el.classList.toggle('is-empty', !v);
    fieldLabel(el, text);
  } else if (el.matches('[data-date-field]')) {
    const v = YMD.test(value ?? '') ? value : '';
    el.value = v;
    const text = v ? dateText(v) : el.dataset.placeholder;
    $('.fb-label', el).textContent = text;
    el.classList.toggle('is-empty', !v);
    fieldLabel(el, text);
  } else if (el.matches('[role="checkbox"], [role="switch"]')) {
    const on = value === true || value === 'true';
    el.value = String(on);
    el.setAttribute('aria-checked', String(on));
  }
}

function commitField(el, value) {
  const before = el.value;
  setFieldValue(el, value);
  if (el.value !== before) fire(el);
}

function openSelectField(btn) {
  const opts = readOptions(btn);
  btn.setAttribute('aria-expanded', 'true');
  openMenu(
    btn,
    opts.map((o) => ({
      label: o.label,
      icon: o.color ? undefined : o.icon,
      iconHtml: o.color ? optionLead(o) : undefined,
      hint: o.hint ? `<span class="hint-text">${esc(o.hint)}</span>` : '',
      checked: o.value === btn.value,
      onSelect: () => commitField(btn, o.value),
    })),
    { minWidth: btn.offsetWidth, className: 'select-pop', label: btn.dataset.label || '', onClose: () => btn.setAttribute('aria-expanded', 'false') },
  );
}

/**
 * Google Calendar-style time list. opts: { value, base, step, allowClear, clearLabel, label, onPick(hhmm|''), onClose }
 */
export function openTimePicker(anchor, { value = '', base = '', step = 15, allowClear = false, clearLabel = 'No time', label = 'Choose a time', onPick, onClose } = {}) {
  const v = HHMM.test(value ?? '') ? value : '';
  const b = HHMM.test(base ?? '') ? base : '';
  const st = Math.min(60, Math.max(5, Math.round(+step) || 15));
  const from = b ? toMinutes(b) : 0;
  const times = [];
  for (let m = from; m < 1440; m += st) times.push(fromMinutes(m));
  if (v && !times.includes(v) && (!b || v >= b)) {
    times.push(v);
    times.sort();
  }
  // Combobox pattern: focus stays in the input; aria-activedescendant names the highlighted row, which is
  // also the one with aria-selected="true". `.sel` marks the current value.
  const lid = `tp${++gid}`;
  const row = (t, i) =>
    `<button type="button" class="menu-item tp-row${t === v ? ' sel' : ''}" role="option" id="${lid}-${i}" aria-selected="false" data-t="${t}" tabindex="-1"><span class="tnum">${esc(fmtClock(t))}</span>${b ? `<span class="tp-dur">(${durationLabel(toMinutes(t) - from)})</span>` : ''}</button>`;
  const touch = coarse();
  return openPopover(
    anchor,
    `<div class="timepicker">
      <div class="tp-type"><input type="text" class="input" role="combobox" aria-expanded="true" aria-controls="${lid}" aria-autocomplete="list" placeholder="Type a time" aria-label="Type a time" autocomplete="off" spellcheck="false" value="${v ? esc(fmtClock(v)) : ''}"></div>
      <div class="tp-list" id="${lid}" role="listbox" aria-label="${esc(label)}">
        ${allowClear ? `<button type="button" class="menu-item tp-row tp-clear" role="option" id="${lid}-clear" aria-selected="false" data-t="" tabindex="-1">${esc(clearLabel)}</button>` : ''}
        ${times.map(row).join('')}
      </div>
    </div>`,
    {
      className: 'tp-pop',
      label,
      focus: false,
      sheet: true,
      minWidth: anchor instanceof Element ? Math.min(anchor.offsetWidth, 260) : 0,
      onClose,
      onMount: (el, close) => {
        const input = $('input', el);
        const listEl = $('.tp-list', el);
        const rows = $$('.tp-row:not(.tp-clear)', el);
        let hl = rows.findIndex((r) => r.dataset.t === v);
        let dirty = false;
        const pick = (t) => {
          close();
          onPick?.(t);
        };
        const unmark = () => {
          const prev = rows[hl];
          if (prev) {
            prev.classList.remove('hl');
            prev.setAttribute('aria-selected', 'false');
          }
          hl = -1;
          input.removeAttribute('aria-activedescendant');
        };
        // Scroll a row to the middle of the list, snapped to whole rows: the top row is never cut in half
        // under the "Type a time" field.
        const centre = (r) => {
          const rh = r.offsetHeight || 1;
          listEl.scrollTop = Math.max(0, Math.round((r.offsetTop - listEl.clientHeight / 2 + rh / 2) / rh) * rh);
        };
        const mark = (i, center = false) => {
          unmark();
          hl = Math.max(0, Math.min(rows.length - 1, i));
          const r = rows[hl];
          if (!r) return;
          r.classList.add('hl');
          r.setAttribute('aria-selected', 'true');
          input.setAttribute('aria-activedescendant', r.id);
          if (center) centre(r);
          else r.scrollIntoView({ block: 'nearest' });
        };
        const nearest = (t) => {
          const i = rows.findIndex((r) => r.dataset.t >= t);
          return i < 0 ? rows.length - 1 : i;
        };
        // Scroll to the value, else to now (or the start of the list when anchored to a base time).
        const nowHHMM = `${pad(new Date().getHours())}:${pad(Math.floor(new Date().getMinutes() / st) * st)}`;
        if (hl >= 0) mark(hl, true);
        else if (rows.length) {
          centre(rows[b ? 0 : nearest(nowHHMM)]);
          hl = -1;
        }
        if (!touch) {
          input.focus({ preventScroll: true });
          input.select();
        }
        listEl.addEventListener('click', (e) => {
          const r = e.target.closest('[data-t]');
          if (r) pick(r.dataset.t);
        });
        input.addEventListener('input', () => {
          dirty = true;
          const t = parseTimeInput(input.value, { base: b });
          if (t) mark(nearest(t), true);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            dirty = false;
            mark(hl < 0 ? 0 : hl + (e.key === 'ArrowDown' ? 1 : -1));
            if (rows[hl]) input.value = fmtClock(rows[hl].dataset.t);
          } else if (e.key === 'Tab' && !e.shiftKey) {
            // Like a native field, Tab keeps the time typed or arrowed to here, then goes on to the next field.
            const typed = input.value.trim();
            if (dirty && !typed && allowClear) return v && pick('');
            const t = dirty ? parseTimeInput(typed, { base: b }) : rows[hl]?.dataset.t;
            if (t && t !== v && (!b || t >= b)) pick(t);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const typed = input.value.trim();
            if (!typed && allowClear) return pick('');
            const t = dirty ? parseTimeInput(typed, { base: b }) : rows[hl]?.dataset.t || parseTimeInput(typed, { base: b });
            if (t && (!b || t >= b)) pick(t);
            else input.select();
          }
        });
        // A row can hold focus (pressed and dragged off, or moved there by assistive tech): arrows move
        // between rows, up from the first returns to the input, and the highlight follows focus.
        listEl.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const opts = $$('.tp-row', el);
          const j = opts.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
          if (j < 0) return input.focus();
          opts[Math.min(opts.length - 1, j)]?.focus();
        });
        listEl.addEventListener('focusin', (e) => {
          const i = rows.indexOf(e.target);
          if (i >= 0) mark(i);
          else if (e.target.classList?.contains('tp-clear')) unmark();
        });
      },
    },
  );
}

function openTimeField(btn) {
  btn.setAttribute('aria-expanded', 'true');
  openTimePicker(btn, {
    value: btn.value,
    base: btn.dataset.base || '',
    step: +btn.dataset.step || 15,
    allowClear: !!(btn.dataset.placeholder || btn.dataset.clearLabel),
    clearLabel: btn.dataset.clearLabel || btn.dataset.placeholder || 'No time',
    label: btn.dataset.label || 'Choose a time',
    onPick: (t) => commitField(btn, t),
    onClose: () => btn.setAttribute('aria-expanded', 'false'),
  });
}

function openDateField(btn) {
  btn.setAttribute('aria-expanded', 'true');
  openDatePicker(btn, {
    value: btn.value || null,
    title: btn.dataset.label || 'Choose a date',
    allowClear: btn.dataset.allowClear !== 'false',
    clearLabel: btn.dataset.placeholder || 'No date',
    onPick: ({ date }) => commitField(btn, date || ''),
    onClose: () => btn.setAttribute('aria-expanded', 'false'),
  });
}

/**
 * Custom autocomplete under a text input (replaces <datalist>). Focus never leaves the input.
 * getItems(query) → [string | {value, label?, icon?, hint?}]. Arrow keys move, Enter / click picks.
 * opts: { onPick(value, item), max = 8, minChars = 1, autoHighlight = false }. `autoHighlight` (a boolean,
 * or a function of the items) highlights the first item on each refresh, so Enter takes it.
 * Returns { close, refresh, destroy }.
 */
export function attachSuggest(input, getItems, { onPick, max = 8, minChars = 1, autoHighlight = false } = {}) {
  const listId = `sg${++gid}`;
  let pop = null;
  let items = [];
  let hl = -1;
  let picking = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('autocomplete', 'off');
  const close = () => pop?.close();
  const setHl = (i) => {
    hl = i;
    if (!pop) return;
    $$('.menu-item', pop.el).forEach((b, j) => {
      b.classList.toggle('hl', j === hl);
      b.setAttribute('aria-selected', String(j === hl));
      if (j === hl) b.scrollIntoView({ block: 'nearest' });
    });
    if (hl >= 0) input.setAttribute('aria-activedescendant', `${listId}-${hl}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return;
    input.value = it.value;
    close();
    picking = true;
    try {
      fire(input);
    } finally {
      picking = false;
    }
    onPick?.(it.value, it);
  };
  const refresh = () => {
    const q = input.value;
    let raw = [];
    if (q.trim().length >= minChars) {
      try {
        raw = getItems(q) || [];
      } catch (err) {
        console.error('ecosys: suggestions failed', err);
      }
    }
    items = (Array.isArray(raw) ? raw : [])
      .map((x) => (x && typeof x === 'object' ? { value: String(x.value ?? ''), label: String(x.label ?? x.value ?? ''), icon: x.icon, hint: x.hint } : { value: String(x), label: String(x) }))
      .filter((x) => x.value)
      .slice(0, max);
    if (!items.length) return close();
    const body = items
      .map((it, i) => `<button type="button" class="menu-item" role="option" id="${listId}-${i}" data-s="${i}" tabindex="-1" aria-selected="false">${it.icon ? icon(String(it.icon), { size: 16 }) : ''}<span class="grow truncate">${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</button>`)
      .join('');
    if (!pop) {
      pop = openPopover(input, `<div class="suggest" role="listbox" id="${listId}"></div>`, {
        className: 'suggest-pop',
        role: '',
        focus: false,
        restoreFocus: false,
        toggle: false,
        minWidth: Math.min(input.offsetWidth, 320),
        onClose: () => {
          pop = null;
          hl = -1;
          input.setAttribute('aria-expanded', 'false');
          input.removeAttribute('aria-activedescendant');
        },
        onMount: (el) => {
          el.addEventListener('pointerdown', (e) => e.preventDefault());
          el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-s]');
            if (b) pick(+b.dataset.s);
          });
        },
      });
      input.setAttribute('aria-expanded', 'true');
    }
    $('.suggest', pop.el).innerHTML = body;
    pop.reposition();
    let first = false;
    try {
      first = !!(typeof autoHighlight === 'function' ? autoHighlight(items) : autoHighlight);
    } catch (err) {
      console.error('ecosys: suggestion highlight failed', err);
    }
    setHl(first ? 0 : -1);
  };
  const onInput = () => !picking && refresh();
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!pop) {
        if (e.key === 'ArrowDown') refresh();
        if (!pop) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return setHl(0);
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const n = items.length;
      setHl(e.key === 'ArrowDown' ? (hl + 1) % n : hl <= 0 ? n - 1 : hl - 1);
    } else if (e.key === 'Enter' && pop && hl >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(hl);
    } else if (e.key === 'Tab') close();
  };
  const onBlur = () => setTimeout(() => document.activeElement !== input && close());
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey, true);
  input.addEventListener('blur', onBlur);
  return {
    close,
    refresh,
    destroy() {
      close();
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey, true);
      input.removeEventListener('blur', onBlur);
    },
  };
}

/** Grow a textarea to fit its content (textareas never show the native resize grip). */
export function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
}

function initFields() {
  document.addEventListener('click', (e) => {
    const t = e.target;
    const f = t.closest?.('[data-select], [data-time-field], [data-date-field], .check-field, button.switch[role="switch"]');
    if (!f || f.disabled) return;
    if (f.matches('[data-select]')) openSelectField(f);
    else if (f.matches('[data-time-field]')) openTimeField(f);
    else if (f.matches('[data-date-field]')) openDateField(f);
    else commitField(f, f.getAttribute('aria-checked') !== 'true');
  });
  document.addEventListener('keydown', (e) => {
    if (!(e.key === 'ArrowDown' || e.key === 'ArrowUp') || e.metaKey || e.ctrlKey) return;
    const f = e.target.closest?.('[data-select], [data-time-field], [data-date-field]');
    if (!f || f.disabled || f.getAttribute('aria-expanded') === 'true') return;
    e.preventDefault();
    f.click();
  });
  document.addEventListener('input', (e) => {
    if (e.target.matches?.('textarea[data-autosize]')) autosize(e.target);
  });
}

// ---------------------------------------------------------------- app switcher (Proton)

export function switcherButton() {
  return `<button type="button" class="icon-btn" data-app-switcher aria-label="Switch app" aria-haspopup="dialog" aria-expanded="false" data-tip="Apps">${icon('apps', { size: 20 })}</button>`;
}

export function openSwitcher(anchor, current = currentApp) {
  const btn = anchor instanceof Element ? anchor : null;
  btn?.setAttribute('aria-expanded', 'true');
  const tiles = APPS.map(
    (a) => `<a class="switcher-app" href="${esc(a.url)}"${a.id === current ? ' aria-current="page"' : ''}>
      <span class="app-icon">${appIcon(a.id)}</span><span class="truncate">${esc(a.name)}</span></a>`,
  ).join('');
  // AI is listed like the apps, as on Home. It has no page of its own: it opens Connect AI. ui.css lays the
  // five out in one row, like Home's.
  const ai = `<button type="button" class="switcher-app" data-switch-ai aria-haspopup="dialog">
      <span class="app-icon">${appIcon('ai')}</span><span class="truncate">AI<span class="sr-only"> assistants</span></span></button>`;
  return openPopover(anchor, `<nav class="switcher-grid" aria-label="ecosys apps">${tiles}${ai}</nav>`, {
    className: 'switcher',
    label: 'Apps',
    focus: false,
    onClose: () => btn?.setAttribute('aria-expanded', 'false'),
    onMount: (el, close) => {
      el.querySelector('[data-switch-ai]').addEventListener('click', () => {
        close();
        openAI();
      });
      const links = $$('.switcher-app', el);
      (links.find((a) => a.hasAttribute('aria-current')) || links[0])?.focus({ preventScroll: true });
      el.addEventListener('keydown', (e) => {
        const i = links.indexOf(document.activeElement);
        if (i < 0 || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
        e.preventDefault();
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
        links[(i + d + links.length) % links.length].focus();
      });
    },
  });
}

export function sidebarHead(appId) {
  const app = APPS.find((a) => a.id === appId) || APPS[0];
  return `<div class="side-head">
    <button type="button" class="brand-btn" data-app-menu aria-label="${esc(app.name)} menu" aria-haspopup="menu" aria-expanded="false">
      <span class="app-icon">${appIcon(app.id, { small: true })}</span><span class="truncate">${esc(app.name.toLowerCase())}</span>${icon('chevron-down', { size: 15 })}
    </button>
    <span class="grow"></span>
    ${switcherButton()}
  </div>`;
}

/** The brand menu (Todoist keeps settings and data under the account menu). */
export function openAppMenu(anchor) {
  anchor.setAttribute('aria-expanded', 'true');
  openMenu(
    anchor,
    [
      { label: 'Settings', icon: 'gear', keys: 'comma', onSelect: () => openSettings() },
      { label: 'Search', icon: 'search', keys: 'mod K', onSelect: () => openPalette() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', keys: '?', className: 'hover-only', onSelect: () => openShortcuts() },
      { sep: true },
      { label: 'Connect AI…', icon: 'ai', onSelect: () => openAI() },
      { label: 'Export backup', icon: 'download', onSelect: () => downloadBackup() },
    ],
    { label: 'App menu', onClose: () => anchor.setAttribute('aria-expanded', 'false') },
  );
}

// Completion chime (Microsoft To Do's signature sound), synthesised so there's no audio file.
let audioCtx = null;
export function playDing() {
  if (!settings.get()?.completionSound) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    for (const [freq, delay] of [
      [987.8, 0],
      [1318.5, 0.075],
    ]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.08, t + delay + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.42);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.45);
    }
  } catch {
    /* audio not available */
  }
}

/** @deprecated The apps put these in the brand menu; kept so older pages keep working. */
export function sidebarFoot() {
  return `<div class="side-foot">
    <button type="button" class="icon-btn" data-open-settings aria-label="Settings" ${tipAttrs('Settings', ',')}>${icon('gear')}</button>
    <button type="button" class="icon-btn" data-open-shortcuts aria-label="Keyboard shortcuts" ${tipAttrs('Keyboard shortcuts', '?')}>${icon('keyboard')}</button>
    <span class="grow"></span>
    <button type="button" class="btn btn-ghost btn-sm" data-open-palette aria-label="Search">${icon('search', { size: 15 })}${keys('mod K')}</button>
  </div>`;
}

// ---------------------------------------------------------------- command palette

const paletteProviders = [];
const sharedProviders = [];
/**
 * provider(query) → [{group, label, sub?, words?, icon?, iconHtml?, keys?, hint?, fallback?, replaces?, run}]
 * Results are listed group by group, in the order the groups first appear. `fallback: true` items
 * (e.g. 'Create event “q”') come after every other result, built-in commands included. A result with
 * both `keys` and `hint` shows both, the shortcut first. A row with no `sub` line, or with `words` (other
 * names for it), is a command: one the query names is listed first (see collectResults). Content (a task,
 * event or note) has a sub line.
 * `replaces` names the shared commands an app's result stands in for, which are then left out:
 * 'new-note', 'quick-note' or 'today-note' (one, or an array), e.g. a day-note command when its day is today.
 */
export function registerPaletteProvider(fn, { prepend = false } = {}) {
  if (prepend) paletteProviders.unshift(fn);
  else paletteProviders.push(fn);
}

// The query's words, split once per query (score() is called for every record on every keystroke).
let termsFor = '';
let termsCache = [];
const termsOf = (q) => {
  const s = String(q ?? '');
  if (s !== termsFor) {
    termsFor = s;
    termsCache = s.toLowerCase().split(/\s+/).filter(Boolean);
  }
  return termsCache;
};
/** How well lower-case text matches every term: 3 a term it starts with, 2 one that starts a word, 1 one inside a word. */
function scoreTerms(low, terms) {
  let s = 0;
  for (const term of terms) {
    const i = low.indexOf(term);
    if (i < 0) return 0;
    s += i === 0 ? 3 : low[i - 1] === ' ' ? 2 : 1;
  }
  return s;
}

/** How well `text` matches every word of `q` (0: not all of them); 1 for an empty query. */
export function score(text, q) {
  if (!q) return 1;
  return scoreTerms(String(text ?? '').toLowerCase(), termsOf(q));
}

/** score() for text that is already in lower case, such as searchText()'s: nothing is lowercased again. */
export function scoreLower(low, q) {
  if (!q) return 1;
  return scoreTerms(String(low ?? ''), termsOf(q));
}

// Lower-case search text per record. The store gives an edited record a new object, so a WeakMap keyed by it
// never serves an old title; the fields it was built from are compared as well (a list renamed, a field changed
// in place), and anything else builds it again.
const searchCache = new WeakMap();
/**
 * The lower-case text a record is searched by: `build()` once, then cached for the record while every value
 * in `deps` (the fields build reads, compared with ===) stays the same. For a palette provider, which
 * scores every task, event or note on each keystroke: scoreLower(taskSearchText(t, listName), q), or for
 * other text scoreLower(searchText(rec, [rec.a, rec.b], () => `${rec.a} ${rec.b}`), q).
 */
export function searchText(rec, deps, build) {
  if (!rec || typeof rec !== 'object') return String(build() ?? '').toLowerCase();
  const d = Array.isArray(deps) ? deps : [deps];
  const hit = searchCache.get(rec);
  if (hit && hit.deps.length === d.length && hit.deps.every((x, i) => x === d[i])) return hit.low;
  const low = String(build() ?? '').toLowerCase();
  searchCache.set(rec, { deps: d, low });
  return low;
}
/** What a task is searched by, in lower case: its title, notes, labels and list name (cached, see searchText). */
export function taskSearchText(t, listName = '') {
  const list = String(listName ?? '');
  return searchText(t, [t?.title, t?.notes, t?.tags, list], () => `${t?.title ?? ''} ${t?.notes ?? ''} ${(Array.isArray(t?.tags) ? t.tags : []).join(' ')} ${list}`);
}
/** What an event is searched by, in lower case: its title, location and notes (cached, see searchText). */
export function eventSearchText(e) {
  return searchText(e, [e?.title, e?.location, e?.notes], () => `${e?.title ?? ''} ${e?.location ?? ''} ${e?.notes ?? ''}`);
}

/** Items of a group together, groups in the order they first appear (the palette heads each group once). */
function byGroup(items) {
  const groups = new Map();
  for (const it of items) {
    const k = String(it.group ?? '');
    if (groups.has(k)) groups.get(k).push(it);
    else groups.set(k, [it]);
  }
  return [...groups.values()].flat();
}

// A shared command (its id is kept under this key) that the app lists itself appears once, as the app's.
// The app says so with `replaces`. Failing that, an app command (no sub line) with the same name under the
// same heading counts, like an app's own "Open today's note" under Notes. Names are only compared within a heading,
// so user content under another one, such as a tasks list named "Quick note" under Go to, never hides one.
const SHARED_COMMAND = Symbol('shared command');
const commandKey = (x) => `${String(x.group ?? '')}\n${String(x.label ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/^open\s+/, '').trim()}`;

// Set on a built-in or shared command that the query names (see namesCommand).
const NAMED = Symbol('named command');
const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/**
 * Does the query name this command? Every typed word starts a word of its label ("connect ai" for
 * "Connect AI…"), or, from three letters on, one of its keywords ("claude", "dark"). Such commands are
 * listed before results that merely mention the words, like a note that talks about Claude.
 */
function namesCommand(q, label, words = '') {
  const terms = wordsOf(q);
  if (!terms.length || String(q).trim().length < 2) return false;
  const named = wordsOf(label);
  const extra = wordsOf(words);
  return terms.every((t) => named.some((w) => w.startsWith(t)) || (t.length >= 3 && extra.some((w) => w.startsWith(t))));
}
// An app's row is one of its commands when it has no sub line (its content, a task, event or note, always
// has one) or when it lists `words`. The query echoed in a catch-all row ('New note “q”') names nothing.
const appNames = (q, x) => (!x.sub || x.words != null) && namesCommand(q, String(x.label ?? '').replace(/“[^”]*”/g, ' '), x.words);

/**
 * Results in their final order. Groups keep the order they first appear in, except that a group holding a
 * command the query names moves ahead of groups that only have matching content. Within that come the
 * current app's commands the query names ("today" is Tasks' Today, not Today's note), then the built-in
 * and shared ones it names ("keyboard shortcuts", "connect ai", "dark"), then the rest of the app's results
 * (its tasks, events or notes), then everything else (other apps' content, other built-in commands), and
 * `fallback` results (e.g. 'Create event “q”') last.
 */
function collectResults(q) {
  const out = [];
  const rank = new Map();
  const replaced = new Set();
  const appCommands = new Set();
  for (const p of [...paletteProviders, ...sharedProviders, builtinProvider]) {
    const fromApp = paletteProviders.includes(p);
    try {
      const r = p(q);
      if (!Array.isArray(r)) continue;
      for (const x of r) {
        if (!x || typeof x.run !== 'function') continue;
        if (fromApp) {
          for (const id of [x.replaces].flat()) if (typeof id === 'string') replaced.add(id);
          if (!x.sub) appCommands.add(commandKey(x));
        } else if (x[SHARED_COMMAND] && (replaced.has(x[SHARED_COMMAND]) || appCommands.has(commandKey(x)))) continue;
        out.push(x);
        rank.set(x, fromApp && appNames(q, x) ? 0 : x[NAMED] ? 1 : fromApp ? 2 : 3);
      }
    } catch (err) {
      console.error('ecosys: a search provider failed', err);
    }
  }
  const main = out.filter((x) => !x.fallback);
  const groups = new Map();
  for (const x of main) {
    const k = String(x.group ?? '');
    const g = groups.get(k) || { first: groups.size, best: 4, items: [] };
    g.best = Math.min(g.best, rank.get(x));
    g.items.push(x);
    groups.set(k, g);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => a.best - b.best || a.first - b.first)
    .flatMap((g) => g.items.map((x, i) => [x, i]).sort(([x, i], [y, j]) => rank.get(x) - rank.get(y) || i - j).map(([x]) => x));
  return [...ordered, ...byGroup(out.filter((x) => x.fallback))];
}

export function openPalette(initial = '') {
  if ($('.palette')) return;
  let results = [];
  let hl = 0;
  const listId = `pal${++gid}`;
  const { el, close } = openModal({
    className: 'palette',
    label: 'Search and commands',
    body: `<div class="palette-input">${icon('search')}<input type="text" placeholder="Search or type a command" autocomplete="off" spellcheck="false" value="${esc(initial)}" role="combobox" aria-expanded="true" aria-controls="${listId}" aria-autocomplete="list" aria-label="Search and commands" data-autofocus><button type="button" class="palette-esc" data-close aria-label="Close">${keys('esc')}</button><button type="button" class="palette-cancel" data-close>Cancel</button></div>
      <div class="palette-list" id="${listId}" role="listbox" aria-label="Results"></div>
      <div class="sr-only" role="status" aria-live="polite" data-pal-count></div>`,
  });
  const input = $('input', el);
  const list = $('.palette-list', el);
  // How many results there are, said once typing pauses (not on every keystroke).
  const countEl = $('[data-pal-count]', el);
  let countTimer = 0;
  const sayCount = (text) => {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      if (countEl.textContent !== text) countEl.textContent = text;
    }, 450);
  };
  const setHl = (i) => {
    hl = Math.max(0, Math.min(results.length - 1, i));
    for (const b of $$('[data-r]', list)) {
      const on = +b.dataset.r === hl;
      b.classList.toggle('hl', on);
      b.setAttribute('aria-selected', String(on));
      if (on) b.scrollIntoView({ block: 'nearest' });
    }
    if (results.length) input.setAttribute('aria-activedescendant', `${listId}-${hl}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    const q = input.value.trim();
    results = collectResults(q);
    sayCount(!q ? '' : results.length ? plural(results.length, 'result') : 'No results');
    if (!results.length) {
      list.innerHTML = `<div class="palette-empty">No results for “${esc(q)}”</div>`;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastGroup = null;
    list.innerHTML = results
      .map((r, i) => {
        const head = r.group !== lastGroup ? `<div class="menu-label" role="presentation">${esc(r.group)}</div>` : '';
        lastGroup = r.group;
        // The shortcut (one that works: see liveKeys), then the hint (e.g. the ↗ of a result that opens another
        // app), when there are both.
        const hint = `${keys(liveKeys(r.keys))}${r.hint || ''}`;
        return `${head}<button type="button" class="menu-item" id="${listId}-${i}" data-r="${i}" role="option" aria-selected="false" tabindex="-1">
          <span class="pal-lead">${r.iconHtml || icon(r.icon || 'arrow-right', { size: 18 })}</span>
          <span class="grow truncate">${esc(r.label)}${r.sub ? `<span class="pal-sub">${esc(r.sub)}</span>` : ''}</span>
          ${hint ? `<span class="hint">${hint}</span>` : ''}
        </button>`;
      })
      .join('');
    setHl(0);
  };
  const run = (i) => {
    const r = results[i];
    if (!r) return;
    close();
    r.run();
  };
  // With a large library the results are drawn once typing pauses, not on every key: each draw scores every
  // task, event and note. Enter and the arrows always act on the results for what is typed.
  const large = () => all('tasks').length + all('events').length + all('notes').length > 2000;
  let pending = 0;
  const renderNow = () => {
    if (!pending) return;
    clearTimeout(pending);
    pending = 0;
    render();
  };
  input.addEventListener('input', () => {
    clearTimeout(pending);
    pending = 0;
    if (!large()) return render();
    pending = setTimeout(() => {
      pending = 0;
      if (document.contains(input)) render();
    }, 50);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') renderNow();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) setHl(e.key === 'ArrowDown' ? (hl + 1) % results.length : (hl - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(hl);
    }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (b) run(+b.dataset.r);
  });
  list.addEventListener('pointermove', (e) => {
    const b = e.target.closest('[data-r]');
    if (b && +b.dataset.r !== hl) setHl(+b.dataset.r);
  });
  render();
}

// Cross-app search: tasks, events and notes from the shared store, opened in their own app.
const deepLink = (app, path) => `${BASE}${app}/#/${path}`;
const outIcon = () => `<span class="pal-out" aria-hidden="true">${icon('arrow-up-right', { size: 14 })}</span>`;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function searchTasks(q) {
  if (!q) return [];
  const terms = termsOf(q);
  const lists = new Map(all('lists').map((l) => [l.id, l]));
  const hits = [];
  for (const t of all('tasks')) {
    if (!t || !isId(t.id)) continue;
    const s = scoreTerms(taskSearchText(t, lists.get(t.listId)?.name), terms);
    if (s) hits.push({ t, s });
  }
  return hits
    .sort((a, b) => !!a.t.done - !!b.t.done || b.s - a.s)
    .slice(0, 5)
    .map(({ t }) => ({
      group: 'Tasks',
      label: String(t.title || 'Untitled task'),
      sub: t.done ? 'Completed' : YMD.test(t.date ?? '') ? dayLabel(t.date) : String(lists.get(t.listId)?.name ?? 'Inbox'),
      icon: t.done ? 'check-circle' : 'circle',
      hint: outIcon(),
      run: () => (location.href = deepLink('tasks', `task/${encodeURIComponent(t.id)}`)),
    }));
}

function searchEvents(q) {
  if (!q) return [];
  const terms = termsOf(q);
  const today = todayYmd();
  const cals = new Map(all('calendars').map((c) => [c.id, c]));
  const hits = [];
  for (const e of all('events')) {
    if (!e || !isId(e.id) || typeof e.start !== 'string' || !YMD.test(e.start.slice(0, 10))) continue;
    const s = scoreTerms(eventSearchText(e), terms);
    if (s) hits.push({ e, s });
  }
  return hits
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map(({ e }) => {
      const start = e.start.slice(0, 10);
      let date = start;
      if (e.repeat && typeof e.repeat === 'object') {
        try {
          const end = typeof e.end === 'string' && YMD.test(e.end.slice(0, 10)) ? e.end.slice(0, 10) : start;
          const span = Math.max(0, diffDays(start, end));
          date = occurrencesBetween(e.repeat, start, addDaysYmd(today, -span), addDaysYmd(today, 400), { exdates: Array.isArray(e.exdates) ? e.exdates : [], until: YMD.test(e.until ?? '') ? e.until : null })[0] || start;
        } catch {
          date = start;
        }
      }
      const time = !e.allDay && HHMM.test(e.start.slice(11, 16)) ? ` ${fmtClock(e.start.slice(11, 16))}` : '';
      const color = cssColor(cals.get(e.calendarId)?.color) || 'var(--c-iris)';
      return {
        group: 'Events',
        label: String(e.title || 'Untitled event'),
        sub: `${dayLabel(date)}${time}${e.repeat ? ', repeats' : ''}`,
        iconHtml: `<span class="swatch-dot" style="background:${color}"></span>`,
        hint: outIcon(),
        run: () => (location.href = deepLink('schedule', `day/${date}/event/${encodeURIComponent(e.id)}`)),
      };
    });
}

/** Plain text of a block's runs ([text, marks?, attrs?]; a chip's text is its label, '\n' a soft line break). */
const runsText = (c) => (Array.isArray(c) ? c.map((r) => (Array.isArray(r) ? String(r[0] ?? '') : typeof r === 'string' ? r : '')).join('') : '');

// A note's title and plain-text lines, the line that repeats the title left out, cached per note until its
// title or text changes (with `low`, that text in lower case, once a search has needed it). Notes keep their
// text in blocks (notes/core/schema.js; `body` is ''), one line per line of each block, as the notes list reads them. Older notes have an HTML body: htmlToText decodes it
// (list bullets dropped), but it runs the sanitizer, which is too slow to repeat on every keystroke.
const noteCache = new WeakMap();
function noteText(n) {
  const src = Array.isArray(n.blocks) && n.blocks.length ? n.blocks : String(n.body ?? n.html ?? n.content ?? n.text ?? '');
  const hit = noteCache.get(n);
  if (hit && hit.src === src && hit.rawTitle === n.title) return hit;
  let lines = [];
  try {
    lines = (Array.isArray(src) ? src.flatMap((b) => (b && b.t !== 'hr' ? runsText(b.c).split('\n') : [])) : htmlToText(src).split('\n').map((l) => l.replace(/^- /, '')))
      .map(oneLine)
      .filter(Boolean);
  } catch {
    lines = [];
  }
  const named = clip(oneLine(n.title) || (lines[0] || '').split(/(?<=[.!?])\s/)[0] || '');
  if (named && lines[0] && lines[0].slice(0, named.length).toLowerCase() === named.toLowerCase()) {
    const rest = lines[0].slice(named.length).trim();
    lines = rest ? [rest, ...lines.slice(1)] : lines.slice(1);
  }
  // An empty note is listed as "New Note" (as in Notes), but that placeholder is not searchable text.
  const entry = { src, rawTitle: n.title, title: named || 'New Note', lines, text: `${named} ${lines.join(' ')}`, low: null };
  noteCache.set(n, entry);
  return entry;
}

/** `s.slice(from, from + len)` that never splits a surrogate pair (an emoji) at either end. */
function clip(s, from = 0, len = 120) {
  let a = from;
  let b = Math.min(s.length, from + len);
  if (/[\uDC00-\uDFFF]/.test(s[a] || '')) a += 1;
  if (b < s.length && /[\uD800-\uDBFF]/.test(s[b - 1] || '')) b -= 1;
  return s.slice(a, b);
}

/** About a line's worth of `line`, starting a little before the first of `terms` so the match shows. */
function snippet(line, terms) {
  const low = line.toLowerCase();
  const at = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(at) || at < 40) return clip(line);
  const space = line.lastIndexOf(' ', at - 12);
  return `…${clip(line, space > at - 40 ? space + 1 : at - 12)}`;
}

const edited = (n) => (Number.isFinite(n.editedAt) ? n.editedAt : 0) || (Number.isFinite(n.updatedAt) ? n.updatedAt : 0);
function searchNotes(q) {
  if (!q) return [];
  const terms = termsOf(q);
  const hits = [];
  for (const n of all('notes')) {
    if (!n || !isId(n.id) || n.trashed || n.deletedAt || n.trashedAt) continue;
    const t = noteText(n);
    t.low ??= t.text.toLowerCase(); // kept with the note's text (a long note is lowercased once, not per key)
    const s = scoreTerms(t.low, terms);
    if (s) hits.push({ n, t, s });
  }
  return hits
    .sort((a, b) => b.s - a.s || edited(b.n) - edited(a.n))
    .slice(0, 5)
    .map(({ n, t }) => {
      // Preview the line that matched when the title alone doesn't explain the match, else the first line.
      const title = t.title.toLowerCase();
      const rest = terms.filter((x) => !title.includes(x));
      const line = rest.length ? t.lines.find((l) => rest.some((x) => l.toLowerCase().includes(x))) : null;
      return {
        group: 'Notes',
        label: t.title,
        sub: line ? snippet(line, rest) : clip(t.lines[0] || ''),
        icon: YMD.test(n.day ?? '') ? 'calendar' : 'note',
        hint: outIcon(),
        run: () => (location.href = deepLink('notes', `n/${encodeURIComponent(n.id)}`)),
      };
    });
}

/**
 * Quick note from any app (notes-spec §7): Notes' Quick Note sheet. It is told where it was opened from
 * (`back`, this page's address), so Done or Esc brings you back here; "Open in Notes" stays in Notes.
 * Notes only goes back to a page of this ecosys (same origin, under BASE).
 */
export function openQuickNote() {
  location.href = `${deepLink('notes', 'quick')}?back=${encodeURIComponent(location.href)}`;
}

// Notes from any app (notes-spec §7). The notes app lists its own versions of these, and handles mod alt N itself.
const NOTE_COMMANDS = [
  { id: 'new-note', label: 'New note', words: 'create compose write', icon: 'edit', path: 'new' },
  { id: 'quick-note', label: 'Quick note', words: 'jot capture', icon: 'quick-note', keys: 'mod alt N', run: openQuickNote },
  { id: 'today-note', label: "Today's note", words: 'daily journal day', icon: 'today', path: 'today' },
];
function noteCommands(q) {
  if (!q) return [];
  return NOTE_COMMANDS.filter((c) => score(`${c.label} ${c.words}`, q)).map((c) => ({
    group: 'Notes',
    label: c.label,
    icon: c.icon,
    // Each opens Notes, so each gets the ↗ (Quick note after its shortcut), as other apps' content does.
    ...(c.keys ? { keys: c.keys } : {}),
    hint: outIcon(),
    run: c.run || (() => (location.href = deepLink('notes', c.path))),
    [SHARED_COMMAND]: c.id,
    [NAMED]: namesCommand(q, c.label, c.words),
  }));
}

function registerCrossAppSearch(app) {
  if (app !== 'tasks') sharedProviders.push(searchTasks);
  if (app !== 'schedule') sharedProviders.push(searchEvents);
  if (app !== 'notes') sharedProviders.push(searchNotes, noteCommands);
}

// What else each appearance is called, so "dark" finds Lights out (not all four) and "light" finds Light first.
const THEME_WORDS = { system: 'automatic auto system os device', light: 'light white bright', dim: 'dim dusk grey gray', dark: 'dark black night oled' };

// Built-in entries: other apps, appearance and settings. Listed after other results, unless the query
// names them (namesCommand): "connect ai", "export" or "dark" then come first.
function builtinProvider(q) {
  const items = [];
  for (const a of APPS) {
    if (a.id === currentApp) continue;
    const label = `Open ${a.name}`;
    if (score(`${label} ${a.blurb} switch app`, q)) items.push({ group: 'Apps', label, iconHtml: `<span class="app-icon xs">${appIcon(a.id, { small: true })}</span>`, run: () => (location.href = a.url), [NAMED]: namesCommand(q, label) });
  }
  const cmds = [
    { label: 'Settings', words: 'preferences options', icon: 'gear', keys: 'comma', run: () => openSettings() },
    { label: 'Keyboard shortcuts', words: 'keys hotkeys', icon: 'keyboard', keys: '?', run: () => openShortcuts() },
    { label: 'Connect AI…', words: 'assistant claude chatgpt grok mcp connections', iconHtml: `<span class="app-icon xs">${appIcon('ai', { small: true })}</span>`, run: () => openAI() },
    ...THEMES.map((t) => ({ label: `Appearance: ${t.name}`, words: `${THEME_WORDS[t.id] || ''} theme mode`, icon: 'contrast', run: () => settings.set({ theme: t.id }) })),
    ...ACCENTS.map((a) => ({ label: `Accent colour: ${a.name}`, words: 'color theme', iconHtml: `<span class="swatch-dot" style="background:${a.color}"></span>`, run: () => settings.set({ accent: a.id }) })),
    { label: 'Export backup', words: 'download data json', icon: 'download', run: () => downloadBackup() },
  ];
  if (q) for (const c of cmds) if (score(`${c.label} ${c.words || ''}`, q)) items.push({ group: 'Commands', ...c, [NAMED]: namesCommand(q, c.label, c.words) });
  // With nothing typed: Settings, and Keyboard shortcuts where there is a keyboard to use them (as in the app menu).
  if (!q) items.push({ group: 'Commands', ...cmds[0] }, ...(matchMedia('(hover: none)').matches ? [] : [{ group: 'Commands', ...cmds[1] }]));
  return items;
}

// ---------------------------------------------------------------- keyboard shortcuts sheet

let shortcutGroups = [];
/** groups: [{title, items:[[label, keySpec]], examples?:true}] — `examples` groups show phrases, not keycaps. */
export function registerShortcuts(groups) {
  shortcutGroups = Array.isArray(groups) ? groups : [];
}
export function openShortcuts() {
  const global = {
    title: 'Everywhere',
    items: [
      ['Search and commands', 'mod K'],
      ['Undo', 'mod Z'],
      ['Redo', isMac ? 'shift mod Z' : 'mod Y'],
      ...(currentApp === 'notes' ? [] : [['Quick note', 'mod alt N']]),
      ['Keyboard shortcuts', '?'],
      ['Settings', ','],
      ['Close or cancel', 'esc'],
    ],
  };
  const right = (spec, examples) => {
    const s = String(spec ?? '');
    const isKeys = !examples && s.split(/\s+\/\s+|\s+/).filter(Boolean).every(isKeyToken);
    return isKeys ? keys(s) : `<code class="example">${esc(s)}</code>`;
  };
  const body = [...shortcutGroups, global]
    .map((g) => `<h4>${esc(g.title)}</h4>` + (g.items || []).map(([label, spec]) => `<div class="shortcut"><span>${esc(label)}</span>${right(spec, g.examples)}</div>`).join(''))
    .join('');
  // The sheet lists every shortcut; while the one-key ones are off it says so, and where to turn them on.
  const off = singleKeys() ? '' : `<p class="muted" data-keys-off style="margin:2px 0 14px;font:var(--t-callout)">Single-key shortcuts, like E or ?, are off; shortcuts with ${MOD} keep working. Turn them back on in Settings, under Keyboard.</p>`;
  openModal({ title: 'Keyboard shortcuts', className: 'wide', body: `<div class="modal-body">${off}<div class="shortcuts">${body}</div></div>` });
}

// ---------------------------------------------------------------- settings

/**
 * The largest file Import backup reads. Export writes a backup as one string, which holds at most 2^29 − 24
 * characters in Chrome, and a character is at most 3 bytes of UTF-8 (a pair, 4 bytes, is two characters): no
 * backup Export makes is larger than this, so Import never refuses one of them for its size. That is far more
 * than the apps can hold (they keep all of their data in memory; sync sends a big import in pieces, and
 * validateSnapshot bounds every record). A larger file is refused before it is read.
 */
const MAX_BACKUP_BYTES = 3 * (2 ** 29 - 24);
// Above this a backup takes a moment to read and check, so a status says it is happening.
const BIG_BACKUP_BYTES = 2 * 1024 * 1024;
const mbText = (bytes) => {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? Math.max(0.1, Math.round(mb * 10) / 10) : Math.round(mb)} MB`;
};
// Lets a status toast paint before work that holds the page for a moment.
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/**
 * Export backup: everything (tasks, lists, events, calendars, notes, folders and settings) as one JSON file.
 * Compact JSON: indenting it made backups about 80% larger, and Import reads both.
 */
export function downloadBackup() {
  let blob;
  try {
    blob = new Blob([JSON.stringify(store.exportData())], { type: 'application/json' });
  } catch (err) {
    // More than one string can hold (RangeError), or out of memory: say so rather than fail without a word.
    console.error('ecosys: could not make a backup', err);
    return toast('Couldn’t make a backup: there is more data than this browser can write to one file.', { duration: 10000 });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ecosys-backup-${todayYmd()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000); // a large file can take a while to save
  // Said when it is made, not when it is needed (MAX_BACKUP_BYTES makes this all but impossible).
  if (blob.size > MAX_BACKUP_BYTES) toast(`Backup downloaded, but at ${mbText(blob.size)} it is more than ecosys can import (${mbText(MAX_BACKUP_BYTES)}).`, { duration: 10000 });
  else toast('Backup downloaded');
}

const syncOnline = () => !!(syncModule?.syncState?.online ?? window.ecosysSync?.online);
const andList = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
/**
 * Where an import, reset or erase lands, for its confirm dialog. While the ecosys app is reachable (or
 * reconnecting, with the change queued for it) the change reaches every open app and connected AI assistant.
 */
function dataReach() {
  const s = syncModule?.syncState ?? window.ecosysSync;
  const shared = !!s && (s.online === true || ['online', 'offline', 'connecting'].includes(s.status));
  return shared ? { where: 'in ecosys on this computer', also: ', for your other open apps and connected AI assistants too', shared } : { where: 'in this browser', also: '', shared };
}
// ecosys keeps what a replace removes (server/store.mjs: backups/before-replace-…), so the dialogs can say so.
const safetyCopy = (what) => ` A safety copy of ${what} is kept on this computer, in the backups folder of the ecosys data folder.`;
function syncNote() {
  const s = syncModule?.syncState ?? window.ecosysSync;
  if (s?.online) return 'Saved on this computer and synced live across your open apps.';
  if (s?.status === 'connecting') return 'Connecting to the ecosys app on this computer…';
  if (s?.status === 'offline') return 'The ecosys app is not reachable right now. Changes stay here and sync when it is back.';
  return 'Stored only in this browser. Export a backup to move it.';
}

async function importBackupFile(file, done) {
  if (file.size > MAX_BACKUP_BYTES) return toast(`This backup is ${mbText(file.size)}, more than ecosys can import (${mbText(MAX_BACKUP_BYTES)}).`, { duration: 8000 });
  const big = file.size > BIG_BACKUP_BYTES;
  let data;
  let text = null;
  const reading = big ? toast(`Reading the backup (${mbText(file.size)})…`, { duration: 0 }) : null;
  try {
    text = await file.text();
    if (big) await nextFrame();
    data = JSON.parse(text);
  } catch (err) {
    reading?.();
    if (text !== null) return toast('That file is not a valid ecosys backup.'); // read, but not JSON
    // Not read: more than one string holds here (so Export in this browser did not write it), or the file
    // changed or can't be opened since it was chosen.
    const tooLarge = err instanceof RangeError || file.size > 2 ** 29;
    return toast(tooLarge ? `Couldn’t read this ${mbText(file.size)} file: it is more than this browser can read at once.` : 'Couldn’t read that file. Try choosing it again.', { duration: 8000 });
  } finally {
    text = null;
  }
  reading?.();
  if (!data || typeof data !== 'object' || data.app !== 'ecosys') return toast('That file is not an ecosys backup.');
  const src = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
  const n = (k) => (Array.isArray(src[k]) ? src[k].length : 0);
  const parts = [['tasks', 'task'], ['events', 'event'], ['notes', 'note']].filter(([k]) => n(k)).map(([k, word]) => plural(n(k), word));
  // Import replaces each collection the backup has (and the settings, if it has them).
  const kinds = COLLECTIONS.filter((k) => Array.isArray(src[k]));
  if (data.settings && typeof data.settings === 'object') kinds.push('settings');
  const { where, also, shared } = dataReach();
  const has = parts.length ? `It has ${andList(parts)}.` : 'It has no tasks, events or notes.';
  const message = `${has} Importing replaces your ${andList(kinds.length ? kinds : ['data'])} ${where}${also}.${shared && kinds.some((k) => k !== 'settings') ? safetyCopy('what it replaces') : ''}`;
  const ok = await confirmDialog({ title: 'Import this backup?', message, confirm: 'Import', danger: true });
  if (!ok) return;
  const importing = big ? toast('Importing the backup…', { duration: 0 }) : null;
  if (big) await nextFrame();
  let result;
  try {
    result = store.importData(data);
  } catch (err) {
    importing?.();
    return toast(err?.message || 'Could not import that backup.');
  }
  importing?.();
  clearUndo();
  done?.();
  // Records that could not be repaired were left out (store.importData validates every one): say how many.
  const dropped = Number(result?.dropped) || 0;
  toast(dropped ? `Backup imported. ${plural(dropped, 'item')} couldn’t be read and ${dropped === 1 ? 'was' : 'were'} left out.` : 'Backup imported', { duration: dropped ? 8000 : 4500 });
}

function pickBackupFile(done) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.hidden = true;
  const cleanup = () => input.remove();
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    cleanup();
    if (f) importBackupFile(f, done);
  }, { once: true });
  input.addEventListener('cancel', cleanup, { once: true });
  document.body.append(input);
  input.click();
}

// Notes settings are notes-prefixed keys in the shared settings object (notes-spec §4). The store has no
// defaults for them, so an unset key reads as the notes app's default. Working hours read as the hours the
// AI tools use while they are unset (server/core.mjs effectiveSettings).
const SETTING_FALLBACKS = { notesNewStyle: 'h1', notesTextSize: 'm', notesMarkdown: true, notesCheckedSort: 'auto', notesAi: 'edit', scheduleWorkStart: '09:00', scheduleWorkEnd: '17:00' };
const settingOf = (cur, key) => cur[key] ?? (Object.hasOwn(SETTING_FALLBACKS, key) ? SETTING_FALLBACKS[key] : undefined);
// Switches whose setting is on unless it is false.
const SWITCH_READ = { notesMarkdown: (v) => v !== false, shellSingleKeys: (v) => v !== false };
const switchOn = (cur, key) => (Object.hasOwn(SWITCH_READ, key) ? SWITCH_READ[key](settingOf(cur, key)) : !!cur[key]);
const NUMBER_SETTINGS = new Set(['weekStart', 'scheduleDays', 'defaultEventMinutes', 'defaultTaskMinutes']);
/**
 * Working hours as a pair that makes a range: when a change puts the end at or before the start, the other
 * one moves an hour away from it (the server would otherwise ignore both and use 09:00–17:00).
 */
function workHours(cur, name, value) {
  const at = (m) => fromMinutes(Math.min(1439, Math.max(0, m)));
  let start = name === 'scheduleWorkStart' ? value : settingOf(cur, 'scheduleWorkStart');
  let end = name === 'scheduleWorkEnd' ? value : settingOf(cur, 'scheduleWorkEnd');
  if (name === 'scheduleWorkStart') {
    if (end <= start) end = at(toMinutes(start) + 60);
    if (end <= start) start = at(toMinutes(end) - 60);
  } else {
    if (end <= start) start = at(toMinutes(end) - 60);
    if (end <= start) end = at(toMinutes(start) + 60);
  }
  return { scheduleWorkStart: start, scheduleWorkEnd: end };
}

/** Settings' "AI assistants" value: 'Claude connected', '2 connected', 'Not connected', 'Not set up', 'Off'. */
function aiSummary(st, assistants = {}) {
  if (!st?.online) return st?.reason && st.reason !== 'unknown' ? 'Unavailable' : '';
  if (st.mode === 'off') return 'Off';
  const connected = Array.isArray(st.connected) ? st.connected : [];
  if (connected.length) {
    // An assistant by name ("Claude"); another MCP app by its own label ("Cursor").
    const names = [...new Set(connected.map((c) => (c?.kind !== 'other' && Object.hasOwn(assistants, c?.kind) ? assistants[c.kind].name : oneLine(c?.label).slice(0, 40) || 'An AI app')))];
    return names.length === 1 ? `${names[0]} connected` : `${names.length} connected`;
  }
  return Array.isArray(st.clients) && st.clients.length ? 'Not connected' : 'Not set up';
}

export function openSettings() {
  if ($('.modal.settings')) return;
  const preview = { system: 'linear-gradient(135deg,#fff 50%,#000 50%)', light: '#fff', dim: '#15172a', dark: '#000' };
  const bar = { system: '#d0d2dc', light: '#e3e4ec', dim: '#2b2f4a', dark: '#24242c' };
  const s = settings.get() || {};
  const lengths = (list) => list.map((m) => ({ value: m, label: fmtDuration(m) }));
  const seg = (key, opts, label) =>
    `<div class="segmented" role="group" aria-label="${esc(label)}">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${esc(v)}" aria-pressed="false">${esc(l)}</button>`).join('')}</div>`;
  const row = (label, control, id = '') => `<div class="item"><span class="grow"${id ? ` id="${id}"` : ''}>${label}</span>${control}</div>`;
  const sw = (key, label) => row(label, switchField({ name: key, checked: switchOn(s, key), labelledBy: `set-${key}` }), `set-${key}`);
  const body = `<div class="settings-body">
      <div class="group-title">Appearance</div>
      <div class="group">
        <div class="theme-cards" role="radiogroup" aria-label="Theme">
          ${THEMES.map(
            (t) => `<button type="button" class="theme-card" role="radio" data-set="theme" data-val="${t.id}" aria-checked="false">
              <span class="preview" style="background:${preview[t.id]}"><i style="top:18%;background:${bar[t.id]}"></i><i style="top:36%;right:40%;background:${bar[t.id]}"></i><i style="top:62%;left:14%;right:52%;height:12%;background:var(--accent)"></i></span>${esc(t.name)}</button>`,
          ).join('')}
        </div>
        ${row('Accent colour', `<div class="swatches" role="radiogroup" aria-label="Accent colour">${ACCENTS.map((a) => `<button type="button" class="swatch-btn" role="radio" style="--sw:${a.color}" data-set="accent" data-val="${a.id}" aria-checked="false" aria-label="${esc(a.name)}" data-tip="${esc(a.name)}">${icon('check')}</button>`).join('')}</div>`)}
        ${sw('reduceMotion', 'Reduce motion')}
      </div>

      <div class="group-title">Date &amp; time</div>
      <div class="group">
        ${row('Week starts on', seg('weekStart', [[0, 'Sun'], [1, 'Mon'], [6, 'Sat']], 'Week starts on'))}
        ${row('Time format', seg('timeFormat', [['auto', 'Auto'], ['12h', '12h'], ['24h', '24h']], 'Time format'))}
        ${row('Default event length', selectField({ name: 'defaultEventMinutes', value: s.defaultEventMinutes, options: lengths([15, 30, 45, 60, 90, 120]), ariaLabel: 'Default event length', className: 'compact' }))}
        ${row('Default task block', selectField({ name: 'defaultTaskMinutes', value: s.defaultTaskMinutes, options: lengths([15, 30, 45, 60, 90]), ariaLabel: 'Default task block', className: 'compact' }))}
      </div>

      <div class="group-title hover-only">Keyboard</div>
      <div class="group hover-only">
        ${sw('shellSingleKeys', 'Single-key shortcuts')}
      </div>
      <div class="group-foot hover-only">Shortcuts that are one key, like E or ?. Turn them off if you use speech input or press keys by accident; shortcuts with ${MOD} keep working.</div>

      <div class="group-title">Tasks</div>
      <div class="group">
        ${sw('completionSound', 'Completion sound')}
        ${sw('showEventsInToday', 'Show events in Today and Upcoming')}
      </div>

      <div class="group-title">Schedule</div>
      <div class="group">
        ${sw('showTasksInSchedule', 'Show tasks on the calendar')}
        ${row('Days in the multi-day view', seg('scheduleDays', [[2, '2'], [3, '3'], [4, '4'], [5, '5']], 'Days in the multi-day view'))}
        ${row(
          'Working hours',
          `<span style="display:flex;align-items:center;gap:6px;color:var(--text-3)">${timeField({ name: 'scheduleWorkStart', value: settingOf(s, 'scheduleWorkStart'), step: 30, ariaLabel: 'Working hours start', className: 'compact' })}<span aria-hidden="true">–</span>${timeField({ name: 'scheduleWorkEnd', value: settingOf(s, 'scheduleWorkEnd'), base: settingOf(s, 'scheduleWorkStart'), step: 30, ariaLabel: 'Working hours end', className: 'compact' })}</span>`,
        )}
      </div>
      <div class="group-foot">AI assistants plan tasks and look for free time within your working hours.</div>

      <div class="group-title">Notes</div>
      <div class="group">
        ${row('New notes start with', seg('notesNewStyle', [['h1', 'Title'], ['h2', 'Heading'], ['p', 'Body']], 'New notes start with'))}
        ${row('Text size', seg('notesTextSize', [['s', 'S'], ['m', 'M'], ['l', 'L']], 'Text size'))}
        ${sw('notesMarkdown', 'Markdown shortcuts')}
        ${row('Sort checked items', seg('notesCheckedSort', [['auto', 'Automatically'], ['manual', 'Manually']], 'Sort checked items'))}
        ${row('AI assistants can', seg('notesAi', [['edit', 'Read & edit'], ['read', 'Read'], ['off', 'Off']], 'AI access to notes'))}
      </div>
      <div class="group-foot">For notes, within what <button type="button" data-action="ai" style="color:var(--accent-text);font-weight:500">Connect AI</button> allows everywhere. Notes and folders you hide from AI are never shown to assistants.</div>

      <div class="group-title">Connections</div>
      <div class="group">
        <button type="button" class="item" data-action="ai"><span class="grow">AI assistants</span><span class="value"><span data-ai-value></span>${icon('chevron-right', { size: 16 })}</span></button>
      </div>

      <div class="group-title">Your data</div>
      <div class="group">
        <button type="button" class="item" data-action="export"><span class="grow">Export backup</span><span class="value" data-counts></span></button>
        <button type="button" class="item" data-action="import"><span class="grow">Import backup…</span></button>
        <button type="button" class="item" data-action="samples"><span class="grow">Start over with sample data</span></button>
        <button type="button" class="item" data-action="erase"><span class="grow danger-text">Erase everything</span></button>
      </div>
      <div class="group-foot" data-sync-note></div>
    </div>`;
  const { el, close } = openModal({ title: 'Settings', className: 'settings grouped', body: `<div class="modal-body">${body}</div>` });

  // Update controls in place (never re-render), so focus and scroll stay where they are.
  const sync = () => {
    if (!document.contains(el)) return;
    const cur = settings.get() || {};
    for (const b of $$('[data-set]', el)) {
      const on = String(settingOf(cur, b.dataset.set)) === b.dataset.val;
      b.setAttribute(b.getAttribute('role') === 'radio' ? 'aria-checked' : 'aria-pressed', String(on));
    }
    for (const g of $$('[role="radiogroup"]', el)) {
      const radios = $$('[role="radio"]', g);
      const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0];
      for (const r of radios) r.tabIndex = r === checked ? 0 : -1;
    }
    for (const f of $$('[data-select][name]', el)) setFieldValue(f, settingOf(cur, f.getAttribute('name')));
    for (const f of $$('[role="switch"][name]', el)) setFieldValue(f, switchOn(cur, f.getAttribute('name')));
    // The end's list starts at the start and says how long the day is ('5pm (8 hrs)').
    for (const f of $$('[data-time-field][name]', el)) setFieldValue(f, settingOf(cur, f.getAttribute('name')), f.getAttribute('name') === 'scheduleWorkEnd' ? { base: settingOf(cur, 'scheduleWorkStart') } : {});
    const notes = all('notes').length;
    $('[data-counts]', el).textContent = `${plural(all('tasks').length, 'task')}, ${plural(all('events').length, 'event')}${notes ? `, ${plural(notes, 'note')}` : ''}`;
    $('[data-sync-note]', el).textContent = syncNote();
  };
  sync();
  const off = db.on(() => sync());
  window.addEventListener('ecosys:sync', sync);
  // The AI row says who is connected right now, live (Connect AI's status, without its keys).
  let offAI = () => {};
  import('./ai.js')
    .then((m) => {
      if (!document.contains(el) || typeof m.onAIStatus !== 'function') return;
      const aiValue = $('[data-ai-value]', el);
      offAI = m.onAIStatus((st) => {
        if (aiValue) aiValue.textContent = aiSummary(st, m.ASSISTANTS);
      });
    })
    .catch(() => {
      /* Connect AI isn't available: the row still opens it, which explains */
    });
  const obs = new MutationObserver(() => {
    if (!document.contains(el)) {
      off();
      offAI();
      window.removeEventListener('ecosys:sync', sync);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });

  const setFrom = (b) => {
    const key = b.dataset.set;
    let val = b.dataset.val;
    if (NUMBER_SETTINGS.has(key)) val = +val;
    if ((settings.get() || {})[key] !== val) settings.set({ [key]: val });
  };
  el.addEventListener('click', async (e) => {
    const set = e.target.closest('[data-set]');
    if (set) return setFrom(set);
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (act === 'export') downloadBackup();
    else if (act === 'import') pickBackupFile(close);
    else if (act === 'ai') {
      close();
      openAI();
    } else if (act === 'samples') {
      // resetData() replaces every collection (notes and folders too) and, with sync on, the server's copy.
      const { where, also, shared } = dataReach();
      if (await confirmDialog({ title: 'Start over with sample data?', message: `Every task, list, event, calendar and note ${where} is replaced with the sample set${also}.${shared ? safetyCopy('what is replaced') : ''}`, confirm: 'Replace everything', danger: true })) {
        store.resetData({ withSamples: true });
        clearUndo();
        close();
        toast('Sample data loaded');
      }
    } else if (act === 'erase') {
      const { where, also, shared } = dataReach();
      if (await confirmDialog({ title: 'Erase everything?', message: `Every task, list, event, calendar and note ${where} is deleted${also}.${shared ? safetyCopy('what is erased') : ''} Consider exporting a backup first.`, confirm: 'Erase everything', danger: true })) {
        store.resetData();
        clearUndo();
        close();
        toast('All data erased');
      }
    }
  });
  // Radio groups: arrow keys move the selection (WAI-ARIA radio pattern).
  el.addEventListener('keydown', (e) => {
    const r = e.target.closest('[role="radio"]');
    if (!r || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const radios = $$('[role="radio"]', r.closest('[role="radiogroup"]'));
    const next = radios[(radios.indexOf(r) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + radios.length) % radios.length];
    next.focus();
    setFrom(next);
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    const name = t.getAttribute?.('name');
    if (!name) return;
    if (t.matches('[data-select]')) settings.set({ [name]: NUMBER_SETTINGS.has(name) ? +t.value : t.value });
    else if (t.matches('[role="switch"]')) settings.set({ [name]: t.value === 'true' });
    else if (t.matches('[data-time-field]') && HHMM.test(t.value) && /^scheduleWork(Start|End)$/.test(name)) {
      const next = workHours(settings.get() || {}, name, t.value);
      settings.set(next);
      sync(); // the other field, if it moved, and the end's list start
    }
  });
}

// ---------------------------------------------------------------- date picker (Todoist quick dates + mini calendar)

/**
 * opts: { value:'YYYY-MM-DD'|null, title, allowClear, clearLabel, withTime, time:'HH:MM'|null, onPick({date, time}), onClose }
 * `withTime` adds a Time row (Todoist's date menu): choosing a time keeps the chosen date (today when there
 * is none) and closes the picker, and "fri 3pm" typed in the field sets both. onPick's `time` is then the
 * time to keep with every pick ('HH:MM', or null for none): unchanged for a day picked from the calendar
 * or the quick dates, null with "No date". Without `withTime`, `time` is undefined.
 */
export function openDatePicker(anchor, opts = {}) {
  const s = settings.get() || {};
  const weekStart = [0, 1, 6].includes(s.weekStart) ? s.weekStart : 0;
  const value = YMD.test(opts.value ?? '') ? opts.value : null;
  const withTime = !!opts.withTime;
  const time = withTime && HHMM.test(opts.time ?? '') ? opts.time : null;
  const today = todayYmd();
  let month = value ? parseYmd(value) : new Date();
  let focusDate = value || today;
  const wd = new Date().getDay();
  const nextWeekDelta = (1 - wd + 7) % 7 || 7;
  // Todoist's date menu: Today · Tomorrow · Later this week · This weekend · Next week · No date
  const quick = [
    { k: 'today', label: 'Today', icon: 'today', date: today },
    { k: 'tomorrow', label: 'Tomorrow', icon: 'tomorrow', date: addDaysYmd(today, 1) },
    wd >= 1 && wd <= 3 && { k: 'later', label: 'Later this week', icon: 'calendar-week', date: addDaysYmd(today, 2) },
    { k: 'weekend', label: wd === 6 || wd === 0 ? 'Next weekend' : 'This weekend', icon: 'weekend', date: addDaysYmd(today, wd === 6 ? 7 : wd === 0 ? 6 : 6 - wd) },
    { k: 'nextweek', label: 'Next week', icon: 'calendar-next', date: addDaysYmd(today, nextWeekDelta) },
  ].filter(Boolean);
  const cal = (sel = value) => miniCalendar({ month, selected: sel, weekStart, focusDate });
  const tail = [
    withTime &&
      `<button type="button" class="menu-item" data-dp="time" aria-haspopup="dialog">${icon('clock', { size: 18 })}<span class="grow">${time ? 'Time' : 'Add time'}</span>${time ? `<span class="hint tnum">${esc(fmtClock(time))}</span>` : ''}</button>`,
    opts.allowClear !== false && value && `<button type="button" class="menu-item" data-dp="clear">${icon('no-date', { size: 18 })}<span class="grow">${esc(opts.clearLabel || 'No date')}</span></button>`,
  ].filter(Boolean);
  const content = `<div class="datepicker">
      <div class="dp-type"><input type="text" class="input" placeholder="${withTime ? 'Type a date: fri 3pm, dec 5' : 'Type a date: fri, in 3 days, dec 5'}" aria-label="${withTime ? 'Type a date and time' : 'Type a date'}" data-dp-type autocomplete="off" spellcheck="false"></div>
      <div class="dp-quick">
        ${quick.map((q) => `<button type="button" class="menu-item" data-dp="${q.k}">${q.k === 'today' ? todayGlyph(18) : icon(q.icon, { size: 18 })}<span class="grow">${q.label}</span><span class="hint">${esc(dayShort(q.date))}</span></button>`).join('')}
      </div>
      <div class="menu-sep"></div>
      <div data-dp-cal>${cal()}</div>
      <div class="sr-only" role="status" aria-live="polite" data-dp-live></div>
      ${tail.length ? `<div class="menu-sep"></div>${tail.join('')}` : ''}
    </div>`;
  return openPopover(anchor, content, {
    className: 'dp-pop',
    label: opts.title || 'Choose a date',
    focus: !coarse(),
    sheet: true,
    onClose: opts.onClose,
    onMount: (el, close) => {
      const calEl = $('[data-dp-cal]', el);
      // Stays in place while the calendar is redrawn, so the month it moves to is read out.
      const live = $('[data-dp-live]', el);
      const say = (text) => {
        live.textContent = '';
        setTimeout(() => (live.textContent = text), 60);
      };
      const pick = (date, t = time) => {
        close();
        opts.onPick?.({ date, ...(withTime ? { time: date ? t || null : null } : {}), evening: false, someday: false });
      };
      const redraw = (sel) => (calEl.innerHTML = cal(sel));
      el.addEventListener('click', (e) => {
        const q = e.target.closest('[data-dp]');
        if (q) {
          const k = q.dataset.dp;
          if (k === 'clear') return pick(null);
          if (k === 'time') {
            return openTimePicker(q, {
              value: time || '',
              allowClear: !!time,
              clearLabel: 'No time',
              label: 'Time',
              onPick: (t) => pick(value || today, t || null),
            });
          }
          return pick(quick.find((x) => x.k === k)?.date || null);
        }
        const d = e.target.closest('[data-date]');
        if (d) return pick(d.dataset.date);
        const nav = e.target.closest('[data-mc]');
        if (nav) {
          const k = nav.dataset.mc;
          const hadFocus = nav.contains(document.activeElement);
          month = k === 'today' ? new Date() : new Date(month.getFullYear(), month.getMonth() + (k === 'next' ? 1 : -1), 1);
          focusDate = k === 'today' ? today : ymd(month);
          redraw();
          say(monthTitle(month));
          // The button was drawn again: keep the keyboard on it (a press with the keyboard left focus on <body>).
          if (hadFocus) $(`[data-mc="${k}"]`, calEl)?.focus({ preventScroll: true });
        }
      });
      // Arrow keys move through the days (one tab stop for the whole grid).
      calEl.addEventListener('keydown', (e) => {
        if (!e.target.closest('.mc-day')) return;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        let next = null;
        if (step) next = addDaysYmd(focusDate, step);
        else if (e.key === 'PageUp' || e.key === 'PageDown') next = ymd(addMonths(parseYmd(focusDate), e.key === 'PageDown' ? 1 : -1)); // the same day, or that month's last
        else if (e.key === 'Home') next = addDaysYmd(focusDate, -((parseYmd(focusDate).getDay() - weekStart + 7) % 7));
        else if (e.key === 'End') next = addDaysYmd(focusDate, 6 - ((parseYmd(focusDate).getDay() - weekStart + 7) % 7));
        if (!next) return;
        e.preventDefault();
        focusDate = next;
        const d = parseYmd(next);
        if (d.getMonth() !== month.getMonth() || d.getFullYear() !== month.getFullYear()) month = new Date(d.getFullYear(), d.getMonth(), 1);
        redraw();
        $(`[data-date="${next}"]`, calEl)?.focus();
      });
      const typeInput = $('[data-dp-type]', el);
      // What the field reads as: a date, and with withTime a time ("fri 3pm"; "3pm" alone is today).
      const typed = () => {
        const r = parse(typeInput.value, { mode: 'task' });
        const t = withTime && HHMM.test(r.time ?? '') ? r.time : null;
        const d = r.date || r.deadline || (t ? value || today : null);
        return d && YMD.test(d) ? { d, t } : null;
      };
      let shown = '';
      typeInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          $('.dp-quick .menu-item', el)?.focus();
          return;
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const r = typed();
        if (r) return pick(r.d, r.t || time);
        typeInput.select();
      });
      typeInput.addEventListener('input', () => {
        const r = typed();
        if (!r) return;
        month = parseYmd(r.d);
        focusDate = r.d;
        redraw(r.d);
        // Say what Enter would set, once per new reading ("Friday, November 27, 3pm").
        const text = `${fmt(parseYmd(r.d), { weekday: 'long', month: 'long', day: 'numeric', ...(parseYmd(r.d).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })}${r.t ? `, ${fmtClock(r.t)}` : ''}`;
        if (text !== shown) say((shown = text));
      });
      $('.dp-quick', el).addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = $$('.dp-quick .menu-item', el);
        const i = items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
        if (i < 0) typeInput.focus();
        else if (i >= items.length) $(`[data-date="${focusDate}"]`, calEl)?.focus();
        else items[i].focus();
      });
    },
  });
}

/**
 * Today's glyph: the calendar page with the dot that means "now" (icons.js `today`, the Schedule logo's
 * language), `size` px square, drawn without a font so it never depends on the date or a typeface.
 * Decorative (aria-hidden): the label next to it says "Today". The .today-glyph box keeps the size callers set.
 */
export function todayGlyph(size = 20) {
  const s = Number(size) || 20;
  return `<span class="today-glyph" style="width:${s}px;height:${s}px" aria-hidden="true">${icon('today', { size: s })}</span>`;
}

function dayShort(s) {
  const n = diffDays(todayYmd(), s);
  if (n === 0) return '';
  return fmt(parseYmd(s), n < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- custom repeat (Todoist's and Google Calendar's "Custom…")

const REPEAT_UNITS = [
  { freq: 'day', one: 'Day', many: 'Days' },
  { freq: 'week', one: 'Week', many: 'Weeks' },
  { freq: 'month', one: 'Month', many: 'Months' },
  { freq: 'year', one: 'Year', many: 'Years' },
];
/**
 * A custom repeat: every n days, weeks (on the weekdays chosen), months or years, for a select's "Custom…".
 * Monthly repeats keep the day of the month of `date`, yearly ones its day and month, weekly ones start on
 * its weekday. opts: { value: rule|null, date: 'YYYY-MM-DD', label, onPick(rule), onClose }, where rule is
 * recur.js's { freq, interval, days?, monthDay?, month? }. Returns the popover's handle.
 */
export function openRepeatPicker(anchor, { value = null, date = '', label = 'Custom repeat', onPick, onClose } = {}) {
  const d = parseYmd(YMD.test(date ?? '') ? date : todayYmd());
  const v = value && typeof value === 'object' ? value : null;
  const weekStart = [0, 1, 6].includes(settings.get()?.weekStart) ? settings.get().weekStart : 0;
  let freq = REPEAT_UNITS.some((u) => u.freq === v?.freq) ? v.freq : 'week';
  let interval = Math.min(99, Math.max(1, Math.round(+v?.interval) || 1));
  let days = v?.freq === 'week' && Array.isArray(v.days) ? [...new Set(v.days.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))] : [];
  if (!days.length) days = [d.getDay()];
  const keep = (k, fallback) => (v?.freq === freq && Number.isInteger(v?.[k]) ? v[k] : fallback);
  const rule = () => {
    const r = { freq, interval };
    if (freq === 'week') r.days = [...days].sort((a, b) => a - b);
    if (freq === 'month') r.monthDay = keep('monthDay', d.getDate());
    if (freq === 'year') Object.assign(r, { month: keep('month', d.getMonth() + 1), monthDay: keep('monthDay', d.getDate()) });
    return r;
  };
  const order = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  const unitButtons = () => REPEAT_UNITS.map((u) => `<button type="button" data-rp-unit="${u.freq}" aria-pressed="${u.freq === freq}">${interval === 1 ? u.one : u.many}</button>`).join('');
  const content = `<form class="rp-form" novalidate autocomplete="off" style="display:grid;gap:12px;width:284px;max-width:100%;padding:6px">
      <label style="display:flex;align-items:center;gap:10px;font-size:14px">Repeat every
        <input class="input" name="interval" inputmode="numeric" maxlength="2" value="${interval}" aria-label="Repeat every" data-autofocus style="width:56px;height:32px;text-align:center"></label>
      <div class="segmented full" role="group" aria-label="Unit" data-rp-units>${unitButtons()}</div>
      <div class="segmented full" role="group" aria-label="On" data-rp-days${freq === 'week' ? '' : ' hidden'}>${order.map((w) => `<button type="button" data-rp-day="${w}" aria-pressed="${days.includes(w)}" aria-label="${esc(WEEKDAY_LONG[w])}" style="padding:0">${esc(WEEKDAY_NARROW[w])}</button>`).join('')}</div>
      <p data-rp-sum aria-live="polite" style="margin:0;color:var(--text-3);font-size:13px"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-ghost btn-sm" data-rp-cancel>Cancel</button><button type="submit" class="btn btn-primary btn-sm">Done</button></div>
    </form>`;
  return openPopover(anchor, content, {
    className: 'rp-pop',
    label,
    sheet: true,
    // As the date picker: on a touch screen, focusing the field would raise the keyboard over the sheet.
    focus: !coarse(),
    onClose,
    onMount: (el, close) => {
      const form = $('form', el);
      const input = form.elements.interval;
      // A phone's sheet: the screen's width, and a field large enough to tap that iOS does not zoom into.
      if (el.classList.contains('as-sheet')) {
        form.style.width = '100%';
        Object.assign(input.style, { height: '40px', fontSize: '16px' });
      }
      const sum = $('[data-rp-sum]', el);
      const draw = () => {
        sum.textContent = describeRule(rule());
        $('[data-rp-units]', el).innerHTML = unitButtons();
        $('[data-rp-days]', el).hidden = freq !== 'week';
        for (const b of $$('[data-rp-day]', el)) b.setAttribute('aria-pressed', String(days.includes(+b.dataset.rpDay)));
      };
      draw();
      input.addEventListener('input', () => {
        const n = parseInt(input.value.replace(/\D/g, ''), 10);
        if (n >= 1 && n <= 99 && n !== interval) {
          interval = n;
          draw();
        }
      });
      input.addEventListener('blur', () => (input.value = String(interval)));
      el.addEventListener('click', (e) => {
        const unit = e.target.closest('[data-rp-unit]');
        if (unit) {
          freq = unit.dataset.rpUnit;
          draw();
          $(`[data-rp-unit="${freq}"]`, el)?.focus();
          return;
        }
        const day = e.target.closest('[data-rp-day]');
        if (day) {
          const w = +day.dataset.rpDay;
          // A weekly repeat needs a day: the last one stays on.
          if (days.includes(w)) {
            if (days.length > 1) days = days.filter((x) => x !== w);
          } else days = [...days, w];
          draw();
          return;
        }
        if (e.target.closest('[data-rp-cancel]')) close();
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const r = rule();
        close();
        onPick?.(r);
      });
    },
  });
}

// ---------------------------------------------------------------- sync & AI hooks (optional modules, loaded lazily)

let syncModule = null;
let aiStarted = false;

/** Open the AI connections panel (shared/ai.js). Degrades to a toast when it isn't available. */
export function openAI() {
  import('./ai.js')
    .then((m) => {
      if (typeof m.openAIPanel !== 'function') throw new Error('missing openAIPanel');
      return m.openAIPanel();
    })
    .catch(() => {
      // While ecosys answers, the app is there: the module itself failed to load, and a reload can help.
      if (syncOnline()) toast('Couldn’t load AI connections. Reload the page to try again.', { action: 'Reload', onAction: () => location.reload(), duration: 8000 });
      else toast('AI connections need the ecosys app running on this computer.', { duration: 6000 });
    });
}

function startAI() {
  if (aiStarted || !syncOnline()) return;
  aiStarted = true;
  import('./ai.js')
    .then((m) => m.initAI?.({ app: currentApp }))
    .catch(() => {
      /* AI features are optional */
    });
}

async function startSyncSafely() {
  try {
    syncModule = await import('./sync.js');
    window.addEventListener('ecosys:sync', startAI);
    window.addEventListener('ecosys:sync', onSyncStatus);
    await syncModule.startSync?.();
  } catch {
    return; // no sync module or no server (static hosting): the apps work from this browser's storage alone
  }
  startAI();
}

// Losing ecosys shows in every app, not only in Settings: once a page has been in sync, a quiet toast that
// stays up says when ecosys stops answering (a restart that is over in a few seconds passes silently) and
// that changes are kept; "Back online" replaces it. Being a toast, it is read out as a status too. Its Hide
// puts it away for the rest of the outage (it covers part of the page), and "Back online" still says when
// ecosys is back.
const SYNC_GRACE_MS = 4000;
let syncWasOnline = false;
let syncNotice = null; // { refused, close } while a status is up (or hidden)
let syncNoticeTimer = 0;
/**
 * Tell ecosys this computer's time zone (its IANA name, in settings.uiTimeZone), which the AI tools' clock
 * uses (server/model.mjs): once this page is in sync with ecosys, never before (a new browser's first sync
 * is left alone), and again when the page comes back into view (a laptop that travelled). Only a change is
 * written. Nothing happens without ecosys (a static copy has no AI tools).
 */
export function reportTimeZone() {
  if (!syncOnline()) return;
  let zone = null;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    /* no Intl time zones here */
  }
  if (typeof zone === 'string' && zone && (settings.get() || {}).uiTimeZone !== zone) settings.set({ uiTimeZone: zone });
}

function onSyncStatus(e) {
  const s = e?.detail ?? syncModule?.syncState ?? {};
  clearTimeout(syncNoticeTimer);
  if (s.online) {
    reportTimeZone();
    syncWasOnline = true;
    if (syncNotice) {
      syncNotice.close();
      syncNotice = null;
      toast('Back online', { duration: 2500 });
    }
    return;
  }
  // 'error': ecosys refused this page (it stops syncing until reloaded), which replaces "Offline", hidden or not.
  const refused = s.status === 'error';
  const said = () => !!syncNotice && (syncNotice.refused || !refused);
  if (!syncWasOnline || said() || (s.status !== 'offline' && !refused)) return;
  syncNoticeTimer = setTimeout(
    () => {
      if (syncModule?.syncState?.online || said()) return;
      syncNotice?.close();
      syncNotice = {
        refused,
        close: refused
          ? toast('Sync stopped. Reload to sync your changes.', { action: 'Reload', onAction: () => location.reload(), duration: 0 })
          : toast('Offline. Your changes will sync when ecosys is back.', { action: 'Hide', duration: 0 }),
      };
    },
    refused ? 0 : SYNC_GRACE_MS,
  );
}

// ---------------------------------------------------------------- init

let shellReady = false;
let lastSaveError = 0;
/**
 * Call once per app. opts: { app: 'home' | 'tasks' | 'schedule' | 'notes' }
 */
export function initShell({ app }) {
  if (shellReady) return;
  shellReady = true;
  currentApp = APPS.some((a) => a.id === app) ? app : 'home';
  window.addEventListener('ecosys:save-error', () => {
    if (Date.now() - lastSaveError < 30000) return;
    lastSaveError = Date.now();
    toast('Could not save. Storage may be full or blocked, so export a backup.', { duration: 8000 });
  });
  window.addEventListener('ecosys:data-replaced', () => clearUndo());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reportTimeZone();
  });
  try {
    store.registerSeeder?.(seed);
    store.seedIfEmpty?.();
  } catch (err) {
    console.error('ecosys: could not prepare data', err);
  }
  // Live regions first, so the page's first status message is announced.
  toastRegion();
  announce('');
  if (store.storageAvailable && !store.storageAvailable()) toast('This browser is blocking storage, so changes last only until you close this tab.', { duration: 10000 });
  applyTheme();
  setFavicon(currentApp);
  darkMq.addEventListener('change', applyTheme);
  db.on(({ names }) => {
    if (names.has('settings')) applyTheme();
  });
  registerCrossAppSearch(currentApp);
  initTooltips();
  initFields();

  document.addEventListener('click', (e) => {
    const t = e.target;
    const sw = t.closest('[data-app-switcher]');
    if (sw) return void openSwitcher(sw, currentApp);
    const am = t.closest('[data-app-menu]');
    if (am) return void openAppMenu(am, currentApp);
    if (t.closest('[data-open-settings]')) return void openSettings();
    if (t.closest('[data-open-shortcuts]')) return void openShortcuts();
    if (t.closest('[data-open-palette]')) return void openPalette();
    if (t.closest('[data-open-ai]')) return void openAI();
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
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !e.altKey && !isTyping(e)) {
      e.preventDefault();
      undoLast();
      return;
    }
    // Redo: shift mod Z everywhere, and Ctrl+Y outside macOS (where Cmd+Y is the browser's History).
    if (mod && !e.altKey && !isTyping(e) && ((e.shiftKey && e.key.toLowerCase() === 'z') || (!isMac && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'y'))) {
      e.preventDefault();
      redoLast();
      return;
    }
    // Quick note from any app (the notes app has its own mod alt N). Like the other app shortcuts, not while
    // typing in a field (notes-spec §4): it leaves the page, and what's typed there would be lost. Matched on
    // the key's position: on a Mac, Option changes the character. Not with AltGr (Ctrl+Alt on Windows), which
    // types characters.
    if (currentApp !== 'notes' && mod && e.altKey && !e.shiftKey && e.code === 'KeyN' && !e.isComposing && !e.getModifierState?.('AltGraph') && !layers.length && !isTyping(e)) {
      e.preventDefault();
      openQuickNote();
      return;
    }
    if (isTyping(e) || mod || e.altKey || layers.length || singleKeyOff(e)) return;
    if (e.key === '?') {
      e.preventDefault();
      openShortcuts();
    } else if (e.key === ',') {
      e.preventDefault();
      openSettings();
    }
  });

  startSyncSafely();
}

export { icon, db, settings, todayYmd, addDaysYmd, parseYmd, ymd, addDays, fmt, dayLabel };
