/**
 * L2 breaker 2.0 — enqueue birth-rate control (automatic, drain-only).
 *
 * WHY: breaker 2.1 is the MANUAL producer kill-switch and 2.3 structurally bans
 * one specific recursion. This is the AUTOMATIC volume governor that 2.1's doc
 * points at ("the automatic birth-rate / lineage breakers"): it catches a
 * producer that starts outpacing drainage BEFORE the queue explodes, without a
 * human having to notice and flip PRODUCER_HALT_CLASSES. It is the last big
 * anti-fragile floor piece the loop contract asks for before ramping real
 * producers (AUTONOMOUS_LOOP_CONTRACT — breakers "before ramping producers").
 *
 * WHAT: at a producer chokepoint, look at, for a task class over a recent
 * window, how many tasks are PENDING vs how many COMPLETED. If producers are
 * outpacing drainage — either an absolute pending ceiling is crossed (a
 * fork-bomb with little completion signal), or the pending/completed ratio
 * exceeds a threshold once there is enough completion signal to trust it — then
 * stop spawning NEW tasks of that class while workers keep draining the ones
 * already queued.
 *
 * MODE: BIRTH_RATE_BREAKER_MODE = off | shadow | enforce (default: shadow).
 *   off     — disabled (legacy behavior).
 *   shadow  — log what WOULD be halted, but still spawn (measure, no change).
 *   enforce — skip the spawn cycle when the rate is exceeded (drain-only).
 * Shadow-first on purpose: the thresholds want calibration against real live
 * volume before they gate anything (same discipline as the peer-verify prefilter
 * and RRL shadow modes). Zero DDL — pure env levers, instantly reversible.
 *
 * LEVERS (all optional, sane defaults):
 *   BIRTH_RATE_MAX_RATIO   — pending/completed ceiling            (default 2.0)
 *   BIRTH_RATE_WINDOW_MIN  — completion-count window, minutes     (default 15)
 *   BIRTH_RATE_MIN_SAMPLE  — min completed in window to trust ratio (default 20)
 *   BIRTH_RATE_MAX_PENDING — absolute pending ceiling per class   (default 500)
 *
 * FAIL-SAFE: this only ever SKIPS a spawn cycle, never adds one — the worst case
 * of a mis-set threshold is deferred useful work (recoverable), never extra work.
 * FAIL-OPEN on error: if the count query itself fails, do NOT halt (return
 * exceeded=false) and log loudly — an automatic breaker must not wedge every
 * producer on a flaky count; the manual 2.1 kill-switch and the 2.5 hard budget
 * breaker are the backstops. FAIL-LOUD: callers log every halt/would-halt.
 */

export type BirthRateMode = 'off' | 'shadow' | 'enforce';

export interface BirthRateConfig {
  maxRatio: number;
  windowMin: number;
  minSample: number;
  maxPending: number;
}

export interface BirthRateDecision {
  /** the rate condition tripped (independent of mode). */
  exceeded: boolean;
  /** exceeded AND mode==='enforce' — the caller should actually skip spawning. */
  halted: boolean;
  mode: BirthRateMode;
  pending: number;
  completed: number;
  /** pending/completed; Infinity when completed===0 and pending>0; 0 when both 0. */
  ratio: number;
  /** which rule tripped (or why it didn't) — for the fail-loud log. */
  reason: string;
}

