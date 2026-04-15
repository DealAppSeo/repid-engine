import { Router, Request, Response } from 'express';
import { db } from '../db';
import { updateRepId } from '../engine/repid-update';

const router = Router();

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

// POST /bounties — post a new bounty
router.post('/bounties', async (req: Request, res: Response) => {
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
    posted_by_agent_id: postedByAgentId ?? null,
  }).select('id').single();
  if (error || !data) return res.status(500).json({ error: error?.message });
  return res.status(201).json({ bountyId: data.id });
});

// POST /bounties/:id/claim — claim a bounty
router.post('/bounties/:id/claim', async (req: Request, res: Response) => {
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
router.post('/bounties/:id/complete', async (req: Request, res: Response) => {
  const { agentId, zkpProof } = req.body ?? {};
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  await db.from('repid_bounties').update({
    status: 'COMPLETED',
    zkp_completion_proof: zkpProof ?? `eas-stub-bounty-${Date.now()}`,
    completed_at: new Date().toISOString(),
  }).eq('id', req.params.id).eq('claimant_agent_id', agentId);
  return res.json({ status: 'COMPLETED', message: 'Awaiting verification by Sean.' });
});

// POST /bounties/:id/verify — Sean-side verification → pays out RepID via /score
router.post('/bounties/:id/verify', async (req: Request, res: Response) => {
  const { verifierAgentId, approved } = req.body ?? {};
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
    return res.json({ status: 'REJECTED', message: 'Bounty returned to CLAIMED state' });
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
    verifierAgentId: verifierAgentId ?? null,
    payout,
    message: `Bounty verified. ${bounty.bounty_repid} RepID payout attributed (score event AUDIT_CONTRIBUTION).`,
  });
});

export default router;
