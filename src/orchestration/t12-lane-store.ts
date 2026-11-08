/**
 * t12-lane-store.ts — durable claim → check → integrate state for T12 coding lanes.
 *
 * `trinity_tasks` is the authoritative task and lease store (D-151 C4), so this file adds no table
 * and needs no DDL. Every transition is one transaction: lock the row, check the fence, append the
 * decision receipt, write. A crash can never leave a state change without its receipt.
 *
 * WHY THESE STATUSES, MEASURED 2026-11-07 AGAINST PROD AND THE RUNTIME:
 * - `assigned_to = LANE_POOL` keeps the fleet's CLAIM_SQL off these rows.
 * - Making is `claimed`, not `doing`: the fleet reaper releases any `doing`/`in_progress` row older
 *   than 60 minutes whether or not its worker is alive.
 * - Everything after making stays `pending_validation`, with the real stage in metadata.t12.stage.
 *   `trinity-task-bridge` polls `done`, `verified` and `shadow_reject` into RepID, so a lane row
 *   must never pass through those: this path cannot move a score by construction.
 * - Rejection ends in `cancelled`, not `failed`: `trg_auto_escalate` can bounce `failed` to `pending`.
 *
 * THE LEASE. Making holds `expires_at`, which the existing `trinity_reap_expired_claims` cron frees.
 * That reaper has no status guard, so every exit from making clears `expires_at`, and check and
 * integrate claims never set it (`recoverStages` frees those instead, back to the same stage rather
 * than back to the maker). `metadata.t12.epoch` is the fencing token: it rises on every claim and
 * recovery and is never refunded, so a stale worker cannot write after losing its lease.
 *
 * CLOCK. Every expiry compares against the database clock, so lanes on different hosts cannot
 * disagree about whether a lease is live.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../services/receipt-signer';
import { evaluateHandoff, type RequiredOutput } from './handoff-gate';
import { HEARTBEAT_TTL_MS, MAX_LEASE_AGE_MS } from './write-lease';

export const LANE_POOL = 'trinity-t12-lanes';
/** Above MAX_ATTEMPTS because a crash also spends a claim: the reaper does not refund one. */
export const MAX_TASK_CLAIMS = 6;
export const MAX_ATTEMPTS = 3;
export const MAX_NOT_CHECKED = 3;
export const STAGE_TTL_SECONDS = 15 * 60;
/** One claim is at most one model call, so this bounds unattended free-tier use per UTC day. */
export const DAILY_CLAIM_CAP = 60;
const LEASE_SECONDS = HEARTBEAT_TTL_MS / 1000;
const MAX_LEASE_AGE_SECONDS = MAX_LEASE_AGE_MS / 1000;
const POOL_STATUSES = ['pending', 'claimed', 'pending_validation', 'cancelled', 'not_checked'];

/** Repos a lane may work on. A row naming any other repo is refused at replenish and at claim. */
export const LANE_REPOS: readonly string[] = ['DealAppSeo/trustshell'];

export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
export interface TxDb extends SqlRunner {
  tx<T>(fn: (c: SqlRunner) => Promise<T>): Promise<T>;
}

