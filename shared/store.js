// ecosys shared data store.
//
// Every app is served from the same origin and reads and writes the same localStorage (the offline
// cache). Changes in one tab reach the others through the `storage` event. A collection localStorage
// can't hold (it is full) is kept in this tab's memory, and its changes go to the other tabs over a
// BroadcastChannel instead; it is never "rolled back" by writing an older copy, which every other tab
// would then load. When the local ecosys server is running, shared/sync.js registers a sync adapter:
// every write is recorded as an op ({op:'put'|'del'|'settings'|'replace'}, together with the record
// as it was before) and pushed to the server, and changes made elsewhere (another browser, an AI
// assistant over MCP) come back through applyRemoteOps() / replaceAll(). The edits this tab has not
// had confirmed yet stay on top of such changes: the adapter merges them in field by field
// (adapter.rebase), so a change made elsewhere to another field of the same record is kept.
//
// Everything that enters the cache — from localStorage, a backup file, another tab or the server —
// goes through the validators in sanitize.js. If localStorage is blocked, the store keeps working
// in memory for the session (storageAvailable() tells the UI).
//
// Notes and folders are validated with the notes data model (notes/core/schema.js) in EVERY app,
// not only in the notes app: Tasks, Schedule and Home also save remote changes, backups and other
// tabs' writes over the localStorage copy all the apps share, and the stage-1 notes schema alone
// would strip every note's blocks there. The import below registers those validators (with
// sanitize.js extendSchema) before this module's body runs, so before the first validation.
//
// Validating notes that way is costly (about 60 ms for 1,000 notes), and a page re-reads a whole
// collection each time another tab saves it (every few hundred ms while someone types in Notes).
// Re-reads therefore go through a validation memo (sanitize.js createValidationMemo): a record
// whose JSON is unchanged since it was last validated, and which that JSON describes exactly (not
// 1e309, which JSON.parse reads as Infinity), is not validated again; new and changed records always
// are. Backups are always validated in full.

import { COLLECTIONS, SETTINGS_DEFAULTS, validateItem, validateCollection, validateSettingsPatch, validateSnapshot, validateOp, isPlainObject, createValidationMemo } from './sanitize.js';
import { registerNoteSchemas } from '../notes/core/schema.js';

registerNoteSchemas(); // idempotent: schema.js already does this when it is first evaluated

const PREFIX = 'ecosys:v1:';
export { COLLECTIONS };

