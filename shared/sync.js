// ecosys sync — keeps the browser's store in step with the local ecosys server (server.mjs), so
// every browser, tab and AI assistant (over MCP) sees the same tasks, events and notes.
//
//   startSync()   called once by initShell(). Safe everywhere: on static hosting (GitHub Pages) or
//                 when the server isn't running it does nothing and the apps stay local-only.
//                 Resolves after the first attempt; if ecosys is busy or restarting it keeps trying.
//   syncState     { online, status, rev, lastError, pending, leader, clientId, version, ai, synced } —
//                 live object, also at window.ecosysSync. status: 'off' | 'connecting' | 'online' |
//                 'offline' | 'unpaired' | 'error'. ai: the server's last AI status { mode, clients }
//                 (or null), in every tab, also the ones that don't hold the event stream. synced: this
//                 browser has synced with an ecosys data folder, so a change made while it is not
//                 connected (an Erase everything too) reaches that folder once it is; a browser that
//                 never has keeps such a replace to itself and brings only what the folder lacks.
//   window events 'ecosys:sync' (detail: syncState copy) whenever the status or lastError changes,
//                 'ecosys:ai'   (detail: AI event from the server: connected / activity / status).
//
// Protocol (see build spec §2): GET api/hello → GET api/state → first run of a data folder: POST
// api/import with the local data, else take the server's data. Every request sends the pairing
// header (shared/pair.js); a browser the server doesn't know ('unpaired') keeps working from its own
// copy and keeps its changes for when it is connected. Local writes become ops pushed with POST
// api/ops (debounced, retried with backoff, kept in localStorage until the server has them, so a
// closed tab's unsent changes are sent by the next page). Remote changes arrive on a server-sent event
// stream (api/events); one tab per browser holds it and the others get the changes through
// localStorage (or, for what localStorage can't hold, from that tab: store.js), so many open tabs
// never exhaust the browser's connection limit.
//
// Changes are never lost to a concurrent one:
//   - A put says what it started from: base (the server copy's updatedAt), fields (the keys this
//     browser changed) and was (each changed key's hash in that copy). The server applies it whole
//     when its copy is still that version and merges only those fields otherwise (server/store.mjs);
//     it answers with the merged copy, which this tab then takes. Edits not sent yet are merged the
//     same way into each change that arrives (rebase), never re-applied as whole records over it.
//   - Each data folder has an id. A browser that meets another folder (or an empty one) brings what
//     it has there (import, or the first-sync merge) instead of replacing its copy with the folder's.
//     An Erase everything, Start over or Import backup made before this browser ever synced with a
//     folder (a new profile not connected yet) stays this browser's: it never replaces the folder's data.
//   - A folder put back to an older copy while ecosys runs (its rev goes down) is reloaded, and what
//     this browser has that it lost goes back to it (the first-sync merge again).
//   - After a gap in the event stream (or a stream that opened late) the state is reloaded unless the
//     server's hello shows nothing went by unstreamed (heardRev: every change up to it is here).
//   - Waiting changes that can't be saved in this browser (localStorage full) keep the page from being
//     left without asking, and while ecosys is not reachable the user is told ('ecosys:save-error').
//
// Size: the server takes request bodies up to 2 MiB of UTF-8. Requests are measured in bytes and
// filled to BATCH_BYTES; an import or replace bigger than that is sent as a replace with the first
// records followed by puts for the rest. Changes the server refuses (too large, invalid) are dropped
// from the outbox and reported in lastError; this tab's copy is never overwritten because of them.

import { COLLECTIONS, setSyncAdapter, applyRemoteOps, replaceAll, snapshot, storageAvailable, seededAt, sampleIds, cacheSaved, db } from './store.js';
import { validateOp, isId } from './sanitize.js';
import { apiHeaders, markRejected, onPairingChange, pairingState } from './pair.js';
import { newBlock, blockText, longDate } from '../notes/core/schema.js';

const BASE = new URL('../', import.meta.url).pathname;
const API = `${BASE}api/`;
const PUSH_DELAY = 120;
const MAX_OPS_PER_REQUEST = 1000; // the server takes up to 2000
const BATCH_BYTES = 1500000; // a request is filled up to this many bytes of JSON (UTF-8)...
const REQUEST_BYTES_MAX = 2000000; // ...and one op alone may use up to this (the server's limit is 2 MiB)
const KEEPALIVE_BYTES = 60000; // browsers refuse keepalive bodies over 64 KiB
const BACKUP_MAX = 256 * 1024;
const ABANDONED_MS = 120000; // without Web Locks: another tab's outbox untouched this long belongs to a closed tab
const STREAM_IDLE_MS = 70000; // the server sends a heartbeat every 25 s
const STREAM_WAIT_MS = 2500; // the first load waits this long for the event stream to open
const ADOPTED_MS = 120000;
const SS_OUTBOX = 'ecosys:sync:outbox';
const LS_OUTBOX = 'ecosys:v1:outbox:';
const LS_META = 'ecosys:v1:sync';
const LS_BACKUP = 'ecosys:v1:backup-before-sync';
const OUTBOX_LOCK = 'ecosys-outbox-'; // held by every page that may have unsent changes: its outbox is not another page's to take

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const clientId = randomId();

export const syncState = { online: false, status: 'off', rev: 0, lastError: null, pending: 0, leader: false, clientId, version: null, ai: null, synced: false };
window.ecosysSync = syncState;

let started = null;
let settle = () => {};
let ready = false; // state loaded: ops may be pushed
let stopped = false;
let listening = false;
let subscribed = false;
let sources = []; // localStorage keys the restored entries were read from (removed once this page can sync)
let claimed = false; // this page took the restored entries over (claimOutbox): their sources may go
let outbox = []; // [{ at, op, base?, fields?, was?, bytes? }] waiting to be sent (compacted)
let inflight = null; // entries in the request that is on its way
let pushTimer = null;
let pushRetry = 0;
let batchOps = MAX_OPS_PER_REQUEST; // lowered when the server answers 413
let batchBytes = BATCH_BYTES;
let confirmMerge = false; // the backup of the first sync is removed once the outbox drains
let resyncing = null;
let resyncAgain = false;
let channel = null;
let releaseLeader = null;
let lockCtrl = null;
let streamCtrl = null;
let streamOpen = false; // the event stream is connected (not just being opened)
let streamRetry = 0;
let streamTimer = null;
let idleTimer = null;
let helloTimer = null;
let missedEvents = false;
let firstStream = null; // resolves when the leader's first stream attempt has settled
let loading = 0; // a state load is on its way: server events wait in `held`
let held = [];
let appliedRev = -1; // the rev of the state this page last took: older events are in it
let heardRev = -1; // every change up to this rev is in this page's copy (a state it took, streamed events, its own pushes)
const heardAbove = new Set(); // revs above heardRev whose changes this page has: heardRev moves up through them
let dataId = null; // the data folder this page syncs with
let hadMeta = false; // this browser synced before: its cached records are server copies (or in the outbox)
let outboxWarned = false;
let outboxUnsaved = false; // changes are waiting that only this page's memory holds (see setUnsaved)
let unsavedWarnedAt = 0;
let releaseOutboxLock = null;
let outboxLockCtrl = null;
const serverVer = new Map(); // "c:id" → updatedAt of the server's copy, as this page last saw it
const adopted = new Map(); // "c:id" → { rev, t }: the server's copy taken from a push answer at that rev

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Values read from the server or from storage are parsed JSON, which can hold objects whose
// toString / valueOf is not a function ({"toString": 0}); String(x), `${x}`, x > y and obj[x]
// throw on those. These helpers read such values without converting them.
const textOf = (v) => (typeof v === 'string' ? v : '');
const timeOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The server's records of collection c (objects only; anything else in the list is ignored). */
const rowsOf = (state, c) => {
  const list = state && typeof state === 'object' && state.data && typeof state.data === 'object' ? state.data[c] : null;
  return Array.isArray(list) ? list.filter(isRecord) : [];
};
const encoder = new TextEncoder();
/** Size of a value as a JSON request body, in UTF-8 bytes (what the server's limit counts). */
const byteSize = (v) => encoder.encode(JSON.stringify(v)).length;
const entryBytes = (e) => (e.bytes ??= byteSize(wire(e)));
const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- field-level merge (server/store.mjs has the same rules)

const NO_MERGE = new Set(['id', 'createdAt', 'updatedAt', '__proto__', 'constructor', 'prototype']);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** cyrb53: a fast 53-bit string hash, written in base 36 (the server computes the same). */
export function hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** The hash of a field's value (its JSON; 'u' for a missing key). */
export const valueHash = (v) => (v === undefined ? 'u' : hash53(JSON.stringify(v)));

/** An array merged item by item: plain objects with unique, non-empty string ids (note blocks, checklists). */
export function isIdArray(v) {
  if (!Array.isArray(v) || v.length > 5000) return false;
  const seen = new Set();
  for (const x of v) {
    if (!isRecord(x) || typeof x.id !== 'string' || !x.id || seen.has(x.id)) return false;
    seen.add(x.id);
  }
  return true;
}

