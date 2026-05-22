/**
 * Checks if a given agent name complies with canonical naming conventions.
 * A name is canonical if it has a prefix of 'trinity-', 'validator-', 'test-',
 * 'user-', or 'mock-', followed by lowercase alphanumeric characters and hyphens.
 *
 * @param name The agent name to validate.
 * @returns True if the name matches canonical conventions, false otherwise.
 */
export function isCanonicalAgentName(name: string): boolean {
  return getCanonicalCategory(name) !== 'legacy';
}

/**
 * Categorizes an agent name into its canonical category or returns 'legacy'.
 *
 * - Trinity 12: trinity-{name} lowercase (e.g. trinity-sophia)
 * - BFT validators: validator-{name} lowercase (e.g. validator-atlas)
 * - Test agents: test-{purpose}-{timestamp} lowercase
 * - Human users: user-{handle} lowercase
 * - Mock agents: mock-{purpose}-{timestamp} lowercase
 *
 * @param name The agent name to categorize.
 * @returns The canonical category: 'trinity', 'validator', 'test', 'user', 'mock', or 'legacy'.
 */
export function getCanonicalCategory(name: string): 'trinity' | 'validator' | 'test' | 'user' | 'mock' | 'legacy' {
  if (/^trinity-[a-z0-9-]+$/.test(name)) return 'trinity';
  if (/^validator-[a-z0-9-]+$/.test(name)) return 'validator';
  if (/^test-[a-z0-9-]+$/.test(name)) return 'test';
  if (/^user-[a-z0-9-]+$/.test(name)) return 'user';
  if (/^mock-[a-z0-9-]+$/.test(name)) return 'mock';
  return 'legacy';
}
