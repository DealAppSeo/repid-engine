/**
 * repid-delta-statement.ts — the ZKP RepID wire: a canonical, domain-parameterized
 * statement asserting that a RepID delta obeyed the scoring rules, WITHOUT publishing
 * the rules.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS AND IS NOT — read before quoting it anywhere
 * ════════════════════════════════════════════════════════════════════════════════
 * This is the STATEMENT + COMMITMENT layer. It builds the exact public inputs a
 * Plonky3 circuit must prove, and the witness it must be given. It is fully
 * checkable today for an honest prover (`verifyRepidDeltaStatement` recomputes the
 * delta from the witness), and that is a real, useful property — but it is NOT yet a
 * zero-knowledge proof, because there is no circuit and no `proof_bytes`.
 *
 * A statement without a proof is a CLAIM WITH A CANONICAL SHAPE. Rows written from
 * here carry `scheme='poseidon2-statement-v1'` and `is_real=false` precisely so no
 * query, dashboard, or public page can ever mistake one for a proven delta. Do not
 * describe this as "ZK-proven RepID". Describe it as "the statement the RepID circuit
 * will prove", which is what it is.
 *
 * This mirrors how the POSTCARD leaf landed (`leaf-dual-write.ts`): get the canonical
 * digest exact, gated and measured in the engine first; the prover catches up second.
 * The alternative — waiting for a circuit before fixing the statement — is how you end
 * up with a circuit that proves the wrong thing.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE POINT: PROVE RULE-FOLLOWING WITHOUT PUBLISHING THE RULE
 * ════════════════════════════════════════════════════════════════════════════════
 * The RepID scoring formula is a hard stop — it must never appear in public docs. That
 * looks like it forecloses external verification, and it is exactly what ZK is for.
 * The public statement reveals:
 *
 *   - the delta that was applied,
 *   - the published band it had to lie inside,
 *   - a COMMITMENT to the formula that produced it, and
 *   - a scoped nullifier that stops the same event being counted twice.
 *
 * From those four, an outside developer can verify: this delta is inside the published
 * band, and it came from the same formula as every other delta in the epoch. If we
 * quietly changed the formula for one favoured agent, the commitment would differ and
 * anyone could see it. That is a stronger guarantee than publishing the formula, which
 * would only tell you what the rule IS — not that it was FOLLOWED.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE COMMITMENT IS SALTED — a real flaw, handled
 * ════════════════════════════════════════════════════════════════════════════════
 * The formula's parameters are LOW ENTROPY: small integers and a handful of
 * thresholds. An unsalted Poseidon2 commitment over them is trivially brute-forced —
 * an attacker enumerates plausible parameter sets until the digest matches, and the
 * "commitment" has published the formula it was meant to hide.
 *
 * So the commitment is `H(params ‖ salt)` with a secret salt from
 * `REPID_FORMULA_COMMITMENT_SALT`. Consequences, stated plainly:
 *   - With no salt configured, `formulaCommitment()` refuses rather than emitting a
 *     brute-forceable digest. Failing closed beats publishing a secret by accident.
 *   - The salt must be STABLE. Rotating it changes every commitment and makes new
 *     deltas look like they came from a different formula. It belongs with the other
 *     long-lived secrets, not in a deploy script.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * INVARIANT COMPLIANCE (ZKP_ARCHITECTURE_INVARIANTS v1)
 * ════════════════════════════════════════════════════════════════════════════════
 * 1. ONE HASH/FIELD — Poseidon2 over BabyBear only, via `poseidon2-babybear.ts`,
 *    which is parity-gated bit-exact against Plonky3's own
 *    `default_babybear_poseidon2_16()`. No sha256, no keccak, anywhere in this file.
 * 2. SCOPED NULLIFIERS — `nullifier = Sponge(tag ‖ identity_secret ‖ domain ‖ scope)`
 *    from `nullifier-identity.ts`, where the secret is PER-IDENTITY and `scope` is a
 *    caller-supplied PARAMETER. Nothing here is hardcoded to ownership OR to
 *    reputation, so the same construction serves a study-consent nullifier in
 *    Vertical B unchanged. See that module's header for the two defects this
 *    replaced (a salt-derived secret, and a 31-bit nullifier that collides at
 *    ~63,000 events) and for exactly what unlinkability is and is not claimed.
 * 3. DOMAIN-PARAMETERIZED — `domain` is an explicit field in the statement and is
 *    absorbed into the digest, so one verifier serves many domains and a proof from
 *    one domain cannot be replayed into another.
 * 5. ONE PLONKY3 PIN — no new proving surface is introduced; this only fixes an
 *    input/output convention over the already-pinned permutation.
 * 6. DOMAIN NAMESPACE — `REPID_DELTA_DOMAIN` is the registry key for this circuit.
 */

