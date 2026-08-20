/**
 * proof-tier-regret.test.ts — pins the MEASUREMENT behind the proof-tier policy’s enabling disclosure.
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
 *   CLAIM      — the inequalities that the proof-tier policy’s value argument actually rests on.
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
  operatingBand,
  requiredIndexOf,
  runRegretMeasurement,
  scoreStrategy,
  UNDER_PROOF_PRICES,
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

  it.each([
    // The three PUBLISHED regret columns, as literals. These are printed in the report and
    // quoted in the disclosure, and until now nothing asserted them: flipping the sign of
    // the under-proof term, and deleting that term outright, each left the entire suite
    // green. A published number with no test is a number that can ship wrong.
    // name,                     R@10, R@40, R@200
    ['always_none', 240, 960, 4800],
    ['always_max', 956, 956, 956],
    ['fixed_current_validity', 110, 350, 1630],
    ['floor_only', 92, 362, 1802],
    ['learned_only', 314, 344, 504],
    ['policy', 305, 335, 495],
  ])('%s: regret@10=%i regret@40=%i regret@200=%i', (name, r10, r40, r200) => {
    const r = byName(results, name as string);
    expect([r.regretAtPrice[10], r.regretAtPrice[40], r.regretAtPrice[200]]).toEqual([
      r10,
      r40,
      r200,
    ]);
  });

  it('the regret column is the SAME quantity the band is derived from, at every price', () => {
    // Recomputed from the two components — which are pinned to independent literals in the
    // table above — rather than from the formula under test. A sign flip or a dropped
    // penalty changes the column but not the components, so this separates them.
    for (const r of results) {
      for (const p of UNDER_PROOF_PRICES) {
        expect(r.regretAtPrice[p]).toBe(r.overProofCostUnits + p * r.underProof);
      }
      // Slope in price is the under-proof count, and it is POSITIVE: paying more per
      // under-proof must cost a strategy more, never less. This is the assertion the
      // sign-flip mutant dies on even if someone later re-derives the literals above.
      const slope =
        ((r.regretAtPrice[200] as number) - (r.regretAtPrice[10] as number)) / 190;
      expect(slope).toBe(r.underProof);
    }
  });

  it('…and the published columns actually reverse the ranking across the band', () => {
    // The point of disclosing three prices is that the winner CHANGES. If the columns were
    // decorative — or the penalty deleted — floor_only would win at every price and the
    // whole "operating band" framing would be unsupported by the printed table.
    const policy = byName(results, 'policy');
    const floorOnly = byName(results, 'floor_only');
    expect(floorOnly.regretAtPrice[10] as number).toBeLessThan(policy.regretAtPrice[10] as number);
    expect(policy.regretAtPrice[200] as number).toBeLessThan(floorOnly.regretAtPrice[200] as number);
  });

  it('crossoverPrice returns null exactly when two strategies never separate', () => {
    // learned_only and policy both under-prove once, so their regret lines are parallel:
    // one dominates at every price and no crossing exists. Reporting a crossing here would
    // invent a decision point that does not exist.
    const policy = byName(results, 'policy');
    const learned = byName(results, 'learned_only');
    expect(learned.underProof).toBe(policy.underProof);
    expect(crossoverPrice(policy, learned)).toBeNull();
  });

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

describe('proof-tier regret — CLAIM: what the proof-tier policy’s value argument actually rests on', () => {
  const { results } = runRegretMeasurement();
  const policy = byName(results, 'policy');
  const floorOnly = byName(results, 'floor_only');
  const alwaysMax = byName(results, 'always_max');
  const fixed = byName(results, 'fixed_current_validity');

  it('the learned layer strictly beats rules-only on safety', () => {
    // If a deterministic floor alone matched the policy's under-proof count, the learned
    // fabric would be decoration and the design claim would be weaker than stated. This
    // is the inequality that says otherwise, and it is the one a linear-substitution
    // mutation must break.
    expect(policy.underProof).toBeLessThan(floorOnly.underProof);
    expect(policy.underProof).toBeLessThan(fixed.underProof);
  });

  it('and strictly beats prove-everything on cost', () => {
    expect(policy.totalCostUnits).toBeLessThan(alwaysMax.totalCostUnits);
    expect(alwaysMax.underProof).toBe(0); // the only thing always_max is good at
  });

  it('is the strict regret minimiser at a PUBLISHED price inside its operating band', () => {
    // Deliberately reads `regretAtPrice` — the column the report actually prints — rather
    // than recomputing regret from a private lambda. The earlier version of this test
    // recomputed, which is why `regretAtPrice` could be sign-flipped or have its
    // under-proof penalty deleted entirely with the whole suite still green: the field was
    // published to readers and pinned by nobody. 200 is a published price and lies inside
    // (37.9, 661), so the claim and the printed column are now the same quantity.
    const P = 200;
    const mine = policy.regretAtPrice[P] as number;
    for (const r of results) {
      if (r.name === 'policy') continue;
      expect(r.regretAtPrice[P] as number).toBeGreaterThan(mine);
    }
  });

  it('the operating band is non-empty, and both edges are pinned', () => {
    // Affine regret ⇒ each pair crosses at most once, so the band is exact rather than
    // searched. Disclosing it converts "the policy is better" — true only inside a band —
    // into "the policy is better IFF an under-proven claim costs more than X", which a
    // reader can price for themselves and can falsify.
    const { lower, upper } = operatingBand(results);
    expect(lower).toBeLessThan(upper);
    expect(lower).toBeCloseTo(265 / 7, 6); // 37.857… — set by fixed_current_validity, not floor_only
    // ⚠ 661 is CONDITIONAL, not a constant of the policy — it is 661 only because the
    // residual under-proof count is exactly 1. The dependence is pinned two tests below;
    // this literal alone would let the disclosure read "~661" as if it were as solid as
    // the lower edge, which it is not.
    expect(upper).toBeCloseTo(661.0, 6); // set by always_max, divided by policy.underProof === 1
    expect(policy.underProof).toBe(1);

    // The lower edge lands just below the cost of one ranking_integrity proof (40 units).
    // Stated plainly: proving is worth paying for exactly when being wrong costs more
    // than the most expensive proof on the ladder.
    expect(lower).toBeLessThan(TIER_COST_UNITS[TIER_COST_UNITS.length - 1] as number);
  });

  it('DISCLOSED LIMITATION: the upper edge is a STEP FUNCTION of one integer, the lower edge is not', () => {
    // The honest shape of the disclosure. `always_max` under-proves zero times, so the
    // crossing price against it is (its over-proof cost − ours) ÷ OUR under-proof count.
    // That denominator is a small integer, so the upper edge cannot vary smoothly: it
    // halves when the count goes to 2 and disappears entirely when it goes to 0. Asserted
    // against synthetic results rather than described in prose, so a later change that
    // fixes `best-provider-route` fails here and forces the ~661 figure to be restated.
    const synth = (name: string, underProof: number, overProofCostUnits: number): StrategyResult => ({
      name,
      note: '',
      exact: 0,
      underProof,
      underProofIds: [],
      overProof: 0,
      overProofCostUnits,
      totalCostUnits: 0,
      regretAtPrice: {},
    });
    const max = byName(results, 'always_max');
    const build = (underProof: number) => [
      synth('policy', underProof, policy.overProofCostUnits),
      synth('always_max', max.underProof, max.overProofCostUnits),
    ];

    expect(operatingBand(build(1)).upper).toBeCloseTo(661.0, 6);
    expect(operatingBand(build(2)).upper).toBeCloseTo(330.5, 6); // one more miss ⇒ half the ceiling
    expect(operatingBand(build(0)).upper).toBe(Infinity); // parallel lines ⇒ no ceiling at all

    // …while the lower edge, set by a strategy that under-proves MORE than the policy,
    // divides by a difference of counts that is large and does not hinge on one scenario.
    expect(fixed.underProof - policy.underProof).toBeGreaterThan(1);
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

describe('proof-tier regret — ROBUSTNESS: how much of the result rests on my own labels', () => {
  /**
   * The whole measurement rests on 30 labels that the author of the policy also wrote.
   *
   * THIS SWEEP IS THE ANSWER TO THAT, and it is the only part of the answer this repository
   * can prove. Perturb EVERY scenario to EVERY other rung, one at a time, and check the
   * qualitative claim survives all 120. It is strictly stronger than re-checking one
   * alternative label set, because it does not depend on which labels any particular second
   * opinion happened to change — and unlike a report, it fails loudly when the corpus moves.
   *
   * Beat 44 also commissioned a second labeller with no authorship, which reported 28/30
   * agreement. That figure is [REPORTED, NOT REPRODUCIBLE HERE] — a Beat 46 verifier
   * enumerated every branch's history and found no committed artifact carrying those 30
   * values, so nothing in this repo can recompute or falsify it. It was previously written
   * up as the leading, citable defence; it is corroboration. See `proof-tier-corpus.ts`.
   */
  const perturbations = (() => {
    const out: { id: string; to: string; lower: number; upper: number }[] = [];
    for (let i = 0; i < PROOF_TIER_CORPUS.length; i++) {
      const scenario = PROOF_TIER_CORPUS[i]!;
      for (const t of PROOF_TIERS) {
        if (t === scenario.requiredTier) continue;
        const corpus = PROOF_TIER_CORPUS.map((s, j) =>
          j === i ? { ...s, requiredTier: t as never } : s,
        );
        const { lower, upper } = operatingBand(runRegretMeasurement(corpus).results);
        out.push({ id: scenario.id, to: t, lower, upper });
      }
    }
    return out;
  })();

  it('sweeps every single-label relabelling — 30 scenarios x 4 alternative rungs', () => {
    expect(perturbations).toHaveLength(120);
  });

  it('THE CLAIM SURVIVES ALL OF THEM: no single relabelling empties the band', () => {
    const empty = perturbations.filter((p) => !(p.lower < p.upper));
    expect(empty).toEqual([]);
  });

  it('the LOWER edge is stable under relabelling — safe to quote as a measured constant', () => {
    const lowers = perturbations.map((p) => p.lower).sort((a, b) => a - b);
    expect(lowers[0]).toBeCloseTo(28.5, 6);
    expect(lowers[lowers.length - 1]).toBeCloseTo(50 + 1 / 3, 6);
    // The unperturbed value is the exact median of the perturbed population — the corpus
    // sits in the middle of its own sensitivity range rather than at a favourable edge.
    expect(lowers[Math.floor(lowers.length / 2)]).toBeCloseTo(265 / 7, 6);
  });

  it('the UPPER edge is NOT stable, and this is the pinned counterpart of that disclosure', () => {
    // 4 relabellings remove the ceiling entirely (they take the residual under-proof to 0)
    // and 44 cut it by a quarter or more. Anyone quoting ~661 as a property of the policy
    // is quoting a step function evaluated at one point; these counts are the evidence.
    const unbounded = perturbations.filter((p) => !isFinite(p.upper));
    const muchLower = perturbations.filter((p) => isFinite(p.upper) && p.upper < 661 * 0.75);
    expect(unbounded).toHaveLength(4);
    expect(muchLower).toHaveLength(44);
  });

  it('LIMIT OF THIS METHOD, stated rather than hidden', () => {
    // Two limits, both real. (1) Single-label perturbation cannot detect a bias shared by
    // MANY labels — if the whole corpus leans one way, every one-at-a-time neighbour leans
    // with it. (2) The independent re-labelling behind this was not perfectly blind: the
    // corpus groups scenarios by tier in contiguous blocks, so a re-labeller reading the
    // file sees the grouping. 28/30 is therefore a LOWER bound on agreement, not a
    // measurement of it. The grouping is asserted here so the caveat cannot go stale
    // silently — if someone shuffles the corpus, this test fails and the caveat should be
    // removed rather than left standing as a false apology.
    const order = PROOF_TIER_CORPUS.map((s) => s.requiredTier);
    const blocks = order.filter((t, i) => i === 0 || t !== order[i - 1]).length;
    expect(blocks).toBeLessThan(order.length);
  });

  it('the 28/30 figure is marked REPORTED, because nothing here can recompute it', () => {
    // Beat 46 verifier, MEDIUM-HIGH. The corpus header used to rank the second-labeller
    // result FIRST and call it "the strongest evidence, and the one to cite" — while no
    // data file, fixture or test anywhere in any branch carries that labeller's 30 values.
    // For enabling-disclosure material that distinction is the whole game: an
    // unpinned FACT is the same defect as an unpinned column, one level up.
    //
    // Prose is the thing that drifts, so the disclosure is pinned as a property. If someone
    // restores the confident wording, this fails. If someone later commits the 30 labels
    // and a test that recomputes the count, this fails too — correctly, because the caveat
    // must then be removed rather than left standing as a false apology.
    const header = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'proof-tier-corpus.ts'),
      'utf8'
    ).slice(0, 4000);

    expect(header).toMatch(/NOT REPRODUCIBLE FROM THIS REPOSITORY/);
    expect(header).toMatch(/MUST NOT BE CITED/);

    // …and the sweep, which IS reproducible, is what now leads.
    const sweepAt = header.indexOf('120-RELABELLING SWEEP');
    const relabelAt = header.indexOf('INDEPENDENT RE-LABELLING');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(relabelAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(relabelAt);

    // Guard on the guard: if the corpus is ever renamed or moved, the reads above would
    // throw rather than silently pass — but an empty/short read would not, so pin that too.
    expect(header.length).toBeGreaterThan(2000);
  });
});
