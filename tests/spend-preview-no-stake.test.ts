import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import spendPreviewRouter from '../src/routes/human-spend-preview';
import { previewSpendFixture } from '../src/services/spend-preview';

describe('spend preview with no stake row', () => {
  it('returns applied false and sends_eth false when no stake row exists', async () => {
    const body = previewSpendFixture([]);
    expect(body.applied).toBe(false);
    expect(body.sends_eth).toBe(false);
    expect(previewSpendFixture(null)).toEqual(body);
    expect(previewSpendFixture()).toEqual(body);

    const server = express();
    server.use(express.json());
    server.use('/api/v1', spendPreviewRouter);
    const res = await request(server).get('/api/v1/human/spend/preview');
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.sends_eth).toBe(false);

    const serviceSrc = readFileSync(path.join(__dirname, '..', 'src', 'services', 'spend-preview.ts'), 'utf8');
    expect(serviceSrc).not.toContain('stake_deposits');
    expect(serviceSrc).not.toContain('supabase');
    expect(serviceSrc).not.toContain('fetch(');
    expect(serviceSrc).not.toContain('REAL_STAKING');
  });
});
