// update_event keeps meeting notes linked, as the Schedule app does (server/tools.mjs): a meeting note
// is linked to one occurrence, note.event = {id, date}. Editing one occurrence on its own ('this'),
// splitting a series ('following') or moving its days ('all') moves the links in the same change, so
// undo_change puts them back with the event. Notes hidden from AI follow too, but no result mentions them
// (server/core.mjs undoes the links as bookkeeping, never counted or named).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCore } from '../server/core.mjs';
import { ymd, addDaysYmd, parseYmd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const text = (r) => r.content[0].text;
/** A Monday at least two weeks away, so every date in a test is in the future. */
const D = (() => {
  let d = addDaysYmd(ymd(new Date()), 14);
  while (parseYmd(d).getDay() !== 1) d = addDaysYmd(d, 1);
  return d;
})();
const day = (n) => addDaysYmd(D, n);

async function withCore(fn) {
  const core = await createCore({ dataDir: mkdtempSync(join(tmpdir(), 'ecosys-meeting-notes-')), log: silent });
  try {
    core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cwork', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
    const client = core.ai.createClient({ kind: 'claude', label: 'Claude' });
    const call = (name, args) => core.callTool(name, args, { client });
    const ok = (r) => {
      assert.equal(r.isError, false, text(r));
      return r.structuredContent;
    };
    await fn({ core, call, ok });
  } finally {
    core.close();
    rmSync(core.dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

let seq = 0;
/** A meeting note on occurrence {id, date} of an event, as the Notes app saves one (synced, not through MCP). */
function putNote(core, event, extra = {}) {
  const id = `mn${++seq}`;
  const t = Date.now() - 60000;
  const item = {
    id, v: 1, rev: 1, blocks: [{ id: `${id}h`, t: 'h1', c: [[extra.title || `Meeting ${id}`]] }, { id: `${id}p`, t: 'p', c: [['Agenda']] }],
    folderId: null, pinned: false, day: null, event, aiHidden: false, aiPrev: null, locked: null, editedBy: 'user', editedAt: t, createdAt: t, updatedAt: t, trashedAt: null, trashedFrom: null,
    ...extra,
  };
  delete item.title;
  const out = core.store.applyOps([{ op: 'put', c: 'notes', item }]);
  assert.deepEqual(out.rejected, []);
  return id;
}
const link = (core, id) => core.store.get('notes', id).event;
const putEvent = (core, item) => {
  const out = core.store.applyOps([{ op: 'put', c: 'events', item: { calendarId: 'cwork', allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1, ...item } }]);
  assert.deepEqual(out.rejected, []);
  return core.store.get('events', item.id);
};
const series = (ok, call, title, repeat = 'FREQ=DAILY;COUNT=10') => ok(call('create_events', { events: [{ title, start: `${D}T09:00`, duration_minutes: 30, calendar: 'Work', repeat }] })).created[0].event_id;

test("update_event 'this': the copy records its occurrence, that day's notes go with it, and undo puts them back", async () => {
  await withCore(async ({ core, call, ok }) => {
    const id = series(ok, call, 'Standup');
    const mine = putNote(core, { id, date: day(2) });
    const other = putNote(core, { id, date: day(3) });
    const revBefore = core.store.get('notes', mine).rev;
    const r = ok(call('update_event', { event_id: id, occurrence: day(2), scope: 'this', start: `${day(3)}T10:00` }));
    const copy = core.store.get('events', r.event.event_id);
    assert.equal(copy.seriesId, id);
    assert.equal(copy.occurrence, day(2), 'the day it replaces in the series');
    assert.deepEqual(link(core, mine), { id: copy.id, date: day(3) }, 'the note follows the copy to its new day');
    assert.equal(core.store.get('notes', mine).rev, revBefore + 1);
    assert.deepEqual(link(core, other), { id, date: day(3) }, 'another day\'s note stays with the series');
    assert.ok(!/note/i.test(text(call('update_event', { event_id: copy.id, title: 'Standup (moved)' }))), 'results say nothing about notes');

    // The undo record covers the link: undo the title change, then the detach.
    const changes = ok(call('find_changes', { limit: 5 })).changes;
    ok(call('undo_change', { change_id: changes[0].change_id }));
    const u = ok(call('undo_change', { change_id: r.change_id }));
    assert.equal(u.restored, 2, 'the series and the copy (links are not counted)');
    assert.equal(core.store.get('events', copy.id), null);
    assert.ok(!core.store.get('events', id).exdates.includes(day(2)));
    assert.deepEqual(link(core, mine), { id, date: day(2) });
    assert.deepEqual(link(core, other), { id, date: day(3) });
    // Redo (undo of the undo) moves it back onto the copy.
    ok(call('undo_change', { change_id: u.change_id }));
    assert.deepEqual(link(core, mine), { id: copy.id, date: day(3) });
  });
});

test("update_event 'following': later notes move to the new series, edited occurrences are re-parented, their notes go to the copy", async () => {
  await withCore(async ({ core, call, ok }) => {
    // A daily series with day 5 edited on its own (the copy), as the apps store it.
    const S = putEvent(core, { id: 'sDaily', title: 'Sync', start: `${D}T09:00`, end: `${D}T09:30`, repeat: { freq: 'day', interval: 1 }, exdates: [day(5)], until: day(9) });
    const X = putEvent(core, { id: 'xDay5', title: 'Sync (long)', start: `${day(5)}T15:00`, end: `${day(5)}T16:00`, seriesId: S.id, occurrence: day(5) });
    const early = putNote(core, { id: S.id, date: day(1) });
    const later = putNote(core, { id: S.id, date: day(4) });
    const viaSeries = putNote(core, { id: S.id, date: day(5) }); // saved before day 5 was edited on its own
    const onCopy = putNote(core, { id: X.id, date: day(5) });
    const last = putNote(core, { id: S.id, date: day(8) });
    const before = Object.fromEntries([early, later, viaSeries, onCopy, last].map((n) => [n, link(core, n)]));
    // From day 3 on, one day later.
    const r = ok(call('update_event', { event_id: S.id, occurrence: day(3), scope: 'following', start: `${day(4)}T09:00` }));
    const R = r.event.event_id;
    assert.notEqual(R, S.id);
    assert.equal(core.store.get('events', S.id).until, day(2));
    assert.deepEqual(link(core, early), { id: S.id, date: day(1) }, 'before the split: unchanged');
    assert.deepEqual(link(core, later), { id: R, date: day(5) }, 'moved with its occurrence to the new series');
    assert.deepEqual(link(core, viaSeries), { id: X.id, date: day(5) }, 'the note of an edited day goes to the copy');
    assert.deepEqual(link(core, onCopy), { id: X.id, date: day(5) }, 'already on the copy');
    assert.deepEqual(link(core, last), { id: R, date: day(9) });
    assert.equal(core.store.get('events', X.id).seriesId, R, 'the edited occurrence belongs to the new series');
    assert.equal(core.store.get('events', X.id).occurrence, day(5));
    // Undo: the series, the copy's parent and every link as they were.
    const u = ok(call('undo_change', { change_id: r.change_id }));
    assert.equal(u.skipped.length, 0);
    assert.equal(core.store.get('events', R), null);
    assert.equal(core.store.get('events', S.id).until, day(9));
    assert.equal(core.store.get('events', X.id).seriesId, S.id);
    for (const [n, l] of Object.entries(before)) assert.deepEqual(link(core, n), l, n);
  });
});

test("update_event 'all': notes move by the days the series (or a single event) moved; time-only and title edits leave them", async () => {
  await withCore(async ({ core, call, ok }) => {
    const id = series(ok, call, 'Review');
    const first = putNote(core, { id, date: D });
    const third = putNote(core, { id, date: day(3) });
    // Two days later, every occurrence (rule, exdates and until move along).
    const r = ok(call('update_event', { event_id: id, start: `${day(2)}T09:00` }));
    assert.equal(r.scope, 'all');
    assert.deepEqual([link(core, first), link(core, third)], [{ id, date: day(2) }, { id, date: day(5) }]);
    // Time only, and title only: no link moves, and the change has the event alone.
    for (const args of [{ start: `${day(2)}T11:00` }, { title: 'Weekly review' }]) {
      const t = ok(call('update_event', { event_id: id, ...args }));
      assert.deepEqual([link(core, first), link(core, third)], [{ id, date: day(2) }, { id, date: day(5) }]);
      assert.deepEqual(core.ai.change(t.change_id).refs, []);
    }
    // A single event moved back a day.
    const single = ok(call('create_events', { events: [{ title: 'Dentist', start: `${day(6)}T14:00`, calendar: 'Work' }] })).created[0].event_id;
    const dn = putNote(core, { id: single, date: day(6) });
    const m = ok(call('update_event', { event_id: single, date: day(5) }));
    assert.deepEqual(link(core, dn), { id: single, date: day(5) });
    ok(call('undo_change', { change_id: m.change_id }));
    assert.deepEqual(link(core, dn), { id: single, date: day(6) });
  });
});

test("update_event 'all': a note saved on a day that was later edited on its own goes to that copy", async () => {
  await withCore(async ({ core, call, ok }) => {
    const S = putEvent(core, { id: 'sWeekly', title: 'Planning', start: `${D}T10:00`, end: `${D}T11:00`, repeat: { freq: 'day', interval: 1 }, exdates: [day(4)], until: day(9) });
    const X = putEvent(core, { id: 'xPlan4', title: 'Planning', start: `${day(4)}T13:00`, end: `${day(4)}T14:00`, seriesId: S.id, occurrence: day(4) });
    const viaSeries = putNote(core, { id: S.id, date: day(4) });
    const plain = putNote(core, { id: S.id, date: day(6) });
    ok(call('update_event', { event_id: S.id, start: `${day(1)}T10:00` }));
    assert.deepEqual(link(core, viaSeries), { id: X.id, date: day(4) });
    assert.deepEqual(link(core, plain), { id: S.id, date: day(7) });
  });
});

test('update_event: an edited occurrence given a repeat of its own leaves its series, with the notes found through it', async () => {
  await withCore(async ({ core, call, ok }) => {
    const S = putEvent(core, { id: 'sOneOne', title: '1:1', start: `${D}T16:00`, end: `${D}T16:30`, repeat: { freq: 'week', interval: 1, days: [1] }, exdates: [day(7)] });
    const X = putEvent(core, { id: 'xOneOne', title: '1:1 (Tue)', start: `${day(8)}T16:00`, end: `${day(8)}T16:30`, seriesId: S.id, occurrence: day(7) });
    const viaSeries = putNote(core, { id: S.id, date: day(7) });
    const onCopy = putNote(core, { id: X.id, date: day(8) });
    const r = ok(call('update_event', { event_id: X.id, repeat: 'weekly' }));
    const own = core.store.get('events', X.id);
    assert.ok(own.repeat);
    assert.equal(own.seriesId, undefined, 'a series of its own');
    assert.equal(own.occurrence, undefined);
    assert.deepEqual(link(core, viaSeries), { id: X.id, date: day(8) });
    assert.deepEqual(link(core, onCopy), { id: X.id, date: day(8) });
    // Deleting the old series no longer takes the new one with it.
    ok(call('delete_items', { items: [{ type: 'event', id: S.id }] }));
    assert.ok(core.store.get('events', X.id));
    assert.ok(r.event);
  });
});

test('meeting notes hidden from AI, locked or deleted follow their event too, and no result or change summary gives them away', async () => {
  await withCore(async ({ core, call, ok }) => {
    const id = series(ok, call, 'Board meeting');
    core.store.applyOps([{ op: 'put', c: 'folders', item: { id: 'fsecret', name: 'Board', parentId: null, color: 'red', order: 0, aiHidden: true, createdAt: 1, updatedAt: 1 } }]);
    const notes = [
      putNote(core, { id, date: day(1) }, { title: 'Secret minutes', aiHidden: true }),
      putNote(core, { id, date: day(1) }, { title: 'Folder minutes', folderId: 'fsecret' }),
      putNote(core, { id, date: day(1) }, { locked: { iv: 'aaaaaaaaaaaaaaaa', ct: 'QUJDRA' } }),
      putNote(core, { id, date: day(1) }, { title: 'Deleted minutes', trashedAt: Date.now() - 1000 }),
    ];
    for (const notesAi of ['edit', 'off']) {
      core.store.transaction((tx) => tx.setSettings({ notesAi }));
      const r = call('update_event', { event_id: id, occurrence: day(1), scope: 'this', start: `${day(1)}T11:00` });
      assert.equal(r.isError, false, text(r));
      const copy = r.structuredContent.event.event_id;
      for (const n of notes) assert.deepEqual(link(core, n), { id: copy, date: day(1) }, `${notesAi}: ${n} follows the copy`);
      const all = `${text(r)}${JSON.stringify(r.structuredContent)}`;
      assert.ok(!/minutes|meeting note/i.test(all) && notes.every((n) => !all.includes(n)), all);
      // The change is listed with its own summary: it edited an event, not a note.
      const row = call('find_changes', { limit: 5 }).structuredContent.changes.find((c) => c.change_id === r.structuredContent.change_id);
      assert.equal(row.summary, 'Edited event "Board meeting"');
      // The assistant's undo puts the links back without counting or naming them.
      const u = call('undo_change', { change_id: r.structuredContent.change_id });
      assert.equal(u.isError, false, text(u));
      assert.equal(u.structuredContent.restored, 2);
      assert.deepEqual(u.structuredContent.skipped, []);
      assert.ok(!/minutes|note|folder/i.test(text(u)) && notes.every((n) => !JSON.stringify(u.structuredContent).includes(n)), text(u));
      for (const n of notes) assert.deepEqual(link(core, n), { id, date: day(1) }, `${notesAi}: ${n} back on the series`);
    }
  });
});

test('undo_change: a link goes back even when the note was edited since, but stays when its event changed again', async () => {
  await withCore(async ({ core, call, ok }) => {
    const id = series(ok, call, 'Retro');
    const n = putNote(core, { id, date: day(2) });
    const r = ok(call('update_event', { event_id: id, occurrence: day(2), scope: 'this', start: `${day(2)}T15:00` }));
    const copy = r.event.event_id;
    // The user takes notes in the meeting (synced from the Notes app).
    const edited = { ...core.store.get('notes', n), blocks: [{ id: 'nb1', t: 'h1', c: [['Retro notes']] }, { id: 'nb2', t: 'p', c: [['Went well: shipping']] }], rev: 7, updatedAt: Date.now() };
    core.store.applyOps([{ op: 'put', c: 'notes', item: edited }]);
    ok(call('undo_change', { change_id: r.change_id }));
    const back = core.store.get('notes', n);
    assert.deepEqual(back.event, { id, date: day(2) }, 'the link went back with the event');
    assert.equal(back.blocks[1].c[0][0], 'Went well: shipping', 'the user\'s text is kept');
    assert.equal(back.rev, 8);

    // A single event moved a day; the user then renames it; the assistant's undo skips the event, and the note stays with it.
    const single = ok(call('create_events', { events: [{ title: 'Offsite', start: `${day(10)}T09:00`, calendar: 'Work' }] })).created[0].event_id;
    const sn = putNote(core, { id: single, date: day(10) });
    const m = ok(call('update_event', { event_id: single, date: day(11) }));
    assert.deepEqual(link(core, sn), { id: single, date: day(11) });
    core.store.applyOps([{ op: 'put', c: 'events', item: { ...core.store.get('events', single), title: 'Offsite (Lisbon)', updatedAt: Date.now() } }]);
    const u = call('undo_change', { change_id: m.change_id });
    assert.equal(u.isError, true);
    assert.match(text(u), /changed again/);
    assert.deepEqual(link(core, sn), { id: single, date: day(11) }, 'still on the day the event is on');
    assert.ok(copy);
  });
});

test('a meeting note saved in an older form (HTML body, no blocks) follows its event as a link too: not a note edit, and undo puts it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-meeting-legacy-'));
  try {
    // data.json as an older ecosys left it: the store keeps records as they were loaded.
    const legacy = { id: 'nLeg', title: 'Legacy minutes', body: '<p>Secret legacy minutes</p>', folderId: null, event: { id: 'sLeg', date: day(2) }, aiHidden: true, createdAt: 5, updatedAt: 5 };
    const event = { id: 'sLeg', title: 'Weekly sync', calendarId: 'cwork', allDay: false, start: `${D}T09:00`, end: `${D}T09:30`, location: '', notes: '', repeat: { freq: 'day', interval: 1 }, exdates: [], until: day(6), createdAt: 1, updatedAt: 1 };
    const cal = { id: 'cwork', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 };
    writeFileSync(join(dir, 'data.json'), JSON.stringify({ format: 1, rev: 1, initialized: true, data: { tasks: [], lists: [], events: [event], calendars: [cal], notes: [legacy], folders: [] }, settings: {} }));
    const core = await createCore({ dataDir: dir, log: silent });
    try {
      const client = core.ai.createClient({ kind: 'claude' });
      const call = (name, args) => core.callTool(name, args, { client });
      assert.equal(core.store.get('notes', 'nLeg').blocks, undefined, 'still in its older form');
      const r = call('update_event', { event_id: 'sLeg', occurrence: day(2), scope: 'this', start: `${day(2)}T11:00` });
      assert.equal(r.isError, false, text(r));
      const copy = r.structuredContent.event.event_id;
      const moved = core.store.get('notes', 'nLeg');
      assert.deepEqual(moved.event, { id: copy, date: day(2) }, 'the note follows the copy');
      assert.match(JSON.stringify(moved.blocks), /Secret legacy minutes/, 'written in today\'s form, its text kept');
      assert.deepEqual([moved.editedAt, moved.createdAt, moved.aiHidden], [5, 5, true], 'its times and Hide from AI are as they were');
      // Not an edit of the (hidden) note: the change lists no note, and find_changes names the event.
      assert.deepEqual(core.ai.change(r.structuredContent.change_id).refs, []);
      const row = call('find_changes', { limit: 5 }).structuredContent.changes.find((c) => c.change_id === r.structuredContent.change_id);
      assert.equal(row.summary, 'Edited event "Weekly sync"');
      // The assistant's undo takes the copy away and puts the link back on the series, saying nothing about it.
      const u = call('undo_change', { change_id: r.structuredContent.change_id });
      assert.equal(u.isError, false, text(u));
      assert.equal(u.structuredContent.restored, 2);
      assert.deepEqual(u.structuredContent.skipped, []);
      assert.ok(!/Legacy|Secret|note/i.test(text(u)), text(u));
      assert.equal(core.store.get('events', copy), null);
      assert.deepEqual(core.store.get('notes', 'nLeg').event, { id: 'sLeg', date: day(2) });
      assert.match(JSON.stringify(core.store.get('notes', 'nLeg').blocks), /Secret legacy minutes/);
    } finally {
      core.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('without notes/core/schema.js, update_event leaves meeting notes as they are (a write would drop their blocks)', async () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-meeting-degraded-'));
  try {
    const note = { id: 'mnDeg', v: 1, rev: 2, blocks: [{ id: 'd1', t: 'h1', c: [['Kickoff']] }, { id: 'd2', t: 'p', c: [['Decisions so far']] }], title: 'Kickoff', tags: [], links: [], folderId: null, pinned: false, day: null, event: { id: 'sDeg', date: day(1) }, aiHidden: false, aiPrev: null, locked: null, editedBy: 'user', editedAt: 1, createdAt: 1, updatedAt: 1, trashedAt: null, trashedFrom: null };
    const event = { id: 'sDeg', title: 'Kickoff', calendarId: 'cwork', allDay: false, start: `${D}T09:00`, end: `${D}T09:30`, location: '', notes: '', repeat: { freq: 'day', interval: 1 }, exdates: [], until: day(5), createdAt: 1, updatedAt: 1 };
    const cal = { id: 'cwork', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 };
    writeFileSync(join(dir, 'data.json'), JSON.stringify({ format: 1, rev: 1, initialized: true, data: { tasks: [], lists: [], events: [event], calendars: [cal], notes: [note], folders: [] }, settings: {} }));
    const script = join(dir, 'child.mjs');
    const url = (rel) => pathToFileURL(join(ROOT, rel)).href;
    writeFileSync(script, `
      import { registerHooks } from 'node:module';
      registerHooks({ load(u, ctx, next) { return u.endsWith('/notes/core/schema.js') ? { format: 'module', source: 'throw new Error("schema exploded")', shortCircuit: true } : next(u, ctx); } });
      const { createCore } = await import(${JSON.stringify(url('server/core.mjs'))});
      const silent = { warn() {}, error() {}, info() {}, log() {} };
      const core = await createCore({ dataDir: ${JSON.stringify(dir)}, log: silent });
      const client = core.ai.createClient({ kind: 'claude' });
      const r = core.callTool('update_event', { event_id: 'sDeg', occurrence: ${JSON.stringify(day(1))}, scope: 'this', start: ${JSON.stringify(`${day(2)}T10:00`)} }, { client });
      const u = core.callTool('undo_change', { change_id: r.structuredContent?.change_id }, { client });
      core.close();
      console.log(JSON.stringify({ notes: core.validators.notes, isError: r.isError, text: r.content[0].text, undoError: u.isError, copies: core.store.all('events').length }));
    `);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { code, out, err } = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [script], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let o = '';
      let e = '';
      p.stdout.on('data', (c) => (o += c));
      p.stderr.on('data', (c) => (e += c));
      p.on('error', reject);
      p.on('close', (c) => resolve({ code: c, out: o, err: e }));
    });
    assert.equal(code, 0, err);
    const result = JSON.parse(out.trim().split('\n').at(-1));
    assert.equal(result.notes, false, 'the schema did not load');
    assert.equal(result.isError, false, result.text);
    assert.equal(result.undoError, false);
    const saved = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).data.notes.find((n) => n.id === 'mnDeg');
    assert.deepEqual(saved, note, 'the note was not rewritten: blocks and link as they were');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
