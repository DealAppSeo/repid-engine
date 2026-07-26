/**
 * HITL validation-queue reconciliation (loop Beat 12, 2026-07-26).
 *
 * GAP CLOSED
 * ----------
 * When a `hitl_requests` row reaches a terminal-WITHOUT-human-resolution state
 * ('expired' or 'cancelled'), nothing transitions its linked `validation_queue`
 * row out of `status='processing'`. Two existing paths both miss it:
 *   - `validation-queue-worker.ts` `checkTimeouts()` DELIBERATELY does not reset
 *     HITL-pending rows (it only warns for them).
 *   - `pollResolvedHitlEntries()` finalizes a row only when its
 *     `metadata.hitl_resolved === 'true'` (i.e. a human decided) — never on expiry.
 * So a request whose 7-day window simply lapsed strands its queue row in
 * `processing` forever. `/health` counts every such row in
 * `processing_hitl_pending(_over_24h)`, so a genuinely NEW pending HITL item is
 * buried in stale noise and can never be surfaced.
 *   (Live 2026-07-26 [V]: 14 processing rows = 13 linked to `expired` requests
 *    (oldest expiry 2026-05-24) + 1 linked to a real `pending` request.)
 *
 * FIX
 * ---
 * Transition a stranded row to `skipped` — a valid terminal status per
 * `validation_queue_status_check` (pending|processing|completed|failed|skipped),
 * setting `processed_at` as `validation_queue_processed_check` requires — WITHOUT
 * applying any RepID delta. The human review window lapsed, so no verdict is
 * fabricated; the row is simply closed out of the pending count.
 *
 * DISCIPLINE
 * ----------
 * Shadow-first (default), fail-safe (only ever moves a stranded expired/cancelled
 * row → skipped; never touches an active `pending` request or a `resolved` one —
 * those flow through the existing worker paths), fail-loud (logs every action /
 * would-action), zero-DDL, one-env reversible. `off`/`shadow` = zero mutation.
 *
 * This module is a PURE functional core (no I/O). The db-bound adapter lives in
 * `validation-queue-worker.ts`; the on-demand runner in
 * `scripts/diag/reconcile-hitl-queue.ts`. Both drive this same tested logic.
 */

export type HitlReconcileMode = 'off' | 'shadow' | 'enforce';

/**
 * `hitl_requests.status` values that are terminal WITHOUT a human resolution and
 * therefore strand a `validation_queue` row in `processing`. `resolved` is
 * excluded on purpose — the existing `pollResolvedHitlEntries()` path owns those.
 */
export const STRANDING_HITL_STATUSES = ['expired', 'cancelled'] as const;

export function parseHitlReconcileMode(raw: string | undefined | null): HitlReconcileMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'off') return 'off';
  // Unknown / empty / 'shadow' → shadow: observe + log, never mutate.
  return 'shadow';
}

export interface HitlQueueRowView {
  /** validation_queue.status */
  queueStatus: string;
  /** linked hitl_requests.status, or null if the metadata link is broken/missing */
  hitlStatus: string | null;
  /** true when metadata.hitl_finalized === true (already closed by the worker) */
  alreadyFinalized: boolean;
}

export interface ReconcileDecision {
  reconcile: boolean;
  /** the only terminal we ever move a stranded row to */
  toStatus: 'skipped';
  reason: string;
}

/**
 * Pure decision: should this validation_queue row be reconciled to `skipped`?
 * Conservative by construction — anything ambiguous is left untouched.
 */
export function classifyHitlQueueRow(row: HitlQueueRowView): ReconcileDecision {
  const noop = (reason: string): ReconcileDecision => ({ reconcile: false, toStatus: 'skipped', reason });

  if (row.queueStatus !== 'processing') return noop('not-processing');
  if (row.alreadyFinalized) return noop('already-finalized');
  // Broken/missing link: do NOT guess — leave for manual inspection.
  if (row.hitlStatus == null) return noop('no-linked-hitl-request');
  if (!(STRANDING_HITL_STATUSES as readonly string[]).includes(row.hitlStatus)) {
    // pending/assigned/reviewing (still live) or resolved (worker owns it) → leave.
    return noop(`hitl-not-stranding:${row.hitlStatus}`);
  }
  return { reconcile: true, toStatus: 'skipped', reason: `hitl-${row.hitlStatus}-window-lapsed` };
}

export interface ReconcileCandidate {
  /** validation_queue.id */
  id: string;
  /** linked hitl_requests.status, or null if the link is broken */
  hitlStatus: string | null;
  /** metadata.hitl_finalized === true */
  alreadyFinalized: boolean;
}

export interface ReconcileDeps {
  /**
   * Return up to `limit` validation_queue rows in `processing` that carry a
   * hitl_request_id, each joined to its hitl_requests.status. Read-only.
   */
  fetchCandidates: (limit: number) => Promise<ReconcileCandidate[]>;
  /**
   * ENFORCE-only: mark a validation_queue row terminal (`skipped` + processed_at +
   * reconcile metadata). Guarded on `status='processing'` by the caller to avoid
   * racing the worker. Never called in off/shadow mode.
   */
  markSkipped: (id: string, reason: string) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ReconcileResult {
  mode: HitlReconcileMode;
  scanned: number;
  wouldReconcile: number;
  reconciled: number;
  errors: number;
}

/**
 * Sweep + (in enforce mode) reconcile stranded HITL validation_queue rows.
 * Fail-open: a reconciler must never wedge the worker on a flaky query, so any
 * fetch/mark error is logged and counted, never thrown.
 */
export async function reconcileExpiredHitlRows(
  deps: ReconcileDeps,
  mode: HitlReconcileMode,
  limit = 200,
): Promise<ReconcileResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const result: ReconcileResult = { mode, scanned: 0, wouldReconcile: 0, reconciled: 0, errors: 0 };

  if (mode === 'off') return result;

  let candidates: ReconcileCandidate[];
  try {
    candidates = await deps.fetchCandidates(limit);
  } catch (e: any) {
    log(`[HitlReconcile] fetch error (fail-open, no rows touched): ${e?.message ?? e}`);
    result.errors++;
    return result;
  }

  for (const c of candidates) {
    result.scanned++;
    const decision = classifyHitlQueueRow({
      queueStatus: 'processing', // fetchCandidates pre-filters to processing
      hitlStatus: c.hitlStatus,
      alreadyFinalized: c.alreadyFinalized,
    });
    if (!decision.reconcile) continue;

    result.wouldReconcile++;
    if (mode === 'shadow') {
      log(`[HitlReconcile] SHADOW would skip validation_queue ${c.id} (${decision.reason})`);
      continue;
    }

    // enforce
    try {
      await deps.markSkipped(c.id, decision.reason);
      result.reconciled++;
      log(`[HitlReconcile] reconciled validation_queue ${c.id} → skipped (${decision.reason})`);
    } catch (e: any) {
      result.errors++;
      log(`[HitlReconcile] mark error for ${c.id} (fail-open): ${e?.message ?? e}`);
    }
  }

  if (result.wouldReconcile > 0) {
    log(
      `[HitlReconcile] ${mode}: scanned=${result.scanned} ` +
        `${mode === 'enforce' ? `reconciled=${result.reconciled}` : `would=${result.wouldReconcile}`} ` +
        `errors=${result.errors}`,
    );
  }
  return result;
}
