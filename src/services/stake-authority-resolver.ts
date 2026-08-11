/**
 * stake-authority-resolver — what collateral ACTUALLY backs an agent's spending authority.
 *
 * SHADOW ONLY. Nothing here decides anything. It computes a second opinion beside
 * `x402-gate.decideAuthority`, so the divergence can be measured before a single payment
 * decision changes. Making it load-bearing is a separate call with Sean's GO (CLAUDE_RULES 23).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS — see reports/2026-08-11/STAKE_AUTHORITY_DEFECT.md
 *
 * `x402-gate.ts` sums `agent_stakes.stake_amount` as the collateral backing spending authority.
 * `agent_stakes` is a PREDICTION MARKET (`target_model`, `stake_position`, `actual_consensus`,
 * `deviation`, `slash_amount`) — a wager on how a model will score, not capital posted against
 * misbehaviour. Real collateral lands in `stake_deposits`, which the gate never reads.
 *
 * So today: posted collateral earns no authority, and winning prediction bets do.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * THREE RULES THIS MODULE ENFORCES, AND WHY EACH ONE IS LOAD-BEARING
 *
 * 1. SIMULATED COLLATERAL NEVER BACKS REAL AUTHORITY. 49 of 50 active deposits are
 *    `is_simulated`. A naive repoint at `stake_deposits` would grant REAL spending power against
 *    DEMO money — strictly worse than the bug it replaces, because the current defect fails
 *    CLOSED (under-granting) and that one fails OPEN.
 *
 * 2. AN UNRESOLVED OWNER YIELDS ZERO, NOT A GUESS. `stake_deposits` is keyed on `builder_id`
 *    (a human/account); authority is asked about an agent. If the link is missing the answer is
 *    "no evidence of collateral", never a fallback to some other agent's stake.
 *
 * 3. THE RESULT REPORTS ITS OWN BASIS. `deposits_considered`, `simulated_excluded` and
 *    `unresolved_owner` come back with the number, so a zero that means "no collateral" is
 *    distinguishable from a zero that means "we could not tell". Those are different facts and a
 *    bare 0 conflates them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * IT CANNOT BE VALIDATED AGAINST PROD YET, AND THAT IS A FINDING, NOT A GAP IN THIS FILE.
 * [V 2026-08-11] 50 active deposits from 47 distinct builders; 43 of 176 agents carry a
 * `builder_id`; the OVERLAP IS ZERO. Depositors own no agents and agent-owners have not
 * deposited, so against today's data this resolver correctly returns 0 for every agent —
 * identical to the current gate, so a divergence measurement would prove nothing.
 *
 * The first builder who BOTH owns an agent AND stakes is exactly what the demo's Act One
 * creates. This module is written and tested so that moment is a measurement, not a scramble.
 *
 * PURE. No I/O — the caller supplies rows. Same discipline as write-lease.ts and
 * selection-score.ts: this decides, something else fetches, so the verdict is reproducible.
 */

/** A row from `stake_deposits`. `amount` is raw USDC (6dp), as stored. */
export interface StakeDepositRow {
  builder_id: string | null;
  amount: number | null;
  status: string | null;
  /** Demo money. Must never back real authority. */
  is_simulated?: boolean | null;
}

/** The link from a deposit's owner to an agent. Absent = unresolved, never guessed. */
export interface AgentOwnership {
  agentName: string;
  builderId: string | null;
}

export interface CollateralBasis {
  /** Raw USDC (6dp) genuinely backing this agent's authority. */
  collateralRaw: number;
  /** Same, in dollars, for humans reading a log line. */
  collateralUsdc: number;
  /** Rows that belonged to this agent's owner and were active. */
  depositsConsidered: number;
  /** Active rows dropped for being demo money. */
  simulatedExcluded: number;
  /** True when the agent has no `builder_id`, so no deposit can be attributed to it. */
  unresolvedOwner: boolean;
  /** Human-readable basis, so a log line explains itself without a schema lookup. */
  basis: string;
}

const ACTIVE = 'active';
const rawToUsdc = (raw: number) => Number((raw / 1_000_000).toFixed(6));

/**
 * Sum the collateral that genuinely backs one agent.
 *
 * Deliberately takes ALL candidate rows and filters here rather than trusting the caller to have
 * pre-filtered: the exclusions ARE the safety property, and a query written elsewhere can quietly
 * stop applying them.
 */
export function resolveCollateral(
  owner: AgentOwnership,
  deposits: readonly StakeDepositRow[],
): CollateralBasis {
  if (!owner.builderId) {
    return {
      collateralRaw: 0,
      collateralUsdc: 0,
      depositsConsidered: 0,
      simulatedExcluded: 0,
      unresolvedOwner: true,
      basis: `no builder_id on agent "${owner.agentName}" — no deposit can be attributed to it; ` +
             `reporting zero rather than guessing an owner`,
    };
  }

  const mine = deposits.filter((d) => d.builder_id === owner.builderId && d.status === ACTIVE);
  const simulated = mine.filter((d) => d.is_simulated === true);
  const real = mine.filter((d) => d.is_simulated !== true);
  const raw = real.reduce((s, d) => s + Number(d.amount ?? 0), 0);

  return {
    collateralRaw: raw,
    collateralUsdc: rawToUsdc(raw),
    depositsConsidered: mine.length,
    simulatedExcluded: simulated.length,
    unresolvedOwner: false,
    basis:
      `${real.length} real active deposit(s) for builder ${owner.builderId}` +
      (simulated.length ? `; ${simulated.length} simulated deposit(s) EXCLUDED` : ''),
  };
}

export interface ShadowComparison {
  agentName: string;
  /** What the live gate currently uses — the prediction-market sum. */
  currentStakeAvailable: number;
  /** What collateral actually backs it. */
  correctedCollateralUsdc: number;
  /** corrected − current. Negative = the gate is currently OVER-crediting. */
  divergenceUsdc: number;
  /**
   * True when the correction would REDUCE authority. This is the direction that matters: the
   * live gate is granting spending power against wagers, and a shadow run that surfaces
   * over-crediting is reporting money at risk, not a tidy-up.
   */
  currentOverCredits: boolean;
  basis: string;
  unresolvedOwner: boolean;
}

/**
 * Compare live vs corrected for one agent. Pure; log the result, change nothing.
 *
 * `currentStakeAvailable` is whatever `x402-gate` computed, passed in rather than recomputed, so
 * the comparison is against the value that actually gated the decision — not a re-derivation that
 * might drift from it.
 */
export function compareToLiveGate(
  owner: AgentOwnership,
  deposits: readonly StakeDepositRow[],
  currentStakeAvailable: number,
): ShadowComparison {
  const c = resolveCollateral(owner, deposits);
  const divergence = Number((c.collateralUsdc - currentStakeAvailable).toFixed(6));
  return {
    agentName: owner.agentName,
    currentStakeAvailable,
    correctedCollateralUsdc: c.collateralUsdc,
    divergenceUsdc: divergence,
    currentOverCredits: divergence < 0,
    basis: c.basis,
    unresolvedOwner: c.unresolvedOwner,
  };
}
