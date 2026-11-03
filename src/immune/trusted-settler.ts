/**
 * immune/trusted-settler.ts — the TRUSTED SETTLER (Agent Immune System slice, increment 2, Job B core).
 *
 * THE FLOW this closes: a sandboxed Maker produced a verdict, the promotion gate let its outbox come home,
 * and now the trusted settler VALIDATES that promoted artifact, SCORES it against a fixture oracle, computes
 * a DRY-RUN settlement, and emits the combined trust receipt from #1494 that a SEPARATE verifier re-checks.
 * The same code path REFUSES a dishonest or forged result (see the e2e test + run-slice refusal demos).
 *
 * DATA-ONLY TRUST BOUNDARY (hard rule). The promoted bundle is the Maker's OUTPUT. This module parses it as
 * DATA — JSON plus sha256 checks — and never executes, evals, sources or imports anything from it. Its logic
 * and its authorities come from the checked-out repo, not the artifact.
 *
 * NO PRODUCTION SECRETS (hard rule). Keys are PARAMETERS (four throwaway Ed25519 keys passed in); nothing is
 * read from env. The settlement is a DRY-RUN: it returns the settlement attestation plus a "would-write" record
 * and writes NOTHING to prod. Every piece here is a STUB whose prod wiring is the next Sean-gated gate:
 *   - fixture oracle (committed claims.json)         → prod oracle/answer-set wiring: next gate.
 *   - deterministic stub Maker (fixtures/maker.mjs)  → real model Maker behind keys: next gate.
 *   - throwaway per-run Ed25519 keys                 → KMS / engine signing keys: next gate.
 *   - DRY-RUN settlement (would-write record)        → repid_experimental_events write: next gate.
 *
 * REUSE. The receipt is built with the increment-1 API (combined-receipt.ts): buildCombinedReceipt /
 * signCombinedReceipt / signComponentAttestation / verifyCombinedReceipt, the three attestation domains and
 * CombinedReceiptTrustRoots. This module does not fork any of it.
 *
 * HONEST INDEPENDENCE. The stub Maker and the fixture oracle are the SAME controller, so independence_class is
 * always 'same_controller_measured' and mode is 'shadow'. A negative settlement of a verified-incorrect result
 * is legitimate (failure), never dressed as a success — the verifier enforces that.
 */
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { signerFromPublicKey } from '../kernel/receipt-signing';
import {
  buildCombinedReceipt,
  signCombinedReceipt,
  signComponentAttestation,
  verifyCombinedReceipt,
  SANDBOX_ATTESTATION_DOMAIN,
  EVALUATION_ATTESTATION_DOMAIN,
  SETTLEMENT_ATTESTATION_DOMAIN,
  type CombinedReceiptInput,
  type CombinedReceiptTrustRoots,
  type CombinedReceiptVerification,
  type SignedCombinedReceipt,
  type SandboxProfileCheck,
  type SandboxAttestationPayload,
  type EvaluationAttestationPayload,
  type SettlementAttestationPayload,
  type VerifiedCorrect,
  type ReceiptResult,
  type SettlementOutcome,
} from './combined-receipt';

/** Defaults the slice binds its receipts to. The policy digest stands for the promotion gate's policy (stub). */
export const SLICE_ORACLE_SET_ID = 'immune-slice-claims-v1';
export const SLICE_EVALUATION_VERSION = 'immune-slice-eval-v1';
export const SLICE_POLICY_DIGEST = '0x' + 'p1'.repeat(32).slice(0, 64);

/** One labelled fixture claim the oracle rules against. `expected` is the oracle's secret, never given to the Maker. */
export interface OracleClaim {
  id: string;
  claim: string;
  expected: 'TRUE' | 'FALSE';
}

/** The committed fixture oracle: the claim set and the ruler (its id + a content hash). */
export interface FixtureOracle {
  oracle_set_id: string;
  hash: string;
  claims: readonly OracleClaim[];
}

/**
 * The minimal, slice-defined sandbox receipt the settler consumes as DATA. In CI, run-slice.ts adapts the
 * real TrustShell sandbox-mission receipt into this shape (parse only); the e2e test crafts it directly.
 */
export interface SliceSandboxReceipt {
  mission_id: string;
  airlock_decision: 'promote' | 'refuse';
  /** The sha256 the sandbox recorded for the promoted artifact (0x + 64 hex, or bare hex — normalised here). */
  artifact_sha256: string;
  profile_checks: SandboxProfileCheck[];
}

/** The promoted-artifact bundle: the Maker's verdict file (as bytes/string), its claimed sha256, and the sandbox receipt. */
export interface PromotedBundle {
  /** The promoted verdict file content. DATA only — never executed. */
  verdict: string;
  /** The sha256 the bundle claims for `verdict` (re-checked against the actual bytes here). */
  verdict_sha256: string;
  sandbox_receipt: SliceSandboxReceipt;
}

