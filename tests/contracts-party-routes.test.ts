/**
 * contracts-party-routes.test.ts — the caller-identity guard on the four contract
 * mutations that did not have one: /escrow, /cancel, /dispute, /resolve.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE CASE THIS FILE EXISTS FOR
 * ════════════════════════════════════════════════════════════════════════════════
 * `authMiddleware` has a party check — "a bound key may act on a contract iff its
 * agent is a PARTY" (src/middleware/auth.ts:254-278) — but it is nested inside
 * `if (dbAgentId) { … }`, and `dbAgentId` is set ONLY by a DB-issued agent key.
 *
 * A caller holding a shared `REPID_API_KEYS` env key authenticates fine and leaves
 * `dbAgentId` undefined, so the whole block — party check included — is skipped.
 * That is the case the middleware never covers, and therefore the case tested here:
 * **every test below drives a caller with NO bound agent identity**, which is what a
 * shared tier key looks like by the time it reaches a route handler.
 *
 * The pre-existing suites (tests/routes/v1/contracts.test.ts and
 * contracts-dispute.test.ts) used exactly this shape in their auth mock and asserted
 * 200s, so before this change the hole was not merely untested — it was pinned in
 * place by passing tests.
 *
 * `/escrow` gets the most attention because it is the one that moves a contract
 * `pending → escrowed` with no payment presented at all when
 * `X402_ENFORCEMENT_ENABLED` is unset (it is compared to the literal `'true'`).
 */

import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';
import { contractPartyRefusal } from '../src/routes/v1/contracts';

// `rpc` is needed by versioningMiddleware, which runs before every route and
// lazily ensures the api_key_versions table exists — without it the request 500s
// long before reaching the handler under test.
jest.mock('../src/db', () => ({
  db: {
    from: jest.fn(),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

// The caller identity for the next request is carried on `global` rather than a
// module-scoped variable: a jest.mock factory is hoisted above the file body and
// may not close over ordinary local bindings.
//
// `null` = a shared env key: authenticated, no bound agent — the exact state
// `authMiddleware` leaves behind when the key came from `REPID_API_KEYS` rather
// than `agent_api_keys`.
jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.apiKey = { key: 'shared-env-key', tier: 'enterprise' };
    // Mirrors auth.ts: `agent_id` is set ONLY for a DB-issued bound key. A shared
    // key leaves it undefined — the property is not defined at all, not set to null.
    const id = (global as any).__callerAgentId;
    if (id) req.agent_id = id;
    next();
  },
}));

const BUYER = 'buyer-aaaa-1111';
const PROVIDER = 'provider-bbbb-2222';
const STRANGER = 'stranger-cccc-3333';
const CONTRACT_ID = '11111111-2222-3333-4444-555555555555';

/** Records every write attempt so a refusal can be proven to have changed nothing. */
let updateSpy: jest.Mock;
let insertSpy: jest.Mock;

function setCaller(id: string | null) {
  (global as any).__callerAgentId = id;
}

/**
 * A chainable Supabase-shaped stub. Both `single` and `maybeSingle` resolve to the
 * contract row, which covers `/dispute` (uses `.single()`) and `/escrow`, `/cancel`,
 * `/resolve` (use `.maybeSingle()`) with one stub.
 */
function mockDb(contract: Record<string, unknown> | null) {
  (db.from as jest.Mock).mockImplementation((table: string) => {
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      gte: jest.fn(() => chain),
      not: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      lte: jest.fn(async () => ({ data: [], error: null })),
      // versioningMiddleware upserts into api_key_versions and awaits it directly.
      upsert: jest.fn(async () => ({ data: null, error: null })),
      update: jest.fn((patch: unknown) => {
        updateSpy(table, patch);
        return chain;
      }),
      insert: jest.fn((row: unknown) => {
        insertSpy(table, row);
        return chain;
      }),
      single: jest.fn(async () => ({ data: contract, error: null })),
      maybeSingle: jest.fn(async () => ({ data: contract, error: null })),
    };
    return chain;
  });
}

const CONTRACT = {
  id: CONTRACT_ID,
  status: 'pending',
  buyer_agent_id: BUYER,
  provider_agent_id: PROVIDER,
  agreed_price_usdc_raw: 10000,
};

beforeEach(() => {
  jest.clearAllMocks();
  updateSpy = jest.fn();
  insertSpy = jest.fn();
  setCaller(null);
  mockDb(CONTRACT);
  // Unset = the legacy branch, which is the configuration that was live and the
  // one where escrow costs the caller nothing.
  delete process.env.X402_ENFORCEMENT_ENABLED;
});

