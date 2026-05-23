/**
 * POST /api/v1/hal/evaluate — public HAL evaluation surface for Trust* products.
 *
 * Body: { text: string, context?: { domain?, certainty?, product? }, strictness?: 1|2 }
 * Response: HalEvaluationResponse (hal_score, decision, mode, signals, latency_ms).
 *
 * Mounting (do at merge — see report): app.use('/api/v1/hal', halEvaluateRouter)
 * AND add '/api/v1/hal/evaluate' to the SQL-keyword sanitizer bypass + a rate
 * limiter (deliverable prose legitimately contains SQL-ish words).
 */
import { Router, type Request, type Response } from 'express';
import { halService } from '../hal/service';

const router = Router();

router.post('/evaluate', async (req: Request, res: Response) => {
  const { text, context, strictness } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required (non-empty string)' });
  }
  if (text.length > 8000) {
    return res.status(400).json({ error: 'text too long (max 8000 chars)' });
  }
  const s = strictness === 2 || strictness === '2' ? 2 : strictness === 1 || strictness === '1' ? 1 : undefined;
  try {
    const result = await halService.evaluate({ text, context: context as any, strictness: s });
    return res.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'hal_evaluation_failed', message: msg });
  }
});

export default router;
