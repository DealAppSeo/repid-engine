/**
 * tests/zkp2-holder-identity-binding.test.ts
 *
 * The holder-supplied nullifier path, end to end.
 *
 * The load-bearing test in this file is `THE GUARD`: it derives a seed the way the
 * obvious implementation would — from the binding signature the engine already
 * collects — and asserts the module REFUSES it. `human_agent_bindings.binding_sig` is
 * a persisted column [V information_schema 2026-08-04], so that seed has a pre-image
 * readable by anyone with SELECT. A privacy path whose worst failure mode is only
 * described in a comment is a privacy path nobody checked.
 *
 * The row-shape tests are pinned to the LIVE table, queried the same day, not to
 * `src/types/database.types.ts` — which is a known-stale surface.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BINDING_DOMAIN_IDENTITY,
  BINDING_SCOPE_OWNERSHIP,
  HUMAN_AGENT_BINDING_COLUMNS,
  assertSeedIndependentOfBindingSignature,
  bindingRowFor,
  deriveHolderSeed,
  holderIdentityFromPublished,
  holderIdentityFromSeed,
  holderSeedMessage,
  holderUnlinkability,
  rowMatchesSecret,
} from '../src/zkp/holder-identity-binding';
import { identitySecretFromHolderSeed, IDENTITY_MASTER_ENV } from '../src/zkp/nullifier-identity';
import { REPID_DELTA_DOMAIN } from '../src/zkp/repid-delta-statement';

const HEX32 = /^0x[0-9a-f]{64}$/;

/** A 65-byte value shaped like an ECDSA signature. Not a real one — nothing verifies it here. */
const sig = (fill: string) => '0x' + fill.repeat(65);
const SEED_SIG = sig('a3');
const BINDING_SIG = sig('7c');

const AGENT_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const SCOPE = 'score_event:1234';

function seedFor(domain = REPID_DELTA_DOMAIN): string {
  return deriveHolderSeed({ signatureHex: SEED_SIG, domain });
}

// ---------------------------------------------------------------------------
// The message the holder signs
// ---------------------------------------------------------------------------

describe('holderSeedMessage — a different message from the binding message', () => {
  const msg = holderSeedMessage({
    wallet: '0xAbC0000000000000000000000000000000000001',
    agentId: AGENT_UUID,
    domain: REPID_DELTA_DOMAIN,
  });

  it('tells the human, in the text a wallet renders, never to transmit it', () => {
    expect(msg).toMatch(/DO NOT SEND THIS SIGNATURE TO ANY SERVER/);
  });

  it('is not the ownership binding message — that signature IS persisted', () => {
    // The binding message says "bind agent to human" and its signature lands in
    // human_agent_bindings.binding_sig. These must never be the same text, or one
    // wallet prompt would produce both values.
    expect(msg).not.toMatch(/bind agent to human/);
    expect(msg).toMatch(/derive private nullifier seed/);
  });

  it('binds the agent and the domain, so a seed signature cannot be replayed', () => {
    expect(msg).toContain(AGENT_UUID);
    expect(msg).toContain(REPID_DELTA_DOMAIN);
    const other = holderSeedMessage({
      wallet: '0xAbC0000000000000000000000000000000000001',
      agentId: AGENT_UUID,
      domain: 'hyperdag/health/consent/v1',
    });
    expect(other).not.toBe(msg);
  });

  it('lowercases the wallet so checksummed and lowercase forms do not diverge', () => {
    expect(msg).toContain('0xabc0000000000000000000000000000000000001');
  });
});

// ---------------------------------------------------------------------------
// The seed KDF
// ---------------------------------------------------------------------------

