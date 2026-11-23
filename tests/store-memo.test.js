// shared/store.js re-reads a whole collection whenever another tab saves it (every few hundred ms
// while someone types in Notes) and whenever the server sends a snapshot. Validating notes with the
// notes data model costs about 60 ms per 1,000 notes, so those re-reads go through a validation memo
// (sanitize.js createValidationMemo): records whose JSON is unchanged are not validated again, and
// new or changed records always are, so nothing that changed skips validation, not even a change JSON
// can't show (1e309 reads as Infinity and is written back as null). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

const P = 'ecosys:v1:';
const T0 = 1795000000000;
const N = 400;

const S = await import('../shared/sanitize.js');
const { sampleNotesAndFolders } = await import('../notes/core/seed.js'); // also registers the notes data model

// Realistic notes: the sample notes (every block type, marks, links, tags) copied N times.
const samples = sampleNotesAndFolders('2026-11-22', { now: T0 });
const rawNotes = Array.from({ length: N }, (_, i) => {
  const s = samples.notes[i % samples.notes.length];
  return { ...structuredClone(s), id: `note${String(i).padStart(4, '0')}`, title: `${s.title} ${i}`, updatedAt: T0 + i };
});
const NOTES = S.validateCollection('notes', rawNotes).items; // the stored (canonical) form
assert.equal(NOTES.length, N);

// Count the notes the field validators run on (the field is never kept).
const seen = [];
S.extendSchema('notes', { zzSeen: (_v, raw) => void seen.push(raw?.id) });

