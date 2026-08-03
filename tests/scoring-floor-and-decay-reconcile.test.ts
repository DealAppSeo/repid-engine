/**
 * scoring-floor-and-decay-reconcile.test.ts
 *
 * Two divergences in one scoring path, and the witnesses that prove each.
 *
 * 1. TWO FLOORS. `repid-delta.ts` carried `FLOOR = 0`; `repid-clamp.ts` exports
 *    `REPID_MIN = 10` and the DB CHECK on `repid_agents.current_repid` agrees with
 *    the clamp, not the formula. Now one imported constant, behind a default-OFF
 *    flag because flipping it changes a stored ledger value.
 *
 * 2. THE LEDGER IDENTITY. `score-event-writer.ts::reconciles` requires
 *    `repid_after - repid_before === repid_delta_applied`. `runScoreEvent` stored the
 *    HAL delta, which is NOT the movement whenever decay (enforce) or the #314 clamp
 *    took a bite. These tests exhibit both gaps numerically and pin the fix.
 *
 * Ruler: every assertion below is arithmetic over the real exported functions — no
 * mocks, no DB. Column types (`integer` for repid_before/after/delta_applied and for
 * repid_agents.current_repid) verified against Trinity prod information_schema
 * 2026-08-03; that is what makes "the base must be integral" a requirement and not a
 * preference.
 */

import { computeDelta, deltaFloor, DeltaInput, HALDecision } from '../src/scoring/repid-delta';
import { REPID_MIN, REPID_MAX, clampRepid } from '../src/scoring/repid-clamp';
import {
  assessDecay,
  applyToScore,
  appliedScoreReconciles,
  decayedScoreFor,
  DecayAssessment,
} from '../src/scoring/decay-bridge';
import { reconciles, CallerAppliedEvent } from '../src/scoring/score-event-writer';
import { applyDecay } from '../src/layers/decay';

const DECISIONS: HALDecision[] = ['clean', 'flagged', 'vetoed', 'abstain'];
const SCORES = [0, 0.05, 0.25, 0.4, 0.5, 0.75, 0.95, 1];

/** Every score an agent can legally hold, plus both bounds and the floor window. */
const IN_RANGE_SCORES = [
  10, 11, 12, 15, 19, 20, 21, 60, 100, 499, 500, 999, 1000, 1001, 4999, 5000, 7999,
  8000, 9990, 9995, 9998, 9999, 10000,
];

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.REPID_DELTA_FLOOR_RECONCILED;
  if (value === undefined) delete process.env.REPID_DELTA_FLOOR_RECONCILED;
  else process.env.REPID_DELTA_FLOOR_RECONCILED = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.REPID_DELTA_FLOOR_RECONCILED;
    else process.env.REPID_DELTA_FLOOR_RECONCILED = prev;
  }
}

