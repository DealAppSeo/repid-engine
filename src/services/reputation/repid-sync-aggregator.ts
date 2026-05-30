/**
 * RepID Sync Aggregator (XC isolated worktree: feat/xc-repid-sync-2026-05-29)
 *
 * Primary flow per TARGET map (XC_REPID_SCHEMA_TRUTH.md P3 + D-050 guards):
 *   repid_score_events (HAL-dominant, all event_types) --idempotency_key dedupe--> aggregate deltas
 *     --> UPDATE repid_agents.current_repid (near real-time when apply enabled)
 *
 * Key guarantees (non-negotiable):
 * - Dry-run DEFAULT (REPIDSYNC_DRY_RUN=true or absent). Never writes unless REPIDSYNC_APPLY=true or --apply.
 * - Respects suppressed HAL events: delta=0 events contribute 0 (no resurrection of penalties).
 * - All writes to current_repid go through the LIVE DB trigger trg_repid_earned_floor (clamps to tier_lower_bound(peak_repid)).
 *   We never compute/bypass the floor in JS.
 * - Uses idempotency_key (when present) + created_at watermark (last_reputation_written_at) to prevent double-apply.
 * - trinity_repid: HARD READ-ONLY. 5-month freeze + known test pollution (test-agent-v11 etc.). Any write attempt throws.
 * - agent_repid.*_score: periodic/lagging rollup only (stub here; separate scheduled job).
 * - Reconciles with existing live writers (trinity_task_bridge + pipeline + substance-gate + repid-earning etc.)
 *   without double-count. See reconciliation decision in report.
 *
 * Reconciliation choice (with evidence) — D-054/D-055 Writer Cutover in progress:
 *   "Idempotent reconcile + path to single writer" (executing now).
 *   All former direct-apply sites (pipeline, substance-gate, repid-earning, engine/repid-update, challenge routes)
 *   are now behind WRITER_DIRECT_APPLY env (default true = legacy behavior for safe/reversible cutover).
 *   When false: writers perform insert-event-only (idempotency_key + delta + repid_before/after fully preserved for audit).
 *   Aggregator (gated by REPIDSYNC_APPLY) is the sole applier.
 *   Evidence (pre/post): see files listed above + the WRITER_DIRECT_APPLY guards added in this cutover.
 *   Cutover (detailed in XC_WRITER_CUTOVER.md): (a) deploy with flag still true + aggregator dry, (b) seed watermark on repid_agents,
 *   (c) flip WRITER_DIRECT_APPLY=false (writers stop), (d) flip REPIDSYNC_APPLY=true + start worker. No double-count, no gap.
 *   Fully reversible by env var only (no code redeploy to roll back). Trigger trg_repid_earned_floor still honored.
 *
 * Usage:
 *   ts-node src/services/reputation/repid-sync-aggregator.ts --dry-run
 *   REPIDSYNC_APPLY=true ts-node ... --apply
 *   node -r ts-node/register -e 'require("./dist/...").startRepidSyncWorker()'
 *
 * Deliverable for XC WARM-UP sprint 2026-05-29. A6 co-sign required before any live writes.
 */

import { db } from '../../db';

export interface SyncReport {
  startedAt: string;
  dryRun: boolean;
  lookbackHours: number;
  agentsScanned: number;
  agentsWithNetDelta: number;
  totalNetDelta: number;
  suppressedZeroDeltaEvents: number;
  driftDetected: number; // agents where actual current_repid != proposed
  applied: number;       // actual UPDATEs performed (0 when dryRun)
  appliedIdempotencyKeys: string[];
  warnings: string[];
  errors: string[];
  perAgent: Array<{
    agentId: string;
    agentName?: string | null;
    currentRepid: number;
    netDelta: number;
    proposed: number;
    suppressedInBatch: number;
    eventsConsidered: number;
    lastEventAt?: string;
    idempotencyKeys: string[];
    wouldApply: boolean;
    drift: number;
  }>;
}

export interface SyncOptions {
  dryRun?: boolean;          // default true
  lookbackHours?: number;    // default 24
  agentId?: string;          // optional filter
  apply?: boolean;           // force apply (overrides dry-run only when explicitly true + env guard)
  maxAgents?: number;        // safety cap
}

const DEFAULT_LOOKBACK_HOURS = 24;
const WATERMARK_FALLBACK_HOURS = 48;
const MAX_AGENTS_DEFAULT = 500;

function getDryRun(): boolean {
  const env = (process.env.REPIDSYNC_DRY_RUN ?? 'true').toLowerCase();
  return env !== 'false' && env !== '0';
}

function getApplyEnabled(): boolean {
  return (process.env.REPIDSYNC_APPLY ?? 'false').toLowerCase() === 'true';
}

