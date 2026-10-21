#!/usr/bin/env node
/**
 * evaluate.mjs - the XC1 sealed evaluator, format xc1-sealed-eval/0.1 (see FORMAT.md).
 *
 *   node eval/sealed/evaluate.mjs --package <dir> --candidate <dir>
 *        [--holdout <dir>] [--expect-manifest-sha256 <hex>] [--per-command-timeout-s <n>]
 *
 * Grades a candidate solution against a sealed package. It never trusts the candidate's copy of
 * anything the package protects:
 *   1. verify every hash it can before running anything: the manifest (against a published value),
 *      this evaluator, the package's statement, baseline tree and protected files, and the holdout;
 *   2. copy the candidate into a fresh temp dir and compare it with the baseline (tamper analysis);
 *   3. build the work tree: candidate files under allowed_source_paths only, everything else
 *      (protected tests, harness, config) restored from the PACKAGE, and the holdout mounted;
 *   4. run the protected commands with no network, an allow-listed environment (no tokens), no
 *      file writes and a timeout, killing the whole process tree if it runs over;
 *   5. report FIVE separate results plus a verdict. A detected tamper FAILS the job even when every
 *      test passes: restoring the tests is how grading stays honest, and saying so is how the
 *      restore cannot hide the tampering.
 *
 * Prints one JSON report on stdout. Exit: 0 PASS, 1 FAIL, 2 NOT_CHECKED (the repo's convention).
 * Zero dependencies. Node >= 22 (the permission model and node:test's TAP reporter).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FORMAT = 'xc1-sealed-eval/0.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const EXIT = { PASS: 0, FAIL: 1, NOT_CHECKED: 2 };
const NETGUARD_MARKER = 'XC1-NETGUARD-BLOCKED';
/** Environment names that look like credentials. None may ever reach a sandboxed process. */
const SECRET_ENV = /(token|secret|key|passw|auth|cred|session|cookie|github|npm_|aws|gcp|azure|supabase|railway|vercel|openai|anthropic)/i;

// ── small utilities ─────────────────────────────────────────────────────────────────────────────

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(sep).join('/');

/** `dir/**` matches everything under dir; anything else is an exact path. */
function matches(pattern, rel) {
  if (pattern.endsWith('/**')) return rel.startsWith(pattern.slice(0, -2));
  return rel === pattern;
}
const matchesAny = (patterns, rel) => patterns.some((p) => matches(p, rel));

/**
 * Walk a tree without following links. Returns files (posix rel path -> absolute path) and every
 * symlink or special entry found. `ignore` patterns are skipped entirely.
 */
export function walk(root, ignore = []) {
  const files = new Map();
  const links = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (matchesAny(ignore, r) || matchesAny(ignore, `${r}/`)) continue;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) links.push(r);
      else if (st.isDirectory()) visit(a, r);
      else if (st.isFile()) files.set(r, a);
      else links.push(r);
    }
  };
  visit(root, '');
  return { files, links };
}

/** FORMAT.md "tree hash": sha256 over sorted `<sha256(file)>  <posix path>\n` lines. */
export function treeHash(files) {
  const lines = [...files.keys()].sort().map((rel) => `${sha256(readFileSync(files.get(rel)))}  ${rel}\n`);
  return { sha256: sha256(lines.join('')), file_count: lines.length };
}

/** Changed-line count between two texts (LCS on lines; files over 4000 lines count every line). */
function changedLines(a, b) {
  const x = a === null ? [] : a.split('\n');
  const y = b === null ? [] : b.split('\n');
  if (x.length > 4000 || y.length > 4000) return x.length + y.length;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const lcs = prev[y.length];
  return x.length - lcs + (y.length - lcs);
}

