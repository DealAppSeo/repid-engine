// Jest config for e2e tests against the live Railway deployment.
// Kept separate from the root jest.config.js so `npm test` never
// accidentally hits production. Invoke via: npm run test:e2e
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '../../',
  testMatch: ['<rootDir>/tests/e2e/**/*.e2e.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 60_000,
};
