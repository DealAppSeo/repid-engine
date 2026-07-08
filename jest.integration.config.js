/**
 * Jest config for integration tests.
 *
 * These hit a DISPOSABLE TEST Supabase project (never prod). Runs with
 * --runInBand to avoid cross-test interference on shared db state.
 *
 * globalSetup runs the prod-guard + schema-presence probe ONCE and exports
 * INTEGRATION_SCHEMA_PRESENT; write-path suites gate on it via
 * `describeIfSchema` (tests/helpers/describe-if-schema.ts) so they SKIP
 * (green) when the target is prod / env-unset / an unseeded empty test DB.
 *
 * CC Sprint 8 (2026-05-12) — gates production deploys via
 * `npm run smoke:full`.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 30000,           // per-test ceiling — 30s
  globalSetup: '<rootDir>/tests/helpers/integration-global-setup.ts',
  setupFiles: ['dotenv/config'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleNameMapper: {
    '^@xenova/transformers$': '<rootDir>/tests/__mocks__/xenova-stub.js'
  }
};
