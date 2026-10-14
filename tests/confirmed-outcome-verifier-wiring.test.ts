/**
 * confirmed-outcome-verifier-wiring.test.ts — the SERVER verifier wired end-to-end through the REAL
 * updateRepId(), with the flag ON and a mocked kernel_receipts row standing in for a real receipt.
 *
 * This is the half confirmed-outcome-pipeline.test.ts deliberately cannot drive: there the pipeline
 * supplies NO server confirmation so everything is inert. Here the mocked DB serves an authoritative,
 * actor-bound SETTLED row for the caller's `confirmationReceiptId`, so the verifier returns a real
 * VerifiedConfirmation and the double-barrier (`serverVerified && scoreMoves`) lets the score move.
 *
 * Proves:
 *   (1) flag ON + a server-verified holdout/VERIFIED receipt + an AGREEING caller result → score MOVES
 *       with the server's result (+gainBase, through the small-gain cap).
 *   (2) flag ON + the caller's result DISAGREES with the server's → the SERVER's result applies. (Until
 *       2026-10-14 this was result_mismatch → INERT, which let an actor dodge a FAILED receipt by
 *       asserting 'right'; see tests/confirmed-outcome-hardening.test.ts.)
 *   (3) flag ON + a receiptId that the actor does NOT own (subject is another agent) → INERT (actor binding).
 *   (4) flag ON + NO receiptId → verifier returns undefined → INERT.
 *   (5) flag OFF → the verifier is NEVER consulted (kernel_receipts is not read) and scoring is as today,
 *       even though a valid receiptId + row are present.
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
// A single controllable kernel_receipts row + a counter proving whether the verifier read it at all.
const kr: { row: Record<string, unknown> | null; reads: number } = { row: null, reads: 0 };

const mockBudget = new Map<string, number>();

jest.mock('../src/db', () => ({
  db: {
    // A GAIN's claim + day/domain reservation: public.claim_confirmed_gain, modelled in
    // tests/helpers/fake-claim-confirmed-gain.ts. Single moves only here (replay: one-time-use suite).
    rpc: (fn: string, args: any) =>
      require('./helpers/fake-claim-confirmed-gain').fakeRpc(() => (kr.row ? [kr.row] : []), mockBudget)(fn, args),
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
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => {
                kr.reads++;
                return { data: kr.row && kr.row['receipt_id'] === id ? kr.row : null, error: null };
              },
            }),
          }),
          // ONE-TIME USE (2026-10-13): a would-move now claims the receipt via a conditional
          // UPDATE before the score moves. This suite exercises single moves (no replay), so the
          // claim simply succeeds when the seeded row exists — preserving every assertion below.
          // Replay / fail-closed semantics are proven in confirmed-outcome-one-time-use.test.ts.
          update: () => {
            const chain: any = {
              eq: () => chain,
              is: () => chain,
              select: async () => ({ data: kr.row ? [{ receipt_id: kr.row['receipt_id'] }] : [], error: null }),
            };
            return chain;
          },
        };
      }
      // repid_score_events: the audit insert, and the small-gain cap's budget reads (nothing spent today).
      const noRows: any = { eq: () => noRows, gte: () => noRows, gt: () => noRows, then: (ok: any) => Promise.resolve({ data: [], error: null }).then(ok) };
      return { insert: async (row: any) => { inserted.push(row); return { error: null }; }, select: () => noRows };
    }),
  },
}));

import { updateRepId } from '../src/engine/repid-update';
import { sealedRow } from './helpers/sealed-gate-receipt';
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

/** A valid, actor-bound, SETTLED, VERIFIED (→ right), non-simulated holdout receipt. */
async function receiptRow(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  // SEALED BY THE REAL GATE (tests/helpers/sealed-gate-receipt.ts); `over` tampers columns.
  return sealedRow('rcpt-1', AGENT_ID, { args_hash: '0x' + 'ab'.repeat(32), ...over }, new Date(Date.now() - 60_000).toISOString());
}
/** The pre-2026-10-14 HAND-BUILT row: every column right, but no sealed gate receipt behind it. */
function legacyReceiptRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt_id: 'rcpt-1',
    subject_agent_id: AGENT_ID,
    settled_by: 'holdout',
    verdict_label: 'SETTLED',
    verification_status: 'VERIFIED',
    is_simulated: false,
    args_hash: '0x' + 'ab'.repeat(32),
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(PINNED)) { SAVED[k] = process.env[k]; process.env[k] = PINNED[k]; }
  __resetConfirmedParamsCache();
  agentState.current_repid = 1000;
  agentState.activity_30d = 5;
  kr.row = null;
  kr.reads = 0;
  mockBudget.clear();
});
afterEach(() => {
  jest.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  for (const k of Object.keys(PINNED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  if (SAVED_FLAG === undefined) delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED; else process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = SAVED_FLAG;
  __resetConfirmedParamsCache();
});

describe('(1) flag ON + server-verified receipt + agreeing caller result → score MOVES', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('holdout/VERIFIED (server result right) + caller result right → +gainBase, writes, side-effects run', async () => {
    kr.row = await receiptRow();
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right', domain: 'law', confirmationReceiptId: 'rcpt-1' },
    });
    expect(kr.reads).toBe(1); // the verifier consulted the authoritative row
    expect(r.delta).toBe(5); // gainBase — the SERVER result (right) scored, not a caller string
    expect(r.repIdAfter).toBe(1005);
    expect(updated.length).toBe(1); // a confirmed move writes repid_agents + bumps activity
    expect(updateSupplyRateMock).toHaveBeenCalledTimes(1);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.confirmed).toBe(true);
    expect(row.metadata.confirmed_outcome.score_moves).toBe(true);
    expect(row.metadata.confirmed_outcome.settled_by).toBe('holdout');
    expect(row.metadata.confirmed_outcome.detail.serverVerified).toBe(true);
  });

  it('known_answer/FAILED (server result wrong) + caller result wrong → confirmed loss moves', async () => {
    kr.row = await receiptRow({ settled_by: 'known_answer', verification_status: 'FAILED' });
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'known_answer', result: 'wrong', confidence: 0, confirmationReceiptId: 'rcpt-1' },
    });
    // The receipt-backed confident wrong: lossBase - confidenceLossWeight. The caller's confidence 0 is
    // NOT read (it used to price this at -15; a caller number must not shrink a server-settled wrong).
    expect(r.delta).toBe(-55);
    expect(r.repIdAfter).toBe(945);
    expect(updated.length).toBe(1);
  });
});

