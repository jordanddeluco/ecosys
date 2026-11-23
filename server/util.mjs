// Small helpers shared by the ecosys server, the data store and the stdio bridge.
// Everything here is synchronous on purpose: writes must be finished before a request returns,
// because a client (e.g. Claude Code on Windows) may kill the process right after the response.
import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, copyFileSync, unlinkSync,
  readFileSync, readSync, statSync, fstatSync, mkdirSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ID_RE = /^[a-z0-9_-]{1,40}$/i;
export const isId = (s) => typeof s === 'string' && ID_RE.test(s);

/** 16-char lowercase hex id, same shape as `uid()` in shared/store.js. */
export const uid = () => randomBytes(8).toString('hex');

/** 32 random bytes, base64url (43 chars). */
export const randomToken = () => randomBytes(32).toString('base64url');

const digest = (s) => createHash('sha256').update(String(s)).digest();
/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(digest(a), digest(b)) && a.length === b.length;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export const sleepSync = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** JSON.parse that drops prototype-polluting keys at every depth. */
export const safeParse = (text) => JSON.parse(text, (k, v) => (PROTO_KEYS.has(k) ? undefined : v));

// A key named like a prototype member, or any \u escape of an ASCII character (a key can spell one
// that way). Text without either can't hold such a key, so it is parsed as it is.
const RISKY_JSON = /"(?:__proto__|constructor|prototype)"\s*:|\\u00[0-7]/;
/**
 * safeParse for ecosys's own files and copies (ai.json, undo data, validated records): the same
 * result, but the reviver, which costs several times the parse itself on a large file, only runs on
 * text that may hold such a key. For untrusted input (request bodies, stdin) use safeParse.
 */
export const parseJson = (text) => (RISKY_JSON.test(text) ? safeParse(text) : JSON.parse(text));

/**
 * Create a folder (and parents) that only this user can open: mode 0700 on macOS and Linux; on
 * Windows, where the mode is ignored, the new folder gets a private ACL (makeDirPrivate). An existing
 * folder is left as it is (secureDataDir checks the data folder at every start).
 */
export function ensureDir(dir) {
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (made !== undefined && process.platform === 'win32' && makeDirPrivate(dir).ok) privateDirs.add(dirKey(dir));
}

// ---------------------------------------------------------------- a private folder on Windows
//
// A new folder on Windows gets whatever its parent passes down: under a folder like C:\projects that
// is "Authenticated Users: Modify", so every other account on the computer could read the AI keys
// and all data. The data folder is made private instead: nothing inherited, full control for this
// user, SYSTEM and Administrators only; the files and folders in it inherit exactly that. The tools
// are run from System32 by full path, without a shell (a whoami.exe earlier on PATH, such as Git's,
// is never used).

