/**
 * L4 breaker — CONSUMER-side proof-churn guard for the proof-drain worker.
 *
 * WHY THIS EXISTS (and why the producer-side filter is not enough)
 * ---------------------------------------------------------------
 * `proof-enqueue-filter.ts` (PR #192, merged 2026-07-27) stops NEW internal-scoring
 * churn from entering `repid_proof_queue`. It does nothing about the rows that are
 * ALREADY queued — and the proof-GENERATION consumer has been down since
 * 2026-06-16 18:13Z, so the backlog is large and overwhelmingly churn.
 *
 * Live composition of the pending queue, verified by SQL against
 * qnnpjhlxljtqyigedwkb on 2026-07-27 (join `repid_proof_queue.event_id` →
 * `repid_score_events.event_type`; the queue table itself has no event_type column) [V]:
 *
 *   status=pending, zkp_service_url = <the deployed prover>   40,519 rows
 *     HAL_SCORE_EVENT      40,258   (99.36%)  internal scoring — non-economic churn
 *     SERVICE_FULFILLED       252   }
 *     VALIDATOR_REWARD          3   }
 *     VALIDATION_FAILED         3   }  261 genuinely economic jobs
 *     SERVICE_SATISFIED         2   }
 *     PREDICTION_RESOLVE        1   }
 *   status=pending, zkp_service_url IS NULL (event_id also NULL)     22 rows
 *     — unreachable by the drain either way: `fetchPendingBatch` filters on
 *       `zkp_service_url = $2`, and NULL never equals anything. Dead-letter class,
 *       inert, listed here so a future reader does not "discover" them as a bug.
 *
 * `fetchPendingBatch` has no ORDER BY, so a blind restart drains in physical order:
 * ~40k churn proofs would be generated (and, wherever the prover returns a
 * merkle_root, EAS-attested on Base Sepolia at real gas cost — see the two
 * attest paths in `insertCanonicalProof`) before the 261 economic jobs are reached.
 * That is the precise failure this guard prevents.
 *
 * WHAT THIS DOES
 * --------------
 * Chooses the SQL the drain's hot poll runs, by mode:
 *   - 'off'     (DEFAULT) → the legacy statement, character-for-character. No join,
 *                           no extra planning cost, behaviour byte-identical to today.
 *   - 'shadow'  → same result set as legacy (nothing is excluded, nothing is skipped),
 *                 plus an `is_churn` column so the worker can LOG the composition of
 *                 each batch it is about to prove. Observe before gating.
 *   - 'enforce' → churn jobs are excluded from the fetch entirely. They are never
 *                 claimed, never proved, never written to — they simply stay `pending`,
 *                 exactly as they have been since 2026-06-16.
 *
 * SAFETY
 * ------
 *  - Pure: no I/O, no DB, no network. It returns strings and a boolean.
 *  - Fail-safe: 'enforce' only ever NARROWS the fetched set. No mode adds a row,
 *    mutates a row, or deletes a row. Nothing here writes to the database at all —
 *    excluded jobs are left untouched, so the decision is reversible by an env change
 *    with no data to undo.
 *  - Default-inert: unset / empty / a typo all resolve to 'off'. Deliberately UNLIKE
 *    `parseProofEnqueueMode`, whose safe default is 'shadow'. On the producer side the
 *    risk is dropping a proof that should exist; here the guard runs inside a service
 *    that is currently stopped, so the conservative default is "change nothing", and
 *    the operator must opt in explicitly (see the runbook in
 *    reports/2026-07-27/BEAT29_PROOF_GENERATION_RESTART_RUNBOOK.md).
 *  - Single source of truth for "what counts as churn": `CHURN_PROOF_EVENT_TYPES`
 *    is imported from the producer-side filter, so the two ends of the queue can
 *    never disagree about the classification.
 */

import { CHURN_PROOF_EVENT_TYPES } from './proof-enqueue-filter';

export type ProofDrainChurnMode = 'off' | 'shadow' | 'enforce';

/**
 * The exact statement the drain has run since the 2026-05-21 PostgREST bypass.
 * Kept as a literal so `mode='off'` is provably unchanged rather than
 * "re-derived and hopefully identical".
 *
 * 2026-08-01: `contract_id` added to the SELECT list in BOTH statements. It is a
 * projection change only — no predicate, no join, no ORDER BY — so the SET OF
 * ROWS returned is identical and `mode='off'` remains behaviourally unchanged.
 * The column is what lets a generated proof record which contract paid for it.
 */
export const LEGACY_PENDING_BATCH_SQL = `SELECT id, job_id, agent_id, event_id, contract_id, status
       FROM repid_proof_queue
       WHERE status = $1 AND zkp_service_url = $2
       LIMIT $3`;

