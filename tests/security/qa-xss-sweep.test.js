// QA security: stored XSS sweep in a real Chrome. Every user-controlled string the apps render
// (task titles, notes, steps, labels, list, calendar and folder names, event titles, locations and
// notes, note blocks, links and chips, an AI connection's label, the client name an assistant
// reports, activity summaries and the live toasts of AI changes) holds a payload that tries to
// break out of text, double- and single-quoted and unquoted attributes. After every page, view and
// panel the DOM must hold no element or attribute the payload made, while the payload text itself
// is visible (so the data really rendered). Skipped without Chrome. Set E2E_NO_LOCK=1 to run it
// without the machine-wide one-Chrome lock (when something else coordinates the browsers).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../e2e/server.mjs';
import { launch, findChrome } from '../e2e/cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const P = (f) => `Zebra${f} "'><xss-mark f="${f}"></xss-mark> xss-attr=${f} <b xss-b=${f}>b</b>`;

function seedData(today) {
  const now = Date.now();
  const blk = (id, t, s, extra = {}) => ({ id, t, c: [[s]], ...extra });
  return {
    lists: [{ id: 'listx', name: P('list.name'), color: 'blue', icon: '', order: 0, createdAt: now, updatedAt: now }],
    tasks: [
      { id: 'taskx1', title: P('task.title'), notes: P('task.notes'), listId: 'listx', tags: [P('task.tag')], priority: 1, date: today, time: '10:00', duration: 30, deadline: today, checklist: [{ id: 'stp1', title: P('task.step'), done: false }], done: false, order: 0, createdAt: now, updatedAt: now },
      { id: 'taskx2', title: P('task2.title'), tags: ['plain'], date: today, repeat: { freq: 'day', interval: 1 }, done: false, order: 1, createdAt: now, updatedAt: now },
    ],
    calendars: [{ id: 'calx', name: P('cal.name'), color: 'red', visible: true, order: 0, createdAt: now, updatedAt: now }],
    events: [
      { id: 'evx1', title: P('event.title'), calendarId: 'calx', allDay: false, start: `${today}T11:00`, end: `${today}T12:00`, location: P('event.location'), notes: P('event.notes'), createdAt: now, updatedAt: now },
      { id: 'evx2', title: P('event2.title'), calendarId: 'calx', allDay: true, start: today, end: today, repeat: { freq: 'week', interval: 1 }, createdAt: now, updatedAt: now },
    ],
    folders: [{ id: 'fldx', name: P('folder.name'), parentId: null, color: 'green', order: 0, aiHidden: false, createdAt: now, updatedAt: now }],
    notes: [
      {
        id: 'notex1', v: 1, rev: 1, folderId: 'fldx', pinned: true,
        blocks: [
          blk('b1', 'h1', P('note.title')), blk('b2', 'p', P('note.body')),
          { id: 'b3', t: 'p', c: [[P('note.linktext'), '', { href: 'https://example.com/?q="><xss-mark f=note.href></xss-mark>' }]] },
          { id: 'b4', t: 'p', c: [[P('note.chip'), '', { ref: 'note:notex2', atom: 1 }]] },
          blk('b5', 'check', P('note.check'), { ck: false }), blk('b6', 'code', P('note.code'), { lang: 'js' }), blk('b7', 'quote', P('note.quote')),
        ],
        createdAt: now, updatedAt: now, editedAt: now, editedBy: 'mcp:claude', aiPrev: { at: now, by: 'mcp:claude', rev: 0, blocks: [blk('pb1', 'p', P('note.aiPrev'))] },
      },
      { id: 'notex2', v: 1, rev: 1, day: today, blocks: [blk('c1', 'h1', P('daily.title')), blk('c2', 'p', P('daily.body'))], createdAt: now, updatedAt: now, editedAt: now, editedBy: 'user' },
      { id: 'notex3', v: 1, rev: 1, event: { id: 'evx1', date: today }, blocks: [blk('d1', 'h1', P('meeting.title'))], createdAt: now, updatedAt: now, editedAt: now, editedBy: 'user' },
    ],
  };
}

describe('QA security: stored XSS sweep (Chrome)', () => {
  let server = null;
  let browser = null;
  after(async () => {
    await browser?.close().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('no stored string becomes markup on any page, view or panel', { skip: !findChrome() && 'Google Chrome is not installed', timeout: 240000 }, async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    server = await startServer();
    const imp = await server.api('api/import', { method: 'POST', body: { data: seedData(today), settings: {} } });
    assert.equal(imp.status, 200, imp.text);
    const client = (await server.api('api/ai/clients', { method: 'POST', body: { kind: 'other', label: P('ai.label') } })).json.client;
    const mcp = async (method, params = {}, notification = false) => {
      const r = await fetch(server.url('mcp'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${client.token}`, 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notification ? {} : { id: Math.floor(Math.random() * 1e9) }) }),
      });
      await r.text();
    };
    await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: P('ai.clientName'), version: P('ai.clientVersion') } });
    await mcp('notifications/initialized', {}, true);
    await mcp('tools/call', { name: 'create_tasks', arguments: { tasks: [{ title: P('ai.task'), date: today }] } });

    browser = await launch({ lock: process.env.E2E_NO_LOCK !== '1' });
    const page = await browser.newPage();
    await page.setViewport(1440, 900, false);
    const problems = [];
    const scan = async (where, { expectText = true } = {}) => {
      const r = await page.evaluate(() => ({
        hits: [...document.querySelectorAll('xss-mark, [xss-attr], [xss-b]')].map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('f') || el.getAttribute('xss-attr') || el.getAttribute('xss-b')}]`),
        shown: (document.body.innerText.match(/Zebra[\w.]+/g) || []).length,
      }));
      if (r.hits.length) problems.push(`${where}: ${r.hits.join(', ')}`);
      if (expectText && !r.shown) problems.push(`${where}: no seeded text was rendered, so this view proved nothing`);
    };
    const open = async (path, ms = 1500) => {
      await page.goto(server.url(path));
      await page.waitFor(() => !!window.ecosysSync && document.readyState === 'complete', { timeout: 15000, message: `${path} to start` });
      await sleep(ms);
    };
    for (const path of ['', 'tasks/#/today', 'tasks/#/list/listx', 'schedule/#/week', 'schedule/#/month', 'schedule/#/agenda', 'notes/#/n/notex1', 'notes/#/n/notex3', 'notes/#/folder/fldx', 'notes/#/daily']) {
      await open(path);
      await scan(path || 'home');
    }
    await open(`tasks/#/tag/${encodeURIComponent(P('task.tag'))}`);
    await scan('tasks tag route', { expectText: false });
    await open('tasks/#/today');
    await page.evaluate(() => [...document.querySelectorAll('[data-id], .task-row, .row')].find((e) => /Zebratask\.title/.test(e.textContent))?.click());
    await sleep(800);
    await scan('task details');
    await open('schedule/#/week');
    await page.evaluate(() => [...document.querySelectorAll('[data-id], [data-event], .ev, .event')].find((e) => /Zebraevent\.title/.test(e.textContent))?.click());
    await sleep(800);
    await scan('event details');
    for (const path of ['tasks/', 'notes/']) {
      await open(path, 1000);
      await page.press('Control+K');
      await sleep(300);
      await page.type('Zebra');
      await sleep(800);
      await scan(`palette on ${path}`);
      await page.press('Escape');
    }
    await open('', 1000);
    await page.evaluate(() => import('/shared/ai.js').then((m) => m.openAIPanel({})));
    await sleep(1500);
    await scan('Connect AI');
    await page.evaluate(() => [...document.querySelectorAll('.ai-panel [role=tab]')].find((b) => /^Activity/.test(b.textContent.trim()))?.click());
    await sleep(600);
    await scan('Connect AI activity');
    await page.press('Escape');
    await open('tasks/', 1000);
    await mcp('tools/call', { name: 'create_tasks', arguments: { tasks: [{ title: P('ai.livetask'), date: today }] } });
    await sleep(2500);
    await scan('live AI toast');
    assert.deepEqual(problems, []);
  });
});
