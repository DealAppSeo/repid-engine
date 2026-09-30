import express from 'express';
import request from 'supertest';
import beltsRouter from '../src/routes/belts';

describe('GET /api/v1/belts', () => {
  it('returns ids cmo, cfo, and cto only', async () => {
    const server = express();
    server.use('/api/v1', beltsRouter);
    const res = await request(server).get('/api/v1/belts');
    expect(res.status).toBe(200);
    expect(res.body.belts.map((belt: { id: string }) => belt.id)).toEqual(['cmo', 'cfo', 'cto']);
    for (const belt of res.body.belts as Record<string, unknown>[]) {
      expect(Object.keys(belt)).toEqual(['id']);
    }
  });
});
