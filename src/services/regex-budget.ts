/**
 * Bounded regular-expression execution.
 *
 * WHY THIS EXISTS
 * ---------------
 * `task-verify-leg.ts` grades a task's output against an operator-supplied
 * `matches` pattern. That pattern is attacker-influenceable in practice — it
 * arrives in `trinity_tasks.expected_output`, which anything that can insert a
 * task can write. A catastrophically-backtracking pattern run against a 20,000
 * character subject does not fail; it pegs the event loop for minutes to hours,
 * and because the grader is synchronous the whole bridge worker goes with it.
 *
 * The guard so far has been `hasBacktrackingRisk()`, a static shape heuristic.
 * It has now been bypassed FOUR times across Beats 32, 33 and 38 — each fix
 * narrowed the gap and each next reading found another shape: `(a+){10}$`,
 * `(a|aa)+$`, `(a?)+`, `([a-z]{2,4})+`, nested-group prefixes, `{n,}` braces.
 * That is not a run of bad luck; the space of dangerous regexes is not finite
 * and cannot be enumerated by inspecting the source string. Seven beats have
 * carried "replace the heuristic with a timeout budget" as an open item.
 *
 * This is that budget, and the argument for it is the same one that made the
 * durable claim cap work in the sibling repo: bound the HARM, not the shapes.
 * A wall-clock deadline is TOTAL — it covers every pattern that exists today
 * and every one anyone writes later, without having to recognise any of them.
 *
 * WHY A WORKER THREAD AND NOT A TIMER
 * -----------------------------------
 * A backtracking regex is synchronous. `setTimeout` cannot interrupt it: the
 * timer callback is queued behind the very loop it is meant to cut short, so a
 * timeout implemented in-process fires only after the damage is done. The match
 * has to run somewhere terminable. `worker.terminate()` kills the thread's
 * isolate outright, which is the one mechanism that reliably stops a runaway
 * match. The cost is a thread spawn (tens of ms) per pattern — irrelevant here,
 * because the grader runs against finished tasks on a 30-second poll, not on a
 * request path.
 *
 * THE HEURISTIC IS NOT DELETED — IT IS DEMOTED.
 * `hasBacktrackingRisk` stays in front of this as an advisory pre-filter, for
 * one reason: it produces a good error at contract-PARSE time ("your pattern is
 * dangerous") instead of a silent per-task timeout forever afterwards. What
 * changes is that it is no longer load-bearing. If it misses — and the record
 * says it will — the budget still holds. Defence in depth, with the total
 * guarantee underneath and the helpful message on top.
 */

import { Worker } from 'worker_threads';

/**
 * Default wall-clock budget for one match. Deliberately generous: a legitimate
 * pattern over a 20 KB subject completes in well under a millisecond, so 250 ms
 * is ~3 orders of magnitude of headroom and cannot produce a false timeout on
 * honest input. It exists to separate "slow" from "never", not to be tight.
 */
export const DEFAULT_REGEX_BUDGET_MS = 250;

export type RegexBudgetResult =
  /** The match ran to completion inside the budget. */
  | { status: 'ok'; matched: boolean }
  /** The budget expired and the worker was terminated. NOT a match failure. */
  | { status: 'timeout'; budgetMs: number }
  /** The pattern was invalid, or the worker itself failed. */
  | { status: 'error'; message: string };

/**
 * The body run inside the worker. Kept as a string (`eval: true`) on purpose:
 * a separate .js file would have to survive the tsc build and land at a path
 * that resolves identically from `src/` under ts-node and from `dist/` in
 * production. A missing worker file degrades to "every match times out", which
 * looks exactly like a working budget and would be found only by someone
 * wondering why nothing ever matches. Inlining removes that failure mode.
 */