const system32 = () => join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
// Each normally takes some 30 ms; a stuck one (a share that does not answer) must not hold up start-up.
const runTool = (exe, args) =>
  execFileSync(join(system32(), exe), args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
const dirKey = (dir) => resolve(dir).toLowerCase();
/** Folders this process made private (or found private) already: secureDataDir doesn't do them again. */
const privateDirs = new Set();
let userSid; // undefined: not looked up yet; null: could not be found

/** This user's account SID ("S-1-5-21-…"), or null. Asked once per process. */
function currentUserSid() {
  if (userSid === undefined) {
    try {
      userSid = /"(S-1-\d+(?:-\d+)+)"/.exec(runTool('whoami.exe', ['/user', '/fo', 'csv', '/nh']))?.[1] || null;
    } catch {
      userSid = null;
    }
  }
  return userSid;
}

/** The first line icacls (or whoami) printed about a failure, else the error's code. */
function toolProblem(err) {
  const said = `${err?.stderr || ''}\n${err?.stdout || ''}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return cleanText(said || err?.code || 'failed').slice(0, 200);
}

/**
 * Give `dir` a private ACL on Windows (see above). Elsewhere nothing to do: the folder is 0700.
 * Never throws: {ok:true} or {ok:false, error}.
 */
export function makeDirPrivate(dir) {
  if (process.platform !== 'win32') return { ok: true };
  const sid = currentUserSid();
  if (!sid) return { ok: false, error: "this user's account id could not be read (whoami /user)" };
  try {
    runTool('icacls.exe', [resolve(dir), '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toolProblem(err) };
  }
}

/** Groups standing for every account (or every person) on the computer, as SDDL writes them. */
const BROAD_SIDS = { WD: 'Everyone', 'S-1-1-0': 'Everyone', AU: 'Authenticated Users', 'S-1-5-11': 'Authenticated Users', BU: 'Users', 'S-1-5-32-545': 'Users' };
/** The entries of an SDDL ACL: (type;flags;rights;object;inherited object;account[;condition]). */
const ACE_RE = /\(([A-Z]+);([^;()]*);([^;()]*);[^;()]*;[^;()]*;([^;()]+)/g;

/** `dir`'s ACL as SDDL ("D:PAI(A;OICI;FA;;;SY)…"; icacls /save, which reads only the folder itself), or null. */
function readAcl(dir) {
  const file = join(tmpdir(), `ecosys-acl-${process.pid}-${randomBytes(4).toString('hex')}.txt`);
  try {
    runTool('icacls.exe', [resolve(dir), '/save', file]);
    // The first line is the folder's name; the ACL follows.
    return readFileSync(file).toString('utf16le').split(/\r?\n/).slice(1).join('');
  } catch {
    return null;
  } finally {
    removeFile(file);
  }
}

/**
 * True when ACL `sddl` is the one makeDirPrivate gives: nothing inherited (a protected DACL), full
 * control for user `sid` passed on to everything inside, and no other account allowed in than that
 * user, SYSTEM and Administrators. (A deny entry only takes access away.)
 */
function isPrivateAcl(sddl, sid) {
  const flags = /D:([A-Z_]*)/.exec(sddl)?.[1];
  if (!sid || !flags?.includes('P')) return false;
  const allowed = new Set([sid, 'SY', 'S-1-5-18', 'BA', 'S-1-5-32-544']);
  let mine = false;
  for (const [, type, aceFlags, rights, who] of sddl.matchAll(ACE_RE)) {
    if (type === 'D' || type === 'OD') continue;
    if (!allowed.has(who)) return false;
    if (who === sid && type === 'A' && aceFlags.includes('OI') && aceFlags.includes('CI') && rights === 'FA') mine = true;
  }
  return mine;
}

/**
 * Which of Everyone, Authenticated Users and Users an "allow" entry of `dir`'s ACL still lets in
 * (Windows; [] elsewhere), or null when the ACL can't be read. icacls /save writes the ACL as SDDL,
 * which names these groups the same in every language.
 */
export function broadAccess(dir) {
  if (process.platform !== 'win32') return [];
  const sddl = readAcl(dir);
  if (sddl === null) return null;
  const found = new Set();
  for (const [, type, , , who] of sddl.matchAll(ACE_RE)) if (['A', 'OA', 'XA'].includes(type) && Object.hasOwn(BROAD_SIDS, who)) found.add(BROAD_SIDS[who]);
  return [...found];
}

/**
 * The data folder, once at every start: on Windows make it private (makeDirPrivate), then warn when
 * Everyone, Authenticated Users or Users can still open it (an entry set on the folder itself).
 * A folder that is private already (every start after the first) is only read: setting its ACL again
 * would rewrite the ACL of every file inside, which takes about a second for a few thousand files.
 * Never throws and never stops ecosys from starting: logs one warning instead. True when private.
 */
export function secureDataDir(dir, log = console) {
  if (process.platform !== 'win32') return true;
  const key = dirKey(dir);
  if (privateDirs.has(key)) return true;
  const where = `the data folder ${resolve(dir)}`;
  const sid = currentUserSid();
  const acl = sid ? readAcl(dir) : null;
  if (acl !== null && isPrivateAcl(acl, sid)) {
    privateDirs.add(key);
    return true;
  }
  const made = makeDirPrivate(dir);
  if (!made.ok) {
    log.warn?.(`ecosys: could not make ${where} private to this user (${made.error}). Other accounts on this computer may be able to read it; check its Properties, Security.`);
    return false;
  }
  const broad = broadAccess(dir);
  if (broad?.length) {
    log.warn?.(`ecosys: ${broad.join(', ')} can still open ${where}, so other accounts on this computer may read your data and AI keys. Remove ${broad.length === 1 ? 'that entry' : 'those entries'} in the folder's Properties, Security.`);
    return false;
  }
  privateDirs.add(key);
  return true;
}

