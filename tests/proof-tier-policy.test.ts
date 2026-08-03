/**
 * proof-tier-policy.test.ts — properties of the Patent #2 proof-tier policy.
 *
 * These are not coverage tests. Each one pins a property the patent claim rests on,
 * and each is written so that a policy which "works by accident" fails it:
 *
 *  P1 non-degeneracy — every rung of the ladder is actually reachable. A policy that
 *     always returned `current_validity` would satisfy every monotonicity property
 *     below VACUOUSLY. This test exists because a prior artifact in this repo passed
 *     its central assertion for the wrong reason, and nothing caught it.
 *  P2 the learned layer is load-bearing — the tier moves on axis changes that leave
 *     both gates untouched. Otherwise the ANFIS fabric is decoration and the claim
 *     ("policy-gated selection") is really just a lookup table.
 *  P3 safety monotonicity — the effective tier is NEVER below the deterministic floor.
 *     This is the property that makes shipping a learned policy defensible.
 *  P4/P5 directional monotonicity in stakes and cost, verified by exhaustive sweep.
 *  P6 the ladder's cost is strictly increasing — otherwise "stronger" is meaningless.
 *  P7 determinism — same axes ⇒ byte-identical decision.
 */
import {
  selectProofTier,
  shadowCompareProofTier,
  floorTierIndex,
  PROOF_TIERS,
  TIER_COST_UNITS,
  TIER_LATENCY_MS,
  ANY_STAKES_FLOOR,
  HIGH_STAKES_FLOOR,
  RELIABILITY_FLOOR,
  PRIVACY_ZK_THRESHOLD,
  URGENT_LATENCY,
  type PolicyAxes,
} from '../src/services/proof-tier-policy';

const GRID = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1];

/**
 * The floor, restated INDEPENDENTLY of the implementation.
 *
 * This matters more than it looks. Asserting the policy against the exported
 * `floorTierIndex()` is self-referential: mutate the floor and both sides of the
 * comparison move together, so the assertion holds while the safety property is gone.
 * A mutation run caught exactly that — deleting the stakes≥0.35 rung left the whole
 * suite green. This literal restatement is the independent oracle.
 */
function expectedFloor(a: PolicyAxes): number {
  let f = 0;
  if (a.stakes >= 0.35) f = 1;
  if (a.stakes >= 0.7) f = 2;
  if (a.reliabilityRequired >= 0.8) f = Math.max(f, 2);
  return f;
}

function sweep(fn: (a: PolicyAxes) => void): number {
  let n = 0;
  for (const stakes of GRID)
    for (const costPressure of GRID)
      for (const privacy of GRID)
        for (const latencyUrgency of GRID)
          for (const reliabilityRequired of GRID) {
            fn({ stakes, costPressure, privacy, latencyUrgency, reliabilityRequired });
            n++;
          }
  return n;
}

describe('proof-tier policy — ladder shape', () => {
  it('P6: cost and latency are strictly increasing across the ladder', () => {
    expect(TIER_COST_UNITS.length).toBe(PROOF_TIERS.length);
    expect(TIER_LATENCY_MS.length).toBe(PROOF_TIERS.length);
    for (let i = 1; i < PROOF_TIERS.length; i++) {
      expect(TIER_COST_UNITS[i]!).toBeGreaterThan(TIER_COST_UNITS[i - 1]!);
      expect(TIER_LATENCY_MS[i]!).toBeGreaterThan(TIER_LATENCY_MS[i - 1]!);
    }
  });
});

