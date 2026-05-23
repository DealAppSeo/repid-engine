/**
 * Jest config for integration tests.
 *
 * These hit live Supabase (read-only mostly; tagged synthetic
 * inserts cleaned up on teardown). Runs with --runInBand to avoid
 * cross-test interference on shared db state. Skipped per-test if
 * SUPABASE env vars are absent (graceful for local-without-env).
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
  setupFiles: ['dotenv/config'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleNameMapper: {
    '^@xenova/transformers$': '<rootDir>/tests/__mocks__/xenova-stub.js'
  }
};
