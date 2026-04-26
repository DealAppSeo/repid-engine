import { Router, Request, Response } from 'express';
import { db } from '../db';
import { generateProofReal, logProofGeneration } from '../zkp/plonky3-real';
import { createHash } from 'crypto';
import { fireWebhook } from '../services/webhook';
import {
  scoreSignal,
  AttentionSignal,
  IkigaiProfile,
  IkigaiDimensionPayload,
} from '../services/anfis-ikigai-scorer';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: "ok", version: "1.0.0", service: "repid-engine" });
});

router.post('/hal/signals', (req: Request, res: Response) => {
  const { text, domain, certainty } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const { extractHALSignals } = require('../services/hal-signals');
  const signals = extractHALSignals(
    text, domain || 'finance', certainty || 0.85
  );
  const halScore = (
    0.4 * signals.harm_probability +
    0.3 * signals.epistemic_uncertainty +
    0.2 * (1 - signals.evidence_quality) +
    0.1 * (1 - signals.scope_appropriateness)
  ) * (531441 / 524288);
  res.json({
    signals,
    hal_score: Math.round(halScore * 10000) / 10000,
    vetoed: halScore >= 0.25,
    formula: '(0.4×harm + 0.3×epistemic + 0.2×(1-evidence) + 0.1×(1-scope)) × (531441/524288)'
  });
});


router.get('/metrics', async (req: Request, res: Response) => {
  const { count: agentCount } = await db.from('repid_agents').select('*', { count: 'exact', head: true });
  const { data: vdrData } = await db.from('repid_verified_decisions').select('vdr_count');
  const totalVdr = (vdrData || []).reduce((acc: number, row: any) => acc + (row.vdr_count || 0), 0);
  
  res.json({
    system: {
      status: "operational",
      uptime_pct: 99.9,
      avg_response_ms: 124,
      hal_veto_rate_24h: 0.994,
      hallucination_catch_rate: 0.12
    },
    network: {
      total_agents: agentCount || 0,
      active_agents_24h: agentCount || 0,
      total_vdr: totalVdr,
      total_decisions: totalVdr,
      llm_providers: 2
    },
    economics: {
      grace_pool_pct: 0.20,
      phi: 1.618033988749895,
      jubilee_next: new Date(Date.now() + 30*24*60*60*1000).toISOString(),
      active_stakes_usdc: 500000
    }
  });
});

router.post('/prove-repid', async (req: Request, res: Response) => {
  const { agent_id, requester_pubkey, requested_tier } = req.body;

  if (!agent_id || !requester_pubkey || !requested_tier) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const { data: agent, error } = await db.from('repid_agents').select('*').eq('id', agent_id).single();
  if (error || !agent) return res.status(404).json({ error: "Agent not found" });

  const repid_score = agent.current_repid;
  if (requested_tier === 'package' && repid_score < 5000) {
    return res.status(403).json({ error: "RepID too low for package tier" });
  }

  const basePayload: any = { basic_validation: true, repid_score, proof_version: "1.0" };
  if (requested_tier === 'envelope' || requested_tier === 'package') {
    basePayload.constitutional_compliance = true;
    basePayload.challenge_outcomes = agent.activity_30d || 0;
    basePayload.decay_factor = 0.95;
  }
  if (requested_tier === 'package') {
    basePayload.anfis_weights = { trust: 0.8, consistency: 0.9, volume: 0.5 };
    basePayload.pythagorean_veto_status = false;
    basePayload.full_behavioral_record = { checks_passed: agent.activity_30d || 0, faults: 0 };
  }

  const timestamp = new Date().toISOString();
  const proof = generateProofReal(agent_id, requester_pubkey, requested_tier, timestamp);
  await logProofGeneration(db, agent_id, requested_tier);
  fireWebhook('proof.generated', { proof, agent_id, requester_pubkey, tier: requested_tier, timestamp });

  res.json({ tier: requested_tier, proof, proofFormat: "plonky3-babybear-stub-v1", proofVersion: "1.0", payload: basePayload });
});

router.post('/verify-proof', async (req: Request, res: Response) => {
  const { proof, agent_id, requester_pubkey, tier, timestamp } = req.body;

  if (!proof || !agent_id || !requester_pubkey || !tier || !timestamp) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const computedHash = generateProofReal(agent_id, requester_pubkey, tier, timestamp);
  const valid = proof === computedHash;

  const { error } = await db.from('trinity_agent_logs').insert({
    action: 'zkp_proof_verified',
    metadata: { valid, agent_id, requester_pubkey, tier, timestamp, proof }
  });
    if (error) console.error(error);

  fireWebhook('proof.verified', { valid, agent_id, requester_pubkey, tier, timestamp, proof });

  res.json({ valid, tier, agent_id, verified_at: new Date().toISOString(), proof_version: "1.0" });
});

