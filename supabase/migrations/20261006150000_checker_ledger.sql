-- CHECKER LEDGER (Sean, 2026-10-06: GO; k = 3; live traffic as daily totals only).
--
-- WHY. The stamp is two model-family checkers agreeing. "A model-based grader should be treated as
-- another fallible component whose own reliability needs evaluation" (Understanding Harness
-- Engineering, s.27). These tables are that evaluation, kept so a score can never be re-derived
-- from memory or quietly rewritten:
--
--   ledger_items          our OWN labelled claims (public corpus rows, later a private holdout).
--                         Never a user's text.
--   ledger_eval_results   one row per item per checker per run. Append-only.
--   ledger_checker_daily  live traffic, as COUNTS per checker per UTC day. No text, no user, no IP.
--   ledger_pair_daily     live traffic, as COUNTS per deciding pair per UTC day: agreed, contradicted,
--                         unsure. No text, no user, no IP.
--   ledger_checker_slices a view of counts per checker x prompt x source x task class. Scores
--                         (k = 3, 95% range, hidden under 100) are computed from it in
--                         src/ledger/score.ts, never stored as a fact.
--
-- ACCESS. RLS on with no policies, and every privilege revoked from anon and authenticated, so only
-- the engine's secret key (service_role, which bypasses RLS) reads or writes. Nothing here is public.
--
-- ORDER. Apply AFTER the privacy page names the daily counts (trustshell), because the engine starts
-- writing ledger_checker_daily / ledger_pair_daily on its own once these functions exist.

create table if not exists public.ledger_items (
  id          bigserial primary key,
  source      text        not null,                       -- canary | fever | truthfulqa | halueval | holdout
  source_id   text        not null,                       -- the corpus row id
  claim       text        not null,                       -- our own labelled claim, never user text
  truth       text        not null check (truth in ('TRUE', 'FALSE')),
  task_class  text        not null default 'unclassified',
  holdout     boolean     not null default false,         -- true: never exported, never in git
  audited_at  timestamptz,
  audit_note  text,
  added_at    timestamptz not null default now(),
  retired_at  timestamptz,                                -- a retired item stops counting, its rows stay
  unique (source, source_id)
);

create table if not exists public.ledger_eval_results (
  id             bigserial primary key,
  run_id         text        not null,
  item_id        bigint      not null references public.ledger_items (id),
  checker        text        not null,                    -- provider:model, e.g. groq:openai/gpt-oss-120b
  model_snapshot text,                                    -- a vendor fingerprint, when the host returns one
  prompt_version text        not null,                    -- short hash of the vote prompt, or a dated label
  engine_commit  text,                                    -- the harness that asked: parser, budget, encoding
  answer         text        not null check (answer in ('TRUE', 'FALSE', 'UNSURE', 'NONE')),
  latency_ms     integer,
  created_at     timestamptz not null default now(),
  unique (run_id, item_id, checker)
);

create or replace function public.ledger_eval_results_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ledger_eval_results is append-only: write a new run instead of changing an old one';
end;
$$;

drop trigger if exists ledger_eval_results_append_only on public.ledger_eval_results;
create trigger ledger_eval_results_append_only
  before update or delete on public.ledger_eval_results
  for each row execute function public.ledger_eval_results_append_only();

create table if not exists public.ledger_checker_daily (
  day            date        not null,
  checker        text        not null,
  prompt_version text        not null,
  engine_commit  text        not null,
  true_n         integer     not null default 0,
  false_n        integer     not null default 0,
  unsure_n       integer     not null default 0,
  no_answer_n    integer     not null default 0,          -- sent, then timeout / error / unparseable
  not_sent_n     integer     not null default 0,          -- refused before any request (no key, budget, ...)
  updated_at     timestamptz not null default now(),
  primary key (day, checker, prompt_version, engine_commit)
);

create table if not exists public.ledger_pair_daily (
  day            date        not null,
  checker_a      text        not null,
  checker_b      text        not null,
  prompt_version text        not null,
  engine_commit  text        not null,
  agreed_true    integer     not null default 0,          -- Checks out
  agreed_false   integer     not null default 0,          -- Caught
  contradicted   integer     not null default 0,          -- one TRUE, one FALSE: Not checked
  one_unsure     integer     not null default 0,
  both_unsure    integer     not null default 0,
  incomplete     integer     not null default 0,          -- a slot gave no verdict at all
  updated_at     timestamptz not null default now(),
  primary key (day, checker_a, checker_b, prompt_version, engine_commit),
  check (checker_a <= checker_b)
);