afterAll(() => {
  delete (global as any).__callerAgentId;
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED-KEY CASE — the one the middleware never sees
// ─────────────────────────────────────────────────────────────────────────────

describe('shared env key (no bound agent) cannot mutate a contract', () => {
  const routes: Array<{ path: string; body?: Record<string, unknown>; action: string }> = [
    { path: 'escrow', action: 'escrow' },
    { path: 'cancel', action: 'cancel' },
    { path: 'dispute', body: { reason: 'did not deliver' }, action: 'dispute' },
    { path: 'resolve', body: { dispute_verdict: 'provider_at_fault' }, action: 'resolve' },
  ];

  for (const route of routes) {
    it(`refuses /${route.path} with unbound_caller`, async () => {
      setCaller(null);

      const res = await request(app)
        .post(`/api/v1/contracts/${CONTRACT_ID}/${route.path}`)
        .send(route.body ?? {});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('unbound_caller');
      expect(res.body.action).toBe(route.action);
    });

    it(`writes nothing on a refused /${route.path}`, async () => {
      setCaller(null);

      await request(app)
        .post(`/api/v1/contracts/${CONTRACT_ID}/${route.path}`)
        .send(route.body ?? {});

      // The refusal must land BEFORE any state change — a 403 that still flipped
      // the row would be a worse bug than the one being fixed.
      expect(updateSpy).not.toHaveBeenCalled();
      expect(insertSpy).not.toHaveBeenCalled();
    });
  }

  // The specific consequence named in the report: with enforcement off, the legacy
  // branch moves pending → escrowed having presented no payment whatsoever.
  it('does not flip pending → escrowed for free on the legacy branch', async () => {
    setCaller(null);
    delete process.env.X402_ENFORCEMENT_ENABLED;

    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});

    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalledWith(
      'service_contracts',
      expect.objectContaining({ status: 'escrowed' }),
    );
  });

  // Same refusal with enforcement ON, so the guard is not quietly dependent on a
  // flag that could be flipped either way.
  it('refuses /escrow with X402_ENFORCEMENT_ENABLED=true as well', async () => {
    setCaller(null);
    process.env.X402_ENFORCEMENT_ENABLED = 'true';

    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unbound_caller');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BOUND BUT UNRELATED — the middleware DOES cover this one; assert it at the route
// ─────────────────────────────────────────────────────────────────────────────

describe('bound key belonging to a non-party is refused', () => {
  for (const route of ['escrow', 'cancel', 'dispute', 'resolve']) {
    it(`refuses /${route} with not_a_party`, async () => {
      setCaller(STRANGER);

      const res = await request(app)
        .post(`/api/v1/contracts/${CONTRACT_ID}/${route}`)
        .send({ dispute_verdict: 'provider_at_fault', reason: 'x' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('not_a_party');
      expect(updateSpy).not.toHaveBeenCalled();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PARTIES STILL WORK — a guard that blocks the legitimate path is an outage
// ─────────────────────────────────────────────────────────────────────────────

describe('a party is allowed through', () => {
  it('lets the buyer escrow (legacy branch)', async () => {
    setCaller(BUYER);

    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});

    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      'service_contracts',
      expect.objectContaining({ status: 'escrowed' }),
    );
  });

  it('lets the provider escrow (party check is buyer OR provider)', async () => {
    setCaller(PROVIDER);

    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});

    expect(res.status).toBe(200);
  });

  it('lets the buyer cancel', async () => {
    setCaller(BUYER);

    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/cancel`).send({});

    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      'service_contracts',
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('lets the provider dispute', async () => {
    setCaller(PROVIDER);

    const res = await request(app)
      .post(`/api/v1/contracts/${CONTRACT_ID}/dispute`)
      .send({ reason: 'buyer will not confirm' });

    expect(res.status).toBe(200);
  });

  it('lets a party resolve', async () => {
    setCaller(BUYER);

    const res = await request(app)
      .post(`/api/v1/contracts/${CONTRACT_ID}/resolve`)
      .send({ dispute_verdict: 'provider_at_fault' });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN CONTRACT — 404, and the guard must not leak whether it exists
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown contract', () => {
  it('404s on /cancel rather than issuing a blind UPDATE', async () => {
    setCaller(BUYER);
    mockDb(null);

    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/cancel`).send({});

    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('404s on /resolve rather than issuing a blind UPDATE', async () => {
    setCaller(BUYER);
    mockDb(null);

    const res = await request(app)
      .post(`/api/v1/contracts/${CONTRACT_ID}/resolve`)
      .send({ dispute_verdict: 'provider_at_fault' });

    expect(res.status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RULE ITSELF — pure, no app, no database
// ─────────────────────────────────────────────────────────────────────────────

describe('contractPartyRefusal', () => {
  const contract = { buyer_agent_id: BUYER, provider_agent_id: PROVIDER };

  it('refuses a caller with no agent_id', () => {
    expect(contractPartyRefusal({}, contract, 'escrow')).toMatchObject({
      error: 'unbound_caller',
      action: 'escrow',
    });
  });

  it('refuses a whitespace-only agent_id rather than treating it as an identity', () => {
    expect(contractPartyRefusal({ agent_id: '   ' }, contract, 'escrow')).toMatchObject({
      error: 'unbound_caller',
    });
  });

  it('refuses a non-string agent_id', () => {
    expect(contractPartyRefusal({ agent_id: 12345 }, contract, 'cancel')).toMatchObject({
      error: 'unbound_caller',
    });
  });

  it('refuses a bound stranger', () => {
    expect(contractPartyRefusal({ agent_id: STRANGER }, contract, 'dispute')).toMatchObject({
      error: 'not_a_party',
      action: 'dispute',
    });
  });

  it('allows the buyer', () => {
    expect(contractPartyRefusal({ agent_id: BUYER }, contract, 'escrow')).toBeNull();
  });

  it('allows the provider', () => {
    expect(contractPartyRefusal({ agent_id: PROVIDER }, contract, 'escrow')).toBeNull();
  });

  it('compares case-insensitively and ignores surrounding whitespace', () => {
    expect(
      contractPartyRefusal({ agent_id: `  ${BUYER.toUpperCase()}  ` }, contract, 'escrow'),
    ).toBeNull();
  });

  // A contract row with a null counterparty must not become a wildcard: `sameAgent`
  // requires both sides to be non-empty strings, so null can never match.
  it('does not let a null party id match anyone', () => {
    expect(
      contractPartyRefusal({ agent_id: STRANGER }, { buyer_agent_id: null, provider_agent_id: null }, 'escrow'),
    ).toMatchObject({ error: 'not_a_party' });
  });
});
