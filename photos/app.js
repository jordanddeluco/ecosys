// photos — the ecosys photo library, with cloud backup to OneDrive or Google Drive.
//
// The look is ecosys (one accent, quiet surfaces, pills, sheets, the shared shell); the structure takes
// the best of the two big photo apps:
//   from Apple Photos   the Library's Years · Months · Days · All switcher (a floating pill at the bottom),
//                       year and month cards, Memories, an Albums page with My Albums / Media Types /
//                       Utilities, Recently Deleted that keeps things 30 days, and a viewer with a filmstrip
//   from Google Photos  the search bar across the top, day headers whose circle selects the whole day,
//                       tick circles on hover and a selection bar that replaces the top bar, the date
//                       scrubber down the right edge, backup status always in sight, the info panel, and
//                       Free up space
//   from Samsung        backup into a folder of its own in your cloud ("Pictures/ecosys Photos/2026/11")
//
// Routes (hash): #/photos  #/albums  #/album/<id>  #/favorites  #/videos  #/trash  #/backup  #/search?q=…

import {
  initShell, esc, $, $$, icon, toast, undoable, openMenu, openModal, confirmDialog, registerPaletteProvider, registerShortcuts,
  sidebarHead, hasOpenLayer, isTyping, tipAttrs, keys, switchField, singleKeyOff, announce, BASE, settings,
} from '../shared/shell.js';
import { fmt } from '../shared/dates.js';
import * as lib from './lib/library.js';
import * as media from './lib/media.js';
import * as backup from './lib/backup.js';
import * as oauth from './lib/oauth.js';

initShell({ app: 'photos' });

// ---------------------------------------------------------------- helpers

const DAY = 86400000;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const reduceMotion = () => settings.get()?.reduceMotion === true || matchMedia('(prefers-reduced-motion: reduce)').matches;
const isVideo = (p) => media.isVideoType(p.type);
const local = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(`ecosys:photos:${k}`);
    localStorage.setItem(`ecosys:photos:${k}`, String(v));
  } catch {}
  return null;
};
function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
const dur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthKey = (t) => dayKey(t).slice(0, 7);
const thisYear = () => new Date().getFullYear();
function dayTitle(t) {
  const d = new Date(t);
  const today = new Date();
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return fmt(d, { weekday: 'long' });
  return fmt(d, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
const monthTitle = (t) => fmt(new Date(t), { month: 'long', year: 'numeric' });
const longDate = (t) => fmt(new Date(t), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeOf = (t) => fmt(new Date(t), { hour: 'numeric', minute: '2-digit' });
const PROVIDER_NAME = { onedrive: 'OneDrive', gdrive: 'Google Drive' };
/**
 * The providers' own marks, used only to say which service a button connects to (as their brand guidelines
 * allow for "connect to" buttons): OneDrive's four-blue cloud and Google Drive's six-part triangle.
 */
const PROVIDER_LOGO = {
  onedrive: `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M12.2 11.19l6.72 4.03 4-1.69A6.48 6.48 0 0 1 25.5 13c.15 0 .29 0 .44.02A10 10 0 0 0 7.9 10H8a7.96 7.96 0 0 1 4.2 1.19z" fill="#0364b8"/><path d="M12.2 11.19A7.96 7.96 0 0 0 8 10h-.1a8 8 0 0 0-6.46 12.57l5.92-2.49 2.63-1.11 5.86-2.47 3.06-1.29z" fill="#0078d4"/><path d="M25.94 13.02A6.4 6.4 0 0 0 25.5 13a6.48 6.48 0 0 0-2.58.53l-4 1.69 1.16.7 3.81 2.27 1.66 1 5.68 3.4a6.5 6.5 0 0 0-5.29-9.57z" fill="#1490df"/><path d="M25.55 19.18l-1.66-.99-3.81-2.28-1.16-.7-3.06 1.29-5.86 2.47-2.64 1.1-5.92 2.5A7.99 7.99 0 0 0 8 26h17.5a6.5 6.5 0 0 0 5.72-3.42z" fill="#28a8ea"/></svg>`,
  gdrive: `<svg viewBox="0 0 87.3 78" aria-hidden="true" focusable="false"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>`,
};
const providerLogo = (id, cls = '') => `<span class="ph-prov-icon ${id}${cls ? ` ${cls}` : ''}">${PROVIDER_LOGO[id] || icon('cloud')}</span>`;
const PROVIDER_PATH = { onedrive: 'Pictures', gdrive: 'My Drive' };

// ---------------------------------------------------------------- state

const state = {
  route: { view: 'photos', id: '', q: '' },
  zoom: ['years', 'months', 'days', 'all'].includes(local('zoom')) ? local('zoom') : 'days',
  cols: Math.min(10, Math.max(3, Number(local('cols')) || 6)),
  selected: new Set(),
  anchor: null, // last tile clicked, for shift-click ranges
  order: [], // ids in the order the current view shows them
  cfg: { ...backup.DEFAULTS },
  status: backup.getStatus(),
  importing: null, // { done, total }
  ready: false,
};

// ---------------------------------------------------------------- layout

$('#app').innerHTML = `
<div class="shell ph-shell" id="shell">
  <aside class="sidebar" id="sidebar">
    ${sidebarHead('photos')}
    <div class="create-wrap"><button type="button" class="create-btn" data-import ${tipAttrs('Import photos', 'u')}>${icon('upload', { size: 21, stroke: 2.2 })}<span>Import</span></button></div>
    <nav class="side-scroll" id="nav" aria-label="Library"></nav>
    <a class="ph-side-backup" id="side-backup" href="#/backup"></a>
  </aside>
  <div class="side-overlay" data-close-nav></div>
  <main class="main" id="main">
    <header class="topbar ph-top" id="topbar">
      <button type="button" class="icon-btn menu-toggle" data-toggle-nav aria-label="Library" aria-controls="sidebar">${icon('sidebar')}</button>
      <form class="ph-search" id="search" role="search">
        ${icon('search', { size: 18 })}
        <input type="search" id="q" placeholder="Search your photos" aria-label="Search your photos" autocomplete="off" enterkeyhint="search" />
        <span class="ph-search-key" aria-hidden="true">${keys('/')}</span>
      </form>
      <span class="grow"></span>
      <a class="icon-btn ph-cloud-btn" id="cloud-btn" href="#/backup"></a>
      <button type="button" class="btn btn-tint btn-sm ph-top-import" data-import>${icon('upload', { size: 16 })}<span>Import</span></button>
    </header>
    <div class="ph-selbar" id="selbar" hidden></div>
    <div class="content main-scroll ph-scroll" id="scroll"><div id="view"></div></div>
    <div class="ph-scrubber" id="scrubber" aria-hidden="true"><div class="ph-scrub-marks"></div><div class="ph-scrub-bubble"></div></div>
    <div class="ph-zoombar" id="zoombar"></div>
  </main>
  <nav class="tabbar" id="tabbar" aria-label="Views"></nav>
</div>
<input type="file" id="file" accept="image/*,video/*,.heic,.heif" multiple hidden />
<div class="ph-drop" id="drop" hidden><div>${icon('upload', { size: 36 })}<p>Drop to add to Photos</p></div></div>`;

const el = {
  shell: $('#shell'),
  nav: $('#nav'),
  sideBackup: $('#side-backup'),
  top: $('#topbar'),
  selbar: $('#selbar'),
  scroll: $('#scroll'),
  view: $('#view'),
  zoombar: $('#zoombar'),
  scrubber: $('#scrubber'),
  tabbar: $('#tabbar'),
  file: $('#file'),
  drop: $('#drop'),
  q: $('#q'),
  cloud: $('#cloud-btn'),
};

// ---------------------------------------------------------------- thumbnails (object URLs, loaded as they scroll in)

const thumbUrls = new Map();
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const blob = await lib.getThumb(id);
  const url = blob ? URL.createObjectURL(blob) : '';
  thumbUrls.set(id, url);
  return url;
}
function dropThumb(id) {
  const u = thumbUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  thumbUrls.delete(id);
}
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      io.unobserve(img);
      thumbUrl(img.dataset.thumb).then((u) => {
        if (!u) return;
        img.src = u;
        img.decode?.().catch(() => {}).finally(() => img.classList.add('in'));
      });
    }
  },
  { root: null, rootMargin: '600px 0px' },
);
function hydrate(root = el.view) {
  for (const img of $$('img[data-thumb]:not([src])', root)) {
    const u = thumbUrls.get(img.dataset.thumb);
    if (u) {
      img.src = u;
      img.classList.add('in');
    } else io.observe(img);
  }
}

// ---------------------------------------------------------------- data views

const live = () => lib.allPhotos().filter((p) => !p.deletedAt);
const byNewest = (a, b) => b.takenAt - a.takenAt;
const trashed = () => lib.allPhotos().filter((p) => p.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);

function searchPhotos(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const albums = new Map(lib.allAlbums().map((a) => [a.id, a.name.toLowerCase()]));
  return live()
    .filter((p) => {
      const d = new Date(p.takenAt);
      const hay = [
        p.name, p.camera, p.exposure,
        fmt(d, { month: 'long' }), fmt(d, { month: 'short' }), fmt(d, { weekday: 'long' }), String(d.getFullYear()),
        isVideo(p) ? 'video videos' : 'photo photos', p.favorite ? 'favorite favourite favorites' : '',
        p.cloud ? `backed up ${PROVIDER_NAME[p.cloud.provider] || ''}` : 'not backed up', p.width > p.height ? 'landscape' : p.width < p.height ? 'portrait' : 'square',
        ...(p.albumIds || []).map((a) => albums.get(a) || ''),
      ].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort(byNewest);
}

function itemsFor(route = state.route) {
  switch (route.view) {
    case 'favorites':
      return live().filter((p) => p.favorite).sort(byNewest);
    case 'videos':
      return live().filter(isVideo).sort(byNewest);
    case 'album':
      return live().filter((p) => p.albumIds?.includes(route.id)).sort(byNewest);
    case 'trash':
      return trashed();
    case 'search':
      return searchPhotos(route.q);
    default:
      return live().sort(byNewest);
  }
}

function groupBy(list, keyFn) {
  const groups = [];
  let cur = null;
  for (const p of list) {
    const k = keyFn(p.takenAt);
    if (!cur || cur.key !== k) groups.push((cur = { key: k, items: [] }));
    cur.items.push(p);
  }
  return groups;
}

/** The photo that stands for a set: a favourite if there is one, else one from the middle (Apple's key photo). */
const keyPhoto = (items) => items.find((p) => p.favorite && !isVideo(p)) || items.find((p) => !isVideo(p) && p.width >= p.height) || items[Math.floor(items.length / 2)];

// ---------------------------------------------------------------- routing

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const [view, id = ''] = path.split('/');
  const q = new URLSearchParams(query);
  const known = ['photos', 'albums', 'album', 'favorites', 'videos', 'trash', 'backup', 'search'];
  return { view: known.includes(view) ? view : 'photos', id: decodeURIComponent(id), q: q.get('q') || '', connected: q.has('connected') };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  const prev = state.route;
  state.route = parseRoute();
  if (prev.view !== state.route.view || prev.id !== state.route.id) {
    clearSelection(false);
    el.scroll.scrollTop = 0;
  }
  closeDrawer();
  render();
});

// ---------------------------------------------------------------- render

