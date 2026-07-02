/**
 * Tier-ceiling authority policy (Task 1) — pure decideAuthority unit tests.
 *
 * decideAuthority is DB-free (all live state injected via ctx), so these tests
 * verify the tier ceilings and denial precedence without touching Supabase.
 */
// x402-gate.ts imports the real db at module load (which calls config.ts and would
// throw without SUPABASE_* env). decideAuthority/limitForTier are pure and never touch
// the db, so we stub the db import — matching the repo-wide supertest mock pattern.
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import { decideAuthority, limitForTier, TIER_LIMITS } from '../src/services/x402-gate';

const ctx = (over: Partial<Parameters<typeof decideAuthority>[1]> = {}) => ({
  tier: 'AUTONOMOUS',
  stake_available: 1_000_000,
  daily_used: 0,
  open_disputes: 0,
  ...over,
});

describe('decideAuthority — tier ceilings', () => {
  it('PROBATIONARY cannot transact at any amount ($0 ceiling)', () => {
    const d = decideAuthority(1, ctx({ tier: 'PROBATIONARY' }));
    expect(d.authorized).toBe(false);
    expect(d.denial_reason).toBe('tier_probationary_cannot_transact');
    expect(d.per_tx_limit).toBe(0);
  });

  it('EARNING allows $10/tx but denies above it', () => {
    expect(decideAuthority(10, ctx({ tier: 'EARNING', stake_available: 1000 })).authorized).toBe(true);
    const over = decideAuthority(11, ctx({ tier: 'EARNING', stake_available: 1000 }));
    expect(over.authorized).toBe(false);
    expect(over.denial_reason).toBe('exceeds_per_tx_limit');
  });

  it('ESTABLISHED allows $100/tx but denies above it', () => {
    expect(decideAuthority(100, ctx({ tier: 'ESTABLISHED', stake_available: 1000 })).authorized).toBe(true);
    expect(decideAuthority(101, ctx({ tier: 'ESTABLISHED', stake_available: 1000 })).denial_reason)
      .toBe('exceeds_per_tx_limit');
  });

  it('AUTONOMOUS/VETERAN carry higher ceilings and require no stake', () => {
    expect(TIER_LIMITS.AUTONOMOUS.per_tx).toBeGreaterThan(TIER_LIMITS.ESTABLISHED.per_tx);
    expect(TIER_LIMITS.VETERAN.per_tx).toBeGreaterThan(TIER_LIMITS.AUTONOMOUS.per_tx);
    expect(decideAuthority(1000, ctx({ tier: 'AUTONOMOUS', stake_available: 0 })).authorized).toBe(true);
    expect(decideAuthority(5000, ctx({ tier: 'VETERAN', stake_available: 0 })).authorized).toBe(true);
  });

  it('unknown tier falls back to the PROBATIONARY (fully-gated) default', () => {
    expect(limitForTier('WAT')).toEqual(TIER_LIMITS.PROBATIONARY);
    expect(decideAuthority(1, ctx({ tier: 'not-a-tier' as any })).authorized).toBe(false);
  });
});

describe('decideAuthority — precedence and other denials', () => {
  it('rejects non-positive amounts first', () => {
    expect(decideAuthority(0, ctx()).denial_reason).toBe('invalid_amount');
    expect(decideAuthority(-5, ctx()).denial_reason).toBe('invalid_amount');
  });

  it('open disputes block before per-tx / daily / stake checks', () => {
    const d = decideAuthority(10, ctx({ tier: 'ESTABLISHED', open_disputes: 1 }));
    expect(d.authorized).toBe(false);
    expect(d.denial_reason).toBe('open_disputes');
  });

  it('enforces the daily ceiling', () => {
    const d = decideAuthority(10, ctx({ tier: 'EARNING', stake_available: 1000, daily_used: 45 }));
    // 45 + 10 = 55 > EARNING daily 50
    expect(d.authorized).toBe(false);
    expect(d.denial_reason).toBe('exceeds_daily_limit');
  });

  it('requires stake to cover the amount for stake-gated tiers', () => {
    const d = decideAuthority(10, ctx({ tier: 'EARNING', stake_available: 5 }));
    expect(d.authorized).toBe(false);
    expect(d.denial_reason).toBe('insufficient_stake');
  });

  it('authorizes a fully-satisfied ESTABLISHED transaction', () => {
    const d = decideAuthority(50, ctx({ tier: 'ESTABLISHED', stake_available: 100, daily_used: 10 }));
    expect(d.authorized).toBe(true);
    expect(d.denial_reason).toBeNull();
    expect(d.daily_remaining).toBe(TIER_LIMITS.ESTABLISHED.daily - 10);
  });
});
