// Regression tests for the shared/sanitize.js defects the QA fuzz suite found (tests/fuzz/):
//   - validators threw on parsed JSON objects whose toString / valueOf is not a function, which
//     failed a whole import or sync batch;
//   - a repaired event `end` moved to the end of the record (JSON comparisons saw a change);
//   - extendSchema / extendSettingsSchema wrote prototype names onto Object.prototype & co.;
//   - validateRepeat reset intervals over 999 to 1 ("every 1000 days" became daily);
//   - a validator that threw was dropped silently; taskSort kept view keys such as 'toString'.
// And the validation memo (createValidationMemo), which lets the store skip records it already validated.
// Only shared/sanitize.js is loaded here (the stage-1 schemas). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../shared/sanitize.js';

const J = (s) => JSON.parse(s); // like data from the network or storage: "toString" etc. become own keys
/** JSON objects that String(), `${}`, + and comparisons cannot convert (they throw a TypeError). */
const ODD = [J('{"toString":0}'), J('{"toString":""}'), J('{"valueOf":0,"toString":0}'), J('{"toString":{}}'), J('[{"toString":0}]'), J('{"valueOf":"","toString":null}')];
const throwsOnString = (v) => {
  try {
    String(v);
    return false;
  } catch {
    return true;
  }
};

const PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype).sort().join();
const assertNoPollution = () => {
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(), PROTO_KEYS, 'Object.prototype gained keys');
  assert.equal({}.zzPolluted, undefined);
  assert.equal(Object.zzPolluted, undefined);
  assert.equal(Function.prototype.zzPolluted, undefined);
};

// ---------------------------------------------------------------- safe string conversion

test('the odd values really make String() throw (the premise of these tests)', () => {
  for (const v of ODD) assert.ok(throwsOnString(v), JSON.stringify(v));
});

test('safeString never throws: strings kept, numbers / booleans / bigints written out, everything else is empty', () => {
  assert.equal(S.safeString('a<b'), 'a<b');
  assert.equal(S.safeString(42), '42');
  assert.equal(S.safeString(-1.5), '-1.5');
  assert.equal(S.safeString(true), 'true');
  assert.equal(S.safeString(10n), '10');
  for (const v of [null, undefined, {}, [], ['a'], Symbol('s'), () => 1, ...ODD]) assert.equal(S.safeString(v), '');
});

test('sanitizeHtml, htmlToText, escapeHtml and cleanHref never throw on such objects', () => {
  for (const v of ODD) {
    assert.equal(S.sanitizeHtml(v), '');
    assert.equal(S.htmlToText(v), '');
    assert.equal(S.escapeHtml(v), '');
    assert.equal(S.cleanHref(v), null);
  }
  assert.equal(S.sanitizeHtml(42), '42');
  assert.equal(S.sanitizeHtml(null), '');
  assert.equal(S.sanitizeHtml(['<b>x</b>']), '', 'an array is not HTML');
  assert.equal(S.escapeHtml(7), '7');
  assert.equal(S.cleanHref(['https://ok.example/']), null);
  assert.equal(S.cleanHref('https://ok.example/'), 'https://ok.example/');
});

// ---------------------------------------------------------------- validators never throw

/** A record of collection c with every schema field (and a few extra keys) set to `odd`. */
const oddRecord = (c, odd) => ({ ...Object.fromEntries(S.schemaFields(c).map((k) => [k, odd])), id: 'odd1', start: '2026-11-22T10:00', extra: odd, toString: odd, valueOf: odd });

test('validateItem never throws on fields holding such objects, in any collection, and returns a clean record', () => {
  for (const c of S.COLLECTIONS) {
    for (const odd of ODD) {
      let out;
      assert.doesNotThrow(() => (out = S.validateItem(c, oddRecord(c, odd))), `${c} with ${JSON.stringify(odd)}`);
      assert.ok(out, `${c}: the record is repaired (only typed fields, so every odd value is dropped)`);
      assert.ok(!Object.hasOwn(out, 'toString') && !Object.hasOwn(out, 'valueOf') && !Object.hasOwn(out, 'extra'));
      assert.doesNotThrow(() => JSON.stringify(out) + String(Object.values(out)), `${c}: the result prints`);
      for (const v of Object.values(out)) assert.ok(v === null || typeof v !== 'object' || Array.isArray(v) || S.isPlainObject(v));
    }
  }
  const n = S.validateItem('notes', J('{"id":"a","body":{"toString":0}}'));
  assert.equal(n.body, '');
});

