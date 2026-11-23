// The server's copy of the ecosys data: .ecosys/data.json
//   {format:1, wid, deleted, replaced, rev, initialized, dataId, data:{tasks,lists,events,calendars,notes,folders}, settings}
//   wid       a random id of this very write: another process's same-size write within the same
//             timestamp slot (FAT32 keeps 2 s) still shows as a different file
//   dataId    this data folder's identity: a browser that meets another one (a new or emptied folder)
//             brings its own copy to it instead of replacing its copy with the folder's (shared/sync.js)
//   deleted   {collection: {id: ms}} when records were deleted, and replaced {collection: ms} when a
//             whole collection was (Erase everything, Import backup): a browser's change to a record
//             deleted after the version it started from does not bring the record back
// Writes are atomic (temp file + rename) and finish before the request that caused them returns.
// Another process (the stdio MCP bridge) may write the same file, so every read-modify-write runs
// under a cross-process lock and starts by reloading the file if it changed.
//
// The file is never taken for empty because it could not be read: at start the store retries for a
// few seconds and then refuses to start (DataFileError), and while running a failed reload keeps what
// is in memory (a write then waits for the file, or keeps a copy of a corrupt one before replacing it).
// A save that fails puts memory back as it was, so "nothing was changed" is then true.
//
// Browsers' sync ops may carry what the browser started from: a put {base, fields, was} (the version's
// updatedAt, the keys it changed, and a hash of each changed key's value in that version, see baseOf)
// and a del {base, at}. A put whose record still has that version is applied whole; otherwise only its
// fields are merged into the current copy (applyOps). Ops without them are applied as they come.
import { join } from 'node:path';
import { readFileSync, openSync, readSync, fstatSync, closeSync, copyFileSync } from 'node:fs';
import { atomicWrite, atomicWriteJson, fileStamp, sameStamp, createLock, ensureDir, isId, isPlainObject, pruneDir, stamp, jsonErrorAt, parseJson, sleepSync, uid } from './util.mjs';
import { COLLECTIONS, LIMITS } from './validate.mjs';

export const FORMAT = 1;

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
  }
}

/**
 * data.json exists but cannot be used: another program holds it, this account may not read it, or it
 * is not valid ecosys data. Thrown at start (ecosys then does not start) and, as a 503, by a write
 * that finds the file busy while ecosys runs. The message never quotes the file's content.
 */
export class DataFileError extends Error {
  constructor(message, { status = 503, code = 'EDATAFILE', cause } = {}) {
    super(message);
    this.name = 'DataFileError';
    this.status = status;
    this.code = code;
    if (cause?.code) this.cause = { code: cause.code };
  }
}

const emptyCols = () => Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
const emptyTombs = () => Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const timeOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** At most this many deleted-record times are kept (the newest), and none older than TOMB_MAX_AGE_MS. */
const TOMB_MAX = 10000;
const TOMB_MAX_AGE_MS = 90 * 86400000;
/** How long the store waits for a data.json it cannot read: at start, and before a write. */
const START_WAIT_MS = 5000;
const WRITE_WAIT_MS = 1000;

// ---------------------------------------------------------------- reading the file

// util.mjs parseJson: JSON.parse, or safeParse when the text may hold a key named like a prototype
// member (a reviver over every value of a large file costs more than the parse itself).
const parseData = parseJson;
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

/**
 * data.json now: {status:'ok', raw, stamp} | {status:'missing'} | {status:'unreadable', err} |
 * {status:'corrupt', err, stamp}. The stamp is the one of the file that was read (fstat of the open
 * file), so a write that lands after the read shows as a change.
 */
function readDisk(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    return err.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable', err };
  }
  let text;
  let st;
  try {
    st = fstatSync(fd);
    text = readFileSync(fd, 'utf8');
  } catch (err) {
    return { status: 'unreadable', err };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  const at = { mtimeMs: st.mtimeMs, size: st.size };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let raw;
  try {
    raw = parseData(text);
  } catch (err) {
    return { status: 'corrupt', err, stamp: at };
  }
  if (!isPlainObject(raw)) return { status: 'corrupt', err: new SyntaxError('not an object'), stamp: at };
  // A file from before folders had an id: one derived from its content, the same in every process
  // and after every restart until the next write stores it.
  if (!(typeof raw.dataId === 'string' && isId(raw.dataId))) raw.derivedId = `d${hash53(text).padStart(11, '0')}`;
  return { status: 'ok', raw, stamp: at };
}

