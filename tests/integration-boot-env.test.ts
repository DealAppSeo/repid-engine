/**
 * integration-boot-env.test.ts — pins the "secretless run SKIPS, it does not THROW" fix.
 *
 * The fix is `applyIntegrationBootEnv()` (tests/helpers/run-integration.ts), registered as a
 * `setupFiles` entry in jest.integration.config.js. Three ways it can quietly stop working, each
 * pinned below:
 *   1. It overwrites REAL credentials — the integration job would then test nothing and say so
 *      nowhere. (Real credentials must pass through untouched.)
 *   2. A placeholder arms a suite — `runIntegration()` must stay false while the marker is set.
 *   3. It is removed from, or reordered in, the config — the 18 suites go back to throwing at
 *      import (loud), or run before dotenv and shadow a developer's real `.env` (silent).
 *
 * The end-to-end proof (`npm run test:integration` with empty secrets exits 0 and skips) cannot
 * live in a unit test: it needs the whole integration run. See the PR that introduced this file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyIntegrationBootEnv,
  runIntegration,
  PLACEHOLDER_CREDS_MARKER,
} from './helpers/run-integration';

const config = require('../jest.integration.config.js') as { setupFiles: string[] };

const KEYS = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_KEY'];

describe('applyIntegrationBootEnv', () => {
  it('fills in placeholders and sets the marker when NO credentials exist', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyIntegrationBootEnv(env)).toBe(true);
    expect(env.SUPABASE_URL).toBe('http://localhost:54321');
    expect(env.SUPABASE_SERVICE_KEY).toBeTruthy();
    expect(env[PLACEHOLDER_CREDS_MARKER]).toBe('1');
  });

  it('treats EMPTY strings as absent — how Actions renders a withheld secret (Dependabot)', () => {
    const env: NodeJS.ProcessEnv = { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SMOKE_BASE_URL: '' };
    expect(applyIntegrationBootEnv(env)).toBe(true);
    expect(env.SUPABASE_URL).toBe('http://localhost:54321');
    expect(env.SUPABASE_SERVICE_KEY).toBe('placeholder-not-a-credential');
    // Unrelated env is left alone.
    expect(env.SMOKE_BASE_URL).toBe('');
  });

  it.each(KEYS)('leaves REAL credentials untouched (key supplied as %s)', (keyName) => {
    const env: NodeJS.ProcessEnv = { SUPABASE_URL: 'https://example-test.supabase.co', [keyName]: 'real-key' };
    const before = { ...env };
    expect(applyIntegrationBootEnv(env)).toBe(false);
    expect(env).toEqual(before);
    expect(env[PLACEHOLDER_CREDS_MARKER]).toBeUndefined();
  });

  it('never pairs a REAL key with the placeholder URL (URL missing, key present)', () => {
    const env: NodeJS.ProcessEnv = { SUPABASE_SECRET_KEY: 'real-secret', SUPABASE_SERVICE_ROLE_KEY: 'real-role' };
    expect(applyIntegrationBootEnv(env)).toBe(true);
    for (const k of ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY']) {
      expect(env[k]).toBeUndefined();
    }
    expect(env.SUPABASE_SERVICE_KEY).toBe('placeholder-not-a-credential');
  });

  it('never pairs a REAL URL with a placeholder key (key missing, URL present)', () => {
    const env: NodeJS.ProcessEnv = { SUPABASE_URL: 'https://example-test.supabase.co' };
    expect(applyIntegrationBootEnv(env)).toBe(true);
    expect(env.SUPABASE_URL).toBe('http://localhost:54321');
  });
});

describe('placeholder credentials never arm a suite', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('runIntegration() is FALSE with RUN_INTEGRATION=1 once placeholders are applied', () => {
    process.env.RUN_INTEGRATION = '1';
    for (const k of KEYS) delete process.env[k];
    delete process.env.SUPABASE_URL;
    applyIntegrationBootEnv();
    // The placeholders ARE a "URL + key" pair, so without the marker this would be true.
    expect(process.env.SUPABASE_URL).toBe('http://localhost:54321');
    expect(runIntegration()).toBe(false);
  });

  it('runIntegration() is still TRUE with RUN_INTEGRATION=1 and REAL credentials', () => {
    process.env.RUN_INTEGRATION = '1';
    process.env.SUPABASE_URL = 'https://example-test.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'real-key';
    delete process.env[PLACEHOLDER_CREDS_MARKER];
    applyIntegrationBootEnv();
    expect(runIntegration()).toBe(true);
  });
});

describe('jest.integration.config.js wiring', () => {
  it('registers the boot env AFTER dotenv/config, so a real .env is never shadowed', () => {
    const dotenv = config.setupFiles.indexOf('dotenv/config');
    const boot = config.setupFiles.findIndex((f) => f.endsWith('tests/helpers/integration-boot-env.ts'));
    expect(dotenv).toBeGreaterThanOrEqual(0);
    expect(boot).toBeGreaterThan(dotenv);
  });
});

describe('no integration suite can be armed by a placeholder', () => {
  // The placeholders are a URL + key PAIR, which is exactly what a credential-presence gate
  // looks for. audit-chain-integrity.test.ts had one (`URL && KEY ? describe : describe.skip`)
  // and, before it learned the marker, reported a vacuous PASS on a chain it never verified.
  // The sibling tripwire (integration-guard-hygiene.test.ts) only matches `!!(process.env.SUPABASE_URL`
  // and so could not see it. This one is broader: any integration suite that READS Supabase env
  // must either go through the shared gates or check the marker itself.
  const dir = join(__dirname, 'integration');
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const SAFE = /PLACEHOLDER_CREDS_MARKER|runIntegration|integrationSchemaPresent|describeIfSchema/;
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));

  it('finds the integration suites (an empty scan passes trivially)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every suite that reads SUPABASE_* env also uses a gate that ignores placeholders', () => {
    const offenders = files.filter((f) => {
      const code = stripComments(readFileSync(join(dir, f), 'utf8'));
      return /process\.env\.SUPABASE_/.test(code) && !SAFE.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