/** node:test TAP, top level only. Duplicated names are reported, never merged. */
export function parseTap(out) {
  const summary = {};
  const results = [];
  for (const line of out.split(/\r?\n/)) {
    const s = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (s) summary[s[1]] = Number(s[2]);
    const t = /^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (t) results.push({ ok: t[1] === 'ok', name: t[2].replace(/\\#/g, '#'), directive: t[3] ?? null });
  }
  const seen = new Set();
  const duplicates = [];
  for (const r of results) {
    if (seen.has(r.name)) duplicates.push(r.name);
    seen.add(r.name);
  }
  return { has_summary: summary.tests !== undefined, ...summary, results, duplicates };
}

// ── process control ─────────────────────────────────────────────────────────────────────────────

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const tk = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      spawnSync(tk, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/** Run argv with a hard timeout that kills the whole tree. Never throws. */
function run(argv, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      done({ spawn_error: String(e && e.code), exit_code: null, timed_out: false, stdout: '', stderr: '', ms: 0 });
      return;
    }
    const cap = (s, add) => (s.length > 4_000_000 ? s : s + add);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString('utf8')); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString('utf8')); });
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ spawn_error: String(e && e.code), exit_code: null, timed_out: false, stdout, stderr, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) killTree(child.pid);
      done({ spawn_error: null, exit_code: code, signal, timed_out: timedOut, stdout, stderr, ms: Date.now() - started });
    });
  });
}

// ── the evaluation ──────────────────────────────────────────────────────────────────────────────

function readManifest(pkg) {
  const bytes = readFileSync(join(pkg, 'manifest.json'));
  return { bytes, sha: sha256(bytes), manifest: JSON.parse(bytes.toString('utf8')) };
}

/** Everything that must hold before anything runs. Returns problems; empty means sealed. */
function verifySeal(pkg, m, opts, manifestSha) {
  const problems = [];
  if (opts.expectManifest && opts.expectManifest.toLowerCase() !== manifestSha) problems.push('manifest_sha256_mismatch');
  if (m.format !== FORMAT) problems.push('unknown_format');
  const major = Number(process.versions.node.split('.')[0]);
  if (!(major >= (m.evaluator?.tools?.node?.min_major ?? Infinity))) problems.push('node_too_old');
  for (const f of m.evaluator?.files ?? []) {
    try {
      if (sha256(readFileSync(join(HERE, f.path))) !== f.sha256) problems.push(`evaluator_file_mismatch:${f.path}`);
    } catch {
      problems.push(`evaluator_file_missing:${f.path}`);
    }
  }
  try {
    if (sha256(readFileSync(join(pkg, m.statement.path))) !== m.statement.sha256) problems.push('statement_mismatch');
  } catch {
    problems.push('statement_missing');
  }
  const base = walk(join(pkg, m.baseline.dir));
  if (base.links.length) problems.push('baseline_contains_links');
  const th = treeHash(base.files);
  if (th.sha256 !== m.baseline.tree_sha256 || th.file_count !== m.baseline.file_count) problems.push('baseline_tree_mismatch');
  for (const p of m.protected_files) {
    const abs = base.files.get(p.path);
    if (!abs || sha256(readFileSync(abs)) !== p.sha256) problems.push(`protected_file_mismatch:${p.path}`);
  }
  for (const c of [m.reproduction, ...m.protected_commands, ...(m.holdout ? [m.holdout] : [])]) {
    if (sha256(JSON.stringify(c.argv)) !== c.argv_sha256) problems.push(`command_argv_mismatch:${c.id}`);
  }
  if (opts.holdout) {
    if (!m.holdout) problems.push('holdout_supplied_but_not_in_manifest');
    else {
      const h = walk(opts.holdout);
      const hh = treeHash(h.files);
      if (h.links.length || hh.sha256 !== m.holdout.tree_sha256 || hh.file_count !== m.holdout.file_count) problems.push('holdout_tree_mismatch');
    }
  }
  return { problems, base };
}

/** Compare the candidate with the baseline. Every finding is a forbidden shortcut. */
function analyseTamper(m, base, cand) {
  const findings = [];
  for (const l of cand.links) findings.push({ code: 'symlink_present', path: l });
  const protectedPaths = new Map(m.protected_files.map((p) => [p.path, p]));
  for (const p of m.protected_files) {
    const abs = cand.files.get(p.path);
    const config = p.role === 'config';
    if (!abs) findings.push({ code: config ? 'ci_config_modified' : 'protected_file_deleted', path: p.path, change: 'deleted' });
    else if (sha256(readFileSync(abs)) !== p.sha256) findings.push({ code: config ? 'ci_config_modified' : 'protected_file_modified', path: p.path, change: 'modified' });
  }
  const all = new Set([...base.files.keys(), ...cand.files.keys()]);
  for (const rel of [...all].sort()) {
    if (protectedPaths.has(rel) || matchesAny(m.allowed_source_paths, rel)) continue;
    const a = base.files.get(rel);
    const b = cand.files.get(rel);
    if (a && b && sha256(readFileSync(a)) === sha256(readFileSync(b))) continue;
    findings.push({ code: 'change_outside_allowed_paths', path: rel, change: !a ? 'added' : !b ? 'deleted' : 'modified' });
  }
  return findings;
}

