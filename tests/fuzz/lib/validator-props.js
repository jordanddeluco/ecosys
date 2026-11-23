// Properties of the shared/sanitize.js validators (validateItem, validateCollection, validateOp(s),
// validateSnapshot, validateSettingsPatch). Run in-process by tests/fuzz/validators.fuzz.test.js
// (with the notes schema registered, as in the notes app) and in a child process via
// lib/child-runner.mjs (stage-1 schema only: shared/sanitize.js on its own, as the server's loader imports it).
import * as S from '../../../shared/sanitize.js';
import { fail, check, jsonEqual, sameContent, firstDiff, show, defineOwn } from './harness.js';
import { checkSanitized } from './html-check.js';
import { nearValidRecord, jsonValue, jsonObject, pollution, obj, hostileString, COLLECTION_NAMES, BAD_COLLECTIONS, FORBIDDEN, VALID_IDS, BAD_IDS } from './json-gen.js';

const { validateItem, validateCollection, validateOp, validateOps, validateSnapshot, validateSettingsPatch, schemaFields, isYmd, isHHMM, isDateTime } = S;
const ITEM_MAX = S.ITEM_JSON_MAX ?? 512 * 1024;
const LIMITS = S.LIMITS ?? {};
const COLORS = S.COLORS;
const FREQS = ['day', 'week', 'month', 'year'];
const SORT_MODES = ['manual', 'date', 'priority', 'alpha', 'created'];
const EXT_KEY_RE = /^(notes|tasks|schedule|home|ai|ui|shell)[A-Z][A-Za-z0-9]{0,39}$/;
const ID_RE = /^[a-z0-9_-]{1,40}$/i;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
// eslint-disable-next-line no-control-regex
const LINE_BAD = new RegExp(`[\\u0000-\\u001F\\u007F${LS}${PS}]`);
// eslint-disable-next-line no-control-regex
const TEXT_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const notesSchemaRegistered = () => schemaFields('notes').includes('blocks');
export const describeEnv = () => ({ notesSchema: notesSchemaRegistered(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });

// ---------------------------------------------------------------- generic checks

const PROTO_BEFORE = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
const OBJ_BEFORE = Object.getOwnPropertyNames(Object).sort().join(',');
export function assertNoPollution() {
  const now = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  if (now !== PROTO_BEFORE) fail('pollution', `Object.prototype gained keys: ${now}`);
  if (Object.getOwnPropertyNames(Object).sort().join(',') !== OBJ_BEFORE) fail('pollution', 'Object gained static keys');
  // eslint-disable-next-line no-proto
  if ({}.polluted !== undefined || [].polluted !== undefined || (() => {}).polluted !== undefined) fail('pollution', 'a prototype has a "polluted" property');
}

/** Path of the first own forbidden key / non-plain prototype in a JSON-like value, or null. */
function badKeyPath(v, path = '$', seen = new Set()) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || v === undefined) return `${path} is ${typeof v}`;
    if (typeof v === 'number' && !Number.isFinite(v)) return `${path} is ${v}`;
    return null;
  }
  if (seen.has(v)) return `${path} is a shared reference`;
  seen.add(v);
  if (!Array.isArray(v)) {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return `${path} has a non-plain prototype`;
  }
  for (const k of Object.keys(v)) {
    if (FORBIDDEN.includes(k)) return `${path}.${k} (forbidden key)`;
    const r = badKeyPath(v[k], `${path}.${k}`, seen);
    if (r) return r;
  }
  return null;
}

const isTs = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const lineOk = (v, max) => typeof v === 'string' && v.length <= max && !LINE_BAD.test(v) && v.isWellFormed();
const textOk = (v, max) => typeof v === 'string' && v.length <= max && !TEXT_BAD.test(v) && v.isWellFormed();
const refOk = (v) => v === null || (typeof v === 'string' && ID_RE.test(v));
const optRefOk = (v) => v === undefined || (typeof v === 'string' && ID_RE.test(v));
const ymdOrNull = (v) => v === null || isYmd(v);
const numOk = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15;