create or replace function public.ledger_bump_checker_daily(
  p_day date, p_checker text, p_prompt_version text, p_engine_commit text,
  p_true integer, p_false integer, p_unsure integer, p_no_answer integer, p_not_sent integer
)
returns void
language sql
set search_path = ''
as $$
  insert into public.ledger_checker_daily as d
    (day, checker, prompt_version, engine_commit, true_n, false_n, unsure_n, no_answer_n, not_sent_n)
  values
    (p_day, p_checker, p_prompt_version, p_engine_commit, p_true, p_false, p_unsure, p_no_answer, p_not_sent)
  on conflict (day, checker, prompt_version, engine_commit) do update set
    true_n      = d.true_n      + excluded.true_n,
    false_n     = d.false_n     + excluded.false_n,
    unsure_n    = d.unsure_n    + excluded.unsure_n,
    no_answer_n = d.no_answer_n + excluded.no_answer_n,
    not_sent_n  = d.not_sent_n  + excluded.not_sent_n,
    updated_at  = now();
$$;

create or replace function public.ledger_bump_pair_daily(
  p_day date, p_checker_a text, p_checker_b text, p_prompt_version text, p_engine_commit text,
  p_agreed_true integer, p_agreed_false integer, p_contradicted integer,
  p_one_unsure integer, p_both_unsure integer, p_incomplete integer
)
returns void
language sql
set search_path = ''
as $$
  insert into public.ledger_pair_daily as d
    (day, checker_a, checker_b, prompt_version, engine_commit,
     agreed_true, agreed_false, contradicted, one_unsure, both_unsure, incomplete)
  values
    (p_day, least(p_checker_a, p_checker_b), greatest(p_checker_a, p_checker_b), p_prompt_version, p_engine_commit,
     p_agreed_true, p_agreed_false, p_contradicted, p_one_unsure, p_both_unsure, p_incomplete)
  on conflict (day, checker_a, checker_b, prompt_version, engine_commit) do update set
    agreed_true  = d.agreed_true  + excluded.agreed_true,
    agreed_false = d.agreed_false + excluded.agreed_false,
    contradicted = d.contradicted + excluded.contradicted,
    one_unsure   = d.one_unsure   + excluded.one_unsure,
    both_unsure  = d.both_unsure  + excluded.both_unsure,
    incomplete   = d.incomplete   + excluded.incomplete,
    updated_at   = now();
$$;

-- Counts per slice. security_invoker, so reading it needs the same rights as the tables under it.
create or replace view public.ledger_checker_slices
with (security_invoker = true)
as
select
  r.checker,
  r.prompt_version,
  i.source,
  i.task_class,
  i.holdout,
  count(*)                                                                   as n,
  count(*) filter (where r.answer in ('TRUE', 'FALSE') and r.answer = i.truth)  as right_n,
  count(*) filter (where r.answer in ('TRUE', 'FALSE') and r.answer <> i.truth) as wrong_n,
  count(*) filter (where r.answer = 'UNSURE')                                as unsure_n,
  count(*) filter (where r.answer = 'NONE')                                  as none_n,
  min(r.created_at)                                                          as first_at,
  max(r.created_at)                                                          as last_at
from public.ledger_eval_results r
join public.ledger_items i on i.id = r.item_id
where i.retired_at is null
group by r.checker, r.prompt_version, i.source, i.task_class, i.holdout;

alter table public.ledger_items          enable row level security;
alter table public.ledger_eval_results   enable row level security;
alter table public.ledger_checker_daily  enable row level security;
alter table public.ledger_pair_daily     enable row level security;

revoke all on public.ledger_items, public.ledger_eval_results, public.ledger_checker_daily,
              public.ledger_pair_daily, public.ledger_checker_slices
  from anon, authenticated;
revoke all on sequence public.ledger_items_id_seq, public.ledger_eval_results_id_seq from anon, authenticated;

revoke all on function public.ledger_bump_checker_daily(date, text, text, text, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.ledger_bump_pair_daily(date, text, text, text, text, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.ledger_eval_results_append_only() from public, anon, authenticated;
grant execute on function public.ledger_bump_checker_daily(date, text, text, text, integer, integer, integer, integer, integer)
  to service_role;
grant execute on function public.ledger_bump_pair_daily(date, text, text, text, text, integer, integer, integer, integer, integer, integer)
  to service_role;

comment on table public.ledger_checker_daily is
  'Live /classify traffic as counts per checker per UTC day (TRUE/FALSE/UNSURE/no answer/not sent). '
  'Never claim text, never a user, never an IP. Written by src/ledger/daily-totals.ts.';
comment on table public.ledger_pair_daily is
  'Live /classify traffic as counts per deciding pair per UTC day. contradicted = one TRUE, one FALSE. '
  'Never claim text, never a user, never an IP.';
comment on table public.ledger_eval_results is
  'Append-only. One row per labelled item per checker per run. Scores (k = 3) are computed in '
  'src/ledger/score.ts from ledger_checker_slices, never stored.';
