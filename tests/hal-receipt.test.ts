import express from 'express';
import request from 'supertest';

type Row = Record<string, unknown>;

const state: {
  probeError: { message: string } | null;
  votes: Row[];
  inserts: { table: string; row: Row }[];
} = { probeError: null, votes: [], inserts: [] };

function reset(): void {
  state.probeError = null;
  state.votes = [];
  state.inserts = [];
}

jest.mock('../src/db', () => ({
  db: {
    from(table: string) {
      return {
        select() {
          return {
            limit: async () => ({ error: state.probeError }),
            gte(_column: string, since: string) {
              const data = state.votes.filter((row) => String(row.created_at) >= since);
              return { limit: async () => ({ data, error: null }) };
            },
            order() {
              return {
                limit() {
                  return {
                    maybeSingle: async () => {
                      const sorted = [...state.votes].sort((a, b) =>
                        String(b.created_at).localeCompare(String(a.created_at)),
                      );
                      return { data: sorted[0] ?? null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        insert(row: Row) {
          const stored = { ...row, created_at: new Date().toISOString() };
          state.inserts.push({ table, row: stored });
          if (table === 'hal_quorum_validator_votes') state.votes.push(stored);
          const id = state.inserts.filter((item) => item.table === 'hal_quorum_receipts').length;
          return {
            select() {
              return { single: async () => ({ data: { id }, error: null }) };
            },
            then(onOk: (value: { error: null }) => unknown, onErr?: (error: unknown) => unknown) {
              return Promise.resolve({ error: null }).then(onOk, onErr);
            },
          };
        },
      };
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const halReceiptRouter = require('../src/routes/hal-receipt').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const honestyARouter = require('../src/routes/honesty-a').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const halLatestRouter = require('../src/routes/hal-latest').default;

const app = express();
app.use(express.json());
app.use('/api/v1/hal', halReceiptRouter);
app.use('/api/v1/hal', honestyARouter);
app.use('/api/v1', halLatestRouter);

const GOOD = { family: 'llama', host: 'groq', verdict: 'FALSE' };

describe('POST /api/v1/hal/receipt', () => {
  const previous = process.env.HAL_QUORUM_RECEIPT_ENABLED;

  afterEach(() => {
    reset();
    if (previous === undefined) delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
    else process.env.HAL_QUORUM_RECEIPT_ENABLED = previous;
  });

  it('inserts nothing when the flag is not exact true', async () => {
    for (const flag of [undefined, '', 'TRUE', 'on', '1']) {
      reset();
      if (flag === undefined) delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
      else process.env.HAL_QUORUM_RECEIPT_ENABLED = flag;
      const res = await request(app).post('/api/v1/hal/receipt').send(GOOD);
      expect(res.status).toBe(204);
      expect(state.inserts).toHaveLength(0);
    }
  });

  it('inserts nothing when the column probe fails', async () => {
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    state.probeError = { message: 'column host does not exist' };
    const res = await request(app).post('/api/v1/hal/receipt').send(GOOD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: false, reason: 'columns-missing' });
    expect(state.inserts).toHaveLength(0);
  });

  it('inserts one vote row and honesty-a shows it', async () => {
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    const before = await request(app).get('/api/v1/receipt/hal-latest');
    expect(before.status).toBe(404);
    expect(before.body).toEqual({ error: 'not_found' });
    const res = await request(app).post('/api/v1/hal/receipt').send(GOOD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: true });
    const votes = state.inserts.filter((item) => item.table === 'hal_quorum_validator_votes');
    expect(votes).toHaveLength(1);
    const row = votes[0]!.row;
    expect(row.family).toBe('llama');
    expect(row.host).toBe('groq');
    expect(row.verdict).toBe('FALSE');
    expect(row).not.toHaveProperty('user_id');
    expect(row).not.toHaveProperty('claim');
    expect(row).not.toHaveProperty('prompt');
    expect(JSON.stringify(state.inserts)).not.toContain('user_id');
    const tables = new Set(state.inserts.map((item) => item.table));
    expect(tables.has('repid_agents')).toBe(false);
    expect(tables.has('repid_score_events')).toBe(false);

    const honesty = await request(app).get('/api/v1/hal/honesty-a');
    expect(honesty.status).toBe(200);
    expect(honesty.body.status).toBe('counted');
    expect(honesty.body.rows).toHaveLength(1);
    expect(honesty.body.rows[0].family).toBe('llama');
    expect(honesty.body.rows[0].host).toBe('groq');
    expect(honesty.body.rows[0].FALSE).toBe(1);

    const latest = await request(app).get('/api/v1/receipt/hal-latest');
    expect(latest.status).toBe(200);
    expect(latest.body).toEqual({
      family: 'llama',
      host: 'groq',
      verdict: 'FALSE',
      created_at: row.created_at,
    });
    expect(JSON.stringify(latest.body)).not.toContain('claim');
    expect(JSON.stringify(latest.body)).not.toContain('user_id');
  });

  it('rejects a body that carries claim text', async () => {
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    const res = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...GOOD, claim: 'bitcoin text' });
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it('rejects prompt and user id fields', async () => {
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    const prompt = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...GOOD, prompt: 'say something' });
    const user = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...GOOD, user_id: 'abc' });
    expect(prompt.status).toBe(400);
    expect(user.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });
});
