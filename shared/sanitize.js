// ecosys sanitizer & validators — the trust boundary for every record that enters a store.
// Pure ES module: works in the browser AND in Node (server, MCP bridge). No DOM APIs.
//
//   sanitizeHtml(html)            notes HTML → allowlisted, well-formed HTML (tokenizer + rebuild)
//   htmlToText(html)              notes HTML → plain text (search, previews, MCP)
//   validateItem(c, item)         one record → sanitized copy, or null when it can't be repaired
//   validateCollection(c, items)  → { items, dropped }   (dedupes ids, caps sizes)
//   validateSnapshot(data)        backup / server state → { data, settings, dropped, counts }
//   validateSettingsPatch(patch)  → only the known (or app-prefixed) keys with valid values
//   validateOp(op) / validateOps  sync ops ({op:'put'|'del'|'settings'|'replace'}) → sanitized or null
//   createValidationMemo()        lets validateCollection / validateSnapshot / validateOp skip records
//                                 they already validated (unchanged JSON), for stores that re-read data
//
// Records are rebuilt field by field from a schema, so unknown keys (including __proto__,
// constructor and prototype) never survive. Stage-2 builders can add fields with extendSchema():
// notes/core/schema.js adds the definitive notes and folders fields (and task.source) that way, and
// shared/store.js imports it, so every page validates notes the same way (as the server does).
// No validator throws on parsed JSON, whatever it holds (see safeString).

// ---------------------------------------------------------------- constants

export const COLLECTIONS = ['tasks', 'lists', 'events', 'calendars', 'notes', 'folders'];

/** Named colors shared by lists, calendars, notes and folders (CSS: --c-<name>). */
export const COLORS = ['iris', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'graphite'];

/** Upper bounds per collection (records beyond this are dropped). */
export const LIMITS = { tasks: 50000, events: 50000, notes: 20000, lists: 2000, calendars: 500, folders: 2000 };

/** Longest notes HTML kept (characters of sanitized output). */
export const NOTE_HTML_MAX = 400000;
/**
 * Largest record the server stores, in characters of JSON (server/validate.mjs LIMITS.itemBytes).
 * validateItem() keeps every record under it, so a record that validates here is never refused there.
 */
export const ITEM_JSON_MAX = 512 * 1024;
const TEXT_MAX = 20000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------- primitives

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A value as a string, without ever throwing. String(v), `${v}` and 'x' + v call toString / valueOf,
 * and parsed JSON can hold objects in which those are not functions ({"toString": 0}): converting
 * such an object throws a TypeError. Strings are returned as they are; numbers, booleans and bigints
 * are written out; null, undefined, objects, arrays and symbols give ''.
 */
export function safeString(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

/**
 * Names that must never become a schema field or a settings key: '__proto__', 'constructor',
 * 'prototype' and every other Object.prototype member ('toString', 'valueOf', 'hasOwnProperty'…).
 * A record or a settings object with an own 'toString' that is not a function can't be printed.
 */
const isReservedName = (k) => typeof k !== 'string' || FORBIDDEN_KEYS.has(k) || k in Object.prototype;

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export const isForbiddenKey = (k) => FORBIDDEN_KEYS.has(k);

const ID_RE = /^[a-z0-9_-]{1,40}$/i;
/** Record ids: 1–40 chars of [A-Za-z0-9_-] (uid() makes 16 lowercase hex chars; legacy ids also pass). */
export const isId = (s) => typeof s === 'string' && ID_RE.test(s);

const daysIn = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** 'YYYY-MM-DD' that is a real calendar date (year 1000–9999). */
export function isYmd(s) {
  if (typeof s !== 'string' || s.length !== 10) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  return y >= 1000 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** 'HH:MM', 00:00–23:59. */
export const isHHMM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Local date-time 'YYYY-MM-DDTHH:MM'. */
export const isDateTime = (s) => typeof s === 'string' && s.length === 16 && s[10] === 'T' && isYmd(s.slice(0, 10)) && isHHMM(s.slice(11));

const toNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
};

/** Round and clamp to [min, max]; non-numbers give `fallback`. Accepts numeric strings ('60'). */
export function clampInt(v, min, max, fallback = null) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Integer inside [min, max], otherwise `fallback` (no clamping: 5e9 days is not "7 days"). */
function intIn(v, min, max, fallback = null) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  return r >= min && r <= max ? r : fallback;
}

const toBool = (v, fallback = false) => (typeof v === 'boolean' ? v : v === 'true' || v === 1 ? true : v === 'false' || v === 0 ? false : fallback);

// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex
const LINE_CTRL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/g;
// eslint-disable-next-line no-control-regex
const HAS_CTRL_RE = /[\u0000-\u001F\u007F]/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Unpaired surrogates (half an emoji; they can't be stored as UTF-8) become U+FFFD. Length is kept. */
const wellFormed = typeof String.prototype.toWellFormed === 'function' ? (s) => s.toWellFormed() : (s) => s.replace(LONE_SURROGATE_RE, '�');
const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;

/** First `max` characters of `s`, never ending in half a surrogate pair. */
function truncate(s, max) {
  if (s.length <= max) return s;
  return isHighSurrogate(s.charCodeAt(max - 1)) ? s.slice(0, max - 1) : s.slice(0, max);
}

/**
 * String with control characters removed, at most `max` chars. Numbers and booleans are coerced;
 * anything else gives ''. Also usable curried: cleanString(200)(value).
 */
export function cleanString(v, max = 1000) {
  if (arguments.length === 1 && typeof v === 'number' && Number.isInteger(v) && v > 0) {
    const m = v;
    return (x) => cleanString(x, m);
  }
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' ? String(v) : '';
  return wellFormed(truncate(s, max).replace(CTRL_RE, ''));
}

/** Single-line string: line breaks and tabs become spaces. Not trimmed (inputs write on every keystroke). */
export function cleanLine(v, max = 500) {
  return cleanString(v, max).replace(LINE_CTRL_RE, ' ');
}

/** Labels: array of short unique strings. */
export function cleanTags(v, { max = 100, len = 60 } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (out.length >= max) break;
    const t = cleanLine(x, len).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export const cleanColor = (v, fallback = 'iris') => (COLORS.includes(v) ? v : fallback);

const isTs = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;

function genId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function ymdList(v, max = 2000) {
  if (!Array.isArray(v)) return [];
  const set = new Set();
  for (const x of v) {
    if (set.size >= max) break;
    if (isYmd(x)) set.add(x);
  }
  return [...set].sort();
}

function idList(v, max = 1000) {
  if (!Array.isArray(v)) return [];
  const set = new Set();
  for (const x of v) {
    if (set.size >= max) break;
    if (isId(x)) set.add(x);
  }
  return [...set];
}

const pad2 = (n) => String(n).padStart(2, '0');
function addMinutesDT(s, mins) {
  const [y, mo, d] = s.slice(0, 10).split('-').map(Number);
  const [h, mi] = s.slice(11).split(':').map(Number);
  const x = new Date(y, mo - 1, d, h, mi + mins);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}T${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}

// ---------------------------------------------------------------- repeat rules

const FREQS = ['day', 'week', 'month', 'year'];

/**
 * Longest repeat interval ("every 99 weeks"), the same as the server's MCP tools (server/model.mjs
 * normalizeRule and parseRepeat). Longer intervals are capped to it, never reset to 1: "every 1000
 * days" must not become a daily task.
 */
export const REPEAT_INTERVAL_MAX = 99;

/** rule = { freq, interval 1..99, days?:[0..6], monthDay?:1..31, month?:1..12 (yearly), from?:'due'|'done' } or null. */
export function validateRepeat(r) {
  if (!isPlainObject(r) || !FREQS.includes(r.freq)) return null;
  const out = { freq: r.freq, interval: clampInt(r.interval, 1, REPEAT_INTERVAL_MAX, 1) };
  if (r.freq === 'week' && Array.isArray(r.days)) {
    const days = [...new Set(r.days.map((d) => intIn(d, 0, 6, null)).filter((d) => d !== null))].sort((a, b) => a - b);
    if (days.length) out.days = days;
  }
  if (r.freq === 'month' || r.freq === 'year') {
    const md = intIn(r.monthDay, 1, 31, null);
    if (md) out.monthDay = md;
  }
  if (r.freq === 'year') {
    const mo = intIn(r.month, 1, 12, null);
    if (mo) out.month = mo;
  }
  if (r.from === 'due' || r.from === 'done') out.from = r.from;
  return out;
}

// ---------------------------------------------------------------- schemas

// A field validator gets (value, rawItem) and returns the clean value, or undefined to omit the key.
const F = {
  id: (v) => (isId(v) ? v : undefined),
  ref: (v) => (isId(v) ? v : null),
  optRef: (v) => (isId(v) ? v : undefined),
  line: (max, dflt = '') => (v) => (v == null ? dflt : cleanLine(v, max)),
  text: (max = TEXT_MAX) => (v) => (v == null ? '' : cleanString(v, max)),
  bool: (dflt = false) => (v) => toBool(v, dflt),
  ymd: (v) => (isYmd(v) ? v : null),
  optYmd: (v) => (isYmd(v) ? v : undefined),
  hhmm: (v) => (isHHMM(v) ? v : null),
  int: (min, max, dflt = null) => (v) => intIn(v, min, max, dflt),
  num: (dflt = 0) => (v) => {
    const n = toNumber(v);
    return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : dflt;
  },
  ts: (v) => (isTs(v) ? v : Date.now()),
  tsOrNull: (v) => (isTs(v) ? v : null),
  color: (dflt = 'iris') => (v) => cleanColor(v, dflt),
  colorOrNull: (v) => (COLORS.includes(v) ? v : null),
  icon: (v) => (typeof v === 'string' && /^[a-z0-9-]{0,40}$/.test(v) ? v : ''),
  tags: (v) => cleanTags(v),
  repeat: (v) => validateRepeat(v),
  html: (v) => (v == null ? '' : sanitizeHtml(v)),
  checklist: (v) => {
    if (!Array.isArray(v)) return [];
    const out = [];
    const seen = new Set();
    for (const s of v) {
      if (out.length >= 300) break;
      if (!isPlainObject(s)) continue;
      let id = isId(s.id) && !seen.has(s.id) ? s.id : genId();
      seen.add(id);
      out.push({ id, title: cleanLine(s.title ?? '', 500), done: toBool(s.done) });
    }
    return out;
  },
};

/** Field order here is the canonical key order of stored records. */
const SCHEMAS = {
  tasks: {
    id: F.id,
    title: F.line(500),
    notes: F.text(),
    listId: F.ref,
    tags: F.tags,
    priority: F.int(0, 3, 0),
    date: F.ymd,
    time: F.hhmm,
    duration: F.int(1, 10080, null),
    deadline: F.ymd,
    repeat: F.repeat,
    checklist: F.checklist,
    done: F.bool(false),
    completedAt: F.tsOrNull,
    order: F.num(0),
    repeatOf: F.optRef,
    createdAt: F.ts,
    updatedAt: F.ts,
  },
  lists: {
    id: F.id,
    name: F.line(200, 'Untitled list'),
    color: F.color('iris'),
    icon: F.icon,
    order: F.num(0),
    createdAt: F.ts,
    updatedAt: F.ts,
  },
  events: {
    id: F.id,
    title: F.line(500),
    calendarId: F.ref,
    allDay: F.bool(false),
    // Checked together in POST.events, which always replaces both (or drops the record). A missing
    // value is held as null so the key keeps its place here: a repaired `end` must not move to the
    // end of the record, or the same event would serialize differently on a second validation.
    start: (v) => (typeof v === 'string' ? v : null),
    end: (v) => (typeof v === 'string' ? v : null),
    location: F.line(500),
    notes: F.text(),
    repeat: F.repeat,
    exdates: (v) => ymdList(v),
    until: F.ymd,
    seriesId: F.optRef,
    occurrence: F.optYmd,
    createdAt: F.ts,
    updatedAt: F.ts,
  },
  calendars: {
    id: F.id,
    name: F.line(200, 'Untitled calendar'),
    color: F.color('iris'),
    visible: F.bool(true),
    order: F.num(0),
    createdAt: F.ts,
    updatedAt: F.ts,
  },
  // Notes app records (stage 2). body is sanitized notes HTML; trashedAt != null = in Recently Deleted.
  notes: {
    id: F.id,
    title: F.line(500),
    body: F.html,
    folderId: F.ref,
    pinned: F.bool(false),
    color: F.colorOrNull,
    tags: F.tags,
    order: F.num(0),
    trashedAt: F.tsOrNull,
    createdAt: F.ts,
    updatedAt: F.ts,
  },
  folders: {
    id: F.id,
    name: F.line(200, 'Untitled folder'),
    color: F.colorOrNull,
    icon: F.icon,
    parentId: F.ref,
    order: F.num(0),
    createdAt: F.ts,
    updatedAt: F.ts,
  },
};

// A memo (validateKnown) keeps the JSON of every record it validates. POST.notes has just written the
// note out to measure it, so it hands that JSON over instead of the memo writing the note out again:
// notes are most of the bytes, and that is one JSON.stringify less per note on a page load.
let wantJson = false; // validateKnown is asking
let postJson = null; // { item, json } with JSON.stringify(item) === json: the record POST returned, unchanged since

/**
 * Cross-field checks after the per-field pass. Return null to drop the record. They only assign keys
 * the field pass already set (never add one), so records keep the canonical key order: store.js,
 * sync.js and the server detect changes by comparing JSON strings.
 */
const POST = {
  events(e) {
    let { start, end } = e;
    if (e.allDay) {
      if (isDateTime(start)) start = start.slice(0, 10);
      if (!isYmd(start)) return null;
      if (isDateTime(end)) end = end.slice(0, 10);
      if (!isYmd(end) || end < start) end = start;
    } else {
      if (isYmd(start)) start = `${start}T09:00`;
      if (!isDateTime(start)) return null;
      if (!isDateTime(end) || end <= start) end = addMinutesDT(start, 60);
    }
    e.start = start;
    e.end = end;
    if (e.until && e.until < start.slice(0, 10)) e.until = start.slice(0, 10);
    return e;
  },
  // Quotes, backslashes and line breaks take two characters in JSON, so a note whose HTML fits
  // NOTE_HTML_MAX can still be over the server's record limit. Cut its end until it fits: removing k
  // characters of HTML saves at least k characters of JSON, so one pass is enough.
  notes(n) {
    const json = JSON.stringify(n);
    const over = json.length - ITEM_JSON_MAX;
    if (over > 0 && typeof n.body === 'string') n.body = sanitizeHtml(n.body, { maxLength: Math.max(0, n.body.length - over) });
    else if (wantJson) postJson = { item: n, json }; // n is returned as it is: this is its JSON
    return n;
  },
};

/** The schema of a known collection, or null ('toString', '__proto__' … are not collections). */
const schemaOf = (collection) => (typeof collection === 'string' && hasOwn(SCHEMAS, collection) ? SCHEMAS[collection] : null);

// Bumped by every extendSchema(): records a validation memo saw under an older schema are validated again.
let schemaGen = 0;

/**
 * Add or replace field validators for a collection (e.g. new notes fields in stage 2).
 * Must be called identically in the browser and on the server, or the server will drop the field.
 * Throws, changing nothing, for an unknown collection or a bad field (not a function, 'id', or an
 * Object.prototype name such as '__proto__' or 'toString').
 */
export function extendSchema(collection, fields) {
  const schema = schemaOf(collection);
  if (!schema || !isPlainObject(fields)) throw new Error(`Unknown collection: ${safeString(collection).slice(0, 40)}`);
  const entries = Object.entries(fields);
  for (const [k, fn] of entries) {
    if (isReservedName(k) || k === 'id' || typeof fn !== 'function') throw new Error(`Bad schema field: ${k.slice(0, 40)}`);
  }
  for (const [k, fn] of entries) schema[k] = fn;
  schemaGen++;
}

/** Field names a collection keeps (read-only view, handy for tools and docs). */
export const schemaFields = (collection) => Object.keys(schemaOf(collection) || {});

const warnedThrow = new Set(); // collections whose validators threw (reported once each)

/**
 * A field validator threw. That is a bug (validators repair or reject, they never throw), and it
 * may drop every record of a collection: say so once per collection, so it can't go unnoticed.
 */
function reportThrow(collection, err) {
  if (warnedThrow.has(collection)) return;
  warnedThrow.add(collection);
  let why = '';
  try {
    why = safeString(err?.message).slice(0, 300); // whatever was thrown, reading it must not throw again
  } catch {}
  try {
    console.warn(`ecosys: a ${collection} validator threw, so the record was dropped (reported once per collection)${why ? `: ${why}` : ''}`);
  } catch {}
}

/**
 * One record → sanitized copy with only known keys, or null (not an object, bad id, unrepairable).
 * Never throws: a record that makes a field validator throw (an added validator meeting input it
 * did not expect) is invalid, so one odd record never fails the whole collection, import or sync
 * batch it arrived in (the first such failure of each collection is logged with console.warn).
 * The server (server/validate.mjs) treats such records the same way.
 */
export function validateItem(collection, item) {
  const schema = schemaOf(collection);
  if (!schema || !isPlainObject(item)) return null;
  try {
    const out = {};
    for (const k of Object.keys(schema)) {
      const v = schema[k](hasOwn(item, k) ? item[k] : undefined, item);
      if (v !== undefined) out[k] = v;
    }
    if (!out.id) return null;
    return hasOwn(POST, collection) ? POST[collection](out) : out;
  } catch (err) {
    reportThrow(collection, err);
    return null;
  }
}

// ---------------------------------------------------------------- validation memo

const memoState = new WeakMap(); // memo → { gen, tables: Map(collection → Map(id → JSON of the validated record)) }

/**
 * A memo for code that validates the same records again and again: a store re-reads a whole
 * collection each time another tab rewrites it after changing one record, and a server snapshot is
 * mostly what the store already holds. Pass it as { memo } to validateCollection, validateSnapshot
 * or validateOp. A record that is JSON-identical to the record last validated with its id (in that
 * collection), and that JSON describes exactly (see jsonLossy: JSON.parse reads 1e309 as Infinity,
 * which JSON.stringify writes as null), is returned as it is; new and changed records are validated
 * in full.
 *
 * That is exact, not a shortcut: validation is idempotent and gives canonical JSON (the QA fuzz
 * suite checks both), and equal JSON means an equal value once jsonLossy is false, so such a record
 * is what validating it gives (tests/validation-sanitize.test.js compares the two value for value,
 * not by JSON). A memo forgets what it saw when a schema is extended, and keeps one JSON string per
 * record of the collections it last validated. Use it only for data parsed from JSON (storage, the
 * network, a file): a hit is the input object itself, not a copy.
 */
export function createValidationMemo() {
  const memo = Object.freeze({});
  memoState.set(memo, { gen: schemaGen, tables: new Map() });
  return memo;
}

/** The memo's table for `collection` (empty again after a schema change), or null without a memo. */
function memoTable(memo, collection) {
  const st = memo !== null && typeof memo === 'object' ? memoState.get(memo) : undefined;
  if (!st || !schemaOf(collection)) return null;
  if (st.gen !== schemaGen) {
    st.tables.clear();
    st.gen = schemaGen;
  }
  let table = st.tables.get(collection);
  if (!table) st.tables.set(collection, (table = new Map()));
  return table;
}

/** JSON of a validated record, or undefined if it can't be written (such a record is never a hit). */
function jsonOf(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

/**
 * True when JSON.stringify does not describe `v` exactly, so equal JSON does not mean an equal value.
 * From JSON.parse that is a number JSON can't hold: 1e309 and -1e400 are read as ±Infinity, which
 * JSON.stringify writes as null, and -0 (or -1e-400) is written as 0. In other data (the memo is meant
 * for parsed JSON, but a live object must not slip through either) it is also a value JSON leaves out
 * or converts: undefined, a function, a symbol, an array hole, an object that is not a plain one (a
 * Date, a Map, a null-prototype object…). Only called on a record whose JSON matched a validated
 * record's, so `v` is small and acyclic.
 */
function jsonLossy(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return false;
  if (typeof v === 'number') return !Number.isFinite(v) || (v === 0 && 1 / v < 0);
  if (typeof v !== 'object') return true;
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) return true;
    for (let i = 0; i < v.length; i++) if (!(i in v) || jsonLossy(v[i])) return true;
    return false;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) return true;
  for (const k in v) if (hasOwn(v, k) && jsonLossy(v[k])) return true;
  return false;
}

/**
 * validateItem through a memo table: [record, json]. The record is `raw` itself when its JSON is the
 * JSON last validated under its id and describes it exactly (!jsonLossy), else validateItem's result;
 * json is the record's JSON (to remember).
 */
function validateKnown(collection, raw, table) {
  try {
    if (isPlainObject(raw) && typeof raw.id === 'string') {
      const known = table.get(raw.id);
      if (known !== undefined && JSON.stringify(raw) === known && !jsonLossy(raw)) return [raw, known];
    }
  } catch {} // a live object that can't be written as JSON: validated below
  postJson = null;
  wantJson = true;
  let v;
  try {
    v = validateItem(collection, raw);
  } finally {
    wantJson = false;
  }
  // The JSON POST wrote for this very record (identity: never one a nested validation left), else ours.
  const json = !v ? undefined : postJson !== null && postJson.item === v ? postJson.json : jsonOf(v);
  postJson = null;
  return [v, json];
}

/**
 * Array of records → { items, dropped }. First occurrence of an id wins. With { memo }, records
 * already validated (same JSON) are not validated again, and the memo then holds this collection's
 * records only (records that are gone are forgotten).
 */
export function validateCollection(collection, items, { max = schemaOf(collection) && hasOwn(LIMITS, collection) ? LIMITS[collection] : 10000, memo = null } = {}) {
  if (!Array.isArray(items)) return { items: [], dropped: 0 };
  const table = memoTable(memo, collection);
  const next = table ? new Map() : null;
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of items) {
    if (out.length >= max) {
      dropped++;
      continue;
    }
    let it;
    let json;
    if (table) [it, json] = validateKnown(collection, raw, table);
    else it = validateItem(collection, raw);
    if (!it || seen.has(it.id)) {
      dropped++;
      continue;
    }
    seen.add(it.id);
    if (next && json !== undefined) next.set(it.id, json);
    out.push(it);
  }
  if (next) memoState.get(memo).tables.set(collection, next);
  return { items: out, dropped };
}

