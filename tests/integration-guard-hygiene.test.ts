/**
 * integration-guard-hygiene.test.ts — keeps the integration gate honest.
 *
 * Two failures this prevents, both measured 2026-08-22:
 *   1. A guard reverting to a credential-PRESENCE check. Presence is satisfied by
 *      the localhost dummy that boots src/config.ts, so the suite arms against a
 *      Supabase that isn't there (red locally) while CI, having no secrets, skips
 *      it (green) — a guard that is wrong in both directions and runs in neither.
 *   2. The gate silently passing on presence alone. `runIntegration()` must refuse
 *      unless RUN_INTEGRATION=1 is set EXPLICITLY, credentials present or not.
 *
 * This test is the tripwire the CLAUDE.md note and run-integration.ts promise.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIntegration } from './helpers/run-integration';

const INTEGRATION_DIR = join(__dirname, 'integration');

/**
 * The banned idiom: a boolean built from the mere PRESENCE of Supabase env, used
 * to decide whether a suite runs. Setting a boot default
 * (`process.env.SUPABASE_URL = process.env.SUPABASE_URL || '...'`) is allowed and
 * does not match this — only `!!(process.env.SUPABASE_URL ...)` presence booleans do.
 */
const PRESENCE_GATE = /!!\(\s*process\.env\.SUPABASE_URL/;

describe('integration guard hygiene', () => {
  const files = readdirSync(INTEGRATION_DIR).filter((f) => f.endsWith('.test.ts'));

  it('has integration files to check (guards against an empty/false-green scan)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no tests/integration file gates on credential PRESENCE — use runIntegration()', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(INTEGRATION_DIR, f), 'utf8');
      if (PRESENCE_GATE.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('runIntegration() refuses presence-without-opt-in', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is FALSE when credentials are present but RUN_INTEGRATION is unset', () => {
    delete process.env.RUN_INTEGRATION;
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_KEY = 'dummy';
    expect(runIntegration()).toBe(false);
  });

  it('is FALSE when opted in but credentials are absent', () => {
    process.env.RUN_INTEGRATION = '1';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    expect(runIntegration()).toBe(false);
  });

  it('is TRUE only with RUN_INTEGRATION=1 AND credentials', () => {
    process.env.RUN_INTEGRATION = '1';
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_KEY = 'dummy';
    expect(runIntegration()).toBe(true);
  });
});
