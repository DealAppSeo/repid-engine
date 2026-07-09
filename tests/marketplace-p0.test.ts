/**
 * TrustMarket-light P0 — list→browse round-trip (supertest against the real app).
 *
 * LIVE test: exercises POST /api/v1/marketplace/list (human login_token auth)
 * and GET /api/v1/marketplace/browse (public/keyless) end-to-end against the
 * DISPOSABLE TEST Supabase project, then cleans up the row it created.
 *
 * Gating: runs ONLY when TEST-project creds are present in env and do NOT point
 * at prod. Under a bare `npm test` (no SUPABASE_TEST_* in env) it SKIPS green.
 * To run it live:
 *   SUPABASE_TEST_URL=... SUPABASE_TEST_PUBLISHABLE_KEY=... \
 *   FULL_ACCOUNT_JWT_SECRET=<any> npx jest tests/marketplace-p0.test.ts
 *
 * SAFETY: refuses any URL containing the prod ref (qnnpjhlxljtqyigedwkb).
 */

const PROD_REF = 'qnnpjhlxljtqyigedwkb';
const TEST_URL = process.env.SUPABASE_TEST_URL || '';
const TEST_KEY =
  process.env.SUPABASE_TEST_PUBLISHABLE_KEY ||
  process.env.SUPABASE_TEST_SERVICE_KEY ||
  '';

const haveTestCreds = !!(TEST_URL && TEST_KEY && !TEST_URL.includes(PROD_REF));

// Point the app's Supabase client at the TEST project BEFORE importing app
// (src/config.ts throws at import if these are unset).
if (haveTestCreds) {
  process.env.SUPABASE_URL = TEST_URL;
  process.env.SUPABASE_SERVICE_KEY = TEST_KEY;
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key-for-import';
process.env.FULL_ACCOUNT_JWT_SECRET = process.env.FULL_ACCOUNT_JWT_SECRET || 'test-marketplace-p0-secret';
process.env.NODE_ENV = 'test';

import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';
import { issueFullAccountToken } from '../src/services/auth-token';

const run = haveTestCreds ? describe : describe.skip;

run('TrustMarket-light P0 — list→browse round-trip (live TEST Supabase)', () => {
  const builderId = `p0-test-${process.pid}-${Date.now()}`;
  const token = issueFullAccountToken(builderId, `${builderId}@example.com`);
  const marker = `P0-ROUNDTRIP-${builderId}`;
  let listingId: string | undefined;
  let impersonateListingId: string | undefined;

  afterAll(async () => {
    const ids = [listingId, impersonateListingId].filter(Boolean) as string[];
    for (const id of ids) {
      await db.from('marketplace_listings').delete().eq('id', id);
    }
  });

  it('POST /list creates a human listing (201), prose passes the sanitizer', async () => {
    const res = await request(app)
      .post('/api/v1/marketplace/list')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'want',
        mode: 'buy',
        category: 'compute',
        title: marker,
        // prose with SQL-shaped tokens; router is mounted before the sanitizer.
        description: 'need GPU hours; e.g. SELECT the cheapest provider, do not DELETE my budget',
        price_usdc: 12.5,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.poster_type).toBe('human');
    expect(res.body.poster_id).toBe(builderId);
    listingId = res.body.listing_id;
    expect(typeof listingId).toBe('string');
  });

  it('GET /browse (keyless) returns the listing enriched with a poster badge', async () => {
    const res = await request(app).get('/api/v1/marketplace/browse?kind=want');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.listings)).toBe(true);
    const found = res.body.listings.find((l: any) => l.id === listingId);
    expect(found).toBeTruthy();
    expect(found.title).toBe(marker);
    expect(found.kind).toBe('want');
    expect(found.poster.type).toBe('human');
    // Badge fields are always present (repid/tier may be null for a human poster).
    expect(found.poster).toHaveProperty('repid');
    expect(found.poster).toHaveProperty('tier');
  });

  it('POST /list without auth is 401', async () => {
    const res = await request(app)
      .post('/api/v1/marketplace/list')
      .send({ kind: 'have', mode: 'buy', title: 'x' });
    expect(res.status).toBe(401);
  });

  it('POST /list rejects an invalid kind (400)', async () => {
    const res = await request(app)
      .post('/api/v1/marketplace/list')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'nope', mode: 'buy', title: 'x' });
    expect(res.status).toBe(400);
  });

  it("POST /list requires rent_period when mode='rent' (400)", async () => {
    const res = await request(app)
      .post('/api/v1/marketplace/list')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'have', mode: 'rent', title: 'rentable agent' });
    expect(res.status).toBe(400);
  });

  it('env-key caller CANNOT inherit another identity\'s RepID badge (impersonation blocked)', async () => {
    // An externally-distributed env REPID_API_KEYS key that is NOT bound to any
    // poster_id. resolvePosterIdentity re-reads process.env per call, so setting
    // it here (marketplace router is mounted before authMiddleware) is enough.
    process.env.REPID_API_KEYS = 'p0-impersonation-key:pro';
    delete process.env.REPID_API_KEY_POSTER_BINDINGS; // key is unbound → unverified

    const impMarker = `${marker}-IMPERSONATE`;
    // Declare SOPHIA — a real, trusted, high-RepID agent the caller does NOT own.
    const create = await request(app)
      .post('/api/v1/marketplace/list')
      .set('x-api-key', 'p0-impersonation-key')
      .send({ kind: 'have', mode: 'buy', title: impMarker, poster_id: 'SOPHIA' });

    // Listing is accepted (not hard-403'd) but flagged unverified with NO badge.
    expect(create.status).toBe(201);
    expect(create.body.poster_verified).toBe(false);
    expect(create.body.repid_at_post).toBeNull();
    impersonateListingId = create.body.listing_id;
    expect(typeof impersonateListingId).toBe('string');

    // On the public browse surface the borrowed badge must NOT appear: the
    // poster is marked unverified and repid/tier are null even though SOPHIA has
    // a real, high RepID in repid_agents.
    const browse = await request(app).get('/api/v1/marketplace/browse?kind=have');
    expect(browse.status).toBe(200);
    const found = browse.body.listings.find((l: any) => l.id === impersonateListingId);
    expect(found).toBeTruthy();
    expect(found.title).toBe(impMarker);
    expect(found.poster.verified).toBe(false);
    expect(found.poster.repid).toBeNull();
    expect(found.poster.tier).toBeNull();
    expect(found.poster.repid_at_post).toBeNull();
  });
});
