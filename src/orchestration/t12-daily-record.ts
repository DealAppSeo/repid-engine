/**
 * t12-daily-record.ts — one small, machine-readable record of the work T12 actually did on one UTC day.
 *
 * Built only from the hash-chained receipts on `trinity_tasks`. Busy is not good: nothing here scores
 * reputation or anchors anything, and the record says so. "Free" is stated only with provider-side
 * evidence passed in; a route being marked free in our own code is not evidence of the bill.
 */
import type { LeasePathCode } from './t12-lane-git';
import { verifyReceipts, type DecisionReceipt, type LaneState } from './t12-lane-store';

/** 0.2: `providers[].failed` became counts by ProviderFailureCode, and a lease refusal carries `path_code`. */
export const DAILY_RECORD_SCHEMA = 'dev.hyperdag.t12-daily-record/0.2';

/**
 * Why a provider gave no answer. timeout: no full reply in time. stream_cut: a reply started and broke, or a stream ended
 * without [DONE]. http_error: a non-2xx other than 429. connect_error: no HTTP reply at all. empty_answer: a complete 2xx
 * with no usable text. other: anything else, such as a call refused before any byte left.
 */
export type ProviderFailureCode = 'timeout' | 'stream_cut' | 'http_error' | 'connect_error' | 'empty_answer' | 'other';

export interface FreeEntitlement { host: string; verified: boolean; evidence: string }
export interface ProviderUse { host: string; attempts: number; answered: number; rate_limited: number; failed: Record<ProviderFailureCode, number>; verified_free: boolean | null; free_basis: string }
export interface DailyRecord {
  schema: typeof DAILY_RECORD_SCHEMA;
  date: string;
  source: 'synthetic' | 'real';
  tasks: { attempted: number; accepted: number; rejected: number; not_checked: number; integrated: number; waiting_for_capacity: number; maker_refused: number };
  leases: { claims: number; stage_claims: number; expired_and_recovered: number; released: number };
  belts: { checked_out: number; denied: number };
  providers: ProviderUse[];
  tests: Array<{ task: string; verdict: 'approved' | 'rejected' | 'not_checked'; commit: string | null; exit: number | null; controls: number; reason: string | null }>;
  /** Why the lane refused a model's output before any check: codes from closed sets, never the reason text or the path. */
  refusals: Array<{ task: string } & MakerRefusal>;
  receipts: Array<{ task: string; count: number; last_hash: string; chain_ok: boolean }>;
  reputation: { scored: false; anchored: false; reason: string };
}

export type MakerRefusalCode = 'no_json' | 'invalid_json' | 'no_files' | 'file_missing_path_or_content' | 'path_outside_lease' | 'no_change' | 'belt_denied' | 'other';
/** `path_code` is present only on a path_outside_lease the lane labelled (readMakerFiles in t12-lane-git.ts). */
export interface MakerRefusal { code: MakerRefusalCode; path_code?: LeasePathCode }

const FILE_SET = 'model output was not a valid file set inside the lease: ';
const LEASE = /^outside the lease \((same_after_normalize|escapes_root|other_path)\): /;

/**
 * The code for a maker_failed reason, matched against the lane's own phrases (t12-lane-git.ts, t12-lane-runner.ts).
 * Two of those reasons embed model text (an out-of-lease path, a JSON parser message that quotes the reply), so the
 * text is never copied. Both start with fixed lane text and the model's text follows it, so a crafted path cannot
 * forge a code or put words in the record. The `is outside the lease` suffix is the format before path_code existed.
 */
export function makerRefusalCode(reason: string): MakerRefusal {
  if (reason === 'the model produced no change') return { code: 'no_change' };
  if (reason.startsWith('belt denied')) return { code: 'belt_denied' };
  if (!reason.startsWith(FILE_SET)) return { code: 'other' };
  const rest = reason.slice(FILE_SET.length);
  if (rest === 'no JSON object in the reply') return { code: 'no_json' };
  if (rest === 'no files in the reply') return { code: 'no_files' };
  if (rest === 'a file is missing its path or content') return { code: 'file_missing_path_or_content' };
  if (rest.startsWith('invalid JSON: ')) return { code: 'invalid_json' };
  const lease = LEASE.exec(rest);
  if (lease) return { code: 'path_outside_lease', path_code: lease[1] as LeasePathCode };
  if (rest.endsWith(' is outside the lease')) return { code: 'path_outside_lease' };
  return { code: 'other' };
}

/** A route attempt's own reason (t12-attempt.ts) as one code. Never its status: an empty or cut-off 2xx is status 200. */
export function providerOutcome(reason: unknown): 'answered' | 'rate_limited' | ProviderFailureCode {
  if (reason === 'answered' || reason === 'rate_limited' || reason === 'timeout' || reason === 'stream_cut' || reason === 'empty_answer') return reason;
  if (reason === 'network_error') return 'connect_error';
  return typeof reason === 'string' && /^http_\d{3}$/.test(reason) ? 'http_error' : 'other';
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
    const failed = { timeout: 0, stream_cut: 0, http_error: 0, connect_error: 0, empty_answer: 0, other: 0 };
    u = { host, attempts: 0, answered: 0, rate_limited: 0, failed, verified_free: e ? e.verified : null, free_basis: e ? e.evidence : 'NOT_CHECKED: no provider-side evidence was supplied' };
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
    tasks: { attempted: 0, accepted: 0, rejected: 0, not_checked: 0, integrated: 0, waiting_for_capacity: 0, maker_refused: 0 },
    leases: { claims: 0, stage_claims: 0, expired_and_recovered: 0, released: 0 },
    belts: { checked_out: 0, denied: 0 },
    providers: [],
    tests: [],
    refusals: [],
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
        maker_failed: () => {
          record.tasks.maker_refused += 1;
          record.refusals.push({ task, ...makerRefusalCode(r.reason) });
        },
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
          const o = providerOutcome(ev.reason);
          if (o === 'answered' || o === 'rate_limited') u[o] += 1;
          else u.failed[o] += 1;
        },
      };
      counters[r.event]?.();
    }
    record.receipts.push({ task, count: state.receipts.length, last_hash: state.receipts.at(-1)!.hash, chain_ok: verifyReceipts(state.receipts).ok });
  }
  record.providers = [...uses.values()].sort((a, b) => a.host.localeCompare(b.host));
  return record;
}
