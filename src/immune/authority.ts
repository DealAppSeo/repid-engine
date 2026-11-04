/**
 * immune/authority.ts — the engine-side decision that makes a combined trust receipt AUTHORITATIVE (D-129, B+A).
 *
 * A receipt is authoritative — safe for the engine to anchor with its pinned attester — only when ALL hold:
 *   1. the sandbox receipt's harness signature VERIFIES (tamper-evidence; sandbox-receipt-verify.ts), AND
 *   2. its passport config MATCHES the committed pin (config-pin.ts), AND
 *   3. this runs in the ENGINE's protected env (IMMUNE_ENGINE_AUTHORITY=1), never in PR CI.
 *
 * Neither 1 nor 2 is authenticity on its own: the harness key is EPHEMERAL per mission and the passport is
 * self-signed, so a hostile producer can both sign and config-match a fabricated receipt. Authenticity comes
 * from the ENGINE — it runs this check inside its protected env and anchors under HYPERDAG_ATTESTOR_PRIVATE_KEY,
 * the stable on-chain root that already roots the 225 real ZKP anchors (D-129). The env flag is that protected-env
 * gate; default OFF => authoritative:false, so every PR-CI receipt stays a non-anchorable demonstration (r23,
 * shadow-until-ratified). Flipping the flag only enables the decision; the on-chain send itself stays MAJOR/HITL.
 */
import { verifySandboxReceipt, type SandboxReceiptVerification } from './sandbox-receipt-verify';
import { checkConfigPin, SLICE_PINNED_CONFIG, type PinnedConfig, type ConfigPinResult } from './config-pin';

export interface AuthorityDecision {
  /** verified AND config-pinned AND in the engine's protected env — the only state safe to anchor. */
  authoritative: boolean;
  signature_verified: boolean;
  config: ConfigPinResult;
  engine_enabled: boolean;
  /** why NOT authoritative (empty when authoritative). */
  reasons: string[];
}

/** True only in the engine's protected env; PR CI never sets it, so CI receipts are never authoritative. */
const engineEnabled = (): boolean => process.env['IMMUNE_ENGINE_AUTHORITY'] === '1';

/**
 * Decide whether the sandbox `{ receipt, signature }` envelope backs an AUTHORITATIVE receipt. Never throws.
 * `enabled` overrides the env gate (tests pass it explicitly); omit it to read the protected-env flag. Pass a
 * precomputed `signature` verification to avoid re-verifying when the caller already has one.
 */
export function establishAuthority(
  envelope: unknown,
  opts: { pinned?: PinnedConfig; enabled?: boolean; signature?: SandboxReceiptVerification } = {},
): AuthorityDecision {
  const enabled = opts.enabled ?? engineEnabled();
  const sig = opts.signature ?? verifySandboxReceipt(envelope);
  const config = checkConfigPin((envelope as { receipt?: unknown })?.receipt, opts.pinned ?? SLICE_PINNED_CONFIG);

  const reasons: string[] = [];
  if (!sig.verified) reasons.push('sandbox_signature_invalid');
  if (!config.matched) reasons.push(...config.mismatches.map((m) => `config_pin:${m}`));
  if (!enabled) reasons.push('engine_authority_disabled');

  return {
    authoritative: sig.verified && config.matched && enabled,
    signature_verified: sig.verified,
    config,
    engine_enabled: enabled,
    reasons,
  };
}
