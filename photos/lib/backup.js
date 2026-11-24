// Cloud backup, the Samsung Gallery way: connect OneDrive or Google Drive once, and every photo and video
// is copied into a folder of its own there ("ecosys Photos", sorted into year and month folders), newest
// first, whenever Photos is open. Deleting a photo for good moves its cloud copy to the provider's recycle
// bin too (a setting). "Free up space" removes originals that are safe in the cloud, keeping previews;
// opening one downloads it again. "Restore" brings a cloud folder's photos into a new browser or device.
//
// One tab backs up at a time (a Web Lock), and the others follow its progress through the library's
// change events.

import * as lib from './library.js';
import * as oauth from './oauth.js';
import { makeProvider, CloudError } from './providers.js';
import { importFromCloud, isVideoType } from './media.js';

export const DEFAULTS = { provider: null, folderName: 'ecosys Photos', auto: true, syncDeletes: true, includeVideos: true, account: null, rootId: null, folders: {}, lastRunAt: null, lastError: null };

const status = { state: 'off', done: 0, total: 0, current: '', error: '' };
const listeners = new Set();
let running = false;
let stopAsked = false;

export const getStatus = () => ({ ...status });
export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(patch) {
  Object.assign(status, patch);
  for (const fn of listeners) fn(getStatus());
}

export async function getConfig() {
  return { ...DEFAULTS, ...((await lib.kvGet('backup')) || {}) };
}
export async function setConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  await lib.kvSet('backup', next);
  return next;
}

export function provider(id) {
  return makeProvider(id, { token: (force) => oauth.accessToken(id, { force }) });
}

const pad = (n) => String(n).padStart(2, '0');
const folderKey = (t) => {
  const d = new Date(t);
  return [String(d.getFullYear()), pad(d.getMonth() + 1)];
};

/** What still needs to go up, newest first. */
export function queue(cfg, photos = lib.allPhotos()) {
  if (!cfg.provider) return [];
  return photos
    .filter((p) => !p.deletedAt && p.local !== false && (!p.cloud || p.cloud.provider !== cfg.provider) && (cfg.includeVideos || !isVideoType(p.type)))
    .sort((a, b) => b.takenAt - a.takenAt);
}

/** Counts for the status line: backed up, waiting, only in the cloud. */
export function counts(cfg, photos = lib.allPhotos()) {
  const live = photos.filter((p) => !p.deletedAt);
  const safe = live.filter((p) => p.cloud && p.cloud.provider === cfg.provider);
  return {
    total: live.length,
    backedUp: safe.length,
    waiting: queue(cfg, photos).length,
    cloudOnly: live.filter((p) => p.local === false).length,
    freeable: safe.filter((p) => p.local !== false),
  };
}

/** Called once the sign-in came back: who is signed in, and the backup folder. */
export async function finishConnect() {
  const cfg = await getConfig();
  if (!cfg.provider) return cfg;
  const p = provider(cfg.provider);
  const account = await p.account();
  const rootId = await p.folder([cfg.folderName]);
  const next = await setConfig({ account, rootId, folders: {}, lastError: null });
  setStatus({ state: 'idle', error: '' });
  return next;
}

/** Disconnect: the tokens are forgotten. What is already in the cloud stays there. */
export async function disconnect() {
  const cfg = await getConfig();
  stopAsked = true;
  if (cfg.provider) await oauth.forgetTokens(cfg.provider);
  await setConfig({ provider: null, account: null, rootId: null, folders: {}, lastError: null });
  setStatus({ state: 'off', done: 0, total: 0, current: '', error: '' });
}

export function stop() {
  stopAsked = true;
}

/**
 * Back up everything that's waiting. Returns quietly when another tab is already doing it, nothing
 * is connected, or the browser is offline.
 */
export async function run({ reason = 'auto' } = {}) {
  if (running) return;
  const cfg = await getConfig();
  if (!cfg.provider) return setStatus({ state: 'off' });
  if (reason === 'auto' && !cfg.auto) return setStatus({ state: 'paused', total: queue(cfg).length });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return setStatus({ state: 'offline' });
  const work = () => runLocked(cfg);
  if (navigator.locks?.request) {
    await navigator.locks.request('ecosys-photos-backup', { ifAvailable: true }, (lock) => (lock ? work() : null));
  } else await work();
}

async function runLocked(cfg) {
  running = true;
  stopAsked = false;
  const p = provider(cfg.provider);
  let failures = 0;
  try {
    await processDeletes(p, cfg);
    let items = queue(cfg);
    setStatus({ state: items.length ? 'running' : 'idle', done: 0, total: items.length, current: '', error: '' });
    let done = 0;
    while (items.length && !stopAsked) {
      const ph = items.shift();
      const fresh = lib.getPhoto(ph.id);
      if (!fresh || fresh.deletedAt || (fresh.cloud && fresh.cloud.provider === cfg.provider)) continue;
      setStatus({ current: fresh.name });
      try {
        const blob = await lib.getOriginal(fresh.id);
        if (!blob) {
          // Only in another provider's cloud (backed up before a switch): nothing to send from here.
          done++;
          continue;
        }
        const parent = await folderFor(p, cfg, fresh.takenAt);
        const item = await p.upload(parent, blob, { name: fresh.name, mime: fresh.type, takenAt: fresh.takenAt, photoId: fresh.id });
        await lib.updatePhotos([fresh.id], { cloud: { provider: cfg.provider, id: item.id, at: Date.now() } });
        done++;
        setStatus({ done });
      } catch (err) {
        if (err.code === 'throttled') {
          items.unshift(ph);
          await new Promise((r) => setTimeout(r, (err.retryAfter || 5) * 1000));
          continue;
        }
        if (err.status === 404 && /folder|parent|item/i.test(err.message || '')) cfg.folders = {}; // folder removed in the cloud: make it again
        if (err.code === 'reauth' || err.code === 'offline' || err.code === 'full') throw err;
        if (++failures >= 5) throw err;
        console.warn('ecosys photos: backup of', fresh.name, 'failed:', err);
      }
      // New photos imported while backing up join the queue.
      if (!items.length) items = queue(cfg).filter((x) => x.id !== fresh.id);
      if (items.length + done > status.total) setStatus({ total: items.length + done });
    }
    await setConfig({ lastRunAt: Date.now(), lastError: null, folders: cfg.folders });
    setStatus({ state: stopAsked ? 'paused' : 'idle', current: '', error: '' });
  } catch (err) {
    const state = err.code === 'reauth' ? 'reauth' : err.code === 'offline' ? 'offline' : 'error';
    await setConfig({ lastError: err.message || String(err), folders: cfg.folders }).catch(() => {});
    setStatus({ state, current: '', error: err.message || String(err) });
  } finally {
    running = false;
  }
}

