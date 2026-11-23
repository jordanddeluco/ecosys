// Parent side of lib/child-runner.mjs: spawn a Node child that runs a property module under a
// given environment and hand back its JSON report. One child at a time (memory is tight).
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SEED, RUNS_FACTOR } from './harness.js';

const RUNNER = fileURLToPath(new URL('./child-runner.mjs', import.meta.url));

export function runChildProps(moduleUrl, { env = {}, timeoutMs = 240000 } = {}) {
  const modulePath = fileURLToPath(moduleUrl);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, modulePath],
      { env: { ...process.env, FUZZ_SEED: String(SEED), FUZZ_RUNS: String(RUNS_FACTOR), ...env }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').filter(Boolean).pop();
        if (line) {
          try {
            return resolve(JSON.parse(line));
          } catch {
            /* fall through */
          }
        }
        reject(new Error(`child failed (${err?.code ?? err?.signal ?? 'no output'}): ${String(stderr).slice(0, 3000)}`));
      },
    );
  });
}

/** Run a Node script with `args`, write `input` to its stdin, and parse the last JSON line it prints. */
export function runScript(scriptUrl, args = [], { input = '', env = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(scriptUrl), ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`script exited ${code} without a JSON result: ${err.slice(0, 2000)}`));
      }
    });
    child.stdin.end(input);
  });
}

/** Register one node:test subtest per property result of a child report. */
export async function reportChild(t, report, label) {
  t.diagnostic(`${label}: seed=${report.seed}${report.env ? ` env=${JSON.stringify(report.env)}` : ''}`);
  for (const r of report.results) {
    await t.test(r.name, (st) => {
      st.diagnostic(`${label}: cases=${r.runs ?? '-'} discarded=${r.discards ?? '-'} ${r.ms} ms`);
      if (!r.ok) {
        const err = new Error(`[${label}] ${r.error}`);
        err.stack = err.message; // the child's message is the useful part
        throw err;
      }
    });
  }
}