/** `was` for one field of the version an edit started from: its hash, and each item's for an id'd array. */
export function baseOf(v) {
  return isIdArray(v) ? [valueHash(v), Object.fromEntries(v.map((x) => [x.id, valueHash(x)]))] : valueHash(v);
}

/** `was` as sent → Map(field → hash | [hash, Map(id → hash)]). */
function readWas(was) {
  const out = new Map();
  if (!isRecord(was)) return out;
  for (const [k, b] of Object.entries(was)) {
    if (typeof b === 'string') out.set(k, b);
    else if (Array.isArray(b) && typeof b[0] === 'string' && isRecord(b[1])) out.set(k, [b[0], new Map(Object.entries(b[1]))]);
  }
  return out;
}

/**
 * Merge id'd arrays: items only one side changed take that side's version, items both changed the
 * newer write's (`preferMine`), items I deleted go unless they changed them, and items only I added
 * (or changed while they deleted them) follow the item they came after in my copy.
 */
export function mergeIdArray(base, mine, theirs, preferMine) {
  const mineById = new Map(mine.map((x) => [x.id, x]));
  const theirIds = new Set(theirs.map((x) => x.id));
  const changedByMe = new Set(mine.filter((x) => base.get(x.id) !== valueHash(x)).map((x) => x.id));
  const out = [];
  for (const x of theirs) {
    const b = base.get(x.id);
    if (changedByMe.has(x.id)) out.push((b === undefined || b !== valueHash(x)) && !preferMine ? x : mineById.get(x.id));
    else if (b !== undefined && !mineById.has(x.id) && b === valueHash(x)) continue; // I deleted it; they left it alone
    else out.push(x);
  }
  mine.forEach((x, i) => {
    if (theirIds.has(x.id) || (base.has(x.id) && !changedByMe.has(x.id))) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((y) => y.id === mine[j].id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, x);
  });
  return out;
}

/**
 * An edit merged into another copy of its record, field by field (see server/store.mjs mergeRecord):
 * fields the other copy still has as the edit found them take the edit's value; fields both changed
 * take the newer write's (id'd arrays are merged item by item). Returns a new record, or `cur` itself.
 */
export function mergeRecord(cur, item, fields, was, preferMine) {
  let out = null;
  for (const f of fields) {
    if (typeof f !== 'string' || NO_MERGE.has(f)) continue;
    const mine = hasOwn(item, f) ? item[f] : undefined;
    const theirs = hasOwn(cur, f) ? cur[f] : undefined;
    if (sameValue(mine, theirs)) continue;
    const b = was?.get(f);
    const baseHash = Array.isArray(b) ? b[0] : b;
    let next;
    if (baseHash !== undefined && valueHash(theirs) === baseHash) next = mine;
    else if (Array.isArray(b) && isIdArray(mine) && isIdArray(theirs)) next = mergeIdArray(b[1], mine, theirs, preferMine);
    else if (preferMine) next = mine;
    else continue;
    if (sameValue(next, theirs)) continue;
    out ??= { ...cur };
    if (next === undefined) delete out[f];
    else out[f] = next;
  }
  return out || cur;
}

/** A merged record gets a version of its own (newer than both), and a merged note a new rev. */
function finish(c, merged, mine, theirs) {
  merged.updatedAt = Math.max(timeOf(mine.updatedAt), timeOf(theirs.updatedAt) + 1);
  if (c === 'notes' && Number.isInteger(theirs.rev) && Number.isInteger(mine.rev)) merged.rev = Math.max(theirs.rev, mine.rev) + 1;
  return merged;
}

