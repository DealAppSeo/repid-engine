/**
 * memory-root-anchor-sweep.ts — the missing middle layer between item 9's off-peak batching
 * and item 10's EAS anchor (both `src/memory/memory-root-anchor.ts`, both zero-caller as of
 * Beat 75/76). Neither primitive changed; this is the orchestration that was missing.
 *
 * Pure/injected-dependency, same shape as its neighbors: `fetchPending`/`attestFn`/`writeback`
 * are all passed in, so the sweep itself is testable with no live DB and no chain call.
 *
 * CORRECTED 2026-11-18: this header said `src/index.ts` does not import this file. It does, behind
 * MEMORY_ROOT_ANCHOR_SWEEP_ENABLED (off | shadow = dry run | enforce = real EAS gas from the funded
 * attester). Two measured facts about that wiring: `agent_memory_roots` does not exist in prod
 * (to_regclass NULL, 2026-11-18), so both modes fail at fetch today; and the select names
 * `repid_snapshot`, a column no migration created (file added: 20261118000000_...repid_snapshot.sql).
 * This sweep has NO fee ceiling and NO readback dedupe; `memory-root-anchor-due.ts` has both and is
 * not wired. Do not set `enforce` before that is decided.
 */
import { anchorMemoryRoot, isOffPeakHour, selectOffPeakBatch, type AttestFn } from './memory-root-anchor';

/** One `agent_memory_roots` row still missing its on-chain anchor, joined to its agent's tier. */
export interface PendingRootRow {
  id: number;
  agentId: string;
  tier: string;
  root: string;
  epoch: number;
  repidSnapshot: number | null;
}

export interface AnchorSweepDeps {
  /** Query `agent_memory_roots where eas_uid is null` joined to `repid_agents.tier`, oldest first. */
  fetchPending: () => Promise<PendingRootRow[]>;
  /** Persist a successful anchor's `eas_uid`/`anchored_at` back onto the row. */
  writeback: (id: number, uid: string, txHash: string | null) => Promise<void>;
  attestFn?: AttestFn;
  /** UTC hour to evaluate off-peak against; defaults to the real current hour. */
  nowHourUtc?: number;
  maxBatch?: number;
  /** When true, compute the batch but never call attestFn/writeback (observe-only). */
  dryRun?: boolean;
}

export interface AnchorSweepRowResult {
  id: number;
  anchored: boolean;
  uid?: string | null;
  error?: string;
}

export interface AnchorSweepResult {
  consideredCount: number;
  isOffPeak: boolean;
  chosenCount: number;
  results: AnchorSweepRowResult[];
}

/**
 * Fetch pending roots, apply the SCHEDULE-axis off-peak batch selection, and anchor each
 * chosen row (or, in `dryRun`, report what would have been chosen without anchoring anything).
 * Never throws on a single row's failure — one bad root must not stop the rest of the batch,
 * same swallow-and-continue shape as `checkAndAwardBadges`.
 */
export async function runMemoryRootAnchorSweep(deps: AnchorSweepDeps): Promise<AnchorSweepResult> {
  const hourUtc = deps.nowHourUtc ?? new Date().getUTCHours();
  const isOffPeak = isOffPeakHour(hourUtc);
  const pending = await deps.fetchPending();
  const chosen = selectOffPeakBatch<PendingRootRow>(pending, isOffPeak, deps.maxBatch ?? 10);

  const results: AnchorSweepRowResult[] = [];
  for (const row of chosen) {
    if (deps.dryRun) {
      results.push({ id: row.id, anchored: false });
      continue;
    }
    try {
      const r = await anchorMemoryRoot(
        { agentId: row.agentId, tier: row.tier, root: row.root, epoch: row.epoch, repidSnapshot: row.repidSnapshot },
        deps.attestFn,
      );
      if (r.anchored && r.uid) {
        await deps.writeback(row.id, r.uid, r.txHash);
      }
      results.push({ id: row.id, anchored: r.anchored, uid: r.uid, error: r.error });
    } catch (e: any) {
      results.push({ id: row.id, anchored: false, error: e?.message ?? String(e) });
    }
  }

  return { consideredCount: pending.length, isOffPeak, chosenCount: chosen.length, results };
}
