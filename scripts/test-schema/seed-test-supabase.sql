-- =============================================================================
-- seed-test-supabase.sql
-- =============================================================================
-- Purpose: seed the DISPOSABLE TEST Supabase project with the minimal schema the
-- write-path INTEGRATION suites need so they RUN instead of SKIP.
--
-- The schema-presence gate (tests/helpers/prod-guard.ts) checks for
-- REQUIRED_TABLES = ['repid_events', 'service_contracts']. Once those exist and
-- the target is non-prod, describeIfSchema flips every gated suite from
-- describe.skip -> describe. The remaining tables below are the ones those
-- suites (and the src/ code they exercise) actually .from() at runtime, so the
-- suites can execute against real relations rather than 42P01 "relation does
-- not exist".
--
-- SAFETY: apply ONLY to the TEST project (ref ebiftjvrbsotpdthsyav). NEVER apply
-- to prod (qnnpjhlxljtqyigedwkb). Idempotent — safe to re-run.
--
-- All tables are additive, permissive (nullable columns so inserts succeed), and
-- have RLS ENABLED. Integration tests connect with the service-role/secret key,
-- which bypasses RLS; the anon role is denied by default (no policies), which is
-- the safe posture for a disposable test DB.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tier derivation (mirrors prod: repid_agents.tier is trigger-derived).
-- Canonical 5-tier scheme per CLAUDE.md.
-- ---------------------------------------------------------------------------
create or replace function public.compute_tier(score integer)
returns text language sql immutable as $$
  select case
    when coalesce(score, 0) < 500  then 'PROBATIONARY'
    when score            < 1000 then 'EARNING'
    when score            < 5000 then 'ESTABLISHED'
    when score            < 8000 then 'AUTONOMOUS'
    else 'VETERAN'
  end;
$$;

create or replace function public.trg_sync_tier()
returns trigger language plpgsql as $$
begin
  new.tier := public.compute_tier(new.current_repid::int);
  return new;
end;
$$;

-- ===========================================================================
-- GATE TABLES (prod-guard REQUIRED_TABLES)
-- ===========================================================================

-- repid_events — a2a bridge / feedback-loop outbox (validation-repid-delta.ts,
-- feedback-loop-worker.ts, bridge-integration.test.ts).
create table if not exists public.repid_events (
  id               uuid primary key default gen_random_uuid(),
  subject_id       uuid,
  subject_type     text,
  event_type       text,
  reputation_delta numeric,
  event_data       jsonb default '{}'::jsonb,
  processed_at     timestamptz,
  created_at       timestamptz default now()
);
alter table public.repid_events enable row level security;

-- service_contracts — a2a service-contract lifecycle (bridge-integration.test.ts,
-- validation-repid-delta.ts applyServiceFulfilledDeltas).
create table if not exists public.service_contracts (
  id                    uuid primary key default gen_random_uuid(),
  service_id            uuid,
  buyer_agent_id        uuid,
  provider_agent_id     uuid,
  agreed_price_usdc_raw bigint,
  payload               jsonb default '{}'::jsonb,
  status                text default 'pending',
  x402_payment_id       uuid,
  metadata              jsonb default '{}'::jsonb,
  result                jsonb,
  escrowed_at           timestamptz,
  fulfilled_at          timestamptz,
  created_at            timestamptz default now()
);
alter table public.service_contracts enable row level security;

-- ===========================================================================
-- SUPPORTING TABLES exercised by the gated suites + the code they invoke
-- ===========================================================================

-- repid_config — circuit-breaker + runtime flags (circuit-breaker.ts,
-- x402-real-settler.ts, x402-recovery-worker.ts).
create table if not exists public.repid_config (
  key          text primary key,
  value        text,
  last_updated timestamptz default now(),
  updated_by   text
);
alter table public.repid_config enable row level security;

-- repid_agents — agent state. tier is trigger-derived (do NOT write it directly).
create table if not exists public.repid_agents (
  id                     uuid primary key default gen_random_uuid(),
  agent_name             text,
  agent_type             text,
  is_human               boolean default false,
  constitution           jsonb,
  current_repid          integer default 1000,
  peak_repid             integer,
  tier                   text,
  erc8004_address        text,
  erc8004_token_id       text,
  wallet_address         text,
  last_reputation_tx_hash text,
  vesting_cliff_ends_at  timestamptz,
  last_active_at         timestamptz,
  last_updated           timestamptz,
  created_at             timestamptz default now(),
  constraint repid_agents_tier_check check (
    tier is null or tier in ('PROBATIONARY','EARNING','ESTABLISHED','AUTONOMOUS','VETERAN')
  )
);
alter table public.repid_agents enable row level security;
drop trigger if exists trg_sync_tier on public.repid_agents;
create trigger trg_sync_tier before insert or update on public.repid_agents
  for each row execute function public.trg_sync_tier();

