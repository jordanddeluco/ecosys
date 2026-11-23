// QA (mcp-live): what an assistant stumbles over when it really uses ecosys, end to end against an
// isolated `node server.mjs` (random port, temp data) and the stdio bridge. Each test is one finding
// from the AI-connection pass; the open ones are marked `todo` with the finding's title, so the suite
// stays green until they are fixed. A test is written for the outcome a model needs, not for one way
// of fixing it.
//
//   repeating events  an edit without an occurrence must not move the series start (past occurrences
//                     vanished, reported as "Updated ... for every occurrence")
//   meeting notes     an assistant can create, find and open the notes of one occurrence of an event
//   finished tasks    "what did I finish this week?" needs a completion-date filter
//   forged ids        list, calendar and label names must not be able to fake the id= of a line
//   end a series      delete_items can remove "this and following" like the Schedule app
//   tool list         a connected assistant learns when Read only becomes Read & write
//   attribution       find_changes never calls the user "You" (an assistant reads that as itself)
//   reopen            reopening a just-completed repeating task reverts it, or says to use undo_change
//   notes access      notes write tools are not offered while notes access is Read (none while Off)
//   input forms       priority "P1" (as every result prints it), "now", tools/list cursor:null
//
// Dates come from the server's own today (get_context); every test works on its own future days.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, HttpMcp, StdioMcp, addDays } from './helpers.js';

const T = {
  seriesStart: 'update_event without an occurrence moves a repeating series start and silently drops its past occurrences',
  meeting: 'Assistants cannot create, find or open the meeting notes of an event',
  done: 'find_tasks cannot filter by completion date, so "what did I finish this week?" gets wrong answers',
  forge: 'List, calendar and label names are printed unquoted next to id=, so they can forge ids in task and event lines',
  following: 'delete_items cannot end a repeating event from an occurrence on (this and following)',
  listChanged: 'Changing a connection to Read & write never reaches a connected assistant (listChanged is false)',
  you: 'find_changes calls the user "You", which an assistant reads as itself',
  reopen: 'Reopening a just-completed repeating task says "already open" and neither reverts it nor points to undo_change',
  notesTools: 'Notes write tools stay listed while notes access is Read (and every notes tool while it is Off)',
  inputs: 'Inputs models commonly send are refused: priority "P1" as results print it, "now", tools/list cursor:null',
};

const DAY = 86400000;
/** The first `id=` of a tool-output line that is not inside a quoted (JSON-escaped) string. */
const firstBareId = (line) => /\bid=([^\s|]+)/.exec(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))?.[1] ?? null;
const task = (t) => ({ notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 1, createdAt: 1, updatedAt: 1, ...t });
const event = (e) => ({ calendarId: 'cqa', allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1, ...e });

