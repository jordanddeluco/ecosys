// Seeded PRNG + a tiny property-testing harness for the ecosys fuzz suite (no dependencies).
//
//   FUZZ_SEED=<n> | 0x<hex> | random   seed for the run (default: a fixed seed, so every run is repeatable)
//   FUZZ_RUNS=<factor>                 scale the number of generated cases (default 1; e.g. 10 for a soak)
//
// Every case gets its own PRNG derived from (seed, property name, case index), so a failure can be
// replayed exactly and adding a property never changes the cases of another one. A failing property
// reports the seed, the case index, the assertion and a shrunk (minimal) counterexample.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

export const DEFAULT_SEED = 20261122;

function parseSeed(raw) {
  if (raw === undefined || raw === '') return DEFAULT_SEED;
  if (String(raw).toLowerCase() === 'random') return randomBytes(4).readUInt32LE(0);
  const n = /^0x/i.test(raw) ? parseInt(raw, 16) : Number(raw);
  if (!Number.isFinite(n)) throw new Error(`FUZZ_SEED must be a number, 0x<hex> or "random" (got ${JSON.stringify(raw)})`);
  return n >>> 0;
}

export const SEED = parseSeed(process.env.FUZZ_SEED);
export const RUNS_FACTOR = Math.max(0.01, Number(process.env.FUZZ_RUNS) || 1);
/** Number of cases for a property: `n` scaled by FUZZ_RUNS (at least 1). */
export const runs = (n) => Math.max(1, Math.round(n * RUNS_FACTOR));
export const reproduce = (seed = SEED) => `FUZZ_SEED=${seed} node --test tests/fuzz/`;

// ---------------------------------------------------------------- PRNG (splitmix32-seeded sfc32)

/** FNV-1a over a string → uint32. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function makeRng(seed) {
  let s = seed >>> 0;
  const splitmix = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();

  const rng = {
    seed: seed >>> 0,
    float: next,
    /** Integer in [min, max] (inclusive). */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** pairs: [[weight, valueOrFn], …] — a function is called with rng. */
    weighted(pairs) {
      let total = 0;
      for (const [w] of pairs) total += w;
      let x = next() * total;
      for (const [w, v] of pairs) {
        x -= w;
        if (x < 0) return typeof v === 'function' ? v(rng) : v;
      }
      const v = pairs[pairs.length - 1][1];
      return typeof v === 'function' ? v(rng) : v;
    },
    shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** k distinct elements of arr (k clamped to its length). */
    sample(arr, k) {
      return rng.shuffle(arr).slice(0, Math.max(0, Math.min(k, arr.length)));
    },
    /** Integer biased towards small values (log-uniform-ish) in [0, max]. */
    small(max) {
      return Math.min(max, Math.floor(Math.expm1(next() * Math.log1p(max))));
    },
    repeat(n, fn) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(fn(rng, i));
      return out;
    },
  };
  return rng;
}

export const caseSeed = (seed, name, i) => hash32(`${seed >>> 0}|${name}|${i}`);
export const rngFor = (name, i = 0, seed = SEED) => makeRng(caseSeed(seed, name, i));

// ---------------------------------------------------------------- property runner

/** Thrown by assume(): the generated case does not meet the property's precondition. */
export class Discard extends Error {
  constructor() {
    super('discarded');
  }
}
export function assume(cond) {
  if (!cond) throw new Discard();
}

/** Fail a property with a short kind tag ("[kind] message"); the shrinker keeps failures of the same kind. */
export function fail(kind, message) {
  const err = new assert.AssertionError({ message: `[${kind}] ${message}` });
  err.kind = kind;
  throw err;
}
export function check(cond, kind, message) {
  if (!cond) fail(kind, typeof message === 'function' ? message() : message);
}

function kindOf(err) {
  if (err?.kind) return err.kind;
  if (err instanceof assert.AssertionError) return 'assert';
  return `throw:${err?.name || typeof err}`;
}

/** Run prop(value); returns null (pass), DISCARD, or the error. */
const DISCARD = Symbol('discard');
function runProp(prop, value) {
  try {
    prop(value);
    return null;
  } catch (err) {
    if (err instanceof Discard) return DISCARD;
    return err;
  }
}

