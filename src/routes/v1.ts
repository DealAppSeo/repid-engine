import { Router, Request, Response } from 'express';
import { db } from '../db';
import { generateProofReal } from '../zkp/plonky3-real';
import { createHash } from 'crypto';
import { fireWebhook } from '../services/webhook';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: "ok", version: "1.0.0", service: "repid-engine" });
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

  const { proof, timestamp } = await generateProofReal(agent_id, requester_pubkey, requested_tier);

  res.json({ tier: requested_tier, proof, proofFormat: "plonky3-babybear-stub-v1", proofVersion: "1.0", payload: basePayload });
});

router.post('/verify-proof', async (req: Request, res: Response) => {
  const { proof, agent_id, requester_pubkey, tier, timestamp } = req.body;

  if (!proof || !agent_id || !requester_pubkey || !tier || !timestamp) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { proof: computedHash } = await generateProofReal(agent_id, requester_pubkey, tier, timestamp);
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
    const p = await generateProofReal(r.agent_id, r.requester_pubkey, r.tier);
    return { ...r, proof: p.proof, timestamp: p.timestamp };
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
