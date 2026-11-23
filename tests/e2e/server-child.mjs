// Child-process entry used by tests/e2e/server.mjs. It runs the real ecosys entry point
// (server.mjs, configured through PORT / HOST / ECOSYS_DATA_DIR) and shuts it down as soon as the
// test process that started it goes away: when the IPC channel closes, or when the parent's pid is
// gone. So an interrupted or crashed test run never leaves a server (or its temp data) behind.
//
// Pairing: with ECOSYS_E2E_PAIR_SECRET set (tests/e2e/server.mjs sets it for its whole process), a
// temp data folder without a pair.json gets one holding that secret before the server starts, so all
// e2e servers of one test run share it and a paired page stays paired across restarts and new data
// folders. Empty, or a folder that already has one: the server keeps or makes its own, as always.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const parentPid = Number(process.env.ECOSYS_E2E_PARENT) || process.ppid;

const secret = process.env.ECOSYS_E2E_PAIR_SECRET || '';
const dataDir = process.env.ECOSYS_DATA_DIR ? resolve(process.env.ECOSYS_DATA_DIR) : '';
// Only ever a test's own temp folder: never the real .ecosys folder, whatever the environment says.
if (/^[A-Za-z0-9_-]{43,200}$/.test(secret) && dataDir.startsWith(resolve(tmpdir()) + sep) && !existsSync(join(dataDir, 'pair.json'))) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'pair.json'), `${JSON.stringify({ v: 1, secret })}\n`, { mode: 0o600, flag: 'wx' });
}

let quitting = false;
function quit() {
  if (quitting) return;
  quitting = true;
  // server.mjs closes cleanly on SIGINT. Emit it without a real signal (Windows has none), and
  // give it a moment before exiting regardless.
  if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT');
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on('disconnect', quit);
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') quit();
  }
}, 1500).unref();

try {
  await import(pathToFileURL(join(ROOT, 'server.mjs')).href);
} catch (err) {
  console.error('ecosys e2e: server.mjs failed to load:', err?.stack || err);
  process.exit(1);
}