export function ruleProblem(r) {
  if (r === null) return null;
  if (!S.isPlainObject(r)) return 'rule is not an object';
  const order = ['freq', 'interval', 'days', 'monthDay', 'month', 'from'];
  const keys = Object.keys(r);
  if (keys.some((k) => !order.includes(k))) return `unknown rule key in ${show(keys)}`;
  if (keys.join() !== order.filter((k) => k in r).join()) return `rule keys out of order: ${show(keys)}`;
  if (!FREQS.includes(r.freq)) return `freq ${show(r.freq)}`;
  if (!isInt(r.interval, 1, S.REPEAT_INTERVAL_MAX ?? 999)) return `interval ${show(r.interval)}`; // 1-99 since intervals are capped like the server's
  if ('days' in r && (r.freq !== 'week' || !Array.isArray(r.days) || !r.days.length || r.days.some((d, i) => !isInt(d, 0, 6) || (i && d <= r.days[i - 1])))) return `days ${show(r.days)} (freq ${r.freq})`;
  if ('monthDay' in r && (!['month', 'year'].includes(r.freq) || !isInt(r.monthDay, 1, 31))) return `monthDay ${show(r.monthDay)} (freq ${r.freq})`;
  if ('month' in r && (r.freq !== 'year' || !isInt(r.month, 1, 12))) return `month ${show(r.month)} (freq ${r.freq})`;
  if ('from' in r && r.from !== 'due' && r.from !== 'done') return `from ${show(r.from)}`;
  return null;
}

function tagsProblem(v) {
  if (!Array.isArray(v)) return 'tags is not an array';
  if (v.length > 100) return `${v.length} tags`;
  const seen = new Set();
  for (const t of v) {
    if (!lineOk(t, 60) || !t || t !== t.trim()) return `bad tag ${show(t)}`;
    if (seen.has(t)) return `duplicate tag ${show(t)}`;
    seen.add(t);
  }
  return null;
}

function checklistProblem(v) {
  if (!Array.isArray(v)) return 'checklist is not an array';
  if (v.length > 300) return `${v.length} steps`;
  const ids = new Set();
  for (const s of v) {
    if (!S.isPlainObject(s) || Object.keys(s).join() !== 'id,title,done') return `step shape ${show(s)}`;
    if (!ID_RE.test(s.id) || ids.has(s.id)) return `step id ${show(s.id)} invalid or repeated`;
    ids.add(s.id);
    if (!lineOk(s.title, 500)) return `step title ${show(s.title, 80)}`;
    if (typeof s.done !== 'boolean') return `step done ${show(s.done)}`;
  }
  return null;
}

const htmlOk = (v) => typeof v === 'string' && !checkSanitized(v, { allowedTags: S.NOTE_TAGS, noteClasses: S.NOTE_CLASSES, linkAttrs: S.LINK_ATTRS }) && S.sanitizeHtml(v) === v;

/** Independent per-field expectations (stage-1 schemas). `opt` keys may be absent. */
const SPECS = {
  tasks: {
    id: (v) => ID_RE.test(v), title: (v) => lineOk(v, 500), notes: (v) => textOk(v, 20000), listId: refOk, tags: (v) => !tagsProblem(v) || tagsProblem(v),
    priority: (v) => isInt(v, 0, 3), date: ymdOrNull, time: (v) => v === null || isHHMM(v), duration: (v) => v === null || isInt(v, 1, 10080), deadline: ymdOrNull,
    repeat: (v) => !ruleProblem(v) || ruleProblem(v), checklist: (v) => !checklistProblem(v) || checklistProblem(v), done: (v) => typeof v === 'boolean',
    completedAt: (v) => v === null || isTs(v), order: numOk, repeatOf: optRefOk, createdAt: isTs, updatedAt: isTs,
    source: (v) => v === undefined || (S.isPlainObject(v) && v.app === 'notes' && ID_RE.test(v.noteId) && (v.blockId === undefined || ID_RE.test(v.blockId))),
    opt: ['repeatOf', 'source'],
  },
  lists: { id: (v) => ID_RE.test(v), name: (v) => lineOk(v, 200), color: (v) => COLORS.includes(v), icon: (v) => typeof v === 'string' && /^[a-z0-9-]{0,40}$/.test(v), order: numOk, createdAt: isTs, updatedAt: isTs },
  events: {
    id: (v) => ID_RE.test(v), title: (v) => lineOk(v, 500), calendarId: refOk, allDay: (v) => typeof v === 'boolean', start: (v) => typeof v === 'string', end: (v) => typeof v === 'string',
    location: (v) => lineOk(v, 500), notes: (v) => textOk(v, 20000), repeat: (v) => !ruleProblem(v) || ruleProblem(v),
    exdates: (v) => Array.isArray(v) && v.length <= 2000 && v.every((d, i) => isYmd(d) && (!i || d > v[i - 1])), until: ymdOrNull, seriesId: optRefOk, occurrence: (v) => v === undefined || isYmd(v),
    createdAt: isTs, updatedAt: isTs, opt: ['seriesId', 'occurrence'],
  },
  calendars: { id: (v) => ID_RE.test(v), name: (v) => lineOk(v, 200), color: (v) => COLORS.includes(v), visible: (v) => typeof v === 'boolean', order: numOk, createdAt: isTs, updatedAt: isTs },
  notes: {
    id: (v) => ID_RE.test(v), title: (v) => lineOk(v, 500), body: htmlOk, folderId: refOk, pinned: (v) => typeof v === 'boolean', color: (v) => v === null || COLORS.includes(v),
    tags: (v) => !tagsProblem(v) || tagsProblem(v), order: numOk, trashedAt: (v) => v === null || isTs(v), createdAt: isTs, updatedAt: isTs,
  },
  folders: { id: (v) => ID_RE.test(v), name: (v) => lineOk(v, 200), color: (v) => v === null || COLORS.includes(v), icon: (v) => typeof v === 'string' && /^[a-z0-9-]{0,40}$/.test(v), parentId: refOk, order: numOk, createdAt: isTs, updatedAt: isTs },
};

