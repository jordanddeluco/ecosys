// Domain logic shared by tasks and schedule: one source of truth for what a task or event "is".
import { db } from './store.js';
import { todayYmd, parseYmd, ymd, addDays, diffDays, parseDT, fmtDT, toMinutes } from './dates.js';
import { nextOccurrence, occurrencesBetween, firstOnOrAfter } from './recur.js';

// ---------------------------------------------------------------- colors

/** Named colors shared by lists and calendars (values come from CSS: --c-<name>). */
export const COLORS = ['iris', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'graphite'];
export const colorVar = (name) => `var(--c-${COLORS.includes(name) ? name : 'iris'})`;

// ---------------------------------------------------------------- tasks

/*
 task = {
   id, title, notes, listId|null, tags:[], priority:0..3,
   date:'YYYY-MM-DD'|null   – the day you plan to do it ("when")
   time:'HH:MM'|null        – optional start time; with duration it becomes a time block in schedule
   duration:minutes|null,
   deadline:'YYYY-MM-DD'|null,
   evening:boolean, someday:boolean,
   repeat: rule|null, checklist:[{id,title,done}],
   done:boolean, completedAt:number|null, order:number, createdAt, updatedAt
 }
*/

export const isOpen = (t) => !t.done;
export const isOverdue = (t, today = todayYmd()) => !t.done && ((t.date && t.date < today) || (t.deadline && t.deadline < today));
export const isToday = (t, today = todayYmd()) => !t.done && !t.someday && ((t.date && t.date <= today) || (t.deadline && t.deadline <= today));

export const SMART_LISTS = [
  { id: 'inbox', name: 'Inbox', icon: 'inbox', color: 'blue', key: '1' },
  { id: 'today', name: 'Today', icon: 'star', color: 'yellow', key: '2' },
  { id: 'upcoming', name: 'Upcoming', icon: 'calendar', color: 'red', key: '3' },
  { id: 'anytime', name: 'Anytime', icon: 'layers', color: 'teal', key: '4' },
  { id: 'someday', name: 'Someday', icon: 'archive', color: 'graphite', key: '5' },
  { id: 'logbook', name: 'Logbook', icon: 'check-circle', color: 'green', key: '6' },
];

export function tasksIn(view, { today = todayYmd(), tag = null } = {}) {
  const all = db.all('tasks');
  switch (view) {
    case 'inbox':
      return all.filter((t) => !t.done && !t.listId && !t.date && !t.someday);
    case 'today':
      return all.filter((t) => isToday(t, today));
    case 'upcoming':
      return all.filter((t) => !t.done && !t.someday && t.date && t.date > today);
    case 'anytime':
      return all.filter((t) => !t.done && !t.someday && t.listId && (!t.date || t.date <= today));
    case 'someday':
      return all.filter((t) => !t.done && t.someday);
    case 'logbook':
      return all.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    case 'tag':
      return all.filter((t) => !t.done && t.tags?.includes(tag));
    default:
      return all.filter((t) => t.listId === view && !t.done);
  }
}

export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt;
export function byTimeThenOrder(a, b) {
  if (a.time && b.time) return a.time.localeCompare(b.time) || byOrder(a, b);
  if (a.time) return -1;
  if (b.time) return 1;
  return byOrder(a, b);
}

export function nextOrder() {
  const all = db.all('tasks');
  return all.length ? Math.max(...all.map((t) => t.order ?? 0)) + 1 : 1;
}

export function allTags() {
  const s = new Set();
  for (const t of db.all('tasks')) if (!t.done) for (const g of t.tags || []) s.add(g);
  return [...s].sort();
}

/** Create a task from a parsed quick-add result (or a plain object). Creates missing lists on the fly. */
export function createTask(fields) {
  let listId = fields.listId ?? null;
  if (!listId && fields.newList) {
    const existing = db.all('lists').find((l) => l.name.toLowerCase() === fields.newList.toLowerCase());
    listId = existing ? existing.id : createList({ name: fields.newList }).id;
  }
  return db.insert('tasks', {
    title: fields.title || 'New task',
    notes: fields.notes || '',
    listId,
    tags: fields.tags || [],
    priority: fields.priority || 0,
    date: fields.someday ? null : fields.date || null,
    time: fields.someday ? null : fields.time || null,
    duration: fields.duration || null,
    deadline: fields.deadline || null,
    evening: !!fields.evening,
    someday: !!fields.someday,
    repeat: fields.repeat || null,
    checklist: fields.checklist || [],
    done: false,
    completedAt: null,
    order: fields.order ?? nextOrder(),
  });
}

