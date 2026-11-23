// MCP tools for ecosys: what an AI assistant can read and change.
//
// Tool entry contract (also used by server/tools-notes.mjs, which exports { tools: [...] }):
//   {
//     name: 'snake_case', title, description, inputSchema, outputSchema?, annotations,
//     write: boolean,                 // write tools are hidden from read-only connections
//     alongside?: {tool: sentence},   // added to the description only while that tool is listed too
//     run(args, ctx) → { text, data, summary? }
//   }
//   ctx = {
//     clock: {now: Date, today, time, nowDT, zone, offset, weekday},
//     state: {all(c), get(c, id), settings()}   // read access (for write tools this is the tx)
//     tx:    {all, get, put(c, item), del(c, id), settings(), setSettings(patch)}   // write tools only
//     settings: effective settings with defaults, hour12: boolean,
//     client: {id, kind, label, access}, clientName,
//     offers(name),                           // is that tool listed for this session now (see below)
//     undo(changeId), recentChanges(limit),   // recentChanges: summaries of hidden notes are masked
//     notesSchema: boolean,                   // false: notes/core/schema.js didn't load; don't write notes
//     normalizeNote(note),                    // a stored note in the form the store saves (older records)
//     notesEditable(state)                    // → (note) => may this assistant change it now; null: no note
//   }
// A tool points an assistant to another tool only where the session has that tool: in its description
// through `alongside`, in a result (or error) only when ctx.offers(name). A read-only connection, the
// global AI access Read only, or notes access Read or Off each take tools away (core.offeredTools).
// A read tool's description names no write tool at all, not even in `alongside`: its definition is the
// same for a read-only connection as for one that can write (tests/mcp/tools.test.js).
// Throw ToolError (from ./model.mjs, or call fail()) for anything the model can fix; the message is
// returned as an isError result with today's date and time zone appended. Everything a write tool
// does through ctx.tx is one atomic change: recorded for undo, shown in the activity feed and pushed
// live to open browser tabs. Items are validated by shared/sanitize.js on put (note HTML included).
// Arguments are checked against inputSchema before run(): objects allow only the listed fields,
// and a string without maxLength is capped at ARG_LIMITS.maxLength (20000), an array without
// maxItems at ARG_LIMITS.maxItems (200). Set explicit limits for anything that needs more or less.
// Schema/annotation helpers for new tool files: `import { schema } from './tools.mjs'`
// ({str, int, bool, arr, obj, nullable, looseOut, ann}, plus when(d) for a date/time string capped at
// 64 characters and ref(d) for an id or name capped at 200); errors: `import { fail } from './model.mjs'`.
// A tool that completes or reopens a task calls mirrorTaskChecks(ctx, taskId) (exported below), so the
// task's linked checklist items in notes follow in the same change.
// Text results quote (JSON strings) everything a user named: titles, notes, locations, and the names
// of lists, calendars, labels and folders, so stored text can't pose as a field or an instruction.
import {
  ToolError, fail, clock as makeClock, todayLine, fmtDay, fmtMinutes, parseDate, parseTime, parseWhen,
  parseDuration, parsePriority, parseLabels, parseRepeat, untilForCount, describeRepeat,
  resolveList, resolveCalendar, listName, calendarName, isOverdue, nextTaskOrder, newTask, completeTask,
  taskView, taskLine, byDue, instancesBetween, eventView, eventLine, shiftRule, isOccurrence, shiftDate,
  busyIntervals, mergeIntervals, freeSlots, wallMin, fromWallMin, addMinutesDT, HHMM_RE, COLORS, uid,
  addDaysYmd, diffDays, firstOnOrAfter, occurrencesBetween, nlpParse, localStamp, checkNlpDate, checkNlpTime, checkNlpRepeat,
  checkNlpRejectedRepeat, validYmd, labelsText, cmpStr,
} from './model.mjs';
import { cleanText, isPlainObject } from './util.mjs';

export { ToolError };

// ---------------------------------------------------------------- annotations

