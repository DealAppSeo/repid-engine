/**
 * lane-report-gate.ts — the gate that `handoff-gate.ts` was built to be, actually called.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * `evaluateHandoff`, `canAssign`, `cheapestCapableLane` and `eligibleVerifiers`
 * shipped with 63 tests and, until this file, ZERO callers outside those tests. That
 * is Pattern G in our own roadmap — COLD MODULE DISEASE, "fully designed, documented,
 * and never wired" — and it is worse than not having built the gate, because the
 * roadmap records the gate as done. Meanwhile eight lane reports were graded by a
 * human reading prose, which is the exact review the gate exists to replace.
 *
 * So: this module turns a lane's report into a decision. It contains all of the
 * judgement. `scripts/lane-report.ts` is a shell over it that reads files, asks git
 * questions, prints, and exits.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE JUDGEMENT IS HERE AND NOT IN THE CLI
 * ════════════════════════════════════════════════════════════════════════════════
 * The first attempt at this put the rules in the CLI and tested them by spawning
 * `npx ts-node` once per case. That suite did not finish in TEN MINUTES, and a gate
 * that makes the suite unrunnable gets deleted — the same fate as an un-wired gate,
 * just louder. Every rule below is a function of its arguments and is exercised
 * in-process in milliseconds. The CLI is tested by calling it, not by spawning it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE THREE EXITS
 * ════════════════════════════════════════════════════════════════════════════════
 *   0 ADVANCE        — every required output is present and usable, and verification
 *                      is adequate for whether this touches live state.
 *   1 HOLD           — the gate reached a verdict and the verdict is no. The report
 *                      is the thing to fix.
 *   2 COULD_NOT_RUN  — the gate could not form a judgement at all: no report, invalid
 *                      JSON, unknown spec, unknown lane. Distinct from HOLD on
 *                      purpose. A gate that reports "fail" when it means "I did not
 *                      run" is how a broken check gets mistaken for a caught defect,
 *                      and how a dead provider key once got reported as a quality
 *                      regression (CLAUDE_RULES 24).
 */

import {
  certifyDelta,
  type Certification,
  type CertifyOptions,
  type Parsed,
  type RunMeasurement,
} from './baseline-ledger';
import {
  evaluateHandoff,
  type HandoffDecision,
  type MeasuredValue,
  type OutputProblem,
  type ReportedValue,
  type RequiredOutput,
  type Voice,
} from './handoff-gate';
import {
  canAssign,
  cheapestCapableLane,
  eligibleVerifiers,
  laneById,
  type Capability,
  type LaneId,
} from './lane-registry';

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export interface LaneReportSpec {
  id: string;
  description: string;
  requiredOutputs: readonly RequiredOutput[];
  /**
   * Capabilities the WORK required. A lane without them could not have obtained the
   * numbers it is reporting — so the report is refused at the gate rather than
   * believed. This is `lane-registry`'s whole thesis: fabrication is prevented by
   * routing, and caught here when routing was skipped.
   */
  requiredCapabilities: readonly Capability[];
  /** Capabilities a co-signer needs to actually REACH the evidence. */
  evidenceNeeds: readonly Capability[];
  /**
   * Must the reported delta be backed by two recorded runs this gate can certify?
   * True for anything that quotes a test count, because a hand-written count is
   * precisely what the per-environment baseline machinery exists to stop.
   */
  requireCertifiedDelta: boolean;
}

/**
 * The standard parallel-lane sprint report.
 *
 * `delta` is typed `measurement`, so `checkOutput` refuses a bare number: "328" is
 * not a result, "+34 on jest suite @ e24ce7f..a1b2c3d, 294→295 suites collected" is.
 * That is CLAUDE_RULES 24 made mechanical instead of remembered.
 */
