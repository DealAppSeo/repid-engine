/**
 * ZKP RepID — the nullifier's identity binding.
 *
 * Two of these tests are unusual and deliberate: they DEMONSTRATE the defects the
 * module fixes, by running the attack, rather than asserting in a comment that the
 * attack exists. A privacy claim backed by prose is a privacy claim nobody checked.
 *
 * Everything else pins the properties the construction is supposed to have — and, just
 * as importantly, pins the shape of what it does NOT claim, so a later change cannot
 * quietly upgrade "bound" into "proven".
 */

import {
  HOLDER_SEED_MIN_BYTES,
  IDENTITY_COMMITMENT_TAG,
  IDENTITY_MASTER_ENV,
  IDENTITY_MASTER_MIN_LENGTH,
  IDENTITY_NULLIFIER_TAG,
  IDENTITY_SECRET_KDF_TAG,
  IDENTITY_SECRET_WIDTH,
  commitToSecretFelts,
  deriveIdentitySecret,
  feltsFromHex,
  feltsFromString,
  identityMaster,
  identitySecretFromFelts,
  identitySecretFromHolderSeed,
  nullifierMatchesSecret,
  scopedNullifier,
  unlinkabilityOf,
} from '../src/zkp/nullifier-identity';
import {
  NARROW_NULLIFIER_BITS,
  REPID_DELTA_DOMAIN,
  deriveNullifier,
  feltsFromString as statementFeltsFromString,
  nullifierScope,
} from '../src/zkp/repid-delta-statement';
import { BABYBEAR_P } from '../src/zkp/poseidon2-babybear';
import { readFileSync } from 'fs';
import { join } from 'path';

const HEALTH_DOMAIN = 'hyperdag/health/consent/v1';

/** 40 chars — over IDENTITY_MASTER_MIN_LENGTH, and obviously not a production value. */
const MASTER = 'test-identity-master-not-the-production-1';

const withMaster = <T>(fn: () => T, value: string = MASTER): T => {
  const prev = process.env[IDENTITY_MASTER_ENV];
  process.env[IDENTITY_MASTER_ENV] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[IDENTITY_MASTER_ENV];
    else process.env[IDENTITY_MASTER_ENV] = prev;
  }
};

const someSecret = (seed = 1n) =>
  identitySecretFromFelts({
    felts: Array.from({ length: IDENTITY_SECRET_WIDTH }, (_, i) => (seed * 7919n + BigInt(i) * 131n) % BABYBEAR_P),
    domain: REPID_DELTA_DOMAIN,
  });

// ---------------------------------------------------------------------------
// The defects, demonstrated rather than asserted
// ---------------------------------------------------------------------------

