/**
 * immune/authority.ts — the protected-engine decision that makes a combined trust receipt AUTHORITATIVE (D-130).
 *
 * A receipt is authoritative — safe for the engine to anchor with its pinned attester — only when ALL FOUR hold:
 *   1. the sandbox receipt's harness signature VERIFIES (tamper-evidence; sandbox-receipt-verify.ts), AND
 *   2. its passport config MATCHES the committed pin (config-pin.ts), AND
 *   3. its execution ORIGIN is AUTHENTICATED — a mission admission (trusted runner) + owner grant, each signed by
 *      a PINNED EXTERNAL root the Maker does not control, cross-bound to this mission + artifact (execution-origin.ts), AND
 *   4. this runs in the ENGINE's protected env (IMMUNE_ENGINE_AUTHORITY=1), never in PR CI.
 *
 * WHY 3 IS THE GATE (Grok + Chat, independently). Conditions 1–2 are self-asserted: the harness key is ephemeral
 * and the passport self-signed, so a hostile producer can sign AND config-match a fabricated receipt. Without an
 * authenticated origin the engine would LAUNDER that into its attester. Condition 3 rests on roots the Maker cannot
 * forge, so a correctly self-signed, config-matching receipt with no valid admission is REFUSED even with the flag on.
 *
 * NO CALLER OVERRIDE (D-130 P0-a). The production decision is DERIVED here from verified evidence: `enabled` is read
 * from the env ONLY, and the signature is VERIFIED here — neither is a caller-provided boolean or an injected result.
 * The admission, owner grant, and pinned roots come from the ENGINE's protected context, never from the untrusted
 * receipt. The default (no roots, no admission) is fail-closed: not authentic ⇒ not authoritative.
 */
import { verifySandboxReceipt } from './sandbox-receipt-verify';
import { checkConfigPin, SLICE_PINNED_CONFIG, type PinnedConfig, type ConfigPinResult } from './config-pin';
import { verifyExecutionOrigin, type OriginBinding, type OriginRoot, type OriginVerification } from './execution-origin';

export interface AuthorityDecision {
  /** signature + config-pin + authenticated origin + the engine's protected env — the only state safe to anchor. */
  authoritative: boolean;
  signature_verified: boolean;
  config: ConfigPinResult;
  origin: OriginVerification;
  engine_enabled: boolean;
  /** why NOT authoritative (empty when authoritative). */
  reasons: string[];
}

/**
 * What the protected engine supplies to decide authority. `envelope` is the untrusted sandbox `{ receipt, signature }`;
 * `binding` is the mission + artifact the engine is deciding on; `admission`/`ownerGrant`/roots are the engine's
 * protected context. Omitting the admission/roots is fail-closed (origin not authentic ⇒ not authoritative).
 */
export interface AuthorityInput {
  envelope: unknown;
  binding: OriginBinding;
  admission?: unknown;
  ownerGrant?: unknown;
  pinned?: PinnedConfig;
  admissionRoots?: readonly OriginRoot[];
  ownerRoots?: readonly OriginRoot[];
  seenNonces?: ReadonlySet<string>;
  now?: number;
}

/** Read the protected-env flag HERE, never from a caller — a PR job cannot force it on (D-130 P0-a). */
const engineEnabled = (): boolean => process.env['IMMUNE_ENGINE_AUTHORITY'] === '1';

/**
 * Decide whether a combined receipt backed by this sandbox evidence is AUTHORITATIVE. Never throws. Every input
 * that matters is derived here (the env flag, the signature verification) or comes from the engine's protected
 * context (admission, owner grant, roots) — nothing authoritative can be asserted by a caller-supplied boolean.
 */
export function establishAuthority(input: AuthorityInput): AuthorityDecision {
  const enabled = engineEnabled(); // derived here; never a caller override
  const sig = verifySandboxReceipt(input.envelope); // verified here; never a caller-injected result
  const receipt = (input.envelope as { receipt?: unknown } | null)?.receipt;
  const config = checkConfigPin(receipt, input.pinned ?? SLICE_PINNED_CONFIG);
  const origin = verifyExecutionOrigin(
    { admission: input.admission, ownerGrant: input.ownerGrant, binding: input.binding },
    { admissionRoots: input.admissionRoots, ownerRoots: input.ownerRoots, seenNonces: input.seenNonces, now: input.now },
  );

  const reasons: string[] = [];
  if (!sig.verified) reasons.push('sandbox_signature_invalid');
  if (!config.matched) reasons.push(...config.mismatches.map((m) => `config_pin:${m}`));
  if (!origin.authentic) reasons.push(...origin.reasons.map((r) => `origin:${r}`));
  if (!enabled) reasons.push('engine_authority_disabled');

  return {
    authoritative: enabled && sig.verified && config.matched && origin.authentic,
    signature_verified: sig.verified,
    config,
    origin,
    engine_enabled: enabled,
    reasons,
  };
}
