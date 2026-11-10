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
 * is never refunded, so a stale worker cannot write after losing its lease.
 *
 * CLOCK. Every expiry compares against the database clock, so lanes on different hosts cannot
 * disagree about whether a lease is live.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../services/receipt-signer';
import { evaluateHandoff, type RequiredOutput } from './handoff-gate';
import { HEARTBEAT_TTL_MS, MAX_LEASE_AGE_MS } from './write-lease';

export const LANE_POOL = 'trinity-t12-lanes';
/** Above MAX_ATTEMPTS because a crash also spends a claim: the reaper does not refund one. A blameless release does. */
export const MAX_TASK_CLAIMS = 6;
export const MAX_ATTEMPTS = 3;
export const MAX_NOT_CHECKED = 3;
/** Longer than a check's worst case (install, the test, then each control), so a slow check is not taken from under itself. */
export const STAGE_TTL_SECONDS = 45 * 60;
export const MAX_CONTROLS = 5;
/** One claim is at most MAX_HOSTS_PER_ASK model calls, so this bounds unattended free-tier use per UTC day. */
export const DAILY_CLAIM_CAP = 60;
const LEASE_SECONDS = HEARTBEAT_TTL_MS / 1000;
const MAX_LEASE_AGE_SECONDS = MAX_LEASE_AGE_MS / 1000;
const POOL_STATUSES = ['pending', 'claimed', 'pending_validation', 'cancelled', 'not_checked'];

/** Repos a lane may work on. A row naming any other repo is refused at replenish and at claim. */
export const LANE_REPOS: readonly string[] = ['DealAppSeo/trustshell', 'DealAppSeo/t12-dogfood-sandbox'];

export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
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
  /** Which of `paths` already exist and may be changed. Anything else must be a new file. */
  overwrites?: string[];
  /** A runner name and one target, never a command: nothing executable is read from a task row. */
  verify: { runner: 'jest' | 'node-test'; target: string; controls?: Control[] };
  risk: Risk;
  priority?: number;
  /** Files handed to the model as supplied evidence. */
  context?: string[];
  /** Which belt this task's writes need. Defaults to engineering. Postgres decides what each belt covers. */
  belt?: 'engineering' | 'research';
}

/**
 * A deliberate break in the code under test. The test must fail once it is applied. This is the
 * negative control for a test-only task: removing the test proves only that the file went missing.
 */
export interface Control {
  file: string;
  find: string;
  replace: string;
}

export type Stage =
  | 'ready' | 'making' | 'awaiting_check' | 'checking' | 'approved' | 'integrating' | 'integrated'
  | 'rejected' | 'not_checked' | 'waiting_for_capacity';

export interface Submission {
  branch: string;
  commit: string;
  base: string;
  files: string[];
  host: string | null;
  /** SHA-256 of the git bundle, when the commit has to travel to another machine. */
  bundle_sha256?: string;
}

/** Why this decision happened: a person asked, a schedule fired, the system chose, or it was repairing itself. */
export type ReceiptOrigin = 'human_prompt' | 'scheduled' | 'autonomous' | 'recovery';

