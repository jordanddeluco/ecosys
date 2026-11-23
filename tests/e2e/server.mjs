// Start and stop an isolated ecosys server for the end-to-end tests.
//
// Each server gets its own random free port (never 4300, the live dev server) and a fresh temp
// data directory passed as ECOSYS_DATA_DIR, so a test never reads or changes the real data in
// .ecosys/. It runs the real entry point (server.mjs) in a child process via server-child.mjs, which
// exits on its own if this process goes away.
//
//   const server = await startServer();
//   server.url('tasks/')                         'http://127.0.0.1:PORT/tasks/'
//   server.secret                                its pairing secret (read from <data dir>/pair.json)
//   server.pairingLink('tasks/')                 'http://127.0.0.1:PORT/tasks/#pair=<secret>'
//   await server.api('api/ai')                   { status, json, text, headers }   (sends X-Ecosys: <secret>)
//   await server.state()                         the GET /api/state snapshot {rev, initialized, data, settings}
//   await server.waitForState((s) => s.data.tasks.find((t) => t.title === 'x'), 10000)
//   await server.stop()                          stops it and deletes its data directory
//
// Pairing. Every e2e server of one test process shares one secret, E2E_PAIR_SECRET (also passed, as
// ECOSYS_E2E_PAIR_SECRET, to servers a test starts itself through server-child.mjs, which writes it
// into a new data folder's pair.json): a page paired once (cdp.mjs pairs every tab it opens) stays
// paired when a test restarts its server, even with a new data folder. startServer({ env: {
// ECOSYS_E2E_PAIR_SECRET: '' } }) lets the server make its own, as a real first start does.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIVE_PORT = 4300;
const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'server-child.mjs');
const DATA_PREFIX = 'ecosys-e2e-data-';

/** The pairing secret of this test process's e2e servers (see above). */
export const E2E_PAIR_SECRET = /^[A-Za-z0-9_-]{43,200}$/.test(process.env.ECOSYS_E2E_PAIR_SECRET || '')
  ? process.env.ECOSYS_E2E_PAIR_SECRET
  : (process.env.ECOSYS_E2E_PAIR_SECRET = randomBytes(32).toString('base64url'));

/** The pairing secret in a data folder's pair.json, or null. */
export function readPairSecret(dataDir) {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, 'pair.json'), 'utf8')).secret;
    return typeof s === 'string' && s ? s : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free TCP port on 127.0.0.1 that is not the live dev server's. */
export async function freePort(exclude = [LIVE_PORT]) {
  for (let i = 0; i < 20; i++) {
    const srv = net.createServer();
    await new Promise((res, rej) => {
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', res);
    });
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    if (!exclude.includes(port)) return port;
  }
  throw new Error('e2e: could not find a free port');
}

/** Delete a directory this harness created (refuses anything else). */
export function removeTempDir(dir) {
  if (!dir) return;
  const abs = resolve(dir);
  if (!basename(abs).startsWith('ecosys-e2e-') || !abs.startsWith(resolve(tmpdir()) + sep)) {
    throw new Error(`e2e: refusing to delete ${abs} (not an e2e temp directory)`);
  }
  try {
    rmSync(abs, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch {
    // A file still locked on Windows: leave it to the OS temp cleanup rather than fail the run.
  }
}

/** Is ecosys answering on `port`? (/api/hello needs no pairing.) */
async function hello(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(1500) });
    if (res.status !== 200) return false;
    const body = await res.json().catch(() => null);
    return body?.app === 'ecosys';
  } catch {
    return false;
  }
}

/**
 * Start an isolated server. Options: `timeout` (ms to wait for it to answer), `env` (extra
 * environment variables for the server process).
 */
export async function startServer({ timeout = 20000, env = {} } = {}) {
  // Belt and braces: never start a server that might fall back to the real data directory.
  const entry = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  if (!entry.includes('ECOSYS_DATA_DIR') || !entry.includes('process.env.PORT')) {
    throw new Error('e2e: server.mjs no longer reads ECOSYS_DATA_DIR / PORT, so an isolated server cannot be guaranteed; refusing to start it');
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const dataDir = mkdtempSync(join(tmpdir(), DATA_PREFIX));
    try {
      return await boot({ port, dataDir, timeout, env });
    } catch (err) {
      lastErr = err;
      removeTempDir(dataDir);
      if (!err.portInUse) break; // another process grabbed the port between the check and the listen: try another
    }
  }
  throw lastErr;
}