async function folderFor(p, cfg, takenAt) {
  const [y, m] = folderKey(takenAt || Date.now());
  const key = `${y}/${m}`;
  if (!cfg.folders[key]) cfg.folders[key] = await p.folder([cfg.folderName, y, m]);
  return cfg.folders[key];
}

// ---------------------------------------------------------------- deletes

/** Queue the cloud copies of photos deleted for good (when the setting is on), then send them. */
export async function forgetInCloud(photos) {
  const cfg = await getConfig();
  if (!cfg.syncDeletes) return;
  const list = (await lib.kvGet('cloudDeletes')) || [];
  for (const ph of photos) if (ph.cloud?.id) list.push({ provider: ph.cloud.provider, id: ph.cloud.id });
  await lib.kvSet('cloudDeletes', list, { quiet: true });
  if (cfg.provider && !running) {
    try {
      await processDeletes(provider(cfg.provider), cfg);
    } catch {
      /* tried again on the next backup */
    }
  }
}

async function processDeletes(p, cfg) {
  const list = (await lib.kvGet('cloudDeletes')) || [];
  if (!list.length) return;
  const left = [];
  for (const d of list) {
    if (d.provider !== cfg.provider) continue; // that cloud isn't connected any more: nothing to do there
    try {
      await p.remove(d.id);
    } catch (err) {
      left.push(d);
      if (err.code === 'reauth' || err.code === 'offline') {
        left.push(...list.slice(list.indexOf(d) + 1).filter((x) => x.provider === cfg.provider));
        break;
      }
    }
  }
  await lib.kvSet('cloudDeletes', left, { quiet: true });
}

// ---------------------------------------------------------------- free up space, open, restore

/** Remove the originals of photos that are safe in the connected cloud. Returns { count, bytes }. */
export async function freeUpSpace() {
  const cfg = await getConfig();
  const ids = counts(cfg).freeable;
  const bytes = ids.reduce((n, p) => n + (p.size || 0), 0);
  await lib.dropOriginals(ids.map((p) => p.id));
  return { count: ids.length, bytes };
}

/** The original file: from this device, or downloaded from the cloud (not kept unless `keep`). */
export async function original(photo, { keep = false } = {}) {
  const local = await lib.getOriginal(photo.id);
  if (local) return local;
  if (!photo.cloud) return null;
  const blob = await provider(photo.cloud.provider).download(photo.cloud.id);
  const typed = blob.type ? blob : new Blob([blob], { type: photo.type });
  if (keep) {
    await lib.putOriginal(photo.id, typed);
    await lib.updatePhotos([photo.id], { local: true });
  }
  return typed;
}

/** Download originals back to this device (undo "Free up space"). onProgress(done, total). */
export async function downloadAll(onProgress) {
  const list = lib.allPhotos().filter((p) => p.local === false && p.cloud && !p.deletedAt);
  let n = 0;
  for (const p of list) {
    await original(p, { keep: true });
    onProgress?.(++n, list.length);
  }
  return n;
}

/**
 * Bring photos from the backup folder that this library doesn't have (a new browser, another computer).
 * Only previews are kept; originals download when opened. onProgress({ done, total, phase }).
 */
export async function restore(onProgress) {
  const cfg = await getConfig();
  if (!cfg.provider || !cfg.rootId) throw new CloudError('Connect a cloud first.');
  const p = provider(cfg.provider);
  onProgress?.({ done: 0, total: 0, phase: 'list' });
  const items = await p.list(cfg.rootId);
  const known = new Set(lib.allPhotos().filter((x) => x.cloud?.provider === cfg.provider).map((x) => x.cloud.id));
  const ids = new Set(lib.allPhotos().map((x) => x.id));
  const fresh = items.filter((it) => !known.has(it.id) && !(it.photoId && ids.has(it.photoId)));
  let done = 0;
  let added = 0;
  for (const it of fresh) {
    try {
      const blob = await p.download(it.id);
      const r = await importFromCloud(blob, { name: it.name, takenAt: it.takenAt, cloud: { provider: cfg.provider, id: it.id, at: Date.now() } });
      if (!r.duplicate) added++;
    } catch (err) {
      if (err.code === 'reauth' || err.code === 'offline') throw err;
      console.warn('ecosys photos: could not restore', it.name, err);
    }
    onProgress?.({ done: ++done, total: fresh.length, phase: 'download' });
  }
  return { found: items.length, added };
}

export { CloudError };
