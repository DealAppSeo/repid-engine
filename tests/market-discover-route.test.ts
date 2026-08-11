/**
 * market-discover — rung 0, the keyless discovery read.
 *
 * The cases that matter are the ones where a marketplace endpoint is normally, quietly dishonest:
 * an empty market returning `[]` as if the filters were merely tight, a bare score with no way to
 * check it, and a missing dimension silently scored as if it were measured.
 *
 * The db is mocked because booting the real app would connect to PRODUCTION Supabase and start
 * `processCascadeQueue` — a financial state transition on a 60s timer. A route test must never be
 * able to move money.
 */
import express from 'express';
import request from 'supertest';

const tables: Record<string, any[]> = {
  agent_services: [],
  repid_agents: [],
  dispute_claims: [],
  erc8004_reputation_writes: [],
};

/** Minimal chainable stub: every filter is a no-op, the awaited value is the table. */
function makeQuery(name: string) {
  const q: any = {
    select: () => q,
    eq: () => q,
    lte: () => q,
    in: () => q,
    limit: () => Promise.resolve({ data: tables[name] ?? [], error: null }),
    then: (r: any) => Promise.resolve({ data: tables[name] ?? [], error: null }).then(r),
  };
  return q;
}
jest.mock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/v1/market-discover').default;

const app = express();
app.use('/api/v1/market', router);

const svc = (over: Partial<any> = {}) => ({
  id: 's1',
  provider_agent_id: 'p1',
  service_type: 'verification',
  service_name: 'Constitutional Verification',
  description: 'checks a claim against the constitution',
  base_price_usdc_raw: 100_000, // $0.10
  total_fulfilled: 0,
  total_satisfied: 0,
  avg_satisfaction: null,
  capability_metadata: {},
  ...over,
});
const agent = (over: Partial<any> = {}) => ({
  id: 'p1',
  agent_name: 'trinity-shofet',
  current_repid: 2110,
  tier: 'ESTABLISHED',
  last_active_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  tables.agent_services = [svc()];
  tables.repid_agents = [agent()];
  tables.dispute_claims = [];
  tables.erc8004_reputation_writes = [{ agent_id: 'p1' }, { agent_id: 'p1' }];
});

describe('rung 0 is keyless and answers with evidence, not a bare number', () => {
  it('returns candidates with the dimensions actually used AND their evidence', async () => {
    const r = await request(app).get('/api/v1/market/discover');
    expect(r.status).toBe(200);
    const c = r.body.candidates[0];
    expect(c.provider).toBe('trinity-shofet');
    expect(c.score).toBeGreaterThan(0);
    expect(c.dimensions_used.length).toBeGreaterThan(0);
    for (const d of c.dimensions_used) expect(d.evidence).toMatch(/=/);
  });

  it('THE HONESTY BIT: unavailable dimensions are named, not folded into the score', async () => {
    const r = await request(app).get('/api/v1/market/discover');
    const c = r.body.candidates[0];
    // zero completed jobs -> no satisfaction, nothing to infer reliability from
    expect(c.dimensions_unavailable).toEqual(expect.arrayContaining(['satisfaction']));
    expect(c.dimensions_used.map((d: any) => d.dimension)).not.toContain('satisfaction');
    expect(c.notes.join(' ')).toMatch(/omitted, not defaulted/);
  });

  it('always reports what the model cannot compute at all', async () => {
    const r = await request(app).get('/api/v1/market/discover');
    expect(r.body.candidates[0].dimensions_not_implemented).toEqual(
      expect.arrayContaining(['sybil_risk', 'task_similarity']),
    );
  });

  it('coverage is returned so a thin score cannot pass as a confident one', async () => {
    const r = await request(app).get('/api/v1/market/discover');
    expect(r.body.candidates[0].coverage).toBeGreaterThan(0);
    expect(r.body.candidates[0].coverage).toBeLessThan(1); // satisfaction is missing here
    expect(r.body.interpretation).toMatch(/comparable coverage/);
  });

  it('prices are returned in dollars, not raw 6-decimal USDC', async () => {
    const r = await request(app).get('/api/v1/market/discover');
    expect(r.body.candidates[0].price_usdc).toBeCloseTo(0.1, 6);
  });
});

describe('an empty market is a RESULT that explains itself', () => {
  it('says the market is empty rather than returning a bare []', async () => {
    tables.agent_services = [];
    const r = await request(app).get('/api/v1/market/discover');
    expect(r.status).toBe(200);
    expect(r.body.candidates).toEqual([]);
    expect(r.body.note).toMatch(/market is empty for this query, not filtered out/);
  });

  it('reports how many services were considered vs matched', async () => {
    const r = await request(app).get('/api/v1/market/discover?q=nonexistent-capability');
    expect(r.body.market.services_considered).toBe(1);
    expect(r.body.market.services_matching_filters).toBe(0);
    expect(r.body.candidates).toEqual([]);
  });
});

describe('filters', () => {
  it('min_repid excludes a provider below the bar', async () => {
    const r = await request(app).get('/api/v1/market/discover?min_repid=5000');
    expect(r.body.candidates).toHaveLength(0);
    expect(r.body.market.candidates_scored).toBe(0);
  });

  it('min_coverage can reject thinly-evidenced candidates entirely', async () => {
    const r = await request(app).get('/api/v1/market/discover?min_coverage=0.99');
    expect(r.body.candidates).toHaveLength(0);
  });

  it('free-text q is a substring match over the listing, not a fake relevance score', async () => {
    const hit = await request(app).get('/api/v1/market/discover?q=constitution');
    expect(hit.body.candidates).toHaveLength(1);
    const miss = await request(app).get('/api/v1/market/discover?q=solidity');
    expect(miss.body.candidates).toHaveLength(0);
  });
});

describe('a catastrophic failure is visible and cannot be hidden by volume', () => {
  it('a lost dispute drops the score and says so', async () => {
    tables.agent_services = [svc({ total_fulfilled: 500, avg_satisfaction: 1 })];
    const clean = await request(app).get('/api/v1/market/discover');
    const cleanScore = clean.body.candidates[0].score;

    tables.dispute_claims = [{ defendant_agent: 'trinity-shofet', status: 'resolved' }];
    const failed = await request(app).get('/api/v1/market/discover');
    const c = failed.body.candidates[0];

    expect(c.score).toBeLessThan(cleanScore);
    expect(c.failure_penalty).toBeLessThan(1);
    expect(c.notes.join(' ')).toMatch(/volume cannot offset/);
  });
});