/** Read data.json, waiting up to `waitMs` (with backoff) while it is busy, missing mid-replace or not valid yet. */
function readDiskPatiently(file, waitMs) {
  const until = Date.now() + waitMs;
  let r = readDisk(file);
  for (let pause = 25; r.status === 'unreadable' || r.status === 'corrupt'; pause = Math.min(pause * 2, 800)) {
    const left = until - Date.now();
    if (left <= 0) break;
    sleepSync(Math.min(pause, left));
    r = readDisk(file);
  }
  return r;
}

/** The write id at the start of data.json; null when it has none, undefined when it can't be read. */
function diskWid(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(160);
    const head = buf.toString('latin1', 0, readSync(fd, buf, 0, buf.length, 0));
    return /"wid"\s*:\s*"([0-9A-Za-z_-]{1,40})"/.exec(head)?.[1] ?? null;
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

/** Why data.json can't be used, for the log and the start-up error. Never the file's content. */
function describeTrouble(file, r) {
  if (r.status === 'corrupt') return `${file} is not valid JSON${r.err instanceof SyntaxError ? jsonErrorAt(r.err) : ''}`;
  const code = typeof r.err?.code === 'string' ? r.err.code : 'error';
  return `${file} could not be read (${code})`;
}

// ---------------------------------------------------------------- field-level merge (shared/sync.js has the same rules)

const NO_MERGE = new Set(['id', 'createdAt', 'updatedAt', '__proto__', 'constructor', 'prototype']);

/** cyrb53: a fast 53-bit string hash, written in base 36. shared/sync.js computes the same. */
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
    if (x === null || typeof x !== 'object' || Array.isArray(x) || typeof x.id !== 'string' || !x.id || seen.has(x.id)) return false;
    seen.add(x.id);
  }
  return true;
}

/** What a browser sends in `was` for one field of the version it started from: its hash, and each item's for an id'd array. */
export function baseOf(v) {
  return isIdArray(v) ? [valueHash(v), Object.fromEntries(v.map((x) => [x.id, valueHash(x)]))] : valueHash(v);
}

/** A `was` value from the network → string | [string, Map(id → hash)], or undefined when it is not one. */
function readBase(b) {
  if (typeof b === 'string') return b.length <= 24 ? b : undefined;
  if (!Array.isArray(b) || b.length !== 2 || typeof b[0] !== 'string' || !isPlainObject(b[1])) return undefined;
  const items = Object.entries(b[1]);
  if (items.length > 5000 || !items.every(([, h]) => typeof h === 'string' && h.length <= 24)) return undefined;
  return [b[0], new Map(items)];
}

/**
 * Merge id'd arrays: items only one side changed take that side's version, items both changed the
 * newer write's (`preferMine`), items I deleted go unless they changed them, and items only I added
 * follow the item they came after in my copy. `base`: Map(id → hash) of the version I started from.
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
    // Items only I added, and items I changed that they deleted (my text is not lost).
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
 * A browser's edit merged into the current copy, field by field. For each key in `fields`: when the
 * current copy still has the value the browser started from (its hash in `was`), the browser's value
 * is taken; when both changed it, id'd arrays are merged item by item and anything else takes the
 * newer write's value (`preferMine`: the edit is at least as new as the current copy). A key whose
 * starting value is unknown counts as changed on both sides. Returns a new record, or `cur` itself
 * when nothing would change. `was`: Map(field → readBase value).
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
    if (baseHash !== undefined && valueHash(theirs) === baseHash) next = mine; // only this edit changed it
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

/** The base/fields/was/at a browser's op carries, checked. `fields` is null for an op without them (applied as it comes). */
function opMeta(raw) {
  const meta = { base: undefined, fields: null, was: null, at: undefined };
  if (!isPlainObject(raw)) return meta;
  if (raw.base === null || (typeof raw.base === 'number' && Number.isFinite(raw.base))) meta.base = raw.base;
  if (Array.isArray(raw.fields) && raw.fields.length <= 500 && raw.fields.every((k) => typeof k === 'string' && k.length <= 64)) meta.fields = [...new Set(raw.fields)];
  if (isPlainObject(raw.was)) {
    const was = new Map();
    for (const [k, v] of Object.entries(raw.was).slice(0, 500)) {
      const b = readBase(v);
      if (b !== undefined) was.set(k, b);
    }
    meta.was = was;
  }
  if (typeof raw.at === 'number' && Number.isFinite(raw.at)) meta.at = raw.at;
  return meta;
}

