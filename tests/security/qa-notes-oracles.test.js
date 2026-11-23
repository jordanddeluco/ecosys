// QA security: notes hidden from AI must be indistinguishable from notes that do not exist, for the
// write tools too (notes-spec section 7: "asking for one gives the same not_found as a note that
// doesn't exist"). The read tools already answer alike; these probes use the write tools' outcomes
// (an error versus a success) as the signal, which is all an assistant needs to learn a secret.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createScope, startServer, api, legacyCall } from './_harness.js';

const T = {
  daily: 'notes_append with day reveals which days have a daily note hidden from AI (or locked): it refuses there and creates a note on any other day',
  folder: 'notes_create / notes_update reveal whether a folder hidden from AI has a given name (folder_unavailable versus a new folder)',
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (off) => ymd(new Date(Date.now() + off * 86400000));
const call = (s, token, name, args) => legacyCall(s, token, 'tools/call', { name, arguments: args });
const isErr = (r) => r.json?.result?.isError === true;
const text = (r) => r.json?.result?.content?.[0]?.text ?? '';
const blk = (id, t, s) => ({ id, t, c: [[s]] });

async function seeded(scope) {
  const s = await startServer(scope);
  const now = Date.now();
  const data = {
    folders: [{ id: 'fhid', name: 'Therapy', parentId: null, color: 'red', order: 0, aiHidden: true, createdAt: now, updatedAt: now }],
    notes: [
      { id: 'nhid', v: 1, rev: 1, day: day(-3), aiHidden: true, blocks: [blk('a', 'h1', 'Hidden diary'), blk('b', 'p', 'private')], createdAt: now, updatedAt: now, editedAt: now, editedBy: 'user' },
      { id: 'nvis', v: 1, rev: 1, blocks: [blk('c', 'h1', 'Visible note')], createdAt: now, updatedAt: now, editedAt: now, editedBy: 'user' },
      { id: 'ninf', v: 1, rev: 1, folderId: 'fhid', blocks: [blk('d', 'h1', 'Session notes')], createdAt: now, updatedAt: now, editedAt: now, editedBy: 'user' },
    ],
  };
  assert.equal((await api(s, 'POST', '/api/import', { data, settings: {} })).status, 200);
  const token = (await api(s, 'POST', '/api/ai/clients', { kind: 'claude' })).json.client.token;
  return { s, token };
}

describe('QA security: hidden notes leave no trace through the notes write tools', () => {
  const scope = createScope('qa-oracle');
  after(() => scope.cleanup());

  test('the reads already answer alike for a hidden daily note and a missing one (control)', async () => {
    const { s, token } = await seeded(scope);
    const hidden = await call(s, token, 'notes_read', { day: day(-3) });
    const none = await call(s, token, 'notes_read', { day: day(-4) });
    assert.equal(isErr(hidden), isErr(none));
    const norm = (r) => text(r).replace(/\w{3} \d{4}-\d{2}-\d{2}/, 'DAY').replace(/Today is .*/, '');
    assert.equal(norm(hidden), norm(none));
  });

  test('notes_append with day: a day whose daily note is hidden looks like a day without one', { todo: T.daily }, async () => {
    const { s, token } = await seeded(scope);
    const hidden = await call(s, token, 'notes_append', { day: day(-3), markdown: 'probe' });
    const none = await call(s, token, 'notes_append', { day: day(-4), markdown: 'probe' });
    assert.equal(isErr(hidden), isErr(none), `hidden day: ${text(hidden).slice(0, 120)} | empty day: ${text(none).slice(0, 120)}`);
    const st = (await api(s, 'GET', '/api/state')).json;
    const n = st.data.notes.find((x) => x.id === 'nhid');
    assert.equal(n.rev, 1, 'the hidden daily note itself is never changed');
  });

  test('a folder path that names a hidden folder looks like a folder that does not exist', { todo: T.folder }, async () => {
    const { s, token } = await seeded(scope);
    const intoHidden = await call(s, token, 'notes_create', { markdown: '# probe one', folder: 'Therapy' });
    const intoAbsent = await call(s, token, 'notes_create', { markdown: '# probe two', folder: 'Nowhere' });
    assert.equal(isErr(intoHidden), isErr(intoAbsent), `hidden: ${text(intoHidden).slice(0, 120)} | absent: ${text(intoAbsent).slice(0, 120)}`);
    const moveHidden = await call(s, token, 'notes_update', { id: 'nvis', ifRev: 1, folder: 'Therapy/Sub' });
    const rev = (await call(s, token, 'notes_read', { id: 'nvis' })).json.result.structuredContent.rev;
    const moveAbsent = await call(s, token, 'notes_update', { id: 'nvis', ifRev: rev, folder: 'Elsewhere/Sub' });
    assert.equal(isErr(moveHidden), isErr(moveAbsent), `hidden: ${text(moveHidden).slice(0, 120)} | absent: ${text(moveAbsent).slice(0, 120)}`);
    const st = (await api(s, 'GET', '/api/state')).json;
    assert.ok(!st.data.notes.some((x) => x.folderId === 'fhid' && x.id !== 'ninf'), 'nothing is ever filed into the hidden folder');
    assert.ok(!st.data.folders.some((f) => f.parentId === 'fhid'), 'nothing is ever created inside the hidden folder');
  });
});
