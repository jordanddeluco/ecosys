// Runs the `properties` exported by a property module in THIS process and prints one JSON line:
//   {env, results:[{name, ok, runs, discards, ms, error}]}
// Used to check the same properties under another environment (TZ=…, or without the notes schema
// registered), which can only be set before the modules under test are loaded.
//
//   node tests/fuzz/lib/child-runner.mjs <property-module.js>     (env: FUZZ_SEED, FUZZ_RUNS, TZ, …)
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { forAll, shrinkString, shrinkValue, SEED } from './harness.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node child-runner.mjs <property-module>');
  process.exit(2);
}
const mod = await import(pathToFileURL(resolve(target)).href);
if (mod.setup) await mod.setup();
const SHRINK = { string: shrinkString, value: shrinkValue };
const results = [];
for (const p of mod.properties) {
  const t0 = performance.now();
  try {
    const r = p.test
      ? (p.test(), { runs: 1, discards: 0 })
      : forAll(p.name, { runs: p.runs, gen: p.gen, prop: p.prop, shrink: SHRINK[p.shrink], display: p.display, timeLimitMs: p.timeLimitMs });
    results.push({ name: p.name, ok: true, runs: r.runs, discards: r.discards, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    results.push({ name: p.name, ok: false, ms: Math.round(performance.now() - t0), error: String(err?.message ?? err).slice(0, 6000) });
  }
}
process.stdout.write(`${JSON.stringify({ seed: SEED, env: mod.describeEnv ? mod.describeEnv() : null, results })}\n`);