function numEnv(raw: string | null | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Parse BIRTH_RATE_BREAKER_MODE. Default shadow. Pure. */
export function birthRateMode(
  env: string | null | undefined = process.env.BIRTH_RATE_BREAKER_MODE,
): BirthRateMode {
  const m = (env || 'shadow').trim().toLowerCase();
  return m === 'off' || m === 'enforce' ? (m as BirthRateMode) : 'shadow';
}

/** Resolve the numeric thresholds from env, each with a floor. Pure. */
export function birthRateConfig(env: NodeJS.ProcessEnv = process.env): BirthRateConfig {
  return {
    // maxRatio floored at >0 so a bad "0" can't halt everything.
    maxRatio: numEnv(env.BIRTH_RATE_MAX_RATIO, 2.0, Number.MIN_VALUE),
    windowMin: numEnv(env.BIRTH_RATE_WINDOW_MIN, 15, 1),
    minSample: numEnv(env.BIRTH_RATE_MIN_SAMPLE, 20, 0),
    maxPending: numEnv(env.BIRTH_RATE_MAX_PENDING, 500, 1),
  };
}

/** pending/completed with explicit handling of the empty-denominator case. Pure. */
export function birthRateRatio(pending: number, completed: number): number {
  if (completed > 0) return pending / completed;
  return pending > 0 ? Infinity : 0;
}

/**
 * Pure decision: given the two counts, the mode and the config, decide whether
 * the birth rate is exceeded and whether the caller should halt.
 *
 * Trips when EITHER:
 *   (a) pending >= maxPending — an absolute backlog ceiling; catches a fork-bomb
 *       that has produced a huge pending pile with little/no completion signal
 *       (where the ratio alone can't be trusted), OR
 *   (b) completed >= minSample AND pending/completed > maxRatio — sustained
 *       outpacing, only once there is enough completion signal to trust the ratio.
 */
export function computeBirthRateDecision(args: {
  pending: number;
  completed: number;
  mode: BirthRateMode;
  config: BirthRateConfig;
}): BirthRateDecision {
  const { pending, completed, mode, config } = args;
  const ratio = birthRateRatio(pending, completed);

  if (mode === 'off') {
    return { exceeded: false, halted: false, mode, pending, completed, ratio, reason: 'mode=off' };
  }

  const ceilingHit = pending >= config.maxPending;
  const ratioHit = completed >= config.minSample && ratio > config.maxRatio;
  const exceeded = ceilingHit || ratioHit;

  let reason: string;
  if (ceilingHit) {
    reason = `pending ${pending} >= ceiling ${config.maxPending}`;
  } else if (ratioHit) {
    reason = `ratio ${ratio.toFixed(2)} > ${config.maxRatio} (completed ${completed} >= sample ${config.minSample})`;
  } else if (completed < config.minSample) {
    reason = `below sample: completed ${completed} < ${config.minSample}, pending ${pending} < ceiling ${config.maxPending}`;
  } else {
    reason = `ok: ratio ${ratio.toFixed(2)} <= ${config.maxRatio}`;
  }

  return { exceeded, halted: exceeded && mode === 'enforce', mode, pending, completed, ratio, reason };
}

/** Minimal shape of the Supabase-ish client method chain this module needs. */
export interface CountableDb {
  from(table: string): any;
}

/**
 * Count pending vs recently-completed tasks of a class and decide. Impure only
 * in the two COUNT queries (head:true, no rows fetched). Fail-open on error.
 *
 * `nowMs` is injectable for deterministic tests; defaults to Date.now().
 */
export async function checkBirthRate(
  db: CountableDb,
  taskClass: string,
  opts: { env?: NodeJS.ProcessEnv; nowMs?: number } = {},
): Promise<BirthRateDecision> {
  const env = opts.env ?? process.env;
  const mode = birthRateMode(env.BIRTH_RATE_BREAKER_MODE);
  const config = birthRateConfig(env);

  if (mode === 'off') {
    return { exceeded: false, halted: false, mode, pending: 0, completed: 0, ratio: 0, reason: 'mode=off' };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = new Date(nowMs - config.windowMin * 60 * 1000).toISOString();
  const DONE_STATUSES = ['done', 'verified', 'shadow_reject', 'archived', 'completed'];

  try {
    const pendingRes = await db
      .from('trinity_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('task_type', taskClass)
      .eq('status', 'pending');

    const completedRes = await db
      .from('trinity_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('task_type', taskClass)
      .in('status', DONE_STATUSES)
      .gte('updated_at', windowStart);

    if (pendingRes?.error || completedRes?.error) {
      const msg = pendingRes?.error?.message || completedRes?.error?.message || 'unknown';
      return {
        exceeded: false, halted: false, mode, pending: 0, completed: 0, ratio: 0,
        reason: `fail-open: count query error (${msg})`,
      };
    }

    const pending = pendingRes?.count ?? 0;
    const completed = completedRes?.count ?? 0;
    return computeBirthRateDecision({ pending, completed, mode, config });
  } catch (err: any) {
    return {
      exceeded: false, halted: false, mode, pending: 0, completed: 0, ratio: 0,
      reason: `fail-open: count query threw (${err?.message ?? err})`,
    };
  }
}
