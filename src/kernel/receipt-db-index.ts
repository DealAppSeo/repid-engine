/**
 * receipt-db-index.ts — BEST-EFFORT mirror of one kernel receipt into public.kernel_receipts.
 *
 * The kernel's JSONL ledger (store.ts) is AUTHORITATIVE and is written first; this is only a
 * queryable index so the confirmed-outcome verifier (engine/repid-update.ts::resolveServerConfirmation)
 * can look a receipt up by id and bind it to the acting agent. It is injected into StoreLedger as the
 * `receiptIndexer` callback ONLY from the production wiring (routes/kernel.ts) — the generic ledger and
 * every kernel test stay DB-free.
 *
 * FAIL-OPEN FOR THE INDEX ONLY. Any error here — a missing table in prod very much included — is
 * swallowed; it MUST NEVER throw into the kernel decision path. StoreLedger also guards the call, so
 * this is belt-and-suspenders. A write failing changes nothing about the JSONL ledger or the verdict.
 */
import { db } from '../db';
import type { KernelReceipt } from './types';

/**
 * Upsert a receipt into public.kernel_receipts, keyed by receipt_id. The decision row (executed:false)
 * is written first and the outcome row (executed:true) UPSERTs over it under the same id, so the index
 * ends on the final state of each call. All confirmation-relevant fields come from the VERIFICATION LEG
 * (status / verdict_label / settled_by / is_simulated), which is what the verifier gates on.
 */
export async function indexKernelReceiptToDb(receipt: KernelReceipt): Promise<void> {
  try {
    const v = receipt.verification;
    await db.from('kernel_receipts').upsert(
      {
        receipt_id: receipt.header.receipt_id,
        subject_agent_id: receipt.subject.agent.agent_id,
        settled_by: v.settled_by,
        verdict_label: v.verdict_label,
        verification_status: v.status,
        is_simulated: v.is_simulated,
        receipt_hash: receipt.header.receipt_hash,
        receipt,
      },
      { onConflict: 'receipt_id' },
    );
  } catch (e) {
    // Fail-open: the JSONL ledger is authoritative and already committed. Never rethrow.
    console.warn(
      `[kernel] kernel_receipts index upsert failed (ledger unaffected): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