/** Everything a validated record must satisfy (`order`: also require the schema's canonical key order). */
export function checkRecord(c, out, { order = false } = {}) {
  check(S.isPlainObject(out) && Object.getPrototypeOf(out) === Object.prototype, 'shape', () => `validateItem returned ${show(out, 200)}`);
  const bad = badKeyPath(out);
  check(!bad, 'unsafe-value', () => `output has ${bad}`);
  const fields = schemaFields(c);
  const keys = Object.keys(out);
  check(
    keys.every((k) => fields.includes(k)),
    'unknown-key',
    () => `keys ${show(keys.filter((k) => !fields.includes(k)))} are not in the schema`,
  );
  if (order) check(keys.join() === fields.filter((k) => k in out).join(), 'key-order', () => `key order ${show(keys)} differs from the schema ${show(fields)}`);
  check(ID_RE.test(out.id), 'id', () => `id ${show(out.id)}`);
  const spec = SPECS[c];
  const extended = notesSchemaRegistered() && (c === 'notes' || c === 'folders');
  if (spec && !extended) {
    for (const [k, fn] of Object.entries(spec)) {
      if (k === 'opt') continue;
      if (!(k in out)) {
        check((spec.opt || []).includes(k) || fn(undefined) === true, 'missing-key', `key ${k} is missing`);
        continue;
      }
      const r = fn(out[k]);
      check(r === true, `field:${k}`, () => `${c}.${k} = ${show(out[k], 160)}${typeof r === 'string' ? ` (${r})` : ''}`);
    }
  }
  if (c === 'events' && !extended) {
    if (out.allDay) check(isYmd(out.start) && isYmd(out.end) && out.end >= out.start, 'event-span', () => `all-day ${out.start} .. ${out.end}`);
    else check(isDateTime(out.start) && isDateTime(out.end) && out.end > out.start, 'event-span', () => `timed ${out.start} .. ${out.end}`);
    if (out.until) check(out.until >= out.start.slice(0, 10), 'until', () => `until ${out.until} before start ${out.start}`);
  }
  const json = JSON.stringify(out);
  check(sameContent(JSON.parse(json), out), 'json-unsafe', () => `JSON round trip changes the record: ${firstDiff(JSON.parse(json), out)}`);
  check(json.length <= ITEM_MAX, 'too-big', () => `record is ${json.length} chars of JSON (server limit ${ITEM_MAX})`);
}

// ---------------------------------------------------------------- properties