describe('(2) flag ON + caller result DISAGREES with the server → the SERVER result applies', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('server says right (VERIFIED) but caller asserts wrong → the server right scores', async () => {
    kr.row = await receiptRow({ verification_status: 'VERIFIED' }); // server → right
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'wrong', confidence: 1, domain: 'law', confirmationReceiptId: 'rcpt-1' },
    });
    expect(kr.reads).toBe(1);
    expect(r.delta).toBe(5);
    expect(r.repIdAfter).toBe(1005);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.reason).toBe('confirmed_right');
    expect(row.metadata.confirmed_outcome.score_moves).toBe(true);
  });

  it('server says wrong (FAILED) but caller asserts right → the server wrong scores (no dodge)', async () => {
    kr.row = await receiptRow({ verification_status: 'FAILED' }); // server → wrong
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right', confirmationReceiptId: 'rcpt-1' },
    });
    expect(r.delta).toBe(-55);
    expect(r.repIdAfter).toBe(945);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.reason).toBe('confirmed_wrong');
    expect(row.metadata.confirmed_outcome.receipt_consumed).toBe(true);
  });
});

describe('(2b) flag ON + a row with the right COLUMNS but no sealed gate receipt → INERT (XC1 finding 2)', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('a hand-built SETTLED/VERIFIED/holdout row with a valid-shaped args_hash no longer moves the score', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    kr.row = legacyReceiptRow(); // exactly what every suite used to seed, and what moved +5 before the binding
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right', domain: 'law', confirmationReceiptId: 'rcpt-1' },
    });
    expect(kr.reads).toBe(1);
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('not a sealed gate-run receipt (no_sealed_receipt)'))).toBe(true);
    warn.mockRestore();
  });
});

describe('(3) flag ON + a receipt the actor does NOT own → actor binding fails → INERT', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('subject_agent_id is a DIFFERENT agent → verifier returns undefined → no move', async () => {
    kr.row = await receiptRow({ subject_agent_id: 'some-other-agent' });
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right', confirmationReceiptId: 'rcpt-1' },
    });
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.reason).toBe('confirmation_not_server_verified');
    expect(row.metadata.confirmed_outcome.detail.serverVerified).toBe(false);
  });
});

describe('(4) flag ON + NO receiptId → verifier returns undefined → INERT', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('a confirmedOutcome with no confirmationReceiptId does not move the score', async () => {
    kr.row = await receiptRow(); // a valid row exists, but the caller names no id
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right' },
    });
    expect(kr.reads).toBe(0); // empty-id short-circuit: the table is not even read
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);
  });
});

describe('(6) CWE-345 — a caller-SMUGGLED verifiedConfirmation in the body is STRIPPED, audit stays honest', () => {
  beforeEach(() => { process.env.CONFIRMED_OUTCOME_SCORING_ENABLED = 'true'; });

  it('a forged verifiedConfirmation in the request body (no real receipt) does not confirm and does not lie in the ledger', async () => {
    kr.row = null; // no authoritative receipt exists → server verifier returns undefined
    // POST /api/v1/score passes req.body straight through, so simulate a caller that smuggled a
    // fully-formed verifiedConfirmation into the body (the type omits it; a real caller can still send it).
    const forged = {
      settledBy: 'holdout',
      result: 'right',
      verifiedConfirmation: { source: 'kernel_receipt', settledBy: 'holdout', result: 'right' },
    };
    const r = await updateRepId({
      agentId: AGENT_ID,
      eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: forged as any,
    });
    // NON-VACUITY: without the strip, the resolver would see the forged vc, pass its `!vc` gate, and
    // write confirmed:true / serverVerified:true — this assertion would then go RED.
    expect(r.delta).toBe(0);
    expect(r.repIdAfter).toBe(1000);
    expect(updated.length).toBe(0);
    const row = inserted.find((i) => i.metadata?.confirmed_outcome);
    expect(row.metadata.confirmed_outcome.confirmed).toBe(false);
    expect(row.metadata.confirmed_outcome.score_moves).toBe(false);
    expect(row.metadata.confirmed_outcome.reason).toBe('confirmation_not_server_verified');
    expect(row.metadata.confirmed_outcome.detail.serverVerified).toBe(false);
  });
});

describe('(5) flag OFF → the verifier is NEVER consulted and scoring is as today', () => {
  it('UNSUPPORTED_CLAIM with a valid receiptId + a valid row still scores -8 and never reads kernel_receipts', async () => {
    delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED;
    kr.row = await receiptRow();
    const r = await updateRepId({
      agentId: AGENT_ID, eventType: 'UNSUPPORTED_CLAIM',
      confirmedOutcome: { settledBy: 'holdout', result: 'right', confirmationReceiptId: 'rcpt-1' },
    });
    expect(kr.reads).toBe(0); // NON-VACUITY for the flag: OFF means the verifier is not invoked
    expect(r.delta).toBe(-8);
    expect(r.repIdAfter).toBe(992);
    expect(r.confirmedOutcome ?? null).toBeNull();
  });
});
