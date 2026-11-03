/**
 * immune/config-pin.ts — check a sandbox receipt's passport config measurements against the committed pin.
 *
 * DEFENSE IN DEPTH, NOT AUTHENTICITY (read this first). The passport is SELF-SIGNED by the mission's EPHEMERAL
 * harness key, and its own `not_proven` note says a matching passport only means "the supervisor measured the
 * same configuration twice" — a hostile producer can fabricate a passport carrying these exact values. So a
 * config-pin match is NECESSARY, never SUFFICIENT: authenticity rests on the ENGINE anchoring with its pinned
 * attester (D-129, option B+A). This module answers only "does the measured config equal the approved config?",
 * fail-closed, and says nothing about who produced it.
 *
 * The approved values are the measurements of the slice's committed, pinned configuration: the image digest the
 * workflow pins (.github/workflows/immune-slice.yml, the pinned node:22-alpine digest), the worker program, the
 * tool-belt manifest, a VALID Guard policy in force, the run-as / dropped-caps / no-new-privileges permissions,
 * and the read-only rootfs. A drift in any of them FAILS the pin — which is the point: the config changed and
 * must be re-approved (re-pinned) deliberately, not slipped through.
 *
 * WHY policy is pinned by STATE, not by digest [V 2026-11-03, two real CI bundles]: the passport's
 * `policy.value.sha256` is the digest of the Guard policy file in the supervisor home, and it DIFFERS per mission
 * even for otherwise byte-identical config (efb77197… vs 00ff581f… across the two legs) — it is a per-mission
 * value, not a committed constant. Pinning it would false-reject half of all legitimate bundles. So we pin the
 * stable, security-relevant invariant instead: a VALID policy was enforced (`policy.value.state === 'ok'`).
 */

export interface PinnedConfig {
  /** the pinned image digest — equal to the workflow's pinned node:22-alpine digest (a test guards the two in sync). */
  pinned_digest: string;
  program_sha256: string;
  manifest_sha256: string;
  /** the Guard policy STATE (a valid policy was in force); NOT the per-mission policy digest — see the header note. */
  policy_state: string;
  permissions: { user: string; cap_drop: readonly string[]; cap_add: readonly string[]; privileged: boolean; security_opt: readonly string[] };
  isolation: { readonly_rootfs: boolean };
}

/**
 * The approved config for the Immune slice (the measurements of its committed, pinned configuration, read from
 * a real CI bundle's passport). `pinned_digest` MUST equal the workflow's pinned digest — config-pin.test.ts
 * reads .github/workflows/immune-slice.yml and fails if they drift.
 */
export const SLICE_PINNED_CONFIG: PinnedConfig = {
  pinned_digest: 'sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914',
  program_sha256: 'c64fa51ffd3e709e8ec28a0541b5409f9b4689e5219557448fc9b084359392e0',
  manifest_sha256: '3be3600a558dbca7791e63da9f082584e8901e945d3ae2709909ee63c6f4de72',
  policy_state: 'ok',
  permissions: { user: '65534:65534', cap_drop: ['ALL'], cap_add: [], privileged: false, security_opt: ['no-new-privileges'] },
  isolation: { readonly_rootfs: true },
};

export interface ConfigPinResult {
  /** true only when every pinned field is present AND equals the approved value. */
  matched: boolean;
  /** one entry per field that is absent or differs from the pin (empty when matched). */
  mismatches: string[];
}

/** Order-stable structural compare. undefined (an absent field) never equals a pinned value, so it is a mismatch. */
const canon = (v: unknown): string | undefined => (v === undefined ? undefined : JSON.stringify(v));

/**
 * Compare a sandbox receipt's passport config against `pinned`. `innerReceipt` is the SIGNED body
 * (envelope.receipt), whose `passport.passport` holds the TrustMedic measurements. Never throws. Fail-closed:
 * a missing passport, a missing field, or any differing value is a mismatch — never silently a pass.
 */
export function checkConfigPin(innerReceipt: unknown, pinned: PinnedConfig = SLICE_PINNED_CONFIG): ConfigPinResult {
  const p = (innerReceipt as { passport?: { passport?: Record<string, { value?: Record<string, unknown> }> } })?.passport?.passport;
  if (p == null || typeof p !== 'object') return { matched: false, mismatches: ['passport_absent'] };

  const mismatches: string[] = [];
  const eq = (field: string, actual: unknown, expected: unknown): void => {
    if (canon(actual) !== canon(expected)) mismatches.push(field);
  };
  eq('pinned_digest', p['model_build']?.value?.['pinned_digest'], pinned.pinned_digest);
  eq('program_sha256', p['identity']?.value?.['program_sha256'], pinned.program_sha256);
  eq('manifest_sha256', p['tool_belt']?.value?.['manifest_sha256'], pinned.manifest_sha256);
  eq('policy_state', p['policy']?.value?.['state'], pinned.policy_state);
  // permissions / isolation: pin the security-relevant fields (deep-equal on the pinned subset).
  const perm = (p['permissions']?.value ?? {}) as Record<string, unknown>;
  eq('permissions.user', perm['user'], pinned.permissions.user);
  eq('permissions.cap_drop', perm['cap_drop'], pinned.permissions.cap_drop);
  eq('permissions.cap_add', perm['cap_add'], pinned.permissions.cap_add);
  eq('permissions.privileged', perm['privileged'], pinned.permissions.privileged);
  eq('permissions.security_opt', perm['security_opt'], pinned.permissions.security_opt);
  eq('isolation.readonly_rootfs', p['isolation']?.value?.['readonly_rootfs'], pinned.isolation.readonly_rootfs);

  return { matched: mismatches.length === 0, mismatches };
}
