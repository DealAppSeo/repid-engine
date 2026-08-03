/**
 * nullifier-identity.ts — bind the nullifier to a per-identity secret, and make the
 * nullifier wide enough to actually be one.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: TWO DEFECTS IN THE PREVIOUS WIRE, BOTH MEASURED
 * ════════════════════════════════════════════════════════════════════════════════
 * `repid-delta-bridge.ts` used to derive the nullifier secret as
 * `H(formula_salt ‖ eventLabel)` reduced mod p, and `repid-delta-statement.ts` emitted
 * the nullifier as `H_p2(secret, scope)` — a SINGLE BabyBear element. Its own comment
 * admitted the first defect. Building the fix surfaced a second, worse one.
 *
 * ── Defect 1: the secret was not an identity secret ──────────────────────────────
 * It was a function of the formula salt and a PUBLIC event id. Anyone holding the salt
 * recomputes every nullifier by enumerating event ids, so the nullifier hid nothing;
 * and the secret keyed a per-EVENT axis, not the per-IDENTITY axis Invariant 2 asks
 * for, so "the same identity, different scopes" — the property the health vertical
 * needs — had no representation at all. It also made ONE secret serve two unrelated
 * jobs (hiding the formula, and hiding the identity), so any rotation or disclosure of
 * the salt destroyed both at once.
 *
 * ── Defect 2 (found while fixing 1, and the more urgent of the two): 31 bits ──────
 * A single BabyBear element is < 2^31. Two consequences, both fatal and both measured
 * in this repo rather than asserted:
 *
 *   COLLISIONS. Sweeping distinct one-element secrets against a fixed scope through
 *   `poseidon2Hash2`, the first collision appears at the 62,852nd secret (colliding
 *   with the 44,437th) — found in 4.2 s on this machine. `repid_score_events` already
 *   holds 152,084 rows [V SQL 2026-08-03], and the nullifier was scoped per score
 *   event, so at existing volume the expected number of colliding pairs is
 *   n²/2p ≈ 5.7. The de-duplication tag would have reported roughly SIX events as
 *   replays of other events that have nothing to do with them. A nullifier that
 *   collides is worse than no nullifier: it manufactures false "already counted"
 *   verdicts on honest events.
 *
 *   BRUTE FORCE. Given a published nullifier and a public scope, an attacker recovers
 *   the secret by trying all 2^31 candidates — then computes that identity's nullifier
 *   under EVERY other scope and links the whole history. Measured cost: this repo's TS
 *   Poseidon2 runs 10,689 hash/s, so the full space is ~56 h single-threaded here, and
 *   a native Poseidon2-BabyBear (2–3 orders faster) puts it in minutes. Unlinkability
 *   against a 31-bit pre-image is not a weak guarantee, it is no guarantee.
 *
 * So widening was not optional polish: no choice of secret SOURCE can rescue a 31-bit
 * nullifier. The fix is a wide secret absorbed directly into a wide sponge, with no
 * single small field element anywhere on the path from secret to published nullifier.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE CONSTRUCTION
 * ════════════════════════════════════════════════════════════════════════════════
 *   secret      := 8 BabyBear elements (~248 bits), never persisted, never logged
 *   commitment  := Sponge(COMMITMENT_TAG ‖ secret)                      → publishable
 *   nullifier   := Sponge(NULLIFIER_TAG ‖ secret ‖ domain ‖ scopeLabel) → publishable
 *
 * `domain` and `scopeLabel` are both length-prefixed strings (`feltsFromString`), so
 * no two (domain, scope) pairs can alias by concatenation. `scope` stays a free
 * PARAMETER: `scopeLabel = 'score_event:1234'` for reputation, `scopeLabel = studyId`
 * for a consent nullifier in the health vertical, with zero code change. Nothing in
 * this file knows what reputation is.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES AND DOES NOT GIVE YOU — read before writing any privacy copy
 * ════════════════════════════════════════════════════════════════════════════════
 * HAS (both sources):
 *   - Replay detection that does not lie. Same (secret, domain, scope) ⇒ same
 *     nullifier; anything else ⇒ a different one, with collisions at 2^-248 rather
 *     than at 63,000 events.
 *   - Cross-scope non-linkage against anyone WITHOUT the secret. Two nullifiers from
 *     one identity in different scopes are not relatable in less than brute-forcing a
 *     ~248-bit pre-image.
 *   - Cross-DOMAIN non-linkage even for the SAME identity id, because the
 *     engine-derived secret absorbs the domain: the reputation secret for `agent-x`
 *     and a future health secret for `agent-x` are independent values.
 *   - A commitment that binds the secret without revealing it, so a future Plonky3
 *     circuit can prove "this nullifier came from the secret behind this registered
 *     commitment" — the Semaphore shape. That is the step from tag to nullifier.
 *
 * DOES NOT HAVE, stated as precisely as I can:
 *   - `source: 'engine-derived'` is FULLY LINKABLE BY WHOEVER HOLDS
 *     `REPID_IDENTITY_MASTER_SECRET`. That is the engine operator (us) and anyone who
 *     reads that Railway variable. The attack is not brute force, it is arithmetic:
 *     derive the secret for each of the ~172 rows in `repid_agents`, compute each
 *     one's nullifier under the scope in question, and read off the match. Agent ids
 *     are public, so the candidate set is small and enumerable. Against the operator
 *     this construction provides de-duplication and NOTHING ELSE.
 *   - `source: 'holder-supplied'` removes the master from the picture — the secret is
 *     derived client-side and the engine stores none of it — but the engine still SEES
 *     it in process memory for the duration of the request. Unlinkable against anyone
 *     reading persisted state; not unlinkable against an operator who logs requests.
 *     JS gives no way to zero a bigint, so "not persisted" is the honest ceiling.
 *   - NOTHING here is proven. There is no circuit. A verifier holding the secret can
 *     recheck the derivation (`nullifierMatchesSecret`); a verifier without it must
 *     take the binding on trust until the circuit lands. Do not describe a nullifier
 *     from this module as a zero-knowledge anything.
 *   - `agent_commitment` in the statement is NOT pseudonymity and never was:
 *     `H(domain ‖ agentId)` over a public agent id is recomputable by anyone, so it
 *     hides the id from a casual reader and from nobody else. The identity commitment
 *     here is different in kind — its pre-image is a secret — but note that both are
 *     stable per agent, so all of one agent's statements link to each other by
 *     construction. Per-statement unlinkability is a different design (fresh
 *     commitments per epoch) and is not what this is.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * IDENTITY MATERIAL IN THE LIVE DATABASE — enumerated, 2026-08-03
 * ════════════════════════════════════════════════════════════════════════════════
 * Invariant 2 points at `human_sbt_mints.commitment_hash`. It exists and is unusable:
 * ONE row, `wallet_address = '0xMOCK_M1_HUMAN_TESTNET'`, `commitment_hash` nine
 * characters long [V SQL 2026-08-03]. `human_agent_bindings` — the table with the
 * right shape (`scope`, `domain`, `nullifier`, `binding_sig`) — has ZERO rows, and its
 * writer `src/services/human-agent-binding.ts` is gated off by
 * `HUMAN_AGENT_BIND_ENABLED`. `identity_binding_ledger` (5 rows) and
 * `nullifier_registry` (3 rows) are one 2026-06-13 drill: agent ids `re`, `sp`,
 * `trinity-agent-mock-001`, nullifiers `n1…`, `ns`. `repid_agents` has no per-agent
 * secret or commitment column at all. Searched: every `public` column whose name
 * matches commitment / nullifier / secret / encrypted / identity_hash, plus every
 * table matching %sbt% / %human% / %identity% / %nullifier% / %commitment%. NOT
 * searched: the `auth` schema, and the isolated `trustchat-prod` project.
 *
 * CONSEQUENCE, stated rather than papered over: there is no populated per-identity
 * secret to bind to today. Note also that a `commitment_hash` is by definition the
 * PUBLIC image of a secret, not the secret — reading Invariant 2 as "use
 * commitment_hash as the secret" would publish every nullifier to anyone with SELECT
 * on the table. So this module takes the secret as an INPUT with two sources, and the
 * `human_sbt_mints` path becomes a third source (`holder-supplied`, fed by the
 * holder's own pre-image) the day real rows exist. Nothing was invented to fill the
 * gap; the gap is the reason `engine-derived` is labelled as operator-linkable.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * INVARIANT COMPLIANCE (ZKP_ARCHITECTURE_INVARIANTS v1)
 * ════════════════════════════════════════════════════════════════════════════════
 * 1. Poseidon2 over BabyBear ONLY, through the parity-gated `poseidon2Sponge`. No
 *    sha256, no keccak, no ethers hashing anywhere in this file. The permutation and
 *    its KATs are untouched.
 * 2. ONE identity, SCOPED nullifiers — one secret per identity per domain, `scope` a
 *    caller-supplied parameter. `studyId` and `eventId` are the same code path.
 * 3. `domain` is an explicit, absorbed field in both the commitment derivation and
 *    the nullifier, so one verifier serves many domains and nothing replays across.
 * 5. No new proving surface; a fixed input/output convention over the pinned
 *    permutation.
 * 6. Domain strings are the circuit-registry namespace keys.
 */

