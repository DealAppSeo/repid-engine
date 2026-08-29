/**
 * proof-carrying-verify-route.test.ts — HTTP contract for POST /proof-carrying/verify
 * (backlog item 3's verifier-endpoint half — see PATENT_ALIGNED_BUILD_BACKLOG.md).
 *
 * Exercises the route the same way a peer/HAL would: no import of ProofCarryingMemory,
 * just a JSON body over HTTP. Uses emitGroundedAnswer (already covered by
 * proof-carrying-memory.test.ts) purely to construct a realistic request body.
 */
import express from 'express';
import request from 'supertest';
import proofCarryingVerifyRouter from '../src/routes/proof-carrying-verify';
import { ProofCarryingMemory, emitGroundedAnswer, type MemoryEntry } from '../src/memory/proof-carrying-memory';

function entry(content: string): MemoryEntry {
  return { content, source_id: 'agent-x', source_repid: 1200, hal_verdict: 'clean', epoch: 1 };
}

/** The wire contract: bigint leaf fields travel as decimal strings (see route file header). */
function toWire(pca: unknown): unknown {
  return JSON.parse(JSON.stringify(pca, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/proof-carrying', proofCarryingVerifyRouter);
  return app;
}

describe('POST /api/v1/proof-carrying/verify', () => {
  it('rejects a non-object body with 400', async () => {
    const res = await request(makeApp()).post('/api/v1/proof-carrying/verify').send([1, 2, 3]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON object/);
  });

  it('verifies a real grounded proof-carrying answer end-to-end over HTTP', async () => {
    const mem = new ProofCarryingMemory();
    const v1 = mem.add(entry('fact one'));
    const v2 = mem.add(entry('fact two'));
    const pca = emitGroundedAnswer('grounded in one and two', mem, [v1, v2]);

    const res = await request(makeApp()).post('/api/v1/proof-carrying/verify').send(toWire(pca));
    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(true);
    expect(res.body.binding_ok).toBe(true);
    expect(res.body.verified_citations).toBe(2);
    expect(res.body.total_citations).toBe(2);
  });

  it('flags a tampered answer as not grounded without throwing', async () => {
    const mem = new ProofCarryingMemory();
    const v1 = mem.add(entry('fact one'));
    const pca = emitGroundedAnswer('original claim', mem, [v1]);
    const forged = { ...pca, answer: 'a different claim' };

    const res = await request(makeApp()).post('/api/v1/proof-carrying/verify').send(toWire(forged));
    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(false);
    expect(res.body.binding_ok).toBe(false);
    expect(res.body.reasons).toContain('binding_mismatch');
  });

  it('handles a malformed citations field without crashing (adversarial input)', async () => {
    const res = await request(makeApp())
      .post('/api/v1/proof-carrying/verify')
      .send({ answer: 'x', memory_root: '0x' + '00'.repeat(32), citations: 'not-an-array', binding: '0x00' });
    expect(res.status).toBe(200);
    expect(res.body.grounded).toBe(false);
    expect(res.body.total_citations).toBe(0);
  });
});
