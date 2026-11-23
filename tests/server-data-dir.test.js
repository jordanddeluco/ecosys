// A data folder (ECOSYS_DATA_DIR, or --data for the stdio bridge) inside the folder ecosys serves is
// refused, because the static server would serve it like the apps, ai.json and its connection keys
// included, unless a folder on its way down has a name starting with a dot (never served, like the
// default .ecosys). server/core.mjs dataDirProblem; server.mjs and mcp/stdio-bridge.mjs exit before
// writing anything. The servers started here use a free port, never 4300, and a folder that is never
// created (that is what is checked).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as coreMod from '../server/core.mjs';

const { DEFAULT_DATA_DIR, ROOT: CORE_ROOT } = coreMod;
const dataDirProblem = (...a) => coreMod.dataDirProblem(...a);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
const tempDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const SERVED = /is inside the folder ecosys serves .*so your data and AI connection keys would be served with the apps\. Use a folder outside it, or one whose name starts with a dot/;

test('dataDirProblem: inside the served folder is refused unless a folder on the way starts with a dot', () => {
  const root = tempDir('ecosys-served-');
  const outside = tempDir('ecosys-outside-');
  const refused = (dir, opts = {}) => {
    const p = dataDirProblem(dir, { root, ...opts });
    assert.ok(p, `${dir} should be refused`);
    assert.match(p, SERVED);
    return p;
  };
  const allowed = (dir, opts = {}) => assert.equal(dataDirProblem(dir, { root, ...opts }), null, `${dir} should be allowed`);
  refused(root);
  refused(join(root, 'mydata'), {}); // need not exist
  refused(join(root, 'nested', 'deeper'));
  refused(join(root, 'tests', 'data'), {}); // tooling folders are not special: only outside or a dot-folder
  refused(join(root, '..', basename(root), 'x'));
  assert.match(refused(join(root, 'mydata'), { label: '--data' }), /^--data /);
  assert.match(refused(join(root, 'mydata')), /^ECOSYS_DATA_DIR /);
  allowed(join(root, '.data'));
  allowed(join(root, '.ecosys'));
  allowed(join(root, 'nested', '.hidden', 'data'));
  allowed(join(root, '..data')); // a name starting with a dot, not a parent folder
  allowed(outside);
  allowed(join(outside, 'mydata'));
  allowed(`${root}-sibling`); // same prefix, another folder
  allowed(dirname(root));
  if (process.platform === 'win32') refused(join(root.toUpperCase(), 'MyData'));
  // Relative paths start from the current folder.
  assert.match(dataDirProblem('.', { root: process.cwd() }), SERVED);
  assert.match(dataDirProblem('mydata', { root: process.cwd() }), SERVED);
  assert.equal(dataDirProblem('./.data', { root: process.cwd() }), null);
  // The real project: its default folder is fine, the project folder itself is not.
  assert.equal(CORE_ROOT, ROOT);
  assert.equal(dataDirProblem(DEFAULT_DATA_DIR), null);
  assert.match(dataDirProblem(ROOT), SERVED);
  assert.match(dataDirProblem(join(ROOT, 'mydata')), SERVED);
});

test('dataDirProblem: links and short names are followed to where the files really are', () => {
  const root = tempDir('ecosys-served-');
  const outside = tempDir('ecosys-outside-');
  const longRoot = realpathSync.native(root);
  // Short (8.3) and long spellings of the same folder (the same when the temp folder has no short name).
  assert.match(dataDirProblem(join(root, 'mydata'), { root: longRoot }), SERVED);
  assert.match(dataDirProblem(join(longRoot, 'mydata'), { root }), SERVED);
  // A link outside that leads into the served folder: the files would be served.
  mkdirSync(join(root, 'real'));
  const into = join(outside, 'into');
  symlinkSync(join(root, 'real'), into, 'junction');
  assert.match(dataDirProblem(into, { root }), SERVED);
  assert.match(dataDirProblem(join(into, 'not-yet'), { root }), SERVED);
  // A link in the served folder that leads out: the static server checks the real path, so it is not served.
  const elsewhere = join(outside, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(root, 'out'), 'junction');
  assert.equal(dataDirProblem(join(root, 'out'), { root }), null);
  // A link to a dot-folder in the served folder is fine too.
  mkdirSync(join(root, '.private'));
  symlinkSync(join(root, '.private'), join(outside, 'priv'), 'junction');
  assert.equal(dataDirProblem(join(outside, 'priv'), { root }), null);
});

