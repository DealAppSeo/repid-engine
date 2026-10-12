/**
 * confirmed-outcome-pipeline.test.ts — the flag wiring inside the REAL updateRepId().
 *
 * Proves the three things the lane must guarantee:
 *   (1) OFF == TODAY. With CONFIRMED_OUTCOME_SCORING_ENABLED unset, an event that
 *       carries a confirmedOutcome payload scores EXACTLY as the same event without it
 *       — the payload is ignored and nothing new is recorded.
 *   (2) ON GOVERNS. With the flag ON, the confirmed-outcome delta moves current_repid.
 *   (3) UNCONFIRMED IS INERT. A 2-1 vote / abstain / fail-closed counterparty leaves
 *       current_repid AND activity_30d untouched and runs NO operational side-effects,
 *       exactly like a shadow-deception hold.
 *
 * Mirrors tests/trust-keystone-deception.test.ts's mock topology so only the
 * confirmed-outcome branch varies.
 */

// Neutralize the other scoring layers.
jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
  updateSupplyRate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: jest.fn() }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid, // no decay
  computeRedemptionModifier: jest.fn().mockResolvedValue(1.0), // no redemption damping
}));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: jest.fn().mockResolvedValue({
    enabled: false, passed: null, complianceScore: null, rulesChecked: [],
    halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0,
    mirrorTestPassed: true,
  }),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: jest.fn().mockResolvedValue([]) }));

const inserted: any[] = [];
const updated: any[] = [];
const agentState = { id: 'agent-1', agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };
jest.mock('../src/db', () => ({
  db: {
    from: jest.fn((table: string) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: agentState, error: null }) }) }),
          update: (payload: any) => ({ eq: async () => { updated.push(payload); return { error: null }; } }),
        };
      }
      return { insert: async (row: any) => { inserted.push(row); return { error: null }; } };
    }),
  },
}));

import { updateRepId } from '../src/engine/repid-update';
import { __resetConfirmedParamsCache } from '../src/scoring/confirmed-outcome';
import { updateSupplyRate } from '../src/layers/ecosystem-need';
import { checkAndAwardBadges } from '../src/engine/badges';
const updateSupplyRateMock = updateSupplyRate as jest.Mock;
const checkAndAwardBadgesMock = checkAndAwardBadges as jest.Mock;

const PINNED: Record<string, string> = {
  REPID_CONFIRMED_GAIN_BASE: '5',
  REPID_CONFIRMED_LOSS_BASE: '-15',
  REPID_CONFIRMED_CONFIDENCE_LOSS_WEIGHT: '40',
  REPID_CONFIRMED_RUBBER_STAMP_PENALTY: '-120',
  REPID_CONFIRMED_BAND_TIGHTEN_BASE: '-8',
  REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR: '0.5',
  REPID_CONFIRMED_NEED_WEIGHT_CAP: '2',
};
const SAVED: Record<string, string | undefined> = {};
const SAVED_FLAG = process.env.CONFIRMED_OUTCOME_SCORING_ENABLED;
const SAVED_SR = process.env.SELF_REPORT_EVIDENCE_MODE;

beforeEach(() => {
  for (const k of Object.keys(PINNED)) { SAVED[k] = process.env[k]; process.env[k] = PINNED[k]; }
  __resetConfirmedParamsCache();
  agentState.current_repid = 1000;
  agentState.activity_30d = 5;
});
afterEach(() => {
  jest.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  for (const k of Object.keys(PINNED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  if (SAVED_FLAG === undefined) delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED; else process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = SAVED_FLAG;
  if (SAVED_SR === undefined) delete process.env.SELF_REPORT_EVIDENCE_MODE; else process.env.SELF_REPORT_EVIDENCE_MODE = SAVED_SR;
  __resetConfirmedParamsCache();
});

// A confirmed-wrong payload that WOULD score -55 if the flag were ON.
const confirmedWrongPayload = { settledBy: 'holdout' as const, result: 'wrong' as const, confidence: 1 };

describe('(1) OFF == TODAY', () => {
  it('flag OFF: an UNSUPPORTED_CLAIM scores -8 whether or not it carries a confirmedOutcome payload', async () => {
    delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED; // OFF

    const withoutPayload = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM' });
    expect(withoutPayload.delta).toBe(-8);
    expect(withoutPayload.repIdAfter).toBe(992);
    expect(withoutPayload.confirmedOutcome ?? null).toBeNull();

    const withPayload = await updateRepId({
      agentId: 'agent-1',
      eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: confirmedWrongPayload, // ignored while OFF
    });
    // Byte-for-byte the same movement: the payload changed nothing.
    expect(withPayload.delta).toBe(withoutPayload.delta);
    expect(withPayload.repIdAfter).toBe(withoutPayload.repIdAfter);
    expect(withPayload.confirmedOutcome ?? null).toBeNull();

    // And the audit row records no confirmed_outcome block while OFF.
    const row = inserted.find((i) => i.metadata?.confirmed_outcome !== undefined);
    expect(row?.metadata.confirmed_outcome ?? null).toBeNull();
  });

  it('flag explicitly "false" is also OFF', async () => {
    process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'false';
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: confirmedWrongPayload });
    expect(r.delta).toBe(-8);
    expect(r.confirmedOutcome ?? null).toBeNull();
  });
});

