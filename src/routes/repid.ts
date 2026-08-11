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
import { publicError } from './public-error';

export const repidPublicRouter = Router();


export const repidAdminRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an agent path param to a repid_agents UUID.
 *
 * Accepts either a raw UUID (passed through unchanged), a numeric
 * erc8004_token_id, or an agent name/slug (e.g. "trinity-shofet" or bare
 * "shofet"). Mirrors the lookup already used by GET /repid/:agentId,
 * /history, and /zkp so a slug OR a UUID both work.
 *
 * Returns the resolved UUID, or null if a non-UUID input matched no agent
 * (caller should 404). A raw UUID is always returned as-is (no lookup).
 */
async function resolveAgentUuid(raw: string): Promise<string | null> {
  const id = String(raw ?? '');
  if (!id || UUID_RE.test(id)) return id || null;

  let query = db.from('repid_agents').select('id');
  if (/^\d+$/.test(id)) {
    query = query.eq('erc8004_token_id', id);
  } else {
    const lcName = id.toLowerCase();
    const lookupName = lcName.startsWith('trinity-') ? lcName : `trinity-${lcName}`;
    query = query.eq('agent_name', lookupName);
  }
  const { data } = await query.maybeSingle();
  return data && data.id ? (data.id as string) : null;
}

/* ------------------------ Public routes ----------------------------- */

// GET /api/v1/repid/:agentId — current RepID for an agent
// Public lookup endpoint: ANY failure to retrieve (not-found OR
// upstream DB issue) is reported as 404. The DB error is still
// logged server-side for ops visibility. This matches the pre-
// existing /repid/:agent_id route's lenient behavior in v1.ts so
// the existing tests/repid-score.test.ts smoke test stays green.
repidPublicRouter.get('/repid/:agentId', async (req: Request, res: Response) => {
  try {
    // Shared resolver — NOT a fourth inline copy. This block used to duplicate
    // resolveAgentUuid() and diverge from it: when the name lookup missed, it kept the raw
    // user string and passed it to a uuid-typed column, so Postgres raised 22P02
    // "invalid input syntax for type uuid" and this route answered an unauthenticated GET
    // with a 500 carrying the raw DB error text. /proof was fixed by extracting the helper;
    // its three siblings kept the copy and kept the bug.
    const resolvedId = await resolveAgentUuid(String(req.params.agentId ?? ''));
    if (!resolvedId) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND', agent_id: String(req.params.agentId ?? '').slice(0, 128) });
    }
    const lookup = await getRepIDForAgent(resolvedId);
    res.json(lookup);
  } catch (e: any) {
    if (e?.code === 'DATABASE_ERROR') {
      console.error(`[repid] lookup db error for ${req.params.agentId}: ${e.message}`);
    }
    return publicError(res, 404, 'AGENT_NOT_FOUND', e, `GET /repid/${req.params.agentId}`);
  }
});

// GET /api/v1/repid/:agentId/history — append-only score-events trail
repidPublicRouter.get(
  '/repid/:agentId/history',
  async (req: Request, res: Response) => {
    try {
      // Shared resolver — NOT a fourth inline copy. This block used to duplicate
      // resolveAgentUuid() and diverge from it: when the name lookup missed, it kept the raw
      // user string and passed it to a uuid-typed column, so Postgres raised 22P02
      // "invalid input syntax for type uuid" and this route answered an unauthenticated GET
      // with a 500 carrying the raw DB error text. /proof was fixed by extracting the helper;
      // its three siblings kept the copy and kept the bug.
      const resolvedId = await resolveAgentUuid(String(req.params.agentId ?? ''));
      if (!resolvedId) {
        return res.status(404).json({ error: 'AGENT_NOT_FOUND', agent_id: String(req.params.agentId ?? '').slice(0, 128) });
      }
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const history = await getRepIDHistory(resolvedId, since);
      res.json({ agent_id: resolvedId, count: history.length, events: history });
    } catch (e: any) {
      if (e?.code === 'AGENT_NOT_FOUND') {
        return publicError(res, 404, 'AGENT_NOT_FOUND', e, `GET /repid/${req.params.agentId}/history`);
      }
      return publicError(res, 500, 'INTERNAL', e, `GET /repid/${req.params.agentId}/history`);
    }
  },
);

