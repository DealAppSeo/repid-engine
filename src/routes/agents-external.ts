import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { calculateFullReward, calculateChallengerCourageBonus } from '../reward-formula';
import { extractHALSignals, extractHALSignalsWithCrossLLM } from '../services/hal-signals';
import { deriveHalDecision } from '../scoring/pipeline';
import { issueAgentApiKey } from '../auth/api-keys';
import { requireApiKey } from '../middleware/auth-api-key';

const router = Router();

const PYTHAGOREAN_COMMA = 531441 / 524288;
// bft_veto_threshold (0.0195) is TrustTrader-only; general HAL veto uses repid_config.hal_veto_threshold
const PHI_FALLBACK = 1.618033988749895;
const IMPACT_CAP_FALLBACK = 5.0;

function computeTierFromRepid(repid: number): string {
  if (repid >= 8000) return 'VETERAN';
  if (repid >= 5000) return 'AUTONOMOUS';
  if (repid >= 1000) return 'ESTABLISHED';
  if (repid >= 500) return 'EARNING';
  return 'PROBATIONARY';
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

// Sprint A5: sanitize free-form text — strip script/javascript/data URIs, null bytes.
function sanitizeFreeText(s: string): string {
  return s
    .replace(/\0/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?script[^>]*>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\bdata:[^\s;,]+/gi, '');
}

// Sprint A5: in-memory IP+name dedup window. 24h. Resets on process restart;
// production hardening sprint will move this to Redis.
const ipNameDedup: Map<string, number> = new Map();
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
function dedupKey(ip: string, name: string): string {
  return `${ip}::${name.toLowerCase()}`;
}
function checkAndRecordDedup(ip: string, name: string): { duplicate: boolean } {
  const now = Date.now();
  // Lazy cleanup: every call sweeps a small slice.
  if (ipNameDedup.size > 1000) {
    for (const [k, ts] of ipNameDedup) {
      if (now - ts > DEDUP_WINDOW_MS) ipNameDedup.delete(k);
    }
  }
  const key = dedupKey(ip, name);
  const last = ipNameDedup.get(key);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    return { duplicate: true };
  }
  ipNameDedup.set(key, now);
  return { duplicate: false };
}
// Test-only reset hook so jest cases can start with an empty dedup window.
export function __resetDedupForTests() {
  ipNameDedup.clear();
}