describe('deriveHolderSeed', () => {
  it('is deterministic and 32 bytes', () => {
    const a = seedFor();
    expect(a).toMatch(HEX32);
    expect(seedFor()).toBe(a);
  });

  it('is domain-separated — one signature yields independent seeds per vertical', () => {
    expect(deriveHolderSeed({ signatureHex: SEED_SIG, domain: REPID_DELTA_DOMAIN })).not.toBe(
      deriveHolderSeed({ signatureHex: SEED_SIG, domain: 'hyperdag/health/consent/v1' }),
    );
  });

  it('refuses a signature short enough to brute-force', () => {
    expect(() => deriveHolderSeed({ signatureHex: '0x' + 'ab'.repeat(16), domain: 'd' })).toThrow(
      /at least 32/,
    );
  });

  it('refuses non-hex rather than hashing garbage', () => {
    expect(() => deriveHolderSeed({ signatureHex: 'not-hex', domain: 'd' })).toThrow();
  });

  it('length is absorbed — a 64-byte and a 65-byte signature cannot alias', () => {
    const a = deriveHolderSeed({ signatureHex: '0x' + 'ab'.repeat(64), domain: 'd' });
    const b = deriveHolderSeed({ signatureHex: '0x' + 'ab'.repeat(65), domain: 'd' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// THE GUARD — the way this path gets built wrongly
// ---------------------------------------------------------------------------

describe('THE GUARD: a seed derived from binding_sig is refused', () => {
  it('rejects it, because binding_sig is a PERSISTED column', () => {
    // This is exactly what the low-effort implementation does: reuse the one signature
    // the holder already gave. The resulting seed is recomputable by anyone with SELECT
    // on human_agent_bindings.
    const badSeed = deriveHolderSeed({ signatureHex: BINDING_SIG, domain: REPID_DELTA_DOMAIN });
    expect(() =>
      assertSeedIndependentOfBindingSignature({
        seedHex: badSeed,
        bindingSig: BINDING_SIG,
        domain: REPID_DELTA_DOMAIN,
      }),
    ).toThrow(/PERSISTED/);
  });

  it('the guard is wired into the posture-A entry point, not merely exported', () => {
    const badSeed = deriveHolderSeed({ signatureHex: BINDING_SIG, domain: REPID_DELTA_DOMAIN });
    expect(() =>
      holderIdentityFromSeed({
        seedHex: badSeed,
        domain: REPID_DELTA_DOMAIN,
        scopeLabel: SCOPE,
        bindingSig: BINDING_SIG,
      }),
    ).toThrow(/PERSISTED/);
  });

  it('an independently-derived seed passes with the same binding_sig present', () => {
    expect(() =>
      holderIdentityFromSeed({
        seedHex: seedFor(),
        domain: REPID_DELTA_DOMAIN,
        scopeLabel: SCOPE,
        bindingSig: BINDING_SIG,
      }),
    ).not.toThrow();
  });

  it('is domain-aware: the same seed under a different domain is not the flagged one', () => {
    const badForHealth = deriveHolderSeed({
      signatureHex: BINDING_SIG,
      domain: 'hyperdag/health/consent/v1',
    });
    // Checked against the reputation domain, it does not match that domain's derivation.
    expect(() =>
      assertSeedIndependentOfBindingSignature({
        seedHex: badForHealth,
        bindingSig: BINDING_SIG,
        domain: REPID_DELTA_DOMAIN,
      }),
    ).not.toThrow();
    // Checked against its own domain, it is caught.
    expect(() =>
      assertSeedIndependentOfBindingSignature({
        seedHex: badForHealth,
        bindingSig: BINDING_SIG,
        domain: 'hyperdag/health/consent/v1',
      }),
    ).toThrow(/PERSISTED/);
  });

  it('no binding_sig, or an unusable one, is not an error', () => {
    expect(() =>
      assertSeedIndependentOfBindingSignature({
        seedHex: seedFor(),
        bindingSig: null,
        domain: REPID_DELTA_DOMAIN,
      }),
    ).not.toThrow();
    expect(() =>
      assertSeedIndependentOfBindingSignature({
        seedHex: seedFor(),
        bindingSig: 'legacy-non-hex-signature',
        domain: REPID_DELTA_DOMAIN,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Posture A — seed-to-engine
// ---------------------------------------------------------------------------

describe('posture A (seed-to-engine)', () => {
  const id = () =>
    holderIdentityFromSeed({ seedHex: seedFor(), domain: REPID_DELTA_DOMAIN, scopeLabel: SCOPE });

  it('publishes a wide commitment and a wide nullifier', () => {
    const h = id();
    expect(h.commitment).toMatch(HEX32);
    expect(h.nullifier).toMatch(HEX32);
    expect(h.commitment).not.toBe(h.nullifier);
    expect(h.secret).not.toBeNull();
  });

  it('same identity, same scope ⇒ same nullifier (replay detection actually works)', () => {
    expect(id().nullifier).toBe(id().nullifier);
  });

  it('same identity, different scope ⇒ unrelated nullifier, same commitment', () => {
    const a = id();
    const b = holderIdentityFromSeed({
      seedHex: seedFor(),
      domain: REPID_DELTA_DOMAIN,
      scopeLabel: 'score_event:9999',
    });
    expect(b.nullifier).not.toBe(a.nullifier);
    expect(b.commitment).toBe(a.commitment);
  });

  it('does not use the engine master — the nullifier is identical with it set or unset', () => {
    const before = process.env[IDENTITY_MASTER_ENV];
    try {
      delete process.env[IDENTITY_MASTER_ENV];
      const without = id().nullifier;
      process.env[IDENTITY_MASTER_ENV] = 'x'.repeat(64);
      expect(id().nullifier).toBe(without);
    } finally {
      if (before === undefined) delete process.env[IDENTITY_MASTER_ENV];
      else process.env[IDENTITY_MASTER_ENV] = before;
    }
  });

  it('the secret redacts itself under JSON.stringify', () => {
    const s = JSON.stringify(id().secret);
    expect(s).toContain('REDACTED');
    expect(s).not.toMatch(/"felts":\[/);
  });
});

// ---------------------------------------------------------------------------
// Posture B — client-computed
// ---------------------------------------------------------------------------

describe('posture B (client-computed)', () => {
  const secret = () => identitySecretFromHolderSeed({ seedHex: seedFor(), domain: REPID_DELTA_DOMAIN });

  it('carries NO secret — the absence is the property', () => {
    const a = holderIdentityFromSeed({
      seedHex: seedFor(),
      domain: REPID_DELTA_DOMAIN,
      scopeLabel: SCOPE,
    });
    const b = holderIdentityFromPublished({
      commitment: a.commitment,
      nullifier: a.nullifier,
      domain: REPID_DELTA_DOMAIN,
      scopeLabel: SCOPE,
    });
    expect(b.secret).toBeNull();
    // The published values are identical to what the engine would have computed — the
    // client and the engine run the same derivation.
    expect(b.commitment).toBe(a.commitment);
    expect(b.nullifier).toBe(a.nullifier);
  });

  it('rejects a narrow nullifier — the 31-bit form collided at live volume', () => {
    expect(() =>
      holderIdentityFromPublished({
        commitment: secret().commitment,
        nullifier: '0xdeadbeef',
        domain: REPID_DELTA_DOMAIN,
        scopeLabel: SCOPE,
      }),
    ).toThrow(/0x\+64 hex/);
  });

  it('rejects commitment === nullifier (one variable wired into both slots)', () => {
    const c = secret().commitment;
    expect(() =>
      holderIdentityFromPublished({
        commitment: c,
        nullifier: c,
        domain: REPID_DELTA_DOMAIN,
        scopeLabel: SCOPE,
      }),
    ).toThrow(/equals nullifier/);
  });
});

// ---------------------------------------------------------------------------
// The honest claim surface
// ---------------------------------------------------------------------------

describe('holderUnlinkability stays honest', () => {
  const a = () =>
    holderUnlinkability(
      holderIdentityFromSeed({ seedHex: seedFor(), domain: REPID_DELTA_DOMAIN, scopeLabel: SCOPE }),
    );
  const b = () => {
    const h = holderIdentityFromSeed({
      seedHex: seedFor(),
      domain: REPID_DELTA_DOMAIN,
      scopeLabel: SCOPE,
    });
    return holderUnlinkability(
      holderIdentityFromPublished({
        commitment: h.commitment,
        nullifier: h.nullifier,
        domain: REPID_DELTA_DOMAIN,
        scopeLabel: SCOPE,
      }),
    );
  };

  it('NOTHING is proven in either posture — no circuit exists', () => {
    expect(a().proven).toBe(false);
    expect(b().proven).toBe(false);
    expect(a().unproven.length).toBeGreaterThan(0);
    expect(b().unproven.length).toBeGreaterThan(0);
  });

  it('posture A still names the request-logging operator as able to link', () => {
    expect(a().linkable_by.join(' ')).toMatch(/logs|retains/i);
    expect(a().linkable_by).not.toHaveLength(0);
  });

  it('posture B removes the operator from linkable_by — and says why it is not free', () => {
    expect(b().linkable_by).toEqual(['the holder themselves']);
    expect(b().unlinkable_by.join(' ')).toMatch(/logs every request/);
    // The trade is stated, not hidden: no secret means no check.
    expect(b().unproven.join(' ')).toMatch(/cannot run nullifierMatchesSecret|unrelated values/);
  });

  it('neither posture claims the holder is a distinct human', () => {
    for (const u of [a(), b()]) {
      expect(u.unproven.join(' ')).toMatch(/distinct human/);
    }
  });
});

// ---------------------------------------------------------------------------
// The row — fits the LIVE table
// ---------------------------------------------------------------------------

describe('bindingRowFor fits human_agent_bindings [V information_schema 2026-08-04]', () => {
  const identity = () =>
    holderIdentityFromSeed({
      seedHex: seedFor(BINDING_DOMAIN_IDENTITY),
      domain: BINDING_DOMAIN_IDENTITY,
      scopeLabel: BINDING_SCOPE_OWNERSHIP,
    });

  const ok = () =>
    bindingRowFor({
      identity: identity(),
      agentId: AGENT_UUID,
      ownerKind: 'builder',
      builderId: '11111111-2222-3333-4444-555555555555',
      humanWallet: '0xabc0000000000000000000000000000000000001',
      bindingSig: BINDING_SIG,
    });

  it('emits only real columns of the live table', () => {
    for (const k of Object.keys(ok().row)) {
      expect(HUMAN_AGENT_BINDING_COLUMNS).toContain(k as never);
    }
  });

  it('omits the server-defaulted columns rather than overriding them', () => {
    const row = ok().row as Record<string, unknown>;
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('bound_at');
  });

  it('carries the ABSORBED domain and scope, not the column defaults', () => {
    const health = holderIdentityFromSeed({
      seedHex: seedFor('hyperdag/health/consent/v1'),
      domain: 'hyperdag/health/consent/v1',
      scopeLabel: 'study-42',
    });
    const r = bindingRowFor({
      identity: health,
      agentId: AGENT_UUID,
      ownerKind: 'builder',
      builderId: '11111111-2222-3333-4444-555555555555',
    });
    // A row whose domain/scope columns disagree with what the nullifier absorbed is
    // unverifiable by anyone, forever, and looks entirely normal.
    expect(r.row.domain).toBe('hyperdag/health/consent/v1');
    expect(r.row.scope).toBe('study-42');
    expect(r.row.domain).not.toBe(BINDING_DOMAIN_IDENTITY);
  });

  it('enforces CHECK num_nonnulls(human_token_id, builder_id) = 1', () => {
    const base = { identity: identity(), agentId: AGENT_UUID, ownerKind: 'builder' as const };
    expect(() => bindingRowFor(base)).toThrow(/exactly one owner/);
    expect(() =>
      bindingRowFor({
        ...base,
        builderId: '11111111-2222-3333-4444-555555555555',
        humanTokenId: 'token-1',
      }),
    ).toThrow(/exactly one owner/);
  });

  it('refuses a row whose owner_kind overstates the assurance it carries', () => {
    expect(() =>
      bindingRowFor({
        identity: identity(),
        agentId: AGENT_UUID,
        ownerKind: 'human_sbt',
        builderId: '11111111-2222-3333-4444-555555555555',
      }),
    ).toThrow(/proof-of-human assurance/);
  });

  it('refuses a non-uuid agent_id — the column is uuid, FK to repid_agents(id)', () => {
    expect(() =>
      bindingRowFor({
        identity: identity(),
        agentId: 'trinity-shofet',
        ownerKind: 'builder',
        builderId: '11111111-2222-3333-4444-555555555555',
      }),
    ).toThrow(/uuid/);
  });

  it('returns the identity commitment separately — the table has no column for it', () => {
    const r = ok();
    expect(r.identity_commitment).toMatch(HEX32);
    expect(HUMAN_AGENT_BINDING_COLUMNS).not.toContain('identity_commitment' as never);
  });

  it('rowMatchesSecret rechecks a stored row against a held secret', () => {
    const r = ok();
    const s = identitySecretFromHolderSeed({
      seedHex: seedFor(BINDING_DOMAIN_IDENTITY),
      domain: BINDING_DOMAIN_IDENTITY,
    });
    expect(rowMatchesSecret(r.row, s)).toBe(true);
    // A tampered scope breaks it — which is the point of absorbing the scope.
    expect(rowMatchesSecret({ ...r.row, scope: 'other' }, s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('ZKP invariants', () => {
  const SRC = join(__dirname, '..', 'src', 'zkp', 'holder-identity-binding.ts');
  const code = () =>
    readFileSync(SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('Invariant 1 — Poseidon2/BabyBear only; no sha256, keccak, or ethers hashing', () => {
    expect(code()).not.toMatch(/sha256|keccak|createHash|ethers|md5|sha1|sha3/i);
    expect(code()).toMatch(/poseidon2Sponge/);
  });

  it('writes nothing — no db import, no chain import', () => {
    expect(code()).not.toMatch(
      /from '\.\.\/db'|supabase|attestProof|JsonRpcProvider|new Wallet|sendTransaction|\.insert\(|\.upsert\(/,
    );
  });

  it('Invariant 2 — a studyId under a health domain works on the same code path', () => {
    const h = holderIdentityFromSeed({
      seedHex: seedFor('hyperdag/health/consent/v1'),
      domain: 'hyperdag/health/consent/v1',
      scopeLabel: 'study-42',
    });
    expect(h.nullifier).toMatch(HEX32);
    const other = holderIdentityFromSeed({
      seedHex: seedFor('hyperdag/health/consent/v1'),
      domain: 'hyperdag/health/consent/v1',
      scopeLabel: 'study-43',
    });
    expect(other.nullifier).not.toBe(h.nullifier);
    expect(other.commitment).toBe(h.commitment);
  });

  it('Invariant 3 — the same seed under two domains gives independent identities', () => {
    const rep = holderIdentityFromSeed({
      seedHex: seedFor(),
      domain: REPID_DELTA_DOMAIN,
      scopeLabel: SCOPE,
    });
    // Same signature, health domain: the seed itself already differs, and so does the
    // commitment — cross-vertical correlation is prevented at the secret, not only at
    // the nullifier.
    const health = holderIdentityFromSeed({
      seedHex: seedFor('hyperdag/health/consent/v1'),
      domain: 'hyperdag/health/consent/v1',
      scopeLabel: SCOPE,
    });
    expect(health.commitment).not.toBe(rep.commitment);
    expect(health.nullifier).not.toBe(rep.nullifier);
  });

  it('nothing in the module knows what reputation is', () => {
    expect(code()).not.toMatch(/computeDelta|hal_score|agent_tier|scoring\//);
  });

  it('does not build the health vertical — no PHI, no study model, no second data plane', () => {
    expect(code()).not.toMatch(/PHI|patient|diagnos|trustchat|HIPAA/i);
  });
});