/** The keys of `item` that differ from `prev` (skipping the ones in `known`, already marked changed). */
function changedFields(prev, item, known) {
  const out = [];
  for (const k of new Set([...Object.keys(prev), ...Object.keys(item)])) {
    if (NO_MERGE.has(k) || known?.has(k)) continue;
    const a = prev[k];
    const b = item[k];
    if (a === b) continue;
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------- status

function setStatus(status, err) {
  const online = status === 'online';
  const lastError = err ? String(err.message || err) : online ? null : syncState.lastError;
  if (syncState.status === status && syncState.online === online && syncState.lastError === lastError) return;
  Object.assign(syncState, { status, online, lastError });
  announce();
  // Changes only this page holds (they could not be saved here) and ecosys can't take them now.
  if (!online && outboxUnsaved && syncState.pending) warnUnsaved(new Error('The changes waiting to sync could not be saved in this browser'));
  // The other tabs of this browser don't see the stream: they show what the tab holding it sees.
  if (syncState.leader && (status === 'online' || status === 'offline')) postChannel({ type: 'status', status, error: lastError });
}

const announce = () => window.dispatchEvent(new CustomEvent('ecosys:sync', { detail: { ...syncState } }));

/** A problem that doesn't change the connection (a refused change): shown until the next reconnect. */
function problem(message) {
  syncState.lastError = message;
  announce();
}

function setRev(rev) {
  if (Number.isFinite(rev) && rev > syncState.rev) syncState.rev = rev;
}

/**
 * This page has every change of server rev `rev` (each write on the server is one rev). heardRev only
 * moves up without a gap, so after the stream was down it tells whether something went by unstreamed.
 */
function heard(rev) {
  if (!Number.isInteger(rev) || rev <= heardRev) return;
  if (rev !== heardRev + 1) {
    if (heardAbove.size < 5000) heardAbove.add(rev);
    return;
  }
  heardRev = rev;
  while (heardAbove.delete(heardRev + 1)) heardRev++;
}

function dispatchAI(detail) {
  window.dispatchEvent(new CustomEvent('ecosys:ai', { detail }));
}

/** Keep the server's AI status for tabs that start later. Returns false when it hasn't changed. */
function rememberAI(d) {
  if (d?.type !== 'status') return true;
  const next = { mode: d.mode, clients: Array.isArray(d.clients) ? d.clients : [] };
  if (JSON.stringify(next) === JSON.stringify(syncState.ai)) return false;
  syncState.ai = next;
  return true;
}

function postChannel(msg) {
  try {
    channel?.postMessage(msg);
  } catch {}
}

// ---------------------------------------------------------------- HTTP

async function api(path, { method = 'GET', body, timeout = 15000, keepalive = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const auth = apiHeaders();
  try {
    const res = await fetch(API + path, {
      method,
      headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
      keepalive,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const msg = textOf(data?.error?.message) || textOf(data?.error) || `HTTP ${res.status}`;
      const err = Object.assign(new Error(msg), { status: res.status });
      if (res.status === 403 && textOf(data?.error) === 'pairing_required') {
        err.pairing = true;
        markRejected(auth['X-Ecosys']);
      }
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** The API only answers on this computer (loopback); elsewhere (GitHub Pages, LAN, tunnels) don't even ask. */
function isLoopback() {
  const h = location.hostname;
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

/** No answer, a timeout or a server error: ecosys may be busy or restarting, so it is worth another try. */
const isTransient = (err) => !err.status || err.status >= 500 || err.status === 408 || err.status === 425 || err.status === 429;

const isEcosys = (hello) => hello?.app === 'ecosys' && (Array.isArray(hello.features) ? hello.features : ['sync']).includes('sync');

// ---------------------------------------------------------------- outbox

const opKey = (o) => (o.op === 'settings' ? 'settings' : o.op === 'replace' ? null : `${o.c}:${o.op === 'put' ? o.item.id : o.id}`);
const describeOp = (o) => (!o ? 'change' : o.op === 'settings' ? 'settings' : o.op === 'replace' ? `replace ${o.c}` : `${o.op} ${opKey(o)}`);
/** The key of an op as the server sent it (not validated yet), or null. */
const rawKey = (o) => (isRecord(o) && typeof o.c === 'string' ? (o.op === 'put' && isRecord(o.item) && typeof o.item.id === 'string' ? `${o.c}:${o.item.id}` : o.op === 'del' && typeof o.id === 'string' ? `${o.c}:${o.id}` : null) : null);

/**
 * Two changes to one record become one: what the first started from, and everything both changed. A
 * record that came with a replace (`split`: one of the puts a large replace is sent as) stays part of it.
 */
function mergeEntries(prev, e) {
  const o = e.op;
  if (o.op === 'settings') return { at: e.at, op: { op: 'settings', patch: { ...prev.op.patch, ...o.patch } } };
  const out = { at: e.at, op: o };
  if (prev.base !== undefined) out.base = prev.base;
  else if (e.base !== undefined) out.base = e.base;
  if (o.op === 'put' && prev.op.op === 'put' && e.fields && prev.fields) {
    out.fields = [...new Set([...prev.fields, ...e.fields])];
    out.was = { ...e.was, ...prev.was };
  }
  if (prev.split || e.split) out.split = 1;
  return out;
}

/** Outbox entries for a replace: the replace, or the replace with its first records and puts for the rest (`split`). */
const replaceEntries = (op, at, budget) => splitOp(op, budget).map((part) => (part.op === 'put' ? { at, op: part, split: 1 } : { at, op: part }));

/** Keep only the latest change per record (merged with the earlier ones); a replace absorbs earlier ops on its collection. */
function compact(entries) {
  const out = [];
  const at = new Map();
  for (const e of entries) {
    const o = e.op;
    if (o.op === 'replace') {
      for (let i = 0; i < out.length; i++) if (out[i] && out[i].op.c === o.c) out[i] = null;
      out.push(e);
      continue;
    }
    const k = opKey(o);
    let entry = e;
    if (at.has(k) && out[at.get(k)]) {
      const prev = out[at.get(k)];
      out[at.get(k)] = null;
      entry = mergeEntries(prev, e);
    }
    at.set(k, out.length);
    out.push(entry);
  }
  return out.filter(Boolean);
}

/** A replace too big for one request becomes a replace with the first records, then puts for the rest. */
function splitOp(op, budget = BATCH_BYTES) {
  if (op.op !== 'replace' || byteSize(op) <= budget) return [op];
  const first = [];
  const rest = [];
  let bytes = byteSize({ ...op, items: [] });
  for (const item of op.items) {
    const size = rest.length ? 0 : byteSize(item) + 1;
    if (!rest.length && bytes + size <= budget) {
      first.push(item);
      bytes += size;
    } else rest.push({ op: 'put', c: op.c, item });
  }
  return [{ op: 'replace', c: op.c, items: first }, ...rest];
}

/** An op as it is sent: a put or delete carries what it started from (see the top of this file). */
function wire(e) {
  const o = e.op;
  if (o.op === 'put' && e.fields) return { ...o, base: e.base ?? null, fields: e.fields, was: e.was || {} };
  if (o.op === 'del' && e.base !== undefined) return { ...o, base: e.base, at: e.at };
  return o;
}

/**
 * An entry as it is saved. A record (or a whole collection) the offline cache holds exactly as the
 * entry has it is saved as a reference to it, so the outbox stays small however much is waiting.
 * `cached(c)`: the offline cache's records of collection c by id (built once per save).
 */
function savedForm(e, cached) {
  const o = e.op;
  const out = { at: e.at, op: o };
  if (o.op === 'put' && cacheSaved(o.c) && cached(o.c).get(o.item.id) === o.item) {
    out.op = { op: 'put', c: o.c, item: { id: o.item.id } };
    out.ref = 1;
  } else if (o.op === 'replace' && cacheSaved(o.c)) {
    const now = cached(o.c);
    if (o.items.every((x) => now.get(x.id) === x)) {
      out.op = { op: 'replace', c: o.c, items: [] };
      out.ref = 1;
    }
  }
  if (e.base !== undefined) out.base = e.base;
  if (e.fields) {
    out.fields = e.fields;
    out.was = e.was || {};
  }
  if (e.split) out.split = 1;
  return out;
}

function persist() {
  const entries = [...(inflight || []), ...outbox];
  syncState.pending = entries.length;
  const maps = new Map();
  const cached = (c) => {
    if (!maps.has(c)) maps.set(c, new Map((COLLECTIONS.includes(c) ? db.all(c) : []).map((x) => [x.id, x])));
    return maps.get(c);
  };
  const list = entries.length ? JSON.stringify(entries.map((e) => savedForm(e, cached))) : null;
  try {
    if (list) sessionStorage.setItem(SS_OUTBOX, `{"v":2,"id":"${clientId}","entries":${list}}`);
    else sessionStorage.removeItem(SS_OUTBOX);
  } catch {
    try {
      sessionStorage.removeItem(SS_OUTBOX); // never leave an older copy behind
    } catch {}
  }
  if (!storageAvailable()) return void setUnsaved(entries.length > 0, null);
  const key = LS_OUTBOX + clientId;
  try {
    if (list) localStorage.setItem(key, `{"v":2,"at":${Date.now()},"entries":${list}}`);
    else localStorage.removeItem(key);
    setUnsaved(false);
  } catch (err) {
    // localStorage is full: the changes stay in this tab (an older saved copy is kept) until they are sent.
    setUnsaved(true, err);
  }
  dropSources(entries.length);
}

/**
 * The changes waiting to sync could not be saved in this browser (localStorage is full or blocked):
 * leaving the page asks first while they wait, and while ecosys is not reachable the user is told
 * (the shell's "Could not save" warning). `err`: the storage error (null: storage is blocked, which the
 * shell already says).
 */
function setUnsaved(on, err) {
  if (on !== outboxUnsaved) {
    outboxUnsaved = on;
    if (on) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  }
  if (!on) {
    outboxWarned = false;
    return;
  }
  if (!err) return;
  if (!outboxWarned) {
    outboxWarned = true;
    console.warn('ecosys: the changes waiting to sync could not be saved in this browser', err);
    problem('Some changes waiting to sync could not be saved in this browser: keep this tab open until ecosys has them.');
  }
  if (!syncState.online) warnUnsaved(err);
}

/** Tell the user (at most every 30 s) that changes are kept only in this tab while ecosys can't take them. */
function warnUnsaved(err) {
  const t = Date.now();
  if (t - unsavedWarnedAt < 30000) return;
  unsavedWarnedAt = t;
  window.dispatchEvent(new CustomEvent('ecosys:save-error', { detail: err }));
}

function onBeforeUnload(e) {
  if (!outboxUnsaved || stopped || !(outbox.length || inflight?.length)) return;
  e.preventDefault(); // "Leave site? Changes you made may not be saved."
  e.returnValue = true; // older browsers ask only with this
}

/** Saved entries → entries. A reference is read from the offline cache (now, before any server state replaces it). */
function readEntries(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!isRecord(e) || !Number.isFinite(e.at)) continue;
    let op = null;
    const o = e.op;
    if (e.ref && isRecord(o) && COLLECTIONS.includes(o.c)) {
      if (o.op === 'put' && isRecord(o.item) && typeof o.item.id === 'string') {
        const item = db.get(o.c, o.item.id);
        if (item) op = { op: 'put', c: o.c, item };
      } else if (o.op === 'replace') op = { op: 'replace', c: o.c, items: db.all(o.c).slice() };
    } else op = validateOp(o);
    if (!op) continue;
    const entry = { at: e.at, op };
    if (e.base === null || (typeof e.base === 'number' && Number.isFinite(e.base))) entry.base = e.base;
    if (op.op === 'put' && Array.isArray(e.fields) && e.fields.every((k) => typeof k === 'string')) {
      entry.fields = [...new Set(e.fields)];
      entry.was = isRecord(e.was) ? e.was : {};
    }
    if (op.op === 'put' && e.split) entry.split = 1;
    out.push(entry);
  }
  return out;
}

/** The pages (tabs) of this browser that are alive and hold an outbox (Web Locks), or null when it can't be told. */
async function liveOutboxes() {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.query !== 'function') return null;
  try {
    const q = await locks.query();
    const names = [...(q.held || []), ...(q.pending || [])].map((l) => l?.name).filter((n) => typeof n === 'string' && n.startsWith(OUTBOX_LOCK));
    return new Set(names.map((n) => n.slice(OUTBOX_LOCK.length)));
  } catch {
    return null;
  }
}

function holdOutboxLock() {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function' || outboxLockCtrl) return;
  outboxLockCtrl = new AbortController();
  locks
    .request(OUTBOX_LOCK + clientId, { signal: outboxLockCtrl.signal }, () => new Promise((resolve) => (releaseOutboxLock = resolve)))
    .catch(() => {});
}

function dropOutboxLock() {
  releaseOutboxLock?.();
  releaseOutboxLock = null;
  outboxLockCtrl?.abort();
  outboxLockCtrl = null;
}

/**
 * Unsent ops from the previous page in this tab, and from pages that were closed before sending (no
 * page holds their outbox lock; without Web Locks, untouched for ABANDONED_MS). The copies they were
 * read from are deleted only after claimOutbox(), once this page knows it can sync (or that ecosys is
 * busy and it keeps trying), so a page that finds no ecosys server never loses them, and only once this
 * page's own saved copy holds them (or they are sent: see dropSources). Copies saved meanwhile under
 * this page's id are harmless: compact() merges duplicates.
 */
async function restoreOutbox({ claim = true } = {}) {
  const found = [];
  const keys = [];
  let prevId = null;
  try {
    const s = JSON.parse(sessionStorage.getItem(SS_OUTBOX) || 'null');
    if (s) {
      prevId = typeof s.id === 'string' ? s.id : null;
      found.push(...readEntries(s.entries));
    }
  } catch {}
  if (storageAvailable()) {
    const live = await liveOutboxes();
    try {
      const all = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_OUTBOX)) all.push(k);
      }
      for (const k of all) {
        const id = k.slice(LS_OUTBOX.length);
        if (id === clientId) continue;
        if (id === prevId) {
          keys.push(k); // same entries as sessionStorage
          continue;
        }
        let v = null;
        try {
          v = JSON.parse(localStorage.getItem(k) || 'null');
        } catch {}
        if (live ? !live.has(id) : !v || Date.now() - timeOf(v.at) > ABANDONED_MS) {
          found.push(...readEntries(v?.entries));
          keys.push(k);
        }
      }
    } catch {}
  }
  found.sort((a, b) => a.at - b.at);
  outbox = compact([...found, ...outbox]);
  sources = [...new Set([...sources, ...keys])];
  if (claim) claimOutbox();
  else persist();
}

/** This page syncs (or keeps trying): its own saved copy has the entries, so drop the copies they came from. */
function claimOutbox() {
  claimed = true;
  persist();
}

/**
 * The copies the restored entries were read from go once this page's own saved copy holds them, or
 * once nothing of them is left to send: never while they exist only in this page's memory.
 */
function dropSources(left) {
  if (!claimed || !sources.length || (outboxUnsaved && left)) return;
  for (const k of sources) {
    try {
      localStorage.removeItem(k);
    } catch {}
  }
  sources = [];
}

const trusted = () => !!dataId || hadMeta;

/**
 * The server version an edit of record `key` starts from: the copy in the request on its way (once
 * it lands that is the server's), else the server's copy as last seen, else (for a browser that has
 * synced) the cached record, which then came from the server.
 */
function baseFor(key, prev) {
  const flying = inflight?.find((e) => opKey(e.op) === key);
  if (flying) return flying.op.op === 'put' ? timeOf(flying.op.item.updatedAt) : null;
  if (serverVer.has(key)) return serverVer.get(key);
  return prev && trusted() ? timeOf(prev.updatedAt) : null;
}

/**
 * An outbox entry for a local op: a put or delete says what it started from; a put which keys it
 * changed. A put of a record that existed always carries its fields, even none (a letter typed and
 * deleted again before the save, a value picked again): sent without them it would be applied whole,
 * over whatever changed on the server meanwhile.
 */
function makeEntry(op, prev, t) {
  const e = { at: t, op };
  if (op.op !== 'put' && op.op !== 'del') return e;
  const key = opKey(op);
  e.base = baseFor(key, prev);
  if (op.op === 'put') {
    // Keys an earlier unsent change already marked are not compared again (typing in a long note).
    const earlier = outbox.findLast((x) => opKey(x.op) === key);
    const known = earlier?.fields ? new Set(earlier.fields) : null;
    const fields = prev ? changedFields(prev, op.item, known) : Object.keys(op.item).filter((k) => !NO_MERGE.has(k));
    if (prev || fields.length || known) {
      e.fields = fields;
      e.was = prev ? Object.fromEntries(fields.map((f) => [f, baseOf(prev[f])])) : {};
    }
  }
  return e;
}

function queue(ops, prevs = []) {
  if (stopped) return;
  const t = Date.now();
  const entries = [];
  (Array.isArray(ops) ? ops : []).forEach((op, i) => {
    if (!isRecord(op)) return;
    // A replace carries the live collection: its list is copied (records are never changed in place).
    if (op.op === 'replace') entries.push(...replaceEntries({ op: 'replace', c: op.c, items: op.items.slice() }, t));
    else entries.push(makeEntry(op, prevs[i], t));
  });
  outbox = compact([...outbox, ...entries]);
  persist();
  if (ready && pushRetry === 0) debouncePush(); // while retrying, the backoff timer decides
}

let pushTimerAt = 0;
/** Push PUSH_DELAY ms after the last write, but no later than 1 s after the first one. */
function debouncePush() {
  const t = Date.now();
  if (pushTimer && t - pushTimerAt >= 1000) return;
  clearTimeout(pushTimer);
  if (!pushTimer) pushTimerAt = t;
  pushTimer = setTimeout(push, PUSH_DELAY);
}

function schedulePush(delay) {
  clearTimeout(pushTimer);
  pushTimerAt = Date.now();
  pushTimer = setTimeout(push, delay);
}

/** The entries for the next request: as many as fit (count and bytes), always at least one. */
function takeBatch() {
  const batch = [];
  let bytes = 0;
  while (outbox.length && batch.length < batchOps) {
    const size = entryBytes(outbox[0]);
    if (size > REQUEST_BYTES_MAX) {
      tooLarge([outbox.shift()]); // never sendable: don't upload it just to be refused
      continue;
    }
    if (batch.length && bytes + size > batchBytes) break;
    bytes += size;
    batch.push(outbox.shift());
  }
  return batch;
}

const listOps = (items) => items.slice(0, 20).join(', ') + (items.length > 20 ? `, and ${items.length - 20} more` : '');

/** The server can't take these changes. They are dropped from the outbox; this tab keeps its copy. */
function tooLarge(entries) {
  console.warn(`ecosys: too large to sync, kept in this browser only: ${listOps(entries.map((e) => describeOp(e.op)))}`);
  problem('An item is too large to sync. It is kept in this browser only.');
}

/** rejected: [{index, error}] as the server reports them (index into `entries`). */
function refused(entries, rejected) {
  const entryAt = (r) => (Number.isInteger(r?.index) ? entries[r.index] : undefined);
  console.warn(`ecosys: the server refused changes; this browser keeps its copy: ${listOps(rejected.map((r) => `${describeOp(entryAt(r)?.op)}${textOf(r?.error) ? ` (${r.error})` : ''}`))}`);
  const reason = rejected.find((r) => typeof r?.error === 'string')?.error;
  const what = rejected.length === 1 ? 'a change' : `${rejected.length} changes`;
  problem(`ecosys could not save ${what}${reason ? ` (${String(reason).slice(0, 120)})` : ''}. It is kept in this browser only.`);
}

/** The outbox is empty: the first sync's merge (if any) is on the server, so its backup can go. */
function drained() {
  if (!confirmMerge) return;
  confirmMerge = false;
  try {
    localStorage.removeItem(LS_BACKUP);
  } catch {}
}

/** The server has this change as it was sent: its copy is now this version. */
function acknowledged(e, rev) {
  const k = opKey(e.op);
  if (!k || k === 'settings') return;
  if (e.op.op === 'put') serverVer.set(k, timeOf(e.op.item.updatedAt));
  else serverVer.delete(k);
  adopted.set(k, { rev, t: Date.now() });
}

function pruneAdopted() {
  const t = Date.now();
  for (const [k, a] of adopted) if (t - a.t > ADOPTED_MS) adopted.delete(k);
}

async function push() {
  clearTimeout(pushTimer);
  pushTimer = null;
  if (!ready || stopped || inflight) return;
  if (!outbox.length) return drained();
  inflight = takeBatch();
  if (!inflight.length) {
    inflight = null;
    persist();
    return drained();
  }
  persist();
  let res;
  try {
    res = await api('ops', { method: 'POST', body: { client: clientId, baseRev: syncState.rev, ops: inflight.map(wire) } });
  } catch (err) {
    return pushFailed(err);
  }
  const sent = inflight;
  inflight = null;
  pushRetry = 0;
  setRev(res?.rev);
  const rev = timeOf(res?.rev);
  // A change applied here (more applied than replaces, which may change nothing) is the server's rev
  // now; while the stream is open the changes of the revs before it come on the stream.
  if (streamOpen && typeof res?.applied === 'number' && res.applied > sent.filter((e) => e.op.op === 'replace').length) heard(res.rev);
  // Ops the server did not apply as sent: merged with a newer copy, or deleted there (this tab takes
  // the server's copy), or refused as invalid (this tab keeps its copy and says so).
  const count = typeof res?.rejected === 'number' || typeof res?.rejected === 'string' ? Number(res.rejected) : 0;
  const rejected = Array.isArray(res?.rejected) ? res.rejected : count > 0 ? [{}] : [];
  const outcomes = [];
  const refusals = [];
  const notAsSent = new Set();
  for (const r of rejected) {
    const e = Number.isInteger(r?.index) ? sent[r.index] : undefined;
    if (e) notAsSent.add(r.index);
    const outcome = textOf(r?.outcome);
    const k = e ? opKey(e.op) : null;
    if (k && (outcome === 'merged' || outcome === 'kept') && isRecord(r.item) && `${e.op.c}:${r.item.id}` === k) outcomes.push({ op: 'put', c: e.op.c, item: r.item });
    else if (k && e.op.op === 'put' && outcome === 'deleted') outcomes.push({ op: 'del', c: e.op.c, id: e.op.item.id });
    else refusals.push(r);
  }
  sent.forEach((e, i) => {
    if (!notAsSent.has(i)) acknowledged(e, rev);
  });
  pruneAdopted();
  if (outcomes.length) {
    for (const o of outcomes) adopted.set(opKey(o), { rev, t: Date.now() });
    applyRemoteOps(outcomes); // its rebase moves newer edits of these records onto the server's copy
  }
  persist();
  // The tab holding the stream is online when the stream is (a failed push may have said otherwise).
  if (syncState.status !== 'online' && (!syncState.leader || streamOpen)) setStatus('online');
  if (refusals.length) refused(sent, refusals);
  if (syncState.leader && !streamCtrl) openStream(); // the server is back: reconnect now
  if (outbox.length) schedulePush(0);
  else drained();
}

function pushFailed(err) {
  const sent = inflight || [];
  inflight = null;
  const s = err.status;
  if (err.pairing) {
    outbox = compact([...sent, ...outbox]); // kept for when this browser is connected again
    persist();
    return void goUnpaired();
  }
  if (s === 401 || s === 403) {
    outbox = compact([...sent, ...outbox]); // kept (also in storage) for a page that may sync them
    persist();
    return void fail(err);
  }
  if (s === 413) {
    // Too big for the server: try again with half as much. A replace is split further; one record
    // that is still too big stays local.
    const one = sent.length === 1 ? sent[0] : null;
    if (!one) {
      batchOps = Math.max(1, Math.floor(sent.length / 2));
      batchBytes = Math.max(1, Math.floor(sent.reduce((n, e) => n + entryBytes(e), 0) / 2));
      outbox = compact([...sent, ...outbox]);
    } else if (one.op.op === 'replace' && one.op.items.length) {
      outbox = compact([...replaceEntries(one.op, one.at, Math.floor(entryBytes(one) / 2)), ...outbox]);
    } else tooLarge(sent);
    persist();
    return void schedulePush(0);
  }
  if (s >= 400 && s < 500 && s !== 408 && s !== 425 && s !== 429) {
    // The server refused the whole request: drop these changes (sending them again won't help).
    refused(sent, sent.map((_, index) => ({ index, error: err.message })));
    persist();
    return void schedulePush(PUSH_DELAY);
  }
  outbox = compact([...sent, ...outbox]);
  persist();
  setStatus('offline', err);
  pushRetry++;
  schedulePush(backoff(pushRetry));
}

// The server is on this computer: retry quickly, but never more than every 10 s once it has been down a while.
const backoff = (n) => Math.min(10000, 500 * 2 ** Math.min(n, 5)) * (0.75 + Math.random() * 0.5);

/** Best-effort send of what's left when the page goes away (the outbox is also kept for the next page). */
function pushOnExit() {
  if (!ready || stopped || !outbox.length) return;
  let bytes = 200;
  for (const e of outbox) if ((bytes += entryBytes(e) + 1) > KEEPALIVE_BYTES) return; // all or nothing: the next page sends it
  api('ops', { method: 'POST', body: { client: clientId, baseRev: syncState.rev, ops: outbox.map(wire) }, keepalive: true }).catch(() => {});
}

// ---------------------------------------------------------------- rebase (local edits on top of changes from elsewhere)

/**
 * The local view of a record: entry `e` (a change not confirmed yet) on top of `view` (another copy
 * of the record, null when there is none). A put that doesn't say what it changed is taken whole.
 */
function overlay(e, view) {
  const o = e.op;
  if (o.op === 'del') return null;
  if (o.op !== 'put') return view;
  if (!view) return e.base == null ? o.item : null; // gone there: only a record made here is still on its way
  if (!e.fields || (e.base != null && timeOf(view.updatedAt) === e.base)) return o.item;
  const merged = mergeRecord(view, o.item, e.fields, readWas(e.was), timeOf(o.item.updatedAt) >= timeOf(view.updatedAt));
  return merged === view ? view : finish(o.c, merged, o.item, view);
}

/**
 * Entry `e` moved onto the server's copy `theirs` (null: deleted there): it now starts from that
 * version and carries only what still differs from it. Returns e, a new entry, or null (nothing
 * of it is left to send).
 */
function rebaseEntry(e, theirs) {
  const o = e.op;
  if (o.op === 'del') {
    if (!theirs) return null; // deleted there too
    if (timeOf(theirs.updatedAt) > e.at) return null; // changed there after it was deleted here: it stays
    return { at: e.at, op: o, base: timeOf(theirs.updatedAt) };
  }
  if (o.op !== 'put') return e;
  if (!theirs) return e.base == null ? e : null; // deleted after the version this edit started from: it stays deleted
  if (!e.fields) return e;
  if (e.base != null && timeOf(theirs.updatedAt) === e.base) return e;
  const merged = mergeRecord(theirs, o.item, e.fields, readWas(e.was), timeOf(o.item.updatedAt) >= timeOf(theirs.updatedAt));
  const fields = e.fields.filter((f) => !NO_MERGE.has(f) && !sameValue(merged[f], theirs[f]));
  if (!fields.length || merged === theirs) return null;
  const item = finish(o.c, merged, o.item, theirs);
  return { at: e.at, op: { op: 'put', c: o.c, item }, base: timeOf(theirs.updatedAt), fields, was: Object.fromEntries(fields.map((f) => [f, baseOf(theirs[f])])) };
}

/**
 * store.js calls this with changes that came from elsewhere (validated): the server's versions
 * (server: true: unsent edits of these records now start from them) or another tab's copy of a
 * collection. Returns the ops that put this tab's unconfirmed edits back on top of them.
 */
function rebase(ops, { server = false } = {}) {
  const out = [];
  if (!Array.isArray(ops) || !ops.length) return out;
  const incoming = new Map(); // "c:id" → record, or null (deleted)
  const full = new Set(); // collections given whole: a record missing from them is gone
  let settingsIn = false;
  for (const o of ops) {
    if (o.op === 'put') incoming.set(`${o.c}:${o.item.id}`, o.item);
    else if (o.op === 'del') incoming.set(`${o.c}:${o.id}`, null);
    else if (o.op === 'replace') {
      full.add(o.c);
      for (const it of o.items) incoming.set(`${o.c}:${it.id}`, it);
    } else if (o.op === 'settings') settingsIn = true;
  }
  if (server) {
    for (const [k, v] of incoming) {
      if (v) serverVer.set(k, timeOf(v.updatedAt));
      else serverVer.delete(k);
    }
    if (full.size) for (const k of [...serverVer.keys()]) if (full.has(k.slice(0, k.indexOf(':'))) && !incoming.has(k)) serverVer.delete(k);
  }
  const pending = [...(inflight || []), ...outbox];
  // A replace of our own on its way (an import, Erase everything) wins on its collection, as before.
  const ownReplace = new Set(pending.filter((e) => e.op.op === 'replace').map((e) => e.op.c));
  for (const e of pending) if (e.op.op === 'replace' && (full.has(e.op.c) || ops.some((o) => o.c === e.op.c))) out.push(e.op);
  const flying = new Map((inflight || []).map((e) => [opKey(e.op), e]));
  const queued = new Map();
  outbox.forEach((e, i) => {
    const k = opKey(e.op);
    if (k) queued.set(k, i);
  });
  const keys = new Set([...flying.keys(), ...queued.keys()].filter((k) => k && k !== 'settings'));
  const drop = new Set();
  for (const k of keys) {
    const c = k.slice(0, k.indexOf(':'));
    if (!incoming.has(k) && !full.has(c)) continue;
    if (ownReplace.has(c)) {
      const mine = queued.has(k) ? outbox[queued.get(k)] : flying.get(k);
      if (mine) out.push(mine.op);
      continue;
    }
    const theirs = incoming.has(k) ? incoming.get(k) : null;
    let view = theirs;
    const fe = flying.get(k);
    if (fe) view = overlay(fe, view);
    if (queued.has(k)) {
      const i = queued.get(k);
      let qe = outbox[i];
      // Moved onto the server's copy only when nothing is on its way for it (that answer moves it).
      if (server && !fe) {
        const next = rebaseEntry(qe, theirs);
        if (next !== qe) {
          if (next) outbox[i] = next;
          else drop.add(i);
          qe = next;
        }
      }
      if (qe) view = overlay(qe, view);
    }
    if (view && view !== theirs) out.push({ op: 'put', c, item: view });
    else if (!view && theirs) out.push({ op: 'del', c, id: k.slice(c.length + 1) });
  }
  if (settingsIn) for (const e of pending) if (e.op.op === 'settings') out.push(e.op);
  if (drop.size || server) {
    if (drop.size) outbox = outbox.filter((_, i) => !drop.has(i));
    persist();
  }
  return out;
}

// ---------------------------------------------------------------- state

/** An entry from an older page (no base/fields) older than the server's copy of its record. */
function isStale(entry, state) {
  const o = entry.op;
  if (o.op !== 'put' && o.op !== 'del') return false;
  const id = o.op === 'put' ? o.item.id : o.id;
  const theirs = rowsOf(state, o.c).find((x) => x.id === id);
  return !!theirs && timeOf(theirs.updatedAt) > entry.at;
}

function readMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(LS_META) || 'null');
    return isRecord(m) ? m : null;
  } catch {
    return null;
  }
}