function render() {
  if (!state.ready) return;
  const r = state.route;
  if (r.view === 'album' && !lib.getAlbum(r.id)) return go('#/albums');
  if (document.activeElement !== el.q) el.q.value = r.view === 'search' ? r.q : '';
  renderNav();
  renderTabbar();
  renderCloud();
  const views = { albums: viewAlbums, backup: viewBackup, trash: viewTrash, album: viewAlbum, search: viewSearch, favorites: viewFiltered, videos: viewFiltered };
  (views[r.view] || viewLibrary)();
  hydrate();
  renderSelbar();
  renderZoombar();
  requestAnimationFrame(buildScrubber);
  document.title = `${{ photos: 'Photos', albums: 'Albums', album: lib.getAlbum(r.id)?.name || 'Album', favorites: 'Favorites', videos: 'Videos', trash: 'Recently Deleted', backup: 'Cloud backup', search: `“${r.q}”` }[r.view]} · photos`;
}

function setView(markup) {
  el.view.innerHTML = markup;
}

// The tile: a square crop like both apps' grids. The tick circle (Google) appears on hover and in selection.
function tile(p, { trash = false } = {}) {
  const sel = state.selected.has(p.id);
  const label = `${isVideo(p) ? 'Video' : 'Photo'}, ${longDate(p.takenAt)} ${timeOf(p.takenAt)}${p.favorite ? ', favorite' : ''}`;
  const daysLeft = trash ? Math.max(0, lib.TRASH_DAYS - Math.floor((Date.now() - p.deletedAt) / DAY)) : 0;
  return `<div class="ph-tile${sel ? ' sel' : ''}" data-id="${esc(p.id)}" role="gridcell" aria-selected="${sel}">
    <button type="button" class="ph-open" data-open="${esc(p.id)}" aria-label="${esc(label)}"><img data-thumb="${esc(p.id)}" alt="" draggable="false" /></button>
    <button type="button" class="ph-tick" data-tick="${esc(p.id)}" aria-label="${sel ? 'Deselect' : 'Select'}" aria-pressed="${sel}">${icon('check', { size: 14, stroke: 3 })}</button>
    ${isVideo(p) ? `<span class="ph-badge ph-dur">${p.duration ? dur(p.duration) : ''}${icon('play', { size: 11 })}</span>` : ''}
    ${p.favorite && !trash ? `<span class="ph-badge ph-fav">${icon('heart-fill', { size: 13 })}</span>` : ''}
    ${p.local === false && !trash ? `<span class="ph-badge ph-cloudonly" title="Only in the cloud">${icon('cloud', { size: 13 })}</span>` : ''}
    ${trash ? `<span class="ph-badge ph-left">${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}</span>` : ''}
  </div>`;
}

function grid(items, opts = {}) {
  return `<div class="ph-grid${opts.dense ? ' dense' : ''}" role="grid" aria-label="${esc(opts.label || 'Photos')}"><div role="row" class="ph-row">${items.map((p) => tile(p, opts)).join('')}</div></div>`;
}

