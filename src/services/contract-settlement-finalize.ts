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
 *   5. ZK work-statement binding
 *
 * Steps 3-5 are BEST-EFFORT by design, exactly as before. A settlement rolled
 * back because a nudge or a hash write failed would be worse than a weaker
 * receipt — but each failure logs loudly rather than vanishing.
 */

import { db } from '../db';
import { applyServiceSatisfiedDeltas } from './validation-repid-delta';
import { registerPendingOutcome } from './outcome-notifier';
import { workStatementHash } from './work-statement';

export interface FinalizeResult {
  ok: boolean;
  contract?: Record<string, unknown>;
  error?: string;
}

export async function finalizeSettledContract(args: {
  contractId: string;
  satisfactionScore: number;
  /** The release outcome, used for the settlement tx inside the ZK binding. */
  releaseResult?: { txHash?: string } | null;
}): Promise<FinalizeResult> {
  const { contractId, satisfactionScore } = args;

  // Two-step update to honor trigger logic ('satisfied' then 'settled').
  const { error: err1 } = await db
    .from('service_contracts')
    .update({
      status: 'satisfied',
      buyer_satisfaction_score: satisfactionScore,
      satisfied_at: new Date().toISOString(),
    })
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

    // ZK BIND T1 — commit this exchange at the moment it settles.
    //
    // Recorded HERE and not earlier because the hash covers the settlement tx
    // and the buyer's acceptance, which do not exist until now. Recorded ONCE:
    // a later edit to the contract changes the recomputation and no longer
    // matches, and that disagreement is the tamper-detection, not a bug.
    try {
      const { data: full } = await db
        .from('service_contracts')
        .select('id, service_id, buyer_agent_id, provider_agent_id, agreed_price_usdc_raw, payload, result')
        .eq('id', contractId)
        .maybeSingle();
      if (full) {
        const hash = workStatementHash({
          contract_id: String((full as any).id),
          service_id: String((full as any).service_id),
          buyer_agent_id: String((full as any).buyer_agent_id),
          provider_agent_id: String((full as any).provider_agent_id),
          agreed_price_usdc_raw: Number((full as any).agreed_price_usdc_raw),
          settlement_tx: args.releaseResult?.txHash ?? null,
          verdict: String(((full as any).result as any)?.verdict ?? '') || null,
          satisfaction_score: Number(satisfactionScore),
          payload: (full as any).payload,
          result: (full as any).result,
        });
        const { error: bindErr } = await db
          .from('service_contracts')
          .update({ work_statement_hash: hash })
          .eq('id', contractId)
          .is('work_statement_hash', null);
        if (bindErr) {
          console.error(`[zk-bind] FAILED to record work_statement_hash for ${contractId}: ${bindErr.message}`);
        }
      }
    } catch (e) {
      console.error('[zk-bind] work statement binding threw (settlement unaffected):', e);
    }
  }

  return { ok: true, contract: step2 as Record<string, unknown> };
}
