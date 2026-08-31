-- canon bind-contract-v1 — the database half.
--
-- Three separate defects, found by running the path rather than reading it.
-- The first one alone made gate I1 unreachable.
--
-- ============================================================================
-- 1. EVERY BIND WAS IMPOSSIBLE. A TYPE ERROR, NOT A REFUSAL.
-- ============================================================================
-- validate_human_agent_binding() checked agent existence with:
--
--   WHERE r.id = NEW.agent_id OR r.agent_id = NEW.agent_id
--
-- repid_agents.agent_id is TEXT; human_agent_bindings.agent_id is UUID. Postgres
-- has no `text = uuid` operator, so the statement never plans and the trigger
-- raises `operator does not exist: text = uuid` on EVERY insert — including a
-- valid one naming a real agent with a real signature. OR does not rescue it:
-- both branches are type-checked before either is evaluated.
--
-- MEASURED 2026-08-31: a direct insert with an existing repid_agents row and a
-- well-formed 132-character EIP-191 signature failed with exactly that message.
-- v_bind_status has always read "NOT BOUND: no PAI exists" — not because nobody
-- tried, but because the table could not accept a row. Every layer built above
-- inherited a blocker none could see, because it surfaced as a type error rather
-- than a refusal.
--
-- The fix is the cast and nothing else. All five refusals are preserved verbatim;
-- this does not relax validation, it makes the check evaluable so it can refuse
-- what it was written to refuse.
--
-- ============================================================================
-- 2. CANON STEP (3) CANNOT RUN AS WRITTEN.
-- ============================================================================
-- Canon says `INSERT INTO repid_agents (agent_name, current_repid, lifecycle_status)
-- VALUES (<name>, 0, 'active')`. Two reasons that fails:
--   * erc8004_address is NOT NULL with no default.
--   * CHECK (current_repid >= 10 AND current_repid <= 10000) forbids 0.
-- bind_human_to_agent() therefore seeds at 10 — the same floor
-- apply_repid_score_event() clamps to, and deliberately NOT the column default of
-- 1000, which would hand a new agent reputation nobody measured. And it REFUSES
-- rather than inventing an erc8004_address: canon decisions
-- erc8004-address-column-is-wrong-shape and identity-mint-gap-is-2-of-12 already
-- record that column as unreliable, and a bind that fabricates an on-chain
-- identity to succeed is worse than one that stops.
--
-- ============================================================================
-- 3. THE NONCE WAS DECORATION.
-- ============================================================================
-- Canon puts nonce:<uuid> in the signed message, but nothing recorded or enforced
-- it, so a captured signature could be replayed against a revoked binding to make
-- a new live one. The unique index makes reuse fail. A nonce nobody enforces is
-- decoration, and this codebase has paid for that pattern already.
--
-- ============================================================================
-- WHAT THIS IS NOT: THE CRYPTOGRAPHIC GATE.
-- ============================================================================
-- canon bind-contract-v1 (2): the server MUST ecrecover and assert the recovered
-- address equals human_wallet. THE DATABASE CANNOT DO THIS. The trigger checks
-- that binding_sig matches ^0x[0-9a-fA-F]{130}$ — a SHAPE check that stops sloppy
-- fakes and not one deliberate well-formed hex string.
--
-- bind_human_to_agent() therefore carries EXECUTE for service_role ONLY. Granting
-- it to anon or authenticated would hand every holder of the publishable key —
-- which ships in the browser bundle — a route straight around the signature
-- check. That is the entire point of I1. Do not widen this grant.

