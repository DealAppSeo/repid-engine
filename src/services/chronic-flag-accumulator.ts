/**
 * CHRONIC-FLAG ACCUMULATOR (C-2, 2026-06-08). A2 set `flagged → 0` RepID delta, which is correct for
 * a SINGLE unconfirmed flag (1 FALSE + 2 UNCERTAIN, no quorum) — but removes all friction on a
 * repeatable PATTERN of flags. This closes that gaming surface WITHOUT penalizing any single flag:
 * when an agent's flag rate over a window exceeds a threshold, route its recent work to the existing
 * probabilistic PEER-VERIFICATION path (reuse peer_verification_queue), NOT a blind slash. A confirmed
 * peer-verify FAILURE then carries the real RepID consequence; an unconfirmed flag pattern carries none.
 *
 * Default OFF (HAL_CHRONIC_FLAG_ENABLED). The threshold (HAL_CHRONIC_FLAG_THRESHOLD) is a placeholder
 * wired to GA-C's flagged-precision number — coordinate before enabling. Enabling = Tier-2 (XC).
 */

export interface ChronicFlagConfig {
  enabled: boolean;
  /** number of flags within the window that triggers a peer-verify. From GA-C (placeholder). */
  threshold: number;
  windowHours: number;
}
export function chronicFlagConfig(): ChronicFlagConfig {
  return {
    enabled: process.env.HAL_CHRONIC_FLAG_ENABLED === 'true',
    threshold: Number(process.env.HAL_CHRONIC_FLAG_THRESHOLD ?? '5'), // PLACEHOLDER until GA-C lands
    windowHours: Number(process.env.HAL_CHRONIC_FLAG_WINDOW_HOURS ?? '24'),
  };
}

/** Pure: does this flag count over the window cross the threshold? */
export function shouldTriggerPeerVerify(flagCount: number, threshold: number): boolean {
  return flagCount >= threshold;
}

interface DbLike { from: (t: string) => any }

/** Count an agent's 'flagged' score events within the window. Best-effort; 0 on error. */
export async function countRecentFlags(db: DbLike, agentId: string, windowHours: number): Promise<number> {
  try {
    const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const { data, error } = await db
      .from('repid_score_events')
      .select('id', { count: 'exact', head: false })
      .eq('agent_id', agentId)
      .eq('hal_decision', 'flagged')
      .gte('created_at', since);
    if (error) return 0;
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

export interface ChronicFlagResult {
  enabled: boolean;
  flagCount: number;
  threshold: number;
  triggered: boolean;
  enqueued: boolean;
  reason: string;
}

/**
 * If the agent's recent flag count crosses the threshold, enqueue a peer-verification (NOT a penalty).
 * Returns what happened. In shadow/disabled it computes but enqueues nothing. NEVER throws — a chronic
 * accumulator failure must not affect the live scoring path.
 */
export async function maybeTriggerChronicFlag(
  db: DbLike,
  agentId: string,
  recentClaimText?: string,
): Promise<ChronicFlagResult> {
  const cfg = chronicFlagConfig();
  const flagCount = await countRecentFlags(db, agentId, cfg.windowHours);
  const triggered = cfg.enabled && shouldTriggerPeerVerify(flagCount, cfg.threshold);
  if (!triggered) {
    return { enabled: cfg.enabled, flagCount, threshold: cfg.threshold, triggered: false, enqueued: false,
      reason: cfg.enabled ? `${flagCount} flags < ${cfg.threshold} threshold` : 'chronic-flag accumulator disabled (default; GA-C threshold pending)' };
  }
  // Enqueue a peer-verify on the agent's recent work — the consequence is verification, not a slash.
  let enqueued = false;
  try {
    const { error } = await db.from('peer_verification_queue').insert({
      source_agent_id: agentId,
      verification_status: 'pending',
      threshold_used: cfg.threshold,
      claim_text: (recentClaimText ?? `chronic flag pattern: ${flagCount} flags in ${cfg.windowHours}h`).slice(0, 2000),
    });
    enqueued = !error;
  } catch { /* never throw */ }
  return { enabled: true, flagCount, threshold: cfg.threshold, triggered: true, enqueued,
    reason: `chronic flag pattern (${flagCount} >= ${cfg.threshold}) → peer-verify enqueued (not penalized)` };
}
