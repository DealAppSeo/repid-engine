/**
 * TrustMarket P1 — the offer→accept→settle→RepID path, at the route layer.
 *
 * WHAT WAS MISSING, AND WHY THESE TESTS ARE THE ONES THAT MATTER.
 *
 * 1. THE REVERSE LINK. POST /offers/:id/accept returns contract_id to the POSTER.
 *    On a 'have' listing the poster is the PROVIDER, so the contract id lands with
 *    the party who has nothing to do next, while the BUYER — who must present the
 *    payment authorization at escrow — is told nothing. marketplace_offers has no
 *    contract_id column, so the only join is service_contracts.payload.offer_id.
 *    GET /offers/:id is that join, and it is scoped to the two participants.
 *
 * 2. WHOSE TURN IS IT. RepID moves three calls after the accept, at
 *    POST /contracts/:id/satisfy, and only the buyer can make that call. Nothing
 *    told them. In production 148 of 184 service_contracts sat at 'fulfilled' —
 *    delivered, unpaid, no settle-side RepID. GET /exchanges/:contractId names the
 *    stage, the party, the exact request and the refusals.
 *
 * 3. D-095. An EIP-3009 authorization is a SIGNATURE, not a transfer. No response
 *    on this surface may claim funds are held. Pinned by an explicit test, because
 *    that sentence is the kind that gets re-introduced by a well-meaning edit.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';

// ── db mock ────────────────────────────────────────────────────────────────
// A table-driven stub. `single`/`maybeSingle` return the staged row; a bare
// await (thenable) returns the staged list. No writes are staged anywhere —
// this surface must never write, and a stray insert would fail loudly here.

interface DbState {
  offer: any;
  listing: any;
  contract: any;
  service: any;
  bindings: any[];
  writes: Array<{ table: string; op: string }>;
}

const st: DbState = { offer: null, listing: null, contract: null, service: null, bindings: [], writes: [] };

function rowFor(table: string): any {
  if (table === 'marketplace_offers') return st.offer;
  if (table === 'marketplace_listings') return st.listing;
  if (table === 'service_contracts') return st.contract;
  if (table === 'agent_services') return st.service;
  return null;
}

function makeQuery(table: string) {
  const q: any = {};
  q.select = () => q;
  q.eq = () => q;
  q.is = () => q;
  q.order = () => q;
  q.limit = () => q;
  q.maybeSingle = async () => ({ data: rowFor(table), error: null });
  q.single = async () => ({ data: rowFor(table), error: null });
  q.insert = () => {
    st.writes.push({ table, op: 'insert' });
    return q;
  };
  q.update = () => {
    st.writes.push({ table, op: 'update' });
    return q;
  };
  q.delete = () => {
    st.writes.push({ table, op: 'delete' });
    return q;
  };
  q.then = (resolve: any) => {
    if (table === 'human_agent_bindings') return resolve({ data: st.bindings, error: null });
    return resolve({ data: [], error: null });
  };
  return q;
}

jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

// resolvePosterIdentity lives on the P0 router; mocked so the tests drive
// identity directly instead of minting tokens for a surface they do not test.
let identity: { poster_type: 'agent' | 'human'; poster_id: string } | null = null;
jest.mock('../src/routes/marketplace', () => ({
  __esModule: true,
  resolvePosterIdentity: async () => identity,
  default: {},
}));

import { listingOffersRouter } from '../src/routes/v1/listing-offers';
import {
  describeNextStep,
  offerRoles,
  viewerRole,
  toStage,
  AUTHORIZATION_NOTE,
  type ExchangeFacts,
} from '../src/routes/v1/exchange-next-step';

const POSTER = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
const OFFERER = 'bbbb2222-2222-4222-8222-bbbbbbbbbbbb';
const STRANGER = 'cccc3333-3333-4333-8333-cccccccccccc';
const CONTRACT = 'dddd4444-4444-4444-8444-dddddddddddd';
const OFFER = 'eeee5555-5555-4555-8555-eeeeeeeeeeee';
const LISTING = 'ffff6666-6666-4666-8666-ffffffffffff';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marketplace', listingOffersRouter);
  return app;
}
const app = makeApp();

function facts(over: Partial<ExchangeFacts> = {}): ExchangeFacts {
  return {
    status: 'pending',
    serviceType: 'verification',
    handlerDelivered: true,
    hasPaymentAuthorization: false,
    settledAt: null,
    resultVerdict: null,
    settleOnDelivery: true,
    enforcementEnabled: true,
    now: Date.parse('2026-08-04T00:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  identity = { poster_type: 'agent', poster_id: OFFERER };
  st.writes = [];
  st.bindings = [];
  st.listing = {
    id: LISTING,
    poster_type: 'agent',
    poster_id: POSTER,
    kind: 'have',
    mode: 'buy',
    title: 'Fact-check a claim',
    status: 'matched',
    price_usdc: 0.1,
  };
  st.offer = {
    id: OFFER,
    listing_id: LISTING,
    offerer_id: OFFERER,
    offerer_type: 'agent',
    amount_usdc: 0.1,
    message: JSON.stringify({ note: null, service_id: 'svc-1' }),
    status: 'accepted',
    created_at: '2026-08-03T00:00:00.000Z',
  };
  st.contract = {
    id: CONTRACT,
    status: 'fulfilled',
    service_id: 'svc-1',
    buyer_agent_id: OFFERER,
    provider_agent_id: POSTER,
    agreed_price_usdc_raw: 100000,
    x402_payment_id: 'settle-1',
    result: { verdict: 'PASS' },
    payload: { source: 'marketplace_listing', listing_id: LISTING, offer_id: OFFER },
    metadata: { bridged_from_listing: true },
    created_at: '2026-08-03T00:00:00.000Z',
    escrowed_at: '2026-08-03T00:01:00.000Z',
    fulfilled_at: '2026-08-03T00:02:00.000Z',
    settled_at: null,
  };
  st.service = { id: 'svc-1', service_type: 'verification', service_name: 'Fact check' };
});

// ── the state machine, pure ────────────────────────────────────────────────

describe('describeNextStep — whose turn, and the exact call', () => {
  it("'pending' is the BUYER's escrow call, and asks for the X-PAYMENT header", () => {
    const n = describeNextStep(facts({ status: 'pending' }));
    expect(n.turn).toBe('buyer');
    expect(n.action?.path).toBe('/api/v1/contracts/:id/escrow');
    expect(n.action?.headers.join(' ')).toMatch(/X-PAYMENT/);
    expect(n.terminal).toBe(false);
  });

  it("'pending' omits the X-PAYMENT header when enforcement is off (it is not required)", () => {
    const n = describeNextStep(facts({ status: 'pending', enforcementEnabled: false }));
    expect(n.action?.headers).toEqual([]);
  });

  it("'escrowed' is the PROVIDER's turn, and a handled service_type routes to the handler, not /fulfill", () => {
    const n = describeNextStep(facts({ status: 'escrowed', handlerDelivered: true }));
    expect(n.turn).toBe('provider');
    expect(n.action?.path).toBe('/api/v1/agent/process-contracts');
    expect(n.refusals.map((r) => r.code)).toContain('handler_delivery_required');
  });

  it("'escrowed' with no registered handler routes to /fulfill", () => {
    const n = describeNextStep(facts({ status: 'escrowed', handlerDelivered: false, serviceType: 'bespoke' }));
    expect(n.action?.path).toBe('/api/v1/contracts/:id/fulfill');
    expect(n.action?.body).toHaveProperty('result');
  });

  it("'fulfilled' — the dead-end 148 contracts sat in — is the BUYER's /satisfy call", () => {
    const n = describeNextStep(facts({ status: 'fulfilled' }));
    expect(n.turn).toBe('buyer');
    expect(n.action?.path).toBe('/api/v1/contracts/:id/satisfy');
    expect(n.action?.body).toHaveProperty('satisfaction_score');
    expect(n.terminal).toBe(false);
  });

  it("'fulfilled' names the refusals /satisfy actually returns, including the provider self-release block", () => {
    const codes = describeNextStep(facts({ status: 'fulfilled' })).refusals.map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'unbound_caller',
        'self_satisfaction_forbidden',
        'not_the_buyer',
        'deliverable_rejected',
        'payment_release_failed',
      ]),
    );
  });

  it("'fulfilled' surfaces a non-PASS verdict in the rejection refusal, so the buyer knows before calling", () => {
    const n = describeNextStep(facts({ status: 'fulfilled', resultVerdict: 'VETO' }));
    const rejected = n.refusals.find((r) => r.code === 'deliverable_rejected');
    expect(rejected?.when).toMatch(/VETO/);
  });

  it("'settled' is terminal, nobody's turn, and carries the optional 24h–7d outcome window", () => {
    const settledAt = '2026-08-01T00:00:00.000Z';
    const n = describeNextStep(facts({ status: 'settled', settledAt, now: Date.parse('2026-08-03T00:00:00.000Z') }));
    expect(n.terminal).toBe(true);
    expect(n.turn).toBe('nobody');
    expect(n.action).toBeNull();
    expect(n.optional_next?.path).toBe('/api/v1/contracts/:id/outcome');
    expect(n.optional_next?.turn).toBe('buyer');
    expect(n.optional_next?.open_now).toBe(true);
  });

  it('the outcome window is CLOSED inside the first 24h and after 7d', () => {
    const settledAt = '2026-08-01T00:00:00.000Z';
    const tooEarly = describeNextStep(
      facts({ status: 'settled', settledAt, now: Date.parse('2026-08-01T06:00:00.000Z') }),
    );
    const tooLate = describeNextStep(
      facts({ status: 'settled', settledAt, now: Date.parse('2026-08-20T00:00:00.000Z') }),
    );
    expect(tooEarly.optional_next?.open_now).toBe(false);
    expect(tooLate.optional_next?.open_now).toBe(false);
  });

  it("'settled' with no settled_at reports a null window rather than guessing one", () => {
    const n = describeNextStep(facts({ status: 'settled', settledAt: null }));
    expect(n.optional_next?.opens_at).toBeNull();
    expect(n.optional_next?.open_now).toBe(false);
  });

  it('cancelled and resolved are terminal; disputed is not (it can still resolve)', () => {
    expect(describeNextStep(facts({ status: 'cancelled' })).terminal).toBe(true);
    expect(describeNextStep(facts({ status: 'resolved' })).terminal).toBe(true);
    expect(describeNextStep(facts({ status: 'disputed' })).terminal).toBe(false);
  });

  it('an unrecognised status reports unknown instead of inventing a next call', () => {
    const n = describeNextStep(facts({ status: 'wat' }));
    expect(n.stage).toBe('unknown');
    expect(n.action).toBeNull();
    expect(n.turn).toBe('nobody');
  });

  it('toStage is case-insensitive and refuses to map junk', () => {
    expect(toStage('FULFILLED')).toBe('fulfilled');
    expect(toStage(null)).toBe('unknown');
    expect(toStage('almost_settled')).toBe('unknown');
  });

  it('D-095: no stage ever claims funds are held or locked', () => {
    const all = ['pending', 'escrowed', 'fulfilled', 'satisfied', 'settled', 'disputed', 'resolved', 'cancelled'];
    const prose = all
      .map((status) => JSON.stringify(describeNextStep(facts({ status }))))
      .concat(AUTHORIZATION_NOTE)
      .join(' ')
      .toLowerCase();
    expect(prose).not.toMatch(/funds (are |were )?held/);
    expect(prose).not.toMatch(/payment (is |was )?held/);
    expect(prose).not.toMatch(/funds (are |were )?locked/);
    expect(prose).not.toMatch(/in escrow custody/);
  });
});

// ── direction: 'have' and 'want' invert who pays ───────────────────────────

describe('offerRoles — inverting this pays the wrong party', () => {
  it("'have': the poster provides, the offerer buys", () => {
    expect(offerRoles('have')).toEqual({ buyer: 'offerer', provider: 'poster' });
  });
  it("'want': the poster buys, the offerer provides", () => {
    expect(offerRoles('want')).toEqual({ buyer: 'poster', provider: 'offerer' });
  });
  it('an unknown kind resolves to nothing rather than defaulting to a direction', () => {
    expect(offerRoles('barter')).toBeNull();
  });
});

describe('viewerRole', () => {
  const c = { buyer_agent_id: OFFERER, provider_agent_id: POSTER };
  it('matches the buyer and the provider, case-insensitively', () => {
    expect(viewerRole(c, [OFFERER.toUpperCase()])).toBe('buyer');
    expect(viewerRole(c, [POSTER])).toBe('provider');
  });
  it('a non-party is nothing, and an empty id set fails closed', () => {
    expect(viewerRole(c, [STRANGER])).toBeNull();
    expect(viewerRole(c, [])).toBeNull();
    expect(viewerRole(c, [''])).toBeNull();
  });
});

// ── GET /offers/:id — the reverse link ─────────────────────────────────────

describe('GET /api/v1/marketplace/offers/:id', () => {
  it('gives the OFFERER the contract their accepted offer became — the link that did not exist', async () => {
    identity = { poster_type: 'agent', poster_id: OFFERER };
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(200);
    expect(res.body.viewer).toBe('offerer');
    expect(res.body.your_side).toBe('buyer'); // 'have' listing → the offerer pays
    expect(res.body.contract.id).toBe(CONTRACT);
    expect(res.body.contract.state_url).toBe(`/api/v1/marketplace/exchanges/${CONTRACT}`);
  });

  it('gives the POSTER the same view, from the provider side', async () => {
    identity = { poster_type: 'agent', poster_id: POSTER };
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(200);
    expect(res.body.viewer).toBe('poster');
    expect(res.body.your_side).toBe('provider');
  });

  it('a pending offer has no contract yet, and says so without inventing one', async () => {
    st.offer.status = 'pending';
    st.contract = null;
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(200);
    expect(res.body.contract).toBeNull();
  });

  it('flags an accepted offer with no contract as an orphan rather than reporting success', async () => {
    st.contract = null;
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(200);
    expect(res.body.contract).toBeNull();
    expect(String(res.body.note)).toMatch(/orphan/i);
  });

  // refusals
  it('401 without a credential', async () => {
    identity = null;
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('auth_required');
  });

  it('403 for a stranger — an offer amount is competitive information', async () => {
    identity = { poster_type: 'agent', poster_id: STRANGER };
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_a_participant');
  });

  it('403 for a human whose id happens to equal an agent party id (type must match too)', async () => {
    identity = { poster_type: 'human', poster_id: OFFERER };
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(403);
  });

  it('404 when the offer does not exist', async () => {
    st.offer = null;
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('offer_not_found');
  });

  it('404 when the listing behind the offer is gone', async () => {
    st.listing = null;
    const res = await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('listing_not_found');
  });

  it('writes nothing', async () => {
    await request(app).get(`/api/v1/marketplace/offers/${OFFER}`);
    expect(st.writes).toEqual([]);
  });
});

// ── GET /exchanges/:contractId — whose turn is it ───────────────────────────

describe('GET /api/v1/marketplace/exchanges/:contractId', () => {
  it("tells the BUYER of a 'fulfilled' contract that it is their turn, with the concrete /satisfy URL", async () => {
    identity = { poster_type: 'agent', poster_id: OFFERER };
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.your_role).toBe('buyer');
    expect(res.body.your_turn).toBe(true);
    expect(res.body.next_step.turn).toBe('buyer');
    // the id is substituted — a caller should not have to patch a placeholder
    expect(res.body.next_step.action.path).toBe(`/api/v1/contracts/${CONTRACT}/satisfy`);
  });

  it('tells the PROVIDER of the same contract that it is NOT their turn', async () => {
    identity = { poster_type: 'agent', poster_id: POSTER };
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.status).toBe(200);
    expect(res.body.your_role).toBe('provider');
    expect(res.body.your_turn).toBe(false);
    expect(res.body.counterparty_role).toBe('buyer');
  });

  it('reports the listing origin so a marketplace contract is traceable back to its offer', async () => {
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.body.origin).toEqual({ kind: 'marketplace_listing', listing_id: LISTING, offer_id: OFFER });
  });

  it('reports the a2a award origin for a contract created by the RFQ path', async () => {
    st.contract.payload = { scope: 'whatever' };
    st.contract.metadata = { negotiation: { rfq_id: 'rfq-9' } };
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.body.origin).toEqual({ kind: 'a2a_award', rfq_id: 'rfq-9' });
  });

  it('says AUTHORIZATION_RECORDED, never that funds are held', async () => {
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.body.payment_state).toBe('AUTHORIZATION_RECORDED');
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/funds (are |were )?held/);
  });

  it('reports NO_AUTHORIZATION_RECORDED when nothing was ever presented', async () => {
    st.contract.x402_payment_id = null;
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.body.payment_state).toBe('NO_AUTHORIZATION_RECORDED');
  });

  // refusals
  it('401 without a credential', async () => {
    identity = null;
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.status).toBe(401);
  });

  it('403 for an agent that is neither buyer nor provider', async () => {
    identity = { poster_type: 'agent', poster_id: STRANGER };
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_a_party');
  });

  it('a human sees the exchange only through an agent they still own', async () => {
    identity = { poster_type: 'human', poster_id: 'builder-1' };
    st.bindings = [{ agent_id: OFFERER }];
    const ok = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(ok.status).toBe(200);
    expect(ok.body.your_role).toBe('buyer');

    st.bindings = []; // revoked, or never bound
    const denied = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(denied.status).toBe(403);
    expect(String(denied.body.message)).toMatch(/bound to this account/i);
  });

  it('404 for a contract that does not exist', async () => {
    st.contract = null;
    const res = await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('contract_not_found');
  });

  it('writes nothing', async () => {
    await request(app).get(`/api/v1/marketplace/exchanges/${CONTRACT}`);
    expect(st.writes).toEqual([]);
  });
});
