// CC2 2026-05-27 — pure helpers for the /api/v1/llm-trust endpoint.
//
// Extracted from the inline handler in src/index.ts so tests can target the
// window-filter + envelope logic without mounting the whole Express app.
// The handler itself stays inline (RULE-3 — minimal move); only the new
// CC2-added logic (window filter + response envelope) lives here.
//
// Sean's PR #66 (Round 12) provides the upstream allow-list + per-provider
// collapse + sort-by-last_decision-DESC; this module wraps the result with
// the `?window=` filter and the new envelope shape.

export const ALLOWED_WINDOWS = ['24h', '7d', '30d', 'all'] as const;
export type WindowKey = (typeof ALLOWED_WINDOWS)[number];

export const DEFAULT_WINDOW: WindowKey = '24h';

// Pure: derive the window key + an ISO cutoff timestamp from a query-string value.
// Falls back to DEFAULT_WINDOW on missing/invalid input. `all` returns null cutoff
// (no filter).
export function parseWindow(qs: string | string[] | undefined): {
  window: WindowKey;
  cutoffIso: string | null;
} {
  const raw = String((Array.isArray(qs) ? qs[0] : qs) ?? '').toLowerCase().trim();
  const window: WindowKey = (ALLOWED_WINDOWS as readonly string[]).includes(raw)
    ? (raw as WindowKey)
    : DEFAULT_WINDOW;
  if (window === 'all') return { window, cutoffIso: null };
  const hours = window === '24h' ? 24 : window === '7d' ? 7 * 24 : 30 * 24;
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  return { window, cutoffIso: cutoff.toISOString() };
}

// Pure: keep rows whose `last_decision` is at or after the cutoff.
// Rows with null/missing last_decision are EXCLUDED when a cutoff is set
// (a provider with zero recorded decisions in-window cannot be "active in window").
// When cutoffIso is null, returns the input unchanged (window='all').
export function filterByWindow<T extends { last_decision: string | null | undefined }>(
  rows: T[],
  cutoffIso: string | null
): T[] {
  if (cutoffIso === null) return rows.slice();
  const cutoffMs = new Date(cutoffIso).getTime();
  return rows.filter((r) => {
    if (!r.last_decision) return false;
    const t = new Date(r.last_decision).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
}

// Pure: build the response envelope. The `providers` array IS the
// already-filtered list (post-window, post-allow-list, post-per-provider
// collapse, post-sort).
export interface LlmTrustEnvelope<P> {
  providers: P[];
  window: WindowKey;
  total_providers_tracked: number;
  providers_active_in_window: number;
  as_of: string;
}

export function buildEnvelope<P>(
  providers: P[],
  window: WindowKey,
  totalProvidersTracked: number,
  asOf: Date = new Date()
): LlmTrustEnvelope<P> {
  return {
    providers,
    window,
    total_providers_tracked: totalProvidersTracked,
    providers_active_in_window: providers.length,
    as_of: asOf.toISOString(),
  };
}
