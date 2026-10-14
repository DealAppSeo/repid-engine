import { Router, Request, Response } from 'express';
import { db } from '../db';
import { updateRepId } from '../engine/repid-update';
import { authorizeBountyVerification } from '../services/bounty-authorization';
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
// `app.use(authMiddleware)` in src/index.ts, so before this change POST /bounties,
// /claim and /complete accepted anyone. Each write now runs authMiddleware itself: no key
// -> 401, invalid key -> 403, and for an agent-bound key its f2-authz check rejects a body
// `agentId` naming a different agent. /verify keeps its own stricter scope check below.
// GET routes stay public.

// POST /bounties — post a new bounty
router.post('/bounties', authMiddleware, async (req: Request, res: Response) => {
  const { title, description, bountyRepid, bountyUsdc, repo,
          acceptanceCriteria, postedByAgentId } = req.body ?? {};
  if (!title || !description)
    return res.status(400).json({ error: 'title and description required' });
  const { data, error } = await db.from('repid_bounties').insert({
    title,
    description,
    bounty_repid: bountyRepid ?? 0,
    bounty_usdc: bountyUsdc ?? 0,
    repo,
    acceptance_criteria: acceptanceCriteria,
    // An agent-bound key posts as itself; the body field is only honoured for operator keys.
    posted_by_agent_id: (req as any).agent_id ?? postedByAgentId ?? null,
  }).select('id').single();
  if (error || !data) return res.status(500).json({ error: error?.message });
  return res.status(201).json({ bountyId: data.id });
});

// POST /bounties/:id/claim — claim a bounty
router.post('/bounties/:id/claim', authMiddleware, async (req: Request, res: Response) => {
  const { agentId } = req.body ?? {};
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const { data: bounty } = await db.from('repid_bounties')
    .select('status').eq('id', req.params.id).single();
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (bounty.status !== 'OPEN')
    return res.status(409).json({ error: 'Bounty is not open' });
  await db.from('repid_bounties').update({
    status: 'CLAIMED',
    claimant_agent_id: agentId,
    claimed_at: new Date().toISOString(),
  }).eq('id', req.params.id);
  return res.json({ status: 'CLAIMED', message: 'Bounty claimed. Complete and submit proof.' });
});

// POST /bounties/:id/complete — submit completion proof
router.post('/bounties/:id/complete', authMiddleware, async (req: Request, res: Response) => {
  const { agentId, zkpProof } = req.body ?? {};
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  await db.from('repid_bounties').update({
    status: 'COMPLETED',
    zkp_completion_proof: zkpProof ?? `eas-stub-bounty-${Date.now()}`,
    completed_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('claimant_agent_id', agentId);
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
    await db.from('repid_bounties').update({
      status: 'CLAIMED',
      completed_at: null,
    }).eq('id', req.params.id);
    return res.json({
      status: 'REJECTED',
      verifierAgentId,
      message: 'Bounty returned to CLAIMED state',
    });
  }

  // Approve: mark verified and pay out via AUDIT_CONTRIBUTION score event
  await db.from('repid_bounties').update({
    status: 'VERIFIED',
    verified_at: new Date().toISOString(),
  }).eq('id', req.params.id);

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
