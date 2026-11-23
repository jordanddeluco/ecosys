// A tiny Chrome DevTools Protocol client for the ecosys end-to-end tests. No dependencies: it
// launches the installed Chrome (headless=new, a throwaway --user-data-dir, --remote-debugging-port=0),
// reads the port from DevToolsActivePort and speaks CDP over Node's global WebSocket, with one
// flattened session per page.
//
//   const browser = await launch();                  // waits for the one-Chrome-at-a-time lock
//   const page = await browser.newPage();            // newPage({ isolated: true }) = fresh profile (own storage)
//   await page.setViewport(1440, 900, false);
//   await page.emulateColorScheme('dark');
//   await page.goto('http://127.0.0.1:PORT/tasks/');  // → { status }
//   await page.waitFor('[aria-label="Task name"]');  // CSS selector (visible), or a predicate function
//   await page.clickText('button', 'Add task');      // role or CSS selector + accessible name / visible text
//   await page.type('Buy milk tomorrow');            // Input.insertText into the focused element
//   await page.press('Enter');                       // also 'Escape', 'Shift+Tab', 'Control+K', 'Mod+Enter', ...
//   page.consoleErrors();                            // console.error, uncaught exceptions, failed loads, CSP
//   await page.screenshot('out.png');
//   await browser.close();
//
// Only one Chrome runs at a time across all processes using this module (node --test runs test
// files in parallel): launch() holds a named-pipe lock (a unix socket elsewhere) until close(),
// which the OS releases if the process dies. Set E2E_HEADFUL=1 to watch the browser, E2E_CHROME
// to use another Chrome binary.
//
// Pairing (ecosys's browser API answers only paired browsers): every tab is paired with the e2e
// servers' shared secret (ECOSYS_E2E_PAIR_SECRET, see server.mjs), as if the pairing link had been
// opened in it: its first page on a 127.0.0.1 / localhost / [::1] origin finds the secret stored,
// unless one is stored already. Only that first page: a test that then removes it gets an unpaired
// tab. newPage({ pair: false }) opens a tab that is never paired (a browser that never saw the link).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------ Chrome binary