/** Bind a pg Pool. Advisory locks are transaction-scoped, so this is safe on the :6543 pooler. */
export function poolDb(pool: {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<SqlRunner & { release(): void }>;
}): TxDb {
  return {
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';
export interface LaneSpec {
  id: string;
  repo: string;
  title: string;
  prompt: string;
  /** Exact repo-relative files the maker may write. These are the path locks. */
  paths: string[];
  /** A runner name and one target, never a command: nothing executable is read from a task row. */
  verify: { runner: 'jest' | 'node-test'; target: string };
  risk: Risk;
  priority?: number;
  dependsOn?: string[];
  /** Files handed to the model as supplied evidence. */
  context?: string[];
}

export type Stage =
  | 'ready' | 'making' | 'awaiting_check' | 'checking' | 'approved' | 'integrating' | 'integrated'
  | 'rejected' | 'not_checked';

export interface Submission {
  branch: string;
  commit: string;
  base: string;
  files: string[];
  host: string | null;
}

export interface DecisionReceipt {
  seq: number;
  at: string;
  actor: string;
  event: string;
  from: string;
  to: string;
  epoch: number;
  reason: string;
  evidence: unknown;
  prev: string;
  hash: string;
}

export interface LaneState {
  spec: LaneSpec;
  stage: Stage;
  epoch: number;
  attempts: number;
  notChecked: number;
  producer?: string;
  submission?: Submission;
  lastRejection?: string;
  integrated?: { url: string; commit: string };
  receipts: DecisionReceipt[];
}

export interface Handle {
  taskId: number;
  actor: string;
  epoch: number;
  spec: LaneSpec;
  attempts: number;
  lastRejection?: string;
  submission?: Submission;
}

export type ClaimResult =
  | { kind: 'claimed'; handle: Handle }
  | { kind: 'none'; reason: string }
  | { kind: 'paused'; reason: string };
export type StepResult = { ok: true } | { ok: false; fenced: boolean; reason: string };

const GENESIS = '0'.repeat(64);

function receiptHash(r: Omit<DecisionReceipt, 'hash'>): string {
  return createHash('sha256').update(canonicalize(r)).digest('hex');
}

export function appendReceipt(
  receipts: readonly DecisionReceipt[],
  input: Omit<DecisionReceipt, 'seq' | 'prev' | 'hash'>,
): DecisionReceipt[] {
  const last = receipts[receipts.length - 1];
  const body = { ...input, seq: receipts.length, prev: last ? last.hash : GENESIS };
  return [...receipts, { ...body, hash: receiptHash(body) }];
}

/** Recompute the chain. Detects an edit or a removal; a row rewritten whole needs an external anchor. */
export function verifyReceipts(receipts: readonly DecisionReceipt[]): { ok: boolean; brokenAt?: number } {
  let prev = GENESIS;
  for (let i = 0; i < receipts.length; i++) {
    const { hash, ...body } = receipts[i]!;
    if (body.seq !== i || body.prev !== prev || receiptHash(body) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true };
}

const PROTECTED_PATH = /^(\.github\/|\.claude\/|\.husky\/|package(-lock)?\.json$|.*\.npmrc$|.*\.env(\..*)?$)/i;
const SPEC_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** Why a lane may not take this spec. Empty means eligible. */
export function validateSpec(s: Partial<LaneSpec> | null | undefined): string[] {
  if (!s || typeof s !== 'object') return ['not an object'];
  const out: string[] = [];
  if (typeof s.id !== 'string' || !SPEC_ID.test(s.id)) out.push('id is missing or malformed');
  if (typeof s.repo !== 'string' || !LANE_REPOS.includes(s.repo)) out.push(`repo ${String(s.repo)} is not allowed`);
  if (typeof s.title !== 'string' || !s.title.trim()) out.push('title is empty');
  if (typeof s.prompt !== 'string' || s.prompt.trim().length < 40) out.push('prompt is too thin to act on');
  if (!Array.isArray(s.paths) || s.paths.length === 0) out.push('names no paths');
  else {
    for (const p of s.paths) {
      if (typeof p !== 'string' || !p || /[*?\\]/.test(p) || p.startsWith('/') || p.split('/').includes('..')) {
        out.push(`path ${String(p)} is not an exact repo-relative file`);
      } else if (PROTECTED_PATH.test(p)) out.push(`path ${p} is protected`);
    }
  }
  if (!s.verify || !['jest', 'node-test'].includes(s.verify.runner)) out.push('has no machine-checkable verify runner');
  else if (!Array.isArray(s.paths) || !s.paths.includes(s.verify.target)) out.push('verify target is not one of its paths');
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(String(s.risk))) out.push('risk is not LOW, MEDIUM or HIGH');
  return out;
}

const lockKey = (s: LaneSpec, p: string) => `${s.repo}\0${p.toLowerCase()}`;

/**
 * The first candidate that conflicts with no held path and has its dependencies met. Paths are
 * exact files, so conflict is equality; `patternsMayOverlap` compares directory prefixes and would
 * make every pair of new tests under `tests/` collide. Lower-cased for Windows and macOS checkouts.
 */
export function pickClaimable<T extends { spec: LaneSpec }>(
  candidates: readonly T[],
  held: readonly LaneSpec[],
  satisfied: ReadonlySet<string>,
): T | undefined {
  const locked = new Set(held.flatMap((s) => s.paths.map((p) => lockKey(s, p))));
  return candidates.find(
    (c) =>
      validateSpec(c.spec).length === 0 &&
      (c.spec.dependsOn ?? []).every((d) => satisfied.has(d)) &&
      !c.spec.paths.some((p) => locked.has(lockKey(c.spec, p))),
  );
}

interface Row {
  id: string | number;
  status: string;
  claimed_by: string | null;
  metadata: { t12?: LaneState } | null;
  lease_live?: boolean | null;
  age_ok?: boolean | null;
  db_now: string;
}

function stateOf(row: Row): LaneState {
  const s = row.metadata?.t12;
  if (!s || !s.spec || !Array.isArray(s.receipts)) throw new Error(`task ${row.id} has no lane state`);
  return s;
}

const ACTOR = /^trinity-[a-z0-9-]+$/;
function assertActor(actor: string): void {
  // The DB requires this prefix and normalize_agent_name lowercases, so anything else would break the fence.
  if (!ACTOR.test(actor)) throw new Error(`invalid lane actor: ${actor}`);
}

interface Persist {
  status: string;
  claimedBy: string | null;
  leaseSeconds?: number | null;
  newClaim?: boolean;
  columns?: Partial<Record<'artifact_url' | 'external_artifact_url' | 'verifier_verdict' | 'verifier_evidence' | 'final_verdict' | 'verification_method' | 'stuck_reason', string>>;
  verified?: boolean;
  completed?: boolean;
}

async function persist(c: SqlRunner, id: Row['id'], state: LaneState, p: Persist): Promise<void> {
  const col = p.columns ?? {};
  await c.query(
    `UPDATE trinity_tasks SET
       status = $2,
       claimed_by = $3,
       claimed_at = CASE WHEN $3::text IS NULL THEN NULL WHEN $5 THEN now() ELSE claimed_at END,
       started_at = CASE WHEN $5 AND status = 'pending' THEN now() ELSE started_at END,
       expires_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END,
       claim_count = claim_count + CASE WHEN $5 AND status = 'pending' THEN 1 ELSE 0 END,
       metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{t12}', $6::jsonb),
       artifact_url = COALESCE($7, artifact_url),
       external_artifact_url = COALESCE($8, external_artifact_url),
       verifier_verdict = COALESCE($9, verifier_verdict),
       verifier_evidence = COALESCE($10, verifier_evidence),
       final_verdict = COALESCE($11, final_verdict),
       verification_method = COALESCE($12, verification_method),
       stuck_reason = COALESCE($13, stuck_reason),
       verified_at = CASE WHEN $14 THEN now() ELSE verified_at END,
       verify_count = COALESCE(verify_count, 0) + CASE WHEN $14 THEN 1 ELSE 0 END,
       completed_at = CASE WHEN $15 THEN now() ELSE completed_at END
     WHERE id = $1`,
    [
      id, p.status, p.claimedBy, p.leaseSeconds ?? null, !!p.newClaim, JSON.stringify(state),
      col.artifact_url ?? null, col.external_artifact_url ?? null, col.verifier_verdict ?? null,
      col.verifier_evidence ?? null, col.final_verdict ?? null, col.verification_method ?? null,
      col.stuck_reason ?? null, !!p.verified, !!p.completed,
    ],
  );
}

const ROW_COLUMNS = `id, status, claimed_by, metadata, now()::text AS db_now`;

async function lockRow(c: SqlRunner, taskId: number): Promise<Row | undefined> {
  const { rows } = await c.query(
    `SELECT ${ROW_COLUMNS}, expires_at > now() AS lease_live,
            claimed_at > now() - make_interval(secs => $2::int) AS age_ok
       FROM trinity_tasks WHERE id = $1 AND assigned_to = $3 FOR UPDATE`,
    [taskId, MAX_LEASE_AGE_SECONDS, LANE_POOL],
  );
  return rows[0];
}

function fenceProblem(row: Row | undefined, h: Handle, status: string, stage: Stage): string | null {
  if (!row) return 'task is not in the lane pool';
  const s = stateOf(row);
  if (row.status !== status) return `status is ${row.status}, expected ${status}`;
  if (row.claimed_by !== h.actor) return `held by ${row.claimed_by ?? 'nobody'}, not ${h.actor}`;
  if (s.epoch !== h.epoch) return `epoch is ${s.epoch}, this worker holds ${h.epoch}`;
  if (s.stage !== stage) return `stage is ${s.stage}, expected ${stage}`;
  if (status === 'claimed' && !row.lease_live) return 'lease expired';
  return null;
}

function step(row: Row, s: LaneState, actor: string, event: string, to: Stage, reason: string, evidence: unknown = null): LaneState {
  return { ...s, stage: to, receipts: appendReceipt(s.receipts, { at: row.db_now, actor, event, from: s.stage, to, epoch: s.epoch, reason, evidence }) };
}

async function fenced(
  db: TxDb,
  h: Handle,
  status: string,
  stage: Stage,
  apply: (c: SqlRunner, row: Row, s: LaneState) => Promise<void>,
): Promise<StepResult> {
  return db.tx(async (c) => {
    const row = await lockRow(c, h.taskId);
    const problem = fenceProblem(row, h, status, stage);
    if (problem) return { ok: false, fenced: true, reason: problem };
    await apply(c, row!, stateOf(row!));
    return { ok: true };
  });
}

/** Take the next task whose paths are free. One lane at a time holds the advisory lock while deciding. */
export async function claimMake(db: TxDb, lane: string, opts: { dailyCap?: number } = {}): Promise<ClaimResult> {
  assertActor(lane);
  const cap = opts.dailyCap ?? DAILY_CLAIM_CAP;
  return db.tx(async (c): Promise<ClaimResult> => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('t12-lanes'))`);

    const { rows: used } = await c.query(
      `SELECT count(*)::int AS n
         FROM trinity_tasks t, jsonb_array_elements(t.metadata #> '{t12,receipts}') r
        WHERE t.assigned_to = $1 AND t.status = ANY($2::varchar[])
          AND r->>'event' = 'claimed' AND (r->>'at')::timestamptz >= date_trunc('day', now())`,
      [LANE_POOL, POOL_STATUSES],
    );
    if (used[0].n >= cap) return { kind: 'paused', reason: `QUOTA_PAUSED: ${used[0].n}/${cap} claims today` };

    const { rows } = await c.query(
      `SELECT ${ROW_COLUMNS} FROM trinity_tasks
        WHERE assigned_to = $1 AND status = 'pending' AND claimed_by IS NULL AND claim_count < $2
        ORDER BY priority DESC NULLS LAST, created_at ASC LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [LANE_POOL, MAX_TASK_CLAIMS],
    );
    const candidates = (rows as Row[]).map((row) => ({ row, spec: stateOf(row).spec }));
    if (candidates.length === 0) return { kind: 'none', reason: 'no ready task' };

    const { rows: held } = await c.query(
      `SELECT metadata #> '{t12,spec}' AS spec FROM trinity_tasks
        WHERE assigned_to = $1 AND status IN ('claimed', 'pending_validation')
          AND metadata #>> '{t12,stage}' IN ('making', 'awaiting_check', 'checking')`,
      [LANE_POOL],
    );
    const { rows: met } = await c.query(
      `SELECT metadata #>> '{t12,spec,id}' AS id FROM trinity_tasks
        WHERE assigned_to = $1 AND metadata #>> '{t12,stage}' IN ('approved', 'integrating', 'integrated')
          AND status = 'pending_validation'`,
      [LANE_POOL],
    );
    const pick = pickClaimable(candidates, held.map((h: any) => h.spec), new Set(met.map((m: any) => m.id)));
    if (!pick) return { kind: 'none', reason: 'every ready task is blocked by a held path or a dependency' };

    let s = stateOf(pick.row);
    if (s.stage === 'making') {
      s = step(pick.row, s, 'trinity_reap_expired_claims', 'lease_reaped', 'ready', 'the previous maker lost its lease');
    }
    s = { ...s, epoch: s.epoch + 1 };
    s = step(pick.row, s, lane, 'claimed', 'making', `attempt ${s.attempts + 1}`);
    await persist(c, pick.row.id, s, { status: 'claimed', claimedBy: lane, leaseSeconds: LEASE_SECONDS, newClaim: true });
    return {
      kind: 'claimed',
      handle: { taskId: Number(pick.row.id), actor: lane, epoch: s.epoch, spec: s.spec, attempts: s.attempts, lastRejection: s.lastRejection },
    };
  });
}

