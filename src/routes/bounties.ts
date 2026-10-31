import { Router, Request, Response } from 'express';
import { db } from '../db';
import { updateRepId } from '../engine/repid-update';
import { authorizeBountyVerification, verifierIndependence } from '../services/bounty-authorization';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { trustedClientIp } from '../middleware/client-ip';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// /bounties is mounted at '/' (src/index.ts), so the global token bucket — which gates only
// /api/v1/* — never sees it, and it sits ahead of authMiddleware. Every caller here is
// unauthenticated until a handler says otherwise, so the client IP is the only key there is
// (trustedClientIp, not req.ip). CodeQL js/missing-rate-limiting #45.
export const BOUNTIES_LIMIT_PER_MIN = 60;
router.use('/bounties', rateLimit({
  windowMs: 60_000,
  limit: BOUNTIES_LIMIT_PER_MIN,
  keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
}));

// GET /bounties — list bounties with optional filter/sort
//   ?status=OPEN|CLAIMED|COMPLETED|VERIFIED  (default OPEN, 'all' = no filter)
//   ?sort=repid|usdc|newest                   (default repid)
//   ?limit=20
router.get('/bounties', async (req: Request, res: Response) => {
  const status = (req.query.status as string) ?? 'OPEN';
  const sort = (req.query.sort as string) ?? 'repid';
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  let query = db.from('repid_bounties').select('*');
  if (status !== 'all') query = query.eq('status', status);

  if (sort === 'usdc') query = query.order('bounty_usdc', { ascending: false });
  else if (sort === 'newest') query = query.order('created_at', { ascending: false });
  else query = query.order('bounty_repid', { ascending: false });

  const { data, error } = await query.limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data ?? []);
});

// GET /bounties/:id — single bounty detail
router.get('/bounties/:id', async (req: Request, res: Response) => {
  const { data, error } = await db
    .from('repid_bounties')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Bounty not found' });
  return res.json(data);
});

// WRITES REQUIRE AN API KEY. This router is mounted at '/', ahead of the global
// `app.use(authMiddleware)` in src/index.ts, so each write runs authMiddleware itself: no key
// -> 401, invalid key -> 403. /verify keeps its own stricter scope check below. GET routes
// stay public.
//
// THE KEY SAYS WHO ACTS, NOT THE BODY. An agent-bound key acts as its own agent and the body's
// agentId is ignored (a string naming another agent is already refused by authMiddleware's
// f2-authz). A key with no agent identity (a REPID_API_KEYS env key) may act for a named agent
// only if it is an operator key (tier 'ops', the tier /observability/x402-metrics requires);
// any other unbound key is refused, because it could otherwise act as anyone.
//
// EVERY STATUS MOVE IS GUARDED IN THE UPDATE ITSELF (`.eq('status', <from>)`) and the updated
// row count is checked: OPEN->CLAIMED, CLAIMED->COMPLETED, COMPLETED->VERIFIED|CLAIMED. A move
// from any other state is a 409 and writes nothing. A read-then-write check alone loses a race,
// and an unguarded complete let a claimant pull a VERIFIED bounty back to COMPLETED so the next
// verify paid it again.
export const BOUNTY_OPERATOR_TIER = 'ops';

type Actor = { ok: true; agentId: string | null } | { ok: false; status: number; error: string };

function bountyActor(req: Request, claimed: unknown, field: string, required: boolean): Actor {
  if (claimed !== undefined && claimed !== null && typeof claimed !== 'string')
    return { ok: false, status: 400, error: `${field} must be a string` };
  const bound = (req as any).agent_id as string | undefined;
  if (bound) return { ok: true, agentId: bound };
  if ((req as any).apiKey?.tier !== BOUNTY_OPERATOR_TIER)
    return {
      ok: false,
      status: 403,
      error: `This key is not bound to an agent; only an operator ('${BOUNTY_OPERATOR_TIER}' tier) key may act for a named agent`,
    };
  if (required && !claimed) return { ok: false, status: 400, error: `${field} required` };
  return { ok: true, agentId: (claimed as string) || null };
}

/** A guarded update matched no row: 404 if the bounty does not exist, else 409 naming its state. */
async function noTransition(res: Response, id: unknown, from: string) {
  const { data } = await db.from('repid_bounties').select('status').eq('id', id).maybeSingle();
  if (!data) return res.status(404).json({ error: 'Bounty not found' });
  return res.status(409).json({ error: `Bounty is not ${from} (current: ${data.status})` });
}

// POST /bounties — post a new bounty
router.post('/bounties', authMiddleware, async (req: Request, res: Response) => {
  const { title, description, bountyRepid, bountyUsdc, repo,
          acceptanceCriteria, postedByAgentId } = req.body ?? {};
  const actor = bountyActor(req, postedByAgentId, 'postedByAgentId', false);
  if (!actor.ok) return res.status(actor.status).json({ error: actor.error });
  if (!title || !description)
    return res.status(400).json({ error: 'title and description required' });
  const { data, error } = await db.from('repid_bounties').insert({
    title,
    description,
    bounty_repid: bountyRepid ?? 0,
    bounty_usdc: bountyUsdc ?? 0,
    repo,
    acceptance_criteria: acceptanceCriteria,
    posted_by_agent_id: actor.agentId,
  }).select('id').single();
  if (error || !data) return res.status(500).json({ error: error?.message });
  return res.status(201).json({ bountyId: data.id });
});