describe('(2) ON governs the official score', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('a confirmed RIGHT moves the score up by the small gain', async () => {
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'known_answer', result: 'right' },
    });
    expect(r.delta).toBe(5);
    expect(r.repIdAfter).toBe(1005);
    expect(r.confirmedOutcome?.verdictLabel).toBe('SETTLED');
    expect(updated.length).toBe(1); // the score was written
    expect(updateSupplyRateMock).toHaveBeenCalledTimes(1);
  });

  it('a confirmed CONFIDENT WRONG moves the score down by the larger loss', async () => {
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: confirmedWrongPayload,
    });
    expect(r.delta).toBe(-55);
    expect(r.repIdAfter).toBe(945);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.score_moves).toBe(true);
    expect(row.metadata.confirmed_outcome.settled_by).toBe('holdout');
  });

  it('need CANNOT raise the ceiling: a confirmed right near the cap still clamps to 10000', async () => {
    agentState.current_repid = 9999;
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right', domain: 'law' },
      confirmedOutcomeDeps: { domainNeedWeight: async () => 1000 }, // enormous need
    });
    // The need multiplier is capped and the score is clamped — it never exceeds 10000.
    expect(r.repIdAfter).toBe(10000);
    expect(r.confirmedOutcome?.needMultiplierApplied).toBe(2);
  });
});

describe('(3) UNCONFIRMED is INERT (no move, no side-effects)', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('a 2-1 vote is PROVISIONAL: current_repid AND activity_30d untouched, no supply/badge writes', async () => {
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'vote', result: 'wrong', confidence: 1 },
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000); // unchanged
    expect(updated.length).toBe(0); // no repid_agents write → activity_30d untouched
    expect(updateSupplyRateMock).not.toHaveBeenCalled();
    expect(checkAndAwardBadgesMock).not.toHaveBeenCalled();
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.delta).toBe(0);
    expect(row.repid_before).toBe(1000);
    expect(row.repid_after).toBe(1000);
    expect(row.metadata.confirmed_outcome.verdict_label).toBe('PROVISIONAL');
    expect(row.metadata.confirmed_outcome.score_moves).toBe(false);
  });

  it('abstain is free (inert)', async () => {
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'abstain' },
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);
  });

  it('a counterparty that cannot be shown independent fails closed to no move', async () => {
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'counterparty', result: 'wrong', confidence: 1, counterpartyAgentId: 'cp-1' },
      // model family unreadable → independence cannot be established → fail closed
      confirmedOutcomeDeps: {
        resolveOwner: async (id: string) => ({ status: 'resolved' as const, ownerKey: id === 'agent-1' ? 'A' : 'B' }),
        readModelFamily: async () => null,
      },
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.confirmed).toBe(false);
  });

  it('CONTROL: an independent counterparty DOES move the score (proving the inertness is specific)', async () => {
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'counterparty', result: 'wrong', confidence: 1, counterpartyAgentId: 'cp-1' },
      confirmedOutcomeDeps: {
        resolveOwner: async (id: string) => ({ status: 'resolved' as const, ownerKey: id === 'agent-1' ? 'A' : 'B' }),
        readModelFamily: async (id: string) => (id === 'agent-1' ? 'llama' : 'gemini'),
      },
    });
    expect(r.delta).toBe(-55);
    expect(r.repIdAfter).toBe(945);
    expect(updated.length).toBe(1);
  });
});