// ---------------------------------------------------------------- the store

export class DataStore {
  /**
   * @param {{dir:string, validators:object, lock?:Function, log?:Console, startWaitMs?:number}} opts
   *   startWaitMs: how long to wait for a data.json that can't be read before refusing to start.
   */
  constructor({ dir, validators, lock, log = console, startWaitMs = START_WAIT_MS }) {
    this.dir = dir;
    this.file = join(dir, 'data.json');
    this.backupDir = join(dir, 'backups');
    this.v = validators;
    this.log = log;
    this.withLock = lock || createLock(join(dir, 'lock'));
    this.rev = 0;
    this.initialized = false;
    this.cols = emptyCols();
    this.settingsObj = {};
    this.stampValue = null;
    this.wid = null; // the write id of the copy in memory (null: the file had none)
    this.dataId = uid();
    this.dataIdOnDisk = false;
    this.deleted = emptyTombs(); // collection → Map(id → ms)
    this.replaced = {}; // collection → ms
    this.version = 0; // changes with every change in memory (the snapshot cache follows it)
    this.snapCache = null;
    this.trouble = null; // the stamp data.json had when a reload last failed (logged once per stamp)
    /** Called with (rev) when the file was changed by another process. */
    this.onExternalChange = null;
    ensureDir(dir);
    this.loadAtStart(startWaitMs);
  }

  // ------------------------------------------------------------ disk

  /** First load: a data.json that can't be read is waited for, then ecosys refuses to start. */
  loadAtStart(waitMs) {
    const r = readDiskPatiently(this.file, Math.max(0, waitMs));
    if (r.status === 'missing') return void this.fromJSON(null);
    if (r.status !== 'ok') {
      const why = describeTrouble(this.file, r);
      const fix =
        r.status === 'corrupt'
          ? `It was left exactly as it is. If another program is writing it, start ecosys again in a moment. Otherwise restore a copy from ${this.backupDir} or move data.json somewhere else and start ecosys again: it then starts with an empty data folder, and each browser you used brings its copy of your data back to it.`
          : 'Nothing was changed. Another program may have it open (a backup or sync tool, an antivirus scanner, an editor), or this account may not be allowed to open it. Close that program, or check the file\'s permissions, and start ecosys again.';
      throw new DataFileError(`ecosys did not start: ${why}. ${fix}`, { cause: r.err });
    }
    this.fromJSON(r.raw);
    this.stampValue = r.stamp;
  }

  /** Reload data.json now (another process changed it). A failed reload keeps what is in memory. */
  load() {
    this.refresh({ force: true });
  }

  fromJSON(raw, { keep = false } = {}) {
    const cols = emptyCols();
    let rev = 0;
    let initialized = false;
    let settings = {};
    if (isPlainObject(raw)) {
      rev = Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
      initialized = raw.initialized === true;
      settings = isPlainObject(raw.settings) ? raw.settings : {};
      const data = isPlainObject(raw.data) ? raw.data : {};
      for (const c of COLLECTIONS) {
        if (!Array.isArray(data[c])) continue;
        for (const item of data[c]) if (isPlainObject(item) && isId(item.id)) cols[c].set(item.id, item);
      }
    }
    // The folder's id and deletion times: a copy written by an older ecosys (a bridge started before an
    // update) has none, and must not give the folder a new identity or forget its deletions.
    const id = isPlainObject(raw) && typeof raw.dataId === 'string' && isId(raw.dataId) ? raw.dataId : null;
    if (id) this.dataId = id;
    else if (!keep) this.dataId = isPlainObject(raw) && typeof raw.derivedId === 'string' ? raw.derivedId : uid();
    this.dataIdOnDisk = !!id;
    if (isPlainObject(raw) && (isPlainObject(raw.deleted) || isPlainObject(raw.replaced))) {
      this.deleted = emptyTombs();
      for (const c of COLLECTIONS) {
        const t = isPlainObject(raw.deleted?.[c]) ? raw.deleted[c] : {};
        for (const [k, at] of Object.entries(t)) if (isId(k) && timeOf(at) > 0) this.deleted[c].set(k, at);
      }
      this.replaced = {};
      for (const c of COLLECTIONS) if (timeOf(raw.replaced?.[c]) > 0) this.replaced[c] = raw.replaced[c];
    } else if (!keep) {
      this.deleted = emptyTombs();
      this.replaced = {};
    }
    for (const c of COLLECTIONS) for (const id of cols[c].keys()) this.deleted[c].delete(id);
    this.cols = cols;
    this.rev = rev;
    this.initialized = initialized;
    this.settingsObj = settings;
    this.wid = isPlainObject(raw) && typeof raw.wid === 'string' ? raw.wid : null;
    this.touched();
  }

