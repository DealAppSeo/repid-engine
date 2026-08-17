/**
 * The incentive simulation, pinned.
 *
 * A simulation nobody can reproduce is an anecdote, so determinism is tested first. The rest
 * records the tournament's current verdict — that honesty is NOT the best play — so the day
 * someone corrects the reward orientation, these go red and force a deliberate re-read rather than
 * quietly reporting a different answer.
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

describe('THE VERDICT — currently recorded, not desired', () => {
  it.failing('makes honesty the best available play', () => {
    // The property a reputation economy needs. Currently false; see the reward-curve inversion in
    // tests/incentive-properties.test.ts. When the orientation is corrected this should pass, at
    // which point this `it.failing` goes red and must be promoted to a normal `it`.
    expect(honestyWins(runTournament(BASE))).toBe(true);
  });

  it('records that the threshold gamer currently wins', () => {
    const results = runTournament(BASE);
    expect(results[0]!.strategyId).toBe('threshold-gamer');
    expect(honestyWins(results)).toBe(false);
  });

  it('records that the most honest strategy LOSES RepID over time', () => {
    const results = runTournament(BASE);
    const honest = results.find((r) => r.strategyId === 'honest-expert')!;
    expect(honest.netChange).toBeLessThan(0);
    expect(honest.finalRepid).toBeLessThan(STARTING_REPID);
  });

  it('records that doing nothing outranks being honest', () => {
    // The abstainer asserts nothing checkable, nets exactly zero, and still places above the
    // honest expert. That is the cleanest single statement of the defect.
    const results = runTournament(BASE);
    expect(rankOf(results, 'abstainer')).toBeLessThan(rankOf(results, 'honest-expert'));
  });

  it('keeps abstention exactly neutral, in either direction', () => {
    const abstainer = runTournament(BASE).find((r) => r.strategyId === 'abstainer')!;
    expect(abstainer.netChange).toBe(0);
  });

  it('punishes volume when each honest claim carries a negative expected delta', () => {
    // volume-farmer is honest-expert at 5x throughput. More of a losing play loses more, which is
    // the correct behaviour of a wrong payoff — worth pinning so a future fix is visible here too.
    const results = runTournament(BASE);
    const farmer = results.find((r) => r.strategyId === 'volume-farmer')!;
    const honest = results.find((r) => r.strategyId === 'honest-expert')!;
    expect(farmer.claims).toBeGreaterThan(honest.claims);
    expect(farmer.finalRepid).toBeLessThanOrEqual(honest.finalRepid);
  });
});

describe('the sweep — the detector is not the problem', () => {
  const rows = sweep([0, 0.25, 0.5, 0.75, 1.0], [1.0, 0.2], { rounds: 200, seed: 12345 });

  it('covers every swept combination', () => {
    expect(rows).toHaveLength(10);
  });

  it.failing('finds at least one detector accuracy where honesty wins', () => {
    // If this ever passes, a detector improvement fixed the incentive — which would mean the
    // defect was in HAL rather than in the reward curve. It is not.
    expect(rows.some((r) => r.honestyWins)).toBe(true);
  });

  it('records that no swept detector accuracy makes honesty win', () => {
    // The point: perfecting HAL cannot repair this. A better detector changes what the FABRICATOR
    // earns and leaves the honest-vs-gamer comparison untouched, because both are truthful.
    expect(rows.every((r) => !r.honestyWins)).toBe(true);
    expect(new Set(rows.map((r) => r.bestStrategy))).toEqual(new Set(['threshold-gamer']));
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