async function boot({ port, dataDir, timeout, env }) {
  const childEnv = { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: dataDir, ECOSYS_E2E_PARENT: String(process.pid) };
  for (const k of ['ECOSYS_ALLOWED_HOSTS', 'ECOSYS_CLIENT', 'NODE_TEST_CONTEXT']) if (!(k in env)) delete childEnv[k];

  const child = spawn(process.execPath, [CHILD], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  const collect = (d) => {
    output = (output + d).slice(-30000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  let exitInfo = null;
  exited.then((e) => (exitInfo = e));

  const fail = async (message, extra = {}) => {
    if (!exitInfo) {
      try {
        child.kill();
      } catch {}
      await Promise.race([exited, sleep(3000)]);
    }
    return Object.assign(new Error(`${message}\n--- server output ---\n${output.trim() || '(none)'}`), extra);
  };

  const deadline = Date.now() + timeout;
  for (;;) {
    if (exitInfo) throw await fail(`e2e: the ecosys server exited during startup (code ${exitInfo.code})`, { portInUse: /already in use|EADDRINUSE/i.test(output) });
    if (await hello(port)) break;
    if (Date.now() > deadline) throw await fail(`e2e: the ecosys server did not answer on port ${port} within ${timeout} ms`);
    await sleep(100);
  }

  // Prove the server really uses the temp directory before any test writes through it.
  let info = null;
  for (let i = 0; i < 20 && !info; i++) {
    try {
      info = JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8'));
    } catch {
      await sleep(50);
    }
  }
  if (!info || info.port !== port) throw await fail(`e2e: the server on port ${port} did not write its server.json into the temp data directory ${dataDir}; refusing to use it`);
  // A browser gets the secret from the pairing link; the tests read it where the server keeps it.
  const secret = readPairSecret(dataDir);
  if (!secret) throw await fail(`e2e: the server on port ${port} wrote no pairing secret to ${join(dataDir, 'pair.json')}`);

  // Do not keep the test process alive just because of the child; stop() waits for it explicitly.
  child.unref();
  child.channel?.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();

  const base = `http://127.0.0.1:${port}/`;
  let stopping = null;

  const server = {
    port,
    base,
    dataDir,
    secret,
    pid: child.pid,
    url: (path = '') => base + String(path).replace(/^\/+/, ''),
    /** The link that pairs a browser and opens `path` (what ecosys prints, for the home page). */
    pairingLink: (path = '') => `${server.url(path)}#pair=${secret}`,
    output: () => output,
    get running() {
      return !exitInfo;
    },

    /**
     * Call the server as a paired browser: sends `X-Ecosys: <secret>`, or none with `xEcosys: false`,
     * or the given string (`xEcosys: '1'`, the header from before pairing). JSON-encodes `body`.
     * @returns {Promise<{status:number, headers:Headers, text:string, json:any}>}
     */
    async api(path, { method = 'GET', body, headers = {}, xEcosys = true, timeout: ms = 10000 } = {}) {
      const key = xEcosys === true ? secret : typeof xEcosys === 'string' ? xEcosys : null;
      const h = { ...(key ? { 'X-Ecosys': key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
      const res = await fetch(server.url(path), { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(ms) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, headers: res.headers, text, json };
    },

    /** GET /api/state → {rev, initialized, data:{tasks, lists, events, calendars, notes, folders}, settings}. */
    async state() {
      const r = await server.api('api/state');
      if (r.status !== 200 || !r.json) throw new Error(`e2e: GET /api/state answered ${r.status}: ${r.text.slice(0, 200)}`);
      return r.json;
    },

    /** Poll /api/state until `pred(state)` returns something truthy; resolves to that value. */
    async waitForState(pred, ms = 10000, what = 'the server state to match') {
      const until = Date.now() + ms;
      let last = null;
      let lastErr = null;
      for (;;) {
        try {
          last = await server.state();
          const v = pred(last);
          if (v) return v;
        } catch (err) {
          lastErr = err;
        }
        if (Date.now() > until) {
          const counts = last ? Object.entries(last.data || {}).map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : '?'}`).join(' ') : 'no state';
          throw new Error(`e2e: timed out after ${ms} ms waiting for ${what} (rev ${last?.rev ?? '?'}, ${counts})${lastErr ? `; last error: ${lastErr.message}` : ''}`);
        }
        await sleep(150);
      }
    },

    /** Stop the server (gracefully, then forcefully) and delete its temp data directory. */
    stop() {
      stopping ??= (async () => {
        if (!exitInfo) {
          child.ref();
          try {
            child.disconnect(); // server-child.mjs shuts server.mjs down cleanly when the channel closes
          } catch {}
          const done = await Promise.race([exited.then(() => true), sleep(6000).then(() => false)]);
          if (!done) {
            try {
              child.kill();
            } catch {}
            await Promise.race([exited, sleep(3000)]);
          }
        }
        removeTempDir(dataDir);
      })();
      return stopping;
    },
  };
  live.add(server);
  exited.then(() => live.delete(server));
  installExitHook();
  return server;
}

// If the test process exits without stopping a server (a crash, a forgotten after hook), kill it.
const live = new Set();
let hooked = false;
function installExitHook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const s of live) {
      try {
        process.kill(s.pid);
      } catch {}
    }
  });
}

export const isTempDataDir = (dir) => existsSync(dir) && basename(dir).startsWith(DATA_PREFIX);
