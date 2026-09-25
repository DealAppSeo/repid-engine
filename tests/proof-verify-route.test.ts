/**
 * Existing plonky3_range_check verifier, over HTTP. No minter. No chain.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import proofVerifyRouter from '../src/routes/proof-verify';

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
  server.use('/api/v1', proofVerifyRouter);
  return server;
}

describe('POST /api/v1/proof/verify', () => {
  it('GET with no body is 400, not 500', async () => {
    const res = await request(app()).get('/api/v1/proof/verify');
    expect(res.status).toBe(400);
    expect(res.body.verified).toBe(false);
    expect(res.body.scheme).toBe('plonky3_range_check');
  });

  it('accepts the known-good plonky3_range_check fixture and rejects one flipped byte', async () => {
    expect(meta.scheme).toBe('plonky3_range_check');
    const honest = await request(app())
      .post('/api/v1/proof/verify')
      .send({ proof_bytes: proof.toString('base64'), statement: meta.statement });
    expect(honest.status).toBe(200);
    expect(honest.body.verified).toBe(true);
    expect(honest.body.scheme).toBe('plonky3_range_check');

    const tampered = Buffer.from(proof);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    const flipped = await request(app())
      .post('/api/v1/proof/verify')
      .send({ proof_bytes: tampered.toString('base64'), statement: meta.statement });
    expect(flipped.status).toBe(200);
    expect(flipped.body.verified).toBe(false);
    expect(flipped.body.error).toBeTruthy();
  }, 120000);
});
