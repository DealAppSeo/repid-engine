/**
 * Shared prod-safety guard for integration tests that talk to a live Supabase.
 *
 * WHY THIS EXISTS: `tests/integration/bridge-integration.test.ts` was run against
 * the PRODUCTION Supabase project (qnnpjhlxljtqyigedwkb) with a MOCK on-chain
 * reputation writer. It stamped real `repid_events` rows `processed_at` with a
 * fake tx hash, so the live FeedbackLoopWorker skipped them and those settlements
 * were never written on-chain. A test burned the real queue.
 *
 * Any integration test that WRITES to (or mutates) a Supabase project must refuse
 * to run when that project is production. Derive the project ref from the URL and
 * compare — never hardcode a secret.
 */

// Canonical HyperDAG production Supabase project ref (public identifier, not a
// secret — it appears in the project URL). Trinity prod = AITrinitySymphony.
export const PRODUCTION_SUPABASE_REF = 'qnnpjhlxljtqyigedwkb';

/**
 * Extract the Supabase project ref from a project URL.
 * `https://<ref>.supabase.co` -> `<ref>`. Returns '' if it can't be parsed.
 */
export function supabaseRefFromUrl(url: string | undefined | null): string {
  if (!url) return '';
  // Match the first label of a *.supabase.co / *.supabase.in host, tolerating
  // an optional protocol and any path/port suffix.
  const m = url.match(/(?:^|\/\/)([a-z0-9]+)\.supabase\.(?:co|in)\b/i);
  return m && m[1] ? m[1].toLowerCase() : '';
}

/** True when the given Supabase URL points at the production project. */
export function isProductionSupabase(url: string | undefined | null): boolean {
  return supabaseRefFromUrl(url) === PRODUCTION_SUPABASE_REF;
}

/**
 * Hard guard: throw if the resolved Supabase URL is the production project.
 * Call this at suite load time (top of the file, or in a beforeAll) for any
 * integration test that inserts/updates/deletes rows.
 */
export function assertNotProductionSupabase(
  url: string | undefined | null = process.env.SUPABASE_URL,
): void {
  if (isProductionSupabase(url)) {
    throw new Error(
      'refusing to run this integration test against production Supabase ' +
        `(${PRODUCTION_SUPABASE_REF}) — use a test project. Point SUPABASE_URL ` +
        'at a disposable Supabase project before running write-path integration tests.',
    );
  }
}
