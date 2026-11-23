// QA (data, second pass): a date range is read only when the caller asks for it (`ranges: true`).
// The first pass read "dec 20-28" everywhere, and every caller that keeps only `date` silently saved
// the range's first day: an MCP deadline "dec 3-5" became Dec 3 (the wrong end), an event's end
// "dec 20-28" became Dec 20, and create_events text "Vacation dec 20-28" made a one-day event whose
// clean title hid the lost days. Without the option a range is read exactly as before ranges: its
// first date is the date and the rest stays in the title, where it shows (and where a field that
// takes one day refuses it). Callers that save a range opt in (see the cross requests).
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../shared/nlp.js';
import { createCore } from '../server/core.mjs';

const NOW = new Date(2026, 10, 22, 12); // Sunday 22 November 2026
const pick = (r) => ({ title: r.title, date: r.date, endDate: r.endDate, deadline: r.deadline });

test('without ranges: true a range reads as it did before ranges: the first day, the rest in the title', () => {
  for (const [s, title, date] of [
    ['Vacation dec 20-28', 'Vacation -28', '2026-12-20'],
    ['Conference dec 3 to dec 5', 'Conference to dec 5', '2026-12-03'],
    ['Trip dec 30 - jan 2', 'Trip - jan 2', '2026-12-30'],
    ['Trip 12/20-12/28', 'Trip -12/28', '2026-12-20'],
    ['Trip 2026-12-20 to 2026-12-28', 'Trip to 2026-12-28', '2026-12-20'],
    ['dec 3-5', '5', '2026-12-03'],
  ]) {
    for (const mode of ['task', 'event']) {
      for (const opts of [{}, { ranges: false }, { ranges: 'yes' }]) {
        assert.deepEqual(pick(parse(s, { mode, now: NOW, ...opts })), { title, date, endDate: null, deadline: null }, `${mode} ${JSON.stringify(s)} ${JSON.stringify(opts)}`);
      }
    }
  }
  // the same words with the option are read whole
  assert.deepEqual(pick(parse('Vacation dec 20-28', { mode: 'event', now: NOW, ranges: true })), { title: 'Vacation', date: '2026-12-20', endDate: '2026-12-28', deadline: null });
  assert.deepEqual(pick(parse('Prep slides dec 3-5', { mode: 'task', now: NOW, ranges: true })), { title: 'Prep slides', date: '2026-12-03', endDate: null, deadline: '2026-12-05' });
});

// An isolated core (temp data folder, no port), as tests/nlp-server.test.js runs the tools.
const silent = { warn() {}, error() {}, info() {}, log() {} };
const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
async function withCore(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ecosys-qa-data-ranges-'));
  const core = await createCore({ dataDir, emit: () => {}, log: silent });
  try {
    core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cal1', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
    const client = core.ai.createClient({ kind: 'claude' });
    await fn(core, async (name, args) => core.callTool(name, args, { client }));
  } finally {
    core.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('MCP fields that take one day refuse a date range instead of saving its first day', async () => {
  await withCore(async (core, call) => {
    // tasks: a deadline "dec 3-5" was saved as Dec 3, a date "2030-12-03 to 2030-12-05" as Dec 3
    for (const [field, value] of [
      ['deadline', 'dec 3-5'],
      ['deadline', '2030-12-03 to 2030-12-05'],
      ['date', 'dec 3-5'],
      ['date', 'from dec 3 to dec 5'],
    ]) {
      const r = await call('create_tasks', { tasks: [{ title: `QA one day ${field} ${value}`, [field]: value }] });
      assert.ok(!core.store.all('tasks').some((t) => t.title.startsWith('QA one day')), `create_tasks ${field} ${JSON.stringify(value)} must be refused, not saved: ${text(r)}`);
      assert.match(text(r), new RegExp(field), `the error names the field: ${text(r)}`);
    }
    // events: an end "dec 20-28" after a start "dec 18" was saved as Dec 18-20
    for (const times of [{ start: 'dec 18', end: 'dec 20-28' }, { start: 'dec 20-28' }, { start: 'dec 3-5 9am-5pm' }, { start: 'dec 20', end_date: 'dec 20-28' }]) {
      const r = await call('create_events', { events: [{ title: 'QA one day event', calendar: 'Personal', ...times }] });
      assert.equal(core.store.all('events').length, 0, `create_events ${JSON.stringify(times)} must be refused, not saved: ${text(r)}`);
    }
    // search windows and other one-day arguments
    for (const [tool, args, field] of [
      ['find_tasks', { due_from: 'dec 3-5' }, 'due_from'],
      ['find_tasks', { due_to: 'dec 3-5' }, 'due_to'],
      ['find_events', { from: 'dec 20-28', to: '2030-01-01' }, 'from'],
      ['find_free_time', { from: 'dec 18', to: 'dec 20-28' }, 'to'],
      ['get_overview', { date: 'dec 3-5' }, 'date'],
    ]) {
      const r = await call(tool, args);
      assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} is an error, not a search from or to one end: ${text(r)}`);
      assert.match(text(r), new RegExp(`${field} "dec`), `the error names ${field}: ${text(r)}`);
    }
  });
});

test('create_events and create_tasks text never hide a range they did not keep', async () => {
  await withCore(async (core, call) => {
    await call('create_events', { events: [{ text: 'QA Vacation dec 20-28', calendar: 'Personal' }] });
    const ev = core.store.all('events').find((e) => e.title.startsWith('QA Vacation'));
    assert.ok(ev, 'the event was made');
    // Either the event spans the days (the text path saves the range) or the words it did not use stay
    // in its title, where the assistant and the user see them: never a clean title on a one-day event.
    assert.ok((ev.allDay && ev.end > ev.start) || /-28/.test(ev.title), `one day ${ev.start}..${ev.end} titled ${JSON.stringify(ev.title)}`);

    await call('create_tasks', { tasks: [{ text: 'QA Prep slides dec 3-5' }] });
    const t = core.store.all('tasks').find((x) => x.title.startsWith('QA Prep slides'));
    assert.ok(t, 'the task was made');
    assert.ok((t.deadline && t.deadline > t.date) || /-5/.test(t.title), `date ${t.date}, deadline ${t.deadline}, titled ${JSON.stringify(t.title)}`);
  });
});
