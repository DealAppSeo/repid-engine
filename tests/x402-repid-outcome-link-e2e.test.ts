/**
 * x402 settlement -> outcome -> RepID delta — the ASYMMETRIC LINK, end to end.
 *
 * WHAT THIS LOCKS. The harness claim is "pay-per-call settlement tied to
 * reputation". This suite composes the LIVE wired path — a settler produces an
 * x402 settlement row, a contract references it by `x402_payment_id`, and the
 * outcome/dispute touchpoints in `validation-repid-delta.ts` read that
 * settlement through the shared `isContractSimulated` gate — and pins the three
 * invariants that make the link honest rather than farmable:
 *
 *   1. POSITIVE.   A verified (real, non-simulated) settlement plus a
 *                  successful AUDITED outcome -> a POSITIVE provider RepID delta.
 *   2. NEGATIVE + ASYMMETRY. An agent-fault / failed-delivery outcome -> a
 *                  NEGATIVE delta whose magnitude is HEAVIER than the positive an
 *                  equivalent success earns. Reputation is earned gradually and
 *                  lost quickly; a single fault outweighs the deepest positive
 *                  touchpoint an agent can earn.
 *   3. NO-PROOF-NO-PAY. A settlement that is NOT a verified on-chain proof
 *                  (is_simulated=true — the mock/0xmock output a settler emits
 *                  when MOCK_FACILITATOR is on) -> ZERO reward, no score event.
 *                  Payment without a real proof moves no reputation.
 *
 * WHY THIS IS DISTINCT from the existing unit suites. `service-deltas-sim-gate`
 * drives the gate from a metadata flag and checks each touchpoint in isolation;
 * `x402-end-to-end` stops at the settlement and never asserts the RepID
 * consequence. Nothing before this test drives the gate from a SETTLER-PRODUCED
 * settlement row via `x402_payment_id`, nor asserts the cross-path asymmetry as
 * one economic lifecycle (the loss a single fault imposes exceeds the gain the
 * best positive lifecycle can produce).
 *
 * No real money, no live chain, no real DB: the settler is a pure fake and the
 * db is an in-memory registry keyed off the settlement rows the fake settler
 * emits. All agent ids are synthetic.
 */

// The outcome/dispote paths reach the DB only through isContractSimulated
// (service_contracts + x402_settlements lookups). Route those to an in-memory
// registry seeded by the fake settler; everything else is inert.
type FakeSettlement = { id: string; is_simulated: boolean; tx_hash: string | null };
type FakeContract = {
  id: string;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  x402_payment_id: string | null;
  provider_agent_id: string;
  buyer_agent_id: string;
  service_id: string;
};

const SETTLEMENTS = new Map<string, FakeSettlement>();
const CONTRACTS = new Map<string, FakeContract>();

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'service_contracts') {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => ({ data: CONTRACTS.get(val) ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === 'x402_settlements') {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: async () => ({ data: SETTLEMENTS.get(val) ?? null, error: null }),
            }),
          }),
        };
      }
      // Inert default for any incidental table access.
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    },
  },
}));

// Capture every delta the outcome path would apply, without touching a score.
jest.mock('../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(
    async (agent_id: string, event_type: string, delta: number, metadata: any) => {
      return { old_repid: 1000, new_repid: 1000 + delta, delta_applied: delta };
    },
  ),
  deriveHalDecision: jest.fn(() => 'clean'),
}));

import {
  applyServiceOutcomeDeltas,
  applyServiceDisputeResolution,
  type ServiceOutcomeRating,
} from '../src/services/validation-repid-delta';
import { applyValidationEvent } from '../src/scoring/pipeline';

const deltaCalls = () => (applyValidationEvent as jest.Mock).mock.calls;

// ── A minimal FAKE SETTLER: the shape of x402-real-settler's SettleResult ──
//
// A real on-chain transfer -> { status:'settled', tx_hash:'0x…', is_simulated:false }.
// A mock/simulated settle (MOCK_FACILITATOR) -> is_simulated:true, tx_hash:'0xmock…'.
// A failed settle -> pending_funding, no tx_hash. We model all three and persist
// the emitted row into the in-memory x402_settlements registry the gate reads.
type FakeSettleResult =
  | { status: 'settled'; tx_hash: string; is_simulated: boolean }
  | { settlement_source: 'pending_funding'; error: string };

