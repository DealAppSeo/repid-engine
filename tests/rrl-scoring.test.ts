/**
 * WS2.3 — anti-drift unit tests for the extracted RRL scoring core (src/rrl/scoring.ts).
 * Asserts the module reproduces KNOWN deltas from the WS2.2 sim's locked math, and that the
 * stateful RRLScorer composes them correctly. If any of these change, the extracted core has
 * drifted from the sim-proven rule and the honesty-dominance result is no longer guaranteed.
 */
import {
  defaultRRLParams,
  allMechanismsOn,
  calibrationDelta,
  credentialFactor,
  disclosureBonusFor,
  learningAdjustedRepairBonus,
  concealmentPenalty,
  settleEscrow,
  independentCorrectBonus,
  btsBonusFor,
  RRLScorer,
} from '../src/rrl/scoring';

const P = defaultRRLParams();

describe('RRL locked parameters (values are a design decision, not casual)', () => {
  it('holds the WS2.2-locked knobs', () => {
    expect(P.R_participation).toBe(4.0);
    expect(P.K_cal).toBe(20);
    expect(P.repairBonus0).toBe(3.0);
    expect(P.repairDecayLambda).toBe(0.9);
    expect(P.repairRecencyWindow).toBe(40);
    expect(P.concealMult).toBe(3.0);
    expect(P.escrowFrac).toBe(0.4);
  });
});

describe('calibration — Brier proper rule delta = R - K*(p-outcome)^2', () => {
  it('confident + right (p=0.8, outcome=1) => 3.2', () => {
    expect(calibrationDelta(0.8, 1, P)).toBeCloseTo(3.2, 10);
  });
  it('overconfident + wrong (p=0.97, outcome=0) => -14.818', () => {
    expect(calibrationDelta(0.97, 0, P)).toBeCloseTo(-14.818, 6);
  });
  it('low-confidence + wrong (p=0.35, outcome=0) => 1.55 (lightly penalized)', () => {
    expect(calibrationDelta(0.35, 0, P)).toBeCloseTo(1.55, 10);
  });
});

describe('M9 credential factor — shaves positive gains by miscalibration', () => {
  it('overconfident (stated 0.97 vs realized 0.73) => 0.52', () => {
    expect(credentialFactor(0.97, 0.73, P)).toBeCloseTo(0.52, 10);
  });
  it('well-calibrated (stated 0.725 vs realized 0.731) ≈ 0.988', () => {
    expect(credentialFactor(0.725, 0.731, P)).toBeCloseTo(0.988, 6);
  });
  it('floors at 0.4 for extreme miscalibration', () => {
    expect(credentialFactor(0.99, 0.1, P)).toBe(0.4);
  });
});

describe('disclosure bonus — protected uncertainty on non-trivial claims', () => {
  it('disclosed on a non-easy claim => +0.6', () => {
    expect(disclosureBonusFor(true, 0.5, P)).toBe(0.6);
  });
  it('disclosed on an easy claim => 0 (no bonus for hedging the obvious)', () => {
    expect(disclosureBonusFor(true, 0.1, P)).toBe(0);
  });
  it('not disclosed => 0', () => {
    expect(disclosureBonusFor(false, 0.5, P)).toBe(0);
  });
});

describe('M1 learning-adjusted repair bonus', () => {
  it('first repair of a novel class => full bonus 3', () => {
    expect(learningAdjustedRepairBonus(0, true, P)).toBeCloseTo(3.0, 10);
  });
  it('second same-class repair decays by exp(-0.9) => ~1.2197', () => {
    expect(learningAdjustedRepairBonus(1, true, P)).toBeCloseTo(3 * Math.exp(-0.9), 10);
  });
  it('recurring (>= threshold 3) => non-learning penalty -2.5', () => {
    expect(learningAdjustedRepairBonus(3, true, P)).toBe(-2.5);
  });
  it('M1 OFF => flat bonus (this is what lets error-farming pay)', () => {
    expect(learningAdjustedRepairBonus(5, false, P)).toBe(3.0);
  });
});

describe('concealment + escrow settlement', () => {
  it('concealment penalty = 3x base', () => {
    expect(concealmentPenalty(2, P)).toBe(6);
  });
  it('escrow released fully when correct', () => {
    expect(settleEscrow(1, 5, 0.8)).toBe(5);
  });
  it('escrow clawed back (0.5 + stated) when confident-wrong', () => {
    expect(settleEscrow(0, 5, 0.8)).toBeCloseTo(-6.5, 10);
  });
});

describe('cross-agent primitives', () => {
  it('independent-correct bonus scales with rarity', () => {
    expect(independentCorrectBonus(0.2, P)).toBeCloseTo(1.2, 10); // 1.5*(1-0.2)
  });
  it('BTS bonus peaks at consensus and vanishes at degeneracy', () => {
    expect(btsBonusFor(0.5, P)).toBeCloseTo(0.4, 10); // 0.8*(0.5-0)
    expect(btsBonusFor(1.0, P)).toBeCloseTo(0.0, 10); // 0.8*(0.5-0.5)
  });
});

describe('RRLScorer composes the primitives exactly (known sim delta path)', () => {
  it('a correct, disclosed answer at conf 0.8 on a difficulty-0.5 claim => immediate 2.52, then 3.8 after escrow settles', () => {
    const s = new RRLScorer('t', P, allMechanismsOn());
    const obs = s.observe({
      agentId: 't',
      round: 0,
      abstain: false,
      confidence: 0.8,
      correct: 1,
      disclosed: true,
      difficulty: 0.5,
      errorClass: 3,
    });
    // cal=3.2, escrow holds 3.2*0.4=1.28, +disclosure 0.6 => 3.2-1.28+0.6 = 2.52
    expect(obs.immediateDelta).toBeCloseTo(2.52, 10);
    expect(obs.escrowHeld).toBeCloseTo(1.28, 10);
    expect(obs.mechanismsFired).toEqual(expect.arrayContaining(['calibration', 'disclosure', 'M8 escrow']));
    // settle at maturation round: correct => held 1.28 released => cumDelta 3.8
    s.settle(0 + P.escrowMatureLag);
    expect(s.cumDelta).toBeCloseTo(3.8, 10);
  });

  it('never mutates any external state — wouldBeRepid derives purely from cumDelta', () => {
    const s = new RRLScorer('t2', P, allMechanismsOn());
    expect(s.wouldBeRepid).toBe(1000); // baseline, no events
    s.observe({ agentId: 't2', round: 0, abstain: false, confidence: 0.9, correct: 1, disclosed: false, difficulty: 0.5, errorClass: 1 });
    expect(s.wouldBeRepid).toBeGreaterThan(1000);
  });
});