/** Four throwaway signing authorities, one per role. Keys are parameters; nothing is read from env. */
export interface SettlementKeys {
  harness: KeyObject;
  evaluation: KeyObject;
  settlement: KeyObject;
  composite: KeyObject;
}

/** The binding context: who made it, who checked it, which experiment. The stub Maker + fixture oracle share a controller. */
export interface TrustedSettlementContext {
  experiment_id: string;
  maker_id: string;
  maker_controller: string;
  checker_id: string;
  checker_controller: string;
  evaluation_version?: string;
  policy_digest?: string;
}

export interface TrustedSettlementInput {
  bundle: PromotedBundle;
  oracle: FixtureOracle;
  keys: SettlementKeys;
  context: TrustedSettlementContext;
}

/** The DRY-RUN settlement record a prod settler WOULD write. Nothing is written here. */
export interface WouldWrite {
  target: 'repid_experimental_events (DRY-RUN; not written — prod write is the next Sean-gated gate)';
  agent_id: string;
  experiment_id: string;
  delta_sign: 'positive' | 'negative' | 'none';
  dimension: 'validator';
  mode: 'shadow';
}

export interface Measurements {
  latency_ms: number;
  /** null: the Maker is a deterministic stub, so there is no token count to report. */
  maker_tokens: number | null;
  manual_interventions: number;
}

export type TrustedSettlementResult =
  | { ok: false; refused: string[] }
  | {
      ok: true;
      receipt: SignedCombinedReceipt;
      verification: CombinedReceiptVerification;
      measurements: Measurements;
      settlement: WouldWrite;
    };

/** correct → correct, incorrect → incorrect, missing_evaluation → not_scorable (matches the verifier's result↔verdict rule). */
const RESULT_OF: Record<VerifiedCorrect, ReceiptResult> = {
  correct: 'correct',
  incorrect: 'incorrect',
  missing_evaluation: 'not_scorable',
};
/** The settler sets the outcome from the verdict; a verified-incorrect result settles a legitimate negative (failure). */
const OUTCOME_OF: Record<VerifiedCorrect, SettlementOutcome> = {
  correct: 'success',
  incorrect: 'failure',
  missing_evaluation: 'none',
};
const DELTA_SIGN_OF: Record<VerifiedCorrect, WouldWrite['delta_sign']> = {
  correct: 'positive',
  incorrect: 'negative',
  missing_evaluation: 'none',
};

/** Canonical 0x + lowercase hex, so the composite and its signed components cross-match whatever prefix they came in with. */
const normHash = (s: string): string => '0x' + String(s).replace(/^0x/i, '').toLowerCase();
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The Ed25519 fingerprint a trust root pins for a private key. Throws only if `key` is not an Ed25519 key. */
function fingerprintOf(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  const signer = signerFromPublicKey(`0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`);
  if (signer === null) throw new Error('[immune] trusted-settler: a signing key is not an Ed25519 key');
  return signer.fingerprint;
}

/** Build the per-role trust roots from the four signing keys. Exported so callers can re-check receipts the same way. */
export function trustRootsFor(keys: SettlementKeys): CombinedReceiptTrustRoots {
  return {
    combined: [{ fingerprint: fingerprintOf(keys.composite) }],
    sandbox: [{ fingerprint: fingerprintOf(keys.harness) }],
    evaluation: [{ fingerprint: fingerprintOf(keys.evaluation) }],
    settlement: [{ fingerprint: fingerprintOf(keys.settlement) }],
  };
}

/** The committed fixture oracle: the claim set plus a deterministic content hash (the ruler). Pure — no fs here. */
export function fixtureOracle(claims: readonly OracleClaim[], oracleSetId: string = SLICE_ORACLE_SET_ID): FixtureOracle {
  return { oracle_set_id: oracleSetId, hash: '0x' + sha256Hex(JSON.stringify(claims)), claims };
}

/** Score the Maker's one-line verdict against the oracle. Unparseable or unknown-claim ⇒ missing_evaluation. */
function scoreVerdict(verdict: string, oracle: FixtureOracle): VerifiedCorrect {
  let parsed: { id?: unknown; verdict?: unknown };
  try {
    parsed = JSON.parse((verdict.trim().split('\n')[0] ?? '')) as typeof parsed;
  } catch {
    return 'missing_evaluation';
  }
  const claim = oracle.claims.find((c) => c.id === parsed.id);
  if (!claim || (parsed.verdict !== 'TRUE' && parsed.verdict !== 'FALSE')) return 'missing_evaluation';
  return parsed.verdict === claim.expected ? 'correct' : 'incorrect';
}