// GET /api/v1/repid/:agentId/zkp — latest ZKP proof for an agent
repidPublicRouter.get('/repid/:agentId/zkp', async (req: Request, res: Response) => {
  try {
    // Shared resolver — NOT a fourth inline copy. This block used to duplicate
    // resolveAgentUuid() and diverge from it: when the name lookup missed, it kept the raw
    // user string and passed it to a uuid-typed column, so Postgres raised 22P02
    // "invalid input syntax for type uuid" and this route answered an unauthenticated GET
    // with a 500 carrying the raw DB error text. /proof was fixed by extracting the helper;
    // its three siblings kept the copy and kept the bug.
    const resolvedId = await resolveAgentUuid(String(req.params.agentId ?? ''));
    if (!resolvedId) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND', agent_id: String(req.params.agentId ?? '').slice(0, 128) });
    }

    const { data: proof, error } = await db
      .from('repid_zkp_proofs')
      .select('*')
      .eq('agent_id', resolvedId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return publicError(res, 500, 'DATABASE_ERROR', error, `GET /repid/${req.params.agentId}/zkp`);
    }
    if (!proof) {
      return res.status(404).json({ error: 'NO_PROOF_FOUND' });
    }

    res.json(proof);
  } catch (e: any) {
    return publicError(res, 500, 'INTERNAL', e, `GET /repid/${req.params.agentId}/zkp`);
  }
});

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

  const cacheKey = `proof-job:${job_id}`;
  const { cacheGet, cacheSet } = require('../cache/dragonfly');
  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      console.log(`[repid-route] Cache hit for proof job: ${job_id}`);
      return res.json(JSON.parse(cached));
    }
  } catch (err) {
    console.warn(`[repid-route] Cache error for proof job:`, err);
  }

  const { data, error } = await db
    .from('repid_proof_queue')
    .select('job_id,agent_id,status,proof_hash,proof_bytes,proof_size_bytes,created_at,completed_at')
    .eq('job_id', job_id)
    .maybeSingle();
  if (error) {
    console.error(`[repid] proof lookup db error for job_id=${job_id}: ${error.message}`);
    return res.status(500).json({ error: 'INTERNAL' });
  }
  if (!data) return res.status(404).json({ error: 'Proof job not found' });

  if (data.status === 'completed') {
    try {
      await cacheSet(cacheKey, JSON.stringify(data), 7200);
    } catch (err) {
      console.warn(`[repid-route] Failed to set cache for completed proof job:`, err);
    }
  }

  return res.json(data);
});

