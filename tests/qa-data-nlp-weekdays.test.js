// QA (data): weekday lists in quick add. "Gym every mon wed fri 7am" used to repeat on Monday only,
// start on Wednesday (the next day name was read as the date) and keep "fri" in the title; only
// "every mon, wed and fri" worked. Lists separated by spaces, slashes, "&" or an Oxford comma now
// work, and so do a week's days after "on" ("every 2 weeks on tue, thu", "weekly on mon wed fri").
// The same parser reads the server's repeat field and create_tasks text, so those are checked too.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../shared/nlp.js';
import { validateRepeat } from '../shared/sanitize.js';
import { parseRepeat } from '../server/model.mjs';
import { createCore } from '../server/core.mjs';

const NOW = new Date(2026, 10, 22, 12); // Sunday 22 November 2026
const p = (s, o = {}) => parse(s, { mode: 'task', now: NOW, ...o });
const e = (s, o = {}) => parse(s, { mode: 'event', now: NOW, ...o });
const kinds = (r) => r.tokens.map((t) => `${t.kind}:${t.text}`);

test('"every mon wed fri" repeats on all three days, starts on the first of them and leaves no day in the title', () => {
  const r = p('Gym every mon wed fri 7am');
  assert.deepEqual(
    { title: r.title, date: r.date, time: r.time, repeat: r.repeat },
    { title: 'Gym', date: '2026-11-23', time: '07:00', repeat: { freq: 'week', interval: 1, days: [1, 3, 5] } },
  );
  assert.deepEqual(kinds(r), ['repeat:every mon wed fri', 'time:7am'], 'one repeat token, and no day read as a date');
  const other = p('Meet every other tue thu');
  assert.deepEqual([other.title, other.date, other.repeat], ['Meet', '2026-11-24', { freq: 'week', interval: 2, days: [2, 4] }]);
  // Schedule's Create card: the series starts on Monday, not on the Wednesday after it
  const yoga = e('Yoga every mon wed 6pm');
  assert.deepEqual([yoga.title, yoga.date, yoga.time, yoga.repeat.days], ['Yoga', '2026-11-23', '18:00', [1, 3]]);
  assert.equal(yoga.tokens.some((t) => t.kind === 'date'), false);
});

test('every way of listing the days gives the same rule', () => {
  const want = { freq: 'week', interval: 1, days: [1, 3, 5] };
  for (const s of [
    'Gym every mon, wed and fri',
    'Gym every mon wed fri',
    'Gym every mon, wed, and fri',
    'Gym every mon/wed/fri',
    'Gym every mon & wed & fri',
    'Gym every mon + wed + fri',
    'Gym every mon,wed,fri',
    'Gym every monday wednesday friday',
    'Gym every Monday, Wednesday and Friday',
    'Gym EVERY MON WED FRI',
    'Gym each mon wed fri',
  ]) {
    const r = p(s);
    assert.deepEqual([r.title, r.repeat], ['Gym', want], s);
  }
  assert.deepEqual(p('Clean every sat & sun').repeat, { freq: 'week', interval: 1, days: [0, 6] });
  assert.deepEqual(p('Call every tue/thu').repeat, { freq: 'week', interval: 1, days: [2, 4] });
});

test('a week\'s days can follow "on": every week / every N weeks / every other week / weekly / biweekly', () => {
  for (const [s, rule, date] of [
    ['Gym every week on mon and wed', { freq: 'week', interval: 1, days: [1, 3] }, '2026-11-23'],
    ['Gym every 2 weeks on tue, thu', { freq: 'week', interval: 2, days: [2, 4] }, '2026-11-24'],
    ['Gym every other week on mon fri', { freq: 'week', interval: 2, days: [1, 5] }, '2026-11-23'],
    ['Gym weekly on mon wed fri', { freq: 'week', interval: 1, days: [1, 3, 5] }, '2026-11-23'],
    ['Gym biweekly on tue thu', { freq: 'week', interval: 2, days: [2, 4] }, '2026-11-24'],
    ['Gym fortnightly on sat/sun', { freq: 'week', interval: 2, days: [0, 6] }, '2026-11-22'],
    ['Gym every 3 weeks on wednesday', { freq: 'week', interval: 3, days: [3] }, '2026-11-25'],
  ]) {
    const r = p(s);
    assert.deepEqual({ title: r.title, repeat: r.repeat, date: r.date }, { title: 'Gym', repeat: rule, date }, s);
    assert.deepEqual(validateRepeat(r.repeat), rule, `${s}: stored unchanged`);
  }
});

test('the days are stored in order, once each (the form the validators keep), and other words stay in the title', () => {
  assert.deepEqual(p('Gym every fri mon fri').repeat.days, [1, 5]);
  assert.deepEqual(p('Gym every fri, mon').repeat.days, [1, 5]);
  // only day names are part of the list
  const w = p('Cake every mon wedding');
  assert.deepEqual([w.title, w.repeat.days], ['Cake wedding', [1]]);
  const s = p('Gym every mon sunscreen');
  assert.deepEqual([s.title, s.repeat.days], ['Gym sunscreen', [1]]);
  assert.deepEqual([p('Buy sun cream').title, p('Buy sun cream').repeat], ['Buy sun cream', null]);
  // a day after the list is still a date of its own
  const n = p('Gym every mon wed next fri');
  assert.deepEqual([n.title, n.repeat.days, n.date], ['Gym', [1, 3], '2026-11-27']);
});

test('an interval outside 1-99 is still refused by name, with the days after it left alone', () => {
  const r = p('Gym every 0 weeks on mon 7pm');
  assert.deepEqual([r.repeat, r.rejectedRepeat], [null, 'every 0 weeks']);
  assert.ok(r.title.includes('every 0 weeks'), r.title);
  const big = p('Gym every 100 weeks on mon wed');
  assert.deepEqual([big.repeat, big.rejectedRepeat], [null, 'every 100 weeks']);
});

test('server: the repeat field reads the same lists ("mon wed fri" used to be "not a pattern I understand")', () => {
  const c = { now: NOW, today: '2026-11-22' };
  assert.deepEqual(parseRepeat('mon wed fri', c, '2026-11-23').rule, { freq: 'week', interval: 1, days: [1, 3, 5] });
  assert.deepEqual(parseRepeat('every tue/thu', c, '2026-11-24').rule, { freq: 'week', interval: 1, days: [2, 4] });
  assert.deepEqual(parseRepeat('every mon, wed, and fri', c, '2026-11-23').rule, { freq: 'week', interval: 1, days: [1, 3, 5] });
});

let core;
let client;
before(async () => {
  core = await createCore({ dataDir: mkdtempSync(join(tmpdir(), 'ecosys-qa-weekdays-')), log: { warn() {}, error() {}, info() {}, log() {} } });
  client = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core.close();
  rmSync(core.dataDir, { recursive: true, force: true, maxRetries: 3 });
});

test('server: create_tasks text "Gym every mon wed fri 7am" makes one task that repeats on all three days', () => {
  const r = core.callTool('create_tasks', { tasks: [{ text: 'Gym every mon wed fri 7am' }] }, { client });
  assert.equal(r.isError, false, r.content[0].text);
  const t = core.store.get('tasks', r.structuredContent.created[0].task_id);
  assert.deepEqual({ title: t.title, time: t.time, repeat: t.repeat }, { title: 'Gym', time: '07:00', repeat: { freq: 'week', interval: 1, days: [1, 3, 5] } });
  assert.ok([1, 3, 5].includes(new Date(`${t.date}T12:00`).getDay()), `starts on one of its days (${t.date})`);
});
