/**
 * strategy-sim.ts — a strategy tournament against the REAL RepID scoring path.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE QUESTION
 * ════════════════════════════════════════════════════════════════════════════════
 * "Does RepID reward good behaviour and thwart selfish behaviour?" is an empirical question about a
 * payoff surface, not a design intention. So: define agent strategies, run them through the actual
 * `computeDelta` and `clampRepid`, and see who ends up with the most RepID.
 *
 * If an honest strategy does not win, the incentive does not exist, whatever the docs say.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IS REAL HERE AND WHAT IS MODELLED — READ BEFORE QUOTING A RESULT
 * ════════════════════════════════════════════════════════════════════════════════
 * REAL (imported, not restated): `computeDelta`, `deriveHalDecision`, `clampRepid`, `STARTING_REPID`.
 * The payoff arithmetic is production's.
 *
 * MODELLED, with the parameter swept rather than guessed:
 *   • `pCatch` — the probability HAL's cross-provider quorum actually catches a fabrication. HAL
 *     strictness 2 needs live provider keys, which this environment does not have, so the detector
 *     is a parameter. Sweeping it is more informative than fixing it: it answers "how good must the
 *     detector be before honesty pays?" rather than "does honesty pay at one guessed accuracy".
 *   • `pQuorum` — the probability a quorum is available at all. When it is not,
 *     HAL_DECISION_REQUIRES_QUORUM (default ON) neutralises the decision to 'flagged', which pays
 *     zero. This is modelled because it is the single largest determinant of whether ANY delta
 *     moves in production today, and omitting it would flatter every strategy equally but hide that
 *     the whole economy can be inert.
 *   • The risk score each strategy's output attracts, as a bounded uniform draw. A strategy is a
 *     distribution over risk, not a fixed number.
 *
 * NOT MODELLED, and therefore not claimed: decay over real calendar time, the ecosystem-need
 * multiplier (needs the DB), the validator/challenger reward path in `reward-formula.ts`, staking,
 * and collusion between agents. Each is a separate measurement.
 *
 * DETERMINISM: seeded PRNG, no `Math.random`. A simulation whose numbers move between runs cannot
 * be a measurement (LESSONS §8), and a reader must be able to reproduce the exact table.
 *
 * PURITY: no I/O, no DB, no network, no clock.
 */

import { computeDelta, HALDecision } from '../scoring/repid-delta';
import { clampRepid } from '../scoring/repid-clamp';
import { STARTING_REPID } from '../scoring/repid-constants';

/** xorshift32 — small, fast, and deterministic from a seed. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** One agent strategy: what it asserts, and what risk score its writing attracts. */
export interface Strategy {
  readonly id: string;
  /** One line, for the results table. */
  readonly description: string;
  /** Claims emitted per round. Models volume-based farming. */
  readonly claimsPerRound: number;
  /** True when the strategy asserts things that are actually false. */
  readonly fabricates: boolean;
  /** Inclusive risk band its output lands in when NOT caught. */
  readonly riskBand: readonly [number, number];
  /** True when its claims are unfalsifiable, so HAL abstains. */
  readonly abstains?: boolean;
}

/**
 * The strategies.
 *
 * `threshold-gamer` is the important one: it asserts nothing false, but writes to land just under
 * the flag boundary. If the payoff surface is oriented correctly it should earn LESS than
 * `honest-expert`; if it earns more, the system is paying for style rather than truth.
 */
export const STRATEGIES: readonly Strategy[] = [
  {
    id: 'honest-expert',
    description: 'grounded, well-evidenced claims; never fabricates',
    claimsPerRound: 1,
    fabricates: false,
    riskBand: [0.02, 0.15],
  },
  {
    id: 'honest-hedger',
    description: 'truthful but hedged and cautious; mid-low risk',
    claimsPerRound: 1,
    fabricates: false,
    riskBand: [0.1, 0.25],
  },
  {
    id: 'threshold-gamer',
    description: 'truthful, but written to sit just under the flag threshold',
    claimsPerRound: 1,
    fabricates: false,
    riskBand: [0.36, 0.399],
  },
  {
    id: 'fabricator',
    description: 'asserts falsehoods confidently; risks a veto when quorum catches it',
    claimsPerRound: 1,
    fabricates: true,
    riskBand: [0.3, 0.399],
  },
  {
    id: 'volume-farmer',
    description: 'honest but emits 5x the claims per round',
    claimsPerRound: 5,
    fabricates: false,
    riskBand: [0.02, 0.15],
  },
  {
    id: 'abstainer',
    description: 'only unfalsifiable claims, so HAL abstains',
    claimsPerRound: 1,
    fabricates: false,
    riskBand: [0.5, 0.5],
    abstains: true,
  },
];

export interface SimParams {
  rounds: number;
  /** P(the quorum catches a fabrication | quorum available). */
  pCatch: number;
  /** P(a decision-eligible quorum is available at all). */
  pQuorum: number;
  seed: number;
  /** Agent tier held fixed; the delta path reads it but does not currently branch on it. */
  tier?: string;
  vestingCliffActive?: boolean;
}

