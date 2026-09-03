module.exports = {
  // Reap jest workers orphaned by a CANCELLED run before starting a new one.
  // `--forceExit` only covers a clean exit; when the jest PARENT is killed (a CI
  // timeout, Ctrl-C, an agent harness cancelling a long command), the worker pool
  // survives on Windows and keeps spinning.
  // Measured 2026-08-03: 101 orphans holding 4,020 CPU-seconds turned a ~90 s suite
  // into a >10 min one, and made every timing measurement on this machine — including
  // several parallel-lane baselines — quietly untrustworthy.
  // Fails open: any error logs and continues. See the script header.
  globalSetup: '<rootDir>/scripts/ci/reap-orphan-jest.js',
  preset: 'ts-jest',
  testEnvironment: 'node',
  // DISCOVERY, NOT A LIST [2026-09-03]. This was
  // `['<rootDir>/tests', '<rootDir>/src/hal/lib/__tests__']` — one directory under src,
  // named by hand — and SIX other `src/**/__tests__` directories holding 52 assertions
  // were therefore never executed by any run, local or CI, for months.
  //
  // What that cost is the argument for the change. Those 52 assertions were not merely
  // idle: 18 of them FAILED when finally run, and two of the files had gone actively
  // wrong in ways a running test would have stopped —
  //   * two asserted the TUNED RepID constants as expected values, which
  //     config/scoring-params.ts exists specifically to keep out of this PUBLIC repo;
  //     that refactor stripped them from src/layers/*.ts and missed the tests here;
  //   * one asserted, as correct, the cost-fabrication behaviour a published retraction
  //     exists to prevent — had it run, it would have BLOCKED the fix;
  //   * two were unit tests making live Supabase calls on a fail-open path, so their
  //     verdict tracked network conditions.
  //
  // A hand-maintained root list fails silently and in the safe-looking direction: a new
  // `src/foo/__tests__` is simply never run and every suite stays green. Rooting at
  // `src` means the next one is picked up with no config change and no one to remember.
  // `testMatch: ['**/*.test.ts']` keeps the scope to test files only; verified there are
  // no `*.test.ts` under src outside a `__tests__` directory.
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '<rootDir>/tests/integration/'
  ],
  moduleNameMapper: {
    '^@xenova/transformers$': '<rootDir>/tests/__mocks__/xenova-stub.js'
  }
};
