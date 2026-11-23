// notes-app, second pass (headless Chrome against an isolated server, desktop 1440):
//   chip Open       an event chip of an occurrence moved on its own opens that copy in Schedule
//   day lists       a day's plan lists what Schedule lists that day (series, multi-day, all-day, a moved
//                   occurrence, a hidden calendar, both DST changes), from one pass over the events: stepping
//                   through days or opening a note full of day chips doesn't expand every event per day
//   FLIP            the first keystroke in a note whose row moves reads every row's place before any row
//                   animates (no layout per row), and only rows that can be seen animate
//   search          a keystroke renders the first screen of results (more load on scroll) with their marks;
//                   the note you read isn't switched mid-word; Enter acts on what was typed last
//   day steps       Enter on Previous/Next day keeps the keyboard on that button
//   not paired      a link to a note this browser doesn't have says how to connect it, and opens once it is
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useE2E, openApp as openAppHash, waitForApp, waitForSync, waitForSyncIdle, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Load the page afresh (going to a URL that differs only in its hash would keep the page as it is). */
async function openApp(page, url, opts) {
  await page.goto('about:blank');
  return openAppHash(page, url, opts);
}
const textOf = (b) => (b?.c || []).map((r) => r[0]).join('');
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const days = (from, n) => Array.from({ length: n }, (_, i) => addDaysYmd(from, i));
/** Run fn(store, core, model, arg) in the page (one expression: the page's CSP refuses eval inside it). */
const inPage = (page, fn, arg) =>
  page.evaluate(`(async () => {
    const store = await import('/shared/store.js');
    const core = await import('/notes/core/notes.js');
    const model = await import('/shared/model.js');
    return (${String(fn)})(store, core, model, ${JSON.stringify(arg ?? null)});
  })()`);
const hashNote = (page) => page.evaluate(() => (/\/n\/([^?/]+)/.exec(location.hash) || [])[1] || null);
const focusedDesc = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'BODY';
    return `${a.tagName.toLowerCase()}${typeof a.className === 'string' && a.className ? `.${a.className.trim().split(/\s+/).join('.')}` : ''}[${(a.getAttribute('aria-label') || '').trim()}]`;
  });
/** Type characters one at a time as key presses (`gap` ms apart). */
async function typeKeys(page, text, gap = 0) {
  for (const ch of text) {
    const code = ch === ' ' ? 'Space' : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : '';
    const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    if (gap) await sleep(gap);
  }
}
/**
 * Answer the page's /api requests: handler(request) → 'fail' (no connection), {status, json} (that answer),
 * or {headers} / null (sent on, with those headers). Returns a function that stops it.
 */
async function routeApi(page, handler) {
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  const off = page.conn.on((msg) => {
    if (msg.sessionId !== page.sessionId || msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    let a = null;
    try {
      a = handler(request);
    } catch {}
    if (a === 'fail') return void page.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
    if (a?.status) {
      return void page
        .send('Fetch.fulfillRequest', { requestId, responseCode: a.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(a.json ?? {})).toString('base64') })
        .catch(() => {});
    }
    const headers = a?.headers ? Object.entries(a.headers).map(([name, value]) => ({ name, value: String(value) })) : undefined;
    page.send('Fetch.continueRequest', { requestId, ...(headers ? { headers } : {}) }).catch(() => {});
  });
  return async () => {
    off();
    await page.send('Fetch.disable').catch(() => {});
  };
}