/** Errors Windows gives for a moment while another process (or an antivirus scanner) has a file open. */
const WIN_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Read and parse a JSON file. Returns `fallback` when the file is missing. Throws on invalid JSON
 * (a SyntaxError) or when the file stays unreadable (busy errors are retried for a moment first).
 */
export function readJson(file, fallback = null) {
  let text;
  for (let i = 0; ; i++) {
    try {
      text = readFileSync(file, 'utf8');
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      if (!WIN_BUSY.has(err.code) || i >= 2) throw err;
      sleepSync(5);
    }
  }
  return parseJson(text.replace(/^﻿/, ''));
}

/** True when `file` is a folder, or a file nobody may write (on Windows: the read-only attribute): no rename will replace it. */
function unreplaceable(file) {
  try {
    const st = statSync(file);
    return st.isDirectory() || (st.mode & 0o222) === 0;
  } catch {
    return false;
  }
}

/** Delete a file; true when it is gone (or was never there). A few quick retries for Windows' busy errors. */
export function removeFile(file, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      unlinkSync(file);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (!WIN_BUSY.has(err.code)) return false;
      if (i + 1 < tries) sleepSync(2);
    }
  }
  return false;
}

/**
 * Write a file atomically: write a temp file next to it, fsync, then rename over the target. If
 * anything fails (a read-only target, a full disk, ...) the temp file is removed before the error
 * is thrown, so a failed write never leaves files behind.
 */
export function atomicWrite(file, text) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let moved = false;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // On Windows a rename can briefly fail while another process (or an antivirus scanner) has the
    // target open. Retry for up to ~1 s, then fall back to copying so the data is never lost. A
    // read-only target (or a folder in the way) never becomes replaceable by waiting.
    for (let i = 0; i < 40 && !moved; i++) {
      try {
        renameSync(tmp, file);
        moved = true;
      } catch (err) {
        if (!WIN_BUSY.has(err.code) || unreplaceable(file)) throw err;
        sleepSync(25);
      }
    }
    if (!moved) copyFileSync(tmp, file);
  } finally {
    if (!moved) removeFile(tmp);
  }
}

export const atomicWriteJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 1) + '\n');

/** {mtimeMs, size} of a file, or null if it doesn't exist. */
export function fileStamp(file) {
  try {
    const s = statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
export const sameStamp = (a, b) => (!a && !b) || (a && b && a.mtimeMs === b.mtimeMs && a.size === b.size);

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------- cross-process lock
//
// The HTTP server and the stdio bridge (one per AI app) all read-modify-write data.json and
// ai.json, so every such write runs inside withLock(). The lock is a file created with O_EXCL
// ('wx'), which the OS creates atomically for exactly one process. Its holder then writes one line,
// "<pid> <ms> <nonce>\n". The rules that keep exactly one holder:
//  - A lock file whose line is empty, cut short or unreadable is still held: its holder is between
//    creating and writing it. Only an old one (mtime past `staleMs`) is abandoned.
//  - A complete line is abandoned when its process is gone, or it is older than `staleMs` (a hung
//    holder or a reused pid; real holders keep it for a few milliseconds of synchronous work).
//  - Only one process at a time may delete an abandoned lock, under a second lock file
//    (`<lock>.break`), and it reads the lock again first: a lock that another waiter has already
//    replaced is never deleted. Waiting never "times out" into taking a live lock; it fails instead.
//  - A holder deletes the lock file only while it still holds its own line.
//  - On Windows, creating the file can fail with EPERM (or EACCES / EBUSY) for a moment while a lock
//    that was just deleted is still "delete pending"; that means "busy, try again", like EEXIST.

/** A lock older than this is abandoned. */
export const LOCK_STALE_MS = 10000;
/** Waiting longer than this for the lock fails with a LockError (status 503). */
export const LOCK_TIMEOUT_MS = 15000;
/** Windows busy errors (see above) that last longer than this are real errors (e.g. a folder that cannot be written). */
const LOCK_BUSY_MS = 2000;
const LOCK_LINE = /^([1-9]\d{0,9}) (\d{13}) [0-9a-f]{16}\n$/;
const LEGACY_LOCK_LINE = /^([1-9]\d{0,9}) (\d{13})$/; // written by ecosys 0.3.0 and older: no nonce, no newline

/** Lock files this process holds: normalized path → the line it wrote. Re-entrant across createLock() calls. */
const heldLocks = new Map();
const lockKey = (file) => (process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file));
const holdsLine = (line) => [...heldLocks.values()].includes(line);

export class LockError extends Error {
  constructor(holder) {
    super(`The ecosys data folder is busy: ${holder ? `another ecosys process (pid ${holder})` : 'another ecosys process'} kept its lock for too long. Try again in a moment.`);
    this.code = 'ELOCKED';
    this.status = 503;
  }
}

/** The lock file now: {line, pid, at, mtimeMs} (pid 0 when the line is incomplete), null when there is none, undefined when it cannot be read. */
function readLock(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined;
  }
  try {
    const { mtimeMs } = fstatSync(fd); // the same file as the line, even if it is being replaced
    const buf = Buffer.alloc(64);
    const line = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
    const m = LOCK_LINE.exec(line) || LEGACY_LOCK_LINE.exec(line);
    return { line, pid: m ? Number(m[1]) : 0, at: m ? Number(m[2]) : 0, mtimeMs };
  } catch {
    return undefined;
  } finally {
    try { closeSync(fd); } catch {}
  }
}

