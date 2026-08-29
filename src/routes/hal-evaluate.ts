/**
 * POST /api/v1/hal/evaluate — public HAL evaluation surface for Trust* products.
 *
 * Body: { text: string, context?: { domain?, certainty?, product? }, strictness?: 1|2, source?: string }
 * Response: HalEvaluationResponse (hal_score, decision, mode, signals, latency_ms).
 *
 * Mounting (do at merge — see report): app.use('/api/v1/hal', halEvaluateRouter)
 * AND add '/api/v1/hal/evaluate' to the SQL-keyword sanitizer bypass + a rate
 * limiter (deliverable prose legitimately contains SQL-ish words).
 *
 * GET /api/v1/hal/fact-check-count — public tally of the source-tagged public counter.
 *
 * PUBLIC COUNTER (2026-07-20): a successful fresh evaluation ALSO writes one fire-and-forget row
 * into `hal_public_fact_checks`. That table is SEPARATE from `hal_classifications` (the internal
 * production classifier's pure sink) and is NEVER merged with it — it grows honestly from the
 * public/eval/user surface so it can be blended with tunable weights later.
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'crypto';
import { halService } from '../hal/service';
import { scanForInjection } from '../hal/injection-guard';
import { getCachedHalResult, cacheHalResult } from '../cache/hal-cache'; // S-CACHE
import { db } from '../db';
import { publicError } from './public-error';

const router = Router();

// The four source tags the hal_public_fact_checks CHECK constraint allows. An unknown/absent source
// coerces to 'api' so a stray value can never fail the insert (and never gets silently dropped).
const PUBLIC_FACT_CHECK_SOURCES = ['eval', 'trustchat', 'aidebate', 'api'] as const;
type PublicFactCheckSource = (typeof PUBLIC_FACT_CHECK_SOURCES)[number];

function resolveSource(raw: unknown): PublicFactCheckSource {
  return typeof raw === 'string' && (PUBLIC_FACT_CHECK_SOURCES as readonly string[]).includes(raw)
    ? (raw as PublicFactCheckSource)
    : 'api';
}

/**
 * Fire-and-forget: record one public fact-check into the source-tagged counter. NEVER blocks or
 * fails the response; errors are swallowed (matches the non-critical write style elsewhere in this
 * codebase — badge awards, learning-events). prompt_hash is a sha256 of the text (no prompt is
 * ever stored in the clear).
 */
function recordPublicFactCheck(
  source: PublicFactCheckSource,
  text: string,
  result: { decision?: string; hal_score?: number },
): void {
  try {
    const prompt_hash = createHash('sha256').update(text).digest('hex');
    void db
      .from('hal_public_fact_checks')
      .insert({
        source,
        verdict: result.decision ?? null,
        hal_score: typeof result.hal_score === 'number' ? result.hal_score : null,
        prompt_hash,
      })
      .then(
        ({ error }: any) => {
          if (error) console.error('[hal/evaluate] public fact-check counter insert failed:', error.message ?? error);
        },
        (e: any) => {
          console.error('[hal/evaluate] public fact-check counter insert threw:', e?.message ?? String(e));
        },
      );
  } catch (e: unknown) {
    console.error('[hal/evaluate] public fact-check counter failed:', e instanceof Error ? e.message : String(e));
  }
}

router.post('/evaluate', async (req: Request, res: Response) => {
  const { text, context, strictness, source } = (req.body ?? {}) as Record<string, unknown>;
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
    // Cached hits are NOT re-counted: the underlying evaluation was already recorded on its first
    // (fresh) run, so counting the cache-serve would double-count the same (text, strictness).
    // `cached: true` IS THE POINT OF THIS LINE, and it is not cosmetic.
    //
    // A cache serve used to be INDISTINGUISHABLE from a fresh evaluation: same shape, same
    // fields, no marker. That made "is this answer current?" unanswerable by any caller, and it
    // cost a real hour — a deploy was verified by POSTing the same sentence used before the
    // deploy, the TTL served the pre-deploy verdict, and a working fix was reported broken.
    // The probe could not have been right: it had no way to fail correctly.
    //
    // Marked only on the cache path, so its ABSENCE is not a claim of freshness by an older
    // caller — but its PRESENCE lets a verifier assert it got a real evaluation.
    if (cached) return res.json({ ...cached, cached: true, injection });

    const result = await halService.evaluate({ text, context: context as any, strictness: s });
    void cacheHalResult(text, cacheProvider, result);
    // Source-tagged public counter — fire-and-forget, after a successful fresh evaluation.
    recordPublicFactCheck(resolveSource(source), text, result);
    return res.json({ ...(result as any), injection });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'hal_evaluation_failed', message: msg });
  }
});

// GET /fact-check-count — public tally of the source-tagged public fact-check counter
// (hal_public_fact_checks). SEPARATE from hal_classifications (internal production classifier);
// the two are never merged. No auth (mounted before authMiddleware alongside /evaluate). Read-only.
router.get('/fact-check-count', async (_req: Request, res: Response) => {
  try {
    const results = await Promise.all(
      PUBLIC_FACT_CHECK_SOURCES.map((src) =>
        db.from('hal_public_fact_checks').select('*', { count: 'exact', head: true }).eq('source', src),
      ),
    );
    const by_source: Record<string, number> = {};
    let total = 0;
    for (let i = 0; i < PUBLIC_FACT_CHECK_SOURCES.length; i++) {
      const r: any = results[i];
      if (r?.error) {
        return publicError(res, 500, 'fact_check_count_failed', r.error, 'POST /api/v1/hal/evaluate');
      }
      const c = Number(r?.count ?? 0);
      by_source[PUBLIC_FACT_CHECK_SOURCES[i]!] = c;
      total += c;
    }
    return res.json({ total, by_source, last_updated: new Date().toISOString() });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'fact_check_count_failed', detail: msg });
  }
});

export default router;
