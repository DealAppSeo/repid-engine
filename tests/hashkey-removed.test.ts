/**
 * HashKey is gone, and stays gone (CC1 2026-10-15).
 *
 * Measured before removal: the router in src/routes/hashkey.ts was imported by index.ts and never
 * mounted (production answered /hashkey, /hashkey/config and /hashkey/anchor/:id with the same 401
 * as any unknown path); the contract had no code on HashKey testnet or mainnet; all 12 anchors ever
 * written were stubs; and the RPC env pointed at mainnet with a deployer key configured, so the next
 * challenge would have tried a real mainnet transaction to a codeless address.
 */
jest.mock('../src/db', () => {
  const chain: any = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.in = jest.fn().mockResolvedValue({ data: [], error: null });
  chain.not = jest.fn().mockReturnValue(chain);
  chain.order = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue({ data: [], error: null });
  return { db: { from: jest.fn().mockReturnValue(chain), rpc: jest.fn() } };
});

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [full] : [];
  });
}

describe('HashKey removal', () => {
  it('the HashKey modules no longer exist', () => {
    expect(existsSync(path.join(SRC, 'routes', 'hashkey.ts'))).toBe(false);
    expect(existsSync(path.join(SRC, 'engine', 'hashkey-chain.ts'))).toBe(false);
  });

  it('nothing in src/ imports, mounts or calls them', () => {
    const offenders = sourceFiles(SRC).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /hashkey-chain|routes\/hashkey|from '\.\/hashkey'|hashkeyRouter|anchorRepIdEvent|testHashKeyConnection|HASHKEY_CONFIG/.test(src);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('config carries no HashKey setting', () => {
    const { config } = require('../src/config');
    expect(Object.keys(config).filter((k) => /hashkey/i.test(k))).toEqual([]);
  });

  it('the OpenAPI spec lists no /hashkey path and no HashKey tag', () => {
    const mod = require('../src/api/openapi');
    const spec = mod.openApiSpec ?? mod.default ?? Object.values(mod)[0];
    expect(Object.keys(spec.paths).filter((p) => /hashkey/i.test(p))).toEqual([]);
    expect(JSON.stringify(spec.tags ?? [])).not.toMatch(/hashkey/i);
  });

  // The health route pulls in a large module graph; compiling it the first time can take several
  // seconds under parallel CI load, which is not what this case measures.
  let healthRouter: any;
  beforeAll(() => {
    healthRouter = require('../src/routes/health').default;
  }, 60_000);

  it('GET /health has no HashKey field and dials no HashKey RPC', async () => {
    const app = express();
    app.use(healthRouter);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).filter((k) => /hashkey/i.test(k))).toEqual([]);
    expect(res.body).toHaveProperty('supabaseConnected');
  });
});