test('validateCollection, validateSnapshot, validateOp and validateOps keep the rest of a batch', () => {
  const notes = J('[{"id":"a","body":{"toString":""}},{"id":"b","title":"fine","body":"<p>ok</p>"}]');
  assert.doesNotThrow(() => S.validateCollection('notes', notes));
  assert.deepEqual(S.validateCollection('notes', notes).items.map((x) => x.id), ['a', 'b']);
  const snap = S.validateSnapshot(J('{"data":{"notes":[{"id":"a","body":{"toString":""}},{"id":"b","body":"<p>ok</p>"}],"tasks":[{"id":"t","title":{"valueOf":0,"toString":0},"notes":{"toString":0}}]},"settings":{"theme":{"toString":0},"accent":"blue","notesView":{"toString":0}}}'));
  assert.deepEqual(snap.data.notes.map((x) => x.body), ['', '<p>ok</p>']);
  assert.equal(snap.data.tasks[0].title, '');
  assert.deepEqual(snap.settings, { accent: 'blue' });
  const ops = S.validateOps(J('[{"op":"replace","c":"notes","items":[{"id":"a","body":{"toString":""}}]},{"op":"put","c":"tasks","item":{"id":"t2","title":{"toString":0}}},{"op":"del","c":"tasks","id":{"toString":0}},{"op":{"toString":0}},{"op":"settings","patch":{"taskSort":{"today":{"toString":0}}}}]'));
  assert.deepEqual(ops.map((o) => o.op), ['replace', 'put', 'settings']);
  assert.equal(S.validateOp(J('{"op":"put","c":{"toString":0},"item":{"id":"a"}}')), null);
});

test('a field validator that throws makes only its record invalid (never the whole batch)', () => {
  // An added validator meeting input it did not expect (as notes/core/schema.js can).
  S.extendSchema('lists', { zzBoom: (v) => (v === 'boom' ? null.x : undefined) });
  const warn = console.warn;
  console.warn = () => {}; // reported once (see the next test)
  try {
    assert.equal(S.validateItem('lists', { id: 'l1', zzBoom: 'boom' }), null);
    const r = S.validateCollection('lists', [{ id: 'l1', zzBoom: 'boom' }, { id: 'l2', name: 'Fine' }]);
    assert.deepEqual(r.items.map((x) => x.name), ['Fine']);
    assert.equal(r.dropped, 1);
    const snap = S.validateSnapshot({ lists: [{ id: 'l1', zzBoom: 'boom' }, { id: 'l2' }] });
    assert.equal(snap.counts.lists, 1);
    assert.equal(snap.dropped, 1);
    assert.equal(S.validateOp({ op: 'put', c: 'lists', item: { id: 'l1', zzBoom: 'boom' } }), null);
  } finally {
    console.warn = warn;
    S.extendSchema('lists', { zzBoom: () => undefined }); // inert from here on
  }
});

test('a validator that throws is reported with console.warn once per collection, not silently and not once per record', () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.map((x) => S.safeString(x)).join(' '));
  try {
    S.extendSchema('calendars', { zzBoom: (v) => (v === 'boom' ? null.x : undefined) });
    for (let i = 0; i < 5; i++) assert.equal(S.validateItem('calendars', { id: `c${i}`, zzBoom: 'boom' }), null);
    assert.equal(S.validateCollection('calendars', [{ id: 'c9', zzBoom: 'boom' }, { id: 'c10' }]).items.length, 1);
    assert.equal(S.validateOp({ op: 'replace', c: 'calendars', items: [{ id: 'c11', zzBoom: 'boom' }] }).items.length, 0);
    assert.equal(warnings.length, 1, warnings.join(' | '));
    assert.match(warnings[0], /a calendars validator threw/);
    assert.match(warnings[0], /null/, 'the error message is included'); // "Cannot read properties of null"
    // Another collection is reported on its own, even when what was thrown can't be read.
    const unreadable = {
      get message() {
        throw new Error('unreadable');
      },
    };
    S.extendSchema('folders', {
      zzBoom: (v) => {
        if (v === 'boom') throw unreadable;
      },
    });
    assert.equal(S.validateItem('folders', { id: 'f1', zzBoom: 'boom' }), null);
    assert.equal(S.validateItem('folders', { id: 'f2', zzBoom: 'boom' }), null);
    assert.equal(warnings.length, 2, warnings.join(' | '));
    assert.match(warnings[1], /a folders validator threw/);
  } finally {
    console.warn = warn;
    S.extendSchema('calendars', { zzBoom: () => undefined });
    S.extendSchema('folders', { zzBoom: () => undefined });
  }
});