export interface DecisionReceipt {
  seq: number;
  at: string;
  actor: string;
  origin: ReceiptOrigin;
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
  /** Not claimable before this time: every free route was cooling when it last ran. */
  notBefore?: string;
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
const badPath = (p: unknown): boolean =>
  typeof p !== 'string' || !p || /[*?\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..');

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
      if (badPath(p)) out.push(`path ${String(p)} is not an exact repo-relative file`);
      else if (PROTECTED_PATH.test(p)) out.push(`path ${p} is protected`);
    }
  }
  if (s.overwrites !== undefined && (!Array.isArray(s.overwrites) || !s.overwrites.every((p) => s.paths?.includes(p)))) {
    out.push('overwrites must be a subset of its paths');
  }
  // Context is read from disk and sent to a model, so it gets the same fence as a write.
  for (const p of Array.isArray(s.context) ? s.context : []) {
    if (badPath(p) || PROTECTED_PATH.test(p)) out.push(`context ${String(p)} may not be read`);
  }
  if (s.context !== undefined && !Array.isArray(s.context)) out.push('context is not a list');
  if (s.belt !== undefined && s.belt !== 'engineering' && s.belt !== 'research') out.push('belt must be engineering or research');
  // A maker bases on origin/main, which does not hold a dependency until a human merges it.
  if ((s as { dependsOn?: unknown[] }).dependsOn?.length) out.push('dependsOn is not supported until merges are tracked');
  if (!s.verify || !['jest', 'node-test'].includes(s.verify.runner)) out.push('has no machine-checkable verify runner');
  else if (!Array.isArray(s.paths) || !s.paths.includes(s.verify.target)) out.push('verify target is not one of its paths');
  else {
    const controls = Array.isArray(s.verify.controls) ? s.verify.controls : [];
    if (controls.length > MAX_CONTROLS) out.push(`more than ${MAX_CONTROLS} controls`);
    for (const c of controls) {
      if (badPath(c?.file) || PROTECTED_PATH.test(c.file) || s.paths.includes(c.file)) out.push(`control file ${String(c?.file)} must be code outside the deliverable`);
      else if (typeof c.find !== 'string' || !c.find || typeof c.replace !== 'string' || c.find === c.replace) out.push(`control on ${c.file} changes nothing`);
    }
    if (controls.length === 0 && s.paths.every((p) => p === s.verify!.target)) {
      out.push('a test-only task needs a control that breaks the code under test');
    }
  }
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(String(s.risk))) out.push('risk is not LOW, MEDIUM or HIGH');
  return out;
}

const lockKey = (s: LaneSpec, p: string) => `${s.repo}\0${p.toLowerCase()}`;

/**
 * The first candidate that conflicts with no held path. Paths are
 * exact files, so conflict is equality; `patternsMayOverlap` compares directory prefixes and would
 * make every pair of new tests under `tests/` collide. Lower-cased for Windows and macOS checkouts.
 */