export const DEFAULT_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CANDIDATES = [
  DEFAULT_CHROME,
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** Path of the Chrome executable to use, or null. */
export function findChrome() {
  const env = process.env.E2E_CHROME || process.env.CHROME_PATH;
  if (env) return existsSync(env) ? env : null;
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

const CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  // Background tabs must keep running timers (sync debounce, animations) at full speed.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,AutofillServerCommunication,InterestFeedContentSuggestions,PrivacySandboxSettings4',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-pings',
  '--password-store=basic',
  '--use-mock-keychain',
  '--force-color-profile=srgb',
  '--window-size=1440,900',
];

// ------------------------------------------------------------------------------------ one Chrome at a time

const LOCK_NAME = 'ecosys-e2e-chrome';
export const LOCK_PATH = process.platform === 'win32' ? `\\\\.\\pipe\\${LOCK_NAME}` : join(tmpdir(), `${LOCK_NAME}.sock`);

function tryListen(path) {
  return new Promise((done) => {
    const srv = net.createServer((sock) => sock.destroy());
    srv.once('error', (err) => done({ err }));
    srv.listen(path, () => done({ srv }));
  });
}

function canConnect(path) {
  return new Promise((done) => {
    const s = net.connect(path);
    s.once('connect', () => {
      s.destroy();
      done(true);
    });
    s.once('error', () => done(false));
  });
}

/**
 * Hold the machine-wide e2e Chrome lock. Resolves to an async release function. The lock is a
 * listening named pipe (Windows) or unix socket, so the OS frees it when the holder dies.
 */
export async function acquireChromeLock({ timeout = 20 * 60_000, onWait } = {}) {
  const t0 = Date.now();
  let told = false;
  for (;;) {
    const { srv, err } = await tryListen(LOCK_PATH);
    if (srv) {
      srv.unref();
      let released = null;
      return () => (released ??= new Promise((r) => srv.close(() => r())));
    }
    if (err.code !== 'EADDRINUSE') throw err;
    // A unix socket file left by a crashed holder: nobody answers on it, so remove it.
    if (process.platform !== 'win32' && !(await canConnect(LOCK_PATH))) {
      try {
        rmSync(LOCK_PATH, { force: true });
      } catch {}
      continue;
    }
    if (!told) {
      told = true;
      onWait?.();
    }
    if (Date.now() - t0 > timeout) throw new Error(`e2e: waited ${timeout} ms for another e2e Chrome to finish (lock ${LOCK_PATH})`);
    await sleep(150 + Math.floor(Math.random() * 150));
  }
}

// ------------------------------------------------------------------------------------ CDP connection

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message || 'CDP error'}${error?.data ? ` (${error.data})` : ''}`);
    this.code = error?.code;
  }
}

class Connection {
  static open(url, timeout) {
    return new Promise((done, fail) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        fail(new Error(`e2e: timed out connecting to Chrome DevTools at ${url}`));
      }, timeout);
      ws.addEventListener('open', () => (clearTimeout(timer), done(new Connection(ws))), { once: true });
      ws.addEventListener('error', (e) => (clearTimeout(timer), fail(new Error(`e2e: could not connect to Chrome DevTools at ${url}: ${e?.message || e?.error?.message || 'error'}`))), { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (e) => this.onMessage(e.data));
    ws.addEventListener('close', () => this.onClose());
  }

  send(method, params = {}, sessionId, timeout = 30_000) {
    if (this.closed) return Promise.reject(new Error(`e2e: Chrome connection is closed (${method})`));
    const id = ++this.nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`e2e: CDP ${method} got no answer within ${timeout} ms`));
      }, timeout);
      this.pending.set(id, { done, fail, timer, method });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        fail(err);
      }
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.fail(new CdpError(p.method, msg.error));
      else p.done(msg.result || {});
      return;
    }
    for (const fn of [...this.listeners]) {
      try {
        fn(msg);
      } catch (err) {
        console.error('e2e: CDP event handler failed', err);
      }
    }
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.fail(new Error(`e2e: Chrome connection closed while waiting for ${p.method}`));
    }
    this.pending.clear();
    for (const fn of [...this.listeners]) {
      try {
        fn({ method: '__closed', params: {} });
      } catch {}
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ------------------------------------------------------------------------------------ launch

const liveBrowsers = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  // Never leave a headless Chrome running when the test process ends without close().
  process.on('exit', () => {
    for (const b of liveBrowsers) b.kill();
  });
}

function removeProfile(dir) {
  if (!dir) return;
  const abs = resolve(dir);
  if (!basename(abs).startsWith('ecosys-e2e-chrome-') || !abs.startsWith(resolve(tmpdir()) + sep)) return;
  try {
    rmSync(abs, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  } catch {}
}

async function readActivePort(dir, proc, timeout, stderr) {
  const file = join(dir, 'DevToolsActivePort');
  const until = Date.now() + timeout;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`e2e: Chrome exited during startup (code ${proc.exitCode}).\n${stderr().slice(-2000)}`);
    try {
      const [port, path] = readFileSync(file, 'utf8').split(/\r?\n/);
      if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) return { port: Number(port), path: path.trim() };
    } catch {}
    if (Date.now() > until) throw new Error(`e2e: Chrome did not write DevToolsActivePort within ${timeout} ms.\n${stderr().slice(-2000)}`);
    await sleep(40);
  }
}

/**
 * Launch headless Chrome with a fresh temp profile.
 * Options: headless (default true unless E2E_HEADFUL=1), chromePath, args (extra flags), timeout,
 * lock (default true: wait for the one-Chrome-at-a-time lock), lockTimeout, onLockWait().
 */
export async function launch({ headless = process.env.E2E_HEADFUL !== '1', chromePath = findChrome(), args = [], timeout = 30_000, lock = true, lockTimeout, onLockWait } = {}) {
  if (!chromePath) throw new Error(`e2e: Chrome was not found (looked for ${CANDIDATES.join(', ')}); set E2E_CHROME to its path`);
  const release = lock ? await acquireChromeLock({ timeout: lockTimeout, onWait: onLockWait }) : async () => {};
  let proc = null;
  let userDataDir = null;
  try {
    userDataDir = mkdtempSync(join(tmpdir(), 'ecosys-e2e-chrome-'));
    const argv = [...(headless ? ['--headless=new'] : []), '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, ...CHROME_ARGS, ...args, 'about:blank'];
    proc = spawn(chromePath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let errText = '';
    proc.stderr.on('data', (d) => (errText = (errText + d).slice(-8000)));
    proc.stdout.on('data', () => {});
    proc.on('error', (err) => (errText += `\nspawn error: ${err.message}`));
    const { port, path } = await readActivePort(userDataDir, proc, timeout, () => errText);
    const conn = await Connection.open(`ws://127.0.0.1:${port}${path}`, timeout);
    proc.unref();
    proc.stderr.unref?.();
    proc.stdout.unref?.();
    const browser = new Browser({ proc, conn, userDataDir, release, stderr: () => errText });
    liveBrowsers.add(browser);
    hookExit();
    return browser;
  } catch (err) {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill();
      } catch {}
      await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
    }
    removeProfile(userDataDir);
    await release();
    throw err;
  }
}

export class Browser {
  #closing = null;

  constructor({ proc, conn, userDataDir, release, stderr }) {
    this.proc = proc;
    this.conn = conn;
    this.userDataDir = userDataDir;
    this.release = release;
    this.stderr = stderr;
    this.pages = new Set();
    this.exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', () => r())));
  }

  get pid() {
    return this.proc.pid;
  }

  get connected() {
    return !this.conn.closed;
  }

  version() {
    return this.conn.send('Browser.getVersion');
  }

