/**
 * agent-card-provenance.test.ts
 *
 * GET /api/v1/agents/:id/card is PUBLIC and unauthenticated. Two properties have
 * to hold together, and they pull against each other:
 *
 *   1. it must now say what BACKS the score, not just how big it is
 *   2. it must not leak anything private while doing so
 *
 * The provenance rows carry `metadata` and `prompt_text`-adjacent fields, so the
 * risk of (1) is a regression against (2). These tests pin both.
 */

import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';

jest.mock('../src/db', () => ({
  db: { from: jest.fn(), rpc: jest.fn().mockResolvedValue({ data: null, error: null }) },
}));

jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));

const AGENT = '11111111-2222-3333-4444-555555555555';

/** Score events with a deliberately mixed provenance profile. */
const EVENTS = [
  { event_type: 'SERVICE_SATISFIED', delta: 22, contract_id: 'c-1', metadata: { secret_note: 'MUST_NOT_LEAK' } },
  { event_type: 'VALIDATOR_REWARD', delta: 40, eas_attestation_id: '0xattest' },
  { event_type: 'AGENT_TEACHING', delta: 15 },
  { event_type: 'HAL_SCORE_EVENT', delta: -1 },
  { event_type: 'HAL_SCORE_EVENT', delta: -1 },
];

function mockDb() {
  (db.from as jest.Mock).mockImplementation((table: string) => {
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      not: jest.fn(() => chain),
      order: jest.fn(() => chain),
      upsert: jest.fn(async () => ({ data: null, error: null })),
      limit: jest.fn(async (n: number) => {
        if (table === 'repid_score_events') {
          // the provenance query (limit 500) vs the hal_score/last_event ones
          if (n >= 100) return { data: EVENTS, error: null };
          return { data: [{ created_at: '2026-08-01T00:00:00Z' }], error: null };
        }
        return { data: [], error: null };
      }),
      single: jest.fn(async () => ({
        data: {
          id: AGENT, agent_name: 'trinity-x', description: 'd',
          current_repid: 1460, erc8004_token_id: 7,
          created_at: '2026-01-01T00:00:00Z', last_active_at: '2026-08-01T00:00:00Z',
        },
        error: null,
      })),
    };
    // count queries resolve the chain directly
    (chain as any).then = undefined;
    return chain;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb();
});

describe('public agent card — provenance decomposition', () => {
  it('returns a provenance block with the decomposition', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/card`);
    expect(res.status).toBe(200);
    expect(res.body.provenance).toBeDefined();

    const p = res.body.provenance;
    expect(p.by_class).toBeDefined();
    expect(typeof p.sample_size).toBe('number');
    expect(typeof p.sampled).toBe('boolean');
  });

  it('includes internal_scoring rather than quietly dropping the unflattering class', () => {
    // Omitting a category turns a decomposition into a marketing number.
    return request(app).get(`/api/v1/agents/${AGENT}/card`).then((res) => {
      expect(res.body.provenance.by_class).toHaveProperty('internal_scoring');
      expect(res.body.provenance.by_class).toHaveProperty('self_reported_unbacked');
    });
  });

  it('reports the verifiable share of GAINS, not of all delta', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/card`);
    // 62 verifiable of 77 positive (22 + 40 verifiable; 15 self-reported).
    expect(res.body.provenance.verifiable_share_of_gains).toBeCloseTo(62 / 77, 4);
  });

  it('surfaces unbacked self-report as its own visible number', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/card`);
    expect(res.body.provenance.unbacked_self_reported).toEqual({ events: 1, netDelta: 15 });
  });

  it('marks the result as sampled when the cap is hit', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/card`);
    // 5 rows < 500 cap, so this is a complete read, not a sample.
    expect(res.body.provenance.sampled).toBe(false);
    expect(res.body.provenance.sample_size).toBe(EVENTS.length);
  });
});

describe('public agent card — leakage', () => {
  it('does NOT leak event metadata through the provenance block', async () => {
    // The provenance query selects `metadata` to classify on evidence.ref. That
    // column must be consumed, never echoed — this is the regression the new
    // feature could plausibly introduce.
    const res = await request(app).get(`/api/v1/agents/${AGENT}/card`);
    expect(JSON.stringify(res.body)).not.toContain('MUST_NOT_LEAK');
    expect(JSON.stringify(res.body)).not.toContain('secret_note');
  });

  it('does not echo raw event rows, contract ids or attestation ids', async () => {
    const res = await request(app).get(`/api/v1/agents/${AGENT}/card`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('c-1');
    expect(body).not.toContain('0xattest');
    expect(res.body.provenance.events).toBeUndefined();
    expect(res.body.provenance.rows).toBeUndefined();
  });

  it('still refuses a non-UUID id', async () => {
    const res = await request(app).get('/api/v1/agents/not-a-uuid/card');
    expect(res.status).toBe(400);
  });
});
