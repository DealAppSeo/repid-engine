/**
 * Unit tests for the integration-test guard/schema helpers.
 *
 * Covers (hermetically — NO live Supabase; the client + probe are mocked):
 *   - isProdSupabase(url)          — prod-ref detection vs test/localhost/unset
 *   - hasSupabaseEnv()             — env-presence gate
 *   - tableExists() / hasSchema()  — probe finds table (true) vs 42P01 /
 *                                    PGRST205 / unset-env (false), no throws
 *   - describeIfSchema selector    — resolves to describe.skip vs describe
 *                                    based on INTEGRATION_SCHEMA_PRESENT
 *
 * These helpers changed in PR #146 (skip-based, not throw-based) — this file
 * supersedes the old #140 throw-guard tests.
 */

import { createClient } from '@supabase/supabase-js';
import {
  PROD_PROJECT_REF,
  REQUIRED_TABLES,
  hasSupabaseEnv,
  isProdSupabase,
  tableExists,
  tablesExist,
  hasSchema,
} from './prod-guard';

jest.mock('@supabase/supabase-js');

/**
 * Build a mocked Supabase client whose `.from(table).select(...).limit(...)`
 * resolves with the given per-table result. `resultFor` maps a table name to
 * the `{ error }` PostgREST response returned for that table.
 */
function mockSupabase(resultFor: (table: string) => { error: unknown }): void {
  (createClient as jest.Mock).mockReturnValue({
    from: jest.fn((table: string) => ({
      select: jest.fn(() => ({
        limit: jest.fn().mockResolvedValue(resultFor(table)),
      })),
    })),
  });
}

/** Snapshot + restore process.env around a test body (hermetic, no leakage). */
function withEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<void> | void
): Promise<void> {
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return (async () => {
    try {
      for (const k of keys) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  })();
}

const TEST_URL = 'https://testprojref00000000.supabase.co';
const PROD_URL = `https://${PROD_PROJECT_REF}.supabase.co`;
const KEY = 'service-key-abc';

afterEach(() => {
  jest.clearAllMocks();
});

describe('prod-guard: isProdSupabase', () => {
  it('returns true for the production project ref', () => {
    expect(isProdSupabase(PROD_URL)).toBe(true);
    expect(isProdSupabase(`https://${PROD_PROJECT_REF}.supabase.co/rest/v1`)).toBe(true);
  });

  it('returns false for a test / non-prod Supabase URL', () => {
    expect(isProdSupabase(TEST_URL)).toBe(false);
  });

  it('returns false for a localhost URL', () => {
    expect(isProdSupabase('http://localhost:54321')).toBe(false);
  });

  it('returns false when the URL is undefined / unset / empty', () => {
    expect(isProdSupabase(undefined)).toBe(false);
    expect(isProdSupabase('')).toBe(false);
  });

  it('reads process.env.SUPABASE_URL when no arg is passed', () =>
    withEnv({ SUPABASE_URL: PROD_URL }, () => {
      expect(isProdSupabase()).toBe(true);
    }));

  it('returns false via env when SUPABASE_URL is unset', () =>
    withEnv({ SUPABASE_URL: undefined }, () => {
      expect(isProdSupabase()).toBe(false);
    }));
});

describe('prod-guard: hasSupabaseEnv', () => {
  it('true when URL + service key are both set', () =>
    withEnv({ SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: KEY }, () => {
      expect(hasSupabaseEnv()).toBe(true);
    }));

  it('true when URL + service ROLE key are set', () =>
    withEnv(
      { SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: KEY },
      () => {
        expect(hasSupabaseEnv()).toBe(true);
      }
    ));

  it('false when URL is missing', () =>
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: KEY }, () => {
      expect(hasSupabaseEnv()).toBe(false);
    }));

  it('false when both keys are missing', () =>
    withEnv(
      {
        SUPABASE_URL: TEST_URL,
        SUPABASE_SERVICE_KEY: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      },
      () => {
        expect(hasSupabaseEnv()).toBe(false);
      }
    ));
});

describe('prod-guard: tableExists', () => {
  it('returns true when the probe finds the table (no error)', () =>
    withEnv({ SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: KEY }, async () => {
      mockSupabase(() => ({ error: null }));
      await expect(tableExists('repid_events')).resolves.toBe(true);
    }));

  it('returns false on Postgres 42P01 (undefined_table)', () =>
    withEnv({ SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: KEY }, async () => {
      mockSupabase(() => ({ error: { code: '42P01', message: 'relation "x" does not exist' } }));
      await expect(tableExists('repid_events')).resolves.toBe(false);
    }));

  it('returns false on PostgREST PGRST205 (schema-cache miss)', () =>
    withEnv({ SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: KEY }, async () => {
      mockSupabase(() => ({
        error: { code: 'PGRST205', message: "Could not find the table 'public.x'" },
      }));
      await expect(tableExists('repid_events')).resolves.toBe(false);
    }));

  it('returns false (not throw) on an ambiguous auth/network error', () =>
    withEnv({ SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: KEY }, async () => {
      mockSupabase(() => ({ error: { code: '42501', message: 'permission denied' } }));
      await expect(tableExists('repid_events')).resolves.toBe(false);
    }));

  it('returns false when Supabase env is unset (no client, no throw)', () =>
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, async () => {
      await expect(tableExists('repid_events')).resolves.toBe(false);
    }));
});

