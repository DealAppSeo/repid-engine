import {
  tierOf, computeClaimLimit, computeRewardScale, quarantineCandidate, evaluateGate, gateMode,
} from '../src/services/repid-active-gate';

describe('C-1 RepID active gate (shadow) — scaling math', () => {
  it('tierOf matches canonical boundaries', () => {
    expect(tierOf(0)).toBe('PROBATIONARY');
    expect(tierOf(499)).toBe('PROBATIONARY');
    expect(tierOf(500)).toBe('EARNING');
    expect(tierOf(1000)).toBe('ESTABLISHED');
    expect(tierOf(5000)).toBe('AUTONOMOUS');
    expect(tierOf(8000)).toBe('VETERAN');
  });
  it('claim limit scales by tier', () => {
    expect(computeClaimLimit(100)).toBe(1);   // PROBATIONARY
    expect(computeClaimLimit(700)).toBe(2);    // EARNING
    expect(computeClaimLimit(2280)).toBe(4);   // ESTABLISHED
    expect(computeClaimLimit(6000)).toBe(8);   // AUTONOMOUS
    expect(computeClaimLimit(9000)).toBe(12);  // VETERAN
  });
  it('reward scale is linear in [0.5, 1.5]', () => {
    expect(computeRewardScale(0)).toBe(0.5);
    expect(computeRewardScale(5000)).toBe(1.0);
    expect(computeRewardScale(10000)).toBe(1.5);
    expect(computeRewardScale(99999)).toBe(1.5); // clamped
  });
});

describe('C-1 quarantine candidate selection', () => {
  it('flags a chronically-low active agent that is sliding or repeatedly vetoed', () => {
    expect(quarantineCandidate({ repid: 80, recent_delta: -5 })).toBe(true);       // low + down
    expect(quarantineCandidate({ repid: 80, recent_vetoes: 2 })).toBe(true);        // low + vetoed
  });
  it('does NOT flag a healthy or merely-low-but-stable agent', () => {
    expect(quarantineCandidate({ repid: 2280, recent_delta: -50 })).toBe(false);    // high repid
    expect(quarantineCandidate({ repid: 80, recent_delta: 3, recent_vetoes: 0 })).toBe(false); // low but rising, no vetoes
  });
});

describe('C-1 evaluateGate + mode', () => {
  it('defaults to shadow and computes the full evaluation', () => {
    const prev = process.env.REPID_ACTIVE_GATE_MODE;
    delete process.env.REPID_ACTIVE_GATE_MODE;
    const e = evaluateGate({ id: 'a1', current_repid: 2280, recent_delta: 5 }, { current_claims: 2 });
    expect(e.mode).toBe('shadow');
    expect(e).toMatchObject({ tier: 'ESTABLISHED', claim_limit: 4, reward_scale: 0.73, quarantine_candidate: false, would_allow_claim: true });
    // at the limit → would NOT allow another claim (advisory only in shadow)
    expect(evaluateGate({ id: 'a1', current_repid: 2280 }, { current_claims: 4 }).would_allow_claim).toBe(false);
    if (prev !== undefined) process.env.REPID_ACTIVE_GATE_MODE = prev;
  });
  it('gateMode reads enforce only when explicitly set', () => {
    const prev = process.env.REPID_ACTIVE_GATE_MODE;
    process.env.REPID_ACTIVE_GATE_MODE = 'enforce';
    expect(gateMode()).toBe('enforce');
    process.env.REPID_ACTIVE_GATE_MODE = 'shadow';
    expect(gateMode()).toBe('shadow');
    if (prev === undefined) delete process.env.REPID_ACTIVE_GATE_MODE; else process.env.REPID_ACTIVE_GATE_MODE = prev;
  });
});
