/**
 * disclosure.ts — the SELECTIVE-DISCLOSURE seam: prove `repid >= threshold` without publishing
 * the score.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE HOLE THIS OPENS AGAINST, WHICH IS LIVE TODAY
 * ════════════════════════════════════════════════════════════════════════════════
 * `src/zkp/proof-statement-guard.ts` builds the statement every real proof row carries, and its
 * canonical four keys are `{ agent_id, tier, repid_score, threshold }`. The proof asserts
 * `score > threshold` — and the statement publishes `repid_score` **in the clear, next to the
 * threshold it is compared against**.
 *
 * So the deployed "threshold proof" discloses the exact quantity a threshold proof exists to
 * withhold. It is a signed disclosure with a proof stapled to it. Worse, `tier` is published too,
 * which narrows the score to a band even if `repid_score` were removed.
 *
 * That shape is NOT changed by this module, and deliberately so: `@hyperdag/proof-verifier@0.2.0`
 * parses exactly those four keys, and 22,239 rows are already stored in it. Breaking it would
 * invalidate the corpus and the published verifier in one move. This module is a NEW statement
 * family alongside it, with its own domain tag, so the two can coexist while the old one is
 * migrated — and so that "we have selective disclosure" cannot be claimed of the old rows.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE HONESTLY IS TODAY
 * ════════════════════════════════════════════════════════════════════════════════
 * **A statement, not a proof.** There is no Plonky3 circuit for it. `provenWithoutSecret` is
 * therefore `false`, structurally, and every function here reports that rather than implying
 * otherwise. Concretely: a verifier holding only this statement CANNOT be convinced the threshold
 * was met — they are trusting the engine. The statement's value before a circuit is that it fixes
 * the public surface and the digest pre-image, so a circuit can be written against a target that
 * already exists and is already tested.
 *
 * This is why `ZKREPID_DISCLOSURE_MODE` defaults to `shadow` and why `enforce` currently REFUSES.
 * See `MODE_ENV` below. A mode flag that would let an unproven statement gate real access is the
 * fake-pass failure this codebase keeps relearning (CLAUDE.md RULE-4); the flag is built so
 * flipping it fails loudly instead.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE SHAPE: VERIFIER-NOMINATED, HOLDER-CONSENTED
 * ════════════════════════════════════════════════════════════════════════════════
 * Two steps, two parties, and neither can act alone:
 *
 *   1. The VERIFIER nominates a threshold — `nominateThreshold()` → `ThresholdRequest`.
 *      They ask "are you at or above 5000?", they do not ask "what is your score?".
 *   2. The HOLDER consents or declines — `consentToThreshold()` → `ThresholdStatement`, or
 *      `declineThreshold()` → `ThresholdDecline`.
 *
 * Why not let the holder pick? Because a holder-chosen threshold is not evidence: they would name
 * the highest bar they clear, which is a disclosure of their score by binary search. Why not let
 * the verifier get an automatic answer? Because that is a read primitive on private data — the
 * consent step is the only thing that makes this disclosure rather than surveillance.
 *
 * The nominated threshold appears VERBATIM in the statement's public surface, so the verifier
 * checks `statement.threshold === theThresholdINominated` themselves. No extra binding field is
 * needed for that, and adding one would widen the surface for no gain.
 *
 * **A decline is a first-class outcome, not an error.** It is returned as a value with a reason,
 * because a decline is the input to the incentive layer described in `docs/ZKREPID-DISCLOSURE.md`
 * — declining a reasonably demanded proof is not meant to be free. That cost lives in reputation
 * and ratchet policy, NOT here and NOT in the circuit; this module only records the event.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE EPOCH IS MANDATORY, AND WHY THE WINDOW IS SPELLED OUT
 * ════════════════════════════════════════════════════════════════════════════════
 * Without an epoch, "I am above 5000" is undated. A holder who was above 5000 last March could
 * replay the same statement forever, which converts a reputation claim into a bearer certificate
 * that never expires. The epoch is required, has no default, and is bound into the digest.
 *
 * The public surface carries the epoch WINDOW (`label`, `start`, `end`) alongside `epoch_root`,
 * not just the root. An opaque 32-byte root does not tell a verifier what freshness they accepted
 * — they would have to ask the issuer what window that root covers, which puts the issuer back in
 * the trust path for the one property the verifier is trying to check independently. The window is
 * one line of extra disclosure and it is the difference between a checkable claim and an
 * undisclosed one.
 *
 * `epoch_root` ties to the EXISTING epoch machinery in `src/services/zkp-epoch-anchor.ts`
 * (`dayEpoch`, `computeEpochMerkleRoot`). This module does not invent a second notion of epoch and
 * does no I/O — the caller supplies the root it read.
 *
 * ⚠ SCOPE LIMIT, STATED RATHER THAN IMPLIED. Binding the root makes the statement *dated*; it does
 * not yet make it *anchored*. Nothing here proves the holder's score is a leaf under that root —
 * that is a Merkle-inclusion argument the circuit must carry. Until then a wrong-but-well-formed
 * root is undetectable from the statement alone.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NO BLIND HYBRID IN v1
 * ════════════════════════════════════════════════════════════════════════════════
 * A "both parties contribute to the threshold without either learning the other's pick" scheme was
 * considered and is explicitly OUT for v1. It needs a commit-reveal round inside the circuit, and
 * every extra public input is a field a verifier must be taught to check. The simple statement
 * ships first.
 */