describe('prod-guard: tablesExist / hasSchema', () => {
  it('true only when ALL required tables are present', () =>
    withEnv({ SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: KEY }, async () => {
      mockSupabase(() => ({ error: null }));
      await expect(tablesExist(REQUIRED_TABLES)).resolves.toBe(true);
      await expect(hasSchema()).resolves.toBe(true);
    }));

  it('false when one required table is missing (42P01)', () =>
    withEnv({ SUPABASE_URL: TEST_URL, SUPABASE_SERVICE_KEY: KEY }, async () => {
      const [first] = REQUIRED_TABLES;
      mockSupabase((table) =>
        table === first ? { error: null } : { error: { code: '42P01', message: 'does not exist' } }
      );
      await expect(tablesExist(REQUIRED_TABLES)).resolves.toBe(false);
      await expect(hasSchema()).resolves.toBe(false);
    }));

  it('false when env is unset', () =>
    withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, async () => {
      await expect(hasSchema()).resolves.toBe(false);
    }));
});

describe('describe-if-schema: integrationSchemaPresent flag', () => {
  it('is true only when INTEGRATION_SCHEMA_PRESENT is exactly "true"', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { integrationSchemaPresent } = require('./describe-if-schema');
    const saved = process.env.INTEGRATION_SCHEMA_PRESENT;
    try {
      process.env.INTEGRATION_SCHEMA_PRESENT = 'true';
      expect(integrationSchemaPresent()).toBe(true);
      process.env.INTEGRATION_SCHEMA_PRESENT = 'false';
      expect(integrationSchemaPresent()).toBe(false);
      delete process.env.INTEGRATION_SCHEMA_PRESENT;
      expect(integrationSchemaPresent()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.INTEGRATION_SCHEMA_PRESENT;
      else process.env.INTEGRATION_SCHEMA_PRESENT = saved;
    }
  });
});

/**
 * The `describeIfSchema` selector chooses `describe` vs `describe.skip` based
 * on the flag. Jest forbids calling `describe`/`describe.skip` inside a running
 * `it()` (no nested suites), so we exercise the selector against a STUBBED
 * `describe` global (a plain function with a `.skip` property). This asserts
 * the picking logic directly — which function gets invoked — without
 * registering any real suite.
 */
describe('describe-if-schema: selector picks describe vs describe.skip', () => {
  const savedFlag = process.env.INTEGRATION_SCHEMA_PRESENT;
  let realDescribe: typeof describe;

  beforeEach(() => {
    realDescribe = global.describe;
  });

  afterEach(() => {
    global.describe = realDescribe;
    if (savedFlag === undefined) delete process.env.INTEGRATION_SCHEMA_PRESENT;
    else process.env.INTEGRATION_SCHEMA_PRESENT = savedFlag;
    jest.resetModules();
  });

  /** Load a fresh describeIfSchema against a stubbed describe global. */
  function loadWithStubbedDescribe(flag: string | undefined) {
    if (flag === undefined) delete process.env.INTEGRATION_SCHEMA_PRESENT;
    else process.env.INTEGRATION_SCHEMA_PRESENT = flag;

    const run = jest.fn();
    const skip = jest.fn();
    const stub = Object.assign(run, { skip }) as unknown as jest.Describe;
    global.describe = stub;

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { describeIfSchema } = require('./describe-if-schema');
    return { describeIfSchema, run, skip };
  }

  it('delegates to describe (RUN) when schema present', () => {
    const { describeIfSchema, run, skip } = loadWithStubbedDescribe('true');
    const body = () => undefined;
    describeIfSchema('run-when-present', body);
    expect(run).toHaveBeenCalledWith('run-when-present', body);
    expect(skip).not.toHaveBeenCalled();
  });

  it('delegates to describe.skip (SKIP) when schema absent', () => {
    const { describeIfSchema, run, skip } = loadWithStubbedDescribe('false');
    const body = () => undefined;
    describeIfSchema('skip-when-absent', body);
    expect(skip).toHaveBeenCalledWith('skip-when-absent', body);
    // The RUN path must not fire when skipping (stub.run also backs describe.skip
    // lookups, so assert skip specifically received the call, not a spurious run).
    expect(run).not.toHaveBeenCalledWith('skip-when-absent', body);
  });

  it('delegates to describe.skip (SKIP) when the flag is unset', () => {
    const { describeIfSchema, run, skip } = loadWithStubbedDescribe(undefined);
    const body = () => undefined;
    describeIfSchema('skip-when-unset', body);
    expect(skip).toHaveBeenCalledWith('skip-when-unset', body);
    expect(run).not.toHaveBeenCalledWith('skip-when-unset', body);
  });
});

describe('prod-guard: exported constants', () => {
  it('PROD_PROJECT_REF is the canonical Trinity prod ref', () => {
    expect(PROD_PROJECT_REF).toBe('qnnpjhlxljtqyigedwkb');
  });

  it('REQUIRED_TABLES is non-empty', () => {
    expect(REQUIRED_TABLES.length).toBeGreaterThan(0);
  });
});