/**
 * Validate the promoted bundle as DATA, score it, DRY-RUN the settlement, and emit a combined receipt that is
 * then independently verified. Refuses (ok:false) BEFORE building a receipt when the bundle is malformed, was
 * not promoted, or its claimed sha256 does not match the actual bytes / the sandbox's recorded artifact.
 */
export function runTrustedSettlement(input: TrustedSettlementInput): TrustedSettlementResult {
  const t0 = Date.now();
  const { bundle, oracle, keys, context } = input;
  const sr = bundle.sandbox_receipt;

  // (1) data-only validation. Parse, hash-check — never execute.
  const refused: string[] = [];
  if (!sr || typeof sr.mission_id !== 'string' || !Array.isArray(sr.profile_checks)) {
    refused.push('sandbox_receipt_malformed');
  } else {
    if (sr.airlock_decision !== 'promote') refused.push('sandbox_not_promoted');
    if (normHash(bundle.verdict_sha256) !== '0x' + sha256Hex(bundle.verdict)) refused.push('verdict_sha_mismatch');
    if (normHash(sr.artifact_sha256) !== normHash(bundle.verdict_sha256)) refused.push('sandbox_artifact_mismatch');
  }
  if (refused.length) return { ok: false, refused };

  // (2) score the verdict against the fixture oracle.
  const verified_correct = scoreVerdict(bundle.verdict, oracle);
  const result = RESULT_OF[verified_correct];

  // (3) DRY-RUN settlement: outcome and delta sign from the verdict. No DB write.
  const settlement_outcome = OUTCOME_OF[verified_correct];
  const settled = settlement_outcome !== 'none';
  const settlement_event_id = `immune-slice:settle:${context.experiment_id}`;
  const settlement: WouldWrite = {
    target: 'repid_experimental_events (DRY-RUN; not written — prod write is the next Sean-gated gate)',
    agent_id: context.maker_id,
    experiment_id: context.experiment_id,
    delta_sign: DELTA_SIGN_OF[verified_correct],
    dimension: 'validator',
    mode: 'shadow',
  };

  // (4) the three signed component attestations, each under its own domain and key (Issue-A grounding).
  const artifact_hash = normHash(bundle.verdict_sha256);
  const evaluation_version = context.evaluation_version ?? SLICE_EVALUATION_VERSION;

  const sandboxPayload: SandboxAttestationPayload = {
    mission_id: sr.mission_id,
    artifact_sha256: artifact_hash,
    profile_checks: sr.profile_checks,
    airlock_decision: 'promote',
  };
  const evaluationPayload: EvaluationAttestationPayload = {
    verified_correct,
    evaluation_version,
    checker_id: context.checker_id,
    checker_controller: context.checker_controller,
    oracle_set_id: oracle.oracle_set_id,
  };
  const settlementPayload: SettlementAttestationPayload = {
    settlement_event_id,
    settlement_outcome,
    experiment_id: context.experiment_id,
    maker_id: context.maker_id,
    checker_id: context.checker_id,
  };

  const sandbox_attestation = signComponentAttestation(SANDBOX_ATTESTATION_DOMAIN, sandboxPayload, keys.harness);
  const evaluation_attestation = signComponentAttestation(EVALUATION_ATTESTATION_DOMAIN, evaluationPayload, keys.evaluation);
  const settlement_attestation = signComponentAttestation(SETTLEMENT_ATTESTATION_DOMAIN, settlementPayload, keys.settlement);

  // (5) build + composite-sign the combined receipt.
  const receiptInput: CombinedReceiptInput = {
    artifact_hash,
    evaluation_version,
    policy_digest: normHash(context.policy_digest ?? SLICE_POLICY_DIGEST),
    execution_sha: '0x' + sha256Hex(`${sr.mission_id}:${artifact_hash}`),
    experiment_id: context.experiment_id,
    ruler: { oracle_set_id: oracle.oracle_set_id, hash: oracle.hash },
    mode: 'shadow',
    identities: { maker_id: context.maker_id, maker_controller: context.maker_controller, checker_id: context.checker_id },
    executed: true,
    contained: sr.profile_checks.filter((c) => c.passed).map((c) => c.name),
    settled,
    settlement_event_id,
    settlement_outcome,
    independence_class: 'same_controller_measured',
    sandbox_attestation,
    evaluation_attestation,
    settlement_attestation,
    result,
  };
  const receipt = signCombinedReceipt(buildCombinedReceipt(receiptInput), keys.composite);

  // (6) re-verify independently against the trust roots built from the four public keys.
  const verification = verifyCombinedReceipt(receipt, trustRootsFor(keys));

  return { ok: true, receipt, verification, measurements: { latency_ms: Date.now() - t0, maker_tokens: null, manual_interventions: 0 }, settlement };
}
