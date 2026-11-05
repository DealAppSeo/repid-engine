/**
 * receipt-binding-d147.test.ts — the Receipt v2 binding, attacked (D-147).
 *
 * Sean's brief: "Attack it with swapped deliverables, changed acceptance criteria, forged PASS, stale origin,
 * replay and incorrect settlement." Each test binds a receipt, then presents TAMPERED material and asserts the
 * tamper is named — never silently accepted. Origin authenticity (stale/replay) runs for real against the
 * tested `verifyExecutionOrigin` primitive with pinned test roots, not a stub.
 */
// receipt-binding -> receipt-issuer imports ../db (config throws without SUPABASE env). Factory-mock it; the
// binding module never touches the db, it only borrows receipt-issuer's pure keccak helper.
jest.mock('../../db', () => ({ db: {} }));
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  buildReceiptBinding,
  verifyReceiptBinding,
  receiptBinding,
  bindingContentHash,
  evaluationSpecHash,
  RECEIPT_BINDING_VERSION,
  type BindingMaterial,
  type OriginEvidence,
} from '../receipt-binding';
import { signMissionAdmission, signOwnerGrant } from '../../immune/execution-origin';
import type { CanonicalWorkStatement } from '../work-statement-spec';

const NOW = 1_800_000_000_000;
const admKey = generateKeyPairSync('ed25519').privateKey;
const ownerKey = generateKeyPairSync('ed25519').privateKey;
const sha = (s: string): string => '0x' + createHash('sha256').update(s, 'utf8').digest('hex');

const STATEMENT: CanonicalWorkStatement = {
  acceptance_criteria: [
    { n: 1, text: 'Every claimed program includes a verifiable public source URL.' },
    { n: 2, text: 'No eligibility rule is stated that the cited source does not support.' },
  ],
  agreed_price: { amount_usdc_raw: 500000, currency: 'USDC' },
  deadline: '2026-12-01T00:00:00.000Z',
  deliverable: 'A 500-word sourced brief on OC recuperative-care discharge options.',
};
const DELIVERABLE = 'the produced brief text (data only, hashed, never executed)';
const ARTIFACT_DIGEST = sha(DELIVERABLE);

// Pinned external roots = the fingerprints of the admission/owner keys (fingerprint depends on the key, not the payload).
const admFp = signMissionAdmission(
  { mission_id: 'x', source_commit: 'x', workflow_id: 'x', artifact_digest: '0x00', owner_grant_id: 'x', nonce: 'x', issued_at: 0, expires_at: 0 },
  admKey,
).signer.fingerprint;
const ownerFp = signOwnerGrant(
  { grant_id: 'x', owner_principal: 'x', mission_id: 'x', approved_capabilities: [], policy_version: 'x', scope: '*', not_before: 0, not_after: 0 },
  ownerKey,
).signer.fingerprint;
const admissionRoots = [{ fingerprint: admFp }];
const ownerRoots = [{ fingerprint: ownerFp }];
const AUTH = { admissionRoots, ownerRoots, now: NOW };

function makeOrigin(opts: { nonce?: string; expiresAt?: number; missionId?: string; artifactDigest?: string } = {}): OriginEvidence {
  const mission_id = opts.missionId ?? 'mission-1';
  const artifact_digest = opts.artifactDigest ?? ARTIFACT_DIGEST;
  const ownerGrant = signOwnerGrant(
    { grant_id: 'grant-1', owner_principal: 'owner-abc', mission_id, approved_capabilities: ['settle'], policy_version: 'p1', scope: '*', not_before: NOW - 1000, not_after: NOW + 10_000_000 },
    ownerKey,
  );
  const admission = signMissionAdmission(
    { mission_id, source_commit: 'c0ffee', workflow_id: 'wf-approved', artifact_digest, owner_grant_id: 'grant-1', nonce: opts.nonce ?? 'nonce-1', issued_at: NOW - 1000, expires_at: opts.expiresAt ?? NOW + 10_000_000 },
    admKey,
  );
  return { mission_id, artifact_digest, experiment_id: 'contract-abc', admission, ownerGrant };
}

const material = (over: Partial<BindingMaterial> = {}): BindingMaterial => ({
  deliverableBytes: DELIVERABLE,
  workStatement: STATEMENT,
  origin: makeOrigin(),
  controllerAssurance: 'proven_wallet',
  settledEvidenceId: 'settlement-1',
  ...over,
});

const SIGNED = buildReceiptBinding(material()); // what the engine would have committed + signed over

