// ecosys notes: the browser domain layer — notes and folders on top of the shared store (db).
// Every write goes through db (validated by schema.js, synced, undoable by the caller). Pure helpers
// live in schema.js / markdown.js / search.js so the MCP server can share them; this file is browser only.
//
// rev: +1 on every saved change (MCP ifRev). editedAt/editedBy: content edits only (pins, moves, tag
// renames and task mirroring leave them alone). aiPrev: the pre-AI copy, kept until reviewed.
import {
  validateBlocks, newBlock, newNote, newBlockId, blockText, blocksEqual, isEmptyBlocks, isEmptyNote, dailyNoteBlocks,
  meetingNoteBlocks, renameTagInBlocks, removeTagFromBlocks, appendTag, normalizeTag, tagMatches, folderDepth, descendantIds,
  folderParents, folderHiddenFromAi, uniqueFolderName, cleanFolderName, folderPath, noteHiddenFromAi, parseRef, findTags, tagSegments, isAtomRun, mkRun,
  noteOverLimit, NOTE_LIMITS, TRASH_DAYS, EDITORS, LIST_TYPES,
} from './schema.js';
import { searchNotes } from './search.js';
import { db, settings, replaceAll } from '../../shared/store.js';
import { createTask, toggleTask } from '../../shared/model.js';
import { parse as nlpParse } from '../../shared/nlp.js';
import { todayYmd } from '../../shared/dates.js';
import { COLORS, isId, isYmd } from '../../shared/sanitize.js';

const DAY = 86400000;
const LIST = new Set(LIST_TYPES);
const now = () => Date.now();
const clone = (x) => (x == null ? x : structuredClone(x));
const all = () => db.all('notes');
const live = () => all().filter((n) => !n.trashedAt);
const allFolders = () => db.all('folders');
const bump = (n) => (Number.isInteger(n?.rev) ? n.rev : 0) + 1;
/** A blocks patch; a stage-1 HTML body is cleared once the blocks are written. */
const withBlocks = (n, patch) => (typeof n?.body === 'string' && n.body ? { ...patch, body: '' } : patch);

/** Blocks as stored: validated, blocks over 20,000 characters split (never cut), no count cap yet. */
const fullBlocks = (blocks) => validateBlocks(blocks, { max: Infinity, split: true });

/**
 * Thrown instead of saving when blocks don't fit in one note (5,000 blocks, 256 KB): the store would
 * otherwise cut the end off without a word. err.code === 'note_too_large'; err.size (characters of
 * blocks JSON), err.count (blocks). Callers keep the user's text where it is and say why.
 */
export class NoteTooLargeError extends Error {
  constructor(over) {
    super(over.reason === 'blocks' ? `This note is too long to save: notes can hold up to ${NOTE_LIMITS.blocks.toLocaleString()} paragraphs and list items. Move some of it into a new note.` : 'This note is too long to save: notes can hold up to 256 KB. Move some of it into a new note.');
    this.name = 'NoteTooLargeError';
    this.code = 'note_too_large';
    this.size = over.size;
    this.count = over.count;
  }
}
function assertFits(blocks) {
  const over = noteOverLimit(blocks);
  if (over) throw new NoteTooLargeError(over);
}
/** Would these blocks be stored whole? (for callers that skip instead of throwing) */
export const fitsInNote = (blocks) => !noteOverLimit(blocks);

// ---------------------------------------------------------------- startup

/**
 * If shared/store.js loaded the notes before schema.js registered the note fields (another module
 * imported the store first), its cache holds notes without blocks. Reload them from storage with the
 * full validators instead of ever writing the stripped copies back.
 */
function recoverStrippedNotes() {
  const stripped = all().some((n) => !Array.isArray(n.blocks)) || allFolders().some((f) => !('aiHidden' in f));
  if (!stripped) return;
  let notes = null;
  let folders = null;
  try {
    notes = JSON.parse(localStorage.getItem('ecosys:v1:notes') || 'null');
    folders = JSON.parse(localStorage.getItem('ecosys:v1:folders') || 'null');
  } catch {
    return;
  }
  const data = {};
  if (Array.isArray(notes)) data.notes = notes;
  if (Array.isArray(folders)) data.folders = folders;
  if (Object.keys(data).length) replaceAll({ data }, { reason: 'notes-schema' });
}
try {
  recoverStrippedNotes();
} catch (err) {
  console.warn('ecosys notes: could not reload notes', err);
}

let tagCache = null;
db.on(({ names }) => {
  if (names.has('notes')) tagCache = null;
});

// ---------------------------------------------------------------- reading

export const getNote = (id) => (typeof id === 'string' ? db.get('notes', id) : null);
export const getFolder = (id) => (typeof id === 'string' ? db.get('folders', id) : null);
export const noteFolderPath = (note) => folderPath(note?.folderId, allFolders());
export const isHiddenFromAi = (note) => noteHiddenFromAi(note, allFolders());

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const titleOf = (n) => n.title || 'New Note';
const SORTS = {
  edited: (a, b) => (a.editedAt || 0) - (b.editedAt || 0),
  created: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  title: (a, b) => collator.compare(titleOf(a), titleOf(b)),
};

