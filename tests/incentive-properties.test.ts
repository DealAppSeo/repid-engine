/**
 * RepID incentive properties — does the scoring path pay for good behaviour?
 *
 * Every test here composes the REAL functions (`deriveHalDecision` + `computeDelta`) rather than
 * restating their arithmetic. A property proved against a reimplementation proves nothing about
 * production (LESSONS §2).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * TWO PROPERTIES ARE CURRENTLY FALSE, AND THEY USE `it.failing`
 * ════════════════════════════════════════════════════════════════════════════════
 * `it.failing` passes while its body throws and FAILS once the body starts passing. So a violated
 * property is recorded as a live, named defect that CI carries green — and the moment someone
 * corrects the orientation, these two go red and force a deliberate update. That is the opposite of
 * deleting the assertion or softening it to match the behaviour, which is how a defect becomes a
 * feature nobody remembers choosing.
 *
 * The defect: `hal_score` is a hallucination-RISK score (HIGH IS BAD — src/hal/lib/score.ts, and
 * `deriveHalDecision` returns 'clean' only below 0.40). `computeDelta`'s clean branch reads it as
 * though HIGH WERE GOOD. Nothing inverts it in between (src/scoring/pipeline.ts passes one value to
 * both). Composed, quality is paid inversely.
 *
 * NOT FIXED HERE. `computeDelta` is on the live scoring path; changing it is Sean's call
 * (CLAUDE-RULE-2, CLAUDE-RULE-3). These tests measure and pin.
 */
import {
  sampleCurve,
  reachableCleanPoints,
  cleanExtrema,
  monotonicityViolations,
  rewardMaximisingRisk,
  reachableDecisions,
  NEUTRAL_AGENT,
} from '../src/incentives/reward-curve';
import { computeDelta } from '../src/scoring/repid-delta';
import { deriveHalDecision } from '../src/scoring/pipeline';

const AGENT = NEUTRAL_AGENT;

describe('the reachability fact the whole analysis rests on', () => {
  it("never classifies a high-risk claim as 'clean'", () => {
    // If this ever changes, every conclusion below is void — which is why it is asserted first.
    for (let i = 0; i <= 1000; i++) {
      const risk = i / 1000;
      const decision = deriveHalDecision(risk, false, null);
      if (risk >= 0.4) expect(decision).not.toBe('clean');
    }
  });

  it('can only ever produce clean or flagged from the score alone', () => {
    // 'vetoed' needs the boolean or a critical Comma severity; 'abstain' comes from HAL, not here.
    expect([...reachableDecisions()].sort()).toEqual(['clean', 'flagged']);
  });

  it('confirms the existing unit tests exercise combinations production cannot emit', () => {
    // tests/repid-delta.test.ts asserts clean@0.95 → +2.8 and clean@1.0 → +3. Both are unreachable:
    // the pipeline flags anything ≥ 0.40. Those assertions validate an orientation production never
    // uses, which is why the inversion below survived unnoticed (LESSONS §6).
    expect(deriveHalDecision(0.95, false, null)).toBe('flagged');
    expect(deriveHalDecision(1.0, false, null)).toBe('flagged');
  });
});

describe('PROPERTY: reward must not increase with hallucination risk', () => {
  it.failing('pays a better-grounded claim at least as much as a worse one', () => {
    const violations = monotonicityViolations(401, AGENT);
    // Currently every adjacent pair on the clean branch violates this.
    expect(violations).toEqual([]);
  });

  it('records the violation quantitatively, so the size is not lost', () => {
    const violations = monotonicityViolations(401, AGENT);
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) {
      expect(v.higherRisk.risk).toBeGreaterThan(v.lowerRisk.risk);
      expect(v.rewardGain).toBeGreaterThan(0);
    }
  });
});

describe('PROPERTY: a maximally well-grounded claim must not be punished', () => {
  it.failing('does not penalise a zero-risk claim', () => {
    const d = computeDelta({ hal_score: 0, hal_decision: 'clean', ...AGENT });
    expect(d.delta_applied).toBeGreaterThanOrEqual(0);
  });

  it('records what a zero-risk claim is actually paid', () => {
    const d = computeDelta({ hal_score: 0, hal_decision: 'clean', ...AGENT });
    expect(d.delta_applied).toBeLessThan(0);
  });
});

describe('what the system currently pays the most for', () => {
  it('maximises reward at high risk, just under the flag threshold', () => {
    const best = rewardMaximisingRisk(4001, AGENT);
    expect(best.decision).toBe('clean');
    // The reward-maximising behaviour is "be as risky as possible without tripping the flag".
    expect(best.risk).toBeGreaterThan(0.38);
    expect(best.risk).toBeLessThan(0.4);
  });

  it('caps the best reachable clean reward far below the advertised +5', () => {
    const { best } = cleanExtrema(4001, AGENT);
    // The delta clamp allows +5 and the module comment advertises up to +3 at score 1.0, but the
    // decision gate makes anything ≥0.40 'flagged', so the true ceiling on a clean event is ~+0.6.
    expect(best.delta_applied).toBeLessThan(1);
    expect(best.delta_applied).toBeGreaterThan(0);
  });

  it('has an inverted clean branch end to end', () => {
    expect(cleanExtrema(4001, AGENT).inverted).toBe(true);
  });
});

