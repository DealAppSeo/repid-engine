/**
 * anfis-shadow-persist.ts — makes the ANFIS shadow decision QUERYABLE (measurement, not cutover).
 *
 * BACKGROUND / WHY THIS EXISTS
 * ----------------------------
 * `src/providers/router.ts` computes an ANFIS recommendation on every request (computeShadowDecision /
 * anfisRecommendProvider) but — before this module — only `console.log`ed it. As a result
 * `anfis_routing_logs` had ~0 real rows and `anfis_decisions` had 1 row EVER (a March test), so
 * ANFIS's would-be decisions were invisible and UNMEASURABLE. There was no way to compare what ANFIS
 * *would* have chosen against what the static cost-order router *actually* ran.
 *
 * This module persists one compact row per request to the EXISTING `anfis_routing_logs` table
 * (reconciled to its 22-column shape by migrations/2026-06-05-anfis-routing-logs.sql, RLS service-role
 * only). It captures: request/task context, the STATIC provider that actually ran, the ANFIS-recommended
 * provider/tier/confidence, and whether they agreed — enough to later measure agreement/divergence and
 * (only once evidence supports it) gate a future cutover.
 *
 * SHADOW-ONLY / SAFETY
 * --------------------
 * - This does NOT change routing. It is pure read-only telemetry about a decision that was already made.
 * - `ANFIS_SHADOW_PERSIST=false` disables the write entirely (default ON — it's harmless shadow audit).
 * - The write is TOLERANT: it never throws to the caller and never blocks a request. A failed insert is
 *   logged to console and swallowed (the routing decision is already returned regardless).
 * - No RepID / money / on-chain effect — `anfis_routing_logs` is an internal audit table under
 *   service-role RLS. No scoring formula or ANFIS parameters are written to the row.
 */

import { db } from '../db';

/** Minimal inputs needed to persist a shadow row, taken straight from the router's route decision. */
export interface ShadowPersistInput {
  prompt: string;
  taskHint?: string;
  /** Provider the STATIC cost-order router actually selected (what ran). */
  staticProvider: string;
  staticTier: string;
  staticReason: string;
  /** Provider ANFIS would have recommended (shadow — did NOT decide routing). */
  anfisProvider: string;
  anfisTier: string;
  anfisConfidence: number;
  /** LASSO-selected feature names, for later interpretability of the shadow decision. */
  selectedFeatures?: string[];
  /** How many providers were in the candidate chain at decision time. */
  nProviders?: number;
}

/** Build the `anfis_routing_logs` insert row for a shadow routing decision. Pure/deterministic. */
export function buildShadowPersistRow(input: ShadowPersistInput) {
  const agree = input.anfisProvider === input.staticProvider;
  return {
    // Privacy: only a short preview of the prompt is stored, never the full text.
    prompt_preview: (input.prompt || '').substring(0, 200),
    category: 'llm_route',
    static_provider: input.staticProvider,
    static_tier: input.staticTier,
    static_reason: input.staticReason,
    anfis_provider: input.anfisProvider,
    anfis_tier: input.anfisTier,
    anfis_conf: Number((input.anfisConfidence ?? 0).toFixed(4)),
    // Outcome/cost are unknown at decision time; A3 fills them from downstream measurement later.
    cost_usdc: null as number | null,
    cost_saved: null as number | null,
    latency_ms: null as number | null,
    success: null as boolean | null,
    n_providers: input.nProviders ?? null,
    verified_by: [
      `static:${input.staticProvider}:${input.staticTier}`,
      `anfis:${input.anfisProvider}:${input.anfisTier}`,
    ],
    request_text: (input.taskHint || '').substring(0, 500),
    notes: {
      shadow: true,
      source: 'router.routeRequest',
      agree, // did ANFIS agree with the static pick? (the core measurement signal)
      task_hint: input.taskHint ?? null,
      selected_features: input.selectedFeatures ?? [],
    },
  };
}

/**
 * Persist one shadow-decision row. Tolerant: returns true on success, false on any error/skip.
 * Awaited by the caller but the result is advisory — the routing decision is already returned.
 */
export async function persistShadowDecision(input: ShadowPersistInput): Promise<boolean> {
  // Default ON — read-only shadow telemetry. Reversible with one env var.
  if (process.env.ANFIS_SHADOW_PERSIST === 'false') return false;
  try {
    const { error } = await db
      .from('anfis_routing_logs')
      .insert(buildShadowPersistRow(input) as any);
    if (error) {
      console.error('[anfis-shadow-persist] insert error:', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[anfis-shadow-persist] insert threw:', e?.message ?? e);
    return false;
  }
}