function fakeSettler(mode: 'real' | 'simulated' | 'failed'): FakeSettleResult {
  if (mode === 'failed') {
    return { settlement_source: 'pending_funding', error: 'insufficient funds (fake)' };
  }
  if (mode === 'simulated') {
    return { status: 'settled', tx_hash: '0xmock' + '0'.repeat(58), is_simulated: true };
  }
  return { status: 'settled', tx_hash: '0x' + 'ab'.repeat(32), is_simulated: false };
}

let seq = 0;
/**
 * Compose: run the fake settler, persist its settlement row, and register a
 * contract that references it. Returns the contract the touchpoints will read.
 * A failed settle yields a contract with NO linked payment (x402_payment_id null).
 */
function settleAndBind(mode: 'real' | 'simulated' | 'failed'): FakeContract {
  seq += 1;
  const contractId = `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
  const result = fakeSettler(mode);

  let x402_payment_id: string | null = null;
  if ('status' in result && result.status === 'settled') {
    const settlementId = `settle-${seq}`;
    SETTLEMENTS.set(settlementId, {
      id: settlementId,
      is_simulated: result.is_simulated,
      tx_hash: result.tx_hash,
    });
    x402_payment_id = settlementId;
  }

  const contract: FakeContract = {
    id: contractId,
    metadata: {},
    payload: {},
    x402_payment_id,
    provider_agent_id: '00000000-0000-0000-0000-0000000000a1',
    buyer_agent_id: '00000000-0000-0000-0000-0000000000b2',
    service_id: '00000000-0000-0000-0000-0000000000c3',
  };
  CONTRACTS.set(contractId, contract);
  return contract;
}

function contractArg(c: FakeContract) {
  return {
    id: c.id,
    provider_agent_id: c.provider_agent_id,
    buyer_agent_id: c.buyer_agent_id,
    service_id: c.service_id,
  };
}

const BASELINE_RATER_REPID = 1000; // ESTABLISHED floor -> rater weight ~1.0x

beforeEach(() => {
  (applyValidationEvent as jest.Mock).mockClear();
  SETTLEMENTS.clear();
  CONTRACTS.clear();
  seq = 0;
});

// ── INVARIANT 1: verified settlement + audited success -> POSITIVE ──────────
describe('INVARIANT 1 — verified x402 settlement + successful audited outcome -> POSITIVE delta', () => {
  it('a real (is_simulated=false) settlement, good outcome -> positive provider delta + score event', async () => {
    const c = settleAndBind('real');
    // Guard the premise: the bound settlement really is a verified proof.
    expect(SETTLEMENTS.get(c.x402_payment_id!)!.is_simulated).toBe(false);

    const r = await applyServiceOutcomeDeltas(contractArg(c), 'good', BASELINE_RATER_REPID);

    expect(r.providerDelta).toBeGreaterThan(0);
    expect(r.scoreEventApplied).toBe(true);
    expect(deltaCalls()).toHaveLength(1);
    expect(deltaCalls()[0]![1]).toBe('SERVICE_OUTCOME');
    expect(deltaCalls()[0]![0]).toBe(c.provider_agent_id); // provider only
    expect(deltaCalls()[0]![2]).toBe(r.providerDelta);
  });
});

// ── INVARIANT 2: agent-fault -> NEGATIVE, heavier than the positive earns ───
describe('INVARIANT 2 — agent-fault / failed-delivery -> NEGATIVE, heavier than the success earns (asymmetry)', () => {
  it('bad outcome on a verified settlement -> negative provider delta + dispute-eligible flag', async () => {
    const c = settleAndBind('real');
    const r = await applyServiceOutcomeDeltas(contractArg(c), 'bad', BASELINE_RATER_REPID);

    expect(r.providerDelta).toBeLessThan(0);
    expect(r.disputeEligible).toBe(true);
    expect(r.scoreEventApplied).toBe(true);
  });

  it('the fault penalty is HEAVIER than the equivalent success reward (earned slowly, lost quickly)', async () => {
    const good = await applyServiceOutcomeDeltas(contractArg(settleAndBind('real')), 'good', BASELINE_RATER_REPID);
    const bad = await applyServiceOutcomeDeltas(contractArg(settleAndBind('real')), 'bad', BASELINE_RATER_REPID);

    expect(Math.abs(bad.providerDelta)).toBeGreaterThan(Math.abs(good.providerDelta));
    // and specifically: the negative base outweighs the positive base at equal weight.
    expect(Math.abs(bad.baseDelta)).toBeGreaterThan(Math.abs(good.baseDelta));
  });

  it('a fault-verdict dispute outweighs the deepest positive an agent can earn on one contract', async () => {
    // The best single-touchpoint positive is a good T3 outcome. A provider-at-fault
    // dispute must cost strictly more than that, or a confident failure is cheap.
    const good = await applyServiceOutcomeDeltas(contractArg(settleAndBind('real')), 'good', BASELINE_RATER_REPID);
    const bestPositive = good.providerDelta;

    (applyValidationEvent as jest.Mock).mockClear();
    const c = settleAndBind('real');
    await applyServiceDisputeResolution(contractArg(c), 'provider_at_fault');

    // provider row is the negative one; find it.
    const providerCall = deltaCalls().find((call) => call[0] === c.provider_agent_id);
    expect(providerCall).toBeDefined();
    const disputePenalty = providerCall![2] as number;
    expect(disputePenalty).toBeLessThan(0);
    expect(Math.abs(disputePenalty)).toBeGreaterThan(bestPositive);
  });

  it('a higher-rep rater makes the fault penalty MORE severe (rater-weighted)', async () => {
    const lowRep = await applyServiceOutcomeDeltas(contractArg(settleAndBind('real')), 'bad', 500);
    const highRep = await applyServiceOutcomeDeltas(contractArg(settleAndBind('real')), 'bad', 2000);
    expect(highRep.providerDelta).toBeLessThan(lowRep.providerDelta); // more negative
  });
});

// ── INVARIANT 3: no verified proof -> ZERO reward ───────────────────────────
describe('INVARIANT 3 — payment WITHOUT a verified proof -> ZERO reward (no-proof-no-pay)', () => {
  it('a SIMULATED settlement (is_simulated=true), good outcome -> ZERO delta, NO score event', async () => {
    const c = settleAndBind('simulated');
    expect(SETTLEMENTS.get(c.x402_payment_id!)!.is_simulated).toBe(true); // not a verified proof

    const r = await applyServiceOutcomeDeltas(contractArg(c), 'good', BASELINE_RATER_REPID);

    expect(r.providerDelta).toBe(0);
    expect(r.scoreEventApplied).toBe(false);
    expect(deltaCalls()).toHaveLength(0); // no reputation moved
  });

  it('a simulated settlement never lets a fault-verdict dispute move RepID either (the historical -100 leak stays closed)', async () => {
    const c = settleAndBind('simulated');
    await applyServiceDisputeResolution(contractArg(c), 'provider_at_fault');
    expect(deltaCalls()).toHaveLength(0);
  });

  it('a good rating still records the dispute-eligibility flag semantics unchanged on a simulated settle', async () => {
    // The gate zeroes the SCORE move, not the classification: a bad rating on a
    // simulated settle is still dispute-eligible (a flag), it just pays nothing.
    const c = settleAndBind('simulated');
    const r = await applyServiceOutcomeDeltas(contractArg(c), 'bad', BASELINE_RATER_REPID);
    expect(r.providerDelta).toBe(0);
    expect(r.scoreEventApplied).toBe(false);
    expect(r.disputeEligible).toBe(true);
  });
});

// ── COMPOSITE: one lifecycle — a single fault erases more than a good run earns
describe('COMPOSITE — the loss from one fault lifecycle exceeds the gain from one good lifecycle', () => {
  it('good outcome then, on another contract, a fault: net movement is negative', async () => {
    const good = await applyServiceOutcomeDeltas(contractArg(settleAndBind('real')), 'good', BASELINE_RATER_REPID);
    const bad = await applyServiceOutcomeDeltas(contractArg(settleAndBind('real')), 'bad', BASELINE_RATER_REPID);
    const net = good.providerDelta + bad.providerDelta;
    expect(net).toBeLessThan(0); // one good does not offset one fault
  });

  it('a failed settle (no settlement bound) — the outcome path still runs but this is the no-anchor case', async () => {
    // A failed settle produces NO x402_payment_id. The live gate then treats the
    // contract as non-simulated (fails OPEN), so a delta CAN apply. This documents
    // a real property of the wired path: the live gate blocks *simulated* proofs,
    // it does not by itself require a proof to exist. The stronger no-proof-no-pay
    // (demote-to-zero without any anchor) lives in the PURE library
    // outcome-classification.deltaFor and is covered in x402-outcome-link.test.ts;
    // it is NOT yet wired into this contract path. See the REAL vs STUB map.
    const c = settleAndBind('failed');
    expect(c.x402_payment_id).toBeNull();
    const r = await applyServiceOutcomeDeltas(contractArg(c), 'good', BASELINE_RATER_REPID);
    expect(r.providerDelta).toBeGreaterThan(0); // documents the gap, not an endorsement
  });
});
