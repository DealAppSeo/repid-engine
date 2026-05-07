/**
 * Sprint A5 — GET /api/v1/agents/:id/card public profile tests.
 *
 * Verifies UUID validation, 404 on missing, public-safe field projection
 * (no constitution, no api_key, no email_hash, no wallet_address etc.),
 * and total_decisions count.
 */

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

(global as any)._api_key_versions_table_checked = true;
// State variables read by the jest.mock factory below. Use globalThis so the
// hoisted factory can resolve them at module-load time.
(global as any).__cardTestAgentRow = null;
(global as any).__cardTestCountResult = 0;

jest.mock('../src/db', () => {
  return {
    db: {
      from: (tableName: string) => {
        if (tableName === 'repid_score_events') {
          // Sprint A7: card now also runs SELECT('hal_score').not().order().limit()
          // and SELECT('created_at').order().limit(). Mock supports both chains.
          const chain: any = {
            select: (_cols?: string, opts?: any) => {
              chain._isCount = !!(opts && opts.head);
              return chain;
            },
            eq: () => chain,
            not: () => chain,
            order: () => chain,
            limit: () => chain,
            then: (resolve: any) => {
              if (chain._isCount) {
                resolve({ count: (global as any).__cardTestCountResult ?? 0, data: null, error: null });
              } else {
                resolve({ data: (global as any).__cardTestEventRows ?? [], error: null });
              }
            },
          };
          return chain;
        }
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          single: async () => {
            const ar = (global as any).__cardTestAgentRow ?? null;
            return { data: ar, error: ar ? null : { message: 'not found' } };
          },
          insert: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
          upsert: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
        };
        return chain;
      },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

import request from 'supertest';
import app from '../src/index';

beforeEach(() => {
  (global as any).__cardTestAgentRow = null;
  (global as any).__cardTestCountResult = 0;
  (global as any).__cardTestEventRows = [];
});

describe('GET /api/v1/agents/:id/card', () => {
  it('400s on non-UUID id', async () => {
    const res = await request(app).get('/api/v1/agents/not-a-uuid/card');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UUID/i);
  });

  it('404s when agent does not exist', async () => {
    (global as any).__cardTestAgentRow = null;
    const res = await request(app).get(`/api/v1/agents/${VALID_UUID}/card`);
    expect(res.status).toBe(404);
  });

  it('returns public-safe fields and decision count for an existing agent', async () => {
    (global as any).__cardTestAgentRow = {
      id: VALID_UUID,
      agent_name: 'PublicCardAgent',
      description: 'a description',
      current_repid: 1234,
      erc8004_token_id: '42',
      created_at: '2026-05-07T01:00:00Z',
      last_active_at: '2026-05-07T02:00:00Z',
    };
    (global as any).__cardTestCountResult = 7;
    const res = await request(app).get(`/api/v1/agents/${VALID_UUID}/card`);
    expect(res.status).toBe(200);
    expect(res.body.agent_id).toBe(VALID_UUID);
    expect(res.body.name).toBe('PublicCardAgent');
    expect(res.body.description).toBe('a description');
    expect(res.body.repid).toBe(1234);
    expect(res.body.erc8004_token_id).toBe('42');
    expect(res.body.total_decisions).toBe(7);
    expect(res.body.base_sepolia_explorer_url).toMatch(/sepolia\.basescan\.org/);
    expect(res.body.created_at).toBe('2026-05-07T01:00:00Z');
    expect(res.body.last_active_at).toBe('2026-05-07T02:00:00Z');
  });

  it('does NOT expose private fields (constitution, api_key, wallet_address, email_hash)', async () => {
    (global as any).__cardTestAgentRow = {
      id: VALID_UUID,
      agent_name: 'PrivacyAgent',
      description: null,
      current_repid: 1000,
      erc8004_token_id: null,
      created_at: '2026-05-07T03:00:00Z',
      last_active_at: null,
      // Even if these slipped through the SELECT, the response must not echo them.
      constitution: { api_key: 'secret-leaked' },
      constitution_text: 'private rules',
      conservator_address: '0xPRIVATE',
    };
    const res = await request(app).get(`/api/v1/agents/${VALID_UUID}/card`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('constitution');
    expect(res.body).not.toHaveProperty('constitution_text');
    expect(res.body).not.toHaveProperty('api_key');
    expect(res.body).not.toHaveProperty('wallet_address');
    expect(res.body).not.toHaveProperty('email_hash');
    expect(res.body).not.toHaveProperty('conservator_address');
  });

  // Sprint A7 — new aggregate fields.
  it('returns Sprint A7 score-event aggregates (total_*, avg_hal_score, last_event_at)', async () => {
    (global as any).__cardTestAgentRow = {
      id: VALID_UUID,
      agent_name: 'AggregateAgent',
      description: null,
      current_repid: 1000,
      erc8004_token_id: null,
      created_at: '2026-05-07T03:00:00Z',
      last_active_at: '2026-05-07T04:00:00Z',
    };
    (global as any).__cardTestCountResult = 5;
    (global as any).__cardTestEventRows = [
      { hal_score: 0.1, created_at: '2026-05-07T05:00:00Z' },
      { hal_score: 0.2, created_at: '2026-05-07T05:00:00Z' },
      { hal_score: 0.3, created_at: '2026-05-07T05:00:00Z' },
    ];
    const res = await request(app).get(`/api/v1/agents/${VALID_UUID}/card`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_score_events');
    expect(res.body).toHaveProperty('total_clean');
    expect(res.body).toHaveProperty('total_flagged');
    expect(res.body).toHaveProperty('total_vetoed');
    expect(res.body).toHaveProperty('avg_hal_score');
    expect(res.body).toHaveProperty('last_event_at');
    // avg of [0.1, 0.2, 0.3] = 0.2
    expect(res.body.avg_hal_score).toBeCloseTo(0.2, 5);
    expect(res.body.last_event_at).toBe('2026-05-07T05:00:00Z');
  });

  it('handles agents with zero events (avg null, last_event_at null)', async () => {
    (global as any).__cardTestAgentRow = {
      id: VALID_UUID,
      agent_name: 'NoEventsAgent',
      description: null,
      current_repid: 1000,
      erc8004_token_id: null,
      created_at: '2026-05-07T03:00:00Z',
      last_active_at: null,
    };
    (global as any).__cardTestCountResult = 0;
    (global as any).__cardTestEventRows = [];
    const res = await request(app).get(`/api/v1/agents/${VALID_UUID}/card`);
    expect(res.status).toBe(200);
    expect(res.body.total_score_events).toBe(0);
    expect(res.body.total_clean).toBe(0);
    expect(res.body.total_flagged).toBe(0);
    expect(res.body.total_vetoed).toBe(0);
    expect(res.body.avg_hal_score).toBeNull();
    expect(res.body.last_event_at).toBeNull();
  });

  it('returns null base_sepolia_explorer_url when no erc8004_token_id', async () => {
    (global as any).__cardTestAgentRow = {
      id: VALID_UUID,
      agent_name: 'NoTokenAgent',
      description: null,
      current_repid: 1000,
      erc8004_token_id: null,
      created_at: '2026-05-07T03:00:00Z',
      last_active_at: null,
    };
    const res = await request(app).get(`/api/v1/agents/${VALID_UUID}/card`);
    expect(res.status).toBe(200);
    expect(res.body.base_sepolia_explorer_url).toBeNull();
    expect(res.body.erc8004_token_id).toBeNull();
  });
});
