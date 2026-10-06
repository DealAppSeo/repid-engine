-- ANSWER KEY, FIRST SLICE (S46, Sean's GO 2026-10-06).
--
-- WHAT. For a claim WE put in it, which re-checkable public record supports or contradicts it.
-- An index beside the checker ledger, OFF the stamp path: nothing in /api/v1/classify reads it.
--
--   ak_claims   our own claims (curated seeds, or rows of ledger_items), each with the structured
--               spec that is actually checked. Never a user's text.
--   ak_records  public records that can be fetched again: an npm or PyPI package document, a
--               Wikidata entity at a pinned revision, a published fact-check search. One row per
--               locator, with the sha256 of what was read and a small extract.
--   ak_checks   every check, as an edge from a claim to the record it read (or to nothing, when no
--               record could be read). Append-only. A later check REPLACES an earlier one by naming
--               it in `supersedes`; nothing is ever updated or deleted.
--   ak_claim_status  the current status of each claim, from its checks that nothing supersedes.
--
-- WHY IT IS A DAG. Claims and records are two kinds of node and a check always joins one of each,
-- so support cannot loop through them. The only other link, `supersedes`, must point at an earlier
-- check of the same claim, and a check can be superseded once: a trigger refuses anything else.
--
-- THREE OUTCOMES. A check is 'supports', 'contradicts' or 'unchecked'. An unchecked check is kept,
-- so an abstain is never stored as a lie or as a pass.
--
-- ACCESS. RLS on with no policies, every privilege revoked from anon and authenticated: only the
-- engine's secret key (service_role) reads or writes. Nothing here is public, and no row holds
-- anything about a user, so the privacy page needs no new line.

create table if not exists public.ak_claims (
  id             bigserial primary key,
  seed_id        text        not null unique,                 -- e.g. seed-2026-10-06:npm-express-4.18.2
  claim          text        not null,                        -- our own sentence, never user text
  spec           jsonb       not null,                        -- the structured claim that is checked
  source         text        not null check (source in ('curated', 'ledger')),
  ledger_item_id bigint      references public.ledger_items (id),
  added_at       timestamptz not null default now(),
  check (source <> 'ledger' or ledger_item_id is not null)
);

create table if not exists public.ak_records (
  id          bigserial primary key,
  kind        text        not null check (kind in ('npm', 'pypi', 'wikidata', 'claimreview')),
  locator     text        not null unique,                   -- npm:express, wikidata:Q937#P569@rev123
  url         text        not null,                          -- re-reads exactly this record
  sha256      text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  snapshot    jsonb       not null,                          -- a small fixed-shape extract
  fetched_at  timestamptz not null
);

create table if not exists public.ak_checks (
  id          bigserial primary key,
  claim_id    bigint      not null references public.ak_claims (id),
  record_id   bigint      references public.ak_records (id),  -- null: no record could be read
  checker     text        not null,                          -- e.g. npm-registry@1
  outcome     text        not null check (outcome in ('supports', 'contradicts', 'unchecked')),
  reason      text        not null,
  run_id      text        not null,                          -- the run that produced it
  checked_at  timestamptz not null,
  supersedes  bigint      unique references public.ak_checks (id),
  -- A verdict always names the record it rests on.
  check (outcome = 'unchecked' or record_id is not null)
);

create index if not exists ak_checks_claim_idx on public.ak_checks (claim_id);

create or replace function public.ak_checks_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  prior public.ak_checks%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'ak_checks is append-only: supersede a check with a new one instead of changing it';
  end if;
  if new.supersedes is not null then
    select * into prior from public.ak_checks where id = new.supersedes;
    if not found then
      raise exception 'ak_checks: supersedes % does not exist', new.supersedes;
    end if;
    if prior.claim_id <> new.claim_id then
      raise exception 'ak_checks: a check may only supersede a check of the same claim';
    end if;
    if not (prior.checked_at < new.checked_at) then
      raise exception 'ak_checks: a check may only supersede an earlier one (no cycles)';
    end if;
  end if;
  return new;
end;
$$;

create trigger ak_checks_guard
  before insert or update or delete on public.ak_checks
  for each row execute function public.ak_checks_guard();

-- The current status of each claim, from its checks that nothing supersedes. Mirrors
-- src/answer-key/graph.ts statusOf: both a support and a contradiction is 'conflicted', and neither
-- wins; no current verdict is 'unchecked'.
create or replace view public.ak_claim_status
with (security_invoker = true)
as
with current_checks as (
  select c.*
  from public.ak_checks c
  where not exists (select 1 from public.ak_checks s where s.supersedes = c.id)
)
select
  k.id      as claim_id,
  k.seed_id,
  case
    when bool_or(cc.outcome = 'supports') and bool_or(cc.outcome = 'contradicts') then 'conflicted'
    when bool_or(cc.outcome = 'supports') then 'supported'
    when bool_or(cc.outcome = 'contradicts') then 'contradicted'
    else 'unchecked'
  end       as status,
  count(cc.id)              as current_checks,
  max(cc.checked_at)        as last_checked_at
from public.ak_claims k
left join current_checks cc on cc.claim_id = k.id
group by k.id, k.seed_id;

alter table public.ak_claims  enable row level security;
alter table public.ak_records enable row level security;
alter table public.ak_checks  enable row level security;

revoke all on public.ak_claims, public.ak_records, public.ak_checks, public.ak_claim_status
  from anon, authenticated;
revoke all on sequence public.ak_claims_id_seq, public.ak_records_id_seq, public.ak_checks_id_seq
  from anon, authenticated;
revoke all on function public.ak_checks_guard() from public, anon, authenticated;