test('a settings validator that throws only drops its own key', () => {
  S.extendSettingsSchema({ zzBoomSetting: (v) => (v === 'boom' ? null.x : v === 1 ? 1 : undefined) });
  assert.deepEqual(S.validateSettingsPatch({ zzBoomSetting: 'boom', theme: 'dark' }), { theme: 'dark' });
  assert.deepEqual(S.validateSettingsPatch({ zzBoomSetting: 1 }), { zzBoomSetting: 1 });
});

// ---------------------------------------------------------------- canonical key order

test('events keep the canonical key order whatever is repaired, so a second validation gives the identical JSON', () => {
  const cases = [
    { id: 'a', start: '2024-02-29T23:59' }, // no end
    { id: 'b', start: '2026-11-22T10:00', end: '2026-11-22T09:00' }, // end before start
    { id: 'c', start: '2026-11-22T10:00', end: 5 }, // end not a string
    { id: 'd', allDay: true, start: '2026-11-22' }, // all day, no end
    { id: 'e', allDay: true, start: '2026-11-22T08:00', end: '2026-11-20' },
    { id: 'f', start: '2026-11-22' }, // a date becomes 09:00
    { id: 'g', start: '2026-11-22T23:30', until: '2026-01-01', repeat: { freq: 'week', interval: 1 } },
    { end: '2026-11-22T10:00', id: 'h', updatedAt: 1, createdAt: 1, start: '2026-11-22T09:00', title: 'shuffled input' },
  ];
  for (const raw of cases) {
    const e = S.validateItem('events', raw);
    assert.ok(e, raw.id);
    assert.deepEqual(Object.keys(e), S.schemaFields('events').filter((k) => k in e), `${raw.id}: ${Object.keys(e)}`);
    assert.equal(JSON.stringify(S.validateItem('events', e)), JSON.stringify(e), `${raw.id}: a second validation changes the JSON`);
    assert.equal(JSON.stringify(S.validateItem('events', JSON.parse(JSON.stringify(e)))), JSON.stringify(e), `${raw.id}: validating its JSON copy changes it`);
  }
  assert.equal(S.validateItem('events', { id: 'x' }), null, 'no start: still dropped');
  assert.equal(S.validateItem('events', { id: 'x', start: 'soon' }), null);
});

test('every collection keeps the canonical key order after repairs', () => {
  for (const c of S.COLLECTIONS) {
    const raw = { updatedAt: 'x', createdAt: 'x', id: 'k1', start: '2026-11-22', title: 5, name: 5 };
    const out = S.validateItem(c, raw);
    assert.deepEqual(Object.keys(out), S.schemaFields(c).filter((k) => k in out), c);
  }
});

// ---------------------------------------------------------------- extendSchema / extendSettingsSchema

test('extendSchema refuses prototype-named collections and never writes onto built-ins', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', 'nope', '', null, 5, {}]) {
    assert.throws(() => S.extendSchema(name, { zzPolluted: () => 1 }), /Unknown collection/, String(typeof name === 'string' ? name : typeof name));
    assertNoPollution();
  }
});

test('extendSchema refuses prototype names as fields, and changes nothing when one field is bad', () => {
  const before = S.schemaFields('tasks').join();
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__lookupGetter__', 'id']) {
    const fields = { zzFine: () => 1 };
    Object.defineProperty(fields, k, { value: () => 2, enumerable: true, configurable: true, writable: true }); // an own key, as JSON.parse makes it
    assert.throws(() => S.extendSchema('tasks', fields), /Bad schema field/, k);
    assert.equal(S.schemaFields('tasks').join(), before, `${k}: zzFine was added although the call failed`);
    assertNoPollution();
  }
  assert.throws(() => S.extendSchema('tasks', { zzNotAFunction: 1 }), /Bad schema field/);
  assert.throws(() => S.extendSchema('tasks', [() => 1]), /Unknown collection/);
  // validateItem / schemaFields / validateCollection on prototype names: nothing, and no throw.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(S.validateItem(name, { id: 'a' }), null);
    assert.deepEqual(S.schemaFields(name), []);
    assert.deepEqual(S.validateCollection(name, [{ id: 'a' }]).items, []);
  }
});