function input(over: Partial<DeltaInput> & { current_repid: number }): DeltaInput {
  return {
    hal_score: 0.5,
    hal_decision: 'clean',
    agent_tier: 'ESTABLISHED',
    vesting_cliff_active: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. One source of truth for the floor
// ---------------------------------------------------------------------------

describe('floor: one source of truth', () => {
  test('the reconciled floor IS repid-clamp REPID_MIN — no second literal', () => {
    withFlag('true', () => {
      expect(deltaFloor()).toBe(REPID_MIN);
      expect(deltaFloor()).toBe(10);
    });
  });

  test('default is the legacy 0 — landing this changes nothing until Sean flips it', () => {
    withFlag(undefined, () => expect(deltaFloor()).toBe(0));
    withFlag('false', () => expect(deltaFloor()).toBe(0));
    // Only the exact string 'true' arms it; a typo must not silently arm a live change.
    withFlag('TRUE', () => expect(deltaFloor()).toBe(0));
    withFlag('1', () => expect(deltaFloor()).toBe(0));
  });

  test('NO reachable witness stores a score below REPID_MIN — either floor', () => {
    for (const flag of [undefined, 'true']) {
      withFlag(flag, () => {
        for (const current_repid of IN_RANGE_SCORES) {
          for (const hal_decision of DECISIONS) {
            for (const hal_score of SCORES) {
              for (const vesting_cliff_active of [false, true]) {
                const r = computeDelta(
                  input({ current_repid, hal_decision, hal_score, vesting_cliff_active })
                );
                // What actually gets written is the clamped score. It is the clamp,
                // not the formula's floor, that has always guaranteed >= 10.
                const stored = clampRepid(current_repid + r.delta_applied).value;
                expect(stored).toBeGreaterThanOrEqual(REPID_MIN);
                expect(stored).toBeLessThanOrEqual(REPID_MAX);
              }
            }
          }
        }
      });
    }
  });

  test('with the flag armed the PROJECTED score never dips below 10 either — no clamp needed', () => {
    withFlag('true', () => {
      for (const current_repid of IN_RANGE_SCORES) {
        for (const hal_decision of DECISIONS) {
          for (const hal_score of SCORES) {
            const r = computeDelta(input({ current_repid, hal_decision, hal_score }));
            expect(current_repid + r.delta_applied).toBeGreaterThanOrEqual(REPID_MIN);
          }
        }
      }
    });
  });

  test('legacy floor 0 lets the projection land in 0..9 — the divergence, exhibited', () => {
    // current_repid=15 is inside the DB-legal range and the veto is a legal delta,
    // so this is a formula that believes a score of 5 is a thing that can exist.
    const legacy = withFlag(undefined, () =>
      computeDelta(input({ current_repid: 15, hal_decision: 'vetoed', hal_score: 0.05 }))
    );
    expect(legacy.delta_applied).toBe(-10);
    expect(15 + legacy.delta_applied).toBe(5); // below the DB CHECK floor of 10
    expect(legacy.reason).not.toMatch(/floor-protected/);

    const reconciled = withFlag('true', () =>
      computeDelta(input({ current_repid: 15, hal_decision: 'vetoed', hal_score: 0.05 }))
    );
    expect(reconciled.delta_applied).toBe(-5); // the movement the clamp would allow
    expect(15 + reconciled.delta_applied).toBe(REPID_MIN);
    expect(reconciled.reason).toMatch(/floor-protected/);

    // The score written is 10 EITHER WAY — which is why this cannot move a RepID
    // score, only the recorded delta. -10 was a claim about a 5-point drop.
    expect(clampRepid(15 + legacy.delta_applied).value).toBe(REPID_MIN);
    expect(clampRepid(15 + reconciled.delta_applied).value).toBe(REPID_MIN);
  });

  test('floor protection never flips a penalty into a reward', () => {
    // current_repid < 10 is unreachable under the DB CHECK, but `FLOOR - current_repid`
    // is POSITIVE there, so an unguarded reconciled floor would pay +8 for a veto.
    withFlag('true', () => {
      for (const current_repid of [0, 1, 2, 5, 9]) {
        const r = computeDelta(input({ current_repid, hal_decision: 'vetoed', hal_score: 0.05 }));
        expect(r.delta_calculated).toBe(-10);
        expect(r.delta_applied).toBeLessThanOrEqual(0);
        expect(r.delta_applied).toBe(0);
      }
    });
  });

  test('floor protection only ever shrinks the magnitude of a negative delta', () => {
    for (const flag of [undefined, 'true']) {
      withFlag(flag, () => {
        for (const current_repid of [...IN_RANGE_SCORES, 0, 1, 5, 9]) {
          for (const hal_decision of DECISIONS) {
            for (const hal_score of SCORES) {
              const r = computeDelta(input({ current_repid, hal_decision, hal_score }));
              if (r.delta_calculated < 0) {
                expect(r.delta_applied).toBeLessThanOrEqual(0);
                expect(Math.abs(r.delta_applied)).toBeLessThanOrEqual(
                  Math.abs(r.delta_calculated)
                );
              }
            }
          }
        }
      });
    }
  });

  test('arming the floor changes delta_applied ONLY for current_repid in 10..19', () => {
    const changed: number[] = [];
    for (let current_repid = 10; current_repid <= 200; current_repid++) {
      for (const hal_decision of DECISIONS) {
        for (const hal_score of SCORES) {
          const a = withFlag(undefined, () =>
            computeDelta(input({ current_repid, hal_decision, hal_score })).delta_applied
          );
          const b = withFlag('true', () =>
            computeDelta(input({ current_repid, hal_decision, hal_score })).delta_applied
          );
          if (a !== b) changed.push(current_repid);
        }
      }
    }
    expect(Math.min(...changed)).toBe(10);
    expect(Math.max(...changed)).toBe(19);
    // Prod 2026-08-03: 0 agents in 10..19, min(current_repid)=60 → no live witness.
  });
});

// ---------------------------------------------------------------------------
// 2. The decay / rounding coupling
// ---------------------------------------------------------------------------

describe('decay + rounding: the identity and why the base must be integral', () => {
  test('Math.round(before + d) === before + Math.round(d) — ONLY for integer before', () => {
    const d = 1.5;
    for (const before of [10, 999, 1000, 4321]) {
      expect(Math.round(before + d)).toBe(before + Math.round(d));
    }
    // Fractional base: the two orders give DIFFERENT answers, and nothing on the row
    // records which component absorbed the residue. This is the coupling the fix
    // removes by construction — round the base, then add.
    const fractional = 987.5;
    expect(Math.round(fractional + 0.5)).toBe(988); // round(988.0)
    expect(Math.round(fractional) + Math.round(0.5)).toBe(989); // 988 + 1
    // Same divergence at the small end, for clarity:
    expect(Math.round(0.4 + 0.4)).toBe(1);
    expect(Math.round(0.4) + Math.round(0.4)).toBe(0);
  });

  test('the decayed base is integral — premise check on layers/decay.ts', () => {
    // The dispatch assumed enforce makes the base FRACTIONAL. It does not:
    // applyDecay already rounds. So the identity above never actually breaks on
    // `before`; the real break is attribution (decay + clamp), tested below.
    for (const repid of IN_RANGE_SCORES) {
      for (const activity of [0, 1, 3, 10, 40]) {
        expect(Number.isInteger(applyDecay(repid, activity))).toBe(true);
        const a = assessDecay({ currentRepid: repid, activity30d: activity, mode: 'enforce' });
        expect(Number.isInteger(a.decayed_to)).toBe(true);
        expect(Number.isInteger(decayedScoreFor(a))).toBe(true);
      }
    }
  });

  test('decay in enforce actually removes points — the witness is real, not hypothetical', () => {
    const a = assessDecay({ currentRepid: 1000, activity30d: 0, mode: 'enforce' });
    expect(a.applied).toBe(true);
    expect(a.would_remove).toBeGreaterThan(0);
    expect(a.decayed_to).toBeLessThan(1000);
  });
});

describe('the ledger identity: repid_after - repid_before === repid_delta_applied', () => {
  const OFF = (repid: number, activity = 0): DecayAssessment =>
    assessDecay({ currentRepid: repid, activity30d: activity, mode: 'off' });
  const ENFORCE = (repid: number, activity = 0): DecayAssessment =>
    assessDecay({ currentRepid: repid, activity30d: activity, mode: 'enforce' });

  test('DIVERGENCE under enforce: the HAL delta is NOT the movement', () => {
    const before = 1000;
    const decay = ENFORCE(before);
    const halDelta = 1.5;
    const a = applyToScore({ before, decay, rawDelta: halDelta });

    // What the old code stored as repid_delta_applied:
    const oldStoredDelta = Math.round(halDelta);
    expect(oldStoredDelta).toBe(2);

    // What the score actually did:
    expect(a.after).toBeLessThan(before);
    expect(a.total_applied).toBeLessThan(0);

    // The old row would have claimed +2 beside a drop. Quantify the gap: it is
    // EXACTLY the decay bite, nothing else.
    expect(a.total_applied - oldStoredDelta).toBe(a.decay_points);
    expect(a.decay_points).toBe(-decay.would_remove);

    // Old row: does not reconcile. New row: does.
    const oldRow: CallerAppliedEvent = {
      applier: 'caller',
      agent_id: 'w',
      event_type: 'HAL_SCORE_EVENT',
      delta: oldStoredDelta,
      repid_before: before,
      repid_after: a.after,
      repid_delta_applied: oldStoredDelta,
    };
    expect(reconciles(oldRow)).toBe(false);
    expect(reconciles({ ...oldRow, repid_delta_applied: a.total_applied })).toBe(true);
  });

  test('DIVERGENCE at the ceiling with decay OFF — reachable today', () => {
    // Verified 2026-08-03: exactly one live agent sits at current_repid = 10000.
    // Any positive HAL delta on it moves the score 0 points; the old code recorded
    // the full delta. This half needs no flag flipped at all.
    const before = REPID_MAX;
    const a = applyToScore({ before, decay: OFF(before), rawDelta: 2 });
    expect(a.after).toBe(REPID_MAX);
    expect(a.clamp_points).toBe(-2);
    expect(a.total_applied).toBe(0);
    expect(Math.round(2)).not.toBe(a.total_applied); // the old stored value
    expect(appliedScoreReconciles(a)).toBe(true);
  });

  test('components sum to the movement EXACTLY, over a full grid', () => {
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      for (const before of IN_RANGE_SCORES) {
        for (const activity of [0, 2, 10, 50]) {
          const decay = assessDecay({ currentRepid: before, activity30d: activity, mode });
          for (const rawDelta of [-10, -10.4, -2.5, -1.5, -0.6, 0, 0.6, 1.5, 2.3, 5, 5.5]) {
            const a = applyToScore({ before, decay, rawDelta });
            expect(appliedScoreReconciles(a)).toBe(true);
            expect(a.decay_points + a.delta_points + a.clamp_points).toBe(a.total_applied);
            expect(a.after - a.before).toBe(a.total_applied);
            // Every stored number is an integer, because every column is.
            for (const v of [
              a.before,
              a.after,
              a.decay_points,
              a.delta_points,
              a.clamp_points,
              a.total_applied,
            ]) {
              expect(Number.isInteger(v)).toBe(true);
            }
            // And the score written is always legal.
            expect(a.after).toBeGreaterThanOrEqual(REPID_MIN);
            expect(a.after).toBeLessThanOrEqual(REPID_MAX);
          }
        }
      }
    }
  });

  test('rounding the base first: decay_points carries no fractional residue', () => {
    for (const before of IN_RANGE_SCORES) {
      for (const activity of [0, 1, 5]) {
        const decay = ENFORCE(before, activity);
        const a = applyToScore({ before, decay, rawDelta: 1.5 });
        expect(Number.isInteger(a.decay_points)).toBe(true);
        // The delta is rounded ONCE and lands on an integer base, so the movement
        // decomposes without a leftover half-point hiding in either component.
        if (a.clamp_points === 0) {
          expect(a.after).toBe(before + a.decay_points + a.delta_points);
        }
      }
    }
  });

  test('INERT with decay off and away from the bounds — identical to the old stored value', () => {
    for (const before of [60, 100, 1000, 4999, 5000, 9990]) {
      for (const rawDelta of [-10, -2.5, -1.5, -0.6, 0, 0.6, 1.5, 2.3, 5]) {
        const a = applyToScore({ before, decay: OFF(before), rawDelta });
        expect(a.decay_points).toBe(0);
        expect(a.clamp_points).toBe(0);
        // Old: repid_after = round(before + rawDelta), delta = round(rawDelta).
        expect(a.after).toBe(Math.round(before + rawDelta));
        expect(a.total_applied).toBe(Math.round(rawDelta));
      }
    }
  });

  test('shadow mode moves nothing — shadow that moves a score is not shadow', () => {
    for (const before of IN_RANGE_SCORES) {
      const a = applyToScore({
        before,
        decay: assessDecay({ currentRepid: before, activity30d: 0, mode: 'shadow' }),
        rawDelta: 0,
      });
      expect(a.decay_points).toBe(0);
      expect(a.after).toBe(before);
      expect(a.total_applied).toBe(0);
    }
  });

  test('end-to-end: computeDelta → applyToScore reconciles for every witness', () => {
    for (const flag of [undefined, 'true']) {
      withFlag(flag, () => {
        for (const mode of ['off', 'enforce'] as const) {
          for (const current_repid of IN_RANGE_SCORES) {
            for (const hal_decision of DECISIONS) {
              for (const hal_score of [0.05, 0.5, 0.95]) {
                const d = computeDelta(input({ current_repid, hal_decision, hal_score }));
                const decay = assessDecay({
                  currentRepid: current_repid,
                  activity30d: 0,
                  mode,
                });
                const a = applyToScore({
                  before: current_repid,
                  decay,
                  rawDelta: d.delta_applied,
                });
                expect(appliedScoreReconciles(a)).toBe(true);
                expect(
                  reconciles({
                    applier: 'caller',
                    agent_id: 'w',
                    event_type: 'HAL_SCORE_EVENT',
                    delta: a.delta_points,
                    repid_before: a.before,
                    repid_after: a.after,
                    repid_delta_applied: a.total_applied,
                  })
                ).toBe(true);
              }
            }
          }
        }
      });
    }
  });
});
