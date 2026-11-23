// Performance properties of shared/sanitize.js: every 1 MB pathological input must finish in < 1 s
// (linear-ish time). Each case runs in a worker thread with a hard limit, so a quadratic case is
// reported (and killed) instead of hanging the run.
//
//   FUZZ_PERF_BUDGET_MS=1000   per-call budget (default 1000 ms, as in the test contract)
//   FUZZ_PERF_HARD_MS=3000     when a still-running call is killed and reported as "> limit"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { SEED, reproduce } from './lib/harness.js';
import { CASES } from './lib/perf-cases.js';

const BUDGET_MS = Number(process.env.FUZZ_PERF_BUDGET_MS) || 1000;
const HARD_MS = Number(process.env.FUZZ_PERF_HARD_MS) || Math.max(3000, BUDGET_MS * 3);
const WORKER_URL = new URL('./lib/perf-worker.js', import.meta.url);

console.log(`# sanitize-perf: seed ${SEED} budget ${BUDGET_MS} ms, hard limit ${HARD_MS} ms (reproduce: ${reproduce()})`);

/** Run the named cases in a worker (one at a time); a case past HARD_MS is killed and recorded as timed out. */
async function runCases(names) {
  const results = [];
  let remaining = [...names];
  while (remaining.length) {
    const r = await new Promise((resolve) => {
      const got = [];
      const w = new Worker(WORKER_URL, { workerData: { names: remaining, seed: SEED } });
      let timer = null;
      let current = null;
      const finish = (extra) => {
        clearTimeout(timer);
        w.terminate().catch(() => {});
        resolve({ got, ...extra });
      };
      const arm = (ms, extra) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(extra()), ms);
      };
      arm(60000, () => ({ killed: current ?? remaining[got.length], reason: 'no progress (startup or input building)' }));
      w.on('message', (m) => {
        if (m.done) return finish({});
        if (m.started) {
          current = m.name;
          return arm(HARD_MS, () => ({ killed: m.name, inLen: m.inLen }));
        }
        got.push(m);
        current = null;
        arm(60000, () => ({ killed: remaining[got.length], reason: 'no progress (input building)' }));
      });
      w.on('error', (err) => finish({ crashed: `${err?.name}: ${err?.message}`, killed: current }));
    });
    results.push(...r.got);
    if (r.killed) results.push({ name: r.killed, ms: Infinity, timedOut: true, inLen: r.inLen, reason: r.reason });
    else if (r.crashed) results.push({ name: remaining[r.got.length], ms: Infinity, error: r.crashed });
    const seen = new Set(results.map((x) => x.name));
    remaining = remaining.filter((n) => !seen.has(n));
    if (!r.killed && !r.crashed) break;
  }
  return results;
}

const fmt = (r) => (r.timedOut ? `> ${HARD_MS} ms (killed)` : `${r.ms.toFixed(1)} ms`);

async function perfTest(t, prefix) {
  const names = CASES.filter((c) => c.name.startsWith(`${prefix} | `)).map((c) => c.name);
  assert.ok(names.length > 0, `no cases for ${prefix}`);
  const results = await runCases(names);
  // Other processes may be busy on this machine: a call that was slow but finished is measured
  // again (best of 3) before it counts as slow. Calls past the hard limit are not retried.
  for (let attempt = 0; attempt < 2; attempt++) {
    const again = results.filter((r) => !r.timedOut && !r.error && r.ms >= BUDGET_MS).map((r) => r.name);
    if (!again.length) break;
    for (const r2 of await runCases(again)) {
      const r = results.find((x) => x.name === r2.name);
      if (r2.ms < r.ms) Object.assign(r, r2, { retried: true });
    }
  }
  for (const r of results) t.diagnostic(`${fmt(r).padStart(22)}  ${r.name}${r.retried ? '  (best of 3)' : ''}${r.error ? `  ERROR ${r.error}` : ''}`);
  const errors = results.filter((r) => r.error);
  assert.deepEqual(errors, [], `calls threw:\n${errors.map((r) => `  ${r.name}: ${r.error}`).join('\n')}`);
  const slow = results.filter((r) => !(r.ms < BUDGET_MS));
  assert.equal(
    slow.length,
    0,
    `${slow.length} of ${results.length} 1 MB inputs took longer than ${BUDGET_MS} ms (not linear time):\n${slow.map((r) => `  ${fmt(r).padStart(22)}  ${r.name}`).join('\n')}`,
  );
}

test('sanitizeHtml: every 1 MB pathological input finishes in < 1 s (default maxLength)', async (t) => {
  await perfTest(t, 'sanitizeHtml');
});

test('sanitizeHtml: every 1 MB pathological input finishes in < 1 s when the whole input is kept (maxLength 2 MB)', async (t) => {
  await perfTest(t, 'sanitizeHtml (maxLength 2 MB)');
});

test('htmlToText: 1 MB inputs finish in < 1 s', async (t) => {
  await perfTest(t, 'htmlToText');
});

test('cleanHref: 1 MB inputs finish in < 1 s', async (t) => {
  await perfTest(t, 'cleanHref');
});
