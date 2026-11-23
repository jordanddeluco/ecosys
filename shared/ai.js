// ecosys Connect AI: one place to let Claude, ChatGPT, Grok or any MCP app work with your tasks,
// calendar and notes; the connect animation that plays in every open app when an assistant
// connects; and a small live status API for Home and the apps.
//
//   openAIPanel({kind})            the Connect AI sheet. `kind` ('claude' | 'chatgpt' | 'grok' |
//                                  'other') opens that assistant's setup page. Without the local
//                                  server (GitHub Pages, a LAN address) it explains how to run ecosys,
//                                  and in a browser ecosys doesn't know yet, how to connect it.
//   initAI({app})                  started by initShell() once the local server is online: plays the
//                                  connect animation once per new connection, shows a toast with Undo
//                                  when an assistant changes something, keeps the status cache fresh,
//                                  and in Tasks, Schedule and Notes puts the AI status button in the
//                                  sidebar's head (renderAIChip), beside the app switcher.
//   aiStatus({fresh})              → Promise<{online, reason, mode, clients, connected, activity,
//                                  localUrl, updatedAt}>. Never includes connection keys. reason (when
//                                  not online): 'unknown' (still checking) | 'static' | 'lan' |
//                                  'no-server' | 'unreachable' | 'refused' | 'unpaired' (this browser
//                                  isn't connected to ecosys: shared/pair.js).
//   onAIStatus(fn)                 fn(status) now (when known) and on every change → unsubscribe().
//   renderAIChip(el)               the AI status button for an app's header, rendered into `el` (hidden
//                                  until an assistant is set up) → {refresh(), destroy()}.
//   playConnectAnimation(client, {clientName, duration})  → Promise<boolean> once it is dismissed.
//   assistantMark(kind, {size}), ecosysOrb({size}), ASSISTANTS   the marks, as SVG strings.
//
// Server API (server/http.mjs; every request sends shared/pair.js apiHeaders(), the pairing header, and a
// 403 {"error":"pairing_required"} means this browser isn't connected): GET api/ai (only the Connect AI
// sheet: with keys) · GET api/ai/status (status only, never a key: Home's AI icon, the status button and the
// connect animation; a server that answers it with a 404 gets GET api/ai instead, for that page) ·
// POST api/ai/mode {mode} · POST api/ai/clients {kind, access, label} ·
// POST api/ai/clients/:id {access | rotate | label} · DELETE api/ai/clients/:id ·
// POST api/ai/undo {changeId} → {changeId of the undo} · POST api/ai/install/claude-desktop {clientId?}.
// GET api/ai may also send `bridgeArgs` (['--data', dir] when the data folder isn't the default; every
// stdio setup then includes it). Both send, per activity entry, `undoOf` / `undone`. Live updates
// arrive from shared/sync.js as window 'ecosys:ai' events: {type:'connected', client, clientName} ·
// {type:'activity', entry} · {type:'status', mode, clients}.
//
// The assistant marks are ecosys's own monograms in each assistant's colour family, not the
// vendors' logos: drawn as paths (no font), on a flat circle lit from 11 o'clock like the app logos.
// Apps are squircles and assistants are circles; the AI app's logo (shell.js appIcon('ai')) docks one in the other.
import { appIcon, esc, icon, keys, openModal, openMenu, confirmDialog, toast, BASE, settings, isMac, downloadBackup } from './shell.js';
import { fmt, parseYmd } from './dates.js';
import { apiHeaders, markRejected, onPairingChange, pairingState } from './pair.js';

const API = `${BASE}api/`;
const CSS_HREF = new URL('./ai.css', import.meta.url).href;
const LS_SEEN = 'ecosys:ai:announced';
const LS_TUNNEL = 'ecosys:ai:tunnel';
const REANNOUNCE_MS = 15 * 60 * 1000; // one connect animation per assistant per quarter hour
const DEFER_MS = 2 * 60 * 1000; // a hidden tab still celebrates a connection this recent once shown
const FEED_PREVIEW = 6;

export const ASSISTANTS = Object.freeze({
  claude: { kind: 'claude', name: 'Claude', letters: 'Cl', from: '#f4a582', to: '#c2563a', color: '#d9714d', blurb: 'Claude Desktop, Claude Code and claude.ai' },
  chatgpt: { kind: 'chatgpt', name: 'ChatGPT', letters: 'Ch', from: '#48dba8', to: '#0a8463', color: '#14a37b', blurb: 'A custom connector, through a tunnel' },
  grok: { kind: 'grok', name: 'Grok', letters: 'Gr', from: '#71768b', to: '#16171e', color: '#8b91a7', blurb: 'The Grok app, the xAI API or Grok CLI' },
  other: { kind: 'other', name: 'Other MCP apps', letters: '', from: '#a3aac4', to: '#4f556d', color: '#7a819c', blurb: 'Cursor, VS Code, Codex or any MCP client' },
});
const ORDER = ['claude', 'chatgpt', 'grok', 'other'];
const ABOUT = {
  claude: 'Use ecosys from Claude Desktop, Claude Code or claude.ai.',
  chatgpt: 'ChatGPT reaches ecosys from OpenAI’s servers, through a tunnel you start.',
  grok: 'Use ecosys from the Grok app, the xAI API or Grok CLI.',
  other: 'Any app that speaks MCP: Cursor, VS Code, Codex, Windsurf and more.',
};

// How each assistant can be set up. Each surface gets its own connection (labelled `label`), so
// Activity says exactly which app changed what, and one can be cut off without the others.
const SURFACES = {
  claude: [
    { id: 'desktop', tab: 'Desktop app', label: 'Claude Desktop', exact: true },
    { id: 'code', tab: 'Claude Code', label: 'Claude Code' },
    { id: 'web', tab: 'Web & mobile', label: 'Claude.ai', cloud: true },
  ],
  chatgpt: [{ id: 'chatgpt', label: 'ChatGPT', cloud: true }],
  grok: [
    { id: 'app', tab: 'Grok app', label: 'Grok app', cloud: true },
    { id: 'api', tab: 'xAI API', label: 'xAI API', cloud: true, access: 'read' },
    { id: 'cli', tab: 'Grok CLI', label: 'Grok CLI' },
  ],
  other: [{ id: 'other', label: 'MCP app' }],
};

const MODES = [
  { id: 'off', label: 'Off', text: 'Assistants are turned away until you turn access back on.' },
  { id: 'read', label: 'Read only', text: 'Assistants can look things up, but can’t change anything.' },
  { id: 'write', label: 'Read & write', text: 'Assistants can look things up and make changes. Every change shows up in Activity, and you can undo it.' },
];

// ---------------------------------------------------------------- small helpers

const isId = (s) => typeof s === 'string' && /^[a-z0-9_-]{1,40}$/i.test(s);
const TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;
const CHANGE_RE = /^chg_[a-z0-9_-]{1,40}$/i;
const clean = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const when = (v) => (Number.isFinite(+v) && +v > 0 ? +v : null);
const lcFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
const listJoin = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const uniq = (xs) => [...new Set(xs)];
const OS = (() => {
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`;
  return /Win/i.test(p) ? 'win' : isMac ? 'mac' : 'linux';
})();
const reducedMotion = () =>
  document.documentElement.dataset.reduceMotion === 'true' || settings.get()?.reduceMotion === true || matchMedia('(prefers-reduced-motion: reduce)').matches;
// Metadata separators are drawn dots (CSS), never a text glyph; screen readers hear a comma.
const SEP = '<span class="ai-sep" aria-hidden="true"></span><span class="sr-only">, </span>';
/** Join parts with drawn dots. Strings are escaped; {html} parts are trusted markup. */
const sepJoin = (xs) => xs.filter(Boolean).map((x) => (typeof x === 'object' ? x.html : esc(x))).join(SEP);
const kindOf = (k) => (Object.hasOwn(ASSISTANTS, k) ? k : 'other');
/** What to call a connection in a sentence: "Claude", "ChatGPT", or the label of another MCP app. */
const who = (c) => (c && kindOf(c.kind) !== 'other' ? ASSISTANTS[kindOf(c.kind)].name : clean(c?.label, 60) || 'An AI app');

function ago(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3570) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 84600) return `${Math.round(s / 3600)} hr ago`;
  const d = Math.round(s / 86400);
  if (d <= 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const date = new Date(t);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}
/** "2 min ago" as markup that the open sheet keeps current (its ticker rewrites every [data-ago]). */
const agoSpan = (t) => (when(t) ? `<span data-ago="${when(t)}">${esc(ago(when(t)))}</span>` : '');

/** "claude-code 2.1.293" → "Claude Code 2.1.293". Client names are self-reported: display only. */
function clientApp(name) {
  const raw = clean(name, 80);
  if (!raw) return '';
  const m = /^(.*?)\s+v?(\d+(?:\.\d+){0,3}\S*)$/.exec(raw);
  const base = (m ? m[1] : raw).toLowerCase();
  const version = m ? ` ${m[2]}` : '';
  const known = base.includes('claude-code')
    ? 'Claude Code'
    : base.includes('claude') || base.includes('anthropic')
      ? 'Claude'
      : base.includes('openai-mcp') || base.includes('chatgpt')
        ? 'ChatGPT'
        : base.includes('codex')
          ? 'Codex'
          : base.includes('grok') || base.includes('xai')
            ? 'Grok'
            : '';
  return known ? `${known}${version}` : raw;
}

let gid = 0;

// ---------------------------------------------------------------- marks

// Each monogram is drawn in white strokes (5.5 units, round caps) on the 64 grid, so no font is involved:
// Cl for Claude, Ch for ChatGPT, Gr for Grok, and the plug at the family weight for other MCP apps.
const MARK_GLYPH = {
  claude: '<path d="M35.69 26.07A10 10 0 1 0 35.69 40.93M45 20.5V43.5"/>',
  chatgpt: '<path d="M31.19 26.07A10 10 0 1 0 31.19 40.93M39 20.5V43.5M39 35A5.25 5.25 0 0 1 49.5 35V43.5"/>',
  grok: '<path d="M32.57 26.43A10 10 0 1 0 35.5 33.5H29.25M43 43.5V28.5M43 34A5.5 5.5 0 0 1 48.5 28.5"/>',
  other: '<g transform="translate(11 11) scale(1.75)" stroke-width="3.2"><path d="M9 2.8v4.7M15 2.8v4.7M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4.7"/></g>',
};
// The circle's two stops, lit from 11 o'clock like the app logos (the light stop first).
const MARK_TILE = { claude: ['#ec8a64', '#c45233'], chatgpt: ['#2fc595', '#0a8463'], grok: ['#5d6275', '#16171e'], other: ['#9aa1bb', '#4f556d'] };

/** An assistant's monogram (ecosys's own mark, not the vendor's logo) as an SVG string. */
export function assistantMark(kind, { size = 32, cls = '' } = {}) {
  const k = kindOf(kind);
  const [lit, deep] = MARK_TILE[k];
  const id = `aim${++gid}`;
  const s = Math.max(12, Math.round(+size) || 32);
  return `<svg class="ai-mark ${esc(cls)}" width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="12.8" y1="0" x2="51.2" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${lit}"/><stop offset="1" stop-color="${deep}"/></linearGradient></defs><circle cx="32" cy="32" r="32" fill="url(#${id})"/><g fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">${MARK_GLYPH[k]}</g><circle cx="32" cy="32" r="31.25" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.5"/></svg>`;
}

/** The ecosys orb: the Home logo's e-orbit on a flat disc in the current accent colour (ai.css .ai-orb-a/c). */
export function ecosysOrb({ size = 40, cls = '' } = {}) {
  const id = `aio${++gid}`;
  const s = Math.max(12, Math.round(+size) || 40);
  return `<svg class="ai-orb ${esc(cls)}" width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="12.8" y1="0" x2="51.2" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" class="ai-orb-a"/><stop offset="1" class="ai-orb-c"/></linearGradient></defs><circle cx="32" cy="32" r="32" fill="url(#${id})"/><g transform="translate(6.4 6.4) scale(.8)"><path class="ai-orb-g" d="M17 32H47A15 15 0 1 0 32 47" fill="none" stroke="#fff" stroke-width="6.25" stroke-linecap="round" stroke-linejoin="round"/><circle class="ai-orb-d" cx="42.61" cy="42.61" r="4.6" fill="#fff"/></g><circle cx="32" cy="32" r="31.25" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.5"/></svg>`;
}

function entryMark(e, size = 30) {
  // Your own undos show an undo arrow; a redo (undoing an undo) shows it mirrored.
  const d = undoDepth(e);
  if (e.kind === 'user') return `<span class="ai-you${d && d % 2 === 0 ? ' redo' : ''}" style="width:${size}px;height:${size}px">${icon('undo', { size: Math.round(size * 0.52) })}</span>`;
  return assistantMark(e.kind, { size });
}

/** The orb, a beam and the assistants' marks. `live` sends dots along the beam. Decorative. */
function vizHtml(kinds, { live = false, cls = '' } = {}) {
  const ks = uniq(kinds.map(kindOf)).slice(0, 3);
  const peer = ks.length ? ASSISTANTS[ks[0]].color : 'var(--text-4)';
  const peers = ks.length
    ? ks.map((k) => `<span class="ai-viz-peer">${assistantMark(k, { size: 38 })}</span>`).join('')
    : `<span class="ai-viz-ghost">${icon('plus', { size: 16, stroke: 2.2 })}</span>`;
  return `<span class="ai-viz${live ? ' live' : ''}${ks.length ? '' : ' ai-viz-none'}${cls ? ` ${esc(cls)}` : ''}" style="--peer:${esc(peer)}" aria-hidden="true"><span class="ai-viz-orb">${ecosysOrb({ size: 44 })}</span><span class="ai-viz-line"><i></i><i></i><i></i></span><span class="ai-viz-peers">${peers}</span></span>`;
}

// ---------------------------------------------------------------- styles (loaded on first use)

let cssReady = null;
function ensureStyles() {
  if (cssReady) return cssReady;
  const have = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === CSS_HREF);
  if (have) return (cssReady = Promise.resolve());
  cssReady = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 2500);
    document.head.append(link);
  });
  return cssReady;
}

// ---------------------------------------------------------------- where we are & the server API

const isLoopback = () => {
  const h = location.hostname;
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
};
/** 'local' (this computer: the AI API can answer), 'lan' (ecosys on another computer), 'static' (GitHub Pages etc.). */
function hosting() {
  if (isLoopback()) return 'local';
  const h = location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h.includes(':') || /\.local$/i.test(h)) return 'lan';
  return 'static';
}

/** What a browser the server doesn't know is told (the pairing notice's words, shared/pair.js). */
const UNPAIRED_MSG = 'This browser isn’t connected to ecosys on this computer. Open the link shown where ecosys is running to connect it.';

