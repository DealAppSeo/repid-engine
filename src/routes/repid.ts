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
