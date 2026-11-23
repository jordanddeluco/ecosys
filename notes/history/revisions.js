// notes version history — snapshots of a note's blocks in IndexedDB (database `ecosys`, store
// `noteRevisions`), so history never eats into the ~5 MB localStorage budget the notes live in.
//
//   historyAvailable()                → Promise<boolean>   (false in some private modes / old browsers)
//   snapshot(note, {by, blocks, reason, force}) → Promise<record|null>   (skips a copy of the latest one)
//   listRevisions(noteId)             → Promise<record[]>  newest first
//   getRevision(id)                   → Promise<record|null>
//   latestRevision(noteId)            → Promise<record|null>
//   deleteRevisions(noteId)           → Promise<void>
//   purgeOrphans(liveIds:Set)         → Promise<number>    (revisions of notes that no longer exist)
//   enforceBudget()                   → Promise<void>      (50 MB across all notes, oldest thinned first)
//
// Record: { id, noteId, at, by, rev, title, blocks, size, hash, reason }. Each note keeps everything from
// the last 24 hours, then the last snapshot of each day (1–30 days), of each week (30–180 days) and of
// each month after that, at most 100 per note.

const DB_NAME = 'ecosys';
const DB_VERSION = 1;
const STORE = 'noteRevisions';
const PER_NOTE = 100;
const TOTAL_BYTES = 50 * 1024 * 1024;
const DAY = 86400000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('byNote', ['noteId', 'at']);
        s.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the database (a later version adds stores) must not be blocked by us.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** True when snapshots can be stored in this browser (IndexedDB opens). */
export async function historyAvailable() {
  return !!(await openDb());
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let out;
    let t;
    try {
      t = db.transaction(STORE, mode);
    } catch (err) {
      return reject(err);
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    out = fn(t.objectStore(STORE));
  });
}

const reqP = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** FNV-1a over the JSON: cheap and good enough to skip identical snapshots. */
function hashOf(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + str.length.toString(36);
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

function titleOf(blocks, fallback = '') {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const t = Array.isArray(b?.c) ? b.c.map((r) => (Array.isArray(r) && typeof r[0] === 'string' ? r[0] : '')).join('') : '';
    const s = t.replace(/\s+/g, ' ').trim();
    if (s) return s.slice(0, 120);
  }
  return String(fallback || '').slice(0, 120);
}

async function byNote(db, noteId) {
  return tx(db, 'readonly', (s) => reqP(s.index('byNote').getAll(IDBKeyRange.bound([noteId, -Infinity], [noteId, Infinity]))));
}

/** All snapshots of a note, newest first (with their blocks). */
export async function listRevisions(noteId) {
  const db = await openDb();
  if (!db || typeof noteId !== 'string') return [];
  try {
    const list = await byNote(db, noteId);
    return (Array.isArray(list) ? list : []).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function latestRevision(noteId) {
  return (await listRevisions(noteId))[0] || null;
}

export async function getRevision(id) {
  const db = await openDb();
  if (!db || typeof id !== 'string') return null;
  try {
    return (await tx(db, 'readonly', (s) => reqP(s.get(id)))) || null;
  } catch {
    return null;
  }
}

/** Which snapshots to keep (see the header): returns the ids to delete. */
function thinPlan(list, now = Date.now()) {
  const sorted = [...list].sort((a, b) => b.at - a.at);
  const keep = new Set();
  const seen = new Set();
  for (const r of sorted) {
    const age = now - r.at;
    if (age < DAY) {
      keep.add(r.id);
      continue;
    }
    const d = new Date(r.at);
    let bucket;
    if (age < 30 * DAY) bucket = `d${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    else if (age < 180 * DAY) bucket = `w${Math.floor((r.at - d.getTimezoneOffset() * 60000) / (7 * DAY))}`;
    else bucket = `m${d.getFullYear()}-${d.getMonth()}`;
    if (seen.has(bucket)) continue; // newest first: the first one seen is the last of its bucket
    seen.add(bucket);
    keep.add(r.id);
  }
  const kept = sorted.filter((r) => keep.has(r.id)).slice(0, PER_NOTE);
  const keepIds = new Set(kept.map((r) => r.id));
  return sorted.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
}

/**
 * Store a snapshot of `blocks` (default: note.blocks). Skips it when it matches the latest snapshot.
 * opts.by: 'user' | 'mcp:claude' …; opts.reason: 'idle' | 'session' | 'ai' | 'restore' | 'bulk' | 'remote'.
 */
export async function snapshot(note, { by, blocks, reason = '', force = false } = {}) {
  const db = await openDb();
  if (!db || !note || typeof note.id !== 'string') return null;
  const bl = Array.isArray(blocks) ? blocks : Array.isArray(note.blocks) ? note.blocks : [];
  let json;
  try {
    json = JSON.stringify(bl);
  } catch {
    return null;
  }
  const hash = hashOf(json);
  try {
    const list = await byNote(db, note.id);
    const latest = (Array.isArray(list) ? list : []).sort((a, b) => b.at - a.at)[0];
    if (!force && latest && latest.hash === hash) return null;
    const rec = {
      id: randomId(),
      noteId: note.id,
      at: Date.now(),
      by: typeof by === 'string' && by ? by.slice(0, 40) : typeof note.editedBy === 'string' ? note.editedBy : 'user',
      rev: Number.isFinite(note.rev) ? note.rev : 0,
      title: titleOf(bl, note.title),
      blocks: JSON.parse(json),
      size: json.length,
      hash,
      reason: String(reason).slice(0, 20),
    };
    const drop = thinPlan([...(list || []), rec]);
    await tx(db, 'readwrite', (s) => {
      s.put(rec);
      for (const id of drop) s.delete(id);
    });
    return rec;
  } catch {
    return null;
  }
}

export async function deleteRevisions(noteId) {
  const db = await openDb();
  if (!db || typeof noteId !== 'string') return;
  try {
    const list = await byNote(db, noteId);
    if (!list?.length) return;
    await tx(db, 'readwrite', (s) => {
      for (const r of list) s.delete(r.id);
    });
  } catch {
    /* best effort */
  }
}

/** Remove the snapshots of notes that no longer exist (purged from Recently Deleted). */
export async function purgeOrphans(liveIds) {
  const db = await openDb();
  if (!db || !(liveIds instanceof Set)) return 0;
  try {
    let removed = 0;
    await tx(db, 'readwrite', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (!liveIds.has(c.value?.noteId)) {
          c.delete();
          removed++;
        }
        c.continue();
      };
    });
    return removed;
  } catch {
    return 0;
  }
}

/** Keep the whole history under 50 MB: thin the oldest snapshots first, across all notes. */
export async function enforceBudget() {
  const db = await openDb();
  if (!db) return;
  try {
    const meta = [];
    await tx(db, 'readonly', (s) => {
      const req = s.index('at').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        meta.push({ id: c.value.id, size: Number(c.value.size) || 0 });
        c.continue();
      };
    });
    let total = meta.reduce((n, m) => n + m.size, 0);
    if (total <= TOTAL_BYTES) return;
    const drop = [];
    for (const m of meta) {
      if (total <= TOTAL_BYTES * 0.9) break;
      drop.push(m.id);
      total -= m.size;
    }
    await tx(db, 'readwrite', (s) => {
      for (const id of drop) s.delete(id);
    });
  } catch {
    /* best effort */
  }
}