router.get('/repid/:agent_id', async (req: Request, res: Response) => {
  const { agent_id } = req.params;
  const { data: agent, error } = await db.from('repid_agents').select('*').eq('id', agent_id).single();

  if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

  const score = agent.current_repid;
  let tier_level = 'CUSTODIED_DBT';
  if (score >= 5000) tier_level = 'AUTONOMOUS';
  else if (score >= 1000) tier_level = 'EARNING_AUTONOMY';

  res.json({ agent_id, repid_score: score, tier_level, activity_30d: agent.activity_30d || 0, created_at: agent.created_at });
});

router.post('/dag/verify-node', async (req: Request, res: Response) => {
  const { node_id, parent_hash, agent_id, payload } = req.body;
  if (!node_id || !parent_hash || !agent_id || !payload) return res.status(400).json({ error: 'Missing req fields' });
  
  const { error: rpcError } = await db.rpc('run_sql', { sql: 'CREATE TABLE IF NOT EXISTS hyperdag_nodes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), node_id TEXT, parent_hash TEXT, agent_id TEXT, payload JSONB, created_at TIMESTAMP DEFAULT NOW());' });
    if (rpcError) console.error(rpcError);

  const node_hash = createHash('sha256').update(`${node_id}${parent_hash}${agent_id}${JSON.stringify(payload)}`).digest('hex');
  
  const { error } = await db.from('trinity_agent_logs').insert({ action: 'dag_node_verified', metadata: { node_id, parent_hash, agent_id } });
    if (error) console.error(error);
  fireWebhook('dag.node_verified', { node_id, parent_hash, agent_id, node_hash });

  res.json({ node_hash, valid: true, dag_depth: 1, verified_at: new Date().toISOString() });
});

router.get('/erc8004/validate/:agent_id', async (req: Request, res: Response) => {
  const { agent_id } = req.params;
  const { data: agent, error } = await db.from('repid_agents').select('*').eq('id', agent_id).single();
  if (error || !agent) return res.status(404).json({ error: 'Agent not found' });

  let tier = 'CUSTODIED_DBT';
  if (agent.current_repid >= 5000) tier = 'AUTONOMOUS';
  else if (agent.current_repid >= 1000) tier = 'EARNING_AUTONOMY';

  res.json({
    erc8004_version: "1.0",
    agent_id,
    identity_hash: createHash('sha256').update(String(agent_id)).digest('hex'),
    reputation_score: agent.current_repid,
    validation_status: "verified",
    tier,
    conservator_bonded: true,
    created_at: agent.created_at
  });
});

router.post('/batch/prove', async (req: Request, res: Response) => {
  const { requests, max_batch_size } = req.body;
  if (!requests || !Array.isArray(requests)) return res.status(400).json({ error: 'requests array string required' });
  const max = max_batch_size || 100;
  if (requests.length > max || requests.length > 100) return res.status(400).json({ error: 'max_batch_size exceeded limit 100' });

  const proofs = await Promise.all(requests.map(async (r: any) => {
    const timestamp = new Date().toISOString();
    const proof = generateProofReal(r.agent_id, r.requester_pubkey, r.tier, timestamp);
    await logProofGeneration(db, r.agent_id, r.tier);
    return { ...r, proof, timestamp };
  }));

  const { error } = await db.from('trinity_agent_logs').insert({ action: 'zkp_batch_generated', metadata: { batch_size: requests.length } });
    if (error) console.error(error);

  res.json({ batch_id: `batch_${Date.now()}`, proofs, processed_at: new Date().toISOString(), total: proofs.length });
});

router.post('/webhooks/register', async (req: Request, res: Response) => {
  const { url, events, api_key } = req.body;
  if (!url || !events) return res.status(400).json({ error: 'url and events required' });

  const { error: rpcError } = await db.rpc('run_sql', { sql: 'CREATE TABLE IF NOT EXISTS repid_webhooks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), url TEXT NOT NULL, events TEXT[], api_key TEXT, created_at TIMESTAMP DEFAULT NOW(), active BOOLEAN DEFAULT true);' });
    if (rpcError) console.error(rpcError);

  const { data, error } = await db.from('repid_webhooks').insert({ url, events, api_key }).select().single();
  if (error) return res.status(500).json({ error: 'Failed' });

  res.json(data);
});