export function pickClaimable<T extends { spec: LaneSpec }>(
  candidates: readonly T[],
  held: readonly LaneSpec[],
): T | undefined {
  const locked = new Set(held.flatMap((s) => s.paths.map((p) => lockKey(s, p))));
  return candidates.find(
    (c) =>
      validateSpec(c.spec).length === 0 &&
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
  refundClaim?: boolean;
  columns?: Partial<Record<'artifact_url' | 'external_artifact_url' | 'verifier_verdict' | 'verifier_evidence' | 'final_verdict' | 'verification_method' | 'stuck_reason', string>>;
  verified?: boolean;
  completed?: boolean;
}

async function persist(c: SqlRunner, id: Row['id'], state: LaneState, p: Persist): Promise<void> {
  const col = p.columns ?? {};
  const written = await c.query(
    `UPDATE trinity_tasks SET
       status = $2,
       claimed_by = $3,
       claimed_at = CASE WHEN $3::text IS NULL THEN NULL WHEN $5 THEN now() ELSE claimed_at END,
       started_at = CASE WHEN $5 AND status = 'pending' THEN now() ELSE started_at END,
       expires_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END,
       claim_count = GREATEST(claim_count + CASE WHEN $5 AND status = 'pending' THEN 1 ELSE 0 END - CASE WHEN $16 THEN 1 ELSE 0 END, 0),
       metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{t12}', $6::jsonb),
       artifact_url = COALESCE($7, artifact_url),
       external_artifact_url = COALESCE($8, external_artifact_url),
       verifier_verdict = COALESCE($9, verifier_verdict),
       verifier_evidence = COALESCE($10, verifier_evidence),
       final_verdict = COALESCE($11, final_verdict),
       verification_method = COALESCE($12, verification_method),
       stuck_reason = CASE WHEN $5 AND status = 'pending' THEN NULL ELSE COALESCE($13, stuck_reason) END,
       verified_at = CASE WHEN $14 THEN now() ELSE verified_at END,
       verify_count = COALESCE(verify_count, 0) + CASE WHEN $14 THEN 1 ELSE 0 END,
       completed_at = CASE WHEN $15 THEN now() ELSE completed_at END
     WHERE id = $1`,
    [
      id, p.status, p.claimedBy, p.leaseSeconds ?? null, !!p.newClaim, JSON.stringify(state),
      col.artifact_url ?? null, col.external_artifact_url ?? null, col.verifier_verdict ?? null,
      col.verifier_evidence ?? null, col.final_verdict ?? null, col.verification_method ?? null,
      col.stuck_reason ?? null, !!p.verified, !!p.completed, !!p.refundClaim,
    ],
  );
  // A row policy or a trigger can skip the row without raising an error.
  if (written.rowCount === 0) throw new Error(`task ${String(id)} was not written`);
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

function step(row: Row, s: LaneState, actor: string, event: string, to: Stage, reason: string, evidence: unknown = null, origin: ReceiptOrigin = 'autonomous'): LaneState {
  return { ...s, stage: to, receipts: appendReceipt(s.receipts, { at: row.db_now, actor, origin, event, from: s.stage, to, epoch: s.epoch, reason, evidence }) };
}

/** The cron frees a lease without writing a receipt, so the next reader of the row records it. */
function noteReap(row: Row, s: LaneState): LaneState {
  return s.stage === 'making' ? step(row, s, 'trinity_reap_expired_claims', 'lease_reaped', 'ready', 'the previous maker lost its lease', null, 'recovery') : s;
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

/**
 * Take the next task whose paths are free, among the repos this run can serve. One lane at a time
 * holds the advisory lock while deciding.
 *
 * `repos` is the set this run has clones for. Without it a run met the top row for a repo it could
 * not serve, paused on "no local clone", spent a daily-cap slot and never reached a row it could
 * serve (gate-0 probe P2, 2026-11-09). Rows for other repos are left untouched for a run that can
 * serve them. An empty list serves nothing. Omitted means every repo on LANE_REPOS, which only
 * in-process callers with no clones use; the CLI always passes its `--repo` list.
 */
export async function claimMake(db: TxDb, lane: string, opts: { dailyCap?: number; origin?: ReceiptOrigin; repos?: readonly string[] } = {}): Promise<ClaimResult> {
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

    // A task out of claims gets a terminal state and a reason instead of sitting pending, unservable.
    const { rows: spent } = await c.query(
      `SELECT ${ROW_COLUMNS} FROM trinity_tasks
        WHERE assigned_to = $1 AND status = 'pending' AND claimed_by IS NULL AND claim_count >= $2
          AND metadata #> '{t12,spec}' IS NOT NULL FOR UPDATE SKIP LOCKED`,
      [LANE_POOL, MAX_TASK_CLAIMS],
    );
    for (const row of spent as Row[]) {
      const reason = `claim limit of ${MAX_TASK_CLAIMS} reached without a checked result`;
      await persist(c, row.id, step(row, noteReap(row, stateOf(row)), 'claimMake', 'claim_limit', 'not_checked', reason, null, 'recovery'), {
        status: 'not_checked', claimedBy: null, columns: { stuck_reason: reason },
      });
    }

    const { rows } = await c.query(
      `SELECT ${ROW_COLUMNS} FROM trinity_tasks
        WHERE assigned_to = $1 AND status = 'pending' AND claimed_by IS NULL AND claim_count < $2
          AND metadata #> '{t12,spec}' IS NOT NULL
          AND (metadata #>> '{t12,notBefore}' IS NULL OR (metadata #>> '{t12,notBefore}')::timestamptz <= now())
          AND ($3::text[] IS NULL OR metadata #>> '{t12,spec,repo}' = ANY($3::text[]))
        ORDER BY priority DESC NULLS LAST, created_at ASC LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [LANE_POOL, MAX_TASK_CLAIMS, opts.repos ?? null],
    );
    const candidates = (rows as Row[]).map((row) => ({ row, spec: stateOf(row).spec }));
    if (candidates.length === 0) {
      return { kind: 'none', reason: opts.repos ? `no ready task in the repos this run can serve: ${opts.repos.join(', ') || 'none'}` : 'no ready task' };
    }

    const { rows: held } = await c.query(
      `SELECT metadata #> '{t12,spec}' AS spec FROM trinity_tasks
        WHERE assigned_to = $1 AND status IN ('claimed', 'pending_validation')
          AND metadata #>> '{t12,stage}' IN ('making', 'awaiting_check', 'checking')`,
      [LANE_POOL],
    );
    const pick = pickClaimable(candidates, held.map((h: any) => h.spec));
    if (!pick) return { kind: 'none', reason: 'every ready task is blocked by a held path' };

    let s = noteReap(pick.row, stateOf(pick.row));
    s = { ...s, epoch: s.epoch + 1, notBefore: undefined };
    s = step(pick.row, s, lane, 'claimed', 'making', `attempt ${s.attempts + 1}`, null, opts.origin ?? 'autonomous');
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

export type BeltResult = { ok: true; belt: string; grantId: string; expiresAt: string } | { ok: false; reason: string };

/** Ask Postgres for this claim's belt. Runs apart from the receipt so a failed receipt cannot undo the grant or denial. */
export async function checkoutBelt(db: TxDb, h: Handle): Promise<BeltResult> {
  const { rows } = await db.query(`SELECT public.t12_belt_checkout($1, $2, $3) AS r`, [h.taskId, h.actor, h.epoch]);
  const r = rows[0].r as { ok: boolean; reason?: string; belt?: string; grant_id?: string; expires_at?: string };
  await fenced(db, h, 'claimed', 'making', async (c, row, s) => {
    const next = step(row, s, h.actor, r.ok ? 'belt_checked_out' : 'belt_denied', 'making', r.ok ? `${r.belt} belt` : String(r.reason), r);
    await c.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12}', $2::jsonb) WHERE id = $1`, [row.id, JSON.stringify(next)]);
  });
  return r.ok ? { ok: true, belt: r.belt!, grantId: r.grant_id!, expiresAt: r.expires_at! } : { ok: false, reason: String(r.reason) };
}

export async function submit(db: TxDb, h: Handle, submission: Submission): Promise<StepResult> {
  try {
    return await fenced(db, h, 'claimed', 'making', async (c, row, s) => {
      const next = { ...step(row, s, h.actor, 'submitted', 'awaiting_check', `commit ${submission.commit}`, submission), producer: h.actor, submission };
      await persist(c, row.id, next, { status: 'pending_validation', claimedBy: null, columns: { artifact_url: `git://${s.spec.repo}@${submission.commit}` } });
    });
  } catch (e) {
    if ((e as { code?: string }).code !== '42501') throw e;
  }
  // Postgres refused the write. Asking again records why (expired or revoked) where the worker cannot edit it.
  const belt = await checkoutBelt(db, h);
  const reason = `belt refused the submission: ${belt.ok ? 'the files are outside the belt' : belt.reason}`;
  await releaseMake(db, h, reason, false);
  return { ok: false, fenced: true, reason };
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
      await persist(c, row.id, step(row, s, h.actor, 'released', 'ready', reason), { status: 'pending', claimedBy: null, refundClaim: true });
      return;
    }
    const { next, p } = afterFailure(row, s, h.actor, 'maker_failed', reason);
    await persist(c, row.id, next, p);
  });
}