/** Sort notes: sort 'edited' | 'created' | 'title' (or 'edited:asc'); dir 'desc' | 'asc' (dates default to newest first). */
export function sortNotes(list, sort = 'edited', dir) {
  const [key, d0] = String(sort || 'edited').split(':');
  const k = SORTS[key] ? key : 'edited';
  const d = dir === 'asc' || dir === 'desc' ? dir : d0 === 'asc' || d0 === 'desc' ? d0 : k === 'title' ? 'asc' : 'desc';
  const sign = d === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => sign * SORTS[k](a, b) || (b.editedAt || 0) - (a.editedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * Date groups (Apple Notes): Today, Yesterday, Previous 7 Days, Previous 30 Days, then months of this
 * year, then years. → [{key, label, notes}] in the order of `notes` (already sorted).
 */
export function dateGroups(notes, { field = 'editedAt', now: at = now(), locale } = {}) {
  const today = startOfDay(at);
  const year = new Date(at).getFullYear();
  const groups = new Map();
  let monthFmt;
  for (const n of notes) {
    const t = Number.isFinite(n[field]) ? n[field] : 0;
    let key;
    let label;
    if (t >= today) [key, label] = ['today', 'Today'];
    else if (t >= startOfDay(today - DAY / 2)) [key, label] = ['yesterday', 'Yesterday'];
    else if (t >= today - 7 * DAY) [key, label] = ['7d', 'Previous 7 Days'];
    else if (t >= today - 30 * DAY) [key, label] = ['30d', 'Previous 30 Days'];
    else {
      const d = new Date(t);
      if (d.getFullYear() === year) {
        key = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthFmt ??= new Intl.DateTimeFormat(locale, { month: 'long' });
        label = monthFmt.format(d);
      } else [key, label] = [String(d.getFullYear()), String(d.getFullYear())];
    }
    if (!groups.has(key)) groups.set(key, { key, label, notes: [] });
    groups.get(key).notes.push(n);
  }
  return [...groups.values()];
}

/**
 * Notes for a view. view: 'all' | 'today' (daily notes, newest day first) | 'ai' (unreviewed AI
 * edits) | 'trash' (newest deletion first) | 'folder' (folderId; null or 'notes' = the default Notes
 * folder; subfolders included unless deep:false) | 'tag' (tags + mode 'all'|'any'; nested tags
 * included) | 'search' (q, relevance order; sort:'date' for newest first).
 * Pinned notes come first in all / folder / tag views. With groupByDate (date sorts only) the
 * returned array also carries `sections`: [{key:'pinned'|…, label, notes}].
 */
export function listNotes({ view = 'all', folderId = null, tags = [], mode = 'all', q = '', sort, dir, groupByDate = false, deep = true, now: at } = {}) {
  let list;
  let pinnedFirst = false;
  switch (view) {
    case 'trash':
      return [...all().filter((n) => n.trashedAt)].sort((a, b) => b.trashedAt - a.trashedAt);
    case 'today':
      return [...live().filter((n) => n.day)].sort((a, b) => b.day.localeCompare(a.day) || (b.editedAt || 0) - (a.editedAt || 0));
    case 'ai':
      return [...live().filter((n) => n.aiPrev)].sort((a, b) => (b.aiPrev.at || b.editedAt || 0) - (a.aiPrev.at || a.editedAt || 0));
    case 'search': {
      const res = searchNotes(all(), q, { folders: allFolders(), limit: 1000, sort: sort === 'date' ? 'date' : 'relevance', now: at });
      return res.map((r) => r.note);
    }
    case 'folder': {
      if (folderId == null || folderId === 'notes') list = live().filter((n) => !n.folderId && !n.day);
      else {
        const ids = deep ? descendantIds(folderId, allFolders()) : new Set([folderId]);
        list = live().filter((n) => n.folderId && ids.has(n.folderId));
      }
      pinnedFirst = true;
      break;
    }
    case 'tag': {
      const want = (Array.isArray(tags) ? tags : [tags]).map((t) => normalizeTag(t)).filter(Boolean);
      const has = (n, t) => (n.tags || []).some((x) => tagMatches(x, t));
      list = live().filter((n) => (want.length ? (mode === 'any' ? want.some((t) => has(n, t)) : want.every((t) => has(n, t))) : true));
      pinnedFirst = true;
      break;
    }
    default:
      list = live();
      pinnedFirst = true;
  }
  const sorted = sortNotes(list, sort, dir);
  const pinned = pinnedFirst ? sorted.filter((n) => n.pinned) : [];
  const rest = pinnedFirst ? sorted.filter((n) => !n.pinned) : sorted;
  const out = [...pinned, ...rest];
  const key = String(sort || 'edited').split(':')[0];
  if (groupByDate && key !== 'title') {
    const sections = [];
    if (pinned.length) sections.push({ key: 'pinned', label: 'Pinned', notes: pinned });
    sections.push(...dateGroups(rest, { field: key === 'created' ? 'createdAt' : 'editedAt', now: at ?? now() }));
    Object.defineProperty(out, 'sections', { value: sections, enumerable: false });
  }
  return out;
}

/** Search across notes (not trashed; trash:true searches Recently Deleted). → searchNotes results. */
export const searchAll = (q, opts = {}) => searchNotes(all(), q, { folders: allFolders(), ...opts });

/** Sidebar counts: {all, notes (default folder), today (daily notes), ai (unreviewed), trash, byFolder: Map(id → own count)}. */
export function noteCounts() {
  const out = { all: 0, notes: 0, today: 0, ai: 0, trash: 0, byFolder: new Map() };
  for (const n of all()) {
    if (n.trashedAt) {
      out.trash++;
      continue;
    }
    out.all++;
    if (n.day) out.today++;
    if (n.aiPrev) out.ai++;
    if (n.folderId) out.byFolder.set(n.folderId, (out.byFolder.get(n.folderId) || 0) + 1);
    else if (!n.day) out.notes++;
  }
  return out;
}

/**
 * Folders depth-first: [{folder, depth (0 = top level), count (incl. subfolders), own, path, children,
 * aiHidden (inherited)}]. Every folder is listed once. A folder whose parent is gone is top level, and
 * a parent cycle (two browsers that moved folders into each other) is cut where schema.js
 * folderParents cuts it, so both folders still show and can be renamed, moved or deleted. aiHidden
 * is the rule the AI tools apply (folderHiddenFromAi): in a cycle, a hidden folder hides all of it.
 */
export function folderTree() {
  const fs = allFolders();
  const byId = new Map(fs.map((f) => [f.id, f]));
  const parents = folderParents(byId);
  const own = noteCounts().byFolder;
  const kids = new Map();
  for (const f of fs) {
    const p = parents.get(f.id) ?? null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f);
  }
  const bySort = (a, b) => (a.order ?? 0) - (b.order ?? 0) || collator.compare(a.name, b.name);
  const out = [];
  const seen = new Set();
  const walk = (parent, depth, path, hidden) => {
    let total = 0;
    for (const f of (kids.get(parent) || []).sort(bySort)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const aiHidden = hidden || !!f.aiHidden || folderHiddenFromAi(f.id, byId);
      const entry = { folder: f, depth, count: 0, own: own.get(f.id) || 0, path: path ? `${path}/${f.name}` : f.name, children: (kids.get(f.id) || []).length, aiHidden };
      out.push(entry);
      entry.count = entry.own + walk(f.id, depth + 1, entry.path, entry.aiHidden);
      total += entry.count;
    }
    return total;
  };
  walk(null, 0, '', false);
  return out;
}

/** Tags in use (not trashed) by count: [{tag, count, label}] — label is the casing first seen. */
export function allTagCounts() {
  if (tagCache) return tagCache;
  const counts = new Map();
  for (const n of live()) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const labels = new Map();
  if (counts.size) {
    for (const n of [...live()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
      if (!(n.tags || []).some((t) => !labels.has(t))) continue;
      for (const b of n.blocks || []) for (const seg of tagSegments(b)) for (const tk of findTags(seg.text)) if (!labels.has(tk.tag)) labels.set(tk.tag, tk.raw);
      if (labels.size >= counts.size) break;
    }
  }
  tagCache = [...counts].map(([tag, count]) => ({ tag, count, label: labels.get(tag) || tag })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return tagCache;
}

/** Notes linking to this one (newest edit first). */
export function backlinks(id) {
  const ref = `note:${id}`;
  return live()
    .filter((n) => n.id !== id && (n.links || []).some((l) => l === ref || l.startsWith(`${ref}#`)))
    .sort((a, b) => (b.editedAt || 0) - (a.editedAt || 0));
}

/** Backlinks with the linking block: [{note, blockId, text}] (text = that block's first line). */
export function backlinkEntries(id) {
  const ref = `note:${id}`;
  return backlinks(id).map((note) => {
    const b = (note.blocks || []).find((x) => (x.c || []).some((r) => r?.[2]?.ref === ref || String(r?.[2]?.ref || '').startsWith(`${ref}#`)));
    const text = b ? blockText(b).split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    return { note, blockId: b?.id || null, text };
  });
}

// ---------------------------------------------------------------- creating & saving

function newStyle(style) {
  if (['h1', 'h2', 'h3', 'p'].includes(style)) return style;
  const s = settings.get()?.notesNewStyle;
  return ['h1', 'h2', 'p'].includes(s) ? s : 'h1';
}

/**
 * Create a note. fields: {folderId, day, event:{id,date}, blocks, pinned, aiHidden, tag (appended as
 * a final "#tag" line), style ('h1'|'h2'|'p' for the first block; default from settings.notesNewStyle)}.
 */
export function createNote(fields = {}) {
  let blocks = Array.isArray(fields.blocks) ? fullBlocks(fields.blocks) : [newBlock(newStyle(fields.style))];
  if (fields.tag) blocks = appendTag(blocks, fields.tag).blocks;
  assertFits(blocks); // NoteTooLargeError rather than a note missing its end
  const folderId = isId(fields.folderId) && getFolder(fields.folderId) ? fields.folderId : null;
  return db.insert('notes', newNote({ folderId, day: fields.day, event: fields.event, blocks, pinned: fields.pinned === true, aiHidden: fields.aiHidden === true }));
}

/** Chip labels follow their target's current title (renames never break or stale a chip). */
export function refreshChipLabels(blocks) {
  let changed = false;
  const out = (blocks || []).map((b) => {
    if (!Array.isArray(b?.c) || !b.c.some(isAtomRun)) return b;
    let touched = false;
    const c = b.c.map((r) => {
      if (!isAtomRun(r)) return r;
      const ref = parseRef(r[2].ref);
      let label = null;
      if (ref?.kind === 'note') label = getNote(ref.id)?.title || null;
      else if (ref?.kind === 'task') label = db.get('tasks', ref.id)?.title || null;
      else if (ref?.kind === 'event') label = db.get('events', ref.id)?.title || null;
      label = label && label.replace(/\s+/g, ' ').trim();
      if (!label || label === r[0]) return r;
      touched = true;
      return mkRun(label, r[1], r[2]);
    });
    if (!touched) return b;
    changed = true;
    return { ...b, c };
  });
  return changed ? out : blocks;
}

/**
 * Push edits of task-linked checklist items to their tasks: a changed title renames the task, a
 * changed check state completes/reopens it (toggleTask; a repeating task advances and its item
 * unchecks itself). A missing task clears the link and keeps the text. Returns the final blocks.
 */
function pushToTasks(prevBlocks, blocks) {
  const prev = new Map((prevBlocks || []).map((b) => [b.id, b]));
  return blocks.map((b) => {
    if (b.t !== 'check' || !b.task) return b;
    const t = db.get('tasks', b.task);
    if (!t) {
      const { task: _drop, ...rest } = b;
      return rest;
    }
    const p = prev.get(b.id);
    const text = blockText(b).replace(/\s+/g, ' ').trim();
    if (p && text && blockText(p).replace(/\s+/g, ' ').trim() !== text && t.title !== text) db.update('tasks', t.id, { title: text });
    if (p && p.ck !== b.ck && !!t.done !== b.ck) {
      toggleTask(t.id);
      const after = db.get('tasks', t.id);
      if (after && !!after.done !== b.ck) return { ...b, ck: !!after.done };
    }
    return b;
  });
}

/**
 * Save a note's blocks (validated; a block over 20,000 characters is split, never cut). No-op when
 * nothing changed. Bumps rev, sets editedAt and editedBy (`by`: 'user' or 'mcp:<kind>'); an AI save
 * stores the pre-edit copy in aiPrev unless one is waiting for review already. Chip labels are refreshed
 * and linked tasks follow their checklist items. Throws NoteTooLargeError (code 'note_too_large')
 * before writing anything when the blocks don't fit in a note: the caller keeps the text and says so.
 */
export function saveBlocks(id, blocks, { by = 'user' } = {}) {
  const n = getNote(id);
  if (!n || n.locked) return n;
  const next = refreshChipLabels(fullBlocks(blocks));
  if (blocksEqual(next, n.blocks)) return n;
  assertFits(next);
  const editor = EDITORS.includes(by) ? by : 'user';
  const t = now();
  db.batch(() => {
    const final = fullBlocks(pushToTasks(n.blocks, next));
    const patch = withBlocks(n, { blocks: final, rev: bump(n), editedAt: t, editedBy: editor });
    if (editor !== 'user' && !n.aiPrev) patch.aiPrev = { at: t, by: editor, rev: n.rev || 0, blocks: n.blocks };
    db.update('notes', id, patch);
  });
  return getNote(id);
}

/**
 * Check or uncheck one checklist item (and its linked task). → {note, task, next} where `next` is the
 * repeating task's next date when completing it advanced the task (the item then stays unchecked).
 */
export function setChecked(noteId, blockId, checked) {
  const n = getNote(noteId);
  const b = n?.blocks.find((x) => x.id === blockId);
  if (!n || !b || b.t !== 'check') return { note: n, task: null, next: null };
  const before = b.task ? db.get('tasks', b.task) : null;
  const note = saveBlocks(noteId, n.blocks.map((x) => (x.id === blockId ? { ...x, ck: !!checked } : x)));
  const task = b.task ? db.get('tasks', b.task) : null;
  const next = task && before && before.repeat && checked && !task.done && task.date !== before.date ? task.date : null;
  return { note, task, next };
}

/** Is the note empty (no text)? Empty notes are discarded instead of trashed. */
export { isEmptyNote };

/** Discard a note if it is still empty (call when leaving a new note). → true when it was removed. */
export function discardIfEmpty(id) {
  const n = getNote(id);
  if (!n || !isEmptyNote(n)) return false;
  db.remove('notes', id);
  return true;
}

// ---------------------------------------------------------------- note actions

export function setPinned(id, pinned) {
  const n = getNote(id);
  if (!n || !!n.pinned === !!pinned) return n;
  return db.update('notes', id, { pinned: !!pinned, rev: bump(n) });
}

export function setNoteAiHidden(id, hidden) {
  const n = getNote(id);
  if (!n || !!n.aiHidden === !!hidden) return n;
  return db.update('notes', id, { aiHidden: !!hidden, rev: bump(n) });
}

/** Move a note to a folder (null = Notes). A missing folder counts as Notes. */
export function moveNote(id, folderId) {
  const n = getNote(id);
  if (!n || n.trashedAt) return n;
  const target = isId(folderId) && getFolder(folderId) ? folderId : null;
  if ((n.folderId || null) === target) return n;
  return db.update('notes', id, { folderId: target, rev: bump(n) });
}

/** Move several notes; → undo function. */
export function moveNotes(ids, folderId) {
  const before = (ids || []).map(getNote).filter((n) => n && !n.trashedAt).map((n) => ({ id: n.id, folderId: n.folderId || null }));
  db.batch(() => {
    for (const b of before) moveNote(b.id, folderId);
  });
  return () => db.batch(() => before.forEach((b) => moveNote(b.id, b.folderId)));
}

/** A copy of the note (new block ids, no task links, not a daily or meeting note). */
export function duplicateNote(id) {
  const n = getNote(id);
  if (!n) return null;
  const blocks = n.blocks.map((b) => {
    const c = { ...b, id: newBlockId() };
    delete c.task;
    return c;
  });
  return db.insert('notes', newNote({ folderId: n.folderId && getFolder(n.folderId) ? n.folderId : null, blocks, aiHidden: n.aiHidden }));
}

/** Move a note to Recently Deleted (an empty note is just discarded). → undo function. */
export function trashNote(id) {
  const n = getNote(id);
  if (!n || n.trashedAt) return () => {};
  if (isEmptyNote(n)) {
    const copy = clone(n);
    db.remove('notes', id);
    return () => {
      if (!getNote(id)) db.put('notes', copy);
    };
  }
  const t = now();
  db.update('notes', id, { trashedAt: t, trashedFrom: n.folderId || null, rev: bump(n) });
  return () => {
    const cur = getNote(id);
    if (cur && cur.trashedAt === t) db.update('notes', id, { trashedAt: null, trashedFrom: null, folderId: n.folderId || null, rev: bump(cur) });
  };
}

/** Trash several notes; → one undo function for all of them. */
export function trashNotes(ids) {
  const undos = [];
  db.batch(() => {
    for (const id of ids || []) undos.push(trashNote(id));
  });
  return () => db.batch(() => undos.forEach((u) => u()));
}

/** Recover a note from Recently Deleted: back to its folder if that still exists, else to Notes. */
export function restoreNote(id) {
  const n = getNote(id);
  if (!n || !n.trashedAt) return n;
  const target = [n.trashedFrom, n.folderId].find((f) => f && getFolder(f)) || null;
  const patch = { trashedAt: null, trashedFrom: null, folderId: target, rev: bump(n) };
  // Daily notes are unique per date: if another one took this date meanwhile, this becomes a plain note.
  if (n.day && live().some((x) => x.day === n.day && x.id !== n.id)) patch.day = null;
  return db.update('notes', id, patch);
}

function announcePurge(ids) {
  if (!ids.length || typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('ecosys:notes-purged', { detail: { ids } }));
  } catch {}
}

/** Delete a note permanently (Recently Deleted → Delete Now). Fires `ecosys:notes-purged` {ids} so history can go too. */
export function deleteForever(id) {
  const n = getNote(id);
  if (!n) return null;
  db.remove('notes', id);
  announcePurge([id]);
  return n;
}

/** Delete notes that have been in Recently Deleted for `days` days (default 30). → removed ids. */
export function purgeTrash(days = TRASH_DAYS, { now: at = now() } = {}) {
  const cutoff = at - days * DAY;
  const ids = all().filter((n) => n.trashedAt && n.trashedAt <= cutoff).map((n) => n.id);
  if (!ids.length) return [];
  db.batch(() => ids.forEach((id) => db.remove('notes', id)));
  announcePurge(ids);
  return ids;
}

/** Recently Deleted → Delete All. → removed ids. */
export function emptyTrash() {
  return purgeTrash(0, { now: Infinity });
}

// ---------------------------------------------------------------- daily & meeting notes

/** The daily note for a date (unique per date; the oldest wins if two devices made one). */
export function dailyNote(ymd = todayYmd(), { create = false, locale } = {}) {
  if (!isYmd(ymd)) return null;
  const hit = live()
    .filter((n) => n.day === ymd)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  if (hit || !create) return hit || null;
  return db.insert('notes', newNote({ day: ymd, blocks: dailyNoteBlocks(ymd, { locale }) }));
}

/** Meeting notes for one occurrence of an event (template: title, Notes, Action items). */
export function meetingNote(eventId, ymd, { create = false, title } = {}) {
  if (!isId(eventId) || !isYmd(ymd)) return null;
  const hit = live()
    .filter((n) => n.event && n.event.id === eventId && n.event.date === ymd)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  if (hit || !create) return hit || null;
  const name = String(title || db.get('events', eventId)?.title || 'Meeting notes');
  const folder = settings.get()?.notesMeetingFolder;
  const folderId = isId(folder) && getFolder(folder) ? folder : null;
  return db.insert('notes', newNote({ event: { id: eventId, date: ymd }, folderId, blocks: meetingNoteBlocks(name) }));
}

// ---------------------------------------------------------------- folders

/** The parent a folder is shown under (null: top level), as folderTree shows it (schema.js folderParents). */
const parentOf = (f) => (f ? folderParents(allFolders()).get(f.id) ?? null : null);
/** Folders shown directly under `parentId` (null: the top level), except `exceptId`. */
const siblingsOf = (parentId, exceptId = null) => {
  const parents = folderParents(allFolders());
  return allFolders().filter((f) => (parents.get(f.id) ?? null) === (parentId || null) && f.id !== exceptId);
};
const RESERVED_TOP = 'notes';

/** Deepest nesting below a folder (1 = no subfolders), as folderTree shows the folders. */
function subtreeDepth(id) {
  const kids = new Map();
  for (const [f, p] of folderParents(allFolders())) if (p) (kids.get(p) || kids.set(p, []).get(p)).push(f);
  let depth = 0;
  let level = [id];
  const seen = new Set();
  while (level.length) {
    depth++;
    for (const x of level) seen.add(x);
    level = level.flatMap((x) => kids.get(x) || []).filter((x) => !seen.has(x));
  }
  return depth;
}

/** New folder (name made unique among its siblings; "Notes" is reserved at the top level). Nesting ≤ 3 levels. */
export function createFolder({ name, parentId = null, color } = {}) {
  const parent = parentId ? getFolder(parentId) : null;
  if (parentId && !parent) throw new Error('That folder no longer exists.');
  if (parent && folderDepth(parent.id, allFolders()) >= NOTE_LIMITS.folderDepth) throw new Error('Folders can be nested 3 levels deep.');
  const siblings = siblingsOf(parent?.id || null);
  const taken = parent ? siblings : [...siblings, { name: 'Notes' }];
  const nm = uniqueFolderName(cleanFolderName(name) || 'New Folder', taken);
  const used = new Set(allFolders().map((f) => f.color));
  const c = COLORS.includes(color) ? color : COLORS.find((x) => !used.has(x)) || COLORS[allFolders().length % COLORS.length];
  const order = siblings.reduce((m, f) => Math.max(m, Number.isFinite(f.order) ? f.order : 0), -1) + 1;
  return db.insert('folders', { name: nm, parentId: parent?.id || null, color: c, order, sort: null, sortDir: null, groupByDate: null, view: null, aiHidden: false });
}

/**
 * Rename a folder. Throws a friendly Error for an empty or duplicate name. Keeping the name it has is
 * never an error, even beside a folder of the same name (an AI assistant asking for a folder named
 * like one hidden from it gets a visible one of that name, so the hidden one stays a secret).
 */
export function renameFolder(id, name) {
  const f = getFolder(id);
  if (!f) return null;
  const nm = cleanFolderName(name);
  if (!nm) throw new Error('A folder needs a name.');
  if (nm === f.name) return f;
  const parent = parentOf(f);
  if (!parent && nm.toLowerCase() === RESERVED_TOP) throw new Error('"Notes" is the name of the default folder.');
  if (siblingsOf(parent, f.id).some((x) => x.name.toLowerCase() === nm.toLowerCase())) throw new Error(`There's already a folder named "${nm}" here.`);
  return db.update('folders', id, { name: nm });
}

/** Change folder settings: {color, sort, sortDir, groupByDate, view, aiHidden}. */
export function updateFolder(id, patch = {}) {
  const f = getFolder(id);
  if (!f) return null;
  const allowed = {};
  for (const k of ['color', 'sort', 'sortDir', 'groupByDate', 'view', 'aiHidden', 'order']) if (k in patch) allowed[k] = patch[k];
  return db.update('folders', id, allowed);
}

export const setFolderAiHidden = (id, hidden) => updateFolder(id, { aiHidden: !!hidden });

/** Move (nest or reorder) a folder. Refuses cycles and nesting deeper than 3 levels. */
export function moveFolder(id, parentId = null, order) {
  const f = getFolder(id);
  if (!f) return null;
  const parent = parentId ? getFolder(parentId) : null;
  if (parentId && !parent) throw new Error('That folder no longer exists.');
  if (parent && descendantIds(id, allFolders()).has(parent.id)) throw new Error("A folder can't go inside itself.");
  if ((parent ? folderDepth(parent.id, allFolders()) : 0) + subtreeDepth(id) > NOTE_LIMITS.folderDepth) throw new Error('Folders can be nested 3 levels deep.');
  const siblings = siblingsOf(parent?.id || null, id);
  // A folder that stays where it is (a reorder) keeps its name; one moved elsewhere gets a unique one.
  // Where it is: where the tree shows it, so a folder cut out of a parent cycle can be put in order.
  const stays = parentOf(f) === (parent?.id || null);
  const name = stays ? f.name : uniqueFolderName(f.name, parent ? siblings : [...siblings, { name: 'Notes' }]);
  const ord = Number.isFinite(order) ? order : siblings.reduce((m, x) => Math.max(m, Number.isFinite(x.order) ? x.order : 0), -1) + 1;
  return db.update('folders', id, { parentId: parent?.id || null, order: ord, name });
}

/**
 * Delete a folder and its subfolders. Their notes go to Recently Deleted (notesTo:'trash', default)
 * or to the parent folder (notesTo:'parent'). → undo function (with .count = notes affected).
 */
export function deleteFolder(id, { notesTo = 'trash' } = {}) {
  const f = getFolder(id);
  if (!f) return Object.assign(() => {}, { count: 0 });
  const ids = descendantIds(id, allFolders());
  const foldersBefore = allFolders().filter((x) => ids.has(x.id)).map(clone);
  const affected = live().filter((n) => n.folderId && ids.has(n.folderId));
  const notesBefore = affected.map(clone);
  const up = parentOf(f);
  const t = now();
  db.batch(() => {
    for (const n of affected) {
      if (notesTo === 'parent') db.update('notes', n.id, { folderId: up && !ids.has(up) ? up : null, rev: bump(n) });
      else db.update('notes', n.id, { trashedAt: t, trashedFrom: n.folderId, rev: bump(n) });
    }
    for (const x of foldersBefore) db.remove('folders', x.id);
  });
  const undo = () =>
    db.batch(() => {
      for (const x of foldersBefore) if (!getFolder(x.id)) db.put('folders', x);
      for (const n of notesBefore) {
        const cur = getNote(n.id);
        if (cur) db.put('notes', { ...n, rev: bump(cur) });
      }
    });
  undo.count = affected.length;
  return undo;
}

// ---------------------------------------------------------------- tags

function rewriteAllTags(fn) {
  const before = [];
  let tooLarge = 0;
  db.batch(() => {
    for (const n of all()) {
      if (n.locked || !(n.tags || []).length) continue;
      const r = fn(n);
      if (!r.changed) continue;
      if (!fitsInNote(r.blocks)) {
        tooLarge++; // a longer tag name would push this note over the limit: it keeps the old one
        continue;
      }
      before.push({ id: n.id, blocks: n.blocks });
      db.update('notes', n.id, withBlocks(n, { blocks: r.blocks, rev: bump(n) })); // a system rewrite: editedAt stays
    }
  });
  const undo = () =>
    db.batch(() => {
      for (const b of before) {
        const cur = getNote(b.id);
        if (cur) db.update('notes', b.id, { blocks: b.blocks, rev: bump(cur) });
      }
    });
  undo.count = before.length;
  undo.tooLarge = tooLarge;
  return undo;
}

/** Rename #from → #to in every note (children #from/x follow). → undo function (.count = notes changed). */
export function renameTag(from, to) {
  const f = normalizeTag(from);
  if (!f || !normalizeTag(to)) return Object.assign(() => {}, { count: 0 });
  return rewriteAllTags((n) => (n.tags.some((t) => tagMatches(t, f)) ? renameTagInBlocks(n.blocks, from, to) : { changed: false }));
}

/** Remove the #tag text (and #tag/children) from every note; the notes stay. → undo function (.count). */
export function removeTag(tag) {
  const f = normalizeTag(tag);
  if (!f) return Object.assign(() => {}, { count: 0 });
  return rewriteAllTags((n) => (n.tags.some((t) => tagMatches(t, f)) ? removeTagFromBlocks(n.blocks, f) : { changed: false }));
}

/**
 * Multi-select "Add tag": append "#tag" as the last line of each note. → undo function (.count = notes
 * tagged, .tooLarge = notes left alone because one more line wouldn't fit; say so when it's > 0).
 */
export function addTagToNotes(ids, tag) {
  const before = [];
  let tooLarge = 0;
  db.batch(() => {
    for (const id of ids || []) {
      const n = getNote(id);
      if (!n || n.locked) continue;
      const r = appendTag(n.blocks, tag);
      if (!r.changed) continue;
      if (!fitsInNote(r.blocks)) {
        tooLarge++;
        continue;
      }
      before.push({ id, blocks: n.blocks });
      db.update('notes', id, withBlocks(n, { blocks: r.blocks, rev: bump(n), editedAt: now(), editedBy: 'user' }));
    }
  });
  const undo = () => db.batch(() => before.forEach((b) => getNote(b.id) && db.update('notes', b.id, { blocks: b.blocks, rev: bump(getNote(b.id)) })));
  undo.count = before.length;
  undo.tooLarge = tooLarge;
  return undo;
}

// ---------------------------------------------------------------- tasks

/** #tags in a line → {text without them, tags}. Note tags become task labels, never task lists. */
function splitTags(text) {
  const found = findTags(text);
  let out = text;
  for (const tk of [...found].reverse()) out = out.slice(0, tk.start) + out.slice(tk.end);
  return { text: out.replace(/\s+/g, ' ').trim(), tags: [...new Set(found.map((t) => t.tag))] };
}

/**
 * What Send to Tasks makes of a block (sendBlocksToTasks reads it this way; the Send to Tasks dialog
 * previews it with this): {title, date, time, deadline, repeat, tags, …} as nlp.js parses its text,
 * the note's #tags as labels, or null for a block with no text (or a divider or code block). A date
 * range ("Prep slides dec 3-5") is read whole, as notes_send_to_tasks reads it: planned for the first
 * day and due on the last, rather than the first day with "-5" left in the title.
 */
export function taskFromBlock(b, { now: at = new Date() } = {}) {
  if (!b || b.t === 'hr' || b.t === 'code') return null;
  const line = blockText(b).replace(/\s+/g, ' ').trim();
  if (!line) return null;
  const { text, tags } = splitTags(line);
  const parsed = text ? nlpParse(text, { mode: 'task', now: at, ranges: true }) : { title: '' };
  return { ...parsed, title: (parsed.title || text || line).trim(), tags: [...new Set([...(parsed.tags || []), ...tags])] };
}

/**
 * Send blocks to Tasks: each becomes a task (taskFromBlock: dates etc. parsed from its text by nlp.js)
 * with source:{app:'notes', noteId, blockId}; the block becomes a checklist item linked to it, its text
 * the parsed title. Items already linked to a live task are skipped. → the created tasks.
 */
export function sendBlocksToTasks(noteId, blockIds, { listId = null } = {}) {
  const n = getNote(noteId);
  if (!n || n.trashedAt || n.locked) return [];
  const want = new Set(Array.isArray(blockIds) ? blockIds : [blockIds]);
  const list = isId(listId) && db.get('lists', listId) ? listId : null;
  const created = [];
  db.batch(() => {
    const at = new Date();
    const blocks = n.blocks.map((b) => {
      if (!want.has(b.id)) return b;
      if (b.t === 'check' && b.task && db.get('tasks', b.task)) return b;
      const parsed = taskFromBlock(b, { now: at });
      if (!parsed) return b;
      const { title } = parsed;
      const task = createTask({ ...parsed, listId: list, newList: null });
      db.update('tasks', task.id, { source: { app: 'notes', noteId: n.id, blockId: b.id } });
      created.push(db.get('tasks', task.id));
      return { id: b.id, t: 'check', in: LIST.has(b.t) ? b.in || 0 : 0, ck: false, task: task.id, c: [[title]] };
    });
    if (created.length) db.update('notes', n.id, withBlocks(n, { blocks: validateBlocks(blocks), rev: bump(n), editedAt: now(), editedBy: 'user' }));
  });
  return created;
}

/**
 * Mirror linked tasks into a note's checklist items: done → checked, title → text (skip the block
 * being edited with skipBlockId); a deleted task clears the link and keeps the text. A system change
 * (editedAt stays). → the updated note, or null when nothing changed.
 */
export function syncTaskChecks(note, { skipBlockId = null } = {}) {
  const n = getNote(typeof note === 'string' ? note : note?.id);
  if (!n || n.locked) return null;
  let changed = false;
  const blocks = n.blocks.map((b) => {
    if (b.t !== 'check' || !b.task || b.id === skipBlockId) return b;
    const t = db.get('tasks', b.task);
    if (!t) {
      changed = true;
      const { task: _drop, ...rest } = b;
      return rest;
    }
    let nb = b;
    if (!!t.done !== !!b.ck) nb = { ...nb, ck: !!t.done };
    const title = String(t.title || '').replace(/\s+/g, ' ').trim();
    if (title && title !== blockText(b).replace(/\s+/g, ' ').trim()) nb = { ...nb, c: [[title]] };
    if (nb !== b) changed = true;
    return nb;
  });
  if (!changed) return null;
  const final = fullBlocks(blocks);
  if (!fitsInNote(final)) return null; // a longer task title would push the note over the limit
  return db.update('notes', n.id, withBlocks(n, { blocks: final, rev: bump(n) }));
}

/** syncTaskChecks for every note that links a task. → number of notes updated. */
export function syncAllTaskChecks({ skipBlockId = null } = {}) {
  let count = 0;
  db.batch(() => {
    for (const n of live()) if (n.blocks.some((b) => b.t === 'check' && b.task) && syncTaskChecks(n, { skipBlockId })) count++;
  });
  return count;
}

// ---------------------------------------------------------------- AI review

/**
 * Review an AI edit: 'keep' clears aiPrev; 'undo' restores the pre-AI blocks (a note the AI created
 * goes to Recently Deleted). Linked tasks go back with their items, as when the user edits them
 * (pushToTasks): an item the assistant checked is unchecked again and its task reopened, one it
 * reworded renames its task back; so the Notes app's mirror of linked tasks never undoes the Undo.
 * Snapshot the AI's version into history before calling 'undo'. → the note.
 */
export function reviewAiEdit(id, action) {
  const n = getNote(id);
  if (!n || !n.aiPrev) return n;
  if (action === 'keep') return db.update('notes', id, { aiPrev: null, rev: bump(n) });
  if (action !== 'undo') return n;
  const prev = n.aiPrev;
  if (prev.rev === 0 && isEmptyBlocks(prev.blocks)) {
    return db.update('notes', id, { aiPrev: null, trashedAt: now(), trashedFrom: n.folderId || null, rev: bump(n) });
  }
  db.batch(() => db.update('notes', id, withBlocks(n, { blocks: fullBlocks(pushToTasks(n.blocks, prev.blocks)), aiPrev: null, rev: bump(n), editedAt: now(), editedBy: 'user' })));
  return getNote(id);
}

/**
 * Put a note back as it was when `copy` (a clone of it) was taken: the Undo of an AI-edit Undo or of a
 * Version history Restore. Linked tasks go back with their items, as when the user edits them
 * (pushToTasks: an item checked again completes its task, a reworded one renames it), and rev only
 * goes up (an assistant's ifRev relies on it). → the note.
 */
export function revertNote(copy) {
  if (!copy || !isId(copy.id)) return null;
  const cur = getNote(copy.id);
  const rev = Math.max(Number(cur?.rev) || 0, Number(copy.rev) || 0) + 1;
  db.batch(() => {
    const blocks = Array.isArray(copy.blocks) ? fullBlocks(cur ? pushToTasks(cur.blocks, copy.blocks) : copy.blocks) : copy.blocks;
    db.put('notes', { ...copy, blocks, rev });
  });
  return getNote(copy.id);
}

/** Clear review copies older than `days` (default 7). → the notes as they were (snapshot them first). */
export function expireAiReviews(days = 7, { now: at = now() } = {}) {
  const old = live().filter((n) => n.aiPrev && (n.aiPrev.at || 0) <= at - days * DAY);
  if (!old.length) return [];
  const copies = old.map(clone);
  db.batch(() => old.forEach((n) => db.update('notes', n.id, { aiPrev: null, rev: bump(n) })));
  return copies;
}
