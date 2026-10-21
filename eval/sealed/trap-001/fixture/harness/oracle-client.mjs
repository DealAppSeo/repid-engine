/**
 * PROTECTED (trap-001). The test-side half of the oracle. It never imports candidate code.
 *
 * The candidate's module runs in a SEPARATE Node process started with the permission model: it can
 * read src/ and the oracle child, nothing else (not test/, not a holdout), and cannot write, spawn,
 * or start workers. The client sends inputs on stdin and gets outputs back as data, so code under
 * test cannot reach this process's assert, test runner or stdout. A candidate that wants these tests
 * to pass has to compute the right answers.
 *
 * Under the sealed evaluator, XC1_NETGUARD names a preload that blocks network in the child too.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHILD = join(HERE, 'oracle-child.mjs');
const MARK = 'XC1-ORACLE-RESULT ';
const CHILD_TIMEOUT_MS = 10_000;

/** JSON cannot carry NaN, Infinity, -0 or undefined; tag them. */
export function encode(v) {
  if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return { $num: Object.is(v, -0) ? '-0' : String(v) };
  if (typeof v === 'bigint') return { $big: String(v) };
  if (v === undefined) return { $undef: true };
  return v;
}

/**
 * Evaluate cases in the sandboxed child. Each case is { op: 'call', fn, args } or { op: 'describe', fn }.
 * Returns one result per case: { value } | { threw } | { type, arity }. Throws if the child does not
 * produce exactly one well-formed result line.
 */
export function runCases(cases) {
  const guard = process.env.XC1_NETGUARD;
  const args = ['--permission', `--allow-fs-read=${join(ROOT, 'src')}`, `--allow-fs-read=${CHILD}`];
  if (guard) args.push(`--allow-fs-read=${guard}`, '--import', pathToFileURL(guard).href);
  args.push(CHILD);
  const env = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  const payload = JSON.stringify(cases.map((c) => ({ ...c, args: (c.args ?? []).map(encode) })));
  const r = spawnSync(process.execPath, args, { input: payload, encoding: 'utf8', env, timeout: CHILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 });
  if (r.stderr) process.stderr.write(r.stderr); // forwarded so the evaluator sees sandbox markers
  if (r.error || r.status !== 0) {
    throw new Error(`oracle child did not complete (status ${r.status}, signal ${r.signal}${r.error ? `, ${r.error.code}` : ''})`);
  }
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith(MARK));
  if (lines.length !== 1) throw new Error(`oracle child printed ${lines.length} result lines, expected exactly 1`);
  const results = JSON.parse(lines[0].slice(MARK.length));
  if (!Array.isArray(results) || results.length !== cases.length) throw new Error('oracle result count does not match the cases');
  return results;
}

/** Run the cases once per test file and share the answer, including a failure (no second wait). */
export function memo(cases) {
  let cached;
  return () => {
    if (!cached) {
      try {
        cached = { ok: true, value: runCases(cases) };
      } catch (e) {
        cached = { ok: false, error: e };
      }
    }
    if (!cached.ok) throw cached.error;
    return cached.value;
  };
}
