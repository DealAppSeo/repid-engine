/**
 * S-HARDEN Phase 6 — HAL end-to-end integration.
 *
 * Drives the real `evaluate()` pipeline (strictness 1 — the production default
 * extractor path: pure, no providers, no DB) over GOOD / BAD / HALLUCINATION
 * inputs and asserts the contract that genuinely holds.
 *
 * HONESTY NOTE (see scripts/hal-eval/CALIBRATION_REPORT.md): the strictness-1
 * extractor is *blind* — it does NOT reliably separate good from bad/hallucinated
 * content (measured separation ~0.015; AUC ~0.36). So these tests DO NOT assert a
 * "good > 0.7 / bad < 0.4" threshold the extractor cannot meet — that would be a
 * fabricated green. They assert the invariants that are real:
 *   - score is a well-formed RISK score in [0,1]
 *   - veto is consistent with score vs threshold
 *   - the pipeline is deterministic under identical input
 *   - computeTrustScore() is the inverted, 0–100 trust orientation (HAL_SCORE_V2)
 * Discrimination is the job of the strictness-2 fact-check path (provider-gated),
 * which is out of scope for a DB/network-free integration test.
 */
import { evaluate } from '../../src/hal/lib/evaluate';
import { computeTrustScore } from '../../src/hal/lib/score';
import type { HALContext } from '../../src/hal/lib/types';

const ctx = (over: Partial<HALContext> = {}): HALContext =>
  ({ domain: 'general', certainty: 0.8, strictness: 1, ...over } as HALContext);

const GOOD = 'The capital of France is Paris, a city in Western Europe.';
const BAD = 'Drinking bleach cures every disease and is completely safe for children.';
const HALLUCINATION = 'The Eiffel Tower was relocated to Berlin in 1987 and renamed the Spree Spire.';

describe('HAL e2e — pipeline contract (strictness 1)', () => {
  it('GOOD input → well-formed risk score + consistent veto', async () => {
    const r = await evaluate(GOOD, GOOD, ctx());
    expect(r.hal_score).toBeGreaterThanOrEqual(0);
    expect(r.hal_score).toBeLessThanOrEqual(1);
    expect(typeof r.formula).toBe('string');
    expect(r.strictness).toBe(1);
    // veto must agree with score vs threshold — no independent veto path at L1.
    expect(r.vetoed).toBe(r.hal_score >= r.threshold);
  });

  it('BAD (harmful) input → well-formed risk score + consistent veto', async () => {
    const r = await evaluate(BAD, BAD, ctx());
    expect(r.hal_score).toBeGreaterThanOrEqual(0);
    expect(r.hal_score).toBeLessThanOrEqual(1);
    expect(r.vetoed).toBe(r.hal_score >= r.threshold);
  });

  it('HALLUCINATION input → well-formed risk score + consistent veto', async () => {
    const r = await evaluate(HALLUCINATION, HALLUCINATION, ctx());
    expect(r.hal_score).toBeGreaterThanOrEqual(0);
    expect(r.hal_score).toBeLessThanOrEqual(1);
    expect(r.vetoed).toBe(r.hal_score >= r.threshold);
  });

  it('is deterministic — identical input yields identical score across runs', async () => {
    const a = await evaluate(GOOD, GOOD, ctx());
    const b = await evaluate(GOOD, GOOD, ctx());
    expect(b.hal_score).toBe(a.hal_score);
    expect(b.vetoed).toBe(a.vetoed);
  });

  it('computeTrustScore (HAL_SCORE_V2) inverts risk into a 0–100 trust score', async () => {
    const r = await evaluate(GOOD, GOOD, ctx());
    const trust = computeTrustScore(r.signals);
    expect(Number.isInteger(trust)).toBe(true);
    expect(trust).toBeGreaterThanOrEqual(0);
    expect(trust).toBeLessThanOrEqual(100);
    // trust ≈ (1 - risk) * 100
    expect(Math.abs(trust - (1 - r.hal_score) * 100)).toBeLessThanOrEqual(1);
  });

  it('documents the known calibration gap: L1 extractor does not strongly separate classes', async () => {
    const good = (await evaluate(GOOD, GOOD, ctx())).hal_score;
    const bad = (await evaluate(BAD, BAD, ctx())).hal_score;
    const hall = (await evaluate(HALLUCINATION, HALLUCINATION, ctx())).hal_score;
    // All three land in the same compressed band — this is the documented blindness,
    // asserted so a future fix that *does* separate them will surface here loudly.
    for (const s of [good, bad, hall]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    // Separation is small (< 0.5) at L1 today; if this ever fails, recalibrate the test
    // because discrimination has genuinely improved (a good problem).
    const spread = Math.max(good, bad, hall) - Math.min(good, bad, hall);
    expect(spread).toBeLessThan(0.5);
  });
});
