/**
 * confirmed-outcome ONE-TIME USE (replay-inert) — the server-verified confirmation receipt may
 * move the official score AT MOST ONCE (fix 2026-10-13, CWE-345 follow-up to Strix #1341).
 *
 * The move is gated by a CONDITIONAL, atomic claim in repid-update.ts::claimConfirmationReceipt:
 *   UPDATE kernel_receipts SET consumed_at = now() WHERE receipt_id = $1 AND consumed_at IS NULL
 * If this request claims the row the score moves; if the row is already consumed (zero rows) or the
 * write errors, the confirmation is held INERT. Fail-closed by construction.
 *
 * Proves (flag ON, a real server-verified holdout/VERIFIED receipt):
 *   (1) FIRST use  → claim succeeds → +gainBase moves; audit records receipt_consumed:true.
 *   (2) REPLAY     → same confirmationReceiptId again → claim matches zero rows → INERT (no move);
 *                    audit records score_moves:true but receipt_consumed:false (honest).
 *   (3) FAIL-CLOSED→ the claim write errors → INERT (no move), receipt_consumed:false.
 *
 * NON-VACUITY: make the claim UNCONDITIONAL in src/engine/repid-update.ts (drop
 * `.is('consumed_at', null)`) and case (2) goes RED — the replay would move the score again.
 *
 * Mock topology extends tests/confirmed-outcome-verifier-wiring.test.ts with the claim path.
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

const AGENT_ID = 'agent-1';
const inserted: any[] = [];
const updated: any[] = [];
const agentState = { id: AGENT_ID, agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };

// A single controllable kernel_receipts row plus counters/injection that model the CONDITIONAL claim.
const kr: {
  row: Record<string, unknown> | null;
  reads: number;
  claimAttempts: number;
  failClaim: boolean;
} = { row: null, reads: 0, claimAttempts: 0, failClaim: false };

jest.mock('../src/db', () => ({
  db: {
    from: jest.fn((table: string) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: agentState, error: null }),
              maybeSingle: async () => ({ data: agentState, error: null }),
            }),
          }),
          update: (payload: any) => ({ eq: async () => { updated.push(payload); return { error: null }; } }),
        };
      }
      if (table === 'kernel_receipts') {
        return {
          // resolveServerConfirmation read-verify path: .select().eq().maybeSingle()
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => {
                kr.reads++;
                return { data: kr.row && kr.row['receipt_id'] === id ? kr.row : null, error: null };
              },
            }),
          }),
          // claimConfirmationReceipt conditional-claim path: .update().eq().is().select()
          // Models Postgres `UPDATE ... WHERE receipt_id=$1 AND consumed_at IS NULL RETURNING ...`.
          update: (payload: Record<string, unknown>) => {
            kr.claimAttempts++;
            let targetId: string | null = null;
            let requireConsumedNull = false;
            const chain: any = {
              eq: (c: string, v: string) => { if (c === 'receipt_id') targetId = v; return chain; },
              is: (c: string, v: unknown) => { if (c === 'consumed_at' && v === null) requireConsumedNull = true; return chain; },
              select: async () => {
                if (kr.failClaim) return { data: null, error: { message: 'claim write failed' } };
                const row = kr.row;
                if (!row || row['receipt_id'] !== targetId) return { data: [], error: null };
                // The conditional predicate: only claim an unconsumed row.
                if (requireConsumedNull && row['consumed_at'] != null) return { data: [], error: null };
                kr.row = { ...row, ...payload }; // claim: stamp consumed_at
                return { data: [{ receipt_id: targetId }], error: null };
              },
            };
            return chain;
          },
        };
      }
      return { insert: async (row: any) => { inserted.push(row); return { error: null }; } };
    }),
  },
}));

import { updateRepId } from '../src/engine/repid-update';
import { __resetConfirmedParamsCache } from '../src/scoring/confirmed-outcome';
import { updateSupplyRate } from '../src/layers/ecosystem-need';
const updateSupplyRateMock = updateSupplyRate as jest.Mock;

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

/** A valid, actor-bound, SETTLED, VERIFIED (→ right), non-simulated, UNCONSUMED holdout receipt. */
function receiptRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt_id: 'rcpt-1',
    subject_agent_id: AGENT_ID,
    settled_by: 'holdout',
    verdict_label: 'SETTLED',
    verification_status: 'VERIFIED',
    is_simulated: false,
    consumed_at: null,
    ...over,
  };
}

const moveOnce = { settledBy: 'holdout' as const, result: 'right' as const, confirmationReceiptId: 'rcpt-1' };

beforeEach(() => {
  for (const k of Object.keys(PINNED)) { SAVED[k] = process.env[k]; process.env[k] = PINNED[k]; }
  __resetConfirmedParamsCache();
  agentState.current_repid = 1000;
  agentState.activity_30d = 5;
  kr.row = null;
  kr.reads = 0;
  kr.claimAttempts = 0;
  kr.failClaim = false;
  process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true';
});
afterEach(() => {
  jest.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  for (const k of Object.keys(PINNED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  if (SAVED_FLAG === undefined) delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED; else process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = SAVED_FLAG;
  __resetConfirmedParamsCache();
});

describe('(1) FIRST use claims the receipt and moves the score', () => {
  it('a server-verified holdout/right receipt → +5, writes, and marks receipt_consumed:true', async () => {
    kr.row = receiptRow();
    const r = await updateRepId({ agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: moveOnce });
    expect(kr.reads).toBe(1);
    expect(kr.claimAttempts).toBe(1); // the claim was actually attempted (non-vacuity)
    expect(r.delta).toBe(5);
    expect(r.repIdAfter).toBe(1005);
    expect(updated.length).toBe(1);
    expect(updateSupplyRateMock).toHaveBeenCalledTimes(1);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.score_moves).toBe(true);
    expect(row.metadata.confirmed_outcome.receipt_consumed).toBe(true);
    // the row is now stamped consumed
    expect(kr.row?.consumed_at).toBeTruthy();
  });
});

describe('(2) REPLAY of the same receiptId is INERT', () => {
  it('second use with the same confirmationReceiptId does not move the score', async () => {
    kr.row = receiptRow();

    const first = await updateRepId({ agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: moveOnce });
    expect(first.delta).toBe(5); // baseline: first use moved
    inserted.length = 0;
    updated.length = 0;

    const replay = await updateRepId({ agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: moveOnce });
    expect(kr.claimAttempts).toBe(2);       // the claim was attempted again...
    expect(replay.delta).toBe(0);           // ...but matched zero rows → no move
    expect(replay.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);         // no repid_agents write on the replay
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.score_moves).toBe(true);   // the outcome WOULD move,
    expect(row.metadata.confirmed_outcome.receipt_consumed).toBe(false); // but the receipt was spent
  });
});

describe('(3) a FAILED claim write is INERT (fail closed)', () => {
  it('a DB error on the conditional claim does not move the score', async () => {
    kr.row = receiptRow();
    kr.failClaim = true;
    const r = await updateRepId({ agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: moveOnce });
    expect(kr.claimAttempts).toBe(1);
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.receipt_consumed).toBe(false);
    // the row is NOT stamped consumed when the claim fails
    expect(kr.row?.consumed_at).toBeNull();
  });
});
