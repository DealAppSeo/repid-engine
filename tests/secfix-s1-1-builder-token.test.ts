/**
 * [S1-1, 2026-10-16] A builder id must never reach a builder's session_token.
 *
 * GET /api/v1/demo/builder/:tokenOrId/snapshot is public. It used to look a builder up by UUID and
 * return `session_token`, and verify-otp turns that token into a signed login. The builder-registry
 * address lookups used an unescaped `.ilike`, so `0x%` style patterns could resolve builder ids.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../src/services/stake-vault', () => ({
  snapshotAuthority: jest.fn(async () => ({ authority: 10000000n, basis: { stake: '20000000', floor_check: {} } })),
  getCurrentStake: jest.fn(async () => 0n),
}));

const BUILDER = { id: '11111111-2222-3333-4444-555555555555', current_repid: 5100, session_token: 'secret-session-token' };
const eqCalls: Array<[string, unknown]> = [];
const ilikeCalls: Array<[string, unknown]> = [];

jest.mock('../src/db', () => {
  const chain: any = {};
  chain.from = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn((col: string, val: unknown) => {
    eqCalls.push([col, val]);
    chain._last = [col, val];
    return chain;
  });
  chain.ilike = jest.fn((col: string, val: unknown) => {
    ilikeCalls.push([col, val]);
    chain._last = ['ilike', val];
    return chain;
  });
  chain.maybeSingle = jest.fn(async () => {
    const [col, val] = chain._last ?? [];
    if (col === 'id' && val === BUILDER.id) return { data: BUILDER, error: null };
    if (col === 'session_token' && val === BUILDER.session_token) return { data: BUILDER, error: null };
    return { data: null, error: null };
  });
  return { db: chain };
});

import v1Router from '../src/routes/v1';
import { getBuilderProfile, registerBuilder } from '../src/services/builder-registry';

const app = express();
app.use(express.json());
app.use('/api/v1', v1Router);

beforeEach(() => {
  eqCalls.length = 0;
  ilikeCalls.length = 0;
});

describe('S1-1 demo builder snapshot', () => {
  it('a builder UUID is not a key: 404, and the id column is never queried', async () => {
    const res = await request(app).get(`/api/v1/demo/builder/${BUILDER.id}/snapshot`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(BUILDER.session_token);
    expect(eqCalls.map(([c]) => c)).not.toContain('id');
  });

  it('the session token still finds the builder, and the response never carries session_token', async () => {
    const res = await request(app).get(`/api/v1/demo/builder/${BUILDER.session_token}/snapshot`);
    expect(res.status).toBe(200);
    expect(res.body.builder_id).toBe(BUILDER.id);
    expect(res.body).not.toHaveProperty('session_token');
    expect(JSON.stringify(res.body)).not.toContain(BUILDER.session_token);
  });
});

describe('S1-1 builder address lookups are literal', () => {
  it('getBuilderProfile escapes % and _ before ilike', async () => {
    await getBuilderProfile('0x%');
    await getBuilderProfile('0x_a');
    expect(ilikeCalls).toEqual([
      ['address', '0x\\%'],
      ['address', '0x\\_a'],
    ]);
  });

  it('registerBuilder escapes % and _ before ilike', async () => {
    await registerBuilder('0x%').catch(() => undefined); // the insert path is not under test
    expect(ilikeCalls[0]).toEqual(['address', '0x\\%']);
  });
});
