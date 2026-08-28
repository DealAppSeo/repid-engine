/**
 * POST /api/v1/social/drafts — submit content for verification, and queue it.
 * GET  /api/v1/social/drafts — what is queued, in what state, with what verdict.
 *
 * This is the surface an agent uses to publish. It never posts anything: it verifies, records
 * the verdict, and lets the database decide whether the result is allowed to sit in a state
 * that means "this may go out". The last mile — an actual platform credential — is deliberately
 * not here, and no account is connected, so nothing this route does can put text in front of a
 * human without a further, separate, authenticated step.
 *
 * AUTHED, unlike /hal/evaluate. Evaluation is a public primitive anyone may call; writing a row
 * that a scheduler may later publish is not. The mount sits after authMiddleware for that
 * reason, and the agent id is taken from the caller rather than the body — a body-supplied
 * author is a claim, not attribution.
 *
 * NOTE FOR THE MOUNT: post text is prose. It contains semicolons, em-dashes and words like
 * "select" and "update" constantly, so this path MUST be on the SQL-keyword sanitizer's bypass
 * list or the blanket scan 400s nearly every real draft. That is not speculative — it is the
 * same bug already documented on /hal/evaluate, /api/v1/lessons and the substance gate.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { verifyAndQueueDraft } from '../services/social-publish-gate';

const router = Router();

/** Matches the DB CHECK. A draft longer than this is a thread, and threads are not this shape. */
const MAX_CONTENT = 8000;

router.post('/drafts', async (req: Request, res: Response) => {
  const { platform, content, hashtags, media_url, scheduled_for, agent_id } =
    (req.body ?? {}) as Record<string, unknown>;

  if (typeof platform !== 'string' || platform.trim().length === 0) {
    return res.status(400).json({ error: 'platform is required (non-empty string)' });
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'content is required (non-empty string)' });
  }
  if (content.length > MAX_CONTENT) {
    return res.status(400).json({ error: `content too long (max ${MAX_CONTENT} chars)` });
  }

  // Attribution comes from the authenticated caller where the middleware provides one. A
  // body-supplied agent_id is accepted only as a fallback and is a claim, not proof — which is
  // why it is recorded as-is and never used to make an authorization decision.
  const callerAgent = (req as any).agentId;
  const resolvedAgent =
    typeof callerAgent === 'string' && callerAgent.length > 0
      ? callerAgent
      : typeof agent_id === 'string' && agent_id.length > 0
        ? agent_id
        : undefined;

  try {
    const result = await verifyAndQueueDraft({
      platform: platform.trim(),
      content,
      ...(typeof hashtags === 'string' ? { hashtags } : {}),
      ...(typeof media_url === 'string' ? { mediaUrl: media_url } : {}),
      ...(typeof scheduled_for === 'string' ? { scheduledFor: scheduled_for } : {}),
      ...(resolvedAgent ? { agentId: resolvedAgent } : {}),
    });
    // 201 even for a veto: the request succeeded and the verdict is the answer. Returning an
    // error status for "HAL said no" would teach callers to retry until it says yes.
    return res.status(201).json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[social/drafts] verify+queue failed:', message);
    return res.status(502).json({ error: 'could not verify and queue this draft', detail: message });
  }
});

router.get('/drafts', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  let q = db
    .from('social_content_queue')
    .select('id, platform, status, hal_decision, hal_score, hal_mode, agent_id, verified_at, scheduled_for, posted_at, post_url, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) {
    return res.status(502).json({ error: 'could not read the queue', detail: error.message ?? String(error) });
  }

  const rows = (data ?? []) as Array<{ hal_decision: string | null }>;
  return res.json({
    count: rows.length,
    // NOT CHECKED is its own number, never folded into a pass. Rows predating verification
    // carry a null verdict, and a reader who cannot see that count will assume the queue is
    // verified because most of it is.
    unverified: rows.filter((r) => r.hal_decision === null).length,
    drafts: rows,
  });
});

export default router;
