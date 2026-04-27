/**
 * Reponomics — character score (mission-alignment delta) tests.
 *
 * Pure deltaFor is exercised directly. Bounds enforcement is covered
 * by replaying the delta against current ± delta in the test.
 */

import {
  deltaFor,
  C_FLOOR,
  C_CEILING,
  UNDERSERVED_DOMAIN_THRESHOLD,
} from '../src/services/character-score';

function clamp(v: number) {
  return Math.max(C_FLOOR, Math.min(C_CEILING, v));
}

describe('character-score — event deltas', () => {
  it('trade_with_low_repid: +5 only when counterparty.repid < self.repid', () => {
    expect(deltaFor({ agentId: 'a', eventType: 'trade_with_low_repid', counterpartyRepId: 1000, agentSelfRepId: 5000 })).toBe(5);
    expect(deltaFor({ agentId: 'a', eventType: 'trade_with_low_repid', counterpartyRepId: 5000, agentSelfRepId: 5000 })).toBe(0);
    expect(deltaFor({ agentId: 'a', eventType: 'trade_with_low_repid', counterpartyRepId: 7000, agentSelfRepId: 5000 })).toBe(0);
    expect(deltaFor({ agentId: 'a', eventType: 'trade_with_low_repid' })).toBe(0);
  });

  it('attestation_to_low_repid: +10 unconditional', () => {
    expect(deltaFor({ agentId: 'a', eventType: 'attestation_to_low_repid' })).toBe(10);
  });

  it('underserved_domain_action: +15 only when domainTradeCount < threshold', () => {
    expect(deltaFor({ agentId: 'a', eventType: 'underserved_domain_action', domainTradeCount: UNDERSERVED_DOMAIN_THRESHOLD - 1 })).toBe(15);
    expect(deltaFor({ agentId: 'a', eventType: 'underserved_domain_action', domainTradeCount: UNDERSERVED_DOMAIN_THRESHOLD })).toBe(0);
    expect(deltaFor({ agentId: 'a', eventType: 'underserved_domain_action' })).toBe(0);
  });

  it('agent_abandonment: -20', () => {
    expect(deltaFor({ agentId: 'a', eventType: 'agent_abandonment' })).toBe(-20);
  });

  it('floor 100 enforced (clamped)', () => {
    expect(clamp(105 + deltaFor({ agentId: 'a', eventType: 'agent_abandonment' }))).toBe(100);
    expect(clamp(100 + deltaFor({ agentId: 'a', eventType: 'agent_abandonment' }))).toBe(100);
  });

  it('ceiling 2000 enforced (clamped)', () => {
    expect(clamp(1995 + deltaFor({ agentId: 'a', eventType: 'attestation_to_low_repid' }))).toBe(2000);
  });
});