import { poseidon2Hash2 } from './poseidon2-hash2';
import { poseidon2Sponge, fieldsToHex } from './poseidon2-leaf';
import { BABYBEAR_P } from './poseidon2-babybear';
import {
  scopedNullifier,
  unlinkabilityOf,
  type IdentitySecret,
  type UnlinkabilityStatement,
} from './nullifier-identity';
import { computeDelta, type DeltaInput, type HALDecision } from '../scoring/repid-delta';
import { REPID_MIN, REPID_MAX } from '../scoring/repid-clamp';

// ---------------------------------------------------------------------------
// Domain + versioning
// ---------------------------------------------------------------------------

/** Registry key for this circuit family (Invariant 6). Never reuse across verticals. */
export const REPID_DELTA_DOMAIN = 'hyperdag/repid/delta/v1';

/**
 * Scheme tag written to `repid_zkp_proofs.scheme`.
 *
 * Deliberately says `statement`, not `proof`. When a Plonky3 circuit lands it writes a
 * DIFFERENT tag, so one SQL query can always separate "we recorded the claim" from
 * "we proved the claim" — the distinction the 56,823 sha256 stubs taught us to keep.
 */
export const REPID_DELTA_STATEMENT_SCHEME = 'poseidon2-statement-v1';

/**
 * The published band. These two numbers ARE public — they bound what any single event
 * can do to a score, and publishing them is what makes the commitment meaningful
 * without exposing how a delta is chosen inside the band.
 *
 * Kept in sync with `repid-delta.ts` by a test, not by hope.
 */
export const DELTA_BAND_MIN = -10;
export const DELTA_BAND_MAX = 5;

// ---------------------------------------------------------------------------
// Field encoding
// ---------------------------------------------------------------------------

/**
 * BabyBear is a ~31-bit prime, so a field element holds far less than a JS number.
 * Every encoding below is explicit and injective over its documented range; nothing
 * relies on values "being small enough".
 */

/**
 * Offset used to encode signed integers as field elements.
 *
 * 2^20 is enormous relative to every signed quantity in this statement (deltas are
 * [-10, 5]; scores are [10, 10000]) and tiny relative to p, so the mapping is
 * injective with no wraparound and stays obviously correct on inspection. A tighter
 * offset would save nothing and invite an off-by-one at the boundary.
 */
export const SIGNED_OFFSET = 1n << 20n;

/** Encode a signed integer as a canonical field element. Throws outside the range. */
export function feltFromSigned(n: number): bigint {
  if (!Number.isInteger(n)) throw new Error(`[repid-delta-statement] not an integer: ${n}`);
  const v = BigInt(n) + SIGNED_OFFSET;
  if (v < 0n || v >= BABYBEAR_P) {
    throw new Error(`[repid-delta-statement] signed value out of encodable range: ${n}`);
  }
  return v;
}

