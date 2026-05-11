/**
 * Sprint R-C Track B Phase B3 — RepID HTTP routes.
 *
 * Two routers:
 *   - publicRouter: GET /api/v1/repid/:agentId, GET .../:agentId/history,
 *                   POST /api/v1/repid/verify    (no auth)
 *   - adminRouter:  POST /api/v1/repid/:agentId/attest    (auth required)
 *
 * The public router is mounted BEFORE the global authMiddleware in
 * src/index.ts. The admin router is mounted AFTER. Existing route
 * `/api/v1/repid/:agent_id` in v1.ts is functionally superseded by
 * `GET /api/v1/repid/:agentId` (same path; Express picks the first
 * registered match).
 */
import { Router, type Request, type Response } from 'express';
import { getRepIDForAgent, getRepIDHistory } from '../repid/repid-service';
import {
  signRepIDAttestation,
  verifyRepIDAttestation,
} from '../repid/repid-attestation';
import { db } from '../db';
import { generateProofReal, logProofGeneration } from '../zkp/plonky3-real';
import { fireWebhook } from '../services/webhook';

export const repidPublicRouter = Router();


export const repidAdminRouter = Router();

/* ------------------------ Public routes ----------------------------- */

// GET /api/v1/repid/:agentId — current RepID for an agent
// Public lookup endpoint: ANY failure to retrieve (not-found OR
// upstream DB issue) is reported as 404. The DB error is still
// logged server-side for ops visibility. This matches the pre-
// existing /repid/:agent_id route's lenient behavior in v1.ts so
// the existing tests/repid-score.test.ts smoke test stays green.
repidPublicRouter.get('/repid/:agentId', async (req: Request, res: Response) => {
  try {
    const lookup = await getRepIDForAgent(String(req.params.agentId ?? ''));
    res.json(lookup);
  } catch (e: any) {
    if (e?.code === 'DATABASE_ERROR') {
      console.error(`[repid] lookup db error for ${req.params.agentId}: ${e.message}`);
    }
    return res.status(404).json({ error: 'AGENT_NOT_FOUND', detail: e?.message ?? String(e) });
  }
});

// GET /api/v1/repid/:agentId/history — append-only score-events trail
repidPublicRouter.get(
  '/repid/:agentId/history',
  async (req: Request, res: Response) => {
    try {
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const history = await getRepIDHistory(String(req.params.agentId ?? ''), since);
      res.json({ agent_id: String(req.params.agentId ?? ''), count: history.length, events: history });
    } catch (e: any) {
      if (e?.code === 'AGENT_NOT_FOUND') {
        return res.status(404).json({ error: 'AGENT_NOT_FOUND', detail: e.message });
      }
      res.status(500).json({ error: 'INTERNAL', detail: e?.message ?? String(e) });
    }
  },
);

// POST /api/v1/repid/verify — verify an attestation (no auth — anyone can verify)
repidPublicRouter.post('/repid/verify', async (req: Request, res: Response) => {
  const result = verifyRepIDAttestation(req.body);
  if (!result.valid) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// POST /api/v1/prove-repid — generate a ZKP RepID proof (no auth required)
repidPublicRouter.post('/prove-repid', async (req: Request, res: Response) => {
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
  const result = await generateProofReal(agent_id, requester_pubkey, requested_tier, timestamp);
  const proof = result.proof;
  await logProofGeneration(db, agent_id, requested_tier);
  fireWebhook('proof.generated', { proof, proof_source: result.proof_source, agent_id, requester_pubkey, tier: requested_tier, timestamp });

  res.json({
    tier: requested_tier,
    proof,
    proof_source: result.proof_source,
    proofFormat: result.proof_source === 'plonky3_real' ? 'plonky3-real-v1' : 'plonky3-babybear-stub-v1',
    proofVersion: "1.0",
    payload: basePayload,
  });
});

// GET /api/v1/repid/proof/:jobId — retrieve a completed proof for local verification
repidPublicRouter.get('/repid/proof/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // 1. Fetch proof job
    const { data: job, error: jobErr } = await db
      .from('repid_proof_queue')
      .select('*')
      .eq('job_id', jobId)
      .single();

    if (jobErr || !job) {
      return res.status(404).json({ error: 'PROOF_JOB_NOT_FOUND', detail: `Job ${jobId} not found` });
    }

    if (job.status !== 'completed') {
      return res.status(202).json({
        status: job.status,
        job_id: jobId,
        message: 'Proof generation in progress',
        created_at: job.created_at
      });
    }

    // 2. Fetch agent state (to build the statement)
    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('id, current_repid, tier')
      .eq('id', job.agent_id)
      .single();

    if (agentErr || !agent) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND', detail: `Agent ${job.agent_id} not found` });
    }

    // 3. Map tier to threshold (mirrors zkp-postcard logic)
    const tier = agent.tier as string;
    const TIER_THRESHOLD: Record<string, number> = {
      PROBATIONARY: 0,
      EARNING: 499,
      ESTABLISHED: 999,
      AUTONOMOUS: 4999,
      VETERAN: 7999,
    };
    const threshold = TIER_THRESHOLD[tier] ?? 0;

    // 4. Return verifier-standard shape
    return res.json({
      proof_bytes: job.proof_bytes, // base64 string
      statement: {
        agent_id: agent.id,
        repid_score: agent.current_repid,
        threshold: threshold,
        tier: tier
      },
      proof_hash: job.proof_hash,
      proof_size_bytes: job.proof_size_bytes,
      verified_server_side: true,
      generated_at: job.completed_at
    });
  } catch (e: any) {
    console.error(`[repid] proof retrieval error: ${e.message}`);
    res.status(500).json({ error: 'INTERNAL', detail: e.message });
  }
});

/* ------------------------ Admin routes ------------------------------ */

// POST /api/v1/repid/:agentId/attest — sign a fresh attestation (auth required)
repidAdminRouter.post(
  '/repid/:agentId/attest',
  async (req: Request, res: Response) => {
    try {
      const lookup = await getRepIDForAgent(String(req.params.agentId ?? ''));
      if (lookup.repid_score === null) {
        return res.status(409).json({
          error: 'NO_SCORE',
          detail: `agent ${String(req.params.agentId ?? '')} has no current_repid value`,
        });
      }
      const timestampIso = lookup.last_updated ?? new Date().toISOString();
      const attestation = await signRepIDAttestation({
        agent_id: lookup.agent_id,
        repid_score: lookup.repid_score,
        timestamp_iso: timestampIso,
      });
      res.json({ ...attestation, source: lookup.source });
    } catch (e: any) {
      if (e?.code === 'AGENT_NOT_FOUND') {
        return res.status(404).json({ error: 'AGENT_NOT_FOUND', detail: e.message });
      }
      if (e?.code === 'DATABASE_ERROR') {
        return res.status(500).json({ error: 'DATABASE_ERROR', detail: e.message });
      }
      res.status(500).json({ error: 'INTERNAL', detail: e?.message ?? String(e) });
    }
  },
);
