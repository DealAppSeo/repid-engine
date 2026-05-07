/**
 * Sprint A7 — repid-delta unit tests (Phase 3).
 */

import { computeDelta } from '../src/scoring/repid-delta';

describe('computeDelta', () => {
  test('vetoed during vesting → calculated=-10, applied=0', () => {
    const r = computeDelta({
      hal_score: 0.1,
      hal_decision: 'vetoed',
      current_repid: 1000,
      agent_tier: 'CUSTODIED_DBT',
      vesting_cliff_active: true,
    });
    expect(r.delta_calculated).toBe(-10);
    expect(r.delta_applied).toBe(0);
    expect(r.reason).toMatch(/vesting-cliff/);
  });

  test('vetoed post-vesting → calculated=applied=-10', () => {
    const r = computeDelta({
      hal_score: 0.05,
      hal_decision: 'vetoed',
      current_repid: 1000,
      agent_tier: 'EARNING_AUTONOMY',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBe(-10);
    expect(r.delta_applied).toBe(-10);
  });

  test('clean with hal_score=0.95 → ~+2.8 (capped at +5)', () => {
    const r = computeDelta({
      hal_score: 0.95,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'EARNING_AUTONOMY',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBeCloseTo(2.8, 1);
    expect(r.delta_applied).toBeCloseTo(2.8, 1);
    expect(r.delta_calculated).toBeLessThanOrEqual(5);
  });

  test('clean with hal_score=1.0 → +3 (well under +5 cap)', () => {
    const r = computeDelta({
      hal_score: 1.0,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'EARNING_AUTONOMY',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBe(3);
  });

  test('clean with hal_score=0.10 → small negative (-0.6)', () => {
    const r = computeDelta({
      hal_score: 0.10,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'EARNING_AUTONOMY',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBeCloseTo(-0.6, 1);
    expect(r.delta_applied).toBeCloseTo(-0.6, 1);
  });

  test('floor protection: agent at repid=2 vetoed → applied=-2 (not -10)', () => {
    const r = computeDelta({
      hal_score: 0.05,
      hal_decision: 'vetoed',
      current_repid: 2,
      agent_tier: 'CUSTODIED_DBT',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBe(-10);
    expect(r.delta_applied).toBe(-2); // brings repid to 0, not below
    expect(r.reason).toMatch(/floor-protected/);
  });

  test('flagged during vesting → calculated=-2, applied=0', () => {
    const r = computeDelta({
      hal_score: 0.4,
      hal_decision: 'flagged',
      current_repid: 1000,
      agent_tier: 'CUSTODIED_DBT',
      vesting_cliff_active: true,
    });
    expect(r.delta_calculated).toBe(-2);
    expect(r.delta_applied).toBe(0);
  });

  test('clean+positive applies normally during vesting', () => {
    const r = computeDelta({
      hal_score: 0.95,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'CUSTODIED_DBT',
      vesting_cliff_active: true,
    });
    expect(r.delta_applied).toBeCloseTo(2.8, 1);
    expect(r.delta_applied).toBeGreaterThan(0);
  });

  test('positive cap at +5 if formula somehow exceeds', () => {
    // current formula maxes at +3 for clean — synthesize an edge by passing
    // unlikely score; verify clamp would still apply via direct invariant.
    const r = computeDelta({
      hal_score: 2.0, // outside spec but tests clamp
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'EARNING_AUTONOMY',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBeLessThanOrEqual(5);
  });
});
