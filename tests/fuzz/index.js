// Entry point for `node --test tests/fuzz/`: Node 24 resolves a directory argument to its index.js,
// so this file loads every *.test.js file in this folder into one test run. (Run a single file with
// `node --test tests/fuzz/<name>.fuzz.test.js`.) Helpers live in lib/ and are never run as tests.
//
//   FUZZ_SEED=<n>|random   seed (default fixed: runs are repeatable; every failure prints its seed)
//   FUZZ_RUNS=<factor>     scale the number of generated cases (default 1)
//   FUZZ_ZONES=a,b         time zones for recur-dst (default America/New_York, Europe/London, …)
//   FUZZ_PERF_BUDGET_MS    per-call budget for the 1 MB sanitizer inputs (default 1000)
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(here).filter((n) => n.endsWith('.test.js')).sort()) {
  await import(pathToFileURL(join(here, f)).href);
}
