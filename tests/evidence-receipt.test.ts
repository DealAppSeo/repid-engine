/**
 * F1 — receipt is an evidence tuple, not a baked score. SYNTHETIC.
 */
import { buildEvidenceReceipt, EVIDENCE_RECEIPT_KEYS } from '../src/services/evidence-receipt';

describe('evidence receipt tuple', () => {
  it('has composition, HAL number, payment hash, outcome — and no score', () => {
    const r = buildEvidenceReceipt({
      composition: 'ws:00000000-0000-4000-8000-0000000000aa',
      hal: 0.12,
      payment_hash: '0x' + 'ab'.repeat(32),
      outcome: 'PASS',
      score: 2177,
    });
    expect(Object.keys(r).sort()).toEqual([...EVIDENCE_RECEIPT_KEYS].sort());
    expect(r).toEqual({
      composition: 'ws:00000000-0000-4000-8000-0000000000aa',
      hal: 0.12,
      payment_hash: '0x' + 'ab'.repeat(32),
      outcome: 'PASS',
    });
    expect(r).not.toHaveProperty('score');
    expect(r).not.toHaveProperty('reputationScore');
    expect(r).not.toHaveProperty('current_repid');
  });
});
