/**
 * repid-uncertainty.ts — how much CHECKED evidence stands behind an agent's RepID? SHADOW ONLY.
 *
 * WHY. A bare RepID hides how much evidence is behind it: a new agent and a veteran can show the
 * same number. The first empirical study of live ERC-8004 deployments (arXiv 2606.26028) found
 * mostly placeholder agents and Sybil-heavy, ungrounded feedback. An uncertainty that stays high
 * until checked, owner-distinct outcomes accumulate is the honest way to show a new agent's score.
 *
 * METHOD, implemented from the source (both PDFs read 2026-10-23 at glicko.net):
 *   [G1] Mark E. Glickman, "The Glicko system", http://www.glicko.net/glicko/glicko.pdf. Its
 *        derivation: Glickman, "Parameter estimation in large dynamic paired comparison
 *        experiments", Applied Statistics 48 (1999), 377-394.
 *   [G2] Mark E. Glickman, "Example of the Glicko-2 system" (2022-03-22),
 *        http://www.glicko.net/glicko/glicko2.pdf.
 * Only the ratings deviation (RD) of [G1] is used:
 *   Step 1a  an unrated player starts at RD = 350.
 *   Step 1b  at each rating period, RD = min(sqrt(RD_old^2 + c^2 t), 350), t = periods idle.
 *   Step 2   RD' = sqrt((1/RD^2 + 1/d^2)^-1), d^2 = (q^2 sum g(RD_j)^2 E_j (1 - E_j))^-1, q = ln10/400.
 *   floor    "an RD never drop below a threshold value, such as 30" ([G1], implementation issues).
 *   c        [G1]'s non-fitted method: pick the idle time after which a typical rating is as
 *            uncertain as an unrated one, and solve 350 = sqrt(RD_typical^2 + c^2 t) for c.
 *
 * ADAPTED, because a RepID outcome is a checked delivery, not a game between two rated players:
 *   - No opponent rating exists. Each checked outcome is scored as one game against a fully known
 *     reference at the agent's own level: RD_j = 0, so g = 1; rating gap 0, so E = 1/2. That is the
 *     most information one game can carry in [G1], so RD shrinks as fast as Glicko ever lets it.
 *     If anything, this OVERSTATES certainty per outcome; it can never invent certainty from nothing.
 *   - The rating update r' is NOT computed. RepID keeps its own value; this file only says how much
 *     checked evidence stands behind it. A pass and a checked failure shrink RD equally, as in [G1]
 *     ("game outcomes always decrease a player's RD").
 *   - Only outcomes the #1461 eligibility record admits count (`isCheckedOutcome`). Self-trades,
 *     affiliated parties, unknown owners, laundered receipts and self-attested feedback add nothing.
 *   - Rating period = 30 days, and 12 idle periods take an agent at the floor back to unrated.
 *     Both are principle-level choices for the shadow, NOT fitted. [G1] fits c by predictive
 *     accuracy (the 1999 paper); that needs measured outcomes this system does not have yet.
 * NOT ADOPTED: Glicko-2's volatility (sigma, tau) [G2]. [G2] "works best" with 10-15 games per player
 * per period; agents here have far fewer checked outcomes, and volatility tracks erratic
 * PERFORMANCE, which needs the rating update this file does not do.
 *
 * SCALE. RD is in Glicko rating points: 350 means no checked evidence. RepID runs 10-10000 on its
 * own scale and there is no defined map between the two, so nothing here prints "RepID +/- RD".
 * Choosing that map is a scoring decision: MAJOR, and Sean's.
 *
 * SHADOW. No I/O, no environment, no clock (the caller passes `asOf`). Nothing live imports this
 * file (tests/repid-uncertainty.test.ts walks every live entrypoint's import graph), and it never
 * writes RepID, a tier, a chain or a page. Using RD in scoring is MAJOR, Sean's alone.
 */
