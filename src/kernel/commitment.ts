/**
 * commitment.ts — Mission 1, the loop's Predict → Commit leg.
 *
 * The kernel commits an agent's prediction BEFORE the grant, so a later outcome is measured against a
 * value that could not be edited after the fact. The loop is Predict → Commit → Execute → Observe →
 * Settle; THIS module is Predict/Commit, and it only RECORDS — calibration is shadow, never scored.
 *
 * KEYED, NOT A BARE SALTED HASH. The committed fields are short and sometimes sensitive (a one-line
 * success criterion, a confidence of 0.7, a resource cap). A bare `sha256(salt || value)` is
 * brute-forceable for such a value — an adversary enumerates candidates until the hash matches. So the
 * commitment is an HMAC-SHA256 under a SERVER secret the agent never holds: without the key you can
 * neither forge a commitment for a chosen value nor confirm a guess. (Spec: "keyed commitments, not
 * bare salted hashes, for short/sensitive values.")
 *
 * SECRET IS ENV-ONLY (PUBLIC repo). `KERNEL_COMMITMENT_KEY` is never committed. Unset ⇒ no commitment
 * can be made or verified — fail closed, exactly like `CONTROLLER_QR_SECRET` (F-15). A commitment is
 * worthless if the key that would make it unforgeable is a public default.
 *
 * RECORDED, NEVER SCORED. `recordCalibration` returns a predicted-confidence-vs-observed-outcome row
 * with NO score, NO delta — it touches no scoring path. Mission 1 records the loop; a handful of tasks
 * is noise, and arming calibration into the score is a separate, flag-gated decision this module does
 * not take.
 */
import crypto from 'crypto';
import { canonicalJson } from '../services/owner-authorization';

/** Shown wherever the key is required and absent. Fail closed, never a public default (F-15). */
export const COMMITMENT_SECRET_MISSING =
  'KERNEL_COMMITMENT_KEY is not set, so no prediction commitment can be made or verified';

/** A local fault (bad claim, missing key): nothing is committed. */
export class CommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitmentError';
  }
}

function commitmentSecret(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return (process.env['KERNEL_COMMITMENT_KEY'] || '').trim();
}

/** The fields an agent commits to BEFORE the grant. All five are part of the commitment. */
export interface PredictionClaim {
  /** What the agent predicts will happen. */
  expectedResult: string;
  /** The bar the outcome is measured against (so "it ran" cannot be moved to after the fact). */
  successCriteria: string;
  /** The agent's stated confidence, 0..1. */
  confidence: number;
  /** Declared resource ceilings, e.g. { usdc: 5, seconds: 120 }. Non-negative numbers. */
  resourceLimits: Record<string, number>;
  /** ISO 8601 deadline the outcome is expected by. */
  deadline: string;
}

export interface CommitmentRecord {
  scheme: 'hmac-sha256';
  /** Hex HMAC over the canonical JSON of { claim, committedAt }. Opaque until the claim is revealed. */
  commitment: string;
  /** Kernel timestamp (ISO). The grant must come AFTER this — see committedBeforeGrant. */
  committedAt: string;
}

export interface VerifyOptions {
  key?: string;
}

export interface CommitOptions extends VerifyOptions {
  /** Injected clock (ms since epoch) for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

const hmacHex = (secret: string, data: string): string =>
  crypto.createHmac('sha256', secret).update(data).digest('hex');

/** The exact bytes committed: the claim's fields plus the timestamp, canonicalized (sorted keys). */
function commitmentInput(claim: PredictionClaim, committedAt: string): string {
  return canonicalJson({
    claim: {
      expectedResult: claim.expectedResult,
      successCriteria: claim.successCriteria,
      confidence: claim.confidence,
      resourceLimits: claim.resourceLimits,
      deadline: claim.deadline,
    },
    committedAt,
  });
}

function assertClaim(claim: PredictionClaim): void {
  if (!claim || typeof claim !== 'object') throw new CommitmentError('prediction claim is required');
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (!nonEmpty(claim.expectedResult)) throw new CommitmentError('expectedResult must be a non-empty string');
  if (!nonEmpty(claim.successCriteria)) throw new CommitmentError('successCriteria must be a non-empty string');
  if (typeof claim.confidence !== 'number' || !Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) {
    throw new CommitmentError('confidence must be a finite number in [0, 1]');
  }
  if (!claim.resourceLimits || typeof claim.resourceLimits !== 'object' || Array.isArray(claim.resourceLimits)) {
    throw new CommitmentError('resourceLimits must be an object of non-negative numbers');
  }
  for (const [k, v] of Object.entries(claim.resourceLimits)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new CommitmentError(`resourceLimits.${k} must be a non-negative finite number`);
    }
  }
  if (!nonEmpty(claim.deadline) || Number.isNaN(Date.parse(claim.deadline))) {
    throw new CommitmentError('deadline must be a valid ISO 8601 timestamp');
  }
}