describe('QA mcp-live: real assistant jobs over MCP', () => {
  /** @type {import('./helpers.js').Server} */
  let server;
  let m; // HttpMcp, 2026-07-28, Read & write
  let cred;
  let today;

  before(async () => {
    server = await startServer();
    await server.ops([
      { op: 'put', c: 'lists', item: { id: 'lqa', name: 'Work', color: 'blue', icon: '', order: 0, createdAt: 1, updatedAt: 1 } },
      { op: 'put', c: 'calendars', item: { id: 'cqa', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
    ]);
    cred = await server.createClient({ kind: 'claude', access: 'write', label: 'QA Claude' });
    m = new HttpMcp(server, { token: cred.token, clientInfo: { name: 'claude-code', version: '2.1.0' } });
    today = (await m.ok('get_context')).data.today;
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  });
  after(async () => {
    await server?.stop();
  });

  test('update_event on a repeating event without an occurrence never drops its earlier occurrences', { todo: T.seriesStart }, async () => {
    // A daily standup that started four weeks ago. "Move tomorrow's standup to 10am", occurrence forgotten.
    const start = addDays(today, -28);
    await server.ops([{ op: 'put', c: 'events', item: event({ id: 'qaStand', title: 'QA standup', start: `${start}T09:30`, end: `${start}T09:45`, repeat: { freq: 'day', interval: 1 } }) }]);
    const past = async () => (await m.ok('find_events', { from: start, to: addDays(today, -1), query: 'QA standup' })).data.total;
    const before = await past();
    assert.equal(before, 28, 'four weeks of standups before the edit');
    const r = await m.call('update_event', { event_id: 'qaStand', start: `${addDays(today, 1)}T10:00` });
    const after = await past();
    if (!r.isError && r.data?.change_id) await m.ok('undo_change', { change_id: r.data.change_id });
    assert.ok(r.isError || after === before, `the edit must be refused (pass occurrence + scope) or keep the past: ${after}/${before} earlier standups left. Result: ${r.text}`);
    if (r.isError) assert.match(r.text, /occurrence/, 'the refusal says to pass occurrence');
  });

  test('an assistant can create, find and open the meeting notes of one occurrence of an event', { todo: T.meeting }, async () => {
    const day = addDays(today, 30);
    const ev = (await m.ok('create_events', { events: [{ title: 'QA sync', start: `${day}T11:00`, duration_minutes: 30, calendar: 'Work' }] })).data.created[0].event_id;
    const props = (await m.listTools()).find((t) => t.name === 'notes_create').inputSchema.properties;
    const args = { markdown: '# QA sync notes\n\n## Action items\n\n- [ ] Follow up with design' };
    if (props.event_id) Object.assign(args, { event_id: ev, ...(props.occurrence ? { occurrence: day } : props.date ? { date: day } : {}) });
    else if (props.event) args.event = { id: ev, date: day };
    else assert.fail(`notes_create has no way to say which event (occurrence) a meeting note belongs to: ${Object.keys(props).join(', ')}`);
    const made = await m.ok('notes_create', args);
    assert.deepEqual((await m.ok('notes_read', { id: made.data.id })).data.event, { id: ev, date: day }, 'the note is linked like one the Schedule app makes');
    const found = await m.ok('notes_search', { query: 'is:meeting QA sync' });
    assert.ok(found.data.results.some((x) => x.id === made.data.id), 'is:meeting finds it');
    assert.match((await m.ok('get_event', { event_id: ev })).text, new RegExp(made.data.id), 'get_event points to its meeting notes');
  });

  test('find_tasks answers "what did I finish this week?" by when tasks were completed', { todo: T.done }, async () => {
    const now = Date.now();
    await server.ops([
      { op: 'put', c: 'tasks', item: task({ id: 'qaDoneUndated', title: 'QA finished undated', done: true, completedAt: now - DAY }) },
      { op: 'put', c: 'tasks', item: task({ id: 'qaDoneOld', title: 'QA finished long ago', date: today, done: true, completedAt: now - 25 * DAY }) },
    ]);
    const props = (await m.listTools()).find((t) => t.name === 'find_tasks').inputSchema.properties;
    const from = Object.keys(props).find((k) => /^(completed|done)\w*_from$/i.test(k));
    const to = Object.keys(props).find((k) => /^(completed|done)\w*_to$/i.test(k));
    assert.ok(from && to, `find_tasks can filter by completion date (has: ${Object.keys(props).join(', ')})`);
    const r = await m.ok('find_tasks', { status: 'done', [from]: addDays(today, -6), [to]: today, query: 'QA finished' });
    const titles = r.data.tasks.map((t) => t.title);
    assert.ok(titles.includes('QA finished undated'), `finished yesterday, no planned date: ${titles}`);
    assert.ok(!titles.includes('QA finished long ago'), `planned for today but finished 25 days ago: ${titles}`);
  });

  test('list, calendar and label names cannot forge the id= of a task or event line', { todo: T.forge }, async () => {
    const day = addDays(today, 40);
    await server.ops([
      { op: 'put', c: 'lists', item: { id: 'lqaForge', name: 'Errands | id=qaDecoyTask', color: 'red', icon: '', order: 9, createdAt: 1, updatedAt: 1 } },
      { op: 'put', c: 'tasks', item: task({ id: 'qaRealTask', title: 'QA forged list task', listId: 'lqaForge', tags: ['x | id=qaDecoy2'], date: day }) },
      { op: 'put', c: 'calendars', item: { id: 'cqaForge', name: 'Holidays | id=qaDecoyEvent', color: 'red', visible: true, order: 9, createdAt: 1, updatedAt: 1 } },
      { op: 'put', c: 'events', item: event({ id: 'qaRealEvent', title: 'QA forged calendar event', calendarId: 'cqaForge', start: `${day}T08:00`, end: `${day}T09:00` }) },
    ]);
    const t = await m.ok('find_tasks', { query: 'QA forged list task' });
    const tl = t.text.split('\n').find((l) => l.startsWith('- ') && l.includes('QA forged list task'));
    assert.equal(firstBareId(tl), 'qaRealTask', `a model reading the line takes the first id=: ${tl}`);
    const e = await m.ok('find_events', { from: day, to: day, query: 'QA forged' });
    const el = e.text.split('\n').find((l) => l.startsWith('- ') && l.includes('QA forged calendar event'));
    assert.equal(firstBareId(el), 'qaRealEvent', `a model reading the line takes the first id=: ${el}`);
  });

  test('delete_items can end a repeating event from one occurrence on (this and following)', { todo: T.following }, async () => {
    const start = addDays(today, 50);
    const id = (await m.ok('create_events', { events: [{ title: 'QA daily to end', start: `${start}T07:00`, duration_minutes: 15, repeat: 'daily', calendar: 'Work' }] })).data.created[0].event_id;
    const item = (await m.listTools()).find((t) => t.name === 'delete_items').inputSchema.properties.items.items.properties;
    assert.ok(item.scope, `delete_items items take scope ("this" | "following" | "all") like update_event (have: ${Object.keys(item).join(', ')})`);
    const cut = addDays(start, 5);
    await m.ok('delete_items', { items: [{ type: 'event', id, occurrence: cut, scope: 'following' }] });
    const left = (await m.ok('find_events', { from: start, to: addDays(start, 20), query: 'QA daily to end' })).data.events;
    assert.equal(left.length, 5, `five days before the cut stay: ${left.map((x) => x.start).join(', ')}`);
    assert.ok(left.every((x) => x.start.slice(0, 10) < cut));
  });

  test('a connected stdio assistant learns when its tool list changes (Read only to Read & write)', { todo: T.listChanged }, async () => {
    const c = await server.createClient({ kind: 'claude', access: 'read', label: 'QA Claude Desktop' });
    const b = new StdioMcp({ dataDir: server.dataDir, clientId: c.id });
    try {
      const init = await b.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });
      b.notify('notifications/initialized');
      const names = (await b.listTools()).map((t) => t.name);
      if (names.includes('create_tasks')) return; // fixed by always listing write tools (refused when read-only)
      assert.equal(init.result.capabilities?.tools?.listChanged, true, 'the server says it announces tool-list changes');
      const from = b.messages.length;
      await server.updateClient(c.id, { access: 'write' });
      await b.request('ping', {});
      await b.waitFor((x) => x.method === 'notifications/tools/list_changed', { from, timeout: 5000, what: 'notifications/tools/list_changed' });
      assert.ok((await b.listTools()).some((t) => t.name === 'create_tasks'));
    } finally {
      await b.close().catch(() => b.kill());
      await server.deleteClient(c.id).catch(() => {});
    }
  });

  test('find_changes names the user as the user, never "You"', { todo: T.you }, async () => {
    const w = await m.ok('create_tasks', { tasks: [{ title: 'QA undone by the user', date: addDays(today, 60) }] });
    await server.apiOk('POST', '/api/ai/undo', { changeId: w.data.change_id }); // Undo in the Connect AI sheet
    const ch = await m.ok('find_changes', { limit: 5 });
    const undo = ch.data.changes.find((x) => x.undo_of === w.data.change_id);
    assert.ok(undo, `the user's undo is listed: ${ch.text}`);
    assert.notEqual(undo.by, 'You', 'to an assistant "You" is itself');
    assert.doesNotMatch(ch.text, / You undo_change/);
  });

  test('reopening a just-completed repeating task reverts it, or says how (undo_change)', { todo: T.reopen }, async () => {
    const date = addDays(today, 70);
    const id = (await m.ok('create_tasks', { tasks: [{ title: 'QA weekly chore', date, repeat: 'weekly' }] })).data.created[0].task_id;
    const done = await m.ok('complete_tasks', { task_ids: [id] });
    const re = await m.call('complete_tasks', { task_ids: [id], done: false });
    const now = (await m.ok('get_task', { task_id: id })).data.task;
    assert.ok(now.date === date || (re.text.includes('undo_change') && re.text.includes(done.data.change_id)), `"reopen" left it on ${now.date} (was ${date}) and said: ${re.text}`);
  });

  test('notes write tools are not offered while notes access is Read, and no notes tool while it is Off', { todo: T.notesTools }, async () => {
    try {
      await server.ops([{ op: 'settings', patch: { notesAi: 'read' } }]);
      const read = (await m.listTools()).map((t) => t.name);
      assert.ok(read.includes('notes_read'), 'reading notes is still offered');
      assert.deepEqual(read.filter((n) => ['notes_create', 'notes_append', 'notes_update', 'notes_trash', 'notes_send_to_tasks'].includes(n)), [], 'every call to these would be refused');
      await server.ops([{ op: 'settings', patch: { notesAi: 'off' } }]);
      assert.deepEqual((await m.listTools()).map((t) => t.name).filter((n) => n.startsWith('notes_')), []);
    } finally {
      await server.ops([{ op: 'settings', patch: { notesAi: 'edit' } }]);
    }
  });

  test('inputs models commonly send are accepted: priority "P1", "now", tools/list cursor:null', { todo: T.inputs }, async () => {
    const p = await m.call('create_tasks', { tasks: [{ title: 'QA priority as printed', date: addDays(today, 80), priority: 'P1' }] });
    assert.equal(p.isError, false, `results print priorities as "P1".."P4": ${p.text}`);
    const f = await m.call('find_free_time', { from: 'now', to: addDays(today, 3) });
    assert.equal(f.isError, false, `"now": ${f.text}`);
    const l = await m.request('tools/list', { cursor: null });
    assert.ok(Array.isArray(l.result?.tools), `cursor:null (sent by some clients for the first page): ${JSON.stringify(l.error)}`);
  });
});