import { poseidon2Sponge, fieldsToHex } from './poseidon2-leaf';
import { BABYBEAR_P } from './poseidon2-babybear';

// ---------------------------------------------------------------------------
// Widths and tags
// ---------------------------------------------------------------------------

/**
 * Field elements in an identity secret. 8 × ~31 bits ≈ 248 bits.
 *
 * 8 because that is the sponge's output width, so a derived secret is exactly one
 * squeeze with no truncation and no re-absorption — the fewest moving parts that gets
 * past the 31-bit ceiling. Do not lower it: at 1 element the whole construction
 * collapses back to the defect described in the header.
 */
export const IDENTITY_SECRET_WIDTH = 8;

/**
 * Domain-separation tags. Distinct so that a commitment can never be mistaken for a
 * nullifier or for a derived secret even if two of them absorb identical inputs.
 */
export const IDENTITY_COMMITMENT_TAG = 'hyperdag/identity/commitment/v1';
export const IDENTITY_NULLIFIER_TAG = 'hyperdag/identity/nullifier/v1';
export const IDENTITY_SECRET_KDF_TAG = 'hyperdag/identity/secret-kdf/v1';

/** Env var holding the engine-side identity master. NOT the formula salt — see below. */
export const IDENTITY_MASTER_ENV = 'REPID_IDENTITY_MASTER_SECRET';

