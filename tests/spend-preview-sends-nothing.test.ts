import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import spendPreviewRouter from '../src/routes/human-spend-preview';
import { previewSpendFixture } from '../src/services/spend-preview';

describe('spend preview sends nothing', () => {
  it('keeps applied false and has no send path', async () => {
    const first = previewSpendFixture();
    const second = previewSpendFixture();
    expect(first.applied).toBe(false);
    expect(first.persisted).toBe(false);
    expect(second).toEqual(first);

    const server = express();
    server.use('/api/v1', spendPreviewRouter);
    const res = await request(server).get('/api/v1/human/spend/preview');
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.persisted).toBe(false);

    const root = path.join(__dirname, '..');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'human-spend-preview.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'services', 'spend-preview.ts'), 'utf8');
    for (const src of [routeSrc, serviceSrc]) {
      expect(src).not.toContain('sendTransaction');
      expect(src).not.toContain('ethers');
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('.insert(');
      expect(src).not.toContain('router.post');
    }
    expect(routeSrc).toContain("router.get('/human/spend/preview'");
  });
});