export function createList(fields) {
  const lists = db.all('lists');
  const used = new Set(lists.map((l) => l.color));
  const color = fields.color || COLORS.find((c) => !used.has(c)) || COLORS[lists.length % COLORS.length];
  return db.insert('lists', { name: fields.name, color, icon: fields.icon || '', order: lists.length });
}

/**
 * Toggle completion. Completing a repeating task logs a completed copy to the Logbook and moves
 * the task itself to its next date, so its identity (and any time block in schedule) is preserved.
 * Returns an undo function.
 */
export function toggleTask(id) {
  const t = db.get('tasks', id);
  if (!t) return () => {};
  const before = structuredClone(t);
  if (t.done) {
    db.update('tasks', id, { done: false, completedAt: null });
    return () => db.put('tasks', before);
  }
  if (t.repeat) {
    const today = todayYmd();
    const anchor = t.date || t.deadline || today;
    let base = t.repeat.from === 'done' ? today : anchor;
    let next = nextOccurrence(t.repeat, base);
    for (let guard = 0; next <= today && guard < 1000; guard++) next = nextOccurrence(t.repeat, next);
    const shift = diffDays(anchor, next);
    let copyId = null;
    db.batch(() => {
      const { id: _omit, ...rest } = structuredClone(t);
      copyId = db.insert('tasks', { ...rest, repeat: null, done: true, completedAt: Date.now(), repeatOf: t.id }).id;
      db.update('tasks', id, {
        date: t.date ? addDaysStr(t.date, shift) : null,
        deadline: t.deadline ? addDaysStr(t.deadline, shift) : null,
        checklist: (t.checklist || []).map((c) => ({ ...c, done: false })),
      });
    });
    return () =>
      db.batch(() => {
        if (copyId) db.remove('tasks', copyId);
        db.put('tasks', before);
      });
  }
  db.update('tasks', id, { done: true, completedAt: Date.now() });
  return () => db.put('tasks', before);
}

const addDaysStr = (s, n) => ymd(addDays(parseYmd(s), n));

export function deleteTask(id) {
  const t = db.remove('tasks', id);
  return () => t && db.put('tasks', t);
}

/** Schedule a task into a time block (used by drag & drop in schedule). */
export function scheduleTask(id, date, time, duration) {
  const t = db.get('tasks', id);
  if (!t) return () => {};
  const before = structuredClone(t);
  db.update('tasks', id, {
    date,
    time: time ?? null,
    duration: time ? duration || t.duration || null : t.duration,
    someday: false,
  });
  return () => db.put('tasks', before);
}

// ---------------------------------------------------------------- events

/*
 event = {
   id, title, calendarId, allDay:boolean,
   start: 'YYYY-MM-DDTHH:MM' (timed) | 'YYYY-MM-DD' (all-day)
   end:   'YYYY-MM-DDTHH:MM' (timed, exclusive) | 'YYYY-MM-DD' (all-day, inclusive)
   location, notes, repeat: rule|null, exdates:['YYYY-MM-DD'], until:'YYYY-MM-DD'|null,
   createdAt, updatedAt
 }
*/

export function calendarMap() {
  return new Map(db.all('calendars').map((c) => [c.id, c]));
}

