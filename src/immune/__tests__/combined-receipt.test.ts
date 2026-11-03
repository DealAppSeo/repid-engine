/**
 * Regression tests for the combined trust receipt and its anti-forgery verifier.
 *
 * Throwaway Ed25519 keypairs are generated in-process (node:crypto), one per signing AUTHORITY
 * (composite, sandbox HARNESS, evaluator, settlement engine); nothing is read from env, so the module's
 * "signing key is a parameter" contract is exercised exactly as production would use it. The headline
 * new case (test 1) proves Issue A: a composite that is internally consistent and correctly
 * composite-signed is still REFUSED when an embedded component was not signed by a trusted authority.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { signerFromPublicKey } from '../../kernel/receipt-signing';
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
  type IndependenceClass,
  type ReceiptResult,
  type SettlementOutcome,
  type SignedCombinedReceipt,
  type VerifiedCorrect,
} from '../combined-receipt';

/** A throwaway authority: its private key and the fingerprint a trust root pins. */
function authority(): { key: KeyObject; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const hex = `0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`;
  const signer = signerFromPublicKey(hex);
  if (signer === null) throw new Error('could not derive signer from throwaway key');
  return { key: privateKey, fingerprint: signer.fingerprint };
}

const ARTIFACT_SHA = '0x' + 'ab'.repeat(32);

/**
 * The facts a receipt asserts. Defaults describe a well-formed, correct, same-controller, settled-success
 * receipt; a case overrides only what it is probing. Fields marked (attestation) default into the matching
 * signed component so the happy path cross-matches; a case can diverge them to exercise a mismatch.
 */
interface Facts {
  result: ReceiptResult;
  verified_correct: VerifiedCorrect; // (evaluation attestation)
  settled: boolean;
  settlement_outcome: SettlementOutcome;
  independence_class: IndependenceClass;
  maker_controller: string;
  eval_checker_controller: string; // (evaluation attestation) — authoritative for independence
  artifact_hash: string;
  sandbox_artifact_sha256: string; // (sandbox attestation) — defaults to artifact_hash
  evaluation_version: string;
  settlement_event_id: string;
  experiment_id: string;
  settle_experiment_id: string; // (settlement attestation) — defaults to experiment_id
}

function facts(over: Partial<Facts> = {}): Facts {
  const base: Facts = {
    result: 'correct',
    verified_correct: 'correct',
    settled: true,
    settlement_outcome: 'success',
    independence_class: 'same_controller_measured',
    maker_controller: 'controller-A',
    eval_checker_controller: 'controller-A',
    artifact_hash: ARTIFACT_SHA,
    sandbox_artifact_sha256: ARTIFACT_SHA,
    evaluation_version: 'eval-v1',
    settlement_event_id: 'settle-evt-1',
    experiment_id: 'exp-0001',
    settle_experiment_id: 'exp-0001',
  };
  const merged = { ...base, ...over };
  // Keep the attestation mirrors tracking their composite field unless the case overrode them explicitly.
  if (over.artifact_hash !== undefined && over.sandbox_artifact_sha256 === undefined) merged.sandbox_artifact_sha256 = over.artifact_hash;
  if (over.experiment_id !== undefined && over.settle_experiment_id === undefined) merged.settle_experiment_id = over.experiment_id;
  return merged;
}

/** Authorities whose keys sign each leg. A case can swap one in to sign with an UNTRUSTED key. */
interface SignWith {
  combined?: KeyObject;
  sandbox?: KeyObject;
  evaluation?: KeyObject;
  settlement?: KeyObject;
}

function make(over: Partial<Facts> = {}, signWith: SignWith = {}): { receipt: SignedCombinedReceipt; trustRoots: CombinedReceiptTrustRoots } {
  const f = facts(over);
  const combined = authority();
  const sandbox = authority();
  const evaluation = authority();
  const settlement = authority();

  const sandbox_attestation = signComponentAttestation(
    SANDBOX_ATTESTATION_DOMAIN,
    { mission_id: 'mission-42', artifact_sha256: f.sandbox_artifact_sha256, profile_checks: [{ name: 'seccomp', passed: true }], airlock_decision: 'promote' as const },
    signWith.sandbox ?? sandbox.key,
  );
  const evaluation_attestation = signComponentAttestation(
    EVALUATION_ATTESTATION_DOMAIN,
    { verified_correct: f.verified_correct, evaluation_version: f.evaluation_version, checker_id: 'agent-checker', checker_controller: f.eval_checker_controller, oracle_set_id: 'ak-set-7' },
    signWith.evaluation ?? evaluation.key,
  );
  const settlement_attestation = signComponentAttestation(
    SETTLEMENT_ATTESTATION_DOMAIN,
    { settlement_event_id: f.settlement_event_id, settlement_outcome: f.settlement_outcome, experiment_id: f.settle_experiment_id, maker_id: 'agent-maker', checker_id: 'agent-checker' },
    signWith.settlement ?? settlement.key,
  );

  const input: CombinedReceiptInput = {
    artifact_hash: f.artifact_hash,
    evaluation_version: f.evaluation_version,
    policy_digest: '0x' + '11'.repeat(32),
    execution_sha: '0x' + '22'.repeat(32),
    experiment_id: f.experiment_id,
    ruler: { oracle_set_id: 'ak-set-7', hash: '0x' + '33'.repeat(32) },
    mode: 'active',
    identities: { maker_id: 'agent-maker', maker_controller: f.maker_controller, checker_id: 'agent-checker' },
    executed: true,
    contained: ['seccomp', 'network_egress_blocked'],
    settled: f.settled,
    settlement_event_id: f.settlement_event_id,
    settlement_outcome: f.settlement_outcome,
    independence_class: f.independence_class,
    sandbox_attestation,
    evaluation_attestation,
    settlement_attestation,
    result: f.result,
  };

  const receipt = signCombinedReceipt(buildCombinedReceipt(input), signWith.combined ?? combined.key);
  const trustRoots: CombinedReceiptTrustRoots = {
    combined: [{ fingerprint: combined.fingerprint }],
    sandbox: [{ fingerprint: sandbox.fingerprint }],
    evaluation: [{ fingerprint: evaluation.fingerprint }],
    settlement: [{ fingerprint: settlement.fingerprint }],
  };
  return { receipt, trustRoots };
}