// ---------------------------------------------------------------- settings

/** Defaults for every known setting (the browser store overrides weekStart from the locale). */
export const SETTINGS_DEFAULTS = {
  theme: 'system', // 'system' | 'light' | 'dim' | 'dark'
  accent: 'iris',
  weekStart: 0,
  timeFormat: 'auto', // 'auto' | '12h' | '24h'
  defaultEventMinutes: 60,
  defaultTaskMinutes: 30,
  dayStartHour: 8,
  showTasksInSchedule: true,
  hiddenTaskLists: [], // list ids (or 'inbox') whose tasks are hidden in schedule
  scheduleView: 'week',
  scheduleDays: 4,
  scheduleNavCollapsed: false,
  showWeekends: true,
  showEventsInToday: true,
  completionSound: true,
  taskSort: {}, // view key \u2192 'manual' | 'date' | 'priority' | 'alpha' | 'created'
  reduceMotion: false,
};

const enumOf = (...vals) => (v) => (vals.includes(v) ? v : undefined);
const word = (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(v) ? v : undefined);
const boolSetting = (v) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const intSetting = (min, max) => (v) => intIn(v, min, max, null) ?? undefined;
/** A time of day 'HH:MM' (00:00–23:59), exactly as the server reads it (server/core.mjs HHMM_RE). */
const hhmmSetting = (v) => (isHHMM(v) ? v : undefined);
const SORT_MODES = ['manual', 'date', 'priority', 'alpha', 'created'];

