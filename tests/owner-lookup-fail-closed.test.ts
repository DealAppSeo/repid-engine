/**
 * [F1] A failed owner read is not "nobody owns it".
 *
 * ownerOfAgent (src/services/human-agent-binding.ts) used to ignore the database error and return
 * null, so every caller read a blip as "unowned". For the grant route that meant "today's rules
 * apply" — widening with no approval — and the public owner route answered "No owner". It now
 * throws, and the routes answer 503: we could not look.
 */
import express from 'express';
import request from 'supertest';

const mockFail = { bindings: true };

jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const c: any = {
      select: () => c, eq: () => c, is: () => c, order: () => c,
      maybeSingle: async () =>
        table === 'human_agent_bindings' && mockFail.bindings
          ? { data: null, error: { message: 'connection reset' } }
          : { data: null, error: null },
      then: (r: any) => r({ data: [], error: null }),
    };
    return c;
  };
  return { db: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ownerOfAgent } = require('../src/services/human-agent-binding');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const byokRouter = require('../src/routes/v1/byok').default;

const AGENT = 'aaaaaaaa-1111-2222-3333-444444444444';

describe('ownerOfAgent', () => {
  it('throws on a read error instead of returning "no owner"', async () => {
    mockFail.bindings = true;
    await expect(ownerOfAgent(AGENT)).rejects.toThrow(/owner lookup failed/);
  });

  it('still returns null when there is genuinely no binding', async () => {
    mockFail.bindings = false;
    await expect(ownerOfAgent(AGENT)).resolves.toBeNull();
  });
});

describe('GET /api/v1/agents/:id/owner', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/v1', byokRouter);
    return a;
  };

  it('answers 503 NOT CHECKED when the owner cannot be read — never "No owner"', async () => {
    mockFail.bindings = true;
    const res = await request(app()).get(`/api/v1/agents/${AGENT}/owner`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('owner_not_checked');
    expect(JSON.stringify(res.body)).not.toMatch(/No owner/);
  });

  it('answers "not owned" only when the read succeeded and found nothing', async () => {
    mockFail.bindings = false;
    const res = await request(app()).get(`/api/v1/agents/${AGENT}/owner`);
    expect(res.status).toBe(200);
    expect(res.body.owned).toBe(false);
  });
});
