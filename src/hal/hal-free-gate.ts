/**
 * hal-free-gate.ts — free-tier gate for the HAL fact-check OpenRouter backfill.
 *
 * The OpenRouter backfill (fact-check.ts ~2015) defaults to the PAID slug
 * `qwen/qwen-2.5-72b-instruct` and honours the operator override
 * `HAL_S2_OPENROUTER_MODEL` — which may itself be paid. Neither is gated by the
 * fleet's free-tier gate (that lives in trinity-symphony-shared/callLLM); this is a
 * SECOND, independent paid path. See E:\dev\living-docs\ENGINE_HAL_GATE.md.
 *
 * Rule (Sean, 2026-09-10): allow_paid = false until Sean writes `paid <loop>`
 * (recorded as env SEAN_PAID_LOOP). While false, a paid OpenRouter slug must not
 * fire — neither the paid default nor a paid operator override. Fall back to a
 * VERIFIED-LIVE `:free` slug instead.
 *
 * Pure over its inputs (env injected) so the decision is unit-testable without a
 * network call. It does NOT dial anything; it only decides which model string the
 * caller feeds to resolveModelFor, and whether the operator pin should be dropped.
 *
 * NOTE on family independence: the free default is an nvidia `:free` slug, the same
 * family as nvidia-nim if that provider is also present — so the quorum may count them
 * as one family (one vote) rather than two. That is an accepted narrowing while
 * allow_paid=false: a free-but-narrower quorum beats a broader-but-paid one under the
 * hold. Widen it by authorising paid, or by setting HAL_S2_OPENROUTER_MODEL to a live
 * `:free` slug of a family the quorum lacks.
 */

/** A slug is treated as free iff it explicitly ends `:free`. Everything else is paid. */
export function isFreeSlug(model: string | undefined | null): boolean {
  return typeof model === 'string' && model.trim().endsWith(':free');
}

/**
 * allow_paid is false unless SEAN_PAID_LOOP (or the legacy ALLOW_PAID) is set to a
 * value that is not an explicit hold. Same contract as the fleet gate so the two
 * repos flip together on one env.
 */
export function halAllowPaid(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.SEAN_PAID_LOOP ?? env.ALLOW_PAID ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'hold' || v === 'no') return false;
  return true;
}

export interface OpenRouterGateInput {
  /** The operator override, i.e. process.env.HAL_S2_OPENROUTER_MODEL (trimmed) or undefined. */
  operatorModel?: string;
  /** The current paid default the code ships (qwen/qwen-2.5-72b-instruct). */
  paidDefault: string;
  /** A VERIFIED-LIVE `:free` slug to use under the hold (nvidia/nemotron-3-ultra-550b-a55b:free). */
  freeDefault: string;
  /** Result of halAllowPaid(). */
  allowPaid: boolean;
}

export interface OpenRouterGateResult {
  /** The staticDefault to pass to resolveModelFor/add(). */
  staticDefault: string;
  /**
   * Pass through to resolveModelFor's ignoreOperatorModel. True when we are refusing a
   * paid operator override so the env pin cannot win precedence over our free staticDefault.
   */
  ignoreOperatorModel: boolean;
  /** One-line reason, logged when the paid model was refused. */
  reason: string;
}

/**
 * Decide the OpenRouter backfill model under the free-tier gate.
 *
 * - allow_paid=true  → today's behaviour exactly: operator override honoured, else paid default.
 * - allow_paid=false → NEVER the paid slug. Honour a `:free` operator override; otherwise force
 *   the free default and drop the (paid or unset) operator pin.
 */
export function gateOpenRouterModel(input: OpenRouterGateInput): OpenRouterGateResult {
  const { operatorModel, paidDefault, freeDefault, allowPaid } = input;
  const op = operatorModel?.trim() || undefined;

  if (allowPaid) {
    return { staticDefault: paidDefault, ignoreOperatorModel: false, reason: 'allow_paid=true — paid slugs permitted' };
  }
  // allow_paid = false: refuse every paid slug.
  if (op && isFreeSlug(op)) {
    // Operator pinned a :free slug — honour it, but pass it as the static default with the
    // operator pin dropped so the decision is unambiguous (the pin and the static agree anyway).
    return { staticDefault: op, ignoreOperatorModel: true, reason: `allow_paid=false — using operator :free slug ${op}` };
  }
  // Operator unset, or set to a PAID slug → refuse it and force the verified free default.
  return {
    staticDefault: freeDefault,
    ignoreOperatorModel: true,
    reason: op
      ? `allow_paid=false — REFUSED paid HAL_S2_OPENROUTER_MODEL='${op}', using ${freeDefault}`
      : `allow_paid=false — paid default suppressed, using ${freeDefault}`,
  };
}
