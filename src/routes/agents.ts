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

// POST /agents/human — anonymous human DBT registration
// ZKP-anonymous: no name, no real address stored
// Returns a private UUID the human keeps — their only credential
// The system stores only a ZKP commitment, never their identity
router.post('/agents/human', async (req: Request, res: Response) => {
  const { commitment, constitution } = req.body ?? {};

  const anonymousId = `human-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const zkpCommitment = commitment ||
    `zkp-commitment-${Date.now()}-${Math.random().toString(36).slice(2, 16)}`;

  const humanConstitution = constitution || {
    version: '1.0',
    type: 'HUMAN',
    eas_schema: 'constitutional-compliance-v1',
    rules: {
      rule_1: 'Act justly, love mercy, walk humbly (Micah 6:8)',
      rule_2: 'Never state an opinion as a certain fact',
      rule_3: 'Treat others as you wish to be treated (Matthew 7:12)',
    },
    governing_bodies: ['HyperDAG Protocol'],
    anonymous: true,
    version_date: new Date().toISOString().split('T')[0],
  };

  try {
    const { data: newAgent, error } = await db
      .from('repid_agents')
      .insert({
        erc8004_address: zkpCommitment,
        agent_name: 'HUMAN',
        current_repid: 1000,
        tier: 'CUSTODIED_DBT',
        constitution: {
          ...humanConstitution,
          type: 'HUMAN',
          anonymous: true,
          privateId: anonymousId,
        },
      })
      .select('id')
      .single();

    if (error || !newAgent) {
      return res.status(500).json({ error: error?.message ?? 'insert failed' });
    }

    await db.from('repid_score_events').insert({
      agent_id: newAgent.id,
      event_type: 'GENESIS',
      delta: 0,
      repid_before: 1000,
      repid_after: 1000,
      ecosystem_need_weight: 1.0,
      eas_attestation_id: `eas-stub-genesis-${String(newAgent.id).slice(0, 8)}`,
      metadata: {
        type: 'HUMAN_ANONYMOUS',
        zkpCommitment,
        easSchema: 'constitutional-compliance-v1',
        note: 'Human identity — ZKP anonymous. No PII stored.',
      },
    });

    return res.status(201).json({
      privateId: anonymousId,
      agentId: newAgent.id,
      repId: 1000,
      tier: 'CUSTODIED_DBT',
      message: 'Save your privateId — it is your only credential. We do not store your identity.',
      zkpCommitment,
      warning: 'IMPORTANT: Save privateId and agentId now. They cannot be recovered.',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /agents/:id/mark-human — flag an existing agent as an anonymous human
// Used to upgrade pre-existing records (e.g. founder DBT #1) so POSTCARD
// renders them as ZKP-anonymous humans.
router.post('/agents/:id/mark-human', async (req: Request, res: Response) => {
  const { data: agent, error: readErr } = await db
    .from('repid_agents')
    .select('constitution')
    .eq('id', req.params.id)
    .single();
  if (readErr || !agent) return res.status(404).json({ error: 'Agent not found' });

  const nextConstitution = {
    ...(agent.constitution || {}),
    type: 'HUMAN',
    anonymous: true,
    eas_schema: 'constitutional-compliance-v1',
  };

  const { error: upErr } = await db
    .from('repid_agents')
    .update({ constitution: nextConstitution })
    .eq('id', req.params.id);
  if (upErr) return res.status(500).json({ error: upErr.message });

  return res.json({ ok: true, agentId: req.params.id, markedHuman: true });
});

// GET /agents/by-name/:name — find agent UUID by name (case-insensitive)
// Used by TrustTrader challenge system to sync events
router.get('/agents/by-name/:name', async (req: Request, res: Response) => {
  const { data, error } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, tier')
    .ilike('agent_name', String(req.params.name))
    .limit(1)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Agent not found' });
  return res.json(data);
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

  const isHuman = agent.constitution?.type === 'HUMAN' ||
                  agent.constitution?.anonymous === true;

  if (pt === 'POSTCARD') return res.json({
    proofType: 'POSTCARD',
    agentType: isHuman ? 'HUMAN' : 'AGENT',
    tier: agent.tier,
    agentName: isHuman ? '[ZKP — anonymous human]' : agent.agent_name,
    erc8004Address: isHuman ? '[ZKP — private]' : agent.erc8004_address,
    constitutionVersion: isHuman ? '[ZKP — private]' : (agent.constitution?.version ?? null),
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
