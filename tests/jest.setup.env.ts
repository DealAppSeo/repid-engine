/**
 * CI-parity test bootstrap — runs via jest `setupFiles` BEFORE any test module is imported.
 *
 * WHY: `src/config.ts` throws "SUPABASE_URL and SUPABASE_SERVICE_KEY are required" at import
 * time. Any test that (transitively) imports config/db therefore fails to even LOAD without
 * credentials. On a fresh clone / in CI there is no `.env`, so ~61 suites fail to load — an
 * ENV/CONFIG failure, not a logic failure.
 *
 * FIX: provide DUMMY Supabase creds as a fallback so config.ts loads and pure-logic tests run.
 * These point at a non-routable host — no test that actually needs a live DB will silently pass
 * against prod; those tests assert on shapes/mocks or are integration-gated (tests/integration/**
 * is ignored by jest.config.js).
 *
 * DO NOT set provider API keys here (GROQ/GEMINI/DEEPSEEK/…). The golden-math tripwire in
 * tests/hal/golden-math.test.ts is gated on `HAS_KEYS` and MUST stay skipped in keyless CI —
 * GA's keyed CI runs it for real. Setting keys here would weaken that contract.
 *
 * `|| =` semantics: a real .env (loaded by dotenv in config.ts) or real CI secrets always win;
 * we only fill the gap when a value is absent.
 */
// Detect whether REAL Supabase creds were already supplied (real .env or CI secrets).
// If not, we inject dummies AND raise a sentinel so live-DB integration tests can
// distinguish "dummy creds — skip" from "real creds — run". Without this sentinel,
// setting dummy SUPABASE_URL would flip those tests' `HAS_DB` guard on and make them
// hang against a non-routable host. The sentinel keeps them skipped in keyless CI while
// letting them run for real whenever a genuine DB is present.
const HAD_REAL_SUPABASE = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
if (!HAD_REAL_SUPABASE) {
  process.env.REPID_TEST_DUMMY_DB = '1';
}

// Dummy URL points at a non-routable loopback port so any test that slips past its
// skip-guard and issues a DB call fails FAST (connection refused) instead of hanging on
// DNS for a fake *.supabase.co host — that DNS delay was the source of CI flakiness.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || 'dummy-service-key-not-a-real-credential';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// Deterministic, provider-free defaults for the HAL pipeline so keyless unit CI is stable.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
