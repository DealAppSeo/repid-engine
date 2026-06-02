/** S-HARDEN Phase 1 — HAL score orientation: risk (v1) vs trust (v2, HAL_SCORE_V2). */
import { computeHALScore, computeTrustScore } from '../src/hal/lib/score';

const lowRisk: any = { harm_probability: 0, epistemic_uncertainty: 0.1, evidence_quality: 1, scope_appropriateness: 1 };
const highRisk: any = { harm_probability: 1, epistemic_uncertainty: 1, evidence_quality: 0, scope_appropriateness: 0 };
const mid: any = { harm_probability: 0.5, epistemic_uncertainty: 0.5, evidence_quality: 0.5, scope_appropriateness: 0.5 };

describe('HAL score orientation', () => {
  test('hal_score is a RISK score (higher = worse): high-harm > low-harm', () => {
    expect(computeHALScore(highRisk).hal_score).toBeGreaterThan(computeHALScore(lowRisk).hal_score);
  });

  test('computeTrustScore (v2) is 0–100', () => {
    for (const s of [lowRisk, highRisk, mid]) {
      const t = computeTrustScore(s);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(100);
    }
  });

  test('v2 trust is INVERTED vs risk: low-risk → high trust', () => {
    expect(computeTrustScore(lowRisk)).toBeGreaterThan(computeTrustScore(highRisk));
  });

  test('v2 trust ≈ (1 − risk)·100', () => {
    const risk = computeHALScore(mid).hal_score;
    expect(computeTrustScore(mid)).toBe(Math.round((1 - risk) * 100));
  });
});