describe('proof-tier policy — non-degeneracy (anti-vacuity)', () => {
  it('P1: every rung of the ladder is reachable, as a learned choice AND as an effective one', () => {
    const effective = new Set<number>();
    const learned = new Set<number>();
    const n = sweep((a) => {
      const d = selectProofTier(a);
      effective.add(d.tierIndex);
      learned.add(d.learnedTierIndex);
    });
    expect(n).toBe(GRID.length ** 5);
    for (let i = 0; i < PROOF_TIERS.length; i++) {
      expect(effective.has(i)).toBe(true);
      expect(learned.has(i)).toBe(true);
    }
  });

  it('P2: the learned layer is load-bearing — the tier moves when NEITHER gate is engaged', () => {
    // Hold stakes/reliability below every floor trigger and latency below the ceiling
    // trigger, so floor === 0 and ceiling === max. Anything that changes the tier here
    // is the ANFIS fabric, not a threshold.
    const base: PolicyAxes = {
      stakes: 0.3,
      costPressure: 0.1,
      privacy: 0.1,
      latencyUrgency: 0.1,
      reliabilityRequired: 0.1,
    };
    const seen = new Set<number>();
    for (const costPressure of GRID) {
      const d = selectProofTier({ ...base, costPressure });
      expect(floorTierIndex({ ...base, costPressure })).toBe(0);
      expect(d.floorApplied).toBe(false);
      expect(d.ceilingApplied).toBe(false);
      seen.add(d.tierIndex);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('P2b: the decisions come from the ANFIS fabric specifically, not from any non-constant model', () => {
    // WHY THIS EXISTS. An independent verifier (Beat 42) replaced the `anfisForward` call
    // with a plain one-rule linear sum — deleting the gaussian antecedents, the golden-ratio
    // centers/spreads, the rule firing and the normalisation, i.e. the entire thing this
    // module's header calls "the shared fabric IS the claim" — and ALL 18 tests still passed,
    // while the learned distribution moved on ~11k of 32,768 grid points.
    //
    // P2 above could not see it: `seen.size > 1` distinguishes CONSTANT from NON-CONSTANT,
    // not ANFIS from LINEAR. So the sentence P2 was written to earn — "without this the floors
    // could be doing 100% of the work and the policy is a lookup table wearing a fuzzy-logic
    // costume" — was true of P2 itself. Patent #2's whole claim is that ONE fabric decides both
    // routing and proof strength; a suite that ships green with the fabric removed is not
    // evidence for that claim.
    //
    // These literals are frozen characterisation values, generated once from the real
    // implementation and pasted here. That is deliberate and is NOT the self-referential trap
    // P3 fell into: nothing here calls the code under test to compute its own expectation, so
    // a change in the model moves the actual and leaves the expected where it is.
    // `confidence` is the sharpest probe, because it reads `ruleWeights` — which only exist
    // if the rules actually fired.
    const GOLDEN: Array<[string, PolicyAxes, { tierIndex: number; learnedTierIndex: number; confidence: number }]> = [
      ['low-everything', { stakes: 0.1, costPressure: 0.1, privacy: 0.1, latencyUrgency: 0.1, reliabilityRequired: 0.1 }, { tierIndex: 1, learnedTierIndex: 1, confidence: 0.8941 }],
      ['cost-pressed-midlow', { stakes: 0.3, costPressure: 0.9, privacy: 0.1, latencyUrgency: 0.1, reliabilityRequired: 0.1 }, { tierIndex: 0, learnedTierIndex: 0, confidence: 0.8638 }],
      ['balanced-mid', { stakes: 0.5, costPressure: 0.5, privacy: 0.5, latencyUrgency: 0.5, reliabilityRequired: 0.5 }, { tierIndex: 2, learnedTierIndex: 2, confidence: 0.7441 }],
      ['learned-no-gates', { stakes: 0.3, costPressure: 0.3, privacy: 0.1, latencyUrgency: 0.1, reliabilityRequired: 0.1 }, { tierIndex: 1, learnedTierIndex: 1, confidence: 0.8605 }],
      ['learned-cheap', { stakes: 0.3, costPressure: 0, privacy: 0.1, latencyUrgency: 0.1, reliabilityRequired: 0.1 }, { tierIndex: 2, learnedTierIndex: 2, confidence: 0.8359 }],
      ['high-privacy-midlow', { stakes: 0.3, costPressure: 0.2, privacy: 0.95, latencyUrgency: 0.2, reliabilityRequired: 0.2 }, { tierIndex: 2, learnedTierIndex: 2, confidence: 0.8534 }],
    ];
    for (const [name, axes, want] of GOLDEN) {
      const d = selectProofTier(axes);
      expect(`${name}:${d.tierIndex}`).toBe(`${name}:${want.tierIndex}`);
      expect(`${name}:${d.learnedTierIndex}`).toBe(`${name}:${want.learnedTierIndex}`);
      // Exact, not approximate: an approximate match here would re-admit the linear model.
      expect(`${name}:${d.confidence}`).toBe(`${name}:${want.confidence}`);
    }
  });

  it('both gates actually fire somewhere in the space (they are not dead code)', () => {
    let floors = 0;
    let ceilings = 0;
    sweep((a) => {
      const d = selectProofTier(a);
      if (d.floorApplied) floors++;
      if (d.ceilingApplied) ceilings++;
    });
    expect(floors).toBeGreaterThan(0);
    expect(ceilings).toBeGreaterThan(0);
  });
});

describe('proof-tier policy — safety gate', () => {
  it('P3: the effective tier is NEVER below the floor, checked against an INDEPENDENT oracle', () => {
    const violations: unknown[] = [];
    sweep((a) => {
      const got = selectProofTier(a).tierIndex;
      // Deliberately NOT floorTierIndex(a) — see expectedFloor's comment.
      if (got < expectedFloor(a)) violations.push({ ...a, got, want: expectedFloor(a) });
    });
    expect(violations).toEqual([]);
  });

  it('the implementation floor agrees with the independent oracle at every grid point', () => {
    const disagreements: unknown[] = [];
    sweep((a) => {
      if (floorTierIndex(a) !== expectedFloor(a)) {
        disagreements.push({ ...a, impl: floorTierIndex(a), oracle: expectedFloor(a) });
      }
    });
    expect(disagreements).toEqual([]);
  });

  it('any real consequence carries at least an inclusion proof, under maximum cost+urgency pressure', () => {
    // Pins the stakes≥0.35 rung specifically. Deleting that rung left the whole suite
    // green in a mutation run; this is the test that now dies.
    const d = selectProofTier({
      stakes: 0.35,
      costPressure: 1,
      privacy: 0,
      latencyUrgency: 1,
      reliabilityRequired: 0,
    });
    expect(d.tierIndex).toBeGreaterThanOrEqual(PROOF_TIERS.indexOf('inclusion'));
    expect(d.floorApplied).toBe(true);
  });

  it('a high-stakes claim always carries at least current-validity, even under max cost+latency pressure', () => {
    const d = selectProofTier({
      stakes: HIGH_STAKES_FLOOR,
      costPressure: 1,
      privacy: 0,
      latencyUrgency: 1,
      reliabilityRequired: 0,
    });
    expect(d.tierIndex).toBeGreaterThanOrEqual(PROOF_TIERS.indexOf('current_validity'));
    expect(d.floorApplied).toBe(true);
  });

  it('a high reliability requirement alone raises the floor to current-validity', () => {
    const d = selectProofTier({
      stakes: 0,
      costPressure: 1,
      privacy: 0,
      latencyUrgency: 1,
      reliabilityRequired: RELIABILITY_FLOOR,
    });
    expect(d.tierIndex).toBeGreaterThanOrEqual(PROOF_TIERS.indexOf('current_validity'));
  });

  it('the urgency ceiling can never push a decision BELOW its floor', () => {
    sweep((a) => {
      if (a.latencyUrgency < URGENT_LATENCY) return;
      const d = selectProofTier(a);
      expect(d.tierIndex).toBeGreaterThanOrEqual(floorTierIndex(a));
    });
  });
});

describe('proof-tier policy — directional monotonicity (exhaustive sweep)', () => {
  it('P4: raising stakes alone never LOWERS the required tier', () => {
    const violations: unknown[] = [];
    let checked = 0;
    for (const costPressure of GRID)
      for (const privacy of GRID)
        for (const latencyUrgency of GRID)
          for (const reliabilityRequired of GRID)
            for (let i = 1; i < GRID.length; i++) {
              const lo = selectProofTier({
                stakes: GRID[i - 1]!, costPressure, privacy, latencyUrgency, reliabilityRequired,
              });
              const hi = selectProofTier({
                stakes: GRID[i]!, costPressure, privacy, latencyUrgency, reliabilityRequired,
              });
              checked++;
              if (hi.tierIndex < lo.tierIndex) {
                violations.push({ from: GRID[i - 1], to: GRID[i], lo: lo.tierIndex, hi: hi.tierIndex });
              }
            }
    expect(checked).toBe(GRID.length ** 4 * (GRID.length - 1));
    expect(violations).toEqual([]);
  });

  it('P5: raising cost pressure alone never RAISES the required tier', () => {
    const violations: unknown[] = [];
    for (const stakes of GRID)
      for (const privacy of GRID)
        for (const latencyUrgency of GRID)
          for (const reliabilityRequired of GRID)
            for (let i = 1; i < GRID.length; i++) {
              const lo = selectProofTier({
                stakes, costPressure: GRID[i - 1]!, privacy, latencyUrgency, reliabilityRequired,
              });
              const hi = selectProofTier({
                stakes, costPressure: GRID[i]!, privacy, latencyUrgency, reliabilityRequired,
              });
              if (hi.tierIndex > lo.tierIndex) {
                violations.push({ stakes, from: GRID[i - 1], to: GRID[i] });
              }
            }
    expect(violations).toEqual([]);
  });
});

describe('proof-tier policy — privacy axis is orthogonal to the ladder', () => {
  it('zkRequired tracks privacy alone, and does not by itself move the tier', () => {
    const below = selectProofTier({
      stakes: 0.5, costPressure: 0.5, privacy: PRIVACY_ZK_THRESHOLD - 0.01,
      latencyUrgency: 0.5, reliabilityRequired: 0.5,
    });
    const above = selectProofTier({
      stakes: 0.5, costPressure: 0.5, privacy: PRIVACY_ZK_THRESHOLD,
      latencyUrgency: 0.5, reliabilityRequired: 0.5,
    });
    expect(below.zkRequired).toBe(false);
    expect(above.zkRequired).toBe(true);
    // Crossing the ZK threshold is a statement about disclosure, not about proof strength.
    expect(above.tierIndex).toBe(below.tierIndex);
  });

  it('the disclosure thresholds are pinned to literals, not to themselves', () => {
    // The test above feeds `PRIVACY_ZK_THRESHOLD ± 0.01` as its input, so both sides move
    // together and the constant can drift freely — the identical self-referential hole that
    // P3 had for the floors, surviving one line to the left of where it was fixed. An
    // independent verifier (Beat 42) moved PRIVACY_ZK_THRESHOLD 0.6 → 0.95 and URGENT_LATENCY
    // 0.85 → 0.60 and the whole suite stayed green.
    //
    // These are not arbitrary numbers to leave unguarded: `zkRequired` is the switch that
    // decides whether content may be revealed at all (ZKP_ARCHITECTURE_INVARIANTS 2/4 — PHI
    // never in the clear). Raising it silently means content that should have been proven in
    // zero-knowledge is disclosed instead.
    expect(PRIVACY_ZK_THRESHOLD).toBe(0.6);
    expect(URGENT_LATENCY).toBe(0.85);

    // And the constants must actually drive behaviour at those literal values.
    const axes = (privacy: number, latencyUrgency: number): PolicyAxes =>
      ({ stakes: 0.5, costPressure: 0.5, privacy, latencyUrgency, reliabilityRequired: 0.5 });
    expect(selectProofTier(axes(0.59, 0.5)).zkRequired).toBe(false);
    expect(selectProofTier(axes(0.6, 0.5)).zkRequired).toBe(true);
  });

  it('the URGENT_LATENCY ceiling is pinned as BEHAVIOUR, not only as a number', () => {
    // The previous version of this assertion — `selectProofTier(axes(0.1, 0.85)).tierIndex
    // <= 2` — was VACUOUS: it was evaluated at axes where the learned tier is already ≤ 2,
    // so the ceiling never had to act. An independent verifier proved it two ways: deleting
    // the ceiling entirely passed it, and raising `rawCeiling` 2 → 3 — which moves 2,161
    // grid points — survived the whole suite.
    //
    // The fix is to evaluate where the ceiling must BIND: learned selection strictly above
    // the cap, so `ceilingApplied` is forced true and the cap value itself is observable.
    const hot = (latencyUrgency: number): PolicyAxes => ({
      stakes: 0.9, costPressure: 0.55, privacy: 0.5, latencyUrgency, reliabilityRequired: 0.9,
    });

    const capped = selectProofTier(hot(0.85)); // exactly AT the literal threshold
    expect(capped.learnedTierIndex).toBe(3); // the learned layer wanted authenticated_walk
    expect(capped.ceilingApplied).toBe(true); // …and the ceiling had to overrule it
    expect(capped.tierIndex).toBe(2); // capped at current_validity, not 3

    const uncapped = selectProofTier(hot(0.84)); // one hundredth below it
    expect(uncapped.ceilingApplied).toBe(false);
    expect(uncapped.tierIndex).toBe(3); // the same call, uncapped, goes higher
  });

  it('the SAFETY floors are pinned to literals — the half of the self-referential hole that was left open', () => {
    // Beat 42 fixed this construct for PRIVACY_ZK_THRESHOLD and URGENT_LATENCY and stopped
    // there. An independent verifier found the identical pattern still sitting eleven and
    // twenty-seven lines away, on the two constants that carry the SAFETY property rather
    // than the disclosure one: the tests fed `HIGH_STAKES_FLOOR` and `RELIABILITY_FLOOR` as
    // their own inputs, so both sides moved together and the constants could drift freely.
    //
    // The `expectedFloor` oracle elsewhere in this file does not cover it, because that test
    // only samples the 8-value GRID — and 0.7 and 0.8 are not grid values. Drift that lands
    // in a grid gap is invisible to it.
    //
    // Measured consequence, with both floors raised by 0.05 (suite stayed 20/20 green):
    //   stakes = 0.72, max cost+urgency        current_validity → inclusion
    //   reliabilityRequired = 0.82, ditto      current_validity → NONE, floorApplied false
    // A claim above the documented 0.8 reliability floor shipping with NO cryptographic
    // backing is exactly what the module header calls the thing that makes the learned
    // layer safe to ship. This is the fifth instance of this failure in six beats, and the
    // first where it sits on the safety property rather than a disclosure one.
    expect(ANY_STAKES_FLOOR).toBe(0.35);
    expect(HIGH_STAKES_FLOOR).toBe(0.7);
    expect(RELIABILITY_FLOOR).toBe(0.8);

    // Boundary behaviour at LITERAL inputs — nothing here reads the constants, so a drifted
    // constant changes one side only. Max cost+urgency pressure throughout, so the learned
    // layer selects `none` and every tier below is the floor's doing alone.
    const pressure = (stakes: number, reliabilityRequired: number): PolicyAxes => ({
      stakes, costPressure: 1, privacy: 0, latencyUrgency: 1, reliabilityRequired,
    });
    expect(floorTierIndex(pressure(0.34, 0))).toBe(0);
    expect(floorTierIndex(pressure(0.35, 0))).toBe(1);
    expect(floorTierIndex(pressure(0.69, 0))).toBe(1);
    expect(floorTierIndex(pressure(0.7, 0))).toBe(2);
    expect(floorTierIndex(pressure(0, 0.79))).toBe(0);
    expect(floorTierIndex(pressure(0, 0.8))).toBe(2);

    // …and end-to-end, because a floor that computes correctly but is not applied is the
    // same outage. These are the exact points the verifier showed silently dropping.
    expect(selectProofTier(pressure(0.7, 0)).tier).toBe('current_validity');
    expect(selectProofTier(pressure(0.69, 0)).tier).toBe('inclusion');
    expect(selectProofTier(pressure(0, 0.8)).tier).toBe('current_validity');
    expect(selectProofTier(pressure(0, 0.79)).tier).toBe('none');
  });
});

describe('proof-tier policy — determinism + interpretability', () => {
  it('P7: identical axes produce a byte-identical decision', () => {
    const axes: PolicyAxes = {
      stakes: 0.62, costPressure: 0.31, privacy: 0.77, latencyUrgency: 0.2, reliabilityRequired: 0.55,
    };
    expect(JSON.stringify(selectProofTier(axes))).toBe(JSON.stringify(selectProofTier(axes)));
  });

  it('names the axes that drove the decision (the enabling-disclosure surface)', () => {
    const d = selectProofTier({
      stakes: 0.95, costPressure: 0.05, privacy: 0.05, latencyUrgency: 0.05, reliabilityRequired: 0.95,
    });
    expect(d.drivers).toContain('stakes');
    expect(d.drivers).toContain('reliabilityRequired');
    expect(d.drivers).not.toContain('costPressure');
    expect(d.rationale).toMatch(/floor|ceiling|learned/);
  });

  it('reports the pre-gate learned choice so the gate\'s effect is measurable', () => {
    // Axes chosen so the floor DEMONSTRABLY bites — max cost + max urgency drive the
    // learned choice down, high stakes drag it back up. A previous version of this test
    // guarded its real assertion behind `if (d.floorApplied)` on axes where the floor
    // never fired, so it passed even when learnedTierIndex was overwritten with the
    // final tier. The guard is now an assertion.
    const d = selectProofTier({
      stakes: 0.75, costPressure: 1, privacy: 0, latencyUrgency: 1, reliabilityRequired: 0,
    });
    expect(d.floorApplied).toBe(true);
    expect(d.learnedTierIndex).toBeLessThan(d.tierIndex);
    expect(d.tierIndex).toBe(expectedFloor({
      stakes: 0.75, costPressure: 1, privacy: 0, latencyUrgency: 1, reliabilityRequired: 0,
    }));
  });
});

describe('proof-tier policy — shadow comparator (inert by construction)', () => {
  it('classifies stronger / weaker / same against the tier in force, with a cost delta', () => {
    const axes: PolicyAxes = {
      stakes: 0.9, costPressure: 0.1, privacy: 0.1, latencyUrgency: 0.1, reliabilityRequired: 0.9,
    };
    const cmp = shadowCompareProofTier('none', axes);
    expect(cmp.delta).toBe('stronger');
    expect(cmp.costDeltaUnits).toBeGreaterThan(0);
    expect(cmp.current.tier).toBe('none');

    const same = shadowCompareProofTier(cmp.policy.tier, axes);
    expect(same.delta).toBe('same');
    expect(same.costDeltaUnits).toBe(0);
  });

  it('a cheap low-stakes call is reported as over-proven when current policy is maximal', () => {
    const cmp = shadowCompareProofTier('ranking_integrity', {
      stakes: 0, costPressure: 1, privacy: 0, latencyUrgency: 1, reliabilityRequired: 0,
    });
    expect(cmp.delta).toBe('weaker');
    expect(cmp.costDeltaUnits).toBeLessThan(0);
  });
});
