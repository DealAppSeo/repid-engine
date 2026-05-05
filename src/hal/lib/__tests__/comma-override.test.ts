import { computeHALScore } from '../score';
import { HAL_PYTHAGOREAN_COMMA } from '../constants';

describe('Comma Override functionality', () => {
  const dummySignals = {
    harm_probability: 0.1,
    epistemic_uncertainty: 0.2,
    evidence_quality: 0.8,
    scope_appropriateness: 0.9,
    certainty_at_claim: 0.9,
  };

  it('uses default HAL_PYTHAGOREAN_COMMA when no override is provided', () => {
    const res = computeHALScore(dummySignals);
    // score should be derived using HAL_PYTHAGOREAN_COMMA
    // Let's just check if it matches a manual calculation
    const w = { harm: 0.4, epistemic: 0.3, evidence: 0.2, scope: 0.1 };
    const expected = (
      w.harm * dummySignals.harm_probability +
      w.epistemic * dummySignals.epistemic_uncertainty +
      w.evidence * (1 - dummySignals.evidence_quality) +
      w.scope * (1 - dummySignals.scope_appropriateness)
    ) * HAL_PYTHAGOREAN_COMMA;
    expect(res.hal_score).toBeCloseTo(expected, 6);
  });

  it('uses commaOverride of 0.5', () => {
    const res = computeHALScore(dummySignals, 0.25, 0.5);
    const w = { harm: 0.4, epistemic: 0.3, evidence: 0.2, scope: 0.1 };
    const expected = (
      w.harm * dummySignals.harm_probability +
      w.epistemic * dummySignals.epistemic_uncertainty +
      w.evidence * (1 - dummySignals.evidence_quality) +
      w.scope * (1 - dummySignals.scope_appropriateness)
    ) * 0.5;
    expect(res.hal_score).toBeCloseTo(expected, 6);
  });

  it('uses commaOverride of 1.10', () => {
    const res = computeHALScore(dummySignals, 0.25, 1.10);
    const w = { harm: 0.4, epistemic: 0.3, evidence: 0.2, scope: 0.1 };
    const expected = (
      w.harm * dummySignals.harm_probability +
      w.epistemic * dummySignals.epistemic_uncertainty +
      w.evidence * (1 - dummySignals.evidence_quality) +
      w.scope * (1 - dummySignals.scope_appropriateness)
    ) * 1.10;
    expect(res.hal_score).toBeCloseTo(expected, 6);
  });
});
