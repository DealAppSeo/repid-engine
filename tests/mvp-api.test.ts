/**
 * S-WIRE-MVP — unit tests for the pure decision/aggregation logic behind the MVP API.
 * These cover the policy surfaces that must be correct regardless of DB state:
 *   - provider trust aggregation (grouping, averaging, lowest-risk ranking)
 *   - x402 authority decision (tier ceilings, daily cap, disputes, stake)
 */
import { aggregateProviderTrust, TrustSessionRow } from '../src/services/provider-trust';
import { decideAuthority, limitForTier, TIER_LIMITS, AuthorityContext } from '../src/services/x402-gate';

describe('aggregateProviderTrust', () => {
  const rows: TrustSessionRow[] = [
    { llm_provider_used: 'groq', llm_model: 'llama-3.1-8b', hal_score: 0.2, hal_signals: { evidence_quality: 0.8, certainty_at_claim: 0.7, scope_appropriateness: 0.9 }, hal_flagged_hallucination: false },
    { llm_provider_used: 'groq', llm_model: 'llama-3.1-8b', hal_score: 0.4, hal_signals: { evidence_quality: 0.6, certainty_at_claim: 0.5, scope_appropriateness: 0.7 }, hal_flagged_hallucination: true },
    { llm_provider_used: 'openai', llm_model: 'gpt-4o', hal_score: 0.1, hal_signals: { evidence_quality: 0.9, certainty_at_claim: 0.9, scope_appropriateness: 0.95 }, hal_flagged_hallucination: false },
  ];

  it('groups by provider+model and averages risk', () => {
    const agg = aggregateProviderTrust(rows);
    expect(agg).toHaveLength(2);
    const groq = agg.find((a) => a.provider_name === 'groq')!;
    expect(groq.total_evaluations).toBe(2);
    expect(groq.avg_hal_score).toBeCloseTo(0.3, 5);
    expect(groq.hallucination_rate).toBeCloseTo(0.5, 5);
    expect(groq.avg_evidence_quality).toBeCloseTo(0.7, 5);
    expect(groq.avg_certainty).toBeCloseTo(0.6, 5);
    // no completeness key → falls back to scope_appropriateness avg
    expect(groq.avg_completeness).toBeCloseTo(0.8, 5);
  });

  it('ranks lowest average risk first (rank 1 = most trusted)', () => {
    const agg = aggregateProviderTrust(rows);
    expect(agg[0]!.provider_name).toBe('openai'); // 0.1 < 0.3
  });

  it('lowercases provider and tolerates null model', () => {
    const agg = aggregateProviderTrust([
      { llm_provider_used: 'GROQ', llm_model: null, hal_score: 0.5, hal_signals: null, hal_flagged_hallucination: null },
    ]);
    expect(agg[0]!.provider_name).toBe('groq');
    expect(agg[0]!.model_name).toBe('unknown');
  });

  it('handles empty input', () => {
    expect(aggregateProviderTrust([])).toEqual([]);
  });
});

describe('x402 decideAuthority', () => {
  const ctx = (over: Partial<AuthorityContext> = {}): AuthorityContext => ({
    tier: 'ESTABLISHED', stake_available: 1000, daily_used: 0, open_disputes: 0, ...over,
  });

  it('authorizes a transaction within tier limits', () => {
    const d = decideAuthority(50, ctx());
    expect(d.authorized).toBe(true);
    expect(d.denial_reason).toBeNull();
    expect(d.daily_remaining).toBe(1000);
  });

  it('denies over the per-tx limit', () => {
    const d = decideAuthority(200, ctx()); // ESTABLISHED per_tx = 100
    expect(d.authorized).toBe(false);
    expect(d.denial_reason).toBe('exceeds_per_tx_limit');
  });

  it('denies over the daily limit', () => {
    const d = decideAuthority(50, ctx({ daily_used: 980 })); // 980 + 50 > 1000
    expect(d.denial_reason).toBe('exceeds_daily_limit');
  });

  it('denies when there are open disputes', () => {
    expect(decideAuthority(50, ctx({ open_disputes: 1 })).denial_reason).toBe('open_disputes');
  });

  it('denies insufficient stake for staked tiers', () => {
    expect(decideAuthority(50, ctx({ stake_available: 10 })).denial_reason).toBe('insufficient_stake');
  });

  it('PROBATIONARY cannot transact at all', () => {
    const d = decideAuthority(1, ctx({ tier: 'PROBATIONARY' }));
    expect(d.authorized).toBe(false);
    expect(d.denial_reason).toBe('tier_probationary_cannot_transact');
  });

  it('AUTONOMOUS does not require stake', () => {
    expect(decideAuthority(500, ctx({ tier: 'AUTONOMOUS', stake_available: 0 })).authorized).toBe(true);
  });

  it('rejects a non-positive amount before any other check', () => {
    expect(decideAuthority(0, ctx()).denial_reason).toBe('invalid_amount');
    expect(decideAuthority(-5, ctx()).denial_reason).toBe('invalid_amount');
  });

  it('unknown/empty tier falls back to PROBATIONARY ceilings', () => {
    expect(limitForTier('NONSENSE')).toEqual(TIER_LIMITS.PROBATIONARY);
    expect(limitForTier(null)).toEqual(TIER_LIMITS.PROBATIONARY);
    expect(decideAuthority(5, ctx({ tier: null })).denial_reason).toBe('tier_probationary_cannot_transact');
  });
});
