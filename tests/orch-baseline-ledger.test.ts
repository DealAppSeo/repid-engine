/**
 * The per-environment baseline, and the rule that refuses an incomparable delta.
 *
 * Every case here is a function call. Nothing spawns jest, ts-node, or a shell — the
 * whole file runs in milliseconds, which is the condition for this machinery being
 * allowed to exist at all.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  certifyDelta,
  collectedSuiteDelta,
  environmentId,
  isCollectedSuite,
  latestRun,
  putRun,
  readLedger,
  summariseJestRun,
  writeLedger,
  type CollectionConfig,
  type RunMeasurement,
} from '../src/orchestration/baseline-ledger';

const ENV_A = 'win32-x64-node20.11.0-aaaaaaaaaaaa';
const ENV_B = 'win32-x64-node20.11.0-bbbbbbbbbbbb';

const run = (over: Partial<RunMeasurement> = {}): RunMeasurement => ({
  phase: 'before',
  commit: 'e24ce7f0000000000000000000000000000000aa',
  suites: 294,
  tests: 3000,
  passedTests: 2900,
  failedSuites: 4,
  failedTests: 100,
  complete: true,
  environmentId: ENV_A,
  recordedAt: '2026-08-04T00:00:00.000Z',
  ...over,
});

const after = (over: Partial<RunMeasurement> = {}): RunMeasurement =>
  run({ phase: 'after', commit: 'a1b2c3d0000000000000000000000000000000bb', ...over });

// ---------------------------------------------------------------------------

describe('summariseJestRun — refuses rather than defaulting', () => {
  it('reads the counts out of a jest --json summary', () => {
    const r = summariseJestRun({
      numTotalTestSuites: 294,
      numTotalTests: 3000,
      numPassedTests: 2900,
      numFailedTestSuites: 4,
      numFailedTests: 100,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        suites: 294,
        tests: 3000,
        passedTests: 2900,
        failedSuites: 4,
        failedTests: 100,
        complete: true,
      },
    });
  });

  it('marks an interrupted run incomplete', () => {
    const r = summariseJestRun({
      numTotalTestSuites: 12,
      numTotalTests: 30,
      numPassedTests: 20,
      wasInterrupted: true,
    });
    expect(r.ok && r.value.complete).toBe(false);
  });

  // A missing suite count silently read as 0 would certify a spectacular fake
  // improvement. This is the single most expensive default this module could have.
  it('refuses output that is missing the counts instead of defaulting to zero', () => {
    const r = summariseJestRun({ success: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/numTotalTestSuites/);
  });

  it('refuses a non-object', () => {
    expect(summariseJestRun('294').ok).toBe(false);
    expect(summariseJestRun(null).ok).toBe(false);
  });
});

describe('environmentId', () => {
  it('separates two checkouts on the same machine', () => {
    const base = { platform: 'win32', arch: 'x64', nodeVersion: '20.11.0' };
    expect(environmentId({ ...base, checkoutPath: '/repo' })).not.toBe(
      environmentId({ ...base, checkoutPath: '/repo/.git/worktrees/lane-a' }),
    );
  });

  it('is stable for the same inputs', () => {
    const p = { platform: 'linux', arch: 'arm64', nodeVersion: '22.0.0', checkoutPath: '/x' };
    expect(environmentId(p)).toBe(environmentId(p));
  });
});

// ---------------------------------------------------------------------------

describe('which files jest would collect as suites', () => {
  const cfg: CollectionConfig = {
    roots: ['tests', 'src/hal/lib/__tests__'],
    ignorePrefixes: ['tests/integration/'],
    suffix: '.test.ts',
  };

  it('collects a test under a root', () => {
    expect(isCollectedSuite('tests/orch-report-gate.test.ts', cfg)).toBe(true);
    expect(isCollectedSuite('src/hal/lib/__tests__/adversarial.test.ts', cfg)).toBe(true);
  });

  it('does not collect the six unrooted __tests__ dirs — jest never sees them', () => {
    expect(isCollectedSuite('src/services/__tests__/thing.test.ts', cfg)).toBe(false);
    expect(isCollectedSuite('src/routes/__tests__/x.test.ts', cfg)).toBe(false);
  });

  it('honours the ignore prefix', () => {
    expect(isCollectedSuite('tests/integration/slow.test.ts', cfg)).toBe(false);
  });

  it('is not fooled by a prefix that is not a path segment', () => {
    expect(isCollectedSuite('tests-scratch/x.test.ts', cfg)).toBe(false);
  });

  it('ignores non-test files and normalises windows separators', () => {
    expect(isCollectedSuite('tests/helper.ts', cfg)).toBe(false);
    expect(isCollectedSuite('tests\\orch-x.test.ts', cfg)).toBe(true);
  });

  it('counts added minus deleted, and ignores modified files entirely', () => {
    expect(
      collectedSuiteDelta(
        {
          added: ['tests/orch-a.test.ts', 'tests/orch-b.test.ts', 'src/orchestration/x.ts'],
          deleted: ['tests/old.test.ts'],
        },
        cfg,
      ),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('certifyDelta — the comparability rule', () => {
  it('certifies when the suite change is exactly what the diff explains', () => {
    const c = certifyDelta(run(), after({ suites: 296, tests: 3020, passedTests: 2925 }), {
      expectedSuiteDelta: 2,
    });
    expect(c.certified).toBe(true);
    if (!c.certified) return;
    expect(c.delta.value).toBe(25);
    expect(c.suiteDelta).toBe(2);
    expect(c.testDelta).toBe(20);
  });

  // THE case this module exists for: one briefed count, eight environments, wrong in
  // all of them. A borrowed baseline shifts the suite count by the amount the
  // environments differ, and the diff cannot explain that shift.
  it('refuses a baseline borrowed from another environment', () => {
    const c = certifyDelta(run({ environmentId: ENV_B }), after({ suites: 328 }), {
      expectedSuiteDelta: 0,
    });
    expect(c.certified).toBe(false);
    expect(c.certified === false && c.reason).toMatch(/different environments/);
  });

  it('refuses when the suite count moved by more than the diff accounts for', () => {
    const c = certifyDelta(run({ suites: 294 }), after({ suites: 328 }), {
      expectedSuiteDelta: 1,
    });
    expect(c.certified).toBe(false);
    // The refusal has to carry the numbers, or it is just a "no".
    expect(c.certified === false && c.reason).toMatch(/34/);
    expect(c.certified === false && c.reason).toMatch(/294 → 328/);
  });

  it('refuses when the suite count did not move but the diff added a suite', () => {
    const c = certifyDelta(run(), after(), { expectedSuiteDelta: 1 });
    expect(c.certified).toBe(false);
  });

  it('refuses an interrupted run — a floor is not a count', () => {
    const c = certifyDelta(run(), after({ complete: false }), { expectedSuiteDelta: 0 });
    expect(c.certified).toBe(false);
    expect(c.certified === false && c.reason).toMatch(/floor, not a/);
  });

  it('refuses when both runs are at the same commit', () => {
    const c = certifyDelta(run(), after({ commit: run().commit }), { expectedSuiteDelta: 0 });
    expect(c.certified).toBe(false);
    expect(c.certified === false && c.reason).toMatch(/no change between them/);
  });

  it('refuses runs handed over in the wrong order', () => {
    const c = certifyDelta(after(), run(), { expectedSuiteDelta: 0 });
    expect(c.certified).toBe(false);
    expect(c.certified === false && c.reason).toMatch(/phases are wrong/);
  });

  it('handles a change that DELETES a suite', () => {
    const c = certifyDelta(run(), after({ suites: 293 }), { expectedSuiteDelta: -1 });
    expect(c.certified).toBe(true);
  });

  it('attaches a ruler carrying both suite counts and the commit range', () => {
    const c = certifyDelta(run(), after({ suites: 295 }), { expectedSuiteDelta: 1 });
    expect(c.certified).toBe(true);
    if (!c.certified) return;
    expect(c.delta.corpus).toContain('e24ce7f');
    expect(c.delta.corpus).toContain('a1b2c3d');
    expect(c.delta.config).toContain('294→295 suites collected');
    expect(c.delta.config).toContain(ENV_A);
  });

  // Certifying is a small claim, and the note has to say so — otherwise the next
  // reader treats "certified" as "these runs were identical", which it is not.
  it('states what certification does NOT prove', () => {
    const c = certifyDelta(run(), after({ suites: 294 }), { expectedSuiteDelta: 0 });
    expect(c.certified && c.note).toMatch(/does not prove/i);
  });
});

// ---------------------------------------------------------------------------

describe('ledger storage', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'orch-ledger-'));

  it('round-trips through disk', () => {
    const p = join(dir(), 'ledger.json');
    writeLedger(p, putRun(readLedger(p), run()));
    expect(latestRun(readLedger(p), 'before', ENV_A)).toEqual(run());
  });

  it('treats a missing ledger as empty rather than throwing', () => {
    expect(readLedger(join(dir(), 'nope.json'))).toEqual({ version: 1, runs: [] });
  });

  // Losing an old baseline costs one re-run. Refusing to start costs the sprint.
  it('treats a corrupt ledger as empty so a lane can still record a fresh baseline', () => {
    const p = join(dir(), 'bad.json');
    writeFileSync(p, '{ not json');
    expect(readLedger(p).runs).toEqual([]);
  });

  it('replaces the run for the same phase and environment', () => {
    let l = putRun({ version: 1, runs: [] }, run({ suites: 100 }));
    l = putRun(l, run({ suites: 294 }));
    expect(l.runs).toHaveLength(1);
    expect(latestRun(l, 'before', ENV_A)?.suites).toBe(294);
  });

  it('keeps another environment’s run separate instead of overwriting it', () => {
    let l = putRun({ version: 1, runs: [] }, run({ environmentId: ENV_B, suites: 328 }));
    l = putRun(l, run({ suites: 294 }));
    expect(l.runs).toHaveLength(2);
    expect(latestRun(l, 'before', ENV_A)?.suites).toBe(294);
    expect(latestRun(l, 'before', ENV_B)?.suites).toBe(328);
  });

  it('finds nothing for an environment that never recorded one', () => {
    const l = putRun({ version: 1, runs: [] }, run());
    expect(latestRun(l, 'before', 'some-other-env')).toBeUndefined();
    expect(latestRun(l, 'after', ENV_A)).toBeUndefined();
  });
});
