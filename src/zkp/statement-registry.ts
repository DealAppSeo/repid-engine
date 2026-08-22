/**
 * statement-registry.ts — which statement does this proof prove?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE PROBLEM, MEASURED 2026-08-21 AGAINST THE REAL VERIFIER
 * ════════════════════════════════════════════════════════════════════════════
 * A proof carries no statement identity, and it cannot be given one.
 *
 * `@hyperdag/proof-verifier` takes `{agent_id, tier, repid_score, threshold}`.
 * Its JSON parser is **strict about missing fields and types** — omit `tier` or
 * pass `repid_score` as a string and it refuses — and **silent about unknown
 * ones**. Probed directly:
 *
 *   { …honest, statement_version: 'A1' }                      → verified
 *   { …honest, statement_version: 'A2-totally-different' }    → verified
 *   { …honest, kumquat: 'anything at all' }                   → verified
 *   { …honest, risk_tier: 'ATTESTED', policy_version: '…' }   → verified
 *
 * So **a version tag written into the statement is worth exactly what `tier` is
 * worth: nothing.** `tier` is the known unbound field this codebase already
 * refuses to trust, deriving it database-side instead. A `statement_version`
 * field would be a second one — and far more dangerous, because `tier` merely
 * describes the subject while a version claims to say *what was proven*.
 *
 * A statement version can only be authoritative if it is bound INSIDE the STARK
 * — which means a new circuit and a new verifier release, exactly what a
 * "versioned family" was supposed to make unnecessary — or bound OUTSIDE, by an
 * envelope whose integrity does not depend on the verifier. This module is the
 * envelope's half.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT A1 ACTUALLY BINDS — MEASURED, NOT ASSUMED
 * ════════════════════════════════════════════════════════════════════════════
 * Existing tests already pinned: an inflated score, a substituted agent id and a
 * lowered threshold all reject, and `tier` does not.
 *
 * One property was never checked and matters more than any of them. A1's claim
 * relation is `reconstructed == repid_score - threshold - 1`, which is a
 * statement about a DIFFERENCE. If only the difference were bound, a proof of
 * *"2280 over a threshold of 999"* would equally prove *"10000 over a threshold
 * of 8719"* — the same gap, an enormously better-sounding claim. Probed with
 * difference-preserving shifts of +1, +100, +1000 and +7720: **all four reject.**
 * The two values are bound individually. That is a real soundness property, it
 * was undocumented, and it is now pinned so it cannot regress silently.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE ONE-WAY DOOR, AND THE RULE THAT CLOSES IT
 * ════════════════════════════════════════════════════════════════════════════
 * A1 is **18 BabyBear field elements**: `[0..16]` agent id, `[16]` threshold,
 * `[17]` repid score. It is published and fixed.
 *
 * Now suppose A2 arrives later with the same arity and a different meaning — say
 * `[16]` is a risk-tier ordinal and `[17]` an outcome count, proving one exceeds
 * the other. A legitimate A2 proof handed to an A1 verifier is simply *"agent X,
 * threshold = 1, score = 5000"*, and it verifies. Nothing in the proof, the
 * statement, or the verifier can tell the two apart. Every A1 relying party
 * silently begins accepting A2 proofs as RepID claims.
 *
 * The fix cannot be a field, because A1 cannot gain one. It has to be
 * **structural**:
 *
 *   ► NO FUTURE STATEMENT IN THIS FAMILY MAY USE 18 PUBLIC VALUES.
 *
 * Every A2+ binds a domain-separator element, so its arity is at least 19 and a
 * verifier expecting A1 rejects it on shape before semantics are ever reached.
 * Arity 18 is **reserved to A1, permanently**.
 *
 * That rule costs nothing today and is unenforceable the moment a second
 * 18-element statement exists — at which point no amount of later care can
 * disambiguate the proofs already minted. This is the whole reason it is being
 * written now, with zero users, rather than when A2 is designed.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHERE IDENTITY LIVES INSTEAD
 * ════════════════════════════════════════════════════════════════════════════
 * In the row, not the proof. A stored proof records the statement it was minted
 * for, at mint time, by the minter — a party that is not the prover. A verifier
 * is then **told** which statement to expect and checks that; it never asks the
 * proof what it is, because the proof cannot answer honestly or dishonestly. It
 * simply has no opinion.
 */

/** Identifiers for statements in the RepID proof family. */
export type StatementId = 'A1';

/** Which party a field's value can be trusted from. */
export type FieldBinding =
  /** Bound inside the STARK — substituting it makes the proof fail. */
  | 'BOUND'
  /** Accepted by the verifier and NOT bound. A prover-controlled claim. */
  | 'UNBOUND'
  /** Rejected outright if absent or of the wrong type, but not bound to the proof. */
  | 'REQUIRED_UNBOUND';

