// QA fix (notes-core, second pass; the pinned tests/qa-server-tool-mentions.test.js notes todo): the
// notes tools point an assistant only to tools it has. notes_read and notes_structure are read tools,
// so their descriptions name no write tool at all (a read tool's definition is the same for every
// connection); their results and errors name one only when the session is offered it (ctx.offers): a
// missing daily note or meeting notes, and "Folders: none yet".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { tools as NOTE_TOOLS } from '../server/tools-notes.mjs';
import { addDaysYmd, ymd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-mentions-'));
let core;
let writer;
let reader;
let eventId;
const day = addDaysYmd(ymd(new Date()), 5);

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  writer = core.ai.createClient({ kind: 'claude', access: 'write' });
  reader = core.ai.createClient({ kind: 'chatgpt', access: 'read' });
  core.store.importData({ data: { calendars: [{ id: 'cal1', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 }] }, settings: {} });
  const r = core.callTool('create_events', { events: [{ title: 'Sync', start: 'tomorrow 10am', calendar: 'Work' }] }, { client: writer });
  eventId = r.structuredContent.created[0].event_id;
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const text = (client, name, args) => core.callTool(name, args, { client }).content.map((c) => c.text).join('\n');
const WRITES = NOTE_TOOLS.filter((t) => t.write).map((t) => t.name);

test('the notes read tools\' descriptions name no write tool', () => {
  for (const t of NOTE_TOOLS.filter((x) => !x.write)) {
    const said = [t.description, ...Object.values(t.inputSchema.properties || {}).map((p) => p.description || '')].join(' ');
    assert.deepEqual(WRITES.filter((w) => said.includes(w)), [], t.name);
  }
});

test('a missing daily note, missing meeting notes and no folders point to notes_append / notes_create only when offered', () => {
  const missingDay = (c) => text(c, 'notes_read', { day });
  const missingMeeting = (c) => text(c, 'notes_read', { event_id: eventId });
  const structure = (c) => text(c, 'notes_structure', {});
  assert.match(missingDay(writer), /that AI assistants can open \(notes_append with day starts one when the day has none\)/);
  assert.match(missingMeeting(writer), /that AI assistants can open \(notes_create or notes_append with event_id starts them\)/);
  core.store.transaction((tx) => tx.all('folders').forEach((f) => tx.del('folders', f.id)));
  assert.match(structure(writer), /Folders: none yet \(notes_create with folder creates one\)\./);
  // A read-only connection, and a write connection while notes are Read only for assistants.
  for (const [label, client, notesAi] of [['read-only connection', reader, 'edit'], ['notes read', writer, 'read']]) {
    core.store.applyOps([{ op: 'settings', patch: { notesAi } }]);
    try {
      for (const t of [missingDay(client), missingMeeting(client), structure(client)]) assert.deepEqual(WRITES.filter((w) => t.includes(w)), [], `${label}: ${t}`);
      assert.match(missingDay(client), /^not_found: there is no daily note for \w{3} \S+ that AI assistants can open\./);
      assert.match(structure(client), /Folders: none yet\./);
    } finally {
      core.store.applyOps([{ op: 'settings', patch: { notesAi: 'edit' } }]);
    }
  }
});
