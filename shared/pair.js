// ecosys browser pairing: proof that this browser may use the ecosys server on this computer.
//
// The server keeps a secret per data folder (<data folder>/pair.json) and prints a pairing link where
// it runs: http://127.0.0.1:PORT/#pair=<secret>. Opening that link once connects this browser profile:
// shared/boot.js (it runs first on every page) takes the secret out of the address bar before any app
// router reads it and keeps it in localStorage; this module does the same if boot.js did not. Every
// request to /api/* (the event stream too) sends it as the X-Ecosys header. A browser without it (or
// with a wrong one) gets 403 {"error":"pairing_required"}: it keeps working from its own copy, like the
// GitHub Pages copy, and shows one calm notice saying how to connect it.
//
//   apiHeaders()        headers for an /api request: { 'X-Ecosys': <secret> } once paired, else the
//                       legacy { 'X-Ecosys': '1' } (a server from before pairing still takes that one)
//   pairingState()      'paired' | 'unpaired' | 'rejected' (a stored secret the server refused)
//   markRejected(sent?) the server answered 403 pairing_required: forget the stored secret (only if it is
//                       still the one that was sent, when `sent` is given) and show the notice
//   onPairingChange(fn) fn(state) whenever the state changes, in this tab or because another tab paired;
//                       returns an unsubscribe function
//   showPairingNotice() show the notice now (once per page) if this browser is not paired
//
// Nobody else invents an /api header: shared/sync.js and shared/ai.js import apiHeaders() from here.

const KEY = 'ecosys:v1:pair';
const SECRET_RE = /^[A-Za-z0-9_-]{20,200}$/;
// "#pair=<secret>" leads the hash, or follows other hash parameters after a "&".
const HASH_RE = /(^#|&)pair=([A-Za-z0-9_-]{20,200})(?=$|[&/#?])/;
const NOTICE = "This browser isn't connected to ecosys on this computer. Open the link shown where ecosys is running to connect it.";

let rejected = false; // a stored secret was refused on this page (cleared since)
let lastState = null;
let noticeShown = false; // once per page: dismissing it is final for this page
let closeNotice = null;
const listeners = new Set();

/** The stored secret, or null. Reads both the bare secret and a JSON wrapper ({secret} or a JSON string). */
function storedSecret() {
  let raw = null;
  try {
    raw = globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null; // storage blocked: this browser cannot stay paired
  }
  if (typeof raw !== 'string' || !raw) return null;
  if (SECRET_RE.test(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    const s = typeof v === 'string' ? v : v && typeof v === 'object' ? v.secret : null;
    return typeof s === 'string' && SECRET_RE.test(s) ? s : null;
  } catch {
    return null;
  }
}

function store(secret) {
  try {
    if (secret) globalThis.localStorage?.setItem(KEY, secret);
    else globalThis.localStorage?.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function pairingState() {
  if (storedSecret()) return 'paired';
  return rejected ? 'rejected' : 'unpaired';
}

/** Headers every /api request sends (merge them into the request's own headers). */
export function apiHeaders() {
  return { 'X-Ecosys': storedSecret() || '1' };
}

function changed() {
  const state = pairingState();
  if (state === lastState) return;
  lastState = state;
  if (state === 'paired') hideNotice();
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

export function onPairingChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The server refused this browser (403 pairing_required). `sent`: the X-Ecosys value that request
 * carried; a secret stored since (another tab opened the pairing link meanwhile) is then kept.
 */
export function markRejected(sent) {
  const now = storedSecret();
  if (now && (sent === undefined || sent === now)) {
    store(null);
    rejected = true;
  }
  changed();
  if (pairingState() !== 'paired') showPairingNotice();
}

// ---------------------------------------------------------------- the pairing link

/** Take "#pair=<secret>" out of the address bar (keeping any route after it) and keep the secret. */
function captureFromHash() {
  const loc = globalThis.location;
  const hash = typeof loc?.hash === 'string' ? loc.hash : '';
  const m = HASH_RE.exec(hash);
  if (!m) return;
  store(m[2]);
  rejected = false;
  // What is left of the hash: "#pair=s&/today" or "#pair=s/today" → "#/today"; "#pair=s" → no hash.
  let rest = hash.slice(0, m.index) + (m[1] === '&' ? '' : '#') + hash.slice(m.index + m[0].length);
  rest = rest.replace(/^#[&]+/, '#').replace(/&&+/g, '&').replace(/&$/, '');
  try {
    const url = `${loc.pathname}${loc.search}${rest === '#' ? '' : rest}`;
    globalThis.history?.replaceState(globalThis.history.state, '', url);
  } catch {}
}

// ---------------------------------------------------------------- the notice

/** The toast stack the shell uses (shared look and live region), or a new one like it. */
function toastRegion() {
  let box = document.querySelector('body > .toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  return box;
}

function hideNotice() {
  closeNotice?.();
  closeNotice = null;
}

/** Show the notice once per page while this browser is not paired. The server must be reachable (it said so). */
export function showPairingNotice() {
  if (noticeShown || pairingState() === 'paired' || typeof document === 'undefined' || !document.body) return;
  noticeShown = true;
  const el = document.createElement('div');
  el.className = 'toast sticky';
  el.dataset.pairing = '';
  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = NOTICE;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Hide';
  el.append(msg, btn);
  toastRegion().append(el);
  let closed = false;
  closeNotice = () => {
    if (closed) return;
    closed = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 230);
  };
  btn.addEventListener('click', hideNotice);
}

// ---------------------------------------------------------------- start

captureFromHash();
lastState = pairingState();
const win = typeof window !== 'undefined' ? window : null;
if (typeof win?.addEventListener === 'function') {
  // Another tab opened the pairing link (or was refused): this tab follows.
  win.addEventListener('storage', (e) => {
    if (e?.key === KEY || e?.key === null) changed();
  });
  // The pairing link opened in a tab that is already showing ecosys.
  win.addEventListener('hashchange', () => {
    captureFromHash();
    changed();
  });
}
