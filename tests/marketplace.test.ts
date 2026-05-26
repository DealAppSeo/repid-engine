/**
 * RepID marketplace substrate — unit tests (PR-4, V2 substrate, settlement DISABLED).
 * - validateCreateListing: pure, no IO (happy/sad paths).
 * - POST /listings creates + returns id; POST /rentals returns a settlement-disabled note and
 *   moves NO money. db is mocked via a call-time global handle (no jest hoist/TDZ).
 *
 * Live write paths need the agent_listings / rental_records tables (migration 20260526130000)
 * and are exercised end-to-end after the orchestrator applies it.
 */

jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__mktDb;
  },
}));

import request from 'supertest';
import express from 'express';
import marketplaceRouter, {
  validateCreateListing,
  MARKETPLACE_SETTLEMENT_ENABLED,
} from '../src/routes/v1/marketplace';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marketplace', marketplaceRouter);
  return app;
}

describe('settlement flag', () => {
  test('MARKETPLACE_SETTLEMENT_ENABLED is hard-off for V2', () => {
    expect(MARKETPLACE_SETTLEMENT_ENABLED).toBe(false);
  });
});

describe('validateCreateListing', () => {
  test('accepts a valid rent listing', () => {
    const r = validateCreateListing({
      agent_id: VALID_UUID,
      owner_sbt_id: 'sbt-1',
      listing_type: 'rent',
      price_usdc: 9.5,
      rep_id_at_listing: 1200,
      rental_duration_hours: 24,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.listing_type).toBe('rent');
      expect(r.price_usdc).toBe(9.5);
      expect(r.rental_duration_hours).toBe(24);
    }
  });

  test('accepts a sell listing with null duration', () => {
    const r = validateCreateListing({
      agent_id: VALID_UUID,
      owner_sbt_id: 'sbt-1',
      listing_type: 'sell',
      price_usdc: 100,
      rep_id_at_listing: 5000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rental_duration_hours).toBeNull();
  });

  test('rejects bad agent_id (not uuid)', () => {
    expect(
      validateCreateListing({ agent_id: 'nope', owner_sbt_id: 'sbt-1', listing_type: 'sell', price_usdc: 1, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });

  test('rejects invalid listing_type', () => {
    expect(
      validateCreateListing({ agent_id: VALID_UUID, owner_sbt_id: 'sbt-1', listing_type: 'lease', price_usdc: 1, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });

  test('rejects negative price', () => {
    expect(
      validateCreateListing({ agent_id: VALID_UUID, owner_sbt_id: 'sbt-1', listing_type: 'sell', price_usdc: -5, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });

  test('rejects missing owner_sbt_id', () => {
    expect(
      validateCreateListing({ agent_id: VALID_UUID, listing_type: 'sell', price_usdc: 1, rep_id_at_listing: 1 }).ok,
    ).toBe(false);
  });
});

describe('POST /listings', () => {
  afterEach(() => {
    delete (global as any).__mktDb;
  });

  test('201 returns listing_id', async () => {
    (global as any).__mktDb = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 5 }, error: null }) }) }),
      }),
    };
    const res = await request(makeApp())
      .post('/api/v1/marketplace/listings')
      .send({ agent_id: VALID_UUID, owner_sbt_id: 'sbt-1', listing_type: 'rent', price_usdc: 10, rep_id_at_listing: 1200, rental_duration_hours: 24 });
    expect(res.status).toBe(201);
    expect(res.body.listing_id).toBe(5);
    expect(res.body.status).toBe('active');
  });

  test('400 on invalid body', async () => {
    const res = await request(makeApp())
      .post('/api/v1/marketplace/listings')
      .send({ agent_id: 'bad', owner_sbt_id: 'sbt-1', listing_type: 'rent', price_usdc: 10, rep_id_at_listing: 1200 });
    expect(res.status).toBe(400);
  });
});

describe('POST /rentals — settlement disabled', () => {
  afterEach(() => {
    delete (global as any).__mktDb;
  });

  test('200 returns settlement-disabled note + moves no money', async () => {
    (global as any).__mktDb = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 88 }, error: null }) }) }),
      }),
    };
    const res = await request(makeApp())
      .post('/api/v1/marketplace/rentals')
      .send({ listing_id: 5, renter_sbt_id: 'renter-sbt', target_squad_id: 'squad-9' });
    expect(res.status).toBe(200);
    expect(res.body.rental_id).toBe(88);
    expect(res.body.settlement).toBe('disabled');
    expect(res.body.settlement_enabled).toBe(false);
    expect(res.body.note).toMatch(/SETTLEMENT IS DISABLED/);
    expect(res.body.note).toMatch(/attributes to the AGENT, not the renter/);
  });

  test('400 when renter_sbt_id missing', async () => {
    const res = await request(makeApp())
      .post('/api/v1/marketplace/rentals')
      .send({ listing_id: 5 });
    expect(res.status).toBe(400);
  });
});
