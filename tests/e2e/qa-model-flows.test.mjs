// QA (model) in the real apps: an Undo takes back only its own change (shared/model.js revertChange,
// used by scheduleTask, toggleTask and trackChanges) and never removes a list something has joined
// since, a time typed without a day gets one (createTask), and a repeating event keeps its length on
// the night the clocks go forward (eventInstances).
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const uid = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

async function shortcut(page, key) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press(key);
}

/** Drag with real mouse events (a press, small steps, a release), as a person moves a block. */
async function mouseDrag(page, from, to, { steps = 12 } = {}) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(120);
  for (let i = 1; i <= steps; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await sleep(60);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
}

/** Schedule day view: scroll so 7am is at the top and return where to grab a block, and an hour's height. */
function grabPoint(page, selector) {
  return page.evaluate((sel) => {
    const sc = document.querySelector('.grid-scroll');
    const hour = parseFloat(getComputedStyle(document.querySelector('.grid-body')).getPropertyValue('--hour')) || 48;
    sc.scrollTop = hour * 7;
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 8, hour };
  }, selector);
}

describe('qa model: undo, quick add and daylight saving in the apps', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let tasks;
  let sched;
  let today;
  let tomorrow;

  before(async () => {
    tasks = ctx.page;
    sched = await ctx.browser.newPage();
    for (const p of [sched]) {
      await p.setViewport(1440, 900, false);
      await p.emulateColorScheme('light');
    }
    await openApp(tasks, ctx.server.url('tasks/#/inbox'));
    await openApp(sched, ctx.server.url('schedule/'));
    today = await browserToday(tasks);
    tomorrow = addDaysYmd(today, 1);
  });

  const now = () => Date.now();
  /** Write records as another device or an assistant would: straight to the server, which tells every open app. */
  async function serverPut(c, item) {
    const r = await ctx.server.api('api/ops', { method: 'POST', body: { client: 'qamodelflows0001', ops: [{ op: 'put', c, item }] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied, 1, `the server took the ${c} record: ${r.text}`);
    return r.json.rev;
  }
  /** Wait until `page` has the server's change `rev` and its saved copy of the record shows `field` = `value`. */
  async function seen(page, rev, c, id, field, value) {
    await page.waitFor(
      ([rev, key, id, field, value]) => window.ecosysSync?.rev >= rev && JSON.parse(localStorage.getItem(key) || '[]').find((x) => x.id === id)?.[field] === value,
      { timeout: 8000, args: [[rev, `ecosys:v1:${c}`, id, field, value]], message: `the change to reach the page (${field} = ${value})` },
    );
    await settle(page, 150);
  }
  async function serverDel(c, id) {
    const r = await ctx.server.api('api/ops', { method: 'POST', body: { client: 'qamodelflows0001', ops: [{ op: 'del', c, id }] } });
    assert.equal(r.status, 200, r.text);
  }
  const newTask = (fields) => ({ id: uid(), notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 9999, createdAt: now(), updatedAt: now(), ...fields });
  const serverTask = async (id) => (await ctx.server.state()).data.tasks.find((x) => x.id === id) || null;
  const waitTask = (id, pred, what) => ctx.server.waitForState((s) => {
    const x = s.data.tasks.find((y) => y.id === id);
    return x && pred(x) ? x : null;
  }, 8000, what);

  test('Schedule: Ctrl+Z puts a moved time block back and keeps the rename and note made in Tasks meanwhile', async () => {
    await withScreenshot(sched, 'qa-model-undo-block', async () => {
      const t = newTask({ title: `QA block ${tag()}`, date: tomorrow, time: '10:00', duration: 60 });
      await serverPut('tasks', t);
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), tomorrow);
      const block = `.ev[data-task="${t.id}"]`;
      await sched.waitFor(block, { timeout: 8000, message: 'the time block in Schedule' });
      const at = await grabPoint(sched, block);
      await mouseDrag(sched, at, { x: at.x, y: at.y + at.hour * 2 });
      await waitTask(t.id, (x) => x.time === '12:00', 'the block moved to 12:00');

      // In Tasks: rename it and write a note.
      await tasks.bringToFront();
      await tasks.evaluate((id) => (location.hash = `#/task/${id}`), t.id);
      await tasks.waitFor('#inspector [aria-label="Task name"]', 5000);
      await tasks.click('#inspector [aria-label="Task name"]');
      await tasks.press('Control+a');
      await tasks.type(`${t.title} renamed`);
      await tasks.press('Tab');
      await tasks.click('#inspector [data-f="notes"]');
      await tasks.type('important details written later');
      await tasks.press('Tab');
      await waitTask(t.id, (x) => x.title === `${t.title} renamed` && x.notes === 'important details written later', 'the rename and the note');
      await tasks.press('Escape');

      // Back in Schedule (which shows the new name): Ctrl+Z takes back the move only.
      await sched.bringToFront();
      await sched.waitFor((sel) => document.querySelector(sel)?.textContent.includes('renamed'), { timeout: 8000, args: [block], message: 'Schedule to show the new name' });
      await settle(sched, 200);
      await shortcut(sched, 'Control+z');
      const back = await waitTask(t.id, (x) => x.time === '10:00', 'Ctrl+Z in Schedule to move the block back to 10:00');
      assert.deepEqual([back.date, back.duration], [tomorrow, 60]);
      assert.equal(back.title, `${t.title} renamed`, 'the rename made in Tasks stays');
      assert.equal(back.notes, 'important details written later', 'the note written in Tasks stays');
      await sched.waitFor((sel) => document.querySelector(sel)?.textContent.includes('renamed'), { timeout: 8000, args: [block], message: 'Schedule to show the block back at 10:00 with its new name' });
    });
  });

  test('Schedule: an Undo after the task was deleted elsewhere leaves it deleted', async () => {
    await withScreenshot(sched, 'qa-model-undo-deleted', async () => {
      const t = newTask({ title: `QA gone ${tag()}`, date: tomorrow, time: '10:00', duration: 30 });
      await serverPut('tasks', t);
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), tomorrow);
      const block = `.ev[data-task="${t.id}"]`;
      await sched.waitFor(block, { timeout: 8000, message: 'the time block in Schedule' });
      const at = await grabPoint(sched, block);
      await mouseDrag(sched, at, { x: at.x, y: at.y + at.hour * 2 });
      await waitTask(t.id, (x) => x.time === '12:00', 'the block moved to 12:00');
      await serverDel('tasks', t.id); // deleted on the phone
      await sched.waitFor((sel) => !document.querySelector(sel), { timeout: 8000, args: [block], message: 'Schedule to drop the deleted task' });
      await shortcut(sched, 'Control+z');
      await sleep(1200);
      assert.equal(await serverTask(t.id), null, 'the Undo did not bring the deleted task back');
      assert.equal(await sched.evaluate((sel) => !!document.querySelector(sel), block), false);
    });
  });

  test('Tasks: Undo of a completion reopens the task and keeps a rename an assistant made meanwhile', async () => {
    await withScreenshot(tasks, 'qa-model-undo-complete', async () => {
      const t = newTask({ title: `QA complete ${tag()}`, date: today });
      await serverPut('tasks', t);
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/today'));
      await tasks.waitFor((n) => [...document.querySelectorAll('[role=checkbox]')].some((c) => c.getAttribute('aria-label') === n), { timeout: 8000, args: [`Complete: ${t.title}`], message: 'the task in Today' });
      await tasks.clickText('checkbox', `Complete: ${t.title}`);
      const done = await waitTask(t.id, (x) => x.done, 'the task completed in Tasks');
      const rev = await serverPut('tasks', { ...done, title: `${t.title} renamed by AI`, updatedAt: now() });
      await seen(tasks, rev, 'tasks', t.id, 'title', `${t.title} renamed by AI`);
      await shortcut(tasks, 'Control+z');
      const back = await waitTask(t.id, (x) => !x.done, 'Ctrl+Z in Tasks to reopen the task');
      assert.equal(back.completedAt, null);
      assert.equal(back.title, `${t.title} renamed by AI`, "the assistant's rename stays");
      await tasks.waitFor((n) => [...document.querySelectorAll('[role=checkbox]')].some((c) => c.getAttribute('aria-label') === n), { timeout: 8000, args: [`Complete: ${t.title} renamed by AI`], message: 'Tasks to list it again, renamed' });
    });
  });

  test('Schedule: Ctrl+Z puts a moved event back and keeps a rename made elsewhere meanwhile', async () => {
    await withScreenshot(sched, 'qa-model-undo-event', async () => {
      const cal = (await ctx.server.state()).data.calendars[0];
      const e = { id: uid(), title: `QA event ${tag()}`, calendarId: cal?.id ?? null, allDay: false, start: `${tomorrow}T10:00`, end: `${tomorrow}T11:00`, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: now(), updatedAt: now() };
      await serverPut('events', e);
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), tomorrow);
      const block = `.ev[data-ev="${e.id}@${tomorrow}"]`;
      await sched.waitFor(block, { timeout: 8000, message: 'the event in Schedule' });
      const at = await grabPoint(sched, block);
      await mouseDrag(sched, at, { x: at.x, y: at.y + at.hour * 2 });
      const moved = await ctx.server.waitForState((s) => s.data.events.find((x) => x.id === e.id && x.start === `${tomorrow}T12:00`), 8000, 'the event moved to 12:00');
      const rev = await serverPut('events', { ...moved, title: `${e.title} renamed`, location: 'Room 2', updatedAt: now() });
      await seen(sched, rev, 'events', e.id, 'title', `${e.title} renamed`);
      await shortcut(sched, 'Control+z');
      const back = await ctx.server.waitForState((s) => s.data.events.find((x) => x.id === e.id && x.start === `${tomorrow}T10:00`), 8000, 'Ctrl+Z to move the event back');
      assert.deepEqual([back.end, back.title, back.location], [`${tomorrow}T11:00`, `${e.title} renamed`, 'Room 2']);
    });
  });

  test('Tasks and Schedule: a time typed without a day gets one, and the task shows up there', async () => {
    await withScreenshot(tasks, 'qa-model-quick-add', async () => {
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      const title = `Lunch ${tag()}`;
      const clock = () => tasks.evaluate(() => new Date().getHours() * 60 + new Date().getMinutes());
      if (!(await tasks.exists('textbox', 'Task name'))) await tasks.clickText('button', /^add task$/i);
      await tasks.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
      await tasks.type(`${title} at noon`);
      const typedAt = await clock();
      await tasks.press('Enter');
      await tasks.press('Escape');
      const t = await ctx.server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, `"${title}" on the server`);
      const savedAt = await clock();
      assert.equal(t.time, '12:00');
      assert.ok([today, tomorrow].includes(t.date), `the time comes with a day; got ${t.date}`);
      // Today while noon is still ahead, else tomorrow (unless the clock passed noon while it was saved).
      if (typedAt <= 720 && savedAt <= 720) assert.equal(t.date, today, 'before noon: today');
      if (typedAt > 720) assert.equal(t.date, tomorrow, 'after noon: tomorrow');
      await tasks.evaluate((v) => (location.hash = `#/${v}`), t.date === today ? 'today' : 'upcoming');
      await tasks.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"]`), { timeout: 8000, args: [t.id], message: `the task in ${t.date === today ? 'Today' : 'Upcoming'}` });

      // Schedule's Tasks panel: the same, and the task is on the calendar.
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), today);
      await settle(sched, 300);
      if (!(await sched.evaluate(() => !!document.querySelector('[data-panel-add]')?.checkVisibility()))) await shortcut(sched, 'i');
      await sched.waitFor(() => document.querySelector('[data-panel-add]')?.checkVisibility(), { timeout: 5000, message: "Schedule's Tasks panel" });
      const title2 = `Call ${tag()}`;
      await sched.click('[data-panel-add]');
      await sched.type(`${title2} at 11:59pm`);
      await sched.press('Enter');
      const t2 = await ctx.server.waitForState((s) => s.data.tasks.find((x) => x.title === title2), 10000, `"${title2}" on the server`);
      assert.deepEqual([t2.date, t2.time], [await browserToday(sched), '23:59'], 'later today');
      await sched.waitFor((id) => !!document.querySelector(`.ev[data-task="${id}"]`), { timeout: 8000, args: [t2.id], message: 'the task on the calendar' });
    });
  });

  test('Schedule: Ctrl+Z on a quick add that made a list keeps the list a task added in Tasks has joined meanwhile', async () => {
    await withScreenshot(sched, 'qa-model-undo-list', async () => {
      const name = `Groceries${tag()}`;
      const milk = `Milk ${tag()}`;
      const eggs = `Eggs ${tag()}`;
      /** Wait until `page` holds record `id` of collection `c` (sync has brought it there). */
      const holds = (page, c, id, what) =>
        page.waitFor(([key, id]) => JSON.parse(localStorage.getItem(key) || '[]').some((x) => x.id === id), { timeout: 8000, args: [[`ecosys:v1:${c}`, id]], message: what });

      // Schedule's "Add a task": "#Groceries… Milk …" makes the list.
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), today);
      await settle(sched, 300);
      if (!(await sched.evaluate(() => !!document.querySelector('[data-panel-add]')?.checkVisibility()))) await shortcut(sched, 'i');
      await sched.waitFor(() => document.querySelector('[data-panel-add]')?.checkVisibility(), { timeout: 5000, message: "Schedule's Tasks panel" });
      await sched.click('[data-panel-add]');
      await sched.type(`#${name} ${milk}`);
      await sched.press('Enter');
      const made = await ctx.server.waitForState((s) => {
        const list = s.data.lists.find((l) => l.name === name);
        const task = list && s.data.tasks.find((t) => t.title === milk && t.listId === list.id);
        return task ? { list, task } : null;
      }, 10000, `"${milk}" and its new list "${name}" on the server`);

      // Tasks: "#Groceries… Eggs …" joins it.
      await tasks.bringToFront();
      await holds(tasks, 'lists', made.list.id, 'Tasks to have the new list');
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      if (!(await tasks.exists('textbox', 'Task name'))) await tasks.clickText('button', /^add task$/i);
      await tasks.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
      await tasks.type(`#${name} ${eggs}`);
      await tasks.press('Enter');
      await tasks.press('Escape');
      const joined = await ctx.server.waitForState((s) => s.data.tasks.find((t) => t.title === eggs), 10000, `"${eggs}" on the server`);
      assert.equal(joined.listId, made.list.id, `"${eggs}" went into the list`);

      // Schedule: Ctrl+Z takes back the quick add, Milk only.
      await sched.bringToFront();
      await holds(sched, 'tasks', joined.id, `Schedule to have "${eggs}"`);
      await shortcut(sched, 'Control+z');
      await ctx.server.waitForState((s) => !s.data.tasks.some((t) => t.id === made.task.id), 8000, `Ctrl+Z to remove "${milk}"`);
      await sleep(600); // anything else the undo wrote has reached the server by now
      const st = await ctx.server.state();
      assert.ok(st.data.lists.some((l) => l.id === made.list.id), `the list "${name}" stays: "${eggs}" is in it`);
      assert.equal(st.data.tasks.find((t) => t.id === joined.id)?.listId, made.list.id, `"${eggs}" is still in it`);

      // Tasks still shows the list, with Eggs in it.
      await tasks.bringToFront();
      await tasks.waitFor(([id, n]) => document.querySelector(`.nav-item[data-nav="${id}"]`)?.textContent.includes(n), { timeout: 8000, args: [[made.list.id, name]], message: 'the list in Tasks\' sidebar' });
      await tasks.evaluate((id) => (location.hash = `#/list/${id}`), made.list.id);
      await tasks.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"]`), { timeout: 8000, args: [joined.id], message: `"${eggs}" in its list in Tasks` });
    });
  });

  test('Schedule: a 2:30am daily event lasts its hour on the night the clocks go forward (America/Denver)', async () => {
    const page = await ctx.browser.newPage();
    try {
      await page.setViewport(1440, 900, false);
      await page.emulateColorScheme('light');
      await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Denver' }); // DST starts 2027-03-14 at 2:00
      await withScreenshot(page, 'qa-model-dst', async () => {
        const e = { id: uid(), title: `QA night shift ${tag()}`, calendarId: (await ctx.server.state()).data.calendars[0]?.id ?? null, allDay: false, start: '2027-03-12T02:30', end: '2027-03-12T03:30', location: '', notes: '', repeat: { freq: 'day', interval: 1 }, exdates: [], until: null, createdAt: now(), updatedAt: now() };
        await serverPut('events', e);
        await openApp(page, ctx.server.url('schedule/#/day/2027-03-13'));
        const span = async (d) => {
          await page.evaluate((d) => (location.hash = `#/day/${d}`), d);
          return page.waitFor((k) => {
            const b = document.querySelector(`.ev[data-ev="${k}"]`);
            return b ? [+b.dataset.top, +b.dataset.bottom] : null;
          }, { timeout: 8000, args: [`${e.id}@${d}`] });
        };
        assert.deepEqual(await span('2027-03-13'), [150, 210], '2:30 to 3:30 the day before');
        assert.deepEqual(await span('2027-03-15'), [150, 210], '2:30 to 3:30 the day after');
        assert.deepEqual(await span('2027-03-14'), [210, 270], '3:30 to 4:30 on the night 2:30 does not exist, still an hour');
        const label = await page.evaluate((k) => document.querySelector(`.ev[data-ev="${k}"]`)?.getAttribute('aria-label') || '', `${e.id}@2027-03-14`);
        assert.match(label, /3:30/, `the block says when it starts: ${label}`);
        assert.match(label, /4:30/, `and when it ends: ${label}`);
      });
    } finally {
      await page.close();
    }
  });
});