  /** Something in memory changed: the cached snapshot is out of date. */
  touched() {
    this.version++;
    this.snapCache = null;
  }

  colsJSON() {
    return Object.fromEntries(COLLECTIONS.map((c) => [c, [...this.cols[c].values()]]));
  }

  toJSON() {
    return {
      format: FORMAT,
      wid: this.wid,
      deleted: this.tombsJSON(),
      replaced: this.replaced,
      rev: this.rev,
      initialized: this.initialized,
      dataId: this.dataId,
      data: this.colsJSON(),
      settings: this.settingsObj,
    };
  }

  tombsJSON() {
    return Object.fromEntries(COLLECTIONS.map((c) => [c, Object.fromEntries(this.deleted[c])]));
  }

  /** The state as GET /api/state sends it, serialized once per change. */
  snapshotText() {
    if (this.snapCache?.version !== this.version) {
      const text = JSON.stringify({ rev: this.rev, initialized: this.initialized, dataId: this.dataId, data: this.colsJSON(), settings: this.settingsObj });
      this.snapCache = { version: this.version, text };
    }
    return this.snapCache.text;
  }

  /**
   * Write data.json (compact JSON: a large library is serialized once, as GET /api/state sends it).
   * Throws when the write fails; the file then holds what it held before.
   */
  save() {
    const wid = uid();
    const head = `{"format":${FORMAT},"wid":"${wid}","deleted":${JSON.stringify(this.tombsJSON())},"replaced":${JSON.stringify(this.replaced)},`;
    atomicWrite(this.file, `${head}${this.snapshotText().slice(1)}\n`);
    this.wid = wid;
    this.dataIdOnDisk = true;
    this.trouble = null;
    this.stampValue = fileStamp(this.file);
  }

  /**
   * Has another process written data.json since this copy was read or written? A file already found
   * not to be valid JSON is not read again until it changes (a busy one is: it may be free now).
   */
  changedOnDisk({ write = false } = {}) {
    const now = fileStamp(this.file);
    if (sameStamp(now, this.stampValue)) {
      if (!this.stampValue || !this.wid) return false;
      const w = diskWid(this.file);
      return w !== undefined && w !== this.wid;
    }
    return write || this.trouble?.status !== 'corrupt' || !sameStamp(now, this.trouble.stamp);
  }

