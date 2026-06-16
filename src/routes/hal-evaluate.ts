/**
 * POST /api/v1/hal/evaluate — public HAL evaluation surface for Trust* products.
 *
 * Body: { text: string, context?: { domain?, certainty?, product? }, strictness?: 1|2 }
 * Response: HalEvaluationResponse (hal_score, decision, mode, signals, latency_ms).
 *
 * Mounting (do at merge — see report): app.use('/api/v1/hal', halEvaluateRouter)
 * AND add '/api/v1/hal/evaluate' to the SQL-keyword sanitizer bypass + a rate
 * limiter (deliverable prose legitimately contains SQL-ish words).
 *
 * B4 hardening (2026-06-16, CC):
 * - Route-level timeout (default 60s, HAL_ROUTE_TIMEOUT_MS env-overridable) so a stalled quorum
 *   (all providers slow but not timing out at the per-call level) never hangs the Express worker.
 *   If the quorum stalls longer than the route budget, the response is 503 (not 500) to signal
 *   the caller that the service is degraded (retriable), never a silent hang.
 *   The per-provider timeout in queryProvider (HAL_S2_TIMEOUT_MS, default 12s) prevents a single
 *   slow provider from blocking others; this outer timeout is the failsafe for the aggregate.
 * - Structured 503 on timeout so the wrapper consumer can retry/fallback cleanly.
 * - Input size guard already present (8000 chars); validated as the first check.
 */
import { Router, type Request, type Response } from 'express';
import { halService } from '../hal/service';
import { scanForInjection } from '../hal/injection-guard';
import { getCachedHalResult, cacheHalResult } from '../cache/hal-cache'; // S-CACHE

const router = Router();

/** B4 — RULE-8 route-level timeout: default 60s (covers N×perProvider + retries). */
const HAL_ROUTE_TIMEOUT_MS = (() => {
  const v = Number(process.env.HAL_ROUTE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
})();

/**
 * Wrap a promise with a timeout that rejects with a structured error.
 * The original promise continues in the background (fetch can't be aborted here since
 * AbortSignal is already wired inside queryProvider) — document the background-leak caveat
 * per RULE-8.
 */
function withRouteTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new RouteTimeoutError(`HAL route timeout after ${ms}ms`)), ms)
    ),
  ]);
}

class RouteTimeoutError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RouteTimeoutError'; }
}

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

    // B4 — RULE-8 outer timeout: protects against a quorum that is slow-but-not-dead.
    // Per-provider AbortSignal already wires at queryProvider level (HAL_S2_TIMEOUT_MS).
    // This outer race is the failsafe so the Express worker is never hung indefinitely.
    const result = await withRouteTimeout(
      halService.evaluate({ text, context: context as any, strictness: s }),
      HAL_ROUTE_TIMEOUT_MS,
    );
    void cacheHalResult(text, cacheProvider, result);
    return res.json({ ...(result as any), injection });
  } catch (e: unknown) {
    if (e instanceof RouteTimeoutError) {
      // 503 (retriable) — the service is slow/degraded; the actual evaluation may still complete.
      return res.status(503).json({
        error: 'hal_timeout',
        message: `HAL evaluation did not complete within ${HAL_ROUTE_TIMEOUT_MS}ms. The quorum may be degraded. Retry or use strictness:1 for the extractor-only path.`,
        hal_score: 0.5,
        decision: 'flagged', // fail-safe: flag, never veto on timeout
        mode: 'timeout-fallback',
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'hal_evaluation_failed', message: msg });
  }
});

export default router;
