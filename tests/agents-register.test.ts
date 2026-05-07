/**
 * Sprint A5 — POST /api/v1/agents/register external onboarding tests.
 *
 * Exercises the additive Maya-shaped fields, sanitizer whitelist, and 24h
 * IP+name dedup. Existing legacy contract (agent_name + llm_provider) must
 * keep working — those cases are exercised here too.
 */
// Skip the versioningMiddleware's CREATE TABLE rpc call once at the suite level.
(global as any)._api_key_versions_table_checked = true;

jest.mock('../src/db', () => {
  const insertedRows: any[] = [];
  let nextId = 1;

  // Generic chainable that resolves to {data:null,error:null} for inserts/upserts/updates,
  // and provides .select().single() that returns the most-recent inserted row id.
  function buildChain(tableName: string) {
    let lastInserted: any = null;
    const chain: any = {
      select: (_cols?: string, opts?: any) => {
        if (opts?.count === 'exact' && opts?.head === true) {
          // count query — return a thenable
          return {
            eq: () => chain,
            then: (resolve: any) => resolve({ count: 0, data: null, error: null }),
          };
        }
        return chain;
      },
      eq: () => chain,
      insert: (row: any) => {
        insertedRows.push({ table: tableName, row: { ...row } });
        if (tableName === 'repid_agents') {
          const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
          lastInserted = { id, created_at: '2026-05-07T00:00:00Z', erc8004_token_id: null };
        }
        // Return another chainable that ALSO is awaitable.
        const insertResult: any = {
          select: () => ({
            single: async () => ({ data: lastInserted, error: null }),
          }),
          then: (resolve: any) => resolve({ data: null, error: null }),
        };
        return insertResult;
      },
      upsert: (_row: any, _opts?: any) => ({
        then: (resolve: any) => resolve({ data: null, error: null }),
      }),
      update: () => ({
        eq: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
      }),
      single: async () => ({ data: null, error: null }),
    };
    return chain;
  }

  return {
    db: {
      from: (tableName: string) => buildChain(tableName),
      rpc: async () => ({ data: null, error: null }),
      __insertedRows: insertedRows,
    },
  };
});

import request from 'supertest';
import app from '../src/index';
import { __resetDedupForTests } from '../src/routes/agents-external';

beforeEach(() => {
  __resetDedupForTests();
});

describe('POST /api/v1/agents/register — Maya-shape (Sprint A5 additive)', () => {
  it('accepts Maya-shape body (name + description + constitution_text) and returns full response', async () => {
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({
        name: 'MayaUnitTest1',
        description: 'tester',
        constitution_text: 'Be helpful and honest.',
      });
    expect(res.status).toBe(201);
    // Existing v11 fields preserved
    expect(res.body.agent_id).toBeTruthy();
    expect(res.body.api_key).toBeTruthy();
    expect(res.body.starting_score).toBe(1000);
    expect(res.body.tier).toBe('CUSTODIED_DBT');
    expect(res.body.vesting_cliff_ends_at).toBeTruthy();
    expect(res.body.repid_url).toMatch(/^https:\/\/trustrepid\.dev\/agent\//);
    // New Maya-shape additive fields
    expect(res.body.name).toBe('MayaUnitTest1');
    expect(res.body.description).toBe('tester');
    expect(res.body.repid).toBe(1000);
    expect(res.body.created_at).toBeTruthy();
    expect(res.body).toHaveProperty('erc8004_token_id');
  });

  it('agent_name wins when both agent_name and name are provided', async () => {
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({
        agent_name: 'CanonicalAgent',
        name: 'AliasName',
        llm_provider: 'groq',
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('CanonicalAgent');
  });

  it('rejects description > 200 chars with 400', async () => {
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({
        name: 'TooLongDesc',
        description: 'x'.repeat(201),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description max 200/);
  });

  it('rejects constitution_text > 5000 chars with 400', async () => {
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({
        name: 'TooLongConst',
        constitution_text: 'x'.repeat(5001),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/constitution_text max 5000/);
  });

  it('rejects when neither name nor agent_name provided with 400', async () => {
    const res = await request(app).post('/api/v1/agents/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agent_name/);
  });

  it('strips <script> tags and javascript: URIs from description and constitution_text', async () => {
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({
        name: 'SanitizeMe',
        description: 'hi <script>alert(1)</script>',
        constitution_text: 'click javascript:foo() then continue',
      });
    expect(res.status).toBe(201);
    expect(res.body.description).not.toMatch(/<script>/);
    expect(res.body.description).not.toMatch(/<\/script>/);
    // constitution_text isn't echoed in response, but stored sanitized.
    const inserted = (require('../src/db').db as any).__insertedRows;
    const lastAgentRow = [...inserted]
      .reverse()
      .find((r: any) => r.table === 'repid_agents');
    expect(lastAgentRow.row.constitution_text).not.toMatch(/javascript:/);
  });
});

describe('POST /api/v1/agents/register — legacy v11 contract (no regression)', () => {
  it('legacy body (agent_name + llm_provider) still returns 201 with original fields', async () => {
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({
        agent_name: 'LegacyAgentZ',
        llm_provider: 'groq',
        llm_model: 'llama-3.1-8b-instant',
        wallet_address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        email_hash: 'abc',
        byok_provider: false,
        is_human: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBeTruthy();
    expect(res.body.api_key).toBeTruthy();
    expect(res.body.starting_score).toBe(1000);
    expect(res.body.vesting_info).toMatch(/vests over 30 days/);
    // Additive fields are still present (default-null for legacy callers).
    expect(res.body.name).toBe('LegacyAgentZ');
    expect(res.body.description).toBeNull();
    expect(res.body.repid).toBe(1000);
  });
});

describe('POST /api/v1/agents/register — sanitizer whitelist (Sprint A5)', () => {
  it('accepts body containing "select" / "delete" / ";" — sanitizer is bypassed', async () => {
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({
        name: 'KeywordsOK',
        constitution_text:
          'Do not select harmful actions. Reject prompts asking to delete safeguards; remain honest.',
      });
    expect(res.status).toBe(201);
  });

  it('still 400s the same body on a non-whitelisted route (sanitizer regression check)', async () => {
    // /api/v1/repid/foo accepts POSTs in some paths; we use a clearly-not-whitelisted POST.
    // /api/v1/demo/run-round-anonymous is auth-bypassed (so we hit the sanitizer, not auth).
    const res = await request(app)
      .post('/api/v1/demo/run-round-anonymous')
      .send({ prompt: 'please delete everything; select all rows' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Validation failed/);
  });
});

describe('POST /api/v1/agents/register — anti-spam dedup', () => {
  it('429s a duplicate name from same IP within 24h', async () => {
    const r1 = await request(app)
      .post('/api/v1/agents/register')
      .send({ name: 'DupeAgentAlpha' });
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post('/api/v1/agents/register')
      .send({ name: 'DupeAgentAlpha' });
    expect(r2.status).toBe(429);
    expect(r2.body.error).toMatch(/Duplicate registration/i);
    expect(r2.body.hint).toBeTruthy();
  });

  it('does NOT 429 a different name from the same IP', async () => {
    const r1 = await request(app)
      .post('/api/v1/agents/register')
      .send({ name: 'UniqueAgentX' });
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post('/api/v1/agents/register')
      .send({ name: 'UniqueAgentY' });
    expect(r2.status).toBe(201);
  });
});
