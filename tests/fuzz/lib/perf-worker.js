// Worker thread for the sanitizer performance tests: runs the named cases one by one and reports
// the time of each call (input building is not timed). The parent kills the worker when a case
// runs past its hard limit, so a quadratic case cannot hang the test run.
import { parentPort, workerData } from 'node:worker_threads';
import * as sanitize from '../../../shared/sanitize.js';
import { CASES } from './perf-cases.js';

const { names, seed } = workerData;
const byName = new Map(CASES.map((c) => [c.name, c]));

// warm up the code paths once so the first case does not pay for compilation
sanitize.sanitizeHtml('<p class="hl">a <a href="https://x.example">b</a> &amp; <!-- c --></p>'.repeat(200));
sanitize.htmlToText('<ul><li>a</li></ul>'.repeat(200));
sanitize.cleanHref(' https://x.example/ ');

for (const name of names) {
  const c = byName.get(name);
  if (!c) {
    parentPort.postMessage({ name, error: 'unknown case' });
    continue;
  }
  const input = c.build(seed);
  parentPort.postMessage({ name, started: true, inLen: input.length });
  const t0 = performance.now();
  let out;
  let error = null;
  try {
    out = c.opts ? sanitize[c.fn](input, c.opts) : sanitize[c.fn](input);
  } catch (err) {
    error = `${err?.name}: ${err?.message}`;
  }
  const ms = performance.now() - t0;
  parentPort.postMessage({ name, ms, inLen: input.length, outLen: typeof out === 'string' ? out.length : null, error });
}
parentPort.postMessage({ done: true });
