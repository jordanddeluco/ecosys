// Validation of everything that crosses a process boundary: sync ops from browsers, imports,
// and items written by AI tools. Record-level rules come from shared/sanitize.js (pure, shared with
// the browser). If that module is missing or fails to load, a strict structural fallback is used.
import { isId, isPlainObject, parseJson, cleanText } from './util.mjs';

export const COLLECTIONS = ['tasks', 'lists', 'events', 'calendars', 'notes', 'folders'];
export const COLORS = ['iris', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'graphite'];

export const LIMITS = {
  opsPerRequest: 2000,
  itemsPerCollection: 50000,
  itemBytes: 512 * 1024,
};

// ---------------------------------------------------------------- fallback (structural only)

const MAX_DEPTH = 6;
function deepClean(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.length > 200000 ? v.slice(0, 200000) : v;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) return v.slice(0, 5000).map((x) => deepClean(x, depth + 1)).filter((x) => x !== undefined);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.length > 64) continue;
      const c = deepClean(x, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

function fallbackItem(collection, item) {
  if (!isPlainObject(item) || !isId(item.id)) return null;
  if (collection === 'notes') return null; // never store note HTML without the real sanitizer
  return deepClean(item);
}

const SETTING_RULES = {
  theme: (v) => ['system', 'light', 'dim', 'dark'].includes(v),
  accent: (v) => typeof v === 'string' && /^[a-z]{1,20}$/.test(v),
  weekStart: (v) => Number.isInteger(v) && v >= 0 && v <= 6,
  timeFormat: (v) => ['auto', '12h', '24h'].includes(v),
  defaultEventMinutes: (v) => Number.isInteger(v) && v >= 5 && v <= 1440,
  defaultTaskMinutes: (v) => Number.isInteger(v) && v >= 5 && v <= 1440,
  dayStartHour: (v) => Number.isInteger(v) && v >= 0 && v <= 23,
  showTasksInSchedule: (v) => typeof v === 'boolean',
  hiddenTaskLists: (v) => Array.isArray(v) && v.length <= 500 && v.every(isId),
  scheduleView: (v) => typeof v === 'string' && /^[a-z]{1,20}$/.test(v),
  scheduleDays: (v) => Number.isInteger(v) && v >= 1 && v <= 7,
  scheduleNavCollapsed: (v) => typeof v === 'boolean',
  showWeekends: (v) => typeof v === 'boolean',
  showEventsInToday: (v) => typeof v === 'boolean',
  completionSound: (v) => typeof v === 'boolean',
  taskSort: (v) => isPlainObject(v) && Object.keys(v).length <= 500 && Object.entries(v).every(([k, x]) => k.length <= 60 && typeof x === 'string' && x.length <= 20),
  reduceMotion: (v) => typeof v === 'boolean',
  // Read by the server itself (core.mjs): working hours, notes access for assistants, the apps' time zone.
  scheduleWorkStart: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  scheduleWorkEnd: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  notesAi: (v) => ['edit', 'read', 'off'].includes(v),
  uiTimeZone: (v) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(v),
};
function fallbackSettings(patch) {
  if (!isPlainObject(patch)) return {};
  const out = {};
  // Own rules only: "toString" or "constructor" must not find Object.prototype's.
  for (const [k, v] of Object.entries(patch)) if (Object.hasOwn(SETTING_RULES, k) && SETTING_RULES[k](v)) out[k] = structuredClone(v);
  return out;
}

// ---------------------------------------------------------------- loader

/**
 * Load shared/sanitize.js (spec'd exports: validateItem, validateSettingsPatch, sanitizeHtml, isId, ...),
 * then the notes schema that extends it. Returns the validator object used by the store and the tools.
 */
export async function loadValidators({ log = console } = {}) {
  let mod = null;
  try {
    mod = await import('../shared/sanitize.js');
    if (typeof mod.validateItem !== 'function') throw new Error('validateItem export is missing');
  } catch (err) {
    log.warn?.(`ecosys: shared/sanitize.js unavailable (${err.code || err.message}); using the built-in structural validator`);
    mod = null;
  }
  const notes = mod ? await loadNoteSchemas(log) : false;
  return { ...createValidators(mod), notes };
}

/**
 * notes/core/schema.js registers the notes, folders and task.source validators with sanitize.js
 * (extendSchema) when it is evaluated. Without them every note a browser syncs, imports or replaces
 * loses its blocks, and every task its source. It is loaded here, before any data is validated, so
 * this holds whether or not the notes tools (server/tools-notes.mjs) load. A broken notes module must
 * not take the server down: it is reported, and notes then keep only their basic fields.
 */
async function loadNoteSchemas(log) {
  try {
    await import('../notes/core/schema.js');
    return true;
  } catch (err) {
    log.error?.(`ecosys: notes/core/schema.js could not be loaded (${err?.code || cleanText(err?.message || err).slice(0, 200)}); notes and folders keep only their basic fields until it is fixed`);
    return false;
  }
}

export function createValidators(mod) {
  const itemFn = mod ? (c, item) => mod.validateItem(c, item) : fallbackItem;
  const settingsFn = mod?.validateSettingsPatch ? (p) => mod.validateSettingsPatch(p) : fallbackSettings;

  /** Sanitized copy of an item, or null when it is not acceptable. Never throws. */
  function item(collection, raw) {
    if (!COLLECTIONS.includes(collection) || !isPlainObject(raw) || !isId(raw.id)) return null;
    let out;
    try {
      // Round-trip through JSON so no prototypes, functions or shared references survive (and no key
      // named like a prototype member: parseJson drops those).
      out = itemFn(collection, parseJson(JSON.stringify(raw)));
    } catch {
      return null;
    }
    if (!isPlainObject(out) || !isId(out.id)) return null;
    if (JSON.stringify(out).length > LIMITS.itemBytes) return null;
    return out;
  }

  function settings(patch) {
    if (!isPlainObject(patch)) return {};
    try {
      const out = settingsFn(parseJson(JSON.stringify(patch)));
      return isPlainObject(out) ? out : {};
    } catch {
      return {};
    }
  }

  /** Validate one sync op. Returns {op} (normalized) or {error}. */
  function op(raw) {
    if (!isPlainObject(raw)) return { error: 'op must be an object' };
    switch (raw.op) {
      case 'put': {
        if (!COLLECTIONS.includes(raw.c)) return { error: `unknown collection "${String(raw.c).slice(0, 40)}"` };
        const it = item(raw.c, raw.item);
        if (!it) return { error: `invalid ${raw.c} item` };
        return { op: { op: 'put', c: raw.c, item: it } };
      }
      case 'del':
        if (!COLLECTIONS.includes(raw.c)) return { error: `unknown collection "${String(raw.c).slice(0, 40)}"` };
        if (!isId(raw.id)) return { error: 'invalid id' };
        return { op: { op: 'del', c: raw.c, id: raw.id } };
      case 'settings': {
        if (!isPlainObject(raw.patch)) return { error: 'settings patch must be an object' };
        return { op: { op: 'settings', patch: settings(raw.patch) } };
      }
      case 'replace': {
        if (!COLLECTIONS.includes(raw.c)) return { error: `unknown collection "${String(raw.c).slice(0, 40)}"` };
        if (!Array.isArray(raw.items)) return { error: 'replace needs an items array' };
        if (raw.items.length > LIMITS.itemsPerCollection) return { error: 'too many items' };
        const seen = new Set();
        const items = [];
        let dropped = 0;
        for (const x of raw.items) {
          const it = item(raw.c, x);
          if (!it || seen.has(it.id)) {
            dropped++;
            continue;
          }
          seen.add(it.id);
          items.push(it);
        }
        return { op: { op: 'replace', c: raw.c, items }, dropped };
      }
      default:
        return { error: `unknown op "${String(raw.op).slice(0, 20)}"` };
    }
  }

  return {
    item,
    settings,
    op,
    sanitizeHtml: typeof mod?.sanitizeHtml === 'function' ? mod.sanitizeHtml : null,
    source: mod ? 'shared/sanitize.js' : 'fallback',
  };
}
