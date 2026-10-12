/**
 * /api/v1/kernel — the policy kernel's HTTP surface.
 *
 *   POST /decide        a DRY decision: weighs the request against the owner's signed policy and
 *                       returns the verdict. Writes nothing, runs nothing. 200 carries ALLOW, DENY
 *                       or NOT_CHECKED in the body; 400 is a request the kernel will not read.
 *   POST /policy        the owner's signed policy, verified and recorded. The signer must be the
 *                       agent's ACCOUNTABLE ROOT (accountable-root.ts); a signature from anyone
 *                       else — however valid — is refused.
 *   GET  /receipt/:id   the ledger entries for one call.
 *
 * Mounted AFTER authMiddleware. The global SQL-keyword sanitizer in index.ts runs first on POST
 * bodies and rejects `;` and `--`; a tool name containing either never reaches this file.
 *
 * A CLIENT THAT OBEYS /decide IS CO-OPERATING. The kernel enforces where it WRAPS the tool
 * (`runUnderKernel`); a remote caller that is told DENY and proceeds anyway is not stopped by this
 * route. trustshell's kernel-client refuses on anything but a clean ALLOW, which is the client half.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustedClientIp } from '../middleware/client-ip';
import { resolveAccountableRoot } from '../services/accountable-root';
import { dryDecision } from '../kernel/gate';
import { ownerEvidenceFromRoot, parseSignedPolicy, policyHash, verifyOwnerPolicy } from '../kernel/policy';
import { PolicyNonceError, StoreLedger, createJsonlStore } from '../kernel/store';
import type { GateDeps, OwnerResolver } from '../kernel/types';

export type KernelRouteDeps = Pick<GateDeps, 'ledger' | 'resolveOwner'> & Partial<Omit<GateDeps, 'ledger' | 'resolveOwner'>>;

const accountableRootOwner: OwnerResolver = async (agent) => ownerEvidenceFromRoot(await resolveAccountableRoot(agent.agent_id));

/**
 * The MVP ledger lives in the OS temp directory: outside the repository (nothing to commit by
 * accident) and, on Railway, EPHEMERAL — it does not survive a redeploy. That is the cost of "no
 * DDL"; a durable sink is the follow-up. Built on first use, never at import.
 */
function defaultDeps(): KernelRouteDeps {
  let built: KernelRouteDeps | null = null;
  const get = (): KernelRouteDeps =>
    (built ??= { ledger: new StoreLedger(createJsonlStore(join(tmpdir(), 'hyperdag-kernel', 'ledger.jsonl'))), resolveOwner: accountableRootOwner });
  return {
    get ledger() {
      return get().ledger;
    },
    get resolveOwner() {
      return get().resolveOwner;
    },
  };
}

const CALL_ID = /^[0-9a-zA-Z-]{8,64}$/;