async function call(path, { method = 'GET', body, timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  // The pairing header, as on every /api request (shared/pair.js; nobody invents their own).
  const auth = apiHeaders();
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: body === undefined ? { ...auth } : { ...auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    throw Object.assign(new Error(ctrl.signal.aborted ? 'ecosys took too long to answer. Try again.' : 'Couldn’t reach ecosys. Is it still running?'), { status: 0 });
  }
  let data = null;
  try {
    const raw = await res.text();
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 403 && data?.error === 'pairing_required') {
      // ecosys doesn't know this browser (or no longer knows the secret it sent): pair.js forgets that
      // secret and shows its notice; the status and an open Connect AI sheet say how to connect it.
      markRejected(auth['X-Ecosys']);
      lostPairing();
      throw Object.assign(new Error(UNPAIRED_MSG), { status: 403, data, pairing: true, reason: 'unpaired' });
    }
    const msg = data && typeof data.error === 'string' ? clean(data.error, 400) : res.status === 404 ? 'Not found' : `ecosys answered with an error (${res.status}).`;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

// Everything from the server is checked and trimmed before use (and escaped when rendered).
function cleanClient(c, { secrets = false } = {}) {
  if (!c || typeof c !== 'object' || !isId(c.id)) return null;
  const out = {
    id: c.id,
    kind: kindOf(c.kind),
    label: clean(c.label, 60) || 'AI assistant',
    access: c.access === 'read' ? 'read' : 'write',
    connected: c.connected === true,
    lastSeen: when(c.lastSeen),
    lastClientName: c.lastClientName ? clean(c.lastClientName, 80) : null,
    createdAt: when(c.createdAt),
  };
  if (secrets) out.token = typeof c.token === 'string' && TOKEN_RE.test(c.token) ? c.token : '';
  return out;
}

function cleanEntry(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id) return null;
  return {
    id: clean(a.id, 64),
    at: when(a.at) || Date.now(),
    clientId: isId(a.clientId) ? a.clientId : null,
    kind: a.kind === 'user' ? 'user' : kindOf(a.kind),
    label: clean(a.label, 60) || 'AI assistant',
    clientName: a.clientName ? clean(a.clientName, 80) : null,
    tool: clean(a.tool, 60),
    summary: clean(a.summary, 300),
    changeId: typeof a.changeId === 'string' && CHANGE_RE.test(a.changeId) ? a.changeId : null,
    undone: a.undone === true || (typeof a.undoneBy === 'string' && !!a.undoneBy),
    undoOf: typeof a.undoOf === 'string' && CHANGE_RE.test(a.undoOf) ? a.undoOf : null,
  };
}

function cleanOverview(d) {
  const o = d && typeof d === 'object' ? d : {};
  const localUrl = typeof o.localUrl === 'string' && /^http:\/\/[a-z0-9.[\]:-]+\/mcp$/i.test(o.localUrl) ? o.localUrl : `${location.origin}/mcp`;
  const activity = (Array.isArray(o.activity) ? o.activity : []).map(cleanEntry).filter(Boolean);
  for (const e of activity) learnUndo(e);
  return {
    mode: MODES.some((m) => m.id === o.mode) ? o.mode : 'write',
    localUrl,
    publicUrls: (Array.isArray(o.publicUrls) ? o.publicUrls : []).filter((u) => typeof u === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?\/mcp$/i.test(u)).slice(0, 4),
    clients: (Array.isArray(o.clients) ? o.clients : []).map((c) => cleanClient(c, { secrets: true })).filter(Boolean),
    activity,
    bridgePath: clean(o.bridgePath, 600),
    nodePath: clean(o.nodePath, 600) || 'node',
    bridgeArgs: cleanBridgeArgs(o),
  };
}

/**
 * Arguments the stdio bridge needs besides --client: `--data <dir>` when this copy of ecosys keeps
 * its data somewhere other than the default folder (ECOSYS_DATA_DIR). Without it a hand-copied
 * command would look for the connection in the wrong place. Only that one flag is accepted.
 */
function cleanBridgeArgs(o) {
  const raw = Array.isArray(o.bridgeArgs) ? o.bridgeArgs : typeof o.dataDir === 'string' ? ['--data', o.dataDir] : [];
  const i = raw.indexOf('--data');
  const dir = i >= 0 && typeof raw[i + 1] === 'string' ? clean(raw[i + 1], 600) : '';
  return dir && !dir.includes('"') ? ['--data', dir] : [];
}

// ---------------------------------------------------------------- the undo chain
// Undoing a change records a new change ("Undid: …"); undoing that one re-applies the first (a redo),
// and so on. What a button does therefore depends on how deep in that chain its entry sits.

const UNDID = 'Undid: ';
const undoLinks = new Map(); // change id → the change it undid

/** Remember what an entry tells us about the chain (the server sends undoOf / undone when it knows). */
function learnUndo(e) {
  if (!e) return;
  if (e.undoOf) {
    if (e.changeId && e.changeId !== e.undoOf) undoLinks.set(e.changeId, e.undoOf);
    undone.add(e.undoOf);
  }
  if (e.undone && e.changeId) undone.add(e.changeId);
}

/** 0 for a change, 1 for an undo of one, 2 for undoing that undo (a redo), 3 for undoing the redo… */
function undoDepth(e) {
  if (!e?.changeId) return 0;
  let walk = 0;
  for (let id = e.changeId; undoLinks.has(id) && walk < 64; id = undoLinks.get(id)) walk++;
  // The server words every undo "Undid: <what it undid>", so the prefixes count the links too
  // (this also works after a reload, before anything else is known).
  let prefix = 0;
  if (e.tool === 'undo_change') for (let s = e.summary; s.startsWith(UNDID) && prefix < 64; s = s.slice(UNDID.length)) prefix++;
  return Math.max(walk, prefix, e.tool === 'undo_change' ? 1 : 0);
}
/** True when pressing the entry's button re-applies a change, rather than taking one back. */
const isRedo = (e) => undoDepth(e) % 2 === 1;

/** An entry's text. The undo chain reads "Undid: …" and "Redid: …" instead of "Undid: Undid: …". */
function entryText(e) {
  const s = e.summary || e.tool || 'Used ecosys';
  if (e.tool !== 'undo_change' || !s.startsWith(UNDID)) return readable(s);
  let base = s;
  while (base.startsWith(UNDID)) base = base.slice(UNDID.length);
  return readable(`${undoDepth(e) % 2 ? 'Undid' : 'Redid'}: ${base || 'a change'}`);
}

// The server words its summaries for the assistant: titles as JSON strings ("Say \"hi\""), days as
// "Sun 2026-11-22". On screen they read like the rest of ecosys: “Say "hi"” and Sun, Nov 22. A day
// inside a title is part of the title and stays as it is.
const SUMMARY_PARTS = /"(?:[^"\\]|\\.)*"|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{4}-\d{2}-\d{2})\b/g;
function readable(s) {
  return String(s).replace(SUMMARY_PARTS, (m, day) => {
    if (day) {
      const d = parseYmd(day);
      return fmt(d, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }) || m;
    }
    try {
      return `“${JSON.parse(m)}”`;
    } catch {
      return `“${m.slice(1, -1)}”`;
    }
  });
}

const stripSecrets = ({ token, ...c }) => c;

// ---------------------------------------------------------------- live status (shared by the panel, Home and the apps)

const status = { online: null, reason: '', mode: null, clients: [], activity: [], localUrl: '', at: 0 };
const subs = new Set();
const undone = new Set(); // change ids known to be undone (this session, or told by the server)
let fetching = null;
let offlineTimer = 0;
let quietTimer = 0;

// A connection is connected while its last request is this recent (the server's rule, server/ai-store.mjs). The
// server says nothing when one goes quiet, so the status lets it go quiet here on time, too.
const CONNECTED_MS = 10 * 60 * 1000;
const connectedNow = (c, t = Date.now()) => c.connected === true && !(c.lastSeen && t - c.lastSeen >= CONNECTED_MS);

function publicStatus() {
  const t = Date.now();
  const clients = status.clients.map((c) => ({ ...c, connected: connectedNow(c, t) }));
  return {
    online: status.online === true,
    reason: status.online === true ? '' : status.reason || (hosting() === 'local' ? 'unknown' : hosting()),
    mode: status.mode,
    clients,
    connected: clients.filter((c) => c.connected),
    activity: status.activity.map((e) => ({ ...e, undone: e.undone || (!!e.changeId && undone.has(e.changeId)) })),
    localUrl: status.localUrl,
    updatedAt: status.at,
  };
}

function emitStatus() {
  if (subs.size) {
    const snap = publicStatus();
    for (const fn of [...subs]) {
      try {
        fn(snap);
      } catch (err) {
        console.error('ecosys: an AI status listener failed', err);
      }
    }
  }
  armQuiet();
}

/** Tell the listeners again when the next connected assistant goes quiet. */
function armQuiet() {
  clearTimeout(quietTimer);
  if (!subs.size) return;
  const t = Date.now();
  const next = Math.min(...status.clients.filter((c) => c.lastSeen && connectedNow(c, t)).map((c) => c.lastSeen + CONNECTED_MS));
  if (Number.isFinite(next)) quietTimer = setTimeout(emitStatus, Math.max(1000, next - t + 1000));
}

function applyOverview(o) {
  Object.assign(status, { online: true, reason: '', mode: o.mode, clients: o.clients.map(stripSecrets), activity: o.activity.slice(0, 100), localUrl: o.localUrl, at: Date.now() });
  emitStatus();
}

function setOffline(reason) {
  if (status.online === false && status.reason === reason) return;
  Object.assign(status, { online: false, reason, at: Date.now() });
  emitStatus();
}

/** ecosys refused this browser (403 pairing_required): every status view and an open sheet say how to connect it. */
function lostPairing() {
  setOffline('unpaired');
  panel?.unpaired();
}

/**
 * What shared/sync.js found out about the server: 'online' | 'offline' | 'off' | 'error' | 'unpaired' |
 * 'connecting' | 'unknown' (no sync module). Waits while it is still connecting, so a page served by a
 * plain file server never asks for an API that isn't there (that would log a 404), and a browser ecosys
 * doesn't know never asks for one that would refuse it (a 403).
 */
async function syncSettled(timeout = 8000) {
  // sync.js reads 'off' for a moment before initShell starts it: look again after this task.
  if (window.ecosysSync?.status === 'off') await new Promise((r) => setTimeout(r, 0));
  const now = window.ecosysSync?.status;
  if (now && now !== 'connecting') return now;
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (s) => {
      clearTimeout(timer);
      window.removeEventListener('ecosys:sync', on);
      resolve(s);
    };
    const on = (e) => {
      const s = e?.detail?.status;
      if (s && s !== 'connecting') finish(s);
    };
    window.addEventListener('ecosys:sync', on);
    timer = setTimeout(() => finish(window.ecosysSync?.status || 'unknown'), timeout);
  });
}

// Status for Home, the apps' status button and the connect animation comes from GET api/ai/status, which
// never holds a key, so a page that only shows status never receives one. Only the Connect AI sheet
// asks GET api/ai (its setup steps need the keys). A server older than the files it serves (updated
// while it kept running) answers api/ai/status with a 404: this page then falls back to GET api/ai.
let noStatusRoute = false;

async function getOverview(keys) {
  if (!keys && !noStatusRoute) {
    try {
      return await call('ai/status');
    } catch (err) {
      if (err.status !== 404) throw err;
      noStatusRoute = true;
    }
  }
  return call('ai');
}

/**
 * The server's AI overview: with connection keys for the panel (GET api/ai), without them for status
 * (`keys: false`). `probe` skips the sync check (a "Try again" press).
 */
async function fetchOverview({ probe = false, keys = true } = {}) {
  const where = hosting();
  if (where !== 'local') {
    setOffline(where);
    throw Object.assign(new Error(where), { reason: where });
  }
  if (!probe) {
    const st = await syncSettled();
    // Refused, and no secret stored since: asking again would only be refused again (a 403 in the console).
    const unpaired = st === 'unpaired' || (status.reason === 'unpaired' && pairingState() !== 'paired');
    const reason = unpaired ? 'unpaired' : st === 'off' ? 'no-server' : st === 'error' ? 'refused' : st === 'offline' ? 'unreachable' : '';
    if (reason) {
      setOffline(reason);
      throw Object.assign(new Error(reason), { reason });
    }
  }
  try {
    const o = cleanOverview(await getOverview(keys));
    applyOverview(o);
    return o;
  } catch (err) {
    const reason = err.pairing ? 'unpaired' : err.status === 404 ? 'no-server' : err.status === 403 ? 'refused' : 'unreachable';
    setOffline(reason);
    throw Object.assign(err, { reason });
  }
}

function refreshStatus() {
  if (fetching) return fetching;
  fetching = fetchOverview({ keys: false })
    .catch(() => {})
    .then(() => publicStatus())
    .finally(() => {
      fetching = null;
    });
  return fetching;
}

/** The AI connection status: {online, reason, mode, clients, connected, activity, localUrl}. No keys. */
export async function aiStatus({ fresh = false } = {}) {
  ensureListening();
  if (!fresh && status.at && Date.now() - status.at < 3000) return publicStatus();
  return refreshStatus();
}

/** Call `fn(status)` now (when known) and on every change. Returns an unsubscribe function. */
export function onAIStatus(fn) {
  if (typeof fn !== 'function') return () => {};
  ensureListening();
  subs.add(fn);
  if (status.at) {
    try {
      fn(publicStatus());
    } catch (err) {
      console.error('ecosys: an AI status listener failed', err);
    }
    armQuiet();
  } else refreshStatus();
  return () => subs.delete(fn);
}

let listening = false;
function ensureListening() {
  if (listening) return;
  listening = true;
  window.addEventListener('ecosys:ai', onAIEvent);
  window.addEventListener('ecosys:sync', onSync);
  onPairingChange(onPairing);
  document.addEventListener('visibilitychange', onVisibility);
  // When someone last typed: the connect animation waits for a pause instead of covering their words.
  // Heard as the events bubble up to the window, so it never runs ahead of an editor's own handlers.
  window.addEventListener('keydown', noteTyping, { passive: true });
  window.addEventListener('input', noteTyping, { passive: true });
}

function onSync(e) {
  const st = e?.detail?.status ?? window.ecosysSync?.status;
  if (st !== 'offline') {
    clearTimeout(offlineTimer);
    offlineTimer = 0;
  }
  if (st === 'online') {
    if (status.online !== true && hosting() === 'local') refreshStatus();
  } else if (st === 'error') {
    setOffline('refused');
  } else if (st === 'unpaired') {
    setOffline('unpaired'); // it comes back 'online' by itself once the pairing link is opened
  } else if (st === 'offline' && status.online && !offlineTimer) {
    // Give a reconnecting event stream a moment before telling anyone ecosys is gone. (Retries while
    // offline announce again; they don't restart the wait.)
    offlineTimer = setTimeout(() => {
      offlineTimer = 0;
      if (window.ecosysSync?.status !== 'offline') return;
      setOffline('unreachable');
      panel?.syncChanged();
    }, 5000);
  }
  panel?.syncChanged();
}

/**
 * This browser was just connected (the pairing link opened here or in another tab). When sync had heard it was
 * refused, sync reconnects and says 'online' (onSync). When only a request of this module was refused (sync's
 * stream had opened before), nothing else will say so: ask again here.
 */
function onPairing(state) {
  if (state !== 'paired' || status.reason !== 'unpaired' || window.ecosysSync?.status === 'unpaired') return;
  if (hosting() === 'local') refreshStatus();
  panel?.paired();
}

function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  if (deferredConnect) {
    const d = deferredConnect;
    deferredConnect = null;
    if (Date.now() - d.at < DEFER_MS) maybeCelebrate(d);
  }
  panel?.visible();
}

