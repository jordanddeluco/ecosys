// QA fixes in the notes editor, with real keyboard, mouse and touch input in one headless Chrome against an
// isolated server:
//   semantics     headings, quotes and code blocks have their roles, bullets and dashes their alt text, the
//                 placeholder of an empty note is no content
//   checklists    a click with no pointer press (screen reader, voice control) toggles; a real click once
//   task label    End, typing and Backspace in a task-linked item stay in that item
//   @ dates       "@fri", "@dec 3", "@next fri" are offered while typed; a name closes the list; no day twice
//   pickers       "/", "@" and "[[" right after an event chip; an open picker survives a save that relabels a chip
//   keyboard      Alt+F10 reaches a chip's or link's card (Esc comes back), Alt+Enter opens; the toolbar, the
//                 highlight list and the Aa panel move focus in and back out
//   announcements formatting, Markdown shortcuts, moves and undo are said to screen readers
//   phone         a wrapping chip keeps its glyph on its word; leaving a note while typing hands the bottom bar back
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, waitForSyncIdle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/** Type one character at a time (each an input event, as a keyboard does), so autoformat and pickers run. */
async function typeChars(page, s, ms = 30) {
  for (const ch of s) {
    if (ch === '\n') await page.press('Enter');
    else await page.type(ch);
    await sleep(ms);
  }
}

/** The rows of the editor's open suggestion list (or its empty text in parentheses), or null when none is open. */
const popRows = (page) =>
  page.evaluate(() => {
    const id = document.querySelector('.ne-doc')?.getAttribute('aria-controls');
    const p = id && document.getElementById(id);
    if (!p) return null;
    const rows = [...p.querySelectorAll('[role=option]')].map((o) => o.querySelector('.ne-opt-label')?.textContent.trim() + (o.querySelector('.ne-opt-hint') ? ` | ${o.querySelector('.ne-opt-hint').textContent.trim()}` : ''));
    const empty = p.querySelector('.ne-pop-empty')?.textContent;
    return empty ? [...rows, `(${empty})`] : rows;
  });

/** "TAG.class[name]" of the focused element. */
const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName}.${String(a.className || '').split(' ')[0]}[${a.getAttribute('aria-label') || a.textContent.trim().slice(0, 30)}]` : null;
  });

/** Collect what the editor says to screen readers (its polite live region) from now on. */
const watchLive = (page) =>
  page.evaluate(() => {
    window.__said = [];
    const live = document.querySelector('.ne-root .sr-only[aria-live]');
    new MutationObserver(() => {
      const t = live.textContent.trim();
      if (t) window.__said.push(t);
    }).observe(live, { childList: true, characterData: true, subtree: true });
  });
const said = (page) => page.evaluate(() => (window.__said || []).splice(0));

/** A note made in this browser (notes/core), opened in the editor. blocks: [type, text | runs, extra]. */
async function makeNote(page, title, blocks) {
  const id = await page.evaluate(
    async (title, blocks) => {
      const core = await import('/notes/core/notes.js');
      const B = ([t, c, extra]) => ({ t, c: typeof c === 'string' ? (c ? [[c]] : []) : c, ...(extra || {}) });
      return core.createNote({ blocks: [{ t: 'h1', c: [[title]] }, ...blocks.map(B)] }).id;
    },
    title,
    blocks,
  );
  await page.evaluate((id) => (location.hash = `#/all/n/${id}`), id);
  await page.waitFor((t) => (document.querySelector('.ne-doc')?.textContent || '').includes(t), { timeout: 8000, args: [title], message: `the note "${title}" in the editor` });
  await sleep(250);
  return id;
}

/** Put the caret in the editor: block `i` (0 = the title), at `off` characters into its first text node (or its end). */
const caretIn = (page, i, off = null) =>
  page.evaluate(
    (i, off) => {
      const ed = document.querySelector('.ne-doc');
      ed.focus();
      const tx = ed.querySelectorAll('.ne-b')[i].querySelector('.ne-tx');
      const t = [...tx.childNodes].find((n) => n.nodeType === 3) || tx;
      getSelection().collapse(t, off === null ? (t.nodeType === 3 ? t.data.length : 0) : off);
    },
    i,
    off,
  );

/** A trusted left click at viewport coordinates. */
async function clickAt(page, { x, y }) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

/** A one-finger tap (the page must emulate touch: setViewport(…, mobile)). */
async function tap(page, sel) {
  const r = await page.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return { x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 };
  }, sel);
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The editor's subtree of the accessibility tree, one "role "name"" line per node (inline text boxes left out). */
async function editorAx(page) {
  await page.send('Accessibility.enable').catch(() => {});
  const { nodes } = await page.send('Accessibility.getFullAXTree');
  const by = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => n.role?.value === 'textbox' && (n.properties || []).some((p) => p.name === 'multiline' && p.value?.value === true));
  const out = [];
  const walk = (n) => {
    if (!n) return;
    const role = n.role?.value;
    if (!n.ignored && role !== 'InlineTextBox') {
      const props = (n.properties || []).filter((p) => ['level', 'roledescription', 'checked'].includes(p.name)).map((p) => ` ${p.name}=${p.value.value}`);
      const ph = (n.name?.sources || []).find((s) => s.type === 'placeholder' && s.value?.value);
      out.push(`${role} "${n.name?.value || ''}"${props.join('')}${ph ? ` placeholder=${ph.value.value}` : ''}`);
    }
    for (const c of n.childIds || []) walk(by.get(c));
  };
  walk(root);
  return out;
}

