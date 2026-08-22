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
 * an unreachable localhost. In CI there are no secrets, so presence is false, it
 * all skips, and CI is green. The result is a guard that is red for the wrong
 * reason locally and silent in CI: it never actually runs, and nobody notices.
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

/** True only when integration tests were explicitly opted into AND credentials exist. */
export function runIntegration(): boolean {
  if (process.env.RUN_INTEGRATION !== '1') return false;
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