  /**
   * Reload if another process changed the file. Returns true when it did. A file that can't be read
   * keeps the copy in memory: the next call tries again. `write`: a write follows (under the lock), so
   * a busy file is waited for and then refused (503), and a corrupt one is copied aside first.
   */
  refresh({ silent = false, write = false, force = false } = {}) {
    if (!force && !this.changedOnDisk({ write })) return false;
    const r = write ? readDiskPatiently(this.file, WRITE_WAIT_MS) : readDisk(this.file);
    if (r.status === 'missing') {
      if (!this.stampValue && !force) return false;
      // Removed while ecosys runs (by hand, or a sync tool): what is in memory is written back.
      this.log.warn?.(`ecosys: ${this.file} disappeared while ecosys was running; it is written again from memory`);
      this.stampValue = null;
      try {
        this.withLock(() => {
          if (!fileStamp(this.file)) this.save();
        });
      } catch (err) {
        this.log.error?.(`ecosys: could not write ${this.file} again (${err.code || 'error'})`);
      }
      return false;
    }
    if (r.status !== 'ok') {
      const at = r.stamp || fileStamp(this.file);
      if (this.trouble?.status !== r.status || !sameStamp(this.trouble.stamp, at)) {
        this.trouble = { status: r.status, stamp: at };
        this.log.error?.(`ecosys: ${describeTrouble(this.file, r)}; ecosys keeps working with the copy it has and reads it again when it can`);
      }
      if (!write) return false;
      if (r.status === 'unreadable') throw new DataFileError('ecosys could not read its data file just now: another program has it open. Nothing was changed; try again in a moment.', { cause: r.err });
      // Not valid JSON (a hand edit, a damaged disk): keep a copy before the save that follows replaces it.
      const aside = `${this.file}.corrupt-${stamp()}`;
      try {
        copyFileSync(this.file, aside);
      } catch (err) {
        throw new DataFileError('ecosys could not keep a copy of its damaged data file, so it did not write over it. Nothing was changed.', { cause: err });
      }
      this.log.error?.(`ecosys: kept the unreadable data file as ${aside}; the copy in memory replaces it`);
      this.stampValue = fileStamp(this.file);
      return false;
    }
    if (this.trouble) {
      this.trouble = null;
      this.log.info?.(`ecosys: ${this.file} can be read again`);
    }
    const before = this.rev;
    this.fromJSON(r.raw, { keep: true });
    this.stampValue = r.stamp;
    if (!silent && this.onExternalChange) {
      try {
        this.onExternalChange(this.rev, before);
      } catch (err) {
        this.log.error(err);
      }
    }
    return true;
  }

  backup(name, value) {
    try {
      ensureDir(this.backupDir);
      atomicWriteJson(join(this.backupDir, `${stamp()}-${name}.json`), value);
      pruneDir(this.backupDir, '', 30, '.json');
    } catch (err) {
      this.log.error('ecosys: could not write backup', err.message);
    }
  }

  /** Save, or put memory back as it was (undo) and throw: a failed save changes nothing. */
  commit(undo) {
    try {
      this.save();
    } catch (err) {
      for (const fn of undo.reverse()) fn();
      this.touched();
      throw err;
    }
  }

  // ------------------------------------------------------------ deletion times

  /** When record `id` of `c` was deleted here (0: not known to be). */
  deletedAt(c, id) {
    return Math.max(this.deleted[c]?.get(id) || 0, this.replaced[c] || 0);
  }

  tombstone(c, id, at, undo) {
    const m = this.deleted[c];
    const prev = m.get(id);
    m.set(id, at);
    undo?.push(() => (prev === undefined ? m.delete(id) : m.set(id, prev)));
  }

  untomb(c, id, undo) {
    const m = this.deleted[c];
    const prev = m.get(id);
    if (prev === undefined) return;
    m.delete(id);
    undo?.push(() => m.set(id, prev));
  }

  /** Keep the newest TOMB_MAX deletion times, none older than TOMB_MAX_AGE_MS or than its collection's replace. */
  pruneTombs(now = Date.now()) {
    let total = 0;
    for (const c of COLLECTIONS) {
      for (const [id, at] of this.deleted[c]) if (now - at > TOMB_MAX_AGE_MS || at <= (this.replaced[c] || 0)) this.deleted[c].delete(id);
      total += this.deleted[c].size;
    }
    if (total <= TOMB_MAX) return;
    const all = COLLECTIONS.flatMap((c) => [...this.deleted[c]].map(([id, at]) => [c, id, at])).sort((a, b) => a[2] - b[2]);
    for (const [c, id] of all.slice(0, total - TOMB_MAX)) this.deleted[c].delete(id);
  }

  // ------------------------------------------------------------ reads

  all(c) {
    return [...(this.cols[c]?.values() || [])];
  }
  get(c, id) {
    return this.cols[c]?.get(id) || null;
  }
  settings() {
    return this.settingsObj;
  }
  snapshot() {
    this.refresh();
    return { rev: this.rev, initialized: this.initialized, dataId: this.dataId, data: this.colsJSON(), settings: this.settingsObj };
  }
  /** GET /api/state's body as JSON text (the same as JSON.stringify(snapshot())), serialized once per change. */
  snapshotJSON() {
    this.refresh();
    return this.snapshotText();
  }

