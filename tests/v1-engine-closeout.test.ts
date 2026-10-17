/**
 * Closeout against a mocked client. No production URL. No new circuit.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { sealReceiptInsert } from '../src/hal/receipt-payload';
import { writeReceiptVote } from '../src/hal/quorum-receipt-writer';
import proofVerifyRouter from '../src/routes/proof-verify';

const state: { latest: 'row' | 'empty' } = { latest: 'row' };

jest.mock('../src/db', () => ({
  db: {
    from(table: string) {
      if (table === 'hal_quorum_validator_votes') {
        return {
          select() {
            return {
              gte() {
                return {
                  limit: async () => ({
                    data: null,
                    error: { message: 'column first_pass_verdict does not exist' },
                  }),
                };
              },
              order() {
                return {
                  limit() {
                    return {
                      maybeSingle: async () => {
                        if (state.latest === 'empty') return { data: null, error: null };
                        return {
                          data: {
                            family: 'llama',
                            host: 'groq',
                            provider: 'groq',
                            verdict: 'TRUE',
                            created_at: '2026-10-01T00:00:00.000Z',
                          },
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const honestyARouter = require('../src/routes/honesty-a').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const halLatestRouter = require('../src/routes/hal-latest').default;

const FIX_DIR = join(__dirname, 'fixtures', 'zkp');
const meta = JSON.parse(readFileSync(join(FIX_DIR, 'leaf-rangecheck.synthetic.json'), 'utf8')) as {
  scheme: string;
  statement: Record<string, unknown>;
  proof_file: string;
};
const proof = readFileSync(join(FIX_DIR, meta.proof_file));

function app() {
  const server = express();
  server.use(express.json({ limit: '2mb' }));
  server.use('/api/v1/hal', honestyARouter);
  server.use('/api/v1', halLatestRouter);
  server.use('/api/v1', proofVerifyRouter);
  return server;
}

function writerClient() {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return {
        select() {
          return { limit: async () => ({ error: null }) };
        },
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          const pending = Promise.resolve({ data: { id: 9 }, error: null });
          return Object.assign(pending, {
            select() {
              return { single: async () => ({ data: { id: 9 }, error: null }) };
            },
          });
        },
      };
    },
  };
  return { client, inserted };
}

describe('v1 engine closeout', () => {
  beforeEach(() => {
    state.latest = 'row';
  });

  it('omits first_pass when the column is missing', async () => {
    const res = await request(app()).get('/api/v1/hal/honesty-a');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NOT_CHECKED');
    expect(res.body.rows).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(res.body, 'first_pass')).toBe(false);
    expect(res.body.first_pass).not.toBe(0);
    expect(JSON.stringify(res.body)).not.toMatch(/"first_pass"\s*:/);
  });

  it('refuses a receipt insert that adds claim, prompt, or user_id', async () => {
    const { client, inserted } = writerClient();
    const written = await writeReceiptVote(
      client as never,
      { family: 'llama', host: 'groq', verdict: 'NOT_CHECKED' },
      { HAL_QUORUM_RECEIPT_ENABLED: 'true' },
    );
    expect(written.written).toBe(true);
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) {
      expect(row).not.toHaveProperty('claim');
      expect(row).not.toHaveProperty('prompt');
      expect(row).not.toHaveProperty('user_id');
    }
    const parent = inserted[0];
    expect(parent).toBeDefined();
    const withClaim = { ...parent, claim: 'x' };
    const blocked: Record<string, unknown>[] = [];
    expect(() => {
      blocked.push(sealReceiptInsert(withClaim));
    }).toThrow('rejected-receipt-key');
    expect(() => sealReceiptInsert({ ...parent, prompt: 'x' })).toThrow('rejected-receipt-key');
    expect(() => sealReceiptInsert({ ...parent, user_id: 'x' })).toThrow('rejected-receipt-key');
    expect(blocked).toHaveLength(0);

    const writer = readFileSync(join(__dirname, '../src/hal/quorum-receipt-writer.ts'), 'utf8');
    const vote = readFileSync(join(__dirname, '../src/hal/first-pass-vote.ts'), 'utf8');
    expect(writer).toContain('insert(sealReceiptInsert(');
    expect(vote).toContain('sealReceiptInsert(normalized.row)');
  });

  it('returns host, verdict, and created_at, or not_found, with no claim text', async () => {
    const card = await request(app()).get('/api/v1/receipt/hal-latest');
    expect(card.status).toBe(200);
    expect(card.body.host).toBe('groq');
    expect(card.body.verdict).toBe('TRUE');
    expect(card.body.created_at).toBe('2026-10-01T00:00:00.000Z');
    expect(card.body).not.toHaveProperty('claim');
    expect(JSON.stringify(card.body)).not.toContain('claim');

    state.latest = 'empty';
    const missing = await request(app()).get('/api/v1/receipt/hal-latest');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });

  it('verifies the known-good range check and rejects one flipped byte', async () => {
    expect(meta.scheme).toBe('plonky3_range_check');
    const honest = await request(app())
      .post('/api/v1/proof/verify')
      .send({ proof_bytes: proof.toString('base64'), statement: meta.statement });
    expect(honest.status).toBe(200);
    expect(honest.body.verified).toBe(true);

    const tampered = Buffer.from(proof);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    const flipped = await request(app())
      .post('/api/v1/proof/verify')
      .send({ proof_bytes: tampered.toString('base64'), statement: meta.statement });
    expect(flipped.status).toBe(200);
    expect(flipped.body.verified).toBe(false);
  }, 120000);
});
