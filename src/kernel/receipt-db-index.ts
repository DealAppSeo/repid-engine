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
import { DRY_PREVIEW_DOES_NOT_ATTEST } from './gate';
import { validateReceipt } from './receipt';
import type { KernelReceipt } from './types';
import { signReceipt, verifyReceiptSignature, type ReceiptSignature } from '../services/receipt-signer';

/** The kernel_receipts columns the confirmed-outcome verifier reads, as they come back from the DB. */
export interface KernelReceiptIndexRow {
  receipt_id?: unknown;
  subject_agent_id?: unknown;
  settled_by?: unknown;
  verdict_label?: unknown;
  verification_status?: unknown;
  is_simulated?: unknown;
  receipt_hash?: unknown;
  args_hash?: unknown;
  receipt?: unknown;
  /** The engine's DETACHED signature over the sealed receipt (see indexKernelReceiptToDb). */
  engine_signature?: unknown;
  /** Written by the indexer FROM the signed header.created_at; the gate refuses a row where they differ. */
  created_at?: unknown;
}

/**
 * How far the created_at COLUMN may sit from the SIGNED header.created_at. The indexer writes the column
 * from the header, so a genuine row differs by 0; the slack only absorbs timestamp representation.
 * The TTL reads the signed header itself (resolveServerConfirmation). The column is read only by the
 * settler's query, for its grace window and its keyset scan order, before any signature is checked; so
 * an edited column is an edited receipt: refused here, and it can only reorder the scan, never apply.
 */
export const CREATED_AT_SKEW_MS = 5_000;

/**
 * WAS THIS ROW WRITTEN BY THE KERNEL GATE'S OWN RUN? Returns null when yes, else the reason it was not.
 * (2026-10-14, XC1's re-attacks of #1364 finding 2 and of #1371.)
 *
 * The problem. `args_hash` is whatever 32-byte hex the client sends: the kernel deliberately never sees
 * the arguments ("hash the arguments; never send them"), and `hashArgs` has no non-test caller. The
 * server cannot recompute it, so it cannot BIND it. What it can bind is WHO produced the row.
 *
 * THE CONTROL IS THE ENGINE SIGNATURE, NOT RLS. RLS on kernel_receipts stops anon/authenticated, but the
 * service role (the indexer's own key) bypasses RLS, so a service-role writer could insert a
 * self-consistent re-sealed receipt (receipt_hash is an unsigned keccak). The indexer therefore signs
 * every receipt it indexes with the engine's receipt-only key (RECEIPT_SIGNING_KEY, the #1333 signer:
 * EIP-191 over a domain-separated content hash, never a payment signature), and this check requires that
 * signature to VERIFY against the engine signer. Without the signing key, nothing can forge a pass.
 * NOT_CHECKED (no engine signer configured) is a refusal, never a pass.
 *
 * Then that the row still IS the gate's receipt:
 *   - the sealed body validates (schema + invariants + receiptHash(body) === header.receipt_hash) and
 *     is the row's own receipt (id and hash);
 *   - it is not a dry preview;
 *   - every column the verifier gates on equals the sealed body's value (subject, args_hash and the
 *     verification leg), so a column edited without the body does not confirm;
 *   - VERIFIED (a gain) needs `executed: true` under ALLOW: the post actually ran under the gate and
 *     its outcome row was recorded. FAILED (a wrong) needs `executed: false`: a HAL FLAG/VETO DENYs
 *     the post, so a FAILED verification only ever exists on a refused, unexecuted decision row.
 *
 * WHAT THIS DOES NOT PROVE. Whoever holds RECEIPT_SIGNING_KEY can sign anything; that key is the trust
 * root. And because the arguments never reach the kernel, the args_hash in a gate receipt is the one
 * its in-process caller supplied. TODAY runUnderKernel HAS NO PRODUCTION CALLER, so no production row
 * exists to pass this and every confirmation fails closed. A future caller must compute args_hash with
 * hashArgs() over the arguments its closure actually uses.
 */
