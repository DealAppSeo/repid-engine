/**
 * service-hal-gate.ts — a fulfilled contract earns canonical RepID only when HAL actually checked
 * the deliverable and passed it.
 *
 * WHY (D-144, measured 2026-11-04): every SERVICE_FULFILLED award moved canonical RepID whatever
 * HAL said. Deliverables HAL had VETOED still earned, and most "clean" ones had never run HAL at
 * all: `applyValidationEvent` writes 'clean' / 0.5 as a placeholder when no verdict is passed.
 * Deception paid. The fix D-144 chose is this gate on the live SERVICE delta, not the
 * three-condition fence object (independence stays with SAME_OWNER_SETTLEMENT_MODE).
 *
 * SERVICE_HAL_GATE_MODE (mirrors SAME_OWNER_SETTLEMENT_MODE, same-owner-settlement.ts):
 *   unset / 'off'  nothing read, no new metadata: byte-for-byte today.
 *   'shadow'       every SERVICE_FULFILLED row records `service_hal_gate`
 *                  (would_not_count: vetoed | flagged | abstain | hal_not_run | unrecognized | null);
 *                  no number changes.
 *   'enforce'      those rows earn 0 canonical RepID, and (like same-owner enforce) the ERC-8004
 *                  write the provider row leads to is skipped.
 * Anything else behaves as 'shadow' and says so once: a typo must not silently switch the gate on.
 *
 * NO PENALTY (Sean, D-144: "no automatic penalty simply because HAL flags a problem"): a withheld
 * award earns 0 and keeps its `ungated_delta`; it is never subtracted.
 *
 * NOT CHECKED IS NOT FAILED. Two reasons are infrastructure, not a verdict on the work:
 *   hal_error     HAL threw (the writer's catch); nothing was assessed.
 *   hal_degraded  fewer than 2 fact-check providers answered: either the extractor fallback ran (by
 *                 the writer's own measurement it barely discriminates, gap -0.020) or fact-check
 *                 returned `degraded: true` (one provider, or the local keyword-guess fallback).
 *                 Neither 'clean' is a pass.
 * They are withheld like the rest but tagged apart, with `ungated_delta`, so a re-check can credit
 * them later. No backfill job exists yet.
 *
 * SCOPE: SERVICE_FULFILLED only, the one service path where a real HAL verdict exists today.
 * SERVICE_SATISFIED and SERVICE_OUTCOME never run HAL, so gating them on it would withhold every
 * award; that needs a measured decision first (D-144 step 4), not this file.
 */
export type ServiceHalGateMode = 'off' | 'shadow' | 'enforce';
export type HalGateReason = 'vetoed' | 'flagged' | 'abstain' | 'hal_not_run' | 'hal_error' | 'hal_degraded' | 'unrecognized';

/** The verdict applyServiceFulfilledDeltas passes to applyValidationEvent; undefined when HAL did not run. */
export type HalVerdict = { hal_score: number; hal_decision: string; hal_signals?: unknown } | undefined;

let warnedRaw: string | undefined;
export function serviceHalGateMode(raw: string | undefined = process.env.SERVICE_HAL_GATE_MODE): ServiceHalGateMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v === 'shadow' || v === 'enforce') return v;
  if (warnedRaw !== raw) {
    warnedRaw = raw;
    console.warn(`[service-hal-gate] SERVICE_HAL_GATE_MODE=${JSON.stringify(raw)} is not off|shadow|enforce; behaving as 'shadow' (records, changes no number)`);
  }
  return 'shadow';
}

/**
 * Why HAL does not vouch for this deliverable, or null when it ran and passed it.
 * "Ran" means a real verdict carrying hal_signals (D-144's definition); a missing verdict is the
 * 'clean' placeholder and must never read as clean.
 */
export function halGateReason(hal: HalVerdict, errored = false): HalGateReason | null {
  if (errored) return 'hal_error';
  if (!hal || hal.hal_signals === undefined || hal.hal_signals === null) return 'hal_not_run';
  const signals = hal.hal_signals as { mode?: unknown; degraded?: unknown };
  if (signals.mode === 'extractor-fallback') return 'hal_degraded';
  // Fewer than 2 providers answered. Includes the HAL_LOCAL_FALLBACK_ENABLED keyword guess, which
  // reports mode 'fact-check' with providers_used 1: a substring match is never a pass (Strix, #1542).
  if (signals.mode === 'fact-check' && signals.degraded === true) return 'hal_degraded';
  switch (hal.hal_decision) {
    case 'clean': return null;
    case 'vetoed': case 'flagged': case 'abstain': return hal.hal_decision;
    default: return 'unrecognized';
  }
}

export interface ServiceHalGateTag {
  mode: Exclude<ServiceHalGateMode, 'off'>;
  hal_ran: boolean;
  would_not_count: HalGateReason | null;
  /** false only under enforce: this row's delta was withheld. */
  counted: boolean;
  /** What the row would carry without this gate (after the same-owner gate). */
  ungated_delta: number;
}
type Side = { delta: number; meta: { service_hal_gate?: ServiceHalGateTag } };

/**
 * Gate one fulfilled contract's provider and buyer deltas on the deliverable's HAL verdict.
 * 'off' returns them untouched with empty metadata. Both sides follow the deliverable: a trade
 * HAL did not vouch for is not evidence for either party.
 */
export function gateServiceHal(
  deltas: { provider: number; buyer: number },
  hal: HalVerdict,
  mode: ServiceHalGateMode = serviceHalGateMode(),
  /** true when HAL threw: recorded as hal_error, not as "never ran". */
  errored = false,
): { provider: Side; buyer: Side } {
  if (mode === 'off') return { provider: { delta: deltas.provider, meta: {} }, buyer: { delta: deltas.buyer, meta: {} } };
  const reason = halGateReason(hal, errored);
  const withhold = mode === 'enforce' && reason !== null;
  const halRan = reason !== 'hal_not_run' && reason !== 'hal_error';
  const side = (d: number): Side => ({
    delta: withhold ? 0 : d,
    meta: { service_hal_gate: { mode, hal_ran: halRan, would_not_count: reason, counted: !withhold, ungated_delta: d } },
  });
  return { provider: side(deltas.provider), buyer: side(deltas.buyer) };
}
