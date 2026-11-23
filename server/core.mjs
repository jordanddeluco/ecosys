// The ecosys core shared by the HTTP server and the stdio MCP bridge: data store, AI credentials,
// tools, undo history and the MCP handler. `emit(event, payload)` tells the outside world about
// changes ('ops' and 'ai' events); the HTTP server sends them to browsers over SSE, the stdio
// bridge forwards them to a running HTTP server.
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DataStore } from './store.mjs';
import { AIStore, changeRefs, isRelink } from './ai-store.mjs';
import { loadValidators, COLLECTIONS } from './validate.mjs';
import { loadTools, checkArgs, ToolError } from './tools.mjs';
import { createMcpHandler } from './mcp.mjs';
import { clock as makeClock, todayLine, HHMM_RE, timeZone, validTimeZone } from './model.mjs';
import { createLock, cleanText, describeError, ensureDir, isId, isPlainObject, LockError, secureDataDir } from './util.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DATA_DIR = join(ROOT, '.ecosys');

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const USER = { id: null, kind: 'user', label: 'You' };
const MAX_TEXT = 60000;
/** structuredContent of one result, as JSON. Past this its longest arrays are shortened (fitData). */
export const MAX_DATA_BYTES = 256 * 1024;

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v) ?? '');

/**
 * `data` within `maxBytes` of JSON: while it is over, the array with the most items (at any depth) is
 * cut to half its length, and `truncated: true` is set at the top. Every field stays, so the result
 * still matches the tool's outputSchema; the text says what was left out. `data` itself is not changed.
 */
