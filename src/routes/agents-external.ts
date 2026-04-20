import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { calculateFullReward, calculateChallengerCourageBonus } from '../reward-formula';

const router = Router();

const PYTHAGOREAN_COMMA = 531441 / 524288;
// bft_veto_threshold (0.0195) is TrustTrader-only; general HAL veto uses repid_config.hal_veto_threshold
const HAL_CONSTITUTIONAL_BLOCK = 0.48;
const PHI_FALLBACK = 1.618033988749895;
const IMPACT_CAP_FALLBACK = 5.0;

function computeTierFromRepid(repid: number): string {
  if (repid >= 5000) return 'AUTONOMOUS';
  if (repid >= 1000) return 'EARNING_AUTONOMY';
  return 'CUSTODIED_DBT';
}

function alignmentExponentFor(category: string): number {
  switch (category) {
    case 'ecosystem': return 1.0;
    case 'nonprofit': return 0.75;
    case 'self': return -1.0;
    case 'other':
    default: return 0.5;
  }
}

async function getConfigNumber(key: string, fallback: number): Promise<number> {
  const { data } = await db.from('repid_config').select('value').eq('key', key).single();
  const value = (data as any)?.value;
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function authAgent(req: Request, res: Response, agentId: string): Promise<any | null> {
  const header = req.headers['authorization'];
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Bearer token required' });
    return null;
  }
  const { data: agent, error } = await db
    .from('repid_agents').select('*').eq('id', agentId).single();
  if (error || !agent) {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }
  const storedKey = (agent as any)?.constitution?.api_key;
  if (!storedKey || storedKey !== token) {
    res.status(401).json({ error: 'Unauthorized: invalid api_key for agent' });
    return null;
  }
  return agent;
}

