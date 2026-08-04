/**
 * tests/zkp2-holder-bridge-wire.test.ts
 *
 * The holder path ON THE LIVE WIRE.
 *
 * `holder-identity-binding.ts` can hold every guard in the world and still be worth
 * nothing if `repid-delta-bridge.ts` — the only module the scoring pipeline calls —
 * derives its holder secret by some other route. That is precisely what it did: it
 * called `identitySecretFromHolderSeed` directly, bypassing the binding-signature
 * check. This file pins the wire, not the library.
 *
 * Everything runs in `shadow`, which PERSISTS NOTHING, so nothing here can touch a
 * live table.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { recordDeltaStatement } from '../src/zkp/repid-delta-bridge';
import { FORMULA_SALT_ENV, REPID_DELTA_DOMAIN } from '../src/zkp/repid-delta-statement';
import { IDENTITY_MASTER_ENV, nullifierMatchesSecret } from '../src/zkp/nullifier-identity';
import {
  deriveHolderSeed,
  holderSecretFromSeed,
} from '../src/zkp/holder-identity-binding';

const SALT = 'zkp2-wire-formula-salt-not-production';
const MASTER = 'zkp2-wire-identity-master-not-production-32+';
const BINDING_SIG = '0x' + '7c'.repeat(65);

const input = () => ({
  agentId: 'agent-shofet',
  eventLabel: 'score_event:4242',
  deltaApplied: 2,
  scoreBefore: 1611,
  scoreAfter: 1613,
  halScore: 0.75,
  halDecision: 'clean' as const,
  agentTier: 'ESTABLISHED',
  vestingCliffActive: false,
});

const ENV_KEYS = ['REPID_DELTA_STATEMENT_MODE', FORMULA_SALT_ENV, IDENTITY_MASTER_ENV] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.REPID_DELTA_STATEMENT_MODE = 'shadow';
  process.env[FORMULA_SALT_ENV] = SALT;
  process.env[IDENTITY_MASTER_ENV] = MASTER;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('the binding-signature guard runs on the live bridge, not only in the library', () => {
  it('a seed derived from binding_sig is REFUSED by the bridge and nothing is built', async () => {
    const badSeed = deriveHolderSeed({ signatureHex: BINDING_SIG, domain: REPID_DELTA_DOMAIN });
    const r = await recordDeltaStatement({
      ...input(),
      identitySeedHex: badSeed,
      identityBindingSig: BINDING_SIG,
    });
    // Refused as a configuration error, loudly, and inert — the same contract as a
    // too-short master. A statement built on that seed would look completely normal
    // and be recomputable by anyone with SELECT on human_agent_bindings.
    expect(r.statement).toBeNull();
    expect(r.skipped).toBe('identity-secret-rejected');
    expect(r.persisted).toBe(false);
  });

  it('an independently-derived seed passes with the same binding_sig present', async () => {
    const good = deriveHolderSeed({ signatureHex: '0x' + 'a3'.repeat(65), domain: REPID_DELTA_DOMAIN });
    const r = await recordDeltaStatement({
      ...input(),
      identitySeedHex: good,
      identityBindingSig: BINDING_SIG,
    });
    expect(r.skipped).toBeNull();
    expect(r.statement).not.toBeNull();
    expect(r.unlinkability!.source).toBe('holder-supplied');
    expect(r.persisted).toBe(false); // shadow
  });

  it('omitting binding_sig means the check cannot run — not that it silently passes', async () => {
    // The bad seed is only *identifiable* as bad when the signature is supplied. With
    // no signature there is nothing to compare against, and the bridge proceeds. That
    // is a real limit of the guard and is asserted here so nobody reads it as complete.
    const badSeed = deriveHolderSeed({ signatureHex: BINDING_SIG, domain: REPID_DELTA_DOMAIN });
    const r = await recordDeltaStatement({ ...input(), identitySeedHex: badSeed });
    expect(r.statement).not.toBeNull();
    expect(r.skipped).toBeNull();
  });

  it('the wire produces the same nullifier the library would — one derivation, not two', async () => {
    const seed = deriveHolderSeed({ signatureHex: '0x' + 'a3'.repeat(65), domain: REPID_DELTA_DOMAIN });
    const r = await recordDeltaStatement({ ...input(), identitySeedHex: seed });
    const secret = holderSecretFromSeed({ seedHex: seed, domain: REPID_DELTA_DOMAIN });
    expect(r.statement!.identity_commitment).toBe(secret.commitment);
    expect(
      nullifierMatchesSecret({
        secret,
        domain: REPID_DELTA_DOMAIN,
        scopeLabel: input().eventLabel,
        nullifier: r.statement!.nullifier,
      }),
    ).toBe(true);
  });

  it('neither the seed nor the binding signature reaches the statement', async () => {
    const seed = deriveHolderSeed({ signatureHex: '0x' + 'a3'.repeat(65), domain: REPID_DELTA_DOMAIN });
    const r = await recordDeltaStatement({
      ...input(),
      identitySeedHex: seed,
      identityBindingSig: BINDING_SIG,
    });
    const blob = JSON.stringify(r.statement);
    expect(blob).not.toContain(seed);
    expect(blob).not.toContain(BINDING_SIG);
    expect(blob).not.toContain('7c7c7c');
    expect(blob).not.toContain(MASTER);
    expect(blob).not.toContain(SALT);
  });
});
