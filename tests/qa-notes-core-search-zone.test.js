// QA fix (notes-core, server cross request): notes_search's edited:/created: filters follow the
// user's calendar. The tools' clock runs in the apps' time zone (settings.uiTimeZone), which can
// differ from the server process's own (a laptop that travelled), and notes_search passed
// ctx.clock.now.getTime(), a Date whose local fields show the apps' wall time: off by the zones'
// difference. So "edited:7d" counted from the wrong moment, and "today", "yesterday" and a date were
// the process's days, not the user's. Now "7d" counts back from the real now and the day filters use
// the user's midnights (notes/core/search.js `today` / `dayStart`, given by server/tools-notes.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { clock } from '../server/model.mjs';
import { searchNotes } from '../notes/core/search.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const DAY = 86400000;
const MIN = 60000;
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  clock(); // the tools' clock back to this process's zone for anything after
});

const block = (t, text) => ({ id: `${t}${text.length}`, t, c: [[text]] });
const note = (id, editedAt, createdAt = editedAt) => ({ id, v: 1, rev: 1, folderId: null, title: id, tags: [], links: [], blocks: [block('h1', id), block('p', 'weekly review')], editedBy: 'user', editedAt, createdAt, updatedAt: Math.max(editedAt, createdAt) });

// ---------------------------------------------------------------- notes/core/search.js

test('searchNotes: today / dayStart set the calendar the day filters use; "7d" counts back from now', () => {
  // A user 14 hours ahead of UTC: their Nov 23 began at 10:00 UTC on Nov 22.
  const OFF = 14 * 3600000;
  const dayStart = (ymd) => Date.parse(`${ymd}T00:00:00Z`) - OFF;
  const now = Date.parse('2026-11-23T01:00:00Z'); // 15:00 on Nov 23 for the user
  const today = '2026-11-23';
  const s23 = dayStart('2026-11-23');
  const s22 = dayStart('2026-11-22');
  const notes = [note('todayEarly', s23 + MIN), note('yesterdayLate', s23 - MIN), note('yesterdayEarly', s22 + MIN), note('dayBefore', s22 - MIN), note('weekIn', now - 7 * DAY + 3600000), note('weekOut', now - 7 * DAY - 3600000)];
  const q = (query) => searchNotes(notes, query, { now, today, dayStart }).map((r) => r.note.id).sort();
  assert.deepEqual(q('edited:today'), ['todayEarly']);
  assert.deepEqual(q('edited:yesterday'), ['yesterdayEarly', 'yesterdayLate']);
  assert.deepEqual(q('edited:2026-11-22'), ['yesterdayEarly', 'yesterdayLate']);
  assert.deepEqual(q('edited:2026-11-21'), ['dayBefore']);
  assert.deepEqual(q('created:today'), ['todayEarly']);
  assert.ok(q('edited:7d').includes('weekIn') && !q('edited:7d').includes('weekOut'));
  // A month boundary and a year boundary: "yesterday" of Jan 1 is Dec 31.
  const jan1 = dayStart('2027-01-01');
  const nye = [note('jan1', jan1 + MIN), note('dec31', jan1 - MIN)];
  assert.deepEqual(searchNotes(nye, 'edited:yesterday', { now: jan1 + 3600000, today: '2027-01-01', dayStart }).map((r) => r.note.id), ['dec31']);
  // Without them: this device's own calendar, as before (and as the Notes app uses it).
  const local = new Date(2026, 10, 23, 0, 0).getTime();
  const mine = [note('a', local + MIN), note('b', local - MIN)];
  const at = local + 5 * 3600000;
  assert.deepEqual(searchNotes(mine, 'edited:today', { now: at }).map((r) => r.note.id), ['a']);
  assert.deepEqual(searchNotes(mine, 'edited:yesterday', { now: at }).map((r) => r.note.id), ['b']);
  // A dayStart that answers nonsense falls back to this device's midnight rather than matching everything.
  assert.deepEqual(searchNotes(mine, 'edited:today', { now: at, dayStart: () => NaN }).map((r) => r.note.id), ['a']);
});

// ---------------------------------------------------------------- notes_search over MCP

/** The wall date of `ms` in `zone`. */
const wallDate = (ms, zone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
/** Minutes `zone` is ahead of this process at `ms`. */
const ahead = (ms, zone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(ms).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  const d = new Date(ms);
  const here = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
  return Math.round((wall - here) / MIN);
};
/** The first minute of `ymd` in `zone`, found by walking minutes (independent of the code under test). */
function zoneDayStart(zone, ymd) {
  let ms = Date.parse(`${ymd}T00:00:00Z`) - 15 * 3600000;
  while (wallDate(ms, zone) < ymd) ms += MIN;
  return ms;
}

test('notes_search counts days in the apps\' time zone when it is not the server\'s own', async () => {
  const now = Date.now();
  // Of UTC+14 and UTC-11 (25 hours apart), the one farther from this process: at least 12.5 hours.
  const AWAY = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].sort((x, y) => Math.abs(ahead(now, y)) - Math.abs(ahead(now, x)))[0];
  assert.ok(Math.abs(ahead(now, AWAY)) >= 12 * 60, `${AWAY} is ${ahead(now, AWAY)} minutes from this process`);
  const today = wallDate(now, AWAY);
  const yesterday = wallDate(zoneDayStart(AWAY, today) - MIN, AWAY);
  const start = zoneDayStart(AWAY, today);
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-zone-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  try {
    core.store.importData({
      data: {
        notes: [
          note('todayEarly', start + MIN), // just after the user's midnight
          note('yesterdayLate', start - MIN), // just before it
          note('weekIn', now - 7 * DAY + 2 * 3600000),
          note('weekOut', now - 7 * DAY - 2 * 3600000),
          note('madeThisWeek', now - 3 * DAY, now - 3 * DAY),
          note('madeLastMonth', now - 4 * DAY, now - 31 * DAY),
        ],
      },
      settings: { uiTimeZone: AWAY },
    });
    const claude = core.ai.createClient({ kind: 'claude' });
    const ids = (query) => {
      const r = core.callTool('notes_search', { query, limit: 50 }, { client: claude });
      assert.equal(r.isError, false, r.content[0].text);
      return r.structuredContent.results.map((x) => x.id).sort();
    };
    assert.equal(ids('weekly').length, 6, 'control: every note matches the words');
    assert.deepEqual(ids('weekly edited:today'), ['todayEarly'], `today is ${today} in ${AWAY}`);
    assert.deepEqual(ids('weekly edited:yesterday'), ['yesterdayLate']);
    assert.deepEqual(ids(`weekly edited:${today}`), ['todayEarly']);
    assert.deepEqual(ids(`weekly edited:${yesterday}`), ['yesterdayLate']);
    const week = ids('weekly edited:7d');
    assert.ok(week.includes('weekIn') && !week.includes('weekOut'), `7 days back from now: ${week}`);
    assert.deepEqual(ids('weekly created:7d').filter((id) => id.startsWith('made')), ['madeThisWeek']);
  } finally {
    core.close();
  }
});
