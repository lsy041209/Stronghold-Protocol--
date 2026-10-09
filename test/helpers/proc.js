// test/helpers/proc.js — asynchronous stand-ins for `child_process.spawnSync`.
//
// Why this exists: when a test file is run by `node --test` on this machine, *every* `spawnSync()`
// returns `{ status: null, error: EBUSY }` — node, python, cmd.exe, with or without `shell: true`,
// whatever the argument shape. The identical call returns `status: 0` from a plain `node -e`
// process, so it is a property of the test-runner sandbox here, not of the code under test.
// Reporting that as a test failure buries real regressions under ~90 noise failures; skipping those
// tests throws the coverage away.
//
// The asynchronous spawn APIs are unaffected (measured: `spawn()` and `execFile()` both complete
// normally inside the runner). So tests that shell out await `run()` / `runOrThrow()` instead: the
// same assertions, the same results a normal machine would produce, and no skip to explain away.
//
// `run()` returns the shape `spawnSync()` would have: `{ status, signal, stdout, stderr, error }`.
// `status` is `null` only for a real failure to launch (or a timeout).

import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Spawn a command and wait for it. Async, so it works in the test runner where `spawnSync` cannot.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{input?: string|Buffer, env?: object, cwd?: string, timeout?: number}} [opts]
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string,
 *                    error: Error|null, timedOut: boolean}>}
 */
export function run(cmd, args, opts = {}) {
  const { input, env, cwd, timeout = DEFAULT_TIMEOUT_MS } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: env || process.env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error = null;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { error = e; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status: error ? null : status, signal, stdout, stderr, error, timedOut });
    });
    if (child.stdin) child.stdin.end(input === undefined ? '' : input);
  });
}

/** `run()`, but throw the stderr (and a stdout tail) when the command did not exit 0. */
export async function runOrThrow(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.status !== 0) {
    const why = r.error ? (r.error.code || r.error.message)
      : r.timedOut ? `timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS} ms`
        : `exit ${r.status}`;
    throw new Error(`${cmd} ${args.join(' ')}: ${why}\n${r.stderr.slice(-2000)}${r.stdout.slice(-1000)}`);
  }
  return r;
}

/**
 * First interpreter of `bins` that really runs `--version`. Async twin of upstream's
 * `['python3','python'].find(bin => spawnSync(bin, ['--version']).status === 0)`, which finds
 * nothing here for the reason above.
 * @param {string[]} bins
 * @returns {Promise<string|null>}
 */
export async function firstWorking(bins) {
  for (const bin of bins) {
    const r = await run(bin, ['--version'], { timeout: 20_000 });
    if (r.status === 0) return bin;
  }
  return null;
}
