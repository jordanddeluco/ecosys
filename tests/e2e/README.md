# ecosys end-to-end tests

Browser tests for the ecosys apps, driving a real headless Chrome through the Chrome DevTools
Protocol. There are no dependencies: a small CDP client over Node's global `WebSocket`, `node:test`,
and the Chrome already installed on the machine.

```
node --test tests/e2e/                      everything, one process: suites run one after another
node --test tests/e2e/flows.test.mjs        one file
node --test tests/e2e/*.test.mjs            each file in its own process (still one Chrome at a time)
node --test --test-name-pattern="tasks" tests/e2e/flows.test.mjs     one test
```

On Node 22+ `node --test <dir>/` loads the directory as a module instead of searching it, so
`index.js` imports the three test files. A full run takes about 40 seconds.

Requirements: Node 22 or newer (Node 24 is used here) and Google Chrome. The default path is
`C:/Program Files/Google/Chrome/Application/chrome.exe`, and the usual macOS/Linux locations are
also tried.

## What is tested

| File | What it checks |
|---|---|
| `harness.test.mjs` | The harness itself. The server launcher (random port, temp data dir, clean stop) and the CDP client against a fixture page: navigation status, `evaluate`, `waitFor`, trusted clicks (with exact-name preference, and hidden or covered elements skipped), typing, keys and combos, console-error capture, viewport, colour scheme, screenshots, isolated profiles, the Chrome lock. |
| `smoke.test.mjs` | `/`, `/tasks/`, `/schedule/` and `/notes/`, each in light and dark at 1440x900 and 390x844 (390x844 is emulated as a phone with touch). Each page must answer HTTP 200, start the shell (`window.ecosysSync`), come online with the server, and set `data-theme` to the system scheme, with **zero console errors**. Phone pages must not scroll sideways. |
| `flows.test.mjs` | **tasks:** adds "… today 4pm p1" in the composer and checks the server has date, time and priority parsed and the name clean, then completes it from its checkbox. **schedule:** Create, type "… 10am", Save; the event appears and is saved for today at 10:00. **notes:** New note, type a title and a line; it reaches the server and survives a reload. **cross-app:** a task added in tasks shows in schedule after a reload, and in a fresh browser profile, so it must have come through the server. A fresh profile must not push its sample tasks to the server. **AI:** `GET /api/ai` (shape, guards, a new connection listed with its key), and the Connect AI panel opens from the app menu, loads `/api/ai`, lists Claude, ChatGPT and Grok, and closes with Escape. A last test checks there were no console errors during the flows. |

The tests find elements the way a person does: by role, accessible name and visible text (`clickText('button', 'Create')`, `clickText('checkbox', title)`), not by class names. They check results in the server's data as well as on screen, so a visual redesign should not break them.

### Skips

- **notes**: the smoke and flow tests skip `/notes/` while files the notes app needs are missing.
  This covers files `notes/index.html` links to and the modules `notes/app.js` imports. The skip
  message lists the missing files.
- **Connect AI panel**: skipped while `shared/ai.js` is not served.

When a page fails, the message lists the console errors and any files the page references that the
server doesn't have. A screenshot is saved too (see Artifacts).

## Isolation and cleanup