export interface StrategyResult {
  strategyId: string;
  finalRepid: number;
  netChange: number;
  claims: number;
  /** Net RepID per claim — the efficiency a rational agent would optimise. */
  perClaim: number;
  vetoes: number;
  neutralised: number;
  rank: number;
}

/**
 * Run one agent of one strategy.
 *
 * The per-claim sequence mirrors the pipeline: draw a risk, decide whether a quorum exists, decide
 * whether a fabrication is caught, derive the decision, then call the real `computeDelta` and the
 * real `clampRepid`.
 */
function runStrategy(strategy: Strategy, p: SimParams, rng: () => number) {
  let repid = STARTING_REPID;
  let claims = 0;
  let vetoes = 0;
  let neutralised = 0;
  const [lo, hi] = strategy.riskBand;

  for (let round = 0; round < p.rounds; round++) {
    for (let c = 0; c < strategy.claimsPerRound; c++) {
      claims += 1;
      const risk = lo + rng() * (hi - lo);
      const quorumAvailable = rng() < p.pQuorum;

      let decision: HALDecision;
      if (strategy.abstains) {
        decision = 'abstain';
      } else if (strategy.fabricates && quorumAvailable && rng() < p.pCatch) {
        decision = 'vetoed';
        vetoes += 1;
      } else {
        // The real threshold function decides clean vs flagged from the risk.
        decision = risk >= 0.4 ? 'flagged' : 'clean';
      }

      // HAL_DECISION_REQUIRES_QUORUM (default ON): without a quorum the decision is neutralised to
      // 'flagged', which pays zero in either direction.
      if (!quorumAvailable && decision !== 'abstain') {
        if (decision !== 'flagged') neutralised += 1;
        decision = 'flagged';
      }

      const d = computeDelta({
        hal_score: risk,
        hal_decision: decision,
        current_repid: repid,
        agent_tier: p.tier ?? 'ESTABLISHED',
        vesting_cliff_active: p.vestingCliffActive ?? false,
      });
      repid = clampRepid(repid + d.delta_applied).value;
    }
  }

  return { repid, claims, vetoes, neutralised };
}

/** Run every strategy under identical conditions and rank them by final RepID. */
export function runTournament(p: SimParams): StrategyResult[] {
  const results: StrategyResult[] = STRATEGIES.map((s, i) => {
    // Per-strategy seed derived from the run seed, so strategies are independent but the whole
    // tournament is reproducible from one number.
    const rng = makeRng(p.seed + i * 7919);
    const r = runStrategy(s, p, rng);
    return {
      strategyId: s.id,
      finalRepid: r.repid,
      netChange: r.repid - STARTING_REPID,
      claims: r.claims,
      perClaim: (r.repid - STARTING_REPID) / Math.max(1, r.claims),
      vetoes: r.vetoes,
      neutralised: r.neutralised,
      rank: 0,
    };
  });

  results.sort((a, b) => b.finalRepid - a.finalRepid);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });
  return results;
}

/** Where a strategy placed. Throws when the id is unknown, rather than returning a silent default. */
export function rankOf(results: readonly StrategyResult[], strategyId: string): number {
  const found = results.find((r) => r.strategyId === strategyId);
  if (!found) throw new Error(`[strategy-sim] no result for '${strategyId}'`);
  return found.rank;
}

/**
 * Does an honest strategy beat every strategy that games or fabricates?
 *
 * This is the single question the tournament exists to answer. It compares the BEST honest
 * strategy against the BEST dishonest/gaming one, because a system is only well-incentivised if
 * honesty is the best available play — not merely a viable one.
 */
export function honestyWins(results: readonly StrategyResult[]): boolean {
  const honestIds = new Set(['honest-expert', 'honest-hedger', 'volume-farmer']);
  const gamingIds = new Set(['threshold-gamer', 'fabricator']);
  const bestHonest = Math.max(
    ...results.filter((r) => honestIds.has(r.strategyId)).map((r) => r.finalRepid),
  );
  const bestGaming = Math.max(
    ...results.filter((r) => gamingIds.has(r.strategyId)).map((r) => r.finalRepid),
  );
  return bestHonest > bestGaming;
}

/** Sweep the detector accuracy and report where, if anywhere, honesty starts winning. */
export interface SweepRow {
  pCatch: number;
  pQuorum: number;
  honestyWins: boolean;
  bestStrategy: string;
  honestExpertRank: number;
  honestExpertNet: number;
  thresholdGamerNet: number;
  fabricatorNet: number;
}

export function sweep(
  pCatchValues: readonly number[],
  pQuorumValues: readonly number[],
  base: Omit<SimParams, 'pCatch' | 'pQuorum'>,
): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const pQuorum of pQuorumValues) {
    for (const pCatch of pCatchValues) {
      const results = runTournament({ ...base, pCatch, pQuorum });
      const get = (id: string) => results.find((r) => r.strategyId === id)!;
      rows.push({
        pCatch,
        pQuorum,
        honestyWins: honestyWins(results),
        bestStrategy: results[0]!.strategyId,
        honestExpertRank: rankOf(results, 'honest-expert'),
        honestExpertNet: get('honest-expert').netChange,
        thresholdGamerNet: get('threshold-gamer').netChange,
        fabricatorNet: get('fabricator').netChange,
      });
    }
  }
  return rows;
}
