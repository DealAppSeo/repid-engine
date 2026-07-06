module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src/hal/lib/__tests__'],
  // Runs before any test module is imported — injects dummy Supabase creds so config.ts
  // does not throw at import time in keyless CI. Does NOT set provider keys (keeps the
  // live golden-math tripwire skipped). See tests/jest.setup.env.ts.
  setupFiles: ['<rootDir>/tests/jest.setup.env.ts'],
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