const WORKER_SRC = `
  const { parentPort, workerData } = require('worker_threads');
  try {
    const re = new RegExp(workerData.pattern, workerData.flags);
    parentPort.postMessage({ status: 'ok', matched: re.test(workerData.subject) });
  } catch (e) {
    parentPort.postMessage({ status: 'error', message: String((e && e.message) || e) });
  }
`;

/**
 * Run `new RegExp(pattern, flags).test(subject)` under a hard wall-clock budget.
 *
 * Never throws and never rejects: a grader fault must not cost a task its score
 * event, so every failure mode is returned as a value the caller can record.
 */
/**
 * Number of match workers currently alive.
 *
 * This exists because terminating on timeout is the half of the budget that is
 * invisible from the outside: a version that resolves the promise but leaves the
 * thread running passes every behavioural test above, while the runaway match
 * keeps burning a core for as long as it takes — a leak that looks exactly like
 * a working budget. The counter is what lets a test see the difference. It is
 * also worth having operationally: a number that does not return to zero is the
 * signature of that leak.
 */
let liveWorkers = 0;
export function activeWorkerCount(): number {
  return liveWorkers;
}

export async function matchWithBudget(
  pattern: string,
  flags: string,
  subject: string,
  budgetMs: number = DEFAULT_REGEX_BUDGET_MS
): Promise<RegexBudgetResult> {
  // Reject an invalid pattern here rather than paying for a thread to find out.
  // This is compilation only — it does no matching, so it cannot backtrack.
  try {
    new RegExp(pattern, flags);
  } catch (err: any) {
    return { status: 'error', message: `invalid pattern: ${err?.message ?? 'unknown'}` };
  }

  return new Promise<RegexBudgetResult>((resolve) => {
    let settled = false;
    let worker: Worker;

    // One `finish` for every exit path, so termination is guaranteed no matter
    // which of message/error/exit/timeout gets there first.
    //
    // Honest note on the `settled` flag specifically: a mutation that deletes it
    // SURVIVES the suite, and that is correct rather than a missing test. A
    // Promise ignores a second `resolve`, and `clearTimeout`/`terminate` are both
    // idempotent, so removing the guard changes nothing observable — every path
    // still terminates the worker. It stays because it makes the single-settle
    // intent explicit for the next reader, not because it is load-bearing.
    const finish = (result: RegexBudgetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // terminate() is safe to call on an already-exited worker.
      void worker?.terminate().catch(() => {});
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: 'timeout', budgetMs });
    }, budgetMs);
    // Do not let the budget timer hold the process open on shutdown.
    if (typeof timer.unref === 'function') timer.unref();

    try {
      worker = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { pattern, flags, subject },
        // The match needs no filesystem, network or env. Handing it none of the
        // parent's environment keeps an operator-supplied pattern from reading
        // secrets even if some future edit makes the worker body do more than test().
        env: {},
        resourceLimits: {
          // A backtracking match is CPU-bound, not memory-hungry, so this is not
          // the primary defence — it is a second ceiling in case a future pattern
          // class turns out to allocate instead of spin.
          maxOldGenerationSizeMb: 64,
        },
      });
      liveWorkers++;
    } catch (err: any) {
      finish({ status: 'error', message: `worker spawn failed: ${err?.message ?? 'unknown'}` });
      return;
    }

    // Decrement on exit rather than in `finish`: the thread outlives the promise
    // by however long termination takes, and counting it as gone before it is
    // gone would hide precisely the leak this counter exists to expose.
    worker.on('exit', () => { liveWorkers--; });
    worker.on('message', (msg: RegexBudgetResult) => finish(msg));
    worker.on('error', (err: Error) => finish({ status: 'error', message: err?.message ?? 'worker error' }));
    worker.on('exit', (code: number) => {
      // Reached only when the worker died without posting anything. If the timer
      // already fired this is a no-op, which is exactly right: termination by
      // budget must be reported as a timeout, not as a mysterious exit code.
      finish({ status: 'error', message: `worker exited without result (code ${code})` });
    });
  });
}
