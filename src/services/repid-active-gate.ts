/**
 * RepID ACTIVE GATE — SHADOW MODE (C-1, 2026-06-08). Wires "REPID AS ACTIVE CAPITAL" computations
 * (REPID_ACTIVE_GATE_DESIGN_v0) without enforcing anything. RepID is a passive log today; this makes
 * it COMPUTE what an active gate WOULD do — task-claim limit, reward scaling, auto-quarantine
 * candidacy — and logs it. ENFORCEMENT IS HELD: `REPID_ACTIVE_GATE_MODE=enforce` is Tier-2 (XC) and
 * waits on GA-D showing RepID actually predicts quality. Build the mechanism now; gate the bite later.
 *
 * Canonical tiers (DB-derived via trg_sync_tier; mirrored here for preview only):
 *   PROBATIONARY 0–499 · EARNING 500–999 · ESTABLISHED 1000–4999 · AUTONOMOUS 5000–7999 · VETERAN 8000–10000
 */

export type Tier = 'PROBATIONARY' | 'EARNING' | 'ESTABLISHED' | 'AUTONOMOUS' | 'VETERAN';

export function tierOf(repid: number): Tier {
  if (repid >= 8000) return 'VETERAN';
  if (repid >= 5000) return 'AUTONOMOUS';
  if (repid >= 1000) return 'ESTABLISHED';
  if (repid >= 500) return 'EARNING';
  return 'PROBATIONARY';
}

/** Concurrent task-claim limit scaled by tier — higher standing earns more in-flight work. */
const TIER_CLAIM_LIMIT: Record<Tier, number> = {
  PROBATIONARY: 1, EARNING: 2, ESTABLISHED: 4, AUTONOMOUS: 8, VETERAN: 12,
};
export function computeClaimLimit(repid: number): number {
  return TIER_CLAIM_LIMIT[tierOf(repid)];
}

/**
 * Reward scaling in [0.5, 1.5] — linear in RepID (0 → 0.5x, 10000 → 1.5x). Higher-standing agents
 * earn a larger share of the same task's reward; low-standing agents earn less until they prove out.
 */
export function computeRewardScale(repid: number): number {
  const clamped = Math.max(0, Math.min(10000, repid));
  return Math.round((0.5 + clamped / 10000) * 100) / 100;
}

export interface QuarantineInput {
  repid: number;
  /** recent net RepID trend (sum of last-N event deltas); negative = sliding. */
  recent_delta?: number | null;
  /** consecutive HAL vetoes on recent work, if known. */
  recent_vetoes?: number | null;
}
/**
 * Auto-quarantine CANDIDATE flag (not an action): a chronically-low active agent — at/near the
 * PROBATIONARY floor AND either trending down or repeatedly vetoed. In shadow this is only a flag;
 * enforcement would route the agent to review, never an auto-ban.
 */
export const QUARANTINE_REPID_CEIL = 200;
export function quarantineCandidate(input: QuarantineInput): boolean {
  if (input.repid > QUARANTINE_REPID_CEIL) return false;
  const trendingDown = (input.recent_delta ?? 0) < 0;
  const repeatedlyVetoed = (input.recent_vetoes ?? 0) >= 2;
  return trendingDown || repeatedlyVetoed;
}

export type GateMode = 'shadow' | 'enforce';
export function gateMode(): GateMode {
  return process.env.REPID_ACTIVE_GATE_MODE === 'enforce' ? 'enforce' : 'shadow';
}

export interface GateAgent {
  id: string;
  agent_name?: string | null;
  current_repid: number;
  recent_delta?: number | null;
  recent_vetoes?: number | null;
}
export interface GateEvaluation {
  mode: GateMode;
  agent_id: string;
  tier: Tier;
  repid: number;
  claim_limit: number;
  reward_scale: number;
  quarantine_candidate: boolean;
  /** what the gate WOULD do for a given action (shadow: advisory only). */
  would_allow_claim?: boolean;
}

/** Pure evaluation — what the active gate would compute for this agent (no side effects). */
export function evaluateGate(agent: GateAgent, opts: { current_claims?: number } = {}): GateEvaluation {
  const repid = agent.current_repid;
  const claim_limit = computeClaimLimit(repid);
  return {
    mode: gateMode(),
    agent_id: agent.id,
    tier: tierOf(repid),
    repid,
    claim_limit,
    reward_scale: computeRewardScale(repid),
    quarantine_candidate: quarantineCandidate({ repid, recent_delta: agent.recent_delta, recent_vetoes: agent.recent_vetoes }),
    ...(opts.current_claims != null ? { would_allow_claim: opts.current_claims < claim_limit } : {}),
  };
}

/**
 * Shadow-log the evaluation. Best-effort: inserts into repid_gate_shadow_log if present (migration
 * is Tier-2, drafted in migrations/), else falls back to trinity_agent_logs (write-only). NEVER
 * throws and NEVER enforces — a logging failure must not affect the live path.
 */
export async function logGateShadow(
  db: { from: (t: string) => any },
  evalResult: GateEvaluation,
  context?: Record<string, unknown>,
): Promise<void> {
  const row = {
    agent_id: evalResult.agent_id,
    mode: evalResult.mode,
    tier: evalResult.tier,
    repid: evalResult.repid,
    claim_limit: evalResult.claim_limit,
    reward_scale: evalResult.reward_scale,
    quarantine_candidate: evalResult.quarantine_candidate,
    would_allow_claim: evalResult.would_allow_claim ?? null,
    context: context ?? null,
  };
  try {
    const { error } = await db.from('repid_gate_shadow_log').insert(row);
    if (!error) return;
  } catch { /* table not present yet — fall through */ }
  try {
    await db.from('trinity_agent_logs').insert({
      agent_name: evalResult.agent_id,
      event_type: 'repid_gate_shadow',
      metadata: row,
    });
  } catch { /* never throw from the shadow logger */ }
}