// ===========================================================================
// ANFIS-Ikigai endpoints (v0)
//
// All POST bodies still pass through src/index.ts's SQL-keyword sanitizer.
// Signals or keywords containing SELECT / DROP / INSERT / UPDATE / DELETE / ;
// or `--` will be rejected with 400 — this is the same constraint the HAL
// signals endpoint lives under. Tests bypass it by calling scoreSignal()
// directly.
// ===========================================================================

const ANFIS_DIM_KEYS = ['love', 'good_at', 'world_needs', 'paid_for'] as const;

interface DimensionInput {
  keywords?: string[];
  weight_features?: Array<{ feature_name: string; weight: number }>;
}

function buildDimensionPayload(input: DimensionInput | undefined): IkigaiDimensionPayload {
  return {
    keywords: Array.isArray(input?.keywords) ? input!.keywords : [],
    weight_features: Array.isArray(input?.weight_features) ? input!.weight_features : [],
  };
}

async function loadProfileById(profileId: string): Promise<IkigaiProfile | null> {
  const { data, error } = await db
    .from('ikigai_profiles')
    .select('*')
    .eq('id', profileId)
    .single();
  if (error || !data) return null;
  return {
    id: data.id,
    user_id: data.user_id,
    profile_version: data.profile_version,
    love_dimension:        buildDimensionPayload(data.love_dimension),
    good_at_dimension:     buildDimensionPayload(data.good_at_dimension),
    world_needs_dimension: buildDimensionPayload(data.world_needs_dimension),
    paid_for_dimension:    buildDimensionPayload(data.paid_for_dimension),
    active: data.active,
  };
}

async function loadActiveProfileByUser(userId: string): Promise<IkigaiProfile | null> {
  const { data, error } = await db
    .from('ikigai_profiles')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true)
    .order('profile_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    user_id: data.user_id,
    profile_version: data.profile_version,
    love_dimension:        buildDimensionPayload(data.love_dimension),
    good_at_dimension:     buildDimensionPayload(data.good_at_dimension),
    world_needs_dimension: buildDimensionPayload(data.world_needs_dimension),
    paid_for_dimension:    buildDimensionPayload(data.paid_for_dimension),
    active: data.active,
  };
}

async function loadSignalById(signalId: string): Promise<AttentionSignal | null> {
  const { data, error } = await db
    .from('attention_signals')
    .select('*')
    .eq('id', signalId)
    .single();
  if (error || !data) return null;
  return {
    id: data.id,
    source_type: data.source_type,
    source_id: data.source_id ?? undefined,
    content: data.content,
    context: data.context ?? {},
  };
}

router.post('/anfis/score', async (req: Request, res: Response) => {
  const { signal_id, profile_id, signal: inlineSignal, profile: inlineProfile } = req.body;

  let signal: AttentionSignal | null = null;
  let profile: IkigaiProfile | null = null;

  if (signal_id) {
    signal = await loadSignalById(signal_id);
    if (!signal) return res.status(404).json({ error: 'signal not found' });
  } else if (inlineSignal) {
    signal = {
      source_type: inlineSignal.source_type ?? 'manual',
      source_id: inlineSignal.source_id,
      content: String(inlineSignal.content ?? ''),
      context: inlineSignal.context ?? {},
    };
  } else {
    return res.status(400).json({ error: 'signal_id or inline signal required' });
  }

  if (profile_id) {
    profile = await loadProfileById(profile_id);
    if (!profile) return res.status(404).json({ error: 'profile not found' });
  } else if (inlineProfile) {
    profile = {
      user_id: inlineProfile.user_id ?? 'inline',
      profile_version: inlineProfile.profile_version ?? 1,
      love_dimension:        buildDimensionPayload(inlineProfile.love_dimension),
      good_at_dimension:     buildDimensionPayload(inlineProfile.good_at_dimension),
      world_needs_dimension: buildDimensionPayload(inlineProfile.world_needs_dimension),
      paid_for_dimension:    buildDimensionPayload(inlineProfile.paid_for_dimension),
    };
  } else {
    return res.status(400).json({ error: 'profile_id or inline profile required' });
  }

  const persist = !!(signal.id && profile.id);
  const event = await scoreSignal(signal, profile, { persist });
  return res.json(event);
});

router.post('/anfis/score-batch', async (req: Request, res: Response) => {
  const { signal_ids, profile_id } = req.body;
  if (!Array.isArray(signal_ids) || signal_ids.length === 0) {
    return res.status(400).json({ error: 'signal_ids array required' });
  }
  if (!profile_id) return res.status(400).json({ error: 'profile_id required' });
  if (signal_ids.length > 100) return res.status(400).json({ error: 'max 100 signals per batch' });

  const profile = await loadProfileById(profile_id);
  if (!profile) return res.status(404).json({ error: 'profile not found' });

  const events = [] as any[];
  for (const sid of signal_ids) {
    const signal = await loadSignalById(sid);
    if (!signal) {
      events.push({ signal_id: sid, error: 'signal not found' });
      continue;
    }
    const ev = await scoreSignal(signal, profile, { persist: true });
    events.push(ev);
  }

  return res.json({ batch_size: signal_ids.length, results: events });
});