test('extendSettingsSchema refuses prototype names, non-functions and non-objects; null is a no-op', () => {
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
    const fields = {};
    Object.defineProperty(fields, k, { value: () => 1, enumerable: true, configurable: true, writable: true });
    assert.throws(() => S.extendSettingsSchema(fields), /Bad settings field/, k);
    assert.ok(!Object.hasOwn(S.SETTINGS_SCHEMA, k), `${k} became a settings key`);
    assertNoPollution();
  }
  assert.throws(() => S.extendSettingsSchema({ zzOk: () => 1, zzBad: 'x' }), /Bad settings field/);
  assert.ok(!Object.hasOwn(S.SETTINGS_SCHEMA, 'zzOk'), 'nothing is added when one field is bad');
  assert.throws(() => S.extendSettingsSchema([() => 1]), /Bad settings fields/);
  assert.throws(() => S.extendSettingsSchema('x'), /Bad settings fields/);
  assert.doesNotThrow(() => S.extendSettingsSchema(null));
  assert.doesNotThrow(() => S.extendSettingsSchema(undefined));
  // Settings named after Object.prototype members are ignored, never kept as own keys.
  const s = S.validateSettingsPatch(J('{"toString":"x","valueOf":1,"hasOwnProperty":true,"theme":"dark"}'));
  assert.deepEqual(s, { theme: 'dark' });
});

test('taskSort keeps no view key named after an Object.prototype member, so the object can always be printed and used', () => {
  // As data from storage or the server holds them: JSON.parse makes "toString" & co. own keys.
  const names = Object.getOwnPropertyNames(Object.prototype);
  const raw = J(JSON.stringify({ taskSort: Object.fromEntries([...names.map((k) => [k, 'date']), ['today', 'priority'], ['tag:constructor', 'alpha'], ['list1', 'created']]) }));
  assert.ok(Object.hasOwn(raw.taskSort, 'toString') && Object.hasOwn(raw.taskSort, '__proto__'), 'precondition: prototype names are own keys');
  const { taskSort } = S.validateSettingsPatch(raw);
  assert.deepEqual(Object.keys(taskSort), ['today', 'tag:constructor', 'list1']);
  assert.deepEqual(taskSort, { today: 'priority', 'tag:constructor': 'alpha', list1: 'created' });
  assert.equal(String(taskSort), '[object Object]', 'printable (an own "toString" made String() throw)');
  assert.ok(Object.prototype.hasOwnProperty.call(taskSort, 'today'));
  assert.equal(Object.getPrototypeOf(taskSort), Object.prototype);
  assert.deepEqual(S.validateSettingsPatch({ taskSort }), { taskSort }, 'idempotent');
  assertNoPollution();
});

// ---------------------------------------------------------------- validation memo

