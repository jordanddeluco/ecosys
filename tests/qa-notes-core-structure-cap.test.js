// QA fix (notes-core, server cross request): notes_structure is capped like get_context. It returned
// every folder and tag in structuredContent (the core cut it at 256 KB with no word on what was left
// out) and listed every folder in its text, which the core cuts at 60,000 characters mid-line. Now it
// gives at most 500 folders and 200 tags with more_folders / more_tags counts, and its text lists
// folders up to a size that always fits, then says how many more there are and how to reach them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-structure-'));
let core;
let claude;
const call = (name, args = {}) => {
  const r = core.callTool(name, args, { client: claude });
  return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
};
const t0 = Date.now() - 3600000;
const folder = (id, name, parentId = null, extra = {}) => ({ id, name, parentId, color: 'blue', order: 0, aiHidden: false, createdAt: t0, updatedAt: t0, ...extra });
const note = (id, text, extra = {}) => ({ id, v: 1, rev: 1, folderId: null, blocks: [{ id: 'h', t: 'h1', c: [[`Note ${id}`]] }, { id: 'p', t: 'p', c: [[text]] }], editedBy: 'user', editedAt: t0, createdAt: t0, updatedAt: t0, ...extra });

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  claude = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

test('a few folders and tags: all of them, and more_folders / more_tags are 0', () => {
  core.store.applyOps([
    { op: 'put', c: 'folders', item: folder('fw', 'Work') },
    { op: 'put', c: 'folders', item: folder('fc', 'Clients', 'fw') },
    { op: 'put', c: 'notes', item: note('n1', 'Kickoff #acme #work/plan', { folderId: 'fc' }) },
  ]);
  const r = call('notes_structure');
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.data.folders.map((f) => f.path), ['Work', 'Work/Clients']);
  assert.deepEqual([r.data.more_folders, r.data.more_tags], [0, 0]);
  assert.deepEqual(r.data.tags.map((t) => t.name).sort(), ['acme', 'work/plan']);
  assert.doesNotMatch(r.text, /\.\.\.and \d+ more/);
});

test('many long folder names and many tags: capped data with counts, and text that is never cut mid-list', () => {
  // 3 levels of 60-character names (the longest a folder name can be): 20 x 30 = 600 folders below 20 top-level ones.
  const name = (k) => `${String(k).padStart(4, '0')} ${'Quarterly planning and client follow-ups'.padEnd(55, 'x')}`.slice(0, 60);
  const ops = [];
  let k = 0;
  for (let a = 0; a < 20; a++) {
    const top = `t${a}`;
    ops.push({ op: 'put', c: 'folders', item: folder(top, name(k++)) });
    for (let b = 0; b < 30; b++) ops.push({ op: 'put', c: 'folders', item: folder(`${top}s${b}`, name(k++), top) });
  }
  // 300 distinct tags (a note holds at most 100).
  for (let n = 0; n < 3; n++) ops.push({ op: 'put', c: 'notes', item: note(`tags${n}`, Array.from({ length: 100 }, (_, i) => `#tag${n}x${i}`).join(' ')) });
  core.store.applyOps(ops);
  const total = core.store.all('folders').length;
  assert.equal(total, 622, 'control: 620 new folders and the 2 from the first test');
  const r = call('notes_structure');
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.folders.length, 500);
  assert.equal(r.data.more_folders, total - 500);
  assert.equal(r.data.tags.length, 200);
  assert.equal(r.data.more_tags, 302 - 200, '300 tags plus the 2 from the first test');
  assert.equal(r.data.counts.all, 4, 'the totals still count everything');
  // The text: folder lines up to a size that fits, then how many more and how to reach them.
  assert.ok(r.text.length <= 60000, `text is ${r.text.length} characters`);
  assert.doesNotMatch(r.text, /output truncated/);
  const rows = r.text.split('\n').filter((l) => /^- ".*" \(\d+ notes?, \w+\) id=\w+$/.test(l));
  const more = /^- \.\.\.and (\d+) more \(notes_list with folder takes any of them\)$/m.exec(r.text);
  assert.ok(more, r.text.slice(-500));
  assert.equal(rows.length + Number(more[1]), total, 'every folder is either listed or counted');
  assert.ok(rows.length > 100, `${rows.length} folder lines`);
  assert.match(r.text, /Tags: .* and 242 more$/m, 'the text names 60 tags and counts the rest');
  // A folder left out of the list can still be used by its path.
  const shown = new Set(r.data.folders.map((x) => x.id));
  const f = core.store.all('folders').find((x) => !shown.has(x.id) && /^t\d+s\d+$/.test(x.id));
  const path = `${core.store.get('folders', f.parentId).name}/${f.name}`;
  const listed = call('notes_list', { folder: path });
  assert.equal(listed.isError, false, listed.text);
  assert.ok(listed.text.startsWith(`Folder ${JSON.stringify(path)}: 0 notes.`), listed.text);
});
