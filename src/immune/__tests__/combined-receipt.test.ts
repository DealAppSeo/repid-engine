/**
 * Regression tests for the combined trust receipt and its anti-forgery verifier.
 *
 * A throwaway Ed25519 keypair is generated in-process (node:crypto); nothing is read from env, so the
 * module's "signing key is a parameter" contract is exercised exactly as production would use it.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { signerFromPublicKey } from '../../kernel/receipt-signing';
import {
  buildCombinedReceipt,
  signCombinedReceipt,
  verifyCombinedReceipt,
  type CombinedReceiptInput,
  type SignedCombinedReceipt,
} from '../combined-receipt';

/** A throwaway key plus the trusted-signer entry that matches it. */
function throwawayKey(): { key: KeyObject; trusted: { fingerprint: string }[] } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const hex = `0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`;
  const signer = signerFromPublicKey(hex);
  if (signer === null) throw new Error('could not derive signer from throwaway key');
  return { key: privateKey, trusted: [{ fingerprint: signer.fingerprint }] };
}

const ARTIFACT_SHA = '0x' + 'ab'.repeat(32);

/** A well-formed, correct, same-controller, settled receipt input. Override per case. */
function baseInput(over: Partial<CombinedReceiptInput> = {}): CombinedReceiptInput {
  return {
    artifact_hash: ARTIFACT_SHA,
    evaluation_version: 'eval-v1',
    policy_digest: '0x' + '11'.repeat(32),
    execution_sha: '0x' + '22'.repeat(32),
    experiment_id: 'exp-0001',
    ruler: { answer_key_set_id: 'ak-set-7', hash: '0x' + '33'.repeat(32) },
    mode: 'active',
    identities: {
      maker_id: 'agent-maker',
      maker_controller: 'controller-A',
      checker_id: 'agent-checker',
      checker_controller: 'controller-A',
    },
    executed: true,
    contained: ['seccomp', 'network_egress_blocked'],
    verified_correct: 'correct',
    settled: true,
    settlement_event_id: 'settle-evt-1',
    independence_class: 'same_controller_measured',
    sandbox: {
      schema_id: 'trustshell-sandbox-receipt/1',
      mission_id: 'mission-42',
      artifact_sha256: ARTIFACT_SHA,
      profile_checks: [
        { name: 'seccomp', passed: true },
        { name: 'no_network', passed: true },
      ],
      airlock_decision: 'promote',
    },
    result: 'correct',
    ...over,
  };
}

function signed(over: Partial<CombinedReceiptInput> = {}): { receipt: SignedCombinedReceipt; trusted: { fingerprint: string }[]; key: KeyObject } {
  const { key, trusted } = throwawayKey();
  const receipt = signCombinedReceipt(buildCombinedReceipt(baseInput(over)), key);
  return { receipt, trusted, key };
}

describe('combined trust receipt — anti-forgery verifier', () => {
  it('1. accepts a well-formed correct, same-controller, settled receipt', () => {
    const { receipt, trusted } = signed();
    const v = verifyCombinedReceipt(receipt, trusted);
    expect(v).toEqual({ ok: true, reasons: [] });
  });

  it('2. refuses an incorrect result that claims to be settled', () => {
    const { receipt, trusted } = signed({ result: 'incorrect', verified_correct: 'incorrect', settled: true });
    const v = verifyCombinedReceipt(receipt, trusted);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('incorrect_but_settled');
  });

  it('3. refuses independent_counterparty when maker and checker share a controller', () => {
    const { receipt, trusted } = signed({
      independence_class: 'independent_counterparty',
      identities: {
        maker_id: 'agent-maker',
        maker_controller: 'controller-A',
        checker_id: 'agent-checker',
        checker_controller: 'controller-A',
      },
    });
    const v = verifyCombinedReceipt(receipt, trusted);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('false_independence');
  });

  it('4. refuses a tampered signature (one flipped byte)', () => {
    const { receipt, trusted } = signed();
    // Flip a hex char well inside the signature so it stays 0x + 128 hex but no longer verifies.
    const c = receipt.signature[20];
    const flipped = receipt.signature.slice(0, 20) + (c === 'a' ? 'b' : 'a') + receipt.signature.slice(21);
    expect(flipped).not.toBe(receipt.signature);
    const v = verifyCombinedReceipt({ ...receipt, signature: flipped }, trusted);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('signature_invalid');
  });

  it('5. refuses a swapped artifact_hash after signing (recombination)', () => {
    const { receipt, trusted } = signed();
    const tampered = { ...receipt, artifact_hash: '0x' + 'ff'.repeat(32) };
    const v = verifyCombinedReceipt(tampered, trusted);
    expect(v.ok).toBe(false);
    // The swap unbinds the artifact from its sandbox provenance...
    expect(v.reasons).toContain('artifact_hash_unbound');
    // ...and breaks the content hash and the signature too (defense in depth).
    expect(v.reasons).toContain('content_hash_mismatch');
    expect(v.reasons).toContain('signature_invalid');
  });

  it('6. refuses a missing evaluation that claims to be settled', () => {
    const { receipt, trusted } = signed({ verified_correct: 'missing_evaluation', settled: true, result: 'correct' });
    const v = verifyCombinedReceipt(receipt, trusted);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('settled_without_evaluation');
  });

  it('7. refuses a replayed experiment_id', () => {
    const { receipt, trusted } = signed();
    // Clean on first sight.
    expect(verifyCombinedReceipt(receipt, trusted).ok).toBe(true);
    // Already consumed on replay.
    const seen = new Set<string>([receipt.experiment_id]);
    const v = verifyCombinedReceipt(receipt, trusted, seen);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('experiment_replayed');
  });

  it('also refuses a well-formed receipt signed by an untrusted key', () => {
    const { receipt } = signed();
    const v = verifyCombinedReceipt(receipt, []); // nobody trusted
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('untrusted_signer');
  });
});
