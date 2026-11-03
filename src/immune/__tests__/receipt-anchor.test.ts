/**
 * receipt-anchor.test.ts — the on-chain anchor is INERT and gated.
 *
 * The chain write is INJECTED (a fake attestFn), so nothing here touches the network. The gates proved:
 *   - a DEMONSTRATION receipt (authoritative:false — what the slice emits) is REFUSED, never anchored;
 *   - a receipt that does not verify under the given roots is REFUSED;
 *   - an authoritative, verifying receipt with the flag OFF is prepared but NOT sent (dry-run; attestFn untouched);
 *   - the same receipt with the flag ON sends exactly one attestation carrying the receipt's content_hash.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { signerFromPublicKey } from '../../kernel/receipt-signing';
import {
  buildCombinedReceipt,
  signCombinedReceipt,
  signComponentAttestation,
  SANDBOX_ATTESTATION_DOMAIN,
  EVALUATION_ATTESTATION_DOMAIN,
  SETTLEMENT_ATTESTATION_DOMAIN,
  type CombinedReceiptInput,
  type CombinedReceiptTrustRoots,
  type SignedCombinedReceipt,
} from '../combined-receipt';
import { anchorReceipt, buildReceiptAnchor, IMMUNE_RECEIPT_PROOF_TYPE, type AttestFn } from '../receipt-anchor';

function authority(): { key: KeyObject; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const signer = signerFromPublicKey(`0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`);
  if (signer === null) throw new Error('bad throwaway key');
  return { key: privateKey, fingerprint: signer.fingerprint };
}

const ARTIFACT = '0x' + 'ab'.repeat(32);

/** A well-formed, correct, settled-success receipt. `authoritative` is whatever the case needs. */
function receiptWith(authoritative: boolean | undefined): { receipt: SignedCombinedReceipt; roots: CombinedReceiptTrustRoots } {
  const combined = authority(), sandbox = authority(), evaluation = authority(), settlement = authority();
  const input: CombinedReceiptInput = {
    artifact_hash: ARTIFACT,
    evaluation_version: 'eval-v1',
    policy_digest: '0x' + '11'.repeat(32),
    execution_sha: '0x' + '22'.repeat(32),
    experiment_id: 'exp-anchor-1',
    ruler: { oracle_set_id: 'set-1', hash: '0x' + '33'.repeat(32) },
    mode: 'shadow',
    identities: { maker_id: 'agent-maker-X', maker_controller: 'ctrl-A', checker_id: 'agent-checker' },
    executed: true,
    contained: ['seccomp'],
    settled: true,
    settlement_event_id: 'settle-1',
    settlement_outcome: 'success',
    independence_class: 'same_controller_measured',
    sandbox_attestation: signComponentAttestation(SANDBOX_ATTESTATION_DOMAIN, { mission_id: 'm1', artifact_sha256: ARTIFACT, profile_checks: [{ name: 'seccomp', passed: true }], airlock_decision: 'promote' }, sandbox.key),
    evaluation_attestation: signComponentAttestation(EVALUATION_ATTESTATION_DOMAIN, { verified_correct: 'correct', evaluation_version: 'eval-v1', checker_id: 'agent-checker', checker_controller: 'ctrl-A', oracle_set_id: 'set-1' }, evaluation.key),
    settlement_attestation: signComponentAttestation(SETTLEMENT_ATTESTATION_DOMAIN, { settlement_event_id: 'settle-1', settlement_outcome: 'success', experiment_id: 'exp-anchor-1', maker_id: 'agent-maker-X', checker_id: 'agent-checker' }, settlement.key),
    result: 'correct',
    ...(authoritative === undefined ? {} : { authoritative }),
  };
  const receipt = signCombinedReceipt(buildCombinedReceipt(input), combined.key);
  const roots: CombinedReceiptTrustRoots = {
    combined: [{ fingerprint: combined.fingerprint }],
    sandbox: [{ fingerprint: sandbox.fingerprint }],
    evaluation: [{ fingerprint: evaluation.fingerprint }],
    settlement: [{ fingerprint: settlement.fingerprint }],
  };
  return { receipt, roots };
}

const neverCalled: AttestFn = async () => {
  throw new Error('attestFn must NOT be called');
};

describe('immune receipt on-chain anchor — inert + gated', () => {
  it('REFUSES a demonstration receipt (authoritative:false), never anchoring a demo hash', async () => {
    const { receipt, roots } = receiptWith(false);
    const r = await anchorReceipt(receipt, roots, { enabled: true, attestFn: neverCalled });
    expect(r.anchored).toBe(false);
    expect(r.dry_run).toBe(false);
    expect(r.refused).toBe('non_authoritative_receipt');
  });

  it('REFUSES a receipt that is authoritative but absent its marker (default demo) too', async () => {
    const { receipt, roots } = receiptWith(undefined); // no authoritative field
    const r = await anchorReceipt(receipt, roots, { enabled: true, attestFn: neverCalled });
    expect(r.refused).toBe('non_authoritative_receipt');
  });

  it('REFUSES a receipt that does not verify under the given roots', async () => {
    const { receipt } = receiptWith(true);
    const wrong = receiptWith(true).roots; // a DIFFERENT bundle's roots
    const r = await anchorReceipt(receipt, wrong, { enabled: true, attestFn: neverCalled });
    expect(r.anchored).toBe(false);
    expect(r.refused).toBe('receipt_unverified');
  });

  it('DRY-RUN by default: an authoritative verifying receipt is prepared but NOT sent (attestFn untouched)', async () => {
    const { receipt, roots } = receiptWith(true);
    const r = await anchorReceipt(receipt, roots, { enabled: false, attestFn: neverCalled });
    expect(r.anchored).toBe(false);
    expect(r.dry_run).toBe(true);
    expect(r.refused).toBeUndefined();
    expect(r.content_hash).toBe(receipt.content_hash);
    expect(r.attest).toMatchObject({ merkleRoot: receipt.content_hash, proofType: IMMUNE_RECEIPT_PROOF_TYPE, agentId: 'agent-maker-X', tier: 'correct' });
  });

  it('ENABLED: sends exactly one attestation carrying the receipt content_hash, and reports the uid/tx', async () => {
    const { receipt, roots } = receiptWith(true);
    const calls: unknown[] = [];
    const fake: AttestFn = async (input) => {
      calls.push(input);
      return { uid: '0xuid', txHash: '0xtx' };
    };
    const r = await anchorReceipt(receipt, roots, { enabled: true, attestFn: fake });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { merkleRoot: string }).merkleRoot).toBe(receipt.content_hash);
    expect(r).toMatchObject({ anchored: true, dry_run: false, uid: '0xuid', txHash: '0xtx' });
  });

  it('buildReceiptAnchor maps the receipt onto the shared proof schema (pure)', () => {
    const { receipt } = receiptWith(true);
    expect(buildReceiptAnchor(receipt, 7)).toEqual({
      proofId: 7,
      agentId: 'agent-maker-X',
      tier: 'correct',
      merkleRoot: receipt.content_hash,
      proofType: IMMUNE_RECEIPT_PROOF_TYPE,
      repidSnapshot: 0,
    });
  });
});