describe('qa notes-app: second pass', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  const extra = [];
  async function newPage(opts = {}) {
    const p = await ctx.browser.newPage(opts);
    await p.setViewport(1440, 900, false);
    extra.push(p);
    return p;
  }
  async function closeExtra() {
    while (extra.length) await extra.pop().close().catch(() => {});
  }

  test("Open on an event chip of an occurrence moved on its own shows that copy in Schedule, not the series' own occurrence", async () => {
    const { page, server } = ctx;
    const t = tag();
    await withScreenshot(page, 'qa-notes-app-chip-open', async () => {
      await openApp(page, server.url('notes/#/all'));
      const today = await browserToday(page);
      const d1 = addDaysYmd(today, 1);
      const d2 = addDaysYmd(today, 2);
      const x = await inPage(
        page,
        ({ db }, core, model, a) => {
          const cal = db.all('calendars').find((c) => c.visible !== false) || db.all('calendars')[0];
          const series = db.insert('events', { title: `Daily sync ${a.t}`, start: `${a.d1}T09:00`, end: `${a.d1}T09:30`, calendarId: cal.id, allDay: false, repeat: { freq: 'day', interval: 1 } });
          const n = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Chip open ${a.t}`]] }, { id: 'a', t: 'p', c: [[series.title, '', { ref: `event:${series.id}@${a.d1}`, atom: 1 }]] }] });
          model.detachOccurrence(series.id, a.d1, { start: `${a.d2}T16:00`, end: `${a.d2}T16:30`, title: `Moved sync ${a.t}` });
          const copy = db.all('events').find((e) => e.seriesId === series.id && e.occurrence === a.d1);
          return { note: n.id, series: series.id, copy: copy?.id || null };
        },
        { t, d1, d2 },
      );
      assert.ok(x.copy, 'the occurrence was moved to a copy of its own');
      await waitForSyncIdle(page);
      await openApp(page, server.url(`notes/#/all/n/${x.note}`));
      await page.waitFor(() => document.querySelector('.ne-doc .ne-chip-event'), { timeout: 8000, message: 'the event chip' });
      assert.match(await page.evaluate(() => document.querySelector('.ne-doc .ne-chip-event').textContent), new RegExp(`Moved sync ${t}`), 'the chip shows the moved copy');
      // Mod+click opens the chip (Ctrl on Windows and Linux, Cmd on a Mac).
      const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || ''));
      const r = await page.evaluate(() => {
        const b = document.querySelector('.ne-doc .ne-chip-event').getBoundingClientRect();
        return { x: b.x + 10, y: b.y + b.height / 2 };
      });
      const modifiers = mac ? 4 : 2;
      // The address Notes goes to (Schedule tidies it once it has shown the event).
      const asked = page.waitForEvent('Page.frameRequestedNavigation', { timeout: 8000 }).catch(() => null);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
      const nav = await asked;
      if (nav?.url) assert.ok(nav.url.includes(`/schedule/#/day/${d2}/event/${x.copy}`), `the link names the copy (${x.copy}) on its new day, not the series (${x.series}): ${nav.url}`);
      await page.waitFor(() => location.pathname.includes('/schedule/'), { timeout: 8000, message: 'Schedule to open' });
      await waitForApp(page);
      // Schedule shows that copy's details: its own title and time, on the day it moved to.
      await page.waitFor((t2) => [...document.querySelectorAll('[role=dialog], .popover')].some((p) => p.innerText.includes(`Moved sync ${t2}`)), { timeout: 8000, args: [t], message: "the moved copy's details in Schedule" });
      const shown = await page.evaluate(() => [...document.querySelectorAll('[role=dialog], .popover')].map((p) => p.innerText.replace(/\s+/g, ' ')).join(' | '));
      assert.match(shown, /4(:00)?\s*–\s*4:30\s*pm|16:00\s*–\s*16:30/i, `its time is the copy's 4–4:30pm: ${shown}`);
      assert.ok(!/9(:00)?\s*–\s*9:30/.test(shown), `not the series' 9–9:30 occurrence: ${shown}`);
    });
  });

  test("a day's plan lists what Schedule lists that day, read from one pass over the events (also across DST)", async () => {
    const { server } = ctx;
    const page = await newPage();
    try {
      await withScreenshot(page, 'qa-notes-app-day-lists', async () => {
        // New York: the clocks go forward on 2026-03-08 and back on 2026-11-01.
        await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
        await openApp(page, server.url('notes/#/all'));
        const t = tag();
        await inPage(
          page,
          ({ db }, _core, model, t) => {
            db.batch(() => {
              for (const e of [...db.all('events')]) db.remove('events', e.id);
              for (const x of [...db.all('tasks')]) db.remove('tasks', x.id);
            });
            const cal = db.all('calendars').find((c) => c.visible !== false);
            const hidden = db.insert('calendars', { name: `Hidden ${t}`, color: 'red', visible: false });
            const ev = (f) => db.insert('events', { calendarId: cal.id, allDay: false, ...f, title: `${f.title} ${t}` });
            ev({ title: 'Long trip', allDay: true, start: '2026-02-20', end: '2026-05-01' }); // longer than the index spreads
            ev({ title: 'Early daily', start: '2026-03-05T02:30', end: '2026-03-05T03:00', repeat: { freq: 'day', interval: 1 }, until: '2026-03-12' }); // 2:30 doesn't exist on 03-08
            ev({ title: 'Night shift', start: '2026-02-28T22:00', end: '2026-03-01T02:00', repeat: { freq: 'week', interval: 1, days: [6] }, exdates: ['2026-03-07'] });
            ev({ title: 'Conference', allDay: true, start: '2026-03-02', end: '2026-03-04' });
            ev({ title: 'Late call', start: '2026-03-10T23:00', end: '2026-03-11T00:00' }); // ends at midnight: that day only
            db.insert('events', { calendarId: hidden.id, allDay: false, title: `Hidden meeting ${t}`, start: '2026-03-03T10:00', end: '2026-03-03T11:00' });
            ev({ title: 'Twin A', start: '2026-03-09T14:00', end: '2026-03-09T15:00' });
            ev({ title: 'Twin B', start: '2026-03-09T14:00', end: '2026-03-09T15:00' });
            ev({ title: 'Monthly review', start: '2026-02-05T11:00', end: '2026-02-05T12:00', repeat: { freq: 'month', interval: 1 } });
            const standup = ev({ title: 'Standup', start: '2026-03-02T09:00', end: '2026-03-02T09:15', repeat: { freq: 'day', interval: 1 }, until: '2026-03-06' });
            model.detachOccurrence(standup.id, '2026-03-04', { start: '2026-03-05T16:00', end: '2026-03-05T16:15', title: `Standup moved ${t}` });
            ev({ title: 'Every other day', start: '2026-02-26T09:30', end: '2026-02-26T10:00', repeat: { freq: 'day', interval: 2 }, until: '2026-03-12' });
            ev({ title: 'Weekly until', start: '2026-02-23T12:00', end: '2026-02-23T12:30', repeat: { freq: 'week', interval: 1, days: [1, 3] }, until: '2026-03-04' });
            ev({ title: 'Yearly', start: '2025-03-06T08:00', end: '2025-03-06T08:30', repeat: { freq: 'year', interval: 1 } });
            ev({ title: 'Fall back', start: '2026-11-01T01:30', end: '2026-11-01T02:30' });
            ev({ title: 'Overnight', start: '2026-10-30T20:00', end: '2026-11-02T08:00' });
          },
          t,
        );
        const checkDays = [...days('2026-02-27', 15), ...days('2026-10-29', 6)];
        // What Schedule draws each day: the model's own expansion, shown calendars only.
        const want = await page.evaluate(async (list) => {
          const model = await import('/shared/model.js');
          const shell = await import('/shared/shell.js');
          const out = {};
          for (const d of list) {
            out[d] = model
              .eventInstances(d, d, { includeHidden: true })
              .filter((i) => i.calendar?.visible !== false)
              .map((i) => `${i.allDay ? 'All day' : shell.fmtTimeRange(i.start, i.end)} | ${i.event.title || 'Untitled event'}`);
          }
          return out;
        }, checkDays);
        assert.ok(Object.values(want).some((l) => l.length >= 4), 'the days hold several events each');
        assert.ok(want['2026-03-08'].some((r) => r.includes('Early daily')), 'the 2:30 event is there on the night 2:00–3:00 is skipped');
        // Count reads of the events list from here on: one pass serves every day.
        await page.evaluate(async () => {
          const { db } = await import('/shared/store.js');
          const all = db.all;
          window.__eventReads = 0;
          db.all = function (name) {
            if (name === 'events') window.__eventReads++;
            return all.call(this, name);
          };
        });
        for (const d of checkDays) {
          // The app routes on hashchange (synchronously): read the plan right after it.
          await page.evaluate(
            (h) =>
              new Promise((res) => {
                addEventListener('hashchange', () => setTimeout(res, 0), { once: true });
                location.hash = h;
              }),
            `#/day/${d}`,
          );
          const got = await page.evaluate(() => ({
            rows: [...document.querySelectorAll('.n-dayhead a.dh-row')].map((a) => `${a.querySelector('.dh-time')?.textContent.trim()} | ${a.querySelector('.dh-title')?.textContent.trim()}`),
            more: document.querySelector('.n-dayhead .dh-more')?.textContent || '',
            empty: !!document.querySelector('.n-dayhead .dh-empty'),
          }));
          const w = want[d];
          assert.deepEqual(got.rows, w.slice(0, 6), `${d}: the plan lists what Schedule shows, in its order`);
          if (w.length > 6) assert.match(got.more, new RegExp(`^${w.length - 6} more`), `${d}: and counts the rest`);
          assert.equal(got.empty, w.length === 0, `${d}: "Nothing planned" only when nothing is`);
        }
        const reads = await page.evaluate(() => window.__eventReads);
        assert.ok(reads <= 3, `${checkDays.length} days read the events ${reads} times (one pass, not one expansion per day)`);
        assert.deepEqual(page.consoleErrors(), []);
      });
    } finally {
      await closeExtra();
    }
  });

  test('a note full of day chips (60 days) opens without expanding the events per day; a chip card counts its day', async () => {
    const { page, server } = ctx;
    const t = tag();
    await withScreenshot(page, 'qa-notes-app-day-chips', async () => {
      await openApp(page, server.url('notes/#/all'));
      const today = await browserToday(page);
      const list = days(addDaysYmd(today, -30), 60);
      const { noteId, three } = await inPage(
        page,
        ({ db }, core, _m, a) => {
          const cal = db.all('calendars').find((c) => c.visible !== false);
          // Three events on the 10th day (one of them on a hidden calendar would not count; keep them shown).
          const d = a.list[10];
          for (const h of ['08', '12', '17']) db.insert('events', { title: `Chip day ${h} ${a.t}`, calendarId: cal.id, allDay: false, start: `${d}T${h}:00`, end: `${d}T${h}:30` });
          const blocks = [{ id: 'h', t: 'h1', c: [[`Day chips ${a.t}`]] }];
          a.list.forEach((x, i) => blocks.push({ id: `b${i}`, t: 'p', c: [['On '], [x, '', { ref: `day:${x}`, atom: 1 }]] }));
          const n = core.createNote({ blocks });
          return { noteId: n.id, three: d };
        },
        { t, list },
      );
      await waitForSyncIdle(page);
      await page.evaluate(async () => {
        const { db } = await import('/shared/store.js');
        const all = db.all;
        window.__eventReads = 0;
        db.all = function (name) {
          if (name === 'events') window.__eventReads++;
          return all.call(this, name);
        };
      });
      await page.evaluate((h) => {
        location.hash = h;
      }, `#/all/n/${noteId}`);
      await page.waitFor(() => document.querySelectorAll('.ne-doc .ne-chip-day').length === 60, { timeout: 8000, message: 'the 60 day chips' });
      const reads = await page.evaluate(() => window.__eventReads);
      assert.ok(reads <= 1, `opening the note read the events ${reads} times, not once per day chip`);
      // The card of the 10th day's chip counts its three events (worked out when the card asks).
      await page.evaluate((d) => document.querySelector(`.ne-doc .ne-chip-day[data-ref="day:${d}"]`).scrollIntoView({ block: 'center' }), three);
      const r = await page.evaluate((d) => {
        const b = document.querySelector(`.ne-doc .ne-chip-day[data-ref="day:${d}"]`).getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, three);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
      await page.waitFor(() => document.querySelector('.ne-chipcard'), { timeout: 5000, message: "the day chip's card" });
      const card = await page.evaluate(() => document.querySelector('.ne-chipcard').innerText.replace(/\s+/g, ' '));
      const n = await page.evaluate(async (d) => {
        const model = await import('/shared/model.js');
        return model.eventInstances(d, d).length;
      }, three);
      assert.ok(n >= 3, `the day has its events (${n})`);
      assert.match(card, new RegExp(`${n} events`), `the card counts the day's ${n} events: ${card}`);
      await page.press('Escape');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('first keystroke in a note whose row moves: every row place is read before any row animates, and only rows in view animate', async () => {
    const { page, server } = ctx;
    const t = tag();
    await withScreenshot(page, 'qa-notes-app-flip', async () => {
      await openApp(page, server.url('notes/#/all'));
      const { target } = await inPage(
        page,
        ({ db }, core, _m, t) => {
          // 60 notes edited one minute apart; the long note is the 6th newest, so its row moves to the top.
          const base = Date.now() - 2 * 3600e3;
          const made = [];
          for (let i = 0; i < 60; i++) {
            const n = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Flip ${i} ${t}`]] }, { id: 'p', t: 'p', c: [['row text']] }] });
            made.push(n.id);
          }
          const long = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Long flip ${t}`]] }, ...Array.from({ length: 400 }, (_, i) => ({ id: `l${i}`, t: 'p', c: [[`Paragraph ${i} of a long note, with enough words in it to wrap onto a second line in the editor column.`]] }))] });
          db.batch(() => {
            made.forEach((id, i) => {
              const n = db.get('notes', id);
              db.put('notes', { ...n, editedAt: base + (i < 55 ? i : i + 1) * 60000 });
            });
            const n = db.get('notes', long.id);
            db.put('notes', { ...n, editedAt: base + 55 * 60000 + 30000 });
          });
          return { target: long.id };
        },
        t,
      );
      await waitForSyncIdle(page);
      await openApp(page, server.url(`notes/#/all/n/${target}`));
      await page.emulateMedia({ 'prefers-reduced-motion': '' });
      const before = await page.evaluate((id) => [...document.querySelectorAll('#list [data-id]')].findIndex((r) => r.dataset.id === id), target);
      assert.ok(before > 2, `the note's row is not at the top yet (#${before})`);
      // Log reads of list rows' places and the animations, in order.
      await page.evaluate(() => {
        const log = (window.__flipLog = []);
        const rect = Element.prototype.getBoundingClientRect;
        const animate = Element.prototype.animate;
        Element.prototype.getBoundingClientRect = function () {
          if (this.matches?.('#list [data-id]')) log.push('read');
          return rect.call(this);
        };
        Element.prototype.animate = function (...a) {
          if (this.matches?.('#list [data-id]')) {
            if (!log.includes('anim')) queueMicrotask(() => log.push('end'));
            log.push('anim');
          }
          return animate.apply(this, a);
        };
      });
      await page.evaluate(() => {
        const tx = [...document.querySelectorAll('.ne-doc .ne-b .ne-tx')][3];
        const r = document.createRange();
        r.selectNodeContents(tx);
        r.collapse(false);
        document.querySelector('.ne-doc').focus();
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      });
      await typeKeys(page, 'x');
      await page.waitFor(() => window.__flipLog.includes('end'), { timeout: 5000, message: 'the rows to glide (FLIP)' });
      const log = await page.evaluate(() => window.__flipLog.slice());
      const firstAnim = log.indexOf('anim');
      const end = log.indexOf('end');
      const between = log.slice(firstAnim, end);
      assert.ok(firstAnim > 0, 'the rows were measured, then animated');
      assert.equal(between.filter((x) => x === 'read').length, 0, `no row is measured once the animations have started: ${between.join(',')}`);
      const anims = between.filter((x) => x === 'anim').length;
      const inView = await page.evaluate(() => {
        const box = document.getElementById('list').getBoundingClientRect();
        return [...document.querySelectorAll('#list [data-id]')].filter((r) => {
          const b = r.getBoundingClientRect();
          return b.bottom > box.top && b.top < box.bottom;
        }).length;
      });
      assert.ok(anims >= 2 && anims <= inView + 2, `${anims} rows animated, the ones in view (${inView}), not every row`);
      const after = await page.evaluate((id) => {
        const rows = [...document.querySelectorAll('#list [data-id]')];
        const i = rows.findIndex((r) => r.dataset.id === id);
        return { i, above: rows.slice(0, i).filter((r) => !r.querySelector('.nrow-pin')).length };
      }, target);
      assert.ok(after.i < before && after.above === 0, `the edited note's row moved to the top (below pinned notes only): #${before} → #${after.i}`);
    });
  });

  test("search: a keystroke renders the first screen of results, marks included; more load on scroll; the open note isn't switched mid-word", async () => {
    const { page, server } = ctx;
    const t = tag(5).toLowerCase().replace(/[^a-z]/g, 'q');
    const word = `zeta${t}`;
    await withScreenshot(page, 'qa-notes-app-search', async () => {
      await openApp(page, server.url('notes/#/all'));
      const { reading } = await inPage(
        page,
        ({ db }, core, _m, a) => {
          db.batch(() => {
            for (let i = 0; i < 150; i++) core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`${a.word} ${i}`]] }, { id: 'p', t: 'p', c: [[`the ${a.word} body of note ${i}`]] }] });
            // Over a megabyte of text: typing waits for a pause before it searches.
            const filler = 'lorem ipsum dolor sit amet '.repeat(400);
            for (let i = 0; i < 110; i++) core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Filler ${i}`]] }, { id: 'p', t: 'p', c: [[filler]] }] });
          });
          const reading = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [['Reading list']] }, { id: 'p', t: 'p', c: [['books to read']] }] });
          return { reading: reading.id };
        },
        { word },
      );
      await waitForSyncIdle(page, 30000);
      await openApp(page, server.url(`notes/#/all/n/${reading}`));
      await page.evaluate(() => document.getElementById('q').focus());
      const seen = [];
      for (const ch of word) {
        await typeKeys(page, ch);
        await sleep(70);
        seen.push(await hashNote(page));
      }
      assert.deepEqual([...new Set(seen)], [reading], 'while typing, the note you were reading stays open');
      await page.waitFor((r) => (/\/n\/([^?/]+)/.exec(location.hash) || [])[1] !== r, { timeout: 3000, args: [reading], message: 'the first result to open once typing pauses' });
      const shown = await page.evaluate(() => ({
        rows: document.querySelectorAll('#list [data-id]').length,
        head: document.querySelector('.n-lh-sub')?.textContent || '',
        marks: [...document.querySelectorAll('#list [data-id]')].slice(0, 5).map((r) => [r.querySelector('.nrow-title mark')?.textContent || '', r.querySelector('.nrow-prev mark')?.textContent || '']),
      }));
      assert.match(shown.head, /^150 results/, `every result is counted: ${shown.head}`);
      assert.ok(shown.rows <= 41, `only the first screen of rows is rendered (${shown.rows})`);
      for (const [title, snip] of shown.marks) {
        assert.equal(title.toLowerCase(), word, 'the title marks the word');
        assert.equal(snip.toLowerCase(), word, 'and so does the snippet');
      }
      await page.evaluate(() => {
        const l = document.getElementById('list');
        l.scrollTop = l.scrollHeight;
      });
      await page.waitFor(() => document.querySelectorAll('#list [data-id]').length > 41, { timeout: 5000, message: 'more results as the list scrolls' });
      // Enter right after the last key (before the pause the search waits for) acts on what was typed.
      await page.evaluate(() => {
        const q = document.getElementById('q');
        q.focus();
        q.select();
      });
      await typeKeys(page, `brand new ${t}`);
      await page.press('Enter');
      const made = await server.waitForState((s) => s.data.notes.find((n) => textOf(n.blocks?.[0]) === `brand new ${t}`), 10000, 'the note named like the whole query');
      assert.ok(made, 'Enter made the note named after the whole query, not a part of it');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('Enter on Next day / Previous day keeps the keyboard on that button (days with and without a note); a click still writes', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-notes-app-day-step', async () => {
      await openApp(page, server.url('notes/#/all'));
      const start = addDaysYmd(await browserToday(page), 40);
      await inPage(
        page,
        (_s, core, _m, d) => {
          const n = core.dailyNote(d, { create: true });
          core.saveBlocks(n.id, [...n.blocks, { id: 'x', t: 'p', c: [['a day with a note']] }]);
        },
        addDaysYmd(start, 2),
      );
      await openApp(page, server.url(`notes/#/day/${start}`));
      await page.evaluate(() => document.querySelector('.n-dayhead [data-day-step="1"]').focus());
      for (let i = 1; i <= 3; i++) {
        await page.press('Enter');
        await sleep(250);
        assert.equal(await page.evaluate(() => location.hash), `#/day/${addDaysYmd(start, i)}`, `Enter ${i} stepped one more day`);
        assert.match(await focusedDesc(page), /^button.*\[Next day\]$/, `after Enter ${i} the keyboard is still on Next day`);
      }
      await page.evaluate(() => document.querySelector('.n-dayhead [data-day-step="-1"]').focus());
      await page.press(' ');
      await sleep(250);
      assert.equal(await page.evaluate(() => location.hash), `#/day/${addDaysYmd(start, 2)}`, 'Space on Previous day steps back to the day with a note');
      assert.match(await focusedDesc(page), /\[Previous day\]$/, 'and keeps the keyboard there');
      assert.match(await page.evaluate(() => document.querySelector('.ne-doc').innerText), /a day with a note/, "that day's note is shown");
      // A click (a pointer) on Next day: the day's empty note takes the caret, as before.
      const r = await page.evaluate(() => {
        const b = document.querySelector('.n-dayhead [data-day-step="1"]').getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(400);
      assert.equal(await page.evaluate(() => location.hash), `#/day/${addDaysYmd(start, 3)}`);
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ne-doc')), true, "after a click the day's note has the caret");
    });
  });

  test("a browser that isn't paired: a link to a note it doesn't have says how to connect, and opens the note once it is connected", async () => {
    const { server } = ctx;
    const t = tag();
    const id = `qa${tag(10)}`;
    const now = Date.now();
    const r = await server.api('api/ops', { method: 'POST', body: { client: 'qa-ai', ops: [{ op: 'put', c: 'notes', item: { id, v: 1, rev: 1, createdAt: now, updatedAt: now, editedAt: now, blocks: [{ id: 'b1', t: 'h1', c: [[`Paired ${t}`]] }, { id: 'b2', t: 'p', c: [['made in ecosys']] }] } }] } });
    assert.equal(r.status, 200);
    // A new browser profile that never saw the pairing link: the server refuses it, it works from its own copy.
    const page = await newPage({ isolated: true, pair: false });
    let paired = false;
    const pairFile = join(server.dataDir, 'pair.json');
    const secret = existsSync(pairFile) ? JSON.parse(readFileSync(pairFile, 'utf8')).secret : `qa-secret-${tag(24)}`.replace(/[^A-Za-z0-9_-]/g, 'x');
    const unroute = await routeApi(page, (req) => {
      if (!paired) {
        if (/\/api\/hello/.test(req.url)) return { status: 200, json: { ok: true, app: 'ecosys', version: 'qa', paired: false } };
        return { status: 403, json: { error: 'pairing_required' } };
      }
      // Connected: requests go through (to a server from before pairing, with the header it knows).
      return existsSync(pairFile) ? null : { headers: { ...req.headers, 'X-Ecosys': '1' } };
    });
    try {
      await withScreenshot(page, 'qa-notes-app-unpaired', async () => {
        await page.goto(server.url(`notes/#/n/${id}`));
        await waitForApp(page);
        await page.waitFor(() => window.ecosysSync?.status === 'unpaired', { timeout: 15000, message: 'sync to find the browser not paired' });
        await page.waitFor(() => /isn't connected/.test(document.querySelector('#notecol .n-empty h3')?.textContent || ''), { timeout: 5000, message: 'the note column to say the browser is not connected' });
        const msg = await page.evaluate(() => document.querySelector('#notecol .n-empty').innerText);
        assert.match(msg, /Open the link shown where ecosys is running/, `it says how to connect: ${msg}`);
        assert.ok(!/Loading note|Getting it from ecosys/.test(msg), 'no "Loading note…" that never ends');
        await sleep(1500);
        assert.ok(!(await page.evaluate(() => /no longer exists/.test(document.body.innerText))), 'it never says the note no longer exists');
        assert.ok((await page.evaluate(() => location.hash)).includes(id), 'the link is kept');
        // Another tab opens the pairing link: this one is connected, and the note opens.
        paired = true;
        await page.evaluate((s) => {
          localStorage.setItem('ecosys:v1:pair', s);
          window.dispatchEvent(new StorageEvent('storage', { key: 'ecosys:v1:pair', newValue: s }));
        }, secret);
        await waitForSync(page, 20000);
        await page.waitFor((x) => document.querySelector('.ne-doc .ne-b')?.textContent === x, { timeout: 10000, args: [`Paired ${t}`], message: 'the note to open once the browser is connected' });
      });
    } finally {
      await unroute();
      await closeExtra();
    }
  });
});
