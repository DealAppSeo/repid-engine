/**
 * LIVE DAILY TOTALS for the checker ledger (Sean, 2026-10-06: "daily totals").
 *
 * WHAT IS KEPT. Per UTC day, per checker: how many TRUE, FALSE and UNSURE answers it gave, how many
 * times it was sent the claim and gave none, how many times it was refused before any request. Per
 * deciding pair: agreed true, agreed false, contradicted (one TRUE, one FALSE), one or both unsure,
 * incomplete. Keyed by the vote prompt's short hash and the engine commit, because the same model
 * under a different prompt or harness is a different measurement.
 *
 * WHAT IS NEVER KEPT. The claim, the question, a user, an IP, a key. note() takes the voters and
 * their outcomes, which are provider names and verdict words, and nothing else reaches this module.
 *
 * NEVER ON THE REQUEST PATH. note() only adds to a map in memory. A timer flushes the map through
 * two RPCs every FLUSH_MS. A failed flush never touches a check; a missing function (the migration
 * not applied yet) makes the module inert for the life of the process, so nothing piles up. Counts
 * not yet flushed when the process stops are lost, at most FLUSH_MS of them: these are totals, not
 * a record of each check.
 */
import { createHash } from 'node:crypto';
import type { VoteOutcome, Voter } from '../classify/free-votes';
import { voteWasSent } from '../classify/free-votes';

export const FLUSH_MS = 10 * 60 * 1000;
/** Bounds memory if the database is unreachable for a long time. Beyond it, new keys are dropped. */
export const MAX_KEYS = 500;

export interface CheckerCounts {
  true_n: number;
  false_n: number;
  unsure_n: number;
  no_answer_n: number;
  not_sent_n: number;
}

export interface PairCounts {
  agreed_true: number;
  agreed_false: number;
  contradicted: number;
  one_unsure: number;
  both_unsure: number;
  incomplete: number;
}

interface CheckerKey {
  day: string;
  checker: string;
  prompt_version: string;
  engine_commit: string;
}

interface PairKey {
  day: string;
  checker_a: string;
  checker_b: string;
  prompt_version: string;
  engine_commit: string;
}

const checkers = new Map<string, { key: CheckerKey; counts: CheckerCounts }>();
const pairs = new Map<string, { key: PairKey; counts: PairCounts }>();
let inert = false;
let timer: ReturnType<typeof setInterval> | undefined;

export function engineCommit(env: NodeJS.ProcessEnv = process.env): string {
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? '').trim();
  return sha ? sha.slice(0, 7) : 'unknown';
}

/** Short, stable id for a prompt: two prompts with one changed word get different ids. */
export function promptVersion(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 10);
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function checkerName(v: Voter): string {
  return `${v.provider}:${v.model}`;
}

function zeroChecker(): CheckerCounts {
  return { true_n: 0, false_n: 0, unsure_n: 0, no_answer_n: 0, not_sent_n: 0 };
}

function zeroPair(): PairCounts {
  return { agreed_true: 0, agreed_false: 0, contradicted: 0, one_unsure: 0, both_unsure: 0, incomplete: 0 };
}

/** Which pair bucket two final outcomes fall in. */
export function pairBucket(a: VoteOutcome, b: VoteOutcome): keyof PairCounts {
  if (a.kind !== 'verdict' || b.kind !== 'verdict') return 'incomplete';
  const x = a.verdict;
  const y = b.verdict;
  if (x === 'UNSURE' && y === 'UNSURE') return 'both_unsure';
  if (x === 'UNSURE' || y === 'UNSURE') return 'one_unsure';
  if (x === y) return x === 'TRUE' ? 'agreed_true' : 'agreed_false';
  return 'contradicted';
}

function checkerBucket(o: VoteOutcome): keyof CheckerCounts {
  if (o.kind === 'verdict') return o.verdict === 'TRUE' ? 'true_n' : o.verdict === 'FALSE' ? 'false_n' : 'unsure_n';
  return voteWasSent(o) ? 'no_answer_n' : 'not_sent_n';
}