/** No free route can take this now. Costs nothing, and the task is not offered again until `until`. */
export async function waitForCapacity(db: TxDb, h: Handle, until: string, reason: string): Promise<StepResult> {
  return fenced(db, h, 'claimed', 'making', async (c, row, s) => {
    const next = { ...step(row, s, h.actor, 'waiting_for_capacity', 'waiting_for_capacity', reason, { until }), notBefore: until };
    await persist(c, row.id, next, { status: 'pending', claimedBy: null, refundClaim: true, columns: { stuck_reason: `WAITING_FOR_CAPACITY until ${until}: ${reason}`.slice(0, 500) } });
  });
}

const COOLDOWN_PREFIX = 'llm_cooldown:';

/** Keep `host` out of rotation for `seconds`. Durable, so a new process or another lane honours it. */
export async function coolProvider(db: SqlRunner, host: string, seconds: number, reason: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO agent_resource_claims (resource_kind, resource_id, claimed_by, purpose, expires_at)
     VALUES ('other', $1, 'trinity-lane-router', $2, now() + make_interval(secs => $3::int))
     ON CONFLICT (resource_kind, resource_id) WHERE released_at IS NULL
     DO UPDATE SET expires_at = GREATEST(agent_resource_claims.expires_at, EXCLUDED.expires_at), purpose = EXCLUDED.purpose
     RETURNING expires_at::text AS until`,
    [COOLDOWN_PREFIX + host, reason.slice(0, 200), seconds],
  );
  return rows[0].until;
}

const WAKE_PREFIX = 'lane_wake:';

/**
 * Take the single live run slot for this lane. A second wake of the same lane, from a double-fired
 * schedule or a manual run, gets false and leaves. A crashed holder's slot opens when it expires.
 */
export async function acquireWake(db: SqlRunner, lane: string, wakeId: string, ttlSeconds: number): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO agent_resource_claims (resource_kind, resource_id, claimed_by, session_id, purpose, expires_at)
     VALUES ('other', $1, 'trinity-lane-router', $2, 'lane run', now() + make_interval(secs => $3::int))
     ON CONFLICT (resource_kind, resource_id) WHERE released_at IS NULL
     DO UPDATE SET session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at
       WHERE agent_resource_claims.expires_at < now() OR agent_resource_claims.session_id = EXCLUDED.session_id
     RETURNING session_id`,
    [WAKE_PREFIX + lane, wakeId, ttlSeconds],
  );
  return rows.length === 1;
}