/** Expand events (including recurring ones) into concrete instances that touch [fromYmd, toYmd]. */
export function eventInstances(fromYmd, toYmd, { includeHidden = false } = {}) {
  const cals = calendarMap();
  const out = [];
  for (const e of db.all('events')) {
    const cal = cals.get(e.calendarId);
    if (!includeHidden && cal && cal.visible === false) continue;
    const startDate = e.start.slice(0, 10);
    const endDate = e.end.slice(0, 10);
    const spanDays = diffDays(startDate, endDate);
    const dates = e.repeat
      ? occurrencesBetween(e.repeat, startDate, ymd(addDays(parseYmd(fromYmd), -spanDays)), toYmd, { exdates: e.exdates, until: e.until })
      : endDate >= fromYmd && startDate <= toYmd
        ? [startDate]
        : [];
    for (const d of dates) {
      const shift = diffDays(startDate, d);
      let start;
      let end;
      if (e.allDay) {
        start = parseYmd(d);
        end = addDays(parseYmd(endDate), shift);
      } else {
        start = addDays(parseDT(e.start), shift);
        end = addDays(parseDT(e.end), shift);
      }
      const endYmd = e.allDay ? ymd(end) : ymd(new Date(end.getTime() - 1));
      if (endYmd < fromYmd || ymd(start) > toYmd) continue;
      out.push({ key: `${e.id}@${d}`, event: e, occurrence: d, start, end, allDay: !!e.allDay, calendar: cal, color: cal?.color || 'iris' });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Instances overlapping a single day, split into all-day and timed (timed clipped to the day). */
export function dayInstances(instances, dayYmd) {
  const dayStart = parseYmd(dayYmd);
  const dayEnd = addDays(dayStart, 1);
  const allDay = [];
  const timed = [];
  for (const i of instances) {
    if (i.allDay) {
      if (ymd(i.start) <= dayYmd && ymd(i.end) >= dayYmd) allDay.push(i);
    } else if (i.start < dayEnd && i.end > dayStart) {
      const s = i.start < dayStart ? 0 : (i.start - dayStart) / 60000;
      const e = i.end > dayEnd ? 1440 : (i.end - dayStart) / 60000;
      // Multi-day timed events longer than a day are shown in the all-day row instead.
      if (i.end - i.start >= 86400000) allDay.push(i);
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
  const calendarId = fields.calendarId || cals.find((c) => c.visible !== false)?.id || cals[0]?.id;
  const date = fields.date || todayYmd();
  let start;
  let end;
  if (fields.allDay || !fields.time) {
    start = date;
    end = fields.endDate || date;
  } else {
    const mins = fields.duration || settingsObj.defaultEventMinutes || 60;
    const s = parseDT(`${date}T${fields.time}`);
    start = fmtDT(s);
    end = fmtDT(new Date(s.getTime() + mins * 60000));
  }
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
  });
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
  const shiftStr = (s) => (s.length > 10 ? fmtDT(addDays(parseDT(s), shift)) : ymd(addDays(parseYmd(s), shift)));
  let created = null;
  const { id: _omit, ...rest } = structuredClone(e);
  db.batch(() => {
    db.update('events', eventId, { exdates: [...(e.exdates || []), occurrence] });
    created = db.insert('events', {
      ...rest,
      start: shiftStr(e.start),
      end: shiftStr(e.end),
      repeat: null,
      exdates: [],
      until: null,
      seriesId: e.id,
      ...patch,
    });
  });
  return created;
}

/** End a series before `occurrence` and start a new series from it with the patch ("this and following"). */
export function splitSeries(eventId, occurrence, patch) {
  const e = db.get('events', eventId);
  if (!e) return null;
  const startDate = e.start.slice(0, 10);
  if (occurrence === startDate) {
    return db.update('events', eventId, patch);
  }
  const shift = diffDays(startDate, occurrence);
  const shiftStr = (s) => (s.length > 10 ? fmtDT(addDays(parseDT(s), shift)) : ymd(addDays(parseYmd(s), shift)));
  let created = null;
  const { id: _omit, ...rest } = structuredClone(e);
  db.batch(() => {
    db.update('events', eventId, { until: ymd(addDays(parseYmd(occurrence), -1)) });
    created = db.insert('events', {
      ...rest,
      start: shiftStr(e.start),
      end: shiftStr(e.end),
      exdates: (e.exdates || []).filter((x) => x >= occurrence),
      until: e.until,
      ...patch,
    });
  });
  return created;
}

export function snapshotEvents() {
  return structuredClone(db.all('events'));
}

/** Tasks that should appear on the calendar between two dates. */
export function scheduledTasks(fromYmd, toYmd, s) {
  if (!s.showTasksInSchedule) return [];
  const hidden = new Set(s.hiddenTaskLists || []);
  // Completed tasks stay visible (checked) on the day they were planned.
  return db.all('tasks').filter((t) => t.date && t.date >= fromYmd && t.date <= toYmd && !t.someday && !hidden.has(t.listId || 'inbox'));
}

export function taskBlock(t, s) {
  if (!t.time) return null;
  const top = toMinutes(t.time);
  const dur = t.duration || s.defaultTaskMinutes || 30;
  return { top, bottom: Math.min(1440, top + Math.max(15, dur)) };
}

export { firstOnOrAfter };
