/**
 * Human-path shadow — the walk is recorded and nothing on it is performed.
 *
 * The load-bearing test walks the import graph from human-path-shadow.ts and
 * from the route that serves it, and asserts src/db.ts is not reachable. The
 * same walker is run against stake-vault.ts, which does reach the database, so
 * a walker that matches nothing cannot report a clean graph and pass.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import express from 'express';
import request from 'supertest';

import { attenuateCeiling as algebra } from '../src/services/attenuate-ceiling';
import { attenuateCeiling as reexported } from '../src/services/owner-ceiling-shadow';
import {
  HUMAN_PATH_ORDER,
  flagIsOn,
  shadowHumanPath,
} from '../src/services/human-path-shadow';
import humanPathRouter from '../src/routes/human-path';

const SRC = resolve(__dirname, '..', 'src');

function reachableLocalModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)];
    for (const match of specifiers) {
      const spec = match[1];
      if (!spec) continue;
      const base = resolve(dirname(file), spec);
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', humanPathRouter);
  return app;
}

const GATES = ['SELF_SERVE_ACCOUNTS_ENABLED', 'HUMAN_AGENT_BIND_ENABLED', 'REAL_STAKING_ENABLED', 'OWNER_CEILING_SHADOW_ENABLED', 'GATE_PROVISIONS_ACCOUNT'] as const;

describe('human-path shadow', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of GATES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of GATES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  const dbModule = join(SRC, 'db.ts');

  it('ANCHOR: the walker detects the database client when it IS reachable', () => {
    const reachable = reachableLocalModules(join(SRC, 'services', 'stake-vault.ts'));
    expect(reachable.has(dbModule)).toBe(true);
  });

  it('the shadow module and its route cannot reach the database client', () => {
    for (const rel of ['services/human-path-shadow.ts', 'routes/human-path.ts', 'services/attenuate-ceiling.ts']) {
      const reachable = reachableLocalModules(join(SRC, rel));
      expect(reachable.has(dbModule)).toBe(false);
    }
  });

  it('records the six steps in order and applies none of them', () => {
    const body = shadowHumanPath();
    expect(body.path).toBe('human');
    expect(body.mode).toBe('shadow');
    expect(body.applied).toBe(false);
    expect(body.persisted).toBe(false);
    expect(body.distinct_from).toBe('POST /agents/human');
    expect(body.steps.map((s) => s.id)).toEqual([...HUMAN_PATH_ORDER]);
    body.steps.forEach((step, i) => {
      expect(step.order).toBe(i + 1);
      expect(step.mode).toBe('shadow');
      expect(step.applied).toBe(false);
      expect(step.persisted).toBe(false);
    });
    expect(body.testnet_tokens).toEqual({
      dispenses: false,
      chain_id: 84532,
      reads: ['GET /api/v1/faucet/info', 'GET /api/v1/faucet/balance'],
    });
    const bind = body.steps.find((step) => step.id === 'bind_agents');
    expect(bind?.applied).toBe(false);
    expect(bind?.would).toContain('wallet');
    expect(bind?.would).toContain('agent');
    expect(body.steps.every((step) => step.applied === false)).toBe(true);
  });

  it('uses the same ceiling algebra the owner-ceiling shadow re-exports', () => {
    expect(algebra(100, 25)).toEqual(reexported(100, 25));
    const narrowed = shadowHumanPath({ agentCeilingUsdc: 100, ownerCapUsdcPerTx: 25 });
    expect(narrowed.blast_radius_cap).toMatchObject({
      status: 'computed',
      ceiling_usdc: 25,
      narrowed: true,
      bound_by: 'owner_limit',
    });
    expect(narrowed.applied).toBe(false);

    const notWidened = shadowHumanPath({ agentCeilingUsdc: 100, ownerCapUsdcPerTx: 1000 });
    expect(notWidened.blast_radius_cap.ceiling_usdc).toBe(100);
    expect(notWidened.blast_radius_cap.bound_by).toBe('agent_tier');

    const closed = shadowHumanPath({ agentCeilingUsdc: 100, ownerCapUsdcPerTx: Number.NaN });
    expect(closed.blast_radius_cap.ceiling_usdc).toBe(0);
  });

  it('a missing cap is NOT_CHECKED, not zero', () => {
    const none = shadowHumanPath();
    expect(none.blast_radius_cap.status).toBe('NOT_CHECKED');
    expect(none.blast_radius_cap.ceiling_usdc).toBeNull();

    const agentOnly = shadowHumanPath({ agentCeilingUsdc: 100 });
    expect(agentOnly.blast_radius_cap.status).toBe('NOT_CHECKED');
    expect(agentOnly.blast_radius_cap.ceiling_usdc).toBeNull();

    const lookedAndFoundNone = shadowHumanPath({ agentCeilingUsdc: 100, ownerCapUsdcPerTx: null });
    expect(lookedAndFoundNone.blast_radius_cap).toMatchObject({
      status: 'computed',
      ceiling_usdc: 100,
      narrowed: false,
      bound_by: 'agent_tier',
    });
  });

  it('publishes only the gates that are already public, and a live flag still applies nothing', () => {
    const off = shadowHumanPath();
    expect(off.connect_wallet.live_gate).toEqual({
      name: 'SELF_SERVE_ACCOUNTS_ENABLED',
      published: true,
      status: 'off',
    });
    expect(off.bind_agents.live_gate.status).toBe('off');
    expect(off.stake.live_gate).toEqual({ name: 'REAL_STAKING_ENABLED', published: false });
    expect(off.blast_radius_cap.live_observer).toEqual({
      name: 'OWNER_CEILING_SHADOW_ENABLED',
      published: false,
    });

    process.env.SELF_SERVE_ACCOUNTS_ENABLED = 'TRUE';
    process.env.REAL_STAKING_ENABLED = 'true';
    process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
    const on = shadowHumanPath({ agentCeilingUsdc: 10, ownerCapUsdcPerTx: 1 });
    expect(on.connect_wallet.live_gate.status).toBe('ignored_value');
    expect(flagIsOn('SELF_SERVE_ACCOUNTS_ENABLED')).toBe(false);
    expect(flagIsOn('REAL_STAKING_ENABLED')).toBe(true);
    expect(on.bind_agents.live_gate.status).toBe('on');
    expect(on.stake.live_gate).toEqual({ name: 'REAL_STAKING_ENABLED', published: false });
    expect(JSON.stringify(on.stake)).not.toContain('true');
    expect(on.applied).toBe(false);
    expect(on.steps.every((s) => s.applied === false)).toBe(true);
  });

  it('GET /api/v1/human/path previews a cap and rejects a bad number', async () => {
    const ok = await request(makeApp()).get('/api/v1/human/path?agent_ceiling=100&owner_cap=25');
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toBe(false);
    expect(ok.body.blast_radius_cap.ceiling_usdc).toBe(25);
    expect(ok.body.steps).toHaveLength(6);

    const none = await request(makeApp()).get('/api/v1/human/path?agent_ceiling=100&owner_cap=none');
    expect(none.status).toBe(200);
    expect(none.body.blast_radius_cap).toMatchObject({ status: 'computed', ceiling_usdc: 100, narrowed: false });

    const bad = await request(makeApp()).get('/api/v1/human/path?owner_cap=lots');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_owner_cap');
  });

  it('the faucet route still says it does not dispense', () => {
    const source = readFileSync(join(SRC, 'routes', 'faucet.ts'), 'utf8');
    expect(source).toContain('dispenses: false');
  });

  it('GET /api/v1/human/path is mounted before auth, so an unknown path is not the answer', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const mount = index.indexOf("app.use('/api/v1', humanPathRouter)");
    const auth = index.indexOf('app.use(authMiddleware)');
    expect(mount).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(mount);
  });
});