  /**
   * Open a new tab. `isolated: true` puts it in a new browser context (its own cookies, storage
   * and cache, like a separate profile). `pair: false`: never pair it with the ecosys e2e servers
   * (see the top of this file).
   */
  async newPage({ isolated = false, pair = true } = {}) {
    let browserContextId;
    if (isolated) ({ browserContextId } = await this.conn.send('Target.createBrowserContext', { disposeOnDetach: true }));
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', ...(browserContextId ? { browserContextId } : {}) });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, { targetId, sessionId, browserContextId });
    try {
      await page.init();
      const secret = process.env.ECOSYS_E2E_PAIR_SECRET;
      if (pair && /^[A-Za-z0-9_-]{43,200}$/.test(secret || '')) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: pairingScript(secret) });
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
    this.pages.add(page);
    return page;
  }

  /** Kill Chrome right away (synchronous; used on process exit). */
  kill() {
    try {
      if (this.proc.exitCode === null) this.proc.kill();
    } catch {}
  }

  close() {
    this.#closing ??= (async () => {
      try {
        for (const p of [...this.pages]) await p.close().catch(() => {});
        if (this.proc.exitCode === null) {
          await this.conn.send('Browser.close', {}, undefined, 5000).catch(() => {});
          const gone = await Promise.race([this.exited.then(() => true), sleep(5000).then(() => false)]);
          if (!gone) {
            this.kill();
            await Promise.race([this.exited, sleep(3000)]);
          }
        }
      } finally {
        this.conn.close();
        liveBrowsers.delete(this);
        removeProfile(this.userDataDir);
        await this.release(); // always, or the next launch() (in this or another process) would wait for it
      }
    })();
    return this.#closing;
  }
}

/**
 * Runs before any script of every document in a tab: the tab's first page on a loopback http origin
 * stores the pairing secret, unless that origin has one already (sessionStorage remembers, per tab
 * and origin, that it was done, so a test can unpair the tab afterwards).
 */
function pairingScript(secret) {
  return `(() => {
  try {
    const h = location.hostname;
    if (location.protocol !== 'http:' || !(h === '127.0.0.1' || h === 'localhost' || h === '[::1]')) return;
    if (sessionStorage.getItem('ecosys-e2e:paired')) return;
    sessionStorage.setItem('ecosys-e2e:paired', '1');
    if (!localStorage.getItem('ecosys:v1:pair')) localStorage.setItem('ecosys:v1:pair', ${JSON.stringify(secret)});
  } catch {}
})();`;
}

// ------------------------------------------------------------------------------------ keyboard

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
const ALIASES = { esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', del: 'Delete', delete: 'Delete', space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', opt: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', insert: 'Insert' };
// US layout punctuation: [unshifted, shifted, code, keyCode]
const PUNCT = [
  ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187], ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221],
  ['\\', '|', 'Backslash', 220], [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188], ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
];
const SHIFTED_DIGITS = ')!@#$%^&*(';

/** Key description for one key name or character. */
function keyInfo(name) {
  if (name === ' ') return KEYS.Space;
  const alias = ALIASES[name.toLowerCase()];
  if (alias) return KEYS[alias];
  if (KEYS[name]) return KEYS[name];
  if (name.length === 1) {
    if (/[a-z]/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name, shifted: name !== name.toLowerCase() };
    if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, keyCode: 48 + Number(name), text: name };
    const sd = SHIFTED_DIGITS.indexOf(name);
    if (sd >= 0) return { key: name, code: `Digit${sd}`, keyCode: 48 + sd, text: name, shifted: true };
    for (const [plain, shifted, code, keyCode] of PUNCT) {
      if (name === plain) return { key: name, code, keyCode, text: name };
      if (name === shifted) return { key: name, code, keyCode, text: name, shifted: true };
    }
    return { key: name, code: '', keyCode: 0, text: name };
  }
  throw new Error(`e2e: unknown key "${name}"`);
}

/** 'Control+Shift+K' → { mods: ['Control', 'Shift'], key: 'K' }. 'Mod' = Meta on macOS, Control elsewhere. */
function parseCombo(combo) {
  const s = String(combo);
  const parts = s === '+' ? ['+'] : s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  const key = parts.pop();
  const mods = parts.map((m) => {
    const low = m.toLowerCase();
    if (low === 'mod') return process.platform === 'darwin' ? 'Meta' : 'Control';
    const k = ALIASES[low];
    if (!k || !MODIFIER_BITS[k]) throw new Error(`e2e: unknown modifier "${m}" in "${combo}"`);
    return k;
  });
  return { mods: [...new Set(mods)], key: key.toLowerCase() === 'mod' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : key };
}

// Editing shortcuts need explicit commands on macOS (Chrome maps them natively elsewhere).
const MAC_COMMANDS = { 'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo' };

// ------------------------------------------------------------------------------------ page helpers (run in the page)

/**
 * Runs inside the page (serialised with toString(), so it must not use anything from this module).
 * op.kind: 'query' (waitFor), 'locate' (click), 'focusInfo'.
 */