/**
 * Encode a fixed-point ratio in [0, 1] as a field element with 6 decimal places.
 *
 * HAL scores arrive as floats and a float is not a field element. Quantising to
 * 1e-6 is lossy ON PURPOSE and the loss is part of the statement: the circuit and the
 * engine must agree on the *quantised* value, or they compute different things. The
 * scale is fixed here so it cannot drift.
 */
export const RATIO_SCALE = 1_000_000n;

export function feltFromRatio(x: number): bigint {
  if (!Number.isFinite(x)) throw new Error(`[repid-delta-statement] non-finite ratio: ${x}`);
  if (x < 0 || x > 1) throw new Error(`[repid-delta-statement] ratio outside [0,1]: ${x}`);
  return BigInt(Math.round(x * Number(RATIO_SCALE)));
}

/**
 * DELTAS ARE NOT INTEGERS. `repid-delta.ts` computes a clean-path delta as
 * `Math.round(raw * 10) / 10` — one decimal place, so +2.6 is a real, common value.
 *
 * My first version of this file encoded the delta with `feltFromSigned`, which throws
 * on a non-integer. That would have thrown on the majority of live score events: the
 * clean path is the common path. Caught by reading the formula rather than by assuming
 * "delta" meant a whole number.
 *
 * DELTA_SCALE is 10 because that is exactly the precision the formula produces. A
 * coarser scale would silently round real deltas; a finer one would invite the circuit
 * and the engine to disagree about trailing digits that carry no information.
 */
export const DELTA_SCALE = 10;

/** Encode a one-decimal signed delta exactly. Throws if it carries finer precision. */
export function feltFromDelta(d: number): bigint {
  if (!Number.isFinite(d)) throw new Error(`[repid-delta-statement] non-finite delta: ${d}`);
  const scaled = Math.round(d * DELTA_SCALE);
  if (Math.abs(scaled / DELTA_SCALE - d) > 1e-9) {
    throw new Error(
      `[repid-delta-statement] delta ${d} has finer precision than ${1 / DELTA_SCALE} — ` +
        `it cannot be encoded exactly, and a statement must never round its own subject`,
    );
  }
  return feltFromSigned(scaled);
}

/**
 * Encode a UTF-8 string as one field element per byte.
 *
 * Same convention as `merkle-root.ts` `leaf()` — one byte, one element. It is
 * space-inefficient and it is unambiguous, and for a statement that a circuit must
 * reproduce, unambiguous wins every time. Length is absorbed first so that
 * `"ab" ‖ "c"` and `"a" ‖ "bc"` cannot collide.
 */
export function feltsFromString(s: string): bigint[] {
  const bytes = Buffer.from(s, 'utf8');
  return [BigInt(bytes.length), ...Array.from(bytes, (b) => BigInt(b))];
}

// ---------------------------------------------------------------------------
// Formula commitment
// ---------------------------------------------------------------------------

/**
 * The formula parameters committed to. NOT the formula's source — the values that
 * define its behaviour at the band edges plus a version tag.
 *
 * This is deliberately the SMALLEST set that changes whenever scoring behaviour
 * changes. Committing to more (every internal threshold) would leak more under a
 * brute-force attempt and buy nothing: any behavioural change moves the band edges or
 * the version.
 */
export interface FormulaParams {
  bandMin: number;
  bandMax: number;
  scoreFloor: number;
  scoreCeiling: number;
  /**
   * Bumped by hand whenever scoring behaviour changes in a way the band cannot see.
   *
   * ⚠ THIS FIELD HAS ALREADY FAILED ONCE, on 2026-08-17. The clean branch's orientation was
   * corrected (it consumed risk where it needed quality), which changed every delta the formula
   * produces — and the band, floor and ceiling are all untouched by that change, so
   * `formulaCommitment()` stayed BYTE-IDENTICAL because nobody bumped this string.
   *
   * The failure mode that creates is the misleading one: an old proof still shows a MATCHING
   * `formula_commitment`, while the recompute check disagrees with its stored delta — so a version
   * skew presents as a FORGED DELTA. See docs/FORMULA-VERSIONING.md.
   *
   * "Bumped by hand" is the defect, not the instruction. A hand-maintained version behind a hash
   * nobody reads is wired at one end.
   */
  version: string;
}

