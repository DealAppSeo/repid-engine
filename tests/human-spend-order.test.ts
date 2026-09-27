import { shadowHumanSpend } from '../src/services/human-spend-shadow';

describe('spend shadow order', () => {
  it('checks the human cap, then the agent cap, then denies an unbound agent', () => {
    const skipped = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 100,
      bound: false,
      stakeAvailableUsdc: 50,
    });
    expect(skipped.visited).toEqual(['human_cap']);
    expect(skipped.reason).toBe('owner_cap_not_checked');
    expect(skipped.applied).toBe(false);

    const unbound = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 40,
      ownerCapUsdc: 25,
      bound: false,
      stakeAvailableUsdc: 50,
    });
    expect(unbound.visited).toEqual(['human_cap', 'agent_cap', 'deny_unbound']);
    expect(unbound.reason).toBe('unbound_agent');
    expect(unbound.spend).toBe('deny');
    expect(unbound.human_cap_usdc).toBe(25);
    expect(unbound.agent_cap_usdc).toBe(40);
    expect(unbound.effective_cap_usdc).toBe(25);
    expect(unbound.applied).toBe(false);
    expect(unbound.enforced).toBe(false);
  });
});
