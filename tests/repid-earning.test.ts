/**
 * Unit tests for the pure scoring function `scoreTrade` in
 * src/services/repid-earning.ts. Integration tests for `recordOutcome` are
 * deferred — they require a fixture insert into trade_execution_log + cleanup,
 * documented as a follow-up in the sprint report.
 */

import { scoreTrade } from '../src/services/repid-earning';

describe('scoreTrade — pure scoring of paper-trade outcome', () => {
  it('large profit (>2%) → +15', () => {
    const r = scoreTrade({ pnl_realized: 50, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(15);
    expect(r.reason).toMatch(/^profit_/);
    expect(r.pnlPct).toBeCloseTo(5);
  });

  it('small profit (0-2%) → +5', () => {
    const r = scoreTrade({ pnl_realized: 10, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(5);
    expect(r.reason).toMatch(/^profit_small/);
    expect(r.pnlPct).toBeCloseTo(1);
  });

  it('exactly 2% profit (boundary) → +5 (not +15, > strict)', () => {
    const r = scoreTrade({ pnl_realized: 20, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(5);
  });

  it('small loss (0-2%) → -3', () => {
    const r = scoreTrade({ pnl_realized: -15, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(-3);
    expect(r.reason).toMatch(/^loss_small/);
  });

  it('moderate loss (2-5%) → -10', () => {
    const r = scoreTrade({ pnl_realized: -30, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(-10);
    expect(r.reason).toMatch(/^loss_/);
  });

  it('severe loss (>5%) → -20', () => {
    const r = scoreTrade({ pnl_realized: -100, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(-20);
    expect(r.reason).toMatch(/^loss_severe/);
  });

  it('HAL veto (decision=hal_veto, no pnl) → +2', () => {
    const r = scoreTrade({ pnl_realized: null, amount_usd: 1000, decision: 'HAL_VETO', executed_at: null });
    expect(r.delta).toBe(2);
    expect(r.reason).toBe('hal_veto_no_execution');
  });

  it('HAL block (decision contains hal_block) → +2', () => {
    const r = scoreTrade({ pnl_realized: null, amount_usd: 0, decision: 'hal_block:high_dissonance', executed_at: null });
    expect(r.delta).toBe(2);
  });

  it('rejected (decision=reject) → +2', () => {
    const r = scoreTrade({ pnl_realized: null, amount_usd: null, decision: 'reject_low_confidence', executed_at: null });
    expect(r.delta).toBe(2);
  });

  it('null pnl + non-veto decision → -5 timeout/no-pnl', () => {
    const r = scoreTrade({ pnl_realized: null, amount_usd: 1000, decision: 'pending_resolution', executed_at: null });
    expect(r.delta).toBe(-5);
    expect(r.reason).toBe('no_pnl_recorded');
  });

  it('null pnl + null decision → -5', () => {
    const r = scoreTrade({ pnl_realized: null, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(-5);
  });

  it('profit with null amount_usd → +5 small (no pct math)', () => {
    const r = scoreTrade({ pnl_realized: 100, amount_usd: null, decision: null, executed_at: null });
    expect(r.delta).toBe(5);
    expect(r.pnlPct).toBeNull();
  });

  it('loss with null amount_usd → -3 small (no pct math)', () => {
    const r = scoreTrade({ pnl_realized: -100, amount_usd: null, decision: null, executed_at: null });
    expect(r.delta).toBe(-3);
    expect(r.pnlPct).toBeNull();
  });

  it('amount_usd=0 treated as null (avoid div-by-zero)', () => {
    const r = scoreTrade({ pnl_realized: -50, amount_usd: 0, decision: null, executed_at: null });
    expect(r.delta).toBe(-3); // small loss branch since pct is null
    expect(r.pnlPct).toBeNull();
  });

  it('exact -5% boundary (5% loss) → -10 (not -20, > strict)', () => {
    const r = scoreTrade({ pnl_realized: -50, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(-10);
  });

  it('exact -5.01% loss → -20 severe', () => {
    const r = scoreTrade({ pnl_realized: -50.1, amount_usd: 1000, decision: null, executed_at: null });
    expect(r.delta).toBe(-20);
  });
});