function onAIEvent(e) {
  const d = e?.detail;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'status') {
    const known = new Map(status.clients.map((c) => [c.id, c]));
    status.clients = (Array.isArray(d.clients) ? d.clients : [])
      .map((c) => cleanClient(c))
      .filter(Boolean)
      .map((c) => ({ ...c, lastClientName: known.get(c.id)?.lastClientName ?? null, createdAt: known.get(c.id)?.createdAt ?? c.createdAt }));
    if (MODES.some((m) => m.id === d.mode)) status.mode = d.mode;
    Object.assign(status, { online: true, reason: '', at: Date.now() });
    emitStatus();
    panel?.onStatus(d);
  } else if (d.type === 'activity') {
    const entry = cleanEntry(d.entry);
    if (!entry) return;
    learnUndo(entry);
    if (!status.activity.some((a) => a.id === entry.id)) status.activity = [entry, ...status.activity].slice(0, 100);
    const c = status.clients.find((x) => x.id === entry.clientId);
    if (c) {
      c.lastSeen = Math.max(c.lastSeen || 0, entry.at);
      c.connected = true;
    }
    emitStatus();
    panel?.onActivity(entry);
    if (aiStarted) noteChange(entry);
  } else if (d.type === 'connected') {
    const client = cleanClient(d.client);
    if (!client) return;
    const clientName = d.clientName ? clean(d.clientName, 80) : null;
    const c = status.clients.find((x) => x.id === client.id);
    if (c) {
      Object.assign(c, { connected: true, lastSeen: Date.now() });
      if (clientName) c.lastClientName = clientName;
    }
    emitStatus();
    panel?.onConnected(client);
    if (aiStarted) maybeCelebrate({ client, clientName, at: Date.now() });
  }
}

// ---------------------------------------------------------------- initAI: celebrate connections, surface AI changes

let aiStarted = false;
let deferredConnect = null;

/** Start the AI hooks for an app (idempotent). initShell() calls this when the local server is online. */
export function initAI({ app = '' } = {}) {
  if (aiStarted) return;
  aiStarted = true;
  ensureListening();
  ensureStyles(); // so the connect animation is ready the moment it is needed
  if (hosting() === 'local') aiStatus(); // fetches unless something on this page just did
  if (app && app !== 'home') mountAppStatus(); // Home's AI icon has its own caption
}

function seenMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SEEN) || '{}');
    const out = Object.create(null);
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (isId(k) && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return Object.create(null);
  }
}
function markSeen(id) {
  try {
    const m = seenMap();
    m[id] = Date.now();
    for (const k of Object.keys(m)) if (Date.now() - m[k] > 7 * 86400000) delete m[k];
    localStorage.setItem(LS_SEEN, JSON.stringify(m));
  } catch {
    /* storage blocked: every tab decides for itself */
  }
}

async function maybeCelebrate(ev) {
  const id = ev.client.id;
  if (!isId(id) || Date.now() - (seenMap()[id] || 0) < REANNOUNCE_MS) return;
  // A hidden tab waits: the tab you are looking at (or the next one you open) plays it.
  if (document.visibilityState !== 'visible') {
    deferredConnect = ev;
    return;
  }
  markSeen(id);
  if (!status.clients.some((c) => c.id === id)) await refreshStatus();
  const c = status.clients.find((x) => x.id === id) || ev.client;
  playConnectAnimation(c, { clientName: ev.clientName });
}

// Changes made by assistants: one toast per burst, with Undo.
let pendingChanges = [];
let changeTimer = 0;
let firstPending = 0;
function noteChange(entry) {
  if (!entry.changeId || entry.kind === 'user' || panel || document.visibilityState !== 'visible') return;
  if (Date.now() - entry.at > 60000 || undone.has(entry.changeId)) return;
  pendingChanges.push(entry);
  firstPending ||= Date.now();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(flushChanges, Date.now() - firstPending > 2500 ? 0 : 900);
}
function flushChanges() {
  const list = pendingChanges;
  pendingChanges = [];
  firstPending = 0;
  if (!list.length || panel) return;
  const one = list[0];
  const same = list.every((e) => e.clientId === one.clientId);
  const name = same ? who(one) : 'Your assistants';
  const summary = clean(entryText(one), 140) || 'made a change';
  const msg = list.length === 1 ? `${name} ${lcFirst(summary)}` : `${name} made ${list.length} changes`;
  const ids = list.map((e) => e.changeId).reverse();
  toast(msg, {
    action: 'Undo',
    duration: 7000,
    onAction: async () => {
      let ok = 0;
      let failure = null;
      for (const id of ids) {
        try {
          await undoChange(id);
          ok++;
        } catch (err) {
          failure = err;
        }
      }
      if (failure && !ok) toast(undoMessage(failure), { duration: 6000 });
      else toast(ok === 1 ? 'Undone' : `Undid ${ok} changes`, { duration: 2400 });
    },
  });
}

async function undoChange(changeId) {
  const out = await call('ai/undo', { method: 'POST', body: { changeId } });
  undone.add(changeId);
  // The undo is itself a change: remember which one it took back, so its button says Redo.
  if (typeof out?.changeId === 'string' && CHANGE_RE.test(out.changeId) && out.changeId !== changeId) undoLinks.set(out.changeId, changeId);
  emitStatus();
  return out;
}

function undoMessage(err) {
  if (err?.pairing) return 'Couldn’t undo that: this browser isn’t connected to ecosys.';
  const m = String(err?.message || '');
  if (/already undone/i.test(m)) return 'That change was already undone.';
  if (/changed again/i.test(m)) return 'Can’t undo that: it was edited again since.';
  if (/too large/i.test(m)) return 'That change was too large to keep a copy of, so it can’t be undone.';
  if (/no longer kept|No change with id/i.test(m)) return 'That change is too old to undo.';
  if (/already as it was/i.test(m)) return 'Nothing to undo: everything is already as it was.';
  return m || 'Couldn’t undo that change.';
}

// ---------------------------------------------------------------- the connect animation

const queue = [];
let playing = false;
const QUIET_MS = 2500; // someone who typed this recently is still typing
let lastTypedAt = 0;

/** A text field or editor (where keystrokes are someone's words) has focus. */
function inTextField(n = document.activeElement) {
  if (!n || n === document.body || n.nodeType !== 1) return false;
  if (n.isContentEditable || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return true;
  return n.tagName === 'INPUT' && !/^(button|checkbox|radio|range|color|file|image|reset|submit|hidden)$/i.test(n.type || '');
}
function noteTyping(e) {
  if (inTextField(e.target)) lastTypedAt = Date.now();
}
/** Resolves true once nobody is typing, or false after `max` ms of steady typing. */
function whenTypingPauses(max = DEFER_MS) {
  const busy = () => inTextField() && Date.now() - lastTypedAt < QUIET_MS;
  if (!busy()) return Promise.resolve(true);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => (!busy() ? resolve(true) : Date.now() - t0 > max ? resolve(false) : setTimeout(tick, 400));
    setTimeout(tick, 400);
  });
}

/**
 * Play the connection moment: the ecosys orb and the assistant's mark, a beam drawn between them with
 * travelling particles, a check that springs in, then "Claude is connected". Honours Reduce motion.
 * It never covers a field someone is typing in: it waits for a pause (after two minutes of typing it
 * becomes a toast). While it is up it is a modal dialog: it takes focus and gives it back after.
 * client: {id?, kind, label?, access?}. opts: {clientName, mode, access, duration (ms on screen)}.
 */
export function playConnectAnimation(client = { kind: 'claude', label: 'Claude' }, opts = {}) {
  const c = typeof client === 'string' ? { kind: client } : client && typeof client === 'object' ? client : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  ensureListening();
  return new Promise((resolve) => {
    if (queue.length >= 3 || (c.id && queue.some((q) => q.c.id === c.id))) return resolve(false);
    queue.push({ c, opts: o, resolve });
    if (!playing) playNext();
  });
}

async function playNext() {
  const job = queue.shift();
  if (!job) {
    playing = false;
    return;
  }
  playing = true;
  await ensureStyles();
  const next = () => setTimeout(playNext, 250);
  if (!(await whenTypingPauses())) {
    toast(describeConnect(job.c, job.opts).title, { duration: 4000 });
    job.resolve(false);
    return next();
  }
  runOverlay(job.c, job.opts, () => {
    job.resolve(true);
    next();
  });
}

/** The words for a connection moment: who, what it may do, and the caption under its mark. */
function describeConnect(client, opts) {
  const kind = kindOf(client.kind);
  const a = ASSISTANTS[kind];
  const known = client.id ? status.clients.find((x) => x.id === client.id) : null;
  const mode = MODES.some((m) => m.id === opts.mode) ? opts.mode : status.mode || 'write';
  const access = opts.access === 'read' || opts.access === 'write' ? opts.access : known?.access || client.access || 'write';
  const eff = mode === 'off' ? 'off' : mode === 'read' || access === 'read' ? 'read' : 'write';
  const name = who({ kind, label: client.label || known?.label });
  const label = clean(client.label || known?.label, 60);
  const caption = label && label !== name ? label : clientApp(opts.clientName) || (kind === 'other' ? 'MCP app' : a.name);
  const title = eff === 'off' ? `${name} reached ecosys` : `${name} is connected`;
  const sub =
    eff === 'off'
      ? 'AI access is off, so it can’t see anything yet. Turn it on in Connect AI.'
      : eff === 'read'
        ? 'It can read your tasks, calendar and notes.'
        : 'It can read and write your tasks, calendar and notes.';
  return { kind, a, eff, caption, title, sub };
}

/** Keys that put characters into a field: they go back to the field they came from. */
const isTypingKey = (e) =>
  e.isComposing ||
  e.key === 'Process' ||
  e.key === 'Backspace' ||
  e.key === 'Delete' ||
  ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') ||
  (e.key.length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey));

function runOverlay(client, opts, done) {
  const { kind, a, eff, caption, title, sub } = describeConnect(client, opts);
  const reduced = reducedMotion();
  const g = `aicx${++gid}`;
  const dots = (dir, n) =>
    Array.from({ length: n }, (_, i) => {
      const x = dir === 'peer' ? 116 : 264;
      return `<g class="ai-cx-p to-${dir} d${i + 1}"><circle cx="${x}" cy="70" r="7" class="ai-cx-halo" filter="url(#${g}b)"/><circle cx="${x}" cy="70" r="2.6" class="ai-cx-core"/></g>`;
    }).join('');
  const flow = eff === 'off' ? '' : eff === 'read' ? dots('peer', 4) : dots('peer', 3) + dots('home', 3);
  // Where the beams meet: the card's surface in a ring, with the tick, or with access off the lock (ai.css).
  const badge =
    eff === 'off'
      ? `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" class="ai-cx-badge-bg"/><circle cx="20" cy="20" r="17.1" class="ai-cx-badge-ring"/><g class="ai-cx-lock" transform="translate(8 8)"><rect x="4.5" y="10.5" width="15" height="10.5" rx="3"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.75" r="1.6"/></g></svg>`
      : `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" class="ai-cx-badge-bg"/><circle cx="20" cy="20" r="17.1" class="ai-cx-badge-ring"/><path class="ai-cx-tick" d="M12.6 20.6 17.6 25.4 27.6 14.8" pathLength="100"/></svg>`;

  const root = document.createElement('div');
  root.className = `ai-cx ai-cx-${eff}${reduced ? ' reduced' : ''}`;
  root.style.setProperty('--peer', a.color);
  root.innerHTML = `<div class="ai-cx-scrim"></div>
    <div class="ai-cx-card" role="dialog" aria-modal="true" aria-labelledby="${g}t" aria-describedby="${g}s">
      <div class="ai-cx-stage" aria-hidden="true">
        <svg class="ai-cx-svg" viewBox="0 0 380 168">
          <defs>
            <linearGradient id="${g}g" gradientUnits="userSpaceOnUse" x1="116" y1="0" x2="264" y2="0"><stop offset="0" class="ai-cx-s0"/><stop offset="1" stop-color="${a.color}"/></linearGradient>
            <filter id="${g}f" filterUnits="userSpaceOnUse" x="96" y="44" width="188" height="52"><feGaussianBlur stdDeviation="4.5"/></filter>
            <filter id="${g}b" filterUnits="userSpaceOnUse" x="0" y="0" width="380" height="168"><feGaussianBlur stdDeviation="2.6"/></filter>
          </defs>
          <path class="ai-cx-track" d="M116 70H264"/>
          <path class="ai-cx-glow" d="M116 70H264" stroke="url(#${g}g)" filter="url(#${g}f)"/>
          <path class="ai-cx-ray l" d="M116 70H190" stroke="url(#${g}g)" pathLength="100"/>
          <path class="ai-cx-ray r" d="M264 70H190" stroke="url(#${g}g)" pathLength="100"/>
          <g class="ai-cx-flow">${flow}</g>
        </svg>
        <span class="ai-cx-node is-home">${ecosysOrb({ size: 88 })}<span class="ai-cx-ring"></span></span>
        <span class="ai-cx-node is-peer">${assistantMark(kind, { size: 88 })}<span class="ai-cx-ring"></span></span>
        <span class="ai-cx-spark"></span>
        <span class="ai-cx-badge">${badge}</span>
        <span class="ai-cx-cap is-home">ecosys</span>
        <span class="ai-cx-cap is-peer">${esc(caption)}</span>
      </div>
      <h2 class="ai-cx-title" id="${g}t">${esc(title)}</h2>
      <p class="ai-cx-sub" id="${g}s">${esc(sub)}</p>
      <button type="button" class="btn btn-secondary btn-sm ai-cx-done">Done</button>
    </div>`;
  // Focus moves to Done (a screen reader reads the dialog's title and text) and comes back after. The
  // sheet underneath may re-render meanwhile (Connect AI updates as the assistant connects), so the
  // control is also remembered by its data-fk, to find its new copy in the same sheet.
  const prev = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const prevFk = prev?.closest?.('[data-fk]')?.dataset.fk || '';
  const prevSheet = prev?.closest?.('.modal') || null;
  const fromField = inTextField(prev);
  document.body.append(root);
  const card = root.querySelector('.ai-cx-card');
  const doneBtn = root.querySelector('.ai-cx-done');
  doneBtn.focus({ preventScroll: true });

  const total = Math.max(1500, Number.isFinite(+opts.duration) && +opts.duration > 0 ? +opts.duration : reduced ? 4200 : 5800);
  let left = total;
  let started = Date.now();
  let timer = setTimeout(dismiss, left);
  let closed = false;
  const hold = () => {
    clearTimeout(timer);
    left = Math.max(1600, left - (Date.now() - started));
  };
  const resume = () => {
    started = Date.now();
    clearTimeout(timer);
    timer = setTimeout(dismiss, left);
  };
  card.addEventListener('pointerenter', hold);
  card.addEventListener('pointerleave', resume);
  root.addEventListener('click', dismiss);
  // While the card is up nothing behind it reacts to keys (it runs first, at the window): Esc closes
  // it, Tab stays on Done, Enter and Space press Done. A key that types (when focus came from a
  // field) closes it and lands in that field, so no keystroke is lost.
  const onKey = (e) => {
    if (closed || root.inert) return; // a dialog opened on top owns the keyboard now
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      doneBtn.focus({ preventScroll: true });
    } else if (fromField && isTypingKey(e)) {
      lastTypedAt = Date.now(); // this key never reaches the window's typing tracker (stopped above)
      dismiss(); // gives focus back first, so the browser types the key into the field
    }
  };
  window.addEventListener('keydown', onKey, true);

  /** Where focus goes back to: the control itself, else its re-rendered copy, else that sheet's title. */
  function returnTarget() {
    if (prev?.isConnected && !prev.closest('[inert]') && typeof prev.focus === 'function') return prev;
    if (!prevSheet?.isConnected || prevSheet.closest('[inert]')) return null;
    return (prevFk && prevSheet.querySelector(`[data-fk="${CSS.escape(prevFk)}"]`)) || prevSheet.querySelector('.ai-title, h2[tabindex]') || prevSheet;
  }

  function dismiss() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    const now = document.activeElement;
    if (!now || now === document.body || root.contains(now)) {
      returnTarget()?.focus({ preventScroll: true });
      if (root.contains(document.activeElement)) document.activeElement.blur();
    }
    root.inert = true;
    root.classList.add('out');
    setTimeout(() => {
      root.remove();
      done();
    }, reduced ? 120 : 280);
  }
}