/** What this browser last synced with: the data folder and its rev (other tabs read it too). */
function writeMeta() {
  syncState.synced = true;
  try {
    localStorage.setItem(LS_META, JSON.stringify({ rev: syncState.rev, at: Date.now(), ...(dataId ? { dataId } : {}) }));
  } catch {}
}

const PARENT = { tasks: ['lists', 'listId'], events: ['calendars', 'calendarId'], notes: ['folders', 'folderId'] };

let dayLabel = null;
/** "Sunday, November 22" for a YYYY-MM-DD. */
function shortDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  dayLabel ??= new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return dayLabel.format(new Date(y, m - 1, d));
}

/**
 * This browser's daily note for a day the server already has a daily note for: kept as a regular note
 * in the same place (never two daily notes for one date), its date title saying where it came from.
 */
function asRegularNote(x) {
  const label = `${shortDay(x.day)} (from this browser)`;
  const blocks = Array.isArray(x.blocks) ? x.blocks.slice() : [];
  const first = blocks[0];
  if (first?.t === 'h1' && blockText(first).trim() === longDate(x.day)) blocks[0] = { ...first, c: [[label]] };
  else blocks.unshift(newBlock('h1', label));
  return { ...x, day: null, blocks, updatedAt: Math.max(Date.now(), timeOf(x.updatedAt)) };
}

