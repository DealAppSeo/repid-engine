/**
 * TrustMarket P0 — humans carry a RepID badge too.
 *
 * The bug: resolveCurrentRepid() returned null for `poster_type='human'`, and
 * the /browse enrichment only batched agent posters. So a human listing rendered
 * with no reputation while the agent listing beside it showed a score and a tier.
 * On a marketplace whose whole proposition is "you can see who you are dealing
 * with", the side that cannot show a score is the side nobody transacts with —
 * which is one reason the human leg of the loop has never been exercised.
 *
 * `builders.current_repid` has existed the whole time (seeded at the AUTONOMOUS
 * floor on signup, moved by the same score events as everything else). This
 * reads it, and derives the tier the same way compute_tier() does for agents so
 * the badge means the same thing on both sides.
 *
 * Mounts the P0 router in a bare express app with a mocked db, so it runs under
 * a plain `npm test` — unlike marketplace-p0.test.ts, which needs live TEST
 * Supabase creds and skips without them.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key-for-import';

// ---------------------------------------------------------------------------
// db mock: per-table capture of the filter used, so we can assert the human
// batch actually queried `builders`.
// ---------------------------------------------------------------------------
interface TableFixture {
  rows: any[];
}
const fixtures: Record<string, TableFixture> = {};
const queriedTables: string[] = [];

function makeQuery(table: string) {
  queriedTables.push(table);
  const q: any = {};
  const chain = () => q;
  for (const m of ['select', 'eq', 'ilike', 'limit', 'order', 'in', 'gte', 'lt', 'is', 'or']) {
    q[m] = jest.fn(chain);
  }
  const result = () => ({ data: fixtures[table]?.rows ?? [], error: null });
  q.then = (resolve: any) => resolve(result());
  q.maybeSingle = jest.fn(async () => {
    const rows = fixtures[table]?.rows ?? [];
    return { data: rows[0] ?? null, error: null };
  });
  q.single = q.maybeSingle;
  return q;
}

jest.mock('../src/db', () => ({
  db: { from: jest.fn((table: string) => makeQuery(table)) },
}));

import express from 'express';
import request from 'supertest';
import marketplaceRouter from '../src/routes/marketplace';

const app = express();
app.use(express.json());
app.use('/api/v1/marketplace', marketplaceRouter);

const HUMAN_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  for (const k of Object.keys(fixtures)) delete fixtures[k];
  queriedTables.length = 0;
  jest.clearAllMocks();
});

describe('GET /browse — human posters get a live RepID badge', () => {
  it('reads builders.current_repid and derives the tier', async () => {
    fixtures['marketplace_listings'] = {
      rows: [
        {
          id: 'listing-1',
          poster_type: 'human',
          poster_id: HUMAN_ID,
          kind: 'want',
          category: 'research',
          title: 'Need a market scan',
          description: null,
          price_usdc: 5,
          mode: 'buy',
          rent_period: null,
          status: 'open',
          repid_at_post: null,
          created_at: '2026-08-02T00:00:00Z',
          expires_at: null,
        },
      ],
    };
    fixtures['builders'] = { rows: [{ id: HUMAN_ID, current_repid: 5000 }] };

    const res = await request(app).get('/api/v1/marketplace/browse');
    expect(res.status).toBe(200);
    const card = res.body.listings[0];
    expect(card.poster.type).toBe('human');
    expect(card.poster.repid).toBe(5000);
    // 5000 is the AUTONOMOUS floor — same thresholds as the agent badge.
    expect(card.poster.tier).toBe('AUTONOMOUS');
    expect(queriedTables).toContain('builders');
  });

  it('falls back to the at-post snapshot when the builder row is gone', async () => {
    fixtures['marketplace_listings'] = {
      rows: [
        {
          id: 'listing-2',
          poster_type: 'human',
          poster_id: HUMAN_ID,
          kind: 'have',
          category: null,
          title: 'Deleted account listing',
          description: null,
          price_usdc: null,
          mode: 'buy',
          rent_period: null,
          status: 'open',
          repid_at_post: 1200,
          created_at: '2026-08-02T00:00:00Z',
          expires_at: null,
        },
      ],
    };
    fixtures['builders'] = { rows: [] };

    const res = await request(app).get('/api/v1/marketplace/browse');
    expect(res.status).toBe(200);
    const card = res.body.listings[0];
    expect(card.poster.repid).toBe(1200);
    expect(card.poster.tier).toBe('ESTABLISHED');
  });

  it('leaves the badge null when there is no score anywhere — never invents one', async () => {
    fixtures['marketplace_listings'] = {
      rows: [
        {
          id: 'listing-3',
          poster_type: 'human',
          poster_id: HUMAN_ID,
          kind: 'want',
          category: null,
          title: 'Brand new account',
          description: null,
          price_usdc: null,
          mode: 'buy',
          rent_period: null,
          status: 'open',
          repid_at_post: null,
          created_at: '2026-08-02T00:00:00Z',
          expires_at: null,
        },
      ],
    };
    fixtures['builders'] = { rows: [{ id: HUMAN_ID, current_repid: null }] };

    const res = await request(app).get('/api/v1/marketplace/browse');
    const card = res.body.listings[0];
    expect(card.poster.repid).toBeNull();
    expect(card.poster.tier).toBeNull();
  });

  it('does not query builders when every poster is an agent', async () => {
    fixtures['marketplace_listings'] = {
      rows: [
        {
          id: 'listing-4',
          poster_type: 'agent',
          poster_id: AGENT_ID,
          kind: 'have',
          category: null,
          title: 'Verification service',
          description: null,
          price_usdc: 1,
          mode: 'buy',
          rent_period: null,
          status: 'open',
          repid_at_post: 900,
          created_at: '2026-08-02T00:00:00Z',
          expires_at: null,
        },
      ],
    };
    fixtures['repid_agents'] = { rows: [{ id: AGENT_ID, current_repid: 2100, tier: 'ESTABLISHED' }] };

    const res = await request(app).get('/api/v1/marketplace/browse');
    expect(res.status).toBe(200);
    expect(res.body.listings[0].poster.repid).toBe(2100);
    expect(queriedTables).not.toContain('builders');
  });
});
