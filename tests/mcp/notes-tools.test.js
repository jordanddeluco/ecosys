// notes_* MCP tools (server/tools-notes.mjs, notes-spec §7 "AI over MCP"), end to end over HTTP and
// stdio against an isolated server. Skipped, with a message, while server/tools-notes.mjs does not
// exist. Parameter names are read from each tool's inputSchema (the spec's names first), so the
// suite checks behaviour rather than spelling; a missing parameter fails with the schema shown.
// (Definitions, annotations and schema/server agreement for notes tools are also covered
// generically by tools.test.js.)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startServer, HttpMcp, StdioMcp, assertTodayLine, addDays, NOTES_TOOLS_FILE, NOTES_READ_TOOLS, NOTES_WRITE_TOOLS, LATEST_LEGACY } from './helpers.js';

const SKIP = existsSync(NOTES_TOOLS_FILE)
  ? false
  : 'server/tools-notes.mjs does not exist yet (the notes builder adds it in stage 2): notes_* MCP tests skipped';

describe('notes_* MCP tools', { skip: SKIP }, () => {
  /** @type {import('./helpers.js').Server} */
  let server;
  let admin;
  let reader;
  let today;
  let defs;

  /** The first of `names` that the tool takes (spec name first). */
  const param = (tool, names) => {
    const props = Object.keys(defs.get(tool)?.inputSchema?.properties || {});
    const k = names.find((n) => props.includes(n));
    assert.ok(k, `${tool} should take ${names.join(' / ')}; its parameters are: ${props.join(', ') || 'none'}`);
    return k;
  };
  const idArg = (tool, id) => ({ [param(tool, ['id', 'note_id', 'noteId'])]: id });
  const mdKey = (tool) => param(tool, ['markdown', 'content', 'text', 'body']);
  const noteId = (d) => d?.id ?? d?.note_id ?? d?.note?.id ?? d?.note?.note_id;
  const revOf = (d) => d?.rev ?? d?.note?.rev;
  const mentions = (r, s) => (JSON.stringify(r.data ?? null) + r.text).includes(s);

  before(async () => {
    server = await startServer();
    const a = await server.createClient({ kind: 'claude', label: 'Notes admin' });
    const r = await server.createClient({ kind: 'chatgpt', access: 'read', label: 'Notes reader' });
    admin = new HttpMcp(server, { token: a.token });
    admin.cred = a;
    reader = new HttpMcp(server, { token: r.token });
    reader.cred = r;
    today = (await admin.ok('get_context')).data.today;
    defs = new Map((await admin.listTools()).map((t) => [t.name, t]));
  });
  after(async () => {
    await server?.stop();
  });

  test('all nine notes tools are offered, with fitting annotations', () => {
    for (const n of [...NOTES_READ_TOOLS, ...NOTES_WRITE_TOOLS]) assert.ok(defs.has(n), `${n} is listed`);
    for (const n of NOTES_READ_TOOLS) assert.equal(defs.get(n).annotations.readOnlyHint, true, `${n} reads`);
    for (const n of NOTES_WRITE_TOOLS) assert.equal(defs.get(n).annotations.readOnlyHint, false, `${n} writes`);
    assert.equal(defs.get('notes_trash').annotations.destructiveHint, true, 'notes_trash deletes (softly)');
    assert.equal(defs.get('notes_update').annotations.destructiveHint, true, 'notes_update replaces content');
    assert.equal(defs.get('notes_create').annotations.destructiveHint, false, 'notes_create only adds');
    for (const n of [...NOTES_READ_TOOLS, ...NOTES_WRITE_TOOLS]) assert.equal(defs.get(n).annotations.openWorldHint, false, n);
    // Prompt-injection wording: note text is the user's data, never instructions.
    const reads = ['notes_read', 'notes_search', 'notes_list'].map((n) => defs.get(n).description).join(' ');
    assert.match(reads, /instruction|user data|user's data|untrusted/i, 'the read tools warn that note text is data, not instructions');
  });

  test('read-only connections get only the read notes tools, and writes are refused', async () => {
    const names = (await reader.listTools()).map((t) => t.name);
    for (const n of NOTES_READ_TOOLS) assert.ok(names.includes(n), `${n} offered read-only`);
    for (const n of NOTES_WRITE_TOOLS) assert.ok(!names.includes(n), `${n} hidden read-only`);
    const before = (await server.state()).data.notes.length;
    const r = await reader.fails('notes_create', { [mdKey('notes_create')]: '# Read-only attempt' });
    assert.match(r.text, /read-only|read only/i);
    assertTodayLine(r.text, { today });
    assert.equal((await server.state()).data.notes.length, before, 'no note was created');
  });

  test('create -> read -> search -> list -> append -> update (ifRev) -> trash (soft) -> undo_change', async () => {
    const marker = `zebracorn${Date.now().toString(36)}`;
    const created = await admin.ok('notes_create', { [mdKey('notes_create')]: `# Groceries ${marker}\n\n- [ ] oat milk\n- [x] bread\n\nFor the week #home` });
    const id = noteId(created.data);
    assert.ok(typeof id === 'string' && id, `notes_create returns the note id: ${JSON.stringify(created.data)}`);
    const rev1 = revOf(created.data);
    assert.ok(Number.isInteger(rev1), `notes_create returns rev: ${JSON.stringify(created.data)}`);
    assert.match(created.data.change_id || '', /^chg_/, 'the write is undoable');

    const read = await admin.ok('notes_read', idArg('notes_read', id));
    assert.ok(mentions(read, 'oat milk') && mentions(read, marker), 'notes_read returns the content');
    assert.ok(mentions(read, `Groceries ${marker}`), 'the title is derived from the first line');
    assert.ok((await server.state()).data.notes.some((n) => n.id === id), 'stored for the notes app');

    const sq = param('notes_search', ['query', 'q']);
    assert.ok(mentions(await admin.ok('notes_search', { [sq]: marker }), id), 'notes_search finds it');
    assert.ok(mentions(await admin.ok('notes_list', {}), id), 'notes_list lists it');
    assert.ok(mentions(await admin.ok('notes_structure', {}), 'home'), 'notes_structure counts the #home tag');

    const ap = await admin.ok('notes_append', { ...idArg('notes_append', id), [mdKey('notes_append')]: '- [ ] eggs' });
    const rev2 = revOf(ap.data);
    assert.ok(Number.isInteger(rev2) && rev2 > rev1, `append bumps rev (${rev1} -> ${rev2})`);
    assert.ok(mentions(await admin.ok('notes_read', idArg('notes_read', id)), 'eggs'));

    const revKey = param('notes_update', ['ifRev', 'if_rev', 'expected_rev', 'rev']);
    const stale = await admin.call('notes_update', { ...idArg('notes_update', id), [revKey]: rev1, [mdKey('notes_update')]: `# Replaced ${marker}` });
    if (!stale.isError) assert.match(JSON.stringify(stale.data), /conflict|current_rev/i, 'a stale ifRev is reported as a conflict');
    assert.ok(!mentions(await admin.ok('notes_read', idArg('notes_read', id)), 'Replaced'), 'a stale update is not applied');
    const upd = await admin.ok('notes_update', { ...idArg('notes_update', id), [revKey]: rev2, [mdKey('notes_update')]: `# Replaced ${marker}\n\nnew body` });
    assert.ok(revOf(upd.data) > rev2);
    const afterUpd = await admin.ok('notes_read', idArg('notes_read', id));
    assert.ok(mentions(afterUpd, 'new body') && !mentions(afterUpd, 'oat milk'));

    const tr = await admin.ok('notes_trash', idArg('notes_trash', id));
    assert.match(tr.data.change_id || '', /^chg_/);
    const gone = await admin.fails('notes_read', idArg('notes_read', id));
    assertTodayLine(gone.text, { today });
    assert.ok(!mentions(await admin.ok('notes_search', { [sq]: marker }), id), 'trashed notes are invisible to search');
    const stored = (await server.state()).data.notes.find((n) => n.id === id);
    assert.ok(stored, 'a soft delete keeps the note (Recently Deleted)');
    assert.ok(stored.trashedAt, 'trashedAt is set');
    await admin.ok('undo_change', { change_id: tr.data.change_id });
    assert.ok(mentions(await admin.ok('notes_read', idArg('notes_read', id)), 'new body'), 'undo_change brings it back');
  });

  test('notes_send_to_tasks turns checklist items into tasks', async () => {
    const created = await admin.ok('notes_create', { [mdKey('notes_create')]: '# Trip prep\n\n- [ ] Renew passport soonest\n- [ ] Book the airport shuttle' });
    const id = noteId(created.data);
    const sent = await admin.ok('notes_send_to_tasks', idArg('notes_send_to_tasks', id));
    assert.ok(mentions(sent, 'Renew passport soonest'), JSON.stringify(sent.data));
    const found = await admin.ok('find_tasks', { query: 'Renew passport soonest', status: 'all' });
    assert.equal(found.data.total, 1, 'the checklist item is a task now');
  });

  test('unknown or trashed note ids are isError results with actionable text and today\'s date', async () => {
    for (const [tool, extra] of [['notes_read', {}], ['notes_append', { [mdKey('notes_append')]: 'x' }], ['notes_trash', {}], ['notes_send_to_tasks', {}]]) {
      const r = await admin.fails(tool, { ...idArg(tool, 'no-such-note'), ...extra });
      assert.match(r.text, /not[ _]found|no note/i, tool);
      assertTodayLine(r.text, { today }, tool);
    }
  });

  test('a note the user hides from AI (synced from the app) is not_found everywhere, like a missing one', async () => {
    const marker = `hidden${Date.now().toString(36)}`;
    const id = noteId((await admin.ok('notes_create', { [mdKey('notes_create')]: `# Secret plans ${marker}\n\n- [ ] something` })).data);
    const stored = (await server.state()).data.notes.find((n) => n.id === id);
    await server.ops([{ op: 'put', c: 'notes', item: { ...stored, aiHidden: true } }]);
    const sq = param('notes_search', ['query', 'q']);
    assert.ok(!mentions(await admin.ok('notes_search', { [sq]: marker }), id), 'not in search');
    assert.ok(!mentions(await admin.ok('notes_list', {}), id), 'not in the list');
    const fake = 'f'.repeat(id.length);
    const norm = (text, x) => text.split(' Today is')[0].replaceAll(x, '<id>');
    for (const [tool, extra] of [['notes_read', {}], ['notes_append', { [mdKey('notes_append')]: 'x' }], ['notes_trash', {}], ['notes_send_to_tasks', {}]]) {
      const hidden = await admin.fails(tool, { ...idArg(tool, id), ...extra });
      assert.match(hidden.text, /not[ _]found/i, `${tool} on a hidden note`);
      const absent = await admin.fails(tool, { ...idArg(tool, fake), ...extra });
      assert.equal(norm(hidden.text, id), norm(absent.text, fake), `${tool}: a hidden note is indistinguishable from one that does not exist`);
    }
    const after = (await server.state()).data.notes.find((n) => n.id === id);
    assert.deepEqual(after.blocks, stored.blocks, 'nothing about it changed');
    await server.ops([{ op: 'put', c: 'notes', item: { ...after, aiHidden: false } }]);
    assert.ok(mentions(await admin.ok('notes_read', idArg('notes_read', id)), marker), 'visible again once unhidden');
  });

  test('the app\'s notes AI setting is enforced: notesAi "read" refuses writes, "off" refuses every notes tool', async () => {
    const created = (await admin.ok('notes_create', { [mdKey('notes_create')]: '# Setting probe\n\n- [ ] probe item' })).data;
    const id = noteId(created);
    // Arguments that every notes tool accepts, so a refusal can only come from the setting.
    const args = (tool, rev) =>
      ({
        notes_list: {},
        notes_structure: {},
        notes_search: { [param('notes_search', ['query', 'q'])]: 'probe' },
        notes_read: idArg('notes_read', id),
        notes_create: { [mdKey('notes_create')]: '# Refused probe' },
        notes_append: { ...idArg('notes_append', id), [mdKey('notes_append')]: 'more' },
        notes_update: { ...idArg('notes_update', id), [param('notes_update', ['ifRev', 'if_rev', 'expected_rev', 'rev'])]: rev, pinned: true },
        notes_trash: idArg('notes_trash', id),
        notes_send_to_tasks: idArg('notes_send_to_tasks', id),
      })[tool];
    const snapshot = async () => {
      const { data } = await server.state();
      return JSON.stringify([data.notes, data.tasks, data.folders]);
    };
    try {
      // 'read', and a value this version doesn't know (never more than read): reads work, every write is refused.
      for (const value of ['read', 'sometimes']) {
        await server.ops([{ op: 'settings', patch: { notesAi: value } }]);
        const before = await snapshot();
        const rev = (await admin.ok('notes_read', idArg('notes_read', id))).data.rev;
        for (const tool of NOTES_READ_TOOLS) assert.equal((await admin.call(tool, args(tool, rev))).isError, false, `${tool} reads with notesAi "${value}"`);
        for (const tool of NOTES_WRITE_TOOLS) {
          const w = await admin.fails(tool, args(tool, rev));
          assert.match(w.text, /ai_access_read_only/, `${tool} with notesAi "${value}"`);
          assertTodayLine(w.text, { today }, tool);
        }
        assert.equal(await snapshot(), before, `notesAi "${value}": nothing was changed`);
      }
      await server.ops([{ op: 'settings', patch: { notesAi: 'off' } }]);
      const before = await snapshot();
      for (const tool of [...NOTES_READ_TOOLS, ...NOTES_WRITE_TOOLS]) {
        const r = await admin.fails(tool, args(tool, revOf(created)));
        assert.match(r.text, /ai_access_off/, tool);
        assert.ok(!r.text.includes('Setting probe') && !r.text.includes('probe item'), `${tool}: nothing about the notes is shown`);
        assertTodayLine(r.text, { today }, tool);
      }
      assert.equal(await snapshot(), before, 'notesAi "off": nothing was changed');
      assert.equal((await admin.call('find_tasks', {})).isError, false, 'tasks and calendar tools are not affected');
    } finally {
      await server.ops([{ op: 'settings', patch: { notesAi: 'edit' } }]);
    }
    assert.equal((await admin.call('notes_list', {})).isError, false, 'back on');
  });

  test('daily notes: notes_append with day creates the note once; notes_read finds it by day', async () => {
    const dayKey = param('notes_append', ['day']);
    const readDay = param('notes_read', ['day']);
    const first = await admin.ok('notes_append', { [dayKey]: 'today', [mdKey('notes_append')]: 'Daily entry one' });
    const id = noteId(first.data);
    const second = await admin.ok('notes_append', { [dayKey]: today, [mdKey('notes_append')]: 'Daily entry two' });
    assert.equal(noteId(second.data), id, 'the same daily note, not a second one');
    const read = await admin.ok('notes_read', { [readDay]: 'today' });
    assert.ok(mentions(read, 'Daily entry one') && mentions(read, 'Daily entry two'));
    const stored = (await server.state()).data.notes.filter((n) => n.day === today && !n.trashedAt);
    assert.equal(stored.length, 1, 'one daily note per date');
    const y = await admin.ok('notes_append', { [dayKey]: 'yesterday', [mdKey('notes_append')]: 'Looking back' });
    assert.equal((await server.state()).data.notes.find((n) => n.id === noteId(y.data)).day, addDays(today, -1));
  });

  test('AI edits are attributed to the assistant and keep the user\'s own version in aiPrev (oldest copy wins)', async () => {
    const now = Date.now();
    const id = `usernote${now.toString(36)}`;
    const userBlocks = [{ id: 'ub1', t: 'h1', c: [['Shopping']] }, { id: 'ub2', t: 'check', ck: false, c: [['milk']] }];
    await server.ops([{ op: 'put', c: 'notes', item: { id, v: 1, rev: 3, blocks: userBlocks, folderId: null, pinned: false, editedBy: 'user', editedAt: now, createdAt: now, updatedAt: now } }]);
    const before = (await server.state()).data.notes.find((n) => n.id === id);
    assert.equal(before.editedBy, 'user');
    await admin.ok('notes_append', { ...idArg('notes_append', id), [mdKey('notes_append')]: '- [ ] eggs' });
    const once = (await server.state()).data.notes.find((n) => n.id === id);
    assert.equal(once.editedBy, 'mcp:claude', 'editedBy names the assistant');
    assert.ok(once.rev > before.rev, 'rev bumped');
    assert.deepEqual(once.aiPrev?.blocks, before.blocks, 'aiPrev holds the user\'s version');
    await admin.ok('notes_append', { ...idArg('notes_append', id), [mdKey('notes_append')]: '- [ ] bread' });
    const twice = (await server.state()).data.notes.find((n) => n.id === id);
    assert.deepEqual(twice.aiPrev, once.aiPrev, 'a second AI edit keeps the older copy');
  });

  test('notes_update block ops: set_checked, replace, insert_after and delete by block id (with ifRev)', async () => {
    const opsKey = param('notes_update', ['ops']);
    const revKey = param('notes_update', ['ifRev', 'if_rev', 'expected_rev', 'rev']);
    const fmt = param('notes_read', ['format']);
    const id = noteId((await admin.ok('notes_create', { [mdKey('notes_create')]: '# Ops probe\n\n- [ ] alpha\n- [ ] beta\n\nplain line' })).data);
    const blocks = async () => {
      const d = (await admin.ok('notes_read', { ...idArg('notes_read', id), [fmt]: 'blocks' })).data;
      assert.ok(Array.isArray(d.blocks), `format blocks returns blocks: ${JSON.stringify(d).slice(0, 200)}`);
      return { rev: d.rev, blocks: d.blocks };
    };
    let { rev, blocks: b } = await blocks();
    const alpha = b.find((x) => x.markdown === 'alpha');
    const beta = b.find((x) => x.markdown === 'beta');
    const plain = b.find((x) => x.markdown === 'plain line');
    assert.ok(alpha && beta && plain, JSON.stringify(b));
    await admin.ok('notes_update', { ...idArg('notes_update', id), [revKey]: rev, [opsKey]: [{ op: 'set_checked', block: alpha.id, checked: true }, { op: 'replace', block: plain.id, markdown: 'changed line' }, { op: 'insert_after', block: beta.id, markdown: '- [ ] gamma' }] });
    ({ rev, blocks: b } = await blocks());
    assert.equal(b.find((x) => x.id === alpha.id).checked, true);
    assert.ok(b.some((x) => x.markdown === 'changed line') && !b.some((x) => x.markdown === 'plain line'));
    const at = b.findIndex((x) => x.id === beta.id);
    assert.equal(b[at + 1]?.markdown, 'gamma', 'inserted right after beta');
    await admin.ok('notes_update', { ...idArg('notes_update', id), [revKey]: rev, [opsKey]: [{ op: 'delete', block: beta.id }] });
    ({ blocks: b } = await blocks());
    assert.ok(!b.some((x) => x.id === beta.id), 'deleted');
    const bad = await admin.fails('notes_update', { ...idArg('notes_update', id), [revKey]: rev + 1, [opsKey]: [{ op: 'set_checked', block: 'nope', checked: true }] });
    assert.match(bad.text, /rev_conflict|no block/i);
  });

  test('HTML is never accepted as markup: it is stored and returned as literal text, fenced as user data', async () => {
    const r = await admin.ok('notes_create', { [mdKey('notes_create')]: 'Literal <script>alert(1)</script> and <img src=x onerror=alert(2)>' });
    const id = noteId(r.data);
    const stored = (await server.state()).data.notes.find((n) => n.id === id);
    const text = JSON.stringify(stored.blocks);
    assert.ok(text.includes('<script>alert(1)</script>'), 'kept as text in a run, not parsed into markup');
    assert.ok(!Object.hasOwn(stored, 'body') || !/<script/i.test(String(stored.body)), 'no HTML body with the script');
    const read = await admin.ok('notes_read', idArg('notes_read', id));
    assert.ok(read.text.includes('alert(1)'));
    assert.match(read.text, /user data|not instructions/i, 'note content is marked as user data in the text');
  });

  test('the stdio bridge offers the same notes tools', async () => {
    const b = new StdioMcp({ dataDir: server.dataDir, clientId: admin.cred.id });
    try {
      const tools = await b.listTools();
      const http = await new HttpMcp(server, { token: admin.cred.token, era: 'legacy', version: LATEST_LEGACY }).listTools();
      assert.deepEqual(tools, http);
      const r = await b.call('notes_structure', {});
      assert.equal(r.isError, false, r.text);
    } finally {
      const closed = await b.close();
      assert.equal(closed.code, 0);
    }
    b.assertCleanStdout();
  });
});