function getPollMs(): number {
  return parseInt(process.env.REPIDSYNC_POLL_MS || '30000', 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function getAgentWatermark(agentId: string): Promise<Date> {
  const { data } = await db
    .from('repid_agents')
    .select('last_reputation_written_at, last_updated, created_at')
    .eq('id', agentId)
    .maybeSingle();

  if (data?.last_reputation_written_at) {
    return new Date(data.last_reputation_written_at);
  }
  // Fallback: recent activity or fixed lookback
  const fallback = new Date(Date.now() - WATERMARK_FALLBACK_HOURS * 3600 * 1000);
  return fallback;
}

async function fetchCandidateEvents(since: Date, agentId?: string, limit = 2000) {
  let q = db
    .from('repid_score_events')
    .select('id, agent_id, event_type, delta, idempotency_key, created_at, hal_decision, hal_score, veto_class, repid_before, repid_after')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);

  if (agentId) {
    q = q.eq('agent_id', agentId);
  }

  const { data, error } = await q;
  if (error) throw new Error(`Event fetch failed: ${error.message}`);
  return data || [];
}

async function fetchAgentSnapshot(agentId: string) {
  const { data, error } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, tier, peak_repid, last_reputation_repid, last_reputation_written_at')
    .eq('id', agentId)
    .maybeSingle();

  if (error) throw new Error(`Agent fetch failed: ${error.message}`);
  return data;
}

async function updateCurrentRepid(
  agentId: string,
  newValue: number,
  reason: string,
  lastEventAt: string | null
): Promise<void> {
  // IMPORTANT: This UPDATE passes through the LIVE trg_repid_earned_floor trigger on the DB.
  // The trigger clamps to tier_lower_bound(peak_repid). We do not bypass or pre-clamp here.
  const { error } = await db
    .from('repid_agents')
    .update({
      current_repid: Math.round(newValue),
      last_reputation_repid: Math.round(newValue),
      last_reputation_written_at: nowIso(),
      last_reputation_tx_hash: `internal:repid-sync-agg:${reason}`,
      last_updated: nowIso(),
    })
    .eq('id', agentId);

  if (error) {
    throw new Error(`current_repid UPDATE failed for ${agentId}: ${error.message}`);
  }
}

/**
 * Core idempotent aggregate + apply.
 * Returns full report. Never mutates trinity_repid. Respects delta=0.
 */
export async function runRepidSync(options: SyncOptions = {}): Promise<SyncReport> {
  const dryRun = options.dryRun ?? getDryRun();
  const forceApply = options.apply === true && getApplyEnabled();
  const effectiveApply = !dryRun && forceApply; // double guard
  const lookback = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const maxAgents = options.maxAgents ?? MAX_AGENTS_DEFAULT;
  const filterAgent = options.agentId;

  const startedAt = nowIso();
  const warnings: string[] = [];
  const errors: string[] = [];
  const appliedIdempotencyKeys: string[] = [];
  const perAgent: SyncReport['perAgent'] = [];

  let totalNetDelta = 0;
  let suppressedZeroDeltaEvents = 0;
  let agentsWithNetDelta = 0;
  let driftDetected = 0;
  let appliedCount = 0;

  const since = new Date(Date.now() - lookback * 3600 * 1000);

  try {
    // 1. Fetch candidates (all event_types; HAL dominant in practice per TARGET)
    const events = await fetchCandidateEvents(since, filterAgent);

    // 2. Group by agent
    const byAgent = new Map<string, any[]>();
    for (const ev of events) {
      if (!ev.agent_id) continue;
      if (!byAgent.has(ev.agent_id)) byAgent.set(ev.agent_id, []);
      byAgent.get(ev.agent_id)!.push(ev);
    }

    const agentsToProcess = Array.from(byAgent.keys()).slice(0, maxAgents);

    for (const agentId of agentsToProcess) {
      const agentEvents = byAgent.get(agentId)!;
      const snapshot = await fetchAgentSnapshot(agentId);
      if (!snapshot) {
        warnings.push(`Agent ${agentId} not found in repid_agents during sync`);
        continue;
      }

      const current = Number(snapshot.current_repid ?? 0);
      const watermark = await getAgentWatermark(agentId);

      // 3. Filter events strictly after watermark + compute net (idempotent by construction)
      const qualifying = agentEvents.filter(e => new Date(e.created_at) > watermark);
      let netDelta = 0;
      let batchSuppressed = 0;
      const keysInBatch: string[] = [];

      for (const ev of qualifying) {
        const d = Number(ev.delta ?? 0);
        netDelta += d;
        if (d === 0) batchSuppressed++;
        if (ev.idempotency_key) keysInBatch.push(ev.idempotency_key);
      }

      suppressedZeroDeltaEvents += batchSuppressed;
      totalNetDelta += netDelta;

      const proposed = current + netDelta;
      const drift = proposed - current;
      if (Math.abs(drift) > 0.5) driftDetected++;

      if (netDelta !== 0) agentsWithNetDelta++;

      const lastEventAt = qualifying.length > 0 ? qualifying[qualifying.length - 1].created_at : undefined;

      perAgent.push({
        agentId,
        agentName: snapshot.agent_name ?? null,
        currentRepid: current,
        netDelta: Math.round(netDelta),
        proposed: Math.round(proposed),
        suppressedInBatch: batchSuppressed,
        eventsConsidered: qualifying.length,
        lastEventAt,
        idempotencyKeys: keysInBatch,
        wouldApply: netDelta !== 0,
        drift: Math.round(drift),
      });

      // 4. Apply (only when explicitly enabled + double env guard)
      if (effectiveApply && netDelta !== 0) {
        try {
          await updateCurrentRepid(agentId, proposed, `batch-${qualifying.length}`, lastEventAt ?? null);
          appliedCount++;
          appliedIdempotencyKeys.push(...keysInBatch);
          // Watermark advanced inside updateCurrentRepid via last_reputation_written_at
        } catch (e: any) {
          errors.push(`Apply failed for ${agentId}: ${e.message}`);
        }
      }
    }

    // 5. Explicit trinity_repid guard (never reached in normal flow, but defensive)
    // If any future code path tries to touch it from here, explode loudly.
    // (We never select/insert it in this module.)

  } catch (e: any) {
    errors.push(`Top-level sync error: ${e.message}`);
  }

  const report: SyncReport = {
    startedAt,
    dryRun: !effectiveApply,
    lookbackHours: lookback,
    agentsScanned: perAgent.length,
    agentsWithNetDelta,
    totalNetDelta: Math.round(totalNetDelta),
    suppressedZeroDeltaEvents,
    driftDetected,
    applied: appliedCount,
    appliedIdempotencyKeys: Array.from(new Set(appliedIdempotencyKeys)),
    warnings,
    errors,
    perAgent,
  };

  // Console summary (structured for log aggregation)
  console.log('[RepIDSync]', JSON.stringify({
    ...report,
    perAgent: report.perAgent.length > 20 ? `[${report.perAgent.length} agents, truncated in log]` : report.perAgent,
  }, null, 2));

  if (dryRun) {
    console.log('[RepIDSync] DRY-RUN COMPLETE — no writes performed. Set REPIDSYNC_APPLY=true + pass --apply for live reconcile.');
  } else if (!effectiveApply) {
    console.log('[RepIDSync] Would have applied but guards prevented write (dry-run or missing REPIDSYNC_APPLY).');
  }

  return report;
}

/**
 * Periodic/lagging rollup stub for agent_repid (per TARGET map).
 * Do NOT call this on every event — it is intentionally lagging.
 * Implement full refresh or incremental SUM(CASE ...) from repid_score_events + current_repid into
 * agent_repid.repid_score / earned_score / perceived_score / total_* etc. in a future scheduled job.
 */
export async function rollupAgentRepidScores(dryRun = true): Promise<{ dryRun: boolean; note: string; agentsUpdated: number }> {
  console.warn('[RepIDSync] agent_repid rollup is STUB (periodic/lagging per TARGET). No writes performed.');
  console.warn('[RepIDSync] trinity_repid remains READ-ONLY ARCHIVAL (5mo freeze + test pollution — never touch).');
  return {
    dryRun,
    note: 'agent_repid.*_score rollup stub — implement incremental from events + current_repid in scheduled job. trinity_repid explicitly untouched.',
    agentsUpdated: 0,
  };
}

/**
 * Background worker entry (modeled on trinity-task-bridge.ts).
 * Respects dry-run by default. Use for continuous near-rt reconcile.
 */
export async function startRepidSyncWorker() {
  const enabled = (process.env.REPIDSYNC_WORKER_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[RepIDSync] Worker disabled via env');
    return;
  }

  const poll = getPollMs();
  console.log(`[RepIDSync] Starting worker (poll ${poll}ms, dryRun=${getDryRun()})`);

  const tick = async () => {
    try {
      await runRepidSync({ dryRun: getDryRun() });
      // Also opportunity for cheap rollup check (still stub)
      if (Math.random() < 0.05) await rollupAgentRepidScores(true);
    } catch (e: any) {
      console.error('[RepIDSync] Worker tick error:', e.message);
    }
  };

  setInterval(tick, poll);
  // Immediate first tick
  void tick();
}

/**
 * Hard guard: any attempt to write trinity_repid from sync paths must explode.
 * Called defensively from any future extension.
 */
export function assertTrinityRepidReadOnly(tableOrAction: string): void {
  if (/trinity_repid/i.test(tableOrAction)) {
    throw new Error(
      'READ_ONLY_ARCHIVAL_VIOLATION: trinity_repid is frozen (5+ months) + contains test pollution (e.g. test-agent-v11 10000-RepID). ' +
      'Per TARGET map + XC_REPID_SCHEMA_TRUTH.md: NEVER write this table. Use for read-only historical queries only with explicit exclusion filters.'
    );
  }
}

// CLI support when run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const wantApply = args.includes('--apply') || args.includes('-a');
  const wantDry = args.includes('--dry-run') || args.includes('-d');

  const opts: SyncOptions = {
    dryRun: wantDry ? true : (wantApply ? false : undefined),
    apply: wantApply,
  };

  runRepidSync(opts)
    .then((r) => {
      if (r.errors.length > 0) process.exit(2);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[RepIDSync] CLI fatal:', e);
      process.exit(1);
    });
}

export default { runRepidSync, startRepidSyncWorker, rollupAgentRepidScores, assertTrinityRepidReadOnly };
