// QA (server fix): editing and ending repeating events over MCP without losing their history.
//  - update_event on a series that has begun, without an occurrence: a start, date or end with a
//    calendar date is refused without a scope (it would move the whole series there and its earlier
//    occurrences would vanish); with scope "all" it must be an occurrence, and then only says which
//    day's times are meant. A series that has not begun keeps the plain meaning (its new first day).
//    A whole-series result shows the next occurrence, and a move that drops past occurrences says so.
//  - delete_items ends a series from one occurrence on (scope "following"), like the Schedule app.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { addDaysYmd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-events-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: { calendars: [{ id: 'cw', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 }] }, settings: {} });
  const client = core.ai.createClient({ kind: 'claude', access: 'write' });
  const call = (name, args = {}) => {
    const r = core.callTool(name, args, { client });
    return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
  };
  const today = call('get_context').data.today;
  try {
    await fn({ core, call, today });
  } finally {
    core.close();
  }
}
const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r;
};
const daily = (call, start, title = 'Standup') => ok(call('create_events', { events: [{ title, start: `${start}T09:30`, duration_minutes: 15, repeat: 'daily', calendar: 'Work' }] })).data.created[0].event_id;
const count = (call, from, to, query) => ok(call('find_events', { from, to, query })).data.total;

test('a series that has begun: a dated start without occurrence and scope is refused, and nothing moves', async () => {
  await withCore(async ({ core, call, today }) => {
    const start = addDaysYmd(today, -28);
    const id = daily(call, start);
    const before = core.store.get('events', id);
    for (const args of [{ start: `${addDaysYmd(today, 1)}T10:00` }, { date: addDaysYmd(today, 1) }, { end: `${addDaysYmd(today, 1)}T11:00` }]) {
      const r = call('update_event', { event_id: id, ...args });
      assert.equal(r.isError, true, `${JSON.stringify(args)} must be refused: ${r.text}`);
      assert.match(r.text, /repeats \(since .+\)\. Pass occurrence \(the day to change, e\.g\. \d{4}-\d{2}-\d{2}\) and scope/);
      assert.match(r.text, /send start as HH:MM with scope "all"/);
      assert.match(r.text, /Nearby occurrences: /);
    }
    assert.deepEqual(core.store.get('events', id), before, 'the series is untouched');
    assert.equal(count(call, start, addDaysYmd(today, -1), 'Standup'), 28, 'four weeks of standups are still there');
  });
});