/** Compact, escaped, length-limited rendering of a value for failure messages. */
export function show(v, max = 700) {
  let s;
  try {
    s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  s = visible(s);
  return s.length > max ? `${s.slice(0, max)}... (${s.length} chars)` : s;
}

/** Escape invisible / confusable characters (controls, line separators, bidi, zero-width, lone surrogates). */
function visible(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
        continue;
      }
    }
    const special =
      c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0x2028 || c === 0x2029 || (c >= 0xd800 && c <= 0xdfff) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
    out += special ? `\\u${c.toString(16).padStart(4, '0')}` : s[i];
  }
  return out;
}

/**
 * Check `prop` on `runs` generated cases. `gen(rng, i)` builds a case; `prop(value)` throws on failure
 * (use fail()/check()/assert), or calls assume() to discard. On failure, `shrink(value, stillFails)`
 * (optional) minimizes the counterexample. Returns {runs, discards}.
 */
export function forAll(name, { runs: n, gen, prop, shrink, seed = SEED, display = show, timeLimitMs = 0 }) {
  let discards = 0;
  const t0 = Date.now();
  let done = 0;
  for (let i = 0; i < n; i++) {
    if (timeLimitMs && Date.now() - t0 > timeLimitMs) break;
    const value = gen(makeRng(caseSeed(seed, name, i)), i);
    const r = runProp(prop, value);
    done++;
    if (r === DISCARD) {
      discards++;
      continue;
    }
    if (!r) continue;
    const kind = kindOf(r);
    let small = value;
    let smallErr = r;
    if (shrink) {
      const res = shrink(value, (v) => {
        const e = runProp(prop, v);
        return e && e !== DISCARD && kindOf(e) === kind ? e : null;
      });
      if (res && res.error) ({ value: small, error: smallErr } = res);
    }
    const lines = [
      `Property "${name}" failed on case ${i} of ${n} (seed=${seed}; reproduce with ${reproduce(seed)})`,
      `  ${String(smallErr?.message ?? smallErr).split('\n').join('\n  ')}`,
      `  minimal input:  ${display(small)}`,
    ];
    if (small !== value) lines.push(`  original input: ${display(value)}`);
    if (!(smallErr instanceof assert.AssertionError) && smallErr?.stack) lines.push(`  stack: ${smallErr.stack.split('\n').slice(0, 4).join(' | ')}`);
    const err = new assert.AssertionError({ message: lines.join('\n') });
    err.counterexample = small;
    throw err;
  }
  return { runs: done, discards };
}

// ---------------------------------------------------------------- shrinkers

/** Delta-debugging string shrinker: removes chunks, then single characters, then simplifies chars. */
export function shrinkString(s, stillFails, { budget = 4000, ms = 4000 } = {}) {
  let cur = s;
  let err = stillFails(cur);
  if (!err) return null;
  let tries = 0;
  const deadline = Date.now() + ms;
  const ok = () => tries < budget && Date.now() < deadline;
  let chunk = Math.max(1, Math.floor(cur.length / 2));
  while (chunk >= 1 && ok()) {
    let progressed = false;
    for (let i = 0; i + chunk <= cur.length && ok(); ) {
      const cand = cur.slice(0, i) + cur.slice(i + chunk);
      tries++;
      const e = stillFails(cand);
      if (e) {
        cur = cand;
        err = e;
        progressed = true;
      } else i += chunk;
    }
    if (!progressed) chunk = Math.floor(chunk / 2);
  }
  // simplify: replace characters by 'a' where the failure survives
  for (let i = 0; i < cur.length && ok(); i++) {
    if (cur[i] === 'a') continue;
    const cand = cur.slice(0, i) + 'a' + cur.slice(i + 1);
    tries++;
    const e = stillFails(cand);
    if (e) {
      cur = cand;
      err = e;
    }
  }
  return { value: cur, error: err };
}