function itemProp(c) {
  return (raw) => {
    const before = JSON.stringify(raw);
    let out;
    try {
      out = validateItem(c, raw);
    } catch (err) {
      fail('throws', `validateItem('${c}') threw ${err?.name}: ${err?.message}`);
    }
    assertNoPollution();
    check(JSON.stringify(raw) === before, 'mutated-input', 'validateItem changed its input object');
    if (!S.isPlainObject(raw) || !(typeof raw.id === 'string' && ID_RE.test(raw.id))) {
      check(out === null, 'bad-id-accepted', () => `a record without a valid id was accepted: id=${show(raw?.id)}`);
      return;
    }
    if (out === null) return; // e.g. an event without a usable start
    checkRecord(c, out);
    const again = validateItem(c, out);
    check(sameContent(again, out), 'idempotent', () => `validateItem(validateItem(x)) differs: ${firstDiff(out, again)}`);
    const viaJson = validateItem(c, JSON.parse(JSON.stringify(out)));
    check(sameContent(viaJson, out), 'idempotent-json', () => `validating the JSON copy differs: ${firstDiff(out, viaJson)}`);
    assertNoPollution();
  };
}

/** Canonical form: keys in schema order, and validating again gives the identical JSON string (store/sync compare JSON strings). */
function canonicalProp(c) {
  return (raw) => {
    let out;
    try {
      out = validateItem(c, raw);
    } catch {
      return; // reported by the content property
    }
    if (out === null) return;
    checkRecord(c, out, { order: true });
    const a = JSON.stringify(out);
    const b = JSON.stringify(validateItem(c, out));
    check(a === b, 'json-idempotent', () => `JSON.stringify differs after a second validation:\n    once:  ${show(a, 300)}\n    twice: ${show(b, 300)}`);
  };
}

const itemGen = (c) => (rng) => (rng.chance(0.9) ? nearValidRecord(rng, c) : rng.chance(0.5) ? jsonObject(rng) : jsonValue(rng));

function opGen(rng) {
  const c = rng.chance(0.85) ? rng.pick(COLLECTION_NAMES) : rng.pick(BAD_COLLECTIONS);
  const kind = rng.weighted([[4, 'put'], [2, 'del'], [2, 'settings'], [1, 'replace'], [1, () => rng.pick(['x', '', '__proto__', 'constructor', null, 'PUT', 'eval'])]]);
  const entries = [['op', kind], ['c', c]];
  if (kind === 'put' || rng.chance(0.1)) entries.push(['item', rng.chance(0.9) ? nearValidRecord(rng, COLLECTION_NAMES.includes(c) ? c : 'tasks') : jsonValue(rng)]);
  if (kind === 'del' || rng.chance(0.1)) entries.push(['id', rng.chance(0.7) ? rng.pick(VALID_IDS) : rng.pick(BAD_IDS)]);
  if (kind === 'settings' || rng.chance(0.1)) entries.push(['patch', settingsGen(rng)]);
  if (kind === 'replace' || rng.chance(0.05)) entries.push(['items', rng.chance(0.9) ? rng.repeat(rng.small(6), () => nearValidRecord(rng, COLLECTION_NAMES.includes(c) ? c : 'tasks')) : jsonValue(rng)]);
  if (rng.chance(0.2)) entries.push([rng.pick(FORBIDDEN), pollution()]);
  return obj(rng.shuffle(entries));
}

function opProblem(op, out) {
  if (out === null) return null;
  if (!S.isPlainObject(out)) return `returned ${show(out, 120)}`;
  const bad = badKeyPath(out);
  if (bad) return `unsafe value at ${bad}`;
  const keys = Object.keys(out).join();
  switch (out.op) {
    case 'put':
      // (validateItem may mint ids / timestamps for repaired fields, so compare shapes, not a second call)
      if (keys !== 'op,c,item' || !S.COLLECTIONS.includes(out.c) || out.c !== op.c) return `put shape ${keys}`;
      if (!S.isPlainObject(op.item) || out.item.id !== op.item.id) return 'put item id differs from the input id';
      return null;
    case 'del':
      return keys === 'op,c,id' && S.COLLECTIONS.includes(out.c) && ID_RE.test(out.id) ? null : `del shape ${keys} id=${show(out.id)}`;
    case 'settings':
      return keys === 'op,patch' && Object.keys(out.patch).length && jsonEqual(out.patch, validateSettingsPatch(op.patch)) ? null : 'settings shape / patch differs';
    case 'replace':
      if (keys !== 'op,c,items' || !S.COLLECTIONS.includes(out.c) || !Array.isArray(out.items)) return `replace shape ${keys}`;
      return new Set(out.items.map((x) => x.id)).size === out.items.length ? null : 'replace items have duplicate ids';
    default:
      return `unknown op ${show(out.op)}`;
  }
}

