module.exports = {
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
