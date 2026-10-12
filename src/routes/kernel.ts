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
 * A KEY BOUND TO ONE AGENT (req.agent_id, set by authMiddleware for a DB-issued agent key) may act
 * only on that agent: /decide, /policy and /receipt refuse with 403 when the agent they name is
 * another, before reading anything about it. Operator keys (env allowlist) are not bound and are
 * not restricted. See boundAgentOf.
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

/**
 * THE AGENT THIS REQUEST'S API KEY IS BOUND TO, or null when the key is not bound to one.
 *
 * authMiddleware sets `req.agent_id` ONLY for a DB-issued key tied to a registered agent
 * (auth.ts: `dbAgentId`). An env-allowlist key (REPID_API_KEYS: operator / shared tier) leaves it
 * unset, proves nothing about who is asking, and is deliberately not restricted here: this mirrors
 * how contracts.ts and dev-codegen.ts tell the two apart.
 *
 * WHY THIS IS NOT ALREADY DONE FOR US. authMiddleware's f2-authz check compares every STRING-valued
 * identity field in the body to the bound agent. The kernel names its subject in an OBJECT
 * (`agent: { agent_id, agent_name }`) and in `policy.subject`, which that check does not look at,
 * so a key bound to one agent could ask the kernel about another and read its limits, remaining
 * budget, accountable-owner wallet and receipts (CWE-862, found by Strix on #1317). The binding is
 * therefore re-checked here, route-locally, on every route that takes an agent from the caller.
 *
 * Lower-cased and trimmed, the way authMiddleware compares ids. ID ONLY, not the agent's name:
 * names are not unique (see the grants check in auth.ts).
 */
function boundAgentOf(req: Request): string | null {
  const bound = (req as unknown as { agent_id?: unknown }).agent_id;
  return typeof bound === 'string' && bound.trim() !== '' ? bound.trim().toLowerCase() : null;
}

/**
 * Does a bound key name some OTHER agent? Only a STRING that differs counts. A missing or non-string
 * agent is left to the strict parser, which refuses it with a 400 before anything is decided or read,
 * so there is nothing to leak.
 */
function namesOtherAgent(bound: string | null, claimed: unknown): boolean {
  return bound !== null && typeof claimed === 'string' && claimed.trim().toLowerCase() !== bound;
}

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
    // A key bound to one agent may only ask about that agent. Refused BEFORE any lookup, so the
    // answer carries nothing about the agent that was asked about, and its owner is never read.
    if (namesOtherAgent(boundAgentOf(req), (req.body as { agent?: { agent_id?: unknown } } | null)?.agent?.agent_id)) {
      res.status(403).json({
        verdict: 'DENY',
        blocking: true,
        persisted: false,
        reasons: [{ code: 'agent_not_bound_to_key', detail: 'this API key is bound to a different agent' }],
      });
      return;
    }
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
    // Same binding as /decide: a key bound to one agent may not set, or probe the owner of, another's.
    if (namesOtherAgent(boundAgentOf(req), signed.policy.subject)) {
      res.status(403).json({ error: 'agent_not_bound_to_key', detail: 'this API key is bound to a different agent' });
      return;
    }
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
      // A key bound to one agent may only read that agent's receipts. EVERY entry for the call is
      // checked, and nothing from a refused one is returned.
      const bound = boundAgentOf(req);
      if (bound !== null && entries.some((e) => e.subject.agent.agent_id.trim().toLowerCase() !== bound)) {
        res.status(403).json({ error: 'agent_not_bound_to_key', detail: 'this API key is bound to a different agent' });
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