function pageHelpers(op, findFn) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const ROLES = {
    button: 'button, input[type=button], input[type=submit], input[type=reset], input[type=image], summary, [role=button]',
    link: 'a[href], area[href], [role=link]',
    checkbox: 'input[type=checkbox], [role=checkbox]',
    radio: 'input[type=radio], [role=radio]',
    switch: '[role=switch]',
    textbox: 'input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=password], input[type=number], textarea, [role=textbox], [role=searchbox], input[role=combobox], [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]',
    searchbox: 'input[type=search], [role=searchbox]',
    combobox: 'select, [role=combobox]',
    menuitem: '[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]',
    menuitemradio: '[role=menuitemradio]',
    menuitemcheckbox: '[role=menuitemcheckbox]',
    option: 'option, [role=option]',
    tab: '[role=tab]',
    tabpanel: '[role=tabpanel]',
    heading: 'h1, h2, h3, h4, h5, h6, [role=heading]',
    dialog: 'dialog, [role=dialog], [role=alertdialog]',
    alertdialog: '[role=alertdialog]',
    menu: '[role=menu], [role=menubar]',
    listbox: '[role=listbox]',
    list: 'ul, ol, [role=list]',
    listitem: 'li, [role=listitem]',
    navigation: 'nav, [role=navigation]',
    main: 'main, [role=main]',
    region: 'section[aria-label], section[aria-labelledby], [role=region]',
    status: '[role=status], output',
    alert: '[role=alert]',
    img: 'img, svg[role=img], [role=img]',
    article: 'article, [role=article]',
    row: 'tr, [role=row]',
    gridcell: 'td, [role=gridcell]',
    toolbar: '[role=toolbar]',
    group: 'fieldset, details, [role=group]',
    tooltip: '[role=tooltip]',
  };
  const ROLE_ALIASES = { menuitem: ['menuitem', 'menuitemradio', 'menuitemcheckbox'], textbox: ['textbox', 'searchbox', 'combobox'], dialog: ['dialog', 'alertdialog'], img: ['img', 'image'] };

  const isVisible = (el) => {
    if (!el || !el.isConnected || el.closest('[inert]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const textOf = (el) => norm(el.innerText ?? el.textContent);
  function accName(el) {
    const label = el.getAttribute('aria-label');
    if (label && norm(label)) return norm(label);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (norm(t)) return norm(t);
    }
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => l.innerText).join(' ');
      if (norm(t)) return norm(t);
    }
    if (el.matches('input[type=button], input[type=submit], input[type=reset]')) return norm(el.value);
    if (!el.matches('input, textarea, select')) {
      const t = textOf(el);
      if (t) return t;
    }
    return norm(el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('data-tip') || '');
  }
  function describe(el) {
    if (!el) return 'nothing';
    if (el === document.body) return 'body';
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const role = el.getAttribute('role');
    if (role) s += `[role=${role}]`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (cls.length) s += `.${cls.join('.')}`;
    const name = accName(el);
    if (name) s += ` "${name.slice(0, 70)}"`;
    return s;
  }
  function byRoleOrSelector(roleOrSelector) {
    const key = String(roleOrSelector).trim();
    const sel = ROLES[key.toLowerCase()];
    if (!sel) return [...document.querySelectorAll(key)];
    const allowed = ROLE_ALIASES[key.toLowerCase()] || [key.toLowerCase()];
    // An explicit role wins over the tag's implicit role (<button role="checkbox"> is a checkbox).
    return [...document.querySelectorAll(sel)].filter((el) => {
      const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
      return !r || allowed.includes(r);
    });
  }
  function scorer(m) {
    if (m && typeof m === 'object' && typeof m.re === 'string') {
      const re = new RegExp(m.re, m.flags);
      return (s) => (re.test(s) ? 2 : 0);
    }
    const want = lower(m);
    return (s) => {
      const l = lower(s);
      if (!want) return l ? 1 : 0;
      return l === want ? 3 : op.exact ? 0 : l.startsWith(want) ? 2 : l.includes(want) ? 1 : 0;
    };
  }
  const hitTest = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { hit: false, top: null, x, y };
    const top = document.elementFromPoint(x, y);
    return { hit: !!top && (top === el || el.contains(top)), top, x, y };
  };
  const disabled = (el) => el.matches(':disabled') || el.closest('[aria-disabled="true"]') !== null;

  function candidates() {
    if (op.find === 'css') return [...document.querySelectorAll(op.selector)].map((el) => ({ el, score: 1 }));
    if (op.find === 'fn') {
      const r = findFn(...(op.args || []));
      const list = r == null ? [] : r instanceof Element ? [r] : [...r];
      return list.filter((el) => el instanceof Element).map((el) => ({ el, score: 1 }));
    }
    // 'text': accessible name first, then visible text
    const score = scorer(op.text);
    const isRole = !!ROLES[String(op.roleOrSelector).trim().toLowerCase()];
    const out = [];
    for (const el of byRoleOrSelector(op.roleOrSelector)) {
      const s = Math.max(score(accName(el)), isRole ? 0 : score(textOf(el)));
      if (s) out.push({ el, score: s });
    }
    if (!isRole) {
      // For a plain selector, an element whose text matches only because a descendant matches is
      // less specific than that descendant.
      for (const c of out) c.depth = out.filter((o) => o !== c && c.el.contains(o.el) && o.score >= c.score).length;
      return out.filter((c) => !c.depth);
    }
    return out;
  }

  function pick() {
    const all = candidates();
    const vis = all.filter((c) => isVisible(c.el));
    if (!vis.length) return { found: all.length, el: null };
    for (const c of vis) c.hit = hitTest(c.el).hit;
    vis.sort((a, b) => b.score - a.score || Number(b.hit) - Number(a.hit));
    return { found: all.length, el: vis[0].el, visible: vis.length };
  }

  if (op.kind === 'query') {
    const els = [...document.querySelectorAll(op.selector)];
    if (op.state === 'hidden') return els.every((el) => !isVisible(el)) ? 'hidden' : null;
    const el = op.state === 'attached' ? els[0] : els.find(isVisible);
    return el ? describe(el) : null;
  }

  if (op.kind === 'locate') {
    const { el, found, visible } = pick();
    if (!el) return { ok: false, reason: found ? `${found} match(es), none visible` : 'no match' };
    if (!op.noScroll) {
      // Off screen, or clipped by a scroll container: bring it into view first.
      const r0 = el.getBoundingClientRect();
      const out = r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth;
      if (out || !hitTest(el).hit) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
    const r = el.getBoundingClientRect();
    const h = hitTest(el);
    return {
      ok: true,
      x: h.x,
      y: h.y,
      box: [Math.round(r.left * 10), Math.round(r.top * 10), Math.round(r.width * 10), Math.round(r.height * 10)].join(','),
      hit: h.hit,
      covering: h.hit ? null : describe(h.top),
      disabled: disabled(el),
      desc: describe(el),
      count: visible,
    };
  }

  if (op.kind === 'focusInfo') {
    const a = document.activeElement;
    return { desc: describe(a), editable: !!a && (a.isContentEditable || a.matches('input, textarea')), tag: a?.tagName?.toLowerCase() || null };
  }
  return null;
}

