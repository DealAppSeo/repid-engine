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
import { scanForInjection } from '../hal/injection-guard';
import { getCachedHalResult, cacheHalResult } from '../cache/hal-cache'; // S-CACHE

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
  // S-FIX Phase 3 — prompt-injection screen (additive; reported always). Hard-block only when
  // HAL_INJECTION_BLOCK=true (default off → no behavior change), so a high-confidence injection
  // is refused pre-evaluation with maximum risk.
  const injection = scanForInjection(text);
  if (process.env.HAL_INJECTION_BLOCK === 'true' && injection.decision === 'block') {
    return res.status(400).json({
      error: 'INJECTION_BLOCKED',
      message: 'This prompt matches prompt-injection patterns.',
      hal_score: 1.0, hal_verdict: 'INJECTION_BLOCKED', injection,
    });
  }
  try {
    // S-CACHE Phase 2 — return a cached verdict for the same (text, strictness) within the TTL,
    // skipping the LLM/extractor work. The cache key folds strictness in as the "provider".
    const cacheProvider = `s${s ?? 'default'}`;
    const cached = await getCachedHalResult(text, cacheProvider);
    if (cached) return res.json({ ...cached, injection });

    const result = await halService.evaluate({ text, context: context as any, strictness: s });
    void cacheHalResult(text, cacheProvider, result);
    return res.json({ ...(result as any), injection });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'hal_evaluation_failed', message: msg });
  }
});

export default router;