describe('the OLD narrow nullifier — the attacks, actually run', () => {
  it('DEFECT 1 (brute force): a one-element secret is RECOVERED from a public nullifier', () => {
    // The old construction published `H_p2(secret, scope)` with a single BabyBear
    // secret. `scope` is public (it is derived from the domain and the event id), so an
    // attacker with the nullifier searches the secret space directly — and having the
    // secret, computes that identity's nullifier under every OTHER scope and links the
    // whole history. That is the difference between a de-duplication tag and a
    // nullifier.
    //
    // Searched here over 20,000 candidates so the test stays fast. The real space is
    // 2^31 = 2,147,483,648 — only ~107,000x this search. At the 10,689 hash/s this
    // repo's TS Poseidon2 measures, that is ~56 h on ONE core here; a native
    // Poseidon2-BabyBear is 2-3 orders of magnitude faster, which puts full recovery in
    // minutes. 31 bits is not a weak secret, it is a public one.
    const scope = nullifierScope(REPID_DELTA_DOMAIN, 'score_event:1234');
    const trueSecret = 17_000n;
    const published = deriveNullifier(trueSecret, scope);

    let recovered: bigint | null = null;
    for (let c = 1n; c <= 20_000n; c++) {
      if (deriveNullifier(c, scope) === published) {
        recovered = c;
        break;
      }
    }
    expect(recovered).toBe(trueSecret);
    expect(NARROW_NULLIFIER_BITS).toBe(31);
  }, 60_000);

  it('DEFECT 2 (collisions): two unrelated secrets produce the SAME narrow nullifier', () => {
    // This is the one that bites without any attacker at all. The nullifier's ONE job
    // today is "the same event was recorded twice"; a colliding nullifier reports that
    // about two events that have nothing to do with each other.
    //
    // Birthday bound over p = 2013265921: the expected number of colliding pairs among
    // n nullifiers is n^2/2p. `repid_score_events` held 152,084 rows on 2026-08-03 [V
    // SQL] and the nullifier was scoped per score event, so n^2/2p ~ 5.7 — about six
    // honest events already mislabelled as replays, before a single new one is written.
    const scope = 123456789n;
    const seen = new Map<string, number>();
    let collision: { a: number; b: number } | null = null;
    for (let i = 1; i <= 70_000 && collision === null; i++) {
      const key = deriveNullifier(BigInt(i), scope).toString();
      const prev = seen.get(key);
      if (prev !== undefined) collision = { a: prev, b: i };
      else seen.set(key, i);
    }
    expect(collision).not.toBeNull();
    // Found at the 62,852nd secret on first measurement. Not pinned exactly — the point
    // is that it happens well below live ledger volume, not the precise index.
    expect(collision!.b).toBeLessThan(70_000);
    expect(collision!.a).not.toBe(collision!.b);

    // And the same pair does NOT collide under the wide construction.
    const wideA = scopedNullifier({
      secret: someSecret(BigInt(collision!.a)),
      domain: REPID_DELTA_DOMAIN,
      scopeLabel: 'e',
    });
    const wideB = scopedNullifier({
      secret: someSecret(BigInt(collision!.b)),
      domain: REPID_DELTA_DOMAIN,
      scopeLabel: 'e',
    });
    expect(wideA).not.toBe(wideB);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Width — the thing no choice of secret source could have fixed
// ---------------------------------------------------------------------------

describe('secret and nullifier width', () => {
  it('a nullifier is 248 bits of hex, not 32', () => {
    const n = scopedNullifier({ secret: someSecret(), domain: REPID_DELTA_DOMAIN, scopeLabel: 'x' });
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('REFUSES a one-element secret — the narrow form cannot be reintroduced by a caller', () => {
    expect(() => identitySecretFromFelts({ felts: [12345n] })).toThrow(/8 field elements/);
    expect(() => identitySecretFromFelts({ felts: [] })).toThrow();
  });

  it('refuses an all-zero secret (an uninitialised array, in practice)', () => {
    expect(() => identitySecretFromFelts({ felts: Array(IDENTITY_SECRET_WIDTH).fill(0n) })).toThrow(
      /all-zero/,
    );
  });

  it('refuses non-canonical elements', () => {
    const bad = Array(IDENTITY_SECRET_WIDTH).fill(1n);
    bad[3] = BABYBEAR_P;
    expect(() => identitySecretFromFelts({ felts: bad })).toThrow(/canonical/);
    const neg = Array(IDENTITY_SECRET_WIDTH).fill(1n);
    neg[0] = -1n;
    expect(() => identitySecretFromFelts({ felts: neg })).toThrow(/canonical/);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — one identity, scope as a free parameter
// ---------------------------------------------------------------------------

describe('Invariant 2 — one identity, scoped nullifiers', () => {
  it('the SAME identity gives DIFFERENT nullifiers in different scopes', () => {
    const s = someSecret();
    const a = scopedNullifier({ secret: s, domain: REPID_DELTA_DOMAIN, scopeLabel: 'score_event:1' });
    const b = scopedNullifier({ secret: s, domain: REPID_DELTA_DOMAIN, scopeLabel: 'score_event:2' });
    expect(a).not.toBe(b);
  });

  it('the same identity and scope give the SAME nullifier — that is the replay detection', () => {
    const s = someSecret();
    const args = { secret: s, domain: REPID_DELTA_DOMAIN, scopeLabel: 'score_event:1' };
    expect(scopedNullifier(args)).toBe(scopedNullifier(args));
    expect(nullifierMatchesSecret({ ...args, nullifier: scopedNullifier(args) })).toBe(true);
  });

  it('a wrong secret does not match a published nullifier', () => {
    const args = { domain: REPID_DELTA_DOMAIN, scopeLabel: 'score_event:1' };
    const n = scopedNullifier({ ...args, secret: someSecret(1n) });
    expect(nullifierMatchesSecret({ ...args, secret: someSecret(2n), nullifier: n })).toBe(false);
  });

  it('A studyId WORKS EXACTLY LIKE AN eventId — the health vertical reuses this unchanged', () => {
    // The one property that makes this a shared substrate rather than a reputation
    // feature. No branch, no flag, no second function: swap the domain and the label.
    const s = withMaster(() =>
      deriveIdentitySecret({ identityId: 'subject-77', domain: HEALTH_DOMAIN }),
    );
    const consent = scopedNullifier({ secret: s, domain: HEALTH_DOMAIN, scopeLabel: 'study-42' });
    expect(consent).toMatch(/^0x[0-9a-f]{64}$/);
    // One subject, two studies: unrelatable nullifiers, one identity.
    const other = scopedNullifier({ secret: s, domain: HEALTH_DOMAIN, scopeLabel: 'study-43' });
    expect(other).not.toBe(consent);
  });

  it('nothing in the module knows what reputation is', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'zkp', 'nullifier-identity.ts'), 'utf8');
    // The header discusses RepID because that is where the defect was found; the CODE
    // must not. No scoring import, no delta, no tier — a health-vertical caller must be
    // able to import this without dragging reputation scoring in.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/repid-delta|computeDelta|agent_tier|hal_score|scoring\//);
    expect(code).toMatch(/scopedNullifier/);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — domain is explicit and absorbed
// ---------------------------------------------------------------------------

describe('Invariant 3 — domain-parameterized, absorbed, non-replayable', () => {
  it('the same secret and scope in two domains give different nullifiers', () => {
    const s = someSecret();
    const a = scopedNullifier({ secret: s, domain: REPID_DELTA_DOMAIN, scopeLabel: 'subject-1' });
    const b = scopedNullifier({ secret: s, domain: HEALTH_DOMAIN, scopeLabel: 'subject-1' });
    expect(a).not.toBe(b);
  });

  it('the same identity id in two domains gets INDEPENDENT secrets', () => {
    // Cross-vertical correlation is prevented at the secret, not only at the nullifier:
    // even the identity_commitment for `agent-x` differs between reputation and health.
    withMaster(() => {
      const rep = deriveIdentitySecret({ identityId: 'agent-x', domain: REPID_DELTA_DOMAIN });
      const health = deriveIdentitySecret({ identityId: 'agent-x', domain: HEALTH_DOMAIN });
      expect(rep.commitment).not.toBe(health.commitment);
      expect(rep.felts).not.toEqual(health.felts);
    });
  });

  it('domain and scope cannot alias by concatenation', () => {
    // Length-prefixed absorption: ("ab","c") and ("a","bc") must not collide.
    const s = someSecret();
    const x = scopedNullifier({ secret: s, domain: 'ab', scopeLabel: 'c' });
    const y = scopedNullifier({ secret: s, domain: 'a', scopeLabel: 'bc' });
    expect(x).not.toBe(y);
  });
});

// ---------------------------------------------------------------------------
// Invariant 1 — Poseidon2/BabyBear only
// ---------------------------------------------------------------------------

describe('Invariant 1 — Poseidon2 over BabyBear, and nothing else', () => {
  it('the module contains no sha256, keccak, or ethers hashing', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'zkp', 'nullifier-identity.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/sha256|keccak|createHash|ethers|md5|sha1|sha3/i);
    expect(code).toMatch(/poseidon2Sponge/);
  });

  it('reuses the parity-gated sponge — nullifier limbs are canonical BabyBear', () => {
    const n = scopedNullifier({ secret: someSecret(), domain: REPID_DELTA_DOMAIN, scopeLabel: 'x' });
    const h = n.slice(2);
    for (let i = 0; i < 8; i++) {
      expect(BigInt('0x' + h.slice(i * 8, i * 8 + 8))).toBeLessThan(BABYBEAR_P);
    }
  });

  it('the string encoding is identical to the statement module‘s (pinned duplicate)', () => {
    for (const s of ['', 'a', 'hyperdag/repid/delta/v1', 'study-42']) {
      expect(feltsFromString(s)).toEqual(statementFeltsFromString(s));
    }
  });

  it('the three domain tags are distinct, so a commitment cannot pass as a nullifier', () => {
    const tags = [IDENTITY_COMMITMENT_TAG, IDENTITY_NULLIFIER_TAG, IDENTITY_SECRET_KDF_TAG];
    expect(new Set(tags).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed configuration
// ---------------------------------------------------------------------------

describe('fail-closed — no silent degradation to a weak secret', () => {
  const withoutMaster = <T>(fn: () => T): T => {
    const prev = process.env[IDENTITY_MASTER_ENV];
    delete process.env[IDENTITY_MASTER_ENV];
    try {
      return fn();
    } finally {
      if (prev !== undefined) process.env[IDENTITY_MASTER_ENV] = prev;
    }
  };

  it('THROWS with no master, rather than deriving from public inputs', () => {
    withoutMaster(() => {
      expect(identityMaster()).toBeNull();
      expect(() => deriveIdentitySecret({ identityId: 'a', domain: REPID_DELTA_DOMAIN })).toThrow(
        new RegExp(IDENTITY_MASTER_ENV),
      );
    });
  });

  it('THROWS on a master shorter than the floor — a short master is brute-forceable', () => {
    expect(() =>
      deriveIdentitySecret({ identityId: 'a', domain: REPID_DELTA_DOMAIN, master: 'short' }),
    ).toThrow(/at least 32/);
    expect(IDENTITY_MASTER_MIN_LENGTH).toBe(32);
  });

  it('THE KEY-SEPARATION CHECK: throws if the identity master IS the formula salt', () => {
    // The previous wire's actual defect: one secret doing two jobs. Enforced in code,
    // because a comment saying "keep these different" is not a control.
    expect(() =>
      deriveIdentitySecret({
        identityId: 'a',
        domain: REPID_DELTA_DOMAIN,
        master: MASTER,
        formulaSaltForSeparationCheck: MASTER,
      }),
    ).toThrow(/two purposes/);
    // A different salt is fine.
    expect(() =>
      deriveIdentitySecret({
        identityId: 'a',
        domain: REPID_DELTA_DOMAIN,
        master: MASTER,
        formulaSaltForSeparationCheck: 'a-different-salt',
      }),
    ).not.toThrow();
  });

  it('rejects a holder seed too small to be a pre-image', () => {
    expect(() =>
      identitySecretFromHolderSeed({ seedHex: '0x' + 'ab'.repeat(16), domain: REPID_DELTA_DOMAIN }),
    ).toThrow(/at least 32/);
    expect(() =>
      identitySecretFromHolderSeed({
        seedHex: '0x' + 'ab'.repeat(HOLDER_SEED_MIN_BYTES),
        domain: REPID_DELTA_DOMAIN,
      }),
    ).not.toThrow();
  });

  it('rejects malformed hex rather than hashing garbage', () => {
    for (const bad of ['', '0x', '0xzz', '0xabc']) {
      expect(() =>
        identitySecretFromHolderSeed({ seedHex: bad, domain: REPID_DELTA_DOMAIN }),
      ).toThrow();
    }
    expect(feltsFromHex('0x0102')).toEqual([2n, 1n, 2n]);
  });

  it('a 65-byte ECDSA signature is an acceptable holder seed shape', () => {
    // The realistic client-side source: sign `bindingMessage(...)`, derive locally.
    const sig = '0x' + '7f'.repeat(65);
    const s = identitySecretFromHolderSeed({ seedHex: sig, domain: REPID_DELTA_DOMAIN });
    expect(s.source).toBe('holder-supplied');
    expect(s.commitment).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// The commitment
// ---------------------------------------------------------------------------

describe('identity commitment', () => {
  it('is deterministic and 248 bits wide', () => {
    const s = someSecret();
    expect(s.commitment).toBe(commitToSecretFelts(s.felts));
    expect(s.commitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes when any secret element changes', () => {
    const base = someSecret(1n);
    const felts = [...base.felts];
    felts[5] = (felts[5]! + 1n) % BABYBEAR_P;
    expect(commitToSecretFelts(felts)).not.toBe(base.commitment);
  });

  it('is domain-separated from the nullifier — same inputs, different function', () => {
    const s = someSecret();
    expect(s.commitment).not.toBe(
      scopedNullifier({ secret: s, domain: REPID_DELTA_DOMAIN, scopeLabel: '' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Leak resistance
// ---------------------------------------------------------------------------

describe('the secret cannot be leaked by the ordinary accident', () => {
  it('JSON.stringify emits [REDACTED], never the elements', () => {
    // How a secret reaches a log line in practice: someone stringifies the object it
    // is hanging off. Made impossible rather than merely forbidden.
    const s = someSecret(3n);
    const blob = JSON.stringify({ context: 'a log line', secret: s });
    expect(blob).toContain('[REDACTED]');
    for (const f of s.felts) expect(blob).not.toContain(f.toString());
    // The commitment IS publishable and must survive.
    expect(blob).toContain(s.commitment);
  });

  it('the secret object is frozen, so it cannot be mutated after commitment', () => {
    const s = someSecret();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.felts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The honesty surface — what may be claimed
// ---------------------------------------------------------------------------

describe('unlinkability statement — the claim is data, not prose', () => {
  it('engine-derived NAMES the master holder as able to link', () => {
    const s = withMaster(() => deriveIdentitySecret({ identityId: 'a', domain: REPID_DELTA_DOMAIN }));
    const u = unlinkabilityOf(s);
    expect(u.source).toBe('engine-derived');
    expect(u.linkable_by.join(' ')).toContain(IDENTITY_MASTER_ENV);
    expect(u.unlinkable_by.length).toBeGreaterThan(0);
  });

  it('holder-supplied does NOT list the master, and DOES list the holder and a logging operator', () => {
    const s = identitySecretFromHolderSeed({
      seedHex: '0x' + '11'.repeat(32),
      domain: REPID_DELTA_DOMAIN,
    });
    const u = unlinkabilityOf(s);
    expect(u.source).toBe('holder-supplied');
    expect(u.unlinkable_by.join(' ')).toContain(IDENTITY_MASTER_ENV);
    expect(u.linkable_by.join(' ')).toMatch(/holder/);
    expect(u.linkable_by.join(' ')).toMatch(/logs|retains/);
  });

  it('NEITHER source may ever claim to be proven, and linkable_by is never empty', () => {
    // There is no circuit. `bound` is not `proven`, and this is the test that stops a
    // later refactor from rounding one up to the other.
    for (const s of [
      withMaster(() => deriveIdentitySecret({ identityId: 'a', domain: REPID_DELTA_DOMAIN })),
      identitySecretFromHolderSeed({ seedHex: '0x' + '22'.repeat(32), domain: REPID_DELTA_DOMAIN }),
    ]) {
      const u = unlinkabilityOf(s);
      expect(u.proven).toBe(false);
      expect(u.linkable_by.length).toBeGreaterThan(0);
    }
  });
});