import { poseidon2Sponge, fieldsToHex } from '../zkp/poseidon2-leaf';
import { feltsFromString, scopedNullifier, type IdentitySecret } from '../zkp/nullifier-identity';
import { CURRENT_FORMULA_PARAMS, feltFromSigned } from '../zkp/repid-delta-statement';
import { REPID_MIN, REPID_MAX } from '../scoring/repid-clamp';

// ---------------------------------------------------------------------------
// Domain, mode
// ---------------------------------------------------------------------------

/**
 * Registry key for THIS statement family (ZKP invariant 6: never reuse a domain across
 * verticals or families). Distinct from `hyperdag/repid/delta/v1` so a threshold statement and a
 * delta statement can never be substituted for one another, and so nullifiers derived under the
 * two do not correlate.
 */
export const THRESHOLD_DOMAIN = 'hyperdag/zkrepid/threshold/v1';

/**
 * Scheme tag. Says `statement`, not `proof`, for the same reason as
 * `REPID_DELTA_STATEMENT_SCHEME`: one query must always be able to separate "we recorded the
 * claim" from "we proved it".
 */
export const THRESHOLD_STATEMENT_SCHEME = 'poseidon2-threshold-statement-v1';

export const MODE_ENV = 'ZKREPID_DISCLOSURE_MODE';

/**
 * `shadow` — build and record statements; they gate NOTHING. The default.
 * `enforce` — a statement may gate real access. Requires both guards true.
 *
 * `enforce` currently REFUSES, because `provenWithoutSecret` is structurally false until a circuit
 * exists. That is the intended behaviour of the flag, not a gap in it: the alternative is a flag
 * whose flip silently promotes an unproven claim to an access decision.
 */
export type DisclosureMode = 'shadow' | 'enforce';

