// AI connection settings and history: .ecosys/ai.json
//   {mode:'write'|'read'|'off', clients:[credential…], activity:[…200], changes:[…200 change summaries]}
// The items an undo needs live in .ecosys/changes/<changeId>.json, written once per change, so
// ai.json stays small however much an assistant changes: it is rewritten on every write request.
// One credential per AI client (Claude, ChatGPT, Grok, …). The credential doubles as identity, so
// the UI can say which assistant changed what. Tokens never leave this machine except through the
// local browser API (GET /api/ai), which only answers same-origin requests from 127.0.0.1/localhost.
import { join } from 'node:path';
import { readdirSync, unlinkSync, renameSync, copyFileSync } from 'node:fs';
import { atomicWrite, atomicWriteJson, readJson, fileStamp, sameStamp, createLock, ensureDir, isId, isPlainObject, randomToken, safeEqual, uid, stamp, jsonErrorAt } from './util.mjs';

export const MODES = ['write', 'read', 'off'];
export const KINDS = ['claude', 'chatgpt', 'grok', 'other'];
export const ACCESS = ['write', 'read'];
export const KIND_LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok', other: 'AI assistant' };
export const CONNECTED_MS = 10 * 60 * 1000;
/** Undo data kept for one change. A bigger change is still listed, but cannot be undone. */
export const MAX_UNDO_BYTES = 5 * 1024 * 1024;
/** Undo data kept in total; past this the oldest changes lose their undo data first. */
export const UNDO_BUDGET_BYTES = 64 * 1024 * 1024;
const MAX_CLIENTS = 20;
const MAX_ACTIVITY = 200;
const MAX_CHANGES = 200;
const PERSIST_SEEN_MS = 60 * 1000;
const HANDSHAKE_REFIRE_MS = 60 * 1000;
const ACTIVITY_FLUSH_MS = 1000;
const STALE_TMP_MS = 10 * 60 * 1000;
const CHANGE_ID_RE = /^chg_[a-z0-9]{1,40}$/i;

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
const byTime = (a, b) => (a.at || 0) - (b.at || 0);

// ---------------------------------------------------------------- notes and folders a change edited

const REF_RE = /^(notes|folders):[a-z0-9_-]{1,40}$/i;
const MAX_REFS = 200;
// A meeting note's link moving with its event (update_event re-points {event:{id, date}} when an
// occurrence is edited on its own, a series is split or its days move): bookkeeping for the event
// change, not an edit of the note. These fields (and nothing else) differ then. A note assistants use
// in place of one they can't see (a stand-in, server/tools-notes.mjs) is stored without the link it
// is shown with, so when that link moves it only gets the rev bump: the same bookkeeping.
const LINK_FIELDS = new Set(['event', 'rev', 'updatedAt']);

function onlyLinkMoved(a, b) {
  let moved = false;
  let bumped = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null)) continue;
    if (!LINK_FIELDS.has(k)) return false;
    if (k === 'event') moved = true;
    if (k === 'rev') bumped = true;
  }
  // A linked note whose rev changed while its link stayed did not move; a stand-in has no link.
  return moved || (bumped && !a.event && !b.event);
}

/**
 * True when note versions `a` and `b` differ only in where the note's event link points.
 * `normalize` (notes/core/schema.js validateNote) puts both in the form the store saves first, when
 * they differ in more than that: the store keeps records as they were loaded, so the version before
 * a change may be an older one (an HTML body and no blocks) while the version after it is validated.
 */
export function isRelink(c, a, b, normalize = null) {
  if (c !== 'notes' || !isPlainObject(a) || !isPlainObject(b)) return false;
  if (onlyLinkMoved(a, b)) return true;
  // The same link in both, however it is written, can't have moved: nothing more to compare.
  if (typeof normalize !== 'function' || JSON.stringify(a.event ?? null) === JSON.stringify(b.event ?? null)) return false;
  try {
    const na = normalize(a);
    const nb = normalize(b);
    return isPlainObject(na) && isPlainObject(nb) && onlyLinkMoved(na, nb);
  } catch {
    return false;
  }
}

