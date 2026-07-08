/**
 * describeIfSchema — synchronous suite selector for write-path integration tests.
 *
 * Reads `process.env.INTEGRATION_SCHEMA_PRESENT`, set by the integration
 * globalSetup (tests/helpers/integration-global-setup.ts) which runs the async
 * prod-guard + schema-presence probe once before any suite is collected.
 *
 * Usage:
 *   import { describeIfSchema } from '../helpers/describe-if-schema';
 *   describeIfSchema('my write-path suite', () => { ... });
 *
 * When the schema is absent (empty/unseeded test project), PROD is targeted,
 * or Supabase env is unset, this resolves to `describe.skip` so the suite
 * reports SKIPPED (green) with a one-time warning. Seed the test project to
 * make it RUN.
 */

let warned = false;

/** True when globalSetup confirmed the write-path schema is present + non-prod. */
export function integrationSchemaPresent(): boolean {
  return process.env.INTEGRATION_SCHEMA_PRESENT === 'true';
}

export const describeIfSchema: jest.Describe = ((...args: Parameters<jest.Describe>) => {
  if (integrationSchemaPresent()) {
    return (describe as unknown as (...a: Parameters<jest.Describe>) => void)(...args);
  }
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[integration] test Supabase not seeded with schema — skipping write-path ' +
        'integration; seed the test project to enable.'
    );
  }
  return (describe.skip as unknown as (...a: Parameters<jest.Describe>) => void)(...args);
}) as jest.Describe;
