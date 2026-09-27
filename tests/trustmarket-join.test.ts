import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import trustmarketJoinRouter, { trustmarketJoin } from '../src/routes/trustmarket-join';

describe('GET /api/v1/trustmarket/join', () => {
  const savedStake = process.env.REAL_STAKING_ENABLED;

  afterEach(() => {
    if (savedStake === undefined) delete process.env.REAL_STAKING_ENABLED;
    else process.env.REAL_STAKING_ENABLED = savedStake;
  });

  it('returns can_list false and can_stake false', async () => {
    process.env.REAL_STAKING_ENABLED = 'true';
    const app = express();
    app.use('/api/v1', trustmarketJoinRouter);
    const res = await request(app).get('/api/v1/trustmarket/join');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ can_list: false, can_stake: false });
    expect(trustmarketJoin().can_list).toBe(false);
    expect(trustmarketJoin().can_stake).toBe(false);
  });

  it('is mounted before auth and does not read the staking flag', () => {
    const root = path.join(__dirname, '..');
    const indexSrc = readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    const routeSrc = readFileSync(path.join(root, 'src', 'routes', 'trustmarket-join.ts'), 'utf8');
    const mountAt = indexSrc.indexOf("app.use('/api/v1', trustmarketJoinRouter)");
    const authAt = indexSrc.indexOf('app.use(authMiddleware)');
    expect(mountAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(mountAt);
    expect(routeSrc).not.toContain('process.env');
    expect(routeSrc).not.toContain('REAL_STAKING_ENABLED');
  });
});