export function disclosureMode(): DisclosureMode {
  const raw = (process.env[MODE_ENV] ?? '').trim().toLowerCase();
  if (raw === 'enforce') return 'enforce';
  // Anything else — unset, empty, typo, 'ENFORCE_LATER' — is shadow. An unrecognised value must
  // not fail OPEN into enforcement.
  return 'shadow';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DisclosureRefusalReason =
  | 'THRESHOLD_OUT_OF_RANGE'
  | 'THRESHOLD_NOT_INTEGER'
  | 'EPOCH_MISSING'
  | 'EPOCH_ROOT_MALFORMED'
  | 'EPOCH_WINDOW_INVALID'
  | 'SCORE_NOT_INTEGER'
  | 'CONSENT_MISSING'
  | 'THRESHOLD_MISMATCH'
  | 'WITNESS_LEAKED'
  | 'NOT_PROVEN_WITHOUT_SECRET';

export class DisclosureRefusedError extends Error {
  public readonly reason: DisclosureRefusalReason;
  public readonly detail: Record<string, unknown>;
  constructor(reason: DisclosureRefusalReason, message: string, detail: Record<string, unknown> = {}) {
    super(`zkrepid-disclosure[${reason}]: ${message}`);
    this.name = 'DisclosureRefusedError';
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — the verifier nominates
// ---------------------------------------------------------------------------

/** The epoch a statement is bound to. The WINDOW is public, not just the root — see the header. */
export interface DisclosureEpoch {
  /** Human label, e.g. `2026-08-17`. Matches `EpochSpec.label` in zkp-epoch-anchor. */
  readonly label: string;
  /** Inclusive UTC start ISO. */
  readonly start: string;
  /** Exclusive UTC end ISO. */
  readonly end: string;
  /** The epoch merkle root, `0x`+64 hex, as read from the anchor machinery. */
  readonly root: string;
}

export interface ThresholdRequest {
  /** The bar the VERIFIER chose. The holder answers this or nothing. */
  readonly threshold: number;
  /** Who is asking. Opaque to this module; carried so a decline can be attributed. */
  readonly verifierId: string;
  /** Free-text reason the verifier gives. The incentive layer needs it to judge whether a
   *  decline was reasonable; it is never hashed into the statement. */
  readonly purpose: string;
  readonly epoch: DisclosureEpoch;
}

const HEX32 = /^0x[0-9a-f]{64}$/i;

/**
 * Validate and freeze a verifier's nomination. Fails closed on every field.
 *
 * The threshold is required to be an INTEGER inside the score clamp. A fractional threshold would
 * be unrepresentable as a field element by `feltFromSigned` and would throw deep inside digest
 * construction; catching it here names the actual problem.
 */
export function nominateThreshold(args: {
  threshold: number;
  verifierId: string;
  purpose: string;
  epoch: DisclosureEpoch;
}): ThresholdRequest {
  const { threshold } = args;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new DisclosureRefusedError('THRESHOLD_NOT_INTEGER', 'threshold must be a finite number', {
      threshold,
    });
  }
  if (!Number.isInteger(threshold)) {
    throw new DisclosureRefusedError(
      'THRESHOLD_NOT_INTEGER',
      'threshold must be an integer — scores are integers, and a fractional bar is not encodable',
      { threshold },
    );
  }
  if (threshold < REPID_MIN || threshold > REPID_MAX) {
    throw new DisclosureRefusedError(
      'THRESHOLD_OUT_OF_RANGE',
      `threshold ${threshold} is outside the score clamp [${REPID_MIN}, ${REPID_MAX}] — a bar no ` +
        `score can miss, or none can meet, discloses the answer without a proof`,
      { threshold, min: REPID_MIN, max: REPID_MAX },
    );
  }
  assertEpoch(args.epoch);
  return Object.freeze({
    threshold,
    verifierId: args.verifierId,
    purpose: args.purpose,
    epoch: Object.freeze({ ...args.epoch }),
  });
}

/** Epoch is REQUIRED and has no default. An undated claim is a bearer certificate. */
function assertEpoch(epoch: DisclosureEpoch | null | undefined): void {
  if (!epoch || typeof epoch !== 'object') {
    throw new DisclosureRefusedError(
      'EPOCH_MISSING',
      'an epoch is required — without one the statement never expires and can be replayed forever',
    );
  }
  if (typeof epoch.root !== 'string' || !HEX32.test(epoch.root)) {
    throw new DisclosureRefusedError('EPOCH_ROOT_MALFORMED', 'epoch.root must be 0x + 64 hex', {
      root: epoch.root ?? null,
    });
  }
  const start = Date.parse(epoch.start);
  const end = Date.parse(epoch.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) {
    throw new DisclosureRefusedError(
      'EPOCH_WINDOW_INVALID',
      'epoch.start and epoch.end must be ISO timestamps with start < end — the window a verifier ' +
        'is accepting has to be readable, not implied by the root',
      { start: epoch.start ?? null, end: epoch.end ?? null },
    );
  }
  if (typeof epoch.label !== 'string' || epoch.label.trim().length === 0) {
    throw new DisclosureRefusedError('EPOCH_WINDOW_INVALID', 'epoch.label must be non-empty', {
      label: epoch.label ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Step 2a — the holder declines
// ---------------------------------------------------------------------------

export type DeclineReason = 'holder_refused' | 'purpose_unacceptable' | 'no_epoch_data' | 'other';

/**
 * A decline, as a VALUE. Not thrown, because a decline is a legitimate answer that the incentive
 * layer must be able to count. Carries no score information — including no "below/above" hint,
 * which would make declining itself a disclosure channel.
 */
export interface ThresholdDecline {
  readonly outcome: 'declined';
  readonly threshold: number;
  readonly verifierId: string;
  readonly epochLabel: string;
  readonly reason: DeclineReason;
  /**
   * Whether the DEMAND looked reasonable, as judged by the caller — never by this module, which
   * has no context to judge it. The incentive layer only counts declines where this is true; see
   * `docs/ZKREPID-DISCLOSURE.md`. Recorded here so the judgement is explicit at the point it is
   * made rather than reconstructed later.
   */
  readonly demandReasonable: boolean;
}

export function declineThreshold(args: {
  request: ThresholdRequest;
  reason: DeclineReason;
  demandReasonable: boolean;
}): ThresholdDecline {
  return Object.freeze({
    outcome: 'declined' as const,
    threshold: args.request.threshold,
    verifierId: args.request.verifierId,
    epochLabel: args.request.epoch.label,
    reason: args.reason,
    demandReasonable: args.demandReasonable,
  });
}

// ---------------------------------------------------------------------------
// Step 2b — the holder consents
// ---------------------------------------------------------------------------

/** Everything the prover keeps. NEVER persisted, NEVER logged, NEVER in a response. */
export interface ThresholdWitness {
  /** The actual score. This is the value the whole seam exists to keep off the wire. */
  readonly repidScore: number;
  /** The per-identity secret backing the nullifier (`nullifier-identity.ts`). */
  readonly identitySecret: IdentitySecret;
}

/**
 * The PUBLIC SURFACE. Everything here is safe to publish; nothing here is score-bearing.
 *
 * Note what is ABSENT and why, because the absences are the design:
 *   - no `repid_score`  — the point (contrast `proof-statement-guard.ts`, which publishes it)
 *   - no `tier`         — a tier is a score band; publishing it narrows the score to ~1 of 5
 *   - no `agent_id`     — the nullifier is the only identity handle, and its pre-image is secret
 *   - no `met` flag     — see `ThresholdStatement.met` below, which is NOT part of this surface
 */
export interface ThresholdPublicInputs {
  /** The threshold the VERIFIER nominated, verbatim. */
  readonly threshold: number;
  /**
   * The scoring-formula regime this statement was issued under, IN CLEARTEXT.
   *
   * Not the salted `formula_commitment`: a verifier holding a statement from an older regime needs
   * to know WHICH regime to verify against, and a commitment is opaque to them. On 2026-08-17 a
   * behaviour change shipped without a version bump, and the failure mode was a version skew
   * presenting as a forged delta — precisely because the version was only ever inside a hash.
   * See docs/FORMULA-VERSIONING.md and src/zkp/formula-golden-vector.ts.
   */
  readonly formula_version: string;
  /** Epoch window — explicit, so the verifier knows what freshness they accepted. */
  readonly epoch: DisclosureEpoch;
  /** Scoped nullifier, `0x`+64 hex (~248 bits). Scope is `threshold:<t>@<epoch label>`. */
  readonly nullifier: string;
  /** Poseidon2 digest over every field above, in the canonical order in `thresholdFelts`. */
  readonly digest: string;
}

/**
 * Guard flags, computed rather than asserted.
 *
 * Both fail closed: `enforce` mode requires both true, and `provenWithoutSecret` cannot be true
 * until a circuit exists. Returning them in shape (rather than documenting them in prose) is what
 * stops a route from publishing a stronger claim than the construction supports — the same reason
 * `UnlinkabilityStatement` exists.
 */
export interface DisclosureGuards {
  /**
   * True iff no witness-derived value is recoverable from the public surface. **Measured**: the
   * surface's key set is checked against `THRESHOLD_PUBLIC_KEYS`, and every field is compared
   * against the score and against each identity-secret field element. A guard that merely asserted
   * "we did not include it" would have passed on the `{ repid_score, threshold }` shape too.
   */
  readonly witnessHidden: boolean;
  /** Values found in the public surface that should not be there. Empty when `witnessHidden`. */
  readonly leaks: readonly string[];
  /**
   * True iff a verifier holding NO secret can be convinced the threshold claim is true.
   *
   * **Structurally `false` today.** There is no Plonky3 circuit for this statement, so a verifier
   * is trusting the engine's word. Hard-coded rather than parameterised: a flag someone could set
   * to `true` without a circuit is the fake-pass this repo keeps relearning.
   */
  readonly provenWithoutSecret: false;
  /** Why `provenWithoutSecret` is false, in one line, so a caller can surface it verbatim. */
  readonly provenWithoutSecretBecause: string;
}

export interface ThresholdStatement {
  readonly outcome: 'consented';
  readonly domain: string;
  readonly scheme: string;
  readonly public: ThresholdPublicInputs;
  /**
   * Whether the holder's score actually met the threshold.
   *
   * ⚠ NOT PART OF THE PUBLIC SURFACE, and not in the digest. It is returned to the HOLDER so they
   * can see what they are about to hand over before they hand it over. A `met: false` statement is
   * a statement the holder should usually not send — and if they do, sending it is a disclosure
   * decision they made knowingly, which is the whole shape of consented disclosure.
   *
   * Once a circuit exists, `met` becomes the proven predicate and moves onto the public surface;
   * today publishing it would be an unproven assertion dressed as an output.
   */
  readonly met: boolean;
  readonly guards: DisclosureGuards;
  /** `shadow` (default) or `enforce`. `enforce` never reaches here — it refuses. */
  readonly mode: DisclosureMode;
  /**
   * Whether this statement may gate real access. **Always false while no circuit exists.**
   * Explicit so no caller has to infer it from `mode`.
   */
  readonly enforceable: boolean;
}

/**
 * CANONICAL FIELD ORDER for the digest.
 *
 * A circuit and an engine that absorb the same values in a different order compute different
 * digests and every proof fails for no visible reason. Fixed here, in one place, pinned by a KAT
 * test. Do not reorder — append.
 *
 * The domain is absorbed FIRST and is a module constant rather than a wire field, so a verifier
 * can still recompute the digest from the public surface alone while the surface stays minimal.
 */
export function thresholdFelts(p: Omit<ThresholdPublicInputs, 'digest'>): bigint[] {
  return [
    ...feltsFromString(THRESHOLD_DOMAIN),
    feltFromSigned(p.threshold),
    ...feltsFromString(p.formula_version),
    ...feltsFromString(p.epoch.label),
    ...feltsFromString(p.epoch.start),
    ...feltsFromString(p.epoch.end),
    ...feltsFromString(p.epoch.root),
    ...feltsFromString(p.nullifier),
  ];
}

export function thresholdDigest(p: Omit<ThresholdPublicInputs, 'digest'>): string {
  return fieldsToHex(poseidon2Sponge(thresholdFelts(p)));
}

/**
 * The EXACT key set of the public surface.
 *
 * Pinned as data so a structural guard can reject an unexpected key, which is the cheapest
 * available defence against the failure this module exists to avoid: someone adding a
 * `repid_score` field to "help the verifier". Widening this list is a deliberate act that has to
 * pass through a test.
 */
export const THRESHOLD_PUBLIC_KEYS = [
  'threshold',
  'formula_version',
  'epoch',
  'nullifier',
  'digest',
] as const;

/** The nullifier scope. Per (threshold, epoch), so one holder answering two verifiers about the
 *  same bar in the same epoch is linkable across them — stated plainly rather than claimed away.
 *  A per-verifier scope would break exactly the replay detection the nullifier is for. */
export function thresholdScopeLabel(threshold: number, epochLabel: string): string {
  return `threshold:${threshold}@${epochLabel}`;
}

/**
 * Build the statement — the holder's consent step.
 *
 * Fails closed. In `shadow` mode it returns a statement with `enforceable: false` and honest
 * guards. In `enforce` mode it THROWS `NOT_PROVEN_WITHOUT_SECRET`, because there is no circuit and
 * an unproven statement must never gate access.
 */
export function consentToThreshold(args: {
  request: ThresholdRequest;
  witness: ThresholdWitness;
  /** The holder's explicit consent. Absent or false → refusal, not a statement. */
  consent: boolean;
  /** Test seam: override the formula version. Production reads `CURRENT_FORMULA_PARAMS`. */
  formulaVersion?: string;
}): ThresholdStatement {
  const { request, witness } = args;

  if (args.consent !== true) {
    throw new DisclosureRefusedError(
      'CONSENT_MISSING',
      'a threshold statement cannot be built without the holder\'s explicit consent — an ' +
        'automatic answer to a verifier\'s question is a read primitive on private data, ' +
        'not disclosure. Use declineThreshold() to record a refusal.',
      { threshold: request.threshold, verifierId: request.verifierId },
    );
  }

  // Re-validate the request rather than trusting it: `nominateThreshold` froze a valid object, but
  // this function is exported and a caller can hand-build the interface.
  assertEpoch(request.epoch);
  if (!Number.isInteger(request.threshold)) {
    throw new DisclosureRefusedError('THRESHOLD_NOT_INTEGER', 'threshold must be an integer', {
      threshold: request.threshold,
    });
  }
  if (!Number.isInteger(witness.repidScore)) {
    throw new DisclosureRefusedError(
      'SCORE_NOT_INTEGER',
      'repidScore must be an integer — `repid_agents.current_repid` is an integer column, and a ' +
        'fractional witness would not match the ledger the claim is about',
      { repidScore: witness.repidScore },
    );
  }

  const formula_version = args.formulaVersion ?? CURRENT_FORMULA_PARAMS.version;
  const nullifier = scopedNullifier({
    secret: witness.identitySecret,
    domain: THRESHOLD_DOMAIN,
    scopeLabel: thresholdScopeLabel(request.threshold, request.epoch.label),
  });

  const withoutDigest: Omit<ThresholdPublicInputs, 'digest'> = {
    threshold: request.threshold,
    formula_version,
    epoch: Object.freeze({ ...request.epoch }),
    nullifier,
  };
  const pub: ThresholdPublicInputs = Object.freeze({
    ...withoutDigest,
    digest: thresholdDigest(withoutDigest),
  });

  const guards = computeGuards(pub, witness);
  if (!guards.witnessHidden) {
    throw new DisclosureRefusedError(
      'WITNESS_LEAKED',
      'the public surface contains witness-derived values — refusing to emit it',
      { leaks: guards.leaks },
    );
  }

  const mode = disclosureMode();
  if (mode === 'enforce') {
    throw new DisclosureRefusedError(
      'NOT_PROVEN_WITHOUT_SECRET',
      `${MODE_ENV}=enforce, but this statement is not proven without the secret: ` +
        `${guards.provenWithoutSecretBecause}. Refusing to let an unproven claim gate access. ` +
        `Run in shadow mode until a circuit exists.`,
      { mode, threshold: request.threshold },
    );
  }

  return Object.freeze({
    outcome: 'consented' as const,
    domain: THRESHOLD_DOMAIN,
    scheme: THRESHOLD_STATEMENT_SCHEME,
    public: pub,
    met: witness.repidScore >= request.threshold,
    guards,
    mode,
    enforceable: false,
  });
}

/**
 * MEASURE whether the witness leaked into the public surface.
 *
 * The check inspects the BUILT surface, not the code that built it. That distinction is the whole
 * value: the deployed 4-key statement was written by someone who intended a threshold proof, and it
 * publishes the score anyway. A structural guard catches that; an intention does not.
 *
 * LIMITS, STATED. This finds a witness value appearing VERBATIM in a field, or an unexpected field
 * existing at all. It cannot detect a value that was transformed before publication — a score
 * divided by ten, or a coarse bucket of it, would pass. It is a tripwire against the mistake that
 * actually happened here, not a proof of zero-knowledge; that claim needs the circuit.
 */
export function computeGuards(
  pub: ThresholdPublicInputs,
  witness: ThresholdWitness,
): DisclosureGuards {
  const leaks: string[] = [];

  // (1) STRUCTURAL: the surface must have exactly the pinned key set. This is the check that would
  // have caught the deployed `{ agent_id, tier, repid_score, threshold }` shape, and it catches it
  // regardless of what the values happen to be.
  const actualKeys = Object.keys(pub).sort();
  const expectedKeys: string[] = [...THRESHOLD_PUBLIC_KEYS].sort();
  for (const k of actualKeys) {
    if (!expectedKeys.includes(k)) leaks.push(`unexpected public field '${k}' — the surface is pinned`);
  }
  for (const k of expectedKeys) {
    if (!actualKeys.includes(k)) leaks.push(`missing public field '${k}'`);
  }

  // (2) VALUE-WISE, per field, by EQUALITY — not by substring.
  //
  // A substring scan is the obvious implementation and it is wrong here: `":" + 5` matches
  // `"threshold":5000`, and a 4-digit score lands inside a 64-hex nullifier by chance often
  // enough to fire on correct statements. A guard that cries wolf gets switched off, which is
  // strictly worse than a narrower guard that does not. So: exact equality on scalars, and
  // substring matching ONLY for the 8-hex form of a secret felt inside a hex field, where an
  // incidental hit is ~2^-32 per position and a real leak is exact.
  const scoreToken = String(witness.repidScore);
  const secretHex = witness.identitySecret.felts.map((f) => f.toString(16).padStart(8, '0'));
  const secretDec = new Set(witness.identitySecret.felts.map((f) => f.toString(10)));

  const scalars: ReadonlyArray<readonly [string, unknown]> = [
    ['threshold', pub.threshold],
    ['formula_version', pub.formula_version],
    ['nullifier', pub.nullifier],
    ['digest', pub.digest],
    ['epoch.label', pub.epoch?.label],
    ['epoch.start', pub.epoch?.start],
    ['epoch.end', pub.epoch?.end],
    ['epoch.root', pub.epoch?.root],
  ];

  for (const [key, value] of scalars) {
    // `threshold` is EXEMPT from the score check: a holder whose score equals the nominated bar
    // exactly is a coincidence of values, not a leak — the threshold came from the verifier, who
    // already knows it. Flagging it would fail every exactly-at-the-bar statement.
    if (key !== 'threshold') {
      if (typeof value === 'number' && value === witness.repidScore) {
        leaks.push(`${key} equals the witness score`);
      }
      if (typeof value === 'string' && value === scoreToken) {
        leaks.push(`${key} is the witness score as a string`);
      }
    }
    if (typeof value === 'string' && secretDec.has(value)) {
      leaks.push(`${key} is an identity-secret field element in decimal`);
    }
    if (typeof value === 'number' && secretDec.has(String(value))) {
      leaks.push(`${key} is an identity-secret field element`);
    }
    if (typeof value === 'string' && HEX32.test(value)) {
      const lower = value.toLowerCase();
      for (const [i, hex] of secretHex.entries()) {
        if (lower.includes(hex)) leaks.push(`${key} contains identity-secret felt[${i}] in hex`);
      }
    }
  }

  return Object.freeze({
    witnessHidden: leaks.length === 0,
    leaks: Object.freeze(leaks),
    provenWithoutSecret: false as const,
    provenWithoutSecretBecause:
      'no Plonky3 circuit exists for ' +
      THRESHOLD_DOMAIN +
      ' — a verifier holding this statement is trusting the engine, not checking a proof',
  });
}

/**
 * What an outside verifier can check TODAY, with no witness and no circuit.
 *
 * Honest about its own limits, and the limits are the reason the circuit is still needed. It
 * confirms the digest binds these public inputs, the threshold is in range, the epoch window is
 * well-formed and (optionally) still current, and the formula version is the one the verifier
 * expects. It CANNOT confirm the holder's score met the threshold — that is exactly the statement
 * only a ZK proof can carry.
 */
export interface ThresholdVerifyResult {
  /** `VERIFIED` — every check this function CAN run passed. Not "the threshold was met". */
  readonly verdict: 'VERIFIED' | 'NOT_CHECKED' | 'FAILED';
  readonly failures: readonly string[];
  /** Checks structurally unavailable without a circuit. Never empty today. */
  readonly notChecked: readonly string[];
}

export function verifyThresholdStatement(args: {
  public: ThresholdPublicInputs;
  /** The threshold the verifier nominated. Mismatch is a FAILURE, not a warning. */
  expectedThreshold?: number;
  /** Formula regime the verifier is prepared to accept. */
  expectedFormulaVersion?: string;
  /** When supplied, the statement's epoch must contain this instant — the freshness check. */
  now?: Date;
}): ThresholdVerifyResult {
  const p = args.public;
  const failures: string[] = [];

  const { digest: _claimed, ...preimage } = p;
  if (thresholdDigest(preimage) !== p.digest) {
    failures.push('digest does not bind these public inputs');
  }
  if (!Number.isInteger(p.threshold) || p.threshold < REPID_MIN || p.threshold > REPID_MAX) {
    failures.push(`threshold ${p.threshold} is not an integer inside [${REPID_MIN}, ${REPID_MAX}]`);
  }
  if (args.expectedThreshold !== undefined && p.threshold !== args.expectedThreshold) {
    failures.push(
      `threshold ${p.threshold} is not the ${args.expectedThreshold} that was nominated — the ` +
        `holder answered a different question`,
    );
  }
  if (args.expectedFormulaVersion !== undefined && p.formula_version !== args.expectedFormulaVersion) {
    failures.push(
      `formula_version ${p.formula_version} is not the expected ${args.expectedFormulaVersion}`,
    );
  }
  try {
    assertEpoch(p.epoch);
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  }
  if (args.now) {
    const t = args.now.getTime();
    const start = Date.parse(p.epoch.start);
    const end = Date.parse(p.epoch.end);
    if (Number.isFinite(start) && Number.isFinite(end) && !(t >= start && t < end)) {
      failures.push(
        `statement's epoch ${p.epoch.label} does not contain ${args.now.toISOString()} — it is ` +
          `stale, and accepting it would make the claim a bearer certificate`,
      );
    }
  }

  const notChecked = Object.freeze([
    'that the holder\'s score met the threshold — needs the circuit; nothing here proves it',
    'that the holder\'s score is a leaf under epoch_root — needs a Merkle-inclusion argument',
    'that the nullifier was derived from a registered identity commitment — needs the circuit',
  ]);

  return Object.freeze({
    verdict: failures.length > 0 ? ('FAILED' as const) : ('VERIFIED' as const),
    failures: Object.freeze(failures),
    notChecked,
  });
}
