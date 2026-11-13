/**
 * service-delivery-check.ts: did the provider deliver what the contract asked for? SHADOW ONLY.
 *
 * WHY (D-170, replaces P-10's HAL gate). The HAL verdict on a SERVICE_FULFILLED row judges the
 * buyer's `payload.content`, not the provider's `result`. On a verification contract that content
 * is the CLAIM the buyer wants checked, so a HAL veto there says "HAL thinks the claim is false",
 * not "the provider did bad work". Gating credit on it would have withheld credit from providers
 * who answered correctly, sometimes because HAL itself was wrong. So this module never gates.
 * It records, per contract, what can be checked about the DELIVERY, so a later gate (if any) is
 * built on a measurement and not on a guess.
 *
 * Per service type:
 *   verification        The claim "[The] Base Sepolia chain id is <n>" has a known answer:
 *                       BASE_SEPOLIA_CHAIN_ID. The provider's `claim_is` is scored against it, and
 *                       so is HAL's verdict on the same claim, which makes HAL's error rate
 *                       measurable. Any other claim has no ground truth here: NOT CHECKED, with
 *                       both verdicts recorded so their agreement can still be counted.
 *   decentralized_storage  sha256 of the buyer's content is recomputed and compared with the
 *                       provider's content_hash, storage_path and size_bytes.
 *   anything else       NOT CHECKED (no deterministic check). Judging a free-text artifact is the
 *                       service-quality hook's job (SERVICE_QUALITY_HOOK_MODE); a second HAL call
 *                       here would be a second verdict on the same artifact that can disagree.
 *
 * NOT CHECKED IS NOT FAILED. A provider that answered UNDETERMINED (e.g. the RPC was down), a
 * result without the field to compare, or a claim with no known answer is `not_checked`, never
 * `wrong`.
 *
 * SERVICE_DELIVERY_CHECK_MODE: unset / 'off' = nothing runs, no new metadata (byte-for-byte today);
 * 'shadow' = the provider's SERVICE_FULFILLED row carries `delivery_check`. There is no enforce:
 * no number, no on-chain write and no public page changes in any mode (CLAUDE_RULES r23). Any other
 * value, 'enforce' included, behaves as 'shadow' and says so once.
 */
import { createHash } from 'crypto';
import { BASE_SEPOLIA_CHAIN_ID } from './testnet-only';

export type ClaimIs = 'TRUE' | 'FALSE' | 'UNDETERMINED';
export type DeliveryCheckMode = 'off' | 'shadow';
export type DeliveryOutcome = 'correct' | 'wrong' | 'not_checked';

// ponytail: one claim shape, read against Base Sepolia only. The content must be exactly
// "[The] Base Sepolia chain id is <n>[.]". Any other phrasing, another chain, or a compound claim
// falls to the validator vote, unchecked. Widen this when a second verifiable claim type is bought.
// Lives here, not in the handler, so this leaf module adds no import cycle
// (handler -> handler base -> delta writer -> this file).
export const BASE_SEPOLIA_CHAIN_ID_CLAIM = /^\s*(?:the\s+)?base sepolia chain id is (\d+)\.?\s*$/i;

export interface DeliveryCheck {
  mode: 'shadow';
  service_type: string | null;
  outcome: DeliveryOutcome;
  /** What the outcome rests on: the check that ran, or why none could. */
  basis: string;
  /** verification only: what the provider said the claim is. */
  provider_claim_is?: ClaimIs | null;
  /** verification only: the known answer, when one exists. */
  truth?: 'TRUE' | 'FALSE' | null;
  /** verification only: HAL's verdict on the same claim, when a real (non-degraded) fact-check ran. */
  hal_claim_is?: ClaimIs | null;
  /** verification only: HAL against the known answer. null when either is missing. */
  hal_correct?: boolean | null;
}

/** The verdict applyServiceFulfilledDeltas computes; undefined when HAL did not run. */
export type HalVerdict = { hal_score: number; hal_decision: string; hal_signals?: unknown } | undefined;

