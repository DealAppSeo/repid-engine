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
  STRATEGIES,
  SimParams,
} from '../src/incentives/strategy-sim';
import { STARTING_REPID } from '../src/scoring/repid-constants';

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