export function fitData(data, maxBytes = MAX_DATA_BYTES) {
  if (!isPlainObject(data) || jsonBytes(data) <= maxBytes) return data;
  const out = structuredClone(data);
  for (let i = 0; i < 200 && jsonBytes(out) > maxBytes; i++) {
    let longest = null;
    const walk = (v) => {
      if (Array.isArray(v)) {
        if (v.length > 1 && (!longest || v.length > longest.length)) longest = v;
        v.forEach(walk);
      } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(out);
    if (!longest) break;
    longest.length = Math.floor(longest.length / 2);
  }
  out.truncated = true;
  return out;
}

/** Plain words for the file-system errors an internal error usually is: what the user can check. */
const FS_TROUBLE = {
  ENOSPC: 'the disk is full',
  EROFS: 'the data folder is on a read-only drive',
  EPERM: 'a file in the data folder could not be written (read-only, or blocked by another program)',
  EACCES: 'a file in the data folder could not be written (read-only, or blocked by another program)',
  EBUSY: 'a file in the data folder is in use by another program',
  EMFILE: 'too many files are open on the computer',
  ENFILE: 'too many files are open on the computer',
};

/** A path with symlinks, junctions and 8.3 short names resolved, as far as it exists (the rest is appended). */
function realish(p) {
  const rest = [];
  let cur = p;
  for (let i = 0; i < 256; i++) {
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch {}
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  return p;
}

/** Which folder `p` is on disk (volume and file id), or null: missing, not a folder, or no file ids there. */
function folderIdentity(p) {
  try {
    const s = statSync(p, { bigint: true });
    return s.isDirectory() && s.ino !== 0n ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * Why `dataDir` can't hold the ecosys data, or null when it can. The server serves the folder it runs
 * from (`root`) to browsers, so a data folder inside it would be served like the apps, ai.json and its
 * connection keys included, unless a folder on its way down from `root` has a name starting with a dot
 * (never served, like the default .ecosys). Both paths are compared with symlinks, junctions and 8.3
 * short names resolved, and then by file identity: a folder of the data folder's path that is the
 * root under another name (this machine's own share, such as \\localhost\c$\..., or a bind mount)
 * counts as the root. `label` names the setting in the message.
 */
export function dataDirProblem(dataDir, { root = ROOT, label = 'ECOSYS_DATA_DIR' } = {}) {
  const rootReal = realish(resolve(root));
  const dirReal = realish(resolve(dataDir));
  let rel = relative(rootReal, dirReal);
  let inside = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  const rootId = inside ? null : folderIdentity(rootReal);
  if (rootId) {
    for (let cur = dirReal, i = 0; i < 256; i++) {
      if (folderIdentity(cur) === rootId) {
        rel = relative(cur, dirReal);
        inside = true;
        break;
      }
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  if (!inside || rel.split(/[\\/]/).some((s) => s.startsWith('.'))) return null;
  return `${label} ${resolve(dataDir)} is inside the folder ecosys serves (${resolve(root)}), so your data and AI connection keys would be served with the apps. Use a folder outside it, or one whose name starts with a dot (like .ecosys).`;
}

const NOT_FOR_AI = 'not available to AI assistants';
/** Why core.undo left an item alone: it was edited after the change, or it goes with one that was (linkedItems). */
const CHANGED_AGAIN = 'changed again since';
const GOES_WITH = 'goes with an item that changed again since';
const MASKED_SUMMARY = 'Changed a note or folder that is hidden from AI assistants';

/**
 * settings.notesAi as the notes tools read it (server/tools-notes.mjs notesAiAccess, which is used
 * when it loads): unset is 'edit'; 'edit', 'read' and 'off' in any case, spaces ignored; any other
 * value counts as 'read', never as 'edit'. `st` is the store or a transaction.
 */
export function notesAccessOf(st) {
  const s = typeof st?.settings === 'function' ? st.settings() : st?.settings;
  const v = s && typeof s === 'object' ? s.notesAi : undefined;
  if (v === undefined || v === null || v === '') return 'edit';
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return k === 'edit' || k === 'off' ? k : 'read';
}

/**
 * Settings the tools use, with defaults. Working hours come from the app-prefixed settings
 * `scheduleWorkStart` / `scheduleWorkEnd` ('HH:MM'; allowed by shared/sanitize.js), else 09:00-17:00
 * (also when the two don't make a range: an end that is not after the start). `workHoursSet`: they
 * came from the settings.
 */
export function effectiveSettings(s = {}) {
  const intIn = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  const hhmm = (...vals) => vals.find((v) => typeof v === 'string' && HHMM_RE.test(v));
  const setStart = hhmm(s.scheduleWorkStart, s.workStart);
  const setEnd = hhmm(s.scheduleWorkEnd, s.workEnd);
  let workStart = setStart || '09:00';
  let workEnd = setEnd || '17:00';
  let workHoursSet = !!(setStart || setEnd);
  if (workEnd <= workStart) {
    [workStart, workEnd] = ['09:00', '17:00'];
    workHoursSet = false;
  }
  return {
    workHoursSet,
    weekStart: intIn(s.weekStart, 0, 6, 0),
    timeFormat: ['auto', '12h', '24h'].includes(s.timeFormat) ? s.timeFormat : 'auto',
    defaultEventMinutes: intIn(s.defaultEventMinutes, 5, 1440, 60),
    defaultTaskMinutes: intIn(s.defaultTaskMinutes, 5, 1440, 30),
    workStart,
    workEnd,
  };
}

/**
 * Delete the notes whose time in Recently Deleted (30 days) is up, as ecosys starts (notes-spec
 * section 8), with the notes tools' own helper. It runs under the data lock right after a reload, so a
 * note another process restores meanwhile is never deleted, and it is shown only notes the apps
 * count as deleted (a trashedAt that is set and not 0). Never fatal. Returns how many were deleted.
 */
export async function purgeNotesTrash(store, log = console) {
  if (!store.all('notes').some((n) => n?.trashedAt)) return 0; // the usual case: no lock needed
  let purge;
  try {
    purge = (await import('./tools-notes.mjs')).purgeExpiredNotes;
  } catch {
    return 0; // loadTools has already said why the notes tools are missing
  }
  if (typeof purge !== 'function') return 0;
  try {
    const removed = store.withLock(() => {
      store.refresh();
      // What the helper reads and writes through. The apps treat a trashedAt of 0 as "not deleted"
      // (`n.trashedAt && ...`), so such a note is left out rather than purged as deleted in 1970.
      const inTrash = {
        all: (c) => store.all(c).filter((x) => c !== 'notes' || x?.trashedAt),
        transaction: (fn) => store.transaction(fn),
      };
      return purge(inTrash);
    });
    if (removed > 0) log.info?.(`ecosys: deleted ${removed} note(s) whose time in Recently Deleted was up`);
    return Number.isInteger(removed) ? removed : 0;
  } catch (err) {
    log.error?.(`ecosys: could not empty the notes trash: ${describeError(err)}`);
    return 0;
  }
}

/**
 * @param {{dataDir?:string, emit?:Function, log?:Console}} opts
 */
export async function createCore({ dataDir = DEFAULT_DATA_DIR, emit = () => {}, log = console } = {}) {
  // Only this user may open the data folder (AI keys and all data): a new one is made private as it
  // is created (ensureDir), an existing one at every start (Windows; never fatal, a warning at most).
  ensureDir(dataDir);
  secureDataDir(dataDir, log);
  const validators = await loadValidators({ log });
  // Hide from AI and the notes access setting (notes-spec section 7) bind undo_change and find_changes
  // as they bind the notes tools. Loaded like validate.mjs loads it; without it, notes and folders are
  // off limits to assistants, and no note is written (the plain record schema would drop its blocks).
  const noteRules = validators.notes === false ? null : await import('../notes/core/schema.js').catch(() => null);
  // A note as the store saves it. Records are kept as they were loaded (an older one may have an HTML
  // body and no blocks), so versions are compared in this form when telling a moved meeting-note link
  // from an edit of the note.
  const normalizeNote = noteRules && typeof noteRules.validateNote === 'function' ? noteRules.validateNote : null;
  /** Note `n` in the store's form, or `n` itself when it can't be put in that form. */
  const canonNote = (n) => {
    if (!normalizeNote || !isPlainObject(n)) return n;
    try {
      return normalizeNote(n) || n;
    } catch {
      return n;
    }
  };
  const lock = createLock(join(dataDir, 'lock'));
  const store = new DataStore({ dir: dataDir, validators, lock, log });
  const ai = new AIStore({ dir: dataDir, lock, log, normalizeNote });
  const tools = await loadTools({ log });
  await purgeNotesTrash(store, log);
  // The notes tools' own reading of the notes access setting, so the two can never disagree.
  const toolsAccess = await import('./tools-notes.mjs').then((m) => (typeof m.notesAiAccess === 'function' ? m.notesAiAccess : null), () => null);
  const notesAccess = (st) => {
    try {
      const a = toolsAccess?.(st);
      if (a === 'edit' || a === 'read' || a === 'off') return a;
    } catch {}
    return notesAccessOf(st);
  };

  /**
   * What an assistant may see of notes and folders in `st` (the store or a transaction), as the notes
   * tools decide it: nothing while notes access is Off; otherwise no note or folder hidden from AI, no
   * note or folder inside a hidden folder (at any depth) and no locked note.
   */
  function aiView(st) {
    const off = !noteRules || notesAccess(st) === 'off';
    const folders = off ? null : new Map(st.all('folders').map((f) => [f.id, f]));
    const noteOk = (n) => !isPlainObject(n) || !noteRules.noteHiddenFromAi(n, folders);
    const folderOk = (f) => !isPlainObject(f) || (!f.aiHidden && !noteRules.folderHiddenFromAi(f.parentId, folders));
    return {
      /** Whether item `id` of collection `c` may be shown, in every version given (other collections: yes). */
      sees(c, id, versions) {
        if (c !== 'notes' && c !== 'folders') return true;
        if (off) return false;
        if (c === 'notes') return versions.every(noteOk);
        return !noteRules.folderHiddenFromAi(id, folders) && versions.every(folderOk);
      },
    };
  }

  // Change records saved before they listed the notes and folders they edited (`refs`): worked out once
  // from their undo data. A record without undo data that came from a notes tool counts as one that
  // edited some note (shown unless notes access is Off).
  const oldRefs = new Map();
  function refsOf(rec) {
    if (Array.isArray(rec.refs)) return rec.refs;
    if (!oldRefs.has(rec.changeId)) {
      const p = ai.changePayload(rec);
      if (oldRefs.size > 1000) oldRefs.clear();
      oldRefs.set(rec.changeId, p ? changeRefs(p.before, p.after, normalizeNote) : /^(notes_|undo_change$)/.test(rec.tool) ? ['notes:'] : []);
    }
    return oldRefs.get(rec.changeId);
  }

  /** A change's summary as an assistant may read it: one that edited a note or folder it can't see now isn't described. */
  function summaryFor(rec, view, st) {
    const hidden = refsOf(rec).some((ref) => {
      const [c, id] = ref.split(':');
      return !view.sees(c, id, [id ? st.get(c, id) : null]);
    });
    return hidden ? MASKED_SUMMARY : rec.summary;
  }

  const core = { dataDir, store, ai, tools, validators, version: VERSION, log, emit: (...a) => core.emitter(...a), emitter: emit };

  /**
   * Notes access now ('edit' | 'read' | 'off'), as every notes tool applies it (tools/list follows it).
   * `refresh: false`: as data.json was last loaded (no file access; the MCP handler's timer path).
   */
  core.notesAccess = ({ refresh = true } = {}) => {
    if (refresh) store.refresh();
    return notesAccess(store);
  };

  // A browser replacing whole collections (Erase everything, Start over with sample data, restoring a
  // backup) leaves no AI change history behind for them: no undo can bring an erased item back, and
  // find_changes names none. Erasing every collection clears the AI activity list too.
  //  - Every replace the request carries counts, unless the store refused it: one of a collection that
  //    was empty already changes nothing, and still means "this collection was reset".
  //  - The replace and the forgetting happen under one hold of the data lock, and a tool's change is
  //    recorded under the same hold as its transaction (callTool, core.undo): a change made in another
  //    process (the stdio bridge) lands wholly before the erase (and is forgotten) or wholly after it.
  //  - Should the history not be cleared (ai.json can't be written), core.undo still refuses a change
  //    made before its collection was replaced (data.json keeps when: replacedSince).
  const applyOps = store.applyOps.bind(store);
  store.applyOps = (ops) => {
    if (!Array.isArray(ops) || !ops.some((o) => isPlainObject(o) && o.op === 'replace')) return applyOps(ops); // sync's usual puts
    return lock(() => {
      const out = applyOps(ops);
      const refused = new Set((Array.isArray(out?.rejected) ? out.rejected : []).map((r) => r?.index));
      const replaced = new Set();
      ops.forEach((o, i) => {
        if (isPlainObject(o) && o.op === 'replace' && COLLECTIONS.includes(o.c) && !refused.has(i)) replaced.add(o.c);
      });
      for (const o of Array.isArray(out?.applied) ? out.applied : []) if (o?.op === 'replace' && COLLECTIONS.includes(o.c)) replaced.add(o.c);
      if (replaced.size) {
        try {
          ai.forgetChanges([...replaced], { everything: COLLECTIONS.every((c) => replaced.has(c)) });
        } catch (err) {
          log.error(`ecosys: could not clear the AI change history of the replaced collections: ${describeError(err)}`);
        }
      }
      return out;
    });
  };

  /** When collection `c` was last replaced as a whole and lost records (data.json `replaced`, ms), or 0. */
  const replacedAt = (c) => {
    const t = isPlainObject(store.replaced) ? store.replaced[c] : 0;
    return Number.isFinite(t) ? t : 0;
  };
  /** Whether change `rec` was made before a collection it touched (any, when that can't be told) was replaced. */
  const replacedSince = (rec) => {
    const at = rec.at || 0;
    if (!COLLECTIONS.some((c) => replacedAt(c) > at)) return false; // the usual case: nothing replaced since
    return (ai.changeCollections(rec) || COLLECTIONS).some((c) => replacedAt(c) > at);
  };

  const emitSafe = (event, payload) => {
    try {
      core.emit(event, payload);
    } catch (err) {
      log.error('ecosys: emit failed', err);
    }
  };

  core.statusPayload = () => ({ type: 'status', mode: ai.mode(), clients: ai.statusClients() });

  /** 'write' or 'read' for a credential, taking the global mode into account. */
  core.accessFor = (client) => (!client || client.access === 'read' || ai.mode() === 'read' ? 'read' : 'write');

  /**
   * The tools a credential may use now: write tools only with write access (the connection's own and
   * the global AI access), and notes tools as the notes access setting allows (Read: no notes write
   * tools; Off: no notes tools). tools/list shows these, tool results name only these (ctx.offers),
   * and every call checks the same rules again. `refresh: false`: notes access as data.json was last
   * loaded (no file access).
   */
  core.offeredTools = (client, { refresh = true } = {}) => {
    const access = core.accessFor(client);
    const notes = core.notesAccess({ refresh });
    return tools.filter((t) => (access === 'write' || !t.write) && (!t.name.startsWith('notes_') || (notes !== 'off' && (notes === 'edit' || !t.write))));
  };

  /** Bookkeeping for every authenticated MCP request; fires the "connected" animation event. */
  core.seen = (client, { clientName = null, handshake = false } = {}) => {
    if (!client?.id) return;
    const fire = ai.touch(client.id, { clientName, handshake });
    if (fire) {
      const c = ai.get(client.id) || client;
      emitSafe('ai', { type: 'connected', client: { id: c.id, kind: c.kind, label: c.label }, clientName: clientName || c.lastClientName || null });
      emitSafe('ai', core.statusPayload());
    }
  };

  const textResult = (text, isError = false, data) => {
    let t = cleanText(text);
    if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT)}\n[output truncated; narrow the request]`;
    const out = { content: [{ type: 'text', text: t }], isError };
    if (data !== undefined) out.structuredContent = fitData(data);
    return out;
  };
  // The tools' clock runs in the time zone the apps last reported (settings.uiTimeZone), else this
  // process's own: see model.mjs clock().
  const userZone = () => store.settings()?.uiTimeZone;
  core.timeZone = () => validTimeZone(userZone()) || timeZone();
  const errorResult = (msg) => textResult(`${msg} ${todayLine(makeClock(new Date(), userZone()))}`, true);

  /**
   * Log a tool call: an activity entry, plus an undo record when it changed data. Calls that changed
   * nothing (reads, dry runs) are saved lazily. The data is already saved when this runs, so a
   * failure here is logged and the call still succeeds, just without a change_id.
   */
  function record(actor, tool, summary, changes, { undoOf = null, clientName = null, refs = [] } = {}) {
    try {
      if (!changes.length) return { changeId: null, undoable: false, entry: ai.addActivity({ client: actor, tool, summary, clientName }, { defer: true }) };
      const rec = ai.addChange({
        client: actor,
        tool,
        summary,
        clientName,
        undoOf,
        refs,
        before: changes.map(({ c, id, before }) => ({ c, id, item: before })),
        after: changes.map(({ c, id, after }) => ({ c, id, item: after })),
      });
      return { changeId: rec.changeId, undoable: rec.undoable, bytes: rec.bytes, entry: rec.entry };
    } catch (err) {
      log.error(`ecosys: could not save the history of ${tool}`, err?.message || err);
      return { changeId: null, undoable: false, entry: null };
    }
  }

  const isUndoItem = (x) => isPlainObject(x) && COLLECTIONS.includes(x.c) && isId(x.id) && (x.item == null || isPlainObject(x.item));
  /** What the change_id line says about undo. */
  const undoNote = ({ undoable, bytes }, ok) => (undoable ? ok : bytes > ai.maxUndoBytes ? 'too large to undo' : 'cannot be undone');

  function broadcast(actor, ops, rev, entry) {
    if (ops?.length) emitSafe('ops', { rev, origin: actor?.id ? `ai:${actor.id}` : 'server', ops });
    if (entry) emitSafe('ai', { type: 'activity', entry });
  }

  /**
   * Revert a recorded change. Items that were edited again since are skipped (and reported).
   * `actor` is the credential asking (null = the local user in the browser). For an assistant, the
   * notes rules hold as in the notes tools: a note or folder it can't see now (hidden from AI, in a
   * hidden folder, locked, or notes access Off), or any note while notes access is Read, is left as it
   * is and never named. Undoing the creation of a note moves it to Recently Deleted, as the Notes app
   * does; a folder the change created is removed only while nothing else is in it. A meeting note's
   * link that moved with its event goes back with the event, and only then.
   */
  core.undo = (changeId, actor = null, clientName = null) => {
    // The transaction and its record under one hold of the data lock (see store.applyOps above).
    const done = lock(() => {
      ai.refresh();
      const rec = typeof changeId === 'string' ? ai.change(changeId) : null;
      if (!rec) throw new ToolError(`No change with id "${cleanText(changeId).slice(0, 40)}". Use find_changes to list recent changes.`);
      store.refresh();
      // Its summary may name what was erased: not repeated.
      if (replacedSince(rec)) throw new ToolError(`Change ${rec.changeId} was made before this data was erased or replaced in ecosys (Erase everything, Start over with sample data, or a restored backup), so it can't be undone.`);
      const shown = actor ? summaryFor(rec, aiView(store), store) : rec.summary;
      if (rec.undoneBy) throw new ToolError(`Change ${rec.changeId} was already undone (by ${rec.undoneBy}).`);
      const undo = ai.changePayload(rec);
      if (!undo) {
        throw new ToolError(
          rec.bytes > ai.maxUndoBytes
            ? `Change ${rec.changeId} (${shown}) was too large to keep undo data for, so it cannot be undone.`
            : `The undo data for ${rec.changeId} (${shown}) is no longer kept; only recent changes can be undone.`,
        );
      }
      return { rec, shown, ...revert(rec, undo, actor, clientName) };
    });
    const { rec, shown, result, changes, ops, rev } = done;
    const blocked = result.skipped.filter((s) => s.reason === NOT_FOR_AI);
    const again = result.skipped.filter((s) => s.reason !== NOT_FOR_AI && s.reason !== GOES_WITH);
    const held = result.skipped.filter((s) => s.reason === GOES_WITH);
    const titles = (list) => list.map((s) => JSON.stringify(s.title)).join(', ');
    const named = (list) =>
      list
        .map((s) => (s.part === 'completion' ? `the logged completion of ${JSON.stringify(s.title)}` : s.part === 'occurrence' ? `the separately edited occurrence ${JSON.stringify(s.title)}` : `${s.c.slice(0, -1)} ${JSON.stringify(s.title)}`))
        .join(', ');
    if (!changes.length) {
      if (blocked.length && !again.length) {
        throw new ToolError(`Nothing was undone: ${rec.changeId} changed notes or folders the user doesn't let AI assistants see or change now (hidden from AI, or notes access set to Read or Off in ecosys).`);
      }
      throw new ToolError(
        again.length
          ? `Nothing was undone: ${again.length} item(s) were changed again after ${rec.changeId} (${titles(again)})${held.length ? `, and what goes with them was left as it is too (${named(held)})` : ''}${blocked.length ? `, and the rest are notes or folders the user doesn't let AI assistants change` : ''}.`
          : `Nothing to undo for ${rec.changeId}; everything is already as it was.`,
      );
    }
    broadcast(done.who, ops, rev, done.logged.entry);
    const newId = done.logged.changeId;
    const lines = [`Undid ${rec.changeId} (${shown}): restored ${result.restored} item(s).`];
    if (again.length) lines.push(`Left alone because they changed again since: ${named(again)}.`);
    if (held.length) lines.push(`Also left alone, as they go with those: ${named(held)}.`);
    if (blocked.length) lines.push(`Left alone because the user doesn't let AI assistants see or change them: ${blocked.length} note(s) or folder(s).`);
    if (newId) lines.push(`change_id=${newId} (${undoNote(done.logged, 'undo_change on it re-applies the change')})`);
    return { text: lines.join('\n'), data: { restored: result.restored, skipped: result.skipped, undone: rec.changeId, change_id: newId }, summary: done.summary, recorded: true, rev };
  };

  /**
   * Put back what change `rec` changed (its undo data `undo`), in one transaction, and record that as
   * a change of its own (under the caller's lock hold). See core.undo for the rules.
   */
  function revert(rec, undo, actor, clientName) {
    // The undo file is ours, but it is still a file on disk: only well-formed entries are applied.
    const before = undo.before.filter(isUndoItem);
    const afterMap = new Map(undo.after.filter(isUndoItem).map((a) => [`${a.c}\u0000${a.id}`, a.item ?? null]));
    const { result, changes, ops, rev } = store.transaction((tx) => {
      const view = actor ? aiView(tx) : null;
      // Read, Off, or a value this version doesn't know (read as Read): an assistant changes no note.
      const readOnlyNotes = !!actor && notesAccess(tx) !== 'edit';
      const together = linkedItems(rec, before, afterMap, tx);
      let restored = 0;
      const skipped = [];
      const links = [];
      const trashedHere = new Set(); // notes this undo moves to Recently Deleted (their creation is undone)
      const madeFolders = []; // folders the change created: removed last (see below)
      for (const b of before) {
        const expected = afterMap.get(`${b.c}\u0000${b.id}`) ?? null;
        if (isRelink(b.c, b.item, expected, normalizeNote)) {
          links.push({ id: b.id, from: expected.event ?? null, to: canonNote(b.item).event ?? null });
          continue;
        }
        const cur = tx.get(b.c, b.id);
        if ((b.c === 'notes' || b.c === 'folders') && view && (readOnlyNotes || !view.sees(b.c, b.id, [cur, expected, b.item]))) {
          // Not named, and without its id: an assistant learns only that something was left alone, and why.
          skipped.push({ c: b.c, id: null, title: b.c === 'notes' ? 'a note' : 'a folder', reason: NOT_FOR_AI });
          continue;
        }
        const name = (cur || expected || b.item)?.title || (cur || expected || b.item)?.name || b.id;
        if (JSON.stringify(cur ?? null) !== JSON.stringify(expected)) {
          skipped.push({ c: b.c, id: b.id, title: name, reason: CHANGED_AGAIN });
          continue;
        }
        if (together.heldBack(b.c, b.id)) {
          const x = cur || expected || b.item;
          skipped.push({ c: b.c, id: b.id, title: name, reason: GOES_WITH, ...(x?.repeatOf ? { part: 'completion' } : x?.seriesId ? { part: 'occurrence' } : {}) });
          continue;
        }
        if (b.c === 'folders' && !b.item && cur && noteRules) {
          madeFolders.push({ id: b.id, name });
          continue;
        }
        try {
          if ((b.c === 'notes' || b.c === 'folders') && !noteRules) throw new Error('the notes schema is not loaded');
          if (b.item) tx.put(b.c, b.item);
          else if (b.c === 'notes' && cur) {
            const t = Date.now();
            tx.put('notes', { ...cur, aiPrev: null, trashedAt: t, trashedFrom: cur.folderId || null, rev: (cur.rev || 0) + 1, updatedAt: t });
            trashedHere.add(b.id);
          } else tx.del(b.c, b.id);
          restored++;
        } catch {
          skipped.push({ c: b.c, id: b.id, title: name, reason: 'could not be restored' });
        }
      }
      // A folder the change created goes only while nothing else is in it: a note filed there since (one
      // in Recently Deleted too, which Recover puts back there) or a folder made inside it would lose its
      // place, and with it any hidden folder above that keeps it from assistants. The change's own notes
      // that this undo moved to Recently Deleted don't count. Inner folders go first.
      if (madeFolders.length) {
        const filed = new Set();
        for (const n of tx.all('notes')) {
          if (!isPlainObject(n) || trashedHere.has(n.id)) continue;
          if (n.folderId) filed.add(n.folderId);
          if (n.trashedFrom) filed.add(n.trashedFrom);
        }
        const inUse = (id) => filed.has(id) || tx.all('folders').some((f) => f?.parentId === id);
        let left = madeFolders;
        for (let progress = true; progress && left.length; ) {
          progress = false;
          left = left.filter((f) => {
            if (inUse(f.id)) return true;
            tx.del('folders', f.id);
            restored++;
            progress = true;
            return false;
          });
        }
        for (const f of left) skipped.push({ c: 'folders', id: f.id, title: f.name, reason: CHANGED_AGAIN });
      }
      // Meeting-note links: back to where they were when every event of the change went back too, and
      // only links nobody has moved since (the note itself may have been edited: only its link changes).
      // Bookkeeping for the events, so never counted or named, whoever can see the note.
      if (noteRules && !skipped.some((s) => s.c === 'events')) {
        const t = Date.now();
        for (const l of links) {
          const cur = tx.get('notes', l.id);
          if (!cur || JSON.stringify(cur.event ?? null) !== JSON.stringify(l.from)) continue;
          try {
            const n = canonNote(cur);
            tx.put('notes', { ...n, event: l.to, rev: (Number.isInteger(n.rev) ? n.rev : 0) + 1, updatedAt: t });
          } catch {}
        }
      }
      return { restored, skipped };
    });
    const who = actor || USER;
    const summary = `Undid: ${rec.summary}`.slice(0, 300);
    if (!changes.length) return { result, changes, ops, rev, who, summary, logged: null };
    // The undo repeats the summary of the change it took back, so it keeps that change's notes and folders.
    const refs = Array.isArray(rec.refs) ? rec.refs : changeRefs(undo.before, undo.after, normalizeNote);
    const logged = record(who, 'undo_change', summary, changes, { undoOf: rec.changeId, clientName, refs });
    return { result, changes, ops, rev, who, summary, logged };
  }

  /**
   * Items of a change that belong together, so an undo takes them back together or not at all: a
   * repeating task and the done copy its completion logged (repeatOf), a series and an occurrence
   * edited on its own (seriesId), and every event of one update_event edit (a split series and the
   * series it came from). When one of them changed again since, the rest are held back too: half an
   * undo would lose a completion while the task stays moved on, or the days of a split series.
   * → {heldBack(c, id)}: true for an item that is unchanged but goes with one that changed.
   */
  function linkedItems(rec, before, afterMap, tx) {
    const key = (c, id) => `${c}\u0000${id}`;
    const parent = new Map();
    const find = (k) => {
      while (parent.get(k) !== k) k = parent.get(k);
      return k;
    };
    const union = (a, b) => parent.set(find(a), find(b));
    const items = before.filter((b) => b.c === 'tasks' || b.c === 'events');
    for (const b of items) parent.set(key(b.c, b.id), key(b.c, b.id));
    const changed = new Set();
    for (const b of items) {
      const k = key(b.c, b.id);
      const cur = tx.get(b.c, b.id);
      const expected = afterMap.get(k) ?? null;
      if (JSON.stringify(cur ?? null) !== JSON.stringify(expected)) changed.add(k);
      for (const v of [b.item, expected, cur]) {
        for (const ref of [v?.repeatOf, v?.seriesId]) if (typeof ref === 'string' && parent.has(key(b.c, ref))) union(k, key(b.c, ref));
      }
    }
    const undone = rec.tool === 'undo_change' && rec.undoOf ? ai.change(rec.undoOf) : null;
    if (rec.tool === 'update_event' || undone?.tool === 'update_event') {
      const evs = items.filter((b) => b.c === 'events').map((b) => key(b.c, b.id));
      for (const k of evs.slice(1)) union(evs[0], k);
    }
    const hit = new Set([...changed].map(find));
    return { heldBack: (c, id) => parent.has(key(c, id)) && !changed.has(key(c, id)) && hit.has(find(key(c, id))) };
  }

  /**
   * Recent recorded changes, newest first. With `forAi` (find_changes), a change that edited a note or
   * folder the assistant can't see now is listed without its summary, which may name it. A change made
   * before its data was erased or replaced is not listed (normally it is forgotten then; see applyOps).
   */
  core.recentChanges = (limit, { forAi = false } = {}) => {
    ai.refresh();
    store.refresh();
    const list = ai.recentChanges(limit).filter((r) => !replacedSince(r));
    if (!forAi) return list;
    const view = aiView(store);
    return list.map((r) => {
      const summary = summaryFor(r, view, store);
      return summary === r.summary ? r : { ...r, summary };
    });
  };

  /**
   * Run a tool for a credential. Returns an MCP CallToolResult-like object, or {protocolError}.
   */
  core.callTool = (name, args, { client, clientName = null } = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { protocolError: { code: -32602, message: `Unknown tool: ${cleanText(name).slice(0, 60)}` } };
    ai.refresh();
    const fresh = client?.id ? ai.get(client.id) || null : client;
    if (client?.id && !fresh) return errorResult('This ecosys connection was removed. Reconnect from ecosys, Connect AI.');
    if (ai.mode() === 'off') return errorResult('AI access is turned off in ecosys. The user can turn it back on in ecosys under Connect AI.');
    if (tool.write && core.accessFor(fresh) === 'read') {
      // Two switches can make a call read-only; name the one(s) that are set.
      const globalRead = ai.mode() === 'read';
      const connRead = !fresh || fresh.access === 'read';
      return errorResult(
        globalRead && !connRead
          ? `AI access in ecosys is set to read-only for every connection (Connect AI, AI access: Read only), so ${name} is not available. This connection itself allows changes; the user can switch AI access back to Read & write there.`
          : globalRead
            ? `This ecosys connection is read-only, and AI access in ecosys is set to read-only for every connection, so ${name} is not available. The user can allow changes in ecosys under Connect AI (AI access, and this connection).`
            : `This ecosys connection is read-only, so ${name} is not available. The user can allow changes for it in ecosys under Connect AI.`,
      );
    }
    if (!isPlainObject(args)) return { protocolError: { code: -32602, message: 'arguments must be an object' } };
    store.refresh();
    const clk = makeClock(new Date(), userZone());
    const settingsNow = () => effectiveSettings(store.settings());
    let offered = null; // the names of the tools this session is offered, worked out when first asked
    const ctxBase = {
      clock: clk,
      client: fresh,
      clientName,
      mode: ai.mode(),
      // Whether tool `n` is listed for this session now (core.offeredTools, as tools/list shows them),
      // so a result never points an assistant to a tool it can't call (a read-only connection, notes
      // access Read or Off). The store was just read, so notes access needs no second read.
      offers: (n) => (offered ??= new Set(core.offeredTools(fresh, { refresh: false }).map((t) => t.name))).has(n),
      recentChanges: (n) => core.recentChanges(n, { forAi: true }),
      undo: (id) => core.undo(id, fresh, clientName),
      // false: notes can't be written safely (notes/core/schema.js didn't load), so tools leave them alone.
      notesSchema: !!noteRules,
      // A stored note in the form the store saves (an older record may lack blocks): see relinkNotes.
      normalizeNote: canonNote,
      // Which notes in `st` this assistant may change now (complete_tasks mirrors a task's checklist
      // items into them): a test for one note, or null while notes access is not Edit.
      notesEditable: (st) => {
        if (!noteRules || notesAccess(st) !== 'edit') return null;
        const view = aiView(st);
        return (n) => view.sees('notes', n?.id, [n]);
      },
    };
    try {
      checkArgs(tool.inputSchema, args);
      if (!tool.write) {
        store.refresh();
        const s = settingsNow();
        const out = tool.run(args, { ...ctxBase, state: store, settings: s, hour12: s.timeFormat !== '24h' });
        const { entry } = record(fresh, name, out.summary || tool.title, [], { clientName });
        broadcast(fresh, null, null, entry);
        return textResult(out.text, false, out.data);
      }
      if (tool.undo) {
        const out = tool.run(args, { ...ctxBase, state: store, settings: settingsNow(), hour12: true });
        return textResult(out.text, false, out.data);
      }
      // The change and its record under one hold of the data lock (see store.applyOps above).
      const { out, ops, rev, logged } = lock(() => {
        const t = store.transaction((tx) => {
          const s = effectiveSettings(tx.settings());
          return tool.run(args, { ...ctxBase, state: tx, tx, settings: s, hour12: s.timeFormat !== '24h' });
        });
        return { out: t.result, ops: t.ops, rev: t.rev, logged: record(fresh, name, t.result.summary || tool.title, t.changes, { clientName }) };
      });
      broadcast(fresh, ops, rev, logged.entry);
      let text = out.text;
      const data = isPlainObject(out.data) ? { ...out.data } : {};
      if (logged.changeId) {
        text += `\nchange_id=${logged.changeId} (${undoNote(logged, 'undo_change reverts this')})`;
        data.change_id = logged.changeId;
        if (!logged.undoable) data.undoable = false;
      }
      return textResult(text, false, data);
    } catch (err) {
      if (err instanceof ToolError || err?.toolError) return errorResult(err.message);
      if (err instanceof LockError) return errorResult(`${err.message} Nothing was changed.`);
      // The full error goes to the local log only: its message can hold local paths (the user's
      // name, the data folder), and for a cloud assistant this text leaves the computer.
      log.error(`ecosys: tool ${name} failed: ${describeError(err)}`);
      const code = typeof err?.code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(err.code) ? err.code : null;
      const why = code && Object.hasOwn(FS_TROUBLE, code) ? ` Likely cause: ${FS_TROUBLE[code]}.` : '';
      return errorResult(`ecosys hit an internal error while running ${name}${code ? ` (${code})` : ''}. Nothing was changed.${why} Tell the user; details are in the ecosys log on their computer.`);
    }
  };

  /** Save what is still buffered (read activity). Call before exiting or removing the data folder. */
  core.close = () => ai.flush();

  core.mcp = createMcpHandler(core);
  return core;
}