  // ------------------------------------------------------------ writes

  /**
   * Folder `item` as it can be stored: at the top level when its parent chain would lead back to it
   * (two browsers moved two folders into each other at the same time), else as it is.
   */
  outsideCycle(item) {
    if (!item?.parentId) return item;
    const m = this.cols.folders;
    const seen = new Set([item.id]);
    for (let p = m.get(item.parentId), n = 0; p; p = p.parentId ? m.get(p.parentId) : null, n++) {
      if (seen.has(p.id) || n > 64) return { ...item, parentId: null };
      seen.add(p.id);
    }
    return item;
  }

  /**
   * Apply sync ops from a browser. Ops are validated one by one; invalid ones are skipped and reported.
   * An op that changes nothing is neither counted nor saved. Returns {rev, applied:[ops as applied],
   * rejected:[{index, error, outcome?, item?}]}: an entry with `outcome` was not applied as sent
   * (only for ops that say what they started from) and tells the browser the current copy to take:
   *   'merged'  only the op's fields were merged into a copy that changed meanwhile: `item` is the result
   *   'deleted' the record was deleted after the version the browser started from: it stays deleted
   *   'kept'    a delete of a record that changed after it was deleted there: `item` is kept
   */
  applyOps(rawOps) {
    if (!Array.isArray(rawOps)) throw Object.assign(new Error('ops must be an array'), { status: 400 });
    if (rawOps.length > LIMITS.opsPerRequest) throw Object.assign(new Error('too many ops in one request'), { status: 413 });
    const checked = rawOps.map((o) => this.v.op(o)); // validation outside the lock
    return this.withLock(() => {
      this.refresh({ write: true });
      const applied = [];
      const rejected = [];
      const undo = [];
      const now = Date.now();
      let changed = false;
      const setItem = (c, id, item) => {
        changed = true;
        const m = this.cols[c];
        const prev = m.get(id);
        m.set(id, item);
        undo.push(() => (prev === undefined ? m.delete(id) : m.set(id, prev)));
        this.untomb(c, id, undo);
      };
      checked.forEach((res, index) => {
        if (res.error) return rejected.push({ index, error: res.error });
        const op = res.op;
        if (op.op === 'put') {
          const id = op.item.id;
          const cur = this.cols[op.c].get(id);
          const meta = opMeta(rawOps[index]);
          if (!cur && this.cols[op.c].size >= LIMITS.itemsPerCollection) return rejected.push({ index, error: `${op.c} is full` });
          const gone = cur ? 0 : this.deletedAt(op.c, id); // when it was deleted here (0: never, as far as this folder knows)
          if (!meta.fields || (cur && meta.base != null && timeOf(cur.updatedAt) === meta.base) || (!cur && !(meta.base != null && gone > 0 && gone >= meta.base))) {
            // As sent: an op that doesn't say what it started from, the version it started from, or a new record.
            const item = op.c === 'folders' ? this.outsideCycle(op.item) : op.item;
            if (cur && sameValue(cur, item)) return;
            setItem(op.c, id, item);
            applied.push(item === op.item ? op : { ...op, item });
            if (item !== op.item) rejected.push({ index, error: 'stored at the top level: inside that folder it would be inside itself', outcome: 'merged', item });
            return;
          }
          if (!cur) return rejected.push({ index, error: 'deleted on the server', outcome: 'deleted' });
          // The record changed since: merge only what this browser changed.
          let next = mergeRecord(cur, op.item, meta.fields, meta.was, timeOf(op.item.updatedAt) >= timeOf(cur.updatedAt));
          if (next !== cur) {
            next.updatedAt = Math.max(now, timeOf(cur.updatedAt) + 1, timeOf(op.item.updatedAt));
            if (op.c === 'notes' && Number.isInteger(cur.rev) && Number.isInteger(op.item.rev)) next.rev = Math.max(cur.rev, op.item.rev) + 1;
            next = this.v.item(op.c, next) || cur;
            if (op.c === 'folders' && next !== cur) next = this.outsideCycle(next);
          }
          if (next === cur || sameValue(next, cur)) return rejected.push({ index, error: 'a newer copy is stored', outcome: 'merged', item: cur });
          setItem(op.c, id, next);
          const out = { op: 'put', c: op.c, item: next };
          applied.push(out);
          rejected.push({ index, error: 'merged with a newer copy', outcome: 'merged', item: next });
        } else if (op.op === 'del') {
          const cur = this.cols[op.c].get(op.id);
          if (!cur) return;
          const meta = opMeta(rawOps[index]);
          if (meta.base != null && timeOf(cur.updatedAt) !== meta.base && timeOf(cur.updatedAt) > timeOf(meta.at)) {
            return rejected.push({ index, error: 'changed after it was deleted', outcome: 'kept', item: cur });
          }
          this.cols[op.c].delete(op.id);
          undo.push(() => this.cols[op.c].set(op.id, cur));
          this.tombstone(op.c, op.id, now, undo);
          changed = true;
          applied.push(op);
        } else if (op.op === 'settings') {
          const prev = this.settingsObj;
          const next = { ...prev, ...op.patch };
          if (sameValue(next, prev)) return;
          this.settingsObj = next;
          undo.push(() => (this.settingsObj = prev));
          changed = true;
          applied.push(op);
        } else if (op.op === 'replace') {
          const prev = this.cols[op.c];
          // A replace that changes nothing (Erase everything of an empty collection) is still reported
          // as applied, since it means "this collection was reset" (core.mjs forgets its AI history).
          if (prev.size === op.items.length && op.items.every((it) => prev.has(it.id) && sameValue(prev.get(it.id), it))) return void applied.push(op);
          changed = true;
          if (prev.size) this.backup(`before-replace-${op.c}`, { c: op.c, items: this.all(op.c) });
          const next = new Map(op.items.map((it) => [it.id, it]));
          this.cols[op.c] = next;
          const prevReplaced = this.replaced[op.c];
          if ([...prev.keys()].some((id) => !next.has(id))) this.replaced[op.c] = now;
          const tombs = this.deleted[op.c];
          this.deleted[op.c] = new Map([...tombs].filter(([id]) => !next.has(id)));
          undo.push(() => {
            this.cols[op.c] = prev;
            this.deleted[op.c] = tombs;
            if (prevReplaced === undefined) delete this.replaced[op.c];
            else this.replaced[op.c] = prevReplaced;
          });
          applied.push(op);
        }
      });
      if (changed) {
        const rev = this.rev;
        this.rev++;
        undo.push(() => (this.rev = rev));
        this.pruneTombs(now);
        this.touched();
        this.commit(undo);
      }
      return { rev: this.rev, applied, rejected };
    });
  }