// ------------------------------------------------------------------------------------ page

const TRANSIENT = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|Cannot find default execution context|uniqueContextId not found|Promise was collected/i;

function serializeMatcher(m) {
  if (m instanceof RegExp) return { re: m.source, flags: m.flags.replace('g', '') };
  return String(m ?? '');
}

function describeTarget(t) {
  return typeof t === 'function' ? `function ${t.name || ''}`.trim() : JSON.stringify(t);
}

function exceptionText(d) {
  const e = d?.exception;
  const msg = e?.description?.split('\n')[0] || e?.value || d?.text || 'exception';
  const at = d?.url ? ` (${d.url}:${(d.lineNumber ?? 0) + 1})` : '';
  return `${d?.text && d.text !== 'Uncaught' && !msg.includes(d.text) ? `${d.text} ` : ''}${msg}${at}`;
}

function remoteArg(a) {
  if (!a) return '';
  if ('value' in a) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return a.description ?? a.unserializableValue ?? a.type;
}

export class Page {
  #off;
  #waiters = new Set();
  #lifecycle = new Map(); // loaderId → Set(event names)
  #media = new Map();

  constructor(browser, { targetId, sessionId, browserContextId }) {
    this.browser = browser;
    this.conn = browser.conn;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.browserContextId = browserContextId || null;
    this.errors = [];
    this.messages = [];
    this.dialogs = [];
    this.crashed = false;
    this.closed = false;
    this.viewport = null;
    this.#off = this.conn.on((msg) => {
      if (msg.method === '__closed') return this.#gone('the Chrome connection closed');
      if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId === sessionId) return this.#gone('the page was closed');
      if (msg.sessionId === sessionId) this.#onEvent(msg.method, msg.params || {});
    });
  }

  send(method, params = {}, timeout) {
    if (this.closed) return Promise.reject(new Error(`e2e: page is closed (${method})`));
    return this.conn.send(method, params, this.sessionId, timeout);
  }

  async init() {
    await Promise.all([this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable'), this.send('Page.setLifecycleEventsEnabled', { enabled: true })]);
    // Behave as a focused, visible tab even when another tab is in front.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.bringToFront();
  }

  #record(source, text, extra = {}) {
    const entry = { source, text: String(text).slice(0, 2000), ...extra, at: Date.now() };
    this.errors.push(entry);
    if (this.errors.length > 500) this.errors.shift();
  }

  #onEvent(method, p) {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const text = (p.args || []).map(remoteArg).join(' ');
        const frame = p.stackTrace?.callFrames?.[0];
        const url = frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined;
        this.messages.push({ type: p.type, text: text.slice(0, 2000), url });
        if (this.messages.length > 1000) this.messages.shift();
        if (p.type === 'error' || p.type === 'assert') this.#record(`console.${p.type}`, text, url ? { url } : {});
        break;
      }
      case 'Runtime.exceptionThrown':
        this.#record('exception', exceptionText(p.exceptionDetails), p.exceptionDetails?.url ? { url: p.exceptionDetails.url } : {});
        break;
      case 'Log.entryAdded': {
        const e = p.entry || {};
        this.messages.push({ type: `log.${e.level}`, text: String(e.text || '').slice(0, 2000), url: e.url });
        if (this.messages.length > 1000) this.messages.shift();
        if (e.level === 'error') this.#record(`log.${e.source || 'other'}`, e.text, e.url ? { url: e.url } : {});
        break;
      }
      case 'Page.lifecycleEvent': {
        if (!this.#lifecycle.has(p.loaderId)) {
          this.#lifecycle.set(p.loaderId, new Set());
          if (this.#lifecycle.size > 30) this.#lifecycle.delete(this.#lifecycle.keys().next().value);
        }
        this.#lifecycle.get(p.loaderId).add(p.name);
        break;
      }
      case 'Page.javascriptDialogOpening':
        // A native dialog would block the page forever; record it and dismiss it.
        this.dialogs.push({ type: p.type, message: p.message });
        this.send('Page.handleJavaScriptDialog', { accept: p.type === 'beforeunload' }).catch(() => {});
        break;
      case 'Inspector.targetCrashed':
        this.crashed = true;
        this.#record('crash', 'the page crashed (renderer process gone)');
        break;
    }
    for (const w of [...this.#waiters]) {
      if (w.method === method && w.pred(p)) {
        this.#waiters.delete(w);
        clearTimeout(w.timer);
        w.done(p);
      }
    }
  }

  #gone(why) {
    if (this.closed) return;
    this.closed = true;
    this.#off?.();
    for (const w of [...this.#waiters]) {
      clearTimeout(w.timer);
      w.fail(new Error(`e2e: ${why} while waiting for ${w.method}`));
    }
    this.#waiters.clear();
    this.browser.pages.delete(this);
  }

  /** Resolve with the params of the next `method` event matching `pred`. The promise has .cancel(). */
  waitForEvent(method, { timeout = 30_000, pred = () => true } = {}) {
    let w;
    const promise = new Promise((done, fail) => {
      w = { method, pred, done, fail, timer: null };
      w.timer = setTimeout(() => {
        this.#waiters.delete(w);
        fail(new Error(`e2e: no ${method} within ${timeout} ms`));
      }, timeout);
      this.#waiters.add(w);
    });
    promise.cancel = () => {
      clearTimeout(w.timer);
      this.#waiters.delete(w);
    };
    return promise;
  }

  async #waitLifecycle(loaderIdOrFn, name, timeout) {
    const until = Date.now() + timeout;
    for (;;) {
      for (const [id, names] of this.#lifecycle) {
        if ((typeof loaderIdOrFn === 'function' ? loaderIdOrFn(id) : id === loaderIdOrFn) && names.has(name)) return id;
      }
      if (this.closed) throw new Error('e2e: page closed while loading');
      if (this.crashed) throw new Error('e2e: page crashed while loading');
      if (Date.now() > until) throw new Error(`e2e: page did not reach "${name}" within ${timeout} ms`);
      await sleep(20);
    }
  }

  async #status() {
    return this.evaluate(() => performance.getEntriesByType('navigation')[0]?.responseStatus ?? null).catch(() => null);
  }

  /**
   * Navigate and wait for the load event (waitUntil: 'load' | 'DOMContentLoaded').
   * Resolves to { status } (the HTTP status of the document; null for same-document navigations).
   */
  async goto(url, { timeout = 30_000, waitUntil = 'load' } = {}) {
    const nav = await this.send('Page.navigate', { url }, timeout);
    if (nav.errorText) throw new Error(`e2e: navigation to ${url} failed: ${nav.errorText}`);
    if (!nav.loaderId) return { status: null, sameDocument: true };
    await this.#waitLifecycle(nav.loaderId, waitUntil, timeout);
    return { status: await this.#status() };
  }

  /** Reload the page and wait for it to load. */
  async reload({ timeout = 30_000, waitUntil = 'load', ignoreCache = false } = {}) {
    const before = new Set(this.#lifecycle.keys());
    await this.send('Page.reload', { ignoreCache }, timeout);
    await this.#waitLifecycle((id) => !before.has(id), waitUntil, timeout);
    return { status: await this.#status() };
  }

  /**
   * Evaluate a function (called with `args`, which must be JSON-serialisable) or an expression
   * string in the page. Awaits promises; returns the JSON value of the result.
   */
  async evaluate(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : String(fn);
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`e2e: evaluate failed: ${exceptionText(r.exceptionDetails)}`);
    return r.result?.value;
  }

  #helper(op, findFn = null) {
    return this.evaluate(`(${pageHelpers.toString()})(${JSON.stringify(op)}, ${findFn ? findFn.toString() : 'null'})`);
  }

  async #diagnostics() {
    try {
      return await this.evaluate(() => {
        const a = document.activeElement;
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        return `url ${location.href}; focus ${a ? a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.getAttribute('aria-label') ? ` "${a.getAttribute('aria-label')}"` : '') : 'none'}; text "${text.slice(0, 300)}${text.length > 300 ? '…' : ''}"`;
      });
    } catch (err) {
      return `(page not readable: ${err.message})`;
    }
  }

  async #timeout(what, ms, lastErr, message) {
    const errs = this.errors.length ? `; console errors: ${this.errors.slice(-5).map((e) => `[${e.source}] ${e.text}`).join(' | ')}` : '';
    return new Error(`e2e: ${message ? `${message}: ` : ''}timed out after ${ms} ms waiting for ${what}${lastErr ? ` (last error: ${lastErr.message})` : ''}\n  ${await this.#diagnostics()}${errs}`);
  }

  /**
   * Wait for a CSS selector to match a visible element (state 'visible', default), any element
   * ('attached') or no visible element ('hidden'); or for a function to return something truthy
   * (it is polled in the page with `args`; thrown errors count as "not yet"). Resolves to the
   * element description / the function's value.
   *   waitFor('[role=dialog]', 5000)   waitFor(() => window.ready, { timeout: 5000 })
   */
  async waitFor(target, timeoutOrOpts = {}, more = {}) {
    const opts = typeof timeoutOrOpts === 'number' ? { ...more, timeout: timeoutOrOpts } : { ...timeoutOrOpts };
    const { timeout = 10_000, interval = 50, state = 'visible', args = [], message } = opts;
    const until = Date.now() + timeout;
    let lastErr = null;
    for (;;) {
      try {
        const v = typeof target === 'function' ? await this.evaluate(target, ...args) : await this.#helper({ kind: 'query', selector: String(target), state });
        if (v) return v;
        lastErr = null;
      } catch (err) {
        if (this.closed) throw err;
        lastErr = err;
      }
      if (this.crashed) throw new Error('e2e: the page crashed');
      if (Date.now() > until) throw await this.#timeout(describeTarget(target), timeout, lastErr, message);
      await sleep(interval);
    }
  }

  /** Wait until the page's visible text contains `text` (string or RegExp). */
  waitForText(text, timeout = 10_000) {
    const m = serializeMatcher(text);
    return this.waitFor(
      (m) => {
        const t = document.body?.innerText || '';
        return typeof m === 'string' ? t.includes(m) : new RegExp(m.re, m.flags).test(t);
      },
      { timeout, args: [m], message: `text ${text instanceof RegExp ? text : JSON.stringify(text)} to appear` },
    );
  }

  /** Visible text of the page (document.body.innerText). */
  text() {
    return this.evaluate(() => document.body?.innerText || '');
  }

  async hasText(text) {
    const t = await this.text();
    return text instanceof RegExp ? text.test(t) : t.includes(text);
  }

  url() {
    return this.evaluate(() => location.href);
  }

  title() {
    return this.evaluate(() => document.title);
  }

  /** { desc, editable, tag } of document.activeElement. */
  focused() {
    return this.#helper({ kind: 'focusInfo' });
  }

  /**
   * Find the element (visible, enabled, not moving, not covered), scroll it into view and click
   * its centre with real mouse events. Resolves to a description of what was clicked.
   */
  async #clickLocated(op, findFn, { timeout = 10_000, force = false, button = 'left', clickCount = 1, modifiers = [] } = {}) {
    const until = Date.now() + timeout;
    let prev = null;
    let last = null;
    let lastErr = null;
    for (;;) {
      try {
        const r = await this.#helper({ ...op, kind: 'locate' }, findFn);
        last = r;
        lastErr = null;
        if (r?.ok && (force || (r.hit && !r.disabled && prev?.ok && prev.box === r.box))) {
          await this.#mouseClick(r.x, r.y, { button, clickCount, modifiers });
          return r.desc;
        }
        prev = r;
      } catch (err) {
        if (this.closed) throw err;
        lastErr = err;
        prev = null;
      }
      if (Date.now() > until) {
        const why = !last ? 'not found' : !last.ok ? last.reason : last.disabled ? `${last.desc} is disabled` : !last.hit ? `${last.desc} is covered by ${last.covering}` : `${last.desc} kept moving`;
        throw await this.#timeout(`a clickable ${op.find === 'text' ? `${op.roleOrSelector} named ${JSON.stringify(op.text)}` : op.find === 'css' ? JSON.stringify(op.selector) : 'element'} (${why})`, timeout, lastErr);
      }
      await sleep(50);
    }
  }

  async #mouseClick(x, y, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
    const mods = modifiers.reduce((m, k) => m | (MODIFIER_BITS[ALIASES[String(k).toLowerCase()] || k] || 0), 0);
    const buttons = { left: 1, right: 2, middle: 4 }[button] || 1;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods });
    for (let i = 1; i <= clickCount; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i, modifiers: mods });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers: mods });
    }
  }

  /**
   * Click the first visible element matching a CSS selector, or the element a function returns
   * (`click(() => document.querySelector('x').closest('li'))`; `opts.args` are passed to it).
   */
  click(selectorOrFn, opts = {}) {
    if (typeof selectorOrFn === 'function') return this.#clickLocated({ find: 'fn', args: opts.args || [] }, selectorOrFn, opts);
    return this.#clickLocated({ find: 'css', selector: String(selectorOrFn) }, null, opts);
  }

  /**
   * Click an element by role (button, link, checkbox, menuitem, tab, option, textbox, ...) or CSS
   * selector, and by accessible name / visible text: a string (exact match preferred, then prefix,
   * then substring, case-insensitive; `opts.exact` for exact only) or a RegExp.
   */
  clickText(roleOrSelector, text, opts = {}) {
    return this.#clickLocated({ find: 'text', roleOrSelector: String(roleOrSelector), text: serializeMatcher(text), exact: !!opts.exact }, null, opts);
  }

  /** True when a visible element with that role/selector and name exists (no waiting). */
  async exists(roleOrSelector, text) {
    const r = await this.#helper({ kind: 'locate', noScroll: true, find: text === undefined ? 'css' : 'text', selector: String(roleOrSelector), roleOrSelector: String(roleOrSelector), text: serializeMatcher(text) }).catch(() => null);
    return !!r?.ok;
  }

  /** Insert text into the focused element (Input.insertText: beforeinput + input, like an IME commit). */
  async type(text, { keys = false } = {}) {
    if (!keys) return void (await this.send('Input.insertText', { text: String(text) }));
    for (const ch of String(text)) await this.press(ch === '\n' ? 'Enter' : ch);
  }

  /**
   * Press a key or combination: 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'Home',
   * 'a', 'A', '?', 'Shift+Tab', 'Control+a', 'Meta+k', 'Mod+Enter' (Meta on macOS, Control elsewhere).
   */
  async press(combo, { repeat = 1 } = {}) {
    const { mods, key } = parseCombo(combo);
    const info = keyInfo(key);
    for (let n = 0; n < repeat; n++) {
      let bits = 0;
      for (const m of mods) {
        bits |= MODIFIER_BITS[m];
        const k = KEYS[m];
        await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: bits, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, location: k.location });
      }
      // A shifted character ('A', '?') is typed with Shift held, like a real keyboard.
      const eventBits = bits | (info.shifted ? MODIFIER_BITS.Shift : 0);
      const printable = info.text && !(eventBits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt));
      const upper = eventBits & MODIFIER_BITS.Shift && /^[a-z]$/.test(info.key);
      const text = printable ? (upper ? info.text.toUpperCase() : info.text) : undefined;
      const keyName = upper ? info.key.toUpperCase() : info.key;
      const commandKey = `${mods.join('+')}+${info.key.toLowerCase()}`;
      const commands = process.platform === 'darwin' && MAC_COMMANDS[commandKey] ? [MAC_COMMANDS[commandKey]] : undefined;
      const base = { modifiers: eventBits, key: keyName, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, location: info.location };
      await this.send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) });
      await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      for (const m of [...mods].reverse()) {
        bits &= ~MODIFIER_BITS[m];
        const k = KEYS[m];
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: bits, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, location: k.location });
      }
    }
  }

  /** Save a PNG of the viewport (or the whole page with fullPage). Resolves to the path. */
  async screenshot(path, { fullPage = false } = {}) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!fullPage, fromSurface: true }, 30_000);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  /** Errors seen on this page so far: [{ source, text, url?, at }]. */
  consoleErrors() {
    return this.errors.map((e) => ({ ...e }));
  }

  clearConsoleErrors() {
    this.errors.length = 0;
    this.messages.length = 0;
  }

  /** Every console / log message (any level) seen so far, for diagnostics. */
  consoleMessages() {
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * Emulate a viewport. `mobile` turns on the mobile viewport (meta viewport, overlay scrollbars)
   * and, unless opts.touch is false, touch input. opts.deviceScaleFactor defaults to 1.
   */
  async setViewport(width, height, mobile = false, { deviceScaleFactor = 1, touch } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: !!mobile, screenWidth: width, screenHeight: height });
    const t = touch ?? !!mobile;
    await this.send('Emulation.setTouchEmulationEnabled', t ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    this.viewport = { width, height, mobile: !!mobile, touch: t, deviceScaleFactor };
  }

  /** Emulate CSS media features, e.g. { 'prefers-color-scheme': 'dark', 'prefers-reduced-motion': 'reduce' } ('' resets one). */
  async emulateMedia(features) {
    for (const [name, value] of Object.entries(features)) {
      if (value) this.#media.set(name, String(value));
      else this.#media.delete(name);
    }
    await this.send('Emulation.setEmulatedMedia', { features: [...this.#media].map(([name, value]) => ({ name, value })) });
  }

  emulateColorScheme(scheme) {
    if (!['dark', 'light', ''].includes(scheme)) throw new Error(`e2e: colour scheme must be 'dark' or 'light', not ${JSON.stringify(scheme)}`);
    return this.emulateMedia({ 'prefers-color-scheme': scheme });
  }

  bringToFront() {
    return this.send('Page.bringToFront').catch(() => {});
  }

  async close() {
    if (this.closed) return;
    const { targetId, browserContextId } = this;
    this.#gone('the page was closed');
    await this.conn.send('Target.closeTarget', { targetId }, undefined, 5000).catch(() => {});
    if (browserContextId) await this.conn.send('Target.disposeBrowserContext', { browserContextId }, undefined, 5000).catch(() => {});
  }
}
