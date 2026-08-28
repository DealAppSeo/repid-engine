/**
 * Sprint A7 — standalone score-event endpoint.
 *
 * POST /api/v1/agents-external/:id/score-event
 *
 * Wraps src/scoring/pipeline.ts:runScoreEvent for callers that already
 * have an LLM answer and want to score it without going through /complete
 * (e.g. importing historical decisions, re-scoring after threshold tuning).
 *
 * AUTH — this is Sprint A8, the hardening the line above used to promise.
 *
 * It previously read: "rate-limited 60/IP/min only. No API-key requirement for
 * v1 alpha … Sprint A8 will harden auth." That was a deliberate alpha decision,
 * not an oversight — but it meant ANYONE holding an agent's UUID could attribute
 * HAL-scored decisions to it, and an agent UUID is not a secret: it appears in
 * passport URLs and public reads. MEASURED on production 2026-08-28:
 *
 *     POST /api/v1/agents-external/<uuid>/score-event  -> HTTP 400   (no auth; reached the handler)
 *     POST /api/v1/agents/<uuid>/score-event           -> HTTP 401   (correctly gated)
 *
 * Two doors to the scoring path, one of them unlocked. RepID's entire claim is
 * that a score is EARNED; a score anyone can write into is not.
 *
 * So this route now requires the same credential the sibling route has always
 * required — `requireApiKey(['score_event'])` plus an agent_id ownership check,
 * the exact primitive from src/routes/agents-external.ts rather than a second
 * implementation that could disagree with it.
 *
 * WHY AN ESCAPE HATCH, AND WHY IT DEFAULTS TO SECURE. The route's stated
 * purpose includes batch uses — "importing historical decisions, re-scoring
 * after threshold tuning" — that may run without a per-agent key. Setting
 * SCORE_EVENT_PUBLIC_ALPHA=true restores the open behaviour exactly, so a
 * caller this breaks is one env var from working again. It defaults to SECURE
 * because a security control that ships default-off is theatre: the failure
 * direction has to be "the batch job 401s and someone notices", never "anyone
 * can write reputation and nobody does".
 *
 * BLAST RADIUS, measured before changing it: ~3 score events/day across ALL
 * paths; no caller in trustshell, and none in this repo outside
 * scripts/production-smoke.ts (which already accepts 400/404 alongside 200).
 *
 * Distinct from the existing POST /api/v1/agents/:id/score-event (in
 * src/routes/agents-external.ts) which runs the legacy v11 reward pipeline
 * with per-agent bearer auth — that route is preserved unchanged.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { runScoreEvent, NotFoundError } from '../scoring/pipeline';
import { requireApiKey } from '../middleware/auth-api-key';

const router = Router();

/** True only for the exact string 'true' — a typo must never silently open the route. */
export function scoreEventPublicAlpha(): boolean {
  return process.env.SCORE_EVENT_PUBLIC_ALPHA === 'true';
}

/**
 * Require a scoped key AND that the key belongs to the agent being scored.
 *
 * The scope check alone is not enough: any agent's `score_event` key would
 * otherwise be able to write events onto any OTHER agent. Ownership is what
 * makes the score earned rather than merely authenticated.
 */
function requireOwnedAgent(req: Request, res: Response, next: NextFunction): void {
  if ((req as any).agent_id !== String(req.params.id)) {
    res.status(403).json({ error: 'API key agent_id mismatch' });
    return;
  }
  next();
}

/**
 * Resolved at REQUEST time, not module load, so a deployment can flip the flag
 * without a restart and so tests can drive both branches in one process.
 */
const scoreEventAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (scoreEventPublicAlpha()) return next();
  void requireApiKey(['score_event'])(req, res, () => requireOwnedAgent(req, res, next));
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/:id/score-event', scoreEventAuth, async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  if (!UUID_RE.test(agentId)) {
    return res.status(400).json({ error: 'invalid agent id (expected UUID)' });
  }

  const {
    prompt,
    answer,
    llm_call_id,
    provider_used,
    tier_used,
    model_used,
    task_domain,
    certainty,
    idempotency_key,
  } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof prompt !== 'string' || prompt.length === 0) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (typeof answer !== 'string' || answer.length === 0) {
    return res.status(400).json({ error: 'answer is required' });
  }

  try {
    const result = await runScoreEvent({
      agent_id: agentId,
      prompt,
      answer,
      provider_used: typeof provider_used === 'string' ? provider_used : undefined,
      tier_used: typeof tier_used === 'string' ? tier_used : undefined,
      model_used: typeof model_used === 'string' ? model_used : undefined,
      llm_call_id: typeof llm_call_id === 'string' ? llm_call_id : undefined,
      task_domain: typeof task_domain === 'string' ? task_domain : undefined,
      certainty: typeof certainty === 'number' ? certainty : undefined,
      idempotency_key: typeof idempotency_key === 'string' ? idempotency_key : undefined,
    });

    return res.json({
      score_event_id: result.score_event_id,
      hal_score: result.hal_score,
      hal_decision: result.hal_decision,
      repid_delta: result.repid_delta_applied,
      repid_delta_calculated: result.repid_delta_calculated,
      old_repid: result.old_repid,
      new_repid: result.new_repid,
      zk_proof_triggered: result.zk_proof_triggered,
      zk_proof_id: result.zk_proof_id,
      reason: result.reason,
      idempotent_replay: result.idempotent_replay ?? false,
    });
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
});

export default router;
