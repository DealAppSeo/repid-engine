/**
 * The orphaned-jest-worker reaper.
 *
 * The selection rule is the whole risk: this thing sends SIGKILL, and we deliberately
 * run four lanes concurrently, so a rule that is even slightly too broad kills a
 * teammate's suite mid-run. These tests pin what it will and will not touch.
 *
 * Measured cause, 2026-08-03: two cancelled runs left 101 orphaned workers holding
 * 4,020 CPU-seconds. A ~90 s suite stopped finishing in ten minutes, lane wall-clocks
 * diverged 438 s vs 130 s for comparable work, and the failing-suite set flapped.
 */

// Plain CommonJS on purpose — it runs as jest `globalSetup`, before any transform.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { selectOrphans, selfAndAncestorsFrom, reap } = require('../scripts/ci/reap-orphan-jest.js');

type Proc = { pid: number; ppid: number; cmd: string };

const JEST = 'node C:/repo/node_modules/jest-worker/build/workers/processChild.js';
const OTHER = 'node scripts/some-server.js';

describe('selectOrphans — what it will kill', () => {
  it('THE TARGET: a jest worker whose parent is gone', () => {
    const procs: Proc[] = [
      { pid: 100, ppid: 1, cmd: 'node self' }, // the caller
      { pid: 500, ppid: 999, cmd: JEST }, // parent 999 absent
    ];
    expect(selectOrphans(procs, 100).map((p: Proc) => p.pid)).toEqual([500]);
  });

  it('SPARES a jest worker whose parent is still alive — a concurrent lane', () => {
    // Four lanes run at once here. Killing a live pool is the failure mode that would
    // make this script worse than the bug.
    const procs: Proc[] = [
      { pid: 1, ppid: 0, cmd: 'init' },
      { pid: 100, ppid: 1, cmd: 'node self' },
      { pid: 400, ppid: 1, cmd: 'node jest --config jest.config.js' }, // live parent
      { pid: 500, ppid: 400, cmd: JEST },
    ];
    expect(selectOrphans(procs, 100)).toHaveLength(0);
  });

  it('SPARES non-jest processes even when orphaned — not its business', () => {
    const procs: Proc[] = [
      { pid: 100, ppid: 1, cmd: 'node self' },
      { pid: 700, ppid: 999, cmd: OTHER },
    ];
    expect(selectOrphans(procs, 100)).toHaveLength(0);
  });

  it('NEVER kills itself, even if its own parent is gone', () => {
    const procs: Proc[] = [{ pid: 100, ppid: 999, cmd: `${JEST} self` }];
    expect(selectOrphans(procs, 100)).toHaveLength(0);
  });

  it('NEVER kills an ancestor — the run that invoked it', () => {
    // globalSetup runs inside the jest parent, so the parent chain is jest-shaped and
    // would otherwise match the /jest/ filter.
    const procs: Proc[] = [
      { pid: 100, ppid: 90, cmd: 'node globalSetup' },
      { pid: 90, ppid: 80, cmd: 'node jest --config jest.config.js' },
      { pid: 80, ppid: 999, cmd: 'npx jest' }, // orphaned by shell exit, still ours
    ];
    expect(selectOrphans(procs, 100)).toHaveLength(0);
  });

  it('does not use process AGE — a legitimate long suite must survive', () => {
    // Age was the obvious heuristic and it is wrong: a four-lane suite can exceed any
    // threshold. Nothing in the input carries age, which is the point.
    const procs: Proc[] = [
      { pid: 1, ppid: 0, cmd: 'init' },
      { pid: 100, ppid: 1, cmd: 'node self' },
      { pid: 400, ppid: 1, cmd: 'node jest' },
      { pid: 500, ppid: 400, cmd: JEST },
    ];
    expect(selectOrphans(procs, 100)).toHaveLength(0);
    expect(Object.keys(procs[2]!)).not.toContain('age');
  });

  it('reaps several orphans from different dead parents at once', () => {
    const procs: Proc[] = [
      { pid: 100, ppid: 1, cmd: 'node self' },
      { pid: 501, ppid: 901, cmd: JEST },
      { pid: 502, ppid: 902, cmd: JEST },
      { pid: 503, ppid: 903, cmd: JEST },
    ];
    expect(selectOrphans(procs, 100).map((p: Proc) => p.pid).sort()).toEqual([501, 502, 503]);
  });

  it('THE DANGEROUS CASE: a jest PARENT is never reaped, even when orphaned', () => {
    // First version matched /jest/ and would have killed this. Our lanes run DETACHED,
    // so a jest parent whose shell has exited is the normal case — the rule would have
    // killed live suites. Only workers leak, and only workers are targeted.
    const procs: Proc[] = [
      { pid: 100, ppid: 1, cmd: 'node self' },
      { pid: 400, ppid: 999, cmd: 'node jest --config jest.config.js' }, // orphaned PARENT
    ];
    expect(selectOrphans(procs, 100)).toHaveLength(0);
  });

  it('matches the worker shape case-insensitively, and nothing merely jest-ish', () => {
    const procs: Proc[] = [
      { pid: 100, ppid: 1, cmd: 'node self' },
      { pid: 600, ppid: 999, cmd: 'node JEST-WORKER/build/workers/processChild.js' },
      { pid: 601, ppid: 999, cmd: 'node jestful-server.js' },
      { pid: 602, ppid: 999, cmd: 'node digest-worker.js' },
    ];
    const ids = selectOrphans(procs, 100).map((p: Proc) => p.pid);
    expect(ids).toEqual([600]);
  });
});