const SETTING_VALUES = {
  theme: ['system', 'light', 'dim', 'dark', 'blue', '', null, 1],
  accent: ['iris', 'blue', 'a-1', 'Iris', '"><x>', 'x'.repeat(25), ''],
  weekStart: [0, 1, 6, 7, -1, '1', 1.5, null],
  timeFormat: ['auto', '12h', '24h', '13h', ''],
  defaultEventMinutes: [5, 60, 1440, 4, 1441, '30', 5e9],
  defaultTaskMinutes: [5, 30, 1440, 0, '15'],
  dayStartHour: [0, 8, 23, 24, '9', -1],
  showTasksInSchedule: [true, false, 'true', 'false', 1, 0, 'yes'],
  hiddenTaskLists: [[], ['inbox', 'L1'], ['"><x>', 'L1', 'L1'], 'L1', null],
  scheduleView: ['week', 'days', 'month', 'Week', '', 'x'.repeat(30)],
  scheduleDays: [2, 4, 7, 1, 8, '5', 5e9],
  scheduleNavCollapsed: [true, false, 'false'],
  showWeekends: [true, false, 0],
  showEventsInToday: [true, false, null],
  completionSound: [true, false, 'true'],
  taskSort: [{}, { today: 'date', inbox: 'alpha' }, { today: 'bogus' }, 'date', null],
  reduceMotion: [true, false, 'true', 1],
};

function settingsGen(rng) {
  const entries = [];
  const known = Object.keys(SETTING_VALUES);
  for (let i = rng.small(10); i > 0; i--) {
    const k = rng.pick(known);
    entries.push([k, rng.chance(0.85) ? rng.pick(SETTING_VALUES[k]) : jsonValue(rng, 2)]);
  }
  for (let i = rng.small(4); i > 0; i--) entries.push([rng.pick(['notesView', 'aiPanelOpen', 'uiDensity', 'tasksX', 'homeTile1', 'shellX', 'notes', 'notesX-y', 'evil', 'polluted', 'NotesView', `notes${'A'.repeat(41)}`]), rng.chance(0.7) ? rng.pick([true, 1, 'grid', null, 'x'.repeat(201), {}, [], 1e309, 'a\nb']) : jsonValue(rng, 2)]);
  if (rng.chance(0.3)) entries.push([rng.pick(FORBIDDEN), pollution()]);
  if (rng.chance(0.1)) entries.push(['taskSort', obj([['__proto__', 'date'], ['constructor', 'alpha'], ['today', 'date'], ['x'.repeat(121), 'date'], ['a\nb', 'date']])]);
  if (rng.chance(0.05)) entries.push(['hiddenTaskLists', Array.from({ length: rng.pick([1001, 5000]) }, (_, i) => `L${i}`)]);
  if (rng.chance(0.05)) for (let i = 0; i < 150; i++) entries.push([`notesKey${i}`, i]);
  return obj(rng.shuffle(entries));
}

function settingsProblem(out) {
  if (!S.isPlainObject(out)) return `returned ${show(out, 120)}`;
  const bad = badKeyPath(out);
  if (bad) return `unsafe value at ${bad}`;
  let ext = 0;
  for (const [k, v] of Object.entries(out)) {
    if (FORBIDDEN.includes(k)) return `forbidden key ${k}`;
    if (Object.hasOwn(SETTING_VALUES, k)) {
      const ok = {
        theme: () => ['system', 'light', 'dim', 'dark'].includes(v),
        accent: () => typeof v === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(v),
        weekStart: () => isInt(v, 0, 6),
        timeFormat: () => ['auto', '12h', '24h'].includes(v),
        defaultEventMinutes: () => isInt(v, 5, 1440),
        defaultTaskMinutes: () => isInt(v, 5, 1440),
        dayStartHour: () => isInt(v, 0, 23),
        hiddenTaskLists: () => Array.isArray(v) && v.length <= 1000 && v.every((x) => ID_RE.test(x)) && new Set(v).size === v.length,
        scheduleView: () => typeof v === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(v),
        scheduleDays: () => isInt(v, 2, 7),
        taskSort: () => S.isPlainObject(v) && Object.keys(v).length <= 500 && Object.entries(v).every(([sk, sv]) => !FORBIDDEN.includes(sk) && sk.length <= 120 && !LINE_BAD.test(sk) && SORT_MODES.includes(sv)),
      }[k];
      if (ok ? !ok() : typeof v !== 'boolean') return `${k} = ${show(v, 100)}`;
    } else if (Object.hasOwn(S.SETTINGS_SCHEMA, k)) {
      // a setting added with extendSettingsSchema(): only check it is JSON-safe (done above)
    } else {
      if (!EXT_KEY_RE.test(k)) return `unknown key ${show(k)}`;
      ext++;
      if (!(v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || lineOk(v, 200))) return `${k} = ${show(v, 100)}`;
    }
  }
  return ext > 100 ? `${ext} app-prefixed keys` : null;
}

