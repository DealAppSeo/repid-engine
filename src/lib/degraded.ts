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
 *
 * 2026-09-01: LOUD NOW MEANS LOUD TO A PERSON. Until today "loudly" meant `console.warn` into a
 * Railway log nobody tails, which is the same silence the docstring above says this file exists
 * to prevent — one level up. Every degrade now also pages the operator (Telegram, owner chat
 * only, deduped per reason per hour). The console line is kept: it is the record when the pager
 * is unarmed, and `pagerStatus()` on /health says whether that is the case.
 *
 * This is deliberately wired HERE rather than at each call site. `markDegraded` already has
 * callers in the anchor worker, HAL, the ZKP prover and the x402 settler — one seam covers every
 * subsystem, and a new degrade path added later is paged for free instead of being remembered.
 */

import { pageOperator, type PageSource } from '../services/operator-pager';

const PAGE_SOURCES = ['eas-anchor', 'proof-drain', 'hal', 'zkp', 'x402', 'degraded'] as const;

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
  // Fire-and-forget by construction: pageOperator never awaits, never throws, and dedupes. This
  // function is synchronous, returns a value used inline, and is called from the anchor worker's
  // loop — it cannot become async and must not acquire a way to fail.
  pageOperator(asPageSource(tag), reason);
  return Object.assign(obj, { degraded_mode: true as const, degraded_reason: reason });
}

/**
 * Map the free-text `tag` onto the pager's closed set.
 *
 * Unrecognised tags fall back to 'degraded' rather than being dropped: a page that says only
 * "something degraded" still reaches a person, whereas silently discarding an unknown tag would
 * reintroduce exactly the silence being removed. New subsystems page on day one, correctly
 * labelled once someone adds the name.
 */
function asPageSource(tag: string): PageSource {
  return (PAGE_SOURCES as readonly string[]).includes(tag) ? (tag as PageSource) : 'degraded';
}