create or replace function public.validate_human_agent_binding()
returns trigger
language plpgsql
as $function$
BEGIN
  IF NEW.human_wallet IS NULL OR NEW.human_wallet !~ '^0x[0-9a-fA-F]{40}$' THEN
    RAISE EXCEPTION 'BIND REFUSED: human_wallet must be a 42-character EVM address, got %',
      coalesce(NEW.human_wallet, 'NULL');
  END IF;

  IF NEW.binding_sig IS NULL OR NEW.binding_sig !~ '^0x[0-9a-fA-F]{130}$' THEN
    RAISE EXCEPTION 'BIND REFUSED: binding_sig must be a 132-character EIP-191 signature. A passphrase, a UUID or a placeholder is not a binding. Got % characters.',
      coalesce(length(NEW.binding_sig), 0);
  END IF;

  IF NEW.agent_id IS NULL THEN
    RAISE EXCEPTION 'BIND REFUSED: agent_id is required - a binding names a specific agent.';
  END IF;

  -- ::text is load-bearing. Without it this statement fails to plan and the
  -- trigger raises a type error on every insert, valid ones included.
  IF NOT EXISTS (
    SELECT 1 FROM public.repid_agents r
     WHERE r.id = NEW.agent_id
        OR r.agent_id = NEW.agent_id::text
  ) THEN
    RAISE EXCEPTION 'BIND REFUSED: agent_id % does not exist in repid_agents. Bind to a real agent.', NEW.agent_id;
  END IF;

  IF NEW.scope IS NULL OR btrim(NEW.scope) = '' THEN
    RAISE EXCEPTION 'BIND REFUSED: scope is required - an unscoped binding grants everything, which is not a grant.';
  END IF;

  NEW.bound_at := coalesce(NEW.bound_at, now());
  RETURN NEW;
END;
$function$;

create or replace function public.bind_human_to_agent(
  p_agent_name       text,
  p_human_wallet     text,
  p_binding_sig      text,
  p_nullifier        text,
  p_scope            text default 'ownership',
  p_owner_kind       text default 'human_sbt',
  p_human_token_id   text default null,
  p_builder_id       uuid default null,
  p_erc8004_address  text default null
)
returns table (agent_id uuid, agent_created boolean, binding_id uuid, active_bindings int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_id uuid;
  v_created  boolean := false;
  v_binding  uuid;
begin
  if p_agent_name is null or btrim(p_agent_name) = '' then
    raise exception 'BIND REFUSED: agent_name is required.';
  end if;

  -- Named refusal instead of the raw CHECK. canon (4) wants the raised message
  -- returned verbatim so the UI can render UNBOUND with a reason; that only pays
  -- if the message IS a reason rather than an internal column pair.
  if num_nonnulls(p_human_token_id, p_builder_id) <> 1 then
    raise exception
      'BIND REFUSED: a binding must name exactly one owner - either a verified human '
      '(human_token_id) or a builder account (builder_id), not both and not neither. '
      'Got human_token_id=% builder_id=%',
      coalesce(p_human_token_id, 'NULL'), coalesce(p_builder_id::text, 'NULL');
  end if;

  select r.id into v_agent_id
    from public.repid_agents r
   where r.agent_name = p_agent_name
   limit 1;

  if v_agent_id is null then
    if p_erc8004_address is null or btrim(p_erc8004_address) = '' then
      raise exception
        'BIND REFUSED: agent % does not exist and no erc8004_address was supplied. '
        'repid_agents.erc8004_address is NOT NULL with no default, so canon step (3) '
        'cannot run as written. Supply the real on-chain address, or create the agent '
        'first. This will not invent one.', p_agent_name;
    end if;

    insert into public.repid_agents (agent_name, erc8004_address, current_repid, lifecycle_status)
    values (p_agent_name, p_erc8004_address, 10, 'active')
    returning id into v_agent_id;
    v_created := true;
  end if;

  insert into public.human_agent_bindings
    (human_wallet, agent_id, scope, binding_sig, nullifier, owner_kind, human_token_id, builder_id)
  values
    (p_human_wallet, v_agent_id, p_scope, p_binding_sig, p_nullifier, p_owner_kind,
     p_human_token_id, p_builder_id)
  returning id into v_binding;

  return query
    select v_agent_id, v_created, v_binding,
           (select count(*)::int from public.human_agent_bindings b where b.revoked_at is null);
end;
$$;

comment on function public.bind_human_to_agent is
  'canon bind-contract-v1 step (3): atomically create the agent row (if absent) and the binding, or neither. Seeds current_repid at 10 - canon''s 0 violates CHECK >= 10, and the column default of 1000 would be unearned. NOT the cryptographic gate: the API must ecrecover first; the DB can only check signature SHAPE. service_role EXECUTE only, deliberately - granting anon would route around the signature check.';

revoke all on function public.bind_human_to_agent(text,text,text,text,text,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.bind_human_to_agent(text,text,text,text,text,text,text,uuid,text) to service_role;

create unique index if not exists human_agent_bindings_nullifier_once
  on public.human_agent_bindings (nullifier)
  where nullifier is not null;
