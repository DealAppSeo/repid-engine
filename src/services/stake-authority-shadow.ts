/**
 * stake-authority-shadow — give the corrected collateral computation a CALLER, in shadow.
 *
 * `stake-authority-resolver.ts` has been pure, tested and **entirely unreached** since
 * 2026-08-11: its only mention anywhere in `src/` was a comment in `x402-gate.ts` pointing at
 * it. A correction nothing calls is indistinguishable from a correction nobody wrote, and it
 * reads as done — which is the house defect (a system reporting success it has not earned).
 * This module is the seam that lets it observe, and nothing more.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS WRONG TODAY, RESTATED SO THIS FILE STANDS ALONE
 *
 * `x402-gate.loadAuthorityContext` sums `agent_stakes` (a PREDICTION MARKET — an agent
 * wagering on how a model will score) plus `sponsorship_records`. Posted collateral lands in
 * `stake_deposits`, keyed on `builder_id` (a human), and the gate never reads it. So wagers buy
 * spending authority and real money buys none.
 *
 * MEASURED 2026-09-21 against prod, which is why this is worth wiring NOW:
 *   - 41 of 42 lifetime gate decisions denied `insufficient_stake`
 *     (mean stake visible to the gate $1.02 against a mean $1.31 request)
 *   - `stake_deposits` holds 52 rows across 49 builders; the gate reads none of them
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * THE PRECONDITION THAT BLOCKED THIS HAS PARTIALLY LIFTED — AND THAT IS THE WHOLE REASON
 * THIS FILE EXISTS TODAY RATHER THAN IN AUGUST.
 *
 * The resolver's own header records why measuring was pointless then:
 *
 *     "[V 2026-08-11] 50 active deposits from 47 distinct builders; 43 of 176 agents carry a
 *      builder_id; the OVERLAP IS ZERO ... against today's data this resolver correctly returns
 *      0 for every agent — identical to the current gate, so a divergence measurement would
 *      prove nothing."
 *
 * That was true and is no longer. **MEASURED 2026-09-21: the overlap is 2**, not zero — two
 * builders both hold a `stake_deposits` row and own an agent via `repid_agents.builder_id`. Two
 * is small, but it is the difference between a shadow that is structurally incapable of
 * producing a signal and one that can. A caller added while the overlap was zero would have
 * recorded "no divergence" forever and been read as evidence the gate was fine.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT DO
 *
 * It does not decide anything. `authorizeX402Payment` ignores the return value exactly as it
 * ignores `observeOwnerCeiling`'s. Making the correction load-bearing changes which payments
 * are allowed to move real testnet money, so it is a separate call with Sean's GO
 * (CLAUDE_RULES 23), and the flip criteria live in
 * `reports/2026-08-11/STAKE_AUTHORITY_DEFECT.md`.
 *
 * **Repointing the gate's query at `stake_deposits` would be strictly worse than the bug.**
 * 51 of 52 deposits are `is_simulated`, so a naive repoint grants REAL spending power against
 * DEMO money: today's defect fails CLOSED (under-granting), that one fails OPEN. The resolver
 * enforces the simulated-exclusion itself, which is why this module hands it the rows and
 * filters nothing on the way in.
 */
import { db } from '../db';
import {
  compareToLiveGate,
  type AgentOwnership,
  type ShadowComparison,
  type StakeDepositRow,
} from './stake-authority-resolver';

/**
 * Default OFF, read per call rather than at import — so observation can be turned on without a
 * restart, and so a test can flip it. While off this module performs NO reads and NO writes.
 */
export function stakeAuthorityShadowEnabled(): boolean {
  return String(process.env['STAKE_AUTHORITY_SHADOW_ENABLED'] ?? '').toLowerCase() === 'true';
}

export type StakeShadowVerdict = 'disabled' | 'observed' | 'error';

export interface StakeAuthorityObservation {
  verdict: StakeShadowVerdict;
  agent: string;
  amount: number;
  /** What the live gate used. Passed in, never recomputed — see compareToLiveGate. */
  liveStakeAvailable: number;
  /** Null unless verdict is 'observed'. A null here is NOT_CHECKED, never "no divergence". */
  comparison: ShadowComparison | null;
  detail: string;
  observedAt: string;
}

/**
 * Observe what the gate WOULD have seen if it read posted collateral, and record the gap.
 *
 * Never throws: a shadow that can break the money path it observes is worse than no shadow, so
 * every failure becomes `verdict: 'error'` with the live decision reported unchanged.
 */
export async function observeStakeAuthority(input: {
  agent: string;
  amount: number;
  decision: { stake_available: number };
  now?: Date;
}): Promise<StakeAuthorityObservation> {
  const observedAt = (input.now ?? new Date()).toISOString();
  const base = {
    agent: input.agent,
    amount: input.amount,
    liveStakeAvailable: input.decision.stake_available,
    observedAt,
  };

  if (!stakeAuthorityShadowEnabled()) {
    return {
      ...base,
      verdict: 'disabled',
      comparison: null,
      detail:
        'STAKE_AUTHORITY_SHADOW_ENABLED is not set — nothing read, nothing recorded, ' +
        'nothing observed. This is an absence, not a finding of no divergence.',
    };
  }

  try {
    const agentRes = await db
      .from('repid_agents')
      .select('builder_id')
      .eq('agent_name', input.agent)
      .maybeSingle();

    const builderId: string | null = (agentRes.data as any)?.builder_id ?? null;
    const owner: AgentOwnership = { agentName: input.agent, builderId };

    // An agent with no owner can have no collateral attributed to it. Skip the deposit read
    // entirely and let the resolver report `unresolvedOwner` — querying on a null builder would
    // either error or, worse, match rows belonging to nobody in particular.
    let deposits: StakeDepositRow[] = [];
    if (builderId) {
      // Deliberately UNFILTERED beyond the owner: the resolver applies the status and
      // is_simulated exclusions itself, and those exclusions ARE the safety property. A filter
      // written here could quietly stop applying them without the resolver's tests noticing.
      const depRes = await db
        .from('stake_deposits')
        .select('builder_id, amount, status, is_simulated')
        .eq('builder_id', builderId);
      deposits = (depRes.data ?? []) as StakeDepositRow[];
    }

    const comparison = compareToLiveGate(owner, deposits, input.decision.stake_available);

    // Logged rather than written to a table: this is the first caller, and a shadow that
    // provisions storage before it has produced one observation is building on an unmeasured
    // premise. The divergence is small-N by construction (overlap 2) — it belongs in the log
    // until there is enough of it to justify a schema.
    if (comparison.currentOverCredits) {
      console.warn(
        `[stake-authority-shadow] OVER-CREDIT ${input.agent}: gate used ` +
          `$${comparison.currentStakeAvailable}, real collateral $${comparison.correctedCollateralUsdc} ` +
          `(divergence $${comparison.divergenceUsdc}) — ${comparison.basis}`,
      );
    } else {
      console.log(
        `[stake-authority-shadow] ${input.agent}: gate $${comparison.currentStakeAvailable}, ` +
          `real collateral $${comparison.correctedCollateralUsdc} ` +
          `(divergence $${comparison.divergenceUsdc}) — ${comparison.basis}`,
      );
    }

    return { ...base, verdict: 'observed', comparison, detail: comparison.basis };
  } catch (err) {
    return {
      ...base,
      verdict: 'error',
      comparison: null,
      detail: `shadow comparison failed (gate decision unaffected): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