export async function releaseWake(db: SqlRunner, lane: string, wakeId: string): Promise<void> {
  await db.query(
    `UPDATE agent_resource_claims SET released_at = now()
      WHERE resource_kind = 'other' AND resource_id = $1 AND session_id = $2 AND released_at IS NULL`,
    [WAKE_PREFIX + lane, wakeId],
  );
}

/** The emergency halt read over the worker's own connection, so a worker needs no service key. */
export function pgHaltClient(db: SqlRunner): { from: (table: string) => any } {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            try {
              const { rows } = await db.query('SELECT emergency_halt FROM trinity_system_config WHERE id = 1');
              return { data: rows[0] ?? null, error: null };
            } catch (e) {
              return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
            }
          },
        }),
      }),
    }),
  };
}

/** Hosts cooling right now, with the time each comes back. */
export async function coolingProviders(db: SqlRunner): Promise<Map<string, string>> {
  const { rows } = await db.query(
    `SELECT resource_id, expires_at::text AS until FROM agent_resource_claims
      WHERE resource_kind = 'other' AND resource_id LIKE $1 AND released_at IS NULL AND expires_at > now()`,
    [`${COOLDOWN_PREFIX}%`],
  );
  return new Map(rows.map((r: { resource_id: string; until: string }) => [r.resource_id.slice(COOLDOWN_PREFIX.length), r.until]));
}

/** Append one route attempt to the task's receipts. Fenced, so a stale worker cannot add to the record. */
export async function recordRouteAttempt(
  db: TxDb,
  h: Handle,
  a: { host: string; model: string; status: number | null; reason: string },
  cooldownUntil: string | null,
): Promise<StepResult> {
  return fenced(db, h, 'claimed', 'making', async (c, row, s) => {
    const evidence = { provider: a.host, model: a.model, reason: a.reason, status: a.status, cooldown_until: cooldownUntil, task_id: h.taskId };
    const next = step(row, s, h.actor, 'route_attempt', 'making', a.reason, evidence);
    await c.query(`UPDATE trinity_tasks SET metadata = jsonb_set(metadata, '{t12}', $2::jsonb) WHERE id = $1`, [row.id, JSON.stringify(next)]);
  });
}

/**
 * Claim a post-make stage. Checking can never be taken by the lane that produced the work. `repos`
 * is as for claimMake: a checker or integrator without a clone for a row's repo leaves it alone,
 * rather than spending that task's not-checked allowance on "no local clone".
 */
