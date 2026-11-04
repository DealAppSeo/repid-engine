/**
 * execution-origin.test.ts — origin is authenticated ONLY against pinned roots the Maker cannot forge.
 * A forger who holds the receipt's ephemeral keys but self-signs the admission is refused (untrusted_signer);
 * no pinned root is fail-closed; replay / expiry / binding / scope mismatches all refuse.
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { signerFromPublicKey } from '../../kernel/receipt-signing';
import {
  signMissionAdmission, signOwnerGrant, verifyExecutionOrigin,
  type OriginRoot, type MissionAdmissionPayload, type OwnerGrantPayload,
} from '../execution-origin';

function keyAndRoot(): { key: KeyObject; root: OriginRoot } {
  const key = generateKeyPairSync('ed25519').privateKey;
  const x = String(createPublicKey(key).export({ format: 'jwk' }).x);
  const fp = signerFromPublicKey('0x' + Buffer.from(x, 'base64url').toString('hex'))!.fingerprint;
  return { key, root: { fingerprint: fp } };
}

const NOW = 1_000_000;
const admissionPayload = (over: Partial<MissionAdmissionPayload> = {}): MissionAdmissionPayload => ({
  mission_id: 'm1', source_commit: 'deadbeef', workflow_id: 'wf/approved', artifact_digest: '0xaa',
  owner_grant_id: 'g1', nonce: 'n1', issued_at: NOW - 100, expires_at: NOW + 100, ...over,
});
const grantPayload = (over: Partial<OwnerGrantPayload> = {}): OwnerGrantPayload => ({
  grant_id: 'g1', owner_principal: 'owner', mission_id: 'm1', approved_capabilities: ['run'], policy_version: 'p1',
  scope: '*', not_before: NOW - 100, not_after: NOW + 100, ...over,
});
const BIND = { mission_id: 'm1', artifact_digest: '0xaa' };

describe('verifyExecutionOrigin — authenticate against roots the Maker cannot control', () => {
  it('authentic when admission + grant verify under pinned roots and bind the mission + artifact', () => {
    const a = keyAndRoot(), o = keyAndRoot();
    const v = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload(), a.key), ownerGrant: signOwnerGrant(grantPayload(), o.key), binding: BIND },
      { admissionRoots: [a.root], ownerRoots: [o.root], now: NOW },
    );
    expect(v.authentic).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('fail-closed by default: no pinned roots ⇒ not authentic', () => {
    const a = keyAndRoot(), o = keyAndRoot();
    const v = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload(), a.key), ownerGrant: signOwnerGrant(grantPayload(), o.key), binding: BIND },
      { now: NOW },
    );
    expect(v.authentic).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(['no_admission_root', 'no_owner_root']));
  });

  it('REFUSES an admission the forger self-signed (valid signature, but NOT a pinned authority)', () => {
    const forger = keyAndRoot(); // the attacker's own key
    const a = keyAndRoot();      // the real admission root the forger does not hold
    const o = keyAndRoot();
    const v = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload(), forger.key), ownerGrant: signOwnerGrant(grantPayload(), o.key), binding: BIND },
      { admissionRoots: [a.root], ownerRoots: [o.root], now: NOW },
    );
    expect(v.authentic).toBe(false);
    expect(v.reasons).toContain('admission_untrusted_signer');
  });

  it('refuses a replayed nonce and an expired admission', () => {
    const a = keyAndRoot(), o = keyAndRoot();
    const replayed = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload(), a.key), ownerGrant: signOwnerGrant(grantPayload(), o.key), binding: BIND },
      { admissionRoots: [a.root], ownerRoots: [o.root], seenNonces: new Set(['n1']), now: NOW },
    );
    expect(replayed.reasons).toContain('admission_replayed');
    const expired = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload({ expires_at: NOW - 1 }), a.key), ownerGrant: signOwnerGrant(grantPayload(), o.key), binding: BIND },
      { admissionRoots: [a.root], ownerRoots: [o.root], now: NOW },
    );
    expect(expired.reasons).toContain('admission_expired');
  });

  it('refuses a mismatched artifact and a scope that does not cover the mission', () => {
    const a = keyAndRoot(), o = keyAndRoot();
    const wrongArtifact = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload({ artifact_digest: '0xbb' }), a.key), ownerGrant: signOwnerGrant(grantPayload(), o.key), binding: BIND },
      { admissionRoots: [a.root], ownerRoots: [o.root], now: NOW },
    );
    expect(wrongArtifact.reasons).toContain('admission_artifact_mismatch');
    const wrongScope = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload(), a.key), ownerGrant: signOwnerGrant(grantPayload({ scope: 'other-mission' }), o.key), binding: BIND },
      { admissionRoots: [a.root], ownerRoots: [o.root], now: NOW },
    );
    expect(wrongScope.reasons).toContain('owner_grant_scope_mismatch');
  });

  it('refuses when admission and grant disagree (grant id)', () => {
    const a = keyAndRoot(), o = keyAndRoot();
    const v = verifyExecutionOrigin(
      { admission: signMissionAdmission(admissionPayload({ owner_grant_id: 'g-OTHER' }), a.key), ownerGrant: signOwnerGrant(grantPayload(), o.key), binding: BIND },
      { admissionRoots: [a.root], ownerRoots: [o.root], now: NOW },
    );
    expect(v.reasons).toContain('admission_grant_mismatch');
  });
});