function emptyState({ title, text, action = '' }) {
  return `<div class="ph-empty"><div class="ph-empty-art" aria-hidden="true">${icon('photos', { size: 40 })}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
}

function headline(title, sub = '', extra = '') {
  return `<div class="ph-head"><div class="ph-head-text"><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${extra}</div>`;
}

// ---- Library (Apple's four zoom levels)

function viewLibrary() {
  const items = itemsFor();
  state.order = items.map((p) => p.id);
  if (!items.length) {
    setView(
      headline('Photos') +
        emptyState({
          title: 'Your photos will show up here',
          text: 'Import photos and videos from this computer, or drop them anywhere on this page. Connect OneDrive or Google Drive to back them up.',
          action: `<div class="ph-empty-actions"><button type="button" class="btn btn-primary" data-import>${icon('upload', { size: 17 })}Import photos</button><button type="button" class="btn btn-secondary" data-samples>Add sample photos</button><a class="btn btn-ghost" href="#/backup">${icon('cloud', { size: 17 })}Set up backup</a></div>`,
        }),
    );
    return;
  }
  const videos = items.filter(isVideo).length;
  const sub = `${plural(items.length - videos, 'photo')}${videos ? `, ${plural(videos, 'video')}` : ''}`;
  if (state.zoom === 'years') return setView(headline('Photos', sub) + yearCards(items));
  if (state.zoom === 'months') return setView(headline('Photos', sub) + monthCards(items));
  if (state.zoom === 'all') return setView(headline('Photos', sub) + allGrid(items));
  setView(headline('Photos', sub) + memories(items) + daySections(items));
}

function yearCards(items) {
  const years = groupBy(items, (t) => String(new Date(t).getFullYear()));
  return `<div class="ph-cards years">${years
    .map((g) => {
      const k = keyPhoto(g.items);
      return `<button type="button" class="ph-card" data-jump-year="${esc(g.key)}" aria-label="${esc(`${g.key}, ${plural(g.items.length, 'item')}`)}">
        <img data-thumb="${esc(k.id)}" alt="" /><span class="ph-card-text"><strong>${esc(g.key)}</strong><span>${plural(g.items.length, 'item')}</span></span></button>`;
    })
    .join('')}</div>`;
}

function monthCards(items) {
  const months = groupBy(items, monthKey);
  let year = '';
  return months
    .map((g) => {
      const k = keyPhoto(g.items);
      const y = g.key.slice(0, 4);
      const head = y !== year ? `<h2 class="ph-year-head" data-year="${esc(y)}">${esc(y)}</h2>` : '';
      year = y;
      const strip = g.items.filter((p) => p.id !== k.id).slice(0, 3);
      return `${head}<button type="button" class="ph-card month" data-jump-month="${esc(g.key)}" data-month="${esc(g.key)}" aria-label="${esc(`${monthTitle(g.items[0].takenAt)}, ${plural(g.items.length, 'item')}`)}">
        <img data-thumb="${esc(k.id)}" alt="" />
        <span class="ph-card-text"><strong>${esc(fmt(new Date(g.items[0].takenAt), { month: 'long' }))}</strong><span>${plural(g.items.length, 'item')}</span></span>
        ${strip.length ? `<span class="ph-card-strip">${strip.map((p) => `<img data-thumb="${esc(p.id)}" alt="" />`).join('')}</span>` : ''}
      </button>`;
    })
    .join('')
    .replace(/^/, '<div class="ph-cards months">') + '</div>';
}

function daySections(items, { label = 'Photos' } = {}) {
  const days = groupBy(items, dayKey);
  let month = '';
  return days
    .map((g) => {
      const m = g.key.slice(0, 7);
      const mark = m !== month ? ` data-month="${esc(m)}"` : '';
      month = m;
      const allSel = g.items.every((p) => state.selected.has(p.id));
      // Small days sit side by side, as Google Photos packs them; bigger ones take the whole width.
      const pack = g.items.length <= 4 ? ` packed" style="--n:${g.items.length}` : '';
      return `<section class="ph-day${pack}"${mark} aria-label="${esc(dayTitle(g.items[0].takenAt))}">
        <div class="ph-day-head">
          <button type="button" class="ph-day-tick${allSel ? ' on' : ''}" data-tick-day="${esc(g.key)}" aria-pressed="${allSel}" aria-label="Select all from ${esc(dayTitle(g.items[0].takenAt))}">${icon('check', { size: 13, stroke: 3 })}</button>
          <h2>${esc(dayTitle(g.items[0].takenAt))}</h2>
          <span class="ph-day-count">${g.items.length > 1 ? plural(g.items.length, 'item') : ''}</span>
        </div>
        ${grid(g.items, { label })}
      </section>`;
    })
    .join('')
    .replace(/^/, '<div class="ph-days">') + '</div>';
}

function allGrid(items) {
  const months = groupBy(items, monthKey);
  return `<div class="ph-all" style="--cols:${state.cols}">${months
    .map((g) => `<section class="ph-month" data-month="${esc(g.key)}"><h2 class="ph-month-label">${esc(monthTitle(g.items[0].takenAt))}</h2>${grid(g.items, { dense: true })}</section>`)
    .join('')}</div>`;
}

/** Memories (Apple's For You, Google's carousel): On this day, This week, and the last few months. */
function memories(items) {
  if (state.route.view !== 'photos' || items.length < 6) return '';
  const now = new Date();
  const cards = [];
  const otd = items.filter((p) => {
    const d = new Date(p.takenAt);
    return d.getMonth() === now.getMonth() && Math.abs(d.getDate() - now.getDate()) <= 1 && d.getFullYear() < now.getFullYear();
  });
  if (otd.length) {
    const years = now.getFullYear() - new Date(otd[0].takenAt).getFullYear();
    cards.push({ key: 'otd', title: 'On this day', sub: `${years} ${years === 1 ? 'year' : 'years'} ago`, items: otd });
  }
  const week = items.filter((p) => now - p.takenAt < 7 * DAY);
  if (week.length >= 3) cards.push({ key: 'week', title: 'This week', sub: plural(week.length, 'item'), items: week });
  for (const g of groupBy(items, monthKey)) {
    if (cards.length >= 6) break;
    if (g.items.length < 3 || g.key === monthKey(Date.now())) continue;
    cards.push({ key: `m:${g.key}`, title: fmt(new Date(g.items[0].takenAt), { month: 'long' }), sub: String(new Date(g.items[0].takenAt).getFullYear()), items: g.items });
  }
  if (!cards.length) return '';
  memoryCache = new Map(cards.map((c) => [c.key, c.items.map((p) => p.id)]));
  return `<section class="ph-memories" aria-label="Memories"><h2 class="ph-section-title">${icon('memories', { size: 18 })}Memories</h2><div class="ph-mem-row">${cards
    .map((c) => {
      const k = keyPhoto(c.items);
      return `<button type="button" class="ph-mem" data-memory="${esc(c.key)}" aria-label="${esc(`${c.title}, ${c.sub}. Play`)}"><img data-thumb="${esc(k.id)}" alt="" /><span class="ph-mem-text"><strong>${esc(c.title)}</strong><span>${esc(c.sub)}</span></span><span class="ph-mem-play">${icon('play', { size: 14 })}</span></button>`;
    })
    .join('')}</div></section>`;
}
let memoryCache = new Map();

// ---- Favorites, Videos, Search

function viewFiltered() {
  const r = state.route;
  const items = itemsFor();
  state.order = items.map((p) => p.id);
  const title = r.view === 'favorites' ? 'Favorites' : 'Videos';
  if (!items.length) {
    setView(
      headline(title) +
        emptyState(
          r.view === 'favorites'
            ? { title: 'No favorites yet', text: 'Tap the heart on a photo, or press F while viewing it, to keep it here.' }
            : { title: 'No videos yet', text: 'Videos you import show up here, and are backed up like your photos.' },
        ),
    );
    return;
  }
  setView(headline(title, plural(items.length, 'item')) + daySections(items, { label: title }));
}

function viewSearch() {
  const items = itemsFor();
  state.order = items.map((p) => p.id);
  const head = headline(`“${state.route.q}”`, items.length ? plural(items.length, 'result') : '');
  if (!items.length) {
    setView(head + emptyState({ title: 'No results', text: 'Try a month (“july”), a year, a camera, an album, “videos”, “favorites” or “not backed up”.' }));
    return;
  }
  setView(head + daySections(items, { label: 'Results' }));
}

// ---- Albums (Apple's page: My Albums · Media Types · Utilities)

function viewAlbums() {
  state.order = [];
  const albums = lib.allAlbums();
  const all = live();
  const count = (id) => all.filter((p) => p.albumIds?.includes(id)).length;
  const coverOf = (a) => {
    const members = all.filter((p) => p.albumIds?.includes(a.id)).sort(byNewest);
    return members.find((p) => p.id === a.coverId) || members[0] || null;
  };
  const favs = all.filter((p) => p.favorite).sort(byNewest);
  const vids = all.filter(isVideo);
  const card = (href, name, n, cover, { glyph = 'albums', id = '' } = {}) =>
    `<a class="ph-album" href="${esc(href)}"${id ? ` data-album="${esc(id)}"` : ''}><span class="ph-album-cover">${cover ? `<img data-thumb="${esc(cover.id)}" alt="" />` : icon(glyph, { size: 34 })}</span><strong class="truncate">${esc(name)}</strong><span>${n.toLocaleString()}</span></a>`;
  const row = (href, glyph, name, n, extra = '') =>
    `<a class="ph-util" href="${esc(href)}">${icon(glyph, { size: 20 })}<span class="grow">${esc(name)}</span>${extra}<span class="ph-util-n">${n === null ? '' : n.toLocaleString()}</span>${icon('chevron-right', { size: 16 })}</a>`;
  const c = backup.counts(state.cfg);
  setView(`${headline('Albums', '', `<button type="button" class="btn btn-tint btn-sm" data-new-album>${icon('plus', { size: 16 })}New album</button>`)}
    <section class="ph-sec"><h2 class="ph-section-title">My Albums</h2>
      <div class="ph-albums">
        ${card('#/favorites', 'Favorites', favs.length, favs[0], { glyph: 'heart' })}
        ${albums.map((a) => card(`#/album/${encodeURIComponent(a.id)}`, a.name, count(a.id), coverOf(a), { id: a.id })).join('')}
        <button type="button" class="ph-album ph-album-new" data-new-album><span class="ph-album-cover">${icon('plus', { size: 30 })}</span><strong>New album</strong><span>&nbsp;</span></button>
      </div>
    </section>
    <section class="ph-sec"><h2 class="ph-section-title">Media Types</h2>
      <div class="ph-utils">${row('#/videos', 'video', 'Videos', vids.length)}${row('#/favorites', 'heart', 'Favorites', favs.length)}</div>
    </section>
    <section class="ph-sec"><h2 class="ph-section-title">Utilities</h2>
      <div class="ph-utils">
        ${row('#/trash', 'trash', 'Recently Deleted', trashed().length)}
        ${row('#/backup', 'cloud', 'Cloud backup', null, `<span class="ph-util-sub">${esc(state.cfg.provider ? `${PROVIDER_NAME[state.cfg.provider]} · ${c.backedUp.toLocaleString()} of ${c.total.toLocaleString()}` : 'Off')}</span>`)}
        ${row('#/search?q=not%20backed%20up', 'cloud-off', 'Not backed up', state.cfg.provider ? c.waiting : null)}
      </div>
    </section>`);
}

function viewAlbum() {
  const a = lib.getAlbum(state.route.id);
  const items = itemsFor();
  state.order = items.map((p) => p.id);
  const more = `<div class="ph-head-actions">
    ${items.length ? `<button type="button" class="btn btn-tint btn-sm" data-slideshow>${icon('play', { size: 14 })}Play</button>` : ''}
    <button type="button" class="icon-btn" data-album-menu aria-label="Album options" aria-haspopup="menu" ${tipAttrs('Album options')}>${icon('more')}</button></div>`;
  const back = `<a class="ph-back" href="#/albums">${icon('chevron-left', { size: 18 })}Albums</a>`;
  if (!items.length) {
    setView(
      back +
        headline(a.name, '', more) +
        emptyState({ title: 'This album is empty', text: 'Import photos while this album is open, or select photos anywhere and choose Add to album.', action: `<button type="button" class="btn btn-primary" data-import>${icon('upload', { size: 17 })}Import into “${esc(a.name)}”</button>` }),
    );
    return;
  }
  setView(back + headline(a.name, plural(items.length, 'item'), more) + grid(items, { label: a.name }));
}

// ---- Recently Deleted

function viewTrash() {
  const items = trashed();
  state.order = items.map((p) => p.id);
  const extra = items.length ? `<button type="button" class="btn btn-secondary btn-sm" data-empty-trash>Delete all</button>` : '';
  const note = `<p class="ph-note">${icon('info', { size: 16 })}Items are deleted for good after ${lib.TRASH_DAYS} days.${state.cfg.syncDeletes && state.cfg.provider ? ` Their copies in ${PROVIDER_NAME[state.cfg.provider]} move to its recycle bin then.` : ''}</p>`;
  if (!items.length) {
    setView(headline('Recently Deleted') + note + emptyState({ title: 'Nothing here', text: 'Photos and videos you delete stay here for 30 days, so you can change your mind.' }));
    return;
  }
  setView(headline('Recently Deleted', plural(items.length, 'item'), extra) + note + grid(items, { trash: true, label: 'Recently deleted' }));
}

// ---------------------------------------------------------------- Cloud backup page

function viewBackup() {
  state.order = [];
  const cfg = state.cfg;
  const st = state.status;
  const c = backup.counts(cfg);
  const pct = c.total ? Math.round((c.backedUp / c.total) * 100) : 100;
  let hero;
  if (!cfg.provider) {
    hero = `<div class="ph-bk-hero off">${icon('cloud-off', { size: 34 })}<div><h2>Backup is off</h2><p>Keep a copy of every photo and video in your own cloud storage, in a folder Photos makes for them. Choose where:</p></div></div>`;
  } else {
    const running = st.state === 'running';
    const title = running
      ? `Backing up ${Math.min(st.done + 1, st.total)} of ${st.total}`
      : st.state === 'reauth'
        ? `Sign in to ${PROVIDER_NAME[cfg.provider]} again`
        : st.state === 'offline'
          ? 'Waiting for a connection'
          : st.state === 'error'
            ? 'Backup stopped'
            : c.waiting
              ? cfg.auto
                ? `${plural(c.waiting, 'item')} waiting`
                : 'Backup is paused'
              : 'Backup complete';
    const detail = running
      ? esc(st.current)
      : st.state === 'error' || st.state === 'reauth'
        ? esc(st.error || cfg.lastError || '')
        : `${c.backedUp.toLocaleString()} of ${c.total.toLocaleString()} items are in ${esc(PROVIDER_NAME[cfg.provider])}${cfg.lastRunAt ? ` · checked ${esc(timeAgo(cfg.lastRunAt))}` : ''}`;
    const action =
      st.state === 'reauth'
        ? `<button type="button" class="btn btn-primary" data-reconnect>Sign in</button>`
        : running
          ? `<button type="button" class="btn btn-secondary" data-backup-stop>Pause</button>`
          : `<button type="button" class="btn btn-primary" data-backup-now${c.waiting ? '' : ' disabled'}>Back up now</button>`;
    const glyph = running ? 'cloud-up' : st.state === 'error' || st.state === 'reauth' || st.state === 'offline' ? 'cloud-off' : c.waiting ? 'cloud-up' : 'cloud-check';
    hero = `<div class="ph-bk-hero ${running ? 'running' : st.state}">
      <span class="ph-bk-ring" style="--p:${running && st.total ? Math.round((st.done / st.total) * 100) : pct}">${icon(glyph, { size: 30 })}</span>
      <div class="grow"><h2>${esc(title)}</h2><p>${detail}</p>${running ? `<div class="ph-bar"><span style="width:${st.total ? (st.done / st.total) * 100 : 0}%"></span></div>` : ''}</div>
      ${action}</div>`;
  }

  const providerCard = (id, blurb) =>
    `<button type="button" class="ph-provider" data-connect="${id}">${providerLogo(id)}<span class="grow"><strong>${PROVIDER_NAME[id]}</strong><span>${esc(blurb)}</span></span>${icon('chevron-right', { size: 18 })}</button>`;
  const acct = cfg.account || {};
  const quota = acct.total ? `<div class="ph-quota"><div class="ph-bar"><span style="width:${Math.min(100, (acct.used / acct.total) * 100)}%"></span></div><span>${bytes(acct.used)} of ${bytes(acct.total)} used</span></div>` : '';
  const where = cfg.provider
    ? `<div class="group"><div class="ph-row-item">
          ${providerLogo(cfg.provider)}
          <span class="grow"><strong>${esc(PROVIDER_NAME[cfg.provider])}</strong><span class="muted">${esc([acct.name, acct.email].filter(Boolean).join(' · ') || 'Connected')}</span>${quota}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-disconnect>Disconnect</button>
        </div>
        <div class="ph-row-item"><span class="ph-row-glyph">${icon('folder', { size: 20 })}</span><span class="grow"><strong>Backup folder</strong><span class="muted">${esc(PROVIDER_PATH[cfg.provider])} › ${esc(cfg.folderName)} › year › month</span></span><button type="button" class="btn btn-ghost btn-sm" data-rename-folder>Rename</button></div>
      </div>`
    : `<div class="ph-providers">${providerCard('onedrive', 'Into Pictures › ecosys Photos, like Samsung Gallery’s OneDrive sync')}${providerCard('gdrive', 'Into My Drive › ecosys Photos. Photos only sees files it made')}</div>`;

  const sw = (name, on, title, sub) =>
    `<label class="ph-row-item ph-switch-row"><span class="grow"><strong>${esc(title)}</strong><span class="muted">${esc(sub)}</span></span>${switchField({ name, checked: on, ariaLabel: title })}</label>`;
  const freeable = c.freeable;
  const freeBytes = freeable.reduce((n, p) => n + (p.size || 0), 0);
  setView(`${headline('Cloud backup')}
    ${hero}
    <section class="ph-sec"><h2 class="ph-section-title">${cfg.provider ? 'Backing up to' : 'Back up to'}</h2>${where}</section>
    <section class="ph-sec"><h2 class="ph-section-title">Settings</h2><div class="group">
      ${sw('auto', cfg.auto, 'Back up automatically', 'New photos go up while Photos is open in any tab')}
      ${sw('includeVideos', cfg.includeVideos, 'Back up videos', 'Videos can be large; turn this off to keep them on this device only')}
      ${sw('syncDeletes', cfg.syncDeletes, 'Delete from the cloud too', 'When a photo is deleted for good here, its cloud copy goes to the recycle bin')}
    </div></section>
    <section class="ph-sec"><h2 class="ph-section-title">This device</h2><div class="group">
      <div class="ph-row-item"><span class="ph-row-glyph">${icon('archive', { size: 20 })}</span><span class="grow"><strong>Free up space</strong><span class="muted">${
        freeable.length ? `Remove ${plural(freeable.length, 'original')} (${bytes(freeBytes)}) that are safe in the cloud. Previews stay; originals download when you open them.` : cfg.provider ? 'Nothing to free yet: originals can go once they’re backed up.' : 'Connect a cloud first.'
      }</span></span><button type="button" class="btn btn-secondary btn-sm" data-free-space${freeable.length ? '' : ' disabled'}>Free up</button></div>
      ${c.cloudOnly ? `<div class="ph-row-item"><span class="ph-row-glyph">${icon('download', { size: 20 })}</span><span class="grow"><strong>Download originals</strong><span class="muted">${plural(c.cloudOnly, 'item')} only in the cloud</span></span><button type="button" class="btn btn-secondary btn-sm" data-download-all${cfg.provider ? '' : ' disabled'}>Download</button></div>` : ''}
      ${cfg.provider ? `<div class="ph-row-item"><span class="ph-row-glyph">${icon('refresh', { size: 20 })}</span><span class="grow"><strong>Restore from ${esc(PROVIDER_NAME[cfg.provider])}</strong><span class="muted">Bring in photos from the backup folder that aren’t in this library, from another browser or computer</span></span><button type="button" class="btn btn-secondary btn-sm" data-restore>Restore</button></div>` : ''}
      <div class="ph-row-item" id="device-usage"><span class="ph-row-glyph">${icon('image', { size: 20 })}</span><span class="grow"><strong>Stored in this browser</strong><span class="muted" data-usage>…</span></span></div>
    </div></section>
    <p class="ph-fine">Photos signs in to your cloud directly from this browser. Nothing passes through an ecosys server, and the sign-in stays in this browser. ${cfg.provider === 'gdrive' ? 'Google sign-ins last an hour; after that, backing up asks you to continue with one click.' : ''}</p>`);
  lib.storageEstimate().then((est) => {
    const u = $('[data-usage]', el.view);
    if (!u) return;
    const mine = live().reduce((n, p) => n + (p.local !== false ? p.size || 0 : 0), 0);
    u.textContent = `${bytes(mine)} of originals${est?.quota ? ` · ${bytes(est.quota - est.usage)} free for this site` : ''}`;
  });
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmt(new Date(t), { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- chrome: sidebar, tab bar, cloud button, zoom bar

function renderNav() {
  const r = state.route;
  const cur = (k) => String(r.view === k);
  const all = live();
  const item = (href, key, glyph, label, n = 0) =>
    `<a class="nav-item" href="${href}" aria-current="${cur(key)}">${icon(glyph)}<span class="label">${esc(label)}</span>${n ? `<span class="badge">${n.toLocaleString()}</span>` : ''}</a>`;
  const albums = lib.allAlbums();
  el.nav.innerHTML = `
    ${item('#/photos', 'photos', 'photos', 'Photos')}
    ${item('#/albums', 'albums', 'albums', 'Albums')}
    ${item('#/favorites', 'favorites', 'heart', 'Favorites', all.filter((p) => p.favorite).length)}
    ${item('#/videos', 'videos', 'video', 'Videos', all.filter(isVideo).length)}
    <div class="side-section">
      <div class="side-label"><span>My Albums</span><button type="button" class="icon-btn sm" data-new-album aria-label="New album" ${tipAttrs('New album')}>${icon('plus', { size: 16 })}</button></div>
      ${albums.map((a) => `<a class="nav-item" href="#/album/${encodeURIComponent(a.id)}" data-album="${esc(a.id)}" aria-current="${r.view === 'album' && r.id === a.id}">${icon('albums', { size: 18 })}<span class="label">${esc(a.name)}</span><span class="badge">${all.filter((p) => p.albumIds?.includes(a.id)).length || ''}</span></a>`).join('') || '<p class="side-empty">No albums yet</p>'}
    </div>
    <div class="side-section">
      <div class="side-label"><span>Utilities</span></div>
      ${item('#/trash', 'trash', 'trash', 'Recently Deleted', trashed().length)}
      ${item('#/backup', 'backup', 'cloud', 'Cloud backup')}
    </div>`;
  renderSideBackup();
}

/** Google Photos' storage card at the foot of the sidebar: where backup stands, at a glance. */
function renderSideBackup() {
  const cfg = state.cfg;
  const st = state.status;
  const c = backup.counts(cfg);
  let text;
  let glyph = 'cloud-check';
  let pct = c.total ? (c.backedUp / c.total) * 100 : 0;
  if (state.importing) {
    glyph = 'upload';
    text = `Importing ${state.importing.done} of ${state.importing.total}`;
    pct = (state.importing.done / state.importing.total) * 100;
  } else if (!cfg.provider) {
    glyph = 'cloud-off';
    text = 'Backup is off';
  } else if (st.state === 'running') {
    glyph = 'cloud-up';
    text = `Backing up · ${st.done} of ${st.total}`;
    pct = st.total ? (st.done / st.total) * 100 : 0;
  } else if (st.state === 'reauth') {
    glyph = 'cloud-off';
    text = `Sign in to ${PROVIDER_NAME[cfg.provider]}`;
  } else if (st.state === 'error' || st.state === 'offline') {
    glyph = 'cloud-off';
    text = st.state === 'offline' ? 'Waiting for connection' : 'Backup stopped';
  } else text = c.waiting ? `${plural(c.waiting, 'item')} waiting` : 'Backup complete';
  el.sideBackup.innerHTML = `${icon(glyph, { size: 20 })}<span class="grow"><strong>${esc(text)}</strong>${cfg.provider ? `<span>${esc(PROVIDER_NAME[cfg.provider])}${cfg.account?.total ? ` · ${bytes(cfg.account.used)} of ${bytes(cfg.account.total)}` : ''}</span>` : '<span>Connect OneDrive or Google Drive</span>'}${
    cfg.provider || state.importing ? `<span class="ph-bar sm"><span style="width:${pct}%"></span></span>` : ''
  }</span>`;
  el.sideBackup.setAttribute('aria-current', String(state.route.view === 'backup'));
}

function renderCloud() {
  const cfg = state.cfg;
  const st = state.status;
  const c = backup.counts(cfg);
  const running = st.state === 'running';
  const bad = cfg.provider && ['error', 'reauth', 'offline'].includes(st.state);
  const glyph = !cfg.provider || bad ? 'cloud-off' : running || c.waiting ? 'cloud-up' : 'cloud-check';
  const label = !cfg.provider ? 'Backup is off' : running ? `Backing up ${st.done} of ${st.total}` : bad ? 'Backup needs attention' : c.waiting ? `${c.waiting} waiting to back up` : `Backed up to ${PROVIDER_NAME[cfg.provider]}`;
  el.cloud.innerHTML = `<span class="ph-cloud-ring${running ? ' spin' : ''}" style="--p:${running && st.total ? (st.done / st.total) * 100 : 100}"></span>${icon(glyph)}${bad ? '<span class="ph-cloud-dot"></span>' : ''}`;
  el.cloud.className = `icon-btn ph-cloud-btn${cfg.provider ? '' : ' off'}${bad ? ' bad' : ''}`;
  el.cloud.setAttribute('aria-label', label);
  el.cloud.dataset.tip = label;
}

function renderTabbar() {
  const v = state.route.view;
  const t = (href, on, glyph, label) => `<a href="${href}" aria-current="${on}">${icon(glyph)}<span>${label}</span></a>`;
  el.tabbar.innerHTML =
    t('#/photos', v === 'photos', 'photos', 'Library') +
    t('#/albums', ['albums', 'album', 'favorites', 'videos', 'trash'].includes(v), 'albums', 'Albums') +
    `<button type="button" data-focus-search aria-current="${v === 'search'}">${icon('search')}<span>Search</span></button>` +
    t('#/backup', v === 'backup', 'cloud', 'Backup');
}

function renderZoombar() {
  const show = state.route.view === 'photos' && live().length > 0 && !state.selected.size;
  el.zoombar.hidden = !show;
  if (!show) return;
  const seg = (z, label) => `<button type="button" data-zoom="${z}" aria-pressed="${state.zoom === z}">${label}</button>`;
  el.zoombar.innerHTML = `<div class="segmented ph-seg" role="group" aria-label="Show by">${seg('years', 'Years')}${seg('months', 'Months')}${seg('days', 'Days')}${seg('all', 'All')}</div>${
    state.zoom === 'all'
      ? `<div class="ph-zoom-step"><button type="button" class="icon-btn sm" data-cols="1" aria-label="Smaller" ${tipAttrs('Smaller', 'mod -')}>${icon('minus', { size: 16 })}</button><button type="button" class="icon-btn sm" data-cols="-1" aria-label="Bigger" ${tipAttrs('Bigger', 'mod =')}>${icon('plus', { size: 16 })}</button></div>`
      : ''
  }`;
}

function setZoom(z, { month = '', year = '' } = {}) {
  state.zoom = z;
  local('zoom', z);
  if (state.route.view !== 'photos') return go('#/photos');
  render();
  const target = month ? $(`[data-month="${CSS.escape(month)}"]`, el.view) : year ? $(`[data-month^="${CSS.escape(year)}"], [data-year="${CSS.escape(year)}"]`, el.view) : null;
  if (target) target.scrollIntoView({ block: 'start' });
  else el.scroll.scrollTop = 0;
}

// ---------------------------------------------------------------- date scrubber (Google Photos)

let scrubMarks = [];
function buildScrubber() {
  const sc = el.scroll;
  const v = state.route.view;
  const ok = ['photos', 'favorites', 'videos', 'search'].includes(v) && (v !== 'photos' || state.zoom === 'days' || state.zoom === 'all') && sc.scrollHeight > sc.clientHeight * 2.2;
  el.scrubber.classList.toggle('on', ok);
  if (!ok) return;
  const max = sc.scrollHeight - sc.clientHeight;
  scrubMarks = $$('[data-month]', el.view).map((n) => ({ month: n.dataset.month, top: n.offsetTop, frac: Math.min(1, n.offsetTop / max) }));
  const years = [];
  for (const m of scrubMarks) {
    const y = m.month.slice(0, 4);
    if (years.at(-1)?.y === y) continue;
    if (years.length && m.frac - years.at(-1).frac < 0.06) continue;
    years.push({ y, frac: m.frac });
  }
  $('.ph-scrub-marks', el.scrubber).innerHTML =
    scrubMarks.map((m) => `<i style="top:${m.frac * 100}%"></i>`).join('') + years.map((y) => `<b style="top:${y.frac * 100}%">${esc(y.y)}</b>`).join('');
}

function scrubTo(clientY, { show = true } = {}) {
  const r = el.scrubber.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  const sc = el.scroll;
  sc.scrollTop = frac * (sc.scrollHeight - sc.clientHeight);
  const at = [...scrubMarks].reverse().find((m) => m.top <= sc.scrollTop + 8) || scrubMarks[0];
  const bubble = $('.ph-scrub-bubble', el.scrubber);
  if (at && show) {
    bubble.textContent = fmt(new Date(`${at.month}-15T12:00`), { month: 'short', year: 'numeric' });
    bubble.style.top = `${frac * 100}%`;
    el.scrubber.classList.add('dragging');
  }
}
el.scrubber.addEventListener('pointerdown', (e) => {
  el.scrubber.setPointerCapture(e.pointerId);
  scrubTo(e.clientY);
});
el.scrubber.addEventListener('pointermove', (e) => {
  if (el.scrubber.hasPointerCapture(e.pointerId)) scrubTo(e.clientY);
});
el.scrubber.addEventListener('pointerup', () => el.scrubber.classList.remove('dragging'));
el.scrubber.addEventListener('pointercancel', () => el.scrubber.classList.remove('dragging'));
el.scroll.addEventListener('scroll', () => el.top.classList.toggle('scrolled', el.scroll.scrollTop > 8), { passive: true });
window.addEventListener('resize', () => requestAnimationFrame(buildScrubber));

// ---------------------------------------------------------------- selection (Google Photos)

function toggleSelect(id, { range = false } = {}) {
  if (range && state.anchor && state.order.includes(state.anchor)) {
    const a = state.order.indexOf(state.anchor);
    const b = state.order.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (const x of state.order.slice(lo, hi + 1)) state.selected.add(x);
  } else if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  state.anchor = id;
  syncSelection();
}

function clearSelection(paint = true) {
  if (!state.selected.size) return;
  state.selected.clear();
  state.anchor = null;
  if (paint) syncSelection();
}

/** Repaint ticks in place (no re-render, so the scroll position and loaded images stay). */
function syncSelection() {
  for (const t of $$('.ph-tile', el.view)) {
    const on = state.selected.has(t.dataset.id);
    t.classList.toggle('sel', on);
    t.setAttribute('aria-selected', String(on));
    const b = $('.ph-tick', t);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Deselect' : 'Select');
  }
  for (const s of $$('.ph-day', el.view)) {
    const on = $$('.ph-tile', s).every((t) => state.selected.has(t.dataset.id));
    const b = $('.ph-day-tick', s);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  el.view.classList.toggle('selecting', state.selected.size > 0);
  renderSelbar();
  renderZoombar();
}

function renderSelbar() {
  const n = state.selected.size;
  el.selbar.hidden = !n;
  el.top.hidden = !!n;
  el.view.classList.toggle('selecting', n > 0);
  if (!n) return;
  const v = state.route.view;
  const ids = [...state.selected];
  const allFav = ids.every((id) => lib.getPhoto(id)?.favorite);
  const b = (attr, glyph, label) => `<button type="button" class="icon-btn" ${attr} aria-label="${esc(label)}" ${tipAttrs(label)}>${icon(glyph)}</button>`;
  const actions =
    v === 'trash'
      ? `<button type="button" class="btn btn-secondary btn-sm" data-restore-sel>Recover</button><button type="button" class="btn btn-danger btn-sm" data-purge-sel>Delete</button>`
      : `${b('data-fav-sel', allFav ? 'heart-fill' : 'heart', allFav ? 'Unfavorite' : 'Favorite')}${b('data-album-sel aria-haspopup="menu"', 'albums', 'Add to album')}${
          v === 'album' ? b('data-unalbum-sel', 'minus', 'Remove from album') : ''
        }${b('data-download-sel', 'download', 'Download')}${b('data-trash-sel', 'trash', 'Delete')}`;
  el.selbar.innerHTML = `<button type="button" class="icon-btn" data-clear-sel aria-label="Clear selection" ${tipAttrs('Clear selection', 'esc')}>${icon('x')}</button>
    <strong class="ph-sel-n" aria-live="polite">${n.toLocaleString()} selected</strong>
    <button type="button" class="btn btn-ghost btn-sm ph-sel-all" data-select-all>Select all</button>
    <span class="grow"></span>${actions}`;
}

// ---------------------------------------------------------------- actions

async function moveToTrash(ids) {
  if (!ids.length) return;
  const at = Date.now();
  await lib.updatePhotos(ids, { deletedAt: at });
  clearSelection();
  closeViewerIf(ids);
  undoable(`Moved ${plural(ids.length, 'item')} to Recently Deleted`, async () => {
    await lib.updatePhotos(ids, { deletedAt: null });
  });
}

async function purge(ids, { ask = true } = {}) {
  if (!ids.length) return;
  const cfg = state.cfg;
  const inCloud = ids.filter((id) => lib.getPhoto(id)?.cloud).length;
  if (ask) {
    const cloudLine = inCloud && cfg.syncDeletes && cfg.provider ? ` Their ${plural(inCloud, 'copy', 'copies')} in ${PROVIDER_NAME[cfg.provider]} will move to its recycle bin.` : '';
    const ok = await confirmDialog({ title: `Delete ${plural(ids.length, 'item')} for good?`, message: `This can’t be undone on this device.${cloudLine}`, confirm: 'Delete', danger: true });
    if (!ok) return;
  }
  const list = ids.map((id) => lib.getPhoto(id)).filter(Boolean);
  await lib.deletePhotos(ids);
  for (const id of ids) dropThumb(id);
  clearSelection();
  backup.forgetInCloud(list).catch(() => {});
  toast(`Deleted ${plural(ids.length, 'item')}`);
}

async function restoreFromTrash(ids) {
  await lib.updatePhotos(ids, { deletedAt: null });
  clearSelection();
  toast(`Recovered ${plural(ids.length, 'item')}`);
}

async function toggleFavorite(ids, value) {
  const on = value ?? !ids.every((id) => lib.getPhoto(id)?.favorite);
  await lib.updatePhotos(ids, { favorite: on });
  if (ids.length > 1) toast(on ? `Added ${plural(ids.length, 'item')} to Favorites` : `Removed ${plural(ids.length, 'item')} from Favorites`);
  else announce(on ? 'Added to Favorites' : 'Removed from Favorites');
}

async function addToAlbum(ids, albumId) {
  const a = lib.getAlbum(albumId);
  await lib.updatePhotos(ids, (p) => ({ albumIds: [...new Set([...(p.albumIds || []), albumId])] }));
  if (!a.coverId) await lib.saveAlbum({ ...a, coverId: ids[0] });
  clearSelection();
  toast(`Added ${plural(ids.length, 'item')} to “${a.name}”`, { action: 'View', onAction: () => go(`#/album/${encodeURIComponent(albumId)}`) });
}

