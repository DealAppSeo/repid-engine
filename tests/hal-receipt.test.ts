import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { writeReceiptVote } from '../src/hal/quorum-receipt-writer';

type Row = Record<string, unknown>;

const state: {
  probeError: { message: string } | null;
  receiptError: { message: string } | null;
  voteError: { message: string } | null;
  votes: Row[];
  inserts: { table: string; row: Row }[];
} = { probeError: null, receiptError: null, voteError: null, votes: [], inserts: [] };

function reset(): void {
  state.probeError = null;
  state.receiptError = null;
  state.voteError = null;
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
          const failed =
            table === 'hal_quorum_receipts'
              ? state.receiptError
              : table === 'hal_quorum_validator_votes'
                ? state.voteError
                : null;
          if (failed) {
            return {
              select() {
                return { single: async () => ({ data: null, error: failed }) };
              },
              then(onOk: (value: { error: { message: string } }) => unknown, onErr?: (error: unknown) => unknown) {
                return Promise.resolve({ error: failed }).then(onOk, onErr);
              },
            };
          }
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
    const res = await request(app).post('/api/v1/hal/receipt').send(GOOD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: true });
    const receipts = state.inserts.filter((item) => item.table === 'hal_quorum_receipts');
    const votes = state.inserts.filter((item) => item.table === 'hal_quorum_validator_votes');
    expect(receipts).toHaveLength(1);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.row.receipt_id).toBe(1);
    expect(receipts[0]!.row.decision).toBe('FALSE');
    expect(receipts[0]!.row).not.toHaveProperty('claim');
    expect(receipts[0]!.row).not.toHaveProperty('user_id');
    const row = votes[0]!.row;
    expect(row.family).toBe('llama');
    expect(row.host).toBe('groq');
    expect(row.verdict).toBe('FALSE');
    expect(typeof row.created_at).toBe('string');
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
    expect(JSON.stringify(latest.body)).not.toContain('user_id');
    expect(JSON.stringify(latest.body)).not.toContain('claim');
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

  it('posts the glm cerebras FALSE fixture only when the flag is exact true', async () => {
    const fixture = JSON.parse(
      readFileSync(path.join(__dirname, 'fixtures', 'hal-receipt-glm.json'), 'utf8'),
    ) as { family: string; host: string; verdict: string };
    delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
    const off = await request(app).post('/api/v1/hal/receipt').send(fixture);
    expect(off.status).toBe(204);
    expect(state.inserts).toHaveLength(0);

    reset();
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'TRUE';
    const folded = await request(app).post('/api/v1/hal/receipt').send(fixture);
    expect(folded.status).toBe(204);
    expect(state.inserts).toHaveLength(0);

    reset();
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    const claim = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...fixture, claim: 'bitcoin text' });
    const prompt = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...fixture, prompt: 'say something' });
    const user = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...fixture, user_id: 'abc' });
    expect(claim.status).toBe(400);
    expect(prompt.status).toBe(400);
    expect(user.status).toBe(400);
    expect(state.inserts).toHaveLength(0);

    reset();
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    state.probeError = { message: 'column host does not exist' };
    const missing = await request(app).post('/api/v1/hal/receipt').send(fixture);
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ written: false, reason: 'columns-missing' });
    expect(state.inserts).toHaveLength(0);

    reset();
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    const before = await request(app).get('/api/v1/receipt/hal-latest');
    expect(before.status).toBe(404);
    expect(before.body).toEqual({ error: 'not_found' });

    const res = await request(app).post('/api/v1/hal/receipt').send(fixture);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: true });
    const votes = state.inserts.filter((item) => item.table === 'hal_quorum_validator_votes');
    expect(votes).toHaveLength(1);
    expect(votes[0]!.row.receipt_id).toBe(1);
    const row = votes[0]!.row;
    expect(row.family).toBe('glm');
    expect(row.host).toBe('cerebras');
    expect(row.verdict).toBe('FALSE');
    expect(row).not.toHaveProperty('claim');

    const latest = await request(app).get('/api/v1/receipt/hal-latest');
    expect(latest.status).toBe(200);
    expect(latest.body).toEqual({
      family: 'glm',
      host: 'cerebras',
      verdict: 'FALSE',
      created_at: row.created_at,
    });
    expect(JSON.stringify(latest.body)).not.toContain('claim');

    const honesty = await request(app).get('/api/v1/hal/honesty-a');
    expect(honesty.status).toBe(200);
    expect(honesty.body.status).toBe('counted');
    expect(honesty.body.rows[0].first_pass).toEqual({ TRUE: 0, FALSE: 1, NOT_CHECKED: 0 });
    expect(JSON.stringify(honesty.body)).not.toContain('user_id');
    expect(JSON.stringify(honesty.body)).not.toContain('"claim"');
  });

  it('accepts UNCERTAIN and still refuses extras, a folded flag, and missing columns', async () => {
    const body = { family: 'glm', host: 'cerebras', verdict: 'UNCERTAIN' };
    delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
    const off = await request(app).post('/api/v1/hal/receipt').send(body);
    expect(off.status).toBe(204);
    expect(state.inserts).toHaveLength(0);

    reset();
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    const claim = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...body, claim: 'bitcoin text' });
    const prompt = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...body, prompt: 'say something' });
    const user = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...body, user_id: 'abc' });
    const maybe = await request(app)
      .post('/api/v1/hal/receipt')
      .send({ ...body, verdict: 'MAYBE' });
    expect(claim.status).toBe(400);
    expect(prompt.status).toBe(400);
    expect(user.status).toBe(400);
    expect(maybe.status).toBe(400);
    expect(state.inserts).toHaveLength(0);

    reset();
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    state.probeError = { message: 'column host does not exist' };
    const missing = await request(app).post('/api/v1/hal/receipt').send(body);
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ written: false, reason: 'columns-missing' });
    expect(state.inserts).toHaveLength(0);

    reset();
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    const before = await request(app).get('/api/v1/receipt/hal-latest');
    expect(before.status).toBe(404);
    expect(before.body).toEqual({ error: 'not_found' });

    const res = await request(app).post('/api/v1/hal/receipt').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: true });
    const receipts = state.inserts.filter((item) => item.table === 'hal_quorum_receipts');
    const votes = state.inserts.filter((item) => item.table === 'hal_quorum_validator_votes');
    expect(receipts).toHaveLength(1);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.row.receipt_id).toBe(1);
    expect(receipts[0]!.row.decision).toBe('UNCERTAIN');
    expect(receipts[0]!.row).not.toHaveProperty('claim');
    expect(receipts[0]!.row).not.toHaveProperty('user_id');
    const row = votes[0]!.row;
    expect(row.family).toBe('glm');
    expect(row.host).toBe('cerebras');
    expect(row.verdict).toBe('UNCERTAIN');
    expect(row.first_pass_verdict).toBeNull();
    expect(row).not.toHaveProperty('claim');
    expect(row).not.toHaveProperty('user_id');

    const latest = await request(app).get('/api/v1/receipt/hal-latest');
    expect(latest.status).toBe(200);
    expect(latest.body).toEqual({
      family: 'glm',
      host: 'cerebras',
      verdict: 'UNCERTAIN',
      created_at: row.created_at,
    });
    expect(JSON.stringify(latest.body)).not.toContain('claim');

    const honesty = await request(app).get('/api/v1/hal/honesty-a');
    expect(honesty.status).toBe(200);
    expect(honesty.body.rows).toHaveLength(1);
    expect(honesty.body.rows[0].first_pass).toEqual({ TRUE: 0, FALSE: 0, NOT_CHECKED: 1 });
    expect(honesty.body.rows[0].first_pass).not.toBe(0);
  });

  it('returns receipt-missing when the parent insert fails and does not insert a vote', async () => {
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    state.receiptError = { message: 'parent rejected' };
    const res = await request(app).post('/api/v1/hal/receipt').send(GOOD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: false, reason: 'receipt-missing' });
    expect(res.body).not.toHaveProperty('skippedReason');
    expect(JSON.stringify(res.body)).not.toContain('parent rejected');
    expect(state.inserts).toHaveLength(0);
  });

  it('keeps insert-error on the public body when the vote insert fails', async () => {
    process.env.HAL_QUORUM_RECEIPT_ENABLED = 'true';
    state.voteError = { message: 'vote rejected' };
    const res = await request(app).post('/api/v1/hal/receipt').send(GOOD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: false, reason: 'insert-error' });
    expect(res.body).not.toHaveProperty('skippedReason');
    expect(JSON.stringify(res.body)).not.toContain('vote rejected');
    const votes = state.inserts.filter((item) => item.table === 'hal_quorum_validator_votes');
    expect(votes).toHaveLength(0);
  });
});