- **Server:** `server.mjs` starts the real entry point (`server.mjs` at the repo root) in a child
  process, on a random free port (never 4300, the live dev server). Its data goes in a fresh temp
  directory passed as `ECOSYS_DATA_DIR`. Before any test uses the server, the harness checks that
  the server wrote its `server.json` into that directory. The directory is deleted on stop. The
  child process exits by itself if the test process dies (`server-child.mjs` watches the IPC channel
  and the parent's pid). Real data in `.ecosys/` is never read or written.
- **Chrome:** each launch uses a fresh temp `--user-data-dir`, which is deleted on close. Chrome is
  killed if the test process exits without closing it. `newPage({ isolated: true })` opens a
  separate browser context, with its own storage, like a second profile.
- **One Chrome at a time:** `launch()` takes a machine-wide lock before starting Chrome and holds
  it until `close()`. The lock is a named pipe (a unix socket elsewhere), so the OS frees it if the
  holder dies. When test files run in parallel, they wait their turn for the browser.
- Nothing is written into the repository.

## Artifacts

Failure screenshots are saved to `%TEMP%\ecosys-e2e-artifacts\` (`$TMPDIR/ecosys-e2e-artifacts/`),
and the failure message gives the exact path. To save them somewhere else, set `E2E_ARTIFACTS`.

## Environment variables

| Variable | Effect |
|---|---|
| `E2E_CHROME` (or `CHROME_PATH`) | Chrome executable to use |
| `E2E_HEADFUL=1` | Show the browser window instead of running headless |
| `E2E_ARTIFACTS` | Folder for screenshots |

## Writing tests

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, tag } from './helpers.mjs';

describe('my flow', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' }); // Chrome tab + isolated server

  test('adds a list', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/'));                       // loaded, shell started, synced
    await page.clickText('button', /new list/i);
    await page.type(`E2E list ${tag()}`);
    await page.press('Enter');
    await server.waitForState((s) => s.data.lists.some((l) => l.name.startsWith('E2E list')));
    assert.deepEqual(page.consoleErrors(), []);
  });
});
```

Keep each file's hooks inside a `describe()`. In a single-process run, top-level hooks from every
file would all run at the start, and the second `launch()` would wait for the first browser's lock
forever.

**`cdp.mjs`:** `launch(opts)` gives a `Browser`.

- `browser.newPage({ isolated })`, `browser.close()`.
- A `Page` has:
  - `goto(url)` returns `{ status }`; also `reload()`.
  - `evaluate(fn | string, ...args)`.
  - `waitFor(selector | fn, timeout | { timeout, state: 'visible' | 'attached' | 'hidden', args, message })`.
  - `waitForText(text | RegExp)`.
  - `click(selector | fn)` and `clickText(roleOrSelector, text | RegExp, { exact })`. Both wait until
    the element is visible, enabled, still and not covered, then send real mouse events.
  - `exists(roleOrSelector, text)`.
  - `type(text)` uses `Input.insertText`; `{ keys: true }` presses each key instead.
  - `press('Enter' | 'Escape' | 'Tab' | 'Backspace' | 'ArrowDown' | 'Shift+Tab' | 'Control+a' | 'Meta+k' | 'Mod+Enter' …)`.
  - `screenshot(path, { fullPage })`.
  - `consoleErrors()`, `clearConsoleErrors()` and `consoleMessages()`.
  - `setViewport(w, h, mobile, { touch, deviceScaleFactor })`.
  - `emulateColorScheme('dark' | 'light')`, `emulateMedia({...})`.
  - `focused()`, `text()`, `hasText()`, `url()`, `bringToFront()`, `close()`.

  Roles understood by `clickText`: button, link, checkbox, radio, switch, textbox, searchbox,
  combobox, menuitem, option, tab, heading, dialog, menu, listbox, listitem, and more. Anything else
  is treated as a CSS selector.

**`server.mjs`:** `startServer()` gives a server with:

- `port`, `base`, `dataDir`, `url(path)`.
- `api(path, { method, body, headers, xEcosys })`, which sends `X-Ecosys: 1` by default.
- `state()`, `waitForState(pred, ms)`, `stop()`.

**`helpers.mjs`:**

- `useE2E()`, `openApp()`, `waitForApp()`, `waitForSync()`, `waitForSyncIdle()`, `settle()`.
- `withScreenshot()`, `missingFiles()`, `served()`, `browserToday()`.
- `tag()`: random consonants for unique titles that the natural-language parser won't read as
  dates, times or priorities.
- `PAGES`, `VIEWPORTS`, `SCHEMES`.