export const CURRENT_FORMULA_PARAMS: FormulaParams = {
  bandMin: DELTA_BAND_MIN,
  bandMax: DELTA_BAND_MAX,
  scoreFloor: REPID_MIN,
  scoreCeiling: REPID_MAX,
  // Bumped 2026-08-17: the clean branch now consumes QUALITY, not risk (src/scoring/repid-delta.ts).
  // Every delta the formula produces changed. The band did not, so the commitment would otherwise
  // have been unchanged — which is exactly the hole this bump closes.
  version: 'repid-delta-a8-quality-oriented',
};

/** Env var holding the secret salt. See the header on why an unsalted commitment leaks. */
export const FORMULA_SALT_ENV = 'REPID_FORMULA_COMMITMENT_SALT';

export function formulaSalt(): string | null {
  const s = (process.env[FORMULA_SALT_ENV] ?? '').trim();
  return s.length > 0 ? s : null;
}

/**
 * Commit to the scoring formula: `H_sponge(params ‖ salt)`.
 *
 * FAILS CLOSED with no salt. An unsalted digest over these low-entropy parameters is
 * brute-forceable in seconds, so emitting one would publish the formula while
 * appearing to protect it — the worst of both outcomes.
 */
export function formulaCommitment(
  params: FormulaParams = CURRENT_FORMULA_PARAMS,
  salt: string | null = formulaSalt(),
): string {
  if (!salt) {
    throw new Error(
      `[repid-delta-statement] ${FORMULA_SALT_ENV} is not set. Refusing to emit an ` +
        `UNSALTED formula commitment: the parameters are low-entropy and an unsalted ` +
        `digest can be brute-forced back to the formula it is meant to hide.`,
    );
  }
  const felts = [
    ...feltsFromString('repid-formula-commitment/v1'),
    feltFromDelta(params.bandMin),
    feltFromDelta(params.bandMax),
    feltFromSigned(params.scoreFloor),
    feltFromSigned(params.scoreCeiling),
    ...feltsFromString(params.version),
    ...feltsFromString(salt),
  ];
  return fieldsToHex(poseidon2Sponge(felts));
}

// ---------------------------------------------------------------------------
// Scoped nullifier (Invariant 2)
// ---------------------------------------------------------------------------

/**
 * ⚠ NARROW-FORM NULLIFIER — RETAINED FOR CIRCUIT PARITY, UNSAFE FOR UNLINKABILITY.
 * ═══════════════════════════════════════════════════════════════════════════════
 * `nullifierScope` + `deriveNullifier` are the 2-scalar → 1-field construction the
 * zkp-vault ownership AIR is written against (`poseidon2-hash2.ts`). They are kept so
 * that swap (backlog 4.0-d.3) has an off-circuit oracle to match, and for no other
 * reason. **The statement below no longer uses them, and new code must not.**
 *
 * The reason is arithmetic, not taste: the output is ONE BabyBear element, so
 *   - the secret has at most ~31 bits and is recoverable by exhaustive search — an
 *     attacker who recovers it then links that identity across every scope; and
 *   - the nullifier itself collides. Sweeping distinct one-element secrets against a
 *     fixed scope, the first collision lands at the 62,852nd — measured, 4.2 s. With
 *     152,084 rows already in `repid_score_events` [V SQL 2026-08-03] and the
 *     nullifier scoped per event, the expected number of colliding pairs at current
 *     volume is n²/2p ≈ 5.7. That is ~6 honest events reported as replays of
 *     unrelated ones.
 *
 * The ownership circuit inherits the same two defects and should be widened in the
 * same way when 4.0-d.3 is written; that is a zkp-vault change, out of scope here, and
 * is recorded so nobody re-derives it from scratch.
 *
 * Use `scopedNullifier` from `./nullifier-identity` instead.
 *
 * @deprecated unlinkability-unsafe; parity oracle only.
 */
