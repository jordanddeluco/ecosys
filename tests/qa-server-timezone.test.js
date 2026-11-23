// QA (server fix): an assistant's "today" is the day the apps show. A Node process keeps the time zone
// it started in when the computer's zone changes (travel), while the apps follow the new one. The
// apps report their zone in settings.uiTimeZone; the tools' clock (today, times, "today" and
// "tomorrow", completion times) uses it when it is a zone this computer knows, else the process's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { clock, localStamp, timeZone, validTimeZone, parseWhen } from '../server/model.mjs';
import { addDaysYmd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  clock(); // back to this process's zone for anything after
});

/** The wall date and time of `ms` in `zone`, as Intl writes it. */
function wall(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
// One of these two zones (UTC+14 and UTC-11, 25 hours apart) is on another date than this process.
const now = new Date();
const localDate = clock(now).today;
const AWAY = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => wall(now.getTime(), z).date !== localDate);

test('clock(now, zone) and localStamp follow the zone given; an unknown zone falls back to this process\'s', () => {
  const c = clock(now, AWAY);
  const w = wall(now.getTime(), AWAY);
  assert.equal(c.zone, AWAY);
  assert.equal(c.today, w.date);
  assert.equal(c.time, w.time);
  assert.equal(c.nowDT, `${w.date}T${w.time}`);
  assert.equal(localStamp(now.getTime()), `${w.date}T${w.time}`, 'times shown to the assistant use it too');
  assert.match(c.offset, /^[+-]\d\d:\d\d$/);
  assert.equal(parseWhen('tomorrow', c).date, addDaysYmd(w.date, 1), 'the phrase parser counts from that day');
  const z = parseWhen('2026-06-01T12:00:00Z', c);
  const zw = wall(Date.parse('2026-06-01T12:00:00Z'), AWAY);
  assert.deepEqual(z, { date: zw.date, time: zw.time }, 'an ISO time with Z is converted into that zone');
  for (const bad of ['Mars/Olympus_Mons', '../etc', '', null, 42]) {
    assert.equal(validTimeZone(bad), null, String(bad));
    assert.equal(clock(now, bad).zone, timeZone(), `${bad}: this process's zone`);
  }
  assert.equal(clock(now).today, localDate);
});

test('with settings.uiTimeZone set, "today" for an assistant is the apps\' today', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-tz-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  try {
    core.store.importData({ data: {}, settings: { uiTimeZone: AWAY } });
    const client = core.ai.createClient({ kind: 'claude', access: 'write' });
    const call = (name, args = {}) => {
      const r = core.callTool(name, args, { client });
      return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
    };
    const w = wall(Date.now(), AWAY);
    const ctx = call('get_context');
    assert.equal(ctx.data.today, w.date);
    assert.equal(ctx.data.time_zone, AWAY);
    assert.match(ctx.text, new RegExp(`\\(${AWAY.replace('/', '\\/')}, UTC[+-]\\d\\d:\\d\\d\\)`));
    const made = call('create_tasks', { tasks: [{ title: 'QA zone today', date: 'today' }] });
    assert.equal(made.data.created[0].date, w.date, 'saved on the day the apps show');
    assert.match(core.mcp.instructions(), new RegExp(`time zone \\(${AWAY.replace('/', '\\/')}\\)`));
    // Without the setting, the process's own zone.
    core.store.applyOps([{ op: 'settings', patch: { uiTimeZone: null } }]);
    assert.equal(call('get_context').data.time_zone, timeZone());
  } finally {
    core.close();
  }
});