// ---------------------------------------------------------------- the AI status button (an app's sidebar head)

/** How things stand while ecosys answers (st.online): the sheet's hero and the status button. */
function summaryOf(st) {
  const kindsOf = (cs) => uniq(cs.map((c) => kindOf(c.kind)));
  const names = (cs) => uniq(cs.map((c) => who(c)));
  const connected = st.clients.filter((c) => c.connected);
  const plain = (s) => ({ sub: s, subHtml: esc(s) });
  if (st.mode === 'off') return { tone: 'off', kinds: kindsOf(st.clients), title: 'AI access is off', ...plain('Assistants can’t read or change anything.') };
  if (connected.length) {
    const ns = names(connected);
    const latest = Math.max(...connected.map((c) => c.lastSeen || 0));
    const ro = st.mode === 'read' ? ', read only' : '';
    return {
      tone: 'on',
      kinds: kindsOf(connected),
      title: ns.length > 2 ? `${ns.length} assistants are connected` : `${listJoin(ns)} ${ns.length > 1 ? 'are' : 'is'} connected`,
      ...(latest ? { sub: `Active ${ago(latest)}${ro}`, subHtml: `Active ${agoSpan(latest)}${ro}` } : plain(`Connected${ro}`)),
    };
  }
  if (st.clients.length) {
    const ns = names(st.clients);
    const latest = Math.max(0, ...st.clients.map((c) => c.lastSeen || 0));
    return {
      tone: 'idle',
      kinds: kindsOf(st.clients),
      title: `Ready for ${ns.length > 2 ? `${ns.length} assistants` : listJoin(ns)}`,
      ...(latest ? { sub: `Last active ${ago(latest)}`, subHtml: `Last active ${agoSpan(latest)}` } : plain('Waiting for the first connection')),
    };
  }
  return { tone: 'none', kinds: [], title: 'Connect an AI assistant', ...plain('Let Claude, ChatGPT or Grok work with your tasks, calendar and notes.') };
}

/**
 * Markup without its per-render SVG gradient ids (the marks' aim/aio/aicx, the app logos' ecg), to tell whether
 * anything on screen would really change. Only id="…" and url(#…) are touched: escaped text can't contain id="
 * (quotes are escaped).
 */
const stableKey = (h) => h.replace(/(id="|url\(#)(ai(?:m|o|cx)|ecg)\d+/g, '$1$2');

/**
 * Put `html` (one root element) into `host`, keeping the root element that is already there: the button stays
 * the same node, so keyboard focus, hover and a screen reader's place survive.
 */
function morph(host, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const next = tpl.content.firstElementChild;
  const cur = host.firstElementChild;
  if (!cur || !next || cur.tagName !== next.tagName || host.childElementCount !== 1 || tpl.content.childElementCount !== 1) {
    host.replaceChildren(tpl.content);
    return;
  }
  for (const { name } of [...cur.attributes]) if (!next.hasAttribute(name)) cur.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (cur.getAttribute(name) !== value) cur.setAttribute(name, value);
  cur.replaceChildren(...next.childNodes);
}

/**
 * Keep `el` drawn from the live status: `draw(status)` gives its markup, or '' for nothing (then `el` is hidden).
 * It waits for ai.css, redraws only when something visible changes, and stops by itself once `el` leaves the page.
 */
function mountLive(el, draw) {
  if (!(el instanceof Element)) throw new TypeError('ecosys: an element is required');
  ensureListening();
  let stop = false;
  let wasConnected = false;
  let styled = false;
  let shown = null;
  el.hidden = true; // until there is something to show, styled
  const onClick = (e) => {
    if (e.target.closest?.('[data-ai-open]')) openAIPanel();
  };
  const render = (st) => {
    if (stop || !styled) return;
    if (el.isConnected) wasConnected = true;
    else if (wasConnected) return destroy();
    const html = draw(st || publicStatus());
    const key = stableKey(html);
    if (key === shown) return; // a repeated status
    shown = key;
    morph(el, html);
    el.hidden = !html;
  };
  el.addEventListener('click', onClick);
  ensureStyles().then(() => {
    styled = true;
    render();
  });
  const off = onAIStatus(render);
  function destroy() {
    stop = true;
    off();
    el.removeEventListener('click', onClick);
  }
  return { refresh: () => refreshStatus(), destroy };
}

/**
 * The AI status button for an app's header: initAI() puts one in the sidebar's head of Tasks, Schedule and Notes,
 * beside the app switcher (Home's AI icon has a caption of its own). Nothing shows until an assistant is set up and
 * ecosys answers. Then it is the AI glyph, whose docked circle (the assistant) lights up while one is connected,
 * struck through while AI access is off; its name and tooltip say who is connected, and "read only" when that
 * applies. Pressing it opens Connect AI. Returns {refresh, destroy}; it also stops once `el` leaves the page.
 */
export function renderAIChip(el) {
  return mountLive(el, (st) => {
    if (!st.online || !st.clients.length) return '';
    const s = summaryOf(st);
    const tone = s.tone === 'on' ? 'on' : s.tone === 'off' ? 'off' : 'idle';
    const said = tone === 'off' ? s.title : `${s.title}${st.mode === 'read' ? ', read only' : ''}`;
    return `<button type="button" class="icon-btn ai-chip ${tone}" data-ai-open aria-haspopup="dialog" aria-label="${esc(`AI assistants, ${said}`)}" data-tip="${esc(said)}">${icon(tone === 'off' ? 'ai-off' : 'ai', { size: 20 })}</button>`;
  });
}

/** Tasks, Schedule and Notes: the status button in the sidebar's head, just before the app switcher. Once per page. */
function mountAppStatus() {
  const head = document.querySelector('.sidebar .side-head');
  if (!head || head.querySelector('.ai-side')) return;
  const host = document.createElement('span');
  host.className = 'ai-side';
  head.insertBefore(host, head.querySelector(':scope > [data-app-switcher]'));
  renderAIChip(host);
}

// ---------------------------------------------------------------- the Connect AI panel

let panel = null;
let opening = null;

/** Open Connect AI. opts.kind jumps straight to that assistant's setup page. */
export function openAIPanel(opts = {}) {
  const kind = opts && Object.hasOwn(ASSISTANTS, opts.kind || '') ? opts.kind : null;
  if (panel) {
    if (kind) panel.go(kind);
    return Promise.resolve();
  }
  if (opening) return opening; // a second click while the sheet is on its way
  ensureListening();
  opening = ensureStyles()
    .then(() => {
      if (!panel) panel = createPanel({ kind });
    })
    .finally(() => {
      opening = null;
    });
  return opening;
}

function copyText(textValue) {
  return navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(textValue).then(
        () => true,
        () => legacyCopy(textValue),
      )
    : Promise.resolve(legacyCopy(textValue));
}
function legacyCopy(textValue) {
  const ta = document.createElement('textarea');
  ta.value = textValue;
  ta.setAttribute('readonly', '');
  ta.className = 'ai-offscreen';
  (document.activeElement?.closest?.('.modal') || document.body).append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function readTunnel() {
  try {
    return normalizeTunnel(localStorage.getItem(LS_TUNNEL) || '');
  } catch {
    return '';
  }
}
function saveTunnel(v) {
  try {
    if (v) localStorage.setItem(LS_TUNNEL, v);
    else localStorage.removeItem(LS_TUNNEL);
  } catch {
    /* fine: it is only a convenience */
  }
}
/** 'abc.trycloudflare.com' or 'https://abc.trycloudflare.com/…' → 'https://abc.trycloudflare.com' ('' if not usable). */
function normalizeTunnel(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) || /^(localhost|127\.|10\.|192\.168\.)/i.test(u.hostname)) return '';
    return u.origin;
  } catch {
    return '';
  }
}

