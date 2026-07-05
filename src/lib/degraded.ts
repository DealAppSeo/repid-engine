/**
 * markDegraded — "degrade loudly, never silently" helper.
 *
 * WHY THIS EXISTS: 17 days of undetected ZK-proving dormancy came from
 * silent fallbacks — a stub recorded as if it were a real proof, with no
 * alert. This util is the one place that makes a fallback LOUD and correctly
 * labeled: it stamps `degraded_mode: true` + `degraded_reason` on the returned
 * object AND emits a console.warn naming the reason, so a degraded run is
 * visible in the logs instead of masquerading as the real path.
 *
 * It only ADDS the loud signal — it never changes the fallback behavior itself.
 */

export interface DegradedFields {
  degraded_mode: true;
  degraded_reason: string;
}

/**
 * Stamp `degraded_mode`/`degraded_reason` onto `obj` and emit a loud warning.
 *
 * @param obj    the result object being returned from a fallback path
 * @param reason human-readable reason the code degraded to a lesser path
 * @param tag    short log prefix identifying the site (e.g. 'zkp', 'x402', 'hal')
 * @returns      the same object, now carrying the degraded fields
 */
export function markDegraded<T extends object>(obj: T, reason: string, tag = 'degraded'): T & DegradedFields {
  console.warn(`[${tag}] DEGRADED (loud fallback): ${reason}`);
  return Object.assign(obj, { degraded_mode: true as const, degraded_reason: reason });
}