const ann = (title, kind) =>
  ({
    read: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    add: { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    edit: { title, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    once: { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    // schedule_tasks with dry_run:false rewrites existing tasks' date/time, so it must count as destructive.
    plan: { title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  })[kind];

// ---------------------------------------------------------------- schema helpers

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'].flat() });
const int = (description, minimum, maximum, extra = {}) => ({ type: 'integer', description, minimum, maximum, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const arr = (items, description, extra = {}) => ({ type: 'array', items, description, ...extra });
const obj = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const looseOut = (properties, required = []) => ({ type: 'object', properties, required });

// Size limits for free text. Dates and times are short; parsing is never run on anything longer.
const WHEN_MAX = 64; // a date, time or date-time
const REF_MAX = 200; // an id, a list or calendar name, a cursor
const when = (description) => str(description, { maxLength: WHEN_MAX });
const ref = (description, extra = {}) => str(description, { maxLength: REF_MAX, ...extra });
const LABEL = str('Label (without @)', { maxLength: 100 });
const STEP = str('Step title', { maxLength: 500 });

const DATE_D = 'Date: YYYY-MM-DD, "today", "tomorrow" or a short phrase like "next friday"';
const TIME_D = 'Start time HH:MM, 24-hour local time (e.g. "14:30")';
const DT_D = 'Local date-time YYYY-MM-DDTHH:MM (wall time in the user\'s zone; an ISO string with Z or an offset is converted)';
// Results print priorities as P1..P4, so a value copied from a result works too.
const PRIORITY = str('Priority: "p1" (highest) to "p4" (none); "P1".."P4" as results print them also work', { enum: ['p1', 'p2', 'p3', 'p4', 'P1', 'P2', 'P3', 'P4'] });
const REPEAT_D = 'Repeat pattern as text, e.g. "daily", "every weekday", "every mon, wed", "every 2 weeks", "monthly on the 15th", "yearly", "every 3 days after completion"; an RRULE like "FREQ=WEEKLY;BYDAY=MO,WE" also works';
const repeat = (types, extra = '') => ({ type: types, description: REPEAT_D + extra, maxLength: 200 });
const WORKING_HOURS = obj(
  { start: str('HH:MM', { pattern: '^\\d{2}:\\d{2}$', maxLength: 5 }), end: str('HH:MM', { pattern: '^\\d{2}:\\d{2}$', maxLength: 5 }) },
  [],
  { description: 'Working hours to use (default: the user\'s, as get_context shows them; 09:00-17:00 until they set any)' },
);

/** Limits for schemas that set none, so every tool (server/tools-notes.mjs too) has bounded input. */
export const ARG_LIMITS = Object.freeze({ maxLength: 20000, maxItems: 200 });

/** Minimal JSON-schema check for tool arguments, with messages a model can act on. */
export function checkArgs(schema, value, path = 'arguments') {
  const types = [schema.type].flat().filter(Boolean);
  if (types.length) {
    const t = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) fail(`${path} must be ${types.join(' or ')}${t === 'undefined' ? '' : `, got ${t}`}.`);
    if (value === null) return;
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`${path} must be one of: ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}.`);
  if (typeof value === 'string') {
    // Length first: nothing after this (the tool included) ever looks at an oversized string.
    const max = schema.maxLength ?? ARG_LIMITS.maxLength;
    if (value.length > max) fail(`${path} is too long (max ${max} characters).`);
    if (schema.minLength && value.trim().length < schema.minLength) fail(`${path} must not be empty.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`${path} has the wrong format (${schema.description || schema.pattern}).`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${path} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${path} must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    const max = schema.maxItems ?? ARG_LIMITS.maxItems;
    if (value.length > max) fail(`${path} takes at most ${max} items per call; split the request.`);
    if (schema.minItems && value.length < schema.minItems) fail(`${path} needs at least ${schema.minItems} item(s).`);
    if (schema.items) value.forEach((v, i) => checkArgs(schema.items, v, `${path}[${i}]`));
  }
  if (isPlainObject(value) && schema.properties) {
    const props = schema.properties;
    // Own properties only: "toString" or "constructor" must not match Object.prototype members.
    for (const k of schema.required || []) if (!Object.hasOwn(value, k) || value[k] === undefined) fail(`${path}.${k} is required.`);
    for (const [k, v] of Object.entries(value)) {
      if (!Object.hasOwn(props, k)) {
        if (schema.additionalProperties !== false) continue;
        const allowed = Object.keys(props);
        const name = cleanText(k).slice(0, 40);
        fail(allowed.length ? `${path} has an unknown field "${name}". Allowed: ${allowed.join(', ')}.` : `${path} takes no arguments (got "${name}").`);
      }
      if (v !== undefined) checkArgs(props[k], v, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------- shared bits

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const cap = (s, n) => cleanText(s).slice(0, n);
const q = (s) => JSON.stringify(cleanText(s));
const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
/** "a", "a and b", "a, b and c". */
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join(''));
/**
 * Whether this session is offered tool `name` now (ctx.offers: as tools/list shows it), so a result
 * names only tools the assistant can call. A ctx without offers (built by hand) has every tool.
 */
const offers = (ctx, name) => (typeof ctx.offers === 'function' ? !!ctx.offers(name) : true);
/** Distinct lowercase words of a search query. */
const queryWords = (s) => [...new Set(s.toLowerCase().split(/\s+/).filter(Boolean))];

function workingHours(a, ctx) {
  const wh = a.working_hours || {};
  const start = wh.start ? parseTime(wh.start, ctx.clock, 'working_hours.start') : ctx.settings.workStart;
  const end = wh.end ? parseTime(wh.end, ctx.clock, 'working_hours.end') : ctx.settings.workEnd;
  return { start, end };
}

/** Range from tool args: from/to (dates are whole days; to is inclusive). Returns wall-clock strings. */
function rangeArgs(a, ctx, { maxDays, defaultDays = 7, clampToNow = false } = {}) {
  const c = ctx.clock;
  const f = a.from ? parseWhen(a.from, c, 'from', ctx.hour12) : { date: c.today, time: null };
  let fromDT = `${f.date}T${f.time || '00:00'}`;
  let toDT;
  if (a.to) {
    const t = parseWhen(a.to, c, 'to', ctx.hour12);
    toDT = t.time ? `${t.date}T${t.time}` : `${addDaysYmd(t.date, 1)}T00:00`;
  } else toDT = `${addDaysYmd(f.date, defaultDays)}T00:00`;
  if (clampToNow && fromDT < c.nowDT) fromDT = c.nowDT;
  if (toDT <= fromDT) fail(`"to" must be after "from" (and in the future when searching for free time). Got from=${fromDT}, to=${toDT}.`);
  if (maxDays && wallMin(toDT) - wallMin(fromDT) > maxDays * 1440) fail(`The range can be at most ${maxDays} days. Split it into smaller ranges.`);
  return { fromDT, toDT, fromYmd: fromDT.slice(0, 10), toYmd: (toDT.endsWith('T00:00') ? addDaysYmd(toDT.slice(0, 10), -1) : toDT.slice(0, 10)) };
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}
function decodeCursor(cur) {
  if (cur === undefined) return 0;
  try {
    const o = JSON.parse(Buffer.from(String(cur), 'base64url').toString('utf8')).o;
    if (Number.isInteger(o) && o >= 0) return o;
  } catch {}
  fail('cursor is not valid. Pass the exact cursor from the previous result, with the same filters.');
}

const findTask = (st, id) => (typeof id === 'string' && st.get('tasks', id)) || fail(`No task with id "${cap(id, 40)}". Use find_tasks to look up task ids.`);
const findEvent = (st, id) => (typeof id === 'string' && st.get('events', id)) || fail(`No event with id "${cap(id, 40)}". Use find_events to look up event ids.`);

/** A start or end that is only a time of day ("14:30", "5pm"), not a date. */
const timeOnly = (v) => {
  const s = String(v).trim();
  return HHMM_RE.test(s) || /^\d{1,2}(:\d{2})?\s*[ap]\.?m?\.?$/i.test(s);
};

/** The first day on or after `from` that event `e` happens (its exceptions and end honoured), or null. */
function nextOccurrence(e, from) {
  const start = e.start.slice(0, 10);
  if (!e.repeat) return start >= from ? start : null;
  return occurrencesBetween(e.repeat, start, from, addDaysYmd(from, 400), { exdates: e.exdates || [], until: e.until || null })[0] || null;
}

/** How many days before `today` event `e` happens on (1 or 0 for a single event). */
function pastOccurrences(e, today) {
  const start = e.start.slice(0, 10);
  if (start >= today) return 0;
  if (!e.repeat) return 1;
  return occurrencesBetween(e.repeat, start, start, addDaysYmd(today, -1), { exdates: e.exdates || [], until: e.until || null }).length;
}

/**
 * A task's linked checklist items in notes (check blocks with `task: <id>`) follow its done state in
 * the same change, as the apps do it (shared/model.js mirrorTaskChecks): a system change, rev + 1, the
 * edit time and editor kept. Only notes this assistant may change now (notes access Edit; not hidden
 * from AI, in a hidden folder, locked or in Recently Deleted): the Notes app brings any other note in
 * line when it next opens, and results never mention one. `skipNoteId`: a note the caller writes itself.
 */
export function mirrorTaskChecks(ctx, taskId, { skipNoteId = null } = {}) {
  const tx = ctx.tx;
  if (!tx || ctx.notesSchema === false || typeof ctx.notesEditable !== 'function') return 0;
  const t = tx.get('tasks', taskId);
  if (!t) return 0;
  const ck = !!t.done;
  const stale = (b) => isPlainObject(b) && b.t === 'check' && b.task === taskId && !!b.ck !== ck;
  let editable = null;
  let count = 0;
  const now = Date.now();
  for (const raw of tx.all('notes')) {
    if (!isPlainObject(raw) || raw.id === skipNoteId || raw.trashedAt || raw.locked || !Array.isArray(raw.blocks) || !raw.blocks.some(stale)) continue;
    editable ??= ctx.notesEditable(tx) || (() => false);
    if (!editable(raw)) continue;
    const n = typeof ctx.normalizeNote === 'function' ? ctx.normalizeNote(raw) || raw : raw;
    if (!Array.isArray(n.blocks)) continue;
    try {
      tx.put('notes', { ...n, blocks: n.blocks.map((b) => (stale(b) ? { ...b, ck } : b)), rev: (Number.isInteger(n.rev) ? n.rev : 0) + 1, updatedAt: now });
      count++;
    } catch {} // a note that no longer passes validation keeps its items as they are; the task still changes
  }
  return count;
}

function resolveCalendars(st, v) {
  if (!v || !v.length) return null;
  return v.map((x) => resolveCalendar(st, x));
}

// ---------------------------------------------------------------- read tools

/** Lists, calendars and labels get_context returns at most (each), with a count of the rest. */
const MAX_NAMES = 200;

const getOverview = {
  name: 'get_overview',
  title: 'Get overview',
  description:
    'Agenda for today or the next few days: overdue tasks, each day\'s events and tasks in time order, and free time in working hours. Use this first for "what\'s on today / this week" questions.',
  inputSchema: obj({
    date: when(`First day (default today). ${DATE_D}`),
    days: int('Number of days to include (default 1)', 1, 14),
    include_overdue: bool('Include overdue tasks (default true)'),
    working_hours: WORKING_HOURS,
  }),
  outputSchema: looseOut({ today: { type: 'string' }, time_zone: { type: 'string' }, overdue: { type: 'array' }, days: { type: 'array' } }, ['today', 'days']),
  annotations: ann('Get overview', 'read'),
  write: false,
  run(a, ctx) {
    const { clock: c, state: st } = ctx;
    const start = a.date ? parseDate(a.date, c) : c.today;
    const n = a.days ?? 1;
    const end = addDaysYmd(start, n - 1);
    const open = st.all('tasks').filter((t) => !t.done);
    const finished = st.all('tasks').filter((t) => t.done && t.completedAt).sort((x, y) => x.completedAt - y.completedAt);
    const overdue = a.include_overdue !== false && start <= c.today && end >= c.today ? open.filter((t) => isOverdue(t, c.today)).sort(byDue) : [];
    const inst = instancesBetween(st, start, end);
    const lines = [todayLine(c)];
    const MAX = 40;
    const wh = workingHours(a, ctx);
    if (overdue.length) {
      lines.push('', `Overdue tasks (${overdue.length}):`);
      for (const t of overdue.slice(0, MAX)) lines.push(`- ${taskLine(st, t, c)}`);
      if (overdue.length > MAX) lines.push(`- ...and ${overdue.length - MAX} more (find_tasks with overdue:true)`);
    }
    const days = [];
    const busyAll = busyIntervals(st, `${start}T00:00`, `${addDaysYmd(end, 1)}T00:00`, { defaultTaskMinutes: ctx.settings.defaultTaskMinutes });
    for (let d = start; d <= end; d = addDaysYmd(d, 1)) {
      const evs = inst.filter((i) => (i.allDay ? i.start <= d && i.end >= d : i.start < `${addDaysYmd(d, 1)}T00:00` && i.end > `${d}T00:00`));
      const tasks = open
        .filter((t) => t.date === d || (!t.date && t.deadline === d))
        .sort((x, y) => (x.time || '99').localeCompare(y.time || '99') || (y.priority || 0) - (x.priority || 0) || (x.order ?? 0) - (y.order ?? 0));
      // What was finished that day (by when it was completed, whatever day it was planned for).
      const doneTasks = finished.filter((t) => localStamp(t.completedAt).slice(0, 10) === d);
      const doneCount = doneTasks.length;
      let free = [];
      if (d >= c.today) {
        const from = d === c.today ? c.nowDT : `${d}T00:00`;
        free = freeSlots(busyAll, from, `${addDaysYmd(d, 1)}T00:00`, { duration: 15, workStart: wh.start, workEnd: wh.end, excludeWeekends: false, max: 12 });
      }
      days.push({
        date: d,
        weekday: fmtDay(d).slice(0, 3),
        events: evs.slice(0, MAX).map((i) => eventView(i)),
        tasks: tasks.slice(0, MAX).map((t) => taskView(st, t, c)),
        more_events: Math.max(0, evs.length - MAX),
        more_tasks: Math.max(0, tasks.length - MAX),
        done_count: doneCount,
        completed: doneTasks.slice(0, MAX).map((t) => ({ task_id: t.id, title: t.title, list: listName(st, t.listId), completed_at: localStamp(t.completedAt) })),
        free,
      });
      lines.push('', `${fmtDay(d)}${d === c.today ? ' (today)' : ''}`);
      lines.push(evs.length ? `Events (${evs.length}):` : 'Events: none');
      for (const i of evs.slice(0, MAX)) lines.push(`- ${eventLine(i)}`);
      if (evs.length > MAX) lines.push(`- ...and ${evs.length - MAX} more (find_events for that day)`);
      lines.push(tasks.length ? `Tasks (${tasks.length}):` : 'Tasks: none planned');
      for (const t of tasks.slice(0, MAX)) lines.push(`- ${taskLine(st, t, c)}`);
      if (tasks.length > MAX) lines.push(`- ...and ${tasks.length - MAX} more (find_tasks with due_from/due_to)`);
      if (doneCount) {
        lines.push(`Completed that day (${doneCount}):`);
        for (const t of doneTasks.slice(0, MAX)) lines.push(`- ${q(t.title)} | done ${localStamp(t.completedAt).slice(11)} | id=${t.id}`);
        if (doneCount > MAX) lines.push(`- ...and ${doneCount - MAX} more (find_tasks with completed_from/completed_to)`);
      }
      if (d >= c.today) {
        lines.push(
          free.length
            ? `Free in working hours ${wh.start}-${wh.end}: ${free.map((s) => `${s.start.slice(11)}-${s.end.slice(11)} (${fmtMinutes(s.minutes)})`).join(', ')}`
            : `No free time left in working hours ${wh.start}-${wh.end}.`,
        );
      }
    }
    return {
      text: lines.join('\n'),
      data: { today: c.today, time: c.time, time_zone: c.zone, overdue: overdue.slice(0, MAX).map((t) => taskView(st, t, c)), more_overdue: Math.max(0, overdue.length - MAX), days },
      summary: n === 1 ? `Looked at the agenda for ${fmtDay(start)}` : `Looked at the agenda for ${n} days from ${fmtDay(start)}`,
    };
  },
};

const getContext = {
  name: 'get_context',
  title: 'Get context',
  description:
    'Current date, time and time zone, working hours and defaults, plus the lists (with open task counts), calendars and labels (up to 200 of each; labels most used first). Use this to resolve list/calendar names and relative dates.',
  inputSchema: obj({}),
  outputSchema: looseOut({ today: { type: 'string' }, time_zone: { type: 'string' }, lists: { type: 'array' }, calendars: { type: 'array' }, labels: { type: 'array' } }, ['today', 'lists', 'calendars']),
  annotations: ann('Get context', 'read'),
  write: false,
  run(_a, ctx) {
    const { clock: c, state: st } = ctx;
    const tasks = st.all('tasks');
    const open = tasks.filter((t) => !t.done);
    const lists = st.all('lists');
    const listIds = new Set(lists.map((l) => l.id));
    const inboxOpen = open.filter((t) => !t.listId || !listIds.has(t.listId)).length;
    const openIn = new Map();
    for (const t of open) if (t.listId) openIn.set(t.listId, (openIn.get(t.listId) || 0) + 1);
    const labelCount = new Map();
    for (const t of open) for (const g of t.tags || []) labelCount.set(g, (labelCount.get(g) || 0) + 1);
    const labels = [...labelCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({ label, open_tasks: count }));
    const calendars = st.all('calendars');
    const data = {
      today: c.today,
      time: c.time,
      weekday: c.weekday,
      time_zone: c.zone,
      utc_offset: c.offset,
      week_starts_on: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][ctx.settings.weekStart] || 'Sunday',
      // `default`: not set by the user (ecosys uses 09:00-17:00 until they are).
      working_hours: { start: ctx.settings.workStart, end: ctx.settings.workEnd, ...(ctx.settings.workHoursSet ? {} : { default: true }) },
      default_event_minutes: ctx.settings.defaultEventMinutes,
      default_task_minutes: ctx.settings.defaultTaskMinutes,
      // At most MAX_NAMES of each (labels: the most used), with how many more there are: one call
      // stays small however many lists, calendars and labels the user has.
      lists: [{ list_id: null, name: 'Inbox', open_tasks: inboxOpen }, ...lists.slice(0, MAX_NAMES).map((l) => ({ list_id: l.id, name: l.name, color: l.color || null, open_tasks: openIn.get(l.id) || 0 }))],
      more_lists: Math.max(0, lists.length - MAX_NAMES),
      calendars: calendars.slice(0, MAX_NAMES).map((x) => ({ calendar_id: x.id, name: x.name, color: x.color || null, hidden: x.visible === false })),
      more_calendars: Math.max(0, calendars.length - MAX_NAMES),
      labels: labels.slice(0, MAX_NAMES),
      more_labels: Math.max(0, labels.length - MAX_NAMES),
      counts: { open_tasks: open.length, completed_tasks: tasks.length - open.length, events: st.all('events').length },
      access: ctx.client?.access === 'read' || ctx.mode === 'read' ? 'read' : 'write',
    };
    // Only the notes the notes tools would show: none hidden from AI, in a hidden folder, locked or in
    // Recently Deleted, and no count at all while notes access is Off (notes-spec section 7).
    let notesCount = null;
    try {
      notesCount = notesVisibleCount ? notesVisibleCount(st) : null;
    } catch {}
    if (Number.isInteger(notesCount) && notesCount > 0) data.counts.notes = notesCount;
    const more = (n, what) => (n ? ` | and ${n} more ${what}` : '');
    // The tools that take working_hours, of those this session has (schedule_tasks only with write access).
    const takeHours = andList(['find_free_time', 'plan_tasks', 'schedule_tasks'].filter((n) => offers(ctx, n)));
    const lines = [
      todayLine(c),
      `Week starts on ${data.week_starts_on}. Working hours ${data.working_hours.start}-${data.working_hours.end}${data.working_hours.default ? ` (the default: when the user keeps other hours, pass working_hours to ${takeHours})` : ''}. Default event ${fmtMinutes(data.default_event_minutes)}, default task block ${fmtMinutes(data.default_task_minutes)}.`,
      `Lists: ${data.lists.map((l) => `${q(l.name)}${l.list_id ? ` id=${l.list_id}` : ''} (${l.open_tasks} open)`).join(' | ')}${more(data.more_lists, '(find_tasks takes any list by name)')}`,
      `Calendars: ${data.calendars.map((x) => `${q(x.name)} id=${x.calendar_id}${x.hidden ? ' (hidden)' : ''}`).join(' | ') || 'none'}${more(data.more_calendars, '(find_events takes any calendar by name)')}`,
      `Labels: ${labels.length ? data.labels.map((l) => `${q(`@${l.label}`)} (${l.open_tasks})`).join(' ') : 'none'}${data.more_labels ? ` and ${data.more_labels} more, less used (find_tasks takes any label)` : ''}`,
      `Totals: ${plural(data.counts.open_tasks, 'open task')}, ${plural(data.counts.completed_tasks, 'completed task')}, ${plural(data.counts.events, 'event')}${data.counts.notes !== undefined ? `, ${plural(data.counts.notes, 'note')}` : ''}.`,
      data.access === 'read'
        ? "This connection can only read the user's data."
        : "This connection can read and change the user's data. (If your tool list has no create_tasks, it is older than that: the user can refresh or reconnect this connector to load the tools for changes.)",
    ];
    return { text: lines.join('\n'), data, summary: 'Looked up lists, calendars and settings' };
  },
};

const findTasks = {
  name: 'find_tasks',
  title: 'Find tasks',
  description:
    'Search and filter tasks by text, list, labels, priority, status and dates. Defaults to open tasks sorted by date; status done lists the newest-completed first. due_from/due_to filter the planned date or deadline; completed_from/completed_to filter when tasks were finished ("what did I finish this week?"). Use get_task for notes and steps.',
  inputSchema: obj({
    query: str('Words to match in the title, notes or steps', { maxLength: 500 }),
    list: ref('List id or name; "inbox" for tasks without a list'),
    labels: arr(LABEL, 'Tasks with any of these labels', { maxItems: 20 }),
    priority: arr(PRIORITY, 'Only these priorities', { maxItems: 4 }),
    status: str('open (default), done or all; completed_from/completed_to imply done', { enum: ['open', 'done', 'all'] }),
    due_from: when(`Planned date or deadline on/after this day. ${DATE_D}`),
    due_to: when(`Planned date or deadline on/before this day. ${DATE_D}`),
    completed_from: when(`Completed on/after this day (the day it was finished, whatever it was planned for). ${DATE_D}`),
    completed_to: when(`Completed on/before this day. ${DATE_D}`),
    overdue: bool('true: only overdue tasks; false: leave them out'),
    has_date: bool('true: only tasks with a date or deadline; false: only undated'),
    limit: int('Max results (default 20)', 1, 100),
    cursor: ref('Cursor from a previous result to get the next page (send the same filters)'),
  }),
  outputSchema: looseOut({ total: { type: 'integer' }, tasks: { type: 'array' }, next_cursor: { type: ['string', 'null'] } }, ['total', 'tasks']),
  annotations: ann('Find tasks', 'read'),
  write: false,
  run(a, ctx) {
    const { clock: c, state: st } = ctx;
    const byCompletion = has(a, 'completed_from') || has(a, 'completed_to');
    if (byCompletion && a.status === 'open') fail('completed_from/completed_to find finished tasks; leave out status (or use "done") to search by when tasks were completed.');
    const status = a.status || (byCompletion ? 'done' : 'open');
    let tasks = st.all('tasks').filter((t) => (status === 'all' ? true : status === 'done' ? t.done : !t.done));
    const filters = [];
    if (has(a, 'list')) {
      // A search names the lists there are; it doesn't suggest adding one (create_list).
      const id = resolveList(st, a.list, { canCreate: false });
      const listIds = new Set(st.all('lists').map((l) => l.id));
      tasks = tasks.filter((t) => (id ? t.listId === id : !t.listId || !listIds.has(t.listId)));
      filters.push(`list ${q(listName(st, id))}`);
    }
    if (a.labels?.length) {
      const want = parseLabels(a.labels);
      tasks = tasks.filter((t) => (t.tags || []).some((g) => want.includes(g)));
      filters.push(`labels ${labelsText(want)}`);
    }
    if (byCompletion) {
      const from = has(a, 'completed_from') ? parseDate(a.completed_from, c, 'completed_from') : null;
      const to = has(a, 'completed_to') ? parseDate(a.completed_to, c, 'completed_to') : null;
      if (from && to && to < from) fail(`completed_to (${to}) is before completed_from (${from}).`);
      tasks = tasks.filter((t) => {
        if (!t.done || !t.completedAt) return false;
        const day = localStamp(t.completedAt).slice(0, 10);
        return (!from || day >= from) && (!to || day <= to);
      });
      filters.push(`completed ${from || '...'} to ${to || '...'}`);
    }
    if (a.priority?.length) {
      const ps = a.priority.map(parsePriority);
      tasks = tasks.filter((t) => ps.includes(t.priority || 0));
      filters.push(`priority ${a.priority.join('/')}`);
    }
    if (a.due_from || a.due_to) {
      const from = a.due_from ? parseDate(a.due_from, c, 'due_from') : '0000-00-00';
      const to = a.due_to ? parseDate(a.due_to, c, 'due_to') : '9999-99-99';
      tasks = tasks.filter((t) => [t.date, t.deadline].some((d) => d && d >= from && d <= to));
      filters.push(`due ${a.due_from ? from : '...'} to ${a.due_to ? to : '...'}`);
    }
    if (a.overdue !== undefined) {
      tasks = tasks.filter((t) => isOverdue(t, c.today) === a.overdue);
      filters.push(a.overdue ? 'overdue only' : 'not overdue');
    }
    if (a.has_date !== undefined) {
      tasks = tasks.filter((t) => !!(t.date || t.deadline) === a.has_date);
      filters.push(a.has_date ? 'with a date' : 'without a date');
    }
    if (a.query?.trim()) {
      const words = queryWords(a.query);
      tasks = tasks.filter((t) => {
        const hay = [t.title, t.notes, ...(t.checklist || []).map((s) => s.title), ...(t.tags || [])].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      filters.push(`matching ${q(a.query)}`);
    }
    tasks.sort(status === 'done' ? (x, y) => (y.completedAt || 0) - (x.completedAt || 0) : byDue);
    const limit = a.limit ?? 20;
    const offset = decodeCursor(a.cursor);
    const page = tasks.slice(offset, offset + limit);
    const next = offset + limit < tasks.length ? encodeCursor(offset + limit) : null;
    const lines = [todayLine(c), `${status === 'all' ? 'Tasks' : status === 'done' ? 'Completed tasks' : 'Open tasks'}${filters.length ? ` (${filters.join(', ')})` : ''}: ${tasks.length} found${tasks.length ? `, showing ${offset + 1}-${offset + page.length}` : ''}.`];
    for (const t of page) lines.push(`- ${taskLine(st, t, c)}`);
    if (next) lines.push(`More results: call find_tasks again with cursor "${next}" and the same filters.`);
    if (!tasks.length) lines.push('Nothing matches. Try fewer filters, status "all", or get_overview.');
    return { text: lines.join('\n'), data: { total: tasks.length, tasks: page.map((t) => taskView(st, t, c)), next_cursor: next }, summary: `Searched tasks${filters.length ? ` (${filters.join(', ')})` : ''}` };
  },
};

const getTask = {
  name: 'get_task',
  title: 'Get task',
  description: 'Full details of one task: notes, steps (with step ids), repeat rule, dates and status.',
  inputSchema: obj({ task_id: ref('Task id from find_tasks or get_overview', { minLength: 1 }) }, ['task_id']),
  outputSchema: looseOut({ task: { type: 'object' } }, ['task']),
  annotations: ann('Get task', 'read'),
  write: false,
  run(a, ctx) {
    const { clock: c, state: st } = ctx;
    const t = findTask(st, a.task_id);
    const v = taskView(st, t, c, { detailed: true });
    const lines = [todayLine(c), taskLine(st, t, c)];
    if (t.notes) lines.push(`Notes (user content): ${q(t.notes.slice(0, 4000))}`);
    if (v.steps.length) {
      lines.push(`Steps (${v.steps_done}/${v.steps_total} done):`);
      for (const s of v.steps) lines.push(`- [${s.done ? 'x' : ' '}] ${q(s.title)} step_id=${s.step_id}`);
    }
    if (t.repeat) lines.push(`Repeats: ${describeRepeat(t.repeat)}. Completing it moves it to the next date.`);
    return { text: lines.join('\n'), data: { task: v }, summary: `Opened task ${q(t.title)}` };
  },
};

const findEvents = {
  name: 'find_events',
  title: 'Find events',
  description:
    'Calendar events between two dates, with repeating events expanded into occurrences (each has event_id + occurrence). Optional calendar and text filters.',
  // Meeting notes are shown only while the notes tools can open them (notes access Read or Edit).
  alongside: { notes_read: 'An occurrence with meeting notes names them (note_id; open them with notes_read).' },
  inputSchema: obj(
    {
      from: when(`Range start. ${DATE_D}, or ${DT_D}`),
      to: when('Range end; a date is inclusive (the whole day). Max 400 days after from'),
      calendars: arr(ref('Calendar id or name'), 'Only these calendars', { maxItems: 50 }),
      query: str('Words to match in title, location or notes', { maxLength: 500 }),
      limit: int('Max results (default 50)', 1, 200),
    },
    ['from', 'to'],
  ),
  outputSchema: looseOut({ total: { type: 'integer' }, events: { type: 'array' } }, ['total', 'events']),
  annotations: ann('Find events', 'read'),
  write: false,
  run(a, ctx) {
    const { clock: c, state: st } = ctx;
    const r = rangeArgs(a, ctx, { maxDays: 400 });
    const calendarIds = resolveCalendars(st, a.calendars);
    // The text filter is checked once per event, before its occurrences are expanded.
    const words = a.query?.trim() ? queryWords(a.query) : null;
    const match = words
      ? (e) => {
          const hay = [e.title, e.location, e.notes].join(' ').toLowerCase();
          return words.every((w) => hay.includes(w));
        }
      : null;
    const inst = instancesBetween(st, r.fromYmd, r.toYmd, { calendarIds, match }).filter((i) => (i.allDay ? true : i.start < r.toDT && i.end > r.fromDT));
    // By day; on a day all-day events first, then by start time.
    inst.sort((x, y) => cmpStr(x.occurrence, y.occurrence) || (x.allDay === y.allDay ? cmpStr(x.start, y.start) : x.allDay ? -1 : 1));
    const limit = a.limit ?? 50;
    const page = inst.slice(0, limit);
    const meetings = meetingNotesLookup(st);
    const lines = [todayLine(c), `Events ${fmtDay(r.fromYmd)} to ${fmtDay(r.toYmd)}${a.query ? ` matching ${q(a.query)}` : ''}: ${inst.length} found.`];
    const events = page.map((i) => {
      const v = eventView(i);
      const meet = meetings(i);
      if (meet.length) v.meeting_notes = meet;
      lines.push(`- ${eventLine(i)}${meet.length ? ` | meeting notes ${meetingNotesText(meet)}` : ''}`);
      return v;
    });
    if (inst.length > limit) lines.push(`...and ${inst.length - limit} more. Narrow the range or raise limit (max 200).`);
    return { text: lines.join('\n'), data: { total: inst.length, events }, summary: `Looked at events ${fmtDay(r.fromYmd)} to ${fmtDay(r.toYmd)}` };
  },
};

/**
 * The meeting notes of an occurrence that this assistant may open, [{note_id, title}] (none while
 * notes access is Off; never one hidden from AI, locked or deleted): server/tools-notes.mjs
 * meetingNotesOf decides, as for the notes tools. [] without the notes tools.
 */
function meetingNotesFor(st, e, date) {
  if (!notesMeetingNotes) return [];
  try {
    const list = notesMeetingNotes(st, e, date);
    return Array.isArray(list) ? list.map((n) => ({ note_id: n.id, title: n.title })) : [];
  } catch {
    return [];
  }
}

/** At most this many occurrences of one find_events page are asked for their meeting notes (each looks at every note). */
const MAX_MEETING_LOOKUPS = 50;

/**
 * (instance) → its meeting notes, for a page of find_events: server/tools-notes.mjs meetingNotesIndex
 * looks at the notes once, then every occurrence costs the same lookup, whatever notes it has. (An
 * older tools-notes.mjs without it: only occurrences some stored note links to are asked, at most
 * MAX_MEETING_LOOKUPS of them.)
 */
function meetingNotesLookup(st) {
  if (notesMeetingIndex) {
    let index = null;
    try {
      index = notesMeetingIndex(st);
    } catch {}
    if (typeof index !== 'function') return () => [];
    return (i) => {
      try {
        const list = index(i.event, i.occurrence);
        return Array.isArray(list) ? list.map((n) => ({ note_id: n.id, title: n.title })) : [];
      } catch {
        return [];
      }
    };
  }
  if (!notesMeetingNotes) return () => [];
  const linked = new Set();
  for (const n of st.all('notes')) {
    const ev = n?.event;
    if (isPlainObject(ev) && typeof ev.id === 'string' && typeof ev.date === 'string') linked.add(`${ev.id}\u0000${ev.date}`);
  }
  if (!linked.size) return () => [];
  let asked = 0;
  return (i) => {
    const e = i.event;
    // A note of an occurrence edited on its own may still be linked to the series' day (notes-spec).
    const own = linked.has(`${e.id}\u0000${i.occurrence}`);
    const viaSeries = !!e.seriesId && validYmd(e.occurrence) && i.occurrence === e.start.slice(0, 10) && linked.has(`${e.seriesId}\u0000${e.occurrence}`);
    if ((!own && !viaSeries) || asked >= MAX_MEETING_LOOKUPS) return [];
    asked++;
    return meetingNotesFor(st, e, i.occurrence);
  };
}

const meetingNotesText = (meet) => meet.map((n) => `${q(n.title)} note_id=${n.note_id}`).join(', ');

const getEvent = {
  name: 'get_event',
  title: 'Get event',
  description: 'Full details of one event (notes, repeat rule, exceptions). For a repeating event pass occurrence to get that day\'s times.',
  // Meeting notes are shown only while the notes tools can open them (notes access Read or Edit).
  alongside: { notes_read: 'It also lists the meeting notes of the day it shows (note_id; open them with notes_read).' },
  inputSchema: obj({ event_id: ref('Event id', { minLength: 1 }), occurrence: when('Occurrence date YYYY-MM-DD (repeating events)') }, ['event_id']),
  outputSchema: looseOut({ event: { type: 'object' } }, ['event']),
  annotations: ann('Get event', 'read'),
  write: false,
  run(a, ctx) {
    const { clock: c, state: st } = ctx;
    const e = findEvent(st, a.event_id);
    let occ = e.start.slice(0, 10);
    if (a.occurrence) {
      occ = parseDate(a.occurrence, c, 'occurrence');
      if (!isOccurrence(e, occ)) fail(`${fmtDay(occ)} is not an occurrence of ${q(e.title)}. ${nearbyOccurrences(e, occ)}`);
    }
    const shift = diffDays(e.start.slice(0, 10), occ);
    const i = { event: e, occurrence: occ, start: shiftDate(e.start, shift), end: shiftDate(e.end, shift), allDay: !!e.allDay, calendar: calendarName(st, e.calendarId) };
    const v = eventView(i, { detailed: true });
    const lines = [todayLine(c), eventLine(i)];
    if (e.notes) lines.push(`Notes (user content): ${q(e.notes.slice(0, 4000))}`);
    if (e.repeat) lines.push(`Series starts ${fmtDay(e.start.slice(0, 10))}${e.until ? `, ends ${fmtDay(e.until)}` : ''}${e.exdates?.length ? `, skips ${e.exdates.join(', ')}` : ''}.`);
    if (e.seriesId) lines.push(`This is an edited occurrence of series id=${e.seriesId}.`);
    // Meeting notes belong to one occurrence (notes-spec): those of the day shown.
    const meet = meetingNotesFor(st, e, occ);
    if (meet.length) {
      v.meeting_notes = meet;
      lines.push(`Meeting notes${e.repeat ? ` of ${fmtDay(occ)}` : ''}: ${meetingNotesText(meet)}${offers(ctx, 'notes_read') ? ' (notes_read with that id opens them)' : ''}.`);
    }
    return { text: lines.join('\n'), data: { event: v }, summary: `Opened event ${q(e.title)}` };
  },
};

function nearbyOccurrences(e, around) {
  if (!e.repeat) return `It happens on ${fmtDay(e.start.slice(0, 10))}.`;
  const list = occurrencesBetween(e.repeat, e.start.slice(0, 10), addDaysYmd(around, -21), addDaysYmd(around, 21), { exdates: e.exdates || [], until: e.until || null });
  // The eight closest to the day asked about, in date order.
  const near = list
    .map((d) => [Math.abs(diffDays(around, d)), d])
    .sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]))
    .slice(0, 8)
    .map(([, d]) => d)
    .sort();
  return near.length ? `Nearby occurrences: ${near.join(', ')}.` : 'The series has no occurrences near that date.';
}

const findFreeTime = {
  name: 'find_free_time',
  title: 'Find free time',
  description:
    'Open slots on the calendar. Use when the user asks when they are free, or before creating an event or time-blocking tasks. Timed events and timed tasks count as busy; all-day events do not.',
  inputSchema: obj(
    {
      from: when(`Range start. ${DATE_D}, or ${DT_D}`),
      to: when('Range end; a date is inclusive. Max 62 days after from'),
      duration_minutes: int('Minimum slot length (default 30)', 5, 720),
      working_hours: WORKING_HOURS,
      exclude_weekends: bool('Skip Saturday and Sunday (default true)'),
      calendars: arr(ref('Calendar id or name'), 'Only these calendars count as busy (default all)', { maxItems: 50 }),
      buffer_minutes: int('Gap to keep around busy times (default 0)', 0, 120),
      max_results: int('Max slots (default 5)', 1, 20),
    },
    ['from', 'to'],
  ),
  outputSchema: looseOut({ slots: { type: 'array' } }, ['slots']),
  annotations: ann('Find free time', 'read'),
  write: false,
  run(a, ctx) {
    const { clock: c, state: st } = ctx;
    const r = rangeArgs(a, ctx, { maxDays: 62, clampToNow: true });
    const wh = workingHours(a, ctx);
    const duration = a.duration_minutes ?? 30;
    const busy = busyIntervals(st, r.fromDT, r.toDT, { calendarIds: resolveCalendars(st, a.calendars), buffer: a.buffer_minutes || 0, defaultTaskMinutes: ctx.settings.defaultTaskMinutes });
    const slots = freeSlots(busy, r.fromDT, r.toDT, { duration, workStart: wh.start, workEnd: wh.end, excludeWeekends: a.exclude_weekends !== false, max: a.max_results ?? 5 });
    const lines = [todayLine(c), `Free slots of at least ${fmtMinutes(duration)}, ${fmtDay(r.fromYmd)} to ${fmtDay(r.toYmd)}, ${wh.start}-${wh.end}${a.exclude_weekends !== false ? ', weekdays' : ''}: ${slots.length} found.`];
    for (const s of slots) lines.push(`- ${fmtDay(s.start.slice(0, 10))} ${s.start.slice(11)}-${s.end.slice(0, 10) === s.start.slice(0, 10) ? s.end.slice(11) : s.end} (${fmtMinutes(s.minutes)})`);
    if (!slots.length) lines.push('No free time in that range. Try a longer range, shorter duration, other working hours, or exclude_weekends:false.');
    else {
      // Only the tools this session has: a read-only one books nothing.
      const next = [offers(ctx, 'create_events') && 'create_events to book a slot', offers(ctx, 'schedule_tasks') && 'schedule_tasks to time-block tasks'].filter(Boolean);
      if (next.length) lines.push(`Next: ${next.join(', or ')}.`);
    }
    return { text: lines.join('\n'), data: { slots }, summary: `Looked for free time ${fmtDay(r.fromYmd)} to ${fmtDay(r.toYmd)}` };
  },
};

const findChanges = {
  name: 'find_changes',
  title: 'Find recent changes',
  // Names no write tool: a read tool's definition is the same for every connection (tests/mcp/tools.test.js),
  // and a read-only one has no undo. undo_change's own description and the instructions say it takes these ids.
  description:
    'Recent changes made through AI connections, and undos the user made in ecosys (newest first), each with its change_id. "by" is the AI connection that made the change, or "the user".',
  inputSchema: obj({ limit: int('Max results (default 10)', 1, 50) }),
  outputSchema: looseOut({ changes: { type: 'array' } }, ['changes']),
  annotations: ann('Find recent changes', 'read'),
  write: false,
  run(a, ctx) {
    const list = ctx.recentChanges(a.limit ?? 10);
    const mine = ctx.client?.id || null;
    // The user's own changes (an Undo in Connect AI) are recorded as "You", which an assistant would
    // read as itself: they are "the user" here.
    const byUser = (r) => !r.clientId || r.kind === 'user';
    const changes = list.map((r) => ({
      change_id: r.changeId,
      at: localStamp(r.at),
      by: byUser(r) ? 'the user' : r.label,
      ...(mine && r.clientId === mine ? { this_connection: true } : {}),
      tool: r.tool,
      summary: r.summary,
      undone: !!r.undoneBy,
      undoable: !r.undoneBy && !!r.undoable,
      undo_of: r.undoOf || null,
    }));
    // A connection's label is the user's text: quoted, so it can't pass for "the user" or a field.
    const who = (r, ch) => (byUser(r) ? 'the user' : `${q(ch.by)}${ch.this_connection ? ' (this connection)' : ''}`);
    const lines = [todayLine(ctx.clock), `Recent changes: ${changes.length}.`];
    changes.forEach((ch, i) => lines.push(`- ${ch.at.replace('T', ' ')} ${who(list[i], ch)} ${ch.tool}: ${ch.summary}${ch.undone ? ' (undone)' : ch.undoable ? '' : ' (cannot be undone)'} change_id=${ch.change_id}`));
    return { text: lines.join('\n'), data: { changes }, summary: 'Looked at recent changes' };
  },
};

// ---------------------------------------------------------------- task writes

function ensureListByName(tx, name) {
  const lists = tx.all('lists');
  const hit = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const used = new Set(lists.map((l) => l.color));
  const now = Date.now();
  return tx.put('lists', { id: uid(), name: cap(name, 60), color: COLORS.find((x) => !used.has(x)) || COLORS[lists.length % COLORS.length], icon: '', order: lists.length, createdAt: now, updatedAt: now }).id;
}

const TASK_FIELDS = {
  text: str('Natural-language quick add, e.g. "Call mom tomorrow 6pm for 20m #Personal p1 @phone every friday" or "Prep slides dec 3-5" (date Dec 3, deadline Dec 5). Explicit fields override what it implies', { maxLength: 1000 }),
  title: str('Task title', { maxLength: 500 }),
  notes: str('Notes (plain text)', { maxLength: 20000 }),
  list: ref('List id or name (default Inbox)'),
  date: when(`Planned day. ${DATE_D}`),
  time: when(`${TIME_D}; with a duration it becomes a time block on the calendar`),
  duration_minutes: int('Length in minutes', 1, 1440),
  deadline: when(`Hard deadline. ${DATE_D}`),
  priority: PRIORITY,
  labels: arr(LABEL, 'Labels (without @)', { maxItems: 20 }),
  repeat: repeat(['string', 'object'], '; a task repeats until its repeat is removed (no COUNT or UNTIL)'),
  steps: arr(STEP, 'Checklist steps', { maxItems: 100 }),
};

const createTasks = {
  name: 'create_tasks',
  title: 'Create tasks',
  description:
    'Add one or more tasks (up to 50). Give a title plus fields, or a natural-language "text" per task. Returns ids and the resolved dates.',
  // Added to the description only while notes_send_to_tasks is listed too (toolDefinition).
  alongside: {
    notes_send_to_tasks: 'For follow-ups that belong in a note (meeting action items), add them to the note as checklist items and call notes_send_to_tasks instead; not both.',
  },
  inputSchema: obj(
    {
      tasks: arr(obj(TASK_FIELDS), 'Tasks to create', { minItems: 1, maxItems: 50 }),
      allow_duplicates: bool('Create even if an identical open task was added in the last 10 minutes (default false)'),
    },
    ['tasks'],
  ),
  outputSchema: looseOut({ created: { type: 'array' }, failed: { type: 'array' } }, ['created', 'failed']),
  annotations: ann('Create tasks', 'add'),
  write: true,
  run(a, ctx) {
    const { clock: c, tx } = ctx;
    const created = [];
    const failed = [];
    let order = nextTaskOrder(tx);
    a.tasks.forEach((item, index) => {
      try {
        const f = { title: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null };
        const fromText = { date: false, deadline: false }; // which of the two the text gave
        if (has(item, 'text')) {
          const text = String(item.text).slice(0, 1000);
          // A date range is read whole: "dec 3-5" is planned for Dec 3 and due Dec 5 (date and deadline).
          const p = nlpParse(text, { mode: 'task', now: c.now, lists: tx.all('lists'), hour12: ctx.hour12, ranges: true });
          // "every 100 days" is an error for this task, not a task that never repeats.
          if (!has(item, 'repeat')) checkNlpRejectedRepeat(p, 'text');
          Object.assign(f, {
            title: p.title,
            // The phrase parser's dates are checked here; a bad one would otherwise be dropped silently on save.
            date: p.date && !has(item, 'date') ? checkNlpDate(p.date, text, c, 'text') : null,
            time: p.time && !has(item, 'time') ? checkNlpTime(p.time, text, 'text') : null,
            duration: p.duration,
            deadline: p.deadline && !has(item, 'deadline') ? checkNlpDate(p.deadline, text, c, 'text') : null,
            priority: p.priority,
            tags: p.tags,
            listId: p.listId,
            repeat: has(item, 'repeat') ? null : checkNlpRepeat(p.repeat, text, 'text'),
          });
          fromText.date = !!f.date;
          fromText.deadline = !!f.deadline;
          if (p.newList && !has(item, 'list')) f.listId = ensureListByName(tx, p.newList);
        }
        if (has(item, 'title')) f.title = item.title;
        f.title = cap(f.title, 500).trim();
        if (!f.title) fail('title is required (or a "text" that contains one).');
        if (has(item, 'list')) f.listId = resolveList(tx, item.list);
        if (has(item, 'date')) f.date = parseDate(item.date, c);
        if (has(item, 'time')) f.time = parseTime(item.time, c, 'time', ctx.hour12);
        if (has(item, 'duration_minutes')) f.duration = parseDuration(item.duration_minutes);
        if (has(item, 'deadline')) f.deadline = parseDate(item.deadline, c, 'deadline');
        // An explicit date or deadline overrides only its own end of what the text says ("dec 3-5" is
        // planned Dec 3 and due Dec 5; "by fri" a deadline). When the end the text still gives lands on
        // the wrong side of it, the assistant decides: nothing is saved with a deadline before its
        // planned day that nobody asked for. (Both sent as fields: kept as sent.)
        if (f.date && f.deadline && f.deadline < f.date && fromText.date !== fromText.deadline) {
          const said = q(cap(item.text, 60));
          fail(
            fromText.deadline
              ? `text ${said} gives the deadline ${f.deadline}, before date ${f.date}. Send deadline too (the one you mean), or leave the dates out of text.`
              : `text ${said} gives the date ${f.date}, after deadline ${f.deadline}. Send date too (the one you mean), or leave the dates out of text.`,
          );
        }
        if (has(item, 'priority')) f.priority = parsePriority(item.priority);
        if (has(item, 'labels')) f.tags = parseLabels(item.labels);
        if (f.time && !f.date) f.date = c.today;
        if (has(item, 'repeat')) {
          const r = parseRepeat(item.repeat, c, f.date, { canEnd: false });
          f.repeat = r.rule;
        }
        if (f.repeat && !f.date && !f.deadline) f.date = firstOnOrAfter(f.repeat, c.today);
        const checklist = (item.steps || []).map((s) => ({ id: uid(), title: cap(s, 500), done: false })).filter((s) => s.title.trim());
        if (!a.allow_duplicates) {
          const dup = tx.all('tasks').find(
            (t) => !t.done && t.title.toLowerCase() === f.title.toLowerCase() && (t.date || null) === f.date && (t.listId || null) === f.listId && Date.now() - (t.createdAt || 0) < 10 * 60 * 1000,
          );
          if (dup) fail(`An identical task was just added (id=${dup.id}). Set allow_duplicates:true to add it again.`);
        }
        const t = tx.put('tasks', newTask({ ...f, notes: has(item, 'notes') ? cap(item.notes, 20000) : '', checklist, order: order++ }));
        created.push(t);
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        failed.push({ index, title: cap(item.title || item.text || '', 80), error: err.message });
      }
    });
    if (!created.length) fail(`No tasks created. ${failed.map((x) => `Task ${x.index + 1}: ${x.error}`).join(' ')}`);
    const lines = [`Created ${created.length}/${a.tasks.length} tasks:`];
    for (const t of created) lines.push(`- ${taskLine(tx, t, c)}`);
    if (failed.length) {
      lines.push(`Failed (${failed.length}); fix and retry only these:`);
      for (const x of failed) lines.push(`- task ${x.index + 1}${x.title ? ` ${q(x.title)}` : ''}: ${x.error}`);
    }
    return {
      text: lines.join('\n'),
      data: { created: created.map((t) => taskView(tx, t, c)), failed },
      summary: created.length === 1 ? `Added task ${q(created[0].title)}` : `Added ${created.length} tasks: ${created.slice(0, 3).map((t) => q(t.title)).join(', ')}${created.length > 3 ? ', ...' : ''}`,
    };
  },
};

const updateTasks = {
  name: 'update_tasks',
  title: 'Update tasks',
  description:
    'Change fields on existing tasks (up to 25). Send only the fields that change; null clears a field. Setting date on a repeating task moves only this occurrence; change repeat only when the user asks.',
  inputSchema: obj(
    {
      tasks: arr(
        obj(
          {
            task_id: ref('Task id', { minLength: 1 }),
            title: str('New title', { maxLength: 500 }),
            notes: nullable(str('New notes (replaces the old notes)', { maxLength: 20000 })),
            list: nullable(ref('Move to this list (id or name); null or "inbox" for Inbox')),
            date: nullable(when(`Planned day. ${DATE_D}; null removes the date`)),
            time: nullable(when(`${TIME_D}; null removes the time`)),
            duration_minutes: nullable(int('Length in minutes; null clears', 1, 1440)),
            deadline: nullable(when(`Deadline. ${DATE_D}; null clears`)),
            priority: PRIORITY,
            labels: nullable(arr(LABEL, 'Replace all labels; null removes them', { maxItems: 20 })),
            add_labels: arr(LABEL, 'Labels to add', { maxItems: 20 }),
            remove_labels: arr(LABEL, 'Labels to remove', { maxItems: 20 }),
            repeat: repeat(['string', 'object', 'null'], '; null stops repeating (a task has no COUNT or UNTIL)'),
            add_steps: arr(STEP, 'Steps to append', { maxItems: 100 }),
            update_steps: arr(obj({ step_id: ref('Step id from get_task'), title: STEP, done: bool('Checked') }, ['step_id']), 'Steps to change', { maxItems: 200 }),
            remove_step_ids: arr(ref('Step id'), 'Steps to remove', { maxItems: 200 }),
          },
          ['task_id'],
        ),
        'Task changes',
        { minItems: 1, maxItems: 25 },
      ),
    },
    ['tasks'],
  ),
  outputSchema: looseOut({ updated: { type: 'array' }, failed: { type: 'array' } }, ['updated', 'failed']),
  // Not idempotent: add_steps appends its steps again on every call (a retry would duplicate them).
  annotations: ann('Update tasks', 'once'),
  write: true,
  run(a, ctx) {
    const { clock: c, tx } = ctx;
    const updated = [];
    const failed = [];
    a.tasks.forEach((u, index) => {
      try {
        const t = findTask(tx, u.task_id);
        const n = structuredClone(t);
        const changed = [];
        const set = (k, v, label = k) => {
          if (JSON.stringify(n[k] ?? null) !== JSON.stringify(v ?? null)) changed.push(label);
          n[k] = v;
        };
        if (has(u, 'title')) {
          const title = cap(u.title, 500).trim();
          if (!title) fail('title must not be empty.');
          set('title', title);
        }
        if (has(u, 'notes')) set('notes', u.notes === null ? '' : cap(u.notes, 20000));
        if (has(u, 'list')) set('listId', resolveList(tx, u.list), 'list');
        if (has(u, 'date')) {
          set('date', u.date === null ? null : parseDate(u.date, c));
          if (u.date === null && !has(u, 'time')) set('time', null);
        }
        if (has(u, 'time')) {
          set('time', u.time === null ? null : parseTime(u.time, c, 'time', ctx.hour12));
          if (n.time && !n.date) set('date', c.today);
        }
        if (has(u, 'duration_minutes')) set('duration', u.duration_minutes === null ? null : parseDuration(u.duration_minutes), 'duration');
        if (has(u, 'deadline')) set('deadline', u.deadline === null ? null : parseDate(u.deadline, c, 'deadline'));
        if (has(u, 'priority')) set('priority', parsePriority(u.priority));
        let tags = [...(n.tags || [])];
        if (has(u, 'labels')) tags = u.labels === null ? [] : parseLabels(u.labels);
        if (u.add_labels) for (const g of parseLabels(u.add_labels, 'add_labels')) if (!tags.includes(g)) tags.push(g);
        if (u.remove_labels) {
          const rm = parseLabels(u.remove_labels, 'remove_labels');
          tags = tags.filter((g) => !rm.includes(g));
        }
        if (tags.length > 20) fail('At most 20 labels per task.');
        set('tags', tags, 'labels');
        if (has(u, 'repeat')) {
          const r = parseRepeat(u.repeat, c, n.date || n.deadline || c.today, { canEnd: false });
          set('repeat', r.rule);
          if (r.rule && !n.date && !n.deadline) set('date', firstOnOrAfter(r.rule, c.today));
        }
        let steps = structuredClone(n.checklist || []);
        for (const s of u.update_steps || []) {
          const st = steps.find((x) => x.id === s.step_id);
          if (!st) fail(`No step with id "${cap(s.step_id, 40)}" on task ${q(t.title)}. Use get_task to see step ids.`);
          if (has(s, 'title')) {
            if (!cap(s.title, 500).trim()) fail('step title must not be empty.');
            st.title = cap(s.title, 500);
          }
          if (has(s, 'done')) st.done = !!s.done;
        }
        if (u.remove_step_ids?.length) {
          const unknown = u.remove_step_ids.filter((id) => !steps.some((s) => s.id === id));
          if (unknown.length) fail(`No step with id "${cap(unknown[0], 40)}" on task ${q(t.title)}.`);
          steps = steps.filter((s) => !u.remove_step_ids.includes(s.id));
        }
        for (const title of u.add_steps || []) if (cap(title, 500).trim()) steps.push({ id: uid(), title: cap(title, 500), done: false });
        if (steps.length > 200) fail('A task can have at most 200 steps.');
        set('checklist', steps, 'steps');
        if (!changed.length) {
          updated.push({ t, changed });
          return;
        }
        n.updatedAt = Date.now();
        updated.push({ t: tx.put('tasks', n), changed });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        failed.push({ index, task_id: u.task_id, error: err.message });
      }
    });
    if (!updated.length) fail(`No tasks updated. ${failed.map((x) => `${x.task_id}: ${x.error}`).join(' ')}`);
    const lines = [`Updated ${updated.filter((x) => x.changed.length).length}/${a.tasks.length} tasks:`];
    for (const { t, changed } of updated) lines.push(`- ${taskLine(tx, t, c)}${changed.length ? ` (changed: ${changed.join(', ')})` : ' (no changes)'}`);
    for (const x of failed) lines.push(`- FAILED ${x.task_id}: ${x.error}`);
    return {
      text: lines.join('\n'),
      data: { updated: updated.map(({ t, changed }) => ({ ...taskView(tx, t, c), changed })), failed },
      summary: updated.length === 1 ? `Edited task ${q(updated[0].t.title)}` : `Edited ${updated.length} tasks`,
    };
  },
};

/** How long after a repeating task was completed "reopen it" still takes that completion back. */
const REOPEN_WINDOW_MS = 2 * 86400000;

/**
 * Take back the latest completion of repeating task `t` (open again on its next date, with a done copy
 * logged), when it was in the last two days: the task is due on the copy's date and deadline again,
 * its steps are checked as they were then (that completion unchecked them all; a step checked, added
 * or renamed since keeps that, and one removed since stays removed), any other edit made since stays,
 * and the copy goes. Each call takes back one completion. An older one is left as it is, and the
 * result says how to put it back by hand. → {reverted, back_on, removed_completion} |
 * {last_completed, completed_copy_id, next, was} | null (never completed).
 */
function reopenRepeating(tx, t) {
  let copy = null;
  for (const x of tx.all('tasks')) if (x.repeatOf === t.id && x.done && x.completedAt && (!copy || x.completedAt > copy.completedAt)) copy = x;
  if (!copy) return null;
  if (Date.now() - copy.completedAt <= REOPEN_WINDOW_MS) {
    const then = new Map((Array.isArray(copy.checklist) ? copy.checklist : []).filter(isPlainObject).map((s) => [s.id, s]));
    const checklist = (t.checklist || []).map((s) => (s.done || !then.has(s.id) ? s : { ...s, done: !!then.get(s.id).done }));
    tx.del('tasks', copy.id);
    const back = tx.put('tasks', { ...t, date: copy.date ?? null, deadline: copy.deadline ?? null, checklist, updatedAt: Date.now() });
    return { reverted: true, back_on: back.date || back.deadline || null, removed_completion: copy.id };
  }
  return { last_completed: localStamp(copy.completedAt), completed_copy_id: copy.id, next: t.date || t.deadline || null, was: { date: copy.date ?? null, deadline: copy.deadline ?? null } };
}

const completeTasks = {
  name: 'complete_tasks',
  title: 'Complete tasks',
  description:
    'Mark tasks done (or reopen them with done:false). A repeating task moves to its next date and a completed copy is logged; done:false on the task within 2 days takes its latest completion back (due again as before, steps as they were; other edits kept). Checklist items linked to the task in notes follow.',
  inputSchema: obj(
    { task_ids: arr(ref('Task id'), 'Tasks to complete', { minItems: 1, maxItems: 50 }), done: bool('true to complete (default), false to reopen') },
    ['task_ids'],
  ),
  outputSchema: looseOut({ results: { type: 'array' } }, ['results']),
  annotations: ann('Complete tasks', 'once'),
  write: true,
  run(a, ctx) {
    const { clock: c, tx } = ctx;
    const done = a.done !== false;
    const results = [];
    for (const id of a.task_ids) {
      const t = tx.get('tasks', id);
      if (!t) {
        results.push({ task_id: id, ok: false, error: 'not found' });
        continue;
      }
      if (done) {
        if (t.done) {
          results.push({ task_id: id, title: t.title, ok: true, note: 'already done' });
          continue;
        }
        const r = completeTask(tx, t, c);
        results.push({ task_id: id, title: t.title, ok: true, advanced_to: r.advancedTo || null });
      } else if (t.done) {
        tx.put('tasks', { ...t, done: false, completedAt: null, updatedAt: Date.now() });
        results.push({ task_id: id, title: t.title, ok: true, note: 'reopened' });
      } else {
        // An open repeating task may have just been completed: that logged a done copy and moved the
        // task on. "Not done after all" takes that completion back, while nothing changed the task since.
        const r = t.repeat ? reopenRepeating(tx, t) : null;
        results.push({ task_id: id, title: t.title, ok: true, note: r?.reverted ? 'reopened' : 'already open', ...(r || {}) });
      }
      const last = results.at(-1);
      if (last.note !== 'already done' && last.note !== 'already open') mirrorTaskChecks(ctx, id);
    }
    const ok = results.filter((r) => r.ok);
    if (!ok.length) fail(`No tasks changed: ${results.map((r) => `${r.task_id} ${r.error}`).join('; ')}. Use find_tasks to look up ids.`);
    const lines = [`${done ? 'Completed' : 'Reopened'} ${ok.filter((r) => !r.note || r.note === 'reopened').length}/${a.task_ids.length} tasks:`];
    for (const r of results) {
      if (!r.ok) lines.push(`- ${r.task_id}: ${r.error}`);
      else if (r.advanced_to) lines.push(`- ${q(r.title)} done; it repeats, so it now comes back on ${fmtDay(r.advanced_to)} (id=${r.task_id})`);
      else if (r.reverted) lines.push(`- ${q(r.title)} reopened: its completion was taken back, so it is due ${r.back_on ? fmtDay(r.back_on) : 'without a date'} again (id=${r.task_id})`);
      else if (r.last_completed) {
        // Not undo_change: it would take back the whole complete_tasks call, and leaves a task edited
        // since as it is. One id= per line, the task's own: the done copy is named as task_id, which a
        // model reading the line's id= can't take for the task.
        const back = r.was.date ? `date ${r.was.date}` : r.was.deadline ? `deadline ${r.was.deadline}` : 'date null';
        lines.push(
          `- ${q(r.title)} is already open: it repeats, and it is next due ${r.next ? fmtDay(r.next) : 'without a date'}. Its last completion (${r.last_completed.replace('T', ' ')}) is more than 2 days old, so it was not taken back; it is kept as a separate done task (task_id ${r.completed_copy_id}). To put the task back where it was, call update_tasks with ${back}; delete_items with that task_id removes the logged completion (id=${r.task_id})`,
        );
      } else lines.push(`- ${q(r.title)} ${r.note || (done ? 'done' : 'reopened')} (id=${r.task_id})`);
    }
    return {
      text: lines.join('\n'),
      data: { results },
      summary: ok.length === 1 ? `${done ? 'Completed' : 'Reopened'} ${q(ok[0].title)}` : `${done ? 'Completed' : 'Reopened'} ${ok.length} tasks`,
    };
  },
};

// ---------------------------------------------------------------- event writes

const EVENT_FIELDS = {
  text: str('Natural-language quick add, e.g. "Lunch with Sam fri 1-2pm at Cafe Luna #Work", "Standup 9:30 every weekday for 15m" or "Vacation dec 20-28" (all day over those days). Explicit fields override it', { maxLength: 1000 }),
  title: str('Event title', { maxLength: 500 }),
  start: when(`${DT_D}; or YYYY-MM-DD for an all-day event`),
  end: when('End (exclusive) as YYYY-MM-DDTHH:MM or HH:MM; for all-day events the last day YYYY-MM-DD'),
  duration_minutes: int('Length in minutes when end is not given (default from settings, usually 60)', 1, 20160),
  all_day: bool('All-day event'),
  date: when(`Day of an all-day event (or of a timed event when start is only a time). ${DATE_D}`),
  end_date: when('Last day of a multi-day all-day event (inclusive), YYYY-MM-DD'),
  calendar: ref('Calendar id or name (default: first calendar)'),
  location: str('Location', { maxLength: 500 }),
  notes: str('Notes (plain text)', { maxLength: 20000 }),
  repeat: repeat(['string', 'object']),
};

/** Work out start/end for an event from tool fields. `base` = current values when editing. */
function eventTimes(item, ctx, base = null) {
  const c = ctx.clock;
  let allDay = base ? base.allDay : false;
  let date = base ? base.start.slice(0, 10) : null;
  let time = base && !base.allDay ? base.start.slice(11, 16) : null;
  let minutes = base && !base.allDay ? wallMin(base.end) - wallMin(base.start) : null;
  let spanDays = base && base.allDay ? diffDays(base.start, base.end) : 0;
  let explicitEnd = null;
  if (has(item, 'start')) {
    if (timeOnly(item.start)) {
      time = parseTime(item.start, c, 'start', ctx.hour12);
      if (!date) date = has(item, 'date') ? parseDate(item.date, c) : c.today;
      if (!has(item, 'all_day')) allDay = false;
    } else {
      const w = parseWhen(item.start, c, 'start', ctx.hour12);
      date = w.date;
      if (w.time) {
        time = w.time;
        if (!has(item, 'all_day')) allDay = false;
      } else if (!has(item, 'all_day')) allDay = true;
    }
  }
  if (has(item, 'date')) date = parseDate(item.date, c);
  if (has(item, 'all_day')) allDay = !!item.all_day;
  if (!date) fail(`start (or date) is required. Use ${DT_D.split(' (')[0]}, e.g. ${addDaysYmd(c.today, 1)}T15:00.`);
  if (allDay) {
    let endDate = addDaysYmd(date, spanDays);
    if (has(item, 'end_date')) endDate = parseDate(item.end_date, c, 'end_date');
    else if (has(item, 'end')) endDate = parseWhen(item.end, c, 'end', ctx.hour12).date;
    if (endDate < date) fail(`end_date (${endDate}) is before the start (${date}). end_date is the last day, inclusive.`);
    if (diffDays(date, endDate) > 366) fail('An all-day event can span at most a year.');
    return { allDay: true, start: date, end: endDate };
  }
  if (!time) fail(`This event needs a start time. Use start like ${date}T09:00, or set all_day:true.`);
  const start = `${date}T${time}`;
  if (has(item, 'end')) {
    const e = String(item.end).trim();
    if (timeOnly(e)) {
      const et = parseTime(e, c, 'end', ctx.hour12);
      explicitEnd = `${date}T${et}`;
      if (explicitEnd <= start) explicitEnd = `${addDaysYmd(date, 1)}T${et}`; // 10pm-1am
    } else {
      const w = parseWhen(e, c, 'end', ctx.hour12);
      if (!w.time) fail('end needs a time for a timed event (YYYY-MM-DDTHH:MM or HH:MM).');
      explicitEnd = `${w.date}T${w.time}`;
    }
  } else if (has(item, 'duration_minutes')) minutes = parseDuration(item.duration_minutes, 'duration_minutes', 20160);
  if (!minutes) minutes = ctx.settings.defaultEventMinutes;
  const end = explicitEnd || addMinutesDT(start, minutes);
  if (end <= start) fail(`end (${end}) must be after start (${start}).`);
  if (wallMin(end) - wallMin(start) > 14 * 1440) fail('A timed event can be at most 14 days long; use all_day for longer spans.');
  return { allDay: false, start, end };
}

function conflictsFor(st, ev, ignoreIds = []) {
  if (ev.allDay) return [];
  return instancesBetween(st, ev.start.slice(0, 10), ev.end.slice(0, 10)).filter(
    (i) => !i.allDay && !ignoreIds.includes(i.event.id) && i.start < ev.end && i.end > ev.start,
  );
}

const createEvents = {
  name: 'create_events',
  title: 'Create events',
  description:
    'Add one or more calendar events (up to 25): timed (start + end or duration) or all-day, optionally repeating. Use find_free_time first when the time is flexible. Overlaps are reported as warnings.',
  inputSchema: obj(
    {
      events: arr(obj(EVENT_FIELDS), 'Events to create', { minItems: 1, maxItems: 25 }),
      allow_duplicates: bool('Create even when an event with the same title and start exists (default false)'),
    },
    ['events'],
  ),
  outputSchema: looseOut({ created: { type: 'array' }, failed: { type: 'array' }, warnings: { type: 'array' } }, ['created', 'failed']),
  annotations: ann('Create events', 'add'),
  write: true,
  run(a, ctx) {
    const { clock: c, tx } = ctx;
    const created = [];
    const failed = [];
    const warnings = [];
    a.events.forEach((item, index) => {
      try {
        const it = { ...item };
        let f = { title: '', calendarId: null, location: '', repeat: null };
        if (has(it, 'text')) {
          const text = String(it.text).slice(0, 1000);
          // A date range is read whole: "Vacation dec 20-28" is all day from Dec 20 to Dec 28, and
          // "Conference dec 3-5 9am-5pm" one event from Dec 3 09:00 to Dec 5 17:00 (p.duration).
          const p = nlpParse(text, { mode: 'event', now: c.now, calendars: tx.all('calendars'), hour12: ctx.hour12, ranges: true });
          // "every 100 days" is an error for this event, not a one-off event.
          if (!has(it, 'repeat')) checkNlpRejectedRepeat(p, 'text');
          f = { title: p.title, calendarId: p.calendarId, location: p.location || '', repeat: has(it, 'repeat') ? null : checkNlpRepeat(p.repeat, text, 'text') };
          if (p.date && !has(it, 'start') && !has(it, 'date')) {
            const date = checkNlpDate(p.date, text, c, 'text');
            if (p.allDay || !p.time) {
              it.start = date;
              if (p.endDate && p.endDate > date && !has(it, 'end') && !has(it, 'end_date')) it.end_date = checkNlpDate(p.endDate, text, c, 'text');
            } else {
              it.start = `${date}T${checkNlpTime(p.time, text, 'text')}`;
              if (!has(it, 'end') && !has(it, 'duration_minutes') && p.duration) it.duration_minutes = p.duration;
              // all_day:true makes "Conference dec 3-5 9am-5pm" all day over the same days, not on
              // Dec 3 alone (a timed event doesn't read end_date).
              if (p.endDate && p.endDate > date && it.all_day === true && !has(it, 'end') && !has(it, 'end_date')) it.end_date = checkNlpDate(p.endDate, text, c, 'text');
            }
          }
        }
        if (has(it, 'title')) f.title = it.title;
        const title = cap(f.title, 500).trim();
        if (!title) fail('title is required (or a "text" that contains one).');
        const times = eventTimes(it, ctx);
        const calendarId = resolveCalendar(tx, has(it, 'calendar') ? it.calendar : f.calendarId);
        let repeat = f.repeat ? { ...f.repeat } : null;
        let until = null;
        if (has(it, 'repeat')) {
          const r = parseRepeat(it.repeat, c, times.start.slice(0, 10));
          repeat = r.rule;
          if (r.until) until = r.until;
          if (r.count && repeat) until = untilForCount(repeat, times.start.slice(0, 10), r.count);
        }
        if (!a.allow_duplicates) {
          const dup = tx.all('events').find((e) => e.title.toLowerCase() === title.toLowerCase() && e.start === times.start && e.calendarId === calendarId);
          if (dup) fail(`An event ${q(title)} already starts at ${times.start} (id=${dup.id}). Set allow_duplicates:true to add another.`);
        }
        const now = Date.now();
        const ev = tx.put('events', {
          id: uid(),
          title,
          calendarId,
          allDay: times.allDay,
          start: times.start,
          end: times.end,
          location: has(it, 'location') ? cap(it.location, 500) : cap(f.location, 500),
          notes: has(it, 'notes') ? cap(it.notes, 20000) : '',
          repeat,
          exdates: [],
          until,
          createdAt: now,
          updatedAt: now,
        });
        created.push(ev);
        for (const o of conflictsFor(tx, ev, [ev.id]).slice(0, 3)) warnings.push(`${q(title)} overlaps ${q(o.event.title)} ${o.start.slice(11)}-${o.end.slice(11)} (id=${o.event.id})`);
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        failed.push({ index, title: cap(item.title || item.text || '', 80), error: err.message });
      }
    });
    if (!created.length) fail(`No events created. ${failed.map((x) => `Event ${x.index + 1}: ${x.error}`).join(' ')}`);
    const view = (e) => eventView({ event: e, occurrence: e.start.slice(0, 10), start: e.start, end: e.end, allDay: e.allDay, calendar: calendarName(tx, e.calendarId) });
    const lines = [`Created ${created.length}/${a.events.length} events:`];
    for (const e of created) lines.push(`- ${eventLine({ event: e, occurrence: e.start.slice(0, 10), start: e.start, end: e.end, allDay: e.allDay, calendar: calendarName(tx, e.calendarId) })}`);
    if (warnings.length) lines.push(`Warnings: ${warnings.join('; ')}`);
    if (failed.length) {
      lines.push(`Failed (${failed.length}); fix and retry only these:`);
      for (const x of failed) lines.push(`- event ${x.index + 1}${x.title ? ` ${q(x.title)}` : ''}: ${x.error}`);
    }
    return {
      text: lines.join('\n'),
      data: { created: created.map(view), failed, warnings },
      summary: created.length === 1 ? `Added event ${q(created[0].title)} on ${fmtDay(created[0].start.slice(0, 10))}` : `Added ${created.length} events`,
    };
  },
};

/**
 * A meeting note is linked to one occurrence: note.event = {id, date}. When update_event edits one
 * occurrence on its own (a copy with its own id), splits a series (a new series id) or moves days, the
 * links move with it in the same change, as the Schedule app moves them, so the Schedule card and the
 * Notes app still find the note, and undo_change puts them back with the event. Every note is followed
 * (hidden, locked and deleted ones too: they still belong to the event); results never mention them.
 * `linkFor(date)` → the new {id, date}, or null to leave that note as it is.
 */
function relinkNotes(ctx, fromId, linkFor, now) {
  // Without notes/core/schema.js a note can't be written without losing its blocks: leave them all.
  if (!fromId || ctx.notesSchema === false) return;
  for (const raw of ctx.tx.all('notes')) {
    const ev = raw?.event;
    if (!isPlainObject(ev) || ev.id !== fromId || !validYmd(ev.date)) continue;
    const link = linkFor(ev.date);
    if (!link?.id || !validYmd(link.date) || (link.id === ev.id && link.date === ev.date)) continue;
    // A record saved in an older form (an HTML body, no edit time) is written in today's form, with the
    // times it already had: only the link, rev and updatedAt differ, so the change is a link that moved.
    const n = typeof ctx.normalizeNote === 'function' ? ctx.normalizeNote(raw) || raw : raw;
    try {
      ctx.tx.put('notes', { ...n, event: { id: link.id, date: link.date }, rev: (Number.isInteger(n.rev) ? n.rev : 0) + 1, updatedAt: now });
    } catch {
      continue; // a note that no longer passes validation keeps its old link; the event still changes
    }
    // A note assistants can't see is stood in for by their own notes (server/tools-notes.mjs), shown
    // with its link: they get the same rev bump, so the move reads the same either way.
    try {
      notesRelinked?.(ctx.tx, raw, now);
    } catch {}
  }
}

/** Separately edited occurrences of series `seriesId` (on or after `from`): their original day → a link to the copy. */
function copyLinks(tx, seriesId, from = null) {
  const out = new Map();
  for (const x of tx.all('events')) {
    if (x.seriesId !== seriesId || x.repeat || !validYmd(x.occurrence) || (from && x.occurrence < from)) continue;
    out.set(x.occurrence, { id: x.id, date: x.start.slice(0, 10) });
  }
  return out;
}

const updateEvent = {
  name: 'update_event',
  title: 'Update event',
  description:
    'Change an event. For a repeating event always pass occurrence (YYYY-MM-DD, the day to change) and scope: "this" (only that day), "following" (that day and later) or "all" (every occurrence). To change only the time of every occurrence, send start as HH:MM with scope "all". To end a series from a day on, use delete_items with scope "following". Send only changed fields; sending only start keeps the length.',
  inputSchema: obj(
    {
      event_id: ref('Event id', { minLength: 1 }),
      occurrence: when('Occurrence date YYYY-MM-DD: the day of a repeating event to change'),
      scope: str('this, following or all (default: this when occurrence is given, else all)', { enum: ['this', 'following', 'all'] }),
      title: str('New title', { maxLength: 500 }),
      start: when(`New start: ${DT_D}, HH:MM (same day), or YYYY-MM-DD (all-day)`),
      end: when('New end: YYYY-MM-DDTHH:MM or HH:MM; for all-day the last day'),
      duration_minutes: int('New length in minutes', 1, 20160),
      all_day: bool('Make it all-day (true) or timed (false)'),
      date: when(`Move to this day, keeping the time. ${DATE_D}`),
      end_date: when('Last day of an all-day event (inclusive)'),
      calendar: ref('Move to this calendar (id or name)'),
      location: nullable(str('Location; null clears', { maxLength: 500 })),
      notes: nullable(str('Notes; null clears', { maxLength: 20000 })),
      repeat: repeat(['string', 'object', 'null'], '; null makes it a single event (scope all/following). To end a series from a day on, use delete_items with scope "following" instead'),
    },
    ['event_id'],
  ),
  outputSchema: looseOut({ event: { type: 'object' }, scope: { type: 'string' } }, ['event']),
  annotations: ann('Update event', 'once'),
  write: true,
  run(a, ctx) {
    const { clock: c, tx } = ctx;
    const e = findEvent(tx, a.event_id);
    const seriesStart = e.start.slice(0, 10);
    let scope = a.scope || (e.repeat && a.occurrence ? 'this' : 'all');
    let occ = null;
    if (a.occurrence) {
      occ = parseDate(a.occurrence, c, 'occurrence');
      if (!isOccurrence(e, occ)) fail(`${fmtDay(occ)} is not an occurrence of ${q(e.title)}. ${nearbyOccurrences(e, occ)}`);
    }
    if (!e.repeat) scope = 'all';
    // A repeating series edited without saying which day: a start, date or end with a calendar date is
    // measured from the series' first occurrence, so the whole series moves there. For a series that
    // has not begun (no occurrence today or earlier) that is what it says: the date is its new first
    // day (the result says what moved). For one that has, its occurrences so far (and their meeting
    // notes) would leave the calendar, and the date usually means a coming day: without a scope that
    // is refused; with scope "all" the date must be an occurrence, and only says which day's times are
    // meant (the series keeps its days).
    if (e.repeat && !occ && pastOccurrences(e, addDaysYmd(c.today, 1)) > 0) {
      const day = has(a, 'date') ? parseDate(a.date, c) : has(a, 'start') && !timeOnly(a.start) ? parseWhen(a.start, c, 'start', ctx.hour12).date : null;
      if (day || has(a, 'end_date') || (has(a, 'end') && !timeOnly(a.end))) {
        const near = nearbyOccurrences(e, day || c.today);
        if (!a.scope) {
          const example = (day && isOccurrence(e, day) ? day : nextOccurrence(e, c.today)) || seriesStart;
          fail(`${q(e.title)} repeats (since ${fmtDay(seriesStart)}). Pass occurrence (the day to change, e.g. ${example}) and scope "this" (only that day), "following" (that day and later) or "all"; to change only the time of every occurrence, send start as HH:MM with scope "all". ${near}`);
        }
        if (scope === 'all') {
          if (!day || !isOccurrence(e, day)) {
            fail(`${day ? `${fmtDay(day)} is not an occurrence of ${q(e.title)}` : `${q(e.title)} repeats`}, so it can't say which day of the series to change. To change only the time of every occurrence, send start as HH:MM with scope "all"; to move the series to other days, pass occurrence (a day it happens now) with the new start or date. ${near}`);
          }
          occ = day;
        }
      }
    }
    if (e.repeat && scope !== 'all' && !occ) fail(`${q(e.title)} repeats; pass occurrence (YYYY-MM-DD) with scope "${scope}". ${nearbyOccurrences(e, c.today)}`);
    if (scope === 'this' && has(a, 'repeat')) fail('repeat can only change with scope "all" or "following".');
    if (scope === 'following' && occ === seriesStart) scope = 'all';

    const anchor = occ || seriesStart;
    const shift = diffDays(seriesStart, anchor);
    const base = { allDay: !!e.allDay, start: shiftDate(e.start, shift), end: shiftDate(e.end, shift) };
    const touchesTime = ['start', 'end', 'duration_minutes', 'all_day', 'date', 'end_date'].some((k) => has(a, k));
    const times = touchesTime ? eventTimes(a, ctx, base) : base;
    const delta = diffDays(base.start.slice(0, 10), times.start.slice(0, 10));
    const patch = { allDay: times.allDay };
    if (has(a, 'title')) {
      patch.title = cap(a.title, 500).trim();
      if (!patch.title) fail('title must not be empty.');
    }
    if (has(a, 'calendar')) patch.calendarId = resolveCalendar(tx, a.calendar);
    if (has(a, 'location')) patch.location = a.location === null ? '' : cap(a.location, 500);
    if (has(a, 'notes')) patch.notes = a.notes === null ? '' : cap(a.notes, 20000);
    let repeatPatch;
    let untilPatch;
    if (has(a, 'repeat')) {
      const r = parseRepeat(a.repeat, c, times.start.slice(0, 10));
      repeatPatch = r.rule;
      if (r.until) untilPatch = r.until;
      if (r.count && r.rule) untilPatch = untilForCount(r.rule, times.start.slice(0, 10), r.count);
    }
    const now = Date.now();
    let result;
    let scopeText;
    let lostNote = null;
    if (scope === 'this') {
      tx.put('events', { ...e, exdates: [...new Set([...(e.exdates || []), occ])].sort(), updatedAt: now });
      // `occurrence` is the day it replaces in the series (the Schedule app finds the series' note through it).
      result = tx.put('events', { ...e, ...patch, id: uid(), start: times.start, end: times.end, repeat: null, exdates: [], until: null, seriesId: e.id, occurrence: occ, createdAt: now, updatedAt: now });
      // That day's meeting notes go with the copy.
      relinkNotes(ctx, e.id, (d) => (d === occ ? { id: result.id, date: result.start.slice(0, 10) } : null), now);
      scopeText = `only ${fmtDay(occ)} (now a separate event)`;
    } else if (scope === 'following') {
      const oldUntil = e.until;
      tx.put('events', { ...e, until: addDaysYmd(occ, -1), updatedAt: now });
      const rule = repeatPatch !== undefined ? repeatPatch : shiftRule(e.repeat, occ, addDaysYmd(occ, delta));
      result = tx.put('events', {
        ...e,
        ...patch,
        id: uid(),
        start: times.start,
        end: times.end,
        repeat: rule,
        exdates: rule ? (e.exdates || []).filter((x) => x >= occ).map((x) => addDaysYmd(x, delta)) : [],
        until: !rule ? null : untilPatch !== undefined ? untilPatch : oldUntil ? addDaysYmd(oldUntil, delta) : null,
        createdAt: now,
        updatedAt: now,
      });
      // Occurrences edited on their own from the split on now belong to the new series (as in the
      // Schedule app), and the notes of those days follow: to the edited copy of a day when there is
      // one, else to the same occurrence of the new series.
      const copies = copyLinks(tx, e.id, occ);
      for (const x of tx.all('events')) {
        if (x.seriesId === e.id && !x.repeat && x.id !== result.id && (x.occurrence ?? x.start.slice(0, 10)) >= occ) tx.put('events', { ...x, seriesId: result.id, updatedAt: now });
      }
      relinkNotes(ctx, e.id, (d) => (d < occ ? null : copies.get(d) || { id: result.id, date: addDaysYmd(d, delta) }), now);
      scopeText = `${fmtDay(occ)} and later (split into a new series)`;
    } else {
      // Whole series: move the series start by the same amount the chosen occurrence moved.
      const newSeriesStart = e.repeat ? addDaysYmd(seriesStart, delta) : times.start.slice(0, 10);
      const start = e.repeat ? `${newSeriesStart}${times.start.slice(10)}` : times.start;
      const end = e.repeat ? shiftDate(times.end, -shift) : times.end;
      const rule = repeatPatch !== undefined ? repeatPatch : e.repeat ? shiftRule(e.repeat, seriesStart, newSeriesStart) : null;
      // An occurrence edited on its own that gets a repeat of its own becomes a series of its own.
      const ownSeries = !e.repeat && !!rule && !!e.seriesId;
      result = tx.put('events', {
        ...e,
        ...patch,
        start,
        end,
        repeat: rule,
        exdates: rule ? (e.exdates || []).map((x) => addDaysYmd(x, delta)) : [],
        until: !rule ? null : untilPatch !== undefined ? untilPatch : e.until ? addDaysYmd(e.until, delta) : null,
        ...(ownSeries ? { seriesId: undefined, occurrence: undefined } : {}),
        updatedAt: now,
      });
      // The notes move by the days the series (or the single event) moved; a note of a day that was
      // edited on its own goes to that edited copy, as in the Schedule app.
      const dayShift = diffDays(seriesStart, newSeriesStart);
      if (dayShift) {
        const copies = e.repeat ? copyLinks(tx, e.id) : new Map();
        relinkNotes(ctx, e.id, (d) => copies.get(d) || { id: e.id, date: addDaysYmd(d, dayShift) }, now);
      }
      // Notes found through the series it leaves now belong to it.
      if (ownSeries && validYmd(e.occurrence)) relinkNotes(ctx, e.seriesId, (d) => (d === e.occurrence ? { id: e.id, date: result.start.slice(0, 10) } : null), now);
      scopeText = e.repeat ? 'every occurrence' : null;
      // A series whose days moved: say where it starts now and which of its days it no longer has. The
      // meeting notes went along; that is said the same way whatever notes there are, so the text
      // never tells of notes hidden from assistants.
      if (e.repeat && dayShift) {
        const dropped = dayShift > 0 ? occurrencesBetween(e.repeat, seriesStart, seriesStart, addDaysYmd(newSeriesStart, -1), { exdates: e.exdates || [], until: e.until || null }).length : 0;
        lostNote =
          `Its days moved: the series now starts ${fmtDay(newSeriesStart)} (it started ${fmtDay(seriesStart)})` +
          (dropped ? `, so ${plural(dropped, 'occurrence')} from ${fmtDay(seriesStart)} to ${fmtDay(addDaysYmd(newSeriesStart, -1))} ${dropped === 1 ? 'is' : 'are'} no longer on the calendar` : '') +
          (result.until && result.until !== e.until ? `; it now ends ${fmtDay(result.until)}` : '') +
          '; meeting notes of its days moved with them. If that was not meant (to change one day, pass occurrence and scope "this"), undo_change puts it back.';
      }
    }
    // The day shown: the occurrence that was edited, or (a whole series edited without one) its next
    // occurrence from today, not its first day.
    const occView =
      scope === 'all' && e.repeat
        ? occ
          ? addDaysYmd(anchor, delta)
          : nextOccurrence(result, c.today) || result.start.slice(0, 10)
        : result.start.slice(0, 10);
    const sh = diffDays(result.start.slice(0, 10), occView);
    const inst = { event: result, occurrence: occView, start: shiftDate(result.start, sh), end: shiftDate(result.end, sh), allDay: !!result.allDay, calendar: calendarName(tx, result.calendarId) };
    const warn = conflictsFor(tx, inst, [result.id, e.id]).slice(0, 3);
    const lines = [`Updated ${q(result.title)}${scopeText ? ` for ${scopeText}` : ''}:`, `- ${eventLine(inst)}`];
    if (lostNote) lines.push(lostNote);
    if (warn.length) lines.push(`Warnings: overlaps ${warn.map((o) => `${q(o.event.title)} ${o.start.slice(11)}-${o.end.slice(11)}`).join(', ')}`);
    return { text: lines.join('\n'), data: { event: eventView(inst, { detailed: true }), scope }, summary: `Edited event ${q(result.title)}` };
  },
};

// ---------------------------------------------------------------- planning

const PLAN_ITEMS = arr(
  obj({ task_id: ref('Task id', { minLength: 1 }), start: when(`Exact start (${DT_D}); omit to let ecosys pick a free slot`), duration_minutes: int('Block length (default: the task\'s duration, else the default task length)', 5, 720) }, ['task_id']),
  'Tasks to place, in priority order',
  { minItems: 1, maxItems: 25 },
);
const PLAN_FIELDS = {
  from: when(`Search window start (default now). ${DATE_D}, or ${DT_D}`),
  to: when('Search window end (default 7 days later); a date is inclusive'),
  working_hours: WORKING_HOURS,
  exclude_weekends: bool('Skip Saturday and Sunday (default true)'),
  spread: bool('false (default): each task goes into the earliest free slot; true: each goes on the day of the window with the most free time left ("plan my week")'),
};

/**
 * The free slot for a task of `duration` minutes in window `r`: the earliest one, or with `spread` the
 * earliest one on the day with the most free working time left (ties: the earlier day). Null when none.
 */
function pickSlot(busy, r, wh, duration, { excludeWeekends, spread }) {
  const opts = { workStart: wh.start, workEnd: wh.end, excludeWeekends };
  if (!spread) return freeSlots(busy, r.fromDT, r.toDT, { ...opts, duration, max: 1 })[0] || null;
  let best = null;
  let bestFree = -1;
  for (let d = r.fromYmd, guard = 0; d <= r.toYmd && guard < 400; d = addDaysYmd(d, 1), guard++) {
    const from = `${d}T00:00` < r.fromDT ? r.fromDT : `${d}T00:00`;
    const to = `${addDaysYmd(d, 1)}T00:00` > r.toDT ? r.toDT : `${addDaysYmd(d, 1)}T00:00`;
    if (to <= from) continue;
    const slot = freeSlots(busy, from, to, { ...opts, duration, max: 1 })[0];
    if (!slot) continue;
    const free = freeSlots(busy, from, to, { ...opts, duration: 1, max: 100 }).reduce((n, x) => n + x.minutes, 0);
    if (free > bestFree) {
      best = slot;
      bestFree = free;
    }
  }
  return best;
}

/**
 * Work out time blocks for the tasks in `a.items` (plan_tasks, schedule_tasks): each without a start
 * gets a free slot in working hours (pickSlot), and later tasks see the blocks given to earlier ones.
 * With `apply` the tasks get those dates, times and durations (ctx.tx); otherwise nothing changes.
 */
function planBlocks(a, ctx, apply) {
  const c = ctx.clock;
  const st = ctx.tx || ctx.state;
  const r = rangeArgs(a, ctx, { maxDays: 62, clampToNow: true });
  const wh = workingHours(a, ctx);
  const ids = a.items.map((i) => i.task_id);
  let busy = busyIntervals(st, r.fromDT, r.toDT, { ignoreTaskIds: ids, defaultTaskMinutes: ctx.settings.defaultTaskMinutes });
  const placements = [];
  const failed = [];
  for (const item of a.items) {
    try {
      const t = findTask(st, item.task_id);
      if (t.done) fail(`${q(t.title)} is already done.`);
      const duration = item.duration_minutes ?? t.duration ?? ctx.settings.defaultTaskMinutes;
      let start;
      let note = null;
      if (has(item, 'start')) {
        const w = parseWhen(item.start, c, 'start', ctx.hour12);
        if (!w.time) fail(`start for ${q(t.title)} needs a time (YYYY-MM-DDTHH:MM).`);
        start = `${w.date}T${w.time}`;
        const s = wallMin(start);
        if (busy.some(([x, y]) => x < s + duration && y > s)) note = 'overlaps something already scheduled';
      } else {
        const slot = pickSlot(busy, r, wh, duration, { excludeWeekends: a.exclude_weekends !== false, spread: a.spread === true });
        if (!slot) fail(`No free ${fmtMinutes(duration)} slot for ${q(t.title)} between ${r.fromDT.replace('T', ' ')} and ${r.toDT.replace('T', ' ')} in working hours ${wh.start}-${wh.end}. Widen the window, use exclude_weekends:false, or give a start.`);
        start = slot.start;
      }
      const s = wallMin(start);
      busy = mergeIntervals([...busy, [s, s + duration]]);
      placements.push({ task_id: t.id, title: t.title, date: start.slice(0, 10), time: start.slice(11), duration_minutes: duration, end: fromWallMin(s + duration), note });
      if (apply) ctx.tx.put('tasks', { ...t, date: start.slice(0, 10), time: start.slice(11), duration, updatedAt: Date.now() });
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      failed.push({ task_id: item.task_id, error: err.message });
    }
  }
  if (!placements.length) fail(`Nothing could be scheduled. ${failed.map((x) => x.error).join(' ')}`);
  const lines = [];
  for (const p of placements) lines.push(`- ${q(p.title)}: ${fmtDay(p.date)} ${p.time}-${p.end.slice(11)} (${fmtMinutes(p.duration_minutes)})${p.note ? ` [${p.note}]` : ''} id=${p.task_id}`);
  for (const x of failed) lines.push(`- FAILED ${x.task_id}: ${x.error}`);
  return { placements, failed, lines };
}

const planTasks = {
  name: 'plan_tasks',
  title: 'Plan tasks',
  // Names no write tool (see find_changes): a session that can apply the proposal is told how by the
  // instructions, schedule_tasks' own description and this tool's result.
  description:
    'Propose time blocks for tasks in free calendar slots (or at given start times) without changing anything. Items without a start go into the earliest free slot in working hours; spread:true puts each on the day with the most free time left instead ("plan my week").',
  inputSchema: obj({ items: PLAN_ITEMS, ...PLAN_FIELDS }, ['items']),
  outputSchema: looseOut({ dry_run: { type: 'boolean' }, placements: { type: 'array' }, failed: { type: 'array' } }, ['dry_run', 'placements']),
  annotations: ann('Plan tasks', 'read'),
  write: false,
  run(a, ctx) {
    const { placements, failed, lines } = planBlocks(a, ctx, false);
    lines.unshift('Proposed time blocks (nothing changed):');
    if (offers(ctx, 'schedule_tasks')) lines.push('To apply, call schedule_tasks with the same items and options and dry_run:false.');
    return { text: lines.join('\n'), data: { dry_run: true, placements, failed }, summary: `Planned time blocks for ${plural(placements.length, 'task')}` };
  },
};

const scheduleTasks = {
  name: 'schedule_tasks',
  title: 'Schedule tasks',
  description:
    'Time-block tasks into free calendar slots (or at given start times) by setting their date, time and duration. dry_run defaults to true: it returns a proposal and changes nothing (plan_tasks does the same without asking for approval). Call with dry_run:false to apply. Items without a start go into the earliest free slot; spread:true puts each on the day with the most free time left instead.',
  inputSchema: obj({ items: PLAN_ITEMS, dry_run: bool('true (default): only propose; false: apply'), ...PLAN_FIELDS }, ['items']),
  outputSchema: looseOut({ dry_run: { type: 'boolean' }, placements: { type: 'array' }, failed: { type: 'array' } }, ['dry_run', 'placements']),
  annotations: ann('Schedule tasks', 'plan'),
  write: true,
  run(a, ctx) {
    const dry = a.dry_run !== false;
    const { placements, failed, lines } = planBlocks(a, ctx, !dry);
    lines.unshift(dry ? 'Proposed time blocks (nothing changed yet):' : `Scheduled ${placements.length} tasks:`);
    if (dry) lines.push('To apply, call schedule_tasks again with the same items and dry_run:false (or pass explicit start times).');
    return {
      text: lines.join('\n'),
      data: { dry_run: dry, placements, failed },
      summary: dry ? `Planned time blocks for ${plural(placements.length, 'task')}` : `Time-blocked ${plural(placements.length, 'task')}`,
    };
  },
};

// ---------------------------------------------------------------- lists, delete, undo

const createList = {
  name: 'create_list',
  title: 'Create list',
  description: 'Add a task list (like Work or Groceries) that tasks can be filed under. Returns its list_id.',
  inputSchema: obj({ name: str('List name', { minLength: 1, maxLength: 60 }), color: str('Color', { enum: COLORS }) }, ['name']),
  outputSchema: looseOut({ list: { type: 'object' } }, ['list']),
  annotations: ann('Create list', 'add'),
  write: true,
  run(a, ctx) {
    const { tx } = ctx;
    const name = cap(a.name, 60).trim();
    if (!name) fail('name must not be empty.');
    if (name.toLowerCase() === 'inbox') fail('"Inbox" is built in; pick another name.');
    const lists = tx.all('lists');
    const dup = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (dup) fail(`A list named ${q(dup.name)} already exists (id=${dup.id}).`);
    const used = new Set(lists.map((l) => l.color));
    const now = Date.now();
    const l = tx.put('lists', { id: uid(), name, color: a.color || COLORS.find((x) => !used.has(x)) || COLORS[lists.length % COLORS.length], icon: '', order: lists.length, createdAt: now, updatedAt: now });
    return { text: `Created list ${q(l.name)} (${l.color}) id=${l.id}`, data: { list: { list_id: l.id, name: l.name, color: l.color } }, summary: `Added list ${q(l.name)}` };
  },
};

/** Calendars ecosys keeps at most (shared/sanitize.js LIMITS.calendars). */
const MAX_CALENDARS = 500;

const createCalendar = {
  name: 'create_calendar',
  title: 'Create calendar',
  description: 'Add a calendar (like Fitness or Family) that events can be put in; create_events and update_event take it by name or id. Returns its calendar_id.',
  inputSchema: obj({ name: str('Calendar name', { minLength: 1, maxLength: 60 }), color: str('Color', { enum: COLORS }) }, ['name']),
  outputSchema: looseOut({ calendar: { type: 'object' } }, ['calendar']),
  // Only adds; but tests/mcp/helpers.js ADDITIVE_TOOLS lists the tools that may say destructiveHint false.
  annotations: ann('Create calendar', 'once'),
  write: true,
  run(a, ctx) {
    const { tx } = ctx;
    const name = cap(a.name, 60).trim();
    if (!name) fail('name must not be empty.');
    const cals = tx.all('calendars');
    const dup = cals.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (dup) fail(`A calendar named ${q(dup.name)} already exists (id=${dup.id}).`);
    if (cals.length >= MAX_CALENDARS) fail(`ecosys keeps at most ${MAX_CALENDARS} calendars; use one of them, or ask the user to delete one in Schedule.`);
    const used = new Set(cals.map((x) => x.color));
    const now = Date.now();
    const cal = tx.put('calendars', { id: uid(), name, color: a.color || COLORS.find((x) => !used.has(x)) || COLORS[cals.length % COLORS.length], visible: true, order: cals.length, createdAt: now, updatedAt: now });
    return { text: `Created calendar ${q(cal.name)} (${cal.color}) id=${cal.id}`, data: { calendar: { calendar_id: cal.id, name: cal.name, color: cal.color } }, summary: `Added calendar ${q(cal.name)}` };
  },
};

/**
 * update_list and update_calendar: rename or recolor one list or calendar. `find(tx, ref)` → the
 * record; `view(record)` → its structured form.
 */
function renameTool({ name, title, what, key, idKey, collection, find, view, builtIn = null }) {
  return {
    name,
    title,
    description: `Rename or recolor a ${what}. Send only what changes. Its ${what === 'list' ? 'tasks' : 'events'} stay in it.`,
    inputSchema: obj({ [key]: ref(`${what[0].toUpperCase()}${what.slice(1)} id or name`, { minLength: 1 }), name: str('New name', { minLength: 1, maxLength: 60 }), color: str('New color', { enum: COLORS }) }, [key]),
    outputSchema: looseOut({ [what]: { type: 'object' } }, [what]),
    annotations: ann(title, 'edit'),
    write: true,
    run(a, ctx) {
      const { tx } = ctx;
      const cur = find(tx, a[key]);
      if (!has(a, 'name') && !has(a, 'color')) fail(`Send name and/or color: the ${what} ${q(cur.name)} (id=${cur.id}) has nothing to change otherwise.`);
      const next = { ...cur };
      if (has(a, 'name')) {
        const n = cap(a.name, 60).trim();
        if (!n) fail('name must not be empty.');
        if (builtIn && n.toLowerCase() === builtIn.toLowerCase()) fail(`${q(builtIn)} is built in; pick another name.`);
        const dup = tx.all(collection).find((x) => x.id !== cur.id && x.name.toLowerCase() === n.toLowerCase());
        if (dup) fail(`A ${what} named ${q(dup.name)} already exists (id=${dup.id}).`);
        next.name = n;
      }
      if (has(a, 'color')) next.color = a.color;
      const changed = next.name !== cur.name || next.color !== cur.color;
      const saved = changed ? tx.put(collection, { ...next, updatedAt: Date.now() }) : cur;
      const was = saved.name !== cur.name ? ` (was ${q(cur.name)})` : '';
      return {
        text: changed ? `Updated ${what} ${q(saved.name)}${was} (${saved.color}) id=${saved.id}` : `The ${what} ${q(saved.name)} (${saved.color}) id=${saved.id} already looks like that; nothing changed.`,
        data: { [what]: { [idKey]: saved.id, ...view(saved) } },
        summary: `Edited ${what} ${q(saved.name)}`,
      };
    },
  };
}

const updateList = renameTool({
  name: 'update_list',
  title: 'Update list',
  what: 'list',
  key: 'list',
  idKey: 'list_id',
  collection: 'lists',
  builtIn: 'Inbox',
  find: (tx, v) => {
    const id = resolveList(tx, v);
    if (!id) fail('The Inbox is built in: it can\'t be renamed or recolored.');
    return tx.get('lists', id);
  },
  view: (l) => ({ name: l.name, color: l.color }),
});

const updateCalendar = renameTool({
  name: 'update_calendar',
  title: 'Update calendar',
  what: 'calendar',
  key: 'calendar',
  idKey: 'calendar_id',
  collection: 'calendars',
  find: (tx, v) => tx.get('calendars', resolveCalendar(tx, v)),
  view: (x) => ({ name: x.name, color: x.color, hidden: x.visible === false }),
});

const deleteItems = {
  name: 'delete_items',
  title: 'Delete items',
  description:
    'Delete tasks, events or lists (up to 50). For a repeating event pass occurrence and scope: "this" deletes only that day, "following" ends the series before that day (cancel it from then on), "all" deletes the whole series. A list that still has tasks needs move_tasks_to. Every delete can be reverted with undo_change.',
  inputSchema: obj(
    {
      items: arr(
        obj(
          {
            type: str('What to delete', { enum: ['task', 'event', 'list'] }),
            id: ref('Id of the task, event or list', { minLength: 1 }),
            occurrence: when('For a repeating event: the day (YYYY-MM-DD) to delete, or to delete from (scope "following")'),
            scope: str('For a repeating event: "this" (only occurrence; the default when occurrence is given), "following" (occurrence and every later one: the series ends the day before) or "all" (the whole series; the default without occurrence)', { enum: ['this', 'following', 'all'] }),
            move_tasks_to: ref('For a list: move its tasks here first (list id/name or "inbox")'),
          },
          ['type', 'id'],
        ),
        'Items to delete',
        { minItems: 1, maxItems: 50 },
      ),
      move_tasks_to: ref('Default destination for tasks of deleted lists (list id/name or "inbox")'),
    },
    ['items'],
  ),
  outputSchema: looseOut({ deleted: { type: 'array' }, failed: { type: 'array' } }, ['deleted', 'failed']),
  annotations: ann('Delete items', 'edit'),
  write: true,
  run(a, ctx) {
    const { clock: c, tx } = ctx;
    const deleted = [];
    const failed = [];
    for (const it of a.items) {
      try {
        if (it.type === 'task') {
          const t = findTask(tx, it.id);
          tx.del('tasks', t.id);
          deleted.push({ type: 'task', id: t.id, title: t.title });
        } else if (it.type === 'event') {
          const e = findEvent(tx, it.id);
          const start = e.start.slice(0, 10);
          const occ = it.occurrence ? parseDate(it.occurrence, c, 'occurrence') : null;
          // The same three choices as the Schedule app (shared/model.js deleteOccurrence).
          const scope = it.scope || (occ && e.repeat ? 'this' : 'all');
          if (e.repeat && occ && !isOccurrence(e, occ)) fail(`${fmtDay(occ)} is not an occurrence of ${q(e.title)}. ${nearbyOccurrences(e, occ)}`);
          if (e.repeat && scope !== 'all' && !occ) fail(`${q(e.title)} repeats; pass occurrence (YYYY-MM-DD) with scope "${scope}". ${nearbyOccurrences(e, c.today)}`);
          if (e.repeat && scope === 'this') {
            tx.put('events', { ...e, exdates: [...new Set([...(e.exdates || []), occ])].sort(), updatedAt: Date.now() });
            deleted.push({ type: 'event', id: e.id, title: e.title, occurrence: occ });
          } else if (e.repeat && scope === 'following' && occ > start) {
            // The series ends the day before; occurrences edited on their own from that day on go too.
            const until = addDaysYmd(occ, -1);
            // How many occurrences that removes, when the series had an end (else: every later one).
            const later = e.until ? occurrencesBetween(e.repeat, start, occ, e.until, { exdates: e.exdates || [], until: e.until }).length : null;
            tx.put('events', { ...e, until, updatedAt: Date.now() });
            let extra = 0;
            for (const x of tx.all('events')) {
              if (x.seriesId === e.id && !x.repeat && (x.occurrence ?? x.start.slice(0, 10)) >= occ) {
                tx.del('events', x.id);
                extra++;
              }
            }
            deleted.push({ type: 'event', id: e.id, title: e.title, from: occ, ends: until, ...(later !== null ? { later_occurrences: later } : {}), ...(extra ? { edited_occurrences: extra } : {}) });
          } else {
            if (!e.repeat && occ && occ !== start) fail(`${q(e.title)} does not repeat; it is on ${fmtDay(start)}.`);
            tx.del('events', e.id);
            // Edited single occurrences of a series go with it.
            let extra = 0;
            for (const x of tx.all('events')) if (x.seriesId === e.id) {
              tx.del('events', x.id);
              extra++;
            }
            deleted.push({ type: 'event', id: e.id, title: e.title, ...(extra ? { edited_occurrences: extra } : {}) });
          }
        } else if (it.type === 'list') {
          const l = tx.get('lists', it.id) || tx.all('lists').find((x) => x.name.toLowerCase() === String(it.id).toLowerCase());
          if (!l) fail(`No list with id "${cap(it.id, 40)}". Use get_context to see lists.`);
          const tasks = tx.all('tasks').filter((t) => t.listId === l.id);
          const dest = it.move_tasks_to ?? a.move_tasks_to;
          if (tasks.length) {
            if (dest === undefined) fail(`List ${q(l.name)} still has ${plural(tasks.length, 'task')}. Pass move_tasks_to ("inbox" or another list) to keep them.`);
            const target = resolveList(tx, dest);
            if (target === l.id) fail('move_tasks_to must be a different list.');
            for (const t of tasks) tx.put('tasks', { ...t, listId: target, updatedAt: Date.now() });
          }
          tx.del('lists', l.id);
          deleted.push({ type: 'list', id: l.id, title: l.name, moved_tasks: tasks.length });
        }
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        failed.push({ type: it.type, id: it.id, error: err.message });
      }
    }
    if (!deleted.length) fail(`Nothing deleted. ${failed.map((x) => x.error).join(' ')}`);
    const lines = [`Deleted ${deleted.length}/${a.items.length}:`];
    for (const d of deleted) {
      const what = d.occurrence
        ? ` on ${fmtDay(d.occurrence)} only`
        : d.from
          ? ` from ${fmtDay(d.from)} on (the series now ends ${fmtDay(d.ends)}${d.later_occurrences !== undefined ? `; ${plural(d.later_occurrences, 'later occurrence')} removed` : ''})`
          : '';
      lines.push(`- ${d.type} ${q(d.title)}${what}${d.moved_tasks ? ` (moved ${plural(d.moved_tasks, 'task')})` : ''}${d.edited_occurrences ? ` (+${d.edited_occurrences} edited occurrences)` : ''} id=${d.id}`);
    }
    for (const x of failed) lines.push(`- FAILED ${x.type} ${x.id}: ${x.error}`);
    return {
      text: lines.join('\n'),
      data: { deleted, failed },
      summary: deleted.length === 1 ? `Deleted ${deleted[0].type} ${q(deleted[0].title)}` : `Deleted ${deleted.length} items`,
    };
  },
};

const undoChange = {
  name: 'undo_change',
  title: 'Undo change',
  description: 'Revert an earlier change by its change_id (from a write result or find_changes). Items edited since are left alone and reported.',
  inputSchema: obj({ change_id: ref('change_id to revert', { minLength: 1 }) }, ['change_id']),
  outputSchema: looseOut({ restored: { type: 'integer' }, skipped: { type: 'array' } }, ['restored']),
  annotations: ann('Undo change', 'once'),
  write: true,
  undo: true, // handled by the core (needs the undo history)
  run(a, ctx) {
    return ctx.undo(a.change_id);
  },
};

// ---------------------------------------------------------------- registry

export const CORE_TOOLS = [
  getOverview, getContext, findTasks, getTask, findEvents, getEvent, findFreeTime, planTasks, findChanges,
  createTasks, updateTasks, completeTasks, createEvents, updateEvent, scheduleTasks, createList, createCalendar, updateList,
  updateCalendar, deleteItems, undoChange,
];

/**
 * get_context's note count: server/tools-notes.mjs visibleNoteCount(state), the notes an assistant may
 * see (null while notes access is Off). It comes through loadTools: a static import would be a cycle
 * (tools-notes.mjs imports `schema` from here). Without the notes tools, notes are not counted.
 */
let notesVisibleCount = null;
/**
 * From server/tools-notes.mjs, loaded the same way: get_event's meeting notes (meetingNotesOf(state,
 * event, date)), find_events' (meetingNotesIndex(state) → (event, date) → notes), and relinkNotes'
 * hook for the stand-ins of a note assistants can't see (relinkedNote(tx, note, now)).
 */
let notesMeetingNotes = null;
let notesMeetingIndex = null;
let notesRelinked = null;

/** All tools, including the notes tools from server/tools-notes.mjs when that file exists. */
export async function loadTools({ log = console } = {}) {
  const tools = [...CORE_TOOLS];
  try {
    const mod = await import('./tools-notes.mjs');
    if (typeof mod.visibleNoteCount === 'function') notesVisibleCount = mod.visibleNoteCount;
    if (typeof mod.meetingNotesOf === 'function') notesMeetingNotes = mod.meetingNotesOf;
    if (typeof mod.meetingNotesIndex === 'function') notesMeetingIndex = mod.meetingNotesIndex;
    if (typeof mod.relinkedNote === 'function') notesRelinked = mod.relinkedNote;
    for (const t of mod.tools || []) {
      if (!t || typeof t.name !== 'string' || typeof t.run !== 'function' || !t.inputSchema) {
        log.warn?.('ecosys: skipped an invalid tool in server/tools-notes.mjs');
        continue;
      }
      if (tools.some((x) => x.name === t.name)) {
        log.warn?.(`ecosys: duplicate tool name ${t.name} in server/tools-notes.mjs`);
        continue;
      }
      tools.push(t);
    }
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' || !String(err.message).includes('tools-notes.mjs')) {
      log.error?.('ecosys: could not load server/tools-notes.mjs:', err.message);
    }
  }
  return tools;
}

/**
 * Public definition sent in tools/list. `offered`: the names of the tools listed with it (a Set or an
 * array). A tool's `alongside` ({tool name: sentence}) adds each sentence whose tool is among them
 * (none without `offered`): a description names another tool only in `alongside`, so it never points
 * to a tool the connection isn't offered.
 */
export function toolDefinition(t, offered = null) {
  const listed = offered instanceof Set ? (n) => offered.has(n) : Array.isArray(offered) ? (n) => offered.includes(n) : () => false;
  let description = t.description;
  if (isPlainObject(t.alongside)) for (const [n, s] of Object.entries(t.alongside)) if (typeof s === 'string' && listed(n)) description += ` ${s}`;
  const def = { name: t.name, title: t.title, description, inputSchema: t.inputSchema };
  if (t.outputSchema) def.outputSchema = t.outputSchema;
  def.annotations = { title: t.title, ...t.annotations };
  return def;
}

export { makeClock };

/** Helpers for tool files such as server/tools-notes.mjs. */
export const schema = { str, int, bool, arr, obj, nullable, looseOut, ann, when, ref };
