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
  roots: ['<rootDir>/tests', '<rootDir>/src/hal/lib/__tests__'],
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