export interface StatementSpec {
  id: StatementId;
  /** Number of public field elements. Unique across the family — see the header. */
  arity: number;
  /** Human description of the public-value layout. */
  layout: string;
  /** The relation the circuit enforces. */
  claimRelation: string;
  /** Per-field trust, keyed by the name the verifier's JSON input uses. */
  fields: Readonly<Record<string, FieldBinding>>;
  /** The package whose `verify_proof` this statement is defined against. */
  verifierPackage: string;
  /** Verifier version the bindings above were measured under. */
  measuredUnderVerifierVersion: string;
  /** `scheme` values in stored rows that resolve to this statement. */
  schemes: readonly string[];
}

/**
 * A1 — the only statement in the family today.
 *
 * `tier` is listed `REQUIRED_UNBOUND` rather than `UNBOUND` because both halves
 * matter and each on its own misleads: the verifier REFUSES a statement that
 * omits it, so a caller must supply something, and it binds nothing, so whatever
 * they supply is not evidence. A field you are forced to provide and forbidden
 * to believe is a trap unless it is labelled as one.
 */
export const A1: StatementSpec = Object.freeze({
  id: 'A1',
  arity: 18,
  layout: '[0..16] agent_id (16 bytes, one per element) | [16] threshold | [17] repid_score',
  claimRelation: 'repid_score > threshold, via a 16-bit range check on repid_score - threshold - 1',
  fields: Object.freeze({
    agent_id: 'BOUND',
    threshold: 'BOUND',
    repid_score: 'BOUND',
    tier: 'REQUIRED_UNBOUND',
  }),
  verifierPackage: '@hyperdag/proof-verifier',
  measuredUnderVerifierVersion: '0.2.0',
  schemes: Object.freeze(['plonky3_range_check']),
});

export const STATEMENT_REGISTRY: Readonly<Record<StatementId, StatementSpec>> = Object.freeze({
  A1,
});

/**
 * Arity permanently reserved to A1.
 *
 * Exported so the rule is a value a test can assert against, not a sentence in a
 * comment that a future author may never read.
 */
export const RESERVED_ARITY_A1 = 18;

/**
 * Every field the verifier accepts, for any statement in the family.
 *
 * Anything outside this set is silently ignored by the verifier, so writing it
 * into a statement creates the appearance of a constraint where there is none.
 */
export function knownFieldsFor(id: StatementId): readonly string[] {
  return Object.keys(STATEMENT_REGISTRY[id].fields);
}

/** Fields whose values a relying party may treat as proven. */
export function boundFieldsFor(id: StatementId): readonly string[] {
  const spec = STATEMENT_REGISTRY[id];
  return Object.keys(spec.fields).filter((f) => spec.fields[f] === 'BOUND');
}

/**
 * Resolve the statement a stored proof was minted for.
 *
 * Takes the value recorded on the ROW, not anything read out of the proof or its
 * statement JSON. A `null` return means the row predates statement recording or
 * names a scheme this registry does not know — an absence, and the caller must
 * treat it as NOT_CHECKED rather than defaulting to A1. Defaulting is how a
 * future A2 proof silently becomes a RepID claim.
 */
export function resolveStatement(recordedStatementId: string | null | undefined): StatementSpec | null {
  if (!recordedStatementId) return null;
  const spec = STATEMENT_REGISTRY[recordedStatementId as StatementId];
  return spec ?? null;
}

/**
 * Would this statement JSON mislead a reader about what was proven?
 *
 * Returns the keys present that the verifier will silently ignore. A non-empty
 * result is not an error — the verifier accepts them — it is a WARNING that the
 * object contains assertions nothing checks. `tier` is excluded: it is a known,
 * documented, required-but-unbound field, and flagging it every time would train
 * readers to ignore this function.
 */
export function unverifiedClaimKeys(
  id: StatementId,
  statement: Record<string, unknown>,
): string[] {
  const spec = STATEMENT_REGISTRY[id];
  return Object.keys(statement).filter((k) => spec.fields[k] === undefined);
}

/**
 * The rule from the header, as a predicate.
 *
 * A candidate statement is admissible only if its arity is not already taken.
 * Arity is the ONLY structural signal a verifier sees before semantics, so it is
 * the only thing that can keep two statements from being interchangeable.
 */
export function arityIsAvailable(candidateArity: number): boolean {
  return !Object.values(STATEMENT_REGISTRY).some((s) => s.arity === candidateArity);
}
