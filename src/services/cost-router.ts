/**
 * cost-router.ts — UNIFIED, free-first router (CC_ANFIS_COST_ROUTER_SPRINT, 2026-06-13).
 *
 * Reuse, not rebuild: wraps the EXISTING `routeRequest` (providers/router.ts) — which already does
 * ANFIS recommendation + cost-ordered tier-0 + per-provider caps + health/fallback — and adds the
 * three pieces the sprint requires:
 *   (1) free-first DEFAULT: a non-escalated call routes `tier0_only` → it CANNOT silently spend premium.
 *   (2) signal-based ESCALATION hook: only a real signal opens Tier-1 (logged, auditable).
 *   (3) global daily BUDGET cap that fails CLOSED to free (never a silent paid spill).
 * And it LOGS EVERY decision to `anfis_routing_logs` (the table was cold — 116 rows, 8 days stale),
 * so ANFIS is live AND learning.
 *
 * Reversible: `ROUTER_UNIFIED_ENABLED=false` makes routeAndLog defer to plain routeRequest semantics
 * (pass-through). Budget cap via `ROUTER_DAILY_PAID_CAP` (paid_tasks/day, sprint's spend signal).
 * E1 confirmatory roster is EXEMPT — it never calls this; it uses the fixed roster directly.
 */
import { routeRequest, RouteRequest, RouteDecision } from '../providers/router';
import { db } from '../db';
import { isFreeProvider, frontierCostEstimate } from '../billing/free-providers';

export interface RouterSignals {
  contested_bft?: boolean;        // baseline SBFA/BFT triad disagreed
  code_solution_failed?: boolean; // tier-0 code solution failed verification
  rep_id_stake?: number;          // high stake → justify premium
  escalation_level?: number;      // explicit caller escalation (>0)
}

export const STAKE_ESCALATION_THRESHOLD = Number(process.env.ROUTER_STAKE_ESCALATION || 1000);
/** Daily ceiling on paid_tasks (sprint: spend signal = paid_tasks in v_provider_daily_usage). 0 = no cap. */
export const DAILY_PAID_CAP = Number(process.env.ROUTER_DAILY_PAID_CAP || 0);

/** Pure policy: which (if any) signal justifies Tier-1. Logged so escalation is auditable. */
export function escalationSignal(s: RouterSignals = {}): { escalate: boolean; reason: string } {
  if (s.escalation_level && s.escalation_level > 0) return { escalate: true, reason: `escalation_level=${s.escalation_level}` };
  if (s.contested_bft) return { escalate: true, reason: 'contested_bft' };
  if (s.code_solution_failed) return { escalate: true, reason: 'code_solution_failed' };
  if (s.rep_id_stake && s.rep_id_stake >= STAKE_ESCALATION_THRESHOLD) return { escalate: true, reason: `rep_id_stake>=${STAKE_ESCALATION_THRESHOLD}` };
  return { escalate: false, reason: 'none' };
}

/** Today's total paid_tasks across providers (the budget spend signal). Tolerant: 0 on error. */
export async function dailyPaidTasks(): Promise<number> {
  if (process.env.ROUTER_FORCE_BUDGET_BREACH === 'true') return Number.MAX_SAFE_INTEGER; // test hook
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await db.from('v_provider_daily_usage').select('paid_tasks, day').gte('day', today);
    return (data || []).reduce((a: number, r: any) => a + Number(r.paid_tasks || 0), 0);
  } catch { return 0; }
}

/** Tolerant insert into anfis_routing_logs — the un-cold write. Never throws. */
export async function logRoutingDecision(row: {
  request_text: string; selected_model: string; confidence_score: number | null;
  cost_saved: number; latency_ms: number; success: boolean; verified_by: string[];
}): Promise<boolean> {
  try { const { error } = await db.from('anfis_routing_logs').insert(row as any); return !error; }
  catch { return false; }
}

export interface UnifiedDecision {
  decision: RouteDecision;
  adapter: any;
  escalation: string;       // signal reason or 'none'
  budget_failclosed: boolean;
  effective_tier_pref: RouteRequest['tier_preference'];
  logged: boolean;
  hit_paid_lane: boolean;
}

const estTokens = (prompt: string) => Math.max(8, Math.ceil(prompt.length / 4));

/**
 * The one policy. Free-first by default; Tier-1 only on a logged signal; budget-breach fails CLOSED
 * to free; every decision logged to anfis_routing_logs.
 */
export async function routeAndLog(req: RouteRequest, signals: RouterSignals = {}): Promise<UnifiedDecision> {
  const enabled = process.env.ROUTER_UNIFIED_ENABLED !== 'false';
  const esc = escalationSignal(signals);
  const paid = await dailyPaidTasks();
  const cap = Number(process.env.ROUTER_DAILY_PAID_CAP || 0); // read at call-time (reversible/tunable)
  const budgetFailClosed = enabled && cap > 0 && paid >= cap;

  // Effective tier preference: the heart of "cheapest-by-default, premium-by-justification".
  let effPref: RouteRequest['tier_preference'];
  if (!enabled) effPref = req.tier_preference;                 // pass-through (reversible)
  else if (budgetFailClosed) effPref = 'tier0_only';          // (3) fail CLOSED to free — even if escalated
  else if (esc.escalate) effPref = 'tier0_first';             // (2) free first, Tier-1 reachable as justified escalation
  else effPref = 'tier0_only';                                // (1) free-first default — cannot silently spend premium

  // When escalating, make Tier-1 actually reachable (routeRequest gates Tier-1 on paid keys present).
  const paidKeys = esc.escalate && !budgetFailClosed
    ? { openai: process.env.OPENAI_API_KEY ? 'env' : undefined, anthropic: process.env.ANTHROPIC_API_KEY ? 'env' : undefined }
    : req.user_paid_keys;

  const t0 = Date.now();
  const r = await routeRequest({ ...req, tier_preference: effPref, user_paid_keys: paidKeys });
  const latency = Date.now() - t0;

  const hitPaid = r.decision.chosen_tier === '1';
  const chosenProvider = r.decision.chosen_provider;
  const free = isFreeProvider(chosenProvider);
  // cost_saved = what a frontier model would have cost minus (free → 0). Positive when we stayed free.
  const cost_saved = free ? frontierCostEstimate(estTokens(req.prompt), 64) : 0;

  const verified_by = [
    `static:${r.staticProvider}:${r.staticTier}`,
    `anfis:${r.anfisProvider}:${r.anfisTier}`,
    `tier:${r.decision.chosen_tier}`,
    `provider:${chosenProvider}`,
    `reason:${r.decision.reason}`,
    `escalation:${esc.reason}`,
    `budget:${budgetFailClosed ? 'failclosed' : 'ok'}`,
  ];

  const logged = await logRoutingDecision({
    request_text: req.prompt.slice(0, 500),
    selected_model: chosenProvider,
    confidence_score: r.anfisConfidence ?? null,
    cost_saved,
    latency_ms: latency,
    success: r.decision.chosen_tier !== 'none',
    verified_by,
  });

  return {
    decision: r.decision, adapter: r.adapter, escalation: esc.reason,
    budget_failclosed: budgetFailClosed, effective_tier_pref: effPref, logged, hit_paid_lane: hitPaid,
  };
}
