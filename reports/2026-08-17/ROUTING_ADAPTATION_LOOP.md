# Closing the routing adaptation loop — capability built, fit NOT POSSIBLE today

**Date:** 2026-08-17 · **Scope:** instrumentation only. No routing behaviour changed, no
production DDL applied, no weight refitted, no flag flipped to enforcing.

---

## The question this lane did NOT ask

Top-1 routing quality is already at 98.16% of the omniscient bound over 24 paired seeds.
The entire remaining prize for any router / scheduler / capacity / timeout change is
1.84pp, and that number was measured before this lane started. **Nothing here tunes
routing.** The unclosed problem is a capability gap: the adaptation loop cannot learn
because no fittable corpus of (decision features → outcome label) rows exists.

## What was actually wrong

Three real components, none connected:

1. **The decision side is computed and thrown away.** `buildRoutingRecord`
   (`src/decisioning/routing-record.ts`) produces the ordered candidate chain, each
   candidate's cost class, each candidate's skip reason, and `freeFirstViolated` — on
   every route. It is `console.log`ged under `ROUTER_DECISION_RECORD` and otherwise
   discarded. Its own header says persisting was skipped because "`anfis_routing_logs`
   has no column to hold them".
2. **The outcome side is durable.** `logLlmCall` (`src/billing/log-call.ts`) writes
   `status` / `latency_ms` / `cost_usd` on every call, and that table is large.
3. **Nothing joins them.** `anfis_routing_logs` has no `call_id` column at all
   [VERIFIED against `information_schema`], so it could never have been the join site
   without DDL either.

### A finding that came out of checking, not from reading

`persistShadowDecision` (`src/services/anfis-shadow-persist.ts`) defaults **ON** and is
called on every route. Every row it writes sets `notes` and `n_providers`. Both columns
are **NULL on every row of `anfis_routing_logs`** [MEASURED 2026-08-17]. That writer has
produced **zero rows** since it shipped. The rows that do carry labels come from other
writers with different row shapes. This is LESSONS 3 exactly — an unwired mechanism
reading as coverage — and it is why the new writer here defaults off *and says so* rather
than defaulting on and being believed.

## The join key: `(call_id, provider)`

`call_id` is minted once per `POST /v1/llm/complete` (`src/routes/route.ts`), and it is
in scope at **both** sites: the `routeRequest` call and every `logLlmCall` write in that
handler. Verified by reading the enclosing function, not inferred from the name.

It is **not** unique per decision. The handler retries up to three times and every attempt
reuses one `call_id`, so `call_id` alone would silently collapse up to three different
decisions onto one outcome. `provider` disambiguates: a failed or keyless provider is
pushed onto `excludeProviders` before the next attempt and selection skips that list, so a
provider cannot repeat within one call.

Two consequences worth stating:

- **`llm_call_log` needs no DDL, no backfill and no writer change.** It already has both
  key columns. The migration is additive-only and touches one new table.
- **The multi-attempt case has never occurred in production data** [MEASURED]: every
  distinct `call_id` in `llm_call_log` has exactly one row. So `call_id` alone happens to
  work today — and the code that breaks it is still there, which is why the key is the
  pair.

## What was built

| | |
|---|---|
| `migrations/2026_08_17_routing_decision_records.sql` | **UNAPPLIED.** One new table, additive-only. RLS on with no policies (`service_role` bypasses RLS; a policy naming it would grant nothing, and the way to keep a table server-side is to have no rule reaching `anon`). Rollback beside it. |
| `src/decisioning/routing-record-persist.ts` | Pure row builder + tolerant writer. Gated by `ROUTING_RECORD_PERSIST`, **default OFF**. |
| `src/decisioning/routing-corpus.ts` | Pure featuriser: joined row → feature vector. 19 decision-time features. |
| `scripts/eval/fetch-routing-corpus.ts` | Read-only. LEFT joins the two tables and emits JSON. |
| `scripts/eval/anfis-lasso.ts` | Second input path `--joined <file>`. **Fitting maths untouched.** |
| `src/routes/route.ts` | One fire-and-forget call at the only site holding both halves. |

### Why the default is OFF

