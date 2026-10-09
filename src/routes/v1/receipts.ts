/**
 * receipts.ts — the TrustKeys reference-tier PUBLIC receipt surfaces:
 *   GET  /api/v1/receipts/signer         — which engine address signs receipts (so a verifier knows
 *                                           what to expect); null when RECEIPT_SIGNING_KEY is unset.
 *   POST /api/v1/receipts/verify         — pure-crypto check of a receipt + its engine signature.
 *   GET  /api/v1/receipts/:owner/:nonce  — read one stored receipt back by its natural key.
 *
 * "No key on our disk" (Sean, 2026-10-08): a signed-job verification records ONLY receipt fields
 * (src/routes/v1/jobs.ts → src/services/signed-job.ts → the signed_job_receipts table). On its own a
 * receipt is "our DB row". When RECEIPT_SIGNING_KEY is set, the engine ALSO signs the row with its own
 * attestation key (src/services/receipt-attestation.ts) — the ENGINE's key, like the EAS/BASE_SEPOLIA
 * attestor keys, NOT a user/custody key. The two public crypto routes above let anyone confirm that
 * attestation without trusting a DB read: GET /receipts/signer publishes the expected address, and
 * POST /receipts/verify recovers the signer from a receipt's bytes + signature.
 *
 * NON-SECRET ONLY. A receipt holds no key, no prompt, no sentence, and no raw payee address — only the
 * payee HASH — and the GET response is PINNED to an exact non-secret field set (plus the engine
 * signature + signer, both public), so a future column cannot widen this surface silently. The engine
 * signature and the engine signer address are non-secret by construction.
 *
 * WHY MOUNTED AHEAD OF authMiddleware (like jobs.ts / policies.ts). All three are public: the lookup
 * key is a public wallet + nonce, the signer is a public address, and verify is pure crypto over bytes
 * the caller already holds. No API-key identity is involved.
 *
 * FLAG: SIGNED_JOB_VERIFY_ENABLED (shared with #1273, default OFF) → every route 404s BEFORE any work
 * (no DB read, no key read, no crypto), so the whole surface is inert until the operator applies the
 * receipt migration and sets the one flag.
 *
 * THREE OUTCOMES, NEVER TWO. A malformed input is a clean 400 (never a crash or a 503). An absent
 * receipt is 404. A DB error REFUSES as `not_checked` (503) with the raw error logged server-side only.
 * A receipt with no stored engine signature is `attested:false` — NOT "attestation failed" and never
 * presented as attested.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { engineSignerAddress, verifyReceiptAttestation, type ReceiptFields } from '../../services/receipt-attestation';
import { signedJobVerifyEnabled } from '../../services/signed-job';

const router = Router();

/** EVM address shape: 0x + 40 hex chars. Constrained up front so an untyped value never reaches the query. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** 0x-prefixed hex of any length — used for nonces, payee hashes, and signatures. */
const HEX = /^0x[0-9a-fA-F]+$/;
/** A non-negative integer string (token smallest-unit cap), matching the signed-job contract. */
const INT_STRING = /^[0-9]+$/;

/**
 * GET /receipts/signer — publish the engine attestation signer address so a verifier knows which
 * address to expect. null when RECEIPT_SIGNING_KEY is unset (the feature is inert). Flag-gated: 404
 * before any key read when off. No DB, no secret — the address is public.
 */
router.get('/receipts/signer', (_req: Request, res: Response) => {
  if (!signedJobVerifyEnabled()) {
    return res.status(404).json({ error: 'not_found', message: 'Signed-job receipts are not enabled on this deployment.' });
  }
  return res.status(200).json({ engine_signer: engineSignerAddress() });
});

/**
 * POST /receipts/verify — pure crypto. Body: { receipt: { owner, nonce, action, cap, payee_hash,
 * chain_id, time }, receipt_signature }. Recovers the signer over the receipt's canonical bytes and
 * returns { verified, engine_signer }. No DB read. A malformed body is a clean 400 (never a crash or a
 * 503). When the engine has no signer configured, verified is false and engine_signer is null.
 */
