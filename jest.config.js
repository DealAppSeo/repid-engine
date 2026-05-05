module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src/hal/lib/__tests__'],
  testMatch: ['**/*.test.ts']
};