/**
 * Minimum accepted length for the master, in characters.
 *
 * The entire security of `engine-derived` against an outsider rests on this one
 * string, and a short one is brute-forceable in exactly the way the 31-bit secret was.
 * 32 characters is the floor at which a random alphanumeric master carries ~190 bits;
 * a human-chosen 32-character string carries far less, which is why the accompanying
 * runbook line is "generate it, do not compose it".
 */
export const IDENTITY_MASTER_MIN_LENGTH = 32;

/** Where a secret came from. Determines what may honestly be claimed about it. */
export type IdentitySecretSource = 'engine-derived' | 'holder-supplied';

/**
 * A per-identity secret and its public commitment.
 *
 * `felts` is the secret. It must never be persisted, logged, returned from an HTTP
 * handler, or put in an error message. `toJSON` is overridden below to make the
 * accidental version of that mistake impossible rather than merely forbidden.
 */
export interface IdentitySecret {
  readonly felts: readonly bigint[];
  /** `H_sponge(COMMITMENT_TAG ‖ felts)` as `0x`+64 hex. Safe to publish. */
  readonly commitment: string;
  readonly source: IdentitySecretSource;
  /** The domain the secret was derived for, when derivation was domain-scoped. */
  readonly domain: string | null;
}

// ---------------------------------------------------------------------------
// Encoding (same convention as repid-delta-statement / merkle-root)
// ---------------------------------------------------------------------------