export const LANE_SPRINT_V1: LaneReportSpec = {
  id: 'lane-sprint-v1',
  description: 'One lane’s report from a parallel sprint: what changed, what it cost, what proves it.',
  requiredOutputs: [
    {
      key: 'summary',
      kind: 'prose',
      description: 'what was changed and why, in enough words to be checkable',
    },
    {
      key: 'delta',
      kind: 'measurement',
      description: 'the test-count change, with the corpus and configuration it was measured at',
    },
    { key: 'branch', kind: 'artifact', description: 'the branch the work is on' },
    { key: 'pr', kind: 'artifact', description: 'the pull request URL' },
    { key: 'verdict', kind: 'verdict', description: 'the lane’s own explicit verdict' },
  ],
  // A branch and a PR cannot exist without repo access. T12 (reasoning only) is
  // refused here by construction, which is the measured lesson: 18/18 nightly reports
  // from a lane with no HTTP client contained zero real measurements.
  requiredCapabilities: ['repo_write'],
  // Reaching a PR URL needs a network call. A lane that cannot fetch it is not
  // verifying it, however confident its co-sign sounds.
  evidenceNeeds: ['http'],
  requireCertifiedDelta: true,
};

export const SPECS: Readonly<Record<string, LaneReportSpec>> = {
  [LANE_SPRINT_V1.id]: LANE_SPRINT_V1,
};

export const DEFAULT_SPEC_ID = LANE_SPRINT_V1.id;

// ---------------------------------------------------------------------------
// The report envelope
// ---------------------------------------------------------------------------

export interface LaneReport {
  taskId: string | number;
  /** Which lane produced this. Must be a lane the registry knows. */
  lane: LaneId;
  /** Can this work change money, RepID, on-chain state, or a public surface? */
  touchesLiveState: boolean;
  outputs: Record<string, ReportedValue>;
  voices?: Voice[];
  /** The two runs backing the reported delta, plus the suite change the diff explains. */
  runs?: {
    before: RunMeasurement;
    after: RunMeasurement;
    expectedSuiteDelta: number;
  };
  specId?: string;
}

export const EXIT_ADVANCE = 0;
export const EXIT_HOLD = 1;
export const EXIT_COULD_NOT_RUN = 2;
export type GateExit = typeof EXIT_ADVANCE | typeof EXIT_HOLD | typeof EXIT_COULD_NOT_RUN;

export interface GateResult {
  exit: GateExit;
  status: 'ADVANCE' | 'HOLD' | 'COULD_NOT_RUN';
  /** Present whenever the gate got far enough to run `evaluateHandoff`. */
  decision?: HandoffDecision;
  certification?: Certification;
  /** Voices discarded because they could not reach the evidence. */
  ignoredVoices: LaneId[];
  /** Human-readable, one concern per line, ordered cheapest-to-fix first. */
  lines: string[];
}

