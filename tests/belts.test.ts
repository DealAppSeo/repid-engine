import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import beltsRouter, { publicBelts } from '../src/routes/belts';

describe('GET /api/v1/belts', () => {
  it('returns the three public ids and no private fields', async () => {
    const server = express();
    server.use('/api/v1', beltsRouter);
    const res = await request(server).get('/api/v1/belts');
    expect(res.status).toBe(200);
    expect(res.body.belts.map((belt: { id: string }) => belt.id)).toEqual(['cmo', 'cfo', 'cto']);
    expect(publicBelts().belts).toHaveLength(3);
    for (const belt of res.body.belts as Record<string, unknown>[]) {
      expect(Object.keys(belt)).toEqual(['id']);
    }
    const src = readFileSync(path.join(__dirname, '..', 'src', 'routes', 'belts.ts'), 'utf8');
    expect(src).not.toContain('private');
    expect(src).not.toContain('secret');
    expect(src).not.toContain('wallet');
    expect(src).not.toContain('email');
  });
});