test('a validation memo skips records whose JSON is unchanged, and validates every new or changed record in full', () => {
  const seen = []; // ids of the records the field validators ran on
  S.extendSchema('tasks', { zzSeen: (_v, raw) => void seen.push(raw.id) }); // before the memo: extending the schema resets memos
  try {
    const memo = S.createValidationMemo();
    const reread = (x) => J(JSON.stringify(x)); // as read back from localStorage or the network
    const first = S.validateCollection('tasks', [{ id: 't1', title: 'One', date: '2026-11-22' }, { id: 't2', title: 'Two', priority: 9 }], { memo }).items;
    assert.deepEqual(seen.splice(0), ['t1', 't2']);
    assert.equal(first[1].priority, 0, 'repaired');

    // The same records again (another tab rewrote the collection, a server snapshot): nothing runs,
    // and the result is exactly what validating them gives.
    const again = reread(first);
    const r = S.validateCollection('tasks', again, { memo });
    assert.deepEqual(seen.splice(0), []);
    assert.equal(r.items[0], again[0], 'a hit is the parsed record itself');
    assert.equal(JSON.stringify(r.items), JSON.stringify(first));
    assert.equal(JSON.stringify(r.items), JSON.stringify(S.validateCollection('tasks', reread(first)).items));
    seen.length = 0;

    // Any difference is validated in full: a changed or invalid value, an unknown or dangerous key, another key order.
    const variants = [
      ['changed title', { ...first[0], title: 'One!' }, (t) => t.title === 'One!'],
      ['invalid value', { ...first[0], date: '2026-02-30' }, (t) => t.date === null],
      ['unknown key', { ...first[0], evil: '<script>' }, (t) => !('evil' in t)],
      ['own __proto__', J(JSON.stringify(first[0]).replace('{', '{"__proto__":{"zzPolluted":1},')), (t) => !Object.hasOwn(t, '__proto__')],
      ['own toString', J(JSON.stringify(first[0]).replace('{', '{"toString":0,')), (t) => !Object.hasOwn(t, 'toString')],
      ['key order', Object.fromEntries(Object.entries(first[0]).reverse()), (t) => JSON.stringify(t) === JSON.stringify(first[0])],
      ['a BigInt (cannot be JSON)', { ...first[0], big: 10n }, (t) => !('big' in t) && t.title === 'One'],
      // JSON.parse reads 1e309 as Infinity, which JSON.stringify writes as null: the text "matches" first[0]'s.
      ['a number JSON writes as null (1e309)', J(JSON.stringify(first[0]).replace('"time":null', '"time":1e309')), (t) => t.time === null],
    ];
    for (const [what, raw, ok] of variants) {
      const [t] = S.validateCollection('tasks', [raw], { memo }).items;
      assert.deepEqual(seen.splice(0), ['t1'], `${what}: validated`);
      assert.ok(t && t !== raw && ok(t), `${what}: repaired as without a memo`);
      assert.equal(JSON.stringify(t), JSON.stringify(S.validateItem('tasks', raw)), `${what}: same as without a memo`);
      assert.deepEqual(t, S.validateItem('tasks', raw), `${what}: the same value too (deepStrictEqual tells Infinity from null)`);
      S.validateCollection('tasks', reread(first), { memo }); // back to the first records
      seen.length = 0;
    }
    assertNoPollution();

    // First occurrence of an id still wins, and the limit still applies.
    const dup = S.validateCollection('tasks', [...reread(first), { ...first[0], title: 'Second copy' }], { memo });
    assert.deepEqual(dup.items.map((t) => t.title), ['One', 'Two']);
    assert.equal(dup.dropped, 1);
    assert.equal(S.validateCollection('tasks', reread(first), { memo, max: 1 }).items.length, 1);
    seen.length = 0;

    // Records that are gone are forgotten: one that comes back is validated again.
    S.validateCollection('tasks', reread([first[0]]), { memo });
    S.validateCollection('tasks', reread(first), { memo });
    assert.deepEqual(seen.splice(0), ['t2']);

    // validateOp and validateSnapshot take the memo too.
    const put = { op: 'put', c: 'tasks', item: reread(first[0]) };
    assert.equal(S.validateOp(put, { memo }).item, put.item, 'an unchanged put is not validated again');
    assert.equal(S.validateOp({ op: 'put', c: 'tasks', item: { ...first[0], title: 'Put' } }, { memo }).item.title, 'Put');
    assert.deepEqual(seen.splice(0), ['t1']);
    assert.equal(S.validateOp(put, { memo }).item.title, 'One', 'the memo follows the last validated version');
    assert.deepEqual(seen.splice(0), ['t1']);
    assert.equal(S.validateOp({ op: 'replace', c: 'tasks', items: reread(first) }, { memo }).items.length, 2);
    assert.equal(S.validateSnapshot({ data: { tasks: reread(first) } }, { memo }).counts.tasks, 2);
    seen.length = 0;
    assert.deepEqual(S.validateSnapshot({ data: { tasks: reread(first) } }, { memo }).data.tasks, first);
    assert.deepEqual(seen.splice(0), []);

    // No memo, or anything that is not one, validates every time; ops.map(validateOp) still works.
    for (const opts of [undefined, null, {}, { memo: {} }, { memo: 'x' }, 0, 1]) {
      S.validateOp(put, opts);
      assert.deepEqual(seen.splice(0), ['t1'], `opts ${JSON.stringify(opts)}`);
    }
    assert.deepEqual([put, put].map(S.validateOp).map((o) => o.item.title), ['One', 'One']);
    seen.length = 0;

    // Extending a schema resets every memo: records are validated under the new schema.
    S.extendSchema('tasks', { zzLater: () => undefined });
    S.validateCollection('tasks', reread(first), { memo });
    assert.deepEqual(seen.splice(0), ['t1', 't2']);
  } finally {
    S.extendSchema('tasks', { zzSeen: () => undefined }); // inert from here on
  }
});