function albumMenu(anchor, ids) {
  const albums = lib.allAlbums();
  openMenu(anchor, [
    ...albums.map((a) => ({ label: a.name, icon: 'albums', onSelect: () => addToAlbum(ids, a.id) })),
    albums.length ? { sep: true } : null,
    { label: 'New album…', icon: 'plus', onSelect: () => newAlbum(ids) },
  ], { label: 'Add to album' });
}

function promptName({ title, value = '', confirm = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    let out = null;
    openModal({
      title,
      className: 'ph-prompt',
      body: `<form class="modal-body" data-form><input class="input" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="80" required autocomplete="off" />
        <div class="ph-modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">${esc(confirm)}</button></div></form>`,
      onMount: (m, close) => {
        const input = $('input', m);
        input.select();
        $('[data-form]', m).addEventListener('submit', (e) => {
          e.preventDefault();
          out = input.value.trim().slice(0, 80);
          if (out) close();
        });
      },
      onClose: () => resolve(out || null),
    });
  });
}

async function newAlbum(ids = []) {
  const name = await promptName({ title: 'New album', confirm: 'Create', placeholder: 'Album name' });
  if (!name) return;
  const a = await lib.saveAlbum({ id: lib.uid(), name, createdAt: Date.now(), coverId: ids[0] || null });
  if (ids.length) await addToAlbum(ids, a.id);
  else go(`#/album/${encodeURIComponent(a.id)}`);
}