router.post('/receipts/verify', (req: Request, res: Response) => {
  if (!signedJobVerifyEnabled()) {
    return res.status(404).json({ error: 'not_found', message: 'Signed-job receipts are not enabled on this deployment.' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const receipt = body['receipt'];
  const signature = body['receipt_signature'];

  // Shape-validate every field up front so a malformed body is a clean 400, never a crash.
  if (!receipt || typeof receipt !== 'object') {
    return res.status(400).json({ error: 'bad_request', message: 'receipt must be an object' });
  }
  if (typeof signature !== 'string' || !HEX.test(signature)) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt_signature must be a 0x hex string' });
  }
  const r = receipt as Record<string, unknown>;
  if (typeof r['owner'] !== 'string' || !ADDRESS.test(r['owner'])) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt.owner must be a 0x-prefixed 40-hex-character address' });
  }
  if (typeof r['nonce'] !== 'string' || !HEX.test(r['nonce'])) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt.nonce must be a 0x hex string' });
  }
  if (typeof r['action'] !== 'string' || !r['action']) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt.action is required' });
  }
  if (typeof r['cap'] !== 'string' || !INT_STRING.test(r['cap'])) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt.cap must be an integer string (token smallest-unit)' });
  }
  if (typeof r['payee_hash'] !== 'string' || !HEX.test(r['payee_hash'])) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt.payee_hash must be a 0x hex hash' });
  }
  if (typeof r['chain_id'] !== 'number' || !Number.isInteger(r['chain_id'])) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt.chain_id must be an integer' });
  }
  if (typeof r['time'] !== 'string' || !r['time']) {
    return res.status(400).json({ error: 'bad_request', message: 'receipt.time is required' });
  }

  const fields: ReceiptFields = {
    owner: r['owner'],
    nonce: r['nonce'],
    action: r['action'],
    cap: r['cap'],
    payee_hash: r['payee_hash'],
    chain_id: r['chain_id'],
    time: r['time'],
  };
  const { verified, engine_signer } = verifyReceiptAttestation(fields, signature);
  return res.status(200).json({ verified, engine_signer });
});

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
  //    parameterized equality match; a non-matching value simply yields a 404 below. The engine
  //    attestation columns (receipt_signature, receipt_signer) are read alongside the receipt fields.
  const lookup = await db
    .from('signed_job_receipts')
    .select('action, cap, payee_hash, chain_id, signature_status, created_at, receipt_signature, receipt_signer')
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
    | {
        action: string;
        cap: string;
        payee_hash: string;
        chain_id: number;
        signature_status: string;
        created_at: string;
        receipt_signature?: string | null;
        receipt_signer?: string | null;
      }
    | null;
  if (!row) {
    return res.status(404).json({ error: 'receipt_not_found', message: 'No receipt with that owner and nonce is recorded.' });
  }

  // 4. Non-secret fields only, pinned to the exact set. No key / prompt / sentence / raw payee address
  //    exists in the row (the table holds none), and this explicit projection guarantees none can leak
  //    even if a future column is added. The engine signature + signer are public; `attested` is true
  //    iff a signature is stored — a NULL signature is `attested:false`, never "attestation failed".
  const receiptSignature = typeof row.receipt_signature === 'string' && row.receipt_signature.length > 0 ? row.receipt_signature : null;
  const engineSigner = typeof row.receipt_signer === 'string' && row.receipt_signer.length > 0 ? row.receipt_signer : null;
  return res.status(200).json({
    action: row.action,
    cap: row.cap,
    payee_hash: row.payee_hash,
    chain_id: row.chain_id,
    signature_status: row.signature_status,
    created_at: row.created_at,
    receipt_signature: receiptSignature,
    engine_signer: engineSigner,
    attested: receiptSignature !== null,
  });
});

export default router;
