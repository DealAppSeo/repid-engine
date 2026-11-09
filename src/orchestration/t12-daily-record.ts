/**
 * t12-daily-record.ts — one small, machine-readable record of the work T12 actually did on one UTC day.
 *
 * Built only from the hash-chained receipts on `trinity_tasks`. Busy is not good: nothing here scores
 * reputation or anchors anything, and the record says so. "Free" is stated only with provider-side
 * evidence passed in; a route being marked free in our own code is not evidence of the bill.
 */
import { verifyReceipts, type DecisionReceipt, type LaneState } from './t12-lane-store';

export const DAILY_RECORD_SCHEMA = 'dev.hyperdag.t12-daily-record/0.1';

export interface FreeEntitlement { host: string; verified: boolean; evidence: string }
export interface ProviderUse { host: string; attempts: number; answered: number; rate_limited: number; failed: number; verified_free: boolean | null; free_basis: string }
export interface DailyRecord {
  schema: typeof DAILY_RECORD_SCHEMA;
  date: string;
  source: 'synthetic' | 'real';
  tasks: { attempted: number; accepted: number; rejected: number; not_checked: number; integrated: number; waiting_for_capacity: number };
  leases: { claims: number; stage_claims: number; expired_and_recovered: number; released: number };
  belts: { checked_out: number; denied: number };
  providers: ProviderUse[];
  tests: Array<{ task: string; verdict: 'approved' | 'rejected' | 'not_checked'; commit: string | null; exit: number | null; controls: number; reason: string | null }>;
  receipts: Array<{ task: string; count: number; last_hash: string; chain_ok: boolean }>;
  reputation: { scored: false; anchored: false; reason: string };
}

interface Row { state: LaneState }

const isoDay = (at: string) => new Date(at).toISOString().slice(0, 10);

/**
 * A published reason is a short code. Rejection reasons can carry what a model's code printed, and this record
 * goes to a public job summary, so nothing after the first colon is copied and markup is stripped. Receipts keep the detail.
 */
export const plainReason = (reason: string): string | null =>
  (reason.split(':')[0] ?? '').replace(/[<>[\]()!*_`#|~\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || null;

function hostUse(uses: Map<string, ProviderUse>, host: string, entitlements: readonly FreeEntitlement[]): ProviderUse {
  let u = uses.get(host);
  if (!u) {
    const e = entitlements.find((x) => x.host === host);
    u = { host, attempts: 0, answered: 0, rate_limited: 0, failed: 0, verified_free: e ? e.verified : null, free_basis: e ? e.evidence : 'NOT_CHECKED: no provider-side evidence was supplied' };
    uses.set(host, u);
  }
  return u;
}

/** Pure, so it is tested without a database. A receipt counts on the UTC day it was written. */
export function buildDailyRecord(rows: readonly Row[], date: string, source: DailyRecord['source'], entitlements: readonly FreeEntitlement[] = []): DailyRecord {
  const record: DailyRecord = {
    schema: DAILY_RECORD_SCHEMA,
    date,
    source,
    tasks: { attempted: 0, accepted: 0, rejected: 0, not_checked: 0, integrated: 0, waiting_for_capacity: 0 },
    leases: { claims: 0, stage_claims: 0, expired_and_recovered: 0, released: 0 },
    belts: { checked_out: 0, denied: 0 },
    providers: [],
    tests: [],
    receipts: [],
    reputation: { scored: false, anchored: false, reason: 'Postponed until the work itself is reliable. Activity is not a score.' },
  };
  const uses = new Map<string, ProviderUse>();
  for (const { state } of rows) {
    const today = state.receipts.filter((r: DecisionReceipt) => isoDay(r.at) === date);
    if (!today.length) continue;
    const task = state.spec.id;
    if (today.some((r) => r.event === 'claimed')) record.tasks.attempted += 1;
    for (const r of today) {
      const ev = (r.evidence ?? {}) as Record<string, unknown>;
      const counters: Record<string, () => void> = {
        claimed: () => { record.leases.claims += 1; },
        stage_claimed: () => { record.leases.stage_claims += 1; },
        lease_reaped: () => { record.leases.expired_and_recovered += 1; },
        stage_lease_expired: () => { record.leases.expired_and_recovered += 1; },
        released: () => { record.leases.released += 1; },
        belt_checked_out: () => { record.belts.checked_out += 1; },
        belt_denied: () => { record.belts.denied += 1; },
        integrated: () => { record.tasks.integrated += 1; },
        waiting_for_capacity: () => { record.tasks.waiting_for_capacity += 1; },
        check_approved: () => {
          record.tasks.accepted += 1;
          record.tests.push({ task, verdict: 'approved', commit: String(ev.commit ?? '') || null, exit: typeof ev.exit === 'number' ? ev.exit : null, controls: Array.isArray(ev.controls) ? ev.controls.length : 0, reason: null });
        },
        check_rejected: () => {
          record.tasks.rejected += 1;
          record.tests.push({ task, verdict: 'rejected', commit: null, exit: null, controls: 0, reason: plainReason(r.reason) });
        },
        check_not_checked: () => {
          record.tasks.not_checked += 1;
          record.tests.push({ task, verdict: 'not_checked', commit: null, exit: null, controls: 0, reason: plainReason(r.reason) });
        },
        route_attempt: () => {
          const u = hostUse(uses, String(ev.provider ?? 'unknown'), entitlements);
          u.attempts += 1;
          if (ev.status === 429) u.rate_limited += 1;
          else if (typeof ev.status === 'number' && ev.status >= 200 && ev.status < 300) u.answered += 1;
          else u.failed += 1;
        },
      };
      counters[r.event]?.();
    }
    record.receipts.push({ task, count: state.receipts.length, last_hash: state.receipts.at(-1)!.hash, chain_ok: verifyReceipts(state.receipts).ok });
  }
  record.providers = [...uses.values()].sort((a, b) => a.host.localeCompare(b.host));
  return record;
}