/**
 * 'notes:<id>' / 'folders:<id>' for every note and folder a change edited, from its undo items
 * (`before`/`after` = [{c, id, item|null}]). What find_changes and undo_change may tell an assistant
 * depends on whether it can see those now. A link that only moved with its event isn't listed
 * (`normalize`: see isRelink).
 */
export function changeRefs(before = [], after = [], normalize = null) {
  const afterOf = new Map((Array.isArray(after) ? after : []).filter(isPlainObject).map((a) => [`${a.c}\u0000${a.id}`, a.item ?? null]));
  const out = new Set();
  for (const b of Array.isArray(before) ? before : []) {
    if (!isPlainObject(b) || (b.c !== 'notes' && b.c !== 'folders') || !isId(b.id)) continue;
    if (isRelink(b.c, b.item, afterOf.get(`${b.c}\u0000${b.id}`), normalize)) continue;
    out.add(`${b.c}:${b.id}`);
  }
  return [...out];
}

const cleanRefs = (refs) => [...new Set((Array.isArray(refs) ? refs : []).filter((s) => typeof s === 'string' && REF_RE.test(s)))].slice(0, MAX_REFS);

const COL_RE = /^[a-z]{1,20}$/;
/** The collections a change's undo items are in ('tasks', 'notes', …). */
const colsOf = (...lists) => [...new Set(lists.flat().map((x) => x?.c).filter((c) => typeof c === 'string' && COL_RE.test(c)))].slice(0, 20);

function normalizeClient(c) {
  if (!isPlainObject(c) || !isId(c.id) || typeof c.token !== 'string' || c.token.length < 32) return null;
  return {
    id: c.id,
    kind: KINDS.includes(c.kind) ? c.kind : 'other',
    label: clean(c.label, 60) || KIND_LABEL[c.kind] || 'AI assistant',
    token: c.token,
    access: ACCESS.includes(c.access) ? c.access : 'read',
    createdAt: Number(c.createdAt) || Date.now(),
    lastSeen: Number(c.lastSeen) || null,
    lastClientName: c.lastClientName ? clean(c.lastClientName, 80) : null,
  };
}

/** A change summary from ai.json. Older files kept the undo items inline; those move out on the next save. */
function normalizeChange(c) {
  if (!isPlainObject(c) || typeof c.changeId !== 'string' || !CHANGE_ID_RE.test(c.changeId)) return null;
  const inline = Array.isArray(c.before) || Array.isArray(c.after);
  const ref = (v) => (typeof v === 'string' && CHANGE_ID_RE.test(v) ? v : null);
  const out = {
    changeId: c.changeId,
    at: Number(c.at) || 0,
    clientId: isId(c.clientId) ? c.clientId : null,
    kind: clean(c.kind, 20) || 'other',
    label: clean(c.label, 60) || 'ecosys',
    tool: clean(c.tool, 60),
    summary: clean(c.summary, 300),
    undoOf: ref(c.undoOf),
    undoneBy: ref(c.undoneBy),
    undoable: inline || c.undoable === true,
    bytes: Number.isInteger(c.bytes) && c.bytes >= 0 ? c.bytes : 0,
    // null: saved before changes listed the notes and folders they edited (server/core.mjs works it out).
    refs: Array.isArray(c.refs) ? cleanRefs(c.refs) : null,
    // null: saved before changes listed their collections (forgetChanges reads the undo data).
    cols: Array.isArray(c.cols) ? c.cols.filter((x) => typeof x === 'string' && COL_RE.test(x)).slice(0, 20) : null,
  };
  if (inline) {
    out.before = Array.isArray(c.before) ? c.before : [];
    out.after = Array.isArray(c.after) ? c.after : [];
  }
  return out;
}