describe('writeReceiptVote parent', () => {
  const env = { HAL_QUORUM_RECEIPT_ENABLED: 'true' };

  function client(opts: { parentFails?: boolean; voteFails?: boolean }) {
    const inserted: { table: string; row: Row }[] = [];
    return {
      inserted,
      from(table: string) {
        return {
          select() {
            return { limit: async () => ({ error: null }) };
          },
          insert(row: Row) {
            if (table === 'hal_quorum_receipts' && opts.parentFails) {
              return {
                select() {
                  return { single: async () => ({ data: null, error: { message: 'no parent' } }) };
                },
              };
            }
            if (table === 'hal_quorum_validator_votes' && opts.voteFails) {
              return Promise.resolve({ error: { message: 'vote failed' } });
            }
            inserted.push({ table, row });
            const id = inserted.filter((item) => item.table === 'hal_quorum_receipts').length;
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
    };
  }

  it('returns written true when the mocked parent and vote both insert', async () => {
    const db = client({});
    const result = await writeReceiptVote(
      db,
      { family: 'glm', host: 'cerebras', verdict: 'FALSE' },
      env,
    );
    expect(result).toEqual({ written: true });
    const parent = db.inserted.find((item) => item.table === 'hal_quorum_receipts');
    const vote = db.inserted.find((item) => item.table === 'hal_quorum_validator_votes');
    expect(vote?.row.receipt_id).toBe(1);
    expect(vote?.row.verdict).toBe('FALSE');
    expect(parent?.row.decision).toBe('FALSE');
    expect(parent?.row).not.toHaveProperty('claim');
    expect(parent?.row).not.toHaveProperty('user_id');
  });

  it('stores UNCERTAIN on the parent and vote without a closed first pass', async () => {
    const db = client({});
    const result = await writeReceiptVote(
      db,
      { family: 'glm', host: 'cerebras', verdict: 'UNCERTAIN' },
      env,
    );
    expect(result).toEqual({ written: true });
    const parent = db.inserted.find((item) => item.table === 'hal_quorum_receipts');
    const vote = db.inserted.find((item) => item.table === 'hal_quorum_validator_votes');
    expect(parent?.row.decision).toBe('UNCERTAIN');
    expect(parent?.row).not.toHaveProperty('claim');
    expect(vote?.row.receipt_id).toBe(1);
    expect(vote?.row.verdict).toBe('UNCERTAIN');
    expect(vote?.row.first_pass_verdict).toBeNull();
  });

  it('returns receipt-missing when the mocked parent insert fails', async () => {
    const db = client({ parentFails: true });
    const result = await writeReceiptVote(
      db,
      { family: 'glm', host: 'cerebras', verdict: 'FALSE' },
      env,
    );
    expect(result).toEqual({ written: false, reason: 'receipt-missing' });
    expect(db.inserted).toHaveLength(0);
  });

  it('returns insert-error and the vote skippedReason when the vote insert fails', async () => {
    const db = client({ voteFails: true });
    const result = await writeReceiptVote(
      db,
      { family: 'glm', host: 'cerebras', verdict: 'FALSE' },
      env,
    );
    expect(result.written).toBe(false);
    expect(result.reason).toBe('insert-error');
    expect(result.skippedReason).toBe('insert-error');
    expect(db.inserted.filter((item) => item.table === 'hal_quorum_validator_votes')).toHaveLength(0);
  });
});