test('a memo hit needs JSON that describes the record exactly: a number JSON cannot hold is validated in full, in every collection', () => {
  // JSON.parse reads 1e309, -1e400 and 1E+999 as ±Infinity and -0, -0.0 and -1e-400 as -0, and
  // JSON.stringify writes those back as null and 0, so such a text "matches" the validated record's.
  // Every null and every 0 of a validated record is replaced in turn, and the result must be the
  // same value (assert.deepEqual is strict here: it tells Infinity from null and -0 from 0) as a
  // validation without the memo gives. Full validation turns repeat days [-0] into [0], for one.
  const T = 1795000000000;
  const records = {
    tasks: { id: 't1', title: 'Water the plants', repeat: { freq: 'week', interval: 1, days: [0, 3] }, checklist: [{ id: 'c1', title: 'Soil', done: false }], createdAt: T, updatedAt: T },
    lists: { id: 'l1', name: 'Home', createdAt: T, updatedAt: T },
    events: { id: 'e1', title: 'Standup', start: '2026-11-23T09:00', end: '2026-11-23T09:15', repeat: { freq: 'week', days: [0, 1] }, createdAt: T, updatedAt: T },
    calendars: { id: 'k1', name: 'Work', createdAt: T, updatedAt: T },
    notes: { id: 'n1', title: 'Plan', body: '<p>Hi</p>', createdAt: T, updatedAt: T },
    folders: { id: 'f1', name: 'Work', createdAt: T, updatedAt: T },
  };
  assert.deepEqual(Object.keys(records).sort(), [...S.COLLECTIONS].sort());
  const memo = S.createValidationMemo();
  let tried = 0;
  for (const [c, rec] of Object.entries(records)) {
    const [v] = S.validateCollection(c, [rec], { memo }).items;
    const text = JSON.stringify(v);
    const texts = [];
    for (const m of text.matchAll(/[:[,]null(?=[,\]}])/g)) for (const lit of ['1e309', '-1e400', '1E+999']) texts.push(text.slice(0, m.index + 1) + lit + text.slice(m.index + 5));
    for (const m of text.matchAll(/[:[,]0(?=[,\]}])/g)) for (const lit of ['-0', '-0.0', '-1e-400']) texts.push(text.slice(0, m.index + 1) + lit + text.slice(m.index + 2));
    assert.ok(texts.length >= 3, `${c}: has nulls or zeros to replace`);
    for (const t of texts) {
      const raw = J(t);
      assert.equal(JSON.stringify(raw), text, `${c} ${t}: the premise (the parsed record writes back as the validated text)`);
      const [got] = S.validateCollection(c, [raw], { memo }).items;
      assert.deepEqual(got, S.validateItem(c, J(t)), `${c} ${t}: the same value as a validation without the memo`);
      assert.ok(!JSON.stringify(got, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? '<infinite>' : x)).includes('<infinite>'), `${c} ${t}: no Infinity kept`);
      S.validateCollection(c, [J(text)], { memo }); // known again: the validated record
      tried++;
    }
    // The validated text itself is still a hit.
    const again = J(`[${text}]`);
    assert.equal(S.validateCollection(c, again, { memo }).items[0], again[0], `${c}: an exact copy is still a hit`);
  }
  assert.ok(tried > 40, `tried ${tried} texts`);
  // For one: full validation reads repeat days [-0, 3] as [0, 3] (a Set keeps +0); a hit would have kept -0.
  const negZero = J(`[${JSON.stringify(S.validateItem('tasks', records.tasks)).replace('"days":[0,', '"days":[-0,')}]`);
  assert.ok(Object.is(negZero[0].repeat.days[0], -0), 'the premise');
  assert.ok(Object.is(S.validateCollection('tasks', negZero, { memo }).items[0].repeat.days[0], 0), 'repeat days [-0, 3] are read as [0, 3], as without the memo');
});

