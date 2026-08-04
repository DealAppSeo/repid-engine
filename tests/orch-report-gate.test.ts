/**
 * The gate that was cold: `evaluateHandoff` / `canAssign` / `cheapestCapableLane` /
 * `eligibleVerifiers` had 63 tests and no caller. These tests exercise the CALLER.
 *
 * In-process throughout, including the CLI — `runCli` is invoked as a function with a
 * captured io, never spawned. Spawning `npx ts-node` per case is what made the first
 * attempt at this take longer than ten minutes.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunMeasurement } from '../src/orchestration/baseline-ledger';
import {
  DEFAULT_SPEC_ID,
  EXIT_ADVANCE,
  EXIT_COULD_NOT_RUN,
  EXIT_HOLD,
  LANE_SPRINT_V1,
  formatGateResult,
  gradeLaneReport,
  parseReport,
} from '../src/orchestration/lane-report-gate';
import { runCli, collectionConfigFromJest, type CliIo } from '../scripts/lane-report';

const ENV = 'win32-x64-node20.11.0-aaaaaaaaaaaa';

const before: RunMeasurement = {
  phase: 'before',
  commit: 'e24ce7f0000000000000000000000000000000aa',
  suites: 294,
  tests: 3000,
  passedTests: 2900,
  failedSuites: 4,
  failedTests: 100,
  complete: true,
  environmentId: ENV,
  recordedAt: '2026-08-04T00:00:00.000Z',
};

const afterRun: RunMeasurement = {
  ...before,
  phase: 'after',
  commit: 'a1b2c3d0000000000000000000000000000000bb',
  suites: 296,
  tests: 3040,
  passedTests: 2940,
};

/** A report that should ADVANCE, so every failing case differs by exactly one thing. */
const goodReport = () => ({
  taskId: 'orch-1',
  lane: 'CC',
  touchesLiveState: false,
  outputs: {
    summary:
      'Wired evaluateHandoff into a CLI and added the per-environment baseline ledger; no ' +
      'production surface is touched.',
    delta: {
      value: 40,
      corpus: 'jest suite @ e24ce7f..a1b2c3d',
      config: '294→296 suites collected (+2 from this change)',
    },
    branch: 'feat/orch-2026-08-04-wire-the-gate',
    pr: 'https://github.com/DealAppSeo/repid-engine/pull/999',
    verdict: 'ready for review',
  },
  voices: [{ lane: 'GA', agrees: true }],
  runs: { before, after: afterRun, expectedSuiteDelta: 2 },
});

// ---------------------------------------------------------------------------
// EXIT 2 — the gate did not reach a verdict. Never conflated with "fail".
// ---------------------------------------------------------------------------

describe('could-not-run is a distinct outcome from hold', () => {
  it('refuses a non-object', () => {
    expect(gradeLaneReport('nope').exit).toBe(EXIT_COULD_NOT_RUN);
  });

  it('refuses a report with no taskId', () => {
    const r = gradeLaneReport({ lane: 'CC', touchesLiveState: false, outputs: {} });
    expect(r.exit).toBe(EXIT_COULD_NOT_RUN);
  });

  // Defaulting this would silently pick the answer nobody stated — and it is the field
  // that decides whether a co-sign is required at all.
  it('refuses when touchesLiveState is not stated explicitly', () => {
    const { touchesLiveState, ...rest } = goodReport();
    void touchesLiveState;
    const r = gradeLaneReport(rest);
    expect(r.exit).toBe(EXIT_COULD_NOT_RUN);
    expect(formatGateResult(r)).toMatch(/touchesLiveState/);
  });

  it('refuses an unknown lane rather than guessing its capabilities', () => {
    const r = gradeLaneReport({ ...goodReport(), lane: 'ORCH' });
    expect(r.exit).toBe(EXIT_COULD_NOT_RUN);
    expect(formatGateResult(r)).toMatch(/not in the lane registry/);
  });

  it('refuses an unknown spec', () => {
    expect(gradeLaneReport(goodReport(), { specId: 'nope' }).exit).toBe(EXIT_COULD_NOT_RUN);
  });

  it('refuses a hand-asserted expectedSuiteDelta that is not an integer', () => {
    const r = goodReport();
    const bad = { ...r, runs: { ...r.runs, expectedSuiteDelta: 'two' } };
    expect(gradeLaneReport(bad).exit).toBe(EXIT_COULD_NOT_RUN);
  });

  it('refuses a voice whose agreement is not true/false/null', () => {
    const r = { ...goodReport(), voices: [{ lane: 'GA', agrees: 'yes' }] };
    expect(gradeLaneReport(r).exit).toBe(EXIT_COULD_NOT_RUN);
  });

  it('parseReport accepts a well-formed report', () => {
    const p = parseReport(goodReport());
    expect(p.ok).toBe(true);
    expect(p.ok && p.value.lane).toBe('CC');
  });
});

