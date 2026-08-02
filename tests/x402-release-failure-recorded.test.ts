/**
 * A failed payment release must leave a trace.
 *
 * OBSERVED LIVE 2026-08-02, contract 2e89cea0-c540-4a19-8adc-47df56cf5be1: the
 * facilitator threw on the first release, the state machine handed the
 * authorization back correctly, an immediate retry settled, and nothing was
 * double-spent (settlement_attempt_count stayed 1, one tx on chain). The state
 * machine did its job.
 *
 * What it did NOT do was record any of it. Nothing in x402_settlement_failures
 * (newest row was from June), nothing in the audit chain, no log line. The
 * failure existed only in the body of the HTTP response that failed — so after
 * the fact it was unanswerable how often release fails, and a contract can sit
 * `fulfilled` with the provider delivered-and-unpaid until somebody happens to
 * retry. On the UI path, one error a user walks away from strands it silently.
 *
 * The sibling SETTLED_UNRECORDED branch already shouts. This one was mute.
 *
 * Covers: FAILED is returned, the row is handed back to 'authorized' so a retry
 * is possible, a durable failure row is written, and the NOT NULL columns the
 * live table actually requires are all populated.
 */

interface Update {
  table: string;
  patch: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
}
const state = {
  held: null as any,
  updates: [] as Update[],
  inserts: [] as Array<{ table: string; row: any }>,
  insertError: null as any,
  claimReturnsRow: true,
};

function makeQuery(table: string) {
  const q: any = {};
  const eqs: Array<[string, unknown]> = [];
  let pendingPatch: Record<string, unknown> | null = null;

  q.select = () => q;
  q.eq = (col: string, val: unknown) => {
    eqs.push([col, val]);
    return q;
  };
  q.maybeSingle = async () => {
    if (pendingPatch) {
      state.updates.push({ table, patch: pendingPatch, eqs: [...eqs] });
      const claimed = state.claimReturnsRow ? { id: state.held?.id } : null;
      pendingPatch = null;
      return { data: claimed, error: null };
    }
    return { data: state.held, error: null };
  };
  q.single = q.maybeSingle;
  q.update = (patch: Record<string, unknown>) => {
    pendingPatch = patch;
    return q;
  };
  q.insert = async (row: any) => {
    state.inserts.push({ table, row });
    return { data: null, error: state.insertError };
  };
  // Terminal await on an update with no .select()/.maybeSingle().
  q.then = (resolve: any) => {
    if (pendingPatch) {
      state.updates.push({ table, patch: pendingPatch, eqs: [...eqs] });
      pendingPatch = null;
    }
    return resolve({ data: null, error: null });
  };
  return q;
}

jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

const settlePayment = jest.fn();
jest.mock('../src/services/x402-facilitator', () => ({
  x402Facilitator: {
    settlePayment: (...a: unknown[]) => settlePayment(...a),
    buildPaymentRequirements: jest.fn(),
  },
}));

import { releaseHeldPayment, SETTLEMENT_STATUS } from '../src/services/x402-deferred-settlement';

// A header with a window wide enough that assessAuthorization passes.
const HEADER = Buffer.from(
  JSON.stringify({
    payload: { authorization: { from: '0xabc', validAfter: '0', validBefore: '99999999999' } },
  }),
).toString('base64');

const REQUIREMENTS = [{ asset: '0xusdc', payTo: '0xprovider', maxAmountRequired: '100000' }] as any;

beforeEach(() => {
  state.held = {
    id: 'settle-1',
    status: SETTLEMENT_STATUS.AUTHORIZED,
    tx_hash: null,
    x_payment_header: HEADER,
    is_simulated: false,
  };
  state.updates = [];
  state.inserts = [];
  state.insertError = null;
  state.claimReturnsRow = true;
  settlePayment.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

async function release() {
  return releaseHeldPayment({
    contractId: 'contract-1',
    requirements: REQUIREMENTS,
    deliverableVerified: true,
    verificationEvidence: 'verdict=PASS satisfaction=1',
  });
}

describe('release failure — the money path must not fail silently', () => {
  it('returns FAILED with the facilitator reason rather than a bare throw', async () => {
    settlePayment.mockRejectedValue(new Error('facilitator 502 upstream timeout'));
    const r = await release();
    expect(r.status).toBe('FAILED');
    expect((r as any).reason).toMatch(/facilitator 502 upstream timeout/);
  });

  it('hands the authorization back to AUTHORIZED so a retry can succeed', async () => {
    settlePayment.mockRejectedValue(new Error('boom'));
    await release();
    const handBack = state.updates.find(
      (u) => u.patch.status === SETTLEMENT_STATUS.AUTHORIZED,
    );
    expect(handBack).toBeDefined();
    // Guarded on SETTLING so it can never resurrect a row someone else settled.
    expect(handBack!.eqs).toContainEqual(['status', SETTLEMENT_STATUS.SETTLING]);
  });

  it('writes a durable failure row — the gap this test exists for', async () => {
    settlePayment.mockRejectedValue(new Error('facilitator 502 upstream timeout'));
    await release();
    const failure = state.inserts.find((i) => i.table === 'x402_settlement_failures');
    expect(failure).toBeDefined();
    expect(failure!.row.idempotency_key).toBe('contract-1');
    expect(failure!.row.facilitator_response.error).toMatch(/upstream timeout/);
  });

  it('populates every column the live table declares NOT NULL', async () => {
    // direction, payment_payload_b64, payment_requirements, attempt_count and
    // last_attempted_at are NOT NULL per information_schema. The first draft
    // omitted payment_payload_b64 and would have thrown inside the catch that
    // exists to make the failure visible — losing the record twice over.
    settlePayment.mockRejectedValue(new Error('boom'));
    await release();
    const row = state.inserts.find((i) => i.table === 'x402_settlement_failures')!.row;
    for (const col of [
      'direction',
      'payment_payload_b64',
      'payment_requirements',
      'attempt_count',
      'last_attempted_at',
    ]) {
      expect(row[col]).toBeDefined();
      expect(row[col]).not.toBeNull();
    }
    expect(row.payment_payload_b64).toBe(HEADER);
  });

  it('still reports FAILED if the bookkeeping insert itself fails', async () => {
    // A failure to record must never mask the real failure or throw out of the
    // catch that is busy handing the authorization back.
    settlePayment.mockRejectedValue(new Error('boom'));
    state.insertError = { message: 'failures table unreachable' };
    const r = await release();
    expect(r.status).toBe('FAILED');
    expect(
      state.updates.some((u) => u.patch.status === SETTLEMENT_STATUS.AUTHORIZED),
    ).toBe(true);
  });

  it('records nothing on a SUCCESSFUL release', async () => {
    settlePayment.mockResolvedValue({ txHash: '0xgood' });
    const r = await release();
    expect(r.status).toBe('SETTLED');
    expect(state.inserts.find((i) => i.table === 'x402_settlement_failures')).toBeUndefined();
  });
});