function detectWeekStart() {
  try {
    const loc = new Intl.Locale(navigator.language || 'en-US');
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {}
  return 0;
}

export const DEFAULT_SETTINGS = { ...SETTINGS_DEFAULTS, weekStart: detectWeekStart() };

function randomHex(n) {
  const b = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').slice(0, n);
}
/** 16 lowercase hex chars (works in insecure contexts too, where randomUUID is missing). */
export const uid = () => randomHex(16);
const tabId = uid(); // this page, for the messages it sends other tabs
const timeOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------- storage (localStorage or memory)

const mem = new Map(); // values that live only in memory: everything when storage is blocked, a failed settings write otherwise
const lastRaw = new Map(); // serialized value per key as last read/written by this tab
const unsaved = new Set(); // collections whose newest version only this tab's memory holds (localStorage could not take it)
const tooBig = new Map(); // collection → when a large write of it failed: not serialized again for a while
const BIG = 512 * 1024;
const RETRY_MS = 30000;

const storageOk = (() => {
  try {
    const k = `${PREFIX}__probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
})();
/** False when the browser blocks localStorage: data then lives in memory until the tab closes. */
export const storageAvailable = () => storageOk;
/** False while this tab's copy of collection `name` could not be saved in localStorage (it is kept in memory). */
export const cacheSaved = (name) => storageOk && !unsaved.has(name);

let lastSaveErrorAt = 0;
let lastPartialAt = 0;
/**
 * localStorage refused a write. What was written came from the ecosys server (`fromServer`: a state
 * load, a change made elsewhere), or sync is online and every change is on its way there: only the
 * offline copy is partial then, which is 'ecosys:offline-cache' ({partial, names}), not an error.
 * Otherwise 'ecosys:save-error' (detail: the error). Each at most once per 30 s, not once per keystroke.
 */
function reportSaveError(err, names, fromServer = false) {
  const t = Date.now();
  let safe = fromServer;
  try {
    safe ||= !!adapter?.safe?.();
  } catch {}
  if (safe) {
    if (t - lastPartialAt < 30000) return;
    lastPartialAt = t;
    window.dispatchEvent(new CustomEvent('ecosys:offline-cache', { detail: { partial: true, names: [...names] } }));
    return;
  }
  if (t - lastSaveErrorAt < 30000) return;
  lastSaveErrorAt = t;
  console.warn('ecosys: could not save to localStorage', err);
  window.dispatchEvent(new CustomEvent('ecosys:save-error', { detail: err }));
}

function getRaw(key) {
  if (mem.has(key)) return mem.get(key);
  if (!storageOk) return null;
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function setRaw(key, raw) {
  if (!storageOk) return void mem.set(key, raw);
  try {
    localStorage.setItem(PREFIX + key, raw);
    mem.delete(key);
  } catch (err) {
    mem.set(key, raw);
    reportSaveError(err, [key]);
  }
}

function removeRaw(key) {
  mem.delete(key);
  if (!storageOk) return;
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {}
}

function parse(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Save collections (and settings), each key on its own. A key that does not fit keeps its newest
 * version in this tab's memory (`unsaved`); nothing is rolled back by writing an older value again,
 * which every other tab would load. A large collection that did not fit is not serialized again for
 * RETRY_MS. Returns the names that could not be saved. `fromServer`: what is written is the server's
 * copy (see reportSaveError).
 */
function writeMany(names, { fromServer = false } = {}) {
  const failed = [];
  if (!storageOk) {
    for (const n of names) {
      const raw = JSON.stringify(n === 'settings' ? settingsCache : cache[n]);
      lastRaw.set(n, raw);
      mem.set(n, raw);
    }
    return failed;
  }
  let error = null;
  const t = Date.now();
  for (const n of names) {
    if (n !== 'settings' && t - (tooBig.get(n) ?? -Infinity) < RETRY_MS) {
      unsaved.add(n);
      failed.push(n);
      continue;
    }
    const raw = JSON.stringify(n === 'settings' ? settingsCache : cache[n]);
    try {
      if (localStorage.getItem(PREFIX + n) !== raw) localStorage.setItem(PREFIX + n, raw);
      lastRaw.set(n, raw);
      mem.delete(n);
      unsaved.delete(n);
      tooBig.delete(n);
    } catch (err) {
      error = err;
      failed.push(n);
      if (n === 'settings') mem.set(n, raw);
      else {
        unsaved.add(n);
        if (raw.length > BIG) tooBig.set(n, t);
      }
    }
  }
  if (error) reportSaveError(error, failed, fromServer);
  return failed;
}

// ---------------------------------------------------------------- cache

const cache = {};
let settingsCache = null;
const listeners = new Set();
let pending = null;
let batchDepth = 0;
const dirty = new Set();
// Records this page validated as they came in from storage or the server: only parsed JSON goes
// through it (a memo hit is the parsed object itself), never objects app code or the outbox still hold.
const memo = createValidationMemo();

function loadCollection(name, raw = getRaw(name)) {
  const parsed = parse(raw, []);
  cache[name] = validateCollection(name, Array.isArray(parsed) ? parsed : [], { memo }).items;
  lastRaw.set(name, raw);
  keepDeferred(name);
}

/** Keep edits that are still waiting for their deferred save. */
function keepDeferred(name) {
  for (const id of deferred.get(name) || []) {
    const mine = deferredItems.get(`${name}:${id}`);
    if (!mine) continue;
    const i = cache[name].findIndex((x) => x.id === id);
    if (i >= 0) cache[name][i] = mine;
    else cache[name].push(mine);
  }
}

/**
 * Another tab saved collection `name` while this tab holds a newer copy only in memory (it could not
 * be saved): per record, the newer version is kept, and records only this tab has stay.
 */
function mergeCollection(name, raw) {
  const parsed = parse(raw, []);
  const theirs = validateCollection(name, Array.isArray(parsed) ? parsed : [], { memo }).items;
  const mine = new Map(cache[name].map((x) => [x.id, x]));
  const seen = new Set();
  const out = [];
  for (const x of theirs) {
    const m = mine.get(x.id);
    out.push(m && timeOf(m.updatedAt) > timeOf(x.updatedAt) ? m : x);
    seen.add(x.id);
  }
  for (const m of cache[name]) if (!seen.has(m.id)) out.push(m);
  cache[name] = out;
  lastRaw.set(name, raw);
  keepDeferred(name);
}

function loadSettings(raw = getRaw('settings')) {
  settingsCache = { ...DEFAULT_SETTINGS, ...validateSettingsPatch(parse(raw, {})) };
  lastRaw.set('settings', raw);
}

function emit(names, remote = false) {
  if (!pending) {
    pending = { names: new Set(), remote: false };
    queueMicrotask(() => {
      const evt = pending;
      pending = null;
      for (const fn of listeners) {
        try {
          fn(evt);
        } catch (err) {
          console.error(err);
        }
      }
    });
  }
  for (const n of names) pending.names.add(n);
  pending.remote = pending.remote || remote;
}

const dispatchReplaced = (reason) => window.dispatchEvent(new CustomEvent('ecosys:data-replaced', { detail: { reason } }));

// ---------------------------------------------------------------- other tabs

// For what localStorage can't carry: changes to a collection this tab could not save, and a
// replace of everything when even the small 'replaced' key can't be written.
let channel = null;
try {
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel('ecosys-store');
    channel.unref?.(); // Node: an open channel must not keep the process alive
    channel.onmessage = (e) => onTabMessage(e.data);
  }
} catch {
  channel = null;
}

/**
 * Send the ops on collections this tab could not save to the other tabs (no `storage` event carries
 * them): 'local' edits of this tab, 'remote' changes from the server, or a 'state' reload (its
 * replaces are not an Erase everything, unless `reason` says so).
 */
function relay(type, ops, reason) {
  if (!channel) return;
  const out = ops.filter((o) => o && o.op !== 'settings' && unsaved.has(o.c));
  if (!out.length) return;
  try {
    channel.postMessage({ type, from: tabId, ops: out, ...(reason ? { reason } : {}) });
  } catch {}
}

function onTabMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.from === tabId) return;
  if (msg.type === 'replaced') return void dispatchReplaced(typeof msg.reason === 'string' ? msg.reason : 'remote');
  if (!Array.isArray(msg.ops)) return;
  if (msg.type === 'remote') applyRemoteOps(msg.ops, { relayed: true });
  else if (msg.type === 'state') {
    const routine = typeof msg.reason !== 'string' || msg.reason === 'sync';
    applyRemoteOps(msg.ops, { relayed: true, replaced: routine ? null : msg.reason, server: routine });
  }
  else if (msg.type === 'local') applyTabOps(msg.ops);
}

/**
 * Erase everything, start over or import replaced the data here: every tab of this browser drops its
 * undo history (and Notes its open editor), not only this one.
 */
function announceReplaced(reason) {
  dispatchReplaced(reason);
  let sent = false;
  if (storageOk) {
    try {
      localStorage.setItem(`${PREFIX}replaced`, JSON.stringify({ at: Date.now(), reason, tab: tabId }));
      sent = true;
    } catch {}
  }
  if (!sent) {
    try {
      channel?.postMessage({ type: 'replaced', from: tabId, reason });
    } catch {}
  }
}

// ---------------------------------------------------------------- ops (sync)

let adapter = null;
let opsMuted = 0;
let batchOps = [];
let batchPrevs = [];

/**
 * Register the sync adapter, or pass null to stop. Writes made while no adapter is registered are not
 * recorded. The adapter:
 *   push(ops, prevs)        record local ops; prevs[i] is the record op i changed, as it was before
 *   rebase(ops, {server})   local edits not confirmed yet, merged into these incoming ops' records
 *                           (server: they are the server's versions, so the edits now start from
 *                           them); returns ops to apply on top. Optional: without it, pending() is used
 *   pending()               ops not acknowledged yet, re-applied whole (older adapters)
 *   safe()                  true while every change reaches the server (a full localStorage is no loss)
 */
export function setSyncAdapter(a) {
  adapter = a && typeof a.push === 'function' ? a : null;
}

function record(op, prev) {
  if (opsMuted) return;
  if (batchDepth > 0) {
    batchOps.push(op);
    batchPrevs.push(prev);
  } else sendOps([op], [prev]);
}

/** A `replace` in a batch absorbs the other ops on that collection and carries its final contents. */
function finalizeOps(ops, prevs) {
  const replaced = new Set(ops.filter((o) => o.op === 'replace').map((o) => o.c));
  const out = [...replaced].map((c) => ({ op: 'replace', c, items: cache[c] }));
  const outPrevs = out.map(() => undefined);
  ops.forEach((o, i) => {
    if (o.c && replaced.has(o.c)) return;
    out.push(o);
    outPrevs.push(prevs[i]);
  });
  return { ops: out, prevs: outPrevs };
}

function sendOps(ops, prevs = []) {
  if (!ops.length) return;
  const final = finalizeOps(ops, prevs);
  relay('local', final.ops);
  if (!adapter) return;
  try {
    adapter.push(final.ops, final.prevs);
  } catch (err) {
    console.warn('ecosys: sync adapter failed', err);
  }
}

const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** Two lists of records with the same records, in the same order (compared one by one: stops at the first difference). */
function sameList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  return true;
}

/** Apply ops to the cache (no recording). Returns the names that actually changed. */
function applyToCache(ops, changed = new Set()) {
  for (const op of ops) {
    if (op.op === 'settings') {
      const next = { ...settingsCache, ...op.patch };
      if (!sameJson(next, settingsCache)) {
        settingsCache = next;
        changed.add('settings');
      }
      continue;
    }
    const list = cache[op.c];
    if (!list) continue;
    if (op.op === 'put') {
      const i = list.findIndex((x) => x.id === op.item.id);
      if (i >= 0 && sameJson(list[i], op.item)) continue;
      if (i >= 0) list[i] = op.item;
      else list.push(op.item);
      changed.add(op.c);
    } else if (op.op === 'del') {
      const i = list.findIndex((x) => x.id === op.id);
      if (i < 0) continue;
      list.splice(i, 1);
      changed.add(op.c);
    } else if (op.op === 'replace') {
      if (sameList(list, op.items)) continue;
      cache[op.c] = op.items.slice();
      changed.add(op.c);
    }
  }
  return changed;
}

/** Local ops the server hasn't confirmed yet (older adapters): re-applied whole on top of remote state. */
function localPending() {
  try {
    return adapter?.pending?.() || [];
  } catch {
    return [];
  }
}

/**
 * This tab's unconfirmed edits, merged into incoming `ops` (see setSyncAdapter), validated. `legacy`:
 * with an adapter that has no rebase(), its pending() ops are re-applied whole (the older behaviour,
 * for remote changes only).
 */
function rebaseOn(ops, server, { legacy = true } = {}) {
  if (!adapter) return [];
  if (typeof adapter.rebase !== 'function' && !legacy) return [];
  let mine;
  try {
    mine = typeof adapter.rebase === 'function' ? adapter.rebase(ops, { server }) : localPending();
  } catch (err) {
    console.warn('ecosys: could not keep local edits on top of a remote change', err);
    mine = [];
  }
  return (Array.isArray(mine) ? mine : []).map((o) => validateOp(o)).filter(Boolean);
}

/**
 * Reload collections another tab may have written since we last looked (cheap string compare), so a
 * remote op is applied on top of the newest local data. Returns the names that were reloaded: their
 * `storage` event will be skipped as already seen, so the caller must announce them. A collection
 * this tab holds unsaved is newer here than in localStorage, so it is not reloaded.
 */
function refreshFromStorage(names) {
  const reloaded = new Set();
  if (!storageOk) return reloaded;
  for (const n of names) {
    if (unsaved.has(n)) continue;
    const raw = getRaw(n);
    if (raw === lastRaw.get(n)) continue;
    if (n === 'settings') loadSettings(raw);
    else if (cache[n]) loadCollection(n, raw);
    reloaded.add(n);
  }
  return reloaded;
}

/**
 * Apply ops that came from the server (another device, an AI assistant…). Validates them, never
 * re-pushes them, saves to localStorage and notifies listeners with {remote:true}. A replace (Erase
 * everything or an import elsewhere) also dispatches `ecosys:data-replaced`, which clears undo history,
 * in every tab of this browser (the others hear it through localStorage or the BroadcastChannel, like
 * an Erase everything made here), so no tab's Ctrl+Z puts a record back into the erased data.
 * Returns the names of the collections that changed. (`relayed`: sent by another tab of this browser,
 * which tells the other tabs itself, so a replace is raised only here, once its data is in; `replaced`:
 * for a relayed state reload, the reason to announce, or null for a routine one; `server`: false when
 * the ops are not the server's versions, such as a local schema migration.)
 */
export function applyRemoteOps(ops, { relayed = false, replaced, server = true } = {}) {
  flushDeferred();
  const list = (Array.isArray(ops) ? ops : []).map((o) => validateOp(o, { memo })).filter(Boolean);
  if (!list.length) return [];
  const reloaded = refreshFromStorage(new Set(list.map((o) => (o.op === 'settings' ? 'settings' : o.c))));
  opsMuted++;
  let changed;
  try {
    changed = applyToCache(list);
    const mine = rebaseOn(list, server);
    if (mine.length) applyToCache(mine, changed);
  } finally {
    opsMuted--;
  }
  const names = [...changed];
  const announce = [...new Set([...names, ...reloaded])];
  if (announce.length) emit(announce, true);
  if (names.length) {
    writeMany(names, { fromServer: server });
    if (!relayed) relay('remote', list);
  }
  if (replaced !== undefined) {
    if (replaced && names.some((n) => n !== 'settings')) dispatchReplaced(replaced);
  } else if (list.some((o) => o.op === 'replace')) {
    if (relayed) dispatchReplaced('remote');
    else announceReplaced('remote');
  }
  return names;
}

/** Another tab's own edits to collections it could not save (see relay): applied here, never pushed. */
function applyTabOps(ops) {
  flushDeferred();
  const list = ops.map((o) => validateOp(o, { memo })).filter(Boolean);
  if (!list.length) return;
  opsMuted++;
  let changed;
  try {
    changed = applyToCache(list);
    const mine = rebaseOn(list, false, { legacy: false });
    if (mine.length) applyToCache(mine, changed);
  } finally {
    opsMuted--;
  }
  if (!changed.size) return;
  for (const n of changed) if (n !== 'settings') unsaved.add(n); // newer here than in localStorage now
  emit([...changed], true);
}

/**
 * Replace the whole state with a server snapshot ({data:{tasks,…}, settings} or a backup-shaped
 * object). Only collections present in the snapshot are replaced; unchanged ones are left alone.
 * Returns the changed names. A routine reload from the server (reason 'sync') is announced like any
 * remote change; any other reason also dispatches `ecosys:data-replaced`, which clears undo history.
 */
export function replaceAll(snapshot, { reason = 'sync' } = {}) {
  flushDeferred();
  const { data, settings: s } = validateSnapshot(snapshot, { memo });
  const hasSettings = isPlainObject(snapshot?.settings);
  // What came in, before this tab's own edits go on top (the cache lists are changed in place then).
  const state = COLLECTIONS.filter((c) => data[c]).map((c) => ({ op: 'replace', c, items: data[c].slice() }));
  if (hasSettings) state.push({ op: 'settings', patch: s });
  const changed = new Set();
  opsMuted++;
  try {
    for (const c of COLLECTIONS) {
      if (!data[c] || sameList(cache[c], data[c])) continue;
      cache[c] = data[c];
      changed.add(c);
    }
    if (hasSettings) {
      const next = { ...DEFAULT_SETTINGS, ...s };
      if (!sameJson(next, settingsCache)) {
        settingsCache = next;
        changed.add('settings');
      }
    }
    const mine = rebaseOn(state, reason === 'sync');
    if (mine.length) applyToCache(mine, changed);
  } finally {
    opsMuted--;
  }
  const names = [...changed];
  if (names.length) {
    writeMany(names, { fromServer: reason === 'sync' });
    // The server's versions, not this tab's view: the other tabs put their own edits on top.
    relay('state', state.filter((o) => o.op === 'replace' && changed.has(o.c)), reason);
    emit(names, true);
    if (reason !== 'sync' && names.some((n) => n !== 'settings')) dispatchReplaced(reason);
  }
  return names;
}

/** The full state in the server's shape: { data: {tasks,…,folders}, settings }. */
export function snapshot() {
  flushDeferred();
  return { data: Object.fromEntries(COLLECTIONS.map((n) => [n, cache[n]])), settings: settingsCache };
}

// ---------------------------------------------------------------- deferred saves

// db.update(name, id, patch, { defer: true }) changes the cache at once but saves, notifies and syncs
// ~300 ms later (or on the next normal write / when the page is hidden). For typing in text fields.
const deferred = new Map(); // name → Set(id)
const deferredItems = new Map(); // `${name}:${id}` → latest item
const deferredPrev = new Map(); // `${name}:${id}` → the record before the first of these edits
let deferTimer = null;

function takeDeferred() {
  if (!deferred.size) return null;
  clearTimeout(deferTimer);
  deferTimer = null;
  const names = [...deferred.keys()];
  const ops = [];
  const prevs = [];
  for (const [name, ids] of deferred) {
    for (const id of ids) {
      const item = cache[name].find((x) => x.id === id);
      if (!item) continue;
      ops.push({ op: 'put', c: name, item });
      prevs.push(deferredPrev.get(`${name}:${id}`));
    }
  }
  deferred.clear();
  deferredItems.clear();
  deferredPrev.clear();
  return { names, ops, prevs };
}

function flushDeferred() {
  const d = takeDeferred();
  if (!d) return;
  if (batchDepth > 0) {
    for (const n of d.names) dirty.add(n);
    if (!opsMuted) {
      batchOps.push(...d.ops);
      batchPrevs.push(...d.prevs);
    }
    return;
  }
  writeMany(d.names);
  emit(d.names);
  if (!opsMuted) sendOps(d.ops, d.prevs);
}

// ---------------------------------------------------------------- writes

function commit(name) {
  flushDeferred();
  if (batchDepth > 0) {
    dirty.add(name);
    return;
  }
  writeMany([name]);
  emit([name]);
}

const now = () => Date.now();

/** Sanitize a record written by app code. Invalid records are kept locally (and warned about) but never synced. */
function clean(name, obj) {
  const v = validateItem(name, obj);
  if (!v) console.warn(`ecosys: invalid ${name} record was not synced`, obj);
  return v;
}

function assertCollection(name) {
  // An own-collection check: cache.toString / cache.constructor exist on every object.
  if (!COLLECTIONS.includes(name)) throw new Error(`ecosys: unknown collection ${typeof name === 'string' ? `"${name.slice(0, 40)}"` : `(${typeof name})`}`);
}

export const db = {
  all(name) {
    return cache[name];
  },
  get(name, id) {
    return cache[name].find((x) => x.id === id) || null;
  },
  where(name, fn) {
    return cache[name].filter(fn);
  },
  insert(name, obj) {
    assertCollection(name);
    const t = now();
    const raw = { id: uid(), createdAt: t, ...obj, updatedAt: t };
    const v = clean(name, raw);
    const item = v || raw;
    const i = cache[name].findIndex((x) => x.id === item.id);
    const prev = i >= 0 ? cache[name][i] : undefined;
    if (i >= 0) cache[name][i] = item;
    else cache[name].push(item);
    commit(name);
    if (v) record({ op: 'put', c: name, item }, prev);
    return item;
  },
  /** Insert or fully replace an item by id (used for undo). Keeps the item's timestamps. */
  put(name, obj) {
    assertCollection(name);
    const v = clean(name, obj);
    const item = v || obj;
    const i = cache[name].findIndex((x) => x.id === item.id);
    const prev = i >= 0 ? cache[name][i] : undefined;
    if (i >= 0) cache[name][i] = item;
    else cache[name].push(item);
    commit(name);
    if (v) record({ op: 'put', c: name, item }, prev);
    return item;
  },
  /** Merge a patch (object or fn(prev) → object). opts.defer batches rapid edits (typing) into one save. */
  update(name, id, patch, opts) {
    assertCollection(name);
    const i = cache[name].findIndex((x) => x.id === id);
    if (i < 0) return null;
    const prev = cache[name][i];
    const raw = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch), id: prev.id, updatedAt: now() };
    const v = clean(name, raw);
    const next = v || raw;
    cache[name][i] = next;
    if (opts?.defer && v) {
      const key = `${name}:${id}`;
      if (!deferred.has(name)) deferred.set(name, new Set());
      deferred.get(name).add(id);
      deferredItems.set(key, next);
      if (!deferredPrev.has(key)) deferredPrev.set(key, prev);
      clearTimeout(deferTimer);
      deferTimer = setTimeout(flushDeferred, 300);
      return next;
    }
    commit(name);
    if (v) record({ op: 'put', c: name, item: next }, prev);
    return next;
  },
  remove(name, id) {
    assertCollection(name);
    const i = cache[name].findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [item] = cache[name].splice(i, 1);
    deferred.get(name)?.delete(id);
    deferredItems.delete(`${name}:${id}`);
    const before = deferredPrev.get(`${name}:${id}`);
    deferredPrev.delete(`${name}:${id}`);
    commit(name);
    record({ op: 'del', c: name, id }, before || item);
    return item;
  },
  /** Group several writes into one save + one change notification + one sync push. */
  batch(fn) {
    batchDepth++;
    try {
      return fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0) {
        const names = [...dirty];
        dirty.clear();
        const ops = batchOps;
        const prevs = batchPrevs;
        batchOps = [];
        batchPrevs = [];
        if (names.length) {
          writeMany(names);
          emit(names);
        }
        sendOps(ops, prevs);
      }
    }
  },
  /** Save deferred edits now (e.g. when a text field loses focus). */
  flush() {
    flushDeferred();
  },
  /** Subscribe to changes. fn({names:Set<string>, remote:boolean}). Returns an unsubscribe function. */
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export const settings = {
  get() {
    return settingsCache;
  },
  /** Merge a patch. Values are type-checked; unknown keys are ignored unless app-prefixed (see sanitize.js). */
  set(patch) {
    const valid = validateSettingsPatch(patch);
    const ignored = isPlainObject(patch) ? Object.keys(patch).filter((k) => !(k in valid)) : [];
    if (ignored.length) console.warn('ecosys: ignored invalid settings', ignored);
    if (!Object.keys(valid).length) return settingsCache;
    settingsCache = { ...settingsCache, ...valid };
    commit('settings');
    record({ op: 'settings', patch: valid });
    return settingsCache;
  },
};

/** Put every setting back to its default (keeps data). */
export function resetSettings() {
  settingsCache = { ...DEFAULT_SETTINGS };
  commit('settings');
  record({ op: 'settings', patch: settingsCache });
}

// ---------------------------------------------------------------- backup / restore

export function exportData() {
  flushDeferred();
  return {
    app: 'ecosys',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: settingsCache,
    ...Object.fromEntries(COLLECTIONS.map((n) => [n, cache[n]])),
  };
}

/**
 * Restore a backup. Every record is validated and sanitized (sanitize.js); collections missing from
 * the file are kept. Returns { counts: {collection: n}, dropped } so the UI can report skipped records.
 */
export function importData(data) {
  if (!isPlainObject(data) || data.app !== 'ecosys') throw new Error('This file is not an ecosys backup.');
  const { data: cols, settings: s, dropped, counts } = validateSnapshot(data); // in full, without the memo
  const hasSettings = isPlainObject(data.settings);
  if (!Object.keys(cols).length && !hasSettings) throw new Error('This backup has no tasks, events, notes or settings.');
  flushDeferred();
  db.batch(() => {
    for (const [c, items] of Object.entries(cols)) {
      cache[c] = items;
      dirty.add(c);
      record({ op: 'replace', c, items });
    }
    if (hasSettings) {
      settingsCache = { ...DEFAULT_SETTINGS, ...s };
      dirty.add('settings');
      record({ op: 'settings', patch: settingsCache });
    }
    ensureDefaults();
  });
  announceReplaced('import');
  return { counts, dropped };
}

/** Erase everything (tasks, lists, events, calendars, notes, folders), optionally loading the samples. */
export function resetData({ withSamples = false, settings: alsoSettings = false } = {}) {
  flushDeferred();
  const t = now();
  db.batch(() => {
    for (const n of COLLECTIONS) {
      cache[n] = [];
      dirty.add(n);
      record({ op: 'replace', c: n, items: [] });
    }
    if (alsoSettings) {
      settingsCache = { ...DEFAULT_SETTINGS };
      dirty.add('settings');
      record({ op: 'settings', patch: settingsCache });
    }
    if (withSamples && seeder) seeder(db);
    ensureDefaults();
  });
  setRaw('seeded', String(t));
  rememberSamples(); // everything there now is sample or default data
  announceReplaced(withSamples ? 'samples' : 'erase');
  // The notes' version history (IndexedDB `ecosys`, notes/history/revisions.js) holds copies of the
  // notes just erased: delete it too, whichever app the erase came from. An open notes tab does not
  // block this (it closes its connection on `versionchange`), and history starts again when needed.
  try {
    globalThis.indexedDB?.deleteDatabase('ecosys');
  } catch {} // no IndexedDB here (some private modes, sandboxed frames): nothing to delete
}

/** Remember which records are the sample / default data just created (see sampleIds): all but `before`'s. */
function rememberSamples(before = null) {
  const ids = Object.fromEntries(COLLECTIONS.map((c) => [c, cache[c].filter((x) => !before?.has(`${c}:${x.id}`)).map((x) => x.id)]));
  setRaw('samples', JSON.stringify(ids));
}
const recordKeys = () => new Set(COLLECTIONS.flatMap((c) => cache[c].map((x) => `${c}:${x.id}`)));

/**
 * The records this device created as sample / default data, as a Set of "collection:id", or null
 * when that is not known (data seeded by an older version: see seededAt). One of them that was never
 * edited (createdAt === updatedAt) is an untouched sample.
 */
export function sampleIds() {
  const v = parse(getRaw('samples'), null);
  if (!isPlainObject(v)) return null;
  const out = new Set();
  for (const c of COLLECTIONS) if (Array.isArray(v[c])) for (const id of v[c]) if (typeof id === 'string') out.add(`${c}:${id}`);
  return out;
}

/**
 * When this device's sample / default data was created (ms), or null if unknown. Records created at
 * that moment and never edited (createdAt === updatedAt) are untouched samples. Older versions stored
 * '1'; then the earliest createdAt is used.
 */
export function seededAt() {
  const raw = getRaw('seeded');
  if (raw && /^\d{12,}$/.test(raw)) return Number(raw);
  if (!raw || raw === 'user') return null;
  let min = Infinity;
  for (const n of COLLECTIONS) for (const x of cache[n]) if (Number.isFinite(x.createdAt) && x.createdAt < min) min = x.createdAt;
  return Number.isFinite(min) ? min : null;
}

// ---------------------------------------------------------------- first run

let seeder = null;
/** Apps register the sample-data builder (kept in seed.js so the store stays small). */
export function registerSeeder(fn) {
  seeder = fn;
}

function ensureDefaults() {
  db.batch(() => {
    if (!cache.calendars.length) {
      db.insert('calendars', { name: 'Personal', color: 'iris', visible: true, order: 0 });
      db.insert('calendars', { name: 'Work', color: 'blue', visible: true, order: 1 });
    }
    if (!cache.lists.length) {
      db.insert('lists', { name: 'Personal', color: 'iris', order: 0 });
      db.insert('lists', { name: 'Work', color: 'blue', order: 1 });
    }
  });
}

/**
 * First run on this device: load the sample data (or just the default lists and calendars).
 * Not synced — if a server already has data, sync replaces this; if it is new, sync imports it.
 */
export function seedIfEmpty(force = false) {
  const seeded = getRaw('seeded');
  if (seeded && !force) return;
  const empty = COLLECTIONS.every((n) => !cache[n].length);
  if (!empty && !force) {
    setRaw('seeded', 'user'); // data was already here: none of it is sample data
    removeRaw('samples');
    return;
  }
  const t = now();
  const before = recordKeys();
  opsMuted++;
  try {
    if (seeder) db.batch(() => seeder(db));
    ensureDefaults();
  } finally {
    opsMuted--;
  }
  setRaw('seeded', String(t));
  rememberSamples(before);
}

// ---------------------------------------------------------------- init

for (const n of COLLECTIONS) loadCollection(n);
loadSettings();

if (storageOk) {
  window.addEventListener('storage', (e) => {
    if (e.storageArea !== localStorage) return;
    if (e.key === null) {
      // Another page on this origin called localStorage.clear(). Keep our copy and write it back
      // (Settings > Erase is the way to delete data; it never clears storage like this).
      lastRaw.clear();
      writeMany([...COLLECTIONS, 'settings']);
      setRaw('seeded', 'user');
      window.dispatchEvent(new CustomEvent('ecosys:storage-restored'));
      return;
    }
    if (!e.key.startsWith(PREFIX)) return;
    const name = e.key.slice(PREFIX.length);
    if (name === 'replaced') {
      // Another tab erased, started over or imported: its undo history is not this tab's to keep either.
      const v = parse(e.newValue, null);
      if (isPlainObject(v) && v.tab !== tabId) dispatchReplaced(typeof v.reason === 'string' ? v.reason : 'remote');
      return;
    }
    if (!COLLECTIONS.includes(name) && name !== 'settings') return;
    if (e.newValue === null) {
      writeMany([name]); // removed by something else: restore ours
      return;
    }
    mem.delete(name);
    if (e.newValue === lastRaw.get(name)) return;
    if (name === 'settings') loadSettings(e.newValue);
    else if (unsaved.has(name)) mergeCollection(name, e.newValue);
    else {
      loadCollection(name, e.newValue);
      // This tab's own unconfirmed edits stay on top of the other tab's copy.
      opsMuted++;
      try {
        const mine = rebaseOn([{ op: 'replace', c: name, items: cache[name] }], false, { legacy: false });
        if (mine.length) applyToCache(mine);
      } finally {
        opsMuted--;
      }
    }
    emit([name], true);
  });
  // Don't lose a deferred edit when the tab is closed or hidden.
}
if (typeof document !== 'undefined') {
  window.addEventListener('pagehide', flushDeferred);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDeferred();
  });
}