export class AIStore {
  /**
   * @param {{dir:string, lock?:Function, log?:Console, maxUndoBytes?:number, undoBudget?:number, normalizeNote?:Function|null}} opts
   *   maxUndoBytes / undoBudget default to MAX_UNDO_BYTES / UNDO_BUDGET_BYTES (tests lower them).
   *   normalizeNote (notes/core/schema.js validateNote, from server/core.mjs) is how a change's refs
   *   tell a moved meeting-note link from an edit when the note was saved in an older form (isRelink).
   */
  constructor({ dir, lock, log = console, maxUndoBytes = MAX_UNDO_BYTES, undoBudget = UNDO_BUDGET_BYTES, normalizeNote = null }) {
    this.dir = dir;
    this.file = join(dir, 'ai.json');
    this.changesDir = join(dir, 'changes');
    this.maxUndoBytes = maxUndoBytes;
    this.undoBudget = undoBudget;
    this.normalizeNote = typeof normalizeNote === 'function' ? normalizeNote : null;
    this.log = log;
    this.withLock = lock || createLock(join(dir, 'lock'));
    this.state = { mode: 'write', clients: [], activity: [], changes: [] };
    this.stampValue = null;
    this.seen = new Map(); // client id → lastSeen known in memory (persisted at most once a minute)
    this.persistedSeen = new Map();
    this.lastHandshakeFire = new Map();
    this.knownActivity = new Set();
    this.pendingActivity = []; // read activity not saved yet (see addActivity)
    this.flushTimer = null;
    /** Called with {activity, connected} when another process (the stdio bridge) changed ai.json. */
    this.onExternal = null;
    ensureDir(dir);
    try {
      this.withLock(() => {
        this.load();
        this.sweepUndo();
      });
    } catch (err) {
      this.log.error('ecosys: could not tidy the undo history', err.message);
      this.load();
    }
    this.rememberActivity();
  }

  load() {
    let raw = null;
    this.unreadable = false;
    try {
      raw = readJson(this.file, null);
    } catch (err) {
      this.unreadable = true;
      // Never the parser's message: it quotes the text around the error, which can be part of a key.
      const why = err instanceof SyntaxError ? `is not valid JSON${jsonErrorAt(err)}` : `could not be read (${err.code || 'error'})`;
      this.log.error(`ecosys: ${this.file} ${why}; AI connections start empty. It is kept as ai.json.corrupt-<time> (not overwritten) when AI settings are next saved.`);
    }
    const s = isPlainObject(raw) ? raw : {};
    this.state = {
      mode: MODES.includes(s.mode) ? s.mode : 'write',
      clients: (Array.isArray(s.clients) ? s.clients : []).map(normalizeClient).filter(Boolean).slice(0, MAX_CLIENTS),
      activity: (Array.isArray(s.activity) ? s.activity : []).filter((a) => isPlainObject(a) && typeof a.id === 'string').slice(-MAX_ACTIVITY),
      changes: (Array.isArray(s.changes) ? s.changes : []).map(normalizeChange).filter(Boolean).slice(-MAX_CHANGES),
    };
    this.stampValue = fileStamp(this.file);
  }

  /** Activity ids this process has already seen: what is in the file plus what is still pending. */
  rememberActivity() {
    this.knownActivity = new Set([...this.state.activity, ...this.pendingActivity].map((a) => a.id));
  }

  /** Write ai.json (always under the lock, from mutate). */
  save() {
    if (this.unreadable) this.setAsideUnreadable();
    atomicWriteJson(this.file, this.state);
    this.stampValue = fileStamp(this.file);
  }

  /**
   * ai.json could not be parsed when it was loaded, and nobody has fixed it since (mutate reloads it
   * under the lock first). Keep it, with the keys it holds, as ai.json.corrupt-<time> instead of
   * overwriting it, like data.json.
   */
  setAsideUnreadable() {
    this.unreadable = false;
    const aside = `${this.file}.corrupt-${stamp()}`;
    try {
      renameSync(this.file, aside);
    } catch (err) {
      if (err.code === 'ENOENT') return; // gone already: nothing to keep
      try {
        copyFileSync(this.file, aside);
      } catch (err2) {
        this.log.error(`ecosys: could not keep a copy of the unreadable ${this.file} (${err2.code || 'error'}); it is replaced now`);
        return;
      }
    }
    this.log.error(`ecosys: the unreadable ${this.file} was kept as ${aside}`);
  }

