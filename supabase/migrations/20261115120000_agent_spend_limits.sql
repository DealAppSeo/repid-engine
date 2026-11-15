-- AGENT SPEND LIMITS: under AGENT_SPEND_SOURCE=stake an agent spends from its owner's stake only
-- up to a limit the OWNER signed.
--
-- Why. With AGENT_SPEND_SOURCE=stake the escrow pays an agent's payee out of the owner's stake
-- (repid-engine #1551). The binding the owner signed says "It moves no funds and grants no
-- spending authority" (src/services/human-agent-binding.ts), and on the wallet path the owner's own
-- on-chain approval was the consent. Without this table the agent's API key alone could move the
-- whole stake (Strix on #1551). The owner now signs a limit per agent (owner-authorization action
-- `spend.limit`, EIP-712, single-use nonce, 10-minute expiry): no gas, no money moves.
--
-- Semantics, like a token approval: the latest row per (builder, agent) is the limit, and it covers
-- the agent's spends reserved since it was set. Signing a new limit replaces the old one. A limit of
-- 0 stops the agent (it needs no signature: making an agent harder to stop than to start would be
-- the wrong way round). No row means the agent may not spend from stake at all.
--
-- Both checks run in reserve_agent_stake_spend under the SAME per-owner advisory lock as
-- reserve_owner_spend: the agent's limit, then the owner's shared budget. Timestamps use
-- clock_timestamp() so a reservation made after a limit is visible is always inside its window.
--
-- Service role only: RLS on with no policies, and no grants to anon/authenticated.
-- Needs 20261114200000_owner_spend_ledger.sql (owner_spend_ledger, owner_funded_stake) first.

create table if not exists public.agent_spend_limits (
  id            uuid primary key default gen_random_uuid(),
  builder_id    uuid not null,
  agent_id      uuid not null,
  limit_amount  bigint not null check (limit_amount >= 0),   -- micro-USDC (6 decimals)
  set_by        text not null,                               -- the owner wallet that signed, or 'stop' for a 0
  set_at        timestamptz not null default clock_timestamp()
);

create index if not exists agent_spend_limits_latest_idx
  on public.agent_spend_limits (builder_id, agent_id, set_at desc);

alter table public.agent_spend_limits enable row level security;
revoke all on public.agent_spend_limits from anon, authenticated;

create or replace function public.reserve_agent_stake_spend(p_builder uuid, p_agent uuid, p_amount bigint)
returns table (ok boolean, reason text, reservation_id uuid, budget bigint, committed bigint, agent_limit bigint, agent_committed bigint)
language plpgsql
as $$
declare
  v_limit     bigint;
  v_since     timestamptz;
  v_agent     bigint := 0;
  v_budget    bigint;
  v_committed bigint;
  v_id        uuid;
begin
  if p_builder is null or p_agent is null or p_amount is null or p_amount <= 0 then
    raise exception 'reserve_agent_stake_spend: builder, agent and a positive amount are required';
  end if;

  -- The same lock key as reserve_owner_spend and begin_stake_withdrawal: one owner, one queue.
  perform pg_advisory_xact_lock(hashtextextended('owner_spend:' || p_builder::text, 0));

  v_budget := public.owner_funded_stake(p_builder);

  select coalesce(sum(amount), 0)::bigint
    into v_committed
    from public.owner_spend_ledger
   where builder_id = p_builder
     and state <> 'released';

  select l.limit_amount, l.set_at
    into v_limit, v_since
    from public.agent_spend_limits l
   where l.builder_id = p_builder
     and l.agent_id = p_agent
   order by l.set_at desc, l.id desc
   limit 1;

  if v_limit is null then
    return query select false, 'no_spend_limit'::text, null::uuid, v_budget, v_committed, null::bigint, 0::bigint;
    return;
  end if;

  select coalesce(sum(amount), 0)::bigint
    into v_agent
    from public.owner_spend_ledger
   where builder_id = p_builder
     and agent_id = p_agent
     and state <> 'released'
     and created_at >= v_since;

  if v_agent + p_amount > v_limit then
    return query select false, 'over_agent_limit'::text, null::uuid, v_budget, v_committed, v_limit, v_agent;
    return;
  end if;

  if v_committed + p_amount > v_budget then
    return query select false, 'over_owner_budget'::text, null::uuid, v_budget, v_committed, v_limit, v_agent;
    return;
  end if;

  insert into public.owner_spend_ledger (builder_id, agent_id, amount, created_at, updated_at)
  values (p_builder, p_agent, p_amount, clock_timestamp(), clock_timestamp())
  returning id into v_id;

  return query select true, null::text, v_id, v_budget, v_committed + p_amount, v_limit, v_agent + p_amount;
end
$$;

revoke all on function public.reserve_agent_stake_spend(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.reserve_agent_stake_spend(uuid, uuid, bigint) to service_role;