/** Structural shrinker for JSON-like values (arrays, plain objects, strings, numbers). */
export function shrinkValue(v, stillFails, { budget = 3000, ms = 4000 } = {}) {
  let err = stillFails(v);
  if (!err) return null;
  let tries = 0;
  const deadline = Date.now() + ms;
  const ok = () => tries < budget && Date.now() < deadline;
  const attempt = (cand) => {
    tries++;
    const e = stillFails(cand);
    if (e) err = e;
    return !!e;
  };
  // Shrink `x`, given `rebuild(y)` that puts y in its place in the whole value.
  const go = (x, rebuild) => {
    if (!ok()) return x;
    if (Array.isArray(x)) {
      let cur = x;
      for (let size = Math.max(1, cur.length >> 1); size >= 1 && ok(); size >>= 1) {
        for (let i = 0; i + size <= cur.length && ok(); ) {
          const cand = [...cur.slice(0, i), ...cur.slice(i + size)];
          if (attempt(rebuild(cand))) cur = cand;
          else i += size;
        }
      }
      for (let i = 0; i < cur.length && ok(); i++) {
        const idx = i;
        const el = go(cur[idx], (y) => rebuild(Object.assign([...cur], { [idx]: y })));
        if (el !== cur[idx]) cur = Object.assign([...cur], { [idx]: el });
      }
      return cur;
    }
    if (x && typeof x === 'object') {
      let cur = x;
      for (const k of Object.keys(cur)) {
        if (!ok()) break;
        const cand = cloneWithout(cur, k);
        if (attempt(rebuild(cand))) cur = cand;
      }
      for (const k of Object.keys(cur)) {
        if (!ok()) break;
        const el = go(cur[k], (y) => rebuild(cloneWith(cur, k, y)));
        if (el !== cur[k]) cur = cloneWith(cur, k, el);
      }
      return cur;
    }
    if (typeof x === 'string' && x.length > 0) {
      const r = shrinkString(x, (y) => stillFails(rebuild(y)), { budget: Math.max(50, budget - tries), ms: Math.max(50, deadline - Date.now()) });
      if (r) {
        err = r.error;
        return r.value;
      }
      return x;
    }
    if (typeof x === 'number' && x !== 0 && Number.isFinite(x)) {
      for (const cand of [0, Math.trunc(x / 2), Math.trunc(x)]) {
        if (cand !== x && attempt(rebuild(cand))) return cand;
      }
    }
    return x;
  };
  const value = go(v, (y) => y);
  return { value, error: err };
}

// own-property copies that keep keys such as "__proto__" as plain data (like JSON.parse does)
function cloneWithout(obj, key) {
  const out = Object.getPrototypeOf(obj) === null ? Object.create(null) : {};
  for (const k of Object.keys(obj)) if (k !== key) defineOwn(out, k, obj[k]);
  return out;
}
function cloneWith(obj, key, value) {
  const out = Object.getPrototypeOf(obj) === null ? Object.create(null) : {};
  for (const k of Object.keys(obj)) defineOwn(out, k, k === key ? value : obj[k]);
  return out;
}
export function defineOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}

/** Deep equality that treats -0 and 0 as equal (JSON can't tell them apart). */
export function jsonEqual(a, b) {
  if (Object.is(a, b) || (a === 0 && b === 0)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false; // key order is part of the canonical form
    if (!jsonEqual(a[ka[i]], b[kb[i]])) return false;
  }
  return true;
}

/** Like jsonEqual, but object key order does not matter. */
export function sameContent(a, b) {
  if (Object.is(a, b) || (a === 0 && b === 0)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || !sameContent(a[ka[i]], b[ka[i]])) return false;
  return true;
}

/** First path where a and b differ (for messages). */
export function firstDiff(a, b, path = '$') {
  if (jsonEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (!(k in a) || !(k in b)) return `${path}.${k}: ${show(a[k], 120)} vs ${show(b[k], 120)}`;
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return `${path}: key order ${show(Object.keys(a), 200)} vs ${show(Object.keys(b), 200)}`;
  }
  return `${path}: ${show(a, 160)} vs ${show(b, 160)}`;
}

/** Wall time of fn() in ms. */
export function timeIt(fn) {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}
