// Domain logic shared by the apps: one source of truth for what a task or event "is".
import { db, settings } from './store.js';
import { COLORS, isPlainObject, isYmd, isHHMM, isDateTime } from './sanitize.js';
import { pad, todayYmd, parseYmd, ymd, addDays, addDaysYmd, diffDays, parseDT, fmtDT, toMinutes, fromMinutes, fmtTime, dayLabel } from './dates.js';
import { occurrencesBetween, firstOnOrAfter, nextRepeatDates, shiftRule } from './recur.js';
// Pure, and already loaded by store.js in every app (it registers the note validators).
import { noteOverLimit } from '../notes/core/schema.js';

// ---------------------------------------------------------------- colors

/** Named colors shared by lists and calendars (values come from CSS: --c-<name>). */
export { COLORS };
export const colorVar = (name) => `var(--c-${COLORS.includes(name) ? name : 'iris'})`;

// ---------------------------------------------------------------- undo

const same = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Never restored by an undo: identity and timestamps, and a note's rev, which only moves on. */
const KEEP = new Set(['id', 'createdAt', 'updatedAt', 'rev']);
/** Fields an undo restores together or not at all, so it never leaves half a pair (an event's times). */
const TOGETHER = { tasks: [['done', 'completedAt']], events: [['allDay', 'start', 'end']] };
/** Fields that hold a set: an undo takes out what the change added and puts back what it removed. */
const SETS = { tasks: ['tags'], events: ['exdates'] };
/**
 * Records that hold others, and whether anything is in one now: a list holds tasks (done ones too), a
 * calendar events, a folder notes and folders. A note in Recently Deleted doesn't count: restored, it
 * goes to Notes when its folder is gone.
 */
const IN_USE = {
  lists: (id) => db.all('tasks').some((t) => t.listId === id),
  calendars: (id) => db.all('events').some((e) => e.calendarId === id),
  folders: (id) => db.all('notes').some((n) => n.folderId === id && !n.trashedAt) || db.all('folders').some((f) => f.parentId === id),
};

/**
 * Undo one change to one record, given the record as it was `before` and right `after` the change
 * (null for a create / a delete). Only the fields the change made are restored, and only where the
 * record still holds the change's value, so edits made since, in this app, another app or another
 * tab, stay. Undoing a create removes the record if it still exists, except a list, calendar or
 * folder with something in it (IN_USE): that stays, so nothing put there since is stranded (take back
 * what the change itself put in it first, as trackChanges does). Undoing a delete puts the record back
 * unless it was re-created; a record deleted since the change stays deleted. id and createdAt are
 * never touched; updatedAt is now (an undo is a new edit, for sync) and a note's rev moves on.
 * Returns the record as the undo leaves it, or null when there is none.
 */
export function revertChange(collection, before, after) {
  const id = before?.id ?? after?.id;
  if (id == null) return null;
  const cur = db.get(collection, id);
  if (!before) {
    if (!cur || IN_USE[collection]?.(id)) return cur;
    db.remove(collection, id);
    return null;
  }
  if (!after) return cur || db.put(collection, structuredClone(before));
  if (!cur) return null;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !KEEP.has(k));
  const groups = (TOGETHER[collection] || []).map((g) => g.filter((k) => keys.includes(k)));
  const units = [...groups, ...keys.filter((k) => !groups.some((g) => g.includes(k))).map((k) => [k])];
  const sets = SETS[collection] || [];
  const patch = {};
  for (const unit of units) {
    const changed = unit.filter((k) => !same(before[k], after[k]));
    if (!changed.length) continue;
    if (unit.every((k) => same(cur[k], after[k]))) {
      for (const k of changed) patch[k] = before[k] ?? null;
    } else if (unit.length === 1 && sets.includes(unit[0]) && [before, after, cur].every((x) => Array.isArray(x[unit[0]]))) {
      // Edited since: keep those edits, and take back only what this change added or removed.
      const k = unit[0];
      const added = after[k].filter((v) => !before[k].some((w) => same(v, w)));
      const removed = before[k].filter((v) => !after[k].some((w) => same(v, w)));
      const next = [...cur[k].filter((v) => !added.some((w) => same(v, w))), ...removed.filter((v) => !cur[k].some((w) => same(v, w)))];
      if (!same(next, cur[k])) patch[k] = next;
    }
  }
  if (!Object.keys(patch).length) return cur;
  if (Number.isInteger(cur.rev)) patch.rev = Math.max(cur.rev, Number(after.rev) || 0) + 1;
  return db.update(collection, id, structuredClone(patch));
}

// ---------------------------------------------------------------- tasks

/*
 task = {
   id, title, notes, listId|null, tags:[], priority:0..3,
   date:'YYYY-MM-DD'|null   – the day you plan to do it ("when")
   time:'HH:MM'|null        – optional start time; with duration it becomes a time block in schedule
   duration:minutes|null,
   deadline:'YYYY-MM-DD'|null,
   repeat: rule|null, checklist:[{id,title,done}],
   done:boolean, completedAt:number|null, order:number, repeatOf?:id,
   source?:{app:'notes', noteId, blockId?}  – the note (and checklist item) it was sent from
   reminder?:'YYYY-MM-DDTHH:MM'             – "Remind me" (see Reminders and alerts below)
   createdAt, updatedAt
 }
 (Old 'someday' / 'evening' flags are stripped by the store's validator and ignored everywhere.)
*/

export const isOpen = (t) => !t.done;
/** Overdue = planned for a day before today, or past its deadline (Todoist & Microsoft To Do both flag these in red). */
export const isOverdue = (t, today = todayYmd()) => !t.done && ((t.date && t.date < today) || (t.deadline && t.deadline < today));
export const isToday = (t, today = todayYmd()) => !t.done && ((t.date && t.date <= today) || (t.deadline && t.deadline <= today));