export function gateReceiptProblem(row: KernelReceiptIndexRow): string | null {
  const r = row.receipt as KernelReceipt | null | undefined;
  if (!r || typeof r !== 'object') return 'no_sealed_receipt';
  const id = typeof row.receipt_id === 'string' ? row.receipt_id : '';
  // The index keeps ONE row per call: the outcome row upserts over its decision row under the same id,
  // so invariant (7) — an executed record needs its decision row first — is satisfied by the id itself.
  const v = validateReceipt(r, { persisted_decision_ids: new Set([id]) });
  if (!v.ok) return `receipt_invalid:${v.errors[0]?.code ?? 'unknown'}`;
  if (r.header.receipt_id !== id) return 'receipt_id_mismatch';
  if (r.header.receipt_hash !== row.receipt_hash) return 'receipt_hash_mismatch';
  // THE ENGINE SIGNED THIS EXACT BODY. A re-seal, a copied signature or another key all fail here.
  const sig = verifyReceiptSignature(r, (row.engine_signature ?? null) as ReceiptSignature | null);
  if (sig.status === 'NOT_CHECKED') return 'signature_not_checked';
  if (sig.status !== 'VERIFIED') return 'signature_failed';
  // THE ROW'S TIME IS THE SIGNED TIME (XC1 re-attack of #1378). The signature covers header.created_at,
  // not the column; a re-stamped column could make an expired wrong look fresh, or a fresh one look old.
  const colMs = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
  if (!Number.isFinite(colMs) || Math.abs(colMs - Date.parse(r.header.created_at)) > CREATED_AT_SKEW_MS) {
    return 'created_at_mismatch';
  }
  if (r.decision.does_not_attest.includes(DRY_PREVIEW_DOES_NOT_ATTEST)) return 'dry_preview';
  if (r.subject.agent.agent_id !== row.subject_agent_id) return 'subject_mismatch';
  if (r.request.args_hash !== row.args_hash) return 'args_hash_mismatch';
  const ver = r.verification;
  if (
    ver.status !== row.verification_status ||
    ver.verdict_label !== row.verdict_label ||
    ver.settled_by !== row.settled_by ||
    ver.is_simulated !== row.is_simulated
  ) {
    return 'verification_mismatch';
  }
  if (ver.status === 'VERIFIED' && !(r.decision.executed === true && r.decision.verdict === 'ALLOW')) return 'verified_but_not_run';
  if (ver.status === 'FAILED' && r.decision.executed !== false) return 'failed_but_executed';
  return null;
}

let warnedUnsigned = false;

/**
 * Upsert a receipt into public.kernel_receipts, keyed by receipt_id. The decision row (executed:false)
 * is written first and the outcome row (executed:true) UPSERTs over it under the same id, so the index
 * ends on the final state of each call. All confirmation-relevant fields come from the VERIFICATION LEG
 * (status / verdict_label / settled_by / is_simulated), which is what the verifier gates on, plus the
 * request's args_hash (the content key the one-gain-per-content claim is unique on).
 *
 * SIGNED AT SEAL TIME (2026-10-14). The indexer is the production hook that runs right after the gate
 * appends (seals) a receipt, so this is where the engine signs it: a DETACHED signature in its own
 * column, so the receipt itself stays byte-identical to kernel-receipt/1 (whose schema pins
 * `header.signer: null` and is byte-pinned in trustshell). With no usable key the row is indexed
 * UNSIGNED (logged once), and an unsigned row can never confirm a score: fail closed.
 */
export async function indexKernelReceiptToDb(receipt: KernelReceipt): Promise<void> {
  try {
    const signed = await signReceipt(receipt);
    if (!signed.ok && !warnedUnsigned) {
      warnedUnsigned = true;
      console.warn(`[kernel] kernel receipts are being indexed UNSIGNED (${signed.reason}); they can never confirm a score`);
    }
    const v = receipt.verification;
    const { error } = await db.from('kernel_receipts').upsert(
      {
        receipt_id: receipt.header.receipt_id,
        subject_agent_id: receipt.subject.agent.agent_id,
        settled_by: v.settled_by,
        verdict_label: v.verdict_label,
        verification_status: v.status,
        is_simulated: v.is_simulated,
        receipt_hash: receipt.header.receipt_hash,
        // CONTENT KEY for the confirmed-outcome claim (2026-10-14): the same work under a new receipt_id
        // pays once. Needs migrations/2026-10-14-kernel-receipts-content-claim.sql; until it is applied,
        // PostgREST rejects this upsert (unknown column), nothing is indexed and nothing confirms (fail closed).
        args_hash: receipt.request.args_hash,
        // Needs migrations/2026-10-14-kernel-receipts-engine-signature.sql; same fail-closed shape.
        engine_signature: signed.ok ? signed.signature : null,
        // The SIGNED time, on every upsert: the outcome row (written after the tool ran) moves it to the
        // outcome's header time, so the column always equals the signed body the gate checks it against.
        created_at: receipt.header.created_at,
        receipt,
      },
      { onConflict: 'receipt_id' },
    );
    // supabase-js RETURNS a write error rather than throwing it; until 2026-10-14 this one went unread.
    if (error) console.warn(`[kernel] kernel_receipts index upsert failed (ledger unaffected): ${error.message}`);
  } catch (e) {
    // Fail-open: the JSONL ledger is authoritative and already committed. Never rethrow.
    console.warn(
      `[kernel] kernel_receipts index upsert failed (ledger unaffected): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