  /**
   * First-run migration of a browser's offline data. Only allowed while the store is not yet
   * initialized; items the server already has (e.g. written by an AI before the first import) are kept.
   */
  importData(payload) {
    if (!isPlainObject(payload) || !isPlainObject(payload.data)) {
      throw Object.assign(new Error('import needs {data, settings}'), { status: 400 });
    }
    const incoming = {};
    let dropped = 0;
    for (const c of COLLECTIONS) {
      const arr = payload.data[c];
      if (arr === undefined) continue;
      if (!Array.isArray(arr) || arr.length > LIMITS.itemsPerCollection) {
        throw Object.assign(new Error(`data.${c} must be an array of at most ${LIMITS.itemsPerCollection} items`), { status: 400 });
      }
      const m = new Map();
      for (const raw of arr) {
        const it = this.v.item(c, raw);
        if (it && !m.has(it.id)) m.set(it.id, it);
        else dropped++;
      }
      incoming[c] = m;
    }
    const patch = this.v.settings(payload.settings);
    return this.withLock(() => {
      this.refresh({ write: true });
      if (this.initialized) {
        this.backup('rejected-import', payload);
        throw new ConflictError('ecosys already has data on this computer; load it with GET /api/state');
      }
      const before = { cols: { ...this.cols }, settings: this.settingsObj, initialized: this.initialized, rev: this.rev, deleted: { ...this.deleted } };
      for (const c of COLLECTIONS) {
        if (!incoming[c]) continue;
        const merged = new Map(incoming[c]);
        for (const [id, it] of this.cols[c]) if (!merged.has(id)) merged.set(id, it);
        this.cols[c] = merged;
        this.deleted[c] = new Map([...this.deleted[c]].filter(([id]) => !merged.has(id)));
      }
      this.settingsObj = { ...this.settingsObj, ...patch };
      this.initialized = true;
      this.rev++;
      this.touched();
      this.commit([
        () => {
          this.cols = before.cols;
          this.settingsObj = before.settings;
          this.initialized = before.initialized;
          this.rev = before.rev;
          this.deleted = before.deleted;
        },
      ]);
      return { rev: this.rev, dropped, dataId: this.dataId };
    });
  }

