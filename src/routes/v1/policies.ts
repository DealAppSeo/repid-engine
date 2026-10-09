/**
 * policies.ts — the TrustKeys reference-tier POLICY LIFECYCLE: register, revoke, read.
 *
 *   POST /api/v1/policies         register a signed policy (idempotent on its content hash)
 *   POST /api/v1/policies/revoke  revoke it (owner signature required)
 *   GET  /api/v1/policies/:hash   PUBLIC read of the non-secret fields
 *
 * "No key on our disk" (Sean, 2026-10-08): the owner signs a policy on their own box; we verify the
 * signature and store the policy so later jobs can be checked against it and so it can be REVOKED.
 * Not custodial, not a broker — a policy is addresses-as-hashes + a cap + a signature, never a secret.
 * See src/services/signed-policy.ts for the model and the hard constraints.
 *
 * WHY MOUNTED AHEAD OF authMiddleware (like jobs.ts / byok.ts). The OWNER's signature IS the
 * authorization: identity is proven by cryptography, never asserted by an API key or header. A header
 * would be no identity at all — wallet addresses are public, so trusting one would let anyone revoke
 * another person's policy. The GET is public on purpose (its fields are non-secret). The global
 * SQL-keyword body sanitizer still runs on the POSTs (this router mounts after it in src/index.ts);
 * the payloads are all-hex plus a token symbol, so a valid body passes it.
 *
 * FLAG: SIGNED_JOB_VERIFY_ENABLED (shared with #1273, default OFF) → 404 before any DB read, so this
 * surface is inert until the operator applies the migration and sets the one flag.
 *
 * THREE OUTCOMES, NEVER TWO. A refusal is a clean explicit deny; a DB error REFUSES as `not_checked`
 * (503) and the raw error is logged server-side only, never returned.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { signedJobVerifyEnabled } from '../../services/signed-job';
import { verifyPolicyRegistration, verifyRevocation } from '../../services/signed-policy';

const router = Router();

const HEX = /^0x[0-9a-fA-F]+$/;

function notEnabled(res: Response) {
  return res.status(404).json({ error: 'not_found', message: 'Signed-policy lifecycle is not enabled on this deployment.' });
}

// POST /api/v1/policies — register { policy, policy_signature }.
router.post('/policies', async (req: Request, res: Response) => {
  if (!signedJobVerifyEnabled()) return notEnabled(res);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const outcome = await verifyPolicyRegistration({ policy: body['policy'], signature: body['policy_signature'] });
  if (!outcome.ok) {
    const status = outcome.error === 'bad_request' ? 400 : outcome.error === 'not_checked' ? 503 : 401; // signature_mismatch | expired
    return res.status(status).json({ registered: false, error: outcome.error, message: outcome.message });
  }

  // Store, idempotent on policy_hash (the content address). A re-register of the identical policy is a
  // primary-key conflict, which we report as idempotent success with the same hash — never an error.
  const insert = await db
    .from('signed_policies')
    .insert({
      policy_hash: outcome.policy_hash,
      owner: outcome.owner.toLowerCase(),
      policy_json: outcome.policy,
      signature: body['policy_signature'],
      chain_id: outcome.policy.chain_id,
      expiry: outcome.policy.expiry,
    })
    .select('policy_hash')
    .maybeSingle();

  if (insert.error) {
    const msg = String(insert.error.message ?? '');
    const code = String((insert.error as { code?: string }).code ?? '');
    if (/duplicate key|unique/i.test(msg) || code === '23505') {
      return res.status(200).json({ registered: true, idempotent: true, policy_hash: outcome.policy_hash });
    }
    console.error('[policies] register insert failed', insert.error);
    return res.status(503).json({ registered: false, error: 'not_checked', message: 'The policy could not be recorded, so nothing was registered.' });
  }

  return res.status(200).json({ registered: true, policy_hash: outcome.policy_hash });
});

// POST /api/v1/policies/revoke — revoke { revocation, revocation_signature }.
router.post('/policies/revoke', async (req: Request, res: Response) => {
  if (!signedJobVerifyEnabled()) return notEnabled(res);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const revocation = body['revocation'];
  const signature = body['revocation_signature'];

  // Need the policy_hash to look up the policy before verifying the signature against its owner.
  const policyHash = revocation && typeof revocation === 'object' ? (revocation as Record<string, unknown>)['policy_hash'] : undefined;
  if (typeof policyHash !== 'string' || !HEX.test(policyHash)) {
    return res.status(400).json({ revoked: false, error: 'bad_request', message: 'revocation.policy_hash must be a hex string' });
  }

  // 1. Look up the policy. A DB error REFUSES; a missing policy is policy_not_found (404).
  const lookup = await db
    .from('signed_policies')
    .select('owner, revoked_at')
    .eq('policy_hash', policyHash)
    .maybeSingle();
  if (lookup.error) {
    console.error('[policies] revoke lookup failed', lookup.error);
    return res.status(503).json({ revoked: false, error: 'not_checked', message: 'Could not read the policy, so nothing was changed.' });
  }
  const row = lookup.data as { owner: string; revoked_at: string | null } | null;
  if (!row) {
    return res.status(404).json({ revoked: false, error: 'policy_not_found', message: 'No policy with that hash is registered.' });
  }

  // 2. Verify the revocation signature recovers the STORED owner.
  const outcome = await verifyRevocation({ revocation, signature, expectedOwner: row.owner });
  if (!outcome.ok) {
    const status =
      outcome.error === 'bad_request' ? 400 :
      outcome.error === 'not_owner' ? 403 :
      outcome.error === 'not_checked' ? 503 :
      401; // signature_mismatch | expired
    return res.status(status).json({ revoked: false, error: outcome.error, message: outcome.message });
  }

  // 3. Apply the revocation atomically, guarded by revoked_at IS NULL and the unique revocation_nonce.
  const upd = await db
    .from('signed_policies')
    .update({ revoked_at: new Date().toISOString(), revocation_nonce: outcome.nonce })
    .eq('policy_hash', policyHash)
    .is('revoked_at', null)
    .select('policy_hash');

  if (upd.error) {
    const msg = String(upd.error.message ?? '');
    const code = String((upd.error as { code?: string }).code ?? '');
    if (/duplicate key|unique/i.test(msg) || code === '23505') {
      // The revocation nonce was already used (reused across the owner's policies).
      return res.status(409).json({ revoked: false, error: 'replay', message: 'This revocation nonce has already been used.' });
    }
    console.error('[policies] revoke update failed', upd.error);
    return res.status(503).json({ revoked: false, error: 'not_checked', message: 'The revocation could not be recorded, so nothing was changed.' });
  }

  const updated = (upd.data as unknown[] | null) ?? [];
  if (updated.length === 0) {
    // revoked_at was already set — the policy is already revoked. Replaying the effect changes nothing.
    return res.status(409).json({ revoked: false, error: 'replay', message: 'This policy is already revoked.' });
  }

  return res.status(200).json({ revoked: true, policy_hash: policyHash });
});

// GET /api/v1/policies/:policy_hash — PUBLIC read of non-secret fields only.
router.get('/policies/:policy_hash', async (req: Request, res: Response) => {
  if (!signedJobVerifyEnabled()) return notEnabled(res);

  const policyHash = req.params.policy_hash;
  if (typeof policyHash !== 'string' || !HEX.test(policyHash)) {
    return res.status(400).json({ error: 'bad_request', message: 'policy_hash must be a hex string' });
  }

  const lookup = await db
    .from('signed_policies')
    .select('owner, policy_json, expiry, revoked_at, created_at')
    .eq('policy_hash', policyHash)
    .maybeSingle();
  if (lookup.error) {
    console.error('[policies] get lookup failed', lookup.error);
    return res.status(503).json({ error: 'not_checked', message: 'Could not read the policy.' });
  }
  const row = lookup.data as
    | { owner: string; policy_json: { cap?: string; token?: string; payee_hashes?: string[] }; expiry: number | string; revoked_at: string | null; created_at: string }
    | null;
  if (!row) {
    return res.status(404).json({ error: 'policy_not_found', message: 'No policy with that hash is registered.' });
  }

  const p = row.policy_json ?? {};
  // Non-secret fields only: owner (public wallet), cap, token, payee HASHES, expiry, revoked, created.
  // Deliberately NOT returned: the signature and the policy_nonce.
  return res.status(200).json({
    policy_hash: policyHash,
    owner: row.owner,
    cap: p.cap ?? null,
    token: p.token ?? null,
    payee_hashes: p.payee_hashes ?? [],
    expiry: Number(row.expiry),
    revoked: row.revoked_at !== null && row.revoked_at !== undefined,
    created_at: row.created_at,
  });
});

export default router;
