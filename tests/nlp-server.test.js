// The MCP tools with dates outside the stored years (1000-9999), on an isolated core (temp data dir,
// no port). When shared/dates.js ymd() zero-padded years below 1000, '0491-05-01' passed the server's
// round-trip check (server/model.mjs validYmd) while the data validators still dropped it: a task was
// saved without its date, an update erased the date a task had, and one bad event refused a whole
// create_events call. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';

const silent = { warn() {}, error() {}, info() {}, log() {} };

async function withCore(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ecosys-nlp-server-'));
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

const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';

test('create_tasks refuses a year before 1000 for that task only, and never saves the task without its date', async () => {
  await withCore(async (core, call) => {
    const r = await call('create_tasks', { tasks: [{ title: 'Old', date: '0491-05-01' }, { title: 'Ok', date: '2026-12-01' }, { title: 'Old deadline', deadline: '0999-12-31' }] });
    assert.equal(r.isError, false, text(r));
    assert.deepEqual(
      r.structuredContent.failed.map((f) => [f.index, /is not a real date/.test(f.error)]),
      [
        [0, true],
        [2, true],
      ],
      text(r),
    );
    assert.deepEqual(
      core.store.all('tasks').map((t) => [t.title, t.date, t.deadline]),
      [['Ok', '2026-12-01', null]],
    );
  });
});

test('update_tasks with a year before 1000 is an error and keeps the date the task had', async () => {
  await withCore(async (core, call) => {
    await call('create_tasks', { tasks: [{ title: 'Dentist', date: '2026-12-01' }] });
    const t = core.store.all('tasks')[0];
    for (const date of ['0491-05-01', '0100-01-01']) {
      const r = await call('update_tasks', { tasks: [{ task_id: t.id, date }] });
      assert.equal(r.isError, true, text(r));
      assert.match(text(r), /is not a real date/);
      assert.equal(core.store.get('tasks', t.id).date, '2026-12-01', `after date ${date}`);
    }
  });
});

test('create_events with one event before year 1000 still creates the others and lists that one as failed', async () => {
  await withCore(async (core, call) => {
    const r = await call('create_events', {
      events: [
        { title: 'Good', start: '2026-12-01T10:00', calendar: 'Personal' },
        { title: 'Bad', start: '0491-05-01T10:00', calendar: 'Personal' },
        { title: 'Bad all day', start: '0491-05-01', calendar: 'Personal' },
      ],
    });
    assert.equal(r.isError, false, text(r));
    assert.deepEqual(r.structuredContent.failed.map((f) => f.index), [1, 2], text(r));
    assert.deepEqual(core.store.all('events').map((e) => [e.title, e.start]), [['Good', '2026-12-01T10:00']]);
  });
});