/** Priority 3 = P1 (red) … 0 = P4 (none) — Todoist's scale. The star (Microsoft To Do) toggles P1. */
export const PRIORITIES = [
  { value: 3, label: 'Priority 1', short: 'P1', color: 'var(--p1)' },
  { value: 2, label: 'Priority 2', short: 'P2', color: 'var(--p2)' },
  { value: 1, label: 'Priority 3', short: 'P3', color: 'var(--p3)' },
  { value: 0, label: 'Priority 4', short: 'P4', color: 'var(--text-3)' },
];
export const priorityColor = (p) => (PRIORITIES.find((x) => x.value === (p || 0)) ?? PRIORITIES[3]).color;

/**
 * The smart lists, each with its own glyph from the custom set (shared/icons.js): Today's calendar
 * with the now-dot, Upcoming's with a line running ahead, Completed's check with a dot head. 'calendar'
 * stays the plain date glyph and 'tomorrow' is Tomorrow in every date menu.
 */
export const SMART_LISTS = [
  { id: 'inbox', name: 'Inbox', icon: 'inbox', color: 'blue' },
  { id: 'today', name: 'Today', icon: 'today', color: 'green' },
  { id: 'upcoming', name: 'Upcoming', icon: 'upcoming', color: 'purple' },
  { id: 'important', name: 'Important', icon: 'star', color: 'red' },
  { id: 'completed', name: 'Completed', icon: 'done', color: 'graphite' },
];
/** Old view ids (from earlier versions / bookmarks) → current ones. */
export const VIEW_ALIASES = { logbook: 'completed', anytime: 'inbox', someday: 'inbox' };

/** Ids of the lists that exist right now. */
export const liveListIds = () => new Set(db.all('lists').map((l) => l.id));
/** The task's list id if that list still exists, else null (a task whose list was deleted is an Inbox task). */
export const liveListId = (t, ids = liveListIds()) => (t.listId && ids.has(t.listId) ? t.listId : null);
/** The key used by settings.hiddenTaskLists: the live list id, or 'inbox'. */
export const taskListKey = (t, ids = liveListIds()) => liveListId(t, ids) || 'inbox';
/** True when the task's list is hidden on the calendar (settings.hiddenTaskLists). */
export function isTaskListHidden(t, s, ids = liveListIds()) {
  const hidden = s?.hiddenTaskLists;
  return !!hidden?.length && hidden.includes(taskListKey(t, ids));
}

export function tasksIn(view, { today = todayYmd(), tag = null } = {}) {
  const all = db.all('tasks');
  switch (VIEW_ALIASES[view] || view) {
    case 'inbox': {
      const ids = liveListIds();
      return all.filter((t) => !t.done && !liveListId(t, ids));
    }
    case 'today':
      return all.filter((t) => isToday(t, today));
    case 'upcoming':
      return all.filter((t) => !t.done && t.date && t.date > today);
    case 'important':
      return all.filter((t) => !t.done && t.priority === 3);
    case 'completed':
      return all.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    case 'tag':
      return all.filter((t) => !t.done && t.tags?.includes(tag));
    default:
      return all.filter((t) => t.listId === view && !t.done);
  }
}

/** Completed tasks that belong to a view (for the collapsible "Completed" section). */
export function completedIn(view, { today = todayYmd(), tag = null } = {}) {
  const done = db.all('tasks').filter((t) => t.done);
  const ids = liveListIds();
  const match = {
    inbox: (t) => !liveListId(t, ids),
    today: (t) => t.completedAt && ymd(new Date(t.completedAt)) === today,
    important: (t) => t.priority === 3,
    tag: (t) => t.tags?.includes(tag),
  }[VIEW_ALIASES[view] || view] || ((t) => t.listId === view);
  return done.filter(match).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}

export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0);
export function byTimeThenOrder(a, b) {
  if (a.time && b.time) return a.time.localeCompare(b.time) || byOrder(a, b);
  if (a.time) return -1;
  if (b.time) return 1;
  return byOrder(a, b);
}

/**
 * Sort options (Microsoft To Do's sort menu). One word per concept, as everywhere in Tasks: `date` is
 * the day you plan to do a task ("Date"), the day it must be done is its "Deadline", never "Due".
 */
export const SORTS = {
  manual: { label: 'My order', fn: byOrder },
  date: {
    label: 'Date',
    fn: (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99') || byOrder(a, b),
  },
  priority: { label: 'Priority', fn: (a, b) => (b.priority || 0) - (a.priority || 0) || byOrder(a, b) },
  alpha: { label: 'Alphabetically', fn: (a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }) },
  created: { label: 'Creation date', fn: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) },
};

/** Todoist-style date tone: overdue (red), today (green), tomorrow (orange), this week (purple), later. */
export function dateTone(s, today = todayYmd()) {
  const n = diffDays(today, s);
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 7) return 'week';
  return 'later';
}

export function nextOrder() {
  const all = db.all('tasks');
  let max = 0;
  for (const t of all) if (Number.isFinite(t.order) && t.order > max) max = t.order;
  return all.length ? max + 1 : 1;
}

export function allTags() {
  const s = new Set();
  for (const t of db.all('tasks')) if (!t.done) for (const g of t.tags || []) s.add(g);
  return [...s].sort();
}

/**
 * The day for a time typed without one: the deadline's day when there is one ("Submit report by fri
 * 5pm"), else the next time that clock time comes round, today while it is still ahead and otherwise
 * tomorrow, as Todoist and Reminders read "Lunch at noon".
 */
export function dayForTime(time, { deadline = null, now = new Date() } = {}) {
  if (isYmd(deadline)) return deadline;
  const today = ymd(now);
  return toMinutes(time) >= now.getHours() * 60 + now.getMinutes() ? today : addDaysYmd(today, 1);
}

/**
 * The day createTask plans a new task for: its own, or for a bare time the day that time is on (a
 * repeat's first on or after it), else none. A composer shows it before Enter, so its Date chip and
 * the saved task agree.
 */
export function plannedDay(fields) {
  if (fields.date) return fields.date;
  if (!isHHMM(fields.time)) return null;
  const day = dayForTime(fields.time, { deadline: fields.deadline });
  return fields.repeat && !isYmd(fields.deadline) ? firstOnOrAfter(fields.repeat, day) : day;
}

