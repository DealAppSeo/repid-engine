/**
 * RepID incentive properties — does the scoring path pay for good behaviour? Yes, since 2026-08-17.
 *
 * Every test here composes the REAL functions (`deriveHalDecision` + `computeDelta`) rather than
 * restating their arithmetic. A property proved against a reimplementation proves nothing about
 * production (LESSONS §2).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THESE TWO PROPERTIES WERE FALSE UNTIL 2026-08-17 AND ARE NOW ENFORCED
 * ════════════════════════════════════════════════════════════════════════════════
 * The defect: `hal_score` is a hallucination-RISK score (HIGH IS BAD — src/hal/lib/score.ts, and
 * `deriveHalDecision` returns 'clean' only below 0.40), and `computeDelta`'s clean branch read it as
 * though HIGH WERE GOOD, with nothing inverting it in between. Composed, quality was paid inversely:
 * a perfectly grounded claim earned -1.0 while the riskiest still-clean claim earned the most.
 *
 * They were carried here as `it.failing` — which passes while the body throws and fails once it
 * starts passing — precisely so that fixing the orientation would turn them RED and force this
 * update rather than letting the defect quietly become a feature. It worked: the fix
 * (Sean, 2026-08-17 — the clean branch consumes QUALITY) flipped them, and they are now ordinary
 * assertions guarding against regression.
 *
 * Full measurement of the defect, kept for the record: reports/2026-08-17/REPID-INCENTIVE-AUDIT.md.
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

  it('pins the boundary that made the old unit tests unreachable', () => {
    // tests/repid-delta.test.ts USED to assert clean@0.95 → +2.8 and clean@1.0 → +3. Both were
    // unreachable — the pipeline flags anything ≥ 0.40 — so they validated an orientation production
    // never used, which is why the inversion survived (LESSONS §6). Those cases were rewritten onto
    // reachable risks when the orientation was fixed; this assertion keeps the boundary fact itself
    // under test, so the same class of unreachable fixture cannot be reintroduced unnoticed.
    expect(deriveHalDecision(0.95, false, null)).toBe('flagged');
    expect(deriveHalDecision(1.0, false, null)).toBe('flagged');
  });
});

describe('PROPERTY: reward must not increase with hallucination risk', () => {
  it('pays a better-grounded claim at least as much as a worse one', () => {
    // Was `it.failing` until the orientation fix; every adjacent pair on the clean branch used to
    // violate this. An empty list over the sampled grid is a proof of the property, not weak
    // evidence for it — a monotone-decreasing sequence has no adjacent increase.
    expect(monotonicityViolations(401, AGENT)).toEqual([]);
  });

  it('holds at a finer sampling too, so the grid is not hiding a local inversion', () => {
    expect(monotonicityViolations(1601, AGENT)).toEqual([]);
  });
});

describe('PROPERTY: a maximally well-grounded claim must not be punished', () => {
  it('does not penalise a zero-risk claim', () => {
    // Was `it.failing`: a perfectly grounded claim used to be paid -1.0.
    const d = computeDelta({ hal_score: 0, hal_decision: 'clean', ...AGENT });
    expect(d.delta_applied).toBeGreaterThanOrEqual(0);
  });

  it('pays the documented ceiling for a zero-risk claim, which is now reachable', () => {
    const d = computeDelta({ hal_score: 0, hal_decision: 'clean', ...AGENT });
    expect(d.delta_applied).toBeCloseTo(3, 5);
  });

  it('never pays a negative delta anywhere on the clean branch', () => {
    for (const p of reachableCleanPoints(1601, AGENT)) {
      expect(p.delta_applied).toBeGreaterThan(0);
    }
  });
});

describe('what the system pays the most for', () => {
  it('maximises reward at the best-grounded end of the branch', () => {
    const best = rewardMaximisingRisk(4001, AGENT);
    expect(best.decision).toBe('clean');
    // The reward-maximising behaviour is now "be as well grounded as possible" — the opposite of
    // the pre-fix answer, which was "be as risky as possible without tripping the flag".
    expect(best.risk).toBeLessThan(0.02);
  });

  it('reaches the documented +3 ceiling and stays under the +5 clamp', () => {
    const { best } = cleanExtrema(4001, AGENT);
    expect(best.delta_applied).toBeCloseTo(3, 5);
    expect(best.delta_applied).toBeLessThanOrEqual(5);
  });

  it('is not inverted end to end', () => {
    expect(cleanExtrema(4001, AGENT).inverted).toBe(false);
  });

  it('still pays the worst still-clean claim a positive, smaller reward', () => {
    const { worst } = cleanExtrema(4001, AGENT);
    expect(worst.risk).toBeGreaterThan(0.38);
    expect(worst.delta_applied).toBeGreaterThan(0);
    expect(worst.delta_applied).toBeLessThan(cleanExtrema(4001, AGENT).best.delta_applied);
  });
});

describe('PROPERTIES THAT HOLD — the anti-gaming floor that is genuinely there', () => {
  it('makes a confirmed hallucination cost far more than any clean event earns', () => {
    const veto = computeDelta({ hal_score: 0.9, hal_decision: 'vetoed', ...AGENT }).delta_applied;
    const { best } = cleanExtrema(4001, AGENT);
    expect(veto).toBe(-10);
    // Asymmetry is the core anti-gaming property: one caught fabrication must outweigh several wins.
    // The fix RAISED clean rewards (ceiling +0.6 -> +3.0), so it necessarily WEAKENED this ratio
    // from ~17 events per veto to ~4. Asserted at 3 so the guard is real: if clean rewards are ever
    // raised again past a third of the veto, this goes red and the trade-off gets re-decided.
    expect(Math.abs(veto)).toBeGreaterThan(best.delta_applied * 3);
  });

  it('still requires several best-case clean events to repay one veto', () => {
    const { best } = cleanExtrema(4001, AGENT);
    const breakEven = Math.ceil(10 / best.delta_applied);
    expect(breakEven).toBeGreaterThanOrEqual(4);
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