import {
  evaluateEligibilityBatch,
  type EligibilityEvent,
  type EligibilityRecord,
  type EvidenceTier,
  type OwnerLink,
} from './antifarming-eligibility';

export const UNCERTAINTY_SCHEMA = 'repid-uncertainty/0' as const;

/** [G1] Step 1a. */
export const RD_UNRATED = 350;
/** [G1] implementation issues. */
export const RD_FLOOR = 30;
/** [G1] q = ln 10 / 400. */
export const Q = Math.LN10 / 400;
/** ADAPTED: one rating period. [G1] leaves its length to the administrator. */
export const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
/** ADAPTED, not fitted: idle periods before an agent at the floor is as uncertain as an unrated one. */
export const PERIODS_TO_UNRATED = 12;

/** [G1] implementation issues: solve RD_UNRATED = sqrt(rdTypical^2 + c^2 * periods) for c. */
export const cFor = (rdTypical: number, periods: number): number => Math.sqrt((RD_UNRATED ** 2 - rdTypical ** 2) / periods);
/** About 100.7. */
export const C = cFor(RD_FLOOR, PERIODS_TO_UNRATED);

/** [G1] g(RD). */
export const g = (rd: number): number => 1 / Math.sqrt(1 + (3 * Q ** 2 * rd ** 2) / Math.PI ** 2);
/** [G1] E(s | r, r_j, RD_j). */
export const expectedScore = (r: number, rj: number, rdj: number): number => 1 / (1 + 10 ** ((-g(rdj) * (r - rj)) / 400));
/** [G1] Step 1b over `periods` idle periods. */
export const rdAfterIdle = (rd: number, periods: number, c: number = C): number => Math.min(Math.sqrt(rd ** 2 + c ** 2 * periods), RD_UNRATED);
/** [G1] Step 2, RD' only. Each game is given by its g(RD_j) and E. No floor here. */
export function rdAfterGames(rd: number, games: ReadonlyArray<{ g: number; e: number }>): number {
  const invD2 = Q ** 2 * games.reduce((s, x) => s + x.g ** 2 * x.e * (1 - x.e), 0);
  return Math.sqrt(1 / (1 / rd ** 2 + invD2));
}
/** ADAPTED: a checked outcome is a game against a fully known reference at the agent's level (g = 1, E = 1/2). */
export const CHECKED_OUTCOME_GAME = Object.freeze({ g: g(0), e: expectedScore(0, 0, 0) });

const STRONG_TIERS: ReadonlySet<EvidenceTier> = new Set<EvidenceTier>([
  'OWNER_DISTINCT_OBSERVED',
  'INDEPENDENT_OUTCOME_CONFIRMED',
  'REPRODUCED_ECOSYSTEM_IMPROVEMENT',
]);

/**
 * Is this a checked outcome? The #1461 record decides; this only reads it.
 *   yes  independent credibility COUNTS: signed owner-distinct evidence or an independent check
 *        stands behind the delivery.
 *   yes  a checked FAILURE: an independent check found it failed, or a strongly owner-distinct
 *        counterparty rejected a delivery on admissible evidence. [G1] learns from losses as much
 *        as wins; dropping them would make RD shrink only for agents that succeed.
 *   no   everything else: AFFILIATED or UNKNOWN independence, laundered receipts, self-chosen easy
 *        tasks, self-attested or caller-asserted evidence. Not counting is not a penalty: RepID is
 *        untouched, and RD stays where the evidence leaves it.
 */
export function isCheckedOutcome(r: EligibilityRecord): boolean {
  if (r.independence !== 'VERIFIED_INDEPENDENT') return false;
  const c = r.independent_credibility;
  if (c.status === 'COUNTS' || c.decided_by === 'OUTCOME_CONFIRMED_FAIL') return true;
  return c.decided_by === 'COUNTERPARTY_REJECTED' && STRONG_TIERS.has(r.tier);
}