/**
 * Create a task from a parsed quick-add result (or a plain object). Creates missing lists on the fly.
 * A time without a date gets the day it is for (dayForTime), so it reaches Today and the calendar.
 * `fields.source` ({app:'notes', noteId, blockId}: the note and checklist item the task was sent from)
 * goes into the same insert, so the task arrives complete in one op. The store's task validator is
 * the gatekeeper: it keeps a well-formed source and drops anything else (or the whole field, where the
 * schema doesn't know it), so a task is never refused because of its source. A `reminder`
 * ('YYYY-MM-DDTHH:MM') goes in the same way.
 */
export function createTask(fields) {
  let listId = fields.listId && db.get('lists', fields.listId) ? fields.listId : null;
  if (!listId && fields.newList) {
    const existing = db.all('lists').find((l) => l.name.toLowerCase() === String(fields.newList).toLowerCase());
    listId = existing ? existing.id : createList({ name: fields.newList }).id;
  }
  return db.insert('tasks', {
    title: fields.title || 'New task',
    notes: fields.notes || '',
    listId,
    tags: fields.tags || [],
    priority: fields.priority || 0,
    date: plannedDay(fields),
    time: fields.time || null,
    duration: fields.duration || null,
    deadline: fields.deadline || null,
    repeat: fields.repeat || null,
    checklist: fields.checklist || [],
    done: false,
    completedAt: null,
    order: fields.order ?? nextOrder(),
    ...(isPlainObject(fields.source) ? { source: { ...fields.source } } : {}),
    ...(isDateTime(fields.reminder) ? { reminder: fields.reminder } : {}),
  });
}

export function createList(fields) {
  const lists = db.all('lists');
  const used = new Set(lists.map((l) => l.color));
  const color = fields.color || COLORS.find((c) => !used.has(c)) || COLORS[lists.length % COLORS.length];
  return db.insert('lists', { name: fields.name, color, icon: fields.icon || '', order: lists.length });
}

// ---------------------------------------------------------------- checklist order (notes)

const isCheckBlock = (b) => b?.t === 'check';
const indentOf = (b) => (Number.isInteger(b?.in) && b.in > 0 ? b.in : 0);

/** [start, end) of the run of checklist items around index i. */
function checkRunAt(blocks, i) {
  let a = i;
  let b = i + 1;
  while (a > 0 && isCheckBlock(blocks[a - 1])) a--;
  while (b < blocks.length && isCheckBlock(blocks[b])) b++;
  return [a, b];
}

/**
 * The units (an item and the items indented deeper right after it) at item i's level, inside its run
 * and under its parent: [[from, to), …] in order.
 */
function siblingUnits(blocks, i) {
  const [a, b] = checkRunAt(blocks, i);
  const lvl = indentOf(blocks[i]);
  let lo = i;
  while (lo > a && indentOf(blocks[lo - 1]) >= lvl) lo--;
  let hi = i + 1;
  while (hi < b && indentOf(blocks[hi]) >= lvl) hi++;
  const units = [];
  for (let k = lo; k < hi; ) {
    if (indentOf(blocks[k]) !== lvl) {
      k++;
      continue;
    }
    let end = k + 1;
    while (end < hi && indentOf(blocks[end]) > lvl) end++;
    units.push([k, end]);
    k = end;
  }
  return units;
}

/** blocks[from, to) moved so it starts at index `dest` of the array without it. */
function moveRange(blocks, from, to, dest) {
  const span = blocks.slice(from, to);
  const rest = [...blocks.slice(0, from), ...blocks.slice(to)];
  return [...rest.slice(0, dest), ...span, ...rest.slice(dest)];
}

/**
 * Notes' "Sort checked items: Automatically" for checklist items whose check state just changed (the
 * Notes spec's rule, and the editor's own: notes/editor/commands.js autoSort): a checked item moves
 * with its subtree (the items after it indented deeper) to the end of its run of items at its level;
 * an unchecked one moves back above its first checked sibling. Items are taken in the order they are
 * in. `keep`: the id of the block holding the caret, which never moves under it (nor does an item it
 * is indented under), as in the editor. Pure: → new blocks, or `blocks` itself when nothing moves.
 */
export function autoSortChecks(blocks, ids, { keep = null } = {}) {
  if (!Array.isArray(blocks) || !ids) return blocks;
  const wanted = new Set(ids);
  const order = blocks.filter((b) => isCheckBlock(b) && wanted.has(b.id)).map((b) => b.id);
  let out = blocks;
  for (const id of order) {
    const i = out.findIndex((b) => b?.id === id);
    if (i < 0 || !isCheckBlock(out[i])) continue;
    const units = siblingUnits(out, i);
    const me = units.findIndex((u) => u[0] === i);
    if (me < 0) continue;
    const [from, to] = units[me];
    if (keep != null && out.slice(from, to).some((b) => b?.id === keep)) continue;
    if (out[i].ck) {
      const lastEnd = units.at(-1)[1];
      if (to !== lastEnd) out = moveRange(out, from, to, lastEnd - (to - from));
    } else {
      const first = units.find((u, k) => k !== me && out[u[0]].ck);
      if (first && first[0] < from) out = moveRange(out, from, to, first[0]);
    }
  }
  return out;
}

/** Whether checked items move to the bottom by themselves (Notes settings, Sort checked items). */
const checkedSortAuto = () => settings.get()?.notesCheckedSort !== 'manual';

/**
 * One object, two views: a notes checklist item linked to a task (a check block with `task: id`) is
 * checked exactly when the task is done. Sets that on every linked item that differs, so Notes, Home
 * and Tasks agree whether or not Notes is open (Notes also mirrors changes that arrive from elsewhere:
 * notes/core/notes.js syncTaskChecks), and with Sort checked items set to Automatically the item moves
 * as it does when it is checked in Notes (autoSortChecks). Called from Tasks, Home, Schedule and the
 * Notes app's own task chips, never from the item being typed in: when Notes checks an item itself, the
 * save that follows writes the editor's copy, which sorts on its own and keeps the caret's item still.
 * Like syncTaskChecks this is a system change: rev + 1, editedAt and editedBy untouched. Notes in
 * Recently Deleted, locked notes and a note the change would push over the size limit are left alone.
 * Writes nothing when nothing differs, so an untouched sample note stays untouched for sync.
 * → [[note before, note after], …] for each note written.
 */