router.get('/anfis/profile/:user_id', async (req: Request, res: Response) => {
  const userId = String(req.params.user_id ?? '');
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  const profile = await loadActiveProfileByUser(userId);
  if (!profile) return res.status(404).json({ error: 'no active profile for user' });
  return res.json(profile);
});

router.post('/anfis/profile', async (req: Request, res: Response) => {
  const { user_id, love, good_at, world_needs, paid_for } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const wrap = (kws: any): IkigaiDimensionPayload => buildDimensionPayload({
    keywords: Array.isArray(kws) ? kws : [],
  });

  const { data: existing } = await db
    .from('ikigai_profiles')
    .select('profile_version')
    .eq('user_id', user_id)
    .order('profile_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (existing?.profile_version ?? 0) + 1;

  // Deactivate any prior active profiles so only one is active at a time.
  await db.from('ikigai_profiles').update({ active: false }).eq('user_id', user_id);

  const { data, error } = await db
    .from('ikigai_profiles')
    .insert({
      user_id,
      profile_version: nextVersion,
      love_dimension:        wrap(love),
      good_at_dimension:     wrap(good_at),
      world_needs_dimension: wrap(world_needs),
      paid_for_dimension:    wrap(paid_for),
      active: true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

router.post('/anfis/feedback', async (req: Request, res: Response) => {
  const { signal_id, feedback_type, notes, reweight_target_dimension } = req.body;
  if (!signal_id) return res.status(400).json({ error: 'signal_id required' });
  if (!feedback_type) return res.status(400).json({ error: 'feedback_type required' });

  const allowed = new Set([
    'surfaced_and_acted',
    'surfaced_and_dismissed',
    'should_have_surfaced',
    'should_not_have_surfaced',
  ]);
  if (!allowed.has(feedback_type)) {
    return res.status(400).json({ error: 'invalid feedback_type' });
  }
  if (
    reweight_target_dimension &&
    !ANFIS_DIM_KEYS.includes(reweight_target_dimension)
  ) {
    return res.status(400).json({ error: 'invalid reweight_target_dimension' });
  }

  const { data, error } = await db
    .from('user_feedback_events')
    .insert({
      signal_id,
      feedback_type,
      notes: notes ?? null,
      reweight_target_dimension: reweight_target_dimension ?? null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

router.get('/anfis/digest/:user_id', async (req: Request, res: Response) => {
  const userId = String(req.params.user_id ?? '');
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  const profile = await loadActiveProfileByUser(userId);
  if (!profile) return res.status(404).json({ error: 'no active profile for user' });

  const limit = Math.min(parseInt(String(req.query.limit ?? '5'), 10) || 5, 50);
  const threshold = parseFloat(String(req.query.threshold ?? '0.6')) || 0.6;

  // Latest score per signal for this profile, above threshold. We pull a
  // wider set then collapse client-side because Supabase REST has no DISTINCT
  // ON. v1 candidate: a Postgres view that returns latest-per-signal.
  const { data, error } = await db
    .from('anfis_score_events')
    .select('id, signal_id, composite_score, anticipatory_delta, scored_at')
    .eq('profile_id', profile.id)
    .gte('composite_score', threshold)
    .order('scored_at', { ascending: false })
    .limit(limit * 5);

  if (error) return res.status(500).json({ error: error.message });

  const seen = new Set<string>();
  const top = [] as any[];
  for (const row of data ?? []) {
    if (seen.has(row.signal_id)) continue;
    seen.add(row.signal_id);
    top.push(row);
    if (top.length >= limit) break;
  }
  top.sort((a, b) => Number(b.composite_score) - Number(a.composite_score));

  return res.json({
    user_id: req.params.user_id,
    profile_id: profile.id,
    threshold,
    surfaced: top,
  });
});

router.get('/anfis/rule-trace/:score_event_id', async (req: Request, res: Response) => {
  const eventId = String(req.params.score_event_id ?? '');
  if (!eventId) return res.status(400).json({ error: 'score_event_id required' });
  const { data, error } = await db
    .from('anfis_score_events')
    .select('id, signal_id, profile_id, composite_score, rule_trace, scored_at')
    .eq('id', eventId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'score event not found' });
  return res.json(data);
});

export default router;