/**
 * The first time a browser syncs with a data folder that already has data, the records made or
 * edited in this browser are added to it (by id; the newer copy wins), so nothing typed here is lost
 * just because another browser reached the folder first. Untouched sample data is left out, and a
 * sample list / calendar / folder is matched to the folder's one of the same name (a folder at the
 * same place: under the folder its parent matches, or at the top level), so nothing is doubled. An
 * edited daily note for a day the folder has a daily note for becomes a regular note.
 */
function firstSyncOps(state) {
  const local = snapshot().data;
  const seed = seededAt();
  const samples = sampleIds();
  // A sample this device created (store.js remembers which), never edited. Data seeded by an older
  // version: seeding is one synchronous batch, so its records were created within moments of `seed`.
  const pristine = (c, x) =>
    x.createdAt === x.updatedAt && (samples ? samples.has(`${c}:${x.id}`) : seed != null && x.createdAt >= seed && x.createdAt - seed < 2000);
  const theirs = Object.fromEntries(Object.keys(local).map((c) => [c, new Map(rowsOf(state, c).map((x) => [x.id, x]))]));
  const byName = (c) => new Map([...theirs[c].values()].filter((x) => typeof x.name === 'string').map((x) => [x.name.toLowerCase(), x.id]));
  const need = { lists: new Set(), calendars: new Set(), folders: new Set() };
  const ops = [];
  const take = (c, x) => {
    const s = theirs[c].get(x.id);
    if (s) return timeOf(x.updatedAt) > timeOf(s.updatedAt);
    return !pristine(c, x) || !!need[c]?.has(x.id);
  };
  // Days the folder already has a daily note for.
  const days = new Set([...theirs.notes.values()].filter((n) => typeof n.day === 'string' && !n.trashedAt).map((n) => n.day));

  // The server folder an untouched sample folder stands for, or null (it must be sent): the server's
  // folder of the same name at the same place, that is under the folder the sample's parent stands
  // for, or at the top level. (Ids never contain '/', so "parent/name" keys can't collide.)
  const localFolders = new Map(local.folders.map((f) => [f.id, f]));
  const serverPlaces = new Map(); // "parent id/lowercased name" → the server's first folder there
  for (const s of theirs.folders.values()) {
    const key = `${textOf(s.parentId)}/${textOf(s.name).toLowerCase()}`;
    if (!serverPlaces.has(key)) serverPlaces.set(key, s.id);
  }
  const matched = new Map(); // local folder id → server folder id or null (also stops parent cycles)
  const matchFolder = (id) => {
    if (matched.has(id)) return matched.get(id);
    matched.set(id, null);
    const f = localFolders.get(id);
    if (!f || !pristine('folders', f)) return null;
    const parent = f.parentId ? (theirs.folders.has(f.parentId) ? f.parentId : matchFolder(f.parentId)) : '';
    if (parent === null) return null; // its parent is sent, so nothing on the server is at its place
    const match = serverPlaces.get(`${parent}/${textOf(f.name).toLowerCase()}`) ?? null;
    matched.set(id, match);
    return match;
  };

  for (const c of ['tasks', 'events', 'notes']) {
    const [pc, field] = PARENT[c];
    const names = pc === 'folders' ? null : byName(pc);
    for (const x of local[c]) {
      if (!take(c, x)) continue;
      let item = x;
      if (c === 'notes' && typeof x.day === 'string' && !x.trashedAt && !theirs.notes.has(x.id) && days.has(x.day)) item = asRegularNote(x);
      const pid = x[field];
      const parent = pid ? local[pc].find((p) => p.id === pid) : null;
      if (parent && !theirs[pc].has(pid)) {
        const match = pc === 'folders' ? matchFolder(pid) : pristine(pc, parent) && names.get(textOf(parent.name).toLowerCase());
        if (match) item = { ...item, [field]: match };
        else need[pc].add(pid);
      }
      ops.push({ op: 'put', c, item });
    }
  }
  for (const c of ['lists', 'calendars']) for (const x of local[c]) if (take(c, x)) ops.push({ op: 'put', c, item: x });

  // A folder that is sent needs its parent on the server too: the server's own copy, else the server
  // folder an untouched sample parent stands for (the folder is put under that one instead of sending
  // a second "Work"), else the local parent, which is then sent as well (and so on up).
  const sending = new Map(); // folder id → the record to send
  const sendFolder = (f) => {
    if (sending.has(f.id)) return;
    sending.set(f.id, f);
    const pid = f.parentId;
    if (!pid || theirs.folders.has(pid)) return;
    const match = matchFolder(pid);
    if (match && match !== f.id) sending.set(f.id, { ...f, parentId: match });
    else if (localFolders.has(pid)) sendFolder(localFolders.get(pid));
  };
  for (const x of local.folders) if (take('folders', x)) sendFolder(x);
  for (const x of local.folders) if (sending.has(x.id)) ops.push({ op: 'put', c: 'folders', item: sending.get(x.id) });
  return ops;
}

