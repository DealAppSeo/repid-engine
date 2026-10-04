/**
 * V1-4 — GET /api/v1/belts/{cmo,cto}: the same contract as the CFO belt. Rows mirror
 * trustshell public/belts/{cmo,cto}.html; every row has can_spend false and evidence
 * 'self'; a missing belt or row is NOT_CHECKED (404), never 0; GET writes nothing and
 * a self-only row raises no score.
 */
import express from 'express';
import request from 'supertest';

const dbFrom = jest.fn();
const dbRpc = jest.fn();
jest.mock('../src/db', () => ({ db: { from: dbFrom, rpc: dbRpc } }));
const updateRepId = jest.fn();
jest.mock('../src/engine/repid-update', () => ({ updateRepId }));

import beltsRouter, { belt, beltRowScoreDelta, type BeltRow } from '../src/routes/belts';

const server = express();
server.use('/api/v1', beltsRouter);

afterEach(() => {
  expect(dbFrom).not.toHaveBeenCalled();
  expect(dbRpc).not.toHaveBeenCalled();
  expect(updateRepId).not.toHaveBeenCalled();
});

const COSTS = ['free', 'paid', 'free tier, paid plans'];

describe.each(['cmo', 'cto', 'cfo'])('GET /api/v1/belts/%s', (id) => {
  it('returns the six-field rows, nothing can spend, every row is self-vouched and scores 0', async () => {
    const res = await request(server).get(`/api/v1/belts/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.belt).toBe(id);
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const row of res.body.rows as BeltRow[]) {
      expect(Object.keys(row).sort()).toEqual(['can_spend', 'cost', 'evidence', 'kind', 'name', 'why']);
      expect(COSTS).toContain(row.cost);
      expect(row.can_spend).toBe(false);
      expect(row.evidence).toBe('self');
      expect(beltRowScoreDelta(row)).toBe(0);
    }
  });

  it('a row that is not on the belt is NOT_CHECKED, not 0', async () => {
    const res = await request(server).get(`/api/v1/belts/${id}/treasury`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ name: 'treasury', status: 'NOT_CHECKED' });
  });
});

describe('CMO and CTO specifics', () => {
  it('CMO names its methods without endorsement and dates its prices', async () => {
    const res = await request(server).get('/api/v1/belts/cmo');
    expect(res.body.note).toMatch(/do not endorse/);
    expect(res.body.note).toMatch(/2026-10-02/);
    const methods = (res.body.rows as BeltRow[]).filter((r) => r.kind === 'method');
    expect(methods.map((r) => r.name)).toEqual(['hormozi method', 'vaynerchuk method', 'godin method']);
    for (const m of methods) expect(m.why).toMatch(/named only/);
  });

  it('CMO keeps the page wording for a tool with a free tier and paid plans', async () => {
    const res = await request(server).get('/api/v1/belts/cmo/capcut');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([expect.objectContaining({ name: 'capcut', cost: 'free tier, paid plans', can_spend: false })]);
  });

  it('CTO row lookup is case-insensitive and both trustshell rows come back', async () => {
    const one = await request(server).get('/api/v1/belts/CTO/Redact');
    expect(one.status).toBe(200);
    expect(one.body.rows).toEqual([expect.objectContaining({ name: 'redact', kind: 'skill' })]);
    const two = await request(server).get('/api/v1/belts/cmo/trustshell');
    expect((two.body.rows as BeltRow[]).map((r) => r.kind)).toEqual(['mcp', 'repo']);
  });

  it('an unknown belt is NOT_CHECKED (404), never an empty belt', async () => {
    for (const path of ['/api/v1/belts/ceo', '/api/v1/belts/ceo/cap']) {
      const res = await request(server).get(path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ belt: 'ceo', status: 'NOT_CHECKED' });
    }
  });

  it('an odd cost is NOT_CHECKED, never a number', () => {
    const out = belt('cmo', [{ name: 'x', kind: 'tool', why: 'y', cost: 0 as never, can_spend: false, evidence: 'self' }]);
    expect(out.rows[0]?.cost).toBe('NOT_CHECKED');
  });
});