/**
 * UTF-8 string → one field element per byte, length absorbed FIRST.
 *
 * Duplicated from `repid-delta-statement.ts` rather than imported, deliberately: that
 * module imports the statement's scoring types, and this one must stay importable by
 * anything (including a future health vertical) without dragging RepID scoring in.
 * The encoding is three lines and pinned identical by a test, which is a cheaper
 * coupling than the import would be.
 */
export function feltsFromString(s: string): bigint[] {
  const bytes = Buffer.from(s, 'utf8');
  return [BigInt(bytes.length), ...Array.from(bytes, (b) => BigInt(b))];
}

/** Hex string → one field element per byte, length absorbed first. Rejects non-hex. */
export function feltsFromHex(hex: string): bigint[] {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error('[nullifier-identity] expected an even-length hex string');
  }
  const bytes = Buffer.from(h, 'hex');
  return [BigInt(bytes.length), ...Array.from(bytes, (b) => BigInt(b))];
}

// ---------------------------------------------------------------------------
// Commitment
// ---------------------------------------------------------------------------

/** `H_sponge(COMMITMENT_TAG ‖ secret)` — the publishable image of a secret. */
export function commitToSecretFelts(felts: readonly bigint[]): string {
  assertSecretShape(felts);
  return fieldsToHex(poseidon2Sponge([...feltsFromString(IDENTITY_COMMITMENT_TAG), ...felts]));
}

function assertSecretShape(felts: readonly bigint[]): void {
  if (felts.length !== IDENTITY_SECRET_WIDTH) {
    throw new Error(
      `[nullifier-identity] an identity secret is ${IDENTITY_SECRET_WIDTH} field elements, ` +
        `got ${felts.length}. A narrower secret reintroduces the 31-bit brute-force this ` +
        `module exists to remove.`,
    );
  }
  for (const f of felts) {
    if (typeof f !== 'bigint' || f < 0n || f >= BABYBEAR_P) {
      throw new Error(`[nullifier-identity] secret element ${f} is not canonical in [0, p)`);
    }
  }
  // All-zero is the degenerate case the old code guarded against for one element; the
  // same reasoning applies to a vector, and a zero vector almost always means a caller
  // passed an uninitialised array rather than a secret.
  if (felts.every((f) => f === 0n)) {
    throw new Error('[nullifier-identity] refusing an all-zero identity secret');
  }
}

/** Wrap raw secret elements, computing the commitment. Never logs the elements. */
function makeSecret(
  felts: readonly bigint[],
  source: IdentitySecretSource,
  domain: string | null,
): IdentitySecret {
  const commitment = commitToSecretFelts(felts);
  const secret: IdentitySecret = {
    felts: Object.freeze([...felts]),
    commitment,
    source,
    domain,
  };
  // Make the accidental leak impossible, not just forbidden: JSON.stringify of this
  // object — the way a secret reaches a log line or an HTTP body in practice — emits
  // the commitment and a redaction marker, never the elements.
  Object.defineProperty(secret, 'toJSON', {
    value: () => ({ commitment, source, domain, felts: '[REDACTED]' }),
    enumerable: false,
  });
  return Object.freeze(secret);
}

// ---------------------------------------------------------------------------
// Source 1 — engine-derived (available today)
// ---------------------------------------------------------------------------

export function identityMaster(): string | null {
  const v = (process.env[IDENTITY_MASTER_ENV] ?? '').trim();
  return v.length > 0 ? v : null;
}

