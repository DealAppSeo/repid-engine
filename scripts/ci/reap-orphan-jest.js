#!/usr/bin/env node
/**
 * reap-orphan-jest.js — kill jest workers whose parent is gone, before a run starts.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE MEASURED BUG
 * ════════════════════════════════════════════════════════════════════════════════
 * `npm test` runs `jest --forceExit`, which handles a *clean* exit. It does nothing
 * when the jest PARENT is killed — a CI timeout, Ctrl-C, an agent harness cancelling a
 * long command. On Windows the worker pool is not in a job object tied to the parent,
 * so the workers survive, detach, and keep spinning.
 *
 * Observed 2026-08-03 on this machine: **121 node processes holding 4,020 CPU-seconds**,
 * 101 of them orphaned jest workers from two cancelled runs. The full suite, which
 * takes ~90 s on an idle machine, stopped finishing inside TEN MINUTES.
 *
 * The damage is worse than slowness, because it is silent and it corrupts measurement:
 *   - parallel lanes reported 438 s vs 130 s wall-clock for comparable work;
 *   - the set of failing suites FLAPPED between runs, because credential-dependent
 *     suites lose a 5 000 ms race under load and which one loses is arbitrary;
 *   - several lane baselines were therefore recorded on a degraded machine.
 * A test count taken under an unknown CPU load is a measurement without its ruler.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY "PARENT IS GONE" IS THE RIGHT SIGNAL
 * ════════════════════════════════════════════════════════════════════════════════
 * The obvious heuristics are both wrong here:
 *   - "kill jest processes older than N minutes" kills a legitimate concurrent run —
 *     and we deliberately run four lanes at once, where a suite CAN exceed any N.
 *   - "kill all jest processes" is the same bug with more confidence.
 *
 * A worker whose parent PID no longer exists cannot be reporting to anyone. It is
 * finished by definition, whatever its age. That is precise, needs no timing guess,
 * and is safe while other suites are running.
 *
 * Self and ancestors are excluded unconditionally, so this can never reap the run that
 * invoked it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * FAILS OPEN
 * ════════════════════════════════════════════════════════════════════════════════
 * Any error — no PowerShell, no `ps`, a permission denial — logs and returns. A
 * housekeeping step must never be able to stop the test suite from running. It is
 * wired as jest `globalSetup`, so a throw here would block every test in the repo.
 *
 * Usage:  node scripts/ci/reap-orphan-jest.js [--dry-run]
 *         (also invoked automatically as jest globalSetup)
 */

const { execFileSync } = require('node:child_process');

/** Every PID from here up to the root, so we never reap our own run. */
function selfAndAncestors(procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = new Set();
  let cur = process.pid;
  // The bound stops a corrupted parent chain (or PID reuse making a cycle) from
  // looping forever. 64 is far deeper than any real process tree here.
  for (let i = 0; i < 64 && cur && !chain.has(cur); i++) {
    chain.add(cur);
    cur = byPid.get(cur)?.ppid;
  }
  return chain;
}

function listWindows() {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  if (!out) return [];
  const raw = JSON.parse(out);
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((p) => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId),
    cmd: String(p.CommandLine || ''),
  }));
}

function listPosix() {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null;
    })
    .filter(Boolean);
}

/**
 * Which processes are orphaned jest workers?
 *
 * Pure, so the selection rule is unit-testable without spawning anything — the logic
 * that decides what to kill is exactly the part that must not be guessed at.
 */
/**
 * A jest WORKER, specifically — not a jest parent.
 *
 * `/jest/` alone was the first version and it was dangerous: a jest PARENT launched
 * from a shell that has since exited has an absent ppid, so it looks orphaned and would
 * have been killed mid-run. Our lanes run detached, so that is the normal case, not an
 * edge case — the rule would have killed live suites.
 *
 * Workers are the class that actually leaks (101 of them, measured), and they are
 * identifiable: jest spawns them through `jest-worker`'s `processChild`. A parent is
 * never reaped, whatever its parentage — if a parent is genuinely stranded it is one
 * process, not a hundred, and killing it risks a running suite for no real saving.
 */
const WORKER_RE = /jest[-_]worker|processChild/i;

function selectOrphans(procs, selfPid = process.pid) {
  const live = new Set(procs.map((p) => p.pid));
  const protectedPids = selfAndAncestorsFrom(procs, selfPid);
  return procs.filter(
    (p) =>
      WORKER_RE.test(p.cmd) &&
      !protectedPids.has(p.pid) &&
      // The parent is gone: nobody is collecting this worker's results.
      !live.has(p.ppid),
  );
}

function selfAndAncestorsFrom(procs, startPid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = new Set([startPid]);
  let cur = byPid.get(startPid)?.ppid;
  // Walk only through pids we can actually see. Stopping at the first unknown parent
  // keeps the protected set to real ancestors instead of trailing a dead pid that may
  // since have been reused by an unrelated process.
  // The bound stops a cycle from PID reuse looping forever; 64 is far deeper than any
  // real tree here.
  for (let i = 0; i < 64 && cur && byPid.has(cur) && !chain.has(cur); i++) {
    chain.add(cur);
    cur = byPid.get(cur)?.ppid;
  }
  return chain;
}

function reap({ dryRun = false, log = console.error } = {}) {
  let procs;
  try {
    procs = process.platform === 'win32' ? listWindows() : listPosix();
  } catch (e) {
    log(`[reap-jest] could not enumerate processes (${e.message}) — skipping, not failing.`);
    return { scanned: 0, orphans: [], killed: 0 };
  }

  let orphans;
  try {
    orphans = selectOrphans(procs);
  } catch (e) {
    log(`[reap-jest] selection failed (${e.message}) — skipping.`);
    return { scanned: procs.length, orphans: [], killed: 0 };
  }

  if (orphans.length === 0) return { scanned: procs.length, orphans: [], killed: 0 };

  if (dryRun) {
    log(`[reap-jest] would reap ${orphans.length} orphaned jest worker(s): ${orphans.map((o) => o.pid).join(', ')}`);
    return { scanned: procs.length, orphans, killed: 0 };
  }

  let killed = 0;
  for (const o of orphans) {
    try {
      process.kill(o.pid, 'SIGKILL');
      killed++;
    } catch {
      // Already gone, or not ours to kill. Either way, not our problem to escalate.
    }
  }
  log(
    `[reap-jest] reaped ${killed} orphaned jest worker(s) from cancelled runs. ` +
      `They survive a killed parent on this platform and silently degrade every ` +
      `subsequent timing measurement.`,
  );
  return { scanned: procs.length, orphans, killed };
}

/**
 * jest requires `module.exports` to BE the function for `globalSetup` — not an object
 * with a `.default`. Getting that wrong throws "globalSetup file must export a
 * function" and BLOCKS EVERY TEST IN THE REPO, which is exactly what this script's
 * fail-open internals are written to avoid. The lesson worth keeping: fail-open logic
 * inside a module does nothing if the module's export CONTRACT is wrong. Pinned by a
 * test that requires this file and asserts it is callable.
 */
async function globalSetup() {
  reap();
}

module.exports = globalSetup;
module.exports.default = globalSetup;
module.exports.reap = reap;
module.exports.selectOrphans = selectOrphans;
module.exports.selfAndAncestorsFrom = selfAndAncestorsFrom;

if (require.main === module) {
  const r = reap({ dryRun: process.argv.includes('--dry-run') });
  if (r.orphans.length === 0) console.error('[reap-jest] no orphaned jest workers found.');
}
