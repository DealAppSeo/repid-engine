/**
 * receipts.ts — GET /api/v1/receipts/:owner/:nonce, the TrustKeys reference-tier PUBLIC receipt read.
 *
 * "No key on our disk" (Sean, 2026-10-08): a signed-job verification records ONLY receipt fields
 * (src/routes/v1/jobs.ts → src/services/signed-job.ts → the signed_job_receipts table). This GET reads
 * one back by its natural key (owner, nonce) and returns ONLY the NON-SECRET fields. A receipt holds
 * no key, no prompt, no sentence, and no raw payee address — only the payee HASH — so there is nothing
 * secret in the row to withhold; even so the response is PINNED to the exact non-secret field set, so a
 * future column added to the table cannot widen this surface silently (same posture as GET /policies).
 *
 * WHY MOUNTED AHEAD OF authMiddleware (like jobs.ts / policies.ts). This mirrors GET
 * /api/v1/policies/:hash — a public read of non-secret fields. No signature is needed: the lookup key
 * is a public wallet address plus a nonce, neither of which authorizes anything.
 *
 * FLAG: SIGNED_JOB_VERIFY_ENABLED (shared with #1273, default OFF) → 404 BEFORE any DB read, so this
 * surface is inert until the operator applies the receipt migration and sets the one flag. No new env
 * var is introduced.
 *
 * THREE OUTCOMES, NEVER TWO. A malformed owner is a clean 400 (not a crash, not a 503). An absent
 * receipt is 404. A DB error REFUSES as `not_checked` (503) with the raw error logged server-side only
 * and never returned — a failed read is never reported as an empty/absent result.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { signedJobVerifyEnabled } from '../../services/signed-job';

const router = Router();

/** EVM address shape: 0x + 40 hex chars. Constrained up front so an untyped value never reaches the query. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

router.get('/receipts/:owner/:nonce', async (req: Request, res: Response) => {
  // 1. Flag gate — inert when off: a 404 before any database read, so a disabled deployment is
  //    indistinguishable from a route that does not exist.
  if (!signedJobVerifyEnabled()) {
    return res.status(404).json({ error: 'not_found', message: 'Signed-job receipts are not enabled on this deployment.' });
  }

  // 2. Shape the owner before touching the DB. A malformed owner is a clean 400, never a crash or 503.
  const owner = req.params.owner;
  const nonce = req.params.nonce;
  if (typeof owner !== 'string' || !ADDRESS.test(owner)) {
    return res.status(400).json({ error: 'bad_request', message: 'owner must be a 0x-prefixed 40-hex-character address' });
  }

  // 3. Receipts are stored with the owner lowercased, so lowercase before the lookup. The nonce is a
  //    parameterized equality match; a non-matching value simply yields a 404 below.
  const lookup = await db
    .from('signed_job_receipts')
    .select('action, cap, payee_hash, chain_id, signature_status, created_at')
    .eq('owner', owner.toLowerCase())
    .eq('nonce', nonce)
    .maybeSingle();

  if (lookup.error) {
    // A read that ERRORED refuses as not_checked — never silently treated as "no receipt". Raw error
    // server-side only; it never leaves the process.
    console.error('[receipts] lookup failed', lookup.error);
    return res.status(503).json({ error: 'not_checked', message: 'Could not read the receipt, so nothing is reported.' });
  }

  const row = lookup.data as
    | { action: string; cap: string; payee_hash: string; chain_id: number; signature_status: string; created_at: string }
    | null;
  if (!row) {
    return res.status(404).json({ error: 'receipt_not_found', message: 'No receipt with that owner and nonce is recorded.' });
  }

  // 4. Non-secret fields only, pinned to the exact set. No key / prompt / sentence / raw payee address
  //    exists in the row (the table holds none), and this explicit projection guarantees none can leak
  //    even if a future column is added.
  return res.status(200).json({
    action: row.action,
    cap: row.cap,
    payee_hash: row.payee_hash,
    chain_id: row.chain_id,
    signature_status: row.signature_status,
    created_at: row.created_at,
  });
});

export default router;