-- repid_score_events — canonical append-only score history (scoring/pipeline.ts
-- applyValidationEvent, mock-agent.ts recordEvent).
create table if not exists public.repid_score_events (
  id                     bigserial primary key,
  agent_id               uuid,
  event_type             text,
  delta                  integer,
  repid_before           integer,
  repid_after            integer,
  repid_delta_calculated integer,
  repid_delta_applied    integer,
  certainty_at_claim     numeric,
  contract_id            uuid,
  llm_provider           text,
  llm_model              text,
  llm_call_id            text,
  hal_score              numeric,
  hal_decision           text,
  hallucination_caught   boolean,
  tier_used              text,
  task_domain            text,
  decision_outcome       text,
  prompt_text            text,
  answer_text            text,
  zk_proof_triggered     boolean default false,
  zk_proof_id            uuid,
  idempotency_key        text,
  metadata               jsonb default '{}'::jsonb,
  created_at             timestamptz default now()
);
alter table public.repid_score_events enable row level security;

-- repid_proof_queue — ZKP proof job queue (mock-agent.ts requestZKPProof,
-- scoring/pipeline.ts).
create table if not exists public.repid_proof_queue (
  id             bigserial primary key,
  job_id         text not null,
  agent_id       uuid,
  event_id       bigint,
  status         text default 'pending',
  zkp_service_url text,
  created_at     timestamptz default now()
);
alter table public.repid_proof_queue enable row level security;

-- agent_memory_nodes / agent_memory_edges — graph-rag layer (mock-agent.ts).
create table if not exists public.agent_memory_nodes (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid,
  node_type  text,
  content    text,
  importance numeric,
  metadata   jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
alter table public.agent_memory_nodes enable row level security;

create table if not exists public.agent_memory_edges (
  id           uuid primary key default gen_random_uuid(),
  from_node_id uuid,
  to_node_id   uuid,
  edge_type    text,
  weight       numeric,
  metadata     jsonb default '{}'::jsonb,
  created_at   timestamptz default now()
);
alter table public.agent_memory_edges enable row level security;

-- hal_runner_results — HAL benchmark rows (full-substrate-loop.test.ts).
create table if not exists public.hal_runner_results (
  id               uuid primary key default gen_random_uuid(),
  run_id           text,
  prompt_id        text,
  benchmark_source text,
  gen_provider     text,
  gen_model        text,
  gen_latency_ms   integer,
  generated_answer text,
  hal_mode         integer,
  hal_threshold    numeric,
  hal_score        numeric,
  hal_vetoed       boolean,
  gen_failed       boolean,
  created_at       timestamptz default now()
);
alter table public.hal_runner_results enable row level security;

-- hal_anfis_snapshots — ANFIS weight snapshots (full-substrate-loop.test.ts).
create table if not exists public.hal_anfis_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  snapshot_id           text,
  snapshot_version      integer,
  snapshot_hash         text,
  anfis_weights         jsonb,
  milestone_description text,
  created_at            timestamptz default now()
);
alter table public.hal_anfis_snapshots enable row level security;

-- trade_execution_log — paper/live trade rows (mock-agent.ts attemptTrade + teardown).
create table if not exists public.trade_execution_log (
  id             bigserial primary key,
  agent_name     text,
  decision       text,
  asset          text,
  pair           text,
  action         text,
  amount_usd     numeric,
  pnl_realized   numeric,
  execution_mode text,
  reason         text,
  created_at     timestamptz default now()
);
alter table public.trade_execution_log enable row level security;

