// QA (stdio bridge): a waiting assistant hears of a tool-list change without sending anything first.
// mcp/stdio-bridge.mjs checks core.mcp.notifications() on a timer, so when Connect AI switches a
// connection from Read only to Read & write, a session that began with initialize gets
// notifications/tools/list_changed on its own, once; a modern (2026-07-28) session gets nothing unasked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AIStore } from '../../server/ai-store.mjs';
import { StdioMcp, makeTempDir, removeDir, LATEST_LEGACY, CLIENT_INFO, sleep } from './helpers.js';

const LIST_CHANGED = (m) => m?.method === 'notifications/tools/list_changed';
const dirs = [];
after(() => dirs.forEach(removeDir));

test('stdio: an access change reaches a waiting legacy session unprompted, once', async () => {
  const dataDir = makeTempDir('ecosys-qa-listwatch-');
  dirs.push(dataDir);
  const ai = new AIStore({ dir: dataDir });
  const c = ai.createClient({ kind: 'claude', access: 'read', label: 'QA Desktop' });
  const bridge = new StdioMcp({ dataDir, clientId: c.id });
  try {
    const init = await bridge.request('initialize', { protocolVersion: LATEST_LEGACY, capabilities: {}, clientInfo: CLIENT_INFO });
    assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
    bridge.notify('notifications/initialized');
    const listed = await bridge.request('tools/list');
    assert.ok(!listed.result.tools.some((t) => t.name === 'create_tasks'), 'read only: no write tools yet');
    const from = bridge.messages.length;
    ai.updateClient(c.id, { access: 'write' }); // what Connect AI does
    const note = await bridge.waitFor(LIST_CHANGED, { from, timeout: 8000, what: 'notifications/tools/list_changed without asking' });
    assert.equal(note.id, undefined, 'a notification, not a request');
    await sleep(3500); // another tick of the bridge's timer
    assert.equal(bridge.messages.slice(from).filter(LIST_CHANGED).length, 1, 'once');
    const relisted = await bridge.request('tools/list');
    assert.ok(relisted.result.tools.some((t) => t.name === 'create_tasks'), 'the new list has the write tools');
    bridge.assertCleanStdout();
  } finally {
    await bridge.close();
  }
});

test('stdio: a modern session (no initialize) is never sent a notification it did not ask for', async () => {
  const dataDir = makeTempDir('ecosys-qa-listwatch-');
  dirs.push(dataDir);
  const ai = new AIStore({ dir: dataDir });
  const c = ai.createClient({ kind: 'claude', access: 'read', label: 'QA Code' });
  const bridge = new StdioMcp({ dataDir, clientId: c.id });
  try {
    await bridge.modern('tools/list');
    const from = bridge.messages.length;
    ai.updateClient(c.id, { access: 'write' });
    await sleep(4000);
    assert.deepEqual(bridge.messages.slice(from), [], 'nothing arrives unasked');
    bridge.assertCleanStdout();
  } finally {
    await bridge.close();
  }
});