/**
 * Derive a per-identity, per-domain secret from the engine master.
 *
 * `secret := Sponge(KDF_TAG ‖ domain ‖ identityId ‖ master)`, squeezing all 8 lanes.
 *
 * FAILS CLOSED, three ways, because every one of them has a silent-degradation
 * failure mode that would look like it worked:
 *   - no master            → throw. Falling back to a public-input-only secret is
 *                            exactly the defect being removed.
 *   - master too short     → throw. See IDENTITY_MASTER_MIN_LENGTH.
 *   - master === formula salt → throw. Key separation is enforced here rather than
 *                            described in a comment, because the previous wire's
 *                            whole problem was one secret doing two jobs. If the two
 *                            are the same string, disclosing the salt to a formula
 *                            auditor also hands them every nullifier.
 */
export function deriveIdentitySecret(params: {
  identityId: string;
  domain: string;
  master?: string | null;
  /** The formula salt, passed in so this module never imports the scoring statement. */
  formulaSaltForSeparationCheck?: string | null;
}): IdentitySecret {
  const master = params.master ?? identityMaster();
  if (!master) {
    throw new Error(
      `[nullifier-identity] ${IDENTITY_MASTER_ENV} is not set. Refusing to derive an ` +
        `identity secret from public inputs alone — that is the linkable construction ` +
        `this module replaces.`,
    );
  }
  if (master.length < IDENTITY_MASTER_MIN_LENGTH) {
    throw new Error(
      `[nullifier-identity] ${IDENTITY_MASTER_ENV} is ${master.length} characters; ` +
        `at least ${IDENTITY_MASTER_MIN_LENGTH} are required. A short master is ` +
        `brute-forceable and would make every nullifier linkable by an outsider.`,
    );
  }
  const salt = params.formulaSaltForSeparationCheck;
  if (salt && salt === master) {
    throw new Error(
      `[nullifier-identity] ${IDENTITY_MASTER_ENV} equals the formula commitment salt. ` +
        `One secret must not serve two purposes: anyone given the salt to audit formula ` +
        `commitments would also be able to recompute every nullifier.`,
    );
  }
  const felts = poseidon2Sponge([
    ...feltsFromString(IDENTITY_SECRET_KDF_TAG),
    ...feltsFromString(params.domain),
    ...feltsFromString(params.identityId),
    ...feltsFromString(master),
  ]);
  return makeSecret(felts, 'engine-derived', params.domain);
}

// ---------------------------------------------------------------------------
// Source 2 — holder-supplied (the real thing, when a holder exists)
// ---------------------------------------------------------------------------

/**
 * Minimum holder seed, in bytes. A 32-byte seed is a full-strength pre-image; a
 * shorter one is a password, and this module will not pretend otherwise.
 */
export const HOLDER_SEED_MIN_BYTES = 32;

/**
 * Build a secret from material only the holder can produce — e.g. the holder's own
 * signature over `bindingMessage(...)` from `src/services/human-agent-binding.ts`,
 * hashed CLIENT-SIDE, or the pre-image behind a `human_sbt_mints.commitment_hash`.
 *
 * The engine never stores this. The `domain` is still absorbed, so one holder seed
 * yields independent secrets per vertical without the holder managing several.
 *
 * ⚠ A signature is only secret while it stays with its holder. If a caller sends a raw
 * signature and something logs the request body, the secret is gone. The right shape
 * is: holder derives 32+ bytes locally, sends THAT, and nothing persists it. That is a
 * property of the transport, which this function cannot enforce and therefore does not
 * claim.
 */
export function identitySecretFromHolderSeed(params: {
  seedHex: string;
  domain: string;
}): IdentitySecret {
  const seedFelts = feltsFromHex(params.seedHex);
  // seedFelts[0] is the length prefix, so subtract it to count bytes.
  const bytes = seedFelts.length - 1;
  if (bytes < HOLDER_SEED_MIN_BYTES) {
    throw new Error(
      `[nullifier-identity] holder seed is ${bytes} bytes; at least ` +
        `${HOLDER_SEED_MIN_BYTES} are required for the nullifier to be unlinkable.`,
    );
  }
  const felts = poseidon2Sponge([
    ...feltsFromString(IDENTITY_SECRET_KDF_TAG),
    ...feltsFromString(params.domain),
    ...seedFelts,
  ]);
  return makeSecret(felts, 'holder-supplied', params.domain);
}

