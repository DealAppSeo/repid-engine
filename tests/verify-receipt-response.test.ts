import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import receiptVerifyRouter from '../src/routes/receipt-verify';
import { verifyReceiptResponse } from '../src/hal/verify-receipt-response';

describe('verify receipt response', () => {
  const fixture = {
    receipt_id: 'rcpt-7',
    claim: 'the surgeon is the mother',
    prompt: 'hidden prompt',
    user_id: 'user-1',
    votes: [
      { family: 'llama', verdict: 'TRUE', claim: 'do not copy' },
      { family: 'glm', verdict: 'FALSE' },
      { family: 'qwen', verdict: 0 },
    ],
  };

  function bodyOf(input: unknown) {
    return verifyReceiptResponse(input);
  }

  it('includes the receipt id and the family verdicts', () => {
    const body = bodyOf(fixture);
    expect(body.receipt_id).toBe('rcpt-7');
    expect(body.families).toEqual([
      { family: 'llama', verdict: 'TRUE' },
      { family: 'glm', verdict: 'FALSE' },
      { family: 'qwen', verdict: 'NOT_CHECKED' },
    ]);
    expect(body.families[2]?.verdict).not.toBe(0);
  });

  it('a claim key in that body fails', () => {
    const body = bodyOf(fixture);
    expect(Object.keys(body).sort()).toEqual(['families', 'receipt_id']);
    expect(Object.prototype.hasOwnProperty.call(body, 'claim')).toBe(false);
    const json = JSON.stringify(body);
    expect(json).not.toContain('claim');
    expect(json).not.toContain('surgeon');
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('prompt');
    for (const row of body.families) {
      expect(Object.keys(row).sort()).toEqual(['family', 'verdict']);
    }
  });

  it('POST /api/v1/receipt/verify returns that body', async () => {
    const server = express();
    server.use(express.json());
    server.use('/api/v1', receiptVerifyRouter);
    const res = await request(server).post('/api/v1/receipt/verify').send(fixture);
    expect(res.status).toBe(200);
    expect(res.body.receipt_id).toBe('rcpt-7');
    expect(res.body.families).toEqual([
      { family: 'llama', verdict: 'TRUE' },
      { family: 'glm', verdict: 'FALSE' },
      { family: 'qwen', verdict: 'NOT_CHECKED' },
    ]);
    expect(Object.keys(res.body).sort()).toEqual(['families', 'receipt_id']);
    expect(res.body).not.toHaveProperty('claim');

    const root = path.join(__dirname, '..');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'receipt-verify.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'hal', 'verify-receipt-response.ts'), 'utf8');
    const indexSrc = readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    for (const src of [routeSrc, serviceSrc]) {
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('supabase');
      expect(src).not.toContain('.insert(');
      expect(src).not.toContain('REAL_STAKING');
    }
    const verifyAt = indexSrc.indexOf("app.use('/api/v1', receiptVerifyRouter)");
    const publicAt = indexSrc.indexOf("app.use('/api/v1', receiptPublicRouter)");
    const authAt = indexSrc.indexOf('app.use(authMiddleware)');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(publicAt).toBeGreaterThan(verifyAt);
    expect(authAt).toBeGreaterThan(verifyAt);
  });
});