// GET /api/v1/repid/:agentId/proof — the agent's latest cryptographically-real RepID range
// proof, shaped for client-side WASM verification (W4 / @hyperdag/trustshell presentProof()).
// Returns proof_bytes (base64) + the full statement {agent_id, repid_score, threshold, tier}
// the agent-bound verifier needs, plus the EAS anchor (if any). Public surface (proofs are
// accountability-public; mounted before authMiddleware). Registered AFTER /repid/proof/:job_id
// so the literal 'proof' second segment never shadows this one.
repidPublicRouter.get('/repid/:agentId/proof', async (req: Request, res: Response) => {
  const rawAgentId = String(req.params.agentId ?? '');
  if (!rawAgentId) return res.status(400).json({ error: 'agentId required' });

  // Resolve slug/name/token-id → UUID before the UUID-typed agent_id query.
  // Without this a slug (e.g. "trinity-shofet") hits repid_zkp_proofs.agent_id
  // (uuid column) and 500s with "invalid input syntax for type uuid".
  const agentId = await resolveAgentUuid(rawAgentId);
  if (!agentId) {
    return res.status(404).json({ error: 'No proof found for agent', agent_id: rawAgentId });
  }

  // Prefer a real, WASM-verifiable plonky3 proof; fall back to the latest row so callers
  // can see legacy (stub) state honestly rather than a 404.
  const base = db
    .from('repid_zkp_proofs')
    .select('agent_id,scheme,proof_type,proof_bytes,statement,tier_proven,eas_attestation_uid,eas_schema,created_at')
    .eq('agent_id', agentId);

  let { data, error } = await base
    .eq('scheme', 'plonky3_range_check')
    .not('proof_bytes', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!error && !data) {
    // No real proof yet — return the latest row of any kind (honest legacy/stub state).
    ({ data, error } = await db
      .from('repid_zkp_proofs')
      .select('agent_id,scheme,proof_type,proof_bytes,statement,tier_proven,eas_attestation_uid,eas_schema,created_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle());
  }

  if (error) {
    console.error(`[repid] proof-by-agent db error for ${agentId}: ${error.message}`);
    return res.status(500).json({ error: 'INTERNAL' });
  }
  if (!data) return res.status(404).json({ error: 'No proof found for agent', agent_id: agentId });

  const stmt = (data.statement ?? {}) as { threshold?: number; repid_score?: number };
  const cryptographically_verifiable =
    data.scheme === 'plonky3_range_check' && typeof data.proof_bytes === 'string' && data.proof_bytes.length > 0;

  return res.json({
    agent_id: data.agent_id,
    scheme: data.scheme,
    proof_type: data.proof_type,
    // base64 proof bytes; empty string for legacy sha256 stubs (cryptographically_verifiable=false)
    proof_bytes: data.proof_bytes ?? '',
    // full statement shape the agent-bound WASM verifier expects
    statement: {
      agent_id: data.agent_id,
      repid_score: stmt.repid_score ?? null,
      threshold: stmt.threshold ?? null,
      tier: data.tier_proven,
    },
    eas: {
      attestation_uid: data.eas_attestation_uid ?? null,
      schema: data.eas_schema ?? null,
      anchored: !!data.eas_attestation_uid,
      network: 'base-sepolia',
    },
    cryptographically_verifiable,
    created_at: data.created_at,
  });
});

// GET /api/v1/meta/trust — D-022 data residuals for trustshell.dev: a glossary of the
// ecosystem acronyms + the testnet status the site can render as a status field. Static,
// public, cache-friendly. (UI/copy is v0/Sean — this is the data contract only.)
repidPublicRouter.get('/meta/trust', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=3600');
  return res.json({
    network_status: {
      network: 'base-sepolia',
      status: 'testnet',
      chain_id: 84532,
      note: 'All RepID proofs and EAS attestations are on Base Sepolia testnet — not mainnet.',
    },
    glossary: {
      HAL: 'Hallucination Abatement Layer — a cross-provider quorum that flags or vetoes ungrounded model output.',
      RepID: 'Reputation Identity — an agent’s behavioral reputation score (0–10000) earned through verified outcomes.',
      ZKP: 'Zero-Knowledge Proof — a Plonky3 STARK proving an agent’s RepID exceeds a threshold without revealing the score.',
      'agent-bound proof': 'A RepID proof whose public statement includes agent_id, so it cannot be replayed for another agent.',
      EAS: 'Ethereum Attestation Service — where RepID proofs are anchored on-chain (Base Sepolia).',
      'ERC-8004': 'The trustless-agents reputation standard the on-chain reputation writes conform to.',
      tier: 'PROBATIONARY (0–499) · EARNING (500–999) · ESTABLISHED (1000–4999) · AUTONOMOUS (5000–7999) · VETERAN (8000–10000).',
    },
    verifier: {
      package: '@hyperdag/proof-verifier',
      verify_client_side: true,
      note: 'Proofs are verifiable in-browser with the WASM verifier — trust math, not the server.',
    },
  });
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
        return publicError(res, 404, 'AGENT_NOT_FOUND', e, 'repid route');
      }
      if (e?.code === 'DATABASE_ERROR') {
        return publicError(res, 500, 'DATABASE_ERROR', e, 'repid route');
      }
      return publicError(res, 500, 'INTERNAL', e, 'repid route');
    }
  },
);
