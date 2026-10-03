/**
 * ONLY_ATTESTATIONS_LEAVE must read as ON when the value carries a stray space or capitals.
 * 'TRUE ' is what a copy-paste into a dashboard produces, and it used to read as OFF — the
 * boundary failing open in the safe-looking direction (CC2 re-check of #1171).
 */
import { assertPromptEgressAllowed, EgressBoundaryError } from '../src/selfhost/egress-guard';

const CLOUD = 'https://api.groq.com/openai/v1/chat/completions';

describe('ONLY_ATTESTATIONS_LEAVE is trimmed before it is compared', () => {
  const orig = process.env.ONLY_ATTESTATIONS_LEAVE;
  afterEach(() => {
    if (orig === undefined) delete process.env.ONLY_ATTESTATIONS_LEAVE; else process.env.ONLY_ATTESTATIONS_LEAVE = orig;
  });

  it.each(['TRUE ', ' true', 'true\n', ' True\t'])('egress-guard: %j engages the boundary', (v) => {
    process.env.ONLY_ATTESTATIONS_LEAVE = v;
    expect(() => assertPromptEgressAllowed(CLOUD, 'prompt')).toThrow(EgressBoundaryError);
  });

  it.each(['false', '', 'yes', 'tru e'])('egress-guard: %j does not engage it', (v) => {
    process.env.ONLY_ATTESTATIONS_LEAVE = v;
    expect(() => assertPromptEgressAllowed(CLOUD, 'prompt')).not.toThrow();
  });

  it('config.ts reads a padded value as on', () => {
    process.env.ONLY_ATTESTATIONS_LEAVE = 'TRUE ';
    jest.isolateModules(() => {
      process.env.SUPABASE_URL ||= 'http://localhost:54321';
      process.env.SUPABASE_SERVICE_KEY ||= 'dummy';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      expect(require('../src/config').ONLY_ATTESTATIONS_LEAVE).toBe(true);
    });
  });

  it('every reader of the flag trims (no fourth copy left on the old comparison)', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const hits = execSync("git grep -n \"ONLY_ATTESTATIONS_LEAVE || '').toLowerCase()\" -- src || true", { encoding: 'utf8' }).trim();
    expect(hits).toBe('');
  });
});
