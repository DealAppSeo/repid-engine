-- REPID EXPERIMENTAL EVENTS — a separate, labelled namespace for same-controller measured RepID (D-124 rev).
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated, HIGH). FILE ONLY.                                 ║
-- ║  Nothing writes this table until EXPERIMENTAL_REPID_MODE=shadow|active is set AND   ║
-- ║  `npm run exp-repid:settle` is run. With the mode set and this table ABSENT, every  ║
-- ║  settlement is refused as store_error (loud); nothing else is affected.             ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHY. The 12 T12 agents share one controller, funder, runtime and (mostly) one model. Their outcomes are
-- real, measurable evidence, but agreement between them is not independent reputation. So they earn and
-- lose RepID HERE, in a domain that says what it is, and never in canonical repid_agents.current_repid or
-- repid_score_events (this file does not touch either).
--
-- WHAT. One row per (evidence, dimension, mode) movement:
--   domain            't12-exp-v1'. The API refuses any other.
--   agent_id          the subject, repid_agents.id. The writer checks it is the evidence's own subject.
--   dimension         producer | validator | redteam | calibration | reliability | safety: never summed.
--   evidence_*        kind, id ('trinity_tasks:<id>'), ref (where to re-read it), hash (sha256 of exactly
--                     what was scored). One evidence is consumed once per (domain, dimension, mode).
--   oracle_id         who graded it ('answer_key:hal_test_cases.expected_decision' for known answers). Never the subject.
--   eligibility       same_controller_measured, or independent_counterparty only with a DIFFERENT
--                     counterparty agent (DB check below; the writer also needs a positive different-owner
--                     answer from partyIndependence). A known answer has no counterparty, so never.
--   scoring_version   the pure function that produced delta (src/services/experimental-repid.ts).
--   mode              shadow | active. Same evidence, same functions; only active may ever gate anything.
--   delta, score_after  score_after is computed HERE by trigger (previous score_after + delta, serialised
--                     per chain), so no writer can set a score, only submit evidence.
--
-- APPEND-ONLY + ACCESS. Mirrors 20261102130000_kernel_ledger.sql (#1490): UPDATE/DELETE/TRUNCATE refused by
-- trigger for every role, revoked from service_role; RLS on with no policies; anon and authenticated have
-- nothing. Only the engine's service_role reads and inserts. Rows hold agent ids, task ids and hashes;
-- no end-user personal data.

create table if not exists public.repid_experimental_events (
  id                    bigint generated always as identity primary key,
  domain                text        not null check (domain = 't12-exp-v1'),
  agent_id              uuid        not null references public.repid_agents(id),
  dimension             text        not null check (dimension in ('producer','validator','redteam','calibration','reliability','safety')),
  evidence_kind         text        not null,
  evidence_id           text        not null,
  evidence_ref          text        not null,
  evidence_hash         text        not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  oracle_id             text        not null,
  counterparty_agent_id uuid        references public.repid_agents(id),
  eligibility           text        not null check (eligibility in ('same_controller_measured','independent_counterparty')),
  scoring_version       text        not null,
  mode                  text        not null check (mode in ('shadow','active')),
  delta                 numeric     not null,
  score_after           numeric     not null,
  metadata              jsonb       not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  constraint repid_exp_independent_needs_counterparty check (
    eligibility = 'same_controller_measured'
    or (counterparty_agent_id is not null and counterparty_agent_id <> agent_id and evidence_kind <> 'known_answer')
  ),
  constraint repid_exp_oracle_not_subject check (oracle_id <> agent_id::text),
  constraint repid_exp_once_per_evidence unique (domain, dimension, evidence_id, mode),
  constraint repid_exp_once_per_hash unique (domain, dimension, evidence_hash, mode)
);

create index if not exists repid_experimental_events_chain_idx
  on public.repid_experimental_events (domain, agent_id, dimension, mode, id desc);

alter table public.repid_experimental_events enable row level security;

revoke all on public.repid_experimental_events from anon, authenticated;
revoke update, delete, truncate on public.repid_experimental_events from service_role;
grant select, insert on public.repid_experimental_events to service_role;

-- score_after and created_at are the database's, not the writer's.
create or replace function public.repid_experimental_events_chain()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  prev numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.domain || '|' || new.agent_id::text || '|' || new.dimension || '|' || new.mode, 0));
  select e.score_after into prev
    from public.repid_experimental_events e
   where e.domain = new.domain and e.agent_id = new.agent_id and e.dimension = new.dimension and e.mode = new.mode
   order by e.id desc
   limit 1;
  new.score_after := coalesce(prev, 0) + new.delta;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists repid_experimental_events_chain on public.repid_experimental_events;
create trigger repid_experimental_events_chain
  before insert on public.repid_experimental_events
  for each row execute function public.repid_experimental_events_chain();

create or replace function public.repid_experimental_events_refuse_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'public.repid_experimental_events is append-only: % is refused', tg_op;
end;
$$;

drop trigger if exists repid_experimental_events_no_update_delete on public.repid_experimental_events;
create trigger repid_experimental_events_no_update_delete
  before update or delete on public.repid_experimental_events
  for each row execute function public.repid_experimental_events_refuse_change();

drop trigger if exists repid_experimental_events_no_truncate on public.repid_experimental_events;
create trigger repid_experimental_events_no_truncate
  before truncate on public.repid_experimental_events
  for each statement execute function public.repid_experimental_events_refuse_change();

-- Current score per (domain, agent, dimension, mode). score = sum(delta) = the chain's last score_after.
create or replace view public.repid_experimental_scores
with (security_invoker = true) as
select e.domain, e.agent_id, e.dimension, e.mode,
       count(*)                                                              as n,
       sum(e.delta)                                                          as score,
       count(*) filter (where e.eligibility = 'same_controller_measured')    as n_same_controller_measured,
       count(*) filter (where e.eligibility = 'independent_counterparty')    as n_independent_counterparty,
       array_agg(distinct e.scoring_version)                                 as scoring_versions,
       max(e.created_at)                                                     as last_event_at
  from public.repid_experimental_events e
 group by e.domain, e.agent_id, e.dimension, e.mode;

revoke all on public.repid_experimental_scores from anon, authenticated;
grant select on public.repid_experimental_scores to service_role;

-- ── VERIFY (expect: rls true, 0 rows, the three triggers, the view) ──────────────────────
-- select relrowsecurity as rls, (select count(*) from public.repid_experimental_events) as rows
--   from pg_class where oid = 'public.repid_experimental_events'::regclass;
-- select tgname from pg_trigger where tgrelid = 'public.repid_experimental_events'::regclass and not tgisinternal;
-- select count(*) from public.repid_experimental_scores;
-- select has_table_privilege('anon', 'public.repid_experimental_events', 'select') as anon_can_read;  -- expect false
--
-- ── ROLLBACK (DOWN) ─────────────────────────────────────────────────────────────────────
-- First unset EXPERIMENTAL_REPID_MODE (or set it to "off") wherever the settle script runs. The table can
-- then stay; it is inert and touches nothing canonical. Dropping it DESTROYS the experimental history:
-- drop view if exists public.repid_experimental_scores;
-- drop table if exists public.repid_experimental_events;
-- drop function if exists public.repid_experimental_events_chain();
-- drop function if exists public.repid_experimental_events_refuse_change();
