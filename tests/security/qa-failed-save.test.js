// QA security: what happens when a save fails (disk full, a read-only data.json on Windows, a sync
// tool holding the file). The data files must stay the single source of truth: a change that could
// not be saved must not live on in memory, and an assistant must not be shown local paths.
//
// The save is made to fail once by replacing the store's save() for one call, with the error a real
// write gives (Node's fs errors carry the file's path). On Windows the same happens for real when
// data.json has the read-only attribute: see the PoC in the QA notes.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createScope, startServer, api, legacyCall } from './_harness.js';

const T = {
  phantom: 'A write that cannot be saved is reported as "Nothing was changed" but stays in memory, is served to browsers and is saved later without an undo record',
  aiState: 'AI connection changes that cannot be saved still take effect in memory (a new key works, a removed one comes back)',
  paths: 'An internal error shows the assistant absolute local paths (user name, data folder)',
};

const call = (s, token, name, args) => legacyCall(s, token, 'tools/call', { name, arguments: args });
const resultText = (r) => r.json?.result?.content?.[0]?.text ?? '';
const failOnce = (obj, method, err) => {
  const real = obj[method];
  obj[method] = function () {
    obj[method] = real;
    throw err;
  };
};
const fsError = (code, file) => Object.assign(new Error(`${code}: operation failed, rename '${file}.1234.abcd.tmp' -> '${file}'`), { code });

describe('QA security: failed saves', () => {
  const scope = createScope('qa-save');
  after(() => scope.cleanup());

  test('a tool write whose save fails changes nothing, in memory or later on disk', { todo: T.phantom }, async () => {
    const s = await startServer(scope);
    const token = (await api(s, 'POST', '/api/ai/clients', { kind: 'claude' })).json.client.token;
    assert.ok(!(await call(s, token, 'create_tasks', { tasks: [{ title: 'first' }] })).json.result.isError);
    const revBefore = (await api(s, 'GET', '/api/state')).json.rev;
    failOnce(s.core.store, 'save', fsError('ENOSPC', join(s.dataDir, 'data.json')));
    const r = await call(s, token, 'create_tasks', { tasks: [{ title: 'phantom task' }] });
    assert.equal(r.json.result.isError, true, 'the failed write is reported as an error');
    const st = (await api(s, 'GET', '/api/state')).json;
    assert.equal(st.rev, revBefore, 'the rev did not move');
    assert.ok(!st.data.tasks.some((t) => t.title === 'phantom task'), 'browsers are not served the unsaved task');
    const found = await call(s, token, 'find_tasks', { query: 'phantom' });
    assert.equal(found.json.result.structuredContent.total, 0, 'the assistant does not find the task it was told was not created');
    await call(s, token, 'create_tasks', { tasks: [{ title: 'third' }] });
    const after2 = (await api(s, 'GET', '/api/state')).json;
    assert.ok(!after2.data.tasks.some((t) => t.title === 'phantom task'), 'the next successful save does not write the unsaved task');
  });

  test('connection changes whose save fails do not take effect', { todo: T.aiState }, async () => {
    const s = await startServer(scope);
    const keep = (await api(s, 'POST', '/api/ai/clients', { kind: 'claude' })).json.client;
    failOnce(s.core.ai, 'save', fsError('EPERM', join(s.dataDir, 'ai.json')));
    const made = await api(s, 'POST', '/api/ai/clients', { kind: 'grok' });
    assert.equal(made.status, 500);
    const list = (await api(s, 'GET', '/api/ai')).json.clients;
    assert.ok(!list.some((c) => c.kind === 'grok'), 'a connection that was never saved is not listed and has no working key');

    failOnce(s.core.ai, 'save', fsError('EPERM', join(s.dataDir, 'ai.json')));
    const del = await api(s, 'DELETE', `/api/ai/clients/${keep.id}`);
    assert.equal(del.status, 500);
    // The removal failed, so the connection is still there, here and on disk (no resurrection later).
    assert.ok((await api(s, 'GET', '/api/ai')).json.clients.some((c) => c.id === keep.id), 'the connection the failed removal left is listed');
    const ping = await call(s, keep.token, 'get_context', {});
    assert.equal(ping.status, 200, 'its key works, as the disk copy says');
  });

  test('an internal error shown to an assistant never carries a local path', { todo: T.paths }, async () => {
    const s = await startServer(scope);
    const token = (await api(s, 'POST', '/api/ai/clients', { kind: 'claude' })).json.client.token;
    failOnce(s.core.store, 'save', fsError('EPERM', join(s.dataDir, 'data.json')));
    const r = await call(s, token, 'create_tasks', { tasks: [{ title: 'x' }] });
    const text = resultText(r);
    assert.equal(r.json.result.isError, true);
    assert.ok(!text.toLowerCase().includes(s.dataDir.toLowerCase()), `the reply names the data folder: ${text.slice(0, 200)}`);
    assert.ok(!/[A-Za-z]:\\|\/(?:home|Users|tmp|var)\//.test(text), `the reply contains a file-system path: ${text.slice(0, 200)}`);
  });
});
