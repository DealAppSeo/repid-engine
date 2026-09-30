import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createOnboardUnlockRouter, unlockForReceiptCount } from '../src/routes/onboard-unlock';

describe('GET /api/v1/onboard/unlock', () => {
  it('a counted receipt of 1 unlocks layer 1 only', async () => {
    const server = express();
    server.use('/api/v1', createOnboardUnlockRouter(async () => 1));
    const res = await request(server).get('/api/v1/onboard/unlock');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unlocked: [1] });
    expect(Object.keys(res.body)).toEqual(['unlocked']);
    expect(res.body.unlocked).not.toContain(0);
    expect(res.body.unlocked).not.toContain(2);
    expect(res.body.unlocked).not.toContain(3);
    expect(unlockForReceiptCount(0)).toEqual({ unlocked: [] });
    expect(unlockForReceiptCount(3)).toEqual({ unlocked: [] });
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('github');
    const src = readFileSync(path.join(__dirname, '..', 'src', 'routes', 'onboard-unlock.ts'), 'utf8');
    expect(src.toLowerCase()).not.toContain('github');
    expect(src.toLowerCase()).not.toContain('oauth');
  });
});