// ---------------------------------------------------------------------------
// EXIT 0
// ---------------------------------------------------------------------------

describe('advance', () => {
  it('advances a complete, co-signed, certified report', () => {
    const r = gradeLaneReport(goodReport());
    expect(r.exit).toBe(EXIT_ADVANCE);
    expect(r.status).toBe('ADVANCE');
    expect(r.certification?.certified).toBe(true);
  });

  it('says out loud what certification does not prove', () => {
    expect(formatGateResult(gradeLaneReport(goodReport()))).toMatch(/Caveat:/);
  });

  it('advances inert work with no co-sign at all — a branch nobody read costs nothing', () => {
    const r = gradeLaneReport({ ...goodReport(), voices: [] });
    expect(r.exit).toBe(EXIT_ADVANCE);
    expect(r.decision?.verification).toBe('UNVERIFIED');
  });
});

// ---------------------------------------------------------------------------
// EXIT 1 — the reason the gate exists
// ---------------------------------------------------------------------------

describe('hold — required outputs', () => {
  // The headline: a bare test count is exactly what eight prose-graded reports carried.
  it('refuses a bare number as a delta', () => {
    const r = goodReport();
    const bad = { ...r, outputs: { ...r.outputs, delta: 40 } };
    const g = gradeLaneReport(bad);
    expect(g.exit).toBe(EXIT_HOLD);
    expect(formatGateResult(g)).toMatch(/must carry its ruler/);
  });

  it('refuses a delta whose ruler is a placeholder', () => {
    const r = goodReport();
    const bad = {
      ...r,
      outputs: { ...r.outputs, delta: { value: 40, corpus: 'N/A', config: 'TBD' } },
    };
    expect(gradeLaneReport(bad).exit).toBe(EXIT_HOLD);
  });

  it('refuses a placeholder summary', () => {
    const r = goodReport();
    expect(gradeLaneReport({ ...r, outputs: { ...r.outputs, summary: 'LGTM' } }).exit).toBe(
      EXIT_HOLD,
    );
  });

  it('refuses a missing PR link and names it', () => {
    const r = goodReport();
    const { pr, ...outputs } = r.outputs;
    void pr;
    const g = gradeLaneReport({ ...r, outputs });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(g.decision?.problems.map((p) => p.key)).toContain('pr');
  });
});

describe('hold — capability, because a lane cannot report what it could not measure', () => {
  // T12 has `reasoning` and nothing else. 18/18 of its nightly reports contained zero
  // real measurements. The gate refuses the REPORT, not just the routing.
  it('refuses a report from a lane that could not have done the work', () => {
    const g = gradeLaneReport({ ...goodReport(), lane: 'T12' });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(formatGateResult(g)).toMatch(/lacks repo_write/);
  });

  it('names the cheapest lane that could have done it', () => {
    // GA is cost tier 1 and has repo_write; CC (tier 2) and SEAN (tier 3) also do.
    expect(formatGateResult(gradeLaneReport({ ...goodReport(), lane: 'T12' }))).toMatch(
      /Route it to GA \(cost tier 1\)/,
    );
  });
});

describe('hold — verification', () => {
  it('holds live-state work with no independent voice', () => {
    const g = gradeLaneReport({ ...goodReport(), touchesLiveState: true, voices: [] });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(formatGateResult(g)).toMatch(/Silence is not assent/);
  });

  it('holds when a verifier disputes, even against agreement', () => {
    const g = gradeLaneReport({
      ...goodReport(),
      voices: [
        { lane: 'GA', agrees: true },
        { lane: 'XC', agrees: false },
      ],
    });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(g.decision?.verification).toBe('DISPUTED');
  });

  it('holds a report signed only by its own producer', () => {
    const g = gradeLaneReport({ ...goodReport(), voices: [{ lane: 'CC', agrees: true }] });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(g.decision?.verification).toBe('SELF_SIGNED');
  });

  // A co-sign from a lane that cannot reach the evidence is worse than no co-sign,
  // because it carries a signature. It is discarded, not counted.
  it('discards a co-sign from a lane that cannot reach the evidence', () => {
    const g = gradeLaneReport({
      ...goodReport(),
      touchesLiveState: true,
      voices: [{ lane: 'T12', agrees: true }],
    });
    expect(g.ignoredVoices).toEqual(['T12']);
    expect(g.exit).toBe(EXIT_HOLD);
    expect(g.decision?.verification).toBe('UNVERIFIED');
  });
});

