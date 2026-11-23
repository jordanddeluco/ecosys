// QA (server fix): the tool list follows the user's switches, and connected assistants learn of it.
//  - A stdio session that began with initialize is told listChanged:true. After Connect AI switches
//    its connection to Read & write (or AI access, or notes access, changes), the next message it
//    sends gets notifications/tools/list_changed ahead of the answer, once; its next tools/list shows
//    the new tools. Modern sessions (server/discover) and HTTP keep listChanged:false (no stream: a
//    modern client re-lists after the tools/list ttlMs).
//  - Notes access Read: no notes write tools are listed; Off: no notes tools at all.
//  - tools/list with cursor null or "" is the first page, as some clients send it.
// Against an isolated `node server.mjs` (random port, temp data) and the real stdio bridge.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startServer, HttpMcp, StdioMcp, LATEST_LEGACY, NOTES_TOOLS_FILE, NOTES_READ_TOOLS, NOTES_WRITE_TOOLS } from './helpers.js';

const LIST_CHANGED = (x) => x.method === 'notifications/tools/list_changed';
const init = (b) => b.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });

describe('QA server: tool-list changes', () => {
  /** @type {import('./helpers.js').Server} */
  let server;
  before(async () => {
    server = await startServer();
  });
  after(async () => {
    await server?.stop();
  });

  test('stdio: Read only to Read & write is announced once, before the next answer; the new list has the write tools', async () => {
    const c = await server.createClient({ kind: 'claude', access: 'read', label: 'QA list changed' });
    const b = new StdioMcp({ dataDir: server.dataDir, clientId: c.id });
    try {
      const r = await init(b);
      assert.deepEqual(r.result.capabilities.tools, { listChanged: true });
      b.notify('notifications/initialized');
      assert.ok(!(await b.listTools()).some((t) => t.name === 'create_tasks'), 'control: read-only');
      const from = b.messages.length;
      await b.request('ping', {});
      assert.equal(b.messages.slice(from).filter(LIST_CHANGED).length, 0, 'nothing changed yet: no notification');
      await server.updateClient(c.id, { access: 'write' });
      const at = b.messages.length;
      const pong = await b.request('ping', {});
      const seen = b.messages.slice(at);
      const note = seen.findIndex(LIST_CHANGED);
      assert.ok(note >= 0, `a list_changed notification: ${JSON.stringify(seen)}`);
      assert.ok(note < seen.indexOf(pong), 'it comes ahead of the answer');
      const again = b.messages.length;
      await b.request('ping', {});
      assert.equal(b.messages.slice(again).filter(LIST_CHANGED).length, 0, 'announced once');
      assert.ok((await b.listTools()).some((t) => t.name === 'create_tasks'));
      // AI access set to Read only changes the list again.
      await server.setMode('read');
      const m = b.messages.length;
      await b.request('ping', {});
      assert.ok(b.messages.slice(m).some(LIST_CHANGED), 'AI access Read only is announced too');
      assert.ok(!(await b.listTools()).some((t) => t.name === 'create_tasks'));
    } finally {
      await server.setMode('write').catch(() => {});
      await b.close().catch(() => b.kill());
      await server.deleteClient(c.id).catch(() => {});
    }
  });

  test('stdio modern sessions and HTTP sessions keep listChanged:false and get no unsolicited notification', async () => {
    const c = await server.createClient({ kind: 'claude', access: 'read', label: 'QA modern' });
    const b = new StdioMcp({ dataDir: server.dataDir, clientId: c.id });
    try {
      const d = await b.modern('server/discover');
      assert.deepEqual(d.result.capabilities.tools, { listChanged: false });
      await server.updateClient(c.id, { access: 'write' });
      const from = b.messages.length;
      await b.modern('tools/list');
      await b.modern('tools/list');
      assert.equal(b.messages.slice(from).filter(LIST_CHANGED).length, 0);
    } finally {
      await b.close().catch(() => b.kill());
    }
    const http = new HttpMcp(server, { token: c.token, era: 'legacy', version: LATEST_LEGACY });
    const r = await http.initialize();
    assert.deepEqual(r.result.capabilities.tools, { listChanged: false }, 'a JSON-only HTTP server sends no notifications');
    await server.deleteClient(c.id).catch(() => {});
  });

  test('notes access Read lists no notes write tools, Off no notes tools; stdio sessions are told', async (t) => {
    if (!existsSync(NOTES_TOOLS_FILE)) return t.skip('no notes tools in this checkout');
    const c = await server.createClient({ kind: 'claude', access: 'write', label: 'QA notes access' });
    const http = new HttpMcp(server, { token: c.token });
    const b = new StdioMcp({ dataDir: server.dataDir, clientId: c.id });
    try {
      await init(b);
      const names = async () => (await http.listTools()).map((x) => x.name);
      const all = await names();
      assert.ok(NOTES_WRITE_TOOLS.every((n) => all.includes(n)), 'control: notes access Edit lists them');
      await server.ops([{ op: 'settings', patch: { notesAi: 'read' } }]);
      const read = await names();
      assert.deepEqual(read.filter((n) => NOTES_WRITE_TOOLS.includes(n)), []);
      assert.ok(NOTES_READ_TOOLS.every((n) => read.includes(n)), 'reading notes is still offered');
      assert.ok(read.includes('create_tasks'), 'the other write tools stay');
      const from = b.messages.length;
      await b.request('ping', {});
      assert.ok(b.messages.slice(from).some(LIST_CHANGED), 'the stdio session hears of it');
      await server.ops([{ op: 'settings', patch: { notesAi: 'off' } }]);
      assert.deepEqual((await names()).filter((n) => n.startsWith('notes_')), []);
      await server.ops([{ op: 'settings', patch: { notesAi: 'edit' } }]);
      const back = await names();
      assert.ok([...NOTES_READ_TOOLS, ...NOTES_WRITE_TOOLS].every((n) => back.includes(n)));
    } finally {
      await server.ops([{ op: 'settings', patch: { notesAi: 'edit' } }]).catch(() => {});
      await b.close().catch(() => b.kill());
      await server.deleteClient(c.id).catch(() => {});
    }
  });

  test('tools/list with cursor null or "" is the first page; a real cursor is still refused', async () => {
    const c = await server.createClient({ kind: 'claude', access: 'read', label: 'QA cursor' });
    try {
      for (const era of ['legacy', 'modern']) {
        const m = new HttpMcp(server, { token: c.token, era, ...(era === 'legacy' ? { version: LATEST_LEGACY } : {}) });
        for (const cursor of [null, '']) {
          const r = await m.request('tools/list', { cursor });
          assert.ok(Array.isArray(r.result?.tools), `${era} cursor ${JSON.stringify(cursor)}: ${JSON.stringify(r.error)}`);
        }
        assert.equal((await m.request('tools/list', { cursor: 'page2' })).error?.code, -32602, `${era}: a real cursor`);
      }
    } finally {
      await server.deleteClient(c.id).catch(() => {});
    }
  });
});
