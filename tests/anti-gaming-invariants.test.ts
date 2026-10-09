/**
 * anti-gaming-invariants.test.ts — locks the A2A service-touchpoint economics so a
 * future edit that WEAKENS an anti-gaming property fails the build instead of shipping.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS GUARDS, AND WHY HERE
 * ════════════════════════════════════════════════════════════════════════════════
 * The four A2A reputation touchpoints and the dispute path (src/services/
 * validation-repid-delta.ts) carry HARD-CODED deltas — they are NOT the
 * environment-sourced tuned parameters (config/scoring-params.ts), so asserting
 * them here is safe and leaks nothing: the numbers are already in the public tree.
 * This file reasons over the SAME exported constants the live writer applies, so a
 * relationship it pins cannot silently drift from production.
 *
 * It deliberately imports NO tuned scorer (challenge-scoring / decay / ecosystem-need
 * / prediction-scoring) and asserts no tuned scorer's exact output — so it never trips
 * tests/scoring-tuning-not-in-repo.test.ts.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * TWO KINDS OF ASSERTION, LABELLED
 * ════════════════════════════════════════════════════════════════════════════════
 * HOLDS   — an invariant the current constants satisfy. Locked: a regression that
 *           breaks it turns this red.
 * GAP     — a property the authoritative design principles want that the current
 *           constants do NOT yet satisfy (see reports/2026-10-09/REPID-TUNING-ANALYSIS.md).
 *           We assert the CURRENT measured relationship so the day it is closed the
 *           build goes red and whoever closes it must update the expectation here —
 *           the same "assert the current behaviour, document the gap" discipline the
 *           rest of this repo runs on. A GAP assertion is NOT an endorsement of the
 *           current state; its name says so.
 */

// Behaviour-free db stub so importing the constants does not pull in config.ts /
// a live Supabase client (hoisted, like tests/e2e/a2a-repid-touchpoints.test.ts).
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import {
  SERVICE_FULFILLED_DELTAS,
  SERVICE_SATISFIED_DELTA_BASE,
  SERVICE_OUTCOME_BASE,
  SERVICE_DISPUTE_DELTAS,
  RATER_WEIGHT,
  computeRaterWeight,
} from '../src/services/validation-repid-delta';

const mag = (n: number) => Math.abs(n);

