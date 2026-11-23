// QA (server fix, second pass): reading ecosys's own files and expanding calendars stay fast.
//  - readJson (ai.json, undo data) and the store's record copies parse with plain JSON.parse; only
//    text that may hold a key named like a prototype member (written plainly or with \u escapes) goes
//    through the reviver, which costs several times the parse on a large file. Such keys are still
//    dropped at every depth.
//  - find_events filters by text before expanding repeating events, and expands occurrences without
//    date arithmetic per occurrence: a year of 3,000 events (200 series) with a query that matches
//    nothing takes milliseconds, not hundreds. The occurrences are exactly the ones a plain expansion
//    gives (multi-day, overnight and all-day events, exceptions and series ends included).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as util from '../server/util.mjs'; // parseJson is new: read through the namespace
import { createCore } from '../server/core.mjs';
import { instancesBetween, occurrencesBetween } from '../server/model.mjs';
import { loadValidators } from '../server/validate.mjs';
import { addDaysYmd, diffDays, ymd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const tempDir = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

/** How many JSON.parse calls in `fn` passed a reviver. */
function revivers(fn) {
  const real = JSON.parse;
  let n = 0;
  JSON.parse = (text, reviver) => {
    if (reviver) n++;
    return real(text, reviver);
  };
  try {
    return { value: fn(), revived: n };
  } finally {
    JSON.parse = real;
  }
}

test('readJson parses ecosys\'s own files without a reviver, unless one may hold a prototype key', () => {
  const dir = tempDir('ecosys-qa-perf-json-');
  const plain = join(dir, 'ai.json');
  writeFileSync(plain, JSON.stringify({ mode: 'write', clients: [{ id: 'c1', label: 'Claude "constructor" fan' }], activity: Array.from({ length: 50 }, (_, i) => ({ id: `act_${i}`, summary: 'prototype work' })) }));
  const a = revivers(() => util.readJson(plain));
  assert.equal(a.revived, 0, 'a plain file: no reviver');
  assert.equal(a.value.clients[0].label, 'Claude "constructor" fan');
  for (const [name, text] of [
    ['plain key', '{"a":1,"__proto__":{"x":1},"b":{"constructor":{"prototype":{"y":1}}}}'],
    ['escaped key', '{"a":1,"\\u005f\\u005fproto__":{"x":1},"b":{"\\u0063onstructor":{"y":1}}}'],
  ]) {
    const f = join(dir, `${name.replace(' ', '-')}.json`);
    writeFileSync(f, text);
    const r = revivers(() => util.readJson(f));
    assert.equal(r.revived, 1, `${name}: the reviver runs`);
    assert.deepEqual(Object.keys(r.value), ['a', 'b'], name);
    assert.ok(!Object.hasOwn(r.value, '__proto__') && !Object.hasOwn(r.value.b, 'constructor'), `${name}: the keys are dropped`);
    assert.equal({}.x, undefined);
  }
  assert.deepEqual(util.parseJson('{"t":"a \\" quote, \\u00e9 and \\ud83d\\ude00"}'), { t: 'a " quote, é and 😀' }, 'escapes still decode');
});

test('the validators copy every record without a reviver, and still drop prototype keys', async () => {
  const v = await loadValidators({ log: silent });
  const items = Array.from({ length: 200 }, (_, i) => ({ id: `task${String(i).padStart(4, '0')}`, title: `Task ${i}`, notes: 'plain', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: i, createdAt: 1, updatedAt: 1 }));
  const r = revivers(() => items.map((it) => v.item('tasks', it)));
  assert.equal(r.value.filter(Boolean).length, 200);
  assert.equal(r.revived, 0);
  const evil = JSON.parse('{"id":"evil0001","title":"x","__proto__":{"polluted":true}}');
  assert.ok(Object.hasOwn(evil, '__proto__'), 'control: JSON.parse keeps it as an own key');
  const clean = v.item('tasks', evil);
  assert.ok(clean && !Object.hasOwn(clean, '__proto__') && clean.polluted === undefined);
});

/** The plain expansion: every occurrence shifted by whole days from the series start. */
function reference(events, fromYmd, toYmd) {
  const out = [];
  const shift = (s, n) => (s.length > 10 ? `${addDaysYmd(s.slice(0, 10), n)}${s.slice(10)}` : addDaysYmd(s, n));
  for (const e of events) {
    const sd = e.start.slice(0, 10);
    const span = Math.max(0, diffDays(sd, e.end.slice(0, 10)));
    const dates = e.repeat ? occurrencesBetween(e.repeat, sd, addDaysYmd(fromYmd, -span), toYmd, { exdates: e.exdates || [], until: e.until || null }) : e.end.slice(0, 10) >= fromYmd && sd <= toYmd ? [sd] : [];
    for (const d of dates) {
      const n = diffDays(sd, d);
      const start = shift(e.start, n);
      const end = shift(e.end, n);
      if (e.allDay ? end.slice(0, 10) < fromYmd || start.slice(0, 10) > toYmd : !(start < `${addDaysYmd(toYmd, 1)}T00:00` && end > `${fromYmd}T00:00`)) continue;
      out.push(`${e.id} ${d} ${start} ${end}`);
    }
  }
  return out.sort();
}

function calendarOf(n, today) {
  const freqs = [{ freq: 'day', interval: 1 }, { freq: 'week', interval: 1, days: [1, 3] }, { freq: 'week', interval: 2, days: [1, 2, 3, 4, 5] }, { freq: 'month', interval: 1 }, { freq: 'year', interval: 1 }];
  return Array.from({ length: n }, (_, i) => {
    const d = addDaysYmd(today, (i % 400) - 200);
    const allDay = i % 17 === 0;
    const overnight = i % 23 === 0;
    const multi = i % 29 === 0;
    const h = String(8 + (i % 14)).padStart(2, '0');
    return {
      id: `ev${String(i).padStart(6, '0')}`,
      title: `Event ${i}`,
      calendarId: 'cw',
      allDay,
      start: allDay ? d : `${d}T${h}:00`,
      end: allDay ? addDaysYmd(d, multi ? 2 : 0) : overnight ? `${addDaysYmd(d, 1)}T01:30` : `${d}T${h}:45`,
      location: '',
      notes: '',
      repeat: i < n / 15 ? freqs[i % freqs.length] : null,
      exdates: i % 7 === 0 ? [addDaysYmd(d, 7), addDaysYmd(d, 14)] : [],
      until: i % 11 === 0 ? addDaysYmd(d, 90) : null,
      createdAt: 1,
      updatedAt: 1,
    };
  });
}

test('the occurrences find_events works from are exactly those of a plain expansion', () => {
  const today = ymd(new Date());
  const events = calendarOf(1500, today);
  const state = { all: (c) => (c === 'events' ? events : c === 'calendars' ? [{ id: 'cw', name: 'Work', visible: true }] : []), get: () => null };
  for (const [from, to] of [[addDaysYmd(today, -10), addDaysYmd(today, 30)], [today, today], [addDaysYmd(today, -300), addDaysYmd(today, 300)]]) {
    const got = instancesBetween(state, from, to).map((i) => `${i.event.id} ${i.occurrence} ${i.start} ${i.end}`).sort();
    assert.deepEqual(got, reference(events, from, to), `${from}..${to}`);
  }
  const sorted = instancesBetween(state, today, addDaysYmd(today, 14));
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1], sorted[i]];
    assert.ok(a.allDay === b.allDay ? a.start < b.start || (a.start === b.start && a.end >= b.end) : a.allDay, `sorted at ${i}`);
  }
});

test('find_events over a year of 3,000 events with a query that matches nothing takes milliseconds', async () => {
  const core = await createCore({ dataDir: tempDir('ecosys-qa-perf-events-'), log: silent });
  try {
    const today = ymd(new Date());
    core.store.importData({ data: { calendars: [{ id: 'cw', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 }], events: calendarOf(3000, today) }, settings: {} });
    const client = core.ai.createClient({ kind: 'claude', access: 'read' });
    const run = (args) => {
      const t = process.hrtime.bigint();
      const r = core.callTool('find_events', args, { client });
      return { ms: Number(process.hrtime.bigint() - t) / 1e6, r };
    };
    const year = { from: today, to: addDaysYmd(today, 360) };
    assert.ok(run(year).r.structuredContent.total > 10000, 'control: tens of thousands of occurrences');
    const times = Array.from({ length: 5 }, () => run({ ...year, query: 'no such event anywhere' }));
    assert.equal(times[0].r.structuredContent.total, 0);
    const median = times.map((x) => x.ms).sort((a, b) => a - b)[2];
    // Expanding every occurrence first took 250-300 ms here; filtering first takes a few.
    assert.ok(median < 60, `median ${median.toFixed(1)} ms`);
  } finally {
    core.close();
  }
});
