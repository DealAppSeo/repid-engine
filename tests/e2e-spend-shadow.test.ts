/**
 * Spend shadow denies an unbound agent and a missing stake. applied stays false.
 */
import { shadowHumanSpend } from '../src/services/human-spend-shadow';

describe('e2e spend shadow', () => {
  it('denies an unbound agent after the human cap and the agent cap', () => {
    const unbound = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 40,
      ownerCapUsdc: 25,
      bound: false,
      stakeAvailableUsdc: 50,
    });
    expect(unbound.visited).toEqual(['human_cap', 'agent_cap', 'deny_unbound']);
    expect(unbound.spend).toBe('deny');
    expect(unbound.reason).toBe('unbound_agent');
    expect(unbound.applied).toBe(false);
    expect(unbound.enforced).toBe(false);
  });

  it('denies when stake was not checked and when no stake was found', () => {
    const notChecked = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 40,
      ownerCapUsdc: 25,
      bound: true,
    });
    expect(notChecked.spend).toBe('deny');
    expect(notChecked.reason).toBe('stake_not_checked');
    expect(notChecked.applied).toBe(false);
    expect(notChecked.enforced).toBe(false);

    const none = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 40,
      ownerCapUsdc: 25,
      bound: true,
      stakeAvailableUsdc: null,
    });
    expect(none.spend).toBe('deny');
    expect(none.reason).toBe('no_stake');
    expect(none.applied).toBe(false);
    expect(none.enforced).toBe(false);
  });
});
