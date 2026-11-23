// The cross-process data lock and the file helpers in server/util.mjs: what a waiter may and may
// not treat as abandoned, release, re-entrancy, many processes at once (including the QA race: a
// lock file seen before its holder wrote its line), atomic writes that fail, and backup pruning.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLock, LockError, atomicWrite, pruneDir, describeError, redactKeys, sleepSync } from '../server/util.mjs';

const UTIL_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'util.mjs')).href;
const made = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ecosys-lock-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const nonce = 'abcdef0123456789';
const lineOf = (pid, at = Date.now()) => `${pid} ${at} ${nonce}\n`;
/** The pid of a process that has exited. */
async function deadPid() {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => p.on('exit', r));
  return p.pid;
}
const takesLock = (lock) => {
  let ran = false;
  lock(() => (ran = true));
  return ran;
};

test('a lock file that is empty or cut short is held (its holder is still writing it), unless it is old', () => {
  const dir = tempDir();
  const file = join(dir, 'lock');
  for (const content of ['', '123', '4321 17', `${process.ppid} 1764`, `${process.ppid} ${Date.now()} abc`, 'not a lock line\n']) {
    writeFileSync(file, content);
    const t0 = Date.now();
    assert.throws(() => createLock(file, { timeoutMs: 200 })(() => assert.fail('ran while another process held the lock')), (err) => err instanceof LockError && err.status === 503 && err.code === 'ELOCKED', JSON.stringify(content));
    assert.ok(Date.now() - t0 >= 200, 'it waited instead of breaking the lock');
    assert.equal(readFileSync(file, 'utf8'), content, `${JSON.stringify(content)}: a live lock was deleted`);
    // The same file from long ago: its creator died before writing the line.
    const old = new Date(Date.now() - 60000);
    utimesSync(file, old, old);
    assert.equal(takesLock(createLock(file, { timeoutMs: 2000 })), true, `${JSON.stringify(content)} (old) is abandoned`);
    assert.equal(existsSync(file), false, 'released');
  }
});

test('a complete line from a live process is held until it is older than staleMs', () => {
  const file = join(tempDir(), 'lock');
  const live = lineOf(process.ppid);
  writeFileSync(file, live);
  assert.throws(() => createLock(file, { timeoutMs: 200 })(() => {}), LockError);
  assert.equal(readFileSync(file, 'utf8'), live, 'still there');
  writeFileSync(file, lineOf(process.ppid, Date.now() - 20000)); // a hung holder, or a reused pid
  assert.equal(takesLock(createLock(file, { timeoutMs: 2000 })), true);
  assert.equal(existsSync(file), false);
});

test('a lock left by a process that is gone, or by an earlier process with our pid, is broken at once', async () => {
  const file = join(tempDir(), 'lock');
  const gone = await deadPid();
  for (const content of [lineOf(gone), `${gone} ${Date.now()}` /* ecosys 0.3.0 */, lineOf(process.pid)]) {
    writeFileSync(file, content);
    const t0 = Date.now();
    assert.equal(takesLock(createLock(file, { timeoutMs: 5000 })), true, JSON.stringify(content));
    assert.ok(Date.now() - t0 < 2000, `${JSON.stringify(content)} took ${Date.now() - t0} ms`);
    assert.equal(existsSync(file), false);
  }
  assert.equal(existsSync(`${file}.break`), false, 'the break guard is cleaned up');
});

test('release never deletes a lock that is no longer ours (taken over after we held it too long)', () => {
  const file = join(tempDir(), 'lock');
  const theirs = lineOf(process.ppid);
  createLock(file, { staleMs: 60 })(() => {
    sleepSync(40); // past staleMs / 2: the release reads the file back first
    writeFileSync(file, theirs); // another process judged ours abandoned and took it
  });
  assert.equal(readFileSync(file, 'utf8'), theirs, 'the other process keeps its lock');
  rmSync(file);
  // A normal short hold is simply released.
  createLock(file)(() => assert.match(readFileSync(file, 'utf8'), new RegExp(`^${process.pid} \\d{13} [0-9a-f]{16}\\n$`)));
  assert.equal(existsSync(file), false);
});

test('it is re-entrant (also across createLock() calls for the same file) and released after an error', () => {
  const file = join(tempDir(), 'lock');
  const a = createLock(file, { timeoutMs: 500 });
  const b = createLock(file, { timeoutMs: 500 });
  const out = a(() => b(() => a(() => (assert.ok(existsSync(file)), 'inner'))));
  assert.equal(out, 'inner');
  assert.equal(existsSync(file), false);
  assert.throws(() => a(() => b(() => { throw new Error('boom'); })), /boom/);
  assert.equal(existsSync(file), false, 'released after the error');
  assert.equal(takesLock(b), true);
});

test('a lock it cannot read (a folder in its place) is never broken: the wait ends in a LockError', () => {
  const file = join(tempDir(), 'lock');
  mkdirSync(file);
  assert.throws(() => createLock(file, { timeoutMs: 200 })(() => {}), LockError);
  assert.ok(existsSync(file));
});

