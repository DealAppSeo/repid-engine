/**
 * authority.test.ts — the P0 gate (D-130). signature + config-pin + the engine flag are NOT enough: without an
 * AUTHENTICATED ORIGIN (admission + owner grant under pinned EXTERNAL roots), a receipt is never authoritative,
 * even with IMMUNE_ENGINE_AUTHORITY=1. The acceptance case is exactly the bypass the earlier three-condition test
 * demonstrated — kept here as a regression, now REFUSED. No caller can force the flag or inject the signature.
 */
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalJson } from '../../services/owner-authorization';
import { signerFromPublicKey } from '../../kernel/receipt-signing';
import { SLICE_PINNED_CONFIG } from '../config-pin';
import { signMissionAdmission, signOwnerGrant, type OriginRoot } from '../execution-origin';
import { establishAuthority } from '../authority';

const MISSION = 'mission-xyz';
const ARTIFACT = '0xabc123';

/** A passport whose measurements match the pin, so config-pin passes and only ORIGIN is in question. */
function matchingPassport(): Record<string, unknown> {
  const c = SLICE_PINNED_CONFIG;
  return {
    passport: {
      schema: 'trustshell.trustmedic-passport/v0',
      identity: { value: { kind: 'sandbox-worker', program_sha256: c.program_sha256 } },
      model_build: { value: { pinned_digest: c.pinned_digest } },
      tool_belt: { value: { manifest_sha256: c.manifest_sha256 } },
      policy: { value: { state: c.policy_state } },
      permissions: { value: { ...c.permissions } },
      isolation: { value: { readonly_rootfs: c.isolation.readonly_rootfs } },
    },
  };
}

/** A harness-signed sandbox envelope with a config-matching passport (sig + config both pass). */
function harnessEnvelope(): { receipt: Record<string, unknown>; signature: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubB64url = String(publicKey.export({ format: 'jwk' }).x);
  const receipt: Record<string, unknown> = {
    schema: 'trustshell.sandbox-mission-receipt/v2',
    mission_id: MISSION,
    keys: { harness: { alg: 'ed25519', public_key: pubB64url } },
    passport: matchingPassport(),
  };
  const signature = sign(null, Buffer.from(canonicalJson(receipt), 'utf8'), privateKey).toString('base64');
  return { receipt, signature };
}

function keyAndRoot(): { key: KeyObject; root: OriginRoot } {
  const key = generateKeyPairSync('ed25519').privateKey;
  const x = String(createPublicKey(key).export({ format: 'jwk' }).x);
  const fp = signerFromPublicKey('0x' + Buffer.from(x, 'base64url').toString('hex'))!.fingerprint;
  return { key, root: { fingerprint: fp } };
}
const admPayload = { mission_id: MISSION, source_commit: 'c', workflow_id: 'wf', artifact_digest: ARTIFACT, owner_grant_id: 'g1', nonce: 'n', issued_at: 0, expires_at: 2 ** 40 };
const grantPayload = { grant_id: 'g1', owner_principal: 'owner', mission_id: MISSION, approved_capabilities: ['run'], policy_version: 'p', scope: '*', not_before: 0, not_after: 2 ** 40 };
const BIND = { mission_id: MISSION, artifact_digest: ARTIFACT };

/** Run fn with the engine flag forced on/off, then restore — the flag is read from env, never a param. */
function withFlag(on: boolean, fn: () => void): void {
  const prev = process.env['IMMUNE_ENGINE_AUTHORITY'];
  if (on) process.env['IMMUNE_ENGINE_AUTHORITY'] = '1';
  else delete process.env['IMMUNE_ENGINE_AUTHORITY'];
  try { fn(); } finally {
    if (prev === undefined) delete process.env['IMMUNE_ENGINE_AUTHORITY'];
    else process.env['IMMUNE_ENGINE_AUTHORITY'] = prev;
  }
}

describe('authority — no authenticated origin ⇒ never authoritative, even with the flag on (P0)', () => {
  it('REGRESSION: sig + config + flag ON but NO admission ⇒ NOT authoritative (the bypass is closed)', () => {
    withFlag(true, () => {
      const d = establishAuthority({ envelope: harnessEnvelope(), binding: BIND });
      expect(d.signature_verified).toBe(true);
      expect(d.config.matched).toBe(true);
      expect(d.engine_enabled).toBe(true);
      expect(d.authoritative).toBe(false);
      expect(d.reasons).toContain('origin:no_admission_root');
    });
  });

  it('a forged, correctly self-signed, config-matching receipt is REFUSED with the flag on', () => {
    withFlag(true, () => {
      const forger = keyAndRoot(); // attacker self-signs the admission
      const a = keyAndRoot(), o = keyAndRoot(); // the real pinned roots the attacker lacks
      const d = establishAuthority({
        envelope: harnessEnvelope(), binding: BIND,
        admission: signMissionAdmission(admPayload, forger.key),
        ownerGrant: signOwnerGrant(grantPayload, o.key),
        admissionRoots: [a.root], ownerRoots: [o.root], now: 1,
      });
      expect(d.authoritative).toBe(false);
      expect(d.reasons).toContain('origin:admission_untrusted_signer');
    });
  });

  it('authoritative ONLY with sig + config + authenticated origin + flag on', () => {
    withFlag(true, () => {
      const a = keyAndRoot(), o = keyAndRoot();
      const d = establishAuthority({
        envelope: harnessEnvelope(), binding: BIND,
        admission: signMissionAdmission(admPayload, a.key),
        ownerGrant: signOwnerGrant(grantPayload, o.key),
        admissionRoots: [a.root], ownerRoots: [o.root], now: 1,
      });
      expect(d.origin.authentic).toBe(true);
      expect(d.authoritative).toBe(true);
      expect(d.reasons).toEqual([]);
    });
  });

  it('flag OFF ⇒ never authoritative even with everything else valid (no caller can force it on)', () => {
    withFlag(false, () => {
      const a = keyAndRoot(), o = keyAndRoot();
      const d = establishAuthority({
        envelope: harnessEnvelope(), binding: BIND,
        admission: signMissionAdmission(admPayload, a.key),
        ownerGrant: signOwnerGrant(grantPayload, o.key),
        admissionRoots: [a.root], ownerRoots: [o.root], now: 1,
      });
      expect(d.origin.authentic).toBe(true);
      expect(d.authoritative).toBe(false);
      expect(d.reasons).toContain('engine_authority_disabled');
    });
  });
});