export interface NoteInput {
  /** Every vote cast, stand-ins included. */
  attempts: ReadonlyArray<{ voter: Voter; outcome: VoteOutcome }>;
  /** The two deciders and their final outcomes, one per slot. */
  deciders: readonly Voter[];
  outcomes: readonly VoteOutcome[];
  prompt: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Adds one check's votes to today's totals. Memory only; never throws. */
export function note(input: NoteInput): void {
  if (inert) return;
  try {
    const now = input.now ?? Date.now;
    const day = utcDay(now());
    const prompt_version = promptVersion(input.prompt);
    const engine_commit = engineCommit(input.env);
    for (const { voter, outcome } of input.attempts) {
      const key: CheckerKey = { day, checker: checkerName(voter), prompt_version, engine_commit };
      const id = JSON.stringify(key);
      let row = checkers.get(id);
      if (!row) {
        if (checkers.size >= MAX_KEYS) continue;
        row = { key, counts: zeroChecker() };
        checkers.set(id, row);
      }
      row.counts[checkerBucket(outcome)] += 1;
    }
    const [da, db] = input.deciders;
    const [oa, ob] = input.outcomes;
    if (da && db && oa && ob) {
      const [x, y] = [checkerName(da), checkerName(db)].sort() as [string, string];
      const key: PairKey = { day, checker_a: x, checker_b: y, prompt_version, engine_commit };
      const id = JSON.stringify(key);
      let row = pairs.get(id);
      if (!row && pairs.size < MAX_KEYS) {
        row = { key, counts: zeroPair() };
        pairs.set(id, row);
      }
      if (row) row.counts[pairBucket(oa, ob)] += 1;
    }
  } catch {
    // Counting is advisory; a check never fails because of it.
  }
}

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { code?: string; message?: string } | null }>;
}

/** PostgREST's "function not found", or Postgres' undefined function / table: the migration is not applied. */
export function isMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01';
}

export interface FlushResult {
  sent: number;
  failed: number;
  inert: boolean;
}

type Row<K, C> = { key: K; counts: C };

function putBack<K, C extends object>(map: Map<string, Row<K, C>>, row: Row<K, C>): void {
  const id = JSON.stringify(row.key);
  const have = map.get(id);
  if (have) {
    const into = have.counts as Record<string, number>;
    for (const [k, v] of Object.entries(row.counts as Record<string, number>)) into[k] = (into[k] ?? 0) + v;
  } else if (map.size < MAX_KEYS) map.set(id, row);
}

/** Sends every row of one map through `fn`. Rows that fail go back for the next flush. */
async function send<K, C extends object>(
  client: RpcClient,
  map: Map<string, Row<K, C>>,
  fn: string,
  args: (row: Row<K, C>) => Record<string, unknown>,
): Promise<{ sent: number; failed: number }> {
  const rows = [...map.values()];
  map.clear();
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    if (inert) break;
    try {
      const { error } = await client.rpc(fn, args(row));
      if (isMissing(error)) markInert(`${fn} is not in the database (migration not applied)`);
      else if (error) {
        failed += 1;
        putBack(map, row);
      } else sent += 1;
    } catch {
      failed += 1;
      putBack(map, row);
    }
  }
  return { sent, failed };
}

/** Writes and clears what has been noted. Never throws. */
export async function flush(client: RpcClient | null | undefined): Promise<FlushResult> {
  if (inert) return { sent: 0, failed: 0, inert };
  if (!client || typeof client.rpc !== 'function') {
    markInert('no rpc client (local store?)');
    return { sent: 0, failed: 0, inert };
  }
  const a = await send(client, checkers, 'ledger_bump_checker_daily', ({ key, counts }) => ({
    p_day: key.day,
    p_checker: key.checker,
    p_prompt_version: key.prompt_version,
    p_engine_commit: key.engine_commit,
    p_true: counts.true_n,
    p_false: counts.false_n,
    p_unsure: counts.unsure_n,
    p_no_answer: counts.no_answer_n,
    p_not_sent: counts.not_sent_n,
  }));
  const b = await send(client, pairs, 'ledger_bump_pair_daily', ({ key, counts }) => ({
    p_day: key.day,
    p_checker_a: key.checker_a,
    p_checker_b: key.checker_b,
    p_prompt_version: key.prompt_version,
    p_engine_commit: key.engine_commit,
    p_agreed_true: counts.agreed_true,
    p_agreed_false: counts.agreed_false,
    p_contradicted: counts.contradicted,
    p_one_unsure: counts.one_unsure,
    p_both_unsure: counts.both_unsure,
    p_incomplete: counts.incomplete,
  }));
  return { sent: a.sent + b.sent, failed: a.failed + b.failed, inert };
}

function markInert(why: string): void {
  if (inert) return;
  inert = true;
  checkers.clear();
  pairs.clear();
  console.warn(`[ledger] daily totals off for this process: ${why}`);
}

/** Starts the flush timer. Parks on the emergency halt like every other tick loop. */
export function startLedgerFlush(everyMs: number = FLUSH_MS): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      const { shouldParkForHalt } = await import('../services/emergency-halt.js');
      const { db } = await import('../db.js');
      if (await shouldParkForHalt(db, 'ledgerFlush')) return;
      await flush(db as unknown as RpcClient);
    } catch {
      // Advisory: a failed flush must never reach the request path.
    }
  };
  timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
}

/** Tests only. */
export function __ledgerState() {
  return { inert, checkers: [...checkers.values()], pairs: [...pairs.values()] };
}

/** Tests only. */
export function __resetLedger(): void {
  inert = false;
  checkers.clear();
  pairs.clear();
  if (timer) clearInterval(timer);
  timer = undefined;
}
