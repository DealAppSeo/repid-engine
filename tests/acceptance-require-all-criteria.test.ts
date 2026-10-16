/**
 * ACCEPTANCE_REQUIRE_ALL_CRITERIA — /satisfy released payment when ANY criterion was met
 * (score > 0). The flag (default OFF) makes it require every criterion. OFF must be today's
 * decision exactly, plus an `acceptance_shadow` log line where the two rules disagree.
 *
 * Route half drives the real app with the daily minter's 2-criterion statement rated 1 of 2,
 * the exact shape of all 32 settlements in prod's last 30 days [V SQL 2026-10-16].
 */
import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';
import { decideAcceptance, requireAllCriteria } from '../src/services/acceptance-rule';
import { releaseHeldPayment, voidAuthorization } from '../src/services/x402-deferred-settlement';

jest.mock('../src/db', () => ({
  db: { from: jest.fn(), rpc: jest.fn().mockResolvedValue({ data: null, error: null }) },
}));

jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.apiKey = { key: 'bound-key', tier: 'pro' };
    req.agent_id = 'buyer-aaaa-1111';
    next();
  },
}));

jest.mock('../src/services/x402-deferred-settlement', () => ({
  ...jest.requireActual('../src/services/x402-deferred-settlement'),
  releaseHeldPayment: jest.fn(async () => ({ status: 'SETTLED', txHash: '0xabc' })),
  voidAuthorization: jest.fn(async () => ({ voided: true })),
}));

jest.mock('../src/services/contract-settlement-finalize', () => ({
  finalizeSettledContract: jest.fn(async () => ({ ok: true, contract: { status: 'settled' } })),
}));

