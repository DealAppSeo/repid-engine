/**
 * rating-ingestion tests — the un-gameable admission logic + aggregation.
 * Pure over (submission, server context): no database, fully reproducible.
 */
import {
  admitRating,
  aggregateRatings,
  RatingStage,
  RatingVerdict,
  STAGE_WEIGHT,
  type RatingSubmission,
  type OutcomeContext,
  type AdmittedRating,
} from '../src/services/rating-ingestion';

const AGENT = 'trinity-shofet';
const CLIENT = 'client-alice';
const FOLD = 414124072;

function submission(over: Partial<RatingSubmission> = {}): RatingSubmission {
  return {
    subjectAgentId: AGENT,
    raterId: CLIENT,
    stage: RatingStage.RETAINED,
    verdict: RatingVerdict.GOOD,
    outcomeId: 'outcome-1',
    ...over,
  };
}

function ctx(over: Partial<OutcomeContext> = {}): OutcomeContext {
  return {
    exists: true,
    agentId: AGENT,
    gateDecision: 'ALLOW',
    foldRoot: FOLD,
    counterpartyId: CLIENT,
    ...over,
  };
}

describe('admitRating — admission', () => {
  it('admits a valid rating and binds the SERVER fold root (not the client claim)', () => {
    const r = admitRating(submission({ claimedFoldRoot: FOLD }), ctx());
    expect(r.admitted).toBe(true);
    expect(r.rating?.foldRoot).toBe(FOLD);
    expect(r.reasons).toEqual([]);
  });

  it('SETTLED stage may be rated by a non-counterparty (settlement is system-observable)', () => {
    const r = admitRating(
      submission({ stage: RatingStage.SETTLED, raterId: 'some-observer' }),
      ctx(),
    );
    expect(r.admitted).toBe(true);
  });
});

describe('admitRating — the un-gameable rejections', () => {
  it('rejects an outcome that does not exist', () => {
    const r = admitRating(submission(), ctx({ exists: false, foldRoot: null }));
    expect(r.admitted).toBe(false);
    expect(r.reasons).toContain('outcome_not_found');
  });

  it('rejects an outcome the gate REFUSED', () => {
    const r = admitRating(submission(), ctx({ gateDecision: 'REFUSE' }));
    expect(r.admitted).toBe(false);
    expect(r.reasons).toContain('outcome_not_authorized');
  });

  it('rejects an outcome with NO recorded gate decision (fail-closed, not ALLOW-by-default)', () => {
    const r = admitRating(submission(), ctx({ gateDecision: null }));
    expect(r.admitted).toBe(false);
    expect(r.reasons).toContain('outcome_not_authorized');
  });

  it('rejects when the outcome is about a different agent', () => {
    const r = admitRating(submission(), ctx({ agentId: 'someone-else' }));
    expect(r.admitted).toBe(false);
    expect(r.reasons).toContain('subject_mismatch');
  });

  it('rejects self-rating', () => {
    const r = admitRating(submission({ raterId: AGENT }), ctx({ counterpartyId: AGENT }));
    expect(r.admitted).toBe(false);
    expect(r.reasons).toContain('self_rating');
  });

  it('rejects a deep-stage rating from someone who is not the recorded counterparty', () => {
    const r = admitRating(
      submission({ stage: RatingStage.TO_SPEC, raterId: 'drive-by' }),
      ctx(),
    );
    expect(r.admitted).toBe(false);
    expect(r.reasons).toContain('not_the_counterparty');
  });

  it('rejects a fold-root claim that does not match the server', () => {
    const r = admitRating(submission({ claimedFoldRoot: 999 }), ctx());
    expect(r.admitted).toBe(false);
    expect(r.reasons).toContain('fold_root_mismatch');
  });

  it('fails closed when the outcome exists but has no fold root to anchor to', () => {
    const r = admitRating(submission(), ctx({ foldRoot: null }));
    expect(r.admitted).toBe(false);
  });

  it('rejects invalid stage / verdict / missing fields', () => {
    expect(admitRating(submission({ stage: 'wat' as RatingStage }), ctx()).reasons).toContain('invalid_stage');
    expect(admitRating(submission({ verdict: 'meh' as RatingVerdict }), ctx()).reasons).toContain('invalid_verdict');
    expect(admitRating(submission({ outcomeId: '' }), ctx()).reasons).toContain('missing_fields');
  });

  it('reports EVERY failed check, not just the first', () => {
    const r = admitRating(
      submission({ raterId: AGENT, stage: RatingStage.TO_SPEC }),
      ctx({ gateDecision: 'REFUSE', agentId: 'other', counterpartyId: 'x' }),
    );
    expect(r.reasons.length).toBeGreaterThan(1);
  });
});

describe('aggregateRatings — stage-weighted', () => {
  function rating(stage: RatingStage, verdict: RatingVerdict, agentId = AGENT): AdmittedRating {
    return { subjectAgentId: agentId, raterId: 'r', stage, verdict, outcomeId: 'o', foldRoot: FOLD };
  }

  it('returns null score for an agent with no ratings (does not invent neutrality)', () => {
    const s = aggregateRatings(AGENT, []);
    expect(s.weightedScore).toBeNull();
    expect(s.count).toBe(0);
  });

  it('weights RETAINED (T3) above SETTLED (T1)', () => {
    // one GOOD retained (w=4) vs one BAD settled (w=1) → (4*1 + 1*-1)/(4+1) = 0.6
    const s = aggregateRatings(AGENT, [
      rating(RatingStage.RETAINED, RatingVerdict.GOOD),
      rating(RatingStage.SETTLED, RatingVerdict.BAD),
    ]);
    expect(s.weightedScore).toBeCloseTo(0.6, 5);
    expect(s.count).toBe(2);
    expect(s.byStage[RatingStage.RETAINED].good).toBe(1);
    expect(s.byStage[RatingStage.SETTLED].bad).toBe(1);
  });

  it('ignores ratings for other agents', () => {
    const s = aggregateRatings(AGENT, [
      rating(RatingStage.RETAINED, RatingVerdict.GOOD),
      rating(RatingStage.RETAINED, RatingVerdict.BAD, 'other-agent'),
    ]);
    expect(s.count).toBe(1);
    expect(s.weightedScore).toBe(1);
  });

  it('stage weights are ordered settled < to_spec < retained', () => {
    expect(STAGE_WEIGHT[RatingStage.SETTLED]).toBeLessThan(STAGE_WEIGHT[RatingStage.TO_SPEC]);
    expect(STAGE_WEIGHT[RatingStage.TO_SPEC]).toBeLessThan(STAGE_WEIGHT[RatingStage.RETAINED]);
  });
});
