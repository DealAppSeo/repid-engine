/**
 * ratings.ts — TrustMarket rating ingestion API.
 *
 * POST /api/v1/ratings          submit a rating (admitted only if anchored to a
 *                               real, gate-authorized outcome the rater is party to)
 * GET  /api/v1/ratings/:agentId stage-weighted rating summary (public, keyless)
 *
 * The admission decision lives in ../../services/rating-ingestion (pure + tested).
 * This router is the thin I/O layer: it resolves the outcome SERVER-SIDE (the
 * rater never asserts the outcome's truth) and persists admitted rows.
 *
 * Data dependency: an outcome is looked up from `repid_outcomes` (gate decision +
 * committed fold root, written at settlement time). Until that table is populated
 * in prod, lookups return not-found and ingestion fails closed — which is the
 * correct, safe behaviour, never a false accept. See migrations/repid_ratings.sql.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import {
  admitRating,
  aggregateRatings,
  RatingStage,
  RatingVerdict,
  type RatingSubmission,
  type OutcomeContext,
  type AdmittedRating,
} from '../../services/rating-ingestion';

const router = Router();

/** Resolve the truth about an outcome from persisted records. Fail-closed on any error. */
async function lookupOutcome(outcomeId: string): Promise<OutcomeContext> {
  try {
    const { data, error } = await db
      .from('repid_outcomes')
      .select('agent_id, gate_decision, fold_root, counterparty_id')
      .eq('id', outcomeId)
      .maybeSingle();

    if (error || !data) {
      return { exists: false, agentId: null, gateDecision: null, foldRoot: null, counterpartyId: null };
    }
    const gate = data.gate_decision === 'ALLOW' || data.gate_decision === 'REFUSE' ? data.gate_decision : null;
    const fold = typeof data.fold_root === 'number' ? data.fold_root : null;
    return {
      exists: true,
      agentId: data.agent_id ?? null,
      gateDecision: gate,
      foldRoot: fold,
      counterpartyId: data.counterparty_id ?? null,
    };
  } catch {
    // A missing table / column must not become an accept. Unknown = fail closed.
    return { exists: false, agentId: null, gateDecision: null, foldRoot: null, counterpartyId: null };
  }
}

/** Parse + shape-check the POST body into a RatingSubmission (deeper checks are in admitRating). */
export function parseSubmission(body: unknown): { ok: true; value: RatingSubmission } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const subjectAgentId = typeof b.subjectAgentId === 'string' ? b.subjectAgentId.trim() : '';
  const raterId = typeof b.raterId === 'string' ? b.raterId.trim() : '';
  const outcomeId = typeof b.outcomeId === 'string' ? b.outcomeId.trim() : '';
  const stage = b.stage as RatingStage;
  const verdict = b.verdict as RatingVerdict;
  if (!subjectAgentId || !raterId || !outcomeId) {
    return { ok: false, error: 'subjectAgentId, raterId and outcomeId are required strings' };
  }
  const claimedFoldRoot = typeof b.claimedFoldRoot === 'number' ? b.claimedFoldRoot : undefined;
  return { ok: true, value: { subjectAgentId, raterId, outcomeId, stage, verdict, claimedFoldRoot } };
}

/** POST /ratings — ingest one rating. */
router.post('/ratings', async (req: Request, res: Response) => {
  const parsed = parseSubmission(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const ctx = await lookupOutcome(parsed.value.outcomeId);
  const decision = admitRating(parsed.value, ctx);
  if (!decision.admitted) {
    // 422: well-formed but not admissible. The reasons are safe to return.
    return res.status(422).json({ admitted: false, reasons: decision.reasons, explanation: decision.explanation });
  }

  const r = decision.rating as AdmittedRating;
  const { data, error } = await db
    .from('repid_ratings')
    .insert({
      subject_agent_id: r.subjectAgentId,
      rater_id: r.raterId,
      stage: r.stage,
      verdict: r.verdict,
      outcome_id: r.outcomeId,
      fold_root: r.foldRoot,
    })
    .select('id')
    .single();

  if (error || !data) {
    // A unique-index violation (one rating per rater/outcome/stage) lands here too.
    const dup = (error?.code === '23505');
    console.error('[ratings] insert failed:', error?.message);
    return res.status(dup ? 409 : 500).json({ error: dup ? 'duplicate_rating' : 'rating_insert_failed' });
  }

  return res.status(201).json({ admitted: true, rating_id: data.id, fold_root: r.foldRoot });
});

/** GET /ratings/:agentId — stage-weighted summary. Public, keyless. */
router.get('/ratings/:agentId', async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId ?? '').trim();
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const { data, error } = await db
    .from('repid_ratings')
    .select('subject_agent_id, rater_id, stage, verdict, outcome_id, fold_root')
    .eq('subject_agent_id', agentId)
    .limit(1000);

  if (error) {
    console.error('[ratings] query failed:', error.message);
    return res.status(500).json({ error: 'ratings_query_failed' });
  }

  const rows: AdmittedRating[] = (data ?? []).map((d: any) => ({
    subjectAgentId: d.subject_agent_id,
    raterId: d.rater_id,
    stage: d.stage,
    verdict: d.verdict,
    outcomeId: d.outcome_id,
    foldRoot: d.fold_root,
  }));

  return res.status(200).json(aggregateRatings(agentId, rows));
});

export default router;
