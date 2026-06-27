/**
 * shadow-log.ts — the brain's ONLY side effect (decision-contract guarantee 5).
 *
 * Every `decideFailover` call writes one row to `anfis_routing_logs` (the same audit table the LLM
 * shadow router uses, reconciled to 22 columns by migrations/2026-06-05-anfis-routing-logs.sql,
 * verified applied to prod 2026-06-26). The write is tolerant: it NEVER throws to the caller and
 * NEVER blocks a request — a failed log is logged to console and swallowed.
 *
 * Reversible: `RESILIENCE_SHADOW_LOG=false` disables the write entirely (one env var).
 * No RepID / money / on-chain effect — this is an audit table under service-role RLS.
 */

import { db } from '../db';
import type { FailoverDecision, SurfaceSignal } from './decision-contract';

/** Build the `anfis_routing_logs` insert row for a failover decision (reuses the route.ts shape). */
export function buildShadowRow(sig: SurfaceSignal, decision: FailoverDecision) {
  const chosen = sig.candidates.find(c => c.target === decision.chosenTarget);
  const primary = sig.candidates.find(c => c.target === sig.primary);
  // Counterfactual "cost saved" vs staying on primary (negative = the chosen target costs more).
  const costSaved =
    primary && chosen ? Number((primary.costPerUnit - chosen.costPerUnit).toFixed(6)) : 0;
  const candidatesSummary = sig.candidates.map(c => ({
    t: c.target,
    h: c.healthy,
    er: c.errorRate,
    lat: c.latencyMsP50,
    rel: c.reliability,
  }));

  return {
    // map onto the reconciled anfis_routing_logs columns; `category = surface` per the sprint
    prompt_preview: (decision.reason || '').substring(0, 200),
    category: sig.surface,
    static_provider: sig.primary, // the static/primary target the wrapper would use by default
    static_tier: sig.surface,
    static_reason: 'static_primary',
    anfis_provider: decision.chosenTarget,
    anfis_tier: decision.action,
    anfis_conf: Number(decision.confidence.toFixed(4)),
    cost_usdc: costSaved,
    cost_saved: costSaved,
    latency_ms: chosen?.latencyMsP50 ?? null,
    success: null as boolean | null, // outcome unknown at decision time; A/B fills via outcomes later
    n_providers: sig.candidates.length,
    verified_by: [`static:${sig.primary}`, `anfis:${decision.chosenTarget}:${decision.action}`],
    request_text: (sig.requestHint || decision.reason || '').substring(0, 500),
    notes: {
      surface: sig.surface,
      action: decision.action,
      shadow: decision.shadow,
      requestStakes: sig.requestStakes,
      selectedFeatures: decision.selectedFeatures,
      candidates_summary: candidatesSummary,
    },
  };
}

/**
 * Insert the shadow row. Tolerant: returns true on success, false on any error/skip. Awaited by the
 * caller but the result is advisory — the brain's decision is already returned regardless.
 */
export async function logFailoverDecision(
  sig: SurfaceSignal,
  decision: FailoverDecision
): Promise<boolean> {
  if (process.env.RESILIENCE_SHADOW_LOG === 'false') return false;
  try {
    const { error } = await db.from('anfis_routing_logs').insert(buildShadowRow(sig, decision) as any);
    if (error) {
      console.error('[resilience-shadow] log insert error:', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[resilience-shadow] log insert threw:', e?.message ?? e);
    return false;
  }
}
