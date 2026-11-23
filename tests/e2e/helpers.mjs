// Shared helpers for the ecosys end-to-end tests: the page matrix, a before/after fixture that
// starts an isolated server and one headless Chrome tab, app-readiness waits, failure screenshots.
// Pairing: every tab is paired with the isolated servers already (cdp.mjs stores the e2e secret on
// its first page, see server.mjs), so openApp() and plain goto() reach a synced app; a test of an
// unpaired browser opens its tab with browser.newPage({ pair: false }).
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after } from 'node:test';
import { launch } from './cdp.mjs';
import { startServer } from './server.mjs';

/** Screenshots go here (outside the repo, so test runs leave the working tree alone). */
export const ARTIFACTS = process.env.E2E_ARTIFACTS || join(tmpdir(), 'ecosys-e2e-artifacts');

export function artifactPath(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  return join(ARTIFACTS, String(name).replace(/[^a-z0-9._-]+/gi, '-'));
}

export const PAGES = [
  { id: 'home', path: '' },
  { id: 'tasks', path: 'tasks/' },
  { id: 'schedule', path: 'schedule/' },
  { id: 'notes', path: 'notes/', optional: true }, // skipped while the notes app is not built
];
export const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900, mobile: false },
  { id: 'phone', width: 390, height: 844, mobile: true },
];
export const SCHEMES = ['light', 'dark'];

/**
 * A random tag for unique titles. Consonants only: no digits or words the natural-language
 * parser could read as a date, time, duration or priority.
 */
export function tag(n = 6) {
  const c = 'bcdfghjklmnpqrstvwxz';
  let s = '';
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Register before/after hooks for a test file: one headless Chrome tab (waiting for any other
 * e2e Chrome to finish first) and one isolated ecosys server. The returned object's `browser`,
 * `page` and `server` are set once the before hook has run.
 */
export function useE2E({ width = 1440, height = 900, mobile = false, scheme = 'light' } = {}) {
  const ctx = { server: null, browser: null, page: null };
  before(async () => {
    ctx.browser = await launch();
    ctx.server = await startServer();
    ctx.page = await ctx.browser.newPage();
    await ctx.page.setViewport(width, height, mobile);
    await ctx.page.emulateColorScheme(scheme);
  });
  after(async () => {
    await ctx.browser?.close().catch(() => {});
    await ctx.server?.stop().catch(() => {});
  });
  return ctx;
}

/** Wait until the ecosys shell has started on the page: sync.js loaded (window.ecosysSync) and text rendered. */
export function waitForApp(page, timeout = 15000) {
  return page.waitFor(() => !!window.ecosysSync && document.readyState === 'complete' && (document.body?.innerText || '').trim().length > 0, {
    timeout,
    message: 'the app to start (window.ecosysSync set by the shell, some text rendered)',
  });
}

/** Wait until the page is synced with the server. */
export function waitForSync(page, timeout = 15000) {
  return page.waitFor(() => window.ecosysSync?.online === true, { timeout, message: 'sync to come online (window.ecosysSync.online)' });
}

/** Wait until the page has nothing left to send to the server. */
export function waitForSyncIdle(page, timeout = 15000) {
  return page.waitFor(() => window.ecosysSync?.online === true && !window.ecosysSync.pending, { timeout, message: 'sync to finish sending (window.ecosysSync.pending = 0)' });
}

/** Let lazy imports, first SSE events and animations run: two frames, then `ms`. */
export async function settle(page, ms = 400) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await sleep(ms);
}

/**
 * Load an ecosys page and wait until it is usable: loaded, shell started, synced (unless
 * `sync: false`), settled. Returns { status }; a non-200 page is returned without waiting.
 */
export async function openApp(page, url, { sync = true, timeout = 15000, settleMs = 400 } = {}) {
  const nav = await page.goto(url, { timeout });
  if (nav.status !== 200) return nav;
  await waitForApp(page, timeout);
  if (sync) await waitForSync(page, timeout);
  if (settleMs) await settle(page, settleMs);
  return nav;
}

/** Today's date in the browser's time zone ('YYYY-MM-DD'). */
export function browserToday(page) {
  return page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

/** One line per console error, for assertion messages. */
export function formatErrors(errors) {
  return errors.map((e) => `  - [${e.source}] ${e.text}${e.url && !e.text.includes(e.url) ? ` (${e.url})` : ''}`).join('\n');
}

/**
 * Run `fn`; if it throws, save a screenshot and add its path (and recent console errors) to the
 * error. When it passes, a failure screenshot left by an earlier run is removed.
 */
export async function withScreenshot(page, name, fn) {
  try {
    const out = await fn();
    rmSync(artifactPath(`${name}-failure.png`), { force: true });
    return out;
  } catch (err) {
    try {
      const file = await page.screenshot(artifactPath(`${name}-failure.png`));
      err.message += `\n  screenshot: ${file}`;
    } catch {}
    const errs = page.consoleErrors?.() || [];
    if (errs.length && !err.message.includes('console errors')) err.message += `\n  console errors so far:\n${formatErrors(errs.slice(-8))}`;
    throw err;
  }
}

/** Is a path served by the isolated server (e.g. a module or app that may not be built yet)? */
export async function served(server, path) {
  try {
    const r = await fetch(server.url(path), { signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    return r.status === 200;
  } catch {
    return false;
  }
}

const IMPORT_RES = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"\s]+)['"]/g, // import x from './a.js'
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"\s]+)['"]\s*\)/g, // import('./a.js')
  /^\s*import\s*['"](\.{1,2}\/[^'"\s]+)['"]/gm, // import './a.js'
];

/**
 * Files a page needs that the server does not serve: its <script src> / stylesheet links and,
 * recursively, the relative static and dynamic imports of its scripts (found by a simple scan,
 * so a commented-out import counts too). Resolves to [{ path, from }] (empty when complete).
 */
export async function missingFiles(server, pagePath) {
  const pageUrl = server.url(pagePath);
  const get = (u) => fetch(u, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  const res = await get(pageUrl);
  if (res?.status !== 200) return [{ path: new URL(pageUrl).pathname, from: 'the page itself' }];
  const html = await res.text();
  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/\brel\s*=\s*["']?(?:stylesheet|modulepreload)\b/i.test(m[0])) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
      if (href) refs.push(href);
    }
  }
  const origin = new URL(pageUrl).origin;
  const queue = refs.map((r) => ({ url: new URL(r, pageUrl), from: new URL(pageUrl).pathname })).filter((x) => x.url.origin === origin);
  const seen = new Set();
  const missing = [];
  while (queue.length && seen.size < 400) {
    const { url, from } = queue.shift();
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const r = await get(url);
    if (r?.status !== 200) {
      await r?.arrayBuffer().catch(() => {});
      missing.push({ path: url.pathname, from });
      continue;
    }
    if (!/\.m?js$/i.test(url.pathname)) {
      await r.arrayBuffer().catch(() => {});
      continue;
    }
    const src = await r.text();
    for (const re of IMPORT_RES) for (const m of src.matchAll(re)) queue.push({ url: new URL(m[1], url), from: url.pathname });
  }
  return missing;
}

/** "/shared/ai.js (imported by /shared/shell.js), ..." */
export const formatMissing = (list) => list.map((m) => `${m.path} (referenced by ${m.from})`).join(', ');