const ls = new MemoryStorage({
  [P + 'notes']: JSON.stringify(NOTES),
  [P + 'folders']: JSON.stringify(S.validateCollection('folders', samples.folders).items),
  [P + 'seeded']: 'user',
});
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { db, applyRemoteOps, replaceAll, importData, exportData, setSyncAdapter } = await import('../shared/store.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const ids = (list) => [...new Set(list)].sort();
/** Another tab saved the notes (the whole collection is rewritten). */
function otherTabSaves(notes) {
  const newValue = JSON.stringify(notes);
  ls.setItem(P + 'notes', newValue);
  window.dispatchEvent(Object.assign(new Event('storage'), { key: P + 'notes', newValue, storageArea: ls }));
}
/** The cache holds exactly what validating everything from scratch gives (the memo changes nothing). */
function exact(what) {
  const fresh = S.validateCollection('notes', clone(db.all('notes'))).items;
  assert.equal(JSON.stringify(db.all('notes')), JSON.stringify(fresh), `${what}: the cache differs from a full validation`);
  // Value for value too: JSON can't tell Infinity from null or -0 from 0 (deepEqual is strict here).
  assert.deepEqual(db.all('notes'), fresh, `${what}: the cache holds a value JSON does not show`);
  seen.length = 0;
}
/** The notes as JSON text, with `[index, from, to]` text replacements made in single notes. */
function textWith(notes, edits) {
  const parts = notes.map((n) => JSON.stringify(n));
  for (const [i, from, to] of edits) {
    assert.ok(parts[i].includes(from), `note ${i} has ${from}`);
    parts[i] = parts[i].replace(from, to);
  }
  return { text: `[${parts.join(',')}]`, parts };
}
const edited = (i, text) => {
  const n = clone(db.all('notes')[i]);
  n.blocks = [...n.blocks, { id: 'zzedit01', t: 'p', c: [[text]] }];
  n.rev += 1;
  n.updatedAt += 1000;
  return n;
};

test('the first load validates every note (nothing is known yet)', () => {
  assert.equal(db.all('notes').length, N);
  assert.equal(ids(seen).length, N);
  exact('first load');
});

test('another tab saving one note: only that note is validated again', (t) => {
  const notes = clone(db.all('notes'));
  notes[7] = edited(7, 'typed in another tab');
  const started = performance.now();
  otherTabSaves(notes);
  const ms = performance.now() - started;
  assert.deepEqual(ids(seen), [notes[7].id]);
  assert.equal(db.all('notes')[7].blocks.at(-1).c[0][0], 'typed in another tab');
  exact('storage event');
  // A note another tab changed into something invalid is validated and repaired, as without the memo.
  const bad = clone(db.all('notes'));
  bad[3] = { ...bad[3], title: { toString: 0 }, evil: '<script>', blocks: [...bad[3].blocks, { id: 'zzbad001', t: 'script', c: [['<img src=x onerror=alert(1)>', 'zz', { href: 'javascript:alert(1)' }]] }] };
  otherTabSaves(bad);
  assert.deepEqual(ids(seen), [bad[3].id]);
  const got = db.get('notes', bad[3].id);
  assert.equal(JSON.stringify(got), JSON.stringify(S.validateItem('notes', clone(bad[3]))), 'repaired exactly as a full validation does');
  assert.ok(!('evil' in got) && typeof got.title === 'string' && !JSON.stringify(got).includes('javascript:'));
  exact('storage event with an invalid note');
  // (informational) how long that re-read took with N notes
  t.diagnostic(`re-read of ${N} notes with one changed: ${ms.toFixed(1)} ms`);
});

test('remote ops: an unchanged put changes nothing, a replace validates only the notes that changed', () => {
  assert.deepEqual(applyRemoteOps([{ op: 'put', c: 'notes', item: clone(db.all('notes')[0]) }]), []);
  assert.deepEqual(seen, [], 'an unchanged put is not validated again');
  const items = clone(db.all('notes'));
  items[1] = edited(1, 'Claude added this');
  items[2] = edited(2, 'and this');
  assert.deepEqual(applyRemoteOps([{ op: 'replace', c: 'notes', items }]), ['notes']);
  assert.deepEqual(ids(seen), ids([items[1].id, items[2].id]));
  assert.equal(db.all('notes')[2].blocks.at(-1).c[0][0], 'and this');
  exact('remote replace');
});

test('a server snapshot (replaceAll): only new and changed notes are validated', () => {
  const notes = clone(db.all('notes'));
  const added = { ...clone(NOTES[5]), id: 'brandnew01', title: 'New on the server' };
  notes.push(added);
  assert.ok(replaceAll({ rev: 3, data: { notes }, settings: {} }).includes('notes'));
  assert.deepEqual(ids(seen), ['brandnew01']);
  assert.equal(db.all('notes').length, N + 1);
  exact('replaceAll');
  assert.deepEqual(replaceAll({ rev: 4, data: { notes: clone(db.all('notes')) } }), [], 'an unchanged snapshot is no change');
  assert.deepEqual(seen, []);
});

test('a number JSON cannot hold (1e309 reads as Infinity, written back as null) is never a memo hit', () => {
  // Another tab or the server sends text in which a known note's null is 1e309 / -1e400 / 1E+999 and
  // a 0 is -0: JSON.stringify writes the parsed note back exactly as the validated one, so only a
  // value-for-value check tells them apart. The cache must hold what a full validation gives.
  const notes = clone(db.all('notes'));
  const root = notes.findIndex((n) => n.folderId === null);
  const plain = notes.findIndex((n, i) => i > 30 && n.day === null);
  const indented = notes.findIndex((n, i) => i > 40 && JSON.stringify(n).includes('"in":0,'));
  assert.ok(root >= 0 && plain >= 0 && indented >= 0, 'the sample notes have a root note, a plain note and a list item');
  const check = (parts, edited, what) => {
    for (const i of edited) assert.deepEqual(db.get('notes', notes[i].id), S.validateItem('notes', JSON.parse(parts[i])), `${what}: note ${i} as a full validation gives`);
    exact(what);
  };

  // storage event (another tab)
  const a = textWith(notes, [[20, '"trashedAt":null', '"trashedAt":1e309'], [root, '"folderId":null', '"folderId":-1e400'], [plain, '"day":null', '"day":1E+999'], [indented, '"in":0,', '"in":-0,']]);
  ls.setItem(P + 'notes', a.text);
  window.dispatchEvent(Object.assign(new Event('storage'), { key: P + 'notes', newValue: a.text, storageArea: ls }));
  assert.deepEqual(ids(seen), ids([20, root, plain, indented].map((i) => notes[i].id)), 'the notes with such numbers are validated again (and only they)');
  assert.equal(db.get('notes', notes[20].id).trashedAt, null);
  assert.equal(db.get('notes', notes[root].id).folderId, null);
  assert.equal(db.get('notes', notes[plain].id).day, null);
  assert.ok(db.get('notes', notes[indented].id).blocks.every((b) => !Object.is(b.in, -0)), 'indent -0 is read as 0');
  check(a.parts, [20, root, plain, indented], 'storage event');

  // a server snapshot in which another note changed too (so the collection is replaced)
  const changed = clone(db.all('notes'));
  changed[5] = edited(5, 'changed on the server');
  const b = textWith(changed, [[21, '"trashedAt":null', '"trashedAt":-1e400'], [root, '"folderId":null', '"folderId":1e309']]);
  assert.ok(replaceAll(JSON.parse(`{"rev":9,"data":{"notes":${b.text}}}`)).includes('notes'));
  assert.equal(db.get('notes', notes[21].id).trashedAt, null);
  assert.equal(db.get('notes', notes[root].id).folderId, null);
  assert.equal(db.get('notes', changed[5].id).blocks.at(-1).c[0][0], 'changed on the server');
  check(b.parts, [21, root], 'replaceAll');

  // a remote put of a known note with such a number: no change (and nothing infinite cached)
  const put = JSON.parse(`{"op":"put","c":"notes","item":${JSON.stringify(db.get('notes', notes[22].id)).replace('"trashedAt":null', '"trashedAt":1e309')}}`);
  assert.equal(put.item.trashedAt, Infinity, 'the premise');
  assert.deepEqual(applyRemoteOps([put]), []);
  assert.equal(db.get('notes', notes[22].id).trashedAt, null);
  exact('remote put');
});

test('changes this page has not had confirmed are re-applied validated, never as the outbox objects themselves', () => {
  const mine = { op: 'put', c: 'notes', item: edited(9, 'not yet on the server') };
  setSyncAdapter({ push() {}, pending: () => [mine] });
  try {
    const items = clone(db.all('notes'));
    items[10] = edited(10, 'from the server');
    applyRemoteOps([{ op: 'replace', c: 'notes', items }]);
    assert.equal(db.get('notes', mine.item.id).blocks.at(-1).c[0][0], 'not yet on the server', 'the local edit is kept');
    assert.notEqual(db.get('notes', mine.item.id), mine.item, 'the cache holds a validated copy, not the outbox entry');
    assert.ok(seen.includes(mine.item.id), 'the local edit was validated');
  } finally {
    setSyncAdapter(null);
  }
  exact('pending local edit');
});

test('a backup is always validated in full', () => {
  const backup = clone(exportData());
  importData(backup);
  assert.equal(ids(seen).length, db.all('notes').length);
  exact('import');
});

test('extending a schema makes every note be validated again', () => {
  S.extendSchema('notes', { zzLater: () => undefined });
  const notes = clone(db.all('notes'));
  notes[0] = edited(0, 'after the schema changed');
  otherTabSaves(notes);
  assert.equal(ids(seen).length, notes.length);
  exact('after extendSchema');
});