/**
 * Commit a prediction. Keyed + timestamped. Fails closed if the claim is malformed or the secret is
 * unset — a commitment is only worth making when it is unforgeable and well-formed.
 */
export function commitPrediction(claim: PredictionClaim, opts: CommitOptions = {}): CommitmentRecord {
  const secret = commitmentSecret(opts.key);
  if (!secret) throw new CommitmentError(COMMITMENT_SECRET_MISSING);
  assertClaim(claim);
  const committedAt = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  return {
    scheme: 'hmac-sha256',
    commitment: hmacHex(secret, commitmentInput(claim, committedAt)),
    committedAt,
  };
}

export interface CommitmentMatch {
  matches: boolean;
  reason: 'ok' | 'secret_missing' | 'commitment_mismatch' | 'malformed_record';
}

/**
 * Verify a REVEALED prediction against an earlier commitment: recompute the HMAC over the revealed
 * claim + the record's own timestamp and compare in constant time. A changed committed field, the
 * wrong key, or a missing key all FAIL — never a silent pass.
 */
export function verifyRevealedPrediction(
  claim: PredictionClaim,
  record: CommitmentRecord,
  opts: VerifyOptions = {},
): CommitmentMatch {
  const secret = commitmentSecret(opts.key);
  if (!secret) return { matches: false, reason: 'secret_missing' };
  if (!record || record.scheme !== 'hmac-sha256' || typeof record.commitment !== 'string' || typeof record.committedAt !== 'string') {
    return { matches: false, reason: 'malformed_record' };
  }
  let expected: Buffer;
  try {
    assertClaim(claim);
    expected = Buffer.from(hmacHex(secret, commitmentInput(claim, record.committedAt)), 'utf8');
  } catch {
    return { matches: false, reason: 'commitment_mismatch' };
  }
  const given = Buffer.from(record.commitment, 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { matches: false, reason: 'commitment_mismatch' };
  }
  return { matches: true, reason: 'ok' };
}

/** The grant must come AFTER the commitment. True iff the commitment was stamped at or before the grant. */
export function committedBeforeGrant(record: CommitmentRecord, grantAtMs: number): boolean {
  const t = Date.parse(record.committedAt);
  return Number.isFinite(t) && Number.isFinite(grantAtMs) && t <= grantAtMs;
}

export type ObservedOutcome = 'right' | 'wrong' | 'abstain';

/**
 * A calibration row: the predicted confidence beside the observed outcome, tied to the immutable
 * commitment. DELIBERATELY carries NO score and NO delta — calibration is shadow (recorded, never
 * scored). Arming it into the score is a separate, flag-gated decision this module does not take.
 */
export interface CalibrationRecord {
  committedAt: string;
  observedAt: string;
  predictedConfidence: number;
  outcome: ObservedOutcome;
  /** Ties the observed outcome back to the exact earlier commitment. */
  commitment: string;
}

/** Record calibration. Pure: computes nothing about the score, returns no delta. */
export function recordCalibration(
  claim: PredictionClaim,
  record: CommitmentRecord,
  observed: { outcome: ObservedOutcome; at?: number },
): CalibrationRecord {
  return {
    committedAt: record.committedAt,
    observedAt: new Date(observed.at ?? Date.now()).toISOString(),
    predictedConfidence: claim.confidence,
    outcome: observed.outcome,
    commitment: record.commitment,
  };
}