function mirrorTaskChecks(id) {
  const t = db.get('tasks', id);
  if (!t) return [];
  const ck = !!t.done;
  const stale = (b) => b?.t === 'check' && b.task === id && !!b.ck !== ck;
  const notes = db.all('notes').filter((n) => !n.trashedAt && !n.locked && Array.isArray(n.blocks) && n.blocks.some(stale));
  const sort = checkedSortAuto();
  const written = [];
  for (const n of notes) {
    const changed = n.blocks.filter(stale).map((b) => b.id);
    const checked = n.blocks.map((b) => (stale(b) ? { ...b, ck } : b));
    if (noteOverLimit(checked)) continue;
    const blocks = sort ? autoSortChecks(checked, changed) : checked;
    const rev = (Number.isInteger(n.rev) ? n.rev : 0) + 1;
    // A stage-1 HTML body is cleared once blocks are written (as notes.js does).
    const after = db.update('notes', n.id, typeof n.body === 'string' && n.body ? { blocks, rev, body: '' } : { blocks, rev });
    if (after) written.push([structuredClone(n), structuredClone(after)]);
  }
  return written;
}

/**
 * Take back what mirrorTaskChecks wrote, note by note, where the note's items are still exactly as it
 * left them (an item it moved goes back to its place); a note edited since keeps those edits, and the
 * mirror that follows the task's undo brings its items in line. A system change, as the mirror is.
 */
function unmirrorTaskChecks(written) {
  for (const [before, after] of written) {
    const cur = db.get('notes', after.id);
    if (!cur || cur.trashedAt || cur.locked || !same(cur.blocks, after.blocks)) continue;
    db.update('notes', after.id, { blocks: structuredClone(before.blocks), rev: Math.max(Number.isInteger(cur.rev) ? cur.rev : 0, Number(after.rev) || 0) + 1 });
  }
}

/**
 * Toggle completion. Completing a repeating task logs a completed copy and moves the task itself to
 * its next date (see recur.js nextRepeatDates), so its identity (and any time block in schedule) is
 * preserved, and its reminder moves the same number of days, so it comes again at the same time before
 * the next one. A repeating task with no date lands on the next occurrence. Checklist items linked to the
 * task in notes follow in the same batch, checked and (Sort checked items: Automatically) moved as
 * Notes moves them (mirrorTaskChecks; a repeating task's item stays unchecked, as the task is open
 * again). Returns an undo function, which takes back just this change (revertChange: edits made to the
 * task since stay; the logged copy goes if it is still there) and its items with it: a note nobody
 * has touched since gets its items back exactly as they were, in their places; one edited since keeps
 * those edits, and only its items' check state follows the task.
 */
export function toggleTask(id) {
  const t = db.get('tasks', id);
  if (!t) return () => {};
  const before = structuredClone(t);
  let written = [];
  const change = (fn) =>
    db.batch(() => {
      const result = fn();
      written = mirrorTaskChecks(id);
      return result;
    });
  /** The undo: the notes the change wrote first, then the task, then the items of any other note follow. */
  const undoWith = (fn) => {
    const notes = written;
    return () =>
      db.batch(() => {
        unmirrorTaskChecks(notes);
        fn();
        mirrorTaskChecks(id);
      });
  };
  if (t.done) {
    const after = change(() => db.update('tasks', id, { done: false, completedAt: null }));
    return undoWith(() => revertChange('tasks', before, after));
  }
  if (t.repeat) {
    const today = todayYmd();
    const { date, deadline } = nextRepeatDates(t, today);
    // The reminder keeps its distance from the task's day (its date, else its deadline, else today).
    const moved = diffDays(t.date || t.deadline || today, date || deadline || today);
    const [copy, after] = change(() => {
      const { id: _omit, ...rest } = structuredClone(t);
      return [
        db.insert('tasks', { ...rest, repeat: null, done: true, completedAt: Date.now(), repeatOf: t.id }),
        db.update('tasks', id, {
          date,
          deadline,
          checklist: (t.checklist || []).map((c) => ({ ...c, done: false })),
          ...(isDateTime(t.reminder) ? { reminder: shiftDays(t.reminder, moved) } : {}),
        }),
      ];
    });
    return undoWith(() => {
      revertChange('tasks', null, copy);
      revertChange('tasks', before, after);
    });
  }
  const after = change(() => db.update('tasks', id, { done: true, completedAt: Date.now() }));
  return undoWith(() => revertChange('tasks', before, after));
}

/** Delete a task. The undo puts it back, unless it has been re-created (or restored) since. */
export function deleteTask(id) {
  const t = db.remove('tasks', id);
  return () => t && revertChange('tasks', t, null);
}

/** Schedule a task into a time block (used by drag & drop in schedule). The undo takes back only this move. */
export function scheduleTask(id, date, time, duration) {
  const t = db.get('tasks', id);
  if (!t) return () => {};
  const before = structuredClone(t);
  const after = db.update('tasks', id, {
    date,
    time: time ?? null,
    duration: time ? duration || t.duration || null : t.duration,
  });
  return () => revertChange('tasks', before, after);
}

// ---------------------------------------------------------------- events

/*
 event = {
   id, title, calendarId, allDay:boolean,
   start: 'YYYY-MM-DDTHH:MM' (timed) | 'YYYY-MM-DD' (all-day)
   end:   'YYYY-MM-DDTHH:MM' (timed, exclusive) | 'YYYY-MM-DD' (all-day, inclusive)
   location, notes, repeat: rule|null, exdates:['YYYY-MM-DD'], until:'YYYY-MM-DD'|null,
   seriesId?: id of the series an edited occurrence was split from, occurrence?: the date it replaces,
   alerts?: [minutes before the start] (see Reminders and alerts below),
   createdAt, updatedAt
 }
*/