async function downloadItems(ids) {
  let n = 0;
  for (const id of ids) {
    const p = lib.getPhoto(id);
    if (!p) continue;
    try {
      const blob = await backup.original(p);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = p.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      n++;
      if (ids.length > 1) await new Promise((r) => setTimeout(r, 250)); // browsers drop rapid-fire downloads
    } catch (err) {
      toast(`Couldn’t download ${p.name}: ${err.message}`);
    }
  }
  if (n > 1) toast(`Downloading ${plural(n, 'item')}`);
}

// Touch: a long press on a tile starts selecting (both apps), and the click that follows is swallowed.
let press = null;
el.view.addEventListener('pointerdown', (e) => {
  const open = e.pointerType !== 'mouse' && e.target.closest('[data-open]');
  if (!open) return;
  press = { id: open.dataset.open, x: e.clientX, y: e.clientY, fired: false };
  press.timer = setTimeout(() => {
    press.fired = true;
    navigator.vibrate?.(10);
    toggleSelect(press.id);
  }, 450);
});
const cancelPress = (e) => {
  if (!press) return;
  if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) return;
  clearTimeout(press.timer);
  if (!press.fired) press = null;
};
el.view.addEventListener('pointermove', cancelPress);
el.view.addEventListener('pointercancel', cancelPress);
el.view.addEventListener('contextmenu', (e) => press && e.preventDefault());
el.view.addEventListener(
  'click',
  (e) => {
    if (press?.fired && e.target.closest('[data-open]')) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (press) clearTimeout(press.timer);
    press = null;
  },
  true,
);

// ---------------------------------------------------------------- import

function pickFiles() {
  el.file.value = '';
  el.file.click();
}

async function importList(files) {
  const list = [...files].filter((f) => media.mediaType(f));
  if (!list.length) return toast('Those files aren’t photos or videos Photos can keep.');
  if (state.importing) return toast('Still importing the last batch. Try again in a moment.');
  const albumId = state.route.view === 'album' ? state.route.id : null;
  state.importing = { done: 0, total: list.length };
  renderSideBackup();
  lib.persistStorage();
  try {
    const { added, skipped } = await media.importFiles(list, {
      albumId,
      onProgress: (p) => {
        state.importing = p;
        renderSideBackup();
      },
    });
    const dups = skipped.filter((s) => s.reason === 'duplicate').length;
    const bad = skipped.length - dups;
    const parts = [added.length ? `Added ${plural(added.length, 'item')}` : 'Nothing new to add'];
    if (dups) parts.push(`${dups} already here`);
    if (bad) parts.push(`${bad} couldn’t be read`);
    if (added.length && state.zoom !== 'days' && state.route.view === 'photos') setZoom('days');
    toast(parts.join(' · '));
  } catch (err) {
    toast(err?.name === 'QuotaExceededError' ? 'This browser is out of space for photos. Free up space in Cloud backup.' : `Import stopped: ${err.message}`, { duration: 8000 });
  } finally {
    state.importing = null;
    renderSideBackup();
    backup.run();
  }
}

el.file.addEventListener('change', () => el.file.files?.length && importList(el.file.files));

// Drop files anywhere (Google Photos), paste an image (Apple).
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('p', el.drop).textContent = state.route.view === 'album' ? `Drop to add to “${lib.getAlbum(state.route.id)?.name}”` : 'Drop to add to Photos';
  el.drop.hidden = false;
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.drop.hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  importList(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  if (isTyping(e)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) importList(files);
});

// ---------------------------------------------------------------- viewer (Apple's filmstrip, Google's info panel)

const viewer = { open: false, ids: [], i: 0, el: null, url: '', zoom: 1, panX: 0, panY: 0, info: local('info') === '1', show: null, token: 0 };