describe('PROPERTIES THAT HOLD — the anti-gaming floor that is genuinely there', () => {
  it('makes a confirmed hallucination cost far more than any clean event earns', () => {
    const veto = computeDelta({ hal_score: 0.9, hal_decision: 'vetoed', ...AGENT }).delta_applied;
    const { best } = cleanExtrema(4001, AGENT);
    expect(veto).toBe(-10);
    // Asymmetry is the core anti-gaming property: one caught fabrication must outweigh many wins.
    expect(Math.abs(veto)).toBeGreaterThan(best.delta_applied * 10);
  });

  it('requires many best-case clean events to repay one veto', () => {
    const { best } = cleanExtrema(4001, AGENT);
    const breakEven = Math.ceil(10 / best.delta_applied);
    // Recorded rather than asserted at a magic number: this is the farming exchange rate.
    expect(breakEven).toBeGreaterThan(10);
  });

  it('pays nothing for an unfalsifiable claim, so abstention cannot be farmed', () => {
    const d = computeDelta({ hal_score: 0.5, hal_decision: 'abstain', ...AGENT });
    expect(d.delta_calculated).toBe(0);
    expect(d.delta_applied).toBe(0);
  });

  it('pays nothing for an unconfirmed flag, in either direction', () => {
    for (const risk of [0.4, 0.6, 0.95, 1.0]) {
      const d = computeDelta({ hal_score: risk, hal_decision: 'flagged', ...AGENT });
      expect(d.delta_calculated).toBe(0);
      expect(d.delta_applied).toBe(0);
    }
  });

  it('never lets floor protection turn a penalty into a reward', () => {
    // An agent at the floor taking a veto must still be penalised or neutral, never paid.
    for (const current_repid of [1, 2, 5, 10, 11, 15]) {
      const d = computeDelta({
        hal_score: 0.9,
        hal_decision: 'vetoed',
        current_repid,
        agent_tier: 'PROBATIONARY',
        vesting_cliff_active: false,
      });
      expect(d.delta_applied).toBeLessThanOrEqual(0);
    }
  });

  it('clamps every reachable delta into [-10, +5]', () => {
    for (const p of sampleCurve(201, AGENT)) {
      expect(p.delta_calculated).toBeGreaterThanOrEqual(-10);
      expect(p.delta_calculated).toBeLessThanOrEqual(5);
    }
    for (const decision of ['vetoed', 'flagged', 'abstain', 'clean'] as const) {
      for (const risk of [0, 0.25, 0.5, 0.75, 1]) {
        const d = computeDelta({ hal_score: risk, hal_decision: decision, ...AGENT });
        expect(d.delta_calculated).toBeGreaterThanOrEqual(-10);
        expect(d.delta_calculated).toBeLessThanOrEqual(5);
      }
    }
  });

  it('lets the vesting cliff absorb penalties but never withhold rewards', () => {
    const vesting = { ...AGENT, vesting_cliff_active: true };
    const penalty = computeDelta({ hal_score: 0.9, hal_decision: 'vetoed', ...vesting });
    expect(penalty.delta_calculated).toBe(-10);
    expect(penalty.delta_applied).toBe(0);

    // A positive must survive the cliff untouched, or new agents are silently starved.
    const best = cleanExtrema(4001, AGENT).best;
    const reward = computeDelta({ hal_score: best.risk, hal_decision: 'clean', ...vesting });
    expect(reward.delta_applied).toBeCloseTo(best.delta_applied, 5);
  });
});

describe('GAMING VECTOR: the vesting cliff is a cost-free window', () => {
  it('makes fabrication free while the cliff is active', () => {
    // Not presented as a bug — the cliff is a deliberate amnesty for new agents. It is recorded
    // because "penalties are absorbed" and "fabrication is free" are the same sentence, and the
    // window's length is what decides whether that is acceptable.
    const vesting = { ...AGENT, vesting_cliff_active: true };
    for (let i = 0; i < 25; i++) {
      const d = computeDelta({ hal_score: 0.95, hal_decision: 'vetoed', ...vesting });
      expect(d.delta_applied).toBe(0);
    }
  });
});

describe('the reachable curve is stable enough to chart', () => {
  it('yields a clean branch and a flagged branch with a boundary between them', () => {
    const pts = sampleCurve(101, AGENT);
    const clean = pts.filter((p) => p.decision === 'clean');
    const flagged = pts.filter((p) => p.decision === 'flagged');
    expect(clean.length).toBeGreaterThan(10);
    expect(flagged.length).toBeGreaterThan(10);
    // Every clean point sits strictly below every flagged point on the risk axis.
    const maxClean = Math.max(...clean.map((p) => p.risk));
    const minFlagged = Math.min(...flagged.map((p) => p.risk));
    expect(maxClean).toBeLessThan(minFlagged);
  });

  it('has reachable clean points to chart at all', () => {
    expect(reachableCleanPoints(401, AGENT).length).toBeGreaterThan(100);
  });
});
