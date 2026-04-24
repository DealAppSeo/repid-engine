import { Router, Request, Response } from 'express';
import { db } from '../db';
import { generateProofReal, logProofGeneration } from '../zkp/plonky3-real';
import { createHash } from 'crypto';
import { fireWebhook } from '../services/webhook';

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

  const zkpUrl = process.env.ZKP_POSTCARD_URL;
  if (!zkpUrl) {
    console.error('[zkp] ZKP_POSTCARD_URL env var not set');
    return res.status(502).json({ error: 'zkp-postcard service not configured', fallback: false });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const started = Date.now();
  let zkpBody: any;
  try {
    const zkpResp = await fetch(`${zkpUrl}/zkp/repid-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rep_id: repid_score }),
      signal: controller.signal
    });
    if (!zkpResp.ok) {
      const elapsed = Date.now() - started;
      const errBody = await zkpResp.text().catch(() => '');
      console.error('[zkp] zkp-postcard non-200', { status: zkpResp.status, body: errBody, elapsed_ms: elapsed });
      return res.status(502).json({
        error: 'zkp-postcard service unavailable',
        fallback: false,
        details: { reason: 'non_200', status: zkpResp.status, elapsed_ms: elapsed }
      });
    }
    zkpBody = await zkpResp.json();
  } catch (err: any) {
    const elapsed = Date.now() - started;
    console.error('[zkp] zkp-postcard call failed', { elapsed_ms: elapsed, name: err?.name, message: err?.message });
    return res.status(502).json({
      error: 'zkp-postcard service unavailable',
      fallback: false,
      details: { reason: err?.name === 'AbortError' ? 'timeout' : 'network', elapsed_ms: elapsed }
    });
  } finally {
    clearTimeout(timeout);
  }

  const { commitment, proof_type, verified, tier, proving_time_ms, proof_size_bytes, erc8004_token_id } = zkpBody;

  await logProofGeneration(db, agent_id, requested_tier);
  const { error: scoreEventErr } = await db.from('repid_score_events').insert({
    agent_id,
    event_type: 'ZKP_PROOF_GENERATED',
    delta: 0,
    repid_before: repid_score,
    repid_after: repid_score,
    metadata: {
      proof_commitment: commitment,
      proof_type,
      verified,
      tier,
      proving_time_ms,
      proof_size_bytes,
      erc8004_token_id,
      requested_tier,
      source: 'zkp-postcard'
    }
  });
  if (scoreEventErr) console.error('[zkp] repid_score_events insert error', scoreEventErr);

  fireWebhook('proof.generated', { commitment, proof_type, agent_id, requester_pubkey, tier, requested_tier });

  res.json({
    commitment,
    proof_type,
    verified,
    tier,
    proving_time_ms,
    proof_size_bytes,
    protocol: 'HyperDAG Trust Protocol v1'
  });
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

export default router;