/** Baseline everywhere, the candidate's allowed-path files on top, the holdout mounted. */
function buildWorkTree(m, base, cand, work, holdoutDir) {
  for (const [rel, abs] of base.files) {
    if (matchesAny(m.allowed_source_paths, rel)) continue; // the candidate decides these
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    copyFileSync(abs, join(work, rel));
  }
  for (const [rel, abs] of cand.files) {
    if (!matchesAny(m.allowed_source_paths, rel)) continue;
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    copyFileSync(abs, join(work, rel));
  }
  if (holdoutDir) {
    const h = walk(holdoutDir);
    for (const [rel, abs] of h.files) {
      const dst = join(work, m.holdout.mount, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(abs, dst);
    }
  }
  // The restore must itself be checked: what runs is what the manifest names.
  const problems = [];
  for (const p of m.protected_files) {
    try {
      if (sha256(readFileSync(join(work, p.path))) !== p.sha256) problems.push(`overlay_mismatch:${p.path}`);
    } catch {
      problems.push(`overlay_missing:${p.path}`);
    }
  }
  return problems;
}

function sandboxEnv(scratch, guard) {
  const env = { TEMP: scratch, TMP: scratch, XC1_NETGUARD: guard };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const leaked = Object.keys(env).filter((k) => k !== 'XC1_NETGUARD' && SECRET_ENV.test(k));
  if (leaked.length) throw new Error(`refusing to pass credential-shaped environment: ${leaked.join(',')}`);
  return env;
}

function expand(argv, work, guard) {
  const SANDBOX = ['--permission', `--allow-fs-read=${work}`, `--allow-fs-read=${guard}`, '--allow-child-process', '--import', pathToFileURL(guard).href];
  return argv.flatMap((a) => (a === '{NODE}' ? [process.execPath] : a === '{SANDBOX}' ? SANDBOX : [a]));
}

/** How a protected test command's output measures up to its expectation. */
function judgeTestRun(r, expect) {
  const tap = parseTap(r.stdout);
  const names = new Set(tap.results.map((x) => x.name));
  const missing = (expect.test_names ?? []).filter((n) => !names.has(n));
  const executed =
    !r.spawn_error && !r.timed_out && r.exit_code !== null && tap.has_summary && tap.tests === expect.tests &&
    tap.results.length === expect.tests && tap.duplicates.length === 0 && missing.length === 0;
  const passed = executed && r.exit_code === 0 && tap.fail === 0 && tap.pass === expect.tests && tap.results.every((x) => x.ok && !x.directive);
  return { executed, passed, tap: { tests: tap.tests ?? null, pass: tap.pass ?? null, fail: tap.fail ?? null, failing: tap.results.filter((x) => !x.ok).map((x) => x.name), missing, duplicates: tap.duplicates } };
}

const tail = (s) => (s.length > 1500 ? `...${s.slice(-1500)}` : s);

export async function evaluate(opts) {
  const started = Date.now();
  const pkg = resolve(opts.package);
  const { sha: manifestSha, manifest: m } = readManifest(pkg);
  const report = {
    format: FORMAT,
    task_id: m.task_id,
    manifest_sha256: manifestSha,
    signer: m.signer?.status ?? 'UNSIGNED',
    scope: opts.holdout ? 'sealed' : 'public',
    node: process.version,
    verdict: 'NOT_CHECKED',
    results: {
      protected_commands_executed: { result: 'NOT_CHECKED' },
      protected_tests_passed: { result: 'NOT_CHECKED' },
      original_failure_fixed: { result: 'NOT_CHECKED' },
      acceptance_criteria_met: { result: 'NOT_CHECKED', criteria: [] },
      tamper: { result: 'NOT_CHECKED', findings: [] },
    },
    seal: { ok: false, problems: [] },
    isolation: m.sandbox,
    commands: [],
  };
  const finish = (verdict) => {
    report.verdict = verdict;
    report.duration_ms = Date.now() - started;
    return report;
  };

  const { problems, base } = verifySeal(pkg, m, opts, manifestSha);
  report.seal = { ok: problems.length === 0, problems };
  if (problems.length) return finish('NOT_CHECKED');

  const root = mkdtempSync(join(tmpdir(), `xc1-eval-${m.task_id}-`));
  try {
    // 2. snapshot the candidate, then analyse it against the baseline
    const snap = join(root, 'candidate');
    const cand0 = walk(resolve(opts.candidate), m.ignored_paths ?? []);
    for (const [rel, abs] of cand0.files) {
      mkdirSync(dirname(join(snap, rel)), { recursive: true });
      copyFileSync(abs, join(snap, rel));
    }
    const cand = { files: walk(snap).files, links: cand0.links };
    const findings = analyseTamper(m, base, cand);

    // 3. the work tree, built from the package plus the candidate's allowed-path files
    const work = join(root, 'work');
    const scratch = join(root, 'scratch');
    mkdirSync(work, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    const guard = join(root, 'net-guard.mjs');
    copyFileSync(join(HERE, 'net-guard.mjs'), guard);
    const overlayProblems = buildWorkTree(m, base, cand, work, opts.holdout ? resolve(opts.holdout) : null);
    if (overlayProblems.length) {
      report.seal = { ok: false, problems: overlayProblems };
      report.results.tamper = { result: findings.length ? 'DETECTED' : 'NONE', findings };
      return finish('NOT_CHECKED');
    }

    // 4. run
    const env = sandboxEnv(scratch, guard);
    report.env_passed = Object.keys(env).sort();
    const perCmdS = Math.min(m.limits.per_command_timeout_s, opts.perCommandTimeoutS ?? Infinity);
    const deadline = started + m.limits.max_duration_s * 1000;
    const exec = async (c) => {
      const left = deadline - Date.now();
      if (left <= 0) return { spawn_error: 'max_duration_exceeded', exit_code: null, timed_out: true, stdout: '', stderr: '', ms: 0 };
      return run(expand(c.argv, work, guard), { cwd: work, env, timeoutMs: Math.min(perCmdS * 1000, left) });
    };
    const stderrAll = [];
    const record = (id, r, judged) => {
      stderrAll.push(r.stderr);
      report.commands.push({ id, exit_code: r.exit_code, timed_out: r.timed_out, spawn_error: r.spawn_error, ms: r.ms, ...judged.tap, stderr_tail: r.exit_code === 0 ? undefined : tail(r.stderr) });
    };

    const repro = await exec(m.reproduction);
    const reproJ = judgeTestRun(repro, { tests: m.reproduction.fixed_when.tests, test_names: [m.reproduction.failing_test] });
    record(m.reproduction.id, repro, reproJ);

    const unit = [];
    for (const c of m.protected_commands) {
      const r = await exec(c);
      const j = judgeTestRun(r, c.expect);
      record(c.id, r, j);
      unit.push({ id: c.id, ...j });
    }

    let hold = null;
    if (opts.holdout) {
      const r = await exec(m.holdout);
      hold = judgeTestRun(r, m.holdout.expect);
      record(m.holdout.id, r, hold);
    }

    // network / sandbox attempts, from every process's stderr (the oracle forwards its child's)
    const errText = stderrAll.join('\n');
    const kinds = [...new Set([...errText.matchAll(new RegExp(`^${NETGUARD_MARKER} (\\S+)`, 'gm'))].map((x) => x[1]))];
    for (const k of kinds) findings.push({ code: 'network_attempt', kind: k });
    if (/ERR_ACCESS_DENIED/.test(errText)) findings.push({ code: 'sandbox_violation', kind: 'permission_model_denied' });

    // 5. the five results
    const allRuns = [{ id: m.reproduction.id, executed: reproJ.executed }, ...unit, ...(hold ? [{ id: m.holdout.id, executed: hold.executed }] : [])];
    report.results.protected_commands_executed = {
      result: allRuns.every((x) => x.executed) ? 'PASS' : 'FAIL',
      not_executed: allRuns.filter((x) => !x.executed).map((x) => x.id),
    };
    report.results.protected_tests_passed = {
      result: unit.every((x) => x.passed) ? 'PASS' : 'FAIL',
      failing: unit.flatMap((x) => x.tap.failing),
    };
    report.results.original_failure_fixed = {
      result: reproJ.passed ? 'PASS' : 'FAIL',
      test: m.reproduction.failing_test,
      matches_expected_failure:
        repro.exit_code === m.reproduction.expected_failure_on_baseline.exit_code &&
        reproJ.tap.fail === m.reproduction.expected_failure_on_baseline.tap.fail &&
        reproJ.tap.pass === m.reproduction.expected_failure_on_baseline.tap.pass,
    };

    const criteria = [];
    for (const a of m.acceptance_criteria) {
      const counted = a.scope === 'public' || (a.scope === 'sealed' && !!opts.holdout);
      let result = 'NOT_CHECKED';
      let detail;
      if (a.kind === 'result') result = report.results[a.ref]?.result ?? 'NOT_CHECKED';
      else if (a.kind === 'source_changed' || a.kind === 'max_changed_lines') {
        let changed = 0;
        let files = 0;
        const rels = new Set([...base.files.keys(), ...cand.files.keys()].filter((r) => matchesAny(m.allowed_source_paths, r)));
        for (const rel of rels) {
          const a0 = base.files.get(rel) ? readFileSync(base.files.get(rel), 'utf8') : null;
          const b0 = cand.files.get(rel) ? readFileSync(cand.files.get(rel), 'utf8') : null;
          if (a0 === b0) continue;
          files += 1;
          changed += changedLines(a0, b0);
        }
        detail = { files_changed: files, lines_changed: changed };
        result = a.kind === 'source_changed' ? (files > 0 ? 'PASS' : 'FAIL') : changed <= a.limit ? 'PASS' : 'FAIL';
      } else if (a.kind === 'holdout') {
        result = hold ? (hold.passed ? 'PASS' : 'FAIL') : 'NOT_CHECKED';
        detail = hold ? hold.tap : 'the sealed holdout was not supplied; this criterion counts only at sealed scope';
      }
      criteria.push({ id: a.id, kind: a.kind, scope: a.scope, counted, result, ...(detail !== undefined ? { detail } : {}) });
    }
    const counted = criteria.filter((c) => c.counted);
    report.results.acceptance_criteria_met = {
      result: counted.some((c) => c.result === 'FAIL') ? 'FAIL' : counted.some((c) => c.result === 'NOT_CHECKED') ? 'NOT_CHECKED' : 'PASS',
      criteria,
    };
    report.results.tamper = { result: findings.length ? 'DETECTED' : 'NONE', findings };

    const r = report.results;
    const four = [r.protected_commands_executed, r.protected_tests_passed, r.original_failure_fixed, r.acceptance_criteria_met].map((x) => x.result);
    if (r.tamper.result === 'DETECTED' || four.includes('FAIL')) return finish('FAIL');
    if (four.includes('NOT_CHECKED')) return finish('NOT_CHECKED');
    return finish('PASS');
  } finally {
    if (!opts.keepWorkdir) rmSync(root, { recursive: true, force: true });
    else report.workdir = root;
  }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--package') o.package = v();
    else if (a === '--candidate') o.candidate = v();
    else if (a === '--holdout') o.holdout = v();
    else if (a === '--expect-manifest-sha256') o.expectManifest = v();
    else if (a === '--per-command-timeout-s') o.perCommandTimeoutS = Number(v()); // may only LOWER the manifest's limit
    else if (a === '--keep-workdir') o.keepWorkdir = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.package || !o.candidate) throw new Error('usage: evaluate.mjs --package <dir> --candidate <dir> [--holdout <dir>] [--expect-manifest-sha256 <hex>]');
  if (o.perCommandTimeoutS !== undefined && !(o.perCommandTimeoutS > 0)) throw new Error('--per-command-timeout-s must be positive');
  return o;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  let code = EXIT.NOT_CHECKED;
  try {
    const report = await evaluate(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    code = EXIT[report.verdict];
  } catch (e) {
    // An evaluator that could not run has not graded anything: NOT_CHECKED, never a pass.
    process.stdout.write(JSON.stringify({ format: FORMAT, verdict: 'NOT_CHECKED', error: String(e && e.message) }, null, 2) + '\n');
  }
  process.exitCode = code;
}
