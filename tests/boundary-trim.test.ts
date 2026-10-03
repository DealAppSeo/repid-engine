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

  it('the shared reader takes an env and trims it', () => {
    const { onlyAttestationsLeave } = require('../src/selfhost/egress-guard') as typeof import('../src/selfhost/egress-guard');
    expect(onlyAttestationsLeave({ ONLY_ATTESTATIONS_LEAVE: 'TRUE ' })).toBe(true);
    expect(onlyAttestationsLeave({ ONLY_ATTESTATIONS_LEAVE: 'false' })).toBe(false);
    expect(onlyAttestationsLeave({})).toBe(false);
  });

  it('no file in src/ but egress-guard reads the flag itself (any spelling)', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const root = path.join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = path.join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|js|mjs|cjs)$/.test(n)) files.push(f);
      }
    };
    walk(root);
    // A read is env.X, env?.X, env['X'] / env["X"], or destructuring { X } = process.env. The
    // name inside a string or comment is fine. A computed key ('ONLY_' + 'X') is deliberate
    // evasion no static check can catch, so it is out of scope.
    const READ = /env\??\.ONLY_ATTESTATIONS_LEAVE|\[\s*['"`]ONLY_ATTESTATIONS_LEAVE['"`]\s*\]|\{[^}]*\bONLY_ATTESTATIONS_LEAVE\b[^}]*\}\s*=\s*(?:process\.)?env\b/;
    const readers = files.filter((f) => READ.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    // Positive control: the walk found the tree, and the one allowed reader matches. A test
    // that searched nothing must not pass.
    expect(files.length).toBeGreaterThan(100);
    expect(readers).toContain('selfhost/egress-guard.ts');
    expect(readers).toEqual(['selfhost/egress-guard.ts']);
  });
});
