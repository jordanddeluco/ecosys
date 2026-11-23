// shared/sync.js firstSyncOps and nested sample folders: a browser syncs for the first time with a
// server that already has data (from another browser). What the person did must reach the server in
// folders that exist there, and no folder may be doubled: an untouched sample folder stands for the
// server's folder of the same name at the same place (same parent, or the top level), so a needed
// sample folder goes under the server's "Work" instead of bringing a second "Work" along, and a
// sample folder is never matched to a folder of its name somewhere else. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.map = new Map();
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
const ls = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => new MemoryStorage() });
// No Web Locks: sync.js opens its own event stream, and no BroadcastChannel keeps the process alive.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };

const { validateItem, validateOp } = await import('../shared/sanitize.js');
const S = await import('../notes/core/schema.js');
const { db, registerSeeder, seedIfEmpty, seededAt } = await import('../shared/store.js');

// ---------------------------------------------------------------- this browser: sample folders and notes
const F = {};
const N = {};
registerSeeder((d) => {
  const folder = (key, name, parent = null) => (F[key] = d.insert('folders', { name, parentId: parent ? F[parent].id : null, order: 0 }));
  const note = (key, title, folderKey) => {
    const { createdAt, updatedAt, editedAt, ...n } = S.newNote({ blocks: [S.newBlock('h1', title), S.newBlock('p', 'Some text')], folderId: F[folderKey].id });
    N[key] = d.insert('notes', n);
  };
  folder('work', 'Work');
  folder('meetings', 'Meetings', 'work');
  folder('archive', 'Archive');
  folder('old', 'Old', 'archive');
  folder('personal', 'Personal');
  folder('clients', 'Clients');
  folder('acme', 'Acme', 'clients');
  folder('projects', 'Projects');
  folder('q1', 'Q1', 'projects');
  folder('drafts', 'Drafts', 'q1');
  note('kickoff', 'Kickoff', 'meetings');
  note('trip', 'Trip', 'personal');
  note('acme', 'Acme call', 'acme');
  note('plan', 'Plan', 'drafts');
  note('untouched', 'Untouched', 'old');
});
seedIfEmpty();
const later = seededAt() + 60000;
const edit = (c, x, patch) => db.put(c, { ...db.get(c, x.id), ...patch, updatedAt: later });
// What the person did before the first sync:
edit('notes', N.kickoff, { pinned: true }); // in Work › Meetings
edit('notes', N.trip, { pinned: true }); // in Personal
edit('notes', N.acme, { pinned: true }); // in Clients › Acme
edit('notes', N.plan, { pinned: true }); // in Projects › Q1 › Drafts
edit('folders', F.old, { name: 'Old stuff' }); // a renamed sample folder in the untouched "Archive"
const recipes = db.put('folders', { id: 'recipes00000001', name: 'Recipes', parentId: F.personal.id, order: 1, createdAt: later, updatedAt: later });

// ---------------------------------------------------------------- the server, filled by another browser
const T0 = Date.now() - 5 * 86400000;
const folder = (id, name, parentId = null) => validateItem('folders', { id, name, parentId, order: 0, createdAt: T0, updatedAt: T0 });
const server = {
  rev: 7,
  data: {
    tasks: [],
    lists: [],
    events: [],
    calendars: [],
    notes: [],
    folders: [
      folder('srvwork00000001', 'Work'),
      folder('srvarchive00001', 'ARCHIVE'), // the same name, in other letter case
      folder('srvmeetings0001', 'Meetings', 'srvarchive00001'), // "Meetings", but not in "Work"
      folder('srvhome00000001', 'Home'),
      folder('srvpersonal0001', 'Personal', 'srvhome00000001'), // "Personal", but not at the top level
      folder('srvclients00001', 'Clients'),
      folder('srvacme00000001', 'acme', 'srvclients00001'), // Clients › Acme, as here
    ],
  },
  pushed: [],
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync'] });
  if (path === 'state') return json(200, { rev: server.rev, initialized: true, data: structuredClone(server.data), settings: {} });
  if (path === 'import') return json(409, { error: 'already initialized' });
  if (path === 'ops' && opts.method === 'POST') {
    const ops = JSON.parse(opts.body).ops.map(validateOp); // the same validators as server/validate.mjs
    for (const o of ops) {
      server.pushed.push(o);
      if (o?.op !== 'put') continue;
      const list = server.data[o.c];
      const i = list.findIndex((x) => x.id === o.item.id);
      if (i >= 0) list[i] = o.item;
      else list.push(o.item);
    }
    return json(200, { rev: ++server.rev, applied: ops.length, rejected: [] });
  }
  if (path === 'events') return new Response(new ReadableStream({ start(c) { opts.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} }); } }), { status: 200 });
  return json(404, { error: 'Not found' });
};
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const { startSync, syncState } = await import('../shared/sync.js');
const pushed = (c) => new Map(server.pushed.filter((o) => o?.op === 'put' && o.c === c).map((o) => [o.item.id, o.item]));