async function runWorkers(dir, { workers, n, opts }) {
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [,, utilUrl, dir, n, opts] = process.argv;',
    'const { createLock } = await import(utilUrl);',
    "const lock = createLock(join(dir, 'lock'), JSON.parse(opts));",
    "const counter = join(dir, 'counter.txt');",
    'const errors = {};',
    'let ok = 0;',
    'for (let i = 0; i < Number(n); i++) {',
    "  try { lock(() => writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1))); ok++; }",
    '  catch (e) { errors[e.code || e.message] = (errors[e.code || e.message] || 0) + 1; }',
    '}',
    'process.stdout.write(JSON.stringify({ ok, errors }));',
  ].join('\n'));
  writeFileSync(join(dir, 'counter.txt'), '0');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const results = await Promise.all(
    Array.from({ length: workers }, () => new Promise((resolveRun, reject) => {
      const p = spawn(process.execPath, [worker, UTIL_URL, dir, String(n), JSON.stringify(opts)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.on('error', reject);
      p.on('close', () => {
        try {
          resolveRun(JSON.parse(out));
        } catch {
          reject(new Error(`lock worker failed: ${err || out}`));
        }
      });
    })),
  );
  return {
    ok: results.reduce((a, r) => a + r.ok, 0),
    counter: Number(readFileSync(join(dir, 'counter.txt'), 'utf8')),
    errors: results.map((r) => r.errors).filter((e) => Object.keys(e).length),
    left: readdirSync(dir).filter((x) => x !== 'counter.txt' && x !== 'worker.mjs'),
  };
}

test('several processes never hold it at once and never fail, even while a new lock file is still empty', async () => {
  // QA reproduced lost updates by widening the moment between creating the lock file and writing
  // its line (the old lock read '' as pid 0, "dead", and deleted a live lock): 401 of 600 lost.
  for (const opts of [{}, { pauseAfterCreateMs: 2 }]) {
    const dir = tempDir();
    const r = await runWorkers(dir, { workers: 3, n: opts.pauseAfterCreateMs ? 60 : 150, opts });
    assert.equal(r.counter, r.ok, `${JSON.stringify(opts)}: mutual exclusion broke, ${r.ok - r.counter} increments were lost`);
    assert.deepEqual(r.errors, [], `${JSON.stringify(opts)}: taking the lock threw instead of waiting`);
    assert.equal(r.ok, 3 * (opts.pauseAfterCreateMs ? 60 : 150));
    assert.deepEqual(r.left, [], 'no lock, guard or temp files are left behind');
  }
});

// ------------------------------------------------------------------ atomic writes, pruning, logging

test('a failed atomic write throws and leaves no temp file behind', () => {
  const dir = tempDir();
  const target = join(dir, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'inside.txt'), 'x'); // a folder is in the way: the rename (and the copy) must fail
  assert.throws(() => atomicWrite(target, 'data'));
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('a read-only target (Windows refuses to replace it) throws, stays unchanged and leaves no temp file', { skip: process.platform !== 'win32' && 'only Windows refuses to rename over a read-only file' }, () => {
  const dir = tempDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, '{"keep":true}');
  chmodSync(file, 0o444);
  try {
    assert.throws(() => atomicWrite(file, '{}'), (err) => ['EPERM', 'EACCES', 'EBUSY'].includes(err.code));
  } finally {
    chmodSync(file, 0o666);
  }
  assert.equal(readFileSync(file, 'utf8'), '{"keep":true}');
  assert.deepEqual(readdirSync(dir), ['config.json']);
});

test('pruneDir with a pattern removes only the oldest matching files', () => {
  const dir = tempDir();
  const ours = ['2026-01-01T00-00-00-001Z', '2026-01-02T00-00-00-001Z', '2026-01-03T00-00-00-001Z', '2026-01-04T00-00-00-001Z'].map((s) => `c.json.${s}.bak`);
  const theirs = ['c.json.2020-01-01.bak', 'c.json.my.bak', 'c.json.orig', 'other.bak'];
  for (const n of [...ours, ...theirs]) writeFileSync(join(dir, n), n);
  pruneDir(dir, /^c\.json\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.bak$/, 2);
  assert.deepEqual(readdirSync(dir).sort(), [...ours.slice(2), ...theirs].sort());
  pruneDir(dir, 'c.json.', 1, '.bak'); // the prefix form still works
  assert.deepEqual(readdirSync(dir).sort(), ['c.json.orig', 'c.json.my.bak', 'other.bak'].sort());
});

test('errors are logged as text with key-shaped values hidden, never as objects', () => {
  const key = 'Q'.repeat(10) + 'w-e_r'.repeat(5) + 'Zz9'.repeat(3); // 44 base64url characters
  const err = Object.assign(new TypeError(`Invalid URL /s/${key}/mcp`), { code: 'ERR_INVALID_URL', input: `/\\%/s/${key}/mcp` });
  const text = describeError(err);
  assert.ok(!text.includes(key), text);
  assert.match(text, /^\[ERR_INVALID_URL\] TypeError: Invalid URL \/s\/\[redacted\]\/mcp/);
  assert.equal(redactKeys(`a ${key} b`), 'a [redacted] b');
  assert.equal(redactKeys('short-ids-stay 0123456789abcdef'), 'short-ids-stay 0123456789abcdef');
});