function openViewer(ids, i = 0, { slideshow = false } = {}) {
  if (!ids.length) return;
  viewer.ids = ids;
  viewer.i = Math.max(0, Math.min(i, ids.length - 1));
  if (!viewer.open) {
    viewer.open = true;
    viewer.opener = document.activeElement;
    viewer.el = document.createElement('div');
    viewer.el.className = 'ph-viewer';
    viewer.el.setAttribute('role', 'dialog');
    viewer.el.setAttribute('aria-modal', 'true');
    viewer.el.setAttribute('aria-label', 'Photo');
    viewer.el.innerHTML = `
      <header class="pv-top">
        <button type="button" class="icon-btn" data-pv-close aria-label="Close" ${tipAttrs('Close', 'esc')}>${icon('chevron-left')}</button>
        <div class="pv-title"><strong></strong><span></span></div>
        <span class="grow"></span>
        <button type="button" class="icon-btn" data-pv-fav aria-label="Favorite" ${tipAttrs('Favorite', 'f')}></button>
        <button type="button" class="icon-btn" data-pv-info aria-label="Info" ${tipAttrs('Info', 'i')}>${icon('info')}</button>
        <button type="button" class="icon-btn" data-pv-trash aria-label="Delete" ${tipAttrs('Delete', 'delete')}>${icon('trash')}</button>
        <button type="button" class="icon-btn" data-pv-more aria-label="More" aria-haspopup="menu" ${tipAttrs('More')}>${icon('more')}</button>
      </header>
      <div class="pv-body">
        <div class="pv-stage">
          <div class="pv-media"></div>
          <div class="pv-loading" hidden><span class="pv-spin"></span><span></span></div>
          <button type="button" class="pv-nav prev" data-pv-prev aria-label="Previous">${icon('chevron-left', { size: 26 })}</button>
          <button type="button" class="pv-nav next" data-pv-next aria-label="Next">${icon('chevron-right', { size: 26 })}</button>
        </div>
        <aside class="pv-info" aria-label="Info"></aside>
      </div>
      <div class="pv-strip" role="listbox" aria-label="Filmstrip"></div>`;
    document.body.append(viewer.el);
    for (const n of [el.shell]) n.inert = true;
    bindViewer();
  }
  viewer.el.classList.toggle('info', viewer.info);
  renderStrip();
  showCurrent();
  $('[data-pv-close]', viewer.el).focus({ preventScroll: true });
  if (slideshow) startSlideshow();
}

function closeViewer() {
  if (!viewer.open) return;
  stopSlideshow();
  const shown = viewer.ids[viewer.i];
  viewer.open = false;
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  viewer.url = '';
  viewer.el.remove();
  viewer.el = null;
  el.shell.inert = false;
  // Back to the tile of the photo last shown (Apple and Google both keep your place).
  const t = $(`.ph-tile[data-id="${CSS.escape(shown || '')}"] .ph-open`, el.view);
  if (t) {
    t.scrollIntoView({ block: 'nearest' });
    t.focus({ preventScroll: true });
  } else viewer.opener?.focus?.({ preventScroll: true });
}

function closeViewerIf(ids) {
  if (!viewer.open) return;
  const left = viewer.ids.filter((id) => !ids.includes(id));
  if (!left.length) return closeViewer();
  const cur = viewer.ids[viewer.i];
  const idx = ids.includes(cur) ? Math.min(viewer.i, left.length - 1) : left.indexOf(cur);
  viewer.ids = left;
  viewer.i = idx;
  renderStrip();
  showCurrent();
}

async function showCurrent() {
  const p = lib.getPhoto(viewer.ids[viewer.i]);
  if (!p) return closeViewer();
  const v = viewer.el;
  const token = ++viewer.token;
  viewer.zoom = 1;
  viewer.panX = viewer.panY = 0;
  $('.pv-title strong', v).textContent = dayTitle(p.takenAt) === 'Today' || dayTitle(p.takenAt) === 'Yesterday' ? dayTitle(p.takenAt) : fmt(new Date(p.takenAt), { month: 'long', day: 'numeric', year: 'numeric' });
  $('.pv-title span', v).textContent = `${timeOf(p.takenAt)}${viewer.ids.length > 1 ? ` · ${viewer.i + 1} of ${viewer.ids.length}` : ''}`;
  const fav = $('[data-pv-fav]', v);
  fav.innerHTML = icon(p.favorite ? 'heart-fill' : 'heart');
  fav.classList.toggle('on', !!p.favorite);
  fav.setAttribute('aria-pressed', String(!!p.favorite));
  fav.hidden = !!p.deletedAt;
  $('[data-pv-prev]', v).hidden = viewer.i === 0;
  $('[data-pv-next]', v).hidden = viewer.i >= viewer.ids.length - 1;
  for (const s of $$('.pv-strip [data-i]', v)) s.setAttribute('aria-selected', String(Number(s.dataset.i) === viewer.i));
  $(`.pv-strip [data-i="${viewer.i}"]`, v)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  renderInfo(p);

  // The preview straight away, the original as soon as it's here (from this device, or the cloud).
  const box = $('.pv-media', v);
  const thumb = await thumbUrl(p.id);
  if (token !== viewer.token) return;
  box.innerHTML = isVideo(p) ? `<img class="pv-poster" src="${esc(thumb)}" alt="" />` : `<img class="pv-img" src="${esc(thumb)}" alt="${esc(p.name)}" draggable="false" />`;
  applyZoom();
  const loading = $('.pv-loading', v);
  const slow = setTimeout(() => {
    if (token !== viewer.token) return;
    loading.hidden = false;
    $('span:last-child', loading).textContent = p.local === false && p.cloud ? `Downloading from ${PROVIDER_NAME[p.cloud.provider]}…` : 'Loading…';
  }, 250);
  let blob = null;
  try {
    blob = await backup.original(p);
  } catch (err) {
    if (token === viewer.token) {
      clearTimeout(slow);
      loading.hidden = false;
      $('.pv-spin', loading).hidden = true;
      $('span:last-child', loading).textContent = err.code === 'reauth' ? `Sign in to ${PROVIDER_NAME[p.cloud?.provider] || 'your cloud'} again to see the original.` : `Couldn’t load the original: ${err.message}`;
    }
    return;
  }
  clearTimeout(slow);
  if (token !== viewer.token) return;
  loading.hidden = true;
  if (!blob) return;
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  viewer.url = URL.createObjectURL(blob);
  if (isVideo(p)) {
    box.innerHTML = `<video class="pv-video" src="${esc(viewer.url)}" controls playsinline ${viewer.show ? 'autoplay muted' : ''}></video>`;
  } else {
    const img = new Image();
    img.className = 'pv-img';
    img.alt = p.name;
    img.draggable = false;
    img.src = viewer.url;
    try {
      await img.decode();
    } catch {
      return; // the browser can't draw this format: the preview stays
    }
    if (token !== viewer.token) return;
    box.replaceChildren(img);
    applyZoom();
  }
  // Warm the neighbours' previews for instant paging.
  for (const j of [viewer.i - 1, viewer.i + 1]) if (viewer.ids[j]) thumbUrl(viewer.ids[j]);
}

