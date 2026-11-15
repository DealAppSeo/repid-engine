-- OWNER SPEND BUDGET: every agent bound to one owner spends against ONE budget.
--
-- Invariant, per owner (builder):  reserved + settled + unknown  <=  funded stake.
-- Before this, each agent's cap was its own USDC approval, so N agents of one owner could each
-- spend up to the whole stake (src/services/agent-spend.ts). Nothing summed across agents.
--
-- Concurrency: reserve_owner_spend takes a per-owner transaction-scoped advisory lock before it
-- reads either sum, so two reservations for one owner are serialized; under READ COMMITTED each
-- statement after the lock sees every reservation committed before it. Different owners do not
-- wait on each other.
--
-- Funded stake counts a POSITIVE stake_deposits row only when it carries a real 0x transaction
-- hash. The one is_simulated=false row in production today is a `simulated:deposit:` row written
-- by the flag-off path while X402_REAL_RPC was set, and a budget that trusted the label would have
-- spent against it. Withdrawals (negative rows) always count, whatever their hash.
--
-- States: reserved (before signing) -> settled (receipt status 1) | released (receipt status 0:
-- reverted, no USDC moved) | unknown (the send threw: it may or may not have landed, so it keeps
-- counting until an operator reconciles it against the chain).
--
-- Service role only: RLS on with no policies, and no grants to anon/authenticated.

create table if not exists public.owner_spend_ledger (
  id          uuid primary key default gen_random_uuid(),
  builder_id  uuid not null,
  agent_id    uuid not null,
  amount      bigint not null check (amount > 0),          -- micro-USDC (6 decimals)
  state       text not null default 'reserved'
              check (state in ('reserved', 'settled', 'released', 'unknown')),
  tx_hash     text,
  reason      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists owner_spend_ledger_open_idx
  on public.owner_spend_ledger (builder_id) where state <> 'released';

alter table public.owner_spend_ledger enable row level security;
revoke all on public.owner_spend_ledger from anon, authenticated;

-- One on-chain transfer is credited at most once. The replay guard in depositStake is a SELECT taken
-- before several RPC round trips, so two concurrent claims of one hash could both pass it and fund
-- the budget twice for one transfer (Strix on #1550). Real 0x hashes only: simulated rows carry
-- `simulated:deposit:<ms>` and never fund anything. Production held 0 real-hash rows and 0
-- duplicates when this was written [MEASURED 2026-11-14], so it applies without a dedupe.
create unique index if not exists stake_deposits_real_tx_hash_uniq
  on public.stake_deposits (lower(deposit_tx_hash))
  where deposit_tx_hash ~ '^0x[0-9a-fA-F]{64}$';

create or replace function public.owner_funded_stake(p_builder uuid)
returns bigint
language sql
stable
as $$
  select coalesce(sum(
           case
             when amount < 0 then amount
             when deposit_tx_hash ~ '^0x[0-9a-fA-F]{64}$' then amount
             else 0
           end), 0)::bigint
    from public.stake_deposits
   where builder_id = p_builder
     and is_simulated = false
$$;

create or replace function public.reserve_owner_spend(p_builder uuid, p_agent uuid, p_amount bigint)
returns table (ok boolean, reservation_id uuid, budget bigint, committed bigint)
language plpgsql
as $$
declare
  v_budget    bigint;
  v_committed bigint;
  v_id        uuid;
begin
  if p_builder is null or p_agent is null or p_amount is null or p_amount <= 0 then
    raise exception 'reserve_owner_spend: builder, agent and a positive amount are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('owner_spend:' || p_builder::text, 0));

  v_budget := public.owner_funded_stake(p_builder);

  select coalesce(sum(amount), 0)::bigint
    into v_committed
    from public.owner_spend_ledger
   where builder_id = p_builder
     and state <> 'released';

  if v_committed + p_amount > v_budget then
    return query select false, null::uuid, v_budget, v_committed;
    return;
  end if;

  insert into public.owner_spend_ledger (builder_id, agent_id, amount)
  values (p_builder, p_agent, p_amount)
  returning id into v_id;

  return query select true, v_id, v_budget, v_committed + p_amount;
end
$$;

revoke all on function public.owner_funded_stake(uuid) from public, anon, authenticated;
revoke all on function public.reserve_owner_spend(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.owner_funded_stake(uuid) to service_role;
grant execute on function public.reserve_owner_spend(uuid, uuid, bigint) to service_role;
