// shared/nlp.js and shared/dates.js in time zones that skipped a whole day: Pacific/Kiritimati has no
// 1994-12-31 and Pacific/Apia has no 2011-12-30. daysInMonth() used local Date arithmetic, so it gave 1
// for those Decembers, and every date in them stopped being read ("Party 1994-12-08" stayed in the
// title, "the 8th" read on 1994-11-30 was 1995-01-08). Each zone runs in its own child process,
// because TZ must be set before Node starts. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const NLP = new URL('../shared/nlp.js', import.meta.url).href;
const DATES = new URL('../shared/dates.js', import.meta.url).href;

/** Run `body` (module code that sets `out`) in a child process with TZ=zone; returns { zone, out }. */
function inZone(zone, body) {
  const code = `import { parse } from ${JSON.stringify(NLP)};
import { daysInMonth, ymd } from ${JSON.stringify(DATES)};
let out;
${body}
console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, out }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const CASES = `
const p = (s, now) => { const r = parse(s, { mode: 'task', now }); return [r.date, r.title]; };
`;

test('Pacific/Kiritimati (no 1994-12-31): December 1994 has 31 days and its dates are read', (t) => {
  const { zone, out } = inZone(
    'Pacific/Kiritimati',
    `${CASES}
const now = new Date(1994, 10, 30, 12);
out = {
  skipped: ymd(new Date(1994, 11, 31)),
  dim: daysInMonth(1994, 11),
  iso: p('Party 1994-12-08', now),
  md: p('Party 12/25/1994', now),
  nth: p('Pay the 8th', now),
  noYear: p('Party dec 25', now),
  gone: p('Party 1994-12-31', now),
  after: p('Party 1995-01-01', now),
};`,
  );
  if (zone !== 'Pacific/Kiritimati') return t.skip(`TZ not applied (Intl resolved ${zone})`);
  if (out.skipped !== '1995-01-01') return t.skip('this ICU build does not skip 1994-12-31 in Kiritimati');
  assert.equal(out.dim, 31, 'daysInMonth(1994, 11)');
  assert.deepEqual(out.iso, ['1994-12-08', 'Party']);
  assert.deepEqual(out.md, ['1994-12-25', 'Party']);
  assert.deepEqual(out.nth, ['1994-12-08', 'Pay'], 'not 1995-01-08');
  assert.deepEqual(out.noYear, ['1994-12-25', 'Party'], 'not 1995-12-25');
  // the day the zone skipped is no local date: it stays in the title, never read as 1995-01-01
  assert.deepEqual(out.gone, [null, 'Party 1994-12-31']);
  assert.deepEqual(out.after, ['1995-01-01', 'Party']);
});

test('Pacific/Apia (no 2011-12-30): the skipped day is not read as the next one; the days around it are', (t) => {
  const { zone, out } = inZone(
    'Pacific/Apia',
    `${CASES}
const now = new Date(2011, 11, 20, 12);
out = {
  skipped: ymd(new Date(2011, 11, 30)),
  dim: daysInMonth(2011, 11),
  before: p('Party 2011-12-29', now),
  gone: p('Party 2011-12-30', now),
  goneMD: p('Party 12/30/2011', now),
  after: p('Party dec 31 2011', now),
  nth: p('Pay the 30th', now),
};`,
  );
  if (zone !== 'Pacific/Apia') return t.skip(`TZ not applied (Intl resolved ${zone})`);
  if (out.skipped !== '2011-12-31') return t.skip('this ICU build does not skip 2011-12-30 in Apia');
  assert.equal(out.dim, 31, 'daysInMonth(2011, 11)');
  assert.deepEqual(out.before, ['2011-12-29', 'Party']);
  assert.deepEqual(out.gone, [null, 'Party 2011-12-30'], 'not read as 2011-12-31');
  assert.deepEqual(out.goneMD, [null, 'Party 12/30/2011']);
  assert.deepEqual(out.after, ['2011-12-31', 'Party']);
  assert.deepEqual(out.nth, ['2012-01-30', 'Pay'], 'the next 30th that exists there');
});

test('daysInMonth is plain calendar arithmetic (also for month overflow), the same in this process', async () => {
  const { daysInMonth } = await import(DATES);
  const want = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 0; m < 12; m++) assert.equal(daysInMonth(2026, m), want[m], `2026 month ${m}`);
  assert.equal(daysInMonth(2028, 1), 29);
  assert.equal(daysInMonth(2100, 1), 28);
  assert.equal(daysInMonth(2400, 1), 29);
  assert.equal(daysInMonth(2026, 12), 31, 'month 12 is January of the next year');
  assert.equal(daysInMonth(2026, -1), 31, 'month -1 is December of the year before');
  assert.equal(daysInMonth(2027, 13), 29, 'February 2028');
});
