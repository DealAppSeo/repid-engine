/**
 * GET /api/v1/belts/cfo — read-only rows; the cap row cannot spend; a missing row is
 * NOT_CHECKED, not 0; GET inserts nothing; a self-only row does not raise a score.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const dbFrom = jest.fn();
const dbRpc = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: dbRpc } }));
const updateRepId = jest.fn();
jest.mock('../src/engine/repid-update', () => ({ updateRepId }));

import beltsRouter, { beltRowScoreDelta, cfoBelt, type BeltRow } from '../src/routes/belts';

const server = express();
server.use('/api/v1', beltsRouter);

afterEach(() => {
  expect(dbFrom).not.toHaveBeenCalled();
  expect(dbRpc).not.toHaveBeenCalled();
  expect(updateRepId).not.toHaveBeenCalled();
});

describe('GET /api/v1/belts/cfo', () => {
  it('returns rows with name, kind, why, free or paid, and nothing can spend', async () => {
    const res = await request(server).get('/api/v1/belts/cfo');
    expect(res.status).toBe(200);
    expect(res.body.belt).toBe('cfo');
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const row of res.body.rows as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(['can_spend', 'cost', 'evidence', 'kind', 'name', 'why']);
      expect(['free', 'paid']).toContain(row['cost']);
      expect(row['can_spend']).toBe(false);
    }
  });

  it('has a cap row with can_spend false', async () => {
    const res = await request(server).get('/api/v1/belts/cfo/cap');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      expect.objectContaining({ name: 'cap', kind: 'tool', can_spend: false }),
    ]);
  });

  it('a missing row is NOT_CHECKED, not 0', async () => {
    const res = await request(server).get('/api/v1/belts/cfo/treasury');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ name: 'treasury', status: 'NOT_CHECKED' });
    expect(JSON.stringify(res.body)).not.toMatch(/:0\b|"0"/);
    const odd = cfoBelt([
      { name: 'x', kind: 'tool', why: 'y', cost: 0 as never, can_spend: false, evidence: 'self' },
    ]);
    expect(odd.rows[0]?.cost).toBe('NOT_CHECKED');
  });

  it('GET inserts nothing, and the route source names no write, stake flag or key', async () => {
    await request(server).get('/api/v1/belts/cfo');
    await request(server).get('/api/v1/belts/cfo/receipt');
    const src = readFileSync(path.join(__dirname, '..', 'src', 'routes', 'belts.ts'), 'utf8');
    expect(src).not.toMatch(/\.insert\(|\.upsert\(|\.update\(|from '\.\.\/db'/);
    expect(src).not.toContain('REAL_STAKING');
    expect(src).not.toMatch(/process\.env/);
  });

  it('a self-only row does not raise a score', async () => {
    const res = await request(server).get('/api/v1/belts/cfo');
    for (const row of res.body.rows as BeltRow[]) {
      expect(row.evidence).toBe('self');
      expect(beltRowScoreDelta(row)).toBe(0);
    }
  });
});
