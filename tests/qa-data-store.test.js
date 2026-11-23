// QA data safety: the data files and the notes folder tree.
//   - server/store.mjs decides whether data.json changed on disk (another process: the stdio bridge)
//     by its modification time and size only. On a file system with coarse timestamps (FAT32 USB
//     sticks: 2 s, HFS+/ext3: 1 s, exFAT: 10 ms, some network shares), a same-size write by the bridge
//     in the same time slot leaves that stamp unchanged: the server does not reload, and its next write
//     puts its stale copy back (the bridge's change is lost and both copies carry the same rev).
//     The coarse file system is simulated by putting every save in one 2-second slot, as FAT32 reports it.
//   - data.json is briefly unreadable (another program holds it open without sharing: a backup or sync
//     client, an editor) when the server or the bridge reloads it: load() handles any read error like
//     invalid JSON and starts with an EMPTY, uninitialized store (the move aside fails while the file
//     is held, though the log says it was moved), and the next write saves that over the real file.
//   - Erase everything leaves the AI change history (ai.json, changes/*.json): undoing an older assistant
//     delete afterwards (Connect AI's Undo, undo_change) puts the erased record back.
//   - Two browsers move two folders into each other at about the same time: each move is valid where it
//     is made, the server takes both, and the folders form a cycle. folderTree() only walks down from
//     top-level folders, so both folders (and the notes filed in them) vanish from the sidebar.
// All four are pinned with `todo` until fixed. Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake browser for the notes core (shared/store.js reads localStorage when it loads).
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { DataStore } = await import('../server/store.mjs');
const { loadValidators } = await import('../server/validate.mjs');
const N = await import('../notes/core/notes.js');
const { db } = await import('../shared/store.js');

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

test(
  'a same-size change the stdio bridge writes in the same timestamp slot is not overwritten by the server',
  { todo: 'DataStore.refresh() compares only {mtimeMs, size}: on file systems with coarse timestamps the server misses a same-size write by the bridge and writes its stale copy over it' },
  async () => {
    const validators = await loadValidators({ log: { error() {}, warn() {}, info() {}, log() {} } });
    const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-data-'));
    dirs.push(dir);
    const file = join(dir, 'data.json');
    const SLOT = 1795400000; // seconds: one 2-second FAT32 time slot
    const coarse = (store) => {
      const save = store.save.bind(store);
      store.save = () => {
        save();
        utimesSync(file, SLOT, SLOT);
        const s = statSync(file);
        store.stampValue = { mtimeMs: s.mtimeMs, size: s.size };
      };
      return store;
    };
    const t0 = 1795400000000;
    const server = coarse(new DataStore({ dir, validators }));
    server.applyOps([{ op: 'put', c: 'tasks', item: { id: 'aaaaaaaaaaaaaaaa', title: 'Call the bank', createdAt: t0, updatedAt: t0 } }]);
    const bridge = coarse(new DataStore({ dir, validators })); // the stdio bridge (its own process in real use)
    bridge.transaction((tx) => tx.put('tasks', { ...tx.get('tasks', 'aaaaaaaaaaaaaaaa'), title: 'Call the vets', updatedAt: t0 + 1 }));
    assert.equal(new DataStore({ dir, validators }).get('tasks', 'aaaaaaaaaaaaaaaa').title, 'Call the vets', 'the bridge saved its change');
    // The browser adds another task through the server.
    server.applyOps([{ op: 'put', c: 'tasks', item: { id: 'bbbbbbbbbbbbbbbb', title: 'Buy milk', createdAt: t0, updatedAt: t0 } }]);
    const disk = new DataStore({ dir, validators });
    assert.equal(disk.get('tasks', 'bbbbbbbbbbbbbbbb')?.title, 'Buy milk');
    assert.equal(disk.get('tasks', 'aaaaaaaaaaaaaaaa').title, 'Call the vets', 'the bridge’s change survives the server’s next write');
    assert.ok(disk.rev > 2, 'and the rev moved past both writes');
  },
);

/**
 * Make `file` unreadable for a moment, as another program does that opens it without sharing (a backup
 * or sync client, an editor): on Windows a PowerShell process holds it open with FileShare None; on
 * other systems its permissions are removed. Resolves to release() once reads fail, or null when the
 * situation cannot be made here.
 */
async function holdUnreadable(file) {
  const fails = () => {
    try {
      readFileSync(file);
      return false;
    } catch {
      return true;
    }
  };
  if (process.platform === 'win32') {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None'); [Console]::In.ReadLine() | Out-Null; $f.Close()`], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const gone = new Promise((r) => ps.once('exit', r));
    for (let i = 0; i < 100 && !fails(); i++) await new Promise((r) => setTimeout(r, 100));
    if (!fails()) {
      ps.kill();
      return null;
    }
    return async () => {
      ps.stdin.end('\n');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    };
  }
  if (process.getuid?.() === 0) return null; // root reads anything
  chmodSync(file, 0o000);
  if (!fails()) {
    chmodSync(file, 0o600);
    return null;
  }
  return async () => chmodSync(file, 0o600);
}

