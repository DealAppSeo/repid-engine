import { Router, Request, Response } from 'express';
import { recordConfession, validateConfession, reducedPenalty } from '../services/repid-confession';
import { publicError } from './public-error';

/**
 * repid-confess.ts — THE CALLER for the just-culture path.
 *
 * This route exists because a service with no caller is the failure this whole change is
 * fixing. `repid_confession_log` sat in production with a complete schema, zero rows, and
 * nothing wired to it; adding `repid-confession.ts` without an entry point would have
 * reproduced that exactly one layer up (LESSONS #3).
 *
 *   POST /api/v1/repid/:agentId/confess
 *     { domain, confession_text, detected_penalty, original_event_id? }
 *
 * MOUNTED BEHIND authMiddleware, deliberately. A confession must come from the agent
 * itself — an unauthenticated confession endpoint would let anyone charge anyone else a
 * penalty, turning a mechanism for honesty into a griefing primitive. This is the one place
 * in this change where the public/authenticated distinction is load-bearing.
 *
 * GET /api/v1/repid/confession-preview?detected_penalty=N is public and read-only: it
 * computes what a confession WOULD cost without recording anything. An agent deciding
 * whether to disclose should be able to see the discount before committing to it —
 * a just-culture system that hides its own incentive is not offering one.
 */
const router = Router();

/** Preview the asymmetry. Pure arithmetic, no writes, no agent required. */
router.get('/repid/confession-preview', (req: Request, res: Response) => {
  const raw = Number(req.query.detected_penalty);
  if (!Number.isFinite(raw)) {
    return res.status(400).json({ error: 'detected_penalty must be a finite number' });
  }
  const p = reducedPenalty(raw);
  return res.json({
    detected_penalty: p.detected,
    self_reported_penalty: p.reduced,
    delta_if_confessed: p.delta,
    saving: p.detected - p.reduced,
    // Reported rather than assumed: a 1-point penalty cannot be discounted below 1.
    discount_applies: p.detected > 0 && p.reduced < p.detected,
    policy: 'a self-reported failure costs strictly less than the same failure detected',
  });
});

router.post('/repid/:agentId/confess', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = {
      agentId: String(req.params.agentId ?? ''),
      domain: typeof body.domain === 'string' ? body.domain : '',
      confessionText: typeof body.confession_text === 'string' ? body.confession_text : '',
      detectedPenalty: Number(body.detected_penalty),
      originalEventId:
        body.original_event_id === undefined || body.original_event_id === null
          ? null
          : Number(body.original_event_id),
    };

    const refusal = validateConfession(input);
    if (refusal) return res.status(400).json({ error: refusal });

    const result = await recordConfession(input);
    if (!result.ok) {
      // A failed confession write is a server problem, not the agent's — and the agent
      // should be told it did NOT land, so it can retry rather than assume it disclosed.
      return publicError(res, 500, 'CONFESSION_NOT_RECORDED', result.warning ?? 'unknown', 'POST /repid/:id/confess');
    }

    return res.status(201).json({
      recorded: true,
      confession_id: result.confessionId,
      score_event_id: result.scoreEventId ?? null,
      detected_penalty: result.penalty?.detected,
      applied_penalty: result.penalty?.reduced,
      discount_applied: result.discountApplied,
      // Never silently drop a partial success: the disclosure may exist while the ledger
      // entry does not, and the agent needs to know which.
      ...(result.warning ? { warning: result.warning } : {}),
    });
  } catch (e) {
    return publicError(res, 500, 'CONFESSION_NOT_RECORDED', e, 'POST /repid/:id/confess');
  }
});

export default router;
