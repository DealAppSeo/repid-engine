/**
 * proof-tier-regret.test.ts — pins the MEASUREMENT behind Patent #2's enabling disclosure.
 *
 * #225 pinned properties (safety floor, monotonicity, rung reachability) over a
 * 32,768-point grid. Properties cannot produce regret: regret needs a notion of what the
 * right answer was, and a grid has none. This suite pins the measurement that supplies
 * it — and, more importantly, pins the CLAIMS the measurement is used to make, because
 * the recurring failure in this codebase has been a test that pins something weaker than
 * the sentence it is cited to support.
 *
 * So the assertions here are deliberately of three different kinds, and the distinction
 * is load-bearing:
 *   STRUCTURAL — the corpus cannot depend on the policy. Enforced by reading the file,
 *                not by trusting the author's comment saying so.
 *   CLAIM      — the inequalities that Patent #2's value argument actually rests on.
 *                These must break if the learned fabric is removed; that is checked by
 *                mutation, not assumed.
 *   DISCLOSED  — characterisation literals, including two literals that pin LIMITATIONS
 *                (the floor never binds on real traffic; one under-proof is structurally
 *                out of the floor's reach). Pinning a limitation is intentional: if a
 *                later change fixes it, this suite fails and forces the disclosure to be
 *                updated rather than silently going stale.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PROOF_TIERS,
  TIER_COST_UNITS,
  floorTierIndex,
  selectProofTier,
} from '../src/services/proof-tier-policy';
import { PROOF_TIER_CORPUS } from '../src/services/proof-tier-corpus';
import {
  crossoverPrice,
  requiredIndexOf,
  runRegretMeasurement,
  scoreStrategy,
  type StrategyResult,
} from '../src/services/proof-tier-regret';

const byName = (rs: StrategyResult[], n: string): StrategyResult =>
  rs.find((r) => r.name === n) as StrategyResult;

describe('proof-tier regret — STRUCTURAL: the oracle cannot be derived from the policy', () => {
  const corpusPath = path.join(__dirname, '..', 'src', 'services', 'proof-tier-corpus.ts');
  const source = fs.readFileSync(corpusPath, 'utf8');

  it('the corpus file contains no import or require of any kind', () => {
    // The self-referential-oracle bug has landed twice in five beats, both times because
    // an expectation was computed — directly or transitively — by the code under test.
    // A corpus with zero imports cannot do that no matter how it is edited later.
    const importLines = source
      .split(/\r?\n/)
      .filter((l) => /^\s*(import\b|export\s+.*\bfrom\b|const\s+.*=\s*require\()/.test(l));
    expect(importLines).toEqual([]);
  });

  it('every declared requiredTier is a real rung of the ladder', () => {
    // The corpus deliberately re-declares the tier names as a literal union rather than
    // importing the type. That buys independence but costs a compile-time link, so the
    // link is restored here at test time instead of being left to drift.
    for (const s of PROOF_TIER_CORPUS) {
      expect(PROOF_TIERS).toContain(s.requiredTier);
    }
  });

  it('every scenario carries a stated justification a reader can check', () => {
    for (const s of PROOF_TIER_CORPUS) {
      expect(s.why.length).toBeGreaterThan(40);
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
    }
    expect(new Set(PROOF_TIER_CORPUS.map((s) => s.id)).size).toBe(PROOF_TIER_CORPUS.length);
  });

  it('the corpus exercises every rung as a REQUIRED answer, not just as an output', () => {
    // A corpus that never requires the top rung cannot detect under-proof at the top —
    // which is exactly where the residual failure turned out to live.
    const required = new Set(PROOF_TIER_CORPUS.map((s) => s.requiredTier));
    for (const t of PROOF_TIERS) expect(required).toContain(t);
  });
});

describe('proof-tier regret — DISCLOSED: the measured table (characterisation)', () => {
  const { results, oracleCostUnits, n, floorFirings, ceilingFirings } = runRegretMeasurement();

  it('is deterministic across runs', () => {
    expect(runRegretMeasurement().results).toEqual(results);
  });

  it('pins the corpus size and the cost of perfect play', () => {
    expect(n).toBe(30);
    expect(oracleCostUnits).toBe(244);
  });

  it.each([
    // name,                    exact, under, over, overCost, totalCost
    ['always_none', 6, 24, 0, 0, 0],
    ['always_max', 4, 0, 26, 956, 1200],
    ['fixed_current_validity', 10, 8, 12, 30, 90],
    ['floor_only', 20, 9, 1, 2, 61],
    ['learned_only', 13, 1, 16, 304, 520],
    ['policy', 14, 1, 15, 295, 511],
  ])(
    '%s: exact=%i under=%i over=%i overCost=%i cost=%i',
    (name, exact, under, over, overCost, cost) => {
      const r = byName(results, name as string);
      expect([r.exact, r.underProof, r.overProof, r.overProofCostUnits, r.totalCostUnits]).toEqual([
        exact,
        under,
        over,
        overCost,
        cost,
      ]);
    },
  );

  it('LIMITATION, pinned: the deterministic floor never binds on a single real scenario', () => {
    // The floor fires 3,092 times on #225's synthetic grid and 0 times here. Both are
    // true and the gap is the finding: the learned layer over-proves so consistently on
    // realistic traffic that the safety gate is never the binding constraint. The floor
    // still earns its place — it is what makes a drifted policy safe rather than merely
    // observed-to-be-safe — but its measured contribution on this corpus is zero, and
    // saying otherwise would overstate the shipped system.
    expect(floorFirings).toBe(0);
    expect(ceilingFirings).toBe(1);
  });

  it('…and the floor is demonstrably ALIVE, so “never binds” cannot mean “was deleted”', () => {
    // Found by mutation, not by reading: deleting the high-stakes floor rung, and even
    // removing the floor's application entirely, both left the assertion above green.
    // `floorFirings === 0` is equally true of a floor that never binds and of a floor
    // that does not exist — the same weaker-property-than-claimed failure this suite was
    // written in reaction to, reproduced in the suite itself. Two witnesses, each chosen
    // so that exactly one floor rung is the binding cause, restore the distinction.
    const stakesDriven = {
      stakes: 0.7, // ≥ HIGH_STAKES_FLOOR
      costPressure: 0.1,
      privacy: 0,
      latencyUrgency: 0.9,
      reliabilityRequired: 0, // deliberately below RELIABILITY_FLOOR, so stakes is the sole cause
    };
    const dStakes = selectProofTier(stakesDriven);
    expect(dStakes.floorApplied).toBe(true);
    expect(dStakes.learnedTierIndex).toBeLessThan(dStakes.tierIndex);
    expect(dStakes.tierIndex).toBe(2);

    const reliabilityDriven = {
      stakes: 0, // below every stakes rung, so reliability is the sole cause
      costPressure: 0,
      privacy: 0,
      latencyUrgency: 0.8,
      reliabilityRequired: 0.8, // ≥ RELIABILITY_FLOOR
    };
    const dRel = selectProofTier(reliabilityDriven);
    expect(dRel.floorApplied).toBe(true);
    expect(dRel.tierIndex).toBe(2);
  });

  it('LIMITATION, pinned: the one residual under-proof is out of the floor’s structural reach', () => {
    const policy = byName(results, 'policy');
    expect(policy.underProofIds).toEqual(['best-provider-route']);

    const scenario = PROOF_TIER_CORPUS.find((s) => s.id === 'best-provider-route');
    expect(scenario).toBeDefined();
    const required = requiredIndexOf(scenario!);

    // floorTierIndex's range is {0,1,2} — swept rather than asserted from reading it, so
    // the claim survives someone editing the function.
    let maxFloor = 0;
    for (let a = 0; a <= 20; a++) {
      for (let r = 0; r <= 20; r++) {
        const f = floorTierIndex({
          stakes: a / 20,
          costPressure: 0.5,
          privacy: 0.5,
          latencyUrgency: 0.5,
          reliabilityRequired: r / 20,
        });
        if (f > maxFloor) maxFloor = f;
      }
    }
    expect(maxFloor).toBe(2);

    // Therefore no setting of the stakes/reliability axes could have caught this one:
    // the requirement comes from the SHAPE of the claim (an ordering over a set), which
    // the current floor has no input for. That is the gap a shape-keyed floor rung would
    // close, and it is disclosed rather than smoothed over.
    expect(required).toBeGreaterThan(maxFloor);
  });
});

describe('proof-tier regret — CLAIM: what Patent #2’s value argument actually rests on', () => {
  const { results } = runRegretMeasurement();
  const policy = byName(results, 'policy');
  const floorOnly = byName(results, 'floor_only');
  const alwaysMax = byName(results, 'always_max');
  const fixed = byName(results, 'fixed_current_validity');

  it('the learned layer strictly beats rules-only on safety', () => {
    // If a deterministic floor alone matched the policy's under-proof count, the learned
    // fabric would be decoration and the patent claim would be weaker than stated. This
    // is the inequality that says otherwise, and it is the one a linear-substitution
    // mutation must break.
    expect(policy.underProof).toBeLessThan(floorOnly.underProof);
    expect(policy.underProof).toBeLessThan(fixed.underProof);
  });

  it('and strictly beats prove-everything on cost', () => {
    expect(policy.totalCostUnits).toBeLessThan(alwaysMax.totalCostUnits);
    expect(alwaysMax.underProof).toBe(0); // the only thing always_max is good at
  });

  it('is the strict regret minimiser at a price inside its operating band', () => {
    const P = 100;
    const regret = (r: StrategyResult) => r.overProofCostUnits + P * r.underProof;
    const mine = regret(policy);
    for (const r of results) {
      if (r.name === 'policy') continue;
      expect(regret(r)).toBeGreaterThan(mine);
    }
  });

  it('the operating band is non-empty, and both edges are pinned', () => {
    // Affine regret ⇒ each pair crosses at most once, so the band is exact rather than
    // searched. Disclosing it converts "the policy is better" — true only inside a band —
    // into "the policy is better IFF an under-proven claim costs more than X", which a
    // reader can price for themselves and can falsify.
    let lower = 0;
    let upper = Infinity;
    for (const r of results) {
      if (r.name === 'policy') continue;
      const p = crossoverPrice(policy, r);
      if (p === null) continue;
      if (policy.underProof < r.underProof) lower = Math.max(lower, p);
      else upper = Math.min(upper, p);
    }
    expect(lower).toBeLessThan(upper);
    expect(lower).toBeCloseTo(265 / 7, 6); // 37.857… — set by fixed_current_validity, not floor_only
    expect(upper).toBeCloseTo(661.0, 6); // set by always_max

    // The lower edge lands just below the cost of one ranking_integrity proof (40 units).
    // Stated plainly: proving is worth paying for exactly when being wrong costs more
    // than the most expensive proof on the ladder.
    expect(lower).toBeLessThan(TIER_COST_UNITS[TIER_COST_UNITS.length - 1] as number);
  });

  it('scoreStrategy agrees with a hand-rolled count on a two-scenario slice', () => {
    // Guards the arithmetic itself: every headline number above flows through this
    // function, so a bug here would move the whole table coherently and look fine.
    const slice = PROOF_TIER_CORPUS.filter((s) =>
      ['internal-drill', 'stake-sufficient'].includes(s.id),
    );
    expect(slice).toHaveLength(2);
    const r = scoreStrategy({ name: 't', note: '', select: () => 4 }, slice);
    // Both scored at rung 4 (cost 40): required none (0) and current_validity (3).
    expect(r.underProof).toBe(0);
    expect(r.overProof).toBe(2);
    expect(r.totalCostUnits).toBe(80);
    expect(r.overProofCostUnits).toBe(40 - 0 + (40 - 3));
    expect(r.exact).toBe(0);
  });

  it('the per-scenario decisions in the report match selectProofTier exactly', () => {
    // The CLI re-derives decisions for its per-scenario listing; if that ever drifted
    // from the scored table the report would be quietly lying about which scenario failed.
    const policyResult = scoreStrategy(
      { name: 'policy', note: '', select: (a) => selectProofTier(a).tierIndex },
      PROOF_TIER_CORPUS,
    );
    const { note: _a, ...mine } = policyResult;
    const { note: _b, ...theirs } = byName(results, 'policy');
    expect(mine).toEqual(theirs);
  });
});
