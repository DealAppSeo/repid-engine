/**
 * A SECRET WITH A PUBLISHED DEFAULT IS NO SECRET (F-13, 2026-10-07).
 *
 * This repo is public. A secret read from the environment with a string fallback (`|| 'some-string'`)
 * means that whenever the variable is unset, the credential is a string anyone can read here. F-13 found two of them guarding writes: anyone
 * could sign trading-round starts (SEAN_SIG_SECRET) and settle any bet to any outcome
 * (ORACLE_HMAC_SECRET). Both now fail closed.
 *
 * This guard finds every `process.env.<NAME> || '<literal>'` (or `??`) in src/ where a name in the
 * chain looks like a credential, and compares the set with KNOWN below. It fails BOTH ways:
 * - a NEW default secret appears: refuse it; make the code fail closed instead;
 * - a KNOWN one stops matching: it was fixed, so delete its row. KNOWN may only shrink.
 *
 * Every row is a finding waiting for a decision (trustshell BUS F-15), not an approval.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

/** file → the literal it falls back to. Each still needs a fix; none is acceptable. */
const KNOWN: Record<string, { literal: string; why: string }> = {
  'src/middleware/controller-auth.ts': { literal: 'controller-secret-key-1337-abc', why: 'CONTROLLER_QR_SECRET: signs controller QR tokens' },
  'src/services/trading-creds-crypto.ts': { literal: 'reponomics-default-32-byte-encryption-key-please-rotate', why: 'TRADING_CREDS_ENCRYPTION_KEY: encrypts stored trading credentials' },
  'src/zkp/plonky3-real.ts': { literal: 'repid-default-secret', why: 'PROOF_SECRET: the HMAC fallback proof (labelled is_real:false)' },
  // Placeholder service keys: an unset Supabase key falls back to a string that authenticates as
  // nothing. They are not a published credential, but they belong on the same list so a real one
  // cannot hide among them.
  'src/services/hal-tester.ts': { literal: 'dummy-key', why: 'Supabase key placeholder' },
  'src/routes/telegram.ts': { literal: 'dummy-key', why: 'Supabase key placeholder' },
  'src/routes/hal-test.ts': { literal: 'dummy-key', why: 'Supabase key placeholder' },
  'src/routes/stake.ts': { literal: 'dummy-key', why: 'Supabase key placeholder' },
  'src/services/x402-real-settler.ts': { literal: 'key', why: 'Supabase key placeholder' },
};

const CREDENTIAL = /(SECRET|_KEY$|_KEY_|TOKEN|PASSWORD|PRIVATE|ENCRYPTION)/;
const CHAIN = /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*((?:process\.env\.[A-Z0-9_]+\s*(?:\|\||\?\?)\s*)*)['"`]([^'"`\n]+)['"`]/g;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...tsFiles(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

function findDefaults(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of tsFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(CHAIN)) {
      const names = [m[1]!, ...[...(m[2] ?? '').matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((x) => x[1]!)];
      // A public contract address (USDC_TOKEN_ADDRESS) is not a credential.
      if (!names.some((n) => CREDENTIAL.test(n) && !/_ADDRESS$/.test(n))) continue;
      const rel = relative(ROOT, file).split('\\').join('/');
      found.set(rel, [...(found.get(rel) ?? []), m[3]!]);
    }
  }
  return found;
}

describe('no credential falls back to a string published in this repo', () => {
  const found = findDefaults();
  const scanned = tsFiles(SRC).length;

  it('the scan actually ran over the source tree', () => {
    expect(scanned).toBeGreaterThan(200);
  });

  it('no NEW default secret has appeared', () => {
    const fresh = [...found.entries()]
      .filter(([file, literals]) => !KNOWN[file] || literals.some((l) => l !== KNOWN[file]!.literal))
      .map(([file, literals]) => `${file}: ${literals.join(', ')}`);
    expect(fresh).toEqual([]);
  });

  it('every KNOWN row still matches; a fixed one must be deleted from the list', () => {
    const stale = Object.entries(KNOWN)
      .filter(([file, k]) => !(found.get(file) ?? []).includes(k.literal))
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });

  it('the two F-13 secrets are gone from the code entirely', () => {
    const all = tsFiles(SRC).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all).not.toContain('reponomics-default-sean-secret');
    expect(all).not.toContain('reponomics-default-oracle-secret');
  });
});