/** Wrap 8 pre-derived canonical elements. For tests and for a caller that has its own KDF. */
export function identitySecretFromFelts(params: {
  felts: readonly bigint[];
  source?: IdentitySecretSource;
  domain?: string | null;
}): IdentitySecret {
  return makeSecret(params.felts, params.source ?? 'holder-supplied', params.domain ?? null);
}

// ---------------------------------------------------------------------------
// The scoped nullifier (Invariant 2)
// ---------------------------------------------------------------------------

/**
 * `nullifier := Sponge(NULLIFIER_TAG ‖ secret ‖ domain ‖ scopeLabel)` → `0x`+64 hex.
 *
 * The secret is absorbed WHOLE. There is deliberately no intermediate one-element
 * "secret digest" and no one-element output: either would put a 31-bit value on the
 * path from secret to published nullifier and hand back both defects in the header.
 *
 * `scopeLabel` is opaque. Reputation passes a score-event id; a study-consent
 * nullifier passes a study id; neither is privileged by this function.
 */
export function scopedNullifier(params: {
  secret: IdentitySecret;
  domain: string;
  scopeLabel: string;
}): string {
  assertSecretShape(params.secret.felts);
  return fieldsToHex(
    poseidon2Sponge([
      ...feltsFromString(IDENTITY_NULLIFIER_TAG),
      ...params.secret.felts,
      ...feltsFromString(params.domain),
      ...feltsFromString(params.scopeLabel),
    ]),
  );
}

/**
 * Recheck a published nullifier against a secret you hold.
 *
 * This is the HONEST-PROVER check, and its limits are the reason a circuit is still
 * needed: it proves the binding to someone who already has the secret, which is not
 * the party that needs convincing. A verifier holding only the commitment cannot run
 * it. That gap is exactly what `Sponge`-in-circuit closes, and until then no
 * verification claim beyond this one is available.
 */
export function nullifierMatchesSecret(params: {
  secret: IdentitySecret;
  domain: string;
  scopeLabel: string;
  nullifier: string;
}): boolean {
  return (
    scopedNullifier({
      secret: params.secret,
      domain: params.domain,
      scopeLabel: params.scopeLabel,
    }).toLowerCase() === params.nullifier.toLowerCase()
  );
}

/**
 * What may be claimed about a nullifier from this module, given where its secret came
 * from. Returned in shape rather than written in prose so a route or a receipt cannot
 * quietly upgrade the claim.
 */
export interface UnlinkabilityStatement {
  source: IdentitySecretSource;
  /** Parties the nullifier is NOT linkable by. */
  unlinkable_by: string[];
  /** Parties it IS linkable by, and how. Never empty. */
  linkable_by: string[];
  /** Always false today: there is no circuit. */
  proven: false;
}

export function unlinkabilityOf(secret: IdentitySecret): UnlinkabilityStatement {
  const common = [
    'anyone reading the published statement (nullifier pre-image is ~248 bits)',
    'anyone with SELECT on the database (the secret is never persisted)',
  ];
  return secret.source === 'engine-derived'
    ? {
        source: 'engine-derived',
        unlinkable_by: common,
        linkable_by: [
          `anyone holding ${IDENTITY_MASTER_ENV} — they re-derive each agent's secret ` +
            `from the public agent id and match nullifiers directly; the agent set is ` +
            `small and enumerable, so this is arithmetic, not search`,
        ],
        proven: false,
      }
    : {
        source: 'holder-supplied',
        unlinkable_by: [...common, `anyone holding ${IDENTITY_MASTER_ENV} (it is not used)`],
        linkable_by: [
          'the holder themselves',
          'an operator who logs or retains the request that carried the seed — not ' +
            'persisted is not the same as never seen, and JS cannot zero a bigint',
        ],
        proven: false,
      };
}
