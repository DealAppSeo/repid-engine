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
      agent_tier: 'ESTABLISHED',
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
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBe(-10);
    expect(r.delta_applied).toBe(-10);
  });

  // The clean branch consumes QUALITY as of 2026-08-17, so delta = 3 - 4*risk. Every case below
  // uses a REACHABLE risk: `deriveHalDecision` flags anything >= 0.40, so a 'clean' decision at
  // risk 0.95 or 1.0 — which this suite previously asserted — cannot occur in production. Those
  // unreachable cases are why the orientation defect survived (LESSONS §6).
  test('clean at risk 0.05 (near-perfect grounding) → ~+2.8', () => {
    const r = computeDelta({
      hal_score: 0.05,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBeCloseTo(2.8, 1);
    expect(r.delta_applied).toBeCloseTo(2.8, 1);
    expect(r.delta_calculated).toBeLessThanOrEqual(5);
  });

  test('clean at risk 0.0 (perfect grounding) → +3, the documented ceiling, now reachable', () => {
    const r = computeDelta({
      hal_score: 0.0,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBe(3);
  });

  test('clean at risk 0.39 (worst still-clean) → +1.4: smallest clean reward, still positive', () => {
    // The floor of the clean branch. Previously this end of the range paid the MOST (+0.6 was the
    // best a clean event could earn); it now pays the least, and honest work is never punished.
    const r = computeDelta({
      hal_score: 0.39,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBeCloseTo(1.4, 1);
    expect(r.delta_applied).toBeCloseTo(1.4, 1);
    expect(r.delta_applied).toBeGreaterThan(0);
  });

  test('reward decreases monotonically as risk rises across the clean branch', () => {
    const at = (hal_score: number) =>
      computeDelta({
        hal_score,
        hal_decision: 'clean',
        current_repid: 1000,
        agent_tier: 'ESTABLISHED',
        vesting_cliff_active: false,
      }).delta_applied;
    const risks = [0, 0.05, 0.1, 0.2, 0.3, 0.39];
    for (let i = 1; i < risks.length; i++) {
      expect(at(risks[i]!)).toBeLessThan(at(risks[i - 1]!));
    }
  });

  test('floor protection: agent at repid=2 vetoed → applied=-2 (not -10)', () => {
    const r = computeDelta({
      hal_score: 0.05,
      hal_decision: 'vetoed',
      current_repid: 2,
      agent_tier: 'PROBATIONARY',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBe(-10);
    expect(r.delta_applied).toBe(-2); // brings repid to 0, not below
    expect(r.reason).toMatch(/floor-protected/);
  });

  test('flagged → calculated=0, applied=0 (A2: unconfirmed claims no longer penalized)', () => {
    const r = computeDelta({
      hal_score: 0.4,
      hal_decision: 'flagged',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: true,
    });
    expect(r.delta_calculated).toBe(0); // A2: flagged (no FALSE quorum) carries no penalty
    expect(r.delta_applied).toBe(0);
  });

  test('vetoed during vesting → calculated=-10, applied=0 (vesting suppresses negatives)', () => {
    const r = computeDelta({
      hal_score: 0.9,
      hal_decision: 'vetoed',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: true,
    });
    expect(r.delta_calculated).toBe(-10);
    expect(r.delta_applied).toBe(0);
  });

  test('clean+positive applies normally during vesting', () => {
    const r = computeDelta({
      hal_score: 0.05,
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: true,
    });
    expect(r.delta_applied).toBeCloseTo(2.8, 1);
    expect(r.delta_applied).toBeGreaterThan(0);
  });

  test('positive cap at +5 if the formula somehow exceeds it', () => {
    // The clean branch maxes at +3 on valid input, so the upper clamp needs an out-of-spec value to
    // exercise at all. Now that reward falls with risk, the extreme is a NEGATIVE risk — the old
    // version passed 2.0, which after the orientation fix drives the formula DOWN and so probed
    // nothing. Raw here is +7 before the clamp.
    const r = computeDelta({
      hal_score: -1.0, // outside spec, on purpose: this is the clamp's test
      hal_decision: 'clean',
      current_repid: 1000,
      agent_tier: 'ESTABLISHED',
      vesting_cliff_active: false,
    });
    expect(r.delta_calculated).toBe(5);
  });
});

describe('A2 — abstain/flagged carry no RepID penalty', () => {
  const { computeDelta } = require('../src/scoring/repid-delta');
  const base = { current_repid: 2000, vesting_cliff_active: false, hal_score: 0.5 };
  test('abstain → delta 0 (not a checkable claim)', () => {
    expect(computeDelta({ ...base, hal_decision: 'abstain' }).delta_calculated).toBe(0);
  });
  test('flagged → delta 0 (unconfirmed, no FALSE quorum)', () => {
    expect(computeDelta({ ...base, hal_decision: 'flagged' }).delta_calculated).toBe(0);
  });
  test('vetoed → -10 preserved (confirmed FALSE quorum)', () => {
    expect(computeDelta({ ...base, hal_decision: 'vetoed' }).delta_calculated).toBe(-10);
  });
});