  /**
   * Run `fn(tx)` as one atomic change (used by AI tools and undo). The tx records the state of every
   * item before its first change, so callers get {ops, changes:[{c, id, before, after}]} for undo and
   * broadcasting. If fn throws, or the save fails, every change is rolled back.
   */
  transaction(fn) {
    return this.withLock(() => {
      this.refresh({ write: true });
      const tx = new Tx(this);
      let result;
      try {
        result = fn(tx);
      } catch (err) {
        tx.rollback();
        throw err;
      }
      const changes = tx.changes();
      if (changes.length || tx.settingsChanged) {
        const rev = this.rev;
        this.rev++;
        this.pruneTombs();
        this.touched();
        this.commit([
          () => {
            tx.rollback();
            this.rev = rev;
          },
        ]);
      } else if (tx.touched.size) this.touched();
      return { result, changes, ops: tx.ops(changes), rev: this.rev };
    });
  }
}

class Tx {
  constructor(store) {
    this.s = store;
    this.touched = new Map(); // "c\u0000id" → {c, id, before}
    this.settingsBefore = null;
    this.settingsChanged = false;
    this.undo = []; // deletion times to put back on a rollback
  }
  all(c) {
    return this.s.all(c);
  }
  get(c, id) {
    return this.s.get(c, id);
  }
  settings() {
    return this.s.settingsObj;
  }
  touch(c, id) {
    const key = `${c}\u0000${id}`;
    if (!this.touched.has(key)) this.touched.set(key, { c, id, before: this.s.get(c, id) });
  }
  /** Insert or replace an item. The item is validated; returns the stored copy or throws. */
  put(c, item) {
    const clean = this.s.v.item(c, item);
    if (!clean) throw Object.assign(new Error(`invalid ${c} item`), { toolError: true });
    if (!this.s.cols[c].has(clean.id) && this.s.cols[c].size >= LIMITS.itemsPerCollection) {
      throw Object.assign(new Error(`${c} is full`), { toolError: true });
    }
    this.touch(c, clean.id);
    this.s.cols[c].set(clean.id, clean);
    this.s.untomb(c, clean.id, this.undo);
    this.s.touched();
    return clean;
  }
  del(c, id) {
    if (!this.s.cols[c]?.has(id)) return null;
    this.touch(c, id);
    const prev = this.s.cols[c].get(id);
    this.s.cols[c].delete(id);
    this.s.tombstone(c, id, Date.now(), this.undo);
    this.s.touched();
    return prev;
  }
  setSettings(patch) {
    const clean = this.s.v.settings(patch);
    if (!Object.keys(clean).length) return this.s.settingsObj;
    if (!this.settingsBefore) this.settingsBefore = this.s.settingsObj;
    this.s.settingsObj = { ...this.s.settingsObj, ...clean };
    this.settingsChanged = true;
    this.s.touched();
    return this.s.settingsObj;
  }
  rollback() {
    for (const { c, id, before } of this.touched.values()) {
      if (before) this.s.cols[c].set(id, before);
      else this.s.cols[c].delete(id);
    }
    if (this.settingsBefore) this.s.settingsObj = this.settingsBefore;
    for (const fn of this.undo.reverse()) fn();
    this.undo = [];
    this.touched.clear();
    this.settingsBefore = null;
    this.settingsChanged = false;
    this.s.touched();
  }
  /** Net changes (items whose final state differs from their state before the tx). */
  changes() {
    const out = [];
    for (const { c, id, before } of this.touched.values()) {
      const after = this.s.get(c, id);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      out.push({ c, id, before, after });
    }
    return out;
  }
  ops(changes) {
    const ops = changes.map(({ c, id, after }) => (after ? { op: 'put', c, item: after } : { op: 'del', c, id }));
    if (this.settingsChanged) ops.push({ op: 'settings', patch: this.s.settingsObj });
    return ops;
  }
}
