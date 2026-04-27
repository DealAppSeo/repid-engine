/**
 * Reponomics — linked bet sign rule + oracle signature tests.
 *
 * The pure sign-rule helper computeLinkedDeltas can be exercised
 * directly. Oracle HMAC signatures roundtrip via signOracleOutcome /
 * verifyOracleSignature.
 *
 * The DB-side atomic-linkage CHECK constraint is enforced at migration
 * time and tested by the migration's example, not here.
 */

// Mock db before importing — keeps the existing test pattern.
jest.mock('../src/db', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    ilike: () => builder,
    insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  return {
    db: {
      from: () => builder,
      rpc: async () => ({ data: { id: 1 }, error: null }),
    },
  };
});

import {
  computeLinkedDeltas,
  signOracleOutcome,
  verifyOracleSignature,
} from '../src/services/linked-bet-resolver';

describe('linked-bet — sign rule', () => {
  it('correct + confidence > 0 ⇒ both deltas positive', () => {
    const r = computeLinkedDeltas({ betAmount: 100_000_000n, claimedConfidence: 6000, correct: true });
    expect(r.tokenDelta > 0n).toBe(true);
    expect(r.repidDelta > 0).toBe(true);
  });

  it('wrong + confidence > 0 ⇒ both deltas negative', () => {
    const r = computeLinkedDeltas({ betAmount: 100_000_000n, claimedConfidence: 6000, correct: false });
    expect(r.tokenDelta < 0n).toBe(true);
    expect(r.repidDelta < 0).toBe(true);
  });

  it('zero confidence ⇒ both deltas zero', () => {
    const rWin = computeLinkedDeltas({ betAmount: 100_000_000n, claimedConfidence: 0, correct: true });
    expect(rWin.tokenDelta).toBe(0n);
    expect(rWin.repidDelta).toBe(0);
    const rLose = computeLinkedDeltas({ betAmount: 100_000_000n, claimedConfidence: 0, correct: false });
    expect(rLose.tokenDelta).toBe(-0n);  // BigInt has no -0; this is just 0n
    expect(rLose.repidDelta).toBe(-0);
  });

  it('correct path token+repid have same sign', () => {
    for (const conf of [100, 1000, 5000, 9000, 10000]) {
      const r = computeLinkedDeltas({ betAmount: 50_000_000n, claimedConfidence: conf, correct: true });
      const tokenSign = r.tokenDelta > 0n ? 1 : (r.tokenDelta < 0n ? -1 : 0);
      const repidSign = r.repidDelta > 0 ? 1 : (r.repidDelta < 0 ? -1 : 0);
      expect(tokenSign).toBe(repidSign);
    }
  });

  it('wrong path token+repid have same sign', () => {
    for (const conf of [100, 1000, 5000, 9000, 10000]) {
      const r = computeLinkedDeltas({ betAmount: 50_000_000n, claimedConfidence: conf, correct: false });
      const tokenSign = r.tokenDelta > 0n ? 1 : (r.tokenDelta < 0n ? -1 : 0);
      const repidSign = r.repidDelta > 0 ? 1 : (r.repidDelta < 0 ? -1 : 0);
      expect(tokenSign).toBe(repidSign);
    }
  });

  it('100% confidence on $100 bet: token±100M, repid±100', () => {
    const win = computeLinkedDeltas({ betAmount: 100_000_000n, claimedConfidence: 10000, correct: true });
    expect(win.tokenDelta).toBe(100_000_000n);
    expect(win.repidDelta).toBe(100);
    const lose = computeLinkedDeltas({ betAmount: 100_000_000n, claimedConfidence: 10000, correct: false });
    expect(lose.tokenDelta).toBe(-100_000_000n);
    expect(lose.repidDelta).toBe(-100);
  });
});

describe('linked-bet — oracle HMAC roundtrip', () => {
  it('sign+verify roundtrips for a given (betId, outcome)', () => {
    const sig = signOracleOutcome('bet_test_1', true);
    expect(verifyOracleSignature('bet_test_1', true, sig)).toBe(true);
  });

  it('signature is bound to outcome — flipping outcome breaks the signature', () => {
    const sig = signOracleOutcome('bet_test_2', true);
    expect(verifyOracleSignature('bet_test_2', false, sig)).toBe(false);
  });

  it('signature is bound to betId', () => {
    const sig = signOracleOutcome('bet_test_3', true);
    expect(verifyOracleSignature('bet_test_99', true, sig)).toBe(false);
  });
});