// POST /register — public agent onboarding (v11)
router.post('/register', async (req: Request, res: Response) => {
  const {
    agent_name,
    llm_provider,
    llm_model,
    wallet_address,
    email_hash,
    byok_provider,
    is_human,
    conservator_address,
  } = req.body ?? {};

  if (!agent_name || !llm_provider) {
    return res.status(400).json({ error: 'agent_name and llm_provider are required' });
  }

  const apiKey = crypto.randomUUID();
  const vestingCliff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const erc8004 = wallet_address || `external:${crypto.randomUUID()}`;

  const constitution: Record<string, any> = {
    version: '11.0',
    type: is_human ? 'HUMAN' : 'EXTERNAL_AGENT',
    anonymous: is_human ? true : false,
    api_key: apiKey,
    llm_provider,
    llm_model: llm_model ?? null,
    byok_provider: byok_provider ?? null,
    email_hash: email_hash ?? null,
    conservator_address: conservator_address ?? null,
    eas_schema: 'constitutional-compliance-v1',
  };

  try {
    const { data: newAgent, error: insertErr } = await db
      .from('repid_agents')
      .insert({
        erc8004_address: erc8004,
        agent_name,
        current_repid: 1000,
        tier: 'CUSTODIED_DBT',
        activity_30d: 0,
        decay_rate: 0.0015,
        is_human: !!is_human,
        agent_type: 'external',
        vesting_cliff_ends_at: vestingCliff,
        vested_repid: 0,
        byok_provider: byok_provider ?? null,
        byok_acknowledged_at: byok_provider ? new Date().toISOString() : null,
        constitution,
      })
      .select('id')
      .single();

    if (insertErr || !newAgent) {
      return res.status(500).json({ error: insertErr?.message ?? 'insert failed' });
    }

    const agentId = newAgent.id as string;

    await db.from('repid_verified_decisions').insert({
      agent_id: agentId, vdr_count: 0,
    });
    await db.from('repid_wisdom_scores').insert({
      agent_id: agentId,
      calibration_score: 1.0,
      domain_transfer_score: 1.0,
      epistemic_humility_score: 1.0,
      sample_size: 0,
    });
    await db.from('repid_adversarial_immunity').insert({
      agent_id: agentId, immunity_score: 0,
    });

    return res.status(201).json({
      agent_id: agentId,
      api_key: apiKey,
      starting_score: 1000,
      tier: 'CUSTODIED_DBT',
      vesting_cliff_ends_at: vestingCliff,
      vesting_info: 'First 500 RepID vests over 30 days',
      repid_url: `https://trustrepid.dev/agent/${agentId}`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /:id/score-event — per-agent bearer auth, full v11 reward pipeline
router.post('/:id/score-event', async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const agent = await authAgent(req, res, agentId);
  if (!agent) return;

  const {
    llm_provider,
    llm_model,
    certainty,
    decision_text,
    outcome,
    task_domain,
    hallucination_caught,
    economic_impact_usdc,
    alignment_category,
    challenge_mode,
    resolution_at,
  } = req.body ?? {};

  if (!llm_provider || typeof certainty !== 'number' || !decision_text || !outcome || !task_domain) {
    return res.status(400).json({
      error: 'llm_provider, certainty, decision_text, outcome, task_domain are required',
    });
  }
  if (certainty < 0 || certainty > 1) {
    return res.status(400).json({ error: 'certainty must be in [0,1]' });
  }

  let halSignals = null;
  if (decision_text) {
    const { extractHALSignals } = require('../services/hal-signals');
    halSignals = extractHALSignals(decision_text, task_domain || 'finance', certainty || 0.85);
  }

  try {
    // 2. HAL dissonance
    const halApproveThreshold = await getConfigNumber('hal_veto_threshold', 0.25);
    const harmScore = 1 - certainty;
    const epistemicScore = certainty < 0.5 ? 0.8 : 
                           certainty < 0.7 ? 0.5 :
                           certainty < 0.85 ? 0.3 : 0.1;
    const evidenceScore = certainty > 0.8 ? 0.1 :
                          certainty > 0.6 ? 0.25 : 0.5;
    const scopeScore = certainty > 0.8 ? 0.1 :
                       certainty > 0.6 ? 0.2 : 0.3;
    const dissonance =
      (0.4 * harmScore + 0.3 * epistemicScore + 0.2 * evidenceScore + 0.1 * scopeScore) *
      PYTHAGOREAN_COMMA;
    const halApproved = dissonance <= halApproveThreshold;
    const constitutionalBlock = dissonance > HAL_CONSTITUTIONAL_BLOCK;

    if (constitutionalBlock) {
      return res.status(403).json({
        error: 'Constitutional block',
        hal_score: dissonance,
        reason: 'dissonance exceeds constitutional block threshold (0.48)',
      });
    }

    // 4. Collusion risk — needs a target id. Use self-id as a fallback (returns 0).
    const { data: collusionData } = await db.rpc('calculate_collusion_risk', {
      p_agent_id: agentId,
      p_challenged_id: agentId,
    });
    const collusionRisk = typeof collusionData === 'number' ? collusionData : 0;

    // 5. Read config
    const [phi, impactCap] = await Promise.all([
      getConfigNumber('phi', PHI_FALLBACK),
      getConfigNumber('impact_factor_cap', IMPACT_CAP_FALLBACK),
    ]);

    // 6-8. Base delta + alignment + reward
    const baseDelta = Math.round(certainty * 10);
    const alignExp = alignmentExponentFor(alignment_category ?? 'other');
    const currentRepid: number = (agent as any).current_repid ?? 1000;
    const vdrCount: number = (agent as any).vdr_count ?? 0;
    const wisdomScore: number = (agent as any).wisdom_score ?? 1.0;
    const vestedRepid: number = (agent as any).vested_repid ?? 0;
    const vestingCliffEndsAt: string | null = (agent as any).vesting_cliff_ends_at ?? null;
    const isHuman: boolean = !!(agent as any).is_human;

    const rewardResult = calculateFullReward(
      {
        baseDelta,
        isValidator: true,
        impactUSDC: economic_impact_usdc ?? 0,
        domainAccuracy: 1.0,
        alignmentExponent: alignExp,
        challengerRepID: currentRepid,
        targetRepID: currentRepid,
        collusionRisk,
        isExploration: false,
        isGenesis: false,
        wisdomScore,
        informationParity: 1.0,
        daysAsNewDBT: 999,
        vdrCount,
        latencyPenalty: 1.0,
        keystoneFactor: 1.0,
        mentorshipBonus: 1.0,
        confessionFactor: 1.0,
        isHuman,
      },
      phi,
      impactCap,
    );

    const rawDelta = halApproved ? Math.round(rewardResult.reward) : -Math.abs(baseDelta);
    const courageBonus = calculateChallengerCourageBonus(currentRepid, currentRepid, phi);

    // 9. Vesting gate
    const vestingActive =
      vestedRepid < 500 &&
      vestingCliffEndsAt !== null &&
      new Date() < new Date(vestingCliffEndsAt);

    let newScore = currentRepid;
    let newVested = vestedRepid;
    if (vestingActive && rawDelta > 0) {
      newVested = Math.min(500, vestedRepid + rawDelta);
    } else {
      newScore = Math.max(10, Math.min(10000, currentRepid + rawDelta));
    }

    // 10. Tier
    const newTier = computeTierFromRepid(newScore);

    // 11. Insert score event
    const { data: eventRow, error: evErr } = await db
      .from('repid_score_events')
      .insert({
        agent_id: agentId,
        event_type: 'PREDICTION_RESOLVE',
        delta: rawDelta,
        repid_before: currentRepid,
        repid_after: newScore,
        certainty_at_claim: certainty,
        ecosystem_need_weight: 1.0,
        eas_attestation_id: `eas-stub-v11-${Date.now()}`,
        llm_provider,
        llm_model: llm_model ?? null,
        hal_score: dissonance,
        decision_outcome: outcome,
        task_domain,
        hallucination_caught: !!hallucination_caught,
        economic_impact_usdc: economic_impact_usdc ?? 0,
        alignment_category: alignment_category ?? 'other',
        collusion_risk: collusionRisk,
        information_parity: 1.0,
        challenger_repid_at_event: currentRepid,
        vdr_count_at_event: vdrCount,
        metadata: {
          decision_text,
          hal_signals: halSignals,
          hal_approved: halApproved,
          challenge_mode: challenge_mode ?? 'immediate',
          challenge_opens_at: challenge_mode === 'time_locked' ? resolution_at ?? null : null,
          reward_breakdown: rewardResult.breakdown,
          courage_bonus: courageBonus,
          vesting_active: vestingActive,
        },
      })
      .select('id')
      .single();

    if (evErr) {
      return res.status(500).json({ error: `score event insert failed: ${evErr.message}` });
    }

    // 12. HAL-RINS training case on caught hallucination
    let trainingCaseId: number | null = null;
    if (hallucination_caught) {
      const { data: caseRow } = await db
        .from('hal_training_cases')
        .insert({
          source_event_id: eventRow?.id ?? null,
          agent_id: agentId,
          llm_provider,
          llm_model: llm_model ?? null,
          hallucination_type: 'self_reported',
          original_claim: decision_text,
          catch_method: 'agent_disclosure',
          dissonance_score: dissonance,
          hal_layer_triggered: 1,
          added_to_test_suite: true,
        })
        .select('id')
        .single();
      trainingCaseId = (caseRow as any)?.id ?? null;

      await db.from('hal_threshold_updates').insert({
        hal_layer: 1,
        threshold_key: 'catch_count',
        old_value: 0,
        new_value: 1,
        update_type: 'production',
      });
    }

    // 13. Domain accuracy
    await db.rpc('update_agent_domain_accuracy', {
      p_agent_id: agentId,
      p_domain: task_domain,
      p_was_correct: halApproved,
    });

    // 14. Update agent
    const agentUpdate: Record<string, any> = {
      current_repid: newScore,
      tier: newTier,
      activity_30d: ((agent as any).activity_30d ?? 0) + 1,
      last_updated: new Date().toISOString(),
      vested_repid: newVested,
    };
    await db.from('repid_agents').update(agentUpdate).eq('id', agentId);

    // Async proof generation stub
    const proof_job_id = crypto.randomUUID();
    await db.from('repid_proof_queue').insert({
      job_id: proof_job_id,
      agent_id: agentId,
      event_id: eventRow?.id,
      status: 'pending',
      zkp_service_url: process.env.ZKP_SERVICE_URL || 'http://localhost:8080'
    });
    
    fetch(`${process.env.ZKP_SERVICE_URL || 'http://localhost:8080'}/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        agent_id: agentId, 
        repid_score: newScore,
        job_id: proof_job_id 
      })
    }).catch(err => console.error('Proof queue error:', err));

    // Webhook stub
    if ((agent as any).webhook_url && ((agent as any).webhook_events || []).includes('score_event')) {
      const payload = {
        event: 'score_event',
        agent_id: agentId,
        timestamp: new Date().toISOString(),
        delta: rawDelta,
        new_score: newScore,
        hal_approved: halApproved,
        vdr_count: vdrCount + 1
      };
      const sig = crypto.createHmac('sha256', (agent as any).webhook_secret || '').update(JSON.stringify(payload)).digest('hex');
      fetch((agent as any).webhook_url, {
        method: 'POST',
        headers: { 'X-RepID-Signature': sig, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(console.error);
    }

    return res.json({
      new_score: newScore,
      vested_repid: newVested,
      vesting_active: vestingActive,
      delta: rawDelta,
      tier: newTier,
      hal_approved: halApproved,
      hal_score: dissonance,
      challenger_courage_bonus: courageBonus,
      reward_breakdown: rewardResult.breakdown,
      vdr_count: vdrCount + 1,
      hallucination_training_case_id: trainingCaseId,
      llm_trust_updated: true,
      proof_job_id,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /:id/repid — public RepID card
router.get('/:id/repid', async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const { data: agent, error } = await db
    .from('repid_agents').select('*').eq('id', agentId).single();
  if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

  const [wisdomRes, vdrRes, immunityRes, llmRes] = await Promise.all([
    db.from('repid_wisdom_scores').select('composite_wisdom').eq('agent_id', agentId).single(),
    db.from('repid_verified_decisions').select('vdr_count,last_verified_at').eq('agent_id', agentId).single(),
    db.from('repid_adversarial_immunity').select('immunity_score').eq('agent_id', agentId).single(),
    db.from('repid_score_events')
      .select('llm_provider,llm_model,hallucination_caught,delta')
      .eq('agent_id', agentId)
      .not('llm_provider', 'is', null),
  ]);

  const llmRows = (llmRes.data ?? []) as Array<{
    llm_provider: string; llm_model: string | null;
    hallucination_caught: boolean | null; delta: number | null;
  }>;
  const llmBreakdown: Record<string, {
    total: number; hallucinations_caught: number; positive_deltas: number; model: string | null;
  }> = {};
  for (const r of llmRows) {
    const key = r.llm_provider ?? 'unknown';
    const existing = llmBreakdown[key];
    if (existing) {
      existing.total += 1;
      if (r.hallucination_caught) existing.hallucinations_caught += 1;
      if ((r.delta ?? 0) > 0) existing.positive_deltas += 1;
    } else {
      llmBreakdown[key] = {
        total: 1,
        hallucinations_caught: r.hallucination_caught ? 1 : 0,
        positive_deltas: (r.delta ?? 0) > 0 ? 1 : 0,
        model: r.llm_model,
      };
    }
  }

  return res.json({
    agent_id: agentId,
    agent_name: (agent as any).agent_name,
    current_repid: (agent as any).current_repid,
    tier: (agent as any).tier,
    vdr_count: (vdrRes.data as any)?.vdr_count ?? (agent as any).vdr_count ?? 0,
    wisdom_score: (wisdomRes.data as any)?.composite_wisdom ?? 1.0,
    domain_accuracy: (agent as any).domain_accuracy ?? {},
    adversarial_resilience_score:
      (immunityRes.data as any)?.immunity_score ?? (agent as any).adversarial_resilience_score ?? 0,
    activity_30d: (agent as any).activity_30d ?? 0,
    llm_breakdown: llmBreakdown,
    vesting_cliff_ends_at: (agent as any).vesting_cliff_ends_at ?? null,
    vested_repid: (agent as any).vested_repid ?? 0,
    is_human: !!(agent as any).is_human,
    agent_type: (agent as any).agent_type ?? 'external',
    last_updated: (agent as any).last_updated,
    badge_url: `https://trustrepid.dev/badge/${agentId}.svg`,
  });
});

// GET /:id/vdr — public VDR counter
router.get('/:id/vdr', async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const { data, error } = await db
    .from('repid_verified_decisions')
    .select('agent_id,vdr_count,last_verified_at')
    .eq('agent_id', agentId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'VDR record not found' });
  return res.json(data);
});

// GET /:id/proof/:job_id — public proof status
router.get('/:id/proof/:job_id', async (req: Request, res: Response) => {
  const job_id = String(req.params.job_id);
  const agentId = String(req.params.id);
  const { data, error } = await db
    .from('repid_proof_queue')
    .select('job_id,status,proof_hash,created_at,completed_at')
    .eq('job_id', job_id)
    .eq('agent_id', agentId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Proof job not found' });
  return res.json(data);
});

export default router;
