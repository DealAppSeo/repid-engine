import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

// GET /bounties — list bounties by status (default OPEN)
router.get('/bounties', async (req: Request, res: Response) => {
  const status = (req.query.status as string) ?? 'OPEN';
  const { data, error } = await db
    .from('repid_bounties')
    .select('*')
    .eq('status', status)
    .order('bounty_repid', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data ?? []);
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

export default router;
