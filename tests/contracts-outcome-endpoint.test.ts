/**
 * T3 — POST /api/v1/contracts/:id/outcome endpoint tests.
 *
 * Mounts ONLY the contracts router on a bare express app (bypasses global
 * auth/versioning, same pattern as federation.test.ts). db + the delta service
 * are mocked so we can assert the gate logic precisely:
 *   - time-gate: reject <24h (425) and >7d (410)
 *   - buyer-only auth: non-buyer rater → 403
 *   - not settled → 409; invalid rating → 400
 *   - absence-neutral: no request ⇒ nothing happens (delta fn never called)
 *   - happy path (inside window, buyer) → applies delta + records outcome
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Mutable test state the db mock reads at call time.
const state: {
  contract: any;
  rater: any;
  existingOutcome: any;
  inserted: any[];
  updated: any[];
  insertFails: boolean;
} = { contract: null, rater: null, existingOutcome: null, inserted: [], updated: [], insertFails: false };

// Spy on the delta application.
const applyOutcomeMock = jest.fn(async () => ({
  providerDelta: 60,
  baseDelta: 60,
  raterWeight: 1.0,
  disputeEligible: false,
  scoreEventApplied: true,
}));

jest.mock('../src/services/validation-repid-delta', () => ({
  applyServiceFulfilledDeltas: jest.fn(),
  applyServiceSatisfiedDeltas: jest.fn(),
  applyServiceOutcomeDeltas: (...args: any[]) => applyOutcomeMock(...args),
}));

jest.mock('../src/services/outcome-notifier', () => ({
  registerPendingOutcome: jest.fn(),
}));

// Minimal chainable db mock keyed by table.
jest.mock('../src/db', () => {
  const makeChain = (resolver: () => { data: any; error: any }) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      // Behaves like service_outcomes_contract_uniq: a second row for a contract is 23505.
      // The check and the write happen in one synchronous step, as they do in Postgres.
      insert: (row: any) => {
        const dup = (row.contract_id !== undefined && state.existingOutcome) ||
          state.inserted.some((r) => r.contract_id !== undefined && r.contract_id === row.contract_id);
        if (state.insertFails) return { select: () => ({ single: async () => ({ data: null, error: { code: '08006', message: 'connection lost' } }) }) };
        if (dup) return { select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) };
        state.inserted.push(row);
        return {
          select: () => ({ single: async () => ({ data: { id: 999 }, error: null }) }),
        };
      },
      update: (patch: any) => ({ eq: async () => { state.updated.push(patch); return { data: null, error: null }; } }),
      maybeSingle: async () => resolver(),
      single: async () => resolver(),
    };
    return chain;
  };
  return {
    db: {
      from: (table: string) => {
        if (table === 'service_contracts') return makeChain(() => ({ data: state.contract, error: state.contract ? null : { message: 'nf' } }));
        if (table === 'service_outcomes') {
          // first call = duplicate check (returns existingOutcome), insert handled in chain
          return makeChain(() => ({ data: state.existingOutcome, error: null }));
        }
        if (table === 'repid_agents') return makeChain(() => ({ data: state.rater, error: null }));
        if (table === 'x402_settlements') return makeChain(() => ({ data: { tx_hash: '0xabc' }, error: null }));
        if (table === 'service_outcome_pending') return makeChain(() => ({ data: null, error: null }));
        return makeChain(() => ({ data: null, error: null }));
      },
    },
  };
});

import request from 'supertest';
import express from 'express';
import contractsRouter from '../src/routes/v1/contracts';

const BUYER = 'buyer-uuid';
const PROVIDER = 'provider-uuid';

// Stands in for authMiddleware's binding: x-test-agent names the key's bound agent, 'none' = an
// unbound (shared tier) key. Default is the buyer, so the existing cases keep their meaning.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const a = req.header('x-test-agent');
    if (a !== 'none') (req as any).agent_id = a ?? BUYER;
    next();
  });
  app.use('/api/v1/contracts', contractsRouter);
  return app;
}

function baseContract(settledOffsetMs: number | null) {
  return {
    id: 'c-1',
    buyer_agent_id: BUYER,
    provider_agent_id: PROVIDER,
    service_id: 's-1',
    x402_payment_id: 'pay-1',
    settled_at: settledOffsetMs === null ? null : new Date(Date.now() - settledOffsetMs).toISOString(),
  };
}

beforeEach(() => {
  state.contract = baseContract(2 * DAY); // default: settled 48h ago (in-window)
  state.rater = { current_repid: 1000 };
  state.existingOutcome = null;
  state.inserted = [];
  state.updated = [];
  state.insertFails = false;
  applyOutcomeMock.mockClear();
});

const app = makeApp();

describe('POST /contracts/:id/outcome — validation + auth', () => {
  test('400 on invalid rating', async () => {
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'meh', rater_agent_id: BUYER });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_rating');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });

  test('400 when rater_agent_id missing', async () => {
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good' });
    expect(res.status).toBe(400);
  });

  test('403 when rater is NOT the buyer (buyer-only auth)', async () => {
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: 'someone-else' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_buyer');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });

  // 2026-10-16: the rater named in the body must be the authenticated principal.
  test("403 when the PROVIDER's own key rates its outcome by naming the buyer", async () => {
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').set('x-test-agent', PROVIDER).send({ rating: 'good', rater_agent_id: BUYER });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('rater_not_caller');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });

  test('403 when an unbound (shared tier) key rates as the buyer', async () => {
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').set('x-test-agent', 'none').send({ rating: 'bad', rater_agent_id: BUYER });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unbound_caller');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });

  test('404 when contract not found', async () => {
    state.contract = null;
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    expect(res.status).toBe(404);
  });

  test('409 when contract has not settled', async () => {
    state.contract = baseContract(null);
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_settled');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });
});

describe('POST /contracts/:id/outcome — time gate (24h..7d)', () => {
  test('425 before the 24h window opens (settled 2h ago)', async () => {
    state.contract = baseContract(2 * HOUR);
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    expect(res.status).toBe(425);
    expect(res.body.error).toBe('outcome_window_not_open');
    expect(res.body.opens_at).toBeDefined();
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });

  test('410 after the 7d window expires (settled 8d ago)', async () => {
    state.contract = baseContract(8 * DAY);
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'bad', rater_agent_id: BUYER });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('outcome_window_expired');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });

  test('accepts exactly inside the window (settled 48h ago)', async () => {
    state.contract = baseContract(2 * DAY);
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    expect(res.status).toBe(200);
    expect(applyOutcomeMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /contracts/:id/outcome — happy path + idempotency', () => {
  test('good rating inside window applies delta + records service_outcomes row', async () => {
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', note: 'held up great', rater_agent_id: BUYER });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rating).toBe('good');
    expect(res.body.provider_delta_applied).toBe(60);
    expect(res.body.rater_weight).toBe(1.0);
    // A service_outcomes row was inserted (provenance-bound).
    const outcomeRow = state.inserted.find((r) => r.rating === 'good');
    expect(outcomeRow).toBeDefined();
    expect(outcomeRow.contract_id).toBe('c-1');
    expect(outcomeRow.note).toBe('held up great');
    // The claim row is written first; what it applied is recorded after.
    expect(state.updated).toContainEqual(expect.objectContaining({ settlement_tx_hash: '0xabc', provider_delta_applied: 60, rater_weight: 1.0 }));
  });

  test('409 when an outcome already exists for the contract (one rating/contract)', async () => {
    state.existingOutcome = { id: 7 };
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('outcome_already_recorded');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });
});

describe('POST /contracts/:id/outcome — one rating pays once, even under concurrency', () => {
  test('five parallel ratings of one contract: one 200, four 409, the delta applied once', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER }),
      ),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409]);
    expect(applyOutcomeMock).toHaveBeenCalledTimes(1);
  });

  test('a retry after a successful rating (e.g. the client timed out) is 409 and pays nothing more', async () => {
    const first = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    const retry = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(409);
    expect(applyOutcomeMock).toHaveBeenCalledTimes(1);
  });

  test('if the claim cannot be written, no score moves (503, not a silent pay)', async () => {
    state.insertFails = true;
    const res = await request(app).post('/api/v1/contracts/c-1/outcome').send({ rating: 'good', rater_agent_id: BUYER });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('outcome_not_recorded');
    expect(applyOutcomeMock).not.toHaveBeenCalled();
  });
});