/**
 * The local records the first sync leaves out (untouched samples, copies older than the server's) are
 * kept in localStorage until the merge is confirmed (the outbox drains), and only if they are small.
 */
function backupLeftOut(state, ops) {
  if (!storageAvailable()) return;
  const local = snapshot().data;
  const merged = new Set(ops.map((o) => `${o.c}:${o.item.id}`));
  const records = {};
  let count = 0;
  for (const c of Object.keys(local)) {
    const theirs = new Map(rowsOf(state, c).map((x) => [x.id, JSON.stringify(x)]));
    const left = local[c].filter((x) => !merged.has(`${c}:${x.id}`) && theirs.get(x.id) !== JSON.stringify(x));
    if (left.length) {
      records[c] = left;
      count += left.length;
    }
  }
  try {
    const raw = count ? JSON.stringify({ app: 'ecosys', kind: 'left-out-by-first-sync', at: Date.now(), rev: state?.rev ?? null, records }) : '';
    if (raw && raw.length <= BACKUP_MAX) localStorage.setItem(LS_BACKUP, raw);
    else localStorage.removeItem(LS_BACKUP);
  } catch {}
}

/**
 * The import body for this browser's data and the puts that follow it when it doesn't fit one request.
 * Records are taken in collection order until the budget is used up; everything after goes as puts.
 */
function importParts(snap, budget) {
  const whole = { data: snap.data, settings: snap.settings };
  if (byteSize(whole) <= budget) return { body: whole, rest: [] };
  const data = {};
  const rest = [];
  let room = budget - byteSize({ data: {}, settings: snap.settings }) - 200;
  for (const c of Object.keys(snap.data)) {
    data[c] = [];
    for (const item of snap.data[c]) {
      const size = rest.length ? Infinity : byteSize(item) + 1;
      if (size <= room) {
        data[c].push(item);
        room -= size;
      } else rest.push({ op: 'put', c, item });
    }
  }
  return { body: { data, settings: snap.settings }, rest };
}

/** First run of a data folder: it starts with this browser's data. False if another tab got there first. */
async function importLocal() {
  const snap = snapshot();
  const inSnapshot = new Set(outbox); // these entries' changes are part of the snapshot
  let parts = importParts(snap, BATCH_BYTES);
  try {
    let res;
    try {
      res = await api('import', { method: 'POST', body: parts.body });
    } catch (err) {
      if (err.status !== 413) throw err;
      parts = importParts(snap, 0); // this server takes less: claim it with the settings, send records as puts
      res = await api('import', { method: 'POST', body: parts.body });
    }
    setRev(res?.rev);
  } catch (err) {
    if (err.status === 409) return false;
    throw err;
  }
  const t = Date.now();
  outbox = compact([...parts.rest.map((op) => ({ at: t, op })), ...outbox.filter((e) => !inSnapshot.has(e))]);
  return true;
}