/** Validators for known settings: return the clean value or undefined (invalid → ignored). */
export const SETTINGS_SCHEMA = {
  theme: enumOf('system', 'light', 'dim', 'dark'),
  accent: word,
  weekStart: intSetting(0, 6),
  timeFormat: enumOf('auto', '12h', '24h'),
  defaultEventMinutes: intSetting(5, 1440),
  defaultTaskMinutes: intSetting(5, 1440),
  dayStartHour: intSetting(0, 23),
  showTasksInSchedule: boolSetting,
  hiddenTaskLists: (v) => (Array.isArray(v) ? idList(v) : undefined),
  scheduleView: word,
  scheduleDays: intSetting(2, 7),
  scheduleNavCollapsed: boolSetting,
  showWeekends: boolSetting,
  showEventsInToday: boolSetting,
  completionSound: boolSetting,
  taskSort: (v) => {
    if (!isPlainObject(v)) return undefined;
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n >= 500) break;
      // Not only __proto__ & co.: an own 'toString' (or any Object.prototype name) makes the object unprintable.
      if (isReservedName(k) || k.length > 120 || HAS_CTRL_RE.test(k)) continue;
      if (SORT_MODES.includes(v[k])) {
        out[k] = v[k];
        n++;
      }
    }
    return out;
  },
  reduceMotion: boolSetting,
  // Working hours (Settings > Schedule). The AI tools plan and look for free time within them
  // (server/core.mjs effectiveSettings: 09:00–17:00 while unset, or when the two make no range). No
  // default here, so an unset pair stays "the default" for get_context. server/validate.mjs's built-in
  // fallback accepts the same values.
  scheduleWorkStart: hhmmSetting,
  scheduleWorkEnd: hhmmSetting,
};

