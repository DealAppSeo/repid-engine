/**
 * repid-clamp.ts — one definition of the legal RepID range.
 *
 * THE BUG THIS CLOSES. `repid_agents` carries
 *   CHECK (current_repid >= 10 AND current_repid <= 10000)
 * and the documented pipeline (engine/repid-update.ts:503) clamps to exactly that
 * before writing. The LIVE pipeline did not:
 *
 *   scoring/pipeline.ts:421  runScoreEvent       old + delta          — no clamp at all
 *   scoring/pipeline.ts:648  applyValidationEvent Math.max(0, …)      — floor 0, no ceiling
 *
 * Both produce out-of-range values, and the database then REJECTS the write
 * (23514) rather than clamping it. That failure mode is backwards from what you
 * want: a clamp turns an extreme penalty into "you hit the floor", while a
 * rejected write turns it into "nothing happened". **The penalty large enough to
 * matter is the one most likely to be silently dropped**, and the same at the top
 * — an agent at 9,990 taking +30 fails to write instead of capping.
 *
 * Measured 2026-08-02: runScoreEvent produced all 35,501 score events of the last
 * 30 days, so this was the live path, unclamped, the whole time.
 *
 * WHY A MODULE AND NOT A LOCAL FIX. Three call sites already disagreed about the
 * range. A fourth would too. Same discipline as the service manifest and the
 * badge: one computation, imported, so divergence needs a deliberate act.
 */

/** Matches repid_agents_current_repid_check exactly. Changing one requires changing both. */
export const REPID_MIN = 10;
export const REPID_MAX = 10000;

export interface ClampResult {
  value: number;
  /** True when the raw value was outside the legal range. */
  clamped: boolean;
  raw: number;
  bound?: 'floor' | 'ceiling';
}

/**
 * Round, then clamp into the range the database will actually accept.
 *
 * Rounding first matters: clamping a fractional 9999.6 to the ceiling and then
 * rounding would give 10000 either way, but flooring 10.4 before the clamp would
 * silently produce 10 rather than 10 — same answer here, different answer for any
 * future non-integer bound. Round then clamp is the order that stays correct.
 */
export function clampRepid(raw: number): ClampResult {
  const rounded = Math.round(Number.isFinite(raw) ? raw : REPID_MIN);
  if (rounded < REPID_MIN) {
    return { value: REPID_MIN, clamped: true, raw: rounded, bound: 'floor' };
  }
  if (rounded > REPID_MAX) {
    return { value: REPID_MAX, clamped: true, raw: rounded, bound: 'ceiling' };
  }
  return { value: rounded, clamped: false, raw: rounded };
}

/**
 * Clamp and say so out loud when it bites.
 *
 * A clamp that fires is information, not noise: it means an agent hit the floor
 * or the ceiling, which is exactly the event an operator wants to know about and
 * exactly what the rejected-write behaviour was hiding.
 */
export function clampRepidLoud(raw: number, context: { agentId: string; eventType?: string }): number {
  const r = clampRepid(raw);
  if (r.clamped) {
    console.warn(
      `[repid-clamp] ${r.bound?.toUpperCase()} HIT agent=${context.agentId} ` +
        `event=${context.eventType ?? 'unknown'} raw=${r.raw} → ${r.value}. ` +
        `Before this clamp existed the write was rejected by the DB CHECK and the score did not move.`,
    );
  }
  return r.value;
}