// POST /register — public agent onboarding (v11 + Sprint A5 Maya-shape)
router.post('/register', async (req: Request, res: Response) => {
  const {
    agent_name,
    name, // Sprint A5: Maya alias for agent_name. agent_name wins if both provided.
    description,
    constitution_text,
    llm_provider,
    llm_model,
    wallet_address,
    email_hash,
    byok_provider,
    is_human,
    conservator_address,
  } = req.body ?? {};

  // agent_name wins; fall back to name alias.
  const resolvedName: string | undefined = agent_name || name;

  if (!resolvedName) {
    return res.status(400).json({ error: 'agent_name (or name) is required' });
  }
  // Maya-shape allows registration without llm_provider; fall back to 'unknown'
  // so legacy clients still get the same behavior when they pass it.
  const resolvedProvider: string = llm_provider || 'unknown';

  // Sprint A5: bounds-check additive Maya fields.
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be a string' });
    }
    if (description.length > 200) {
      return res.status(400).json({ error: 'description max 200 chars' });
    }
  }
  if (constitution_text !== undefined && constitution_text !== null) {
    if (typeof constitution_text !== 'string') {
      return res.status(400).json({ error: 'constitution_text must be a string' });
    }
    if (constitution_text.length > 5000) {
      return res.status(400).json({ error: 'constitution_text max 5000 chars' });
    }
  }

  const cleanDescription = typeof description === 'string' ? sanitizeFreeText(description) : null;
  const cleanConstitutionText = typeof constitution_text === 'string' ? sanitizeFreeText(constitution_text) : null;

  // Sprint A5 anti-spam: same name from same IP within 24h → 429.
  const ip = (req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown').toString();
  const dedup = checkAndRecordDedup(ip, resolvedName);
  if (dedup.duplicate) {
    return res.status(429).json({
      error: 'Duplicate registration: same agent name from this IP within last 24h',
      hint: 'Try a unique name (e.g. add a numeric or environment suffix).',
    });
  }

  const vestingCliff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const erc8004 = wallet_address || `external:${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  const constitution: Record<string, any> = {
    version: '11.0',
    type: is_human ? 'HUMAN' : 'EXTERNAL_AGENT',
    anonymous: is_human ? true : false,
    llm_provider: resolvedProvider,
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
        agent_name: resolvedName,
        description: cleanDescription,
        constitution_text: cleanConstitutionText,
        current_repid: 200,
        tier: 'PROBATIONARY',
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
      .select('id, created_at, erc8004_token_id')
      .single();

    if (insertErr || !newAgent) {
      return res.status(500).json({ error: insertErr?.message ?? 'insert failed' });
    }

    const agentId = newAgent.id as string;

    const { key: rawKey } = await issueAgentApiKey(agentId, 'default', ['score_event', 'llm_complete', 'read_card', 'admin']);

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
      // Existing v11 fields (unchanged for legacy callers)
      agent_id: agentId,
      api_key: rawKey, // Shown ONCE; SDK clients must save it.
      starting_score: 200,
      tier: 'PROBATIONARY',
      vesting_cliff_ends_at: vestingCliff,
      vesting_info: 'First 500 RepID vests over 30 days',
      repid_url: `https://trustrepid.dev/agent/${agentId}`,
      // Sprint A5 Maya-shape additive fields (no breaking change)
      name: resolvedName,
      description: cleanDescription,
      repid: 200, // alias for starting_score
      erc8004_token_id: (newAgent as any).erc8004_token_id ?? null,
      created_at: (newAgent as any).created_at ?? createdAt,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Sprint A5: GET /:id/card — public profile, no private fields.
// Mounted at /api/v1/agents/:id/card (auth-bypassed in middleware/auth.ts).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get('/:id/card', async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  if (!UUID_RE.test(agentId)) {
    return res.status(400).json({ error: 'invalid agent id (expected UUID)' });
  }

  const { data: agent, error } = await db
    .from('repid_agents')
    .select('id, agent_name, description, current_repid, erc8004_token_id, created_at, last_active_at')
    .eq('id', agentId)
    .single();
  if (error || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Decision count (best-effort; failures default to 0).
  const { count: decisionCount } = await db
    .from('repid_score_events')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  // Sprint A7 — score-event aggregates. All best-effort; failures default to 0/null.
  const [
    cleanRes,
    flaggedRes,
    vetoedRes,
    last100Res,
    lastEventRes,
  ] = await Promise.all([
    db.from('repid_score_events').select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId).eq('hal_decision', 'clean'),
    db.from('repid_score_events').select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId).eq('hal_decision', 'flagged'),
    db.from('repid_score_events').select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId).eq('hal_decision', 'vetoed'),
    db.from('repid_score_events').select('hal_score')
      .eq('agent_id', agentId).not('hal_score', 'is', null)
      .order('created_at', { ascending: false }).limit(100),
    db.from('repid_score_events').select('created_at')
      .eq('agent_id', agentId).order('created_at', { ascending: false }).limit(1),
  ]);

  const last100Rows = (last100Res.data ?? []) as Array<{ hal_score: number | string | null }>;
  let avgHalScore: number | null = null;
  if (last100Rows.length > 0) {
    const nums = last100Rows
      .map(r => Number(r.hal_score))
      .filter(n => Number.isFinite(n));
    if (nums.length > 0) {
      avgHalScore = nums.reduce((a, b) => a + b, 0) / nums.length;
    }
  }
  const lastEventRows = (lastEventRes.data ?? []) as Array<{ created_at: string | null }>;
  const lastEventAt = lastEventRows[0]?.created_at ?? null;

  const tokenId = (agent as any).erc8004_token_id ?? null;
  const explorerUrl = tokenId
    ? `https://sepolia.basescan.org/token/0x8004A818BFB912233c491871b3d84c89A494BD9e?a=${tokenId}`
    : null;

  return res.json({
    agent_id: (agent as any).id,
    name: (agent as any).agent_name,
    description: (agent as any).description ?? null,
    repid: (agent as any).current_repid ?? 1000,
    erc8004_token_id: tokenId,
    total_decisions: decisionCount ?? 0,
    base_sepolia_explorer_url: explorerUrl,
    created_at: (agent as any).created_at ?? null,
    last_active_at: (agent as any).last_active_at ?? null,
    // Sprint A7 — score-event aggregates.
    total_score_events: decisionCount ?? 0,
    total_clean: cleanRes.count ?? 0,
    total_flagged: flaggedRes.count ?? 0,
    total_vetoed: vetoedRes.count ?? 0,
    avg_hal_score: avgHalScore,
    last_event_at: lastEventAt,
  });
});

