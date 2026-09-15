/**
 * F1 — GROUNDING_MODE=enforce default OFF. Harness mutant: ungrounded delta is zeroed only in enforce.
 */
import { enforceGroundedDelta, parseGroundingMode } from '../src/scoring/grounding';

describe('GROUNDING_MODE', () => {
  it('defaults to off', () => {
    expect(parseGroundingMode(undefined)).toBe('off');
    expect(parseGroundingMode('')).toBe('off');
    expect(parseGroundingMode('garbage')).toBe('off');
    expect(parseGroundingMode('shadow')).toBe('shadow');
    expect(parseGroundingMode('enforce')).toBe('enforce');
  });

  it('mutant: enforce zeroes an ungrounded delta; off/shadow leave it', () => {
    expect(enforceGroundedDelta(25, 0, 'off')).toBe(25);
    expect(enforceGroundedDelta(25, 0, 'shadow')).toBe(25);
    expect(enforceGroundedDelta(25, 0, 'enforce')).toBe(0);
    expect(enforceGroundedDelta(25, 'high', 'enforce')).toBe(25);
  });
});