  /**
   * Reload if another process changed ai.json. Returns what changed so the HTTP server can tell
   * browsers: {changed, activity:[new entries], connected:[clients that just came online]}.
   */
  refresh() {
    const now = fileStamp(this.file);
    if (sameStamp(now, this.stampValue)) return { changed: false, activity: [], connected: [] };
    const beforeSeen = new Map(this.state.clients.map((c) => [c.id, this.lastSeen(c)]));
    this.load();
    const activity = this.state.activity.filter((a) => !this.knownActivity.has(a.id));
    this.rememberActivity();
    const connected = [];
    const t = Date.now();
    for (const c of this.state.clients) {
      const prev = beforeSeen.get(c.id);
      if (c.lastSeen && t - c.lastSeen < CONNECTED_MS && (!prev || c.lastSeen - prev >= CONNECTED_MS)) connected.push(c);
    }
    const result = { changed: true, activity, connected };
    if (this.onExternal) {
      try {
        this.onExternal(result);
      } catch (err) {
        this.log.error(err);
      }
    }
    return result;
  }

  /**
   * Read-modify-write ai.json under the cross-process lock. Pending read activity goes along. If the
   * save fails (a full disk, a read-only ai.json), memory goes back to what is on disk, so a change
   * that was not saved never takes effect (a new key that works, a removed one that comes back
   * later): the caller gets the error, and the activity that was waiting stays pending.
   */
  mutate(fn) {
    return this.withLock(() => {
      this.refresh();
      this.moveInlineUndo(this.state);
      const out = fn(this.state);
      const pending = this.pendingActivity;
      this.takePending(this.state); // after fn: if fn throws, pending entries stay pending
      try {
        this.save();
      } catch (err) {
        this.load();
        this.pendingActivity = [...pending, ...this.pendingActivity];
        this.rememberActivity();
        throw err;
      }
      return out;
    });
  }

  // ------------------------------------------------------------ credentials

  mode() {
    return this.state.mode;
  }
  setMode(mode) {
    if (!MODES.includes(mode)) throw Object.assign(new Error(`mode must be one of ${MODES.join(', ')}`), { status: 400 });
    return this.mutate((s) => (s.mode = mode));
  }

  get(id) {
    return this.state.clients.find((c) => c.id === id) || null;
  }

  /** Find the credential for a token (constant-time per comparison). */
  byToken(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
    let found = null;
    for (const c of this.state.clients) if (safeEqual(c.token, token)) found = c;
    return found;
  }

  lastSeen(c) {
    return Math.max(c.lastSeen || 0, this.seen.get(c.id) || 0) || null;
  }
  isConnected(c, t = Date.now()) {
    const seen = this.lastSeen(c);
    return !!seen && t - seen < CONNECTED_MS;
  }