export function calendarMap() {
  return new Map(db.all('calendars').map((c) => [c.id, c]));
}

const isStr = (v) => typeof v === 'string' && v.length >= 10;

/** A floating date ('YYYY-MM-DD') or date-time ('YYYY-MM-DDTHH:MM') moved by whole days, keeping its clock time. */
const shiftDays = (s, n) => `${addDaysYmd(s.slice(0, 10), n)}${s.slice(10)}`;

/**
 * A floating date-time ('YYYY-MM-DDTHH:MM') moved by minutes on the clock, exactly as the server's
 * addMinutesDT (calendar arithmetic, the same in every time zone): "mar 13-15 9am-5pm" ends at 5pm and a
 * slot drawn 1:00-4:00 stays 1:00-4:00 even when the clocks change in between. An end in the hour the
 * clocks skip stays as written (1:00 plus 90 minutes is 2:30), so the event keeps its length by the clock.
 */
function addClockMinutes(dt, mins) {
  const [y, mo, d] = dt.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, 0, toMinutes(dt.slice(11, 16)) + Number(mins)));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** A timed event's length by the clock, from its stored times (minutes; DST changes don't count). */
const wallMinutes = (e) => diffDays(e.start.slice(0, 10), e.end.slice(0, 10)) * 1440 + toMinutes(e.end.slice(11, 16)) - toMinutes(e.start.slice(11, 16));

/** The instances of one event (all of a repeating one's) that touch [fromYmd, toYmd], added to `out`. */
function pushInstances(out, e, fromYmd, toYmd, cal) {
  if (!isStr(e.start) || !isStr(e.end)) return;
  const startDate = e.start.slice(0, 10);
  const endDate = e.end.slice(0, 10);
  const spanDays = Math.max(0, diffDays(startDate, endDate));
  const dates = e.repeat
    ? occurrencesBetween(e.repeat, startDate, addDaysYmd(fromYmd, -spanDays), toYmd, { exdates: e.exdates, until: e.until })
    : endDate >= fromYmd && startDate <= toYmd
      ? [startDate]
      : [];
  const wall = e.allDay ? 0 : wallMinutes(e);
  for (const d of dates) {
    let start;
    let end;
    if (e.allDay) {
      start = parseYmd(d);
      end = addDays(parseYmd(endDate), diffDays(startDate, d));
    } else {
      // The series' clock time on this date, so a 9:00 series stays at 9:00 across DST changes, and
      // the end its clock length later: where that time doesn't exist (2:30 on the night the clocks
      // go from 2:00 to 3:00) the event starts at 3:30 and still lasts its hour, as Apple and Google show it.
      start = parseDT(`${d}${e.start.slice(10)}`);
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + wall);
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const endYmd = e.allDay ? ymd(end) : ymd(new Date(end.getTime() - 1));
    if (endYmd < fromYmd || ymd(start) > toYmd) continue;
    out.push({ key: `${e.id}@${d}`, event: e, occurrence: d, start, end, allDay: !!e.allDay, calendar: cal, color: cal?.color || 'iris' });
  }
}