export function createKernelRouter(deps: KernelRouteDeps = defaultDeps()): Router {
  const router = Router();

  /**
   * AN EXPLICIT CEILING ON THE KERNEL, ON TOP OF THE GLOBAL ONE.
   *
   * `/api/v1/*` already runs the tiered limiter in middleware/rate-limit.ts (60/min per IP with no
   * identity). This one is neither a replacement for it nor a no-op beside it:
   *   - it is stricter where the global one is looser. A BYOK identity gets 600/min globally, and an
   *     agent-attested one up to 1200/min; neither should be able to hammer a route that verifies a
   *     signature (POST /policy can reach the chain for a smart-wallet owner) at that rate;
   *   - it lives on the router, so it still applies if the router is ever mounted somewhere else.
   * The bucket is per network address, taken from the edge-set X-Real-IP rather than a header the
   * caller writes (middleware/client-ip.ts). A 429 is a non-200, which trustshell's kernel client
   * already reads as a refusal (NOT_CHECKED), never as a pass.
   *
   * Created per router, so each router (and each test app) counts on its own.
   */
  const kernelLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
    message: { error: 'too_many_requests', message: 'Too many kernel requests from this network. Try again in a minute.' },
  });
  router.use(kernelLimiter);

  router.post('/decide', async (req: Request, res: Response): Promise<void> => {
    try {
      const out = await dryDecision(req.body, deps);
      if ('malformed' in out) {
        res.status(400).json({ verdict: 'DENY', blocking: true, persisted: false, reasons: out.malformed });
        return;
      }
      res.status(200).json(out);
    } catch {
      // The kernel could not even weigh it. That is NOT_CHECKED, and it blocks.
      res.status(500).json({
        verdict: 'NOT_CHECKED',
        blocking: true,
        persisted: false,
        reasons: [{ code: 'default_deny', detail: 'the kernel failed before it could decide' }],
      });
    }
  });

  router.post('/policy', async (req: Request, res: Response): Promise<void> => {
    const parsed = parseSignedPolicy(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: 'malformed_policy', errors: parsed.errors });
      return;
    }
    const { signed, defaulted } = parsed;
    const now = (deps.now ?? Date.now)();

    if (signed.policy.expires_at * 1000 <= now) {
      res.status(400).json({ error: 'policy_already_expired' });
      return;
    }

    // Only the agent's accountable root may set its policy.
    const owner = await (async () => {
      try {
        return await deps.resolveOwner({ agent_id: signed.policy.subject, agent_name: '' });
      } catch {
        return { status: 'unknown' as const, wallet: null, assurance: null };
      }
    })();
    if (owner.status === 'unknown') {
      res.status(503).json({ error: 'owner_not_checked', detail: 'the agent\'s owner could not be established; nothing was recorded' });
      return;
    }
    if (owner.status === 'none' || !owner.wallet) {
      res.status(403).json({ error: 'owner_none', detail: 'nobody answers for this agent, so nobody can set its policy' });
      return;
    }
    if (owner.wallet.toLowerCase() !== signed.policy.owner.toLowerCase()) {
      res.status(403).json({ error: 'signer_not_owner', detail: "the policy owner is not this agent's accountable owner" });
      return;
    }

    const v = await verifyOwnerPolicy(signed.policy, signed.signature, deps.chain);
    if (v.status === 'NOT_CHECKED') {
      res.status(503).json({ error: 'signature_not_checked', detail: v.detail });
      return;
    }
    if (v.status === 'FAILED') {
      res.status(403).json({ error: 'bad_signature', detail: 'the owner did not sign this policy' });
      return;
    }

    try {
      await deps.ledger.appendPolicy(signed, new Date(now).toISOString());
    } catch (e) {
      if (e instanceof PolicyNonceError) {
        res.status(409).json({ error: 'nonce_not_higher', detail: 'send a policy with a higher nonce to replace the current one' });
        return;
      }
      res.status(503).json({ error: 'ledger_unavailable', detail: 'the policy could not be recorded' });
      return;
    }
    res.status(201).json({
      ok: true,
      policy_hash: policyHash(signed.policy),
      subject: signed.policy.subject,
      nonce: signed.policy.nonce,
      expires_at: signed.policy.expires_at,
      // Limits the owner left out are "0", and a payee list left out allows nobody. Said back so an
      // omission is never a surprise.
      limits_defaulted_to_zero: defaulted.filter((k) => k.endsWith('_raw')),
      payees_defaulted_to_none: defaulted.includes('payees'),
    });
  });

  router.get('/receipt/:id', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params['id'] ?? '');
    if (!CALL_ID.test(id)) {
      res.status(400).json({ error: 'bad_receipt_id' });
      return;
    }
    try {
      const entries = await deps.ledger.findReceipts(id);
      if (entries.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.status(200).json({
        receipt_id: id,
        receipt: entries[entries.length - 1],
        entries: entries.map((e) => ({ receipt_hash: e.header.receipt_hash, executed: e.decision.executed, created_at: e.header.created_at })),
      });
    } catch {
      // Could not read the ledger: that is not "no such receipt".
      res.status(503).json({ error: 'ledger_unavailable' });
    }
  });

  return router;
}

export default createKernelRouter();
