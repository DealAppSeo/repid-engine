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
import { join, relative } from 'node:path';
import { runIntegration } from './helpers/run-integration';

/**
 * SCOPE — widened 2026-08-27, and the reason matters more than the change.
 *
 * This scan used to read ONLY `tests/integration/`. `trinity-swarm-health.test.ts`
 * lives at `tests/` root, gated on credential presence, and had done so the whole
 * time: it failed locally against the boot dummy and skipped silently in CI, while
 * THIS suite sat green one directory away. A tripwire that cannot see the room it
 * guards reports success it has not earned — the same defect it exists to prevent.
 *
 * So the scan now walks every `*.test.ts` under `tests/`, at any depth.
 *
 * This scan READS FILES FROM DISK; it does not run them. That distinction is why
 * it still covers `tests/integration/` during the unit run, even though
 * `jest.config.js` puts that directory in `testPathIgnorePatterns` so those suites
 * never execute there. A guard that could only see what the current jest
 * invocation happens to execute would go blind exactly where coverage is thinnest.
 */
const TESTS_DIR = __dirname;

/** Every *.test.ts under tests/, recursively. */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * COMMENTS ARE STRIPPED BEFORE SCANNING, and that is load-bearing.
 *
 * Three files in this repo quote the banned idiom inside a comment in order to
 * explain why they moved off it — including this file's own header and
 * `hal-accuracy-summary.test.ts`, which documents the presence-vs-liveness
 * distinction at length. A raw scan flags all three. A guard that punishes the
 * files documenting the rule teaches people to delete the documentation, so it
 * must read code, not prose.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The banned idiom: a boolean built from the mere PRESENCE of Supabase env, used
 * to decide whether a suite runs. Setting a boot default
 * (`process.env.SUPABASE_URL = process.env.SUPABASE_URL || '...'`) is allowed and
 * does not match this — only `!!(process.env.SUPABASE_URL ...)` presence booleans do.
 */
const PRESENCE_GATE = /!!\(\s*process\.env\.SUPABASE_URL/;

describe('integration guard hygiene', () => {
  const files = testFiles(TESTS_DIR);

  it('finds test files to check (guards against an empty/false-green scan)', () => {
    // A scan of zero files passes trivially. That is exactly how this guard was
    // green while an offender sat outside its directory.
    expect(files.length).toBeGreaterThan(20);
  });

  it('actually reaches BOTH tests/ root and tests/integration/', () => {
    // The specific blindness that let the bug through. Asserting the count alone
    // would still pass if the scan silently narrowed to one directory again.
    const rel = files.map((f) => relative(TESTS_DIR, f));
    expect(rel.some((f) => !f.includes('/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('integration/'))).toBe(true);
  });

  it('no test file gates on credential PRESENCE — use runIntegration()', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (PRESENCE_GATE.test(stripComments(readFileSync(f, 'utf8')))) {
        offenders.push(relative(TESTS_DIR, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does NOT flag a file that only quotes the idiom in a comment', () => {
    // Proves the strip works, so the guard cannot regress into punishing the
    // files that explain the rule.
    const commented = `/** const HAS_DB = !!(process.env.SUPABASE_URL && x); */\nconst ok = 1;`;
    expect(PRESENCE_GATE.test(commented)).toBe(true);
    expect(PRESENCE_GATE.test(stripComments(commented))).toBe(false);
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
