import { state, createUser, seedAgents, stakeAndBind, decideTrade } from '../scripts/demo/repid-staking-mvp-demo';

describe('repid-staking-mvp-demo stakeId regression', () => {
  beforeEach(() => {
    state.users.clear();
    state.agents.clear();
    state.stakes = [];
    state.tradeAttempts = [];
  });

  it('populates stakeId on TradeAttempt when backed by a stake', () => {
    seedAgents();
    const user = createUser('test-user');
    const stake = stakeAndBind(user.userId, 'sophia', 1000);
    
    const attempt = decideTrade({ agentId: 'sophia', tradeSizeUSD: 500 });
    
    expect(attempt.stakeId).not.toBeNull();
    expect(attempt.stakeId).toBe(stake.stakeId);
    expect(attempt.decision).toBe('approved');
  });
});