/** An eligibility event and when it happened (epoch ms). */
export interface TimedEvent {
  at: number;
  event: EligibilityEvent;
}

export interface AgentUncertainty {
  schema: typeof UNCERTAINTY_SCHEMA;
  agent_id: string;
  shadow: true;
  writes_repid: false;
  /** Glicko rating points. RD_UNRATED = no checked evidence. */
  rd: number;
  checked_outcomes: number;
  /** Events naming this agent as the actor that did not count, replays included. */
  not_counted: number;
  last_checked_at: number | null;
}

/**
 * PURE. RD per actor, as of `asOf` (epoch ms). Events after `asOf` are not evidence yet. An event id
 * seen twice is one outcome. An agent with no events is not in the map: read it as RD_UNRATED.
 */
export function uncertaintyByAgent(events: readonly TimedEvent[], asOf: number): Map<string, AgentUncertainty> {
  const past = events.filter((x) => x.at <= asOf);
  const records = evaluateEligibilityBatch(past.map((x) => x.event));
  const agents = new Map<string, { perPeriod: Map<number, number>; seen: Set<string>; notCounted: number; last: number | null }>();
  past.forEach((x, i) => {
    const a = agents.get(x.event.actor_id) ?? { perPeriod: new Map(), seen: new Set(), notCounted: 0, last: null };
    agents.set(x.event.actor_id, a);
    if (a.seen.has(x.event.event_id) || !isCheckedOutcome(records[i] as EligibilityRecord)) { a.notCounted++; return; }
    a.seen.add(x.event.event_id);
    const p = Math.floor(x.at / PERIOD_MS);
    a.perPeriod.set(p, (a.perPeriod.get(p) ?? 0) + 1);
    a.last = Math.max(a.last ?? x.at, x.at);
  });

  const out = new Map<string, AgentUncertainty>();
  for (const [agent_id, a] of agents) {
    let rd = RD_UNRATED;
    let prev: number | null = null;
    for (const [p, n] of [...a.perPeriod].sort((x, y) => x[0] - y[0])) {
      if (prev !== null) rd = rdAfterIdle(rd, p - prev);
      rd = Math.max(RD_FLOOR, rdAfterGames(rd, Array<typeof CHECKED_OUTCOME_GAME>(n).fill(CHECKED_OUTCOME_GAME)));
      prev = p;
    }
    if (prev !== null) rd = rdAfterIdle(rd, Math.floor(asOf / PERIOD_MS) - prev);
    out.set(agent_id, Object.freeze({
      schema: UNCERTAINTY_SCHEMA, agent_id, shadow: true, writes_repid: false,
      rd, checked_outcomes: a.seen.size, not_counted: a.notCounted, last_checked_at: a.last,
    }));
  }
  return out;
}

/**
 * PURE. A settled service_contracts row as an eligibility event: the provider delivered, the buyer
 * is the counterparty. `settled` is reached only through /satisfy (contract-settlement-finalize.ts),
 * so the buyer accepted. The receipt counts only when exactly ONE x402 settlement backs the contract,
 * its status is 'settled' and it is not simulated: no money moved otherwise. Anything unproven drops
 * the receipt, which can only keep RD higher.
 */
export function eventFromSettledContract(
  row: { id: string; provider_agent_id: string; buyer_agent_id: string },
  owner: OwnerLink,
  settlements: ReadonlyArray<{ status: string | null; is_simulated: boolean | null }>,
): EligibilityEvent {
  const event_id = `contract:${row.id}`;
  const s = settlements.length === 1 ? settlements[0] : undefined;
  const real = s?.status === 'settled' && s.is_simulated === false;
  return {
    event_id, kind: 'trade', actor_id: row.provider_agent_id, counterparty_id: row.buyer_agent_id,
    counterparty_owner: owner,
    receipt: real ? { receipt_id: `x402:${row.id}`, server_settled: true, bound_event_id: event_id } : null,
    counterparty_reported_outcome: 'accepted',
  };
}