function renderStrip() {
  const strip = $('.pv-strip', viewer.el);
  const many = viewer.ids.length > 1;
  strip.hidden = !many;
  if (!many) return;
  strip.innerHTML = viewer.ids.map((id, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${i === viewer.i}" aria-label="Item ${i + 1}" tabindex="-1"><img data-thumb="${esc(id)}" alt="" /></button>`).join('');
  hydrate(strip);
}

function renderInfo(p) {
  const box = $('.pv-info', viewer.el);
  const albums = (p.albumIds || []).map((id) => lib.getAlbum(id)).filter(Boolean);
  const mp = p.width && p.height ? `${((p.width * p.height) / 1e6).toFixed(1)} MP · ` : '';
  const cloud = p.cloud
    ? `${icon('cloud-check', { size: 18 })}<span><strong>Backed up</strong><span>${esc(PROVIDER_NAME[p.cloud.provider] || 'Cloud')}${p.local === false ? ' · original only in the cloud' : ''}</span></span>`
    : state.cfg.provider
      ? `${icon('cloud-up', { size: 18 })}<span><strong>Waiting to back up</strong><span>${esc(PROVIDER_NAME[state.cfg.provider])}</span></span>`
      : `${icon('cloud-off', { size: 18 })}<span><strong>Not backed up</strong><span><a href="#/backup" data-pv-close>Set up Cloud backup</a></span></span>`;
  box.innerHTML = `<div class="pv-info-head"><h2>Info</h2><button type="button" class="icon-btn" data-pv-info aria-label="Close info">${icon('x')}</button></div>
    <dl>
      <div>${icon('calendar', { size: 18 })}<span><strong>${esc(longDate(p.takenAt))}</strong><span>${esc(timeOf(p.takenAt))}</span></span></div>
      <div>${icon(isVideo(p) ? 'video' : 'image', { size: 18 })}<span><strong class="pv-wrap">${esc(p.name)}</strong><span>${mp}${p.width ? `${p.width} × ${p.height} · ` : ''}${bytes(p.size)}${p.duration ? ` · ${dur(p.duration)}` : ''}</span></span></div>
      ${p.camera ? `<div>${icon('eye', { size: 18 })}<span><strong>${esc(p.camera)}</strong><span>${esc(p.exposure || '')}</span></span></div>` : ''}
      ${albums.length ? `<div>${icon('albums', { size: 18 })}<span><strong>In ${albums.length === 1 ? 'album' : 'albums'}</strong><span>${albums.map((a) => `<a href="#/album/${encodeURIComponent(a.id)}" data-pv-close>${esc(a.name)}</a>`).join(', ')}</span></span></div>` : ''}
      <div>${cloud}</div>
      ${p.deletedAt ? `<div>${icon('trash', { size: 18 })}<span><strong>In Recently Deleted</strong><span>Deleted for good in ${Math.max(0, lib.TRASH_DAYS - Math.floor((Date.now() - p.deletedAt) / DAY))} days</span></span></div>` : ''}
    </dl>`;
}

function step(d) {
  const j = viewer.i + d;
  if (j < 0 || j >= viewer.ids.length) return false;
  viewer.i = j;
  showCurrent();
  return true;
}

function applyZoom() {
  const img = $('.pv-img', viewer.el);
  if (!img) return;
  img.style.transform = viewer.zoom === 1 ? '' : `translate(${viewer.panX}px, ${viewer.panY}px) scale(${viewer.zoom})`;
  viewer.el.classList.toggle('zoomed', viewer.zoom > 1);
}

function startSlideshow() {
  stopSlideshow();
  viewer.el.classList.add('show');
  viewer.show = setInterval(() => {
    if (!step(1)) stopSlideshow();
  }, 3500);
  toast('Slideshow. Press any key to stop.', { duration: 2500 });
}
function stopSlideshow() {
  if (!viewer.show) return;
  clearInterval(viewer.show);
  viewer.show = null;
  viewer.el?.classList.remove('show');
}

function bindViewer() {
  const v = viewer.el;
  v.addEventListener('click', async (e) => {
    const t = e.target;
    const p = lib.getPhoto(viewer.ids[viewer.i]);
    if (t.closest('[data-pv-close]')) return closeViewer();
    if (t.closest('[data-pv-prev]')) return step(-1);
    if (t.closest('[data-pv-next]')) return step(1);
    const s = t.closest('.pv-strip [data-i]');
    if (s) {
      viewer.i = Number(s.dataset.i);
      return showCurrent();
    }
    if (t.closest('[data-pv-info]')) {
      viewer.info = !viewer.info;
      local('info', viewer.info ? '1' : '0');
      return v.classList.toggle('info', viewer.info);
    }
    if (!p) return;
    if (t.closest('[data-pv-fav]')) {
      await toggleFavorite([p.id]);
      return showCurrent();
    }
    if (t.closest('[data-pv-trash]')) return p.deletedAt ? purge([p.id]) : moveToTrash([p.id]);
    const more = t.closest('[data-pv-more]');
    if (more) {
      const album = state.route.view === 'album' ? lib.getAlbum(state.route.id) : null;
      openMenu(more, [
        { label: 'Download', icon: 'download', onSelect: () => downloadItems([p.id]) },
        !p.deletedAt && { label: 'Add to album…', icon: 'albums', onSelect: () => albumMenu(more, [p.id]) },
        album && { label: 'Make album cover', icon: 'image', onSelect: () => lib.saveAlbum({ ...album, coverId: p.id }).then(() => toast('Album cover updated')) },
        viewer.ids.length > 1 && { label: 'Slideshow', icon: 'slideshow', onSelect: () => startSlideshow() },
        { sep: true },
        p.deletedAt ? { label: 'Recover', icon: 'undo', onSelect: () => restoreFromTrash([p.id]).then(() => closeViewerIf([p.id])) } : null,
        { label: p.deletedAt ? 'Delete for good' : 'Delete', icon: 'trash', danger: true, onSelect: () => (p.deletedAt ? purge([p.id]) : moveToTrash([p.id])) },
      ], { label: 'More' });
    }
  });

  // Double-click / double-tap zooms (Apple); wheel zooms; drag pans when zoomed, swipes when not.
  const stage = $('.pv-stage', v);
  stage.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.pv-img')) return;
    viewer.zoom = viewer.zoom > 1 ? 1 : 2.5;
    viewer.panX = viewer.panY = 0;
    applyZoom();
  });
  stage.addEventListener(
    'wheel',
    (e) => {
      if (!$('.pv-img', v) || (!e.ctrlKey && Math.abs(e.deltaY) < Math.abs(e.deltaX))) return;
      e.preventDefault();
      viewer.zoom = Math.min(6, Math.max(1, viewer.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (viewer.zoom < 1.02) {
        viewer.zoom = 1;
        viewer.panX = viewer.panY = 0;
      }
      applyZoom();
    },
    { passive: false },
  );
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, video')) return;
    drag = { x: e.clientX, y: e.clientY, px: viewer.panX, py: viewer.panY, id: e.pointerId, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (viewer.zoom > 1) {
      viewer.panX = drag.px + dx;
      viewer.panY = drag.py + dy;
      applyZoom();
    } else {
      const m = $('.pv-media', v);
      m.style.transform = `translate(${dx}px, ${Math.max(0, dy) * 0.6}px)`;
      m.style.opacity = String(1 - Math.min(0.5, Math.max(0, dy) / 400));
    }
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const m = $('.pv-media', v);
    m.style.transform = '';
    m.style.opacity = '';
    if (viewer.zoom === 1 && drag.moved) {
      if (dy > 120 && Math.abs(dy) > Math.abs(dx)) closeViewer(); // swipe down to close (Apple)
      else if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    }
    drag = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

// Keys while the viewer is open. Captured on window so a menu over the viewer closes first (the shell's Esc).
window.addEventListener(
  'keydown',
  (e) => {
    if (!viewer.open || hasOpenLayer() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (viewer.show) {
      stopSlideshow();
      if (e.key !== 'Escape') return e.preventDefault();
    }
    if (e.target.closest?.('video') && [' ', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const p = lib.getPhoto(viewer.ids[viewer.i]);
    const k = e.key;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === 'Escape') {
      if (viewer.zoom > 1) {
        viewer.zoom = 1;
        viewer.panX = viewer.panY = 0;
        applyZoom();
      } else closeViewer();
      return done();
    }
    if (k === 'ArrowLeft') return step(-1), done();
    if (k === 'ArrowRight') return step(1), done();
    if (k === 'Home') return (viewer.i = 0), showCurrent(), done();
    if (k === 'End') return (viewer.i = viewer.ids.length - 1), showCurrent(), done();
    if (!p || singleKeyOff(e)) return;
    if (k === 'f' || k === 'F') return p.deletedAt || toggleFavorite([p.id]).then(showCurrent), done();
    if (k === 'i' || k === 'I') return $('[data-pv-info]', viewer.el).click(), done();
    if (k === 'Delete' || k === 'Backspace') return (p.deletedAt ? purge([p.id]) : moveToTrash([p.id])), done();
    if (k === '+' || k === '=') return (viewer.zoom = Math.min(6, viewer.zoom * 1.5)), applyZoom(), done();
    if (k === '-') return (viewer.zoom = Math.max(1, viewer.zoom / 1.5)), viewer.zoom === 1 && (viewer.panX = viewer.panY = 0), applyZoom(), done();
  },
  true,
);

// ---------------------------------------------------------------- cloud backup actions

async function connect(provider) {
  if (!(await oauth.clientId(provider))) return setupDialog(provider);
  try {
    await oauth.beginSignIn(provider);
  } catch (err) {
    toast(`Couldn’t start sign-in: ${err.message}`);
  }
}

/** First-time setup: the app registration this copy of ecosys needs, and where to paste its ID. */
function setupDialog(provider) {
  const uri = oauth.redirectUri();
  const origin = new URL(uri).origin;
  const loopIp = /^http:\/\/127\.0\.0\.1/.test(origin);
  const steps =
    provider === 'onedrive'
      ? [
          `Open <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">App registrations</a> in Microsoft Entra (any Microsoft account works) and choose <b>New registration</b>.`,
          `Name it “ecosys Photos”. Under <b>Supported account types</b> pick <b>personal Microsoft accounts</b> (with or without work accounts).`,
          `Under <b>Redirect URI</b> choose <b>Single-page application (SPA)</b> and paste the address below.`,
          `Register, then copy the <b>Application (client) ID</b> into the box below.`,
        ]
      : [
          `Open the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API</a> page in Google Cloud and choose <b>Enable</b>.`,
          `Set up the <b>OAuth consent screen</b> (External, add yourself as a test user) with the <b>…/auth/drive.file</b> scope.`,
          `In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a>, create an <b>OAuth client ID</b> of type <b>Web application</b>. Add <code>${esc(origin)}</code> as an authorized JavaScript origin and the address below as an authorized redirect URI.`,
          `Copy the <b>Client ID</b> into the box below.`,
        ];
  openModal({
    title: `Set up ${PROVIDER_NAME[provider]} backup`,
    className: 'ph-setup',
    body: `<form class="modal-body" data-form>
      <div class="ph-setup-lead">${providerLogo(provider)}<p class="muted">${PROVIDER_NAME[provider]} lets an app back up into your account once it’s registered. It’s free and takes a few minutes, and you only do it once per copy of ecosys.</p></div>
      <ol class="ph-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <label class="ph-field"><span>Redirect address</span><span class="ph-copy"><input class="input" readonly value="${esc(uri)}" /><button type="button" class="btn btn-secondary btn-sm" data-copy>Copy</button></span></label>
      ${provider === 'onedrive' && loopIp ? `<p class="ph-warn">${icon('alert', { size: 16 })}<span>Microsoft accepts <code>localhost</code> but not <code>127.0.0.1</code> for this. Open ecosys at <a href="${esc(uri.replace('127.0.0.1', 'localhost').replace(/auth\.html$/, ''))}">${esc(origin.replace('127.0.0.1', 'localhost'))}</a> and set it up there.</span></p>` : ''}
      <label class="ph-field"><span>${provider === 'onedrive' ? 'Application (client) ID' : 'Client ID'}</span><input class="input" name="id" required autocomplete="off" spellcheck="false" placeholder="${provider === 'onedrive' ? '00000000-0000-0000-0000-000000000000' : '1234-abc.apps.googleusercontent.com'}" /></label>
      <div class="ph-modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save and connect</button></div>
    </form>`,
    onMount: (m, close) => {
      $('[data-copy]', m).addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(uri);
          e.target.textContent = 'Copied';
        } catch {
          $('input[readonly]', m).select();
        }
      });
      $('[data-form]', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = $('input[name="id"]', m).value.trim();
        const valid = provider === 'onedrive' ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) : /^[\w-]+\.apps\.googleusercontent\.com$/.test(id);
        if (!valid) {
          toast(provider === 'onedrive' ? 'That doesn’t look like an application ID (a GUID).' : 'That doesn’t look like a Google client ID (…apps.googleusercontent.com).');
          return;
        }
        await oauth.setClientId(provider, id);
        close();
        connect(provider);
      });
    },
  });
}

async function disconnect() {
  const name = PROVIDER_NAME[state.cfg.provider];
  const cloudOnly = backup.counts(state.cfg).cloudOnly;
  const ok = await confirmDialog({
    title: `Disconnect ${name}?`,
    message: `Backing up stops. Everything already in ${name} stays there.${cloudOnly ? ` ${plural(cloudOnly, 'item')} whose original is only in the cloud will show as previews until you connect again.` : ''}`,
    confirm: 'Disconnect',
    danger: true,
  });
  if (!ok) return;
  await backup.disconnect();
  toast(`Disconnected from ${name}`);
}

async function runWithProgress(label, fn) {
  const close = toast(`${label}…`, { duration: 0 });
  const box = $('.toasts .toast.sticky:last-child');
  try {
    return await fn((msg) => {
      const m = box && $('.toast-msg', box);
      if (m) m.textContent = msg;
    });
  } finally {
    close();
  }
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (viewer.open && viewer.el?.contains(t)) return;
  if (t.closest('[data-import]')) return pickFiles();
  if (t.closest('[data-samples]')) {
    t.closest('[data-samples]').disabled = true;
    state.importing = { done: 0, total: 12 };
    await media.makeSamples((p) => {
      state.importing = p;
      renderSideBackup();
    });
    state.importing = null;
    render();
    backup.run();
    return;
  }
  if (t.closest('[data-toggle-nav]')) return openDrawer();
  if (t.closest('[data-close-nav]')) return closeDrawer();
  if (t.closest('[data-focus-search]')) return el.q.focus();
  const zb = t.closest('[data-zoom]');
  if (zb) return setZoom(zb.dataset.zoom);
  const cb = t.closest('[data-cols]');
  if (cb) return setCols(state.cols + Number(cb.dataset.cols));
  const yr = t.closest('[data-jump-year]');
  if (yr) return setZoom('months', { year: yr.dataset.jumpYear });
  const mo = t.closest('[data-jump-month]');
  if (mo) return setZoom('days', { month: mo.dataset.jumpMonth });
  const mem = t.closest('[data-memory]');
  if (mem) return openViewer(memoryCache.get(mem.dataset.memory) || [], 0, { slideshow: true });

  // Tiles: the tick selects; in selection mode the whole tile does (Google); otherwise it opens.
  const tick = t.closest('[data-tick]');
  if (tick) return toggleSelect(tick.dataset.tick, { range: e.shiftKey });
  const dayTick = t.closest('[data-tick-day]');
  if (dayTick) {
    const ids = $$('.ph-tile', dayTick.closest('.ph-day')).map((n) => n.dataset.id);
    const all = ids.every((id) => state.selected.has(id));
    for (const id of ids) all ? state.selected.delete(id) : state.selected.add(id);
    return syncSelection();
  }
  const open = t.closest('[data-open]');
  if (open) {
    const id = open.dataset.open;
    if (state.selected.size || e.shiftKey || e.ctrlKey || e.metaKey) return toggleSelect(id, { range: e.shiftKey });
    return openViewer(state.order, state.order.indexOf(id));
  }

  // Selection bar
  const ids = [...state.selected];
  if (t.closest('[data-clear-sel]')) return clearSelection();
  if (t.closest('[data-select-all]')) {
    for (const id of state.order) state.selected.add(id);
    return syncSelection();
  }
  if (t.closest('[data-fav-sel]')) return toggleFavorite(ids);
  const am = t.closest('[data-album-sel]');
  if (am) return albumMenu(am, ids);
  if (t.closest('[data-unalbum-sel]')) {
    const aid = state.route.id;
    await lib.updatePhotos(ids, (p) => ({ albumIds: (p.albumIds || []).filter((x) => x !== aid) }));
    clearSelection();
    return undoable(`Removed ${plural(ids.length, 'item')} from the album`, () => lib.updatePhotos(ids, (p) => ({ albumIds: [...new Set([...(p.albumIds || []), aid])] })));
  }
  if (t.closest('[data-download-sel]')) return downloadItems(ids);
  if (t.closest('[data-trash-sel]')) return moveToTrash(ids);
  if (t.closest('[data-restore-sel]')) return restoreFromTrash(ids);
  if (t.closest('[data-purge-sel]')) return purge(ids);
  if (t.closest('[data-empty-trash]')) return purge(trashed().map((p) => p.id));

  // Albums
  if (t.closest('[data-new-album]')) return newAlbum();
  if (t.closest('[data-slideshow]')) return openViewer(state.order, 0, { slideshow: true });
  const amenu = t.closest('[data-album-menu]');
  if (amenu) {
    const a = lib.getAlbum(state.route.id);
    return openMenu(amenu, [
      { label: 'Rename…', icon: 'edit', onSelect: async () => {
        const name = await promptName({ title: 'Rename album', value: a.name });
        if (name) await lib.saveAlbum({ ...a, name });
      } },
      { label: 'Import into this album', icon: 'upload', onSelect: () => pickFiles() },
      { sep: true },
      { label: 'Delete album', icon: 'trash', danger: true, onSelect: async () => {
        const ok = await confirmDialog({ title: `Delete “${a.name}”?`, message: 'The photos in it stay in your library.', confirm: 'Delete album', danger: true });
        if (!ok) return;
        await lib.deleteAlbum(a.id);
        go('#/albums');
      } },
    ], { label: 'Album options' });
  }

  // Cloud backup
  const con = t.closest('[data-connect]');
  if (con) return connect(con.dataset.connect);
  if (t.closest('[data-reconnect]')) return oauth.beginSignIn(state.cfg.provider, { silent: true, loginHint: state.cfg.account?.email || '' }).catch((err) => toast(err.message));
  if (t.closest('[data-disconnect]')) return disconnect();
  if (t.closest('[data-backup-now]')) return backup.run({ reason: 'manual' });
  if (t.closest('[data-backup-stop]')) return backup.stop();
  if (t.closest('[data-rename-folder]')) {
    const name = await promptName({ title: 'Backup folder name', value: state.cfg.folderName });
    if (!name || name === state.cfg.folderName) return;
    if (/[\\/:*?"<>|]/.test(name)) return toast('Folder names can’t contain \\ / : * ? " < > |');
    await backup.setConfig({ folderName: name, rootId: null, folders: {} });
    toast(`New photos go to “${name}”. Photos already backed up stay where they are.`);
    return backup.finishConnect().catch((err) => toast(err.message));
  }
  if (t.closest('[data-free-space]')) {
    const c = backup.counts(state.cfg);
    const size = c.freeable.reduce((n, p) => n + (p.size || 0), 0);
    const ok = await confirmDialog({ title: `Free up ${bytes(size)}?`, message: `${plural(c.freeable.length, 'original')} will be removed from this browser. They’re safe in ${PROVIDER_NAME[state.cfg.provider]}, and you’ll still see every photo: originals download when you open them.`, confirm: 'Free up space' });
    if (!ok) return;
    const r = await backup.freeUpSpace();
    return toast(`Freed ${bytes(r.bytes)}`);
  }
  if (t.closest('[data-download-all]')) {
    try {
      const n = await runWithProgress('Downloading originals', (say) => backup.downloadAll((d, total) => say(`Downloading originals · ${d} of ${total}`)));
      toast(`Downloaded ${plural(n, 'original')}`);
    } catch (err) {
      toast(`Download stopped: ${err.message}`);
    }
    return;
  }
  if (t.closest('[data-restore]')) {
    try {
      const r = await runWithProgress(`Looking in ${PROVIDER_NAME[state.cfg.provider]}`, (say) =>
        backup.restore((p) => say(p.phase === 'list' ? `Looking in ${PROVIDER_NAME[state.cfg.provider]}…` : `Restoring ${p.done} of ${p.total}`)),
      );
      toast(r.added ? `Restored ${plural(r.added, 'item')}` : `Everything in ${PROVIDER_NAME[state.cfg.provider]} is already here`);
    } catch (err) {
      toast(`Restore stopped: ${err.message}`);
    }
  }
});

document.addEventListener('change', async (e) => {
  const sw = e.target.closest?.('.ph-switch-row input');
  if (!sw) return;
  await backup.setConfig({ [sw.name]: sw.checked });
  if (sw.name === 'auto' && sw.checked) backup.run();
});

// Search (Google's bar): results as you type.
let searchTimer = 0;
el.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = el.q.value.trim();
    if (q) history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`);
    else if (state.route.view === 'search') history.replaceState(null, '', '#/photos');
    else return;
    state.route = parseRoute();
    render();
  }, 160);
});
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  el.q.blur();
});
el.q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.q.value) {
    e.stopPropagation();
    el.q.value = '';
    el.q.dispatchEvent(new Event('input'));
  }
});

function setCols(n) {
  state.cols = Math.min(10, Math.max(3, n));
  local('cols', state.cols);
  const all = $('.ph-all', el.view);
  if (all) all.style.setProperty('--cols', state.cols);
  requestAnimationFrame(buildScrubber);
}

// Pinch or Ctrl+wheel over the grid zooms it, as a trackpad pinch does in Apple Photos.
el.scroll.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey || state.route.view !== 'photos') return;
    e.preventDefault();
    if (state.zoom !== 'all') return;
    setCols(state.cols + (e.deltaY > 0 ? 1 : -1));
  },
  { passive: false },
);

document.addEventListener('keydown', (e) => {
  if (viewer.open || hasOpenLayer()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape' && state.selected.size) return clearSelection();
  if (isTyping(e)) return;
  if (mod && e.key.toLowerCase() === 'a' && state.order.length) {
    e.preventDefault();
    for (const id of state.order) state.selected.add(id);
    return syncSelection();
  }
  if (mod && (e.key === '-' || e.key === '=' || e.key === '+') && state.route.view === 'photos' && state.zoom === 'all') {
    e.preventDefault();
    return setCols(state.cols + (e.key === '-' ? 1 : -1));
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size) {
    e.preventDefault();
    return state.route.view === 'trash' ? purge([...state.selected]) : moveToTrash([...state.selected]);
  }
  if (mod || e.altKey || singleKeyOff(e)) return;
  if (e.key === '/') {
    e.preventDefault();
    return el.q.focus();
  }
  if (e.key === 'u') return pickFiles();
  const z = { 1: 'years', 2: 'months', 3: 'days', 4: 'all' }[e.key];
  if (z) return setZoom(z);
  if (e.key === 'g') return go('#/photos');
  if (e.key === 'a') return go('#/albums');
  if (e.key === 'b') return go('#/backup');
});

registerShortcuts([
  { title: 'Library', items: [['Search', '/'], ['Import', 'u'], ['Years · Months · Days · All', '1'], ['Photos', 'g'], ['Albums', 'a'], ['Cloud backup', 'b'], ['Select all', 'mod A'], ['Delete selected', 'delete'], ['Bigger / smaller grid (All)', 'mod =']] },
  { title: 'Viewing a photo', items: [['Previous / next', 'arrowleft'], ['Favorite', 'f'], ['Info', 'i'], ['Zoom', '+'], ['Delete', 'delete'], ['Close', 'esc']] },
]);

registerPaletteProvider((q) => {
  const cmds = [
    { label: 'Import photos', icon: 'upload', run: pickFiles },
    { label: 'Cloud backup', icon: 'cloud', run: () => go('#/backup') },
    { label: 'Albums', icon: 'albums', run: () => go('#/albums') },
    { label: 'Favorites', icon: 'heart', run: () => go('#/favorites') },
    { label: 'Recently Deleted', icon: 'trash', run: () => go('#/trash') },
    { label: 'New album', icon: 'plus', run: () => newAlbum() },
  ].map((c) => ({ group: 'Photos', ...c }));
  const albums = lib.allAlbums().map((a) => ({ group: 'Albums', label: a.name, sub: 'Album', icon: 'albums', run: () => go(`#/album/${encodeURIComponent(a.id)}`) }));
  const needle = String(q || '').toLowerCase();
  const out = [...cmds, ...albums].filter((c) => !needle || c.label.toLowerCase().includes(needle));
  if (needle) out.push({ group: 'Photos', label: `Search photos for “${q}”`, icon: 'search', fallback: true, run: () => go(`#/search?q=${encodeURIComponent(q)}`) });
  return out;
});