export function nullifierScope(domain: string, scopeLabel: string): bigint {
  const felts = [...feltsFromString(domain), ...feltsFromString(scopeLabel)];
  // Fold the sponge output to one element: the nullifier hash is 2-scalar -> 1-field.
  return poseidon2Sponge(felts)[0]!;
}

/**
 * `nullifier = H_p2(secret, scope)` — the ownership AIR's construction.
 *
 * @deprecated unlinkability-unsafe (31-bit output). See `nullifierScope` above.
 */
export function deriveNullifier(secret: bigint, scope: bigint): bigint {
  return poseidon2Hash2(secret, scope);
}

/** Bits of pre-image resistance the narrow form actually has. Named so a test can pin it. */
export const NARROW_NULLIFIER_BITS = 31;

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/** Everything the prover keeps. NEVER persisted, NEVER logged, NEVER in a response. */
export interface RepidDeltaWitness {
  hal_score: number;
  hal_decision: HALDecision;
  current_repid: number;
  agent_tier: string;
  vesting_cliff_active: boolean;
  task_complexity?: number;
  /**
   * The PER-IDENTITY secret backing the nullifier (Invariant 2), from
   * `nullifier-identity.ts`. Was a per-event `bigint` derived from the formula salt;
   * that made the nullifier recomputable from public inputs plus one shared secret,
   * and gave the identity axis no representation at all.
   */
  identitySecret: IdentitySecret;
}

/** Everything the verifier sees. Safe to publish in full. */
export interface RepidDeltaPublicInputs {
  domain: string;
  /**
   * `H(domain ‖ agentId)`.
   *
   * ⚠ NOT pseudonymity, and it never was: the agent id is public, so anyone can
   * recompute this. It keeps the raw id out of the row and hides it from a casual
   * reader — nothing more. `identity_commitment` below is the field whose pre-image is
   * actually secret.
   */
  agent_commitment: string;
  /**
   * Commitment to the per-identity nullifier secret: `H(tag ‖ secret)`.
   *
   * This is what turns the nullifier from a de-duplication tag into a nullifier. It
   * publishes a value whose pre-image only the secret-holder knows, so a future
   * Plonky3 circuit can prove "this nullifier was derived from the secret behind this
   * registered commitment" without revealing either — the Semaphore shape. Today it is
   * a binding, not a proof.
   *
   * Stable per identity per domain, so all of one identity's statements link to each
   * other by construction. Per-statement unlinkability would need a fresh commitment
   * per epoch and is deliberately not claimed here.
   */
  identity_commitment: string;
  /**
   * The delta AS STORED — an integer. `repid_score_events.repid_delta_applied` is an
   * integer column and `pipeline.ts` writes `Math.round(...)` into it, so the
   * one-decimal value the formula produces is not what the ledger carries. The
   * statement attests to the ledger.
   */
  delta_applied: number;
  score_before: number;
  score_after: number;
  band_min: number;
  band_max: number;
  formula_commitment: string;
  /**
   * The scoped nullifier, `0x`+64 hex (~248 bits).
   *
   * WIDE ON PURPOSE. The previous 32-bit form collided in practice, not in theory —
   * see the deprecation note on `deriveNullifier`. At this width a collision between
   * two honest events is ~2^-248, so equality really does mean replay.
   */
  nullifier: string;
  /** Poseidon2 digest over every field above, in the canonical order below. */
  statement_digest: string;
}

/**
 * Commit to an agent identity: `H_sponge(domain ‖ agentId)`.
 *
 * Domain-separated so the same agent's commitment differs per circuit family and
 * cannot be correlated across verticals — which is the privacy half of Invariant 3.
 */
