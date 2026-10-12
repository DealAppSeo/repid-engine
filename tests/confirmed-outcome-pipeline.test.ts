/**
 * confirmed-outcome-pipeline.test.ts — the flag wiring inside the REAL updateRepId(),
 * after the CWE-345 fail-closed fix.
 *
 * Proves:
 *   (1) OFF == TODAY. With CONFIRMED_OUTCOME_SCORING_ENABLED unset, an event that
 *       carries a confirmedOutcome payload scores EXACTLY as the same event without it.
 *   (2) CALLER-ASSERTED NEVER MOVES (CWE-345). With the flag ON, a confirmedOutcome from
 *       the request body moves NOTHING — for every settler kind — because the pipeline
 *       supplies no server-derived verifiedConfirmation (none is wired yet). The outcome
 *       is RECORDED for audit and held INERT (no delta, no activity bump, no side-effects).
 *   (3) The inert-hold is SPECIFIC: a normal event still scores with the flag ON.
 *
 * The positive policy (a server-verified confirmation DOES move the score by the rule
 * deltas) is proven at the unit level in confirmed-outcome.test.ts; it cannot be driven
 * from this pipeline because the server verifier is deliberately not reachable from a
 * caller. Non-vacuity for the boundary is a mutation check (see the report).
 *
 * Mirrors tests/trust-keystone-deception.test.ts's mock topology.
 */

jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
  updateSupplyRate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: jest.fn() }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid,
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
  __resetConfirmedParamsCache();
});

// A confirmed-wrong payload that WOULD score -55 if a SERVER verifier confirmed it.
const confirmedWrongPayload = { settledBy: 'holdout' as const, result: 'wrong' as const, confidence: 1 };

describe('(1) OFF == TODAY', () => {
  it('flag OFF: an UNSUPPORTED_CLAIM scores -8 whether or not it carries a confirmedOutcome payload', async () => {
    delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED;
    const withoutPayload = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM' });
    expect(withoutPayload.delta).toBe(-8);
    expect(withoutPayload.repIdAfter).toBe(992);
    expect(withoutPayload.confirmedOutcome ?? null).toBeNull();

    const withPayload = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: confirmedWrongPayload,
    });
    expect(withPayload.delta).toBe(withoutPayload.delta);
    expect(withPayload.repIdAfter).toBe(withoutPayload.repIdAfter);
    expect(withPayload.confirmedOutcome ?? null).toBeNull();

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

describe('(2) CWE-345 — a CALLER-ASSERTED confirmedOutcome NEVER moves the score (flag ON)', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it.each([
    ['holdout right', { settledBy: 'holdout' as const, result: 'right' as const }],
    ['known_answer right', { settledBy: 'known_answer' as const, result: 'right' as const }],
    ['person right', { settledBy: 'person' as const, result: 'right' as const }],
    ['vote wrong', { settledBy: 'vote' as const, result: 'wrong' as const, confidence: 1 }],
    ['rubber-stamp known-wrong', { settledBy: 'known_answer' as const, result: 'wrong' as const, rubberStampKnownWrong: true }],
    ['unsupported pass', { settledBy: 'holdout' as const, result: 'right' as const, passUnsupportedByReceipt: true }],
    ['abstain', { settledBy: 'holdout' as const, result: 'abstain' as const }],
  ])('%s → inert: no delta, no write, no side-effects', async (_name, payload) => {
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: payload });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000); // unchanged
    expect(updated.length).toBe(0); // no repid_agents write → activity_30d untouched
    expect(updateSupplyRateMock).not.toHaveBeenCalled();
    expect(checkAndAwardBadgesMock).not.toHaveBeenCalled();
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.delta).toBe(0);
    expect(row.repid_before).toBe(1000);
    expect(row.repid_after).toBe(1000);
    expect(row.metadata.confirmed_outcome.confirmed).toBe(false);
    expect(row.metadata.confirmed_outcome.score_moves).toBe(false);
  });

  it('an INDEPENDENT counterparty from the request body is STILL inert (no server verification)', async () => {
    const r = await updateRepId({
      agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'counterparty', result: 'wrong', confidence: 1, counterpartyAgentId: 'cp-1' },
      confirmedOutcomeDeps: {
        resolveOwner: async (id: string) => ({ status: 'resolved' as const, ownerKey: id === 'agent-1' ? 'A' : 'B' }),
        readModelFamily: async (id: string) => (id === 'agent-1' ? 'llama' : 'gemini'),
      },
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.reason).toBe('confirmation_not_server_verified');
    expect(row.metadata.confirmed_outcome.detail.serverVerified).toBe(false);
  });
});

describe('(3) the inert-hold is SPECIFIC, not a global freeze', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('flag ON but NO confirmedOutcome payload → a normal event still scores (-8) and writes', async () => {
    const r = await updateRepId({ agentId: 'agent-1', eventType: 'UNSUPPORTED_CLAIM' });
    expect(r.delta).toBe(-8);
    expect(r.repIdAfter).toBe(992);
    expect(updated.length).toBe(1);
    expect(updateSupplyRateMock).toHaveBeenCalledTimes(1);
    expect(r.confirmedOutcome ?? null).toBeNull();
  });
});
