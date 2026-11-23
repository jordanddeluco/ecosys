// The notes access setting binds the core tools over the real transports, however the browser spells
// it: the Connect AI / Settings page saves settings.notesAi through /api/ops, and an assistant on the
// stdio bridge then lists and undoes changes. "Off" in any case (or with spaces) names no note change in
// find_changes and lets undo_change touch no note; "Read" (or a value ecosys doesn't know) still names
// the notes it may read but refuses the undo, as the notes tools refuse notes_update. Isolated server on
// a random port with a temp data folder (helpers.js).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, StdioMcp, LATEST_LEGACY, CLIENT_INFO } from './helpers.js';

const MASK = 'Changed a note or folder that is hidden from AI assistants';

describe('notes access in find_changes and undo_change, set from the browser (stdio bridge)', () => {
  /** @type {import('./helpers.js').Server} */
  let server;
  /** @type {StdioMcp} */
  let bridge;

  before(async () => {
    server = await startServer();
    const writer = await server.createClient({ kind: 'claude', access: 'write' });
    bridge = new StdioMcp({ dataDir: server.dataDir, clientId: writer.id });
    const init = await bridge.request('initialize', { protocolVersion: LATEST_LEGACY, capabilities: {}, clientInfo: CLIENT_INFO });
    assert.ok(init.result, JSON.stringify(init.error));
    bridge.notify('notifications/initialized');
  });
  after(async () => {
    if (bridge) await bridge.close().catch(() => bridge.kill());
    await server?.stop();
  });

  /** As a browser tab saves it: a settings op through /api/ops, kept as sent. */
  async function setNotesAi(value) {
    const r = await server.api('POST', '/api/ops', { client: 'notes-access-tab', ops: [{ op: 'settings', patch: { notesAi: value } }] });
    assert.equal(r.status, 200, r.text);
    assert.equal((await server.state()).settings.notesAi, value);
  }
  const noteText = async (id) => JSON.stringify((await server.item('notes', id))?.blocks ?? null);

  test('"Off", " OFF ", "Read" and "ask": no note named while Off, and no undo of a note change either way', async () => {
    const made = await bridge.call('notes_create', { markdown: '# Trip ideas\nLisbon in May.' });
    assert.equal(made.isError, false, made.text);
    const add = await bridge.call('notes_append', { id: made.data.id, markdown: 'Porto too.' });
    assert.equal(add.isError, false, add.text);
    for (const [value, off] of [['Off', true], [' OFF ', true], ['Read', false], ['ask', false]]) {
      const what = JSON.stringify(value);
      await setNotesAi(value);
      const read = await bridge.call('notes_read', { id: made.data.id });
      assert.equal(read.isError, off, `${what}: notes_read ${read.text.slice(0, 80)}`);
      const fc = await bridge.call('find_changes', { limit: 10 });
      assert.equal(fc.isError, false, fc.text);
      const row = fc.data.changes.find((c) => c.change_id === add.data.change_id);
      if (off) {
        assert.equal(row.summary, MASK, what);
        assert.ok(!`${fc.text}${JSON.stringify(fc.data)}`.includes('Trip ideas'), `${what}: ${fc.text}`);
      } else {
        assert.equal(row.summary, 'Added to note "Trip ideas"', what);
      }
      const u = await bridge.call('undo_change', { change_id: add.data.change_id });
      assert.equal(u.isError, true, `${what}: ${u.text}`);
      assert.match(u.text, /notes access set to Read or Off/, what);
      if (off) assert.ok(!u.text.includes('Trip'), `${what}: ${u.text}`);
      assert.match(await noteText(made.data.id), /Porto too/, `${what}: the note is unchanged`);
    }
    // Read & edit again: now the assistant may undo it.
    await setNotesAi('edit');
    const u = await bridge.call('undo_change', { change_id: add.data.change_id });
    assert.equal(u.isError, false, u.text);
    assert.doesNotMatch(await noteText(made.data.id), /Porto too/);
  });
});
