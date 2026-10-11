/**
 * run-integration.ts — the ONE gate every integration (DB/network-touching)
 * suite must use. Opt-in and explicit, never credential-presence.
 *
 * WHY PRESENCE IS THE WRONG GATE. The repo's DB suites used to gate on
 * `!!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)`. But
 * `src/config.ts` REQUIRES those two just to BOOT, and CLAUDE.md tells
 * developers to export `SUPABASE_URL=http://localhost:54321
 * SUPABASE_SERVICE_KEY=dummy` to make it boot. That dummy satisfies a presence
 * check — so the suite ARMS against a Supabase that does not exist and fails on
 * an unreachable localhost.
 *
 * IT WAS GREEN IN CI FOR A DIFFERENT AND WORSE REASON than this file used to
 * claim. The old text here said "in CI there are no secrets, so presence is
 * false" — measured 2026-08-27 against `ci.yml`, that is wrong: the Unit tests
 * step exports presence dummies of its own. The last suite doing this skipped on
 * a variable-NAME mismatch — the workflow sets SUPABASE_SERVICE_ROLE_KEY, the
 * gate read SUPABASE_SERVICE_KEY. Align those two names and the same gate
 * evaluates TRUE in CI and arms against localhost:54321 on every PR.
 *
 * So presence gates are not merely silent in CI; they are silent by accident,
 * and one rename away from breaking the build for everyone. The result is a
 * guard that is red for the wrong reason locally and quiet in CI for an
 * unrelated one: it never actually runs, and nobody notices.
 *
 * A guard that knows one bad value (special-casing `localhost:54321`) fails open
 * for every OTHER unreachable endpoint, so we do NOT special-case a host. We
 * require an EXPLICIT opt-in instead: `RUN_INTEGRATION=1`. Credentials are still
 * required alongside it (opting in without them is a misconfiguration, not a
 * run), but presence alone never arms anything.
 *
 * Usage:
 *   import { describeIfIntegration } from '../helpers/run-integration';
 *   describeIfIntegration('my write-path suite', () => { ... });
 *
 * Compose with `integrationSchemaPresent()` where a suite also needs the test
 * project seeded:  `(runIntegration() && integrationSchemaPresent() ? describe : describe.skip)`.
 */

/**
 * Set by `applyIntegrationBootEnv()` when it had to substitute placeholder credentials.
 * `runIntegration()` refuses while it is set, so a placeholder can never arm a suite.
 */
export const PLACEHOLDER_CREDS_MARKER = 'INTEGRATION_PLACEHOLDER_CREDS';

// Every name `src/config.ts` accepts for the DB key, in its precedence order.
const CONFIG_KEY_NAMES = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_KEY',
] as const;

/**
 * Let `src/config.ts` BOOT when the integration credentials are absent, so a secretless run
 * SKIPS instead of throwing at import. Wired in as a `setupFiles` entry by
 * `jest.integration.config.js` (via `tests/helpers/integration-boot-env.ts`).
 *
 * THE BUG THIS CLOSES. GitHub withholds Actions secrets from Dependabot-authored runs, so
 * `SUPABASE_URL_TEST` / `SUPABASE_SERVICE_KEY_TEST` render as empty strings [reproduced locally
 * 2026-10-11 by running `npm run test:integration` with those set to ''].
 * Eighteen of the 26 integration suites statically import `src/index` / `src/db` /
 * `src/hal/*`, which load `src/config.ts`, which throws "SUPABASE_URL and SUPABASE_SECRET_KEY …
 * are required" at import. The `describeIfSchema` / `runIntegration()` gates are `describe`-level
 * and cannot help: the file never reaches its first `describe`. So the Integration tests step went
 * red on every Dependabot PR, and `ci.yml`'s "skip gracefully without secrets" was not true.
 *
 * WHAT THIS DOES NOT DO. It does not make any DB-backed suite run: the placeholders are only a
 * boot value (the same idea as the `process.env.SUPABASE_URL = process.env.SUPABASE_URL || …`
 * boot defaults in spine-endpoints / optimize-dashboards, done once instead of per file), and
 * `runIntegration()` returns false while the marker is set. The gates still decide:
 * `integrationSchemaPresent()` comes from globalSetup in the PARENT process, which never sees these
 * placeholders (jest gives each test sandbox its own copy of `process.env`), so with no real
 * credentials it is 'false' and every DB-backed suite takes its `describe.skip` branch.
 * The suites that mock `db` (audit-trail, x402-end-to-end, …) were never DB-backed; they only
 * needed the import to survive, and now run as they do with credentials.
 *
 * REAL CREDENTIALS ARE NEVER TOUCHED. If the URL and a key are both present this returns without
 * writing anything. If only one half is present the pair is treated as absent and BOTH halves are
 * replaced, so a real key is never paired with a placeholder URL (or the reverse).
 *
 * Mutates `env` in place; returns true when placeholders were applied.
 */
export function applyIntegrationBootEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const hasUrl = !!env.SUPABASE_URL;
  const hasKey = CONFIG_KEY_NAMES.some((name) => !!env[name]);
  if (hasUrl && hasKey) return false;

  for (const name of CONFIG_KEY_NAMES) delete env[name];
  env.SUPABASE_URL = 'http://localhost:54321';
  env.SUPABASE_SERVICE_KEY = 'placeholder-not-a-credential';
  env[PLACEHOLDER_CREDS_MARKER] = '1';
  return true;
}

/** True only when integration tests were explicitly opted into AND credentials exist. */
export function runIntegration(): boolean {
  if (process.env.RUN_INTEGRATION !== '1') return false;
  // Placeholder credentials only boot src/config.ts; they are not credentials.
  if (process.env[PLACEHOLDER_CREDS_MARKER] === '1') return false;
  const hasCreds = !!(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY)
  );
  return hasCreds;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[integration] skipped — set RUN_INTEGRATION=1 with real, reachable Supabase ' +
      'credentials to run write-path suites. Presence of SUPABASE_URL alone (e.g. the ' +
      'localhost dummy that boots src/config.ts) does NOT enable them.',
  );
}

/** `describe` when opted in with credentials, else `describe.skip` (with a one-time note). */
export const describeIfIntegration: jest.Describe = ((...args: Parameters<jest.Describe>) => {
  if (runIntegration()) {
    return (describe as unknown as (...a: Parameters<jest.Describe>) => void)(...args);
  }
  warnOnce();
  return (describe.skip as unknown as (...a: Parameters<jest.Describe>) => void)(...args);
}) as jest.Describe;