test('first sync: needed sample folders go under the server folders their sample parents stand for, and nothing is doubled', async () => {
  try {
    await startSync();
    await until(() => syncState.online && server.pushed.length > 0 && syncState.pending === 0);
  } finally {
    window.dispatchEvent(new Event('pagehide')); // stop the stream and timers
  }
  const folders = pushed('folders');
  const notes = pushed('notes');

  // Work › Meetings: the server has "Work" (no "Meetings" in it), so only "Meetings" is sent, under the server's "Work".
  assert.equal(folders.get(F.meetings.id)?.parentId, 'srvwork00000001', '"Meetings" is put in the server’s "Work"');
  assert.ok(!folders.has(F.work.id), 'the sample "Work" is not sent');
  assert.equal(notes.get(N.kickoff.id)?.folderId, F.meetings.id, 'the pinned note stays in its "Meetings"');
  // A renamed folder in an untouched sample parent goes under the server's folder of that name (letter case aside).
  assert.deepEqual([folders.get(F.old.id)?.name, folders.get(F.old.id)?.parentId], ['Old stuff', 'srvarchive00001']);
  assert.ok(!folders.has(F.archive.id), 'the sample "Archive" is not sent');
  // Clients › Acme exists on the server: the note is filed there and no folder is sent for it.
  assert.equal(notes.get(N.acme.id)?.folderId, 'srvacme00000001', 'filed under the server’s Clients › Acme');
  assert.ok(!folders.has(F.clients.id) && !folders.has(F.acme.id));
  // "Personal" on the server is inside "Home", not at the top level: not the same folder, so the sample one is sent.
  assert.equal(folders.get(F.personal.id)?.parentId, null, 'the sample "Personal" is sent (top level)');
  assert.equal(notes.get(N.trip.id)?.folderId, F.personal.id);
  assert.equal(folders.get(recipes.id)?.parentId, F.personal.id, 'the new folder stays in its "Personal"');
  // A needed chain with nothing of it on the server is sent whole, parents included.
  assert.equal(folders.get(F.drafts.id)?.parentId, F.q1.id);
  assert.equal(folders.get(F.q1.id)?.parentId, F.projects.id);
  assert.equal(folders.get(F.projects.id)?.parentId, null);
  assert.equal(notes.get(N.plan.id)?.folderId, F.drafts.id);
  // Untouched samples stay out; "Meetings" is never matched to the server's "Archive › Meetings".
  assert.ok(!notes.has(N.untouched.id), 'the untouched sample note is not sent');
  assert.ok(!server.pushed.some((o) => o?.item?.parentId === 'srvmeetings0001' || o?.item?.folderId === 'srvmeetings0001'));
  assert.deepEqual([...folders.keys()].sort(), [F.meetings.id, F.old.id, F.personal.id, recipes.id, F.projects.id, F.q1.id, F.drafts.id].sort(), 'exactly these folders are sent');
});

test('first sync: every folder and note on the server has its parent there, one "Work" and one "Archive" at the top level', () => {
  const ids = new Set(server.data.folders.map((f) => f.id));
  for (const f of server.data.folders) assert.ok(f.parentId === null || ids.has(f.parentId), `folder ${f.name}: its parent is on the server`);
  for (const n of server.data.notes) assert.ok(n.folderId === null || ids.has(n.folderId), `note ${n.title}: its folder is on the server`);
  const roots = (list, name) => list.filter((f) => f.parentId === null && f.name.toLowerCase() === name).length;
  for (const name of ['work', 'archive', 'clients']) {
    assert.equal(roots(server.data.folders, name), 1, `one "${name}" on the server`);
    assert.equal(roots(db.all('folders'), name), 1, `one "${name}" in this browser`);
  }
  assert.equal(db.get('folders', F.meetings.id)?.parentId, 'srvwork00000001', 'this browser shows the server’s folders with the merged ones');
  assert.equal(db.get('folders', F.work.id), null, 'the sample "Work" gave way to the server’s');
});