  uniqueLabel(kind, wanted) {
    const base = clean(wanted, 60) || KIND_LABEL[kind];
    const taken = new Set(this.state.clients.map((c) => c.label.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
    return `${base} ${uid().slice(0, 4)}`;
  }

  createClient({ kind, access = 'write', label } = {}) {
    if (!KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { status: 400 });
    if (!ACCESS.includes(access)) throw Object.assign(new Error('access must be "write" or "read"'), { status: 400 });
    return this.mutate((s) => {
      if (s.clients.length >= MAX_CLIENTS) throw Object.assign(new Error(`at most ${MAX_CLIENTS} connections; remove one first`), { status: 409 });
      const c = {
        id: uid(),
        kind,
        label: this.uniqueLabel(kind, label),
        token: randomToken(),
        access,
        createdAt: Date.now(),
        lastSeen: null,
        lastClientName: null,
      };
      s.clients.push(c);
      return c;
    });
  }

  updateClient(id, { access, rotate, label } = {}) {
    if (access !== undefined && !ACCESS.includes(access)) throw Object.assign(new Error('access must be "write" or "read"'), { status: 400 });
    return this.mutate((s) => {
      const c = s.clients.find((x) => x.id === id);
      if (!c) throw Object.assign(new Error('no such connection'), { status: 404 });
      if (access !== undefined) c.access = access;
      if (label !== undefined && clean(label, 60)) c.label = clean(label, 60);
      if (rotate === true) {
        c.token = randomToken();
        c.lastSeen = null;
        this.seen.delete(id);
      }
      return c;
    });
  }

  deleteClient(id) {
    return this.mutate((s) => {
      const i = s.clients.findIndex((x) => x.id === id);
      if (i < 0) throw Object.assign(new Error('no such connection'), { status: 404 });
      s.clients.splice(i, 1);
      this.seen.delete(id);
      return true;
    });
  }

  /**
   * Record that a credential made an authenticated MCP request. Returns true when this counts as a
   * (re)connection: first request in 10+ minutes, or a new initialize / server/discover handshake.
   */
  touch(id, { clientName, handshake = false } = {}) {
    const c = this.get(id);
    if (!c) return false;
    const t = Date.now();
    const prev = this.lastSeen(c);
    const idle = !prev || t - prev >= CONNECTED_MS;
    const name = clientName ? clean(clientName, 80) : null;
    const fire = idle || (handshake && t - (this.lastHandshakeFire.get(id) || 0) >= HANDSHAKE_REFIRE_MS);
    this.seen.set(id, t);
    if (fire) this.lastHandshakeFire.set(id, t);
    const needPersist = idle || (name && name !== c.lastClientName) || t - (this.persistedSeen.get(id) || 0) >= PERSIST_SEEN_MS;
    if (needPersist) {
      try {
        this.mutate((s) => {
          const x = s.clients.find((y) => y.id === id);
          if (!x) return;
          x.lastSeen = t;
          if (name) x.lastClientName = name;
        });
        this.persistedSeen.set(id, t);
      } catch (err) {
        this.log.error('ecosys: could not save AI connection state', err.message);
      }
    }
    return fire;
  }

  // ------------------------------------------------------------ activity

  /** An activity entry. `undoOf` (an undo's entry only) is the change it took back. */
  makeActivity({ client, tool, summary, changeId = null, clientName = null, undoOf = null }) {
    return {
      id: `act_${uid().slice(0, 12)}`,
      at: Date.now(),
      clientId: client?.id || null,
      kind: client?.kind || 'other',
      label: client?.label || 'ecosys',
      clientName: clientName ? clean(clientName, 80) : null,
      tool: clean(tool, 60),
      summary: clean(summary, 300),
      changeId,
      ...(typeof undoOf === 'string' && CHANGE_ID_RE.test(undoOf) ? { undoOf } : {}),
    };
  }

  pushActivity(s, entry) {
    s.activity.push(entry);
    if (s.activity.length > MAX_ACTIVITY) s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
    this.knownActivity.add(entry.id);
    if (this.knownActivity.size > 4 * MAX_ACTIVITY) this.rememberActivity();
  }

  /** Move pending read activity into `s` (inside mutate). */
  takePending(s) {
    if (!this.pendingActivity.length) return;
    for (const e of this.pendingActivity) s.activity.push(e);
    this.pendingActivity = [];
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    s.activity.sort(byTime);
    if (s.activity.length > MAX_ACTIVITY) s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
  }

  /**
   * Add an activity entry. With `defer` (reads and other calls that changed nothing) it is kept in
   * memory and saved with the next write, at most ACTIVITY_FLUSH_MS later, so a read never forces a
   * rewrite of ai.json. It shows in recentActivity() right away either way.
   */
  addActivity(fields, { defer = false } = {}) {
    const entry = this.makeActivity(fields);
    if (!defer) {
      this.mutate((s) => this.pushActivity(s, entry));
      return entry;
    }
    this.knownActivity.add(entry.id);
    this.pendingActivity.push(entry);
    if (this.pendingActivity.length > MAX_ACTIVITY) this.pendingActivity.shift();
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), ACTIVITY_FLUSH_MS);
      this.flushTimer.unref?.();
    }
    return entry;
  }

  /** Save pending activity now (the timer does this; also call it before the process exits). Never throws. */
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pendingActivity.length) return;
    try {
      this.mutate(() => {});
    } catch (err) {
      this.log.error('ecosys: could not save AI activity', err.message);
    }
  }

  recentActivity(limit = 50) {
    const all = this.pendingActivity.length ? [...this.state.activity, ...this.pendingActivity].sort(byTime) : this.state.activity;
    return all.slice(-limit).reverse();
  }

  // ------------------------------------------------------------ undo history

  changeFile(changeId) {
    return typeof changeId === 'string' && CHANGE_ID_RE.test(changeId) ? join(this.changesDir, `${changeId}.json`) : null;
  }

  writeUndo(changeId, payload) {
    try {
      atomicWrite(this.changeFile(changeId), payload);
      return true;
    } catch (err) {
      this.log.error(`ecosys: could not save undo data for ${changeId}`, err.message);
      return false;
    }
  }

  dropUndo(changeId) {
    const file = this.changeFile(changeId);
    if (file) try { unlinkSync(file); } catch {}
  }

  /** Undo items still stored inside ai.json (written by an older version) move to changes/<id>.json. */
  moveInlineUndo(s) {
    let moved = false;
    for (const r of s.changes) {
      if (!r.before && !r.after) continue;
      const payload = JSON.stringify({ changeId: r.changeId, before: r.before || [], after: r.after || [] });
      delete r.before;
      delete r.after;
      r.bytes = Buffer.byteLength(payload);
      r.undoable = r.bytes <= this.maxUndoBytes && this.writeUndo(r.changeId, payload);
      moved = true;
    }
    if (moved) this.pruneUndo(s);
  }

  /** Keep at most MAX_CHANGES summaries and `undoBudget` bytes of undo data, newest first. */
  pruneUndo(s) {
    const gone = s.changes.length > MAX_CHANGES ? s.changes.splice(0, s.changes.length - MAX_CHANGES) : [];
    for (const r of gone) if (r.undoable) this.dropUndo(r.changeId);
    let total = 0;
    for (let i = s.changes.length - 1; i >= 0; i--) {
      const r = s.changes[i];
      if (!r.undoable) continue;
      total += r.bytes;
      if (total > this.undoBudget) {
        r.undoable = false;
        this.dropUndo(r.changeId);
      }
    }
  }

  /** Delete undo files that no summary points to (left by a crash) and stale temp files. Run under the lock. */
  sweepUndo() {
    if (this.unreadable) return; // never delete anything based on a file we could not read
    let names;
    try {
      names = readdirSync(this.changesDir);
    } catch {
      return;
    }
    const keep = new Set(this.state.changes.filter((r) => r.undoable && !r.before).map((r) => `${r.changeId}.json`));
    const t = Date.now();
    for (const n of names) {
      const file = join(this.changesDir, n);
      const stale = /^chg_[a-z0-9]+\.json$/i.test(n) ? !keep.has(n) : n.endsWith('.tmp') && t - (fileStamp(file)?.mtimeMs ?? t) > STALE_TMP_MS;
      if (stale) try { unlinkSync(file); } catch {}
    }
  }

  /**
   * Record a change made through ecosys (by an assistant, or an undo from the browser) together with
   * its activity entry, in one save. `before`/`after` = [{c, id, item|null}] go to
   * changes/<changeId>.json so the change can be undone; ai.json only gets the summary. A change
   * over `maxUndoBytes` is recorded without undo data (`undoable: false`, and its activity entry
   * gets no changeId, so nothing offers an Undo that cannot work). The activity entry of an undo
   * carries `undoOf`, so every open tab (it goes out over SSE) marks the change it took back.
   * `refs` lists the notes and folders the change edited (see changeRefs; ids only, so ai.json stays
   * small), plus any given (an undo adds those of the change it took back, whose summary it repeats).
   * Returns the summary record plus `entry`, the activity entry.
   */
  addChange({ client, tool, summary, before = [], after = [], undoOf = null, clientName = null, refs = [] }) {
    const changeId = `chg_${uid().slice(0, 12)}`;
    const payload = JSON.stringify({ changeId, before, after });
    const record = {
      changeId,
      at: Date.now(),
      clientId: client?.id || null,
      kind: client?.kind || 'other',
      label: client?.label || 'ecosys',
      tool: clean(tool, 60),
      summary: clean(summary, 300),
      undoOf,
      undoneBy: null,
      undoable: false,
      bytes: Buffer.byteLength(payload),
      refs: cleanRefs([...(Array.isArray(refs) ? refs : []), ...changeRefs(before, after, this.normalizeNote)]),
      cols: colsOf(before, after),
    };
    const entry = this.makeActivity({ client, tool, summary, clientName, undoOf });
    this.withLock(() => {
      // The undo file goes first, under the same lock: once the summary is in ai.json another
      // process may undo it, and the sweep never sees a file whose summary is still on its way.
      record.undoable = record.bytes <= this.maxUndoBytes && this.writeUndo(changeId, payload);
      if (record.undoable) entry.changeId = changeId;
      this.mutate((s) => {
        s.changes.push(record);
        if (undoOf) {
          const orig = s.changes.find((x) => x.changeId === undoOf);
          if (orig) orig.undoneBy = changeId;
        }
        this.pruneUndo(s);
        this.pushActivity(s, entry);
      });
    });
    return { ...record, entry };
  }

  change(changeId) {
    return this.state.changes.find((c) => c.changeId === changeId) || null;
  }

  /** The undo items of a change, {before, after}, or null when they are not kept. */
  changePayload(rec) {
    if (!rec) return null;
    if (rec.before || rec.after) return { before: rec.before || [], after: rec.after || [] }; // not moved out yet
    if (!rec.undoable) return null;
    const file = this.changeFile(rec.changeId);
    let p = null;
    try {
      p = file ? readJson(file, null) : null;
    } catch (err) {
      this.log.error(`ecosys: undo data for ${rec.changeId} is unreadable`, err.message);
    }
    if (!isPlainObject(p) || p.changeId !== rec.changeId || !Array.isArray(p.before) || !Array.isArray(p.after)) return null;
    return { before: p.before, after: p.after };
  }

  recentChanges(limit = 20) {
    return this.state.changes.slice(-limit).reverse();
  }

  /** The collections change `rec` touched, or null when that can't be known any more (no undo data). */
  changeCollections(rec) {
    if (Array.isArray(rec.cols)) return rec.cols;
    const p = this.changePayload(rec);
    return p ? colsOf(p.before, p.after) : null;
  }

  /**
   * Forget the change history of collections `cols`, which a browser replaced as a whole (Erase
   * everything, Start over with sample data, a restored backup): every change that touched one of them
   * (or that can't tell any more what it touched) loses its record and its undo data, so no undo can
   * bring an erased item back and no summary names one; their activity entries lose their Undo.
   * `everything` (every collection was replaced): the whole history goes, the activity list too.
   * Returns how many changes were forgotten.
   */
  forgetChanges(cols, { everything = false } = {}) {
    const hit = new Set(cols);
    const gone = [];
    this.mutate((s) => {
      s.changes = s.changes.filter((r) => {
        const touched = everything ? null : this.changeCollections(r);
        if (touched && !touched.some((c) => hit.has(c))) return true;
        gone.push(r);
        return false;
      });
      const ids = new Set(gone.map((r) => r.changeId));
      if (everything) {
        s.activity = [];
        this.pendingActivity = [];
      } else for (const e of s.activity) if (e.changeId && ids.has(e.changeId)) e.changeId = null;
    });
    // Once the history no longer lists them (a failed save above throws and keeps everything).
    for (const r of gone) if (r.undoable || r.before) this.dropUndo(r.changeId);
    if (everything) this.rememberActivity();
    return gone.length;
  }

  // ------------------------------------------------------------ views for the browser

  statusClients() {
    const t = Date.now();
    return this.state.clients.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      access: c.access,
      connected: this.isConnected(c, t),
      lastSeen: this.lastSeen(c),
    }));
  }

  /**
   * Every connection as the browser lists it, without its key (GET /api/ai/status). The fields are
   * picked one by one, so a key, or anything secret added to a credential later, never ends up here.
   */
  publicClients() {
    const t = Date.now();
    return this.state.clients.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      access: c.access,
      connected: this.isConnected(c, t),
      lastSeen: this.lastSeen(c),
      lastClientName: c.lastClientName,
      createdAt: c.createdAt,
    }));
  }

  fullClients() {
    const t = Date.now();
    return this.state.clients.map((c) => ({
      ...c,
      lastSeen: this.lastSeen(c),
      connected: this.isConnected(c, t),
      secretPath: `/s/${c.token}/mcp`,
    }));
  }
}
