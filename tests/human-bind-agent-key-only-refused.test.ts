/**
 * An agent's API key alone binds nothing. POST /api/v1/human/bind needs BOTH wallet signatures
 * (the auth envelope and the binding statement) as well as the agent's own key.
 *
 * Until 2026-10-16 a second handler, routes/human-bind-staging.ts, answered any body that named a
 * `wallet`: an API key was its only proof, and it wrote the pair to `human_agent_binds`. That table
 * never existed in production, so the path failed with 500, but creating the table would have
 * opened a key-only bind. The route is deleted; this file pins that it stays deleted and that the
 * signed route refuses every key-only shape.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.HUMAN_AGENT_BIND_ENABLED = 'true'; // as in production: the worst case for this test
process.env.REPID_API_KEYS = 'ops-key:ops';

const writes: string[] = [];
jest.mock('../src/db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'ilike', 'is', 'order', 'limit']) chain[name] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  return {
    db: {
      from: (table: string) => ({
        ...chain,
        insert: () => {
          writes.push(table);
          return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
        },
        update: () => {
          writes.push(table);
          return chain;
        },
      }),
    },
  };
});
const AGENT = 'aaaaaaaa-1111-4222-8333-444444444444';
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (key: string) => (key === 'agent-key' ? { agent_id: AGENT, scopes: [] } : null)),
}));

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { Wallet } from 'ethers';
import byokRouter, { authMessage } from '../src/routes/v1/byok';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', byokRouter);
  return a;
}

const wallet = Wallet.createRandom();
const stranger = Wallet.createRandom();

beforeEach(() => {
  writes.length = 0;
});

describe('a key alone binds nothing', () => {
  test('the old staging shape (API key + body naming a wallet) → 401 signature_required, nothing written', async () => {
    const res = await request(app())
      .post('/api/v1/human/bind')
      .set('Authorization', 'Bearer agent-key')
      .set('x-agent-key', 'agent-key')
      .send({ wallet: wallet.address, agent_id: AGENT });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_required');
    expect(writes).toEqual([]);
  });

  test('an operator key + agent key + a binding signature, but no auth envelope → 401, nothing written', async () => {
    const res = await request(app())
      .post('/api/v1/human/bind')
      .set('Authorization', 'Bearer ops-key')
      .set('x-agent-key', 'agent-key')
      .send({ agent_id: AGENT, signature: await wallet.signMessage('anything'), scope: 'ownership' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_required');
    expect(writes).toEqual([]);
  });

  test("an agent key + an envelope signed by a DIFFERENT wallet → 401 bad_signature, nothing written", async () => {
    const time = new Date().toISOString();
    const forged = await stranger.signMessage(authMessage('POST', '/api/v1/human/bind', wallet.address, time));
    const res = await request(app())
      .post('/api/v1/human/bind')
      .set('x-hd-wallet', wallet.address)
      .set('x-hd-timestamp', time)
      .set('x-hd-signature', forged)
      .set('x-agent-key', 'agent-key')
      .send({ agent_id: AGENT, signature: forged, scope: 'ownership' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('bad_signature');
    expect(writes).toEqual([]);
  });
});

describe('the unsigned staging path stays deleted', () => {
  const src = join(__dirname, '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|js)$/.test(n) ? [p] : [];
    });

  test('no route file, no mount, and no source writes the human_agent_binds table', () => {
    expect(existsSync(join(src, 'routes', 'human-bind-staging.ts'))).toBe(false);
    expect(readFileSync(join(src, 'index.ts'), 'utf8')).not.toMatch(/human-bind-staging/);
    const writers = files(src).filter((f) => /from\(\s*['"`]human_agent_binds['"`]\s*\)/.test(readFileSync(f, 'utf8')));
    expect(writers).toEqual([]);
  });
});
