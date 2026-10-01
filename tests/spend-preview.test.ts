import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import spendPreviewRouter from '../src/routes/human-spend-preview';

describe('spend preview fixture', () => {
  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/v1', spendPreviewRouter);
    return server;
  }

  it('returns rates 50 and 100 with applied false', async () => {
    const res = await request(app()).get('/api/v1/human/spend/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rates: [50, 100],
      assets: [
        { usdc: 50, eth: 1, cbbtc: 1 },
        { usdc: 100, eth: 2, cbbtc: 2 },
      ],
      wallet: 'NOT_CHECKED',
      agent: 'NOT_CHECKED',
      cap: 100,
      spend: 'deny',
      reason: 'unbound_agent',
      applied: false,
      persisted: false,
      sends_eth: false,
    });
    expect(res.body.applied).toBe(false);
    for (const row of res.body.assets as { usdc: number; eth: number; cbbtc: number }[]) {
      expect(row.usdc === 50 || row.usdc === 100).toBe(true);
      expect(typeof row.eth).toBe('number');
      expect(typeof row.cbbtc).toBe('number');
    }
  });

  it('is mounted before auth and does not insert or fetch', () => {
    const root = path.join(__dirname, '..');
    const indexSrc = readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'human-spend-preview.ts'), 'utf8');
    const serviceSrc = readFileSync(path.join(root, 'src', 'services', 'spend-preview.ts'), 'utf8');
    const mountAt = indexSrc.indexOf("app.use('/api/v1', spendPreviewRouter)");
    const authAt = indexSrc.indexOf('app.use(authMiddleware)');
    expect(mountAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(mountAt);
    for (const src of [routeSrc, serviceSrc]) {
      expect(src).not.toContain('.insert(');
      expect(src).not.toContain('supabase');
      expect(src).not.toContain('from(');
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('sendTransaction');
      expect(src).not.toContain('ethers');
    }
  });
});
