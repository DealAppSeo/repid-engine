/**
 * trust-receipt-writer.ts — create the WRITE-side Trust Receipt for a durable move.
 *
 * This is the settlement record the Policy Gate requires (src/kernel/policy-gate.ts):
 * evidence tuples + the gate's decision, NOT a baked score. It is distinct from the
 * READ-side src/services/trust-receipt.ts (the public /receipt report). A durable
 * RepID move references the id this returns via repid_score_events.settled_receipt_id.
 *
 * Best-effort by design: the caller decides fail-open (shadow) vs fail-closed
 * (enforce). This function never throws — it returns the id on success or null on
 * failure, and logs loudly, because a receipt write must never silently corrupt a
 * settlement nor take a score write down with it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TrustReceiptInput {
  id: string;                          // pre-generated uuid so the caller can link before insert
  action_class: string;               // 'durable_repid_move'
  subject_agent_id: string;
  subject_type?: string;              // default 'agent'
  contract_id?: string | null;
  task_id?: string | null;
  evidence_predicate_result: Record<string, unknown>;
  hal_evidence: Record<string, unknown>;
  gate_decision: 'ALLOW' | 'ASK' | 'DENY';
  gate_reasons: string[];
  authorized_delta: number;
  outcome?: 'success' | 'fail' | 'escalate';
  policy_version?: string;
}

export async function writeTrustReceipt(
  db: SupabaseClient,
  r: TrustReceiptInput,
): Promise<string | null> {
  try {
    const { error } = await db.from('trust_receipts').insert({
      id: r.id,
      action_class: r.action_class,
      subject_type: r.subject_type ?? 'agent',
      subject_agent_id: r.subject_agent_id,
      contract_id: r.contract_id ?? null,
      task_id: r.task_id ?? null,
      evidence_predicate_result: r.evidence_predicate_result,
      hal_evidence: r.hal_evidence,
      gate_decision: r.gate_decision,
      gate_reasons: r.gate_reasons,
      authorized_delta: Math.round(r.authorized_delta),
      outcome: r.outcome ?? null,
      policy_version: r.policy_version ?? 'gate-v0',
      settled_at: new Date().toISOString(),
    });
    if (error) {
      console.error(`[trust-receipt-writer] insert failed for ${r.id}: ${error.message}`);
      return null;
    }
    return r.id;
  } catch (e: unknown) {
    console.error(`[trust-receipt-writer] insert threw for ${r.id}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}