-- x402_settlements — settlement ledger (x402-real-settler.ts, recovery worker,
-- bridge-integration.test.ts). Unique idempotency_key -> auto-named
-- x402_settlements_idempotency_key_key.
create table if not exists public.x402_settlements (
  id                       uuid primary key default gen_random_uuid(),
  idempotency_key          text unique,
  tip_id                   text,
  prediction_topic         text,
  amount                   numeric,
  asset                    text,
  status                   text,
  is_simulated             boolean default false,
  tx_hash                  text,
  payer_address            text,
  provider_agent_id        uuid,
  requestor_agent_id       uuid,
  settlement_attempt_count integer default 0,
  created_at               timestamptz default now()
);
alter table public.x402_settlements enable row level security;

-- x402_settlement_failures — retry queue (x402-real-settler.ts, recovery worker).
create table if not exists public.x402_settlement_failures (
  id                   bigserial primary key,
  direction            text,
  agent_id             text,
  payment_payload_b64  text,
  payment_requirements jsonb,
  attempt_count        integer default 0,
  last_attempted_at    timestamptz,
  resolved_at          timestamptz,
  idempotency_key      text,
  facilitator_response jsonb,
  created_at           timestamptz default now()
);
alter table public.x402_settlement_failures enable row level security;

-- x402_recovery_worker_runs — recovery telemetry (x402-recovery-worker.ts).
create table if not exists public.x402_recovery_worker_runs (
  id                      bigserial primary key,
  rows_examined           integer,
  rows_eligible           integer,
  rows_recovered          integer,
  rows_still_failing      integer,
  rows_abandoned          integer,
  circuit_breaker_tripped boolean,
  dry_run                 boolean,
  created_at              timestamptz default now()
);
alter table public.x402_recovery_worker_runs enable row level security;

-- repid_bounties — bounty list surface (routes/bounties.ts; /bounties must 200
-- in auth-gating.test.ts).
create table if not exists public.repid_bounties (
  id           uuid primary key default gen_random_uuid(),
  status       text default 'OPEN',
  bounty_repid integer,
  bounty_usdc  numeric,
  title        text,
  description  text,
  created_at   timestamptz default now()
);
alter table public.repid_bounties enable row level security;

-- agent_services — referenced by the PostgREST embed
-- service_contracts.select('*, agent_services(service_type)'). Created so the
-- relation exists; NOT FK-linked (a FK would break bridge's synthetic inserts).
create table if not exists public.agent_services (
  id           uuid primary key default gen_random_uuid(),
  service_type text,
  created_at   timestamptz default now()
);
alter table public.agent_services enable row level security;

-- ===========================================================================
-- SEED DATA — the 6 circuit-breaker rows (circuit-breaker.ts / x402 tests read
-- these keys; default all OFF).
-- ===========================================================================
insert into public.repid_config (key, value, updated_by) values
  ('cb_disable_x402_settlements', 'false', 'seed-test-schema'),
  ('cb_disable_zkp_proofs',       'false', 'seed-test-schema'),
  ('cb_disable_onchain_writes',   'false', 'seed-test-schema'),
  ('cb_disable_trade_execution',  'false', 'seed-test-schema'),
  ('cb_disable_score_writes',     'false', 'seed-test-schema'),
  ('cb_freeze_swarm_responses',   'false', 'seed-test-schema')
on conflict (key) do nothing;

-- ===========================================================================
-- RLS POLICIES + GRANTS (disposable TEST project only)
-- ---------------------------------------------------------------------------
-- The only API key the test env exposes is the publishable/anon key
-- (SUPABASE_TEST_PUBLISHABLE_KEY); there is no service_role JWT in env. RLS
-- stays ENABLED (per the additive/RLS-on requirement), but the anon +
-- authenticated roles are granted full access so the write-path integration
-- tests can insert/update/delete. This is acceptable ONLY because the project
-- is a throwaway test DB with no real data. Do NOT replicate on prod.
-- ===========================================================================
do $$
declare t text;
  tbls text[] := array[
    'repid_events','service_contracts','repid_config','repid_agents',
    'repid_score_events','repid_proof_queue','agent_memory_nodes','agent_memory_edges',
    'hal_runner_results','hal_anfis_snapshots','trade_execution_log','x402_settlements',
    'x402_settlement_failures','x402_recovery_worker_runs','repid_bounties','agent_services'
  ];
begin
  foreach t in array tbls loop
    execute format('drop policy if exists test_all_access on public.%I', t);
    execute format('create policy test_all_access on public.%I for all to anon, authenticated using (true) with check (true)', t);
    execute format('grant all on public.%I to anon, authenticated', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