This project shed ~8.6M writes/day by turning a default-on telemetry writer off. This one
would add a third insert per routing attempt. The corpus needed is a few thousand rows — a
bounded window someone opens on purpose, not a permanent tap. And an instrument that
arrives already on is indistinguishable, to whoever is paged on write volume, from a
change to the routing path itself. The cost of that default is stated rather than hidden:
**with the flag off the corpus stays empty and no fit is possible.** That is also the
current state, so the default costs nothing that is not already lost.

### The leakage rule, enforced in a test

`latency_ms` and `cost_usd` are measured *after* the call and are deliberately absent from
the feature matrix. A fit that read them would report a near-perfect model of a decision
that could not have been made. `attempt` **is** a feature — at decision time the router
already holds the exclusion set it was handed.

An unmatched decision is emitted with `status: null`, then **dropped and counted**, never
scored as a failure. "We did not observe it" and "it failed" are different facts and the
corpus keeps them apart.

## Was a fit possible today? **NO.**

`routing_decision_records` does not exist (migration unapplied) and the writer defaults
off, so the joined corpus is **0 rows**. There is no retrospective path either: the
decision features were never persisted in any form, and `anfis_routing_logs` carries no
key that could reach `llm_call_log`.

**No coefficients are reported, because none were fitted.** Per LESSONS 1, "I could not
measure this" is the result. A fit on the stale shadow rows — which carry the winner only,
no chain, no cost class, no skip reasons — would answer a different question under a
report heading that implied this one.

What *was* proven, on data whose answer was chosen in advance rather than discovered:

- The `--joined` path **refuses** a thin corpus loudly (`CORPUS TOO THIN — N labelled
  rows`, exit 1) instead of fitting it.
- On a synthetic corpus with a planted signal it recovers the planted features and drives
  the noise columns to zero. The synthetic report was **deleted, not committed** — a
  synthetic result filed under a findings heading is the failure this lane exists to
  avoid.

### How many rows are needed

At 19 features and the conventional ~10 events per predictor, a fit needs roughly **190
minority-class events**. The observed failure rate on the routed path is about **1 in 7**,
which puts the target near **1,400 labelled decisions** — and that base rate is itself
measured on a few hundred calls on a path whose last traffic was 2026-08-11, so treat it
as a planning figure, not a constant.

## Verification

- **VERIFIED** — `npm test`: 5,607 passed. The one failing suite
  (`tests/trinity-swarm-health.test.ts`, 6 failures) fails **identically on a stashed
  base checkout** — it queries a live view with a dummy `SUPABASE_URL`. ENV/CONFIG, not
  REAL (LESSONS 7).
- **VERIFIED** — `tsc --noEmit -p tsconfig.json`: 0 errors.
- **VERIFIED** — 27 new assertions across two suites, **5/5 mutations caught**: missing
  position encoded as 0; `isLabelled` always true; `chosen_position` 0 instead of null;
  the flag defaulting on; `usable()` counting dead candidates.
- **VERIFIED** — routing-adjacent suites (route, routing-order, routing-cost-class,
  routing-refusals, anfis-enablement, providers/router): 70 passed, unchanged.

### NOT CHECKED

- The migration has **never been executed anywhere**. No syntax check against Postgres.
- The writer has **never inserted a row**. Its insert path is exercised by no test that
  reaches a database, and the column list is verified only against the migration it ships
  with.
- `scripts/eval/fetch-routing-corpus.ts` has **not been run** — the Supabase host is
  proxy-denied from an agent session and the target table does not exist.
- Whether `/v1/llm/complete` receives traffic at all now. Its last observed call was
  2026-08-11; with no traffic the flag can be on and the corpus still never fills.
- That the few hundred routed calls used for the base rate all originated from
  `/v1/llm/complete`. That is **INFERRED** from writer-specific `task_hint` values, not
  verified.

## Honest naming of what is and is not LASSO

State this plainly, because the codebase uses one word for two different things:

- `fitLassoLogistic` (`scripts/eval/anfis-lasso.ts`) **is** a LASSO — L1-penalised
  logistic regression by cyclic coordinate descent with soft-thresholding on standardised
  features. It is the only one here. Its maths was not touched by this lane.
- `lassoSelectFeatures` (`src/services/anfis-router.ts`) is **not**. It is a magnitude
  threshold against a hardcoded importance literal. Same for `lassoDrivers`
  (`src/services/proof-tier-policy.ts`).
- The ANFIS `ruleParams` literal in `anfis-router.ts` has **never been fitted**.

None of the three were renamed, moved or deleted here — that is a separate decision.
