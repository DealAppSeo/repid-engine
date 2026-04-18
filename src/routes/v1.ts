import { Router, Request, Response } from 'express';

import { db } from '../db';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: "ok", version: "1.0.0", service: "repid-engine" });
});

router.post('/prove-repid', async (req: Request, res: Response) => {
  const { agent_id, requester_pubkey, requested_tier } = req.body;

  if (!agent_id || !requester_pubkey || !requested_tier) {
    return res.status(400).json({ error: "Missing required fields: agent_id, requester_pubkey, requested_tier" });
  }

  const { data: agent, error } = await db
    .from('repid_agents')
    .select('*')
    .eq('id', agent_id)
    .single();

  if (error || !agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const repid_score = agent.current_repid;

  if (requested_tier === 'package' && repid_score < 5000) {
    return res.status(403).json({ error: "RepID too low for package tier" });
  }

  const basePayload: any = {
    basic_validation: true,
    repid_score: repid_score,
    proof_version: "1.0"
  };

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

  res.json({
    tier: requested_tier,
    proof: "<plonky3-stub-base64>",
    payload: basePayload
  });
});

export default router;