describe('rater-weight clamp (HOLDS)', () => {
  it('clamps to [min, max] and is 1.0 at the pivot', () => {
    expect(computeRaterWeight(0)).toBe(RATER_WEIGHT.min);
    expect(computeRaterWeight(RATER_WEIGHT.pivot)).toBe(1);
    expect(computeRaterWeight(RATER_WEIGHT.pivot * 1_000_000)).toBe(RATER_WEIGHT.max);
    // A null/undefined/NaN rater never throws and never exceeds the floor.
    expect(computeRaterWeight(null)).toBe(RATER_WEIGHT.min);
    expect(computeRaterWeight(undefined)).toBe(RATER_WEIGHT.min);
    expect(computeRaterWeight(Number.NaN)).toBe(RATER_WEIGHT.min);
  });

  it('is monotone non-decreasing in rater reputation (a higher-rep rater never counts less)', () => {
    let prev = -Infinity;
    for (const r of [0, 100, 250, 500, 1000, 1500, 2000, 5000, 10000]) {
      const w = computeRaterWeight(r);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it('a whale rater can never swing more than max/min = 8x a fresh rater', () => {
    expect(RATER_WEIGHT.max / RATER_WEIGHT.min).toBeLessThanOrEqual(8);
  });
});

describe('ground-truth reversal vs the gains it reverses', () => {
  const satisfiedProviderMax = SERVICE_SATISFIED_DELTA_BASE.provider; // satisfaction_score is clamped to [0,1]
  const disputeProviderPenalty = SERVICE_DISPUTE_DELTAS.provider_at_fault.provider; // -100, flat

  it('HOLDS — a provider_at_fault dispute exceeds a single SERVICE_SATISFIED provider gain (principle 4, narrow form)', () => {
    expect(mag(disputeProviderPenalty)).toBeGreaterThan(satisfiedProviderMax);
  });

  it('HOLDS — a bad outcome outweighs the two earlier positive touchpoints combined', () => {
    const earlierPositives = SERVICE_FULFILLED_DELTAS.provider + SERVICE_SATISFIED_DELTA_BASE.provider; // 10 + 30
    expect(mag(SERVICE_OUTCOME_BASE.bad)).toBeGreaterThan(earlierPositives);
  });

  it('HOLDS — a bad outcome is heavier than a good outcome at the same rater weight', () => {
    expect(mag(SERVICE_OUTCOME_BASE.bad)).toBeGreaterThan(mag(SERVICE_OUTCOME_BASE.good));
  });

  // ── GAPS (authoritative principle 4: a ground-truth reversal must be LARGER than the gain) ──
  // The max a provider can bank on ONE real (non-simulated) contract before any dispute:
  //   T1 fulfilled + T2 satisfied(score=1) + T3 good × rater-weight(max)
  const maxStackedProviderGain =
    SERVICE_FULFILLED_DELTAS.provider +
    SERVICE_SATISFIED_DELTA_BASE.provider +
    SERVICE_OUTCOME_BASE.good * RATER_WEIGHT.max; // 10 + 30 + 120 = 160
  const typicalStackedProviderGain =
    SERVICE_FULFILLED_DELTAS.provider +
    SERVICE_SATISFIED_DELTA_BASE.provider +
    SERVICE_OUTCOME_BASE.good * 1; // baseline rater (repid≈pivot): 10 + 30 + 60 = 100

  it('GAP — a flat dispute does NOT exceed the MAX stacked provider gain (whale-rated good outcome)', () => {
    // WANT: mag(disputeProviderPenalty) > maxStackedProviderGain.  TODAY: 100 < 160.
    // A single flat −100 cannot claw back a high-rep-rated good outcome, so a reversal
    // discovered by a red-team holdout / later dispute leaves the provider net-positive.
    // Recommendation: make provider_at_fault reclaim this contract's own positive
    // touchpoints + a margin (proportional), or cap T3 so the stacked max stays below it.
    // WHEN CLOSED: flip to toBeGreaterThan and delete this GAP note.
    expect(mag(disputeProviderPenalty)).toBeLessThan(maxStackedProviderGain);
  });

  it('GAP — against a baseline-rater good outcome the dispute merely breaks even (reversal == gain, not >)', () => {
    // WANT strictly greater; TODAY exactly equal (100 == 100) — a wash, not a reversal.
    expect(mag(disputeProviderPenalty)).toBe(typicalStackedProviderGain);
  });
});

describe('false-dispute asymmetry (HOLDS)', () => {
  it('a false dispute costs the accusing buyer more than it gifts the provider', () => {
    const d = SERVICE_DISPUTE_DELTAS.buyer_at_fault;
    expect(mag(d.buyer)).toBeGreaterThan(d.provider); // |−50| > +20 — a false accusation is not a provider windfall
    expect(d.provider).toBeGreaterThan(0); // the wrongly-accused provider is made a little whole
  });

  it('no_fault moves nothing (an unresolved dispute is not a scoring event)', () => {
    expect(SERVICE_DISPUTE_DELTAS.no_fault.provider).toBe(0);
    expect(SERVICE_DISPUTE_DELTAS.no_fault.buyer).toBe(0);
  });
});

describe('touchpoint weight ordering (HOLDS — T3 outcome is the deepest signal)', () => {
  it('the outcome good base is at least the satisfied provider base, which is at least fulfilled', () => {
    expect(SERVICE_OUTCOME_BASE.good).toBeGreaterThanOrEqual(SERVICE_SATISFIED_DELTA_BASE.provider);
    expect(SERVICE_SATISFIED_DELTA_BASE.provider).toBeGreaterThanOrEqual(SERVICE_FULFILLED_DELTAS.provider);
  });

  it('the rater is never scored for the SATISFIED touchpoint more than the provider (rating is a duty, not farming)', () => {
    expect(SERVICE_SATISFIED_DELTA_BASE.buyer).toBeLessThan(SERVICE_SATISFIED_DELTA_BASE.provider);
  });
});
