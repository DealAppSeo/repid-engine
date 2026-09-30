import express from 'express';
import request from 'supertest';
import whyRouter from '../src/routes/why';

describe('GET /api/v1/why', () => {
  it('returns four ids, one sentence each, and no zk text', async () => {
    const server = express();
    server.use('/api/v1', whyRouter);
    const res = await request(server).get('/api/v1/why');
    expect(res.status).toBe(200);
    expect(res.body.reasons.map((row: { id: string }) => row.id)).toEqual([
      'lies',
      'data',
      'lockin',
      'control',
    ]);
    for (const row of res.body.reasons as { id: string; sentence: string }[]) {
      expect(Object.keys(row).sort()).toEqual(['id', 'sentence']);
      expect(row.sentence.endsWith('.')).toBe(true);
      expect(row.sentence.split('.').filter((part) => part.trim().length > 0)).toHaveLength(1);
    }
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('zk');
  });
});
