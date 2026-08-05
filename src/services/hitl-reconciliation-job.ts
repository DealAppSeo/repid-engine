import { db } from '../db';
import { shouldParkForHalt } from './emergency-halt';
import {
  HitlReconcileMode,
  ReconcileCandidate,
  parseHitlReconcileMode,
  reconcileExpiredHitlRows,
} from './hitl-reconciliation';

/**
 * DB-bound runner for the HITL validation-queue reconciler (loop Beat 12).
 * Sibling to `hitl-expiration-job.ts`: that job flips `hitl_requests` → expired;
 * this one closes out the `validation_queue` rows those expiries strand in
 * `processing` (see `hitl-reconciliation.ts` for the full gap write-up).
 *
 * Pure logic lives in `hitl-reconciliation.ts`; this file only supplies the two
 * db-bound deps (read `fetchCandidates`, enforce-only `markSkipped`) and the
 * interval. `HITL_RECONCILE_MODE` (off|shadow|enforce, default shadow) is the
 * single lever; shadow logs would-actions and mutates nothing.
 */

const POLL_INTERVAL_MS = parseInt(process.env.HITL_RECONCILE_POLL_MS || '300000', 10);
const BATCH_LIMIT = parseInt(process.env.HITL_RECONCILE_BATCH_LIMIT || '200', 10);
const mode = (): HitlReconcileMode => parseHitlReconcileMode(process.env.HITL_RECONCILE_MODE);

let reconcileInterval: NodeJS.Timeout | null = null;

/** Read-only: processing validation_queue rows carrying a hitl_request_id, joined to hitl_requests.status. */
async function fetchCandidates(limit: number): Promise<ReconcileCandidate[]> {
  const { data: rows, error } = await db
    .from('validation_queue')
    .select('id, metadata')
    .eq('status', 'processing')
    .not('metadata->>hitl_request_id', 'is', null)
    .limit(limit);
  if (error) throw new Error(error.message);
  if (!rows || rows.length === 0) return [];

  const ids = Array.from(
    new Set(
      rows
        .map((r: any) => r.metadata?.hitl_request_id)
        .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0),
    ),
  );

  const statusById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: reqs, error: reqErr } = await db.from('hitl_requests').select('id, status').in('id', ids);
    if (reqErr) throw new Error(reqErr.message);
    for (const r of reqs ?? []) statusById.set((r as any).id, (r as any).status);
  }

  return rows.map((r: any) => {
    const hid: string | null = typeof r.metadata?.hitl_request_id === 'string' ? r.metadata.hitl_request_id : null;
    return {
      id: r.id,
      hitlStatus: hid ? statusById.get(hid) ?? null : null,
      alreadyFinalized: r.metadata?.hitl_finalized === true,
    };
  });
}

/**
 * ENFORCE-only. Close a stranded row: status → 'skipped' + processed_at (satisfies
 * validation_queue_processed_check) + reconcile metadata. NO RepID delta — the
 * human window lapsed, so no verdict is fabricated. Guarded on status='processing'
 * so it can never race the worker onto an already-terminal row.
 */
async function markSkipped(id: string, reason: string): Promise<void> {
  const { data: cur, error: readErr } = await db.from('validation_queue').select('metadata').eq('id', id).single();
  if (readErr) throw new Error(readErr.message);

  const md = (cur as any)?.metadata ?? {};
  const now = new Date().toISOString();

  const { error } = await db
    .from('validation_queue')
    .update({
      status: 'skipped',
      processed_at: now,
      metadata: {
        ...md,
        hitl_expired_reconciled: true,
        hitl_expired_reconciled_at: now,
        hitl_expired_reconcile_reason: reason,
      },
    })
    .eq('id', id)
    .eq('status', 'processing');
  if (error) throw new Error(error.message);
}

export async function runReconcileSweep(): Promise<void> {
  // L0 gate 0.4 — GLOBAL EMERGENCY HALT. Mutates validation_queue rows.
  if (await shouldParkForHalt(db, 'HitlReconcileJob')) return;
  await reconcileExpiredHitlRows({ fetchCandidates, markSkipped }, mode(), BATCH_LIMIT);
}

export async function startHitlReconciliationJob(): Promise<void> {
  const m = mode();
  if (m === 'off') {
    console.log('[HitlReconcileJob] Disabled (HITL_RECONCILE_MODE=off), skipping');
    return;
  }
  console.log(`[HitlReconcileJob] Starting loop · mode=${m} · poll=${POLL_INTERVAL_MS}ms`);
  reconcileInterval = setInterval(() => void runReconcileSweep(), POLL_INTERVAL_MS);
  if (reconcileInterval && typeof reconcileInterval.unref === 'function') {
    reconcileInterval.unref();
  }
  // one immediate pass so shadow observability shows up at boot, not one poll later
  void runReconcileSweep();
}

export function stopHitlReconciliationJob(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
  }
}
