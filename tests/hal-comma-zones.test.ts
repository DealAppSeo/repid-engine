/**
 * Wave 5 Phase 4 — three-zone Pythagorean Comma band classification.
 */
import { classifyAgreementZone } from '../src/hal/lib/zones';
import {
  COMMA_BAND_LOOSE_THRESHOLD,
  COMMA_BAND_TIGHT_THRESHOLD,
} from '../src/hal/lib/constants';

describe('comma zone classification (Wave 5 Phase 4)', () => {
  test('boundary values', () => {
    expect(classifyAgreementZone(0.94)).toBe('too-loose');
    expect(classifyAgreementZone(COMMA_BAND_LOOSE_THRESHOLD - 1e-9)).toBe('too-loose');
    expect(classifyAgreementZone(COMMA_BAND_LOOSE_THRESHOLD)).toBe('in-band');
    expect(classifyAgreementZone(0.96)).toBe('in-band');
    expect(classifyAgreementZone(0.98)).toBe('in-band');
    expect(classifyAgreementZone(COMMA_BAND_TIGHT_THRESHOLD)).toBe('in-band');
    expect(classifyAgreementZone(COMMA_BAND_TIGHT_THRESHOLD + 1e-9)).toBe('too-tight');
    expect(classifyAgreementZone(1.0)).toBe('too-tight');
  });

  test('out-of-range and non-finite inputs', () => {
    expect(classifyAgreementZone(0)).toBe('too-loose');
    expect(classifyAgreementZone(0.5)).toBe('too-loose');
    expect(classifyAgreementZone(NaN)).toBe('too-loose');
    expect(classifyAgreementZone(Infinity)).toBe('too-loose');
    expect(classifyAgreementZone(-Infinity)).toBe('too-loose');
  });

  test('thresholds are positioned around the Pythagorean Comma normalized value', () => {
    // The Pythagorean Comma is 1.0136433 (531441/524288). Normalized to
    // similarity = 1 / 1.0136433 ≈ 0.9866. The band should bracket this.
    const normalized = 524288 / 531441;
    expect(normalized).toBeGreaterThan(COMMA_BAND_LOOSE_THRESHOLD);
    expect(normalized).toBeLessThan(COMMA_BAND_TIGHT_THRESHOLD);
  });
});
