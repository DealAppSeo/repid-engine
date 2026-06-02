/**
 * Reputation Inheritance Tests (S-BUILD Phase 6)
 */

import { computeEffectiveRepid } from '../src/engine/reputation-inheritance';

describe('Reputation Inheritance', () => {
  it('effective RepID is MIN of delegator and target', () => {
    const result = computeEffectiveRepid({
      delegatorAgent: 'agent-a',
      delegatorRepid: 850,
      targetAgent: 'agent-b',
      targetRepid: 500,
      delegationDepth: 1,
    });
    expect(result.effectiveRepid).toBe(500);
    expect(result.hitlRequired).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('blocks delegation deeper than 3', () => {
    const result = computeEffectiveRepid({
      delegatorAgent: 'agent-a',
      delegatorRepid: 850,
      targetAgent: 'agent-d',
      targetRepid: 900,
      delegationDepth: 4,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('MAX_DELEGATION_DEPTH_EXCEEDED');
  });

  it('blocks self-delegation', () => {
    const result = computeEffectiveRepid({
      delegatorAgent: 'agent-a',
      delegatorRepid: 850,
      targetAgent: 'agent-a',
      targetRepid: 850,
      delegationDepth: 1,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('SELF_DELEGATION');
  });

  it('requires HITL when effective RepID < 70', () => {
    const result = computeEffectiveRepid({
      delegatorAgent: 'high',
      delegatorRepid: 900,
      targetAgent: 'low',
      targetRepid: 40,
      delegationDepth: 1,
    });
    expect(result.effectiveRepid).toBe(40);
    expect(result.hitlRequired).toBe(true);
  });

  it('high delegator cannot elevate low target', () => {
    const result = computeEffectiveRepid({
      delegatorAgent: 'high',
      delegatorRepid: 9999,
      targetAgent: 'low',
      targetRepid: 30,
      delegationDepth: 1,
    });
    expect(result.effectiveRepid).toBe(30);
    expect(result.hitlRequired).toBe(true);
  });

  it('low delegator caps high target', () => {
    const result = computeEffectiveRepid({
      delegatorAgent: 'low',
      delegatorRepid: 45,
      targetAgent: 'high',
      targetRepid: 800,
      delegationDepth: 1,
    });
    expect(result.effectiveRepid).toBe(45);
    expect(result.hitlRequired).toBe(true);
  });
});