// POST /bounties/:id/claim — claim a bounty (OPEN -> CLAIMED)
router.post('/bounties/:id/claim', authMiddleware, async (req: Request, res: Response) => {
  const actor = bountyActor(req, req.body?.agentId, 'agentId', true);
  if (!actor.ok) return res.status(actor.status).json({ error: actor.error });
  const { data, error } = await db.from('repid_bounties').update({
    status: 'CLAIMED',
    claimant_agent_id: actor.agentId,
    claimed_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('status', 'OPEN').select('id');
  if (error) return res.status(500).json({ error: error.message });
  if (!data?.length) return noTransition(res, req.params.id, 'OPEN');
  return res.json({ status: 'CLAIMED', claimantAgentId: actor.agentId, message: 'Bounty claimed. Complete and submit proof.' });
});

// POST /bounties/:id/complete — submit completion proof (CLAIMED -> COMPLETED, claimant only)
router.post('/bounties/:id/complete', authMiddleware, async (req: Request, res: Response) => {
  const { zkpProof } = req.body ?? {};
  const actor = bountyActor(req, req.body?.agentId, 'agentId', true);
  if (!actor.ok) return res.status(actor.status).json({ error: actor.error });
  const { data, error } = await db.from('repid_bounties').update({
    status: 'COMPLETED',
    zkp_completion_proof: zkpProof ?? `eas-stub-bounty-${Date.now()}`,
    completed_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('claimant_agent_id', actor.agentId).eq('status', 'CLAIMED').select('id');
  if (error) return res.status(500).json({ error: error.message });
  if (!data?.length) {
    const { data: b } = await db.from('repid_bounties')
      .select('status, claimant_agent_id').eq('id', req.params.id).maybeSingle();
    if (!b) return res.status(404).json({ error: 'Bounty not found' });
    if (b.claimant_agent_id !== actor.agentId)
      return res.status(403).json({ error: 'Only the claimant may complete this bounty' });
    return res.status(409).json({ error: `Bounty is not CLAIMED (current: ${b.status})` });
  }
  return res.json({ status: 'COMPLETED', message: 'Awaiting verification by Sean.' });
});

// POST /bounties/:id/verify — operator verification → pays out RepID via /score
//
// AUTHORIZATION RUNS FIRST, BEFORE ANY READ. This router is mounted at
// src/index.ts:376, ahead of `app.use(authMiddleware)` at line 456, so nothing
// upstream has checked anything by the time a request arrives here. The ordering
// below is load-bearing, not stylistic: a check that runs after the bounty is
// fetched still discloses whether an id exists and still risks a partial write.
// See services/bounty-authorization.ts for why the `admin` scope is NOT what
// gates this. (#446; reported externally in #445.)
router.post('/bounties/:id/verify', async (req: Request, res: Response) => {
  const authz = await authorizeBountyVerification({
    authorizationHeader: req.headers.authorization,
    apiKeyHeader: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
  });
  if (!authz.ok) {
    const status = authz.reason === 'insufficient_scope' ? 403 : 401;
    return res.status(status).json({ error: authz.detail, reason: authz.reason });
  }
  // The verifier is whoever the CREDENTIAL says it is. Any `verifierAgentId` in
  // the body is ignored — it is a claim, not evidence.
  const verifierAgentId = authz.verifierAgentId!;

  const { approved } = req.body ?? {};
  const { data: bounty } = await db
    .from('repid_bounties')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'COMPLETED')
    return res.status(409).json({ error: `Bounty not in COMPLETED state (current: ${bounty.status})` });

  if (approved === false) {
    const { data: moved, error: rejErr } = await db.from('repid_bounties').update({
      status: 'CLAIMED',
      completed_at: null,
    }).eq('id', req.params.id).eq('status', 'COMPLETED').select('id');
    if (rejErr) return res.status(500).json({ error: rejErr.message });
    if (!moved?.length) return noTransition(res, req.params.id, 'COMPLETED');
    return res.json({
      status: 'REJECTED',
      verifierAgentId,
      message: 'Bounty returned to CLAIMED state',
    });
  }

  // Approve pays the claimant, so the verifier must be someone else, under another owner.
  // Checked before the state change: a refused approval leaves the bounty COMPLETED.
  if (bounty.claimant_agent_id) {
    const indep = await verifierIndependence(verifierAgentId, bounty.claimant_agent_id);
    if (!indep.ok) return res.status(403).json({ error: indep.detail, reason: indep.reason });
  }

  // Approve: mark verified and pay out via AUDIT_CONTRIBUTION score event. Only the request
  // whose guarded update moves COMPLETED -> VERIFIED pays; a concurrent or repeated verify
  // matches no row and gets 409, so one completion pays once.
  let move = db.from('repid_bounties').update({
    status: 'VERIFIED',
    verified_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('status', 'COMPLETED');
  // Pay only the claimant the independence check was run against.
  if (bounty.claimant_agent_id) move = move.eq('claimant_agent_id', bounty.claimant_agent_id);
  const { data: verified, error: verErr } = await move.select('id');
  if (verErr) return res.status(500).json({ error: verErr.message });
  if (!verified?.length) return noTransition(res, req.params.id, 'COMPLETED');

  let payout = null;
  if (bounty.claimant_agent_id) {
    try {
      payout = await updateRepId({
        agentId: bounty.claimant_agent_id,
        eventType: 'AUDIT_CONTRIBUTION',
      });
    } catch (e) {
      payout = { error: (e as Error).message };
    }
  }

  return res.json({
    status: 'VERIFIED',
    verifierAgentId,
    payout,
    message: `Bounty verified. ${bounty.bounty_repid} RepID payout attributed (score event AUDIT_CONTRIBUTION).`,
  });
});

export default router;
