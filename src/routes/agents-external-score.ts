/**
 * Sprint A7 — standalone score-event endpoint.
 *
 * POST /api/v1/agents-external/:id/score-event
 *
 * Wraps src/scoring/pipeline.ts:runScoreEvent for callers that already
 * have an LLM answer and want to score it without going through /complete
 * (e.g. importing historical decisions, re-scoring after threshold tuning).
 *
 * Auth: rate-limited 60/IP/min only. No API-key requirement for v1 alpha
 * (matches the public /agents/register pattern). Sprint A8 will harden auth.
 *
 * Distinct from the existing POST /api/v1/agents/:id/score-event (in
 * src/routes/agents-external.ts) which runs the legacy v11 reward pipeline
 * with per-agent bearer auth — that route is preserved unchanged.
 */

import { Router, Request, Response } from 'express';
import { runScoreEvent, NotFoundError } from '../scoring/pipeline';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/:id/score-event', async (req: Request, res: Response) => {
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
