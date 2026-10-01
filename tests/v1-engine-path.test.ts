/**
 * V1 path against a mocked database.
 * Receipt writer, Laya classify, bind uniqueness, and the existing proof verifier.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

type Row = Record<string, unknown>;

const state: {
  inserts: { table: string; row: Row }[];
  votes: Row[];
  probeError: { message: string } | null;
  binds: Set<string>;
} = { inserts: [], votes: [], probeError: null, binds: new Set<string>() };

function resetState(): void {
  state.inserts = [];
  state.votes = [];
  state.probeError = null;
  state.binds = new Set<string>();
}

jest.mock('../src/db', () => ({
  db: {
    from(table: string) {
      return {
        select() {
          return {
            limit: async () => ({ error: state.probeError }),
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
          if (table === 'human_agent_binds') {
            const key = `${String(row.wallet)}\0${String(row.agent_id)}`;
            if (state.binds.has(key)) return Promise.resolve({ error: { code: '23505' } });
            state.binds.add(key);
            state.inserts.push({ table, row });
            return Promise.resolve({ error: null });
          }
          const stored = { ...row, created_at: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString() };
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

import { db } from '../src/db';
import { writeV1Receipt } from '../src/hal/v1-receipt-writer';
import halLatestRouter from '../src/routes/hal-latest';
import layaClassifyRouter from '../src/routes/laya-classify';
import humanBindStagingRouter from '../src/routes/human-bind-staging';
import proofVerifyRouter from '../src/routes/proof-verify';

const AGENT = '11111111-1111-4111-8111-111111111111';
const PAIR = { wallet: '0xabc', agent_id: AGENT };

function app(): express.Express {
  const server = express();
  server.use(express.json({ limit: '2mb' }));
  server.use('/api/v1', halLatestRouter);
  server.use('/api/v1', layaClassifyRouter);
  server.use('/api/v1', humanBindStagingRouter);
  server.use('/api/v1', proofVerifyRouter);
  return server;
}

describe('v1 engine path', () => {
  const savedReceipt = process.env.HAL_QUORUM_RECEIPT_ENABLED;
  const savedBind = process.env.HUMAN_AGENT_BIND_ENABLED;

  beforeEach(() => {
    resetState();
    delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
    delete process.env.HUMAN_AGENT_BIND_ENABLED;
  });

  afterEach(() => {
    if (savedReceipt === undefined) delete process.env.HAL_QUORUM_RECEIPT_ENABLED;
    else process.env.HAL_QUORUM_RECEIPT_ENABLED = savedReceipt;
    if (savedBind === undefined) delete process.env.HUMAN_AGENT_BIND_ENABLED;
    else process.env.HUMAN_AGENT_BIND_ENABLED = savedBind;
  });

  it('writes one parent and one vote, then hal-latest returns that host and verdict', async () => {
    const res = await writeV1Receipt(
      db as unknown as Parameters<typeof writeV1Receipt>[0],
      {
        host: 'groq',
        family: 'llama',
        first_pass_verdict: 'FALSE',
        first_pass_at: '2026-09-26T12:00:00.000Z',
        post_hal_verdict: 'FALSE',
      },
      { HAL_QUORUM_RECEIPT_ENABLED: 'true' },
    );
    expect(res).toEqual({ written: true });
    const parents = state.inserts.filter((item) => item.table === 'hal_quorum_receipts');
    const votes = state.inserts.filter((item) => item.table === 'hal_quorum_validator_votes');
    expect(parents).toHaveLength(1);
    expect(votes).toHaveLength(1);
    for (const item of state.inserts) {
      expect(Object.prototype.hasOwnProperty.call(item.row, 'claim')).toBe(false);
    }
    expect(votes[0]?.row.host).toBe('groq');
    expect(votes[0]?.row.verdict).toBe('FALSE');
    const latest = await request(app()).get('/api/v1/receipt/hal-latest');
    expect(latest.status).toBe(200);
    expect(latest.body.host).toBe('groq');
    expect(latest.body.verdict).toBe('FALSE');
    expect(JSON.stringify(latest.body)).not.toContain('claim');
  });

  it('inserts nothing unless the receipt flag is the exact string true', async () => {
    const unset = await writeV1Receipt(
      db as unknown as Parameters<typeof writeV1Receipt>[0],
      { host: 'groq', first_pass_verdict: 'FALSE', first_pass_at: '2026-09-26T12:00:00.000Z' },
      {},
    );
    const folded = await writeV1Receipt(
      db as unknown as Parameters<typeof writeV1Receipt>[0],
      { host: 'groq', first_pass_verdict: 'FALSE', first_pass_at: '2026-09-26T12:00:00.000Z' },
      { HAL_QUORUM_RECEIPT_ENABLED: 'TRUE' },
    );
    expect(unset).toEqual({ written: false });
    expect(folded).toEqual({ written: false });
    expect(state.inserts).toHaveLength(0);
  });

  it('reports columns-missing and inserts nothing when the vote columns are absent', async () => {
    state.probeError = { message: 'column first_pass_verdict does not exist' };
    const res = await writeV1Receipt(
      db as unknown as Parameters<typeof writeV1Receipt>[0],
      { host: 'groq', first_pass_verdict: 'FALSE', first_pass_at: '2026-09-26T12:00:00.000Z' },
      { HAL_QUORUM_RECEIPT_ENABLED: 'true' },
    );
    expect(res).toEqual({ written: false, reason: 'columns-missing' });
    expect(state.inserts).toHaveLength(0);
  });

  it('GET classify with no body asks, and POST still routes cheap, escalate, and ask', async () => {
    const server = app();
    const empty = await request(server).get('/api/v1/laya/classify');
    expect(empty.status).not.toBe(404);
    expect(empty.status).toBe(200);
    expect(empty.body.route).toBe('ask');
    expect(empty.body.latency_ms).toEqual(expect.any(Number));
    const cheap = await request(server).post('/api/v1/laya/classify').send({ text: 'hello' });
    const ask = await request(server).post('/api/v1/laya/classify').send({ text: 'what?' });
    const escalate = await request(server).post('/api/v1/laya/classify').send({ text: 'attest this claim' });
    expect(cheap.body.route).toBe('cheap');
    expect(ask.body.route).toBe('ask');
    expect(escalate.body.route).toBe('escalate');
  });

  it('returns 409 for the same wallet and agent, and 410 leaves the set empty', async () => {
    const server = app();
    const blocked = await request(server).post('/api/v1/human/bind').send(PAIR);
    expect(blocked.status).toBe(410);
    expect(state.binds.size).toBe(0);
    process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
    const first = await request(server).post('/api/v1/human/bind').send(PAIR);
    const second = await request(server).post('/api/v1/human/bind').send(PAIR);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(state.binds.size).toBe(1);
  });

  it('verifies a known-good postcard proof and rejects one flipped byte', async () => {
    const dir = join(__dirname, 'fixtures', 'zkp');
    const meta = JSON.parse(readFileSync(join(dir, 'leaf-rangecheck.synthetic.json'), 'utf8')) as {
      statement: Record<string, unknown>;
      proof_file: string;
    };
    const proof = readFileSync(join(dir, meta.proof_file));
    const server = app();
    const empty = await request(server).get('/api/v1/proof/verify');
    expect(empty.status).toBe(400);
    const honest = await request(server)
      .post('/api/v1/proof/verify')
      .send({ proof_bytes: proof.toString('base64'), statement: meta.statement });
    expect(honest.status).toBe(200);
    expect(honest.body.verified).toBe(true);
    const tampered = Buffer.from(proof);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    const flipped = await request(server)
      .post('/api/v1/proof/verify')
      .send({ proof_bytes: tampered.toString('base64'), statement: meta.statement });
    expect(flipped.status).toBe(200);
    expect(flipped.body.verified).toBe(false);
  }, 120000);
});