const couldNotRun = (...lines: string[]): GateResult => ({
  exit: EXIT_COULD_NOT_RUN,
  status: 'COULD_NOT_RUN',
  ignoredVoices: [],
  lines: ['COULD NOT RUN — the gate did not reach a verdict.', ...lines],
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate the envelope. Deliberately strict and deliberately EXIT 2 on failure: a
 * report the gate cannot read has not been judged, and saying "HOLD" would claim
 * otherwise.
 */
export function parseReport(raw: unknown): Parsed<LaneReport> {
  if (!isRecord(raw)) return { ok: false, error: 'report is not a JSON object' };

  const taskId = raw['taskId'];
  if (typeof taskId !== 'string' && typeof taskId !== 'number') {
    return { ok: false, error: 'report.taskId must be a string or a number' };
  }
  const lane = raw['lane'];
  if (typeof lane !== 'string') return { ok: false, error: 'report.lane must be a lane id string' };

  const touchesLiveState = raw['touchesLiveState'];
  if (typeof touchesLiveState !== 'boolean') {
    return {
      ok: false,
      error:
        'report.touchesLiveState must be an explicit true or false — whether the work can change ' +
        'money, RepID, on-chain state or a public surface decides how much verification it needs, ' +
        'and defaulting it would pick the answer nobody stated.',
    };
  }

  const outputs = raw['outputs'];
  if (!isRecord(outputs)) return { ok: false, error: 'report.outputs must be an object' };

  const rawVoices = raw['voices'] ?? [];
  if (!Array.isArray(rawVoices)) return { ok: false, error: 'report.voices must be an array' };
  const voices: Voice[] = [];
  for (const v of rawVoices) {
    if (!isRecord(v) || typeof v['lane'] !== 'string') {
      return { ok: false, error: 'each report.voices entry needs a lane and an agrees value' };
    }
    const agrees = v['agrees'];
    if (agrees !== true && agrees !== false && agrees !== null) {
      return { ok: false, error: `voice ${String(v['lane'])}.agrees must be true, false, or null` };
    }
    voices.push({ lane: v['lane'] as LaneId, agrees });
  }

  const report: LaneReport = {
    taskId,
    lane: lane as LaneId,
    touchesLiveState,
    outputs: outputs as Record<string, ReportedValue>,
    voices,
  };

  const specId = raw['specId'];
  if (typeof specId === 'string') report.specId = specId;

  const runs = raw['runs'];
  if (runs !== undefined) {
    if (!isRecord(runs) || !isRecord(runs['before']) || !isRecord(runs['after'])) {
      return { ok: false, error: 'report.runs must contain a before and an after run' };
    }
    const expected = runs['expectedSuiteDelta'];
    if (typeof expected !== 'number' || !Number.isInteger(expected)) {
      return {
        ok: false,
        error:
          'report.runs.expectedSuiteDelta must be an integer counted from the diff (see ' +
          '`lane-report certify`), not asserted by hand.',
      };
    }
    report.runs = {
      before: runs['before'] as unknown as RunMeasurement,
      after: runs['after'] as unknown as RunMeasurement,
      expectedSuiteDelta: expected,
    };
  }

  return { ok: true, value: report };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const isMeasured = (v: ReportedValue): v is MeasuredValue =>
  typeof v === 'object' && v !== null && typeof (v as MeasuredValue).value === 'number';

/**
 * Grade one lane report.
 *
 * Order of operations, and why:
 *   1. spec + lane must resolve, or we cannot judge at all      → EXIT 2
 *   2. could this lane even have done the work?                 → HOLD, with a route
 *   3. drop co-signs from lanes that cannot reach the evidence  → then judge
 *   4. required outputs + verification (`evaluateHandoff`)      → HOLD
 *   5. is the reported delta certified by its own two runs?     → HOLD
 *
 * Capability is checked before contents because a report from a lane that could not
 * have measured the thing should not be read for detail — the detail is decoration.
 */
export function gradeLaneReport(raw: unknown, opts: { specId?: string } = {}): GateResult {
  const parsed = parseReport(raw);
  if (!parsed.ok) return couldNotRun(parsed.error);
  const report = parsed.value;

  const specId = opts.specId ?? report.specId ?? DEFAULT_SPEC_ID;
  const spec = SPECS[specId];
  if (!spec) {
    return couldNotRun(
      `unknown spec "${specId}". Known: ${Object.keys(SPECS).join(', ')}.`,
    );
  }

  if (!laneById(report.lane)) {
    return couldNotRun(
      `unknown lane "${report.lane}" — it is not in the lane registry, so neither its ` +
        `capabilities nor its eligible verifiers can be resolved.`,
    );
  }

  const lines: string[] = [];

  // ---- 2. capability -----------------------------------------------------
  const assignment = canAssign(report.lane, spec.requiredCapabilities);
  if (!assignment.assignable) {
    const better = cheapestCapableLane(spec.requiredCapabilities);
    return {
      exit: EXIT_HOLD,
      status: 'HOLD',
      ignoredVoices: [],
      lines: [
        `HOLD ${report.taskId}: ${assignment.reason}`,
        `Work of spec "${spec.id}" needs: ${spec.requiredCapabilities.join(', ')}.`,
        better
          ? `Route it to ${better.id} (cost tier ${better.costTier}) — the cheapest lane that can actually do it.`
          : 'No lane in the registry has these capabilities. That is a gap to close, not a task to dispatch.',
      ],
    };
  }

  // ---- 3. voices that can reach the evidence -----------------------------
  const eligible = new Set(eligibleVerifiers(report.lane, spec.evidenceNeeds).map((l) => l.id));
  const ignoredVoices: LaneId[] = [];
  const usableVoices: Voice[] = [];
  for (const v of report.voices ?? []) {
    if (v.lane === report.lane || eligible.has(v.lane)) {
      usableVoices.push(v);
    } else {
      ignoredVoices.push(v.lane);
    }
  }
  if (ignoredVoices.length > 0) {
    lines.push(
      `Ignored co-sign(s) from ${ignoredVoices.join(', ')}: verifying this needs ` +
        `${spec.evidenceNeeds.join(', ')} and those lanes do not have it. A confident review of ` +
        `evidence the reviewer never saw is worse than no review, because it carries a signature.`,
    );
  }

  // ---- 4. the gate that was never called ---------------------------------
  const decision = evaluateHandoff({
    taskId: report.taskId,
    producer: report.lane,
    requiredOutputs: spec.requiredOutputs,
    reported: report.outputs,
    voices: usableVoices,
    touchesLiveState: report.touchesLiveState,
  });

  // ---- 5. is the delta certified? ----------------------------------------
  const { certification, problems: certProblems } = certifyReportedDelta(report, spec);
  if (certification) {
    lines.push(
      certification.certified
        ? `Delta certified: ${certification.delta.value} on ${certification.delta.corpus} (${certification.delta.config}).`
        : `Delta NOT certified: ${certification.reason}`,
    );
    if (certification.certified) lines.push(`Caveat: ${certification.note}`);
  }

  const allProblems: OutputProblem[] = [...decision.problems, ...certProblems];
  const advance = decision.advance && certProblems.length === 0;

  if (advance) {
    return {
      exit: EXIT_ADVANCE,
      status: 'ADVANCE',
      decision,
      ...(certification ? { certification } : {}),
      ignoredVoices,
      lines: [decision.reason, ...lines],
    };
  }

  const head =
    decision.advance && certProblems.length > 0
      ? `HOLD ${report.taskId}: outputs are present but the delta is not admissible.`
      : decision.reason;

  return {
    exit: EXIT_HOLD,
    status: 'HOLD',
    decision: { ...decision, advance: false, problems: allProblems },
    ...(certification ? { certification } : {}),
    ignoredVoices,
    lines: [head, ...allProblems.map((p) => `  - ${p.key}: ${p.problem}`), ...lines],
  };
}

/**
 * Certify the delta the lane reported against the two runs it recorded.
 *
 * Three ways this refuses, all of them the same underlying failure — a number nobody
 * can re-derive:
 *   - no runs recorded at all, when the spec demands them;
 *   - the runs are not comparable (`certifyDelta` says why);
 *   - the runs ARE comparable and the lane's stated figure is not the one they yield.
 * The last is the one a prose review never catches.
 */
function certifyReportedDelta(
  report: LaneReport,
  spec: LaneReportSpec,
): { certification?: Certification; problems: OutputProblem[] } {
  if (!spec.requireCertifiedDelta) return { problems: [] };

  if (!report.runs) {
    return {
      problems: [
        {
          key: 'delta',
          problem:
            'no before/after runs recorded, so the figure cannot be re-derived. Record a ' +
            'baseline in THIS checkout before changing anything (`lane-report record before`), ' +
            'and the after-run when done. A test count is environment-scoped — a borrowed ' +
            'baseline is not a baseline.',
        },
      ],
    };
  }

  const certOpts: CertifyOptions = { expectedSuiteDelta: report.runs.expectedSuiteDelta };
  const certification = certifyDelta(report.runs.before, report.runs.after, certOpts);

  if (!certification.certified) {
    return {
      certification,
      problems: [{ key: 'delta', problem: `not certifiable — ${certification.reason}` }],
    };
  }

  const reported = report.outputs['delta'];
  if (isMeasured(reported) && reported.value !== certification.delta.value) {
    return {
      certification,
      problems: [
        {
          key: 'delta',
          problem:
            `reported ${reported.value} but the recorded runs yield ${certification.delta.value} ` +
            `(${certification.delta.config}). Report the number your own runs produce.`,
        },
      ],
    };
  }

  return { certification, problems: [] };
}

/** Render a GateResult for a terminal. Kept here so the CLI has no formatting logic. */
export function formatGateResult(result: GateResult): string {
  return result.lines.join('\n');
}