export async function claimStage(db: TxDb, stage: 'awaiting_check' | 'approved', actor: string, origin: ReceiptOrigin = 'autonomous', repos?: readonly string[]): Promise<Handle | null> {
  assertActor(actor);
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT ${ROW_COLUMNS} FROM trinity_tasks
        WHERE assigned_to = $1 AND status = 'pending_validation' AND claimed_by IS NULL
          AND metadata #>> '{t12,stage}' = $2
          AND ($2 <> 'awaiting_check' OR metadata #>> '{t12,producer}' IS DISTINCT FROM $3)
          AND ($2 <> 'approved' OR metadata #>> '{t12,spec,risk}' <> 'HIGH')
          AND ($4::text[] IS NULL OR metadata #>> '{t12,spec,repo}' = ANY($4::text[]))
        ORDER BY priority DESC NULLS LAST, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [LANE_POOL, stage, actor, repos ?? null],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    let s = stateOf(row);
    s = { ...s, epoch: s.epoch + 1 };
    s = step(row, s, actor, 'stage_claimed', stage === 'approved' ? 'integrating' : 'checking', stage, null, origin);
    await persist(c, row.id, s, { status: 'pending_validation', claimedBy: actor, newClaim: true });
    return { taskId: Number(row.id), actor, epoch: s.epoch, spec: s.spec, attempts: s.attempts, submission: s.submission };
  });
}

/** Free check and integrate claims whose holder went away, back to the same stage. */
export async function recoverStages(db: TxDb, ttlSeconds: number = STAGE_TTL_SECONDS): Promise<number> {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT ${ROW_COLUMNS} FROM trinity_tasks
        WHERE assigned_to = $1 AND status = 'pending_validation' AND claimed_by IS NOT NULL
          AND claimed_at <= now() - make_interval(secs => $2::int)
          AND metadata #> '{t12,spec}' IS NOT NULL FOR UPDATE SKIP LOCKED`,
      [LANE_POOL, ttlSeconds],
    );
    for (const row of rows as Row[]) {
      const s = stateOf(row);
      const to: Stage = s.stage === 'integrating' ? 'approved' : 'awaiting_check';
      const next = step(row, s, 'recoverStages', 'stage_lease_expired', to, `${row.claimed_by} went silent`, null, 'recovery');
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
        // A re-run by the same controller is not a second voice, and the most this can open is a draft.
        voices: [],
        touchesLiveState: false,
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
        columns: { verifier_verdict: 'approved', verifier_evidence: verdict.transcript.slice(-4000), final_verdict: 'unverified', verification_method: 'fresh_checkout_rerun' },
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

/** Thrown when a row names a ref it may not. Retrying cannot help, so the runner ends the task. */
export class PublishRefused extends Error {}

const OBJECT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/** The row is worker-writable, so a ref read back from it is checked before git sees it. */
export function submissionRefProblem(spec: LaneSpec, sub: Submission): string | null {
  if (!OBJECT_ID.test(String(sub.commit))) return 'the submitted commit is not an object id';
  if (!OBJECT_ID.test(String(sub.base))) return 'the submitted base is not an object id';
  const prefix = `t12/${spec.id}-e`;
  const branch = String(sub.branch);
  if (!SPEC_ID.test(spec.id) || !branch.startsWith(prefix) || !/^[0-9]+$/.test(branch.slice(prefix.length))) {
    return "the submitted branch is not this task's lane branch";
  }
  return null;
}

export async function refuseIntegration(db: TxDb, h: Handle, reason: string): Promise<StepResult> {
  return fenced(db, h, 'pending_validation', 'integrating', async (c, row, s) => {
    const next = step(row, s, h.actor, 'integration_refused', 'rejected', reason);
    await persist(c, row.id, next, { status: 'cancelled', claimedBy: null, columns: { final_verdict: 'rejected', stuck_reason: reason.slice(0, 500) } });
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
    let eligible = all.filter((r: any) => r.id && r.status === 'pending' && r.claim_count < MAX_TASK_CLAIMS).length;
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
        receipts: appendReceipt([], { at: nowRow[0].db_now, actor: 'replenish', origin: 'autonomous', event: 'enqueued', from: 'none', to: 'ready', epoch: 0, reason: 'vetted spec', evidence: null }),
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
