/**
 * selection-score — the cases that matter are the ones where a naive scorer is silently wrong:
 * a missing dimension defaulted to neutral, a catastrophic failure washed out by volume, and two
 * equal scores built from very different amounts of evidence.
 */
import {
  NOT_YET_COMPUTABLE,
  rankCandidates,
  scoreCandidate,
  type CandidateEvidence,
} from '../src/repid/selection-score';

const NOW = Date.parse('2026-08-11T12:00:00.000Z');

const cand = (over: Partial<CandidateEvidence> = {}): CandidateEvidence => ({
  agentId: 'a1',
  agentName: 'trinity-veritas',
  currentRepid: 1558,
  totalFulfilled: 20,
  avgSatisfaction: 0.9,
  catastrophicFailures: 0,
  disputesTotal: 0,
  settlementsSettled: 10,
  onchainAttestations: 3,
  lastActivityAt: '2026-08-10T12:00:00.000Z',
  ...over,
});

describe('an unavailable dimension is omitted and NAMED, never defaulted', () => {
  it('THE CASE THIS EXISTS FOR: no jobs -> satisfaction unavailable, not 1.0', () => {
    const s = scoreCandidate(cand({ totalFulfilled: 0, avgSatisfaction: null }), NOW);
    expect(s.dimensionsUnavailable).toContain('satisfaction');
    expect(s.dimensionsUsed.map((d) => d.dimension)).not.toContain('satisfaction');
    expect(s.notes.join(' ')).toMatch(/omitted, not defaulted/);
  });

  it('defaulting to neutral would INFLATE an unproven agent — it must not', () => {
    const unproven = scoreCandidate(cand({ totalFulfilled: 0, avgSatisfaction: null }), NOW);
    const proven = scoreCandidate(cand({ totalFulfilled: 50, avgSatisfaction: 1 }), NOW);
    expect(unproven.score).toBeLessThan(proven.score);
  });

  it('zero jobs is a VALUE (no track record), not missing data', () => {
    const s = scoreCandidate(cand({ totalFulfilled: 0, avgSatisfaction: null }), NOW);
    const exp = s.dimensionsUsed.find((d) => d.dimension === 'verified_experience');
    expect(exp).toBeDefined();
    expect(exp!.value).toBe(0);
  });

  it('null settlement / chain data is unavailable, not zero', () => {
    const s = scoreCandidate(cand({ settlementsSettled: null, onchainAttestations: null }), NOW);
    expect(s.dimensionsUnavailable).toEqual(
      expect.arrayContaining(['settlement_history', 'onchain_provenance']),
    );
  });

  it('always reports what it cannot compute at all', () => {
    expect(scoreCandidate(cand(), NOW).dimensionsNotImplemented).toBe(NOT_YET_COMPUTABLE);
    expect(NOT_YET_COMPUTABLE).toContain('sybil_risk');
    expect(NOT_YET_COMPUTABLE).toContain('task_similarity');
  });
});

describe('coverage makes two equal scores distinguishable', () => {
  it('missing dimensions lower coverage, not just the score', () => {
    const full = scoreCandidate(cand(), NOW);
    const thin = scoreCandidate(
      cand({ avgSatisfaction: null, settlementsSettled: null, onchainAttestations: null }),
      NOW,
    );
    expect(thin.coverage).toBeLessThan(full.coverage);
    expect(full.coverage).toBeCloseTo(1, 5);
  });

  it('a thinly-evidenced candidate can be filtered out entirely', () => {
    const thin = cand({
      agentId: 'thin',
      avgSatisfaction: null,
      settlementsSettled: null,
      onchainAttestations: null,
      totalFulfilled: 0,
      disputesTotal: 0,
    });
    expect(rankCandidates([thin], NOW, { minCoverage: 0.8 })).toHaveLength(0);
    expect(rankCandidates([thin], NOW)).toHaveLength(1);
  });

  it('ties break on coverage — better-evidenced wins', () => {
    const a = cand({ agentId: 'well', agentName: 'well-evidenced' });
    const b = cand({ agentId: 'thin', agentName: 'thin-evidenced', onchainAttestations: null });
    const ranked = rankCandidates([b, a], NOW);
    // identical inputs otherwise, so if scores collide the better-covered one must lead
    if (ranked[0]!.score === ranked[1]!.score) {
      expect(ranked[0]!.coverage).toBeGreaterThanOrEqual(ranked[1]!.coverage);
    }
  });
});

describe('failure is asymmetric — volume cannot buy it back', () => {
  it('THE CONSTRAINT: 500 good jobs do not offset a catastrophic failure', () => {
    const clean = scoreCandidate(cand({ totalFulfilled: 50 }), NOW);
    const prolificButFailed = scoreCandidate(
      cand({ totalFulfilled: 500, catastrophicFailures: 1 }),
      NOW,
    );
    expect(prolificButFailed.score).toBeLessThan(clean.score);
  });

  it('the penalty compounds and sits OUTSIDE the mean', () => {
    const one = scoreCandidate(cand({ catastrophicFailures: 1 }), NOW);
    const two = scoreCandidate(cand({ catastrophicFailures: 2 }), NOW);
    expect(one.failurePenalty).toBeCloseTo(0.5, 5);
    expect(two.failurePenalty).toBeCloseTo(0.25, 5);
    expect(two.score).toBeLessThan(one.score);
  });

  it('a clean record applies no penalty at all', () => {
    expect(scoreCandidate(cand(), NOW).failurePenalty).toBe(1);
  });

  it('explains the penalty rather than silently applying it', () => {
    expect(scoreCandidate(cand({ catastrophicFailures: 1 }), NOW).notes.join(' '))
      .toMatch(/volume cannot offset/);
  });
});

describe('recency is a note, never a silent multiplier', () => {
  it('unknown last activity does NOT get substituted with now', () => {
    const s = scoreCandidate(cand({ lastActivityAt: null }), NOW);
    expect(s.notes.join(' ')).toMatch(/never substitute/);
  });

  it('flags a stale candidate without secretly rescoring it', () => {
    const stale = scoreCandidate(cand({ lastActivityAt: '2026-01-01T00:00:00.000Z' }), NOW);
    const fresh = scoreCandidate(cand(), NOW);
    expect(stale.notes.join(' ')).toMatch(/treat freshness with caution/);
    expect(stale.score).toBeCloseTo(fresh.score, 5); // surfaced, not silently applied
  });
});

describe('every verdict is re-derivable by its consumer', () => {
  it('each used dimension carries the evidence it came from', () => {
    for (const d of scoreCandidate(cand(), NOW).dimensionsUsed) {
      expect(d.evidence).toMatch(/=/);
      expect(d.weight).toBeGreaterThan(0);
      expect(d.value).toBeGreaterThanOrEqual(0);
      expect(d.value).toBeLessThanOrEqual(1);
    }
  });

  it('score stays within [0,1] under adversarial inputs', () => {
    const s = scoreCandidate(
      cand({ currentRepid: 999999, totalFulfilled: 999999, avgSatisfaction: 5 }),
      NOW,
    );
    expect(s.score).toBeLessThanOrEqual(1);
    expect(s.score).toBeGreaterThanOrEqual(0);
  });

  it('the same inputs always produce the same verdict', () => {
    expect(scoreCandidate(cand(), NOW)).toEqual(scoreCandidate(cand(), NOW));
  });
});