let warnedRaw: string | undefined;
export function deliveryCheckMode(raw: string | undefined = process.env.SERVICE_DELIVERY_CHECK_MODE): DeliveryCheckMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v !== 'shadow' && warnedRaw !== raw) {
    warnedRaw = raw;
    console.warn(`[service-delivery-check] SERVICE_DELIVERY_CHECK_MODE=${JSON.stringify(raw)} is not off|shadow; behaving as 'shadow' (records, changes no number; there is no enforce)`);
  }
  return 'shadow';
}

/**
 * HAL's verdict read as a claim verdict, or null when HAL did not actually check it. Only a
 * fact-check with 2+ providers counts: the extractor barely discriminates (gap -0.020) and a
 * degraded fact-check includes the local keyword-guess fallback (Strix, #1542).
 */
export function halClaimIs(hal: HalVerdict): ClaimIs | null {
  const s = hal?.hal_signals as { mode?: unknown; degraded?: unknown } | null | undefined;
  if (!s || s.mode !== 'fact-check' || s.degraded === true) return null;
  if (hal!.hal_decision === 'vetoed') return 'FALSE';
  if (hal!.hal_decision === 'clean') return 'TRUE';
  return 'UNDETERMINED';
}

const asClaimIs = (v: unknown): ClaimIs | null => (v === 'TRUE' || v === 'FALSE' || v === 'UNDETERMINED' ? v : null);

function checkVerification(payload: any, result: any, hal: HalVerdict): DeliveryCheck {
  const provider = asClaimIs(result?.claim_is);
  const halIs = halClaimIs(hal);
  const m = BASE_SEPOLIA_CHAIN_ID_CLAIM.exec(String(payload?.content ?? ''));
  const truth: 'TRUE' | 'FALSE' | null = m ? (Number(m[1]) === BASE_SEPOLIA_CHAIN_ID ? 'TRUE' : 'FALSE') : null;
  const base = {
    mode: 'shadow' as const, service_type: 'verification', provider_claim_is: provider, truth, hal_claim_is: halIs,
    hal_correct: truth && (halIs === 'TRUE' || halIs === 'FALSE') ? halIs === truth : null,
  };
  if (!truth) return { ...base, outcome: 'not_checked', basis: 'no_ground_truth' };
  if (!provider) return { ...base, outcome: 'not_checked', basis: 'result_has_no_claim_is' };
  if (provider === 'UNDETERMINED') return { ...base, outcome: 'not_checked', basis: 'provider_undetermined' };
  return { ...base, outcome: provider === truth ? 'correct' : 'wrong', basis: 'chain_id_constant' };
}

function checkStorage(payload: any, result: any): DeliveryCheck {
  const base = { mode: 'shadow' as const, service_type: 'decentralized_storage' };
  // ponytail: proves the receipt matches the content, not that the object is still in the bucket.
  // Add a bucket read when storage contracts have real volume (2 ever, last 2026-05-28).
  if (typeof payload?.content !== 'string') return { ...base, outcome: 'not_checked', basis: 'no_content' };
  if (typeof result?.content_hash !== 'string') return { ...base, outcome: 'not_checked', basis: 'result_has_no_hash' };
  const buf = Buffer.from(payload.content, payload.content_type === 'binary' ? 'base64' : 'utf-8');
  const h = createHash('sha256').update(buf).digest('hex');
  const ok = result.content_hash === h && result.storage_path === `${h.slice(0, 2)}/${h.slice(2, 4)}/${h}` && result.size_bytes === buf.length;
  return { ...base, outcome: ok ? 'correct' : 'wrong', basis: 'content_hash' };
}

/** Pure and synchronous. Never throws: an unexpected shape is `not_checked`, `check_error`. */
export function checkDelivery(input: { serviceType: string | null; payload: unknown; result: unknown; hal: HalVerdict }): DeliveryCheck {
  try {
    if (input.serviceType === 'verification') return checkVerification(input.payload, input.result, input.hal);
    if (input.serviceType === 'decentralized_storage') return checkStorage(input.payload, input.result);
    return { mode: 'shadow', service_type: input.serviceType, outcome: 'not_checked', basis: 'no_deterministic_check' };
  } catch {
    return { mode: 'shadow', service_type: input.serviceType, outcome: 'not_checked', basis: 'check_error' };
  }
}