// ---------------------------------------------------------------- the drawer (phones)

let drawerOpen = false;
function openDrawer() {
  if (!matchMedia('(max-width: 900px)').matches) return;
  drawerOpen = true;
  el.shell.classList.add('nav-open');
  $('#main').inert = true;
  el.tabbar.inert = true;
  ($('.nav-item[aria-current="true"]', el.nav) || $('.nav-item', el.nav))?.focus({ preventScroll: true });
}
function closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  el.shell.classList.remove('nav-open');
  $('#main').inert = false;
  el.tabbar.inert = false;
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && drawerOpen && closeDrawer());

// ---------------------------------------------------------------- start

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const top = el.scroll.scrollTop;
    // Selection survives a change, minus anything that left the view.
    render();
    for (const id of [...state.selected]) if (!state.order.includes(id)) state.selected.delete(id);
    syncSelection();
    el.scroll.scrollTop = top;
    if (viewer.open) {
      const p = lib.getPhoto(viewer.ids[viewer.i]);
      if (p) renderInfo(p);
    }
  });
}

lib.onChange(async (what) => {
  if (what.kv) state.cfg = await backup.getConfig();
  if (what.photos && !what.remote && state.cfg.provider && state.cfg.auto && backup.getStatus().state !== 'running') clearTimeout(autoTimer), (autoTimer = setTimeout(() => backup.run(), 1500));
  queueRender();
});
let autoTimer = 0;

backup.onStatus((s) => {
  state.status = s;
  renderCloud();
  renderSideBackup();
  if (state.route.view === 'backup') queueRender();
});

window.addEventListener('online', () => backup.run());

async function start() {
  try {
    await lib.load();
  } catch (err) {
    el.view.innerHTML = emptyState({ title: 'Photos can’t open its library', text: `${err.message || err}. Private windows and some browser settings block the storage Photos needs.` });
    return;
  }
  state.cfg = await backup.getConfig();
  state.route = parseRoute();
  state.ready = true;
  render();

  // Housekeeping: Recently Deleted keeps things 30 days.
  const expired = lib.expiredTrash();
  if (expired.length) {
    await lib.deletePhotos(expired.map((p) => p.id));
    backup.forgetInCloud(expired).catch(() => {});
  }

  if (state.route.connected) {
    history.replaceState(null, '', '#/backup');
    state.route = parseRoute();
    try {
      state.cfg = await backup.finishConnect();
      toast(`Connected to ${PROVIDER_NAME[state.cfg.provider]}${state.cfg.account?.email ? ` as ${state.cfg.account.email}` : ''}. Backing up into “${state.cfg.folderName}”.`, { duration: 6000 });
    } catch (err) {
      toast(`Connected, but the backup folder couldn’t be made: ${err.message}`, { duration: 8000 });
    }
    render();
  }
  if (state.cfg.provider) {
    if (!state.cfg.rootId) backup.finishConnect().catch(() => {});
    backup.run();
  }
}

start();