describe('ancestor walk', () => {
  it('collects the whole chain to the root', () => {
    const procs: Proc[] = [
      { pid: 10, ppid: 5, cmd: 'a' },
      { pid: 5, ppid: 2, cmd: 'b' },
      { pid: 2, ppid: 0, cmd: 'c' },
    ];
    expect([...selfAndAncestorsFrom(procs, 10)].sort((a, b) => a - b)).toEqual([2, 5, 10]);
  });

  it('terminates on a cycle rather than hanging — PID reuse can create one', () => {
    const procs: Proc[] = [
      { pid: 1, ppid: 2, cmd: 'a' },
      { pid: 2, ppid: 1, cmd: 'b' },
    ];
    expect([...selfAndAncestorsFrom(procs, 1)].sort()).toEqual([1, 2]);
  });

  it('stops cleanly when the parent is not in the list', () => {
    expect([...selfAndAncestorsFrom([{ pid: 10, ppid: 999, cmd: 'a' }], 10)]).toEqual([10]);
  });
});

describe('fails open — housekeeping must never block the suite', () => {
  it('a dry run on the real machine returns a result and does not throw', () => {
    // This is the live path, running inside a real suite. It must be safe here.
    const logged: string[] = [];
    const r = reap({ dryRun: true, log: (m: string) => logged.push(m) });
    expect(typeof r.scanned).toBe('number');
    expect(r.killed).toBe(0);
  });

  it('the reaper is wired as jest globalSetup — otherwise it never runs', () => {
    // The un-wired-gate failure, one file over. A reaper nobody calls is a comment.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require('../jest.config.js');
    expect(cfg.globalSetup).toMatch(/reap-orphan-jest/);
  });

  it('THE REGRESSION: the module EXPORT is a function, or it blocks every test', () => {
    // Shipped once as `module.exports = {…}` with a `.default`. jest rejects that with
    // "globalSetup file must export a function" and the entire suite fails to start —
    // the fail-open internals never get a chance to run. The export contract is the
    // real gate, so it is asserted here rather than assumed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../scripts/ci/reap-orphan-jest.js');
    expect(typeof mod).toBe('function');
    expect(typeof mod.reap).toBe('function');
    expect(typeof mod.selectOrphans).toBe('function');
  });
});