/** Proof of life. Refuses an expired lease rather than reviving it, and stops at the 12 hour ceiling. */
export async function heartbeat(db: TxDb, h: Handle): Promise<StepResult> {
  return db.tx(async (c) => {
    const row = await lockRow(c, h.taskId);
    const problem = fenceProblem(row, h, 'claimed', 'making');
    if (problem) return { ok: false, fenced: true, reason: problem };
    if (!row!.age_ok) return { ok: false, fenced: true, reason: 'lease hit the 12 hour ceiling' };
    await c.query(`UPDATE trinity_tasks SET expires_at = now() + make_interval(secs => $2::int) WHERE id = $1`, [h.taskId, LEASE_SECONDS]);
    return { ok: true };
  });
}

export async function submit(db: TxDb, h: Handle, submission: Submission): Promise<StepResult> {
  return fenced(db, h, 'claimed', 'making', async (c, row, s) => {
    const next = { ...step(row, s, h.actor, 'submitted', 'awaiting_check', `commit ${submission.commit}`, submission), producer: h.actor, submission };
    await persist(c, row.id, next, { status: 'pending_validation', claimedBy: null, columns: { artifact_url: `git://${s.spec.repo}@${submission.commit}` } });
  });
}

function afterFailure(row: Row, s: LaneState, actor: string, event: string, reason: string): { next: LaneState; p: Persist } {
  const attempts = s.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    return {
      next: { ...step(row, s, actor, event, 'rejected', `${reason} (attempt ${attempts} of ${MAX_ATTEMPTS})`), attempts, lastRejection: reason },
      p: { status: 'cancelled', claimedBy: null, columns: { final_verdict: 'rejected', stuck_reason: reason.slice(0, 500) } },
    };
  }
  return {
    next: { ...step(row, s, actor, event, 'ready', reason), attempts, lastRejection: reason },
    p: { status: 'pending', claimedBy: null },
  };
}

