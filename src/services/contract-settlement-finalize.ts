/**
 * contract-settlement-finalize.ts — everything that must happen once the money
 * has actually moved.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN /satisfy. Releasing a payment is only
 * the first half of settling a contract. The second half — status transitions,
 * RepID for both sides, the delayed-outcome nudge, the ZK work-statement binding
 * — is what turns a transfer into a settlement anyone can read. A caller that
 * releases the money and stops leaves the WORST state in the system: funds gone,
 * contract still `fulfilled`, provider unpaid on the ledger and unrewarded in
 * RepID. That is the same shape as SETTLED_UNRECORDED, which x402-deferred-
 * settlement.ts exists to shout about.
 *
 * So when the retry worker landed there were two options: copy this sequence, or
 * share it. Copied, the two would drift, and the drift would live on the money
 * path where it is least visible and most expensive. Shared, a change lands in
 * both by construction.
 *
 * ORDER IS LOAD-BEARING and preserved exactly as /satisfy had it:
 *   1. status → 'satisfied' (the DB trigger requires this before 'settled')
 *   2. status → 'settled'
 *   3. RepID deltas for both parties
 *   4. delayed-outcome registration (flag-gated, no-op when off)
 *   5. (removed) ZK work-statement hash write — that column is now the SPEC
 *      hash, bound at award/create by trg_service_contracts_work_statement.
 *      Writing an exchange hash here would either no-op (already bound) or
 *      forge a client hash (rejected). The T1 exchange digest still exists in
 *      work-statement.ts for receipts; it no longer occupies this column.
 *
 * Steps 3-4 are BEST-EFFORT by design, exactly as before. A settlement rolled
 * back because a nudge failed would be worse than a weaker receipt — but each
 * failure logs loudly rather than vanishing.
 */

import { db } from '../db';
import { applyServiceSatisfiedDeltas } from './validation-repid-delta';
import { registerPendingOutcome } from './outcome-notifier';

export interface FinalizeResult {
  ok: boolean;
  contract?: Record<string, unknown>;
  error?: string;
}

export async function finalizeSettledContract(args: {
  contractId: string;
  satisfactionScore: number;
  /** Per-criterion {n, met}[] for bound contracts. Null on legacy unbound rows. */
  criterionRatings?: { n: number; met: boolean }[] | null;
  /** The release outcome. Kept for callers; no longer hashed into work_statement_hash. */
  releaseResult?: { txHash?: string } | null;
}): Promise<FinalizeResult> {
  const { contractId, satisfactionScore } = args;

  // Two-step update to honor trigger logic ('satisfied' then 'settled').
  const satisfiedPatch: Record<string, unknown> = {
    status: 'satisfied',
    buyer_satisfaction_score: satisfactionScore,
    satisfied_at: new Date().toISOString(),
  };
  if (args.criterionRatings) satisfiedPatch.criterion_ratings = args.criterionRatings;

  const { error: err1 } = await db
    .from('service_contracts')
    .update(satisfiedPatch)
    .eq('id', contractId)
    .select()
    .single();
  if (err1) return { ok: false, error: err1.message };

  const { data: step2, error: err2 } = await db
    .from('service_contracts')
    .update({ status: 'settled', settled_at: new Date().toISOString() })
    .eq('id', contractId)
    .select()
    .single();
  if (err2) return { ok: false, error: err2.message };

  if (step2) {
    try {
      await applyServiceSatisfiedDeltas(step2, satisfactionScore);
    } catch (e) {
      console.error('Failed to apply satisfied deltas:', e);
    }

    try {
      await registerPendingOutcome({
        id: (step2 as any).id,
        buyer_agent_id: (step2 as any).buyer_agent_id,
        provider_agent_id: (step2 as any).provider_agent_id,
        settled_at: (step2 as any).settled_at,
      });
    } catch (e) {
      console.error('Failed to register pending outcome:', e);
    }
  }

  return { ok: true, contract: step2 as Record<string, unknown> };
}
