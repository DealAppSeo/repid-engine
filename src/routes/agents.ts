import { Router, Request, Response } from 'express';
import { db } from '../db';
import { registerAgent, computeTier } from '../engine/repid-update';

const router = Router();

router.post('/agents', async (req: Request, res: Response) => {
  const { erc8004Address, agentName, conservatorAddress, constitution } = req.body;
  if (!erc8004Address || !agentName)
    return res.status(400).json({ error: 'erc8004Address and agentName are required' });
  try {
    return res.status(201).json(
      await registerAgent({ erc8004Address, agentName, conservatorAddress, constitution })
    );
  } catch (err: any) {
    return res.status(err.message?.includes('Already registered') ? 409 : 500)
      .json({ error: err.message });
  }
});

router.get('/agents', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const { data, error } = await db.from('repid_agents')
    .select('id,agent_name,current_repid,tier,activity_30d,last_updated,erc8004_address')
    .order('current_repid', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

router.get('/agents/:id', async (req: Request, res: Response) => {
  const { data, error } = await db.from('repid_agents')
    .select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Agent not found' });
  return res.json(data);
});

router.get('/agents/:id/history', async (req: Request, res: Response) => {
  const { data, error } = await db.from('repid_score_events').select('*')
    .eq('agent_id', req.params.id)
    .order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// ZKP tiered disclosure — EAS attestation via ERC-8004 ValidationRegistry
router.get('/agents/:id/zkp/:proofType', async (req: Request, res: Response) => {
  const { id, proofType } = req.params;
  const pt = (proofType as string).toUpperCase();
  if (!['POSTCARD','ENVELOPE','PACKAGE'].includes(pt))
    return res.status(400).json({ error: 'proofType: POSTCARD | ENVELOPE | PACKAGE' });

  const { data: agent } = await db.from('repid_agents').select('*').eq('id', id).single();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (pt === 'POSTCARD') return res.json({
    proofType: 'POSTCARD',
    agentName: agent.agent_name, tier: agent.tier,
    erc8004Address: agent.erc8004_address,
    constitutionVersion: agent.constitution?.version ?? null,
    easSchema: agent.constitution?.eas_schema ?? 'constitutional-compliance-v1',
    repIdScore: '[ZKP — not revealed at POSTCARD tier]',
    decisionHistory: '[ZKP — not revealed at POSTCARD tier]',
  });

  if (pt === 'ENVELOPE') {
    const { count: decisions } = await db.from('repid_score_events')
      .select('id', { count:'exact', head:true }).eq('agent_id', id);
    const { count: wins } = await db.from('repid_score_events')
      .select('id', { count:'exact', head:true })
      .eq('agent_id', id).eq('event_type', 'CHALLENGE_WIN');
    const { count: constPasses } = await db.from('repid_score_events')
      .select('id', { count:'exact', head:true })
      .eq('agent_id', id).eq('event_type', 'CONSTITUTIONAL_PASS');
    return res.json({
      proofType: 'ENVELOPE',
      agentName: agent.agent_name, tier: agent.tier,
      erc8004Address: agent.erc8004_address,
      decisionCount: decisions ?? 0,
      capitalProtectionRate: decisions
        ? Math.round(((wins ?? 0) / decisions) * 100) / 100 : null,
      constitutionalPassRate: decisions
        ? Math.round(((constPasses ?? 0) / decisions) * 100) / 100 : null,
      merkleRoot: '[ZKP commitment — verify on-chain via ERC-8004 ValidationRegistry]',
      easSchema: 'constitutional-compliance-v1',
      repIdScore: '[ZKP — not revealed at ENVELOPE tier]',
    });
  }

  return res.status(403).json({
    proofType: 'PACKAGE', status: 'requires_4fa',
    message: 'Full disclosure requires 4-factor auth by Conservator',
    docs: 'trustrepid.dev/docs/zkp-disclosure',
    easSchema: 'constitutional-compliance-v1',
  });
});

// x402 payment gate — RepID tier + EAS attestation check
// This is trustshell.gate() under the hood
router.post('/agents/:id/x402-gate', async (req: Request, res: Response) => {
  const { amount, currency = 'USDC', x402RequestId } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount is required' });

  const { data: agent } = await db.from('repid_agents').select('*')
    .eq('id', req.params.id).single();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const tierLimits: Record<string, number> = {
    CUSTODIED_DBT: 0, EARNING_AUTONOMY: 1000, AUTONOMOUS: Infinity,
  };
  const limit = tierLimits[agent.tier] ?? 0;
  const tierAllowed = amount <= limit;
  // Sprint 3: also check latest EAS attestation from ValidationRegistry
  const easCheck = { passed: true, stub: true,
    schema: 'constitutional-compliance-v1' };
  const allowed = tierAllowed && easCheck.passed;

  return res.json({
    allowed, agentId: req.params.id, agentName: agent.agent_name,
    repId: agent.current_repid, tier: agent.tier,
    requestedAmount: amount, currency,
    tierLimit: limit === Infinity ? 'unlimited' : limit,
    reason: !allowed
      ? `tier_limit_${limit === 0 ? 'zero_CUSTODIED_DBT' : limit}`
      : undefined,
    x402RequestId: x402RequestId ?? null,
    easAttestation: easCheck,
  });
});

export default router;