/** Give the task back. Blameless (rate limit, host down) costs no attempt; a bad output does. */
export async function releaseMake(db: TxDb, h: Handle, reason: string, blameless: boolean): Promise<StepResult> {
  return fenced(db, h, 'claimed', 'making', async (c, row, s) => {
    if (blameless) {
      await persist(c, row.id, step(row, s, h.actor, 'released', 'ready', reason), { status: 'pending', claimedBy: null });
      return;
    }
    const { next, p } = afterFailure(row, s, h.actor, 'maker_failed', reason);
    await persist(c, row.id, next, p);
  });
}

/** Claim a post-make stage. Checking can never be taken by the lane that produced the work. */
export async function claimStage(db: TxDb, stage: 'awaiting_check' | 'approved', actor: string): Promise<Handle | null> {
  assertActor(actor);
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT ${ROW_COLUMNS} FROM trinity_tasks
        WHERE assigned_to = $1 AND status = 'pending_validation' AND claimed_by IS NULL
          AND metadata #>> '{t12,stage}' = $2
          AND ($2 <> 'awaiting_check' OR metadata #>> '{t12,producer}' IS DISTINCT FROM $3)
          AND ($2 <> 'approved' OR metadata #>> '{t12,spec,risk}' <> 'HIGH')
        ORDER BY priority DESC NULLS LAST, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [LANE_POOL, stage, actor],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    let s = stateOf(row);
    s = { ...s, epoch: s.epoch + 1 };
    s = step(row, s, actor, 'stage_claimed', stage === 'approved' ? 'integrating' : 'checking', stage);
    await persist(c, row.id, s, { status: 'pending_validation', claimedBy: actor, newClaim: true });
    return { taskId: Number(row.id), actor, epoch: s.epoch, spec: s.spec, attempts: s.attempts, submission: s.submission };
  });
}

