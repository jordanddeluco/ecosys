// Generators of hostile JSON values and near-valid ecosys records for the validator fuzz tests.
// Objects are built with own data properties only (like JSON.parse), so keys such as "__proto__",
// "constructor" and "prototype" arrive as real own keys, exactly as they would from the network.
import { defineOwn } from './harness.js';

const C = (n) => String.fromCharCode(n);
export const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
const PROTO_WORDS = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', 'isPrototypeOf', 'then'];

export function obj(entries) {
  const o = {};
  for (const [k, v] of entries) defineOwn(o, k, v);
  return o;
}

export const VALID_IDS = ['a', 'abc123', 'A_b-9', 'k3f9a0b1c2d3e4f5', 'x'.repeat(40), '0', 'L1', 'inbox'];
export const BAD_IDS = ['', 'x'.repeat(41), 'a b', '../x', '"><img src=x>', 'ab\u0000', 'ä', 'a.b', 'a/b', ' abc', 'abc ', 'a\nb', 0, 1, -1, null, true, [], {}, ['abc'], 1e21];
export const VALID_DATES = ['2026-11-22', '2024-02-29', '2000-02-29', '1000-01-01', '9999-12-31', '2026-03-08', '2026-11-01', '2026-03-29', '2026-10-25', '2026-01-31'];
export const BAD_DATES = ['2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '0999-12-31', '2026-1-1', '2026-11-22T10:00', ' 2026-11-22', '2026-11-22 ', '20261122', '', '2026/11/22', '+02026-11-22', '2026-11-32', 20261122, '٢٠٢٦-١١-٢٢'];
export const VALID_TIMES = ['00:00', '23:59', '09:30', '12:00', '17:45'];
export const BAD_TIMES = ['24:00', '9:00', '09:60', '12:00:00', '12:00 ', ' 12:00', '1200', '12-00', '-1:00', 930, '٠٩:٣٠', '25:61', ''];
export const VALID_DTS = ['2026-11-22T09:30', '2026-03-08T02:30', '2026-11-01T01:30', '2024-02-29T23:59', '2026-12-31T23:00'];
export const BAD_DTS = ['2026-11-22 09:30', '2026-11-22T9:30', '2026-11-22T24:00', '2026-02-29T10:00', '2026-11-22T09:30:00', '2026-11-22T09:30Z', 'soon', ''];
const NUMBERS = [0, -0, 1, -1, 2, 3, 4, 5, 7, 2.5, -2.5, 0.49, 0.5, 1.5, 59, 60, 999, 1000, 1440, 1441, 10080, 10081, 1e15, 1e16, -1e16, 2 ** 53, Number.MAX_VALUE, 5e-324, Infinity, -Infinity, 8.64e15, 8.64e15 + 1, 1763800000000];
const NUMERIC_STRINGS = ['0', '1', '60', ' 60 ', '6e1', '0x10', '1,000', '1.5', '-3', '', ' ', 'NaN', 'Infinity', '1e309', '007', '+5', '٣'];

/** Short hostile strings: markup, controls, line separators, bidi, lone surrogates, long runs. */
export function hostileString(rng) {
  return rng.weighted([
    [4, () => rng.pick(['', ' ', 'x', 'Hello', '  padded  ', 'a\tb', 'a\nb', 'a\r\nb', 'line1' + String.fromCharCode(0x2028) + 'line2', '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'; DROP TABLE x;--"])],
    [2, () => rng.pick([C(0), `a${C(0)}b`, `x${C(7)}y`, `${C(0x1b)}[31m`, C(0x7f), `${C(0xd800)}x`, `x${C(0xdfff)}`, `${C(0xd83d)}${C(0xde00)}`, C(0x202e) + 'evil', C(0xfeff), C(0x85)])],
    [1, () => rng.pick(PROTO_WORDS)],
    [1, () => rng.pick([...VALID_IDS, ...VALID_DATES, ...VALID_TIMES, ...VALID_DTS])],
    [1, () => rng.weighted([[1, () => 'x'.repeat(rng.int(400, 700))], [1, () => '"'.repeat(rng.int(100, 30000))], [1, () => '\\'.repeat(rng.int(100, 5000))], [1, () => `${C(0xd800)}`.repeat(rng.int(1, 600))], [1, () => 'ab'.repeat(rng.int(1000, 15000))]])],
  ]);
}

/** Any JSON value (plus the non-finite numbers JSON.parse can make: 1e309 → Infinity). */
export function jsonValue(rng, depth = 0) {
  return rng.weighted([
    [3, null],
    [2, () => rng.chance(0.5)],
    [4, () => rng.pick(NUMBERS)],
    [6, () => hostileString(rng)],
    [1, () => rng.pick(NUMERIC_STRINGS)],
    [depth < 3 ? 2 : 0, () => rng.repeat(rng.small(6), () => jsonValue(rng, depth + 1))],
    [depth < 3 ? 2 : 0, () => jsonObject(rng, depth + 1)],
  ]);
}

export function jsonObject(rng, depth = 0) {
  const n = rng.small(6);
  const entries = [];
  for (let i = 0; i < n; i++) entries.push([rng.weighted([[3, () => rng.pick(['a', 'id', 'title', 'x', 'polluted', 'freq', 'days', 'theme'])], [2, () => rng.pick(PROTO_WORDS)], [1, () => hostileString(rng).slice(0, 30)]]), jsonValue(rng, depth + 1)]);
  return obj(entries);
}

/** A value meant to pollute prototypes if a validator copies keys blindly. */
export const pollution = () => obj([['polluted', true], ['__proto__', obj([['polluted', true]])], ['constructor', obj([['prototype', obj([['polluted', true]])]])]]);

function hugeArray(rng, el) {
  const n = rng.pick([301, 1001, 2001, 5000]);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = el(i);
  return out;
}

/** Field value generator: usually valid, often a wrong type / edge value / hostile value. */
function field(rng, valid, bad = []) {
  return rng.weighted([
    [5, () => (typeof valid === 'function' ? valid(rng) : rng.pick(valid))],
    [bad.length ? 3 : 0, () => rng.pick(bad)],
    [2, () => jsonValue(rng, 2)],
    [0.3, () => pollution()],
  ]);
}

const RULE = (rng) =>
  rng.weighted([
    [4, () => obj([['freq', rng.pick(['day', 'week', 'month', 'year'])], ['interval', rng.pick([1, 1, 2, 3, 12, 999, 1000, 0, -1, '2', 2.6, 1e9, null])]])],
    [3, () => obj([['freq', 'week'], ['interval', rng.int(1, 4)], ['days', rng.pick([[1, 2, 3, 4, 5], [0, 6], [5, 1, 1, 9], ['3', 3.4, -1, 7, null, 'x'], [], hugeArrayOf(rng, () => rng.int(-3, 9), 3000)])]])],
    [2, () => obj([['freq', rng.pick(['month', 'year'])], ['interval', 1], ['monthDay', rng.pick([1, 15, 28, 29, 30, 31, 0, 32, '15', 31.4])], ['month', rng.pick([1, 2, 12, 13, 0, '2'])], ['from', rng.pick(['due', 'done', 'x', null])]])],
    [1, () => obj([['freq', rng.pick(['hourly', '__proto__', 'constructor', '', null, 'DAY'])], ['interval', 1]])],
    [1, () => jsonValue(rng, 2)],
    [0.3, () => obj([['freq', 'day'], ['__proto__', obj([['polluted', true]])], ['constructor', pollution()]])],
  ]);
const hugeArrayOf = (rng, el, n) => Array.from({ length: n }, () => el(rng));

const checklistItem = (rng) => obj([['id', rng.chance(0.7) ? rng.pick(VALID_IDS) : rng.pick(BAD_IDS)], ['title', rng.chance(0.8) ? hostileString(rng) : jsonValue(rng, 2)], ['done', rng.pick([true, false, 'true', 'false', 1, 0, 'yes', null])], ...(rng.chance(0.1) ? [['__proto__', obj([['polluted', true]])]] : [])]);
const tags = (rng) =>
  rng.weighted([
    [5, () => rng.repeat(rng.small(8), () => (rng.chance(0.8) ? hostileString(rng).slice(0, 80) : jsonValue(rng, 2)))],
    [1, () => hugeArray(rng, (i) => `tag${i % 300}`)],
    [1, () => hostileString(rng)],
  ]);

const ts = (rng) => rng.pick([1763800000000, 0, Date.now(), 8.64e15, 8.64e15 + 1, -1, 1.5, 'yesterday', '1763800000000', null, Infinity]);

const GENS = {
  tasks: (rng) => [
    ['title', field(rng, hostileString)],
    ['notes', field(rng, (r) => (r.chance(0.1) ? 'n'.repeat(r.int(19000, 25000)) : hostileString(r)))],
    ['listId', field(rng, VALID_IDS, BAD_IDS)],
    ['tags', field(rng, tags)],
    ['priority', field(rng, [0, 1, 2, 3], [4, -1, 2.5, '3', 'p1', 1e9])],
    ['date', field(rng, VALID_DATES, BAD_DATES)],
    ['time', field(rng, VALID_TIMES, BAD_TIMES)],
    ['duration', field(rng, [15, 30, 60, 1, 10080], [0, -5, 10081, '30', 2.5, 1e12])],
    ['deadline', field(rng, VALID_DATES, BAD_DATES)],
    ['repeat', field(rng, RULE)],
    ['checklist', field(rng, (r) => r.weighted([[5, () => r.repeat(r.small(10), checklistItem)], [1, () => hugeArray(r, (i) => obj([['id', `s${i % 50}`], ['title', 'x'.repeat(i % 600)], ['done', i % 2 === 0]]))]]))],
    ['done', field(rng, [true, false], ['true', 'false', 1, 0, 'yes'])],
    ['completedAt', field(rng, ts)],
    ['order', field(rng, [0, 1, -1, 1.5, 1e15], [1e16, Infinity, '7', '1e3'])],
    ['repeatOf', field(rng, VALID_IDS, BAD_IDS)],
    ['someday', true],
    ['evening', true],
    ['source', field(rng, (r) => obj([['app', r.pick(['notes', 'tasks', '__proto__'])], ['noteId', r.pick([...VALID_IDS, ...BAD_IDS])], ['blockId', r.pick([...VALID_IDS, ...BAD_IDS])]]))],
  ],
  lists: (rng) => [
    ['name', field(rng, hostileString)],
    ['color', field(rng, ['iris', 'blue', 'red', 'graphite'], ['nope', 'IRIS', '"><x>', '#fff', ''])],
    ['icon', field(rng, ['', 'list', 'cart-2', 'x'.repeat(40)], ['<b>', 'Cart', 'x'.repeat(41), 'a b'])],
    ['order', field(rng, [0, 1, -1, 2.5], [1e16, '1'])],
  ],
  events: (rng) => {
    const allDay = rng.pick([true, false, true, 'true', 0, null]);
    return [
      ['title', field(rng, hostileString)],
      ['calendarId', field(rng, VALID_IDS, BAD_IDS)],
      ['allDay', allDay],
      ['start', field(rng, [...VALID_DATES, ...VALID_DTS], [...BAD_DATES, ...BAD_DTS])],
      ['end', field(rng, [...VALID_DATES, ...VALID_DTS], [...BAD_DATES, ...BAD_DTS])],
      ['location', field(rng, hostileString)],
      ['notes', field(rng, hostileString)],
      ['repeat', field(rng, RULE)],
      ['exdates', field(rng, (r) => r.weighted([[5, () => r.repeat(r.small(10), () => (r.chance(0.7) ? r.pick(VALID_DATES) : r.pick(BAD_DATES)))], [1, () => hugeArray(r, (i) => (i % 3 ? `x${i}` : VALID_DATES[i % VALID_DATES.length]))]]))],
      ['until', field(rng, VALID_DATES, BAD_DATES)],
      ['seriesId', field(rng, VALID_IDS, BAD_IDS)],
      ['occurrence', field(rng, VALID_DATES, BAD_DATES)],
    ];
  },
  calendars: (rng) => [
    ['name', field(rng, hostileString)],
    ['color', field(rng, ['iris', 'teal'], ['nope', null])],
    ['visible', field(rng, [true, false], ['false', 0, 'no'])],
    ['order', field(rng, [0, 3], ['x'])],
  ],
  notes: (rng) => [
    ['title', field(rng, hostileString)],
    ['body', field(rng, (r) => r.weighted([[6, () => r.pick(['<p>hi</p>', '<p onclick=x>hi<script>bad()</script></p>', '<ul class="checklist"><li data-checked="true">t</li></ul>'])], [2, () => '"'.repeat(r.int(1000, 40000))], [1, () => `<p>${'x'.repeat(r.int(1000, 60000))}</p>`], [0.1, () => '"'.repeat(r.int(260000, 300000))], [0.1, () => `<p>${'x'.repeat(r.int(390000, 450000))}</p>`]]))],
    ['folderId', field(rng, VALID_IDS, BAD_IDS)],
    ['pinned', field(rng, [true, false], ['true', 1])],
    ['color', field(rng, ['iris', null], ['nope'])],
    ['tags', field(rng, tags)],
    ['order', field(rng, [0, 1], ['x'])],
    ['trashedAt', field(rng, ts)],
    ['blocks', field(rng, (r) => r.repeat(r.small(8), () => obj([['id', r.pick([...VALID_IDS, ...BAD_IDS])], ['t', r.pick(['p', 'h1', 'check', 'code', 'hr', 'bogus', '__proto__'])], ['c', r.pick([[['hello']], [['x', 'b']], [[hostileString(r), 'biusc', obj([['href', r.pick(['https://x.example', 'javascript:alert(1)'])]])]], 'text', null])], ['ck', r.pick([true, false, 'true'])]])))],
    ['day', field(rng, VALID_DATES, BAD_DATES)],
    ['event', field(rng, (r) => obj([['id', r.pick(VALID_IDS)], ['date', r.pick(VALID_DATES)]]))],
    ['rev', field(rng, [0, 1, 42], [-1, 1.5, 1e13])],
  ],
  folders: (rng) => [
    ['name', field(rng, hostileString)],
    ['color', field(rng, ['iris', null], ['nope'])],
    ['icon', field(rng, ['', 'folder'], ['<b>'])],
    ['parentId', field(rng, VALID_IDS, BAD_IDS)],
    ['order', field(rng, [0, 1], ['x'])],
    ['sort', field(rng, ['edited', 'created', 'title', null], ['x'])],
    ['view', field(rng, ['list', 'gallery', null], ['grid'])],
  ],
};

/** A record for `collection` that is mostly well-formed but carries wrong types, edge values and pollution keys. */
export function nearValidRecord(rng, collection) {
  const entries = [['id', rng.chance(0.85) ? rng.pick(VALID_IDS) : rng.pick(BAD_IDS)]];
  for (const [k, v] of (GENS[collection] || GENS.tasks)(rng)) if (rng.chance(0.75)) entries.push([k, v]);
  entries.push(['createdAt', ts(rng)], ['updatedAt', ts(rng)]);
  if (rng.chance(0.3)) entries.push([rng.pick(FORBIDDEN), pollution()]);
  if (rng.chance(0.2)) entries.push([rng.pick(['extra', 'evil', 'x-y', 'polluted', ...PROTO_WORDS]), jsonValue(rng, 1)]);
  return obj(rng.shuffle(entries));
}

export const COLLECTION_NAMES = ['tasks', 'lists', 'events', 'calendars', 'notes', 'folders'];
export const BAD_COLLECTIONS = ['users', '', 'TASKS', 'tasks ', ...PROTO_WORDS, 'length', '0'];