/**
 * Take the server's state. How depends on the data folder it comes from:
 *   - not initialized (new, or emptied: data.json was moved aside, another ECOSYS_DATA_DIR): this
 *     browser's data goes there (import), as for the very first browser, never the other way round;
 *   - another folder than the one this browser last synced with (or that one put back to an older
 *     copy): what this browser has that the folder lacks is added first (the first-sync merge);
 *   - the folder it knows: its state is taken, with this tab's unconfirmed edits merged on top.
 */
async function adopt(state) {
  if (!isRecord(state)) throw new Error('ecosys sent no data');
  let imported = false;
  if (state.initialized === false) {
    imported = await importLocal();
    state = await api('state');
    if (!isRecord(state)) throw new Error('ecosys sent no data');
  }
  const theirs = typeof state.dataId === 'string' && isId(state.dataId) ? state.dataId : null;
  // An older state than this browser has already seen of this folder: either another tab took a newer
  // one while this request was answered (asking again gets at least that one), or the folder went back
  // to an older copy (asking again gets the same).
  const seen = readMeta();
  if (theirs && seen?.dataId === theirs && timeOf(state.rev) < timeOf(seen.rev)) {
    state = await api('state');
    if (!isRecord(state)) throw new Error('ecosys sent no data');
  }
  const meta = readMeta();
  const known = !!meta && (!theirs || !meta.dataId || (meta.dataId === theirs && timeOf(state.rev) >= timeOf(meta.rev)));
  if (imported || !known || (theirs && theirs !== dataId && dataId)) {
    // The bases of waiting changes belong to another folder: they are merged there by their fields.
    for (const e of outbox) if (e.base !== undefined) e.base = null;
  }
  if (!imported) {
    outbox = outbox.filter((e) => e.fields || e.base !== undefined || !isStale(e, state)); // changes saved by an older page
    if (!known) {
      // An Erase everything, Start over or Import backup made before this browser synced with this
      // folder (a new profile, not connected yet or ecosys not running) was made on this browser's copy,
      // not on the folder's: it never erases or replaces the folder's data. What this browser has that
      // the folder lacks still goes there (below). One made on this very folder (put back to an older
      // copy since) is still applied to it.
      if (!(meta?.dataId && meta.dataId === theirs)) outbox = outbox.filter((e) => e.op.op !== 'replace' && !e.split);
      const ops = firstSyncOps(state);
      if (ops.length) {
        backupLeftOut(state, ops);
        const t = Date.now();
        outbox = compact([...outbox, ...ops.map((op) => ({ at: t, op }))]);
      }
    }
  }
  confirmMerge = true;
  dataId = theirs;
  serverVer.clear();
  for (const c of COLLECTIONS) for (const x of rowsOf(state, c)) if (typeof x.id === 'string') serverVer.set(`${c}:${x.id}`, timeOf(x.updatedAt));
  persist();
  replaceAll(state, { reason: 'sync' });
  if (Number.isFinite(state.rev)) syncState.rev = state.rev;
  appliedRev = timeOf(state.rev);
  heardRev = appliedRev;
  heardAbove.clear();
  writeMeta();
}

async function firstLoad() {
  loading++;
  try {
    await adopt(await api('state'));
  } finally {
    loading--;
    flushHeld();
  }
}

/** Fetch the server's state again (after a gap in the event stream, or when it changed on disk). */
function resync() {
  if (resyncing) {
    resyncAgain = true;
    return resyncing;
  }
  resyncing = (async () => {
    loading++;
    try {
      do {
        resyncAgain = false;
        await adopt(await api('state'));
      } while (resyncAgain);
      // Another folder (or an import) may have added changes to send.
      if (ready && outbox.length && !inflight) schedulePush(0);
    } catch (err) {
      if (err.pairing) goUnpaired();
      else setStatus('offline', err);
    } finally {
      loading--;
      resyncing = null;
      flushHeld();
    }
  })();
  return resyncing;
}

// ---------------------------------------------------------------- event stream

/** Events that arrived while a state was loading, in order: what that state has is skipped. */
function flushHeld() {
  if (loading || !held.length) return;
  const list = held;
  held = [];
  for (const [type, data] of list) {
    if (type === 'gap') afterGap(data);
    else onServerEvent(type, data);
  }
}

/**
 * The stream opened after changes may have gone by unstreamed (it was down, or it opened after the
 * state was loaded): reload, unless the server's hello ({rev, dataId}, its first event) shows that
 * this page has every change up to now. `hello` is null for a server that sends none: then reload.
 * While a state is loading this waits for it, and before any state was taken the first load has it all.
 */
function afterGap(hello) {
  clearTimeout(helloTimer);
  if (!missedEvents) return;
  if (loading) return void held.push(['gap', hello]);
  missedEvents = false;
  if (appliedRev < 0) return;
  const id = isRecord(hello) && typeof hello.dataId === 'string' ? hello.dataId : null;
  if (!isRecord(hello) || !Number.isInteger(hello.rev) || hello.rev !== heardRev || (id && id !== dataId)) resync();
}

function onServerEvent(type, data) {
  if (!data || typeof data !== 'object') return;
  if (loading && (type === 'ops' || type === 'snapshot')) return void held.push([type, data]);
  if (type === 'ops') {
    const rev = timeOf(data.rev);
    if (rev && rev <= appliedRev) return; // already in the state this page took
    setRev(data.rev);
    postChannel({ type: 'rev', rev: syncState.rev });
    if (data.origin !== clientId && Array.isArray(data.ops)) {
      // A record this page took from a push answer at a later rev is newer than what this event says.
      const ops = data.ops.filter((o) => {
        const a = adopted.get(rawKey(o));
        return !(a && rev && a.rev >= rev);
      });
      if (ops.length) applyRemoteOps(ops);
    }
    heard(data.rev);
    writeMeta();
  } else if (type === 'snapshot') {
    // data.json changed on disk (or an import): reload, unless it is the very state this page took. A
    // rev below the one this page has seen means the folder went back to an older copy (a sync or
    // backup tool restored one): reloading takes it, and brings back what this browser has that it lost.
    const rev = timeOf(data.rev);
    const sameFolder = typeof data.dataId !== 'string' || data.dataId === dataId;
    if (!(sameFolder && rev && rev === appliedRev && rev >= syncState.rev)) resync();
  } else if (type === 'hello') {
    afterGap(data);
  } else if (type === 'ai') {
    rememberAI(data);
    dispatchAI(data);
    postChannel({ type: 'ai', detail: data });
  }
}

function parseBlock(block) {
  let type = 'message';
  const data = [];
  for (const raw of block.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return;
  let payload = null;
  try {
    payload = JSON.parse(data.join('\n'));
  } catch {
    return;
  }
  onServerEvent(type, payload);
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => streamCtrl?.abort(), STREAM_IDLE_MS);
}

let streamSettled = null;
function settleStream() {
  streamSettled?.();
  streamSettled = null;
}

// fetch() instead of EventSource so the request can carry the pairing header like every API call.
async function openStream() {
  if (stopped || streamCtrl || !syncState.leader) return;
  clearTimeout(streamTimer);
  const ctrl = new AbortController();
  streamCtrl = ctrl;
  armIdle(); // also covers a server that accepts the connection but never answers
  const auth = apiHeaders();
  try {
    const res = await fetch(`${API}events?client=${encodeURIComponent(clientId)}`, {
      headers: { ...auth, Accept: 'text/event-stream' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      let data = null;
      try {
        data = await res.json();
      } catch {}
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, pairing: res.status === 403 && textOf(data?.error) === 'pairing_required' });
    }
    streamRetry = 0;
    streamOpen = true;
    settleStream();
    armIdle();
    if (ready) setStatus('online'); // before the first load is done, connecting decides
    // Opened after a state was taken (a slow server: the first load did not wait for it), or while one
    // is loading: what changed before it opened was not streamed to this page.
    if (appliedRev >= 0 || loading) missedEvents = true;
    if (missedEvents) {
      // Changes may have been missed: reload, unless the server's hello (its first event) shows that
      // nothing went by unstreamed. A server that sends no hello: reload in a moment.
      clearTimeout(helloTimer);
      helloTimer = setTimeout(() => afterGap(null), 300);
    }
    if (ready && outbox.length && !inflight) schedulePush(0); // the server is back: send what's waiting now
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle();
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        parseBlock(block);
      }
      if (buf.length > 4000000) buf = ''; // a runaway event: drop it
    }
    throw new Error('Event stream closed');
  } catch (err) {
    clearTimeout(idleTimer);
    settleStream();
    if (streamCtrl === ctrl) {
      streamCtrl = null;
      streamOpen = false;
    }
    if (stopped || !syncState.leader) return; // closed because this tab no longer holds the stream (unpaired, stopped)
    missedEvents = true;
    if (err.pairing) {
      markRejected(auth['X-Ecosys']);
      return void goUnpaired();
    }
    if (err.status === 401 || err.status === 403) return void fail(err);
    if (ready) setStatus('offline', ctrl.signal.aborted ? new Error('Connection to ecosys timed out') : err);
    streamRetry++;
    clearTimeout(streamTimer);
    streamTimer = setTimeout(openStream, err.status === 404 ? 60000 : backoff(streamRetry));
  }
}

