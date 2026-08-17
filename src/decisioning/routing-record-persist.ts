/**
 * routing-record-persist.ts — closes the loop from decision features to outcome label.
 *
 * WHAT WAS BROKEN
 * ---------------
 * `buildRoutingRecord` (./routing-record.ts) computes the rich per-decision feature set
 * on every route: the ordered candidate chain, each candidate's cost class, why each one
 * lost, and whether free-first held. Its own header says persisting it was skipped
 * because "`anfis_routing_logs` has no column to hold them".
 *
 * The outcome side is durable and large: `llm_call_log` carries status / latency_ms /
 * cost_usd on every call. Nothing joins the two, so no (features -> outcome) corpus
 * exists, so the LASSO in scripts/eval/anfis-lasso.ts has nothing to fit. That is a
 * capability gap, not a tuning problem.
 *
 * MEASURED 2026-08-17, and it is worse than "no join":
 *   - `notes` and `n_providers` are NULL on EVERY row of `anfis_routing_logs`. Every row
 *     `persistShadowDecision` writes sets both. That writer has therefore produced zero
 *     rows since it shipped, despite defaulting ON -- an unwired mechanism reading as
 *     coverage (LESSONS 3), which is why the default here is the opposite way round and
 *     stated rather than assumed.
 *   - `llm_call_log` holds exactly one row per `call_id` for every distinct call_id in
 *     the table. The retry loop that would produce two has never been observed in
 *     production data -- so `call_id` alone happens to be unique today, and the code that
 *     can break that is still there. Hence the (call_id, provider) key below.
 *
 * THE JOIN KEY: (call_id, provider)
 * ---------------------------------
 * `call_id` is minted once per POST /v1/llm/complete and is in scope both at the
 * `routeRequest` call and at every `logLlmCall` write in that handler. It is NOT unique
 * per DECISION -- the handler retries up to three times on one `call_id`. `provider`
 * disambiguates: a failed or keyless provider is pushed onto `excludeProviders` before
 * the next attempt and selection skips that list, so a provider cannot repeat within one
 * call. `attempt` is recorded for ordering, not as part of the key.
 *
 * Keying this way is what makes the schema change additive-only: `llm_call_log` already
 * has `call_id` and `provider`, so it needs no DDL, no backfill and no writer change.
 *
 * INERT WITH RESPECT TO ROUTING
 * -----------------------------
 * This module runs AFTER the adapter has been selected and cannot influence it. It reads
 * one env var, performs one insert, and swallows every error. No routing decision moves.
 *
 * DEFAULT OFF -- and why
 * ----------------------
 * `ROUTING_RECORD_PERSIST` must be exactly 'true' to write. Reasons, in order:
 *   1. This system already shed ~8.6M writes/day by turning a default-on telemetry
 *      writer off. Adding a third per-attempt insert (alongside `llm_call_log` and
 *      `anfis_routing_logs`) on by default repeats that.
 *   2. The corpus needed to fit is a few thousand rows -- a bounded collection window
 *      somebody opens on purpose and closes again, not a permanent tap.
 *   3. An instrument that arrives already on is indistinguishable, to whoever is paged
 *      on write volume, from a change to the routing path itself.
 * The cost of the default is honest and stated: with the flag off the corpus stays at
 * zero rows and no fit is possible. That is the current state either way.
 */

import { db } from '../db';
import type { RoutingRecord } from './routing-record';

/** Env gate. Exactly 'true' enables the write; anything else (including unset) is off. */
export function routingRecordPersistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROUTING_RECORD_PERSIST === 'true';
}

export interface RoutingRecordPersistInput {
  /** Request-scoped id, shared with every `llm_call_log` row of the same request. */
  callId: string;
  /** 1-based attempt number within the request. Ordering only -- not part of the key. */
  attempt: number;
  record: RoutingRecord;
  taskHint?: string;
}

/** One row of `routing_decision_records`. Every field is decision-time; none is an outcome. */
export interface RoutingRecordRow {
  call_id: string;
  provider: string;
  attempt: number;
  chosen_tier: string;
  chosen_cost_class: string;
  reason: string;
  chosen_position: number | null;
  chain_len: number;
  free_first_violated: boolean;
  n_free_usable: number;
  n_paid_usable: number;
  n_unhealthy: number;
  n_keyless: number;
  n_cap_hit: number;
  n_disabled: number;
  n_excluded: number;
  task_hint: string | null;
  record: RoutingRecord;
}

/**
 * A candidate is "usable" iff nothing structural stopped it -- it won, or the walk simply
 * never reached it. Same definition `buildRoutingRecord` uses for the free-first check, and
 * it must stay the same one: a count of "free providers" that includes dead ones would make
 * `n_free_usable` disagree with `free_first_violated` on the same row.
 */
function usable(outcome: string): boolean {
  return outcome === 'chosen' || outcome === 'not_reached';
}

/**
 * Build the insert row. Pure and total -- a partially observed record still yields a row.
 *
 * `chosen_position` is null when the winner is not in the chain at all (chain exhausted,
 * `chosen === 'none'`). Null means "not in the walk", never 0: position 0 is the FIRST
 * candidate, which is the opposite fact.
 */
export function buildRoutingRecordRow(input: RoutingRecordPersistInput): RoutingRecordRow {
  const r = input.record;
  const chosen = r.candidates.find((c) => c.outcome === 'chosen');

  let nFreeUsable = 0;
  let nPaidUsable = 0;
  let nUnhealthy = 0;
  let nKeyless = 0;
  let nCapHit = 0;
  let nDisabled = 0;
  let nExcluded = 0;

  for (const c of r.candidates) {
    if (usable(c.outcome)) {
      if (c.costClass === 'free') nFreeUsable++;
      else if (c.costClass === 'paid') nPaidUsable++;
    }
    if (c.outcome === 'unhealthy') nUnhealthy++;
    else if (c.outcome === 'no_key') nKeyless++;
    else if (c.outcome === 'cap_hit') nCapHit++;
    else if (c.outcome === 'disabled_by_config') nDisabled++;
    else if (c.outcome === 'excluded_by_caller') nExcluded++;
  }

  return {
    call_id: input.callId,
    provider: r.chosen,
    attempt: input.attempt,
    chosen_tier: r.chosenTier,
    chosen_cost_class: r.chosenCostClass,
    reason: r.reason,
    chosen_position: chosen ? chosen.position : null,
    chain_len: r.candidates.length,
    free_first_violated: r.freeFirstViolated,
    n_free_usable: nFreeUsable,
    n_paid_usable: nPaidUsable,
    n_unhealthy: nUnhealthy,
    n_keyless: nKeyless,
    n_cap_hit: nCapHit,
    n_disabled: nDisabled,
    n_excluded: nExcluded,
    task_hint: input.taskHint ?? null,
    record: r,
  };
}

/**
 * Persist one decision record. Returns true only on a confirmed insert; false on skip,
 * error or throw. Advisory to the caller -- routing has already returned.
 *
 * Fire-and-forget at the call site (`void persistRoutingRecord(...)`), so a slow or dead
 * table costs the request nothing.
 */
export async function persistRoutingRecord(input: RoutingRecordPersistInput): Promise<boolean> {
  if (!routingRecordPersistEnabled()) return false;
  try {
    const { error } = await db
      .from('routing_decision_records')
      .insert(buildRoutingRecordRow(input) as any);
    if (error) {
      console.error('[routing-record-persist] insert error:', error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[routing-record-persist] insert threw:', e?.message ?? e);
    return false;
  }
}