export function agentCommitment(agentId: string, domain: string = REPID_DELTA_DOMAIN): string {
  return fieldsToHex(poseidon2Sponge([...feltsFromString(domain), ...feltsFromString(agentId)]));
}

/**
 * CANONICAL FIELD ORDER for the statement digest.
 *
 * A circuit and an engine that absorb the same values in a different order compute
 * different digests and every proof fails verification for no visible reason. The
 * order is fixed here, in one place, and pinned by a KAT test. Do not reorder — append.
 *
 * FORMAT v2 (2026-08-03): `identity_commitment` inserted after `agent_commitment`, and
 * `nullifier` widened from 32 to 248 bits. Both change the digest, so the KAT in
 * `tests/zkp-repid-delta-statement.test.ts` moved in the same commit — which is what
 * that test is for. Safe to do now precisely because no circuit exists yet and
 * `repid_zkp_proofs` holds ZERO `REPID_DELTA` rows [V SQL 2026-08-03]: there is nothing
 * on disk or in a circuit to invalidate. Once either exists, this is append-only.
 */
function statementFelts(p: Omit<RepidDeltaPublicInputs, 'statement_digest'>): bigint[] {
  return [
    ...feltsFromString(p.domain),
    ...feltsFromString(p.agent_commitment),
    ...feltsFromString(p.identity_commitment),
    feltFromDelta(p.delta_applied),
    feltFromSigned(p.score_before),
    feltFromSigned(p.score_after),
    feltFromDelta(p.band_min),
    feltFromDelta(p.band_max),
    ...feltsFromString(p.formula_commitment),
    ...feltsFromString(p.nullifier),
  ];
}

export function statementDigest(p: Omit<RepidDeltaPublicInputs, 'statement_digest'>): string {
  return fieldsToHex(poseidon2Sponge(statementFelts(p)));
}

export interface BuildStatementParams {
  agentId: string;
  /** Label the nullifier is scoped to — the score-event id for reputation. */
  scopeLabel: string;
  witness: RepidDeltaWitness;
  /** The delta the pipeline actually applied. Compared against the recomputation. */
  deltaApplied: number;
  scoreBefore: number;
  scoreAfter: number;
  domain?: string;
  formulaCommitmentOverride?: string;
}

export interface BuiltStatement {
  public: RepidDeltaPublicInputs;
  /** True when the applied delta equals what the formula produces from the witness. */
  consistent: boolean;
  /** Populated when it does not — the whole reason to build this before a circuit. */
  inconsistency: string | null;
  /**
   * Exactly who can and cannot link this nullifier, derived from where its secret came
   * from. Returned in shape so a caller cannot accidentally publish a stronger claim
   * than the construction supports.
   */
  unlinkability: UnlinkabilityStatement;
}

/**
 * Build the statement for one RepID delta, and check it against the formula.
 *
 * The consistency check is the load-bearing part TODAY. A circuit will eventually
 * enforce it in zero knowledge; right now it catches the thing that actually happens —
 * a delta that reached the ledger without coming from the formula at all. Seven of
 * eleven score-event writers are unguarded, so this is not hypothetical.
 */
export function buildRepidDeltaStatement(params: BuildStatementParams): BuiltStatement {
  const domain = params.domain ?? REPID_DELTA_DOMAIN;
  const w = params.witness;

  // Invariant 2: one per-identity secret, scope as a free parameter. `scopeLabel` is
  // opaque here — a score-event id for reputation, a studyId for the health vertical.
  const nullifier = scopedNullifier({
    secret: w.identitySecret,
    domain,
    scopeLabel: params.scopeLabel,
  });

  const publicNoDigest: Omit<RepidDeltaPublicInputs, 'statement_digest'> = {
    domain,
    agent_commitment: agentCommitment(params.agentId, domain),
    identity_commitment: w.identitySecret.commitment,
    delta_applied: params.deltaApplied,
    score_before: params.scoreBefore,
    score_after: params.scoreAfter,
    band_min: DELTA_BAND_MIN,
    band_max: DELTA_BAND_MAX,
    formula_commitment: params.formulaCommitmentOverride ?? formulaCommitment(),
    nullifier,
  };

  const pub: RepidDeltaPublicInputs = {
    ...publicNoDigest,
    statement_digest: statementDigest(publicNoDigest),
  };

  const check = checkConsistency(params);
  return {
    public: pub,
    consistent: check === null,
    inconsistency: check,
    unlinkability: unlinkabilityOf(w.identitySecret),
  };
}

