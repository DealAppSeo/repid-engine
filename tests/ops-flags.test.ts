/**
 * GET /api/v1/ops/flags (src/routes/ops-flags.ts, src/ops/flag-registry.ts).
 *
 * Each block below was broken once on purpose and seen to go red before this
 * file was committed (see the PR). The fence regex lives HERE, not imported from
 * the module under test, so editing the module cannot weaken its own check.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/db', () => ({ db: { from: jest.fn() } }));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn() }));

import { db } from '../src/db';
import { logAgentEvent } from '../src/engine/agent-log';
import { authMiddleware } from '../src/middleware/auth';
import { opsFlagsRouter } from '../src/routes/ops-flags';
import { FLAG_REGISTRY, classifyEnvValue } from '../src/ops/flag-registry';
import { ALL_KEYS as HAL_KEYS, invalidateHalConfigCache } from '../src/hal/config';
import { KNOWN_ENV_VARS } from '../src/config/known-env-vars.generated';

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PRIVATE|SEED|MNEMONIC|URL|ADDRESS|DSN|WEBHOOK/i;
const OPS_KEY = 'ops-flags-test-ops';
const PRO_KEY = 'ops-flags-test-pro';
const LOOK_KEY = 'ops-flags-test-look-only-key-0123456789';

// repid_config rows the mocked db returns; `fail` makes the read fail.
let rows: Array<{ key: string; value: string }> = [];
let fail: 'none' | 'error' | 'throw' = 'none';
const repidConfigTable = () => ({
  select: () => ({
    in: async () => {
      if (fail === 'throw') throw new Error('network down');
      if (fail === 'error') return { data: null, error: { message: 'permission denied' } };
      return { data: rows, error: null };
    },
  }),
});

const touched = new Set<string>();
function setEnv(name: string, value: string) {
  touched.add(name);
  process.env[name] = value;
}

const app = express();
app.use(authMiddleware);
// What authMiddleware left on the request: the rate limiter reads req.apiKey.key as its bucket name.
let lastApiKey: unknown;
app.use((req, _res, next) => { lastApiKey = (req as any).apiKey; next(); });
app.use('/api/v1/ops', opsFlagsRouter);
// Any authed caller reaches this: it shows what a key can do beyond the flags list.
app.get('/api/v1/other', (_req, res) => res.json({ reached: true }));

async function getFlags() {
  const res = await request(app).get('/api/v1/ops/flags').set('x-api-key', OPS_KEY);
  expect(res.status).toBe(200);
  const byName = Object.fromEntries(res.body.flags.map((f: any) => [f.name, f]));
  return { res, byName };
}

beforeEach(() => {
  process.env.REPID_API_KEYS = `${OPS_KEY}:ops,${PRO_KEY}:pro`;
  for (const n of [...FLAG_REGISTRY, ...touched, 'HAL_CONFIG_FROM_DB']) delete process.env[n];
  touched.clear();
  rows = [];
  fail = 'none';
  (db.from as jest.Mock).mockImplementation(repidConfigTable);
  invalidateHalConfigCache();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('the registry', () => {
  it('holds no secret-shaped name', () => {
    expect(FLAG_REGISTRY.length).toBeGreaterThan(100);
    expect(FLAG_REGISTRY.filter((n) => SECRET_NAME.test(n))).toEqual([]);
  });

  it('the fence can say yes: it matches the flags it is documented to drop', () => {
    for (const n of ['AGENT_SELF_SERVE_KEYS_ENABLED', 'TOKEN_SIGNUP_ENABLED', 'ZKP_SERVICE_URL']) {
      expect(SECRET_NAME.test(n)).toBe(true);
    }
  });

  it('is exactly the documented rule applied to known-env-vars plus the HAL repid_config keys', () => {
    const shaped = (n: string) =>
      /(_ENABLED|_MODE|_ENFORCE|_ENFORCED|_STRICTNESS)$/.test(n) || n.startsWith('HAL_S2_ENABLE_') || n.includes('SHADOW');
    const expected = new Set([...KNOWN_ENV_VARS.filter(shaped), ...HAL_KEYS].filter((n) => !SECRET_NAME.test(n)));
    const actual = new Set(FLAG_REGISTRY);
    const add = [...expected].filter((n) => !actual.has(n)).sort();
    const remove = [...actual].filter((n) => !expected.has(n)).sort();
    // On failure: add / remove these names in src/ops/flag-registry.ts.
    expect({ add, remove }).toEqual({ add: [], remove: [] });
    expect(actual.size).toBe(FLAG_REGISTRY.length); // no duplicates
  });
});

describe('env values', () => {
  it('reports unset, on, off and mode words as such, with the source', async () => {
    setEnv('DISPUTE_WORKER_ENABLED', 'on');
    setEnv('EAS_ANCHOR_WORKER_ENABLED', 'off');
    setEnv('TASK_VERIFY_LEG_MODE', 'shadow');
    setEnv('LINEAGE_DEPTH_MODE', 'enforce');
    setEnv('SBFA_SHADOW_SAMPLE_RATE', '0.25');
    const { byName } = await getFlags();
    expect(byName.CASCADE_SETTLEMENT_ENABLED).toEqual({ name: 'CASCADE_SETTLEMENT_ENABLED', value: 'unset', source: 'default' });
    expect(byName.DISPUTE_WORKER_ENABLED).toMatchObject({ value: 'on', source: 'env' });
    expect(byName.EAS_ANCHOR_WORKER_ENABLED).toMatchObject({ value: 'off', source: 'env' });
    expect(byName.TASK_VERIFY_LEG_MODE).toMatchObject({ value: 'shadow', source: 'env' });
    expect(byName.LINEAGE_DEPTH_MODE).toMatchObject({ value: 'enforce', source: 'env' });
    expect(byName.SBFA_SHADOW_SAMPLE_RATE).toMatchObject({ value: '0.25', source: 'env' });
  });

  it('echoes true as true, never as on (X402_RELEASE_RETRY_ENABLED=true resolves to off)', async () => {
    setEnv('X402_RELEASE_RETRY_ENABLED', 'true');
    setEnv('REAL_STAKING_ENABLED', 'TRUE');
    const { byName } = await getFlags();
    expect(byName.X402_RELEASE_RETRY_ENABLED.value).toBe('true');
    expect(byName.REAL_STAKING_ENABLED.value).toBe('TRUE');
  });

  it('reports a non-mode value as set and never echoes it', async () => {
    const canary = 'sk-canary-9f3a2b7c';
    setEnv('ENGINE_WORKERS_ENABLED', canary);
    setEnv('ARENA_ENABLED', '');
    setEnv('LOCAL_MODE', '12345678');
    const { res, byName } = await getFlags();
    expect(byName.ENGINE_WORKERS_ENABLED).toMatchObject({ value: 'set', source: 'env' });
    expect(byName.ARENA_ENABLED).toMatchObject({ value: 'set', source: 'env' });
    expect(byName.LOCAL_MODE).toMatchObject({ value: 'set', source: 'env' });
    expect(res.text).not.toContain(canary);
    expect(res.text).not.toContain('12345678');
  });

  it('classifyEnvValue never returns an input outside the mode words and short numbers', () => {
    for (const raw of ['hunter2', 'true ', 'ENFORCE;', '0x8004A818', 'https://x.test', '1e9']) {
      expect(classifyEnvValue(raw)).toBe('set');
    }
  });
});

describe('HAL keys come from getHalConfig', () => {
  it('reports a repid_config row, an env value and a default, each with its source', async () => {
    rows = [{ key: 'HAL_S2_ENABLE_GEMINI', value: 'true' }];
    setEnv('HAL_S2_ENABLE_MISTRAL', 'false');
    setEnv('HAL_STRICTNESS', '2');
    const { res, byName } = await getFlags();
    expect(res.body.repid_config_read).toBe('ok');
    expect(byName.HAL_S2_ENABLE_GEMINI).toMatchObject({ value: 'on', source: 'repid_config' });
    expect(byName.HAL_S2_ENABLE_MISTRAL).toMatchObject({ value: 'off', source: 'env' });
    expect(byName.HAL_STRICTNESS).toMatchObject({ value: '2', source: 'env' });
    expect(byName.HAL_S2_ENABLE_GROQ).toMatchObject({ value: 'on', source: 'default' });
  });

  it.each(['error', 'throw'] as const)('a failed repid_config read (%s) is unknown for every HAL key, never off', async (mode) => {
    fail = mode;
    setEnv('HAL_S2_ENABLE_MISTRAL', 'false');
    setEnv('DISPUTE_WORKER_ENABLED', 'on');
    const { res, byName } = await getFlags();
    expect(res.body.repid_config_read).toBe('failed');
    for (const key of HAL_KEYS) {
      expect(byName[key]).toEqual({ name: key, value: 'unknown', source: 'repid_config' });
    }
    expect(byName.DISPUTE_WORKER_ENABLED).toMatchObject({ value: 'on', source: 'env' }); // non-HAL still reported
  });

  it('with HAL_CONFIG_FROM_DB=false the env/default resolution is the real one, not unknown', async () => {
    fail = 'throw';
    setEnv('HAL_CONFIG_FROM_DB', 'false');
    setEnv('HAL_S2_ENABLE_MISTRAL', 'false');
    const { res, byName } = await getFlags();
    expect(res.body.repid_config_read).toBe('disabled');
    expect(byName.HAL_S2_ENABLE_MISTRAL).toMatchObject({ value: 'off', source: 'env' });
  });
});

describe('auth', () => {
  it('no key is a 401', async () => {
    const res = await request(app).get('/api/v1/ops/flags');
    expect(res.status).toBe(401);
    expect(res.body.flags).toBeUndefined();
  });

  it('a non-operator REPID_API_KEYS key is a 403', async () => {
    const res = await request(app).get('/api/v1/ops/flags').set('x-api-key', PRO_KEY);
    expect(res.status).toBe(403);
    expect(res.body.flags).toBeUndefined();
  });

  it('an operator key gets the report, uncached, with the deployed commit', async () => {
    const { res } = await getFlags();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(typeof res.body.deployed_commit).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.generated_at))).toBe(false);
    expect(res.body.flags).toHaveLength(FLAG_REGISTRY.length);
  });
});

describe('the look-only key (OPS_READ_KEY)', () => {
  it('reads the report', async () => {
    setEnv('OPS_READ_KEY', LOOK_KEY);
    const res = await request(app).get('/api/v1/ops/flags').set('x-api-key', LOOK_KEY);
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(FLAG_REGISTRY.length);
  });

  it('is refused on every other path and method, where an operator key gets through', async () => {
    setEnv('OPS_READ_KEY', LOOK_KEY);
    expect((await request(app).get('/api/v1/other').set('x-api-key', OPS_KEY)).status).toBe(200);
    for (const send of [
      () => request(app).get('/api/v1/other').set('x-api-key', LOOK_KEY),
      () => request(app).get('/api/v1/other').set('authorization', `Bearer ${LOOK_KEY}`),
      () => request(app).post('/api/v1/ops/flags').set('x-api-key', LOOK_KEY),
      () => request(app).get('/api/v1/ops/flags/').set('x-api-key', LOOK_KEY),
    ]) {
      const res = await send();
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("can only read GET /api/v1/ops/flags");
      expect(res.body.reached).toBeUndefined();
    }
  });

  it('matches nothing when OPS_READ_KEY is unset or shorter than 32 characters', async () => {
    expect((await request(app).get('/api/v1/ops/flags').set('x-api-key', LOOK_KEY)).status).toBe(403);
    setEnv('OPS_READ_KEY', 'short-look-key');
    const res = await request(app).get('/api/v1/ops/flags').set('x-api-key', 'short-look-key');
    expect(res.status).toBe(403);
    expect(res.body.flags).toBeUndefined();
  });

  it('never puts the key value in a log entry, a response or the rate-limit bucket name', async () => {
    setEnv('OPS_READ_KEY', LOOK_KEY);
    (logAgentEvent as jest.Mock).mockClear();
    lastApiKey = undefined;
    const ok = await request(app).get('/api/v1/ops/flags').set('x-api-key', LOOK_KEY);
    const refused = await request(app).get('/api/v1/other').set('x-api-key', LOOK_KEY);
    expect(ok.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(lastApiKey).toEqual({ key: 'look-only', tier: 'look-only', lookOnly: true });
    expect((logAgentEvent as jest.Mock).mock.calls.length).toBe(2);
    const seen = JSON.stringify([(logAgentEvent as jest.Mock).mock.calls, ok.body, refused.body]);
    expect(seen).not.toContain(LOOK_KEY);
  });

  it('cannot be forged with a REPID_API_KEYS tier name', async () => {
    process.env.REPID_API_KEYS += ',forged-look-only:look-only';
    const res = await request(app).get('/api/v1/ops/flags').set('x-api-key', 'forged-look-only');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden: needs an operator key');
  });
});
