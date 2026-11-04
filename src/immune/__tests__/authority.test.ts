/**
 * authority.test.ts — the engine-side authentic → authoritative decision (D-129 B+A).
 *
 * A receipt is authoritative ONLY with a valid harness signature AND a matching config-pin AND the engine's
 * protected-env flag on. These tests sign real `{ receipt, signature }` envelopes (the same bytes the harness
 * signs: canonicalJson of `receipt`) with a throwaway key and a passport matching SLICE_PINNED_CONFIG, then drop
 * one leg at a time. The flag defaults off, so PR CI is never authoritative.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalJson } from '../../services/owner-authorization';
import { SLICE_PINNED_CONFIG } from '../config-pin';
import { establishAuthority } from '../authority';

/** A passport whose measurements match the pin. */
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

/** A harness-signed `{ receipt, signature }` envelope whose passport matches the pin. */
function signedEnvelope(): { receipt: Record<string, unknown>; signature: string; key: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubB64url = String(publicKey.export({ format: 'jwk' }).x);
  const receipt: Record<string, unknown> = {
    schema: 'trustshell.sandbox-mission-receipt/v2',
    mission_id: 'mission-xyz',
    keys: { harness: { alg: 'ed25519', public_key: pubB64url } },
    passport: matchingPassport(),
  };
  const signature = sign(null, Buffer.from(canonicalJson(receipt), 'utf8'), privateKey).toString('base64');
  return { receipt, signature, key: privateKey };
}

/** Re-sign a (mutated) receipt so the signature stays valid — isolates config/flag failures from sig failures. */
const reSign = (receipt: Record<string, unknown>, key: KeyObject): string =>
  sign(null, Buffer.from(canonicalJson(receipt), 'utf8'), key).toString('base64');

describe('authority — authentic → authoritative (D-129 B+A)', () => {
  it('authoritative only with signature + config-pin + the engine flag on', () => {
    const { receipt, signature } = signedEnvelope();
    const d = establishAuthority({ receipt, signature }, { enabled: true });
    expect(d.authoritative).toBe(true);
    expect(d.signature_verified).toBe(true);
    expect(d.config.matched).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it('default (flag off) is NOT authoritative — PR CI stays a demonstration', () => {
    const { receipt, signature } = signedEnvelope();
    const d = establishAuthority({ receipt, signature }); // enabled defaults to IMMUNE_ENGINE_AUTHORITY (unset)
    expect(d.authoritative).toBe(false);
    expect(d.signature_verified).toBe(true);
    expect(d.config.matched).toBe(true);
    expect(d.reasons).toContain('engine_authority_disabled');
  });

  it('refuses a config drift even with the flag on and a valid signature', () => {
    const { receipt, key } = signedEnvelope();
    (receipt as any).passport.passport.permissions.value.privileged = true;
    const d = establishAuthority({ receipt, signature: reSign(receipt, key) }, { enabled: true });
    expect(d.signature_verified).toBe(true); // the sig is valid over the drifted receipt...
    expect(d.authoritative).toBe(false); // ...but the config no longer matches the pin
    expect(d.reasons).toContain('config_pin:permissions.privileged');
  });

  it('refuses a tampered (bad-signature) receipt even with a matching config', () => {
    const { receipt, signature } = signedEnvelope();
    (receipt as any).mission_id = 'tampered-after-signing'; // keep the old signature
    const d = establishAuthority({ receipt, signature }, { enabled: true });
    expect(d.signature_verified).toBe(false);
    expect(d.authoritative).toBe(false);
    expect(d.reasons).toContain('sandbox_signature_invalid');
  });

  it('fails closed when the passport is absent, flag on', () => {
    const { receipt, key } = signedEnvelope();
    delete (receipt as any).passport;
    const d = establishAuthority({ receipt, signature: reSign(receipt, key) }, { enabled: true });
    expect(d.authoritative).toBe(false);
    expect(d.reasons).toContain('config_pin:passport_absent');
  });
});