/**
 * Churn-aware variant. `$4` is the churn event-type array; `$5` is the enforce
 * switch. With `$5 = false` the extra predicate is a no-op, so 'shadow' returns
 * the same rows as legacy and merely reports `is_churn` alongside them.
 *
 * The join keys on `repid_proof_queue.event_id` → `repid_score_events.id`, which
 * is a real FK (`repid_proof_queue_event_id_fkey`). It is a LEFT join and the
 * comparison is `coalesce(e.event_type,'')`, so a row with a NULL `event_id`
 * survives the filter and is reported `is_churn = false` — the guard never
 * silently swallows a job it cannot classify.
 *
 * SHAPE IS DELIBERATE — the obvious `NOT EXISTS (...)` formulation was written
 * first and measured against live prod (`EXPLAIN ANALYZE`, 2026-07-27): Postgres
 * turned both the projected `EXISTS` and the filtering `NOT EXISTS` into *hashed
 * subplans*, each a full seq scan of `repid_score_events` (147,637 rows), for
 * **394 ms and 58,916 buffer reads per poll** — on a loop that polls every 2 s.
 * The LEFT JOIN below plans as a nested loop over `repid_score_events_pkey`
 * instead: **82 ms**, same 261-row result. Measured, not assumed; if you rewrite
 * this statement, re-measure it.
 *
 * Residual cost, stated honestly: with the backlog 99.4% churn, `LIMIT 20` still
 * walks ~10.5k pending rows before it finds 20 economic ones (~82 ms), and once
 * the economic set is drained an idle poll walks all ~40.5k (~300 ms) every
 * `idleSleepMs`. That is the price of not minting 40k proofs, it applies only in
 * the non-default modes, and it disappears when the churn backlog is
 * dispositioned. A partial index would remove it — deliberately NOT added here,
 * since prod DDL goes through a single writer with a look first.
 */
export const CHURN_AWARE_PENDING_BATCH_SQL = `SELECT q.id, q.job_id, q.agent_id, q.event_id, q.contract_id, q.status,
              (coalesce(e.event_type, '') = ANY($4::text[])) AS is_churn
       FROM repid_proof_queue q
       LEFT JOIN repid_score_events e ON e.id = q.event_id
       WHERE q.status = $1 AND q.zkp_service_url = $2
         AND (
           $5::boolean = false
           OR coalesce(e.event_type, '') <> ALL($4::text[])
         )
       LIMIT $3`;

/**
 * Parse the `PROOF_DRAIN_CHURN_MODE` lever. Only the three canonical spellings
 * (case-insensitive, trimmed) select a mode; anything else — unset, empty,
 * whitespace, a typo — resolves to 'off', i.e. legacy behaviour.
 */
export function parseProofDrainChurnMode(raw?: string | null): ProofDrainChurnMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'shadow' || v === 'enforce') return v;
  return 'off';
}

/** The churn event-type list as a plain array, for use as a SQL array parameter. */
export function churnEventTypeList(): string[] {
  return [...CHURN_PROOF_EVENT_TYPES];
}

export interface PendingBatchQueryPlan {
  sql: string;
  params: unknown[];
  /** True only in 'enforce' — churn rows are absent from the result set. */
  excludesChurn: boolean;
  /** True in 'shadow' and 'enforce' — rows carry an `is_churn` column. */
  reportsChurn: boolean;
  mode: ProofDrainChurnMode;
}

/**
 * Build the pending-batch query for a mode.
 *
 * `mode='off'` returns the legacy SQL and the legacy 3 params, so the drain's hot
 * poll is untouched unless someone explicitly opts in.
 */
export function buildPendingBatchQuery(
  mode: ProofDrainChurnMode,
  args: { status: string; zkpServiceUrl: string; batchSize: number }
): PendingBatchQueryPlan {
  if (mode === 'off') {
    return {
      sql: LEGACY_PENDING_BATCH_SQL,
      params: [args.status, args.zkpServiceUrl, args.batchSize],
      excludesChurn: false,
      reportsChurn: false,
      mode,
    };
  }
  return {
    sql: CHURN_AWARE_PENDING_BATCH_SQL,
    params: [args.status, args.zkpServiceUrl, args.batchSize, churnEventTypeList(), mode === 'enforce'],
    excludesChurn: mode === 'enforce',
    reportsChurn: true,
    mode,
  };
}

/**
 * One-line startup banner. Printed unconditionally on service start so that a
 * restart which forgot the lever is loud in the logs rather than silent — the
 * failure mode this guard exists to catch is exactly "someone restarted the
 * worker without reading the runbook".
 */
export function describeChurnGuard(mode: ProofDrainChurnMode): string {
  const types = churnEventTypeList().join(',');
  if (mode === 'enforce') {
    return `[ProofDrain] churn-guard ENFORCE — jobs whose score event is one of {${types}} are excluded from the fetch and left pending (never claimed, never written)`;
  }
  if (mode === 'shadow') {
    return `[ProofDrain] churn-guard SHADOW — churn jobs {${types}} are still fetched AND PROVED; batch composition is logged only. Set PROOF_DRAIN_CHURN_MODE=enforce to actually exclude them`;
  }
  return `[ProofDrain] churn-guard OFF (legacy) — every pending job is proved, including internal-scoring churn {${types}}. Set PROOF_DRAIN_CHURN_MODE=enforce before draining a churn-heavy backlog`;
}