/** Free check and integrate claims whose holder went away, back to the same stage, with the epoch raised. */
export async function recoverStages(db: TxDb, ttlSeconds: number = STAGE_TTL_SECONDS): Promise<number> {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT ${ROW_COLUMNS} FROM trinity_tasks
        WHERE assigned_to = $1 AND status = 'pending_validation' AND claimed_by IS NOT NULL
          AND claimed_at <= now() - make_interval(secs => $2::int) FOR UPDATE SKIP LOCKED`,
      [LANE_POOL, ttlSeconds],
    );
    for (const row of rows as Row[]) {
      const s = stateOf(row);
      const to: Stage = s.stage === 'integrating' ? 'approved' : 'awaiting_check';
      const next = step(row, { ...s, epoch: s.epoch + 1 }, 'recoverStages', 'stage_lease_expired', to, `${row.claimed_by} went silent`);
      await persist(c, row.id, next, { status: 'pending_validation', claimedBy: null });
    }
    return rows.length;
  });
}

export type Verdict =
  | { outcome: 'approved'; commit: string; transcript: string; evidence: Record<string, unknown> }
  | { outcome: 'rejected'; reason: string; evidence?: Record<string, unknown> }
  | { outcome: 'not_checked'; reason: string };

const CHECK_OUTPUTS: readonly RequiredOutput[] = [
  { key: 'commit', kind: 'artifact', description: 'the commit that was re-run' },
  { key: 'transcript', kind: 'prose', description: 'the command and what it printed' },
];

/** Record the check. An approval the handoff gate will not advance is downgraded, never written. */
export async function recordVerdict(db: TxDb, h: Handle, v: Verdict): Promise<StepResult> {
  return fenced(db, h, 'pending_validation', 'checking', async (c, row, s) => {
    let verdict: Verdict = v;
    if (v.outcome === 'approved') {
      const gate = evaluateHandoff({
        taskId: h.taskId,
        producer: 'T12',
        requiredOutputs: CHECK_OUTPUTS,
        reported: { commit: v.commit, transcript: v.transcript },
        voices: [{ lane: 'HARNESS', agrees: true }],
        touchesLiveState: true,
      });
      if (!gate.advance) verdict = { outcome: 'not_checked', reason: gate.reason };
      else if (v.commit !== s.submission?.commit) {
        verdict = { outcome: 'not_checked', reason: `checked ${v.commit}, submission is ${s.submission?.commit}` };
      }
    }

    if (verdict.outcome === 'approved') {
      const next = step(row, s, h.actor, 'check_approved', 'approved', 'deterministic re-run passed', { ...verdict.evidence, independence: 'same_controller_rerun' });
      await persist(c, row.id, next, {
        status: 'pending_validation', claimedBy: null, verified: true,
        columns: { verifier_verdict: 'approved', verifier_evidence: verdict.transcript.slice(-4000), final_verdict: 'verified_done', verification_method: 'fresh_checkout_rerun' },
      });
    } else if (verdict.outcome === 'rejected') {
      const { next, p } = afterFailure(row, s, h.actor, 'check_rejected', verdict.reason);
      p.columns = { ...p.columns, verifier_verdict: 'rejected', verifier_evidence: verdict.reason.slice(-4000) };
      await persist(c, row.id, next, p);
    } else {
      const notChecked = s.notChecked + 1;
      const giveUp = notChecked >= MAX_NOT_CHECKED;
      const next = { ...step(row, s, h.actor, 'check_not_checked', giveUp ? 'not_checked' : 'awaiting_check', verdict.reason), notChecked };
      await persist(c, row.id, next, { status: giveUp ? 'not_checked' : 'pending_validation', claimedBy: null, columns: { verifier_verdict: 'unclear', stuck_reason: verdict.reason.slice(0, 500) } });
    }
  });
}

export async function recordIntegration(db: TxDb, h: Handle, url: string): Promise<StepResult> {
  return fenced(db, h, 'pending_validation', 'integrating', async (c, row, s) => {
    const commit = s.submission!.commit;
    const next = { ...step(row, s, h.actor, 'integrated', 'integrated', 'draft PR open; a human merges', { url, commit }), integrated: { url, commit } };
    await persist(c, row.id, next, { status: 'pending_validation', claimedBy: null, completed: true, columns: { external_artifact_url: url } });
  });
}

export interface ReplenishReport {
  inserted: string[];
  invalid: Array<{ id: string; problems: string[] }>;
  eligible: number;
  target: number;
  /** Set when the pool stays below target. Filler is never inserted to close the gap. */
  underflow: string | null;
}

/** Top the pool up to `target` from vetted specs, deduped by spec id across every state. */
export async function replenish(db: TxDb, specs: readonly LaneSpec[], target: number): Promise<ReplenishReport> {
  return db.tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('t12-lanes'))`);
    const { rows: all } = await c.query(
      `SELECT status, claim_count, metadata #>> '{t12,spec,id}' AS id, now()::text AS db_now FROM trinity_tasks WHERE assigned_to = $1`,
      [LANE_POOL],
    );
    const seen = new Set(all.map((r: any) => r.id));
    let eligible = all.filter((r: any) => r.status === 'pending' && r.claim_count < MAX_TASK_CLAIMS).length;
    const { rows: nowRow } = await c.query(`SELECT now()::text AS db_now`);
    const inserted: string[] = [];
    const invalid: ReplenishReport['invalid'] = [];
    for (const spec of specs) {
      const problems = validateSpec(spec);
      if (problems.length) {
        invalid.push({ id: String(spec?.id), problems });
        continue;
      }
      if (seen.has(spec.id) || eligible >= target) continue;
      const state: LaneState = {
        spec, stage: 'ready', epoch: 0, attempts: 0, notChecked: 0,
        receipts: appendReceipt([], { at: nowRow[0].db_now, actor: 'replenish', event: 'enqueued', from: 'none', to: 'ready', epoch: 0, reason: 'vetted spec', evidence: null }),
      };
      await c.query(
        `INSERT INTO trinity_tasks (title, description, task_type, task_category, status, assigned_to, priority, insert_source, metadata)
         VALUES ($1, $2, 'code', 'building', 'pending', $3, $4, 't12-lane-replenish', jsonb_build_object('t12', $5::jsonb))`,
        [spec.title, spec.prompt, LANE_POOL, spec.priority ?? 50, JSON.stringify(state)],
      );
      seen.add(spec.id);
      inserted.push(spec.id);
      eligible++;
    }
    return {
      inserted, invalid, eligible, target,
      underflow: eligible < target ? `READY_UNDERFLOW: ${eligible}/${target} eligible, ${invalid.length} specs refused` : null,
    };
  });
}

export async function readLaneState(db: SqlRunner, taskId: number): Promise<{ status: string; claimed_by: string | null; state: LaneState }> {
  const { rows } = await db.query(`SELECT id, status, claimed_by, metadata FROM trinity_tasks WHERE id = $1`, [taskId]);
  return { status: rows[0].status, claimed_by: rows[0].claimed_by, state: stateOf(rows[0]) };
}