function abandoned(l, staleMs, now = Date.now()) {
  if (!l.pid) return now - l.mtimeMs > staleMs; // being written right now, unless that was long ago
  if (l.pid === process.pid) return !holdsLine(l.line); // left by an earlier process that had our pid
  return !pidAlive(l.pid) || now - l.at > staleMs;
}

/** Delete `file` if it is (still) abandoned. One process at a time, under `<file>.break`. */
function breakAbandoned(file, staleMs) {
  const guard = `${file}.break`;
  let fd;
  try {
    fd = openSync(guard, 'wx', 0o600);
  } catch (err) {
    // Another waiter is doing it right now, or died doing so (then its guard file grows old).
    if (err.code === 'EEXIST') {
      const g = fileStamp(guard);
      if (g && Date.now() - g.mtimeMs > staleMs) removeFile(guard);
    }
    return;
  }
  try {
    try { closeSync(fd); } catch {}
    const l = readLock(file);
    if (l && abandoned(l, staleMs)) removeFile(file);
  } finally {
    removeFile(guard);
  }
}

/** Take the lock: returns {line, at} (what was written, and its time), or null when this process already holds that file. */
function acquireLock(file, staleMs, timeoutMs, pauseMs) {
  ensureDir(dirname(file));
  const start = Date.now();
  let lookAt = start + 20; // a lock is normally free again within milliseconds; only then ask who holds it
  let busySince = 0;
  let holder = 0;
  for (let attempt = 0; ; attempt++) {
    const at = Date.now();
    const line = `${process.pid} ${at} ${randomBytes(8).toString('hex')}\n`;
    let fd = null;
    let code = null;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (err) {
      code = err.code;
      const busy = code === 'EEXIST' || (process.platform === 'win32' && WIN_BUSY.has(code));
      if (!busy) throw err;
      const t = Date.now();
      if (code !== 'EEXIST') {
        busySince ||= t;
        if (t - busySince > LOCK_BUSY_MS) throw err;
      } else busySince = 0;
    }
    if (fd !== null) {
      try {
        if (pauseMs) sleepSync(pauseMs);
        writeSync(fd, line);
      } catch (err) {
        try { closeSync(fd); } catch {}
        removeFile(file);
        throw err;
      }
      try { closeSync(fd); } catch {}
      return { line, at };
    }
    const now = Date.now();
    if (code === 'EEXIST' && (now >= lookAt || heldLocks.size)) {
      lookAt = now + 200;
      const l = readLock(file);
      if (l === null) continue; // released just now
      if (l) {
        if (l.pid === process.pid && holdsLine(l.line)) return null; // the same file under another spelling
        holder = l.pid;
        if (abandoned(l, staleMs, now)) {
          breakAbandoned(file, staleMs);
          continue;
        }
      }
    }
    if (now - start > timeoutMs) throw new LockError(holder);
    sleepSync(Math.min(1 + attempt, 15) * (0.5 + Math.random()));
  }
}