test("dataDirProblem: the served folder reached through this machine's own share (\\\\localhost\\c$\\...) is the same folder", { skip: process.platform !== 'win32' && 'drive shares are a Windows thing' }, (t) => {
  const root = realpathSync.native(tempDir('ecosys-served-'));
  const B = '\\';
  // C:\Users\...\root → \\localhost\c$\Users\...\root (the drive's admin share).
  const share = (p, host = 'localhost') => `${B}${B}${host}${B}${p[0].toLowerCase()}$${p.slice(2)}`;
  if (!existsSync(share(root))) {
    t.skip('this machine does not share its drives (\\\\localhost\\c$ is not reachable)');
    return;
  }
  for (const host of ['localhost', '127.0.0.1', 'LOCALHOST']) assert.match(dataDirProblem(share(join(root, 'mydata'), host), { root }), SERVED, host);
  assert.match(dataDirProblem(`${B}${B}?${B}UNC${share(join(root, 'mydata')).slice(1)}`, { root }), SERVED, '\\\\?\\UNC\\ spelling');
  assert.match(dataDirProblem(share(root), { root }), SERVED, 'the root itself');
  assert.match(dataDirProblem(share(join(root, 'nested', 'deeper')), { root }), SERVED);
  assert.match(dataDirProblem(join(root, 'mydata'), { root: share(root) }), SERVED, 'the root given through the share');
  // A dot-folder is fine however it is reached, and so is a folder outside.
  assert.equal(dataDirProblem(share(join(root, '.data')), { root }), null);
  assert.equal(dataDirProblem(share(join(root, 'nested', '.hidden', 'data')), { root }), null);
  assert.equal(dataDirProblem(share(`${root}-sibling`), { root }), null);
  assert.equal(dataDirProblem(share(dirname(root)), { root }), null);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Run a script of the project with `env`; resolves {code, out, err}, or kills it after `ms` (code null). */
function run(args, env, ms = 15000) {
  const childEnv = { ...process.env, ...env };
  for (const k of ['NODE_TEST_CONTEXT', 'ECOSYS_ALLOWED_HOSTS', 'ECOSYS_CLIENT', 'ECOSYS_MCP_TOKEN']) delete childEnv[k];
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    p.stdin.end(); // a bridge that did start would stop at the end of its input
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    const timer = setTimeout(() => p.kill(), ms);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** A folder name inside the project that nothing uses; removed afterwards in any case. */
function insideName() {
  const dir = join(ROOT, `ecosys-data-dir-test-${randomBytes(6).toString('hex')}`);
  assert.ok(!existsSync(dir));
  return dir;
}

test('server.mjs refuses ECOSYS_DATA_DIR inside the served folder, before creating or serving anything', async () => {
  const dir = insideName();
  // On Windows also through this machine's own drive share, when it has one (\\localhost\c$\...).
  const B = '\\';
  const viaShare = process.platform === 'win32' && /^[A-Za-z]:\\/.test(ROOT) ? `${B}${B}localhost${B}${dir[0].toLowerCase()}$${dir.slice(2)}` : null;
  const spellings = [dir, ...(viaShare && existsSync(dirname(viaShare)) ? [viaShare] : [])];
  try {
    for (const given of spellings) {
      const r = await run(['server.mjs'], { PORT: String(await freePort()), HOST: '127.0.0.1', ECOSYS_DATA_DIR: given });
      assert.equal(r.code, 1, `${given}: exit code (stdout: ${r.out.slice(0, 300)})`);
      assert.match(r.err, SERVED);
      assert.ok(r.err.includes(given), r.err);
      assert.ok(!/ecosys is running/.test(r.out), 'it never started');
      assert.equal(existsSync(dir), false, `${given}: nothing was written there`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('the stdio bridge refuses --data (or ECOSYS_DATA_DIR) inside the served folder too', async () => {
  for (const how of ['--data', 'ECOSYS_DATA_DIR']) {
    const dir = insideName();
    const outsideDir = tempDir('ecosys-bridge-env-');
    try {
      // ECOSYS_DATA_DIR always points at a temp folder unless it is the one tested, so nothing can reach the real .ecosys.
      const r = how === '--data'
        ? await run(['mcp/stdio-bridge.mjs', '--data', dir, '--client', 'deadbeefdeadbeef'], { ECOSYS_DATA_DIR: outsideDir })
        : await run(['mcp/stdio-bridge.mjs', '--client', 'deadbeefdeadbeef'], { ECOSYS_DATA_DIR: dir });
      assert.equal(r.code, 1, `${how}: exit code (stderr: ${r.err.slice(0, 300)})`);
      assert.match(r.err, new RegExp(`ecosys: ${how} `));
      assert.match(r.err, SERVED);
      assert.equal(r.out, '', 'stdout carries only protocol messages');
      assert.equal(existsSync(dir), false, `${how}: nothing was written there`);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
