/**
 * stake-delta-gate — engine-level proof gate for the STAKE delta.
 *
 * Drives the REAL updateRepId() with its layer + DB dependencies mocked, and
 * asserts the corrected honesty invariant (2026-07-21):
 *
 *   STAKE event WITHOUT a stakeProof            → delta 0
 *   STAKE event WITH a client-supplied stakeProof → delta 0  (UNVERIFIED, no +5)
 *
 * The prior version of this test asserted "+5 with a stakeProof" and called a raw
 * client-supplied txHash "verified" — that was the bug: the engine awarded +5 for
 * ANY caller string because no on-chain verifier existed (the advertised
 * /stake/onchain/verify route is not in the repo). Until a real server-side
 * verifier lands (fetch receipt → confirm `Staked` event → bind agentId → replay
 * guard), a client stakeProof earns nothing. The +5-on-genuinely-verified case is
 * captured as a pending TODO below and should be un-skipped when that route ships.
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

  it('STAKE with a client-supplied (UNVERIFIED) stakeProof → still delta 0', async () => {
    // A caller-controlled txHash is NOT proof of an on-chain stake. It must earn
    // nothing until a server-side verifier confirms the `Staked` event on-chain.
    const r = await updateRepId({
      agentId: 'agent-1',
      eventType: 'STAKE',
      stakeProof: { txHash: '0x' + 'b'.repeat(64), amountWei: '100000000000000' },
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000); // unchanged — no free +5 from a client string
  });

  // TODO(STAKE-VERIFY): un-skip when verifyStakeOnChain() exists and updateRepId
  // awards +5 only for a server-verified `Staked` event bound to this agentId.
  it.todo('STAKE with a SERVER-VERIFIED on-chain stake → delta +5');
});