/**
 * Settings owned by one app can be added without a schema change by prefixing the key with the
 * app ('notesView', 'aiPanelOpen', 'uiDensity' …). Their values must be scalars. A key that is in
 * SETTINGS_SCHEMA is checked by its own validator even when it has such a prefix (scheduleWorkStart).
 */
const EXT_KEY_RE = /^(notes|tasks|schedule|home|ai|ui|shell)[A-Z][A-Za-z0-9]{0,39}$/;
const extValue = (v) =>
  v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : typeof v === 'string' && v.length <= 200 ? cleanLine(v, 200) : undefined;

/**
 * Add validators for new settings keys (call identically in browser and server). Throws, changing
 * nothing, for a non-object, a value that is not a function or an Object.prototype name as the key.
 */
export function extendSettingsSchema(fields) {
  if (fields == null) return;
  if (!isPlainObject(fields)) throw new Error('Bad settings fields: expected an object of validators');
  const entries = Object.entries(fields);
  for (const [k, fn] of entries) {
    if (isReservedName(k) || typeof fn !== 'function') throw new Error(`Bad settings field: ${k.slice(0, 40)}`);
  }
  for (const [k, fn] of entries) SETTINGS_SCHEMA[k] = fn;
}

/** A settings validator's verdict; one that throws (an added validator) counts as invalid. */
function settingValue(k, v) {
  try {
    return SETTINGS_SCHEMA[k](v);
  } catch {
    return undefined;
  }
}

