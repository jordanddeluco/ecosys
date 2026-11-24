// The photo library on this device: IndexedDB, because photos are far too big for localStorage.
//
//   photos  metadata for every photo and video (kept in memory too: it is small and every view filters it)
//   blobs   the original files, by photo id. Missing once "Free up space" removed an original that is safe
//           in the cloud: the photo is then shown from its preview and downloaded when opened.
//   thumbs  a ~480px JPEG preview of each item, used by the grids
//   albums  { id, name, createdAt, coverId }
//   kv      settings, cloud backup state and sign-in tokens
//
// Other tabs hear about every change through a BroadcastChannel, as the other apps do through `storage`.

const DB_NAME = 'ecosys-photos';
const DB_VERSION = 1;
export const TRASH_DAYS = 30;

let dbp = null;
const listeners = new Set();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ecosys-photos') : null;
channel?.unref?.(); // Node (the tests): don't keep the process alive
const photos = new Map();
const albums = new Map();
let loaded = null;

export const uid = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const ph = db.createObjectStore('photos', { keyPath: 'id' });
      ph.createIndex('hash', 'hash');
      db.createObjectStore('blobs');
      db.createObjectStore('thumbs');
      db.createObjectStore('albums', { keyPath: 'id' });
      db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The photo library is open in an older tab. Close it and try again.'));
  });
  return dbp;
}

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
const result = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const out = fn(...[stores].flat().map((s) => t.objectStore(s)));
  await done(t);
  return out instanceof IDBRequest ? out.result : out;
}

// ---------------------------------------------------------------- loading & change events

/** Load the metadata once per page. Later calls return the same promise. */
export function load() {
  loaded ??= reload();
  return loaded;
}

async function reload() {
  const db = await open();
  const t = db.transaction(['photos', 'albums'], 'readonly');
  const [ps, as] = await Promise.all([result(t.objectStore('photos').getAll()), result(t.objectStore('albums').getAll())]);
  photos.clear();
  albums.clear();
  for (const p of ps) photos.set(p.id, p);
  for (const a of as) albums.set(a.id, a);
}

/** fn({ photos:boolean, albums:boolean, kv:boolean, remote:boolean }) after any change, here or in another tab. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(what, remote = false) {
  for (const fn of listeners) {
    try {
      fn({ ...what, remote });
    } catch (err) {
      console.error('ecosys photos:', err);
    }
  }
  if (!remote) channel?.postMessage(what);
}

channel?.addEventListener('message', async (e) => {
  await reload();
  emit(e.data || {}, true);
});

// ---------------------------------------------------------------- photos

export const allPhotos = () => [...photos.values()];
export const getPhoto = (id) => photos.get(id) || null;
export const findByHash = (hash) => allPhotos().find((p) => p.hash === hash) || null;
export const findByCloudId = (cloudId) => allPhotos().find((p) => p.cloud?.id === cloudId) || null;

/** Add a new item with its original and preview. */
export async function addPhoto(meta, original, thumb) {
  await tx(['photos', 'blobs', 'thumbs'], 'readwrite', (ps, bs, ts) => {
    ps.put(meta);
    if (original) bs.put(original, meta.id);
    if (thumb) ts.put(thumb, meta.id);
  });
  photos.set(meta.id, meta);
  emit({ photos: true });
  return meta;
}

/** Shallow-merge `patch` into each photo. `patch` may be a function of the photo. */
export async function updatePhotos(ids, patch, { quiet = false } = {}) {
  const changed = [];
  await tx('photos', 'readwrite', (ps) => {
    for (const id of ids) {
      const p = photos.get(id);
      if (!p) continue;
      const next = { ...p, ...(typeof patch === 'function' ? patch(p) : patch) };
      ps.put(next);
      changed.push(next);
    }
  });
  for (const p of changed) photos.set(p.id, p);
  if (changed.length && !quiet) emit({ photos: true });
  return changed;
}

/** Remove photos for good: metadata, original and preview. */
export async function deletePhotos(ids) {
  await tx(['photos', 'blobs', 'thumbs'], 'readwrite', (ps, bs, ts) => {
    for (const id of ids) {
      ps.delete(id);
      bs.delete(id);
      ts.delete(id);
    }
  });
  for (const id of ids) photos.delete(id);
  let covers = false;
  for (const a of albums.values()) if (ids.includes(a.coverId)) covers = true;
  emit({ photos: true, albums: covers });
}

export const getOriginal = (id) => tx('blobs', 'readonly', (s) => s.get(id));
export const getThumb = (id) => tx('thumbs', 'readonly', (s) => s.get(id));

export async function putOriginal(id, blob) {
  await tx('blobs', 'readwrite', (s) => s.put(blob, id));
}

/** Drop the originals (they are safe in the cloud); the previews stay. */
export async function dropOriginals(ids) {
  await tx('blobs', 'readwrite', (s) => {
    for (const id of ids) s.delete(id);
  });
  return updatePhotos(ids, { local: false });
}

// ---------------------------------------------------------------- albums

export const allAlbums = () => [...albums.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
export const getAlbum = (id) => albums.get(id) || null;

export async function saveAlbum(album) {
  await tx('albums', 'readwrite', (s) => s.put(album));
  albums.set(album.id, album);
  emit({ albums: true });
  return album;
}

export async function deleteAlbum(id) {
  await tx('albums', 'readwrite', (s) => s.delete(id));
  albums.delete(id);
  const members = allPhotos().filter((p) => p.albumIds?.includes(id));
  if (members.length) await updatePhotos(members.map((p) => p.id), (p) => ({ albumIds: p.albumIds.filter((a) => a !== id) }), { quiet: true });
  emit({ albums: true, photos: members.length > 0 });
}

// ---------------------------------------------------------------- key/value

export const kvGet = (key) => tx('kv', 'readonly', (s) => s.get(key));
export async function kvSet(key, value, { quiet = false } = {}) {
  await tx('kv', 'readwrite', (s) => (value === undefined ? s.delete(key) : s.put(value, key)));
  if (!quiet) emit({ kv: true, key });
}

// ---------------------------------------------------------------- housekeeping

/** Photos in Recently deleted longer than TRASH_DAYS. */
export function expiredTrash(now = Date.now()) {
  const limit = now - TRASH_DAYS * 86400000;
  return allPhotos().filter((p) => p.deletedAt && p.deletedAt < limit);
}

/** Ask the browser not to evict the library under storage pressure (granted silently or not at all). */
export async function persistStorage() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist?.();
  } catch {}
}

export async function storageEstimate() {
  try {
    return (await navigator.storage?.estimate?.()) || null;
  } catch {
    return null;
  }
}