/**
 * Does the claimed delta actually follow from the witness and the band?
 *
 * Returns null when consistent, or the first violation found. Three independent
 * things can be wrong and they are reported separately, because they mean different
 * things: out-of-band is a bug in a writer, formula-mismatch is a delta that bypassed
 * the formula, and arithmetic-mismatch is a score that does not follow from its delta.
 */
export function checkConsistency(params: BuildStatementParams): string | null {
  const { deltaApplied, scoreBefore, scoreAfter, witness } = params;

  if (deltaApplied < DELTA_BAND_MIN || deltaApplied > DELTA_BAND_MAX) {
    return `delta ${deltaApplied} is outside the published band [${DELTA_BAND_MIN}, ${DELTA_BAND_MAX}]`;
  }

  const input: DeltaInput = {
    hal_score: witness.hal_score,
    hal_decision: witness.hal_decision,
    current_repid: witness.current_repid,
    agent_tier: witness.agent_tier,
    vesting_cliff_active: witness.vesting_cliff_active,
    ...(witness.task_complexity !== undefined ? { task_complexity: witness.task_complexity } : {}),
  };
  // THE STATEMENT ATTESTS TO WHAT IS ON THE LEDGER, NOT TO A PRE-ROUNDING FLOAT.
  //
  // Verified against the live schema: `repid_agents.current_repid`,
  // `repid_score_events.repid_before` and `.repid_after` are all `integer`, scale 0,
  // while `computeDelta` produces one-decimal values (`Math.round(raw*10)/10`), and
  // `pipeline.ts` stores `Math.round(...)` at both write sites. So a +2.6 delta is
  // recorded as +3. Comparing the raw float to the stored integer would fail on the
  // majority of clean events — the common path.
  //
  // Rounding is applied here in the same direction and at the same point as the
  // pipeline does it. Note that `Math.round(before + d) === before + Math.round(d)`
  // only because `before` is an integer; if `REPID_DECAY_MODE` is ever flipped to
  // `enforce`, the decayed base becomes fractional and those two stop agreeing. That
  // is a real coupling between the decay rollout and this check, recorded here rather
  // than discovered later.
  const recomputed = Math.round(computeDelta(input).delta_applied);
  if (recomputed !== deltaApplied) {
    return `delta ${deltaApplied} does not follow from the witness — the formula yields ${recomputed}`;
  }

  // The score must move by exactly the delta, unless it was stopped by a clamp bound.
  //
  // ⚠ A DIVERGENCE THIS CHECK SURFACES, recorded rather than silently accommodated:
  // `repid-delta.ts` floor-protects against its own `FLOOR = 0`, while
  // `repid-clamp.ts` (and the DB CHECK) enforce `REPID_MIN = 10`. Two different floors
  // in one scoring path. It is currently harmless — the band is ±10 and floor
  // protection only ever REDUCES |delta|, so a stored score cannot land in 0..9 — but
  // it means the formula believes 0 is reachable and the database does not. The
  // authority for a STORED score is the clamp, so this check uses REPID_MIN. Whoever
  // reconciles the two should change repid-delta.ts's FLOOR, not this line.
  const expected = scoreBefore + deltaApplied;
  const clamped = Math.min(REPID_MAX, Math.max(REPID_MIN, expected));
  if (scoreAfter !== clamped) {
    return `score ${scoreBefore} -> ${scoreAfter} does not follow from delta ${deltaApplied} (expected ${clamped})`;
  }

  return null;
}