test('a memo hit is never a live value that JSON leaves out or converts (undefined, a function, a Date, Infinity, a null-prototype object)', () => {
  const memo = S.createValidationMemo();
  const T = 1795000000000;
  const [task] = S.validateCollection('tasks', [{ id: 't1', title: '2026-11-22T00:00:00.000Z', checklist: [{ id: 'c1', title: 'Soil', done: false }], createdAt: T, updatedAt: T }], { memo }).items;
  const text = JSON.stringify(task);
  const live = [
    ['an undefined value', { ...task, extra: undefined }, (t) => !Object.hasOwn(t, 'extra')],
    ['a nested undefined value', { ...task, checklist: [{ ...task.checklist[0], more: undefined }] }, (t) => !Object.hasOwn(t.checklist[0], 'more')],
    ['a symbol value', { ...task, sym: Symbol('x') }, (t) => !Object.hasOwn(t, 'sym')],
    ['a toJSON method', { ...task, toJSON: () => task }, (t) => !Object.hasOwn(t, 'toJSON')],
    ['a Date (written as its ISO string)', { ...task, title: new Date('2026-11-22T00:00:00.000Z') }, (t) => t.title === ''],
    ['Infinity set directly', { ...task, date: Infinity }, (t) => t.date === null],
    ['-0 set directly (validation keeps it in order)', { ...task, order: -0 }, (t) => Object.is(t.order, -0)],
    ['a null-prototype record', Object.assign(Object.create(null), task), (t) => Object.getPrototypeOf(t) === Object.prototype],
    ['a null-prototype checklist item', { ...task, checklist: [Object.assign(Object.create(null), task.checklist[0])] }, (t) => Object.getPrototypeOf(t.checklist[0]) === Object.prototype],
  ];
  for (const [what, raw, ok] of live) {
    assert.equal(JSON.stringify(raw), text, `${what}: the premise (same JSON as the validated record)`);
    const [got] = S.validateCollection('tasks', [raw], { memo }).items;
    assert.ok(got && got !== raw && ok(got), `${what}: validated, not returned as it is`);
    assert.deepEqual(got, S.validateItem('tasks', raw), `${what}: the same value as without the memo`);
    S.validateCollection('tasks', J(`[${text}]`), { memo }); // known again
  }
});

// ---------------------------------------------------------------- repeat interval

test('validateRepeat caps the interval at 99 (as the server does) instead of resetting it to 1', () => {
  assert.equal(S.REPEAT_INTERVAL_MAX, 99);
  const iv = (interval, freq = 'day') => S.validateRepeat({ freq, interval }).interval;
  assert.equal(iv(1000), 99, '"every 1000 days" must not become daily');
  assert.equal(iv(582851674324, 'week'), 99);
  assert.equal(iv(1e300, 'month'), 99);
  assert.equal(iv(100), 99);
  assert.equal(iv(99), 99);
  assert.equal(iv(98), 98);
  assert.equal(iv('150'), 99);
  assert.equal(iv('12'), 12);
  assert.equal(iv(1.6), 2);
  assert.equal(iv(1), 1);
  assert.equal(iv(0), 1);
  assert.equal(iv(-5), 1);
  for (const bad of [undefined, null, 'x', NaN, Infinity, {}, ...ODD]) assert.equal(iv(bad), 1, String(typeof bad));
  const t = S.validateItem('tasks', { id: 't1', repeat: { freq: 'day', interval: 1000 } });
  assert.deepEqual(t.repeat, { freq: 'day', interval: 99 });
  const e = S.validateItem('events', { id: 'e1', start: '2026-11-22T10:00', repeat: { freq: 'year', interval: 5000, monthDay: 22, month: 11 } });
  assert.deepEqual(e.repeat, { freq: 'year', interval: 99, monthDay: 22, month: 11 });
  assert.deepEqual(S.validateRepeat(S.validateRepeat({ freq: 'week', interval: 500, days: [1] })), { freq: 'week', interval: 99, days: [1] }, 'idempotent');
});
