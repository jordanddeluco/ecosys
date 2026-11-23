// QA (server fix, second pass): the tool-list check the stdio bridge runs on a timer costs nothing.
//  - core.mcp.notifications(client) never reads data.json: an idle Claude Desktop bridge would
//    otherwise re-read and re-parse it every time a browser saves (every few seconds with Notes open).
//  - It still announces a change of the connection's access or of AI access (ai.json, which the
//    bridge reads anyway), once; a change of notes access is announced with the session's next message.
// In-process: two cores on one data folder, as the HTTP server and a bridge share one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../../server/core.mjs';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-notify-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
const LIST_CHANGED = (m) => m?.method === 'notifications/tools/list_changed';

test('the timer check reads no data.json, still announces access changes once, and notes access comes with the next message', async () => {
  const bridge = await createCore({ dataDir: dir, log: silent }); // the stdio bridge's core
  const server = await createCore({ dataDir: dir, log: silent }); // the HTTP server's, which browsers write through
  try {
    server.store.importData({ data: {}, settings: {} });
    const made = server.ai.createClient({ kind: 'claude', access: 'read', label: 'QA Desktop' });
    const current = () => {
      bridge.ai.refresh(); // what the bridge's currentClient() does
      return bridge.ai.get(made.id);
    };
    const init = bridge.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-desktop', version: '1' } } }, { client: current(), transport: 'stdio' });
    assert.deepEqual(init.body.result.capabilities.tools, { listChanged: true });

    let reads = 0;
    const refresh = bridge.store.refresh.bind(bridge.store);
    bridge.store.refresh = (...a) => {
      reads++;
      return refresh(...a);
    };
    // A browser saves a few times; the bridge sits idle, checking on its timer.
    for (let i = 0; i < 3; i++) server.store.applyOps([{ op: 'put', c: 'tasks', item: { id: `qaIdle${i}`, title: `Typed ${i}`, notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: i, createdAt: 1, updatedAt: Date.now() } }]);
    for (let i = 0; i < 5; i++) assert.deepEqual(bridge.mcp.notifications(current()), [], 'nothing changed for this session');
    assert.equal(reads, 0, 'the timer check did not read data.json');

    // Connect AI switches the connection to Read & write: the next check announces it, once.
    server.ai.updateClient(made.id, { access: 'write' });
    const owed = bridge.mcp.notifications(current());
    assert.equal(owed.length, 1);
    assert.ok(LIST_CHANGED(owed[0]));
    assert.deepEqual(bridge.mcp.notifications(current()), [], 'once');
    assert.equal(reads, 0);

    // Notes access set to Read in a browser: the timer leaves it to the next message.
    server.store.applyOps([{ op: 'settings', patch: { notesAi: 'read' } }]);
    assert.deepEqual(bridge.mcp.notifications(current()), []);
    const pong = bridge.mcp.handle({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }, { client: current(), transport: 'stdio' });
    assert.ok((pong.before || []).some(LIST_CHANGED), 'the next message carries it');
    const tools = bridge.mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { client: current(), transport: 'stdio' }).body.result.tools.map((t) => t.name);
    assert.ok(tools.includes('create_tasks') && !tools.includes('notes_create'), tools.join(','));
  } finally {
    bridge.close();
    server.close();
  }
});