// ---------------------------------------------------------------------------
describe('decideAcceptance (pure rule)', () => {
  const r = (...met: boolean[]) => met.map((m) => ({ met: m }));

  it('flag OFF: decision is today\'s rule (sound && score > 0), partial criteria release', () => {
    const d = decideAcceptance({ sound: true, score: 0.5, ratings: r(true, false), requireAll: false });
    expect(d).toEqual({ release: true, met: 1, total: 2, today: 'release', would: 'withhold' });
  });

  it('flag ON: partial criteria withhold, all criteria release', () => {
    expect(decideAcceptance({ sound: true, score: 0.3333, ratings: r(true, false, false), requireAll: true }).release).toBe(false);
    expect(decideAcceptance({ sound: true, score: 1, ratings: r(true, true, true), requireAll: true }).release).toBe(true);
  });

  it('the two rules agree when nothing or everything is met, or the deliverable is unsound', () => {
    for (const requireAll of [false, true]) {
      const none = decideAcceptance({ sound: true, score: 0, ratings: r(false, false), requireAll });
      expect([none.release, none.today, none.would]).toEqual([false, 'withhold', 'withhold']);
      const all = decideAcceptance({ sound: true, score: 1, ratings: r(true, true), requireAll });
      expect([all.release, all.today, all.would]).toEqual([true, 'release', 'release']);
      const unsound = decideAcceptance({ sound: false, score: 1, ratings: r(true, true), requireAll });
      expect([unsound.release, unsound.today, unsound.would]).toEqual([false, 'withhold', 'withhold']);
    }
  });

  it('legacy unbound rows (no criteria) are untouched by the flag', () => {
    const d = decideAcceptance({ sound: true, score: 0.4, ratings: null, requireAll: true });
    expect(d).toEqual({ release: true, met: null, total: null, today: 'release', would: 'release' });
  });

  it('flag reads only the literal "true"', () => {
    delete process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA;
    expect(requireAllCriteria()).toBe(false);
    process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA = '1';
    expect(requireAllCriteria()).toBe(false);
    process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA = 'true';
    expect(requireAllCriteria()).toBe(true);
    delete process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA;
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/v1/contracts/:id/satisfy — acceptance rule wiring', () => {
  const ID = '11111111-2222-3333-4444-555555555555';
  const CONTRACT = {
    id: ID,
    status: 'fulfilled',
    buyer_agent_id: 'buyer-aaaa-1111',
    provider_agent_id: 'provider-bbbb-2222',
    agreed_price_usdc_raw: 100000,
    result: { verdict: 'PASS' },
    work_statement_hash: '0x' + 'ab'.repeat(32),
    work_statement: {
      deliverable: 'Verify the claim: The Base Sepolia chain id is 84532.',
      acceptance_criteria: [
        { n: 1, text: 'The verdict states explicitly whether the claim is true or false, without hedging.' },
        { n: 2, text: 'The verdict names the chain id it verified against, so the check is reproducible.' },
      ],
      agreed_price: { amount_usdc_raw: 100000, currency: 'USDC' },
      deadline: '2026-12-31T00:00:00.000Z',
    },
  };
  const ONE_OF_TWO = { criterion_ratings: [{ n: 1, met: true }, { n: 2, met: false }] };
  const TWO_OF_TWO = { criterion_ratings: [{ n: 1, met: true }, { n: 2, met: true }] };

  let logSpy: jest.SpyInstance;
  const shadowLines = () =>
    logSpy.mock.calls
      .map((c) => c[0])
      .filter((s) => typeof s === 'string' && s.includes('"acceptance_shadow"'))
      .map((s) => JSON.parse(s));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.X402_SETTLE_ON_DELIVERY = 'true';
    delete process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    (db.from as jest.Mock).mockImplementation((table: string) => {
      // Same chain shape as tests/payee-fail-closed-routes.test.ts: middleware on the way in
      // calls insert/upsert/order/limit, and a missing method surfaces as a bare 500.
      const chain: any = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        in: jest.fn(() => chain),
        gte: jest.fn(() => chain),
        lte: jest.fn(() => chain),
        not: jest.fn(() => chain),
        order: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        update: jest.fn(() => chain),
        insert: jest.fn(() => chain),
        upsert: jest.fn(async () => ({ data: null, error: null })),
        single: jest.fn(async () => ({ data: null, error: null })),
        maybeSingle: jest.fn(async () => ({
          data:
            table === 'service_contracts' ? CONTRACT
            : table === 'repid_agents' ? { wallet_address: '0x2222222222222222222222222222222222222222' }
            : null,
          error: null,
        })),
        then: (r: any) => r({ data: null, error: null }),
      };
      return chain;
    });
  });

  afterEach(() => logSpy.mockRestore());
  afterAll(() => {
    delete process.env.X402_SETTLE_ON_DELIVERY;
    delete process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA;
  });

  it('flag OFF: 1 of 2 met still releases (today) and logs the disagreement', async () => {
    const res = await request(app).post(`/api/v1/contracts/${ID}/satisfy`).send(ONE_OF_TWO);
    expect(res.status).toBe(200);
    expect(releaseHeldPayment).toHaveBeenCalledTimes(1);
    expect(voidAuthorization).not.toHaveBeenCalled();
    expect(shadowLines()).toEqual([
      { event: 'acceptance_shadow', contract_id: ID, met: 1, total: 2, today: 'release', would: 'withhold' },
    ]);
  });

  it('flag ON: 1 of 2 met withholds — authorization voided, nothing released', async () => {
    process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA = 'true';
    const res = await request(app).post(`/api/v1/contracts/${ID}/satisfy`).send(ONE_OF_TWO);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'deliverable_rejected',
      reason: 'not_all_criteria_met',
      criteria_met: 1,
      criteria_total: 2,
    });
    expect(releaseHeldPayment).not.toHaveBeenCalled();
    expect(voidAuthorization).toHaveBeenCalledWith(ID, expect.stringContaining('criteria=1/2'));
  });

  it('flag ON: 2 of 2 met releases, no shadow line', async () => {
    process.env.ACCEPTANCE_REQUIRE_ALL_CRITERIA = 'true';
    const res = await request(app).post(`/api/v1/contracts/${ID}/satisfy`).send(TWO_OF_TWO);
    expect(res.status).toBe(200);
    expect(releaseHeldPayment).toHaveBeenCalledTimes(1);
    expect(shadowLines()).toEqual([]);
  });
});
