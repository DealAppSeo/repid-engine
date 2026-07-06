/**
 * stake-delta-gate — engine-level proof gate for the STAKE delta (2026-07-06).
 *
 * Drives the REAL updateRepId() with its layer + DB dependencies mocked, and
 * asserts the core honesty invariant:
 *
 *   STAKE event WITHOUT a stakeProof  → delta 0  (no verified stake, no +5)
 *   STAKE event WITH    a stakeProof  → delta +5 (FIXED_DELTAS.STAKE)
 *
 * This closes the prior hole where any /score {eventType:'STAKE'} granted +5.
 */

// Neutralize the scoring layers so only the STAKE branch matters.
jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
  updateSupplyRate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: jest.fn() }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid, // no decay
  computeRedemptionModifier: jest.fn().mockResolvedValue(1.0),
}));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: jest.fn().mockResolvedValue({
    enabled: false, passed: null, complianceScore: null, rulesChecked: [],
    halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0,
    mirrorTestPassed: true,
  }),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: jest.fn().mockResolvedValue([]) }));

// DB: fetch agent, insert audit row (no error), update score.
jest.mock('../src/db', () => {
  const agent = { id: 'agent-1', agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };
  return {
    db: {
      from: jest.fn((table: string) => {
        if (table === 'repid_agents') {
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: agent, error: null }) }) }),
            update: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        // repid_score_events insert
        return { insert: async () => ({ error: null }) };
      }),
    },
  };
});

import { updateRepId } from '../src/engine/repid-update';

afterEach(() => jest.clearAllMocks());

describe('STAKE delta is proof-gated', () => {
  it('STAKE without stakeProof → delta 0 (no +5)', async () => {
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'STAKE' });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000); // unchanged
  });

  it('STAKE with a verified stakeProof → delta +5', async () => {
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'STAKE',
      stakeProof: { txHash: '0x' + 'b'.repeat(64), amountWei: '100000000000000' },
    });
    expect(r.delta).toBe(5);
    expect(r.repIdAfter).toBe(1005);
  });
});