/**
 * Delete the lock file, but only while it still holds our line: a lock held past `staleMs` may have
 * been judged abandoned and taken over, and is then someone else's. Before `staleMs / 2` nobody can
 * have taken it (see abandoned()), so a normal, short hold skips reading it back.
 */
function releaseLock(file, { line, at }, staleMs) {
  if (Date.now() - at < staleMs / 2 && removeFile(file)) return;
  for (let i = 0; i < 50; i++) {
    const l = readLock(file);
    if (l === null || (l && l.line !== line)) return;
    if (l && removeFile(file)) return;
    sleepSync(2);
  }
  removeFile(file); // unreadable all along: as far as anyone can tell it is still ours
}

/**
 * Cross-process lock around a read-modify-write of the data files (see the rules above).
 * Re-entrant within a process (also across separate createLock() calls for the same file).
 * `fn` must be synchronous. Throws LockError if the lock stays busy for `timeoutMs`.
 * `pauseAfterCreateMs` is for tests only: it widens the moment in which the new lock file is still
 * empty, which other processes must treat as held.
 */
export function createLock(lockFile, { staleMs = LOCK_STALE_MS, timeoutMs = LOCK_TIMEOUT_MS, pauseAfterCreateMs = 0 } = {}) {
  const key = lockKey(lockFile);
  return function withLock(fn) {
    if (heldLocks.has(key)) return fn();
    const taken = acquireLock(lockFile, staleMs, timeoutMs, pauseAfterCreateMs);
    if (taken === null) return fn();
    heldLocks.set(key, taken.line);
    try {
      return fn();
    } finally {
      heldLocks.delete(key);
      releaseLock(lockFile, taken, staleMs);
    }
  };
}

/**
 * Keep only the newest `keep` files in `dir` that `match` (a RegExp for the exact names this code
 * creates, or a name prefix together with `suffix`). Names must sort by age, as ISO time stamps do.
 */
export function pruneDir(dir, match, keep, suffix = '') {
  const ours = match instanceof RegExp ? (n) => match.test(n) : (n) => n.startsWith(match) && n.endsWith(suffix);
  let names;
  try {
    names = readdirSync(dir).filter(ours).sort();
  } catch {
    return;
  }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) removeFile(join(dir, n));
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
/** The shape of stamp(), for matching file names made with it. */
export const STAMP_RE_SOURCE = String.raw`\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z`;

/** Strip control characters (except tab/newline) from text that goes back to a model or a log. */
export const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

/**
 * Where a JSON.parse error happened, for a log line: " (error at character N)" or "". Never the
 * parser's own message, which quotes the text around the error (part of a key, or of the user's data).
 */
export const jsonErrorAt = (err) => {
  const at = err instanceof SyntaxError ? / at position (\d+)/.exec(err.message)?.[1] : null;
  return at ? ` (error at character ${at})` : '';
};

/** Hide anything shaped like a connection key (32+ base64url characters) before text goes to a log. */
export const redactKeys = (s) => String(s ?? '').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');

/**
 * An error as one line-safe string for the log: its code, message and stack, with key-shaped text
 * hidden. Never the error object itself, whose properties (e.g. a URL error's `input`) can hold a
 * request target such as /s/<key>/mcp.
 */
export function describeError(err) {
  const code = typeof err?.code === 'string' ? `[${err.code}] ` : '';
  return redactKeys(cleanText(`${code}${err?.stack || err?.message || err}`));
}

/**
 * Proof that the stdio bridge holds a connection key, for POST /api/internal/notify, so the key
 * itself never has to be sent to whatever listens on the port named in server.json.
 */
export const notifyProof = (token, clientId, at, body) =>
  createHmac('sha256', String(token)).update(`ecosys-notify\n${clientId}\n${at}\n${body}`).digest('base64url');