function becomeLeader() {
  if (stopped) return;
  syncState.leader = true;
  // A tab taking over later: changes made before its stream opened were not streamed to it.
  if (ready) missedEvents = true;
  firstStream = new Promise((r) => (streamSettled = r));
  openStream();
}

function onChannelMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ai') {
    if (rememberAI(msg.detail)) dispatchAI(msg.detail); // a status this tab already has is not repeated
  } else if (msg.type === 'rev') setRev(msg.rev);
  else if (msg.type === 'status') {
    // The tab holding the stream lost (or got back) the server: this tab shows the same.
    if (!syncState.leader && ready && (msg.status === 'offline' || msg.status === 'online')) setStatus(msg.status, msg.status === 'offline' && textOf(msg.error) ? textOf(msg.error) : undefined);
  } else if (msg.type === 'hello' && syncState.leader) {
    // a tab that just opened: the server sent the AI status only to this tab's stream
    if (syncState.ai) postChannel({ type: 'ai', detail: { type: 'status', ...syncState.ai } });
    if (ready && (syncState.status === 'online' || syncState.status === 'offline')) postChannel({ type: 'status', status: syncState.status, error: syncState.lastError });
  }
}

/**
 * Join this browser's tabs: one holds the event stream (Web Locks), the others hear from it over a
 * BroadcastChannel. Resolves once this tab knows which it is, and, holding the stream, once the stream
 * has opened (or failed), so the state loaded next has everything the stream does not bring.
 */
function subscribe() {
  subscribed = true;
  const wait = () => Promise.race([firstStream || Promise.resolve(), sleep(STREAM_WAIT_MS)]);
  const shared = storageAvailable() && globalThis.navigator?.locks && typeof BroadcastChannel === 'function';
  if (!shared) {
    becomeLeader(); // without shared storage every tab needs its own stream
    return wait();
  }
  channel = new BroadcastChannel('ecosys-sync');
  channel.onmessage = (e) => onChannelMessage(e.data);
  postChannel({ type: 'hello' });
  lockCtrl = new AbortController();
  const ctrl = lockCtrl;
  const hold = () =>
    new Promise((resolve) => {
      releaseLeader = resolve;
      becomeLeader();
    });
  return new Promise((decided) => {
    navigator.locks
      .request('ecosys-sync-stream', { ifAvailable: true }, (lock) => {
        if (!lock) return decided();
        const held = hold();
        wait().then(decided);
        return held;
      })
      .then(() => {
        decided();
        // Another tab holds the stream: take it over when that tab goes.
        if (!syncState.leader && !stopped && lockCtrl === ctrl) navigator.locks.request('ecosys-sync-stream', { signal: ctrl.signal }, hold).catch(() => {});
      })
      .catch(() => decided());
  });
}

function unsubscribe() {
  subscribed = false;
  clearTimeout(streamTimer);
  clearTimeout(idleTimer);
  clearTimeout(helloTimer);
  streamCtrl?.abort();
  streamCtrl = null;
  streamOpen = false;
  syncState.leader = false;
  releaseLeader?.();
  releaseLeader = null;
  lockCtrl?.abort();
  lockCtrl = null;
  channel?.close();
  channel = null;
  settleStream();
}

function fail(err) {
  ready = false;
  setSyncAdapter(null);
  unsubscribe();
  setStatus('error', err);
}

/**
 * The server doesn't know this browser (pairing, see shared/pair.js): stop talking to it, keep
 * recording changes (they are sent once the browser is connected), and start again once it is.
 */
function goUnpaired() {
  ready = false;
  clearTimeout(pushTimer);
  pushTimer = null;
  unsubscribe();
  setStatus('unpaired');
  if (!stopped && !connecting) run();
}

/** Resolves once this browser is paired (another tab opened the pairing link, or this one did). */
function pairedAgain() {
  return new Promise((resolve) => {
    if (pairingState() === 'paired') return resolve();
    const off = onPairingChange((state) => {
      if (state !== 'paired') return;
      off();
      resolve();
    });
  });
}

// ---------------------------------------------------------------- lifecycle

const adapter = {
  push: queue,
  pending: () => [...(inflight || []), ...outbox].map((e) => e.op),
  rebase,
  safe: () => syncState.online,
};

function onVisible() {
  if (stopped || !ready || document.visibilityState !== 'visible') return;
  if (outbox.length) schedulePush(0);
  if (syncState.leader && !streamCtrl) openStream();
}

function onPageHide() {
  pushOnExit();
  persist();
  stopped = true;
  unsubscribe();
  dropOutboxLock();
}

function onPageShow(e) {
  if (!e.persisted || !started) return; // restored from the back/forward cache
  stopped = false;
  holdOutboxLock();
  restoreOutbox().then(() => {
    if (stopped || !ready) return;
    subscribe();
    resync().then(() => outbox.length && schedulePush(0));
  });
}

/** One try at reaching ecosys and loading its state: 'ready', 'retry' (busy or restarting), 'unpaired', 'off' or 'failed'. */
async function connectOnce() {
  let hello;
  try {
    hello = await api('hello', { timeout: 4000 });
  } catch (err) {
    if (err.pairing) return 'unpaired';
    if (!isTransient(err)) return 'off';
    claimOutbox(); // writes are recorded while we wait: keep them, and the restored ones, for later
    setStatus('offline', err);
    return 'retry';
  }
  if (!isEcosys(hello)) return 'off';
  syncState.version = textOf(hello.version) || null; // shown in Settings
  if (hello.paired === false) {
    markRejected(apiHeaders()['X-Ecosys']);
    claimOutbox();
    return 'unpaired';
  }
  claimOutbox();
  try {
    if (!subscribed) await subscribe();
    await firstLoad();
    return 'ready';
  } catch (err) {
    if (err.pairing) return 'unpaired';
    if (err.status === 401 || err.status === 403) {
      fail(err);
      return 'failed';
    }
    setStatus('offline', err);
    return 'retry';
  }
}

/** No ecosys server here (plain static server): stay local-only. Saved outboxes are left for a page that can sync. */
function goOff() {
  setSyncAdapter(null);
  outbox = [];
  inflight = null;
  syncState.pending = 0;
  unsubscribe();
  setStatus('off');
}

function goOnline() {
  ready = true;
  setStatus('online');
  if (!listening) {
    listening = true;
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
  }
  if (syncState.leader) postChannel({ type: 'status', status: 'online', error: null });
  flushHeld();
  if (outbox.length) schedulePush(0);
  else drained();
}

let connecting = false;
async function run() {
  if (connecting) return;
  connecting = true;
  try {
    for (let n = 0; !stopped; n++) {
      if (n) await sleep(backoff(n));
      if (stopped) return;
      const step = await connectOnce();
      if (step === 'ready') return goOnline();
      if (step === 'off') return goOff();
      if (step === 'failed') return;
      if (step === 'unpaired') {
        // Keep working from this browser's copy; changes wait for the pairing link to be opened.
        unsubscribe();
        setStatus('unpaired');
        settle();
        await pairedAgain();
        n = -1;
        continue;
      }
      settle(); // the first try failed: startSync() resolves (status 'offline') while this keeps trying
    }
  } finally {
    connecting = false;
  }
}

async function boot() {
  if (!isLoopback()) return setStatus('off');
  hadMeta = !!readMeta();
  syncState.synced = hadMeta;
  holdOutboxLock();
  window.addEventListener('pagehide', onPageHide);
  await restoreOutbox({ claim: false });
  setSyncAdapter(adapter); // record writes from now on; they are sent once the first load is done
  setStatus('connecting');
  await run();
}

/**
 * Start syncing (idempotent). Resolves with syncState once the first attempt has settled — check
 * syncState.online. Never throws: without a server the apps simply stay local.
 */
export function startSync() {
  if (!started) {
    started = new Promise((resolve) => {
      settle = () => {
        settle = () => {};
        resolve();
      };
      boot()
        .catch((err) => {
          console.warn('ecosys: sync unavailable', err);
          setSyncAdapter(null);
          setStatus('off', err);
        })
        .finally(() => settle());
    }).then(() => syncState);
  }
  return started;
}

/** Push pending changes and reload the server's state now (e.g. a "Sync now" button). */
export async function syncNow() {
  if (!ready) return syncState;
  await push();
  await resync();
  return syncState;
}