function snapshotGen(rng) {
  const cols = rng.sample(COLLECTION_NAMES, rng.int(0, 6)).map((c) => [c, rng.chance(0.9) ? rng.repeat(rng.small(8), () => (rng.chance(0.8) ? nearValidRecord(rng, c) : jsonValue(rng, 1))) : jsonValue(rng, 1)]);
  if (rng.chance(0.2)) cols.push(['__proto__', obj([['tasks', [obj([['id', 'fromproto'], ['title', 'x']])]]])]);
  const extra = [];
  if (rng.chance(0.7)) extra.push(['settings', rng.chance(0.8) ? settingsGen(rng) : jsonValue(rng, 1)]);
  if (rng.chance(0.3)) extra.push(['app', 'ecosys'], ['version', rng.pick([1, 2, 'x'])]);
  if (rng.chance(0.2)) extra.push([rng.pick(FORBIDDEN), pollution()]);
  return rng.chance(0.4) ? obj(rng.shuffle([['data', rng.chance(0.9) ? obj(cols) : jsonValue(rng, 1)], ['rev', rng.int(0, 99)], ...extra])) : obj(rng.shuffle([...cols, ...extra]));
}

export const properties = [
  ...COLLECTION_NAMES.map((c) => ({
    name: `validateItem('${c}'): never throws; rejects bad ids; output is schema-only, typed, bounded, JSON-safe, idempotent; no prototype pollution`,
    runs: c === 'tasks' || c === 'events' || c === 'notes' ? 1500 : 700,
    gen: itemGen(c),
    prop: itemProp(c),
    shrink: 'value',
  })),
  ...COLLECTION_NAMES.map((c) => ({
    name: `validateItem('${c}') canonical form: keys in schema order and a second validation gives the identical JSON`,
    runs: 400,
    gen: itemGen(c),
    prop: canonicalProp(c),
    shrink: 'value',
  })),
  {
    name: 'validateItem: unknown or prototype-named collections give null and never pollute',
    runs: 800,
    gen: (rng) => ({ c: rng.pick(BAD_COLLECTIONS), raw: nearValidRecord(rng, rng.pick(COLLECTION_NAMES)) }),
    prop: ({ c, raw }) => {
      let out;
      try {
        out = validateItem(c, raw);
      } catch (err) {
        fail('throws', `threw ${err?.message}`);
      }
      check(out === null, 'accepted', () => `collection ${show(c)} accepted a record`);
      assertNoPollution();
    },
    shrink: 'value',
  },
  {
    name: 'validateCollection: unique ids, every item valid, dropped + kept = input length',
    runs: 600,
    gen: (rng) => {
      const c = rng.pick(COLLECTION_NAMES);
      const base = rng.repeat(rng.small(12), () => nearValidRecord(rng, c));
      return { c, items: rng.chance(0.9) ? [...base, ...rng.sample(base, rng.int(0, base.length)), ...rng.repeat(rng.small(3), () => jsonValue(rng, 1))] : jsonValue(rng, 1) };
    },
    prop: ({ c, items }) => {
      let r;
      try {
        r = validateCollection(c, items);
      } catch (err) {
        fail('throws', `threw ${err?.message}`);
      }
      assertNoPollution();
      check(S.isPlainObject(r) && Array.isArray(r.items) && Number.isInteger(r.dropped), 'shape', () => show(r, 200));
      if (!Array.isArray(items)) return check(r.items.length === 0 && r.dropped === 0, 'non-array', 'a non-array gave items');
      check(new Set(r.items.map((x) => x.id)).size === r.items.length, 'dupes', 'duplicate ids kept');
      check(r.items.length + r.dropped === items.length, 'count', () => `${r.items.length} kept + ${r.dropped} dropped != ${items.length}`);
      for (const it of r.items) checkRecord(c, it);
    },
    shrink: 'value',
  },
  {
    name: 'validateOp: never throws; null or an exact {put|del|settings|replace} shape; idempotent; no pollution',
    runs: 2500,
    gen: opGen,
    prop: (op) => {
      let out;
      try {
        out = validateOp(op);
      } catch (err) {
        fail('throws', `validateOp threw ${err?.name}: ${err?.message}`);
      }
      assertNoPollution();
      const p = opProblem(op, out);
      check(!p, 'shape', () => p);
      if (out) {
        if (out.op === 'put') checkRecord(out.c, out.item);
        if (out.op === 'replace') for (const it of out.items) checkRecord(out.c, it);
        if (out.op === 'settings') check(!settingsProblem(out.patch), 'settings', () => settingsProblem(out.patch));
        const again = validateOp(out);
        check(sameContent(again, out), 'idempotent', () => `validateOp(validateOp(x)) differs: ${firstDiff(out, again)}`);
      }
    },
    shrink: 'value',
  },
  {
    name: 'validateOps: never throws, keeps at most 5000 ops, every kept op is a fixed point of validateOp',
    runs: 300,
    gen: (rng) => (rng.chance(0.9) ? rng.repeat(rng.small(30), opGen) : jsonValue(rng, 1)),
    prop: (ops) => {
      let out;
      try {
        out = validateOps(ops);
      } catch (err) {
        fail('throws', `validateOps threw ${err?.message}`);
      }
      assertNoPollution();
      check(Array.isArray(out), 'shape', 'not an array');
      check(out.length <= Math.min(5000, Array.isArray(ops) ? ops.length : 0), 'count', () => `${out.length} ops kept`);
      for (const o of out) check(sameContent(validateOp(o), o), 'fixed-point', () => `kept op is not stable: ${show(o, 200)}`);
    },
    shrink: 'value',
  },
  {
    name: 'validateSnapshot: never throws on objects; counts add up; prototype-keyed containers are ignored; settings validated',
    runs: 800,
    gen: snapshotGen,
    prop: (input) => {
      const all = JSON.stringify(input).length % 2 === 0;
      let r;
      try {
        r = validateSnapshot(input, { all });
      } catch (err) {
        fail('throws', `validateSnapshot threw ${err?.name}: ${err?.message}`);
      }
      assertNoPollution();
      check(S.isPlainObject(r) && S.isPlainObject(r.data) && S.isPlainObject(r.settings) && S.isPlainObject(r.counts) && Number.isInteger(r.dropped) && r.dropped >= 0, 'shape', () => show(r, 200));
      const src = S.isPlainObject(input.data) ? input.data : input;
      let total = 0;
      for (const c of Object.keys(r.data)) {
        check(S.COLLECTIONS.includes(c), 'collection', `unknown collection ${c}`);
        check(r.counts[c] === r.data[c].length, 'counts', `counts.${c} != data.${c}.length`);
        if (Object.hasOwn(src, c) && Array.isArray(src[c])) total += src[c].length;
        for (const it of r.data[c]) checkRecord(c, it);
        check(!r.data[c].some((it) => it.id === 'fromproto'), 'proto-container', 'records under a "__proto__" key were imported');
      }
      if (all) check(Object.keys(r.data).join() === S.COLLECTIONS.join(), 'all', () => `all:true gave ${Object.keys(r.data)}`);
      const kept = Object.values(r.data).reduce((n, a) => n + a.length, 0);
      check(kept + r.dropped === total, 'dropped', () => `${kept} kept + ${r.dropped} dropped != ${total} input records`);
      check(!settingsProblem(r.settings), 'settings', () => settingsProblem(r.settings));
      check(jsonEqual(r.settings, Object.hasOwn(input, 'settings') ? validateSettingsPatch(input.settings) : {}), 'settings-src', 'settings do not come from input.settings');
    },
    shrink: 'value',
  },
  {
    name: 'validateSnapshot: non-object input fails with a clear Error, not a crash',
    test() {
      for (const v of [null, undefined, 0, 'x', [], [obj([['tasks', []]])], true, Object.create(Array.prototype)]) {
        let err = null;
        try {
          validateSnapshot(v);
        } catch (e) {
          err = e;
        }
        check(err instanceof Error && !(err instanceof TypeError) && /ecosys/i.test(err.message), 'error', () => `validateSnapshot(${show(v)}) → ${err ? `${err.name}: ${err.message}` : 'no error'}`);
      }
    },
  },
  {
    name: 'validateSettingsPatch: never throws; only known or app-prefixed keys with valid values; idempotent; no pollution',
    runs: 2500,
    gen: (rng) => (rng.chance(0.9) ? settingsGen(rng) : jsonValue(rng, 1)),
    prop: (patch) => {
      let out;
      try {
        out = validateSettingsPatch(patch);
      } catch (err) {
        fail('throws', `validateSettingsPatch threw ${err?.message}`);
      }
      assertNoPollution();
      const p = settingsProblem(out);
      check(!p, 'value', () => p);
      check(jsonEqual(validateSettingsPatch(out), out), 'idempotent', () => `not idempotent: ${firstDiff(out, validateSettingsPatch(out))}`);
      if (S.isPlainObject(patch)) {
        for (const k of ['theme', 'timeFormat']) if (Object.hasOwn(patch, k) && ['system', 'light', 'dim', 'dark', 'auto', '12h', '24h'].includes(patch[k]) && S.SETTINGS_SCHEMA[k](patch[k]) !== undefined) check(out[k] === patch[k], 'dropped-valid', `valid ${k} dropped`);
      }
    },
    shrink: 'value',
  },
  {
    name: 'huge arrays and objects are capped and validated in < 1.5 s each',
    test() {
      const big = (n, f) => Array.from({ length: n }, (_, i) => f(i));
      const cases = [
        ['tasks: 1e6 tags', () => validateItem('tasks', { id: 't1', tags: big(1e6, (i) => `t${i}`) }), (o) => o.tags.length <= 100],
        ['tasks: 1e5 checklist steps', () => validateItem('tasks', { id: 't1', checklist: big(1e5, (i) => ({ id: `s${i}`, title: 'x', done: false })) }), (o) => o.checklist.length <= 300],
        ['events: 1e6 junk exdates', () => validateItem('events', { id: 'e1', start: '2026-11-22', allDay: true, exdates: big(1e6, (i) => `x${i}`) }), (o) => o.exdates.length === 0],
        ['events: 1e5 real exdates', () => validateItem('events', { id: 'e1', start: '2026-11-22', allDay: true, exdates: big(1e5, (i) => `${1000 + (i % 9000)}-01-01`) }), (o) => o.exdates.length <= 2000],
        ['settings: 1e6 hidden lists', () => validateSettingsPatch({ hiddenTaskLists: big(1e6, (i) => `L${i}`) }), (o) => o.hiddenTaskLists.length <= 1000],
        ['settings: 1e5 taskSort keys', () => validateSettingsPatch({ taskSort: Object.fromEntries(big(1e5, (i) => [`v${i}`, 'date'])) }), (o) => Object.keys(o.taskSort).length <= 500],
        ['settings: 1e5 app-prefixed keys', () => validateSettingsPatch(Object.fromEntries(big(1e5, (i) => [`notesK${i}`, i]))), (o) => Object.keys(o).length <= 100],
        ['ops: 1e5 ops', () => validateOps(big(1e5, (i) => ({ op: 'del', c: 'tasks', id: `t${i}` }))), (o) => o.length <= 5000],
        ['collection: 60000 tasks', () => validateCollection('tasks', big(60000, (i) => ({ id: `t${i}` }))), (o) => o.items.length <= (LIMITS.tasks ?? 50000)],
        ['notes: 3 MB body', () => validateItem('notes', { id: 'n1', title: 'x', body: `<p>${'"'.repeat(3e6)}</p>` }), (o) => JSON.stringify(o).length <= ITEM_MAX],
      ];
      for (const [label, run, bounded] of cases) {
        const t0 = performance.now();
        let out;
        try {
          out = run();
        } catch (err) {
          fail('throws', `${label}: threw ${err?.message}`);
        }
        const ms = performance.now() - t0;
        check(out && bounded(out), 'unbounded', `${label}: output not capped`);
        check(ms < 1500, 'slow', `${label}: took ${ms.toFixed(0)} ms`);
      }
    },
  },
];

/** Values from JSON.parse keep "__proto__" as an own key; make sure validators see such input too. */
export function parsedPollution() {
  return JSON.parse('{"id":"a1","title":"t","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"repeat":{"freq":"day","__proto__":{"polluted":1}},"tags":["x"]}');
}
export { hostileString, defineOwn };