describe('combined trust receipt — anti-forgery verifier', () => {
  it('accepts a well-formed correct, same-controller, settled-success receipt', () => {
    const { receipt, trustRoots } = make();
    expect(verifyCombinedReceipt(receipt, trustRoots)).toEqual({ ok: true, reasons: [] });
  });

  // ── Issue A: the headline new test ────────────────────────────────────────────────────────────
  it('1. refuses an internally-consistent, composite-signed receipt whose sandbox_attestation is signed by an untrusted key', () => {
    // A rogue key signs the sandbox leg; its signature is VALID but the key is in nobody's sandbox trust root.
    const rogue = generateKeyPairSync('ed25519').privateKey;
    const { receipt, trustRoots } = make({}, { sandbox: rogue });
    const v = verifyCombinedReceipt(receipt, trustRoots);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('sandbox_untrusted_signer');
  });

  // ── Issue B: a legitimate negative settlement ─────────────────────────────────────────────────
  it('2. accepts a verified-incorrect result that settles a negative (failure) delta', () => {
    const { receipt, trustRoots } = make({ result: 'incorrect', verified_correct: 'incorrect', settled: true, settlement_outcome: 'failure' });
    expect(verifyCombinedReceipt(receipt, trustRoots)).toEqual({ ok: true, reasons: [] });
  });

  it('3. refuses an incorrect result represented as a settled success', () => {
    const { receipt, trustRoots } = make({ result: 'incorrect', verified_correct: 'incorrect', settled: true, settlement_outcome: 'success' });
    const v = verifyCombinedReceipt(receipt, trustRoots);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('incorrect_claimed_success');
  });

  it('4. refuses when the settlement attestation names a different experiment_id than the composite', () => {
    const { receipt, trustRoots } = make({ experiment_id: 'exp-0001', settle_experiment_id: 'exp-9999' });
    const v = verifyCombinedReceipt(receipt, trustRoots);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('identifier_mismatch:experiment_id');
  });

  it('5. refuses independent_counterparty when the SIGNED evaluation checker shares the maker controller', () => {
    const { receipt, trustRoots } = make({
      independence_class: 'independent_counterparty',
      maker_controller: 'controller-A',
      eval_checker_controller: 'controller-A',
    });
    const v = verifyCombinedReceipt(receipt, trustRoots);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('false_independence');
  });

  // ── kept guarantees, updated to the new interface ─────────────────────────────────────────────
  it('refuses a tampered composite signature (one flipped byte)', () => {
    const { receipt, trustRoots } = make();
    const c = receipt.signature[20];
    const flipped = receipt.signature.slice(0, 20) + (c === 'a' ? 'b' : 'a') + receipt.signature.slice(21);
    expect(flipped).not.toBe(receipt.signature);
    const v = verifyCombinedReceipt({ ...receipt, signature: flipped }, trustRoots);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('signature_invalid');
  });

  it('refuses a swapped artifact_hash after signing (recombination)', () => {
    const { receipt, trustRoots } = make();
    const tampered = { ...receipt, artifact_hash: '0x' + 'ff'.repeat(32) };
    const v = verifyCombinedReceipt(tampered, trustRoots);
    expect(v.ok).toBe(false);
    // The swap diverges from the signed sandbox attestation...
    expect(v.reasons).toContain('identifier_mismatch:artifact_hash');
    // ...and breaks the content hash and the composite signature too (defense in depth).
    expect(v.reasons).toContain('content_hash_mismatch');
    expect(v.reasons).toContain('signature_invalid');
  });

  it('refuses a settled receipt with no evaluation (missing_evaluation)', () => {
    // not_scorable ↔ missing_evaluation is internally consistent, so this isolates settled_without_evaluation.
    const { receipt, trustRoots } = make({ result: 'not_scorable', verified_correct: 'missing_evaluation', settled: true, settlement_outcome: 'failure' });
    const v = verifyCombinedReceipt(receipt, trustRoots);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('settled_without_evaluation');
  });

  it('refuses a replayed experiment_id', () => {
    const { receipt, trustRoots } = make();
    expect(verifyCombinedReceipt(receipt, trustRoots).ok).toBe(true);
    const seen = new Set<string>([receipt.experiment_id]);
    const v = verifyCombinedReceipt(receipt, trustRoots, seen);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('experiment_replayed');
  });

  it('refuses a well-formed receipt whose composite signer is untrusted', () => {
    const { receipt, trustRoots } = make();
    const v = verifyCombinedReceipt(receipt, { ...trustRoots, combined: [] }); // nobody trusted for the composite
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('untrusted_signer');
  });
});