/** Keep only known (or app-prefixed scalar) keys whose values pass their type check. Never throws. */
export function validateSettingsPatch(patch) {
  const out = {};
  if (!isPlainObject(patch)) return out;
  let ext = 0;
  for (const k of Object.keys(patch)) {
    if (isForbiddenKey(k)) continue;
    if (hasOwn(SETTINGS_SCHEMA, k)) {
      const v = settingValue(k, patch[k]);
      if (v !== undefined) out[k] = v;
    } else if (EXT_KEY_RE.test(k) && ext < 100) {
      const v = extValue(patch[k]);
      if (v !== undefined) {
        out[k] = v;
        ext++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- snapshots & ops

/**
 * A backup file ({app:'ecosys', tasks:[…], …, settings}) or a server state ({data:{…}, settings})
 * → { data: {collection: items} (only collections present, or all with {all:true}), settings, dropped, counts }.
 * { memo }: see createValidationMemo.
 */
export function validateSnapshot(input, { all = false, memo = null } = {}) {
  if (!isPlainObject(input)) throw new Error('Not an ecosys data object.');
  const src = isPlainObject(input.data) ? input.data : input;
  const data = {};
  const counts = {};
  let dropped = 0;
  for (const c of COLLECTIONS) {
    if (hasOwn(src, c) && Array.isArray(src[c])) {
      const r = validateCollection(c, src[c], { memo });
      data[c] = r.items;
      counts[c] = r.items.length;
      dropped += r.dropped;
    } else if (all) {
      data[c] = [];
      counts[c] = 0;
    }
  }
  const settings = hasOwn(input, 'settings') ? validateSettingsPatch(input.settings) : {};
  return { data, settings, dropped, counts };
}

/**
 * One sync op → sanitized op, or null if it is invalid. opts.memo: see createValidationMemo (any
 * other second argument is ignored, so ops.map(validateOp) still works).
 */
export function validateOp(op, opts) {
  if (!isPlainObject(op)) return null;
  const memo = opts !== null && typeof opts === 'object' ? opts.memo : null;
  switch (op.op) {
    case 'put': {
      if (!COLLECTIONS.includes(op.c)) return null;
      const table = memoTable(memo, op.c);
      let item;
      if (table) {
        const [v, json] = validateKnown(op.c, op.item, table);
        if (v && json !== undefined) table.set(v.id, json);
        item = v;
      } else item = validateItem(op.c, op.item);
      return item ? { op: 'put', c: op.c, item } : null;
    }
    case 'del':
      return COLLECTIONS.includes(op.c) && isId(op.id) ? { op: 'del', c: op.c, id: op.id } : null;
    case 'settings': {
      const patch = validateSettingsPatch(op.patch);
      return Object.keys(patch).length ? { op: 'settings', patch } : null;
    }
    case 'replace':
      if (!COLLECTIONS.includes(op.c) || !Array.isArray(op.items)) return null;
      return { op: 'replace', c: op.c, items: validateCollection(op.c, op.items, { memo }).items };
    default:
      return null;
  }
}

/** Array of ops → valid ops only (at most `max`). */
export function validateOps(ops, { max = 5000 } = {}) {
  if (!Array.isArray(ops)) return [];
  const out = [];
  for (const op of ops.slice(0, max)) {
    const v = validateOp(op);
    if (v) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- HTML

/** Elements allowed in notes. Extend (identically in browser and server) for new block types. */
export const NOTE_TAGS = new Set(['p', 'br', 'div', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'hr', 'span']);
/** Class names allowed on note elements. */
export const NOTE_CLASSES = new Set(['checklist', 'checked', 'todo', 'hl']);
/** data-* attributes that link to other records; values must pass isId(). */
export const LINK_ATTRS = new Set(['data-task', 'data-event', 'data-note']);

const VOID_OUT = new Set(['br', 'hr']);
const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'image', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'frame']);
// Content of these is raw text in HTML (never markup) — skipped up to the matching end tag.
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title', 'plaintext']);
// Dropped together with everything inside them.
const DROP_CONTENT = new Set(['svg', 'math', 'template', 'object', 'applet', 'select', 'head', 'frameset', 'audio', 'video', 'canvas', 'map', 'datalist']);
const FOREIGN = new Set(['svg', 'math']); // only these honour a self-closing "/>"
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr']);
const HEADINGS = new Set(['h1', 'h2', 'h3']);
const MAX_DEPTH = 64;

const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', semi: ';', sol: '/', bsol: '\\', Tab: '\t', NewLine: '\n',
  lpar: '(', rpar: ')', period: '.', comma: ',', excl: '!', quest: '?', num: '#', percnt: '%', equals: '=', plus: '+', hyphen: '-', dash: '-',
  lowbar: '_', commat: '@', grave: '`', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}', vert: '|', ast: '*', dollar: '$', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7', divide: '\u00f7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
};

function codePoint(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(n);
}

/** Decode numeric references (with or without ';') and the common named ones (with ';'). */
export function decodeEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return typeof s === 'string' ? s : '';
  return s.replace(/&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g, (m, dec, hex, name) => {
    if (dec) return codePoint(parseInt(dec, 10));
    if (hex) return codePoint(parseInt(hex, 16));
    return hasOwn(NAMED, name) ? NAMED[name] : m;
  });
}

/** Escape a string for HTML text or a double-quoted attribute (numbers are written out, objects give ''). */
export function escapeHtml(s) {
  return safeString(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Text keeps valid entity references as written ("entities preserved"); a bare & becomes &amp;.
const escText = (s) => s.replace(/&(?!(?:#\d{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Allowed link targets: http(s), mailto and internal ecosys: links. Returns the clean URL or null. */
export function cleanHref(raw) {
  const input = safeString(raw);
  // Cheap guard first: never run decoding or trimming over huge strings (anything this long is rejected anyway).
  if (input.length > 8192) return null;
  let u = decodeEntities(input).replace(/[\t\n\r]/g, '');
  // Trim C0 controls and spaces with a linear scan (a `[\u0000- ]+$` regex is quadratic on "x   …   x").
  let a = 0;
  let b = u.length;
  while (a < b && u.charCodeAt(a) <= 0x20) a++;
  while (b > a && u.charCodeAt(b - 1) <= 0x20) b--;
  u = u.slice(a, b);
  if (!u || u.length > 2048) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (!m) return null; // relative / protocol-relative URLs are not allowed in notes
  const scheme = m[1].toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(u)) return null;
  if (scheme === 'http' || scheme === 'https') return /^https?:\/\/[^\s/?#]+/i.test(u) ? u : null;
  if (scheme === 'mailto') return u.length > 7 ? u : null;
  if (scheme === 'ecosys') return /^ecosys:[A-Za-z0-9_\-./@?=&#%:]{1,300}$/.test(u) ? u : null;
  return null;
}

/** Parse the tag that starts at `p` (first char of its name). Returns null at end of input. */
function readTag(s, p) {
  const n = s.length;
  let j = p;
  while (j < n && !isWs(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
  const name = s.slice(p, j).toLowerCase();
  const attrs = [];
  let selfClosing = false;
  for (;;) {
    while (j < n && isWs(s[j])) j++;
    if (j >= n) return null;
    if (s[j] === '>') {
      j++;
      break;
    }
    if (s[j] === '/') {
      j++;
      if (s[j] === '>') {
        selfClosing = true;
        j++;
        break;
      }
      continue;
    }
    let k = j;
    if (s[k] === '=') k++;
    while (k < n && !isWs(s[k]) && s[k] !== '/' && s[k] !== '>' && s[k] !== '=') k++;
    const aname = s.slice(j, k).toLowerCase();
    j = k;
    while (j < n && isWs(s[j])) j++;
    let value = '';
    if (s[j] === '=') {
      j++;
      while (j < n && isWs(s[j])) j++;
      if (j >= n) return null;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0) return null;
        value = s.slice(j + 1, e);
        j = e + 1;
      } else if (q !== '>') {
        let e = j;
        while (e < n && !isWs(s[e]) && s[e] !== '>') e++;
        value = s.slice(j, e);
        j = e;
      }
    }
    if (aname && attrs.length < 64 && !attrs.some((a) => a.name === aname)) attrs.push({ name: aname, value });
  }
  return { name, attrs, selfClosing, end: j };
}

/** Index just past the end tag that closes raw-text element `name`, or the end of input. */
function skipRawText(s, p, name) {
  const re = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
  re.lastIndex = p;
  const m = re.exec(s);
  if (!m) return s.length;
  const gt = s.indexOf('>', m.index);
  return gt < 0 ? s.length : gt + 1;
}

function attrsFor(tag, attrs) {
  const parts = [];
  const get = (n) => attrs.find((a) => a.name === n)?.value;
  if (tag === 'a') {
    const href = get('href');
    const url = href != null ? cleanHref(href) : null;
    if (url) {
      parts.push(`href="${escAttr(url)}"`);
      if (/^https?:/i.test(url)) parts.push('rel="noopener noreferrer"');
    }
  }
  const cls = get('class');
  if (cls != null) {
    const keep = [...new Set(decodeEntities(cls).split(/[\s]+/).filter((c) => NOTE_CLASSES.has(c)))];
    if (keep.length) parts.push(`class="${keep.join(' ')}"`);
  }
  if (tag === 'li') {
    const v = get('data-checked');
    if (v != null) {
      const d = decodeEntities(v).trim().toLowerCase();
      if (d === 'true' || d === '' || d === '1') parts.push('data-checked="true"');
      else if (d === 'false' || d === '0') parts.push('data-checked="false"');
    }
  }
  for (const n of LINK_ATTRS) {
    const v = get(n);
    if (v != null && isId(decodeEntities(v).trim())) parts.push(`${n}="${decodeEntities(v).trim()}"`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

// A comment ends at the first "-->" or "--!>" (HTML tokenizer); one forward scan finds either.
const COMMENT_END = /--!?>/g;
// C0 controls except the HTML whitespace ones (tab, line feed, form feed, carriage return), and DEL.
// eslint-disable-next-line no-control-regex
const HTML_CTRL_RE = /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g;

/** The longest start of escaped text that fits in `room` characters, never cut inside a character reference or a surrogate pair. */
function cutText(e, room) {
  if (room <= 0) return '';
  let s = truncate(e, room);
  const amp = s.lastIndexOf('&');
  if (amp >= 0 && s.indexOf(';', amp) < 0) s = s.slice(0, amp); // escText leaves every & starting a complete reference
  return s;
}

/**
 * Notes HTML → safe HTML. Tokenizes the input (HTML5-style: comments, raw-text elements, quoted
 * attributes, end tags with attributes) and rebuilds it from allowlisted tags and attributes only.
 * Text is re-escaped, attribute values are decoded, checked and re-encoded, implied end tags are
 * made explicit and every element is closed, so the result parses back to the same tree.
 *
 * The result is at most `maxLength` characters: once the next piece of text or tag (plus the end
 * tags it would need) doesn't fit, the rest is dropped and the open elements are closed. Because the
 * limit applies to the output, sanitizeHtml(sanitizeHtml(x)) === sanitizeHtml(x) for every x.
 * Linear time in the input (which is also bounded, at 8 times maxLength). Input that is not a string
 * is read with safeString(): a number is its digits, an object or array is no HTML at all.
 */
export function sanitizeHtml(input, { maxLength = NOTE_HTML_MAX } = {}) {
  const limit = maxLength >= 0 ? Math.floor(maxLength) : 0;
  let s = safeString(input);
  if (s.length > limit * 8 + 4096) s = s.slice(0, limit * 8 + 4096);
  s = s.replace(HTML_CTRL_RE, '');
  const n = s.length;
  const out = [];
  const stack = [];
  let skip = 0;
  let skipTag = null;
  let used = 0; // characters written
  let reserved = 0; // characters the end tags of the open elements will take
  let full = false; // the output reached the limit: the rest of the input is dropped

  const emit = (str) => {
    out.push(str);
    used += str.length;
  };
  const room = () => limit - used - reserved;
  const closeTo = (idx) => {
    while (stack.length > idx) {
      const tag = `</${stack.pop()}>`;
      reserved -= tag.length;
      emit(tag);
    }
  };
  const text = (t) => {
    if (skip || !t) return;
    let e = escText(t);
    if (e.length > room()) {
      e = cutText(e, room());
      full = true;
    }
    if (e) emit(e);
  };
  const start = (t) => {
    const { name } = t;
    if (skip) {
      if (name === skipTag && !t.selfClosing) skip++;
      return;
    }
    if (DROP_CONTENT.has(name)) {
      if (!(t.selfClosing && FOREIGN.has(name)) && !HTML_VOID.has(name)) {
        skip = 1;
        skipTag = name;
      }
      return;
    }
    if (!NOTE_TAGS.has(name)) return; // unknown element: drop the tag, keep its text
    // Implied end tags, so the output means exactly what a browser would build from it.
    if (BLOCK.has(name)) {
      const p = stack.lastIndexOf('p');
      if (p >= 0) closeTo(p);
    }
    if (name === 'li') {
      const list = Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'));
      const li = stack.lastIndexOf('li');
      if (li > list) closeTo(li);
    }
    if (HEADINGS.has(name) && HEADINGS.has(stack[stack.length - 1])) closeTo(stack.length - 1);
    if (name === 'a') {
      const a = stack.lastIndexOf('a');
      if (a >= 0) closeTo(a);
    }
    const isVoid = VOID_OUT.has(name);
    if (!isVoid && stack.length >= MAX_DEPTH) return;
    const tag = `<${name}${attrsFor(name, t.attrs)}>`;
    const close = isVoid ? 0 : name.length + 3;
    if (tag.length + close > room()) {
      full = true;
      return;
    }
    emit(tag);
    if (!isVoid) {
      stack.push(name);
      reserved += close;
    }
  };
  const end = (name) => {
    if (skip) {
      if (name === skipTag && --skip === 0) skipTag = null;
      return;
    }
    if (!NOTE_TAGS.has(name) || VOID_OUT.has(name)) return;
    const idx = stack.lastIndexOf(name);
    if (idx >= 0) closeTo(idx);
  };

  let i = 0;
  while (i < n && !full) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      text(s.slice(i));
      break;
    }
    if (lt > i) text(s.slice(i, lt));
    if (full) break;
    i = lt;
    const c = s[i + 1];
    if (c === '!') {
      if (s.startsWith('<!--', i)) {
        if (s.startsWith('<!-->', i)) i += 5;
        else if (s.startsWith('<!--->', i)) i += 6;
        else {
          COMMENT_END.lastIndex = i + 4;
          const m = COMMENT_END.exec(s);
          i = m ? m.index + m[0].length : n;
        }
      } else {
        const gt = s.indexOf('>', i + 2); // doctype, CDATA, bogus comment
        i = gt < 0 ? n : gt + 1;
      }
      continue;
    }
    if (c === '?') {
      const gt = s.indexOf('>', i + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (c === '/') {
      const nc = s[i + 2];
      if (nc !== undefined && isAlpha(nc)) {
        const t = readTag(s, i + 2);
        if (!t) break; // end of input inside a tag: drop it
        end(t.name);
        i = t.end;
      } else if (nc === '>') i += 3;
      else {
        const gt = s.indexOf('>', i + 2);
        i = gt < 0 ? n : gt + 1;
      }
      continue;
    }
    if (c !== undefined && isAlpha(c)) {
      const t = readTag(s, i + 1);
      if (!t) break;
      i = t.end;
      if (RAW_TEXT.has(t.name)) {
        i = t.name === 'plaintext' ? n : skipRawText(s, i, t.name);
        continue;
      }
      start(t);
      continue;
    }
    text('<');
    i++;
  }
  closeTo(0);
  return wellFormed(out.join(''));
}

/** Notes HTML → plain text (block boundaries become line breaks; entities decoded). */
export function htmlToText(html) {
  const safe = sanitizeHtml(html);
  return decodeEntities(
    safe
      .replace(/<br>|<hr>/g, '\n')
      .replace(/<li[^>]*>/g, '\n- ')
      .replace(/<\/(p|div|h1|h2|h3|pre|blockquote|ul|ol)>/g, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(trimEndSpaces) // per-line scan; a `[ \t]+\n` regex is quadratic on long runs of spaces
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function trimEndSpaces(line) {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 0x09) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}
