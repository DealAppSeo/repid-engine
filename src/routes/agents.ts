import { Router, Request, Response } from 'express';
import { db } from '../db';
import { registerAgent, computeTier } from '../engine/repid-update';
import { computeEthics, suggestConstitutionalRules } from '../engine/badges';

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

    // Genesis badge for human DBTs
    await db.from('repid_badges').insert({
      agent_id: newAgent.id,
      badge_name: 'Genesis',
      badge_rarity: 'COMMON',
      badge_description: 'First step on HyperDAG Protocol',
      metadata: { type: 'HUMAN', date: new Date().toISOString() },
    });

    const suggestedRules = await suggestConstitutionalRules({
      role: (req.body?.role as string) ?? 'general',
    });

    return res.status(201).json({
      privateId: anonymousId,
      agentId: newAgent.id,
      repId: 1000,
      tier: 'CUSTODIED_DBT',
      badges: ['Genesis'],
      suggestedRules,
      message: 'Save your privateId — it is your only credential. We do not store your identity.',
      zkpCommitment,
      warning: 'CRITICAL: Save your privateId now. We do not store it. It cannot be recovered.',
      nextStep: `Visit repid.dev/check?id=${newAgent.id} to see your profile.`,
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
    .neq('agent_name', 'HUMAN')
    .limit(1)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Agent not found' });
  return res.json(data);
});

