// QA (server, third pass): a session is pointed only to tools it has.
//  - For every combination of the connection's access (Read & write / Read only), notes access (Edit /
//    Read / Off) and the global AI access (Read & write / Read only): every tool name in the
//    instructions, in a listed core tool's description or in the descriptions of its input schema is
//    itself listed. Before, a read-only session was told by plan_tasks to apply its proposal with
//    schedule_tasks and by find_changes to pass change_id to undo_change. Those two now name no write
//    tool at all: a read tool's definition stays the same for every connection (tests/mcp/tools.test.js
//    holds that too), and a session that can write learns both from the instructions, the write tools'
//    own descriptions and the results.
//  - The results and errors of the core tools a session calls name no tool it isn't offered: get_context's
//    working-hours hint, find_free_time's "Next:", plan_tasks' "To apply", get_event's meeting notes and
//    find_tasks' unknown list (a search no longer suggests create_list). find_changes may name the tool
//    that made a change: that is history, not advice.
//  - The notes tools' own descriptions and results (server/tools-notes.mjs, the notes-core owner's) are
//    held to the same rule: todo until that owner's cross request lands (notes_read names notes_update,
//    notes_structure notes_create, and a missing daily or meeting note points to notes_append).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { CORE_TOOLS, toolDefinition } from '../server/tools.mjs';
import { addDaysYmd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-mentions-'));
let core;
let writer;
let reader;
let names; // every tool there is
let mentionRe;
let seed; // ids made before the sessions are checked
const coreNames = new Set(CORE_TOOLS.map((t) => t.name));

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: { calendars: [{ id: 'cal1', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 }] }, settings: {} });
  writer = core.ai.createClient({ kind: 'claude', access: 'write', label: 'QA writer' });
  reader = core.ai.createClient({ kind: 'chatgpt', access: 'read', label: 'QA reader' });
  names = core.tools.map((t) => t.name);
  mentionRe = new RegExp(`\\b(?:${[...names].sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
  const ok = (name, args) => {
    const r = core.callTool(name, args, { client: writer });
    assert.equal(r.isError, false, `${name}: ${r.content[0].text}`);
    return r.structuredContent;
  };
  const task = ok('create_tasks', { tasks: [{ title: 'QA plan me', date: 'tomorrow', duration_minutes: 60 }] }).created[0].task_id;
  const events = ok('create_events', { events: [{ title: 'QA Sync', start: 'tomorrow 10am', calendar: 'Work' }, { title: 'QA Lunch', start: 'tomorrow 12pm', calendar: 'Work' }] }).created;
  ok('notes_create', { event_id: events[0].event_id, markdown: '# QA Sync notes\n\n- [ ] Follow up' });
  const today = ok('get_context', {}).today;
  seed = { task, withNotes: events[0].event_id, withoutNotes: events[1].event_id, noDailyNote: addDaysYmd(today, 3) };
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const rpc = (client, method, params = {}) => core.mcp.handle({ jsonrpc: '2.0', id: 1, method, params }, { client, transport: 'stdio' }).body.result;
/** The tool names a text mentions. */
const mentioned = (s) => [...new Set(String(s).match(mentionRe) || [])];
/** Every description in a JSON schema (properties, items, anyOf/oneOf), with where it is. */
function schemaTexts(sch, path = '', out = []) {
  if (!sch || typeof sch !== 'object') return out;
  if (typeof sch.description === 'string') out.push([path || '(schema)', sch.description]);
  for (const [k, v] of Object.entries(sch.properties || {})) schemaTexts(v, `${path}.${k}`, out);
  if (sch.items) schemaTexts(sch.items, `${path}[]`, out);
  for (const k of ['anyOf', 'oneOf']) (sch[k] || []).forEach((x, i) => schemaTexts(x, `${path}|${i}`, out));
  return out;
}

/** Each combination of the three switches, with the session's client set up for it (put back after). */
function* sessions() {
  try {
    for (const mode of ['write', 'read']) {
      for (const notesAi of ['edit', 'read', 'off']) {
        for (const [who, client] of [['write connection', writer], ['read-only connection', reader]]) {
          core.ai.setMode(mode);
          core.store.applyOps([{ op: 'settings', patch: { notesAi } }]);
          const listed = rpc(client, 'tools/list').tools;
          yield { label: `${who}, notes ${notesAi}, AI access ${mode}`, client, listed, offered: new Set(listed.map((t) => t.name)), canWrite: mode === 'write' && client === writer };
        }
      }
    }
  } finally {
    core.ai.setMode('write');
    core.store.applyOps([{ op: 'settings', patch: { notesAi: 'edit' } }]);
  }
}

/** The names a text gives that the session isn't offered. */
const unlisted = (s, offered) => mentioned(s).filter((n) => !offered.has(n));
/** A call's text (and the tool names find_changes reports as history, which are not advice). */
function callText(client, name, args) {
  const r = core.callTool(name, args, { client });
  let text = r.content.map((c) => c.text).join('\n');
  if (name === 'find_changes' && !r.isError) for (const ch of r.structuredContent.changes) text = text.split(` ${ch.tool}: `).join(' (tool): ');
  return { text, isError: r.isError };
}
/** The core read calls a session can make, errors included. */
const coreReads = () => [
  ['get_overview', {}],
  ['get_context', {}],
  ['find_tasks', {}],
  ['find_tasks', { list: 'Nowhere' }],
  ['get_task', { task_id: seed.task }],
  ['get_task', { task_id: 'nope' }],
  ['find_events', { from: 'today', to: 'in 7 days' }],
  ['get_event', { event_id: seed.withNotes }],
  ['get_event', { event_id: 'nope' }],
  ['find_free_time', { from: 'tomorrow', to: 'in 3 days', duration_minutes: 30 }],
  ['plan_tasks', { items: [{ task_id: seed.task }] }],
  ['plan_tasks', { items: [{ task_id: 'nope' }] }],
  ['find_changes', {}],
];

test('in every combination of access switches, instructions and core tool descriptions name only listed tools', () => {
  let count = 0;
  for (const s of sessions()) {
    const ins = rpc(s.client, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa' } }).instructions;
    assert.deepEqual(unlisted(ins, s.offered), [], `${s.label}: instructions: ${ins}`);
    for (const t of s.listed.filter((x) => coreNames.has(x.name))) {
      assert.deepEqual(unlisted(t.description, s.offered), [], `${s.label}: ${t.name} description: ${t.description}`);
      for (const [where, d] of schemaTexts(t.inputSchema)) assert.deepEqual(unlisted(d, s.offered), [], `${s.label}: ${t.name}${where}: ${d}`);
      assert.ok(t.description.length < 1024, `${t.name}: ${t.description.length} characters`);
    }
    count++;
  }
  assert.equal(count, 12);
  // No read tool's description names a write tool, so it can be the same for every connection.
  const writeNames = new Set(core.tools.filter((t) => t.write).map((t) => t.name));
  for (const t of core.tools.filter((x) => !x.write && coreNames.has(x.name))) {
    const all = toolDefinition(t, names);
    const texts = [all.description, ...schemaTexts(all.inputSchema).map(([, d]) => d)];
    assert.deepEqual(texts.flatMap(mentioned).filter((m) => writeNames.has(m)), [], `${t.name}: ${all.description}`);
  }
  assert.match(toolDefinition(CORE_TOOLS.find((t) => t.name === 'find_changes')).description, /\(newest first\), each with its change_id\./);
  // The session that can write is still told how to apply a plan and undo a change.
  const ins = rpc(writer, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa' } }).instructions;
  assert.match(ins, /plan_tasks proposes time blocks for tasks and schedule_tasks with dry_run:false applies them\./);
  assert.match(ins, /Every change returns a change_id that undo_change can revert\./);
  const wl = rpc(writer, 'tools/list').tools;
  assert.match(wl.find((t) => t.name === 'schedule_tasks').description, /plan_tasks does the same without asking for approval\)\. Call with dry_run:false to apply\./);
  assert.match(wl.find((t) => t.name === 'undo_change').description, /by its change_id \(from a write result or find_changes\)/);
});

test('a read tool has the same definition for a read-only connection as for one that can write', () => {
  try {
    for (const mode of ['write', 'read']) {
      for (const notesAi of ['edit', 'read', 'off']) {
        core.ai.setMode(mode);
        core.store.applyOps([{ op: 'settings', patch: { notesAi } }]);
        const w = rpc(writer, 'tools/list').tools;
        const r = rpc(reader, 'tools/list').tools;
        assert.ok(r.length > 0 && r.every((t) => t.annotations.readOnlyHint === true), 'control: the read-only list holds read tools');
        for (const t of r) assert.deepEqual(t, w.find((x) => x.name === t.name), `notes ${notesAi}, AI access ${mode}: ${t.name}`);
      }
    }
  } finally {
    core.ai.setMode('write');
    core.store.applyOps([{ op: 'settings', patch: { notesAi: 'edit' } }]);
  }
});

test('core tool results and errors name no tool the session is not offered', () => {
  let count = 0;
  for (const s of sessions()) {
    for (const [name, args] of coreReads()) {
      const r = callText(s.client, name, args);
      assert.deepEqual(unlisted(r.text, s.offered), [], `${s.label}: ${name} ${JSON.stringify(args)}: ${r.text}`);
    }
    // A write session's own results too: under notes Read or Off they name no notes tool it lacks.
    if (s.canWrite) {
      const write = (name, args) => {
        const r = core.callTool(name, args, { client: s.client });
        const text = r.content.map((c) => c.text).join('\n');
        assert.equal(r.isError, false, `${s.label}: ${name}: ${text}`);
        assert.deepEqual(unlisted(text, s.offered), [], `${s.label}: ${name}: ${text}`);
        return r.structuredContent;
      };
      const made = write('create_tasks', { tasks: [{ title: `QA task ${count}`, date: 'tomorrow', time: '15:00', duration_minutes: 30 }] }).created[0].task_id;
      write('create_events', { events: [{ title: `QA event ${count}`, start: 'tomorrow 4pm', calendar: 'Work' }] });
      write('schedule_tasks', { items: [{ task_id: seed.task }] });
      write('complete_tasks', { task_ids: [made] });
    }
    count++;
  }
  assert.equal(count, 12);
});

test('a read-only session gets the proposal and the free time without being told to apply or book them', () => {
  const call = (name, args) => callText(reader, name, args).text;
  const plan = call('plan_tasks', { items: [{ task_id: seed.task }] });
  assert.match(plan, /^Proposed time blocks \(nothing changed\):\n- "QA plan me": /);
  assert.ok(!/To apply|schedule_tasks/.test(plan), plan);
  const free = call('find_free_time', { from: 'tomorrow', to: 'in 3 days' });
  assert.match(free, /Free slots of at least 30m/);
  assert.ok(!/Next:/.test(free), free);
  assert.match(call('get_context', {}), /pass working_hours to find_free_time and plan_tasks\)/);
  // The same calls with write access still say how to go on.
  const w = (name, args) => callText(writer, name, args).text;
  assert.match(w('plan_tasks', { items: [{ task_id: seed.task }] }), /\nTo apply, call schedule_tasks with the same items and options and dry_run:false\.$/);
  assert.match(w('find_free_time', { from: 'tomorrow', to: 'in 3 days' }), /\nNext: create_events to book a slot, or schedule_tasks to time-block tasks\.$/);
  assert.match(w('get_context', {}), /pass working_hours to find_free_time, plan_tasks and schedule_tasks\)/);
  // An unknown list in a search names the lists, not how to make one; a tool that files tasks still says.
  const miss = callText(writer, 'find_tasks', { list: 'Nowhere' }).text;
  assert.match(miss, /No list named "Nowhere"\. Lists: "Inbox", none yet\. Today is/);
  assert.match(callText(writer, 'create_tasks', { tasks: [{ title: 'QA filed', list: 'Nowhere' }] }).text, /Use create_list to add one\./);
  // get_event names notes_read with the meeting notes only while it is offered (here: always with them).
  assert.match(w('get_event', { event_id: seed.withNotes }), /Meeting notes: .*note_id=.* \(notes_read with that id opens them\)\./);
});

test(
  'the notes tools name only listed tools in their descriptions, results and errors',
  { todo: 'pending the notes-core owner (server/tools-notes.mjs): notes_read and notes_structure descriptions without write tools, and results and errors that name one only when ctx.offers it' },
  () => {
    const bad = [];
    for (const s of sessions()) {
      for (const t of s.listed.filter((x) => !coreNames.has(x.name))) {
        for (const n of unlisted(t.description, s.offered)) bad.push(`${s.label}: ${t.name} description -> ${n}`);
        for (const [where, d] of schemaTexts(t.inputSchema)) for (const n of unlisted(d, s.offered)) bad.push(`${s.label}: ${t.name}${where} -> ${n}`);
      }
      if (!s.offered.has('notes_read')) continue;
      const calls = [
        ['notes_list', {}],
        ['notes_search', { query: 'QA' }],
        ['notes_structure', {}],
        ['notes_read', { event_id: seed.withNotes }],
        ['notes_read', { event_id: seed.withoutNotes }],
        ['notes_read', { day: seed.noDailyNote }],
      ];
      for (const [name, args] of calls) for (const n of unlisted(callText(s.client, name, args).text, s.offered)) bad.push(`${s.label}: ${name} ${JSON.stringify(args)} -> ${n}`);
    }
    assert.deepEqual(bad, []);
  },
);
