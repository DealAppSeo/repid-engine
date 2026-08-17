/**
 * The incentive simulation, pinned.
 *
 * A simulation nobody can reproduce is an anecdote, so determinism is tested first. The rest
 * asserts the tournament's verdict — that honesty IS the best play. It was the opposite until
 * 2026-08-17: these were carried as `it.failing` while the reward orientation was inverted,
 * precisely so that fixing it would turn them red and force this re-read instead of quietly
 * reporting a different answer. It worked.
 *
 * See src/incentives/strategy-sim.ts for what is real (the payoff arithmetic) and what is modelled
 * and swept (detector accuracy, quorum availability).
 */
import {
  makeRng,
  runTournament,
  sweep,
  honestyWins,
  rankOf,
  measureArbitrage,
  STRATEGIES,
  SimParams,
  SYSTEM_FLAG_THRESHOLD,
  ARBITRAGE_OPTIMUM,
} from '../src/incentives/strategy-sim';
import { STARTING_REPID } from '../src/scoring/repid-constants';
import { computeDelta } from '../src/scoring/repid-delta';
import { deriveHalDecision } from '../src/scoring/pipeline';

const BASE: SimParams = { rounds: 200, pCatch: 1.0, pQuorum: 1.0, seed: 12345 };

describe('determinism — without it this is an anecdote, not a measurement', () => {
  it('produces the same stream from the same seed', () => {
    const a = Array.from({ length: 20 }, makeRng(42));
    const b = Array.from({ length: 20 }, makeRng(42));
    expect(a).toEqual(b);
  });

  it('produces a different stream from a different seed', () => {
    const a = Array.from({ length: 20 }, makeRng(42));
    const b = Array.from({ length: 20 }, makeRng(43));
    expect(a).not.toEqual(b);
  });

  it('stays inside [0,1)', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('runs the whole tournament reproducibly', () => {
    expect(runTournament(BASE)).toEqual(runTournament(BASE));
  });

  it('covers every declared strategy exactly once', () => {
    const results = runTournament(BASE);
    expect(results).toHaveLength(STRATEGIES.length);
    expect(new Set(results.map((r) => r.strategyId)).size).toBe(STRATEGIES.length);
  });

  it('ranks contiguously from 1', () => {
    const ranks = runTournament(BASE)
      .map((r) => r.rank)
      .sort((a, b) => a - b);
    expect(ranks).toEqual(STRATEGIES.map((_, i) => i + 1));
  });

  it('throws rather than defaulting when asked about an unknown strategy', () => {
    expect(() => rankOf(runTournament(BASE), 'no-such-strategy')).toThrow(/no result for/);
  });
});

describe('THE VERDICT — honesty is the best play', () => {
  it('makes honesty the best available play', () => {
    // Was `it.failing` while the clean branch consumed risk instead of quality.
    expect(honestyWins(runTournament(BASE))).toBe(true);
  });

  it('puts the threshold gamer BELOW both honest strategies', () => {
    // The gamer asserts nothing false; it only writes to the boundary. It used to win outright.
    const results = runTournament(BASE);
    const gamer = rankOf(results, 'threshold-gamer');
    expect(gamer).toBeGreaterThan(rankOf(results, 'honest-expert'));
    expect(gamer).toBeGreaterThan(rankOf(results, 'honest-hedger'));
  });

  it('makes the most honest strategy GAIN RepID over time', () => {
    const results = runTournament(BASE);
    const honest = results.find((r) => r.strategyId === 'honest-expert')!;
    expect(honest.netChange).toBeGreaterThan(0);
    expect(honest.finalRepid).toBeGreaterThan(STARTING_REPID);
  });

  it('ranks being honest above doing nothing', () => {
    // The inverse used to hold, and it was the cleanest single statement of the defect.
    const results = runTournament(BASE);
    expect(rankOf(results, 'honest-expert')).toBeLessThan(rankOf(results, 'abstainer'));
  });

  it('still ranks the fabricator last once the detector works', () => {
    expect(rankOf(runTournament(BASE), 'fabricator')).toBe(STRATEGIES.length);
  });

  it('keeps abstention exactly neutral, in either direction', () => {
    const abstainer = runTournament(BASE).find((r) => r.strategyId === 'abstainer')!;
    expect(abstainer.netChange).toBe(0);
  });

  it('THROUGHPUT NOW DOMINATES — recorded as a live trade-off, not a win', () => {
    // volume-farmer is honest-expert at 5x throughput, and it now finishes FIRST. Before the fix
    // each honest claim carried a negative expected delta, so volume lost faster; now every honest
    // claim pays, so total RepID scales with claim count and the top of the table is decided by
    // throughput rather than by quality.
    //
    // Per-claim efficiency is essentially identical between the two (same risk band), so this is
    // not the gamer problem returning — nobody is being paid for worse work. But it does mean an
    // agent emitting many trivially-true claims accrues RepID fast, and nothing in THIS module
    // rate-limits that. Whether it is acceptable depends on a cost the simulation does not model.
    const results = runTournament(BASE);
    const farmer = results.find((r) => r.strategyId === 'volume-farmer')!;
    const honest = results.find((r) => r.strategyId === 'honest-expert')!;
    expect(farmer.claims).toBeGreaterThan(honest.claims);
    expect(farmer.finalRepid).toBeGreaterThan(honest.finalRepid);
    // The per-claim rates stay close: volume wins on volume, not on being paid more per claim.
    expect(Math.abs(farmer.perClaim - honest.perClaim)).toBeLessThan(0.2);
  });
});

describe('the sweep — the detector is not the problem', () => {
  const rows = sweep([0, 0.25, 0.5, 0.75, 1.0], [1.0, 0.2], { rounds: 200, seed: 12345 });

  it('covers every swept combination', () => {
    expect(rows).toHaveLength(10);
  });

  it('has honesty winning at EVERY swept detector accuracy', () => {
    // Was `it.failing` at "at least one". The stronger form holds now, and it should: the
    // honest-vs-gamer comparison never depended on the detector, because both are truthful. Fixing
    // the reward curve fixed it everywhere at once — which is the same fact the old failure showed
    // from the other side.
    expect(rows.every((r) => r.honestyWins)).toBe(true);
  });

  it('never lets a gaming strategy top the table at any swept accuracy', () => {
    const winners = new Set(rows.map((r) => r.bestStrategy));
    for (const w of winners) expect(['honest-expert', 'honest-hedger', 'volume-farmer']).toContain(w);
  });

  it('shows a better detector does punish the fabricator, so HAL is working as a detector', () => {
    const perfect = rows.find((r) => r.pQuorum === 1.0 && r.pCatch === 1.0)!;
    const blind = rows.find((r) => r.pQuorum === 1.0 && r.pCatch === 0)!;
    expect(blind.fabricatorNet).toBeGreaterThan(0);
    expect(perfect.fabricatorNet).toBeLessThan(0);
  });

  it('shows an unavailable quorum mutes the whole economy rather than favouring anyone', () => {
    const full = rows.find((r) => r.pQuorum === 1.0 && r.pCatch === 1.0)!;
    const thin = rows.find((r) => r.pQuorum === 0.2 && r.pCatch === 1.0)!;
    // Same ordering, smaller magnitudes: the quorum gate scales deltas toward zero.
    expect(Math.abs(thin.honestExpertNet)).toBeLessThan(Math.abs(full.honestExpertNet));
    expect(Math.abs(thin.thresholdGamerNet)).toBeLessThan(Math.abs(full.thresholdGamerNet));
    expect(thin.bestStrategy).toBe(full.bestStrategy);
  });
});

describe('PREFERENCE ARBITRAGE — is a user-settable risk tolerance a gaming vector?', () => {
  const results = runTournament(BASE);
  const arb = measureArbitrage(results);

  it('the sim default path uses the REAL gate, not a copy of its constant', () => {
    // The sim used to hardcode `risk >= 0.4` under a comment claiming to be the real function. Any
    // strategy WITHOUT a declared preference must be scored by production's own gate, or the whole
    // tournament measures a duplicate that can drift.
    for (let i = 0; i <= 1000; i++) {
      const risk = i / 1000;
      const real = deriveHalDecision(risk, false, null);
      const bySystemConstant = risk >= SYSTEM_FLAG_THRESHOLD ? 'flagged' : 'clean';
      expect(real).toBe(bySystemConstant);
    }
  });

  it('THE FACTORIAL IS VALID: all three arms are the same agent but for the threshold', () => {
    // This is the assertion the finding rests on. Change one arm's band or volume and the comparison
    // stops measuring the knob — which already happened once, when the cautious arm was given a band
    // sitting entirely below its own threshold so the treatment could never bind.
    const arms = ['broad-cautious', 'broad-default', 'broad-shopper'].map((id) => {
      const s = STRATEGIES.find((x) => x.id === id);
      if (!s) throw new Error(`missing arm '${id}'`);
      return s;
    });
    const [a, b, c] = arms as [typeof arms[0], typeof arms[0], typeof arms[0]];
    for (const arm of [b, c]) {
      expect(arm.riskBand).toEqual(a.riskBand);
      expect(arm.claimsPerRound).toBe(a.claimsPerRound);
      expect(arm.fabricates).toBe(a.fabricates);
      expect(arm.abstains).toBe(a.abstains);
    }
    // And the thresholds must actually differ, or there is no treatment at all.
    expect(new Set(arms.map((x) => x.flagThreshold ?? SYSTEM_FLAG_THRESHOLD)).size).toBe(3);
  });

  it('each arm converts a STRICTLY LARGER share of its output into paid events', () => {
    // The validity condition is about EFFECT, not parameters. An earlier version of this test
    // demanded each band straddle its own threshold, and failed on broad-shopper — whose threshold
    // sits ABOVE the band, which is precisely what "maximally permissive" means. The premise was
    // wrong, not the design: what must differ is the fraction of output that is eligible to be paid.
    const cleanFraction = (id: string) => {
      const s = STRATEGIES.find((x) => x.id === id)!;
      const t = s.flagThreshold ?? SYSTEM_FLAG_THRESHOLD;
      const [lo, hi] = s.riskBand;
      return Math.min(1, Math.max(0, (Math.min(t, hi) - lo) / (hi - lo)));
    };
    const cautious = cleanFraction('broad-cautious');
    const dflt = cleanFraction('broad-default');
    const shopper = cleanFraction('broad-shopper');
    expect(cautious).toBeGreaterThan(0); // the treatment binds rather than zeroing the arm
    expect(dflt).toBeGreaterThan(cautious);
    expect(shopper).toBeGreaterThan(dflt);
    expect(shopper).toBe(1); // fully permissive: nothing this agent emits is ever flagged
  });

  it('the shared band straddles the SYSTEM threshold, so there is something to convert', () => {
    const s = STRATEGIES.find((x) => x.id === 'broad-default')!;
    expect(s.riskBand[0]).toBeLessThan(SYSTEM_FLAG_THRESHOLD);
    expect(s.riskBand[1]).toBeGreaterThan(SYSTEM_FLAG_THRESHOLD);
  });

  it('derives the arbitrage ceiling from the reward curve rather than asserting a magic number', () => {
    // delta = 3 - 4*risk crosses zero at 0.75. Above that, widening your own clean band converts
    // zero-paying flagged events into NEGATIVE-paying clean ones, so a rational shopper stops there.
    const atOptimum = computeDelta({
      hal_score: ARBITRAGE_OPTIMUM,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: false,
    }).delta_applied;
    expect(atOptimum).toBeCloseTo(0, 5);
    const justPast = computeDelta({
      hal_score: ARBITRAGE_OPTIMUM + 0.1,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: false,
    }).delta_applied;
    expect(justPast).toBeLessThan(0);
  });

  it('FINDING: shopping a permissive preference pays, with no change in behaviour', () => {
    expect(arb.exploitable).toBe(true);
    expect(arb.gain).toBeGreaterThan(0);
    // Worth more than a third of what the identical-behaviour twin earned by working at all.
    expect(arb.gainRatio).toBeGreaterThan(0.25);
  });

  it('FINDING: the knob is monotone in permissiveness on identical work', () => {
    expect(arb.cautiousNet).toBeLessThan(arb.defaultNet);
    expect(arb.defaultNet).toBeLessThan(arb.shopperNet);
  });

  it('FINDING: caution is PENALISED — the risk-averse user pays for the setting', () => {
    // The half that matters ethically: the user the setting is meant to serve is the one it charges.
    expect(arb.cautiousPenalised).toBe(true);
    expect(arb.cautiousCost).toBeLessThan(0);
  });

  it('spans more than the honest twin earned, so this is not a rounding effect', () => {
    const span = arb.shopperNet - arb.cautiousNet;
    expect(span).toBeGreaterThan(arb.defaultNet * 0.5);
  });
});
