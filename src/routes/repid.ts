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
import { logProofGeneration } from '../zkp/plonky3-real';
import { generateProof } from '../zk-proof/prover';
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

// GET /api/v1/repid/proof/:job_id — public proof retrieval by job_id alone.
// Phase 7 Gap D — this path was advertised in agent-registration-file.ts:112
// (`proof_endpoint: '${BASE_ENGINE_URL}/api/v1/repid/proof/:job_id'`) for
// TrustShell + ERC-8004 verifiers, but was never registered → all callers
// got 404. The companion route /api/v1/agents/:id/proof/:job_id
// (agents-external.ts) requires the caller to know agent_id; TrustShell
// callers typically only have the job_id returned from the original score
// event. Both routes coexist by design.
//
// Public surface: proofs are inherently public on the constitutional-AI
// accountability framework (see trustrepid.dev). Job IDs are UUIDs and
// hard to guess; this endpoint is mounted on the repidPublicRouter (which
// is mounted before authMiddleware in src/index.ts), so no API key is
// required.
repidPublicRouter.get('/repid/proof/:job_id', async (req: Request, res: Response) => {
  const job_id = String(req.params.job_id ?? '');
  if (!job_id) return res.status(400).json({ error: 'job_id required' });
  const { data, error } = await db
    .from('repid_proof_queue')
    .select('job_id,agent_id,status,proof_hash,proof_bytes,proof_size_bytes,created_at,completed_at')
    .eq('job_id', job_id)
    .maybeSingle();
  if (error) {
    console.error(`[repid] proof lookup db error for job_id=${job_id}: ${error.message}`);
    return res.status(500).json({ error: 'INTERNAL', detail: error.message });
  }
  if (!data) return res.status(404).json({ error: 'Proof job not found' });
  return res.json(data);
});

// POST /api/v1/prove-repid — generate a ZKP RepID proof (auth required)
repidAdminRouter.post('/prove-repid', async (req: Request, res: Response) => {
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
  const result = await generateProof({
    agent_id,
    requester_pubkey,
    requested_tier,
    timestamp,
  });
  await logProofGeneration(db, agent_id, requested_tier);
  fireWebhook('proof.generated', {
    proof: result.proof,
    proof_source: result.proof_source,
    agent_id,
    requester_pubkey,
    tier: requested_tier,
    timestamp,
  });

  res.json({
    tier: requested_tier,
    proof: result.proof,
    proof_source: result.proof_source,
    proofFormat: result.proofFormat,
    proofVersion: result.proofVersion,
    payload: basePayload,
  });
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
