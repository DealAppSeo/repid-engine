/**
 * config-pin.test.ts — the passport config-pin matches the approved config and fails closed on any drift.
 *
 * `matchingReceipt()` builds an inner receipt body (envelope.receipt) whose `passport.passport` carries exactly
 * the approved SLICE_PINNED_CONFIG measurements; each test drifts one and asserts the mismatch. A guard test keeps
 * the pinned digest in lockstep with the workflow's PINNED_DIGEST so a bumped image can't silently keep the pin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkConfigPin, SLICE_PINNED_CONFIG } from '../config-pin';

/** An inner receipt body whose passport matches SLICE_PINNED_CONFIG exactly. */
function matchingReceipt(): Record<string, unknown> {
  const c = SLICE_PINNED_CONFIG;
  return {
    passport: {
      passport: {
        schema: 'trustshell.trustmedic-passport/v0',
        identity: { value: { kind: 'sandbox-worker', program_sha256: c.program_sha256 } },
        model_build: { value: { pinned_digest: c.pinned_digest, image_ref: 'node:22-alpine@' + c.pinned_digest } },
        tool_belt: { value: { manifest_sha256: c.manifest_sha256 } },
        // sha256 here is per-mission (not pinned); the pin is on policy.state — see config-pin.ts header.
        policy: { value: { state: c.policy_state, sha256: 'a'.repeat(64) } },
        permissions: { value: { ...c.permissions } },
        isolation: { value: { readonly_rootfs: c.isolation.readonly_rootfs, 'tmpfs./tmp': 'noexec,nosuid,nodev,size=64m' } },
      },
    },
  };
}

describe('config-pin — passport measurements vs the committed pin', () => {
  it('matches a passport carrying the approved config (no mismatches)', () => {
    const r = checkConfigPin(matchingReceipt());
    expect(r.matched).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('fails closed when the passport is absent', () => {
    expect(checkConfigPin({}).mismatches).toEqual(['passport_absent']);
    expect(checkConfigPin(null).mismatches).toEqual(['passport_absent']);
  });

  it('flags a drifted image digest (a different image ran)', () => {
    const rec = matchingReceipt() as any;
    rec.passport.passport.model_build.value.pinned_digest = 'sha256:' + 'de'.repeat(32);
    const r = checkConfigPin(rec);
    expect(r.matched).toBe(false);
    expect(r.mismatches).toContain('pinned_digest');
  });

  it('flags a drifted worker program and an invalid guard policy state', () => {
    const rec = matchingReceipt() as any;
    rec.passport.passport.identity.value.program_sha256 = 'ab'.repeat(32);
    rec.passport.passport.policy.value.state = 'missing';
    expect(checkConfigPin(rec).mismatches).toEqual(expect.arrayContaining(['program_sha256', 'policy_state']));
  });

  it('a per-mission policy digest does NOT fail the pin (only policy.state is pinned)', () => {
    const rec = matchingReceipt() as any;
    rec.passport.passport.policy.value.sha256 = 'ff'.repeat(32); // different per-mission digest — not a pinned field
    expect(checkConfigPin(rec).matched).toBe(true);
  });

  it('flags a weakened sandbox (privileged, caps re-added, writable rootfs)', () => {
    const rec = matchingReceipt() as any;
    rec.passport.passport.permissions.value.privileged = true;
    rec.passport.passport.permissions.value.cap_add = ['NET_ADMIN'];
    rec.passport.passport.isolation.value.readonly_rootfs = false;
    const r = checkConfigPin(rec);
    expect(r.matched).toBe(false);
    expect(r.mismatches).toEqual(expect.arrayContaining(['permissions.privileged', 'permissions.cap_add', 'isolation.readonly_rootfs']));
  });

  it('a missing single field is a mismatch, not a pass', () => {
    const rec = matchingReceipt() as any;
    delete rec.passport.passport.tool_belt.value.manifest_sha256;
    expect(checkConfigPin(rec).mismatches).toContain('manifest_sha256');
  });

  it('SLICE_PINNED_CONFIG.pinned_digest stays in sync with the workflow pin', () => {
    const yml = readFileSync(join(__dirname, '..', '..', '..', '.github', 'workflows', 'immune-slice.yml'), 'utf8');
    const m = yml.match(/PINNED_DIGEST:\s*(sha256:[0-9a-f]{64})/);
    expect(m?.[1]).toBe(SLICE_PINNED_CONFIG.pinned_digest);
  });
});