// POST /:id/score-event — per-agent bearer auth, full v11 reward pipeline
router.post('/:id/score-event', requireApiKey(['score_event']), async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  if ((req as any).agent_id !== agentId) {
    return res.status(403).json({ error: 'API key agent_id mismatch' });
  }

  const { data: agent, error } = await db.from('repid_agents').select('*').eq('id', agentId).single();
  if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

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
    prompt,
  } = req.body ?? {};

  if (!llm_provider || typeof certainty !== 'number' || !decision_text || !outcome || !task_domain) {
    return res.status(400).json({
      error: 'llm_provider, certainty, decision_text, outcome, task_domain are required',
    });
  }
  if (certainty < 0 || certainty > 1) {
    return res.status(400).json({ error: 'certainty must be in [0,1]' });
  }

  // Phase 1.5 — when prompt is supplied, run Layer 0 classifier + Layer 1
  // cross-LLM agreement. Otherwise fall back to the synchronous 5-signal
  // extractor (preserves Track-A behavior for callers that only have the
  // answer text).
  const halSignals = (typeof prompt === 'string' && prompt.trim().length > 0)
    ? await extractHALSignalsWithCrossLLM(decision_text, task_domain || 'finance', certainty || 0.85, prompt)
    : extractHALSignals(decision_text, task_domain || 'finance', certainty || 0.85);

  try {
    // Phase 1.5 — 6-DOF combiner when agreement_score is present; 5-DOF otherwise.
    // 6-DOF reads its own threshold keys (hal_*_threshold_6dof) — distribution
    // differs from 5-DOF, so thresholds are independent.
    const hasAgreement = typeof (halSignals as any).agreement_score === 'number';
    const [hal5VetoThreshold, hal5BlockThreshold, hal6VetoThreshold, hal6BlockThreshold] = await Promise.all([
      getConfigNumber('hal_veto_threshold', 0.43),
      getConfigNumber('hal_block_threshold', 0.55),
      getConfigNumber('hal_veto_threshold_6dof', 0.43),
      getConfigNumber('hal_block_threshold_6dof', 0.55),
    ]);
    const halApproveThreshold = hasAgreement ? hal6VetoThreshold : hal5VetoThreshold;
    const halBlockThreshold = hasAgreement ? hal6BlockThreshold : hal5BlockThreshold;

    const dissonance = hasAgreement
      ? (0.35 * halSignals.harm_probability +
         0.25 * halSignals.epistemic_uncertainty +
         0.15 * (1 - halSignals.evidence_quality) +
         0.05 * (1 - halSignals.scope_appropriateness) +
         0.20 * (1 - ((halSignals as any).agreement_score as number))) *
        PYTHAGOREAN_COMMA
      : (0.4 * halSignals.harm_probability +
         0.3 * halSignals.epistemic_uncertainty +
         0.2 * (1 - halSignals.evidence_quality) +
         0.1 * (1 - halSignals.scope_appropriateness)) *
        PYTHAGOREAN_COMMA;
    const halApproved = dissonance <= halApproveThreshold;
    // Phase 1.5 ext (CC1) — Pythagorean Comma BFT hard veto (P-003).
    // When 3+ providers respond with high agreement AND tiny gap (coordinated
    // bias signature), force constitutional block regardless of dissonance.
    const commaVeto = (halSignals as any).comma_veto === true;
    const constitutionalBlock = commaVeto || dissonance > halBlockThreshold;

    if (constitutionalBlock) {
      return res.status(403).json({
        error: 'Constitutional block',
        hal_score: dissonance,
        reason: commaVeto
          ? `Pythagorean Comma BFT veto (P-003): coordinated-bias signature — comma_gap=${(halSignals as any).comma_gap}, severity=critical`
          : `dissonance exceeds constitutional block threshold (${halBlockThreshold})`,
        comma_veto: commaVeto,
        comma_gap: (halSignals as any).comma_gap ?? null,
        comma_severity: (halSignals as any).comma_severity ?? null,
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
    
    // Calculate hal_decision
    const hal_decision = deriveHalDecision(
      dissonance,
      constitutionalBlock,
      (halSignals as any).comma_severity ?? null
    );

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
        hal_decision,
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
      zkp_service_url: process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app'
    });
    
    fetch(`${process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app'}/zkp/repid-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        agent_id: agentId, 
        score: newScore,
        metadata: { job_id: proof_job_id }
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