test(
  'data.json that is briefly unreadable when the server reloads it is not replaced by an empty store',
  { todo: 'DataStore.load() treats any read error (EBUSY, EACCES) like invalid JSON: it logs that the file was moved aside (the rename fails while the file is held), starts empty and uninitialized, and the next write saves that empty store over the real data.json' },
  async (t) => {
    const validators = await loadValidators({ log: { error() {}, warn() {}, info() {}, log() {} } });
    const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-data-'));
    dirs.push(dir);
    const file = join(dir, 'data.json');
    const quiet = { error() {}, warn() {}, info() {}, log() {} };
    const store = new DataStore({ dir, validators, log: quiet });
    const t0 = Date.now();
    store.applyOps(Array.from({ length: 5 }, (_, i) => ({ op: 'put', c: 'tasks', item: { id: `real${String(i).padStart(12, '0')}`, title: `Real task ${i + 1}`, createdAt: t0, updatedAt: t0 } })));
    // Another program writes the file's time and holds it open without sharing for a moment.
    const later = new Date(Date.now() + 2000);
    utimesSync(file, later, later);
    const release = await holdUnreadable(file);
    if (!release) return t.skip('cannot make data.json unreadable here');
    try {
      store.refresh(); // the server's 1.5-second poll (or the bridge before a tool call)
    } finally {
      await release();
    }
    assert.equal(store.all('tasks').length, 5, 'the server still serves the five tasks');
    store.applyOps([{ op: 'put', c: 'tasks', item: { id: 'newone0000000001', title: 'Typed afterwards', createdAt: Date.now(), updatedAt: Date.now() } }]);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')).data.tasks.map((x) => x.title);
    assert.equal(onDisk.length, 6, `data.json keeps the five tasks and the new one (on disk: ${onDisk.join(', ')})`);
  },
);

test(
  'after Erase everything, undoing an older assistant change does not bring erased data back',
  { todo: 'Erase everything (one replace per collection) leaves the AI change history: Connect AI’s Undo (core.undo, POST /api/ai/undo) or undo_change of an earlier delete_items restores the erased task, and find_changes still names erased notes' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-data-'));
    dirs.push(dir);
    const quiet = { error() {}, warn() {}, info() {}, log() {} };
    const { createCore } = await import('../server/core.mjs');
    const core = await createCore({ dataDir: dir, log: quiet });
    try {
      core.store.importData({ data: {}, settings: {} });
      const client = core.ai.createClient({ kind: 'claude', access: 'write' });
      const made = core.callTool('create_tasks', { tasks: [{ title: 'Old private task' }] }, { client });
      const id = made.structuredContent.created[0].task_id;
      const del = core.callTool('delete_items', { items: [{ type: 'task', id }] }, { client });
      assert.ok(!del.isError && del.structuredContent.change_id, 'the assistant deleted it');
      // Settings > Erase everything: the browser replaces every collection with nothing.
      core.store.applyOps(['tasks', 'lists', 'events', 'calendars', 'notes', 'folders'].map((c) => ({ op: 'replace', c, items: [] })));
      assert.equal(core.store.all('tasks').length, 0);
      try {
        core.undo(del.structuredContent.change_id); // Undo in Connect AI's activity list
      } catch {}
      assert.deepEqual(core.store.all('tasks').map((t) => t.title), [], 'the erased task stays erased');
    } finally {
      core.close();
    }
  },
);

test(
  'two folders moved into each other from two browsers still show in the folder tree',
  { todo: 'Concurrent folder moves make a parent cycle on the server; folderTree() walks down from top-level folders only, so both folders disappear from the sidebar (and cannot be renamed, moved or deleted)' },
  () => {
    const recipes = N.createFolder({ name: 'Recipes' });
    const travel = N.createFolder({ name: 'Travel' });
    N.createNote({ folderId: recipes.id, blocks: [{ t: 'h1', c: [['Lasagne']] }] });
    N.createNote({ folderId: travel.id, blocks: [{ t: 'h1', c: [['Lisbon hotels']] }] });
    // Browser 1 moved Recipes into Travel; browser 2, at the same time, moved Travel into Recipes.
    // Each move was checked where it was made; the server applied both (whole-record puts).
    db.put('folders', { ...db.get('folders', recipes.id), parentId: travel.id, updatedAt: Date.now() });
    db.put('folders', { ...db.get('folders', travel.id), parentId: recipes.id, updatedAt: Date.now() + 1 });
    const shown = N.folderTree().map((e) => e.folder.name);
    assert.ok(shown.includes('Recipes'), `Recipes is in the folder tree (shown: ${shown.join(', ')})`);
    assert.ok(shown.includes('Travel'), 'Travel is in the folder tree');
  },
);