describe('Receipt v2 binding (D-147)', () => {
  it('HAPPY PATH: untampered material against an authentic origin verifies clean', () => {
    const v = verifyReceiptBinding(SIGNED, material(), AUTH);
    expect(v.ok).toBe(true);
    expect(v.mismatches).toEqual([]);
  });

  it('ATTACK swapped deliverable: a different deliverable is caught, nothing else', () => {
    const v = verifyReceiptBinding(SIGNED, material({ deliverableBytes: 'a SWAPPED deliverable the holder substituted' }), AUTH);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toContain('deliverable_swapped');
    expect(v.mismatches).not.toContain('work_statement_changed');
  });

  it('ATTACK forged PASS: a PASS minted for different work hashes differently → deliverable_swapped', () => {
    // A forged PASS has no legitimate deliverable to bind to; presenting it means presenting other bytes.
    const v = verifyReceiptBinding(SIGNED, material({ deliverableBytes: 'work that was never evaluated but claims PASS' }), AUTH);
    expect(v.mismatches).toContain('deliverable_swapped');
  });

  it('ATTACK changed acceptance criteria: softened criteria are caught', () => {
    const softened: CanonicalWorkStatement = {
      ...STATEMENT,
      acceptance_criteria: [
        { n: 1, text: 'The brief mentions at least one program by its program name.' }, // weaker than "verifiable source URL"
        { n: 2, text: 'No eligibility rule is stated that the cited source does not support.' },
      ],
    };
    const v = verifyReceiptBinding(SIGNED, material({ workStatement: softened }), AUTH);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toContain('evaluation_spec_changed'); // the headline
    expect(v.mismatches).toContain('work_statement_changed');  // and the whole contract hash moved too
  });

  it('ATTACK stale origin: an origin valid at issue but expired at verify is not authentic (origin hash still matches)', () => {
    const staleAtVerify = makeOrigin({ expiresAt: NOW + 100 });
    const mat = material({ origin: staleAtVerify });
    const signed = buildReceiptBinding(mat); // bound while still valid
    const v = verifyReceiptBinding(signed, mat, { admissionRoots, ownerRoots, now: NOW + 100_000 }); // verified after expiry
    expect(v.ok).toBe(false);
    expect(v.mismatches).toEqual(['origin_not_authentic']); // the origin wasn't swapped — it went stale
    expect(v.originReasons).toContain('admission_expired');
  });

  it('ATTACK replay: a previously-seen admission nonce is refused', () => {
    const mat = material();
    const signed = buildReceiptBinding(mat);
    const v = verifyReceiptBinding(signed, mat, { ...AUTH, seenNonces: new Set(['nonce-1']) });
    expect(v.mismatches).toEqual(['origin_not_authentic']);
    expect(v.originReasons).toContain('admission_replayed');
  });

  it('ATTACK substituted origin: a different (internally valid) origin is caught by the bound origin hash', () => {
    const v = verifyReceiptBinding(SIGNED, material({ origin: makeOrigin({ missionId: 'mission-OTHER' }) }), AUTH);
    expect(v.mismatches).toContain('execution_origin_changed');
  });

  it('ATTACK incorrect settlement: reusing the receipt against another settlement is caught', () => {
    const v = verifyReceiptBinding(SIGNED, material({ settledEvidenceId: 'settlement-OTHER' }), AUTH);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toEqual(['settlement_mismatch']);
  });

  it('ATTACK stapled deliverable: a deliverable that is not the origin-attested artifact is caught, nothing else fires', () => {
    // The six fields are each internally self-consistent AND the origin is authentic — but the deliverable the
    // receipt commits to is NOT the artifact the admission attested. Only a cross-check between deliverable_sha256
    // and the origin's artifact_digest catches a real deliverable stapled onto an unrelated authentic run.
    const OTHER = 'a different deliverable the admission never attested';
    const mat = material({ deliverableBytes: OTHER }); // origin still attests H(DELIVERABLE), not H(OTHER)
    const stapled = buildReceiptBinding(mat);          // deliverable_sha256 = H(OTHER); execution_origin binds the authentic origin
    expect(mat.origin.artifact_digest).toBe(sha(DELIVERABLE)); // the origin attests the ORIGINAL artifact
    expect(stapled.deliverable_sha256).toBe(sha(OTHER));       // the receipt commits a DIFFERENT deliverable
    const v = verifyReceiptBinding(stapled, mat, AUTH);
    expect(v.ok).toBe(false);
    expect(v.mismatches).toEqual(['deliverable_origin_mismatch']); // the ONLY failure — every other field is self-consistent
  });

  it('ATTACK downgraded controller assurance: administrative is not the signed proven_wallet', () => {
    const v = verifyReceiptBinding(SIGNED, material({ controllerAssurance: 'administrative' }), AUTH);
    expect(v.mismatches).toContain('controller_assurance_changed');
  });

  it('NO SILENT UPGRADE: a v1 receipt has no binding and is never treated as v2-verified', () => {
    expect(receiptBinding({ type: 'hyperdag.repid.receipt.v1', work: {} })).toBeNull();
    expect(receiptBinding({ binding: { version: 1 } })).toBeNull(); // wrong version is not a v2 binding
    expect(receiptBinding({ binding: SIGNED })).toMatchObject({ version: RECEIPT_BINDING_VERSION });
    const v = verifyReceiptBinding(null, material(), AUTH);
    expect(v.ok).toBe(false);
    expect(v.originReasons).toEqual(['no_v2_binding']);
  });

  it('the binding content hash is deterministic and moves when any bound field moves (it is what the signature covers)', () => {
    expect(bindingContentHash(SIGNED)).toBe(bindingContentHash(buildReceiptBinding(material())));
    expect(bindingContentHash(SIGNED)).not.toBe(bindingContentHash(buildReceiptBinding(material({ settledEvidenceId: 'other' }))));
  });

  it('evaluationSpecHash isolates the criteria: same criteria same hash, changed criteria new hash', () => {
    expect(evaluationSpecHash(STATEMENT)).toBe(evaluationSpecHash({ ...STATEMENT, deliverable: 'a totally different deliverable string' }));
    expect(evaluationSpecHash(STATEMENT)).not.toBe(
      evaluationSpecHash({ ...STATEMENT, acceptance_criteria: [{ n: 1, text: 'One single far weaker acceptance criterion only.' }] }),
    );
  });

  it('with NO pinned roots (the inert default) origin is never authentic — a real check must supply roots', () => {
    const v = verifyReceiptBinding(SIGNED, material(), { now: NOW }); // no admissionRoots/ownerRoots
    expect(v.mismatches).toContain('origin_not_authentic');
    expect(v.originReasons).toEqual(expect.arrayContaining(['no_admission_root', 'no_owner_root']));
  });
});