/**
 * Verify a statement WITHOUT the witness, i.e. what an outside developer can do today.
 *
 * This is honest about its own limits and the limits are the reason the circuit is
 * still needed. It confirms: the digest binds these public inputs, the delta is inside
 * the published band, the score arithmetic holds, the formula commitment matches the
 * one being asserted, and the domain is the expected one. It CANNOT confirm the delta
 * came from the formula — that is precisely the statement only a ZK proof can carry,
 * and pretending otherwise would be the overclaim this file exists to avoid.
 */
export interface ExternalVerification {
  valid: boolean;
  checks: Record<string, boolean>;
  /** What a verifier still cannot know without a proof. Never empty today. */
  unproven: string[];
  failures: string[];
}

export function verifyRepidDeltaStatement(
  pub: RepidDeltaPublicInputs,
  opts: { expectedFormulaCommitment?: string; expectedDomain?: string } = {},
): ExternalVerification {
  const { statement_digest, ...rest } = pub;
  const checks: Record<string, boolean> = {
    digest_binds_inputs: statementDigest(rest) === statement_digest,
    delta_in_band: pub.delta_applied >= pub.band_min && pub.delta_applied <= pub.band_max,
    band_matches_published: pub.band_min === DELTA_BAND_MIN && pub.band_max === DELTA_BAND_MAX,
    score_arithmetic:
      pub.score_after ===
      Math.min(REPID_MAX, Math.max(REPID_MIN, pub.score_before + pub.delta_applied)),
    domain_expected: pub.domain === (opts.expectedDomain ?? REPID_DELTA_DOMAIN),
    formula_commitment_matches: opts.expectedFormulaCommitment
      ? pub.formula_commitment === opts.expectedFormulaCommitment
      : true,
    // A narrow nullifier is a REJECTABLE statement, not a cosmetic issue: at 32 bits
    // it collides between honest events (~6 expected pairs at current ledger volume),
    // so an outside verifier must be able to refuse one without reading this file.
    nullifier_is_wide: /^0x[0-9a-f]{64}$/.test(pub.nullifier),
    identity_commitment_present: /^0x[0-9a-f]{64}$/.test(pub.identity_commitment),
  };

  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);

  return {
    valid: failures.length === 0,
    checks,
    failures,
    unproven: [
      'that the delta was derived from the committed formula (needs the Plonky3 circuit)',
      'that the witness inputs were themselves honest (needs HAL attestation binding)',
      // Added with statement format v2. The nullifier is now BOUND to an identity
      // commitment, which is a different thing from being PROVEN to be: a verifier
      // holding only the commitment cannot recheck the derivation. Saying otherwise
      // would be exactly the overclaim this whole module is arranged to avoid.
      'that the nullifier was derived from the secret behind identity_commitment ' +
        '(binding is asserted, not proven — needs the Plonky3 circuit)',
      'that the identity behind identity_commitment is a distinct human or an ' +
        'independently-registered agent (needs populated identity material; see ' +
        'nullifier-identity.ts on the live-database enumeration)',
    ],
  };
}

// ---------------------------------------------------------------------------
// Mode gate
// ---------------------------------------------------------------------------

export type DeltaStatementMode = 'off' | 'shadow' | 'on';

/**
 * `off` — byte-identical to today. `shadow` — build and log, persist nothing.
 * `on` — persist a `REPID_DELTA` row tagged `is_real=false`.
 *
 * Default OFF. Building a statement touches Poseidon2 on every score event, and that
 * cost should be measured in shadow at production volume before any row is written.
 */
export function deltaStatementMode(): DeltaStatementMode {
  const v = (process.env.REPID_DELTA_STATEMENT_MODE ?? '').trim().toLowerCase();
  if (v === 'on') return 'on';
  if (v === 'shadow') return 'shadow';
  return 'off';
}
