/**
 * jobs.ts — POST /api/v1/jobs/verify, the TrustKeys reference-tier signed-job verifier.
 *
 * "No key on our disk" (Sean, 2026-10-08): the owner signs a job on their own box; we
 * verify the signature and that the job is inside a policy they already signed, then
 * store ONLY receipt fields. Not custodial, not a broker — see src/services/signed-job.ts
 * for the full decision and the hard constraints.
 *
 * WHY MOUNTED AHEAD OF authMiddleware. The owner's signature IS the authorization, the same
 * shape as the BYOK/bind routes: identity is proven by cryptography, never asserted by an API
 * key or a header. The global SQL-keyword body sanitizer still runs on this POST (this router is
 * mounted after it in src/index.ts) — the payload is all-hex (addresses, keccak hashes, hex
 * nonces, 0x signatures) plus a token symbol and an action word, so a valid body passes it.
 *
 * FLAG: SIGNED_JOB_VERIFY_ENABLED (default OFF) → 404, with no DB read, so it lands
 * finished-and-inert per CLAUDE_RULES 23 until the operator applies the migration and flips it.
 *
 * TWO POLICY SOURCES (2026-10-09, stacks on the policy registry). If the request carries an INLINE
 * policy, the original path runs UNCHANGED. If it omits the policy, the owner's ACTIVE stored policy
 * (registered via POST /api/v1/policies) is resolved and the job is verified against it EXACTLY as the
 * inline path does — see src/services/signed-policy.ts verifyJobWithStoredPolicy. The stored-policy
 * lookup never touches the inline path.
 */
import { Router, Request, Response } from 'express';
import { signedJobVerifyEnabled, verifySignedJob } from '../../services/signed-job';
import { verifyJobWithStoredPolicy } from '../../services/signed-policy';

const router = Router();

router.post('/jobs/verify', async (req: Request, res: Response) => {
  // 1. Flag gate — inert when off: a 404 before any database read, so a disabled
  // deployment is indistinguishable from a route that does not exist.
  if (!signedJobVerifyEnabled()) {
    return res.status(404).json({ error: 'not_found', message: 'Signed-job verify is not enabled on this deployment.' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // 2. Inline policy present → the original #1273 path, byte-for-byte unchanged.
  if (body['policy'] !== undefined && body['policy'] !== null) {
    const outcome = await verifySignedJob({
      policy: body['policy'],
      policy_signature: body['policy_signature'],
      job: body['job'],
      job_signature: body['job_signature'],
    });
    return res.status(outcome.status).json(outcome.body);
  }

  // 3. No inline policy → resolve the owner's active stored policy and verify against it.
  const outcome = await verifyJobWithStoredPolicy({ job: body['job'], job_signature: body['job_signature'] });
  return res.status(outcome.status).json(outcome.body);
});

export default router;
