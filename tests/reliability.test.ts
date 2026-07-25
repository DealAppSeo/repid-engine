/** Defensibility (P0, SPEC channel) — pure logic. */
import { scoreDefensibility, classifyContractDisposition } from '../src/services/reliability';

describe('scoreDefensibility', () => {
  test('upheld / (upheld + not_upheld), rounded 4dp', () => {
    const r = scoreDefensibility({ upheld: 287, not_upheld: 1356, non_conclusive: 4131 }, 20);
    expect(r.defensibility).toBeCloseTo(0.1747, 4);
    expect(r.conclusive).toBe(1643);
    expect(r.non_conclusive).toBe(4131);
    expect(r.sample_ok).toBe(true);
  });

  test('non_conclusive is excluded from the ratio', () => {
    const r = scoreDefensibility({ upheld: 10, not_upheld: 10, non_conclusive: 999 }, 20);
    expect(r.defensibility).toBe(0.5); // 10/20, unaffected by the 999 non-conclusive
    expect(r.conclusive).toBe(20);
  });

  test('below min sample → null, never a flattering default', () => {
    const r = scoreDefensibility({ upheld: 5, not_upheld: 2, non_conclusive: 100 }, 20);
    expect(r.defensibility).toBeNull();
    expect(r.sample_ok).toBe(false);
    expect(r.conclusive).toBe(7);
  });

  test('zero data → null, no divide-by-zero', () => {
    const r = scoreDefensibility({}, 20);
    expect(r.defensibility).toBeNull();
    expect(r.conclusive).toBe(0);
  });

  test('always provisional', () => {
    const r = scoreDefensibility({ upheld: 100, not_upheld: 100 }, 20);
    expect(r.provisional).toBe(true);
  });
});

describe('classifyContractDisposition (final disposition, provider POV)', () => {
  test('resolved + provider_at_fault → not_upheld', () => {
    expect(classifyContractDisposition({ status: 'resolved', dispute_verdict: 'provider_at_fault', buyer_satisfaction_score: null })).toBe('not_upheld');
  });

  test('resolved + buyer_at_fault → upheld (provider survived)', () => {
    expect(classifyContractDisposition({ status: 'resolved', dispute_verdict: 'buyer_at_fault', buyer_satisfaction_score: null })).toBe('upheld');
  });

  test('resolved + unknown verdict → non_conclusive (never guess)', () => {
    expect(classifyContractDisposition({ status: 'resolved', dispute_verdict: 'mumble', buyer_satisfaction_score: null })).toBe('non_conclusive');
  });

  test('settled + satisfaction >= threshold → upheld', () => {
    expect(classifyContractDisposition({ status: 'settled', dispute_verdict: null, buyer_satisfaction_score: 1 }, 0.6)).toBe('upheld');
  });

  test('settled + low satisfaction → not_upheld', () => {
    expect(classifyContractDisposition({ status: 'settled', dispute_verdict: null, buyer_satisfaction_score: 0.3 }, 0.6)).toBe('not_upheld');
  });

  test('fulfilled-but-unadjudicated → non_conclusive (out of denominator)', () => {
    expect(classifyContractDisposition({ status: 'fulfilled', dispute_verdict: null, buyer_satisfaction_score: null })).toBe('non_conclusive');
  });

  test('pending dispute / cancelled / expired → non_conclusive', () => {
    expect(classifyContractDisposition({ status: 'disputed', dispute_verdict: null, buyer_satisfaction_score: null })).toBe('non_conclusive');
    expect(classifyContractDisposition({ status: 'cancelled', dispute_verdict: null, buyer_satisfaction_score: null })).toBe('non_conclusive');
    expect(classifyContractDisposition({ status: 'expired', dispute_verdict: null, buyer_satisfaction_score: null })).toBe('non_conclusive');
  });
});