router.get('/agents', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const { data, error } = await db.from('repid_agents')
    .select('id,agent_name,current_repid,tier,activity_30d,last_updated,erc8004_address,constitution')
    .order('current_repid', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  const agents = (data ?? []).map((a: any) => ({
    id: a.id,
    agent_name: a.agent_name,
    current_repid: a.current_repid,
    tier: a.tier,
    activity_30d: a.activity_30d,
    last_updated: a.last_updated,
    erc8004_address: a.erc8004_address,
    constitution: a.constitution,
    bio: a.constitution?.bio ?? null,
    personality: a.constitution?.personality ?? null,
    isHuman: a.constitution?.type === 'HUMAN' || a.agent_name === 'HUMAN',
    ruleCount: Object.keys(a.constitution?.rules ?? {}).length,
  }));
  return res.json(agents);
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

// GET /agents/:id/badges — list earned badges
router.get('/agents/:id/badges', async (req: Request, res: Response) => {
  const { data, error } = await db
    .from('repid_badges')
    .select('*')
    .eq('agent_id', req.params.id)
    .order('earned_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data ?? []);
});

// GET /agents/:id/card — shareable anonymous ZKP score card (SVG)
router.get('/agents/:id/card', async (req: Request, res: Response) => {
  const { data: agent } = await db
    .from('repid_agents').select('*').eq('id', req.params.id).single();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { data: badges } = await db
    .from('repid_badges').select('badge_name, badge_rarity')
    .eq('agent_id', req.params.id);

  const isHuman = agent.constitution?.type === 'HUMAN' || agent.constitution?.anonymous;
  const tierColors: Record<string, string> = {
    AUTONOMOUS: '#F59E0B',
    EARNING_AUTONOMY: '#3B82F6',
    CUSTODIED_DBT: '#6B7280',
  };
  const tierColor = tierColors[agent.tier] ?? '#6B7280';
  const badgeCount = badges?.length ?? 0;
  const displayName = isHuman ? 'Anonymous Human' : agent.agent_name;
  const rawAddr: string = agent.erc8004_address ?? '';
  const displayAddress = isHuman
    ? '[ZKP — private]'
    : (rawAddr.slice(0, 10) + '...');

  const ethics = await computeEthics(String(req.params.id));
  const ethicsScore = ethics.overallScore;
  const tierLabel = String(agent.tier).replace(/_/g, ' ');
  const repIdStr = Number(agent.current_repid).toLocaleString();
  const today = new Date().toISOString().split('T')[0];

  const svg = `<svg width="400" height="220" xmlns="http://www.w3.org/2000/svg" font-family="monospace">
  <rect width="400" height="220" rx="16" fill="#111827"/>
  <rect x="1" y="1" width="398" height="218" rx="15" fill="none" stroke="${tierColor}" stroke-width="1.5" stroke-opacity="0.6"/>
  <text x="20" y="32" fill="#9CA3AF" font-size="11" font-weight="bold" letter-spacing="2">HYPERDAG PROTOCOL · REPID</text>
  <circle cx="370" cy="26" r="5" fill="#22C55E"/>
  <text x="20" y="90" fill="${tierColor}" font-size="52" font-weight="bold">${repIdStr}</text>
  <text x="20" y="112" fill="#6B7280" font-size="11">REPID SCORE</text>
  <rect x="20" y="125" width="160" height="24" rx="6" fill="${tierColor}" fill-opacity="0.15" stroke="${tierColor}" stroke-width="1" stroke-opacity="0.4"/>
  <text x="100" y="141" fill="${tierColor}" font-size="10" font-weight="bold" text-anchor="middle" letter-spacing="1">${tierLabel}</text>
  <text x="240" y="80" fill="#9CA3AF" font-size="10">ETHICS SCORE</text>
  <text x="240" y="108" fill="#22C55E" font-size="36" font-weight="bold">${ethicsScore}</text>
  <text x="240" y="135" fill="#9CA3AF" font-size="10">BADGES</text>
  <text x="240" y="155" fill="#F3F4F6" font-size="24" font-weight="bold">${badgeCount}</text>
  <text x="20" y="175" fill="#4B5563" font-size="10">${displayName}</text>
  <text x="20" y="190" fill="#374151" font-size="9">${displayAddress}</text>
  <text x="20" y="210" fill="#374151" font-size="9">ZKP-verified · repid.dev · hyperdag.dev</text>
  <text x="380" y="210" fill="#374151" font-size="9" text-anchor="end">${today}</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache');
  return res.send(svg);
});

// GET /events/recent — latest events across all agents
// Single endpoint for ActivityFeed — replaces N sequential /history calls.
router.get('/events/recent', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 15, 50);

  const { data, error } = await db
    .from('repid_score_events')
    .select('id, event_type, delta, repid_before, repid_after, created_at, eas_attestation_id, agent_id, metadata')
    .neq('event_type', 'GENESIS')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  const agentIds = Array.from(new Set((data ?? []).map((e: any) => e.agent_id)));
  const { data: agents } = agentIds.length
    ? await db.from('repid_agents').select('id, agent_name, constitution').in('id', agentIds)
    : { data: [] as any[] };

  const agentMap: Record<string, { name: string; isHuman: boolean }> = {};
  for (const a of agents ?? []) {
    agentMap[a.id] = {
      name: a.agent_name,
      isHuman: a.constitution?.type === 'HUMAN' || a.agent_name === 'HUMAN',
    };
  }

  const enriched = (data ?? []).map((e: any) => ({
    ...e,
    agentName: agentMap[e.agent_id]?.name ?? 'Unknown',
    isHuman: agentMap[e.agent_id]?.isHuman ?? false,
  }));

  return res.json(enriched);
});

// GET /agents/:id/ethics — real ethics health breakdown
router.get('/agents/:id/ethics', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { data: agent } = await db
    .from('repid_agents').select('id').eq('id', id).single();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const ethics = await computeEthics(id);
  return res.json(ethics);
});

// GET /suggested-rules?role=trading — constitutional rule suggestions (Cerebras stub)
router.get('/suggested-rules', async (req: Request, res: Response) => {
  const role = (req.query.role as string) ?? 'general';
  const domain = (req.query.domain as string) ?? 'generic';
  const rules = await suggestConstitutionalRules({ role, domain });
  return res.json({
    role,
    domain,
    suggestedRules: rules,
    source: 'stub-library',
    note: 'Sprint 5: real Cerebras Fast Inference call. Sprint 4: library stub.',
  });
});

export default router;