describe('hold — the delta must be re-derivable', () => {
  it('refuses a report with no recorded runs at all', () => {
    const r = goodReport();
    const { runs, ...rest } = r;
    void runs;
    const g = gradeLaneReport(rest);
    expect(g.exit).toBe(EXIT_HOLD);
    expect(formatGateResult(g)).toMatch(/environment-scoped/);
  });

  it('refuses a baseline borrowed from another environment', () => {
    const r = goodReport();
    const g = gradeLaneReport({
      ...r,
      runs: { ...r.runs, before: { ...before, environmentId: 'some-other-env' } },
    });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(g.certification?.certified).toBe(false);
  });

  it('refuses when the suite count moved by more than the diff explains', () => {
    const r = goodReport();
    const g = gradeLaneReport({
      ...r,
      runs: { ...r.runs, after: { ...afterRun, suites: 328 } },
    });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(formatGateResult(g)).toMatch(/did not collect the same/);
  });

  // The case a prose review never catches: the runs are fine, the stated number is not
  // the one they produce.
  it('refuses a stated delta that its own runs contradict', () => {
    const r = goodReport();
    const g = gradeLaneReport({
      ...r,
      outputs: { ...r.outputs, delta: { ...r.outputs.delta, value: 400 } },
    });
    expect(g.exit).toBe(EXIT_HOLD);
    expect(formatGateResult(g)).toMatch(/reported 400 but the recorded runs yield 40/);
  });
});

// ---------------------------------------------------------------------------
// The spec itself
// ---------------------------------------------------------------------------

describe('the spec', () => {
  it('types delta as a measurement, so a bare count can never pass', () => {
    expect(LANE_SPRINT_V1.requiredOutputs.find((o) => o.key === 'delta')?.kind).toBe('measurement');
  });

  it('is the default spec', () => {
    expect(DEFAULT_SPEC_ID).toBe(LANE_SPRINT_V1.id);
  });
});

// ---------------------------------------------------------------------------
// The CLI shell — driven in-process, never spawned
// ---------------------------------------------------------------------------

describe('scripts/lane-report.ts is a shell over the module', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (s) => out.push(s), err: (s) => err.push(s) };
    return { io, out, err };
  };

  const writeReport = (body: unknown): string => {
    const p = join(mkdtempSync(join(tmpdir(), 'orch-cli-')), 'report.json');
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  it('grade returns 0 for a report that advances', () => {
    const { io, out } = capture();
    expect(runCli(['grade', writeReport(goodReport())], io)).toBe(EXIT_ADVANCE);
    expect(out.join('\n')).toMatch(/ADVANCE/);
  });

  it('grade returns 1 for a report that holds', () => {
    const r = goodReport();
    const { io, err } = capture();
    const p = writeReport({ ...r, outputs: { ...r.outputs, delta: 40 } });
    expect(runCli(['grade', p], io)).toBe(EXIT_HOLD);
    expect(err.join('\n')).toMatch(/HOLD/);
  });

  it('grade returns 2 when there is no report to grade', () => {
    const { io } = capture();
    expect(runCli(['grade', join(tmpdir(), 'definitely-not-here.json')], io)).toBe(
      EXIT_COULD_NOT_RUN,
    );
  });

  it('grade returns 2 on unparseable JSON — not 1, which would claim a verdict', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'orch-cli-')), 'bad.json');
    writeFileSync(p, '{ nope');
    const { io } = capture();
    expect(runCli(['grade', p], io)).toBe(EXIT_COULD_NOT_RUN);
  });

  it('spec prints what a lane has to produce', () => {
    const { io, out } = capture();
    expect(runCli(['spec'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/delta\s+measurement/);
  });

  it('an unknown command is could-not-run, with usage', () => {
    const { io, err } = capture();
    expect(runCli(['wat'], io)).toBe(EXIT_COULD_NOT_RUN);
    expect(err.join('\n')).toMatch(/exit codes: 0 advance/);
  });

  it('record without a jest json is could-not-run and says how to produce one', () => {
    const { io, err } = capture();
    expect(runCli(['record', 'before'], io)).toBe(EXIT_COULD_NOT_RUN);
    expect(err.join('\n')).toMatch(/--json --outputFile/);
  });
});

describe('collection config is read from the real jest config, not duplicated', () => {
  it('strips <rootDir> and derives the suffix from testMatch', () => {
    expect(
      collectionConfigFromJest({
        roots: ['<rootDir>/tests', '<rootDir>/src/hal/lib/__tests__'],
        testMatch: ['**/*.test.ts'],
        testPathIgnorePatterns: ['/node_modules/', '/dist/', '<rootDir>/tests/integration/'],
      }),
    ).toEqual({
      roots: ['tests', 'src/hal/lib/__tests__'],
      ignorePrefixes: ['tests/integration/'],
      suffix: '.test.ts',
    });
  });

  // This repo's actual config, so the two cannot drift apart unnoticed.
  it('matches the config jest is configured with right now', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require('../jest.config.js') as Record<string, unknown>;
    const collection = collectionConfigFromJest(cfg);
    expect(collection.roots).toContain('tests');
    expect(collection.suffix).toBe('.test.ts');
  });
});