/** Expand events (including recurring ones) into concrete instances that touch [fromYmd, toYmd]. */
export function eventInstances(fromYmd, toYmd, { includeHidden = false } = {}) {
  const cals = calendarMap();
  const out = [];
  for (const e of db.all('events')) {
    const cal = cals.get(e.calendarId);
    if (!includeHidden && cal && cal.visible === false) continue;
    pushInstances(out, e, fromYmd, toYmd, cal);
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

const clockMinutes = (d) => d.getHours() * 60 + d.getMinutes();

/**
 * Instances overlapping a single day, split into all-day and timed. Timed instances get {top, bottom}
 * in wall-clock minutes (0–1440, clipped to the day) — the same scale as the now-line, task blocks
 * and drag & drop, so events line up on DST changeover days too.
 */
export function dayInstances(instances, dayYmd) {
  const dayStart = parseYmd(dayYmd);
  const dayEnd = addDays(dayStart, 1);
  const allDay = [];
  const timed = [];
  for (const i of instances) {
    if (i.allDay) {
      if (ymd(i.start) <= dayYmd && ymd(i.end) >= dayYmd) allDay.push(i);
    } else if (i.start < dayEnd && i.end > dayStart) {
      const s = i.start <= dayStart ? 0 : clockMinutes(i.start);
      const e = i.end >= dayEnd ? 1440 : clockMinutes(i.end);
      // Timed events of a full day or more (by the clock, not elapsed time) go in the all-day row.
      const wall = diffDays(ymd(i.start), ymd(i.end)) * 1440 + clockMinutes(i.end) - clockMinutes(i.start);
      if (wall >= 1440) allDay.push(i);
      else timed.push({ ...i, top: s, bottom: Math.max(e, s + 15) });
    }
  }
  return { allDay, timed };
}

/**
 * Lay out overlapping timed items in columns (like Apple/Google Calendar).
 * items need {top, bottom} in minutes; adds {col, cols, span}.
 */
export function layoutColumns(items) {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const clusters = [];
  let current = [];
  let clusterEnd = -1;
  for (const it of sorted) {
    if (it.top >= clusterEnd && current.length) {
      clusters.push(current);
      current = [];
    }
    current.push(it);
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  if (current.length) clusters.push(current);

  for (const cluster of clusters) {
    const colsEnd = [];
    for (const it of cluster) {
      let c = colsEnd.findIndex((end) => end <= it.top);
      if (c < 0) {
        c = colsEnd.length;
        colsEnd.push(it.bottom);
      } else colsEnd[c] = it.bottom;
      it.col = c;
    }
    const n = colsEnd.length;
    for (const it of cluster) {
      it.cols = n;
      // Expand into free columns to the right.
      let span = 1;
      for (let c = it.col + 1; c < n; c++) {
        if (cluster.some((o) => o !== it && o.col === c && o.top < it.bottom && o.bottom > it.top)) break;
        span++;
      }
      it.span = span;
    }
  }
  return sorted;
}

export function createEvent(fields, settingsObj = {}) {
  const cals = db.all('calendars');
  const calendarId = (fields.calendarId && cals.some((c) => c.id === fields.calendarId) ? fields.calendarId : null) || cals.find((c) => c.visible !== false)?.id || cals[0]?.id || null;
  const date = fields.date || todayYmd();
  let start;
  let end;
  if (fields.allDay || !fields.time) {
    start = date;
    end = fields.endDate || date;
  } else {
    const mins = fields.duration || settingsObj.defaultEventMinutes || 60;
    start = fmtDT(parseDT(`${date}T${fields.time}`));
    end = addClockMinutes(start, mins);
  }
  const alerts = cleanAlerts(fields.alerts);
  return db.insert('events', {
    title: fields.title || 'New event',
    calendarId,
    allDay: !!(fields.allDay || !fields.time),
    start,
    end,
    location: fields.location || '',
    notes: fields.notes || '',
    repeat: fields.repeat || null,
    exdates: [],
    until: null,
    ...(alerts.length ? { alerts } : {}),
  });
}

/** exdates and until moved by whole days, for when a series' dates move ({} when nothing moves). */
export function shiftSeriesDates(e, deltaDays) {
  if (!deltaDays) return {};
  return {
    exdates: (e.exdates || []).map((x) => addDaysYmd(x, deltaDays)),
    until: e.until ? addDaysYmd(e.until, deltaDays) : e.until ?? null,
  };
}

const occurrenceOf = (x) => x.occurrence ?? x.start.slice(0, 10);

/** Edited single occurrences split from series `eventId` (optionally only those on/after `fromYmd`). */
export function seriesCopies(eventId, fromYmd = null) {
  return db.all('events').filter((x) => x.seriesId === eventId && !x.repeat && (fromYmd == null || occurrenceOf(x) >= fromYmd));
}

/**
 * Edit one occurrence of a recurring series: exclude that date from the series and
 * create a standalone copy with the patch applied. Returns the new event.
 */
export function detachOccurrence(eventId, occurrence, patch) {
  const e = db.get('events', eventId);
  if (!e) return null;
  const startDate = e.start.slice(0, 10);
  const shift = diffDays(startDate, occurrence);
  let created = null;
  const { id: _omit, ...rest } = structuredClone(e);
  db.batch(() => {
    db.update('events', eventId, { exdates: [...new Set([...(e.exdates || []), occurrence])].sort() });
    created = db.insert('events', {
      ...rest,
      start: shiftDays(e.start, shift),
      end: shiftDays(e.end, shift),
      repeat: null,
      exdates: [],
      until: null,
      seriesId: e.id,
      occurrence,
      ...patch,
    });
  });
  return created;
}

/**
 * "This and following": end the series before `occurrence` and start a new series there with the
 * patch. Edited copies on/after the split move to the new series; exdates and until follow a date move.
 */
export function splitSeries(eventId, occurrence, patch = {}) {
  const e = db.get('events', eventId);
  if (!e) return null;
  const startDate = e.start.slice(0, 10);
  const moved = isStr(patch.start) ? diffDays(occurrence, patch.start.slice(0, 10)) : 0;
  if (occurrence === startDate) {
    return db.update('events', eventId, { ...shiftSeriesDates(e, moved), ...patch });
  }
  const shift = diffDays(startDate, occurrence);
  let created = null;
  const { id: _omit, ...rest } = structuredClone(e);
  db.batch(() => {
    db.update('events', eventId, { until: addDaysYmd(occurrence, -1) });
    const tail = { ...e, exdates: (e.exdates || []).filter((x) => x >= occurrence) };
    created = db.insert('events', {
      ...rest,
      start: shiftDays(e.start, shift),
      end: shiftDays(e.end, shift),
      exdates: tail.exdates,
      until: e.until,
      ...shiftSeriesDates(tail, moved),
      ...patch,
    });
    for (const c of seriesCopies(e.id, occurrence)) db.update('events', c.id, { seriesId: created.id });
  });
  return created;
}

/**
 * Delete an occurrence ('this'), it and the rest of the series ('following') or the whole series
 * ('all'), including occurrences that were edited separately. Non-repeating events are just removed.
 */
export function deleteOccurrence(eventId, occurrence, scope = 'all') {
  const e = db.get('events', eventId);
  if (!e) return;
  const startDate = e.start.slice(0, 10);
  db.batch(() => {
    if (!e.repeat || scope === 'all' || (scope === 'following' && occurrence <= startDate)) {
      if (e.repeat) for (const c of seriesCopies(e.id)) db.remove('events', c.id);
      db.remove('events', e.id);
    } else if (scope === 'following') {
      for (const c of seriesCopies(e.id, occurrence)) db.remove('events', c.id);
      db.update('events', e.id, { until: addDaysYmd(occurrence, -1) });
    } else {
      db.update('events', e.id, { exdates: [...new Set([...(e.exdates || []), occurrence])].sort() });
    }
  });
}

/**
 * Run `fn` (synchronous writes) and return an undo that reverts exactly what it did to the records
 * it created, changed or removed in `names` (revertChange, record by record): other records, and
 * edits made to these since (from any tab), are left alone. A list, calendar or folder fn made goes
 * last, once what fn put in it has gone (a folder inside another first), and stays while anything
 * else is in it. The undo carries fn's return value as `.result`, and as `.count` how many records fn
 * created, changed or removed: 0 when it wrote nothing, as for an undo that found nothing left to take back.
 */
export function trackChanges(fn, names = ['events']) {
  const before = new Map(names.map((n) => [n, new Map(db.all(n).map((x) => [x.id, x]))]));
  let result;
  db.batch(() => {
    result = fn();
  });
  const changes = []; // [collection, before | null, after | null]
  for (const n of names) {
    const b = before.get(n);
    const after = new Map(db.all(n).map((x) => [x.id, x]));
    for (const [id, x] of after) if (!b.has(id)) changes.push([n, null, structuredClone(x)]);
    for (const [id, x] of b) if (after.get(id) !== x) changes.push([n, structuredClone(x), after.has(id) ? structuredClone(after.get(id)) : null]);
  }
  const holders = changes.filter(([n, b]) => !b && IN_USE[n]);
  const undo = () =>
    db.batch(() => {
      for (const c of changes) if (!holders.includes(c)) revertChange(...c);
      // Then the holders, round by round: each round removes those nothing is in any more.
      for (let left = holders, kept; left.length; left = kept) {
        kept = left.filter((c) => revertChange(...c));
        if (kept.length === left.length) break;
      }
    });
  undo.result = result;
  undo.count = changes.length;
  return undo;
}

/** @deprecated whole-collection snapshots overwrite later edits; use trackChanges(). */
export function snapshotEvents() {
  return structuredClone(db.all('events'));
}

/** Tasks that should appear on the calendar between two dates (completed ones stay, checked). */
export function scheduledTasks(fromYmd, toYmd, s) {
  if (!s.showTasksInSchedule) return [];
  const ids = liveListIds();
  return db.all('tasks').filter((t) => t.date && t.date >= fromYmd && t.date <= toYmd && !isTaskListHidden(t, s, ids));
}

export function taskBlock(t, s) {
  if (!t.time) return null;
  const top = toMinutes(t.time);
  const dur = t.duration || s.defaultTaskMinutes || 30;
  return { top, bottom: Math.min(1440, top + Math.max(15, dur)) };
}

/** fn()'s list, or none if it throws, so a record that can't be read costs its dot, never the sidebar. */
function listOrNone(fn) {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * A mini month's grey dots, one rule for every app that shows them: the days from `fromYmd` to `toYmd`
 * (both 'YYYY-MM-DD', inclusive) that have plans, i.e. an event of a calendar that is shown (a multi-day
 * event marks each of its days) or an open task with a time that Schedule draws (`s`: the settings; tasks
 * hidden there are left out, as are all tasks when no settings are given). A Set of 'YYYY-MM-DD'.
 */
export function busyDays(fromYmd, toYmd, s = {}) {
  const days = new Set();
  if (!isYmd(fromYmd) || !isYmd(toYmd) || fromYmd > toYmd) return days;
  const span = diffDays(fromYmd, toYmd) + 1;
  for (const i of listOrNone(() => eventInstances(fromYmd, toYmd))) {
    const first = ymd(i.start) < fromYmd ? fromYmd : ymd(i.start);
    const lastRaw = i.allDay ? ymd(i.end) : ymd(new Date(i.end.getTime() - 1));
    const last = lastRaw > toYmd ? toYmd : lastRaw;
    for (let d = first, n = 0; d <= last && n < span; d = addDaysYmd(d, 1), n++) days.add(d);
  }
  for (const t of listOrNone(() => scheduledTasks(fromYmd, toYmd, s || {}))) if (!t.done && t.time) days.add(t.date);
  return days;
}

// ---------------------------------------------------------------- reminders and alerts

/*
 task.reminder: 'YYYY-MM-DDTHH:MM' — when to remind, on the clock like event times (Microsoft To Do's
   "Remind me", a Todoist reminder). Only an open task reminds. A repeating task's reminder moves with
   it to its next date (toggleTask), keeping its distance from the task's day.
 event.alerts: [minutes] — Apple and Google Calendar's alerts, in minutes before the start; for an
   all-day event before 0:00 on its first day, so -540 is 9:00 on the day and 900 is 9:00 the day
   before. Every occurrence of a repeating event alerts, and so does an event in a hidden calendar
   (hiding a calendar takes it off the grid; it doesn't mute it, as in Google Calendar).
 A record without either leaves the field out. They come up while ecosys is open in a browser: a page
 asks dueReminders what came due since it last looked.
*/

/** Apple Calendar's alert choices, in minutes before the start (an all-day event's: before 0:00 on its day). */
export const ALERT_CHOICES = Object.freeze({
  timed: Object.freeze([0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]),
  allDay: Object.freeze([-540, 900, 2340, 9540]),
});

/** How many alerts an event keeps (Google Calendar's limit), and how far from the start they can be. */
export const ALERT_LIMITS = Object.freeze({ count: 5, maxBefore: 40320, maxAfter: 1439 });

/** A whole number of minutes from a number or a numeric string ('15'), rounded as the store's validators do; else NaN. */
const wholeMinutes = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

/**
 * An event's alerts as the store keeps them (shared/sanitize.js events.alerts is the same rule): whole
 * minutes from 4 weeks before to a day after the start, each once, the first five given, the earliest
 * alert first. Anything else is left out.
 */
export function cleanAlerts(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (out.length >= ALERT_LIMITS.count) break;
    const m = wholeMinutes(x);
    if (m <= ALERT_LIMITS.maxBefore && m >= -ALERT_LIMITS.maxAfter && !out.includes(m)) out.push(m);
  }
  return out.sort((a, b) => b - a);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function spanWords(m) {
  if (m % 10080 === 0) return plural(m / 10080, 'week');
  if (m % 1440 === 0) return plural(m / 1440, 'day');
  if (m % 60 === 0) return plural(m / 60, 'hour');
  if (m < 60) return plural(m, 'minute');
  return `${plural(Math.floor(m / 60), 'hour')} ${plural(m % 60, 'minute')}`;
}

/** A clock time as the apps write it: '9am', '2:30pm' (or '09:00', '14:30' with 24-hour time). */
const clock = (hhmm) => fmtTime(hhmm, { compact: true });

/**
 * How an alert reads, in Apple Calendar's words: "At time of event", "15 minutes before", "1 hour
 * before", "2 days before"; for an all-day event "On the day at 9am", "1 day before at 9am", "1 week
 * before at 9am" (times follow the 12/24-hour setting).
 */
export function alertLabel(minutes, { allDay = false } = {}) {
  const m = Number(minutes);
  if (!Number.isInteger(m)) return '';
  if (allDay) {
    const time = ((-m % 1440) + 1440) % 1440;
    const days = (time + m) / 1440;
    const at = clock(fromMinutes(time));
    if (days === 0) return `On the day at ${at}`;
    return `${days % 7 === 0 ? plural(days / 7, 'week') : plural(days, 'day')} before at ${at}`;
  }
  if (m === 0) return 'At time of event';
  return m > 0 ? `${spanWords(m)} before` : `${spanWords(-m)} after`;
}

/**
 * Microsoft To Do's "Remind me" choices for a task: Later today (3 hours on, rounded up to the hour,
 * while that is still today), Tomorrow and Next week (Monday, as in the date menu) at 9:00, and first
 * At its time for a task planned for a time still ahead (Todoist's reminder). Two choices never name
 * the same moment (on a Sunday, Next week is tomorrow: Tomorrow stays). Pick a date & time is the
 * date picker's. → [{ id, label, value: 'YYYY-MM-DDTHH:MM' }]
 */
export function reminderChoices(task = null, now = new Date()) {
  const today = ymd(now);
  const out = [];
  if (task && isYmd(task.date) && isHHMM(task.time) && parseDT(`${task.date}T${task.time}`) > now) out.push({ id: 'attime', label: 'At its time', value: `${task.date}T${task.time}` });
  const exact = !now.getMinutes() && !now.getSeconds() && !now.getMilliseconds();
  const later = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 3 + (exact ? 0 : 1), 0);
  if (ymd(later) === today) out.push({ id: 'later', label: 'Later today', value: fmtDT(later) });
  out.push({ id: 'tomorrow', label: 'Tomorrow', value: `${addDaysYmd(today, 1)}T09:00` });
  out.push({ id: 'nextweek', label: 'Next week', value: `${addDaysYmd(today, (1 - now.getDay() + 7) % 7 || 7)}T09:00` });
  return out.filter((c, i) => out.findIndex((x) => x.value === c.value) === i);
}

/** A reminder as the Tasks detail shows it: "Today at 4pm", "Tomorrow at 9am", "Mon, Dec 7 at 9:30am". */
export function reminderLabel(value) {
  return isDateTime(value) ? `${dayLabel(value.slice(0, 10))} at ${clock(value.slice(11))}` : '';
}

const DAY_MS = 86400000;

/**
 * The task reminders and event alerts that come due after `from` and up to `to` (Dates or ms), in the
 * order they come: each open task's reminder, and each alert of each occurrence of an event (any
 * calendar) that isn't over by `to`. A span longer than a week counts as the last week. →
 * [{ key, kind: 'task'|'event', id, at: Date, title, task } | { …, event, occurrence, start, end,
 * allDay, minutes }]. `key` names the one moment (a reminder or event moved to another time is a new
 * one), so a page can tell which it has raised.
 */
export function dueReminders(from, to) {
  const end = +to;
  let start = +from;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return [];
  start = Math.max(start, end - 7 * DAY_MS);
  const due = (d) => d.getTime() > start && d.getTime() <= end;
  const out = [];
  for (const t of db.all('tasks')) {
    if (t.done || !isDateTime(t.reminder)) continue;
    const at = parseDT(t.reminder);
    if (due(at)) out.push({ key: `task:${t.id}@${t.reminder}`, kind: 'task', id: t.id, at, title: String(t.title || ''), task: t });
  }
  const cals = calendarMap();
  for (const e of db.all('events')) {
    const alerts = cleanAlerts(e.alerts);
    if (!alerts.length) continue;
    // Occurrences that start within the span moved by each alert's distance, with a day to spare either side.
    const list = [];
    pushInstances(list, e, ymd(new Date(start + alerts.at(-1) * 60000 - DAY_MS)), ymd(new Date(end + alerts[0] * 60000 + DAY_MS)), cals.get(e.calendarId));
    for (const i of list) {
      const over = i.allDay ? addDays(i.end, 1) : i.end;
      if (over.getTime() <= end) continue; // over before anyone could act on it
      for (const m of alerts) {
        // On the clock: 10 minutes before 9:00 is 8:50, and a day before 9:00 is 9:00, across a clock change too.
        const at = new Date(i.start.getFullYear(), i.start.getMonth(), i.start.getDate(), i.start.getHours(), i.start.getMinutes() - m);
        if (due(at)) {
          out.push({ key: `event:${e.id}@${fmtDT(i.start)}~${m}`, kind: 'event', id: e.id, at, title: String(e.title || ''), event: e, occurrence: i.occurrence, start: i.start, end: i.end, allDay: i.allDay, minutes: m });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'event' ? -1 : 1) || a.title.localeCompare(b.title));
}

/**
 * What a reminder says, for a toast (`text`) or a system notification (`title`, `body`): the task's
 * title and "Reminder", or the event's title and when it starts ("In 10 minutes", "Now", "Today at
 * 3pm", "Tomorrow, all day"), with its location.
 */
export function describeReminder(r, now = new Date()) {
  if (r?.kind === 'event') {
    const title = r.title.trim() || 'Untitled event';
    let when;
    if (r.allDay) when = `${dayLabel(r.occurrence)}, all day`;
    else {
      const mins = Math.round((r.start - now) / 60000);
      when = mins <= 0 ? (r.end > now ? 'Now' : 'Ended') : mins < 60 ? `In ${plural(mins, 'minute')}` : `${dayLabel(ymd(r.start))} at ${clock(fmtDT(r.start).slice(11))}`;
    }
    const where = String(r.event?.location || '').trim();
    const body = where ? `${when} · ${where}` : when;
    return { title, body, text: `${title} · ${body}` };
  }
  const title = String(r?.title || '').trim() || 'Untitled task';
  return { title, body: 'Reminder', text: `Reminder: ${title}` };
}

/** Where a reminder opens, from the site's root: the task in Tasks, or the event on its day in Schedule. */
export function reminderPath(r) {
  return r?.kind === 'event' ? `schedule/#/day/${r.occurrence}/event/${encodeURIComponent(r.id)}` : `tasks/#/task/${encodeURIComponent(r?.id ?? '')}`;
}

export { firstOnOrAfter, shiftRule };