function createPanel(opts) {
  const S = {
    page: Object.hasOwn(ASSISTANTS, opts.kind || '') ? opts.kind : 'home',
    state: 'loading', // 'loading' | 'ready' | 'unavailable'
    why: '',
    data: null, // the server's view, with keys: lives only while the panel is open
    reveal: new Set(),
    tabs: { claude: 'desktop', grok: 'app' },
    filter: 'all',
    showAll: false,
    open: new Set(),
    busy: new Set(),
    install: null,
    tunnel: readTunnel(),
    tunnelRaw: '',
    enter: '',
    copies: new Map(),
    next: null,
    focusTo: null, // {fk, until}: where focus goes after the next render (see restoreFocus)
  };
  S.tunnelRaw = S.tunnel;
  let reloadTimer = 0;
  let renderTimer = 0;
  let ticker = 0;

  const { el } = openModal({
    className: 'ai-panel grouped',
    label: 'Connect AI',
    body: '<div class="modal-head ai-head"></div><div class="modal-body ai-body"></div>',
    onClose: () => {
      clearInterval(ticker);
      clearTimeout(reloadTimer);
      clearTimeout(renderTimer);
      S.data = null;
      S.copies.clear();
      panel = null;
    },
  });
  const head = el.querySelector('.ai-head');
  const body = el.querySelector('.ai-body');
  const rendered = new WeakMap();
  // "2 min ago" stays true while the sheet is open.
  ticker = setInterval(() => {
    for (const n of el.querySelectorAll('[data-ago]')) n.textContent = ago(+n.dataset.ago);
  }, 30000);

  // ---------------------------------------------------------------- data

  async function load({ quiet = false, probe = false } = {}) {
    if (!quiet && !S.data) {
      S.state = 'loading';
      render();
    }
    try {
      S.data = await fetchOverview({ probe });
      S.state = 'ready';
    } catch (err) {
      if (S.data && err.status === 0) toast(err.message);
      else {
        S.data = null;
        S.state = 'unavailable';
        S.why = err.reason || 'unreachable';
      }
    }
    render();
  }
  const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => load({ quiet: true }), 250);
  };
  const scheduleRender = (ms = 180) => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, ms);
  };
  const clients = () => S.data?.clients || [];
  const client = (id) => clients().find((c) => c.id === id) || null;
  const ofKind = (kind) => clients().filter((c) => c.kind === kind);
  const surfaceOf = (kind) => SURFACES[kind].find((s) => s.id === S.tabs[kind]) || SURFACES[kind][0];
  /**
   * The connection a setup surface uses: same label (or "Label 2"), else a generic one of that kind.
   * Other MCP apps each have their own connection; the setup shows the one picked (S.tabs.other).
   */
  function credFor(kind, s) {
    const mine = ofKind(kind);
    if (kind === 'other') return mine.find((c) => c.id === S.tabs.other) || mine[0] || null;
    const l = s.label.toLowerCase();
    const exact = mine.find((c) => c.label.toLowerCase() === l) || mine.find((c) => c.label.toLowerCase().startsWith(`${l} `));
    if (exact || s.exact) return exact || null;
    if (SURFACES[kind].length === 1) return mine[0] || null;
    const generic = [ASSISTANTS[kind].name.toLowerCase(), 'ai assistant'];
    return mine.find((c) => generic.includes(c.label.toLowerCase())) || null;
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!document.contains(el)) return;
    const keep = focusState();
    S.next = new Map();
    const headHtml = renderHead();
    const bodyHtml =
      S.state === 'loading'
        ? '<div class="ai-loading"><span class="ai-spin"></span></div>'
        : S.state === 'unavailable'
          ? unavailableHtml(S.why)
          : S.page === 'home'
            ? homeHtml()
            : detailHtml(S.page);
    const enter = S.enter;
    S.enter = '';
    const page = (cls) => `<div class="ai-page${cls}" data-page="${esc(S.page)}">${bodyHtml}</div>`;
    patch(head, headHtml);
    // The entrance class is left out of the comparison, so the next refresh doesn't cut its animation.
    patch(body, page(enter ? ` enter-${enter}` : ''), { key: page(''), force: !!enter });
    S.copies = S.next;
    restoreFocus(keep);
  }

  /** Replace a region's HTML unless nothing visible changed (SVG ids differ on every render). */
  function patch(node, html, { key = html, force = false } = {}) {
    const k = stableKey(key);
    if (!force && rendered.get(node) === k) return;
    node.innerHTML = html;
    rendered.set(node, k);
  }

  // Focus survives every re-render. Each control carries a stable data-fk. If the focused one is
  // re-rendered it gets focus back (with a text field's selection). If it is gone, an action may have
  // named where to go (S.focusTo), else focus moves to the nearest control that is still there (the
  // next one, else the one before), never to the sheet itself, where Tab would start over at the top.
  function focusState() {
    const a = document.activeElement;
    if (!a || a === el || !el.contains(a)) return null;
    const all = [...el.querySelectorAll('[data-fk]')];
    const i = all.indexOf(a);
    return {
      node: a,
      fk: a.dataset?.fk || '',
      sel: a.tagName === 'INPUT' ? [a.selectionStart, a.selectionEnd] : null,
      near: i < 0 ? [] : [...all.slice(i + 1), ...all.slice(0, i).reverse()].map((n) => n.dataset.fk),
    };
  }
  const byFk = (k) => (k ? el.querySelector(`[data-fk="${CSS.escape(k)}"]`) : null);
  /** Focus `n`; when it moved somewhere new, bring it into view for keyboard users. */
  let steering = false;
  function focusOn(n, { moved = false } = {}) {
    steering = true;
    try {
      n.focus({ preventScroll: true });
    } finally {
      steering = false;
    }
    if (moved && n.matches(':focus-visible')) n.scrollIntoView({ block: 'nearest' });
  }
  // Someone moving focus themselves cancels a pending "focus this next".
  el.addEventListener('focusin', () => {
    if (!steering) S.focusTo = null;
  });
  function restoreFocus(keep) {
    const now = document.activeElement;
    const lost = !now || now === document.body || now === el;
    if (S.focusTo && Date.now() > S.focusTo.until) S.focusTo = null;
    const want = S.focusTo ? byFk(S.focusTo.fk) : null;
    if (want && (lost || el.contains(now))) {
      S.focusTo = null;
      if (want !== now) focusOn(want, { moved: true });
      return;
    }
    if (!keep || !lost) return; // still on a live control, or focus wasn't in the sheet
    const same = byFk(keep.fk);
    if (same) {
      focusOn(same);
      if (keep.sel && typeof same.setSelectionRange === 'function') {
        try {
          same.setSelectionRange(keep.sel[0], keep.sel[1]);
        } catch {
          /* not a text field */
        }
      }
      return;
    }
    const near = keep.near.map(byFk).find(Boolean);
    focusOn(near || head.querySelector('.ai-title') || el, { moved: true });
  }
  /** After the next render, focus the control `fk` (once it exists; give up after a few seconds). */
  const focusNext = (fk) => (S.focusTo = { fk, until: Date.now() + 4000 });

  function copyKey(fk, textValue, secret = false) {
    const k = `c${S.next.size + 1}`;
    S.next.set(k, { text: textValue, secret, fk });
    return k;
  }

  function renderHead() {
    const detail = S.state === 'ready' && S.page !== 'home';
    const title = detail ? ASSISTANTS[S.page].name : 'Connect AI';
    const sync = window.ecosysSync?.status;
    const live =
      S.state !== 'ready'
        ? ''
        : sync === 'online'
          ? '<span class="ai-live" data-tip="Changes show up here as they happen"><span class="ai-live-dot"></span>Live</span>'
          : sync === 'offline' || sync === 'connecting'
            ? '<span class="ai-live off"><span class="ai-spin sm"></span>Reconnecting</span>'
            : '';
    // The sheet's own page carries the AI app's logo, as each app's sidebar carries its logo; a setup page has Back.
    const lead = detail
      ? `<button type="button" class="icon-btn ai-back" data-act="back" data-fk="back" aria-label="Back to Connect AI" data-tip="Back">${icon('chevron-left')}</button>`
      : `<span class="app-icon ai-head-logo" aria-hidden="true">${appIcon('ai', { small: true })}</span>`;
    return `${lead}
      <h2 class="ai-title" tabindex="-1" data-fk="title">${esc(title)}</h2>${live}
      <button type="button" class="icon-btn" data-close data-fk="close" aria-label="Close" data-tip="Close" data-keys="esc">${icon('x')}</button>`;
  }

  // ---------------------------------------------------------------- home page

  function homeHtml() {
    const st = { ...publicStatus(), online: true, mode: S.data.mode, clients: clients().map(stripSecrets) };
    st.connected = st.clients.filter((c) => c.connected);
    const s = summaryOf(st);
    const mode = MODES.find((m) => m.id === S.data.mode) || MODES[2];
    return `<section class="ai-hero tone-${s.tone}" style="--peer:${esc(s.kinds.length ? ASSISTANTS[s.kinds[0]].color : 'var(--accent)')}">
        ${vizHtml(s.kinds, { live: s.tone === 'on' })}
        <h3 class="ai-hero-title">${esc(s.title)}</h3>
        <p class="ai-hero-sub">${s.subHtml}</p>
      </section>

      <div class="group-title" id="ai-access-label">AI access</div>
      <div class="group ai-access">
        <div class="segmented full" role="group" aria-labelledby="ai-access-label">${MODES.map((m) => `<button type="button" data-act="mode" data-val="${m.id}" data-fk="mode-${m.id}" aria-pressed="${m.id === S.data.mode}">${esc(m.label)}</button>`).join('')}</div>
        <p class="ai-note">${esc(mode.text)}</p>
      </div>

      <div class="group-title">Assistants</div>
      <div class="group ai-list">${ORDER.map(rowHtml).join('')}</div>
      <div class="group-foot">Each assistant gets its own key, so you can see who changed what and cut one off on its own. ecosys never sends your keys anywhere: a key leaves this computer only when you paste it into an app.</div>

      ${activityHtml()}

      <div class="ai-foot"><button type="button" class="btn btn-ghost btn-sm" data-act="preview" data-fk="preview">${icon('ai', { size: 16 })}Preview the connection animation</button></div>`;
  }

  /** With AI access off nothing an assistant asks for is answered, however recently it was seen. */
  const paused = () => S.data?.mode === 'off';

  function kindState(kind) {
    const mine = ofKind(kind);
    if (!mine.length) return { tone: 'none', text: 'Set up' };
    if (paused()) return { tone: 'off', text: 'Paused' };
    const on = mine.filter((c) => c.connected);
    if (on.length) return { tone: 'on', text: 'Connected', since: Math.max(...on.map((c) => c.lastSeen || 0)) };
    const seen = Math.max(0, ...mine.map((c) => c.lastSeen || 0));
    return seen ? { tone: 'idle', text: `Active ${ago(seen)}`, html: `Active ${agoSpan(seen)}`, since: seen } : { tone: 'new', text: 'Not connected yet' };
  }

  function rowHtml(kind) {
    const a = ASSISTANTS[kind];
    const st = kindState(kind);
    return `<button type="button" class="item ai-row" data-act="open" data-kind="${kind}" data-fk="row-${kind}">
      ${assistantMark(kind, { size: 38 })}
      <span class="grow"><span class="ai-row-name">${esc(a.name)}</span><span class="ai-row-sub">${esc(a.blurb)}</span></span>
      <span class="ai-state ${st.tone}">${st.tone === 'on' ? '<span class="ai-dot on"></span>' : ''}<span>${st.html || esc(st.text)}</span></span>
      ${icon('chevron-right', { size: 16, cls: 'ai-chev' })}
    </button>`;
  }

  function isUndone(e) {
    return e.undone || (!!e.changeId && undone.has(e.changeId));
  }

  /**
   * Feed rows: back-to-back identical look-ups by the same connection (an assistant checking the
   * agenda five times) share one row, newest first, with a count. Changes are never merged.
   */
  function feedRows(list) {
    const rows = [];
    for (const e of list) {
      const p = rows.at(-1);
      if (p && !e.changeId && !p.e.changeId && e.kind === p.e.kind && e.clientId === p.e.clientId && e.label === p.e.label && e.tool === p.e.tool && e.summary === p.e.summary) p.n++;
      else rows.push({ e, n: 1 });
    }
    return rows;
  }

  function activityHtml() {
    const all = S.data.activity;
    const list = feedRows(S.filter === 'changes' ? all.filter((e) => e.changeId) : all);
    const shown = S.showAll ? list : list.slice(0, FEED_PREVIEW);
    const seg = `<div class="segmented ai-seg-sm" role="group" aria-label="Show">${[
      ['all', 'All'],
      ['changes', 'Changes'],
    ]
      .map(([v, l]) => `<button type="button" data-act="filter" data-val="${v}" data-fk="filter-${v}" aria-pressed="${S.filter === v}">${l}</button>`)
      .join('')}</div>`;
    const empty = all.length
      ? '<div class="ai-empty">No changes yet. Assistants have only looked things up.</div>'
      : '<div class="ai-empty">Nothing yet. When an assistant reads or changes something, it shows up here.</div>';
    return `<div class="ai-sec-head"><div class="group-title">Activity</div>${all.length ? seg : ''}</div>
      <div class="group ai-feed">${shown.length ? shown.map(entryHtml).join('') : empty}</div>
      ${list.length > shown.length ? `<button type="button" class="btn btn-ghost btn-sm ai-more" data-act="more" data-fk="more">Show all ${list.length}</button>` : ''}`;
  }

  function entryHtml({ e, n }) {
    const gone = isUndone(e);
    // In the undo chain the button alternates: an undo's button re-applies the change (Redo), the
    // button under that takes it back again (Undo), and so on.
    const redo = isRedo(e);
    const busy = S.busy.has(`undo-${e.changeId}`);
    const whoText = e.kind === 'user' ? 'You' : e.label;
    const text = entryText(e);
    const fk = `undo-${e.changeId}`;
    // Once pressed, the button's place is taken by "Undone", which keeps its focus (tabindex -1).
    const action = e.changeId
      ? gone
        ? `<span class="ai-undone" tabindex="-1" data-fk="${esc(fk)}">${redo ? 'Redone' : 'Undone'}</span>`
        : `<button type="button" class="btn btn-secondary btn-sm ai-undo" data-act="undo" data-change="${esc(e.changeId)}" data-fk="${esc(fk)}"${busy ? ' aria-disabled="true"' : ''} aria-label="${esc(`${redo ? 'Redo' : 'Undo'}: ${text}`)}">${busy ? '<span class="ai-spin sm"></span>' : ''}${redo ? 'Redo' : 'Undo'}</button>`
      : '';
    return `<div class="item ai-entry${e.changeId ? ' write' : ''}${gone ? ' gone' : ''}">
      ${entryMark(e, 30)}
      <span class="grow"><span class="ai-entry-text">${esc(text)}</span><span class="ai-entry-meta">${sepJoin([whoText, { html: agoSpan(e.at) }, n > 1 ? `${n} times` : ''])}</span></span>
      ${action}
    </div>`;
  }

  // ---------------------------------------------------------------- an assistant's page

  function detailHtml(kind) {
    const mine = ofKind(kind);
    const st = kindState(kind);
    const line =
      st.tone === 'on'
        ? sepJoin(['Connected', st.since ? { html: `active ${agoSpan(st.since)}` } : ''])
        : st.tone === 'idle'
          ? sepJoin(['Not connected', { html: `active ${agoSpan(st.since)}` }])
          : esc(st.tone === 'off' ? 'Paused while AI access is off' : st.tone === 'new' ? 'Set up, waiting for the first connection' : 'Not set up yet');
    const global = S.data.mode !== 'write' ? `<div class="ai-callout">${icon('info', { size: 18 })}<div>${S.data.mode === 'off' ? 'AI access is <strong>off</strong>, so every connection is refused until you turn it back on.' : 'AI access is <strong>read only</strong> for everyone right now, whatever each connection allows.'} <button type="button" class="ai-link" data-act="back" data-fk="access-link">Change</button></div></div>` : '';
    return `<section class="ai-dhero">
        ${assistantMark(kind, { size: 52 })}
        <div class="grow"><p class="ai-dline"><span class="ai-dot ${st.tone === 'on' ? 'on' : st.tone === 'idle' || st.tone === 'off' ? 'idle' : 'new'}"></span><span>${line}</span></p><p class="ai-dabout">${esc(ABOUT[kind])}</p></div>
      </section>
      ${global}
      ${mine.length ? `<div class="group-title">Connections</div><div class="group ai-conns">${mine.map(connHtml).join('')}${kind === 'other' ? addAppHtml() : ''}</div>` : ''}
      <div class="group-title" id="ai-setup-label">Set up</div>
      ${setupHtml(kind)}`;
  }

  function secretHtml(tokenValue, shown) {
    if (!tokenValue) return '<span class="ai-ph">no key</span>';
    if (shown) return `<span class="ai-secret on">${esc(tokenValue)}</span>`;
    return `<span class="ai-secret" role="img" aria-label="${esc(`Hidden key ending in ${tokenValue.slice(-4)}`)}"><span class="ai-dots" aria-hidden="true"></span><span aria-hidden="true">${esc(tokenValue.slice(-4))}</span></span>`;
  }

  /** Build display HTML (keys masked unless revealed) and the plain text to copy, in one go. */
  function parts(...xs) {
    let html = '';
    let textValue = '';
    let secret = false;
    let missing = false;
    for (const x of xs) {
      if (x && typeof x === 'object' && 'secret' in x) {
        secret = true;
        textValue += x.secret;
        html += secretHtml(x.secret, S.reveal.has(x.cid));
      } else if (x && typeof x === 'object' && 'ph' in x) {
        missing = true;
        textValue += x.ph;
        html += `<span class="ai-ph">${esc(x.ph)}</span>`;
      } else {
        textValue += String(x ?? '');
        // A command flag (--client, --data) stays whole when a long command wraps.
        html += esc(x ?? '').replace(/--[a-z][a-z-]*/gi, (flag) => `<span class="ai-nw">${flag}</span>`);
      }
    }
    return { html, text: textValue, secret, missing };
  }

  function codeHtml(p, { fk, label = 'Copy', block = false } = {}) {
    const k = copyKey(fk, p.text, p.secret);
    // Unavailable until the tunnel address is in: still focusable, so its hint can be found and read.
    return `<div class="ai-code${block ? ' block' : ''}"><pre><code>${p.html}</code></pre><button type="button" class="icon-btn sm ai-copy" data-act="copy" data-copy="${k}" data-fk="${esc(fk)}" aria-label="${esc(p.missing ? `${label} (add your tunnel address first)` : label)}" data-tip="${esc(p.missing ? 'Add your tunnel address first' : label)}"${p.missing ? ' aria-disabled="true"' : ''}>${icon('copy', { size: 17 })}</button></div>`;
  }

  /** "Connected, active 2 min ago, Claude Code 2.1.293" (or "Paused, last active …") as dot-separated markup. */
  function connMeta(c) {
    const live = c.connected && !paused();
    return sepJoin([
      paused() ? 'Paused' : live ? 'Connected' : '',
      live ? (c.lastSeen ? { html: `active ${agoSpan(c.lastSeen)}` } : '') : c.lastSeen ? { html: `Last active ${agoSpan(c.lastSeen)}` } : paused() ? '' : 'Not connected yet',
      c.lastClientName ? clientApp(c.lastClientName) : '',
    ]);
  }

  function connHtml(c) {
    const shown = S.reveal.has(c.id);
    const busy = S.busy.has(`access-${c.id}`);
    const dis = busy ? ' aria-disabled="true"' : '';
    return `<div class="ai-conn">
      <div class="ai-conn-head">
        <span class="ai-dot ${c.connected && !paused() ? 'on' : c.lastSeen || paused() ? 'idle' : 'new'}"></span>
        <span class="grow"><span class="ai-conn-name">${esc(c.label)}</span><span class="ai-conn-meta">${connMeta(c)}</span></span>
        <button type="button" class="icon-btn sm" data-act="conn-menu" data-cid="${esc(c.id)}" data-fk="menu-${esc(c.id)}" aria-label="${esc(`More for ${c.label}`)}" aria-haspopup="menu" aria-expanded="false" data-tip="More">${icon('more')}</button>
      </div>
      <div class="ai-kv">
        <span class="ai-k">Key</span>
        <span class="ai-v"><code class="ai-keytext">${secretHtml(c.token, shown)}</code>
          <button type="button" class="icon-btn sm" data-act="reveal" data-cid="${esc(c.id)}" data-fk="reveal-${esc(c.id)}" aria-pressed="${shown}" aria-label="${shown ? 'Hide key' : 'Show key'}" data-tip="${shown ? 'Hide' : 'Show'}">${icon(shown ? 'eye-off' : 'eye', { size: 18 })}</button>
          <button type="button" class="icon-btn sm" data-act="copy" data-copy="${copyKey(`key-${c.id}`, c.token, true)}" data-fk="copykey-${esc(c.id)}" aria-label="Copy key" data-tip="Copy key">${icon('copy', { size: 18 })}</button>
        </span>
      </div>
      <div class="ai-kv">
        <span class="ai-k">Access</span>
        <span class="ai-v"><span class="segmented ai-seg-sm" role="group" aria-label="${esc(`Access for ${c.label}`)}">
          <button type="button" data-act="access" data-cid="${esc(c.id)}" data-val="read" data-fk="acc-read-${esc(c.id)}" aria-pressed="${c.access === 'read'}"${dis}>Read only</button>
          <button type="button" data-act="access" data-cid="${esc(c.id)}" data-val="write" data-fk="acc-write-${esc(c.id)}" aria-pressed="${c.access === 'write'}"${dis}>Read &amp; write</button>
        </span></span>
      </div>
    </div>`;
  }

  function setupHtml(kind) {
    const list = SURFACES[kind];
    const cur = surfaceOf(kind);
    const tabs =
      list.length > 1
        ? `<div class="segmented full ai-tabs" role="tablist" aria-labelledby="ai-setup-label">${list
            .map(
              (s) =>
                `<button type="button" role="tab" id="ai-tab-${s.id}" aria-controls="ai-tabpanel" aria-selected="${s === cur}" tabindex="${s === cur ? 0 : -1}" data-act="tab" data-kind="${kind}" data-val="${s.id}" data-fk="tab-${s.id}">${esc(s.tab)}</button>`,
            )
            .join('')}</div>`
        : '';
    const role = list.length > 1 ? `role="tabpanel" id="ai-tabpanel" aria-labelledby="ai-tab-${cur.id}"` : '';
    return `${tabs}<div class="group ai-setup" ${role}>${SETUP[cur.id](kind, cur)}</div>`;
  }

  // Setup building blocks ------------------------------------------------------------------------

  // A step with `fk` can hold focus (tabindex -1): it takes over from the button it replaced.
  const steps = (list) =>
    `<ol class="ai-steps">${list
      .filter(Boolean)
      .map(
        (s) =>
          `<li class="ai-step${s.done ? ' done' : ''}"${s.fk ? ` tabindex="-1" data-fk="${esc(s.fk)}"` : ''}><span class="ai-step-n" aria-hidden="true">${s.done ? icon('check', { size: 14, stroke: 3 }) : ''}</span><div class="ai-step-b"><div class="ai-step-t">${s.title}${s.done ? '<span class="sr-only"> (done)</span>' : ''}</div>${s.body || ''}</div></li>`,
      )
      .join('')}</ol>`;
  // A menu path. Each crumb is grouped with the chevron after it, so a wrapped row never starts with one.
  const crumbs = (...xs) =>
    `<span class="ai-crumbs">${xs
      .map((x, i) => {
        const crumb = x && typeof x === 'object' ? `<span class="ai-crumb">${icon(x.icon, { size: 13, stroke: 2.4 })}<span class="sr-only">${esc(x.label)}</span></span>` : `<span class="ai-crumb">${esc(x)}</span>`;
        return i < xs.length - 1 ? `<span class="ai-crumb-step">${crumb}${icon('chevron-right', { size: 12, cls: 'ai-crumb-sep' })}</span>` : crumb;
      })
      .join('')}</span>`;
  const ic = (s) => `<code class="ai-ic">${esc(s)}</code>`;
  const q = (s) => `"${s}"`;
  const nodeCmd = () => q(S.data.nodePath || 'node');
  const bridge = () => q(S.data.bridgePath || 'mcp/stdio-bridge.mjs');
  // The bridge's extra arguments (`--data <folder>` when ecosys keeps its data elsewhere), for a
  // command line (flags bare, values quoted) and for a JSON args list.
  const bridgeArgs = () => S.data.bridgeArgs || [];
  const bridgeTail = () => bridgeArgs().flatMap((a) => [' ', a.startsWith('--') ? a : q(a)]);
  const stdioEntry = (c) => ({ command: S.data.nodePath || 'node', args: [S.data.bridgePath || 'mcp/stdio-bridge.mjs', '--client', c.id, ...bridgeArgs()] });
  const dataDir = () => {
    const a = bridgeArgs();
    const i = a.indexOf('--data');
    return i >= 0 ? a[i + 1] || '' : '';
  };
  const localPort = () => {
    try {
      return new URL(S.data.localUrl).port || '';
    } catch {
      return '';
    }
  };
  const origin = () => {
    try {
      return new URL(S.data.localUrl).origin;
    } catch {
      return location.origin;
    }
  };
  const folder = () => {
    const f = (S.data.bridgePath || '').replace(/[\\/]mcp[\\/]stdio-bridge\.mjs$/i, '');
    return f && f !== S.data.bridgePath ? f : '';
  };
  const waitingHtml = (c, name) =>
    !c
      ? ''
      : paused()
        ? `<p class="ai-wait">${icon('lock', { size: 16 })}<span>AI access is off, so ${esc(name)} can’t use ecosys until you turn it back on.</span></p>`
        : c.connected
          ? `<p class="ai-ok">${icon('check-circle', { size: 16 })}<span>${esc(name)} is connected${c.lastSeen ? `, active ${agoSpan(c.lastSeen)}` : ''}</span></p>`
          : `<p class="ai-wait"><span class="ai-spin sm"></span><span>Waiting for ${esc(name)} to connect…</span></p>`;
  const createHtml = (kind, s, name) => {
    const busy = S.busy.has(`create-${s.id}`);
    return `<div class="ai-actions"><button type="button" class="btn btn-tint btn-sm" data-act="create" data-kind="${kind}" data-surface="${s.id}" data-fk="create-${s.id}"${busy ? ' aria-disabled="true"' : ''}>${busy ? '<span class="ai-spin sm"></span>' : icon('key', { size: 16 })}Create a key for ${esc(name)}</button></div>`;
  };
  function connStep(kind, s, c, name) {
    if (c) {
      return {
        title: 'Connection key',
        done: true,
        fk: `create-${s.id}`, // focus lands here after "Create a key", in place of the button
        body: `<p class="ai-p">Uses the <strong>${esc(c.label)}</strong> connection${c.access === 'read' ? ', which is read only' : ''}. You can change its access or key under Connections.</p>`,
      };
    }
    return {
      title: `Create a key for ${esc(name)}`,
      body: `<p class="ai-p">Every app gets its own key, so you can see what it changed and turn it off on its own.${s.access === 'read' ? ' This one starts read only.' : ''}</p>${createHtml(kind, s, name)}`,
    };
  }
  // Other MCP apps: one connection per app. "Add another app…" makes a new one; with two or more, the
  // setup says which app it is for and lets you switch.
  const addAppHtml = () => {
    const busy = S.busy.has('add-other');
    return `<button type="button" class="ai-add" data-act="add-other" data-fk="add-other"${busy ? ' aria-disabled="true"' : ''}>${busy ? '<span class="ai-spin sm"></span>' : icon('plus', { size: 17, stroke: 2.2 })}<span>Add another app…</span></button>`;
  };
  const otherPicker = (c) =>
    ofKind('other').length < 2
      ? ''
      : `<div class="ai-pick"><span class="ai-pick-k" id="ai-pick-k">Setup for</span><button type="button" class="field-btn compact ai-pick-btn" data-act="pick-other" data-fk="pick-other" aria-haspopup="menu" aria-expanded="false" aria-labelledby="ai-pick-k ai-pick-v"><span class="fb-label" id="ai-pick-v"><span class="truncate">${esc(c.label)}</span></span>${icon('chevron-down', { size: 16, cls: 'fb-chev' })}</button></div>`;
  const disclosure = (id, label, inner) => {
    const open = S.open.has(id);
    return `<div class="ai-disc-wrap"><button type="button" class="ai-disc" data-act="toggle" data-val="${esc(id)}" data-fk="disc-${esc(id)}" aria-expanded="${open}">${icon('chevron-right', { size: 15, cls: 'ai-disc-chev' })}${esc(label)}</button>${open ? `<div class="ai-disc-body">${inner}</div>` : ''}</div>`;
  };
  const secretUrl = (c, base) => (c ? parts(base ? base : { ph: 'https://your-tunnel-address' }, '/s/', { secret: c.token, cid: c.id }, '/mcp') : null);

  /** Tunnel steps for assistants that live in the cloud. Returns {steps, base}. */
  function tunnelSteps(name) {
    const pub = (S.data.publicUrls || []).map((u) => u.replace(/\/mcp$/, ''));
    if (pub.length) {
      return {
        base: pub[0],
        steps: [{ title: 'Public address', done: true, body: `<p class="ai-p">ecosys is reachable at ${ic(pub[0])} through your tunnel. Keep the tunnel running while you use ${esc(name)}.</p>` }],
      };
    }
    const base = S.tunnel;
    const host = base ? new URL(base).host : '';
    const install = OS === 'win' ? 'winget install --id Cloudflare.cloudflared' : OS === 'mac' ? 'brew install cloudflared' : '';
    const f = folder();
    const hostPart = host || { ph: 'your-tunnel-address' };
    // A restart must come back the way this copy runs now: the same port (the tunnel points at it)
    // and the same data folder. Neither is remembered by the shell, so the command says them.
    const port = localPort();
    const portVar = port && port !== '4300' ? port : '';
    const dir = dataDir();
    const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const restart =
      OS === 'win'
        ? parts(
            ...(f ? ['cd ', q(f), '; '] : []),
            "$env:ECOSYS_ALLOWED_HOSTS = '",
            hostPart,
            "'; ",
            ...(portVar ? [`$env:PORT = '${portVar}'; `] : []),
            ...(dir ? [`$env:ECOSYS_DATA_DIR = ${psq(dir)}; `] : []),
            'node server.mjs',
          )
        : parts(...(f ? ['cd ', q(f), ' && '] : []), 'ECOSYS_ALLOWED_HOSTS=', hostPart, ...(portVar ? [` PORT=${portVar}`] : []), ...(dir ? [` ECOSYS_DATA_DIR=${q(dir)}`] : []), ' node server.mjs');
    const raw = S.tunnelRaw.trim();
    const feedback = raw && !base ? `<p class="ai-err">${icon('alert', { size: 15 })}<span>That doesn’t look like a tunnel address. It starts with https:// and ends in something like .trycloudflare.com.</span></p>` : base ? `<p class="ai-ok">${icon('check-circle', { size: 15 })}<span>Using ${esc(host)}</span></p>` : '';
    return {
      base,
      steps: [
        {
          title: 'Start a tunnel',
          body: `<p class="ai-p">${esc(name)} runs in the cloud and can’t see this computer, so give ecosys a temporary public address. In a new terminal:</p>
            ${install ? codeHtml(parts(install), { fk: 'cf-install', label: 'Copy install command' }) : `<p class="ai-p">Install <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" data-fk="link-cloudflared" target="_blank" rel="noopener noreferrer">cloudflared</a>, then run:</p>`}
            ${codeHtml(parts(`cloudflared tunnel --url ${origin()}`), { fk: 'cf-run', label: 'Copy tunnel command' })}
            <p class="ai-fine">Keep that window open. It prints an address like https://some-words.trycloudflare.com.</p>`,
        },
        {
          title: 'Paste the address it prints',
          done: !!base,
          body: `<input type="text" class="input ai-tunnel" data-act="tunnel" data-fk="tunnel" value="${esc(S.tunnelRaw)}" placeholder="https://some-words.trycloudflare.com" aria-label="Tunnel address" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url">${feedback}`,
        },
        {
          title: 'Let ecosys accept that address',
          body: `<p class="ai-p">ecosys only answers addresses it knows. Stop it (press ${keys('ctrl C')} in its window) and start it again with:</p>
            ${codeHtml(restart, { fk: 'allow-hosts', label: 'Copy command' })}
            <p class="ai-fine">Through the tunnel only the AI endpoint answers, and only with this connection’s key. Quick tunnel addresses change when the tunnel restarts; repeat these steps then.</p>`,
        },
      ],
    };
  }

  // One builder per setup surface ---------------------------------------------------------------

  const SETUP = {
    desktop(kind, s) {
      const c = credFor(kind, s);
      const inst = S.install || {};
      const busy = inst.state === 'busy';
      const added = inst.state === 'ok';
      const quit =
        OS === 'mac'
          ? `Choose <strong>Claude</strong>, then <strong>Quit Claude</strong> (${keys('mod Q')}), and open it again.`
          : OS === 'win'
            ? 'Right-click the Claude icon by the clock and choose <strong>Quit</strong>, then open Claude again. Closing the window isn’t enough.'
            : 'Quit Claude Desktop from its menu, then open it again. Closing the window isn’t enough.';
      const configAt =
        OS === 'win' ? '%APPDATA%\\Claude\\claude_desktop_config.json' : OS === 'mac' ? '~/Library/Application Support/Claude/claude_desktop_config.json' : '~/.config/Claude/claude_desktop_config.json';
      const json = c ? parts(JSON.stringify({ mcpServers: { ecosys: stdioEntry(c) } }, null, 2)) : null;
      const result = added
        ? `<p class="ai-ok">${icon('check-circle', { size: 16 })}<span>Added to <code class="ai-path">${esc(inst.path || 'Claude Desktop’s settings')}</code>${inst.backups ? '. The old file was backed up next to it.' : '.'}</span></p>`
        : inst.state === 'error'
          ? `<p class="ai-err">${icon('alert', { size: 16 })}<span>${esc(inst.error)}${inst.notFound ? ' <a href="https://claude.ai/download" data-fk="link-claude" target="_blank" rel="noopener noreferrer">Get Claude Desktop</a>' : ''}</span></p>`
          : '';
      return `${steps([
        {
          title: 'Add ecosys to Claude Desktop',
          done: added || !!c?.connected,
          body: `<p class="ai-p">One click adds ecosys to Claude Desktop’s settings. Everything else in that file is kept, and a backup copy is saved first.</p>
            <div class="ai-actions"><button type="button" class="btn ${c ? 'btn-secondary' : 'btn-primary'} btn-sm" data-act="install" data-fk="install"${busy ? ' aria-disabled="true"' : ''}>${busy ? '<span class="ai-spin sm"></span>' : icon('plug', { size: 16 })}${c ? 'Add to Claude Desktop again' : 'Add to Claude Desktop'}</button></div>${result}`,
        },
        { title: 'Restart Claude Desktop', done: !!c?.connected, body: `<p class="ai-p">${quit}</p>` },
        {
          title: 'Ask Claude about your day',
          done: !!c?.connected,
          body: `<p class="ai-p">Try “What’s on my calendar today?”. This window lights up the moment Claude connects. Claude starts ecosys itself, so it works even when this window is closed.</p>${added || c ? waitingHtml(c, 'Claude Desktop') : ''}`,
        },
      ])}
      ${disclosure(
        'manual-desktop',
        'Set it up by hand',
        c
          ? `<p class="ai-p" tabindex="-1" data-fk="create-${esc(s.id)}">In Claude Desktop open ${crumbs('Settings', 'Developer', 'Edit Config')} and add the <strong>ecosys</strong> entry under <code class="ai-ic">mcpServers</code>, keeping anything already there:</p>${codeHtml(json, { fk: 'desktop-json', label: 'Copy settings', block: true })}<p class="ai-fine">The file is ${esc(configAt)}. Quit and reopen Claude Desktop afterwards.</p>`
          : `<p class="ai-p">The entry needs a connection id. Create the Claude Desktop connection first:</p>${createHtml(kind, s, 'Claude Desktop')}`,
      )}`;
    },

    code(kind, s) {
      const c = credFor(kind, s);
      const stdio = c ? parts('claude mcp add --transport stdio --scope user ecosys -- ', nodeCmd(), ' ', bridge(), ' --client ', c.id, ...bridgeTail()) : null;
      const http = c ? parts('claude mcp add --transport http --scope user ecosys ', S.data.localUrl, ' --header "Authorization: Bearer ', { secret: c.token, cid: c.id }, '"') : null;
      return `${steps([
        connStep(kind, s, c, 'Claude Code'),
        {
          title: 'Add ecosys to Claude Code',
          done: !!c?.connected,
          body: c
            ? `<p class="ai-p">Run this in a terminal:</p>${codeHtml(stdio, { fk: 'code-stdio', label: 'Copy command' })}<p class="ai-fine">It works even when this window is closed. ${ic('--scope user')} makes ecosys available in every project; leave it out for just the current one.</p>`
            : '<p class="ai-p muted">Create the key first; the command appears here.</p>',
        },
        {
          title: 'Check it',
          done: !!c?.connected,
          body: `<p class="ai-p">Start ${ic('claude')} and type ${ic('/mcp')}. ecosys should show as connected.</p>${waitingHtml(c, 'Claude Code')}`,
        },
      ])}
      ${c ? disclosure('http-code', 'Connect over HTTP instead', `<p class="ai-p">Talks to this running copy of ecosys, so keep it running:</p>${codeHtml(http, { fk: 'code-http', label: 'Copy command' })}`) : ''}`;
    },

    web(kind, s) {
      const c = credFor(kind, s);
      const t = tunnelSteps('Claude');
      return steps([
        connStep(kind, s, c, 'Claude.ai'),
        ...t.steps,
        {
          title: 'Add a custom connector in Claude',
          done: !!c?.connected,
          body: c
            ? `<p class="ai-p">In Claude open ${crumbs('Settings', 'Connectors', 'Add custom connector')}, name it <strong>ecosys</strong> and use this URL:</p>${codeHtml(secretUrl(c, t.base), { fk: 'web-url', label: 'Copy URL' })}<p class="ai-fine">Leave authentication on <strong>No sign-in</strong>: the link itself is the key. Free plans allow one custom connector. Works in Claude on the web, the desktop app and the phone apps.</p>${waitingHtml(c, 'Claude')}`
            : '<p class="ai-p muted">Create the key first; the URL appears here.</p>',
        },
      ]);
    },

    chatgpt(kind, s) {
      const c = credFor(kind, s);
      const t = tunnelSteps('ChatGPT');
      return `${steps([
        connStep(kind, s, c, 'ChatGPT'),
        ...t.steps,
        {
          title: 'Add ecosys to ChatGPT',
          done: !!c?.connected,
          body: c
            ? `<p class="ai-p">On chatgpt.com open ${crumbs('Plugins', { icon: 'plus', label: 'New' }, 'Add custom MCP server')}</p>
              <p class="ai-fine">Older layouts: ${crumbs('Settings', 'Apps', 'Advanced settings', 'Developer mode', 'Create')}</p>
              <dl class="ai-fields"><dt>Name</dt><dd>ecosys</dd><dt>Server URL</dt><dd>${codeHtml(secretUrl(c, t.base), { fk: 'chatgpt-url', label: 'Copy URL' })}</dd><dt>Authentication</dt><dd>No authentication. ChatGPT can’t send a key, so the secret link is the key.</dd></dl>
              <p class="ai-fine">Accept the warning, create it, then pick ecosys in a chat (type @ or open the tools menu).</p>${waitingHtml(c, 'ChatGPT')}`
            : '<p class="ai-p muted">Create the key first; the URL appears here.</p>',
        },
      ])}
      <div class="ai-callout">${icon('info', { size: 18 })}<div><strong>Which plans?</strong> Custom MCP servers need developer mode on chatgpt.com (not the phone apps). OpenAI lists full access, including changes, for Business, Enterprise and Edu; other plans may only be able to read, or may not offer it. ChatGPT asks you before each change.</div></div>`;
    },

    app(kind, s) {
      const c = credFor(kind, s);
      const t = tunnelSteps('Grok');
      return steps([
        connStep(kind, s, c, 'the Grok app'),
        ...t.steps,
        {
          title: 'Add a custom connector on grok.com',
          done: !!c?.connected,
          body: c
            ? `<p class="ai-p">Open ${crumbs('Connectors', 'New connector', 'Custom')}, name it <strong>ecosys</strong> and use this URL:</p>${codeHtml(secretUrl(c, t.base), { fk: 'grok-url', label: 'Copy URL' })}<p class="ai-fine">Grok refuses local addresses, so the tunnel is required. Custom connectors may need a paid Grok plan.</p>${waitingHtml(c, 'Grok')}`
            : '<p class="ai-p muted">Create the key first; the URL appears here.</p>',
        },
      ]);
    },

    api(kind, s) {
      const c = credFor(kind, s);
      const t = tunnelSteps('Grok');
      const base = t.base || { ph: 'https://your-tunnel-address' };
      const snippet = c
        ? parts(
            '{\n  "type": "mcp",\n  "server_url": "',
            base,
            '/mcp",\n  "server_label": "ecosys",\n  "server_description": "My tasks, calendar and notes",\n  "authorization": "',
            { secret: c.token, cid: c.id },
            '",\n  "allowed_tools": [\n    "get_overview",\n    "find_tasks",\n    "find_events",\n    "find_free_time"\n  ]\n}',
          )
        : null;
      const writeWarn =
        c && c.access === 'write'
          ? `<div class="ai-actions"><button type="button" class="btn btn-secondary btn-sm" data-act="access" data-cid="${esc(c.id)}" data-val="read" data-fk="api-read">${icon('lock', { size: 15 })}Make this connection read only</button></div>`
          : '';
      return `${steps([
        connStep(kind, s, c, 'the xAI API'),
        ...t.steps,
        {
          title: 'Add ecosys to your API call',
          done: !!c?.connected,
          body: c
            ? `<p class="ai-p">Put this in the ${ic('tools')} list of a request to ${ic('https://api.x.ai/v1/responses')}:</p>${codeHtml(snippet, { fk: 'api-json', label: 'Copy JSON', block: true })}<p class="ai-fine">${ic('allowed_tools')} keeps Grok to reading. Remove it to offer every tool this connection allows.</p>${waitingHtml(c, 'Grok')}`
            : '<p class="ai-p muted">Create the key first; the snippet appears here.</p>',
        },
      ])}
      <div class="ai-callout warn">${icon('shield', { size: 18 })}<div><strong>No approval step.</strong> The xAI API runs tools without asking you first. Keep this connection read only unless you want changes made unattended.${writeWarn}</div></div>`;
    },

    cli(kind, s) {
      const c = credFor(kind, s);
      const stdio = c ? parts('grok mcp add ecosys -- ', nodeCmd(), ' ', bridge(), ' --client ', c.id, ...bridgeTail()) : null;
      const http = c ? parts('grok mcp add --transport http ecosys ', S.data.localUrl, ' --header "Authorization: Bearer ', { secret: c.token, cid: c.id }, '"') : null;
      return `${steps([
        connStep(kind, s, c, 'Grok CLI'),
        {
          title: 'Add ecosys to Grok CLI',
          done: !!c?.connected,
          body: c ? `<p class="ai-p">Run this in a terminal:</p>${codeHtml(stdio, { fk: 'cli-stdio', label: 'Copy command' })}<p class="ai-fine">It works even when this window is closed.</p>` : '<p class="ai-p muted">Create the key first; the command appears here.</p>',
        },
        { title: 'Check it', done: !!c?.connected, body: `<p class="ai-p">Run ${ic('grok mcp list')}. ecosys should be listed.</p>${waitingHtml(c, 'Grok CLI')}` },
      ])}
      ${c ? disclosure('http-cli', 'Connect over HTTP instead', `<p class="ai-p">Talks to this running copy of ecosys, so keep it running:</p>${codeHtml(http, { fk: 'cli-http', label: 'Copy command' })}`) : ''}`;
    },

    other(kind, s) {
      const c = credFor(kind, s);
      if (!c) return steps([connStep(kind, s, null, 'your app'), { title: 'Add ecosys to your app', body: '<p class="ai-p muted">Create the key first; the URL, header and command appear here.</p>' }]);
      const json = parts(JSON.stringify({ mcpServers: { ecosys: stdioEntry(c) } }, null, 2));
      return `${otherPicker(c)}${steps([
        connStep(kind, s, c, 'your app'),
        {
          title: 'Add ecosys to your app',
          done: !!c.connected,
          body: `<div class="ai-opt"><div class="ai-opt-t">Streamable HTTP</div>
              <dl class="ai-fields"><dt>URL</dt><dd>${codeHtml(parts(S.data.localUrl), { fk: 'other-url', label: 'Copy URL' })}</dd><dt>Header</dt><dd>${codeHtml(parts('Authorization: Bearer ', { secret: c.token, cid: c.id }), { fk: 'other-header', label: 'Copy header' })}</dd></dl></div>
            <div class="ai-opt"><div class="ai-opt-t">URL only</div><p class="ai-p">For apps that can’t send a header:</p>${codeHtml(parts(origin(), '/s/', { secret: c.token, cid: c.id }, '/mcp'), { fk: 'other-secret', label: 'Copy URL' })}</div>
            <div class="ai-opt"><div class="ai-opt-t">Local command (stdio)</div><p class="ai-p">For apps that start the server themselves. Works even when this window is closed:</p>${codeHtml(json, { fk: 'other-json', label: 'Copy settings', block: true })}</div>
            ${waitingHtml(c, c.label)}`,
        },
      ])}
      <p class="ai-fine pad">ecosys speaks the current MCP revision (2026-07-28) and older ones back to 2024-11-05, and answers with plain JSON, never a stream.</p>`;
    },
  };

  // ---------------------------------------------------------------- without the local server

  function unavailableHtml(why) {
    const repo = (() => {
      const h = location.hostname;
      if (!h.endsWith('.github.io')) return '';
      const user = h.slice(0, -'.github.io'.length);
      const seg = location.pathname.split('/').filter(Boolean)[0];
      return /^[a-z0-9-]+$/i.test(user) ? `https://github.com/${user}/${seg && /^[\w.-]+$/.test(seg) ? seg : h}` : '';
    })();
    // The heading can hold focus (tabindex -1): it takes over when the sheet switches to this page.
    const hero = (title, sub, glyph = 'cloud-off') =>
      `<section class="ai-hero tone-off"><span class="ai-hero-glyph">${icon(glyph, { size: 26 })}</span><h3 class="ai-hero-title" tabindex="-1" data-fk="hero-title">${esc(title)}</h3><p class="ai-hero-sub">${esc(sub)}</p></section>`;
    if (why === 'unpaired') {
      // ecosys runs, but doesn't know this browser yet (lead decision 1, shared/pair.js): the same words as the
      // pairing notice, then where that link is. Once it is opened, sync comes back online and this page loads.
      return `${hero('Connect this browser to ecosys', UNPAIRED_MSG, 'link')}
        <div class="group-title">How to connect it</div>
        <div class="group ai-setup">${steps([
          { title: 'Go to the window where ecosys runs', body: '<p class="ai-p">The one where you started it: a terminal with <strong>npm start</strong>, or the start.cmd window.</p>' },
          {
            title: 'Open the link it shows, in this browser',
            body: `<p class="ai-p">It starts with ${ic(`${location.origin}/#pair=`)} and works like a password, so keep it to yourself. Tabs that are already open connect by themselves, this one too.</p>`,
          },
        ])}
        <p class="ai-fine pad">No window to be found? Restart ecosys with <strong>npm start</strong> or start.cmd: it opens the link for you.</p></div>`;
    }
    if (why === 'lan') {
      return `${hero('Connect AI on the computer running ecosys', 'For your safety, AI connections and keys are only managed on the computer where ecosys runs.', 'lock')}
        <div class="group-title">What to do</div>
        <div class="group ai-setup">${steps([
          { title: 'Go to that computer', body: '<p class="ai-p">The one where you started ecosys.</p>' },
          { title: 'Open ecosys there', body: `${codeHtml(parts('http://127.0.0.1:4300/'), { fk: 'lan-url', label: 'Copy address' })}<p class="ai-fine">Use the port ecosys printed if you changed it.</p>` },
          { title: 'Choose Connect AI', body: '<p class="ai-p">From the app menu, then pick your assistant.</p>' },
        ])}</div>`;
    }
    if (why === 'static') {
      return `${hero('Run ecosys on your computer to connect an AI', 'Claude, ChatGPT and Grok connect to the ecosys app on your own computer, where your data is kept. This web copy has no app behind it, so there is nothing for them to connect to.')}
        <div class="group-title">Four steps</div>
        <div class="group ai-setup">${steps([
          { title: 'Install Node.js 22 or newer', body: '<p class="ai-p">From <a href="https://nodejs.org" data-fk="link-node" target="_blank" rel="noopener noreferrer">nodejs.org</a>. ecosys needs nothing else.</p>' },
          {
            title: 'Get ecosys',
            body: repo
              ? `<p class="ai-p">Download it from <a href="${esc(repo)}" data-fk="link-repo" target="_blank" rel="noopener noreferrer">GitHub</a> (Code, Download ZIP) or clone it:</p>${codeHtml(parts(`git clone ${repo}.git`), { fk: 'clone', label: 'Copy command' })}`
              : '<p class="ai-p">Copy the ecosys folder (the same files as this site) to your computer.</p>',
          },
          { title: 'Start it', body: `<p class="ai-p">In the ecosys folder run:</p>${codeHtml(parts('npm start'), { fk: 'start', label: 'Copy command' })}<p class="ai-fine">On Windows you can also double-click start.cmd.</p>` },
          { title: 'Open Connect AI there', body: '<p class="ai-p">ecosys opens at http://127.0.0.1:4300. Choose <strong>Connect AI</strong> from the app menu and pick your assistant.</p>' },
        ])}</div>
        <div class="ai-callout">${icon('info', { size: 18 })}<div>Your tasks and events here live in this browser. To take them along, export a backup here and import it in the local copy (Settings, Import backup).<div class="ai-actions"><button type="button" class="btn btn-secondary btn-sm" data-act="backup" data-fk="backup">${icon('download', { size: 16 })}Export backup</button></div></div></div>`;
    }
    const plain = why === 'no-server';
    return `${hero(plain ? 'This copy of ecosys has no app server' : 'Can’t reach ecosys', plain ? 'It is served as plain files, so there is nothing for an assistant to connect to. Start ecosys itself instead.' : 'This page is open, but the ecosys app that assistants connect to isn’t answering.')}
      <div class="group-title">What to do</div>
      <div class="group ai-setup">${steps([
        { title: 'Start ecosys', body: `<p class="ai-p">In the ecosys folder run:</p>${codeHtml(parts('npm start'), { fk: 'start', label: 'Copy command' })}<p class="ai-fine">On Windows you can also double-click start.cmd.</p>` },
        // Plain files can't become ecosys: it runs at its own address, so send people there. When
        // ecosys itself stopped answering, it comes back here, so this page can simply try again.
        plain
          ? {
              title: 'Open ecosys there',
              body: `${codeHtml(parts('http://127.0.0.1:4300/'), { fk: 'open-url', label: 'Copy address' })}<p class="ai-fine">Use the address ecosys prints if you changed its port. Then choose <strong>Connect AI</strong> from the app menu.</p>`,
            }
          : {
              title: 'Try again',
              body: `<div class="ai-actions"><button type="button" class="btn btn-primary btn-sm" data-act="retry" data-fk="retry"${S.busy.has('retry') ? ' aria-disabled="true"' : ''}>${S.busy.has('retry') ? '<span class="ai-spin sm"></span>' : icon('refresh', { size: 16 })}Try again</button></div>`,
            },
      ])}</div>`;
  }

  // ---------------------------------------------------------------- actions

  function go(page) {
    if (page !== 'home' && !Object.hasOwn(ASSISTANTS, page)) return;
    const from = S.page;
    if (from === page) return;
    S.enter = page === 'home' ? 'back' : 'fwd';
    S.page = page;
    body.scrollTop = 0;
    el.classList.remove('scrolled');
    // Forward: the page title (a screen reader hears where it is). Back: the row you came from.
    focusNext(page === 'home' ? `row-${from}` : 'title');
    render();
  }

  /** "Try again" without the server: the button stays (busy) so focus stays; once in, focus the title. */
  async function retry() {
    await busyDo('retry', () => load({ probe: true, quiet: true }));
    if (S.state === 'ready') {
      focusNext('title');
      render();
    } else if (panel && S.why !== 'unpaired') toast('ecosys still isn’t answering. Start it, then try again.', { duration: 3200 });
  }

  /** An action failed: say why, unless the sheet itself now explains it (this browser isn't connected: unpaired()). */
  const failed = (err, fallback) => {
    if (!err?.pairing) toast(err?.message || fallback);
  };

  async function busyDo(key, fn) {
    if (S.busy.has(key)) return;
    S.busy.add(key);
    render();
    try {
      return await fn();
    } finally {
      S.busy.delete(key);
      render();
    }
  }

  async function setMode(mode) {
    if (!S.data || S.data.mode === mode || !MODES.some((m) => m.id === mode)) return;
    const prev = S.data.mode;
    S.data.mode = mode;
    render();
    try {
      await call('ai/mode', { method: 'POST', body: { mode } });
      status.mode = mode;
      emitStatus();
      // Apps that started ecosys themselves hear of it; web connectors keep the tools they loaded (HTTP can't tell
      // them), so with one set up, say so. Turning access off needs no refresh: everything is refused.
      if (mode !== 'off' && clients().some(isCloud)) {
        toast(`${mode === 'read' ? 'Assistants can now only read' : 'Assistants can now read and make changes'}. Web connectors (claude.ai, ChatGPT, Grok) may need a refresh to see it.`, { duration: 4200 });
      }
    } catch (err) {
      if (S.data) S.data.mode = prev;
      render();
      failed(err, 'Couldn’t change AI access.');
    }
  }

  async function createFor(kind, surfaceId) {
    const s = SURFACES[kind]?.find((x) => x.id === surfaceId);
    if (!s) return;
    if (kind === 'other') return addApp({ first: true });
    await busyDo(`create-${s.id}`, async () => {
      try {
        const out = await call('ai/clients', { method: 'POST', body: { kind, access: s.access || 'write', label: s.label } });
        const c = cleanClient(out?.client, { secrets: true });
        if (c && S.data && !client(c.id)) S.data.clients.push(c);
        toast(`Created a key for ${c?.label || s.label}`);
        reload();
      } catch (err) {
        failed(err, 'Couldn’t create the connection.');
      }
    });
  }

  /** A small sheet asking for an app's name → the name ('' for none), or null when cancelled. */
  function askName({ title, message, value = '', confirm }) {
    return new Promise((resolve) => {
      let result = null;
      openModal({
        className: 'choice ai-name',
        label: title,
        body: `<form class="modal-body" novalidate>
          <h2 class="choice-title">${esc(title)}</h2>
          <p class="choice-msg">${esc(message)}</p>
          <input type="text" class="input ai-name-input" name="app" value="${esc(value)}" maxlength="60" placeholder="App name" aria-label="App name" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done">
          <div class="choice-actions">
            <button type="submit" class="btn btn-primary btn-block">${esc(confirm)}</button>
            <button type="button" class="btn btn-ghost btn-block" data-close>Cancel</button>
          </div>
        </form>`,
        onMount: (m, close) => {
          const form = m.querySelector('form');
          const input = form.elements.app;
          input.focus({ preventScroll: true });
          input.select();
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            result = clean(input.value, 60);
            close();
          });
        },
        onClose: () => resolve(result),
      });
    });
  }

  /** Other MCP apps: a new connection (its own key) for one more app, named by you. */
  async function addApp({ first = false } = {}) {
    const name = await askName({
      title: first ? 'Name the app' : 'Add another app',
      message: 'The app that will use this key, like Cursor, VS Code or Codex. Activity shows this name next to everything it does.',
      confirm: 'Create key',
    });
    if (name === null || !panel) return;
    await busyDo(first ? 'create-other' : 'add-other', async () => {
      try {
        const out = await call('ai/clients', { method: 'POST', body: { kind: 'other', access: 'write', ...(name ? { label: name } : {}) } });
        const c = cleanClient(out?.client, { secrets: true });
        if (c && S.data && !client(c.id)) S.data.clients.push(c);
        if (c) {
          S.tabs.other = c.id; // the setup below is now for this app
          focusNext('create-other'); // its "Connection key" step
        }
        toast(`Created a key for ${c?.label || name || 'your app'}`);
        reload();
      } catch (err) {
        failed(err, 'Couldn’t create the connection.');
      }
    });
  }

  async function rename(c) {
    const name = await askName({ title: 'Rename connection', message: 'Activity shows this name next to everything the app does.', value: c.label, confirm: 'Rename' });
    if (!name || name === c.label || !panel) return;
    try {
      const out = await call(`ai/clients/${encodeURIComponent(c.id)}`, { method: 'POST', body: { label: name } });
      const fresh = cleanClient(out?.client, { secrets: true });
      if (fresh && S.data) S.data.clients = S.data.clients.map((x) => (x.id === fresh.id ? fresh : x));
      toast(`Renamed to ${fresh?.label || name}`, { duration: 2400 });
      render();
      reload();
    } catch (err) {
      failed(err, 'Couldn’t rename the connection.');
    }
  }

  /** "Setup for: <app>": which Other MCP app's connection the setup steps show. */
  function pickApp(btn) {
    const cur = credFor('other', SURFACES.other[0]);
    btn.setAttribute('aria-expanded', 'true');
    openMenu(
      btn,
      ofKind('other').map((c) => ({
        label: c.label,
        checked: c.id === cur?.id,
        onSelect: () => {
          S.tabs.other = c.id;
          render();
        },
      })),
      { label: 'Setup for', minWidth: btn.offsetWidth, onClose: () => btn.isConnected && btn.setAttribute('aria-expanded', 'false') },
    );
  }

  async function setAccess(id, access) {
    const c = client(id);
    if (!c || c.access === access) return;
    await busyDo(`access-${id}`, async () => {
      const prev = c.access;
      c.access = access;
      try {
        await call(`ai/clients/${encodeURIComponent(id)}`, { method: 'POST', body: { access } });
        // Web connectors keep the tool list they loaded (HTTP can't push it); apps on stdio hear of it themselves.
        toast(`${access === 'read' ? `${c.label} can now only read` : `${c.label} can now read and make changes`}. Web connectors (claude.ai, ChatGPT, Grok) may need a refresh to see it.`, { duration: 4200 });
      } catch (err) {
        c.access = prev;
        failed(err, 'Couldn’t change access.');
      }
    });
  }

  async function rotate(c) {
    const ok = await confirmDialog({
      title: `New key for ${c.label}?`,
      message: 'The old key and secret link stop working right away. Apps set up with the one-click install or a command that uses the connection id keep working.',
      confirm: 'Make a new key',
      danger: true,
    });
    if (!ok || !panel) return;
    try {
      const out = await call(`ai/clients/${encodeURIComponent(c.id)}`, { method: 'POST', body: { rotate: true } });
      const fresh = cleanClient(out?.client, { secrets: true });
      if (fresh && S.data) S.data.clients = S.data.clients.map((x) => (x.id === fresh.id ? fresh : x));
      toast('New key ready. Update any app that used the old one.', { duration: 5000 });
      render();
      reload();
    } catch (err) {
      failed(err, 'Couldn’t make a new key.');
    }
  }

  async function remove(c) {
    const ok = await confirmDialog({
      title: `Remove ${c.label}?`,
      message: `It can no longer reach ecosys. What it changed stays listed in Activity.${c.label.startsWith('Claude Desktop') ? ' Claude Desktop will show ecosys as failed until you remove it there too.' : ''}`,
      confirm: 'Remove',
      danger: true,
    });
    if (!ok || !panel) return;
    try {
      await call(`ai/clients/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (S.data) S.data.clients = S.data.clients.filter((x) => x.id !== c.id);
      S.reveal.delete(c.id);
      toast(`Removed ${c.label}`);
      render();
      reload();
    } catch (err) {
      failed(err, 'Couldn’t remove the connection.');
    }
  }

  /** A connection used from the cloud (ChatGPT, claude.ai, the Grok app, the xAI API). */
  const isCloud = (c) => c.kind === 'chatgpt' || (SURFACES[c.kind] || []).some((s) => s.cloud && c.label.toLowerCase().startsWith(s.label.toLowerCase()));
  /** The public address in front of ecosys: the server's tunnel host, else the one pasted here. */
  const publicBase = () => (S.data.publicUrls[0] || '').replace(/\/mcp$/, '') || S.tunnel;

  function connMenu(btn) {
    const c = client(btn.dataset.cid);
    if (!c) return;
    // A cloud assistant can't reach this computer's own address: its link goes through the tunnel,
    // like the one in its setup steps. Without a tunnel yet, the menu says the link is local only.
    const cloud = isCloud(c);
    const base = cloud ? publicBase() : '';
    btn.setAttribute('aria-expanded', 'true');
    openMenu(
      btn,
      [
        { label: cloud && !base ? 'Copy secret link (this computer only)' : 'Copy secret link', icon: 'link', onSelect: () => copyAndTell(`${base || origin()}/s/${c.token}/mcp`, true) },
        { label: 'Copy connection id', icon: 'copy', onSelect: () => copyAndTell(c.id, false) },
        c.kind === 'other' ? { label: 'Rename…', icon: 'edit', onSelect: () => rename(c) } : null,
        { sep: true },
        { label: 'Make a new key…', icon: 'refresh', onSelect: () => rotate(c) },
        { label: 'Remove connection…', icon: 'trash', danger: true, onSelect: () => remove(c) },
      ],
      { label: `${c.label} options`, align: 'end', onClose: () => btn.isConnected && btn.setAttribute('aria-expanded', 'false') },
    );
  }

  async function install() {
    if (S.install?.state === 'busy') return;
    const s = SURFACES.claude[0];
    const c = credFor('claude', s);
    S.install = { state: 'busy' };
    render();
    try {
      const out = await call('ai/install/claude-desktop', { method: 'POST', body: c ? { clientId: c.id } : {} });
      S.install = { state: 'ok', path: clean(out?.path, 600), backups: Array.isArray(out?.backups) ? out.backups.length : 0 };
      const fresh = cleanClient(out?.client, { secrets: true });
      if (fresh && S.data && !client(fresh.id)) S.data.clients.push(fresh);
      toast('Added to Claude Desktop. Restart it to connect.', { duration: 5000 });
    } catch (err) {
      // A browser ecosys doesn't know gets the sheet's explanation instead (unpaired()), not an error here.
      S.install = err.pairing ? null : { state: 'error', error: err.message || 'Couldn’t add ecosys to Claude Desktop.', notFound: err.status === 404 && /installed/i.test(err.message || '') };
    }
    render();
    reload();
  }

  async function undoFromFeed(changeId) {
    if (!CHANGE_RE.test(changeId || '')) return;
    await busyDo(`undo-${changeId}`, async () => {
      try {
        await undoChange(changeId);
        toast('Undone', { duration: 2200 });
      } catch (err) {
        if (/already undone/i.test(err.message || '')) undone.add(changeId);
        if (!err.pairing) toast(undoMessage(err), { duration: 6000 });
      }
    });
  }

  async function copyAndTell(value, secret) {
    const ok = await copyText(value);
    toast(ok ? (secret ? 'Copied. Keep it private: it works like a password.' : 'Copied') : 'Couldn’t copy. Select the text and copy it instead.', { duration: secret ? 3600 : 2000 });
    return ok;
  }

  async function copyFrom(btn) {
    const item = S.copies.get(btn.dataset.copy);
    if (!item?.text) return;
    if (await copyAndTell(item.text, item.secret)) {
      btn.classList.add('copied');
      btn.innerHTML = icon('check', { size: 17, stroke: 2.4 });
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.classList.remove('copied');
        btn.innerHTML = icon('copy', { size: 17 });
      }, 1600);
    }
  }

  function preview() {
    const cs = clients();
    const c = cs.filter((x) => x.connected).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0))[0] || cs[0] || { kind: 'claude', label: 'Claude' };
    playConnectAnimation(stripSecrets(c), { clientName: c.lastClientName, mode: S.data?.mode });
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    // Busy and unavailable controls are aria-disabled (they keep focus), so they are skipped here.
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true' || !el.contains(b) || b.matches('input')) return;
    const act = b.dataset.act;
    if (act === 'open') go(b.dataset.kind);
    else if (act === 'back') go('home');
    else if (act === 'mode') setMode(b.dataset.val);
    else if (act === 'filter') {
      S.filter = b.dataset.val === 'changes' ? 'changes' : 'all';
      render();
    } else if (act === 'more') {
      S.showAll = true;
      render();
    } else if (act === 'undo') undoFromFeed(b.dataset.change);
    else if (act === 'preview') preview();
    else if (act === 'tab') {
      if (SURFACES[b.dataset.kind]?.some((s) => s.id === b.dataset.val)) S.tabs[b.dataset.kind] = b.dataset.val;
      render();
    } else if (act === 'reveal') {
      const id = b.dataset.cid;
      if (S.reveal.has(id)) S.reveal.delete(id);
      else S.reveal.add(id);
      render();
    } else if (act === 'copy') copyFrom(b);
    else if (act === 'create') createFor(b.dataset.kind, b.dataset.surface);
    else if (act === 'access') setAccess(b.dataset.cid, b.dataset.val === 'read' ? 'read' : 'write');
    else if (act === 'conn-menu') connMenu(b);
    else if (act === 'add-other') addApp();
    else if (act === 'pick-other') pickApp(b);
    else if (act === 'install') install();
    else if (act === 'toggle') {
      const id = b.dataset.val;
      if (S.open.has(id)) S.open.delete(id);
      else S.open.add(id);
      render();
    } else if (act === 'retry') retry();
    else if (act === 'backup') downloadBackup();
  });

  el.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.matches?.('[data-act="tunnel"]')) return;
    S.tunnelRaw = t.value;
    const v = normalizeTunnel(t.value);
    if (v !== S.tunnel) {
      S.tunnel = v;
      saveTunnel(v);
    }
    scheduleRender(220);
  });

  // Setup tabs: arrow keys move between them (WAI-ARIA tabs).
  el.addEventListener('keydown', (e) => {
    const tab = e.target.closest?.('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(tab);
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    S.tabs[next.dataset.kind] = next.dataset.val;
    render();
    body.querySelector(`[data-fk="${CSS.escape(next.dataset.fk)}"]`)?.focus();
  });

  // ---------------------------------------------------------------- live updates

  const api = {
    go,
    // The server came back (or went away): show it, and load what was missing. Once ecosys has stopped
    // answering (sync gave up, or stayed offline past the grace period), the sheet says so instead of
    // showing the last status it heard as live; it loads again by itself when ecosys is back.
    syncChanged() {
      const sync = window.ecosysSync?.status;
      // Focus in the body moves with the page that replaces it (as on any page change), never to Close.
      const inBody = body.contains(document.activeElement);
      if (S.state === 'unavailable' && sync === 'online') {
        // Refused by ecosys, and no secret stored since: the page stays put (onPairing() loads it once there is one).
        if (S.why === 'unpaired' && pairingState() !== 'paired') return render();
        if (inBody) focusNext('title');
        return load();
      }
      if (sync === 'unpaired') return api.unpaired();
      if (S.state === 'ready' && status.online === false && (sync === 'offline' || sync === 'error')) {
        S.data = null;
        S.copies.clear();
        S.state = 'unavailable';
        S.why = status.reason === 'refused' ? 'refused' : 'unreachable';
        if (inBody) focusNext('hero-title');
      }
      render();
    },
    // ecosys refused this browser (sync heard it, or one of this sheet's requests did): the sheet explains how
    // to connect it, and loads by itself once it is (sync comes back online).
    unpaired() {
      if (S.state === 'unavailable' && S.why === 'unpaired') return;
      const inBody = body.contains(document.activeElement);
      S.data = null;
      S.copies.clear();
      S.reveal.clear();
      S.state = 'unavailable';
      S.why = 'unpaired';
      if (inBody) focusNext('hero-title');
      render();
    },
    // Connected again while sync stayed online (onPairing): load, as when ecosys comes back.
    paired() {
      if (S.state !== 'unavailable' || S.why !== 'unpaired') return;
      if (body.contains(document.activeElement)) focusNext('title');
      load();
    },
    visible: () => S.state === 'ready' && reload(),
    onStatus(d) {
      if (!S.data || !Array.isArray(d.clients)) return;
      if (MODES.some((m) => m.id === d.mode)) S.data.mode = d.mode;
      const incoming = new Map(d.clients.map((c) => cleanClient(c)).filter(Boolean).map((c) => [c.id, c]));
      // Added or removed in another tab or by the installer: fetch again (new ones need their keys).
      if (incoming.size !== S.data.clients.length || S.data.clients.some((c) => !incoming.has(c.id))) reload();
      S.data.clients = S.data.clients.filter((c) => incoming.has(c.id));
      for (const c of S.data.clients) {
        const x = incoming.get(c.id);
        Object.assign(c, { connected: x.connected, lastSeen: x.lastSeen, access: x.access, label: x.label });
      }
      scheduleRender(60);
    },
    onActivity(entry) {
      if (!S.data) return;
      if (!S.data.activity.some((a) => a.id === entry.id)) S.data.activity = [entry, ...S.data.activity].slice(0, 100);
      const c = client(entry.clientId);
      if (c) Object.assign(c, { connected: true, lastSeen: Math.max(c.lastSeen || 0, entry.at) });
      scheduleRender(60);
    },
    onConnected(c) {
      if (!S.data) return;
      const x = client(c.id);
      if (x) Object.assign(x, { connected: true, lastSeen: Date.now() });
      scheduleRender(60);
      reload();
    },
  };

  load();
  return api;
}
