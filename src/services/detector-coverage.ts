/**
 * detector-coverage.ts — record WHAT WAS WATCHING when a score moved.
 *
 * THE PROBLEM THIS FIXES, measured 2026-08-11:
 *
 *   negative reputation events total      68,417
 *      of which HAL_SCORE_EVENT           68,321   (99.86%)
 *
 * Essentially the entire punitive signal comes from one detector. Task #56 records that
 * 3 of ~6 HAL providers are currently down (402 credits, 401 bad key).
 *
 * The outage is not the dangerous part. The dangerous part is that **a detector outage and a
 * genuine improvement in agent behaviour produce the identical signature** — fewer negative
 * events. Nothing in the ledger distinguishes "agents got better" from "the thing that
 * notices stopped noticing", and nobody reading the history later can tell either.
 *
 * This is LESSONS #8 ("a measurement without its ruler is not a result") applied to
 * reputation instead of to HAL's F1. A RepID delta computed under 3-of-6 providers is not
 * comparable to one computed under 6-of-6, and until now the regime was not recorded.
 *
 * ── THE LOAD-BEARING RULE ────────────────────────────────────────────────────────────────
 * Unknown coverage is recorded as UNKNOWN. It is never omitted and never defaulted to full.
 *
 * Omitting the field would let a later reader assume coverage was complete, which is exactly
 * the "unwired mechanism becomes false coverage" failure (LESSONS #3) — the same failure that
 * left `repid_confession_log` sitting at zero rows while the schema implied just-culture was
 * handled. An absent ruler must read as "no ruler", not as "the good ruler".
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * No DDL. `repid_score_events.metadata` is already `jsonb`, so this rides in an existing
 * column and is reversible by simply not writing it.
 */

/** A single detector's observed state at scoring time. */
export interface DetectorState {
  /** Stable name, e.g. 'groq', 'cerebras', 'gemini'. */
  name: string;
  /** True only when the provider actually answered. Anything else is not live. */
  live: boolean;
  /** Optional short reason when not live — '402', '401', 'timeout'. Never free prose. */
  reason?: string;
}

export type CoverageState = 'FULL' | 'DEGRADED' | 'NONE' | 'UNKNOWN';

export interface DetectorCoverage {
  state: CoverageState;
  /** Providers that answered. Null when state is UNKNOWN — not zero. */
  live: number | null;
  /** Providers expected. Null when state is UNKNOWN. */
  total: number | null;
  /** Names of the providers that did not answer, so a regime is diagnosable later. */
  down?: string[];
  /** Why coverage is unknown. Present only for UNKNOWN. */
  unknown_because?: string;
  /** ISO timestamp of the snapshot the coverage was derived from. */
  at?: string;
}

/** The shape stored under `metadata.detector_coverage`. */
export const COVERAGE_KEY = 'detector_coverage' as const;

/**
 * Build a coverage record from an observed set of detector states.
 *
 * An empty or missing list is UNKNOWN, never NONE: "we asked nobody" and "we asked and
 * nobody answered" are different facts, and only the second is evidence about the providers.
 */
export function buildCoverage(
  detectors: readonly DetectorState[] | null | undefined,
  at?: string,
): DetectorCoverage {
  if (!Array.isArray(detectors) || detectors.length === 0) {
    return {
      state: 'UNKNOWN',
      live: null,
      total: null,
      unknown_because: 'no detector snapshot supplied at scoring time',
      ...(at ? { at } : {}),
    };
  }

  const total = detectors.length;
  const liveOnes = detectors.filter((d) => d.live === true);
  const live = liveOnes.length;
  const down = detectors.filter((d) => d.live !== true).map((d) => (d.reason ? `${d.name}:${d.reason}` : d.name));

  const state: CoverageState = live === 0 ? 'NONE' : live === total ? 'FULL' : 'DEGRADED';

  return {
    state,
    live,
    total,
    ...(down.length ? { down } : {}),
    ...(at ? { at } : {}),
  };
}

/**
 * Merge coverage into an existing metadata object without disturbing anything else.
 * Returns a new object; never mutates the input.
 */
export function withCoverage(
  metadata: Record<string, unknown> | null | undefined,
  coverage: DetectorCoverage,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [COVERAGE_KEY]: coverage };
}

/**
 * Process-wide latest snapshot, published by whatever last talked to the providers.
 *
 * Deliberately simple and deliberately *stale-aware*: a snapshot older than MAX_AGE_MS is
 * treated as no snapshot at all, because coverage from twenty minutes ago is not evidence
 * about coverage now. Reporting a stale regime as current would be a more convincing lie
 * than reporting nothing.
 */
const MAX_AGE_MS = 5 * 60 * 1000;
let _snapshot: { detectors: DetectorState[]; atMs: number } | null = null;

/** Called by the HAL path (or any detector fleet) after it observes provider outcomes. */
export function publishDetectorSnapshot(detectors: readonly DetectorState[], nowMs: number = Date.now()): void {
  _snapshot = { detectors: [...detectors], atMs: nowMs };
}

/** Current coverage, or UNKNOWN when there is no fresh snapshot. */
export function currentCoverage(nowMs: number = Date.now()): DetectorCoverage {
  if (!_snapshot) {
    return { state: 'UNKNOWN', live: null, total: null, unknown_because: 'no detector snapshot published' };
  }
  const age = nowMs - _snapshot.atMs;
  if (age > MAX_AGE_MS) {
    return {
      state: 'UNKNOWN',
      live: null,
      total: null,
      unknown_because: `detector snapshot is ${Math.round(age / 1000)}s old (max ${MAX_AGE_MS / 1000}s)`,
      at: new Date(_snapshot.atMs).toISOString(),
    };
  }
  return buildCoverage(_snapshot.detectors, new Date(_snapshot.atMs).toISOString());
}

/** Test seam. Clears the published snapshot. */
export function _resetCoverageForTest(): void {
  _snapshot = null;
}
