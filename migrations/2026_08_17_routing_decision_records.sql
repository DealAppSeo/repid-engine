-- routing_decision_records — the decision half of a (features -> outcome) corpus.
--
-- STATUS: **UNAPPLIED.** Not run against any project. Applying it is a separate,
-- deliberate act; nothing in this repo applies migrations automatically.
--
-- WHY THIS TABLE EXISTS
-- --------------------
-- The adaptation loop cannot learn, and the reason is not the fitter. The fitter is
-- real: `fitLassoLogistic` in scripts/eval/anfis-lasso.ts is an L1-penalised logistic
-- regression by cyclic coordinate descent. What is missing is a corpus with both
-- halves in it.
--
--   - The DECISION half exists in memory and is thrown away. `buildRoutingRecord`
--     (src/decisioning/routing-record.ts) computes the ordered candidate chain, each
--     candidate's cost class and the specific reason each one lost, on every route.
--     It is console.logged under a flag and otherwise discarded.
--   - The OUTCOME half is durable: `llm_call_log` carries status / latency_ms /
--     cost_usd on every call.
--   - Nothing joins them. `anfis_routing_logs` has no `call_id` column at all, so it
--     cannot be the join site without DDL either -- and it is already written by
--     three writers with three incompatible row shapes.
--
-- THE JOIN KEY IS (call_id, provider)
-- ----------------------------------
-- `call_id` is minted once per POST /v1/llm/complete (src/routes/route.ts) and is in
-- scope both where `routeRequest` is called and at every `logLlmCall` write in that
-- handler. It is NOT unique per routing DECISION: the handler retries up to three
-- times and every attempt reuses the same `call_id`. A provider, however, cannot
-- repeat within one call -- each failed or keyless provider is pushed onto
-- `excludeProviders` before the next attempt, and selection skips that list. So
-- (call_id, provider) identifies one decision and its one outcome row.
--
-- That choice is what keeps this migration ADDITIVE-ONLY: `llm_call_log` already has
-- both columns, so it needs no DDL, no backfill and no writer change. `attempt` is
-- stored here as ordering information, not as part of the key.
--
-- WHAT IS DELIBERATELY NOT HERE
-- ----------------------------
-- No prompt text and no prompt preview. No ANFIS coefficients, rule parameters or
-- scoring-formula terms. Provider names, chain positions, cost classes, skip-reason
-- counts and the router's own reason code are the whole payload. `record` holds the
-- verbatim RoutingRecord so a later feature can be derived without a re-collection,
-- and RoutingRecord itself carries none of the above.
--
-- WRITE VOLUME
-- ------------
-- The writer (src/decisioning/routing-record-persist.ts) is gated by
-- ROUTING_RECORD_PERSIST and defaults to OFF. This project has already shed ~8.6M
-- writes/day once for exactly this reason. A corpus of a few thousand rows is a
-- bounded collection window that someone opens on purpose, not a permanent tap.

create table if not exists public.routing_decision_records (
  id                  bigserial primary key,

  -- ---- join key -----------------------------------------------------------
  call_id             uuid        not null,
  provider            text        not null,   -- == llm_call_log.provider for this attempt

  -- ---- ordering / provenance ---------------------------------------------
  attempt             smallint    not null,   -- 1-based attempt within the call
  created_at          timestamptz not null default now(),

  -- ---- decision-time features (no outcome information in any of these) ----
  chosen_tier         text        not null,   -- '0a' | '1' | 'slm' | 'none'
  chosen_cost_class   text        not null,   -- 'free' | 'paid' | 'unpriced'
  reason              text        not null,   -- router's own reason code
  chosen_position     smallint,               -- 0-based position in the walk; NULL if not in chain
  chain_len           smallint    not null,
  free_first_violated boolean     not null,
  n_free_usable       smallint    not null,
  n_paid_usable       smallint    not null,
  n_unhealthy         smallint    not null,
  n_keyless           smallint    not null,
  n_cap_hit           smallint    not null,
  n_disabled          smallint    not null,
  n_excluded          smallint    not null,
  task_hint           text,

  -- ---- full fidelity, so a new feature needs no re-collection -------------
  record              jsonb       not null,

  constraint routing_decision_records_call_provider_uniq unique (call_id, provider)
);

create index if not exists routing_decision_records_call_id_idx
  on public.routing_decision_records (call_id);

create index if not exists routing_decision_records_created_at_idx
  on public.routing_decision_records (created_at desc);

-- RLS on, and NO policies. `service_role` has rolbypassrls = true, so a policy
-- naming it would grant nothing it does not already have; the way to keep a table
-- server-side only is to have no rule that reaches `anon` or PUBLIC. An
-- `sb_publishable_...` key authenticates AS `anon` and ships in browser bundles.
alter table public.routing_decision_records enable row level security;

comment on table public.routing_decision_records is
  'Decision-time routing features, joined to llm_call_log on (call_id, provider). '
  'Write-gated by ROUTING_RECORD_PERSIST (default off). No prompt text, no model parameters.';
