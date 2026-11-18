/**
 * memory-root-anchor-due.ts — WHEN a pending root must be anchored, and how it is submitted without
 * overpaying or anchoring twice. Sits beside `memory-root-anchor-sweep.ts` (which batches by off-peak hour
 * only) and leaves it untouched, so `MEMORY_ROOT_ANCHOR_SWEEP_ENABLED` behaves exactly as before.
 *
 * INERT: nothing in `src/index.ts` calls this. It is SHADOW-ONLY until Sean ratifies (r23: original + can
 * spend gas). Its chain client is injected; no real client is built here, because readback-by-key needs an
 * event-log reader over the attester's `Attested` events that does not exist yet. In tests it is a fake.
 *
 * DUE when ANY of:
 *   risk  — a high-risk row is pending (it also jumps the queue),
 *   batch — `batchSize` rows are pending,
 *   age   — the oldest pending row is `maxAgeMs` old.
 * OVERDUE when it has been due for `overdueAfterMs` without being anchored → `alert` is called.
 *
 * SUBMISSION (enforce mode only), in this order, fail closed:
 *   1. fee read BEFORE anything is sent; unreadable fee or fee >= `feeCeilingWei` → deferred, nothing sent;
 *   2. per row, a deterministic anchor key; a key already handled in this run is skipped;
 *   3. READBACK before send: if the chain already holds an anchor for the key (an earlier send whose
 *      receipt was lost), write that back and do not send again;
 *   4. send; a throw is AMBIGUOUS (it may have landed) → no writeback, the next run's readback decides.
 */
import { AbiCoder, keccak256 } from 'ethers';
import { buildMemoryRootAttest, MEMORY_ROOT_PROOF_TYPE, type AttestFn } from './memory-root-anchor';
import type { PendingRootRow } from './memory-root-anchor-sweep';

export interface DueRow extends PendingRootRow {
  /** unix ms the root was queued (agent_memory_roots.computed_at) */
  queuedAt: number;
  risk: 'high' | 'normal';
}

export interface DuePolicy {
  batchSize: number;
  maxAgeMs: number;
  overdueAfterMs: number;
  /** wei per gas; submission requires fee STRICTLY below this */
  feeCeilingWei: bigint;
}

export type DueReason = 'risk' | 'batch' | 'age';

export interface DuePlan {
  due: boolean;
  reasons: DueReason[];
  /** unix ms the queue first became due, or null */
  dueSince: number | null;
  overdue: boolean;
  /** high-risk first, then oldest first */
  ordered: DueRow[];
}

/** Read-only chain access plus the one write. */
export interface AnchorChainClient {
  feeWei(): Promise<bigint>;
  findAnchor(key: string): Promise<{ uid: string; txHash: string | null } | null>;
  attest: AttestFn;
}

/** One anchor per (domain, agent, epoch, root): the same batch submitted twice maps to the same key. */
export function anchorKey(r: Pick<PendingRootRow, 'agentId' | 'epoch' | 'root'>, proofType = MEMORY_ROOT_PROOF_TYPE): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'string', 'uint64', 'bytes32'], [proofType, r.agentId, BigInt(r.epoch), r.root]));
}

export function planDue(rows: DueRow[], nowMs: number, p: DuePolicy): DuePlan {
  const ordered = [...rows].sort((a, b) => (a.risk === b.risk ? a.queuedAt - b.queuedAt : a.risk === 'high' ? -1 : 1));
  const reasons: DueReason[] = [];
  const since: number[] = [];
  const high = rows.filter((r) => r.risk === 'high');
  if (high.length) { reasons.push('risk'); since.push(Math.min(...high.map((r) => r.queuedAt))); }
  if (p.batchSize > 0 && rows.length >= p.batchSize) {
    reasons.push('batch');
    since.push([...rows].sort((a, b) => a.queuedAt - b.queuedAt)[p.batchSize - 1]!.queuedAt);
  }
  if (rows.length) {
    const ageDue = Math.min(...rows.map((r) => r.queuedAt)) + p.maxAgeMs;
    if (nowMs >= ageDue) { reasons.push('age'); since.push(ageDue); }
  }
  const dueSince = since.length ? Math.min(...since) : null;
  return { due: reasons.length > 0, reasons, dueSince, overdue: dueSince !== null && nowMs - dueSince >= p.overdueAfterMs, ordered };
}

export type RowOutcome = 'anchored' | 'readback_existing' | 'duplicate_in_run' | 'ambiguous' | 'failed';

export interface DueSweepResult {
  plan: DuePlan;
  mode: 'shadow' | 'enforce';
  deferred?: 'fee_at_or_above_ceiling' | 'fee_not_checked';
  feeWei?: bigint;
  sent: number;
  rows: Array<{ id: number; key: string; outcome: RowOutcome; uid?: string | null; error?: string }>;
}

export interface DueSweepDeps {
  fetchPending: () => Promise<DueRow[]>;
  writeback: (id: number, uid: string, txHash: string | null) => Promise<void>;
  chain: AnchorChainClient;
  policy: DuePolicy;
  nowMs: number;
  /** 'shadow' never sends and never writes back. Default 'shadow'. */
  mode?: 'shadow' | 'enforce';
  alert: (msg: string) => void;
}

export async function runDueAnchorSweep(d: DueSweepDeps): Promise<DueSweepResult> {
  const mode = d.mode ?? 'shadow';
  const plan = planDue(await d.fetchPending(), d.nowMs, d.policy);
  const out: DueSweepResult = { plan, mode, sent: 0, rows: [] };
  if (!plan.due) return out;
  if (plan.overdue) {
    d.alert(`[memory-anchor-due] OVERDUE: due since ${new Date(plan.dueSince!).toISOString()} (${plan.reasons.join('+')}), ${plan.ordered.length} pending`);
  }
  if (mode === 'shadow') return out;

  try {
    out.feeWei = await d.chain.feeWei();
  } catch {
    out.deferred = 'fee_not_checked';
    return out;
  }
  if (out.feeWei >= d.policy.feeCeilingWei) { out.deferred = 'fee_at_or_above_ceiling'; return out; }

  const seen = new Set<string>();
  for (const row of plan.ordered.slice(0, d.policy.batchSize > 0 ? d.policy.batchSize : plan.ordered.length)) {
    const key = anchorKey(row);
    if (seen.has(key)) { out.rows.push({ id: row.id, key, outcome: 'duplicate_in_run' }); continue; }
    seen.add(key);
    try {
      const existing = await d.chain.findAnchor(key);
      if (existing) {
        await d.writeback(row.id, existing.uid, existing.txHash);
        out.rows.push({ id: row.id, key, outcome: 'readback_existing', uid: existing.uid });
        continue;
      }
    } catch (e: any) {
      // Readback unknown ⇒ sending could double-anchor. Refuse this row.
      out.rows.push({ id: row.id, key, outcome: 'failed', error: `readback not checked: ${e?.message ?? e}` });
      continue;
    }
    let r: Awaited<ReturnType<AttestFn>>;
    try {
      out.sent++;
      r = await d.chain.attest(buildMemoryRootAttest(row));
    } catch (e: any) {
      out.rows.push({ id: row.id, key, outcome: 'ambiguous', error: e?.message ?? String(e) });
      continue;
    }
    if (r.uid) {
      await d.writeback(row.id, r.uid, r.txHash);
      out.rows.push({ id: row.id, key, outcome: 'anchored', uid: r.uid });
    } else {
      out.rows.push({ id: row.id, key, outcome: 'failed', error: r.error });
    }
  }
  return out;
}