describe('qa notes editor', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let today = null;
  async function ready() {
    if (today) return;
    await openApp(ctx.page, ctx.server.url('notes/'));
    await waitForSyncIdle(ctx.page);
    today = await browserToday(ctx.page);
  }

  test('headings, quotes, code and list markers reach screen readers; an empty note’s placeholder is not content', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-semantics', async () => {
      const t = tag();
      await makeNote(page, `Structure ${t}`, [['h2', 'Section'], ['p', 'Body'], ['bullet', 'Bullet one'], ['dash', 'Dash one'], ['num', 'Num one'], ['quote', 'A quote'], ['code', 'const x = 1;']]);
      await page.evaluate(() => document.querySelector('.ne-doc').blur());
      const tree = await editorAx(page);
      const has = (re, what) => assert.ok(tree.some((l) => re.test(l)), `${what}:\n  ${tree.join('\n  ')}`);
      has(new RegExp(`^heading "Structure ${t}" level=1$`), 'the title is a level-1 heading');
      has(/^heading "Section" level=2$/, 'a heading is a level-2 heading');
      has(/^blockquote ""$/, 'a quote is a blockquote');
      has(/^code "" roledescription=code block$/, 'a code block says "code block"');
      has(/^StaticText "Bullet"$/, 'a bullet says "Bullet"');
      has(/^StaticText "Dash"$/, 'a dash says "Dash"');
      // A new, empty note: the "Title" placeholder is drawn, not read as text; the textbox says it instead.
      await page.clickText('button', 'New note');
      await page.waitFor(() => document.activeElement?.classList.contains('ne-doc'), { timeout: 5000, message: 'the new note’s editor' });
      await sleep(200);
      const empty = await editorAx(page);
      assert.ok(!empty.some((l) => /StaticText "Title"/.test(l)), `the placeholder is not content: ${empty.join(' / ')}`);
      assert.ok(/placeholder=Title/.test(empty[0] || ''), `the empty textbox has aria-placeholder: ${empty[0]}`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ne-doc .ne-tx'), '::before').content.startsWith('"Title"')), true, 'and still shows it');
    });
  });

  test('a checklist circle toggles from a click with no pointer press (screen readers, voice control), and a real click once', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-checks', async () => {
      const t = tag();
      await makeNote(page, `Checks ${t}`, [['check', 'Milk'], ['p', 'end']]);
      const checked = () => page.evaluate(() => document.querySelector('.ne-doc .ne-ck').getAttribute('aria-checked'));
      assert.equal(await checked(), 'false');
      await page.evaluate(() => document.querySelector('.ne-doc .ne-ck').click());
      await page.waitFor(() => document.querySelector('.ne-doc .ne-ck').getAttribute('aria-checked') === 'true', { timeout: 3000, message: 'element.click() checks it' });
      await page.evaluate(() => {
        const ck = document.querySelector('.ne-doc .ne-ck');
        for (const type of ['mousedown', 'mouseup', 'click']) ck.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      await page.waitFor(() => document.querySelector('.ne-doc .ne-ck').getAttribute('aria-checked') === 'false', { timeout: 3000, message: 'a synthetic mousedown, mouseup, click (an AT click) unchecks it' });
      const r = await page.evaluate(() => {
        const b = document.querySelector('.ne-doc .ne-ck').getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      await clickAt(page, r);
      await sleep(300);
      assert.equal(await checked(), 'true', 'a real click toggles once (its click event does not toggle it back)');
    });
  });

  test('End, typing and Backspace in a task-linked checklist item stay in that item', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-end', async () => {
      const t = tag();
      const id = await makeNote(page, `End key ${t}`, [['check', `item ${t}`], ['p', `last line ${t}`]]);
      await page.evaluate(async (id) => {
        const core = await import('/notes/core/notes.js');
        const block = core.getNote(id).blocks.find((b) => b.t === 'check');
        core.sendBlocksToTasks(id, [block.id]);
      }, id);
      await page.waitFor(() => document.querySelector('.ne-doc .ne-b[data-task] .ne-taskmeta'), { timeout: 8000, message: 'the item with its task label' });
      // Click in the empty part of the line, right of the label (the usual way to reach a line's end).
      const pos = await page.evaluate(() => {
        const r = document.querySelector('.ne-doc .ne-b[data-task] .ne-tx').getBoundingClientRect();
        return { x: r.right - 12, y: r.y + r.height / 2 };
      });
      await clickAt(page, pos);
      await sleep(200);
      await page.press('End');
      await page.type('Q');
      await sleep(400);
      const lines = () => page.evaluate(() => [...document.querySelectorAll('.ne-doc .ne-tx')].map((e) => e.firstChild?.textContent || ''));
      let got = await lines();
      assert.ok(got.includes(`item ${t}Q`), `"Q" lands at the end of the item: ${JSON.stringify(got)}`);
      assert.ok(!got.includes(`last line ${t}Q`), 'not at the end of the note');
      // From after the label, End stays on the line and Backspace deletes the last character, not the label.
      await page.press('End');
      await page.press('End');
      await page.press('Backspace');
      await sleep(300);
      got = await lines();
      assert.ok(got.includes(`item ${t}`), `Backspace deletes the "Q": ${JSON.stringify(got)}`);
      assert.ok(await page.evaluate(() => !!document.querySelector('.ne-doc .ne-b[data-task] .ne-taskmeta')), 'the task label stays');
    });
  });

  test('@ dates: "@fri", "@dec 3" and "@next fri" are offered while typed, a name closes the list, no day twice', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-dates', async () => {
      const t = tag();
      await makeNote(page, `Dates ${t}`, [['p', '']]);
      await caretIn(page, 1);
      const probe = async (s) => {
        await page.evaluate(() => document.querySelector('.ne-doc').focus());
        await typeChars(page, s);
        await sleep(150);
        const rows = await popRows(page);
        if (rows) await page.press('Escape');
        await page.press('Enter');
        return rows;
      };
      const first = await probe('@');
      const dates = (first || []).map((r) => r.split(' | ')[1]);
      assert.equal(new Set(dates).size, dates.length, `no day is offered twice (on a Sunday next Monday is tomorrow): ${JSON.stringify(first)}`);
      for (const [s, want] of [
        ['@f', '(Keep typing a date)'],
        ['@fr', '(Keep typing a date)'],
        ['@fri', /^Fri, /],
        ['@dec ', '(Keep typing a date)'],
        ['@dec 3', /^\w{3}, Dec 3$|^\w{3}, 3 Dec$/],
        ['@next f', '(Keep typing a date)'],
        ['@next fri', /^Fri, /],
        ['@in 2 weeks', /^\w{3}, /],
      ]) {
        const rows = await probe(s);
        assert.ok(rows && rows.length, `"${s}" keeps the date list open: ${JSON.stringify(rows)}`);
        const label = rows[0].split(' | ')[0];
        assert.ok(typeof want === 'string' ? rows[0] === want : want.test(label), `"${s}" offers ${want}: ${JSON.stringify(rows)}`);
      }
      assert.equal(await probe('@mark'), null, '"@mark" is a name: the list closes');
      // A date's hint is plain text, not the monospace of Markdown hints.
      await typeChars(page, '@fri');
      await sleep(150);
      const font = await page.evaluate(() => getComputedStyle(document.querySelector('.ne-pop .ne-opt-hint')).fontFamily);
      assert.doesNotMatch(font, /mono/i, `date hints use the text font: ${font}`);
      await page.press('Escape');
    });
  });

  test('pickers open right after an event chip; an open picker survives a save that relabels a chip before it', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-pickers', async () => {
      const t = tag();
      const evTitle = `Picker ev ${t}`;
      await page.evaluate(
        async (title, date) => {
          const m = await import('/shared/model.js');
          m.createEvent({ title, date, time: '11:00', duration: 30 });
        },
        evTitle,
        addDaysYmd(today, 1),
      );
      await makeNote(page, `Agenda ${t}`, [['p', '']]);
      const results = [];
      for (const [pause, typed] of [[0, ' @tom'], [300, ' day @tom'], [300, ' /']]) {
        await caretIn(page, (await page.evaluate(() => document.querySelectorAll('.ne-doc .ne-b').length)) - 1);
        const before = await page.evaluate(() => document.querySelectorAll('.ne-doc .ne-chip-event').length);
        await typeChars(page, `Item [[${evTitle}`);
        await page.waitFor((x) => [...document.querySelectorAll('.ne-pop [role=option]')].some((o) => o.textContent.includes(x)), { timeout: 8000, args: [evTitle], message: 'the event in the link picker' });
        await sleep(300);
        await page.press('Enter');
        await page.waitFor((n) => document.querySelectorAll('.ne-doc .ne-chip-event').length > n, { timeout: 5000, args: [before], message: 'the event chip' });
        await sleep(pause);
        await typeChars(page, typed);
        await sleep(700); // past the 400 ms save, whose stored copy comes back into the editor
        results.push(`${JSON.stringify(typed)} after ${pause} ms: ${(await popRows(page)) ? 'opens' : 'does not open'}`);
        await page.press('Escape');
        await page.press('Enter');
      }
      assert.ok(results.every((r) => r.endsWith(': opens')), `each picker opens on the chip's line:\n  ${results.join('\n  ')}`);
      const label = await page.evaluate(() => document.querySelector('.ne-doc .ne-chip-event').dataset.label);
      assert.equal(label, evTitle, 'the chip stores the event title, the label the save keeps (the day and time are shown live)');

      // A note chip, then its note is renamed: the next save relabels the chip while "/" is open after it.
      const target = await page.evaluate(async (title) => {
        const core = await import('/notes/core/notes.js');
        return core.createNote({ blocks: [{ t: 'h1', c: [[title]] }] }).id;
      }, `Target ${t}`);
      await caretIn(page, (await page.evaluate(() => document.querySelectorAll('.ne-doc .ne-b').length)) - 1);
      await typeChars(page, `See [[Target ${t}`);
      await page.waitFor((x) => [...document.querySelectorAll('.ne-pop [role=option]')].some((o) => o.textContent.includes(x)), { timeout: 8000, args: [`Target ${t}`], message: 'the note in the link picker' });
      await sleep(200);
      await page.press('Enter');
      await page.waitFor(() => document.querySelector('.ne-doc .ne-chip-note'), { timeout: 5000, message: 'the note chip' });
      await sleep(900);
      await page.evaluate(async (id, title) => {
        const core = await import('/notes/core/notes.js');
        core.saveBlocks(id, [{ t: 'h1', c: [[title]] }], { by: 'user' });
      }, target, `A much longer renamed target ${t}`);
      await sleep(300);
      await typeChars(page, 'then /hea');
      assert.ok((await popRows(page))?.[0]?.startsWith('Heading'), 'the slash menu is open');
      await sleep(1200); // the save relabels the chip (a longer label before the "/")
      assert.equal(await page.evaluate(() => document.querySelector('.ne-doc .ne-chip-note').dataset.label), `A much longer renamed target ${t}`, 'the save relabelled the chip');
      assert.ok((await popRows(page))?.[0]?.startsWith('Heading'), 'the slash menu is still open after the relabel');
      await page.press('Enter');
      await sleep(300);
      const last = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.ne-doc .ne-b')].pop();
        return { type: b.dataset.type, text: b.textContent };
      });
      assert.equal(last.type, 'h2', 'Enter picked Heading');
      assert.equal(last.text, `See A much longer renamed target ${t} then `, 'exactly "/hea" was replaced');
    });
  });

  test('Alt+F10 reaches the card of a chip or a link, Esc comes back to the same caret, Alt+Enter opens a link', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-cards', async () => {
      const t = tag();
      const taskTitle = `Buy milk ${t}`;
      const taskId = await page.evaluate(async (title) => (await import('/shared/model.js')).createTask({ title }).id, taskTitle);
      await makeNote(page, `Cards ${t}`, [
        ['p', [['Get '], [taskTitle, '', { ref: `task:${taskId}`, atom: 1 }], [' soon']]],
        ['p', [['Go to the '], ['site', '', { href: 'https://example.com/page' }], [' now']]],
      ]);
      await page.evaluate(() => document.querySelector('.ne-doc').focus());
      await watchLive(page);
      // The caret one space after the chip (where it is after inserting one).
      await page.evaluate(() => {
        const tx = document.querySelectorAll('.ne-doc .ne-tx')[1];
        const after = [...tx.childNodes].find((n) => n.nodeType === 3 && n.data.startsWith(' soon'));
        getSelection().collapse(after, 1);
      });
      await sleep(400);
      assert.ok((await said(page)).some((s) => s.startsWith(`Task: ${taskTitle}. Alt+F10`)), 'arriving at a chip says what it is and how to reach its options');
      await page.press('Alt+F10');
      await sleep(200);
      assert.equal(await focused(page), 'BUTTON.ne-cc-task[Complete task]', 'Alt+F10 shows the chip card and focuses its first button');
      await page.press('Escape');
      await sleep(200);
      assert.match(await focused(page), /^DIV\.ne-doc/, 'Esc goes back to the editor');
      assert.equal(await page.evaluate(() => !!document.querySelector('.ne-chipcard')), false, 'and closes the card');
      assert.equal(await page.evaluate(() => getSelection().anchorNode.data?.startsWith(' soon') && getSelection().anchorOffset), 1, 'at the same caret');
      await page.press('Alt+F10');
      await sleep(150);
      await page.press('Enter'); // Complete
      await sleep(400);
      assert.equal(await page.evaluate(async (id) => (await import('/shared/store.js')).db.get('tasks', id)?.done, taskId), true, 'Enter on Complete completes the task');
      assert.match(await focused(page), /^DIV\.ne-doc/, 'and hands focus back to the note');

      // A URL link: the card from the keyboard, arrows between its buttons, Tab stays in it, Esc back.
      await page.evaluate(() => {
        const a = document.querySelector('.ne-doc a.ne-link');
        getSelection().collapse(a.firstChild, 2);
      });
      await sleep(400);
      assert.ok((await said(page)).includes('Link to example.com. Alt+F10 for options.'), 'arriving in a link says where it goes');
      await page.press('Alt+F10');
      await sleep(150);
      assert.equal(await focused(page), 'BUTTON.ne-lc-open[Open example.com]');
      await page.press('ArrowRight');
      assert.equal(await focused(page), 'BUTTON.ne-tb-btn[Edit link]', 'arrows move between the card’s buttons');
      await page.press('Tab');
      await page.press('Tab');
      assert.equal(await focused(page), 'BUTTON.ne-lc-open[Open example.com]', 'Tab cycles inside the card (it never strands focus at the end of the page)');
      await page.press('Escape');
      await sleep(150);
      assert.match(await focused(page), /^DIV\.ne-doc/, 'Esc goes back to the editor');
      await page.evaluate(() => {
        window.__opened = [];
        HTMLAnchorElement.prototype.click = function () {
          window.__opened.push(this.href);
        };
      });
      await page.press('Alt+Enter');
      await page.press('Mod+Enter');
      await sleep(200);
      assert.deepEqual(await page.evaluate(() => window.__opened), ['https://example.com/page', 'https://example.com/page'], 'Alt+Enter, and Ctrl+Enter outside a checklist, open the link');
    });
  });

  test('the toolbar, its highlight list and the Aa panel take focus from the keyboard and give it back', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-toolbar', async () => {
      const t = tag();
      await makeNote(page, `Toolbar ${t}`, [['p', 'Go to the site now']]);
      await page.evaluate(() => {
        const tx = document.querySelectorAll('.ne-doc .ne-tx')[1];
        document.querySelector('.ne-doc').focus();
        getSelection().setBaseAndExtent(tx.firstChild, 3, tx.firstChild, 5);
      });
      await sleep(150);
      await page.press('Alt+F10');
      await sleep(150);
      assert.equal(await focused(page), 'BUTTON.ne-tb-btn[Bold]', 'Alt+F10 shows the selection toolbar and focuses it');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.ne-seltb button')].filter((b) => b.tabIndex === 0).length), 1, 'the toolbar is one tab stop');
      for (let i = 0; i < 5; i++) await page.press('ArrowRight');
      assert.equal(await focused(page), 'BUTTON.ne-tb-btn[Highlight]');
      await page.press('Space');
      await sleep(150);
      assert.match(await focused(page), /^BUTTON\.ne-sw\[/, 'the highlight list takes focus');
      await page.press('Escape');
      await sleep(100);
      assert.equal(await focused(page), 'BUTTON.ne-tb-btn[Highlight]', 'Esc closes the list back to its button');
      assert.equal(await page.evaluate(() => !!document.querySelector('.ne-swpop')), false);
      await page.press('Space');
      await sleep(150);
      assert.equal(await page.evaluate(() => !!document.querySelector('.ne-swpop')), true, 'and the button opens it again');
      await page.press('ArrowRight');
      await page.press('Enter');
      await sleep(300);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ne-doc mark.ne-hl').length), 1, 'a colour picked by keyboard highlights the selection');
      await page.press('Alt+F10');
      await sleep(150);
      await page.press('Escape');
      await sleep(150);
      assert.match(await focused(page), /^DIV\.ne-doc/, 'Esc in the toolbar goes back to the text');
      assert.equal(await page.evaluate(() => !!document.querySelector('.ne-seltb')), false, 'and hides the toolbar');

      // The note's Aa button from the keyboard: focus moves into the Format panel; arrows choose a style.
      await caretIn(page, 1, 2);
      await page.evaluate(() => document.querySelector('[data-aa]').focus());
      await page.press('Space');
      await sleep(250);
      assert.equal(await focused(page), 'BUTTON.ne-aa-style[Body]', 'the panel opens with focus on the current style');
      assert.equal(await page.evaluate(() => document.querySelector('[data-aa]').getAttribute('aria-expanded')), 'true', 'its button says it is expanded');
      await page.press('ArrowLeft');
      await sleep(200);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ne-doc .ne-b')[1].dataset.type), 'h3', 'ArrowLeft chooses Subheading');
      await page.press('Escape');
      await sleep(150);
      assert.equal(await page.evaluate(() => !!document.querySelector('.ne-aa')), false, 'Esc closes the panel');
    });
  });

  test('formatting, Markdown shortcuts, moves and undo are said to screen readers', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-announce', async () => {
      const t = tag();
      await makeNote(page, `Announce ${t}`, [['p', '']]);
      await caretIn(page, 1);
      await watchLive(page);
      const after = async (fn) => {
        await fn();
        await sleep(250);
        return said(page);
      };
      assert.deepEqual(await after(() => page.press('Mod+b')), ['Bold on']);
      assert.deepEqual(await after(() => page.press('Mod+b')), ['Bold off']);
      assert.deepEqual(await after(() => typeChars(page, '## ')), ['Converted to Heading']);
      assert.deepEqual(await after(() => page.press('Backspace')), ['Restored ##']);
      await page.press('Enter');
      assert.deepEqual(await after(() => typeChars(page, '* one\ntwo')), ['Converted to Bulleted list']);
      assert.deepEqual(await after(() => page.press('Tab')), ['Indented, level 2']);
      assert.deepEqual(await after(() => page.press('Shift+Tab')), ['Outdented, level 1']);
      assert.deepEqual(await after(() => page.press('Alt+Shift+ArrowUp')), ['Moved up']);
      assert.deepEqual(await after(() => page.press('Mod+z')), ['Undo move']);
      assert.deepEqual(await after(() => page.press(process.platform === 'darwin' ? 'Mod+Shift+z' : 'Control+y')), ['Redo move']);

      // The link field (Mod+K, the toolbar's Link, the link card's Edit) says what it did, as Remove link does.
      await makeNote(page, `Link field ${t}`, [['p', 'see the site now']]);
      await caretIn(page, 1);
      await watchLive(page);
      const field = async (fn) => {
        await page.press('Mod+k');
        await page.waitFor(() => document.activeElement?.classList.contains('ne-lf-input'), { timeout: 3000, message: 'the link field' });
        await fn();
        return after(() => page.press('Enter'));
      };
      await page.evaluate(() => {
        const tn = [...document.querySelectorAll('.ne-doc .ne-tx')].pop().firstChild;
        getSelection().setBaseAndExtent(tn, 8, tn, 12);
      });
      await sleep(150);
      await said(page);
      assert.deepEqual(await field(() => page.type('example.com')), ['Link added']);
      assert.equal(await page.evaluate(() => document.querySelector('.ne-doc a.ne-link')?.getAttribute('href')), 'https://example.com/');
      await page.evaluate(() => getSelection().collapse(document.querySelector('.ne-doc a.ne-link').firstChild, 2));
      await sleep(300);
      await said(page);
      const upd = await field(async () => {
        await page.press('Mod+a');
        await page.type('new.example.org');
      });
      assert.equal(upd[0], 'Link updated. Link to new.example.org. Alt+F10 for options.', `a new address says so, and where the link at the caret goes now: ${JSON.stringify(upd)}`);
      assert.deepEqual(
        await field(async () => {
          await page.press('Mod+a');
          await page.press('Backspace');
        }),
        ['Link removed'],
      );
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ne-doc a.ne-link').length), 0);
    });
  });

  test('a link or chip is said once: not again while typing or deleting before it, after Esc from its card or the link field, or after a save relabels a chip before it; an undo that lands on one says both', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-said-once', async () => {
      const t = tag();
      const taskTitle = `Call Bob ${t}`;
      const taskId = await page.evaluate(async (title) => (await import('/shared/model.js')).createTask({ title }).id, taskTitle);
      const evId = await page.evaluate(async (date) => (await import('/shared/model.js')).createEvent({ title: 'Standup', date, time: '09:30', duration: 15 }).id, today);
      const target = await page.evaluate(async (title) => (await import('/notes/core/notes.js')).createNote({ blocks: [{ t: 'h1', c: [[title]] }] }).id, `Target ${t}`);
      const chip = (title, ref) => [title, '', { ref, atom: 1 }];
      await makeNote(page, `Said once ${t}`, [
        ['p', [chip(taskTitle, `task:${taskId}`), [' is first']]],
        ['p', [['Remember to '], chip(taskTitle, `task:${taskId}`), [' later']]],
        ['p', [['Meet at '], chip('Standup', `event:${evId}@${today}`), [' ok']]],
        ['p', [['See '], chip(`Target ${t}`, `note:${target}`), [' and the '], ['site', '', { href: 'https://example.com/x' }], [' now']]],
      ]);
      await page.evaluate(() => document.querySelector('.ne-doc').focus());
      await watchLive(page);
      const hints = (list, what) => list.filter((s) => s.includes(what));
      /** Collapse the caret in line `i`: in its text node that starts with `starts` (or the line itself), at `off`. */
      const caretAt = (i, off, starts = null) =>
        page.evaluate(
          (i, off, starts) => {
            const tx = document.querySelectorAll('.ne-doc .ne-tx')[i];
            getSelection().collapse(starts === null ? tx : [...tx.childNodes].find((n) => n.nodeType === 3 && n.data.startsWith(starts)), off);
          },
          i,
          off,
          starts,
        );
      const lineText = (i) => page.evaluate((i) => document.querySelectorAll('.ne-doc .ne-tx')[i].textContent, i);

      // A chip at the start of a line: arriving says it; typing 4 characters before it and 2 Backspaces do not.
      await caretAt(1, 0);
      await sleep(400);
      assert.equal(hints(await said(page), `Task: ${taskTitle}`).length, 1, 'arriving at the chip says it once');
      await typeChars(page, 'Get ', 120);
      await page.press('Backspace');
      await sleep(120);
      await page.press('Backspace');
      await sleep(400);
      assert.deepEqual(await said(page), [], 'typing and deleting before the chip say nothing more (the keys echo themselves)');
      assert.equal(await lineText(1), `Ge${taskTitle} is first`);

      // "Remember to| [chip]": typing before the space keeps the chip one space ahead, and says nothing either.
      await caretAt(2, 11, 'Remember');
      await sleep(400);
      assert.equal(hints(await said(page), 'Task:').length, 1, 'arriving one space before the chip says it');
      await typeChars(page, ' call', 120);
      await sleep(300);
      assert.deepEqual(await said(page), [], 'typing before it says nothing');

      // Backspacing back to a chip is no arrival; an undo that puts the caret back on one says both.
      await caretAt(2, 1, ' later');
      await sleep(400);
      await said(page);
      await typeChars(page, 'xyz', 80);
      await sleep(300);
      for (let i = 0; i < 3; i++) await page.press('Backspace');
      await sleep(400);
      assert.deepEqual(await said(page), [], 'deleting back to the chip says nothing');
      await typeChars(page, 'abc', 80);
      await sleep(400);
      await said(page);
      await page.press('Mod+z');
      await sleep(400);
      assert.deepEqual(await said(page), [`Undo typing. Task: ${taskTitle}. Alt+F10 for options.`], 'the undo says what it undid and where the caret is');

      // Esc back from a chip's card (caret right after the chip element: Esc writes the same caret in another
      // DOM spot, a selection change of its own) and from the link field: no new arrival.
      await page.evaluate(() => {
        const r = document.createRange();
        r.setStartAfter(document.querySelector('.ne-doc .ne-chip-event'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      });
      await sleep(400);
      assert.equal(hints(await said(page), 'Event: Standup').length, 1);
      await page.press('Alt+F10');
      await sleep(250);
      assert.match(await focused(page), /^BUTTON\.btn\[Open\]/, 'the event card has focus');
      await page.press('Escape');
      await sleep(500);
      assert.match(await focused(page), /^DIV\.ne-doc/);
      assert.deepEqual(await said(page), [], 'back from the card the chip is not said again');
      await page.evaluate(() => getSelection().collapse(document.querySelector('.ne-doc a.ne-link').firstChild, 2));
      await sleep(400);
      assert.deepEqual(await said(page), ['Link to example.com. Alt+F10 for options.']);
      await page.press('Mod+k');
      await page.waitFor(() => document.activeElement?.classList.contains('ne-lf-input'), { timeout: 3000, message: 'the link field' });
      await page.press('Escape');
      await sleep(500);
      assert.match(await focused(page), /^DIV\.ne-doc/);
      assert.deepEqual(await said(page), [], 'back from the link field (cancelled) the link is not said again');

      // The note behind the chip before the link is renamed: the save relabels the chip, every offset after it
      // moves, and the caret (still in the link) is no new arrival.
      await page.evaluate(async (id, title) => (await import('/notes/core/notes.js')).saveBlocks(id, [{ t: 'h1', c: [[title]] }], { by: 'user' }), target, `A much longer renamed target ${t}`);
      await sleep(200);
      await page.type('Q'); // an edit: the note saves, and its stored copy (the relabelled chip) comes back
      await page.waitFor((l) => document.querySelector('.ne-doc .ne-chip-note')?.dataset.label === l, { timeout: 8000, args: [`A much longer renamed target ${t}`], message: 'the chip relabelled by the save' });
      await sleep(500);
      assert.deepEqual(await said(page), [], 'a relabelled chip earlier in the line does not make the link new');
      assert.equal(await page.evaluate(() => document.querySelector('.ne-doc a.ne-link').textContent), 'siQte', 'the caret stayed in the link');
    });
  });

  test('an unresolved [[link]]: Alt+F10 reaches its Create note card, Tab stays in it, Esc comes back, Enter creates the note and comes back', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-wiki-card', async () => {
      const t = tag();
      await makeNote(page, `Wiki ${t}`, [['p', `Make [[Nowhere ${t}]] soon`]]);
      const caret = () =>
        page.evaluate(() => {
          const s = getSelection();
          return s.anchorNode?.nodeType === 3 ? `${s.anchorNode.data.slice(0, 7)}@${s.anchorOffset}` : null;
        });
      await caretIn(page, 1, 9);
      await sleep(400);
      await page.press('Alt+F10');
      await sleep(250);
      assert.equal(await focused(page), `BUTTON.ne-lc-open[Create note “Nowhere ${t}”]`, 'Alt+F10 focuses the card’s button');
      assert.equal(await page.evaluate(() => !!document.querySelector('.ne-wikicard')), true, 'and the card stays');
      await page.press('Tab');
      assert.match(await focused(page), /^BUTTON\.ne-lc-open\[Create note/, 'Tab stays in the card');
      await page.press('Escape');
      await sleep(250);
      assert.match(await focused(page), /^DIV\.ne-doc/, 'Esc goes back to the note');
      assert.equal(await caret(), 'Make [[@9', 'at the same caret');
      await page.press('Alt+F10');
      await sleep(250);
      assert.match(await focused(page), /^BUTTON\.ne-lc-open\[Create note/, 'Alt+F10 again (the card was hidden by Esc) shows it and focuses it');
      await page.press('Enter');
      await page.waitFor((x) => document.querySelector('.ne-doc .ne-chip-note')?.textContent.includes(x), { timeout: 5000, args: [`Nowhere ${t}`], message: 'the new note’s chip' });
      await sleep(200);
      assert.match(await focused(page), /^DIV\.ne-doc/, 'focus is back in the note, where the chip landed');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ne-doc .ne-tx')[1].textContent), `Make Nowhere ${t} soon`);
    });
  });

  test('Send to Tasks has one glyph: the checklist menu’s two Send items draw the slash menu’s', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-send-glyph', async () => {
      const t = tag();
      await makeNote(page, `Send ${t}`, [['check', 'Milk'], ['check', 'Eggs'], ['check', '']]);
      await caretIn(page, 3); // the slash menu offers Send to Tasks in a checklist
      await typeChars(page, '/send');
      await page.waitFor(() => [...document.querySelectorAll('.ne-pop [role=option]')].some((o) => o.textContent.includes('Send to Tasks')), { timeout: 3000, message: 'Send to Tasks in the slash menu' });
      const slash = await page.evaluate(() => {
        const o = [...document.querySelectorAll('.ne-pop [role=option]')].find((x) => x.textContent.includes('Send to Tasks'));
        return [...o.querySelectorAll('svg path')].map((p) => p.getAttribute('d')).join(' | ');
      });
      assert.ok(slash, 'the slash menu row has a glyph');
      await page.press('Escape');
      const r = await page.evaluate(() => {
        const b = document.querySelector('.ne-doc .ne-ck').getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...r });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'right', buttons: 2, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'right', buttons: 0, clickCount: 1 });
      await page.waitFor(() => [...document.querySelectorAll('.menu [role=menuitem]')].some((b) => b.textContent.includes('Send unchecked')), { timeout: 3000, message: 'the checklist menu' });
      const items = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('.menu [role=menuitem]')]
            .filter((b) => /^Send/.test(b.textContent.trim()))
            .map((b) => [b.textContent.trim(), [...b.querySelectorAll('svg path')].map((p) => p.getAttribute('d')).join(' | ')]),
        ),
      );
      await page.press('Escape');
      assert.equal(Object.keys(items).length, 2, `both Send items: ${JSON.stringify(Object.keys(items))}`);
      assert.equal(Object.keys(items)[0], 'Send to Tasks');
      assert.match(Object.keys(items)[1], /^Send unchecked to Tasks \(\d\)$/);
      for (const [label, d] of Object.entries(items)) assert.equal(d, slash, `"${label}" draws the same glyph as the slash menu's Send to Tasks`);
    });
  });

  test('the Aa panel’s focused style shows its whole focus ring, on a phone too (a half-shown style scrolls into view)', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-aa-ring', async () => {
      const t = tag();
      await makeNote(page, `Ring ${t}`, [['p', 'Body text']]);
      const ring = () =>
        page.evaluate(() => {
          const a = document.activeElement;
          const row = a.closest('.ne-aa-styles');
          if (!row) return { focus: a.className };
          const r = a.getBoundingClientRect();
          const rr = row.getBoundingClientRect();
          const cs = getComputedStyle(a);
          const o = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth);
          return { focus: a.textContent.trim(), visible: a.matches(':focus-visible'), inside: r.top - o >= rr.top - 0.5 && r.bottom + o <= rr.bottom + 0.5 && r.left - o >= rr.left - 0.5 && r.right + o <= rr.right + 0.5 };
        });
      const openAa = async () => {
        await page.evaluate(() => document.querySelector('.ne-doc').blur());
        await page.press('Shift'); // a key first: focus() then shows the keyboard ring
        await page.evaluate(() => [...document.querySelectorAll('[data-aa]')].find((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').focus());
        await page.press('Space');
        await page.waitFor(() => document.activeElement?.classList.contains('ne-aa-style'), { timeout: 3000, message: 'focus on a style in the Aa panel' });
        await sleep(150);
      };
      await caretIn(page, 1, 2);
      await openAa();
      let g = await ring();
      assert.deepEqual(g, { focus: 'Body', visible: true, inside: true }, 'at 1440 the ring is whole inside the scrolling row');
      await page.press('Escape');
      await page.setViewport(390, 844, true);
      try {
        await sleep(300);
        await openAa();
        assert.equal((await ring()).inside, true, 'at 390 too');
        await page.press('ArrowRight'); // Code block: half outside the row until focus scrolls it in
        await sleep(300);
        g = await ring();
        assert.deepEqual(g, { focus: 'Code block', visible: true, inside: true }, 'a half-shown style scrolls into view with its whole ring');
        assert.notEqual(await page.evaluate(() => document.querySelector('.ne-aa-styles').dataset.fade), 'end', 'and is not under the edge fade');
        await page.press('Escape');
      } finally {
        await page.setViewport(1440, 900, false);
      }
    });
  });

  test('phone: a wrapping chip keeps its glyph on its word; leaving a note while typing hands the bottom bar back', async () => {
    const { page } = ctx;
    await ready();
    await withScreenshot(page, 'qa-notes-editor-phone', async () => {
      await page.setViewport(390, 844, true);
      try {
        const t = tag();
        const taskId = await page.evaluate(async () => (await import('/shared/model.js')).createTask({ title: 'Welcome to tasks — tap the circle to complete me' }).id);
        const evId = await page.evaluate(async (date) => (await import('/shared/model.js')).createEvent({ title: 'Team standup', date, time: '09:30', duration: 15 }).id, today);
        await makeNote(page, `Chips ${t}`, [
          ['p', [['Chips: task '], ['x', '', { ref: `task:${taskId}`, atom: 1 }], [', event '], ['Team standup', '', { ref: `event:${evId}@${today}`, atom: 1 }], [', day '], ['x', '', { ref: `day:${today}`, atom: 1 }], ['.']]],
          ['p', 'More text'],
        ]);
        const lines = await page.evaluate(() =>
          [...document.querySelectorAll('.ne-doc .ne-nb, .ne-doc .ne-chip-day')].map((n) => ({ text: n.textContent, lines: new Set([...n.getClientRects()].map((r) => Math.round(r.top))).size })),
        );
        assert.ok(lines.length >= 4, `glyph groups rendered: ${JSON.stringify(lines)}`);
        for (const l of lines) assert.equal(l.lines, 1, `"${l.text}" stays on one line (a glyph never ends a line alone)`);
        const taskChip = await page.evaluate(() => document.querySelector('.ne-doc .ne-chip-task').getClientRects().length);
        assert.ok(taskChip >= 2, 'the long task chip does wrap (its fragments keep their fill: box-decoration-break)');

        // Typing (the keyboard bar is up), then the note goes away while the editor still has focus.
        await tap(page, '.ne-doc .ne-b:nth-child(2) .ne-tx');
        await page.waitFor(() => !!document.querySelector('.ne-acc.on'), { timeout: 3000, message: 'the keyboard accessory bar' });
        const before = await page.evaluate(() => document.querySelector('.nshell')?.className || '');
        const seen = await page.evaluate(
          () =>
            new Promise((res) => {
              const seen = [];
              document.addEventListener('editor:accessory', (e) => seen.push(e.detail.visible));
              location.hash = '#/all';
              setTimeout(() => res(seen), 600);
            }),
        );
        assert.deepEqual(seen, [false], 'the editor says its bar is gone when it is destroyed while typing');
        if (before.includes('kb-up')) assert.ok(!(await page.evaluate(() => document.querySelector('.nshell').className)).includes('kb-up'), 'the note screen gets its bottom bar back');
      } finally {
        await page.setViewport(1440, 900, false);
      }
    });
  });
});