test('scope "all" with an occurrence\'s date-time changes only the time of every occurrence; another day is refused', async () => {
  await withCore(async ({ core, call, today }) => {
    const start = addDaysYmd(today, -28);
    const id = daily(call, start);
    const r = ok(call('update_event', { event_id: id, scope: 'all', start: `${addDaysYmd(today, 2)}T10:15` }));
    const e = core.store.get('events', id);
    assert.equal(e.start, `${start}T10:15`, 'the series keeps its first day, at the new time');
    assert.equal(e.end, `${start}T10:30`, 'and its length');
    assert.equal(count(call, start, addDaysYmd(today, -1), 'Standup'), 28);
    assert.match(r.text, new RegExp(`${addDaysYmd(today, 2)} 10:15-10:30`), 'the day the model named is shown');
    // A weekly series: a day it does not happen on can't say which day is meant.
    const w = ok(call('create_events', { events: [{ title: 'Weekly sync', start: `${addDaysYmd(today, -14)}T15:00`, duration_minutes: 30, repeat: 'weekly', calendar: 'Work' }] })).data.created[0].event_id;
    const bad = call('update_event', { event_id: w, scope: 'all', start: `${addDaysYmd(today, -13)}T16:00` });
    assert.equal(bad.isError, true, bad.text);
    assert.match(bad.text, /is not an occurrence of "Weekly sync", so it can't say which day of the series to change/);
    assert.match(bad.text, /pass occurrence \(a day it happens now\) with the new start or date/);
  });
});

test('a time-only change of a whole series shows its next occurrence, not its first day', async () => {
  await withCore(async ({ call, today }) => {
    const id = daily(call, addDaysYmd(today, -10));
    const r = ok(call('update_event', { event_id: id, start: '08:45' }));
    assert.equal(r.data.event.start.slice(0, 10), today, `the next occurrence (today) is shown: ${r.text}`);
    assert.equal(r.data.event.start.slice(11), '08:45');
  });
});

test('a series that has not begun yet still moves to the date given (its new first day)', async () => {
  await withCore(async ({ core, call, today }) => {
    const first = addDaysYmd(today, 20);
    const id = daily(call, first, 'Future daily');
    ok(call('update_event', { event_id: id, start: `${addDaysYmd(today, 22)}T09:30` }));
    assert.equal(core.store.get('events', id).start, `${addDaysYmd(today, 22)}T09:30`);
  });
});

test('moving a begun series\' first day later with an explicit occurrence says how many earlier occurrences left the calendar', async () => {
  await withCore(async ({ call, today }) => {
    const start = addDaysYmd(today, -10);
    const id = daily(call, start);
    const r = ok(call('update_event', { event_id: id, occurrence: start, scope: 'all', date: addDaysYmd(today, 1) }));
    // Ten days before today and today's own: the series now starts tomorrow.
    assert.match(r.text, new RegExp(`Its days moved: the series now starts \\w{3} ${addDaysYmd(today, 1)} \\(it started \\w{3} ${start}\\), so 11 occurrences from \\w{3} ${start} to \\w{3} ${today} are no longer on the calendar; meeting notes of its days moved with them\\. .*undo_change puts it back\\.`));
    ok(call('undo_change', { change_id: r.data.change_id }));
    assert.equal(count(call, start, addDaysYmd(today, -1), 'Standup'), 10, 'undo brings them back');
  });
});

test('delete_items scope "following" ends the series the day before; edited later occurrences go with it; undo restores', async () => {
  await withCore(async ({ core, call, today }) => {
    const start = addDaysYmd(today, 30);
    const id = daily(call, start, 'Daily to end');
    const later = addDaysYmd(start, 7);
    ok(call('update_event', { event_id: id, occurrence: later, scope: 'this', start: `${later}T12:00` }));
    const cut = addDaysYmd(start, 5);
    const r = ok(call('delete_items', { items: [{ type: 'event', id, occurrence: cut, scope: 'following' }] }));
    assert.equal(core.store.get('events', id).until, addDaysYmd(cut, -1));
    assert.match(r.text, new RegExp(`from .+ ${cut} on \\(the series now ends .+ ${addDaysYmd(cut, -1)}\\)`));
    assert.match(r.text, /\+1 edited occurrences/);
    const left = ok(call('find_events', { from: start, to: addDaysYmd(start, 20), query: 'Daily to end' })).data.events;
    assert.equal(left.length, 5, left.map((x) => x.start).join(', '));
    ok(call('undo_change', { change_id: r.data.change_id }));
    assert.equal(core.store.get('events', id).until, null);
    assert.equal(ok(call('find_events', { from: start, to: addDaysYmd(start, 20), query: 'Daily to end' })).data.total, 21);
  });
});

test('delete_items: "following" from the first day, or "all", deletes the series; "this" one day; a missing occurrence is refused', async () => {
  await withCore(async ({ core, call, today }) => {
    const start = addDaysYmd(today, 40);
    const a = daily(call, start, 'Series A');
    ok(call('delete_items', { items: [{ type: 'event', id: a, occurrence: start, scope: 'following' }] }));
    assert.equal(core.store.get('events', a), null);
    const b = daily(call, start, 'Series B');
    ok(call('delete_items', { items: [{ type: 'event', id: b, occurrence: addDaysYmd(start, 3), scope: 'all' }] }));
    assert.equal(core.store.get('events', b), null);
    const c = daily(call, start, 'Series C');
    ok(call('delete_items', { items: [{ type: 'event', id: c, occurrence: addDaysYmd(start, 3) }] }));
    assert.deepEqual(core.store.get('events', c).exdates, [addDaysYmd(start, 3)], '"this" is the default with an occurrence');
    const none = call('delete_items', { items: [{ type: 'event', id: c, scope: 'following' }] });
    assert.equal(none.isError, true);
    assert.match(none.text, /pass occurrence \(YYYY-MM-DD\) with scope "following"/);
    // The schema offers the choice.
    const def = core.tools.find((t) => t.name === 'delete_items');
    assert.deepEqual(def.inputSchema.properties.items.items.properties.scope.enum, ['this', 'following', 'all']);
  });
});
