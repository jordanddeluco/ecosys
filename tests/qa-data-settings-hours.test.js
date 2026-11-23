// QA (data, final pass; cross request from the server owner, finding 22): working hours are validated.
// Settings > Schedule writes scheduleWorkStart / scheduleWorkEnd, and the AI tools plan within them
// (get_overview, find_free_time, plan_tasks, schedule_tasks; server/core.mjs effectiveSettings).
// Before, the two keys passed only as "app-prefixed" settings, so any string up to 200 characters was
// kept and synced ('25:00', '9am', 'soon'). Now each must be 'HH:MM' from 00:00 to 23:59, the same rule
// the server's built-in fallback (server/validate.mjs) and effectiveSettings use, and anything else is
// ignored like any other invalid setting. There is still no default for them in SETTINGS_DEFAULTS: an
// unset pair is what get_context reports as "the default".
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S from '../shared/sanitize.js';
import { createValidators } from '../server/validate.mjs';
import { createCore } from '../server/core.mjs';

const { validateSettingsPatch, validateOp, validateSnapshot, SETTINGS_DEFAULTS, SETTINGS_SCHEMA } = S;
const KEYS = ['scheduleWorkStart', 'scheduleWorkEnd'];
const GOOD = ['00:00', '07:00', '07:30', '09:05', '15:45', '17:00', '23:59'];
const BAD = [
  '24:00', '25:00', '7:00', '07:0', '07:60', '0700', '07.00', '07:00:00', ' 07:00', '07:00 ', '07:00\n',
  '9am', 'soon', '', 'x'.repeat(200), '٠٧:٠٠', 7, 700, 7.5, true, false, null, {}, [], ['07:00'], { h: 7 },
];

test('working hours keep a time of day HH:MM (00:00 to 23:59) and nothing else', () => {
  for (const k of KEYS) {
    assert.ok(Object.hasOwn(SETTINGS_SCHEMA, k), `${k} has its own validator`);
    for (const v of GOOD) assert.deepEqual(validateSettingsPatch({ [k]: v }), { [k]: v }, `${k} = ${v}`);
    for (const v of BAD) assert.deepEqual(validateSettingsPatch({ [k]: v }), {}, `${k} = ${JSON.stringify(v)} is ignored`);
  }
  // one bad value drops only itself
  assert.deepEqual(validateSettingsPatch({ scheduleWorkStart: '07:30', scheduleWorkEnd: '25:00', theme: 'dim', notesView: 'grid' }), { scheduleWorkStart: '07:30', theme: 'dim', notesView: 'grid' });
  // they are not app-prefixed extras any more: they don't count toward the 100 extras a patch may hold
  const extras = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`notesK${i}`, i]));
  assert.deepEqual(Object.keys(validateSettingsPatch({ ...extras, scheduleWorkStart: '06:00', scheduleWorkEnd: '14:00' })).filter((k) => KEYS.includes(k)), KEYS);
  // validated output validates to itself (the fuzz suite's idempotence rule)
  const out = validateSettingsPatch({ scheduleWorkStart: '06:15', scheduleWorkEnd: '23:59' });
  assert.deepEqual(validateSettingsPatch(out), out);
  // no default: an unset pair stays "the default" (09:00-17:00) for the AI tools
  for (const k of KEYS) assert.ok(!Object.hasOwn(SETTINGS_DEFAULTS, k), `${k} has no default in SETTINGS_DEFAULTS`);
});

test('sync ops, server state and backups drop invalid working hours the same way', () => {
  assert.equal(validateOp({ op: 'settings', patch: { scheduleWorkEnd: '25:00' } }), null, 'an op with nothing valid is refused');
  assert.deepEqual(validateOp({ op: 'settings', patch: { scheduleWorkStart: '08:00', scheduleWorkEnd: 'soon' } }), { op: 'settings', patch: { scheduleWorkStart: '08:00' } });
  const fromServer = validateSnapshot({ data: { tasks: [] }, settings: { scheduleWorkStart: 'x', scheduleWorkEnd: '18:00' } });
  assert.deepEqual(fromServer.settings, { scheduleWorkEnd: '18:00' });
  const backup = validateSnapshot({ app: 'ecosys', version: 2, settings: { scheduleWorkStart: '06:30', scheduleWorkEnd: '24:00' } });
  assert.deepEqual(backup.settings, { scheduleWorkStart: '06:30' });
});

test('the server accepts the same working hours with shared/sanitize.js as with its built-in fallback', () => {
  const real = createValidators(S);
  const fallback = createValidators(null);
  for (const k of KEYS) {
    for (const v of [...GOOD, ...BAD]) {
      assert.deepEqual(real.settings({ [k]: v }), fallback.settings({ [k]: v }), `${k} = ${JSON.stringify(v)}`);
    }
  }
});

// An isolated core (temp data folder, no port), as the other server tests run the tools.
const silent = { warn() {}, error() {}, info() {}, log() {} };
async function withCore(dataDir, fn) {
  const core = await createCore({ dataDir, emit: () => {}, log: silent });
  try {
    const client = core.ai.createClient({ kind: 'claude', access: 'write' });
    await fn(core, (name, args = {}) => {
      const r = core.callTool(name, args, { client });
      assert.equal(r.isError, false, r.content?.[0]?.text);
      return r.structuredContent;
    });
  } finally {
    core.close();
  }
}

test('a browser that sends invalid working hours changes nothing the assistants plan with', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ecosys-qa-data-hours-'));
  try {
    await withCore(dataDir, async (core, call) => {
      assert.deepEqual(call('get_context').working_hours, { start: '09:00', end: '17:00', default: true });
      // Before the fix, '25:00' and 'soon' were stored and synced to every browser.
      core.store.applyOps([{ op: 'settings', patch: { scheduleWorkStart: '25:00', scheduleWorkEnd: 'soon' } }]);
      assert.ok(!Object.hasOwn(core.store.settings(), 'scheduleWorkStart') && !Object.hasOwn(core.store.settings(), 'scheduleWorkEnd'), 'nothing stored');
      assert.deepEqual(call('get_context').working_hours, { start: '09:00', end: '17:00', default: true });
      core.store.applyOps([{ op: 'settings', patch: { scheduleWorkStart: '07:00', scheduleWorkEnd: '15:30' } }]);
      // a later bad value keeps the good one
      core.store.applyOps([{ op: 'settings', patch: { scheduleWorkEnd: '7pm' } }]);
      assert.deepEqual(call('get_context').working_hours, { start: '07:00', end: '15:30' });
    });
    // ... and the hours a browser set survive a restart
    await withCore(dataDir, async (_core, call) => {
      assert.deepEqual(call('get_context').working_hours, { start: '07:00', end: '15:30' });
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
