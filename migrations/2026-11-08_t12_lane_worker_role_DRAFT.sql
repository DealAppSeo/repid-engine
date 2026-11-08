-- DRAFT. The owner applies this; nothing runs it automatically. Set the login password separately
-- with ALTER ROLE, never in this file.
--
-- A lane worker runs model-written code, so its database access is limited to the lane pool. Tested
-- by tests/t12-lane-profile.test.ts, which applies this file to a throwaway database and then tries
-- to go past it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_lane_worker') THEN
    CREATE ROLE t12_lane_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

-- A role of this name may already exist with more power; IF NOT EXISTS would keep it.
ALTER ROLE t12_lane_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT USAGE ON SCHEMA public TO t12_lane_worker;

GRANT SELECT, INSERT, UPDATE ON public.trinity_tasks TO t12_lane_worker;
GRANT SELECT, INSERT, UPDATE ON public.agent_resource_claims TO t12_lane_worker;
GRANT SELECT ON public.trinity_system_config TO t12_lane_worker;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO t12_lane_worker', pg_get_serial_sequence('public.trinity_tasks', 'id'));
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO t12_lane_worker', pg_get_serial_sequence('public.agent_resource_claims', 'id'));
END $$;

ALTER TABLE public.trinity_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_resource_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trinity_system_config ENABLE ROW LEVEL SECURITY;

-- Task-bound belts. A lane may submit work only under a live belt for that task and that claim.
-- The belt is a row in principal_grants. The worker holds no privilege on that table or on the
-- denial log, so it cannot mint, restore, or read back either one. A policy function, not the
-- worker's code, decides, which is what makes this enforcement instead of a check the code can skip.
CREATE OR REPLACE FUNCTION public.t12_belt_prefixes(p_belt text) RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_belt
    WHEN 'engineering' THEN ARRAY['src/', 'tests/', 'test/', 'lib/', 'docs/']
    WHEN 'research' THEN ARRAY['reports/', 'docs/']
  END
$$;

CREATE OR REPLACE FUNCTION public.t12_belt_paths_ok(p_belt text, p_paths jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  allowed text[] := public.t12_belt_prefixes(p_belt);
  f jsonb;
BEGIN
  IF allowed IS NULL OR p_paths IS NULL OR jsonb_typeof(p_paths) <> 'array' OR jsonb_array_length(p_paths) = 0 THEN
    RETURN false;
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(p_paths) LOOP
    IF jsonb_typeof(f) <> 'string'
       OR (f #>> '{}') ~ '(^|/)\.\.(/|$)|\\|(^|/)\.(env|npmrc)'
       OR NOT EXISTS (SELECT 1 FROM unnest(allowed) AS a(prefix) WHERE starts_with(f #>> '{}', a.prefix)) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

-- Returns the refusal instead of raising it, because a raised error would roll the denial record back.
CREATE OR REPLACE FUNCTION public.t12_belt_checkout(p_task bigint, p_lane text, p_epoch integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r record;
  belt text;
  reason text;
  g record;
  idem text := format('t12:%s:%s', p_task, p_epoch);
BEGIN
  SELECT id, assigned_to, status, claimed_by, expires_at, metadata -> 't12' AS t INTO r
    FROM public.trinity_tasks WHERE id = p_task FOR UPDATE;
  belt := COALESCE(r.t #>> '{spec,belt}', 'engineering');
  reason := CASE
    WHEN r.id IS NULL OR r.assigned_to IS DISTINCT FROM 'trinity-t12-lanes' THEN 'task is not in the lane pool'
    WHEN r.status IS DISTINCT FROM 'claimed' OR r.t ->> 'stage' IS DISTINCT FROM 'making' THEN 'task is not being made'
    WHEN r.claimed_by IS DISTINCT FROM p_lane THEN 'another lane holds this task'
    WHEN r.t ->> 'epoch' IS DISTINCT FROM p_epoch::text THEN 'stale claim'
    WHEN r.expires_at IS NULL OR r.expires_at <= now() THEN 'the lease has expired'
    WHEN public.t12_belt_prefixes(belt) IS NULL THEN format('no such belt: %s', left(belt, 40))
    WHEN NOT public.t12_belt_paths_ok(belt, r.t #> '{spec,paths}') THEN format('the %s belt does not cover the paths of this task', belt)
  END;

  IF reason IS NULL THEN
    INSERT INTO public.principal_grants (grantor_agent_id, grantee_agent_id, grant_class, capabilities, role, expires_at, mint_reason, idempotency_key, signature_status)
    VALUES ('t12-belt-issuer', p_lane, 'cold', '["lane:submit"]'::jsonb, belt, now() + interval '30 minutes', format('lane task %s claim %s', p_task, p_epoch), idem, 'NOT_CHECKED')
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id, expires_at, role INTO g;
    IF g.id IS NULL THEN
      SELECT id, expires_at, role, revoked_at, not_before INTO g FROM public.principal_grants WHERE idempotency_key = idem;
      reason := CASE
        WHEN g.revoked_at IS NOT NULL THEN 'the belt for this claim was revoked'
        WHEN g.expires_at <= now() THEN 'the belt for this claim has expired'
      END;
    END IF;
  END IF;

  IF reason IS NOT NULL THEN
    INSERT INTO public.trinity_agent_logs (agent, task_id, action, status, message, metadata)
    VALUES ('t12-belt-issuer', p_task, 'belt_denied', 'denied', reason, jsonb_build_object('lane', left(p_lane, 80), 'epoch', p_epoch, 'belt', left(belt, 40)));
    RETURN jsonb_build_object('ok', false, 'reason', reason);
  END IF;
  RETURN jsonb_build_object('ok', true, 'grant_id', g.id, 'belt', g.role, 'expires_at', g.expires_at);
END
$$;

-- The row check for every lane-worker write. Only a live belt can put a submission on a row.
CREATE OR REPLACE FUNCTION public.t12_belt_permits(p_id bigint, p_meta jsonb) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n jsonb := p_meta -> 't12';
  o jsonb;
  holder text;
  g record;
BEGIN
  SELECT metadata -> 't12', claimed_by INTO o, holder FROM public.trinity_tasks WHERE id = p_id;
  IF o IS NULL THEN
    RETURN n IS NULL OR (n ->> 'stage' = 'ready' AND n -> 'submission' IS NULL);
  END IF;
  IF n IS NULL OR n -> 'spec' IS DISTINCT FROM o -> 'spec' THEN
    RETURN false;
  END IF;
  IF n -> 'submission' IS NOT DISTINCT FROM o -> 'submission' THEN
    RETURN n ->> 'stage' IN ('ready', 'making', 'rejected', 'not_checked', 'waiting_for_capacity') OR n -> 'submission' IS NOT NULL;
  END IF;
  IF o ->> 'stage' IS DISTINCT FROM 'making' OR n ->> 'stage' IS DISTINCT FROM 'awaiting_check' OR n ->> 'epoch' IS DISTINCT FROM o ->> 'epoch' THEN
    RETURN false;
  END IF;
  SELECT role INTO g FROM public.principal_grants
   WHERE idempotency_key = format('t12:%s:%s', p_id, o ->> 'epoch')
     AND grantor_agent_id = 't12-belt-issuer' AND grantee_agent_id = holder
     AND revoked_at IS NULL AND now() >= not_before AND now() < expires_at;
  IF NOT FOUND OR NOT public.t12_belt_paths_ok(g.role, n #> '{submission,files}') THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(n #> '{submission,files}') AS f(file) WHERE NOT (o #> '{spec,paths}') @> jsonb_build_array(f.file)
  );
END
$$;

-- Supabase's default privileges make a new public function executable by anon and authenticated.
REVOKE ALL ON FUNCTION public.t12_belt_prefixes(text), public.t12_belt_paths_ok(text, jsonb), public.t12_belt_checkout(bigint, text, integer), public.t12_belt_permits(bigint, jsonb) FROM PUBLIC;
DO $$
DECLARE
  who text;
BEGIN
  FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = who) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.t12_belt_prefixes(text), public.t12_belt_paths_ok(text, jsonb), public.t12_belt_checkout(bigint, text, integer), public.t12_belt_permits(bigint, jsonb) FROM %I', who);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.t12_belt_checkout(bigint, text, integer), public.t12_belt_permits(bigint, jsonb) TO t12_lane_worker;

DROP POLICY IF EXISTS t12_lane_worker_pool ON public.trinity_tasks;
CREATE POLICY t12_lane_worker_pool ON public.trinity_tasks
  FOR ALL TO t12_lane_worker
  USING (assigned_to = 'trinity-t12-lanes')
  WITH CHECK (assigned_to = 'trinity-t12-lanes' AND public.t12_belt_permits(id, metadata));

DROP POLICY IF EXISTS t12_lane_worker_claims ON public.agent_resource_claims;
CREATE POLICY t12_lane_worker_claims ON public.agent_resource_claims
  FOR ALL TO t12_lane_worker
  USING (resource_kind = 'other' AND (resource_id LIKE 'llm_cooldown:%' OR resource_id LIKE 'lane_wake:%'))
  WITH CHECK (resource_kind = 'other' AND (resource_id LIKE 'llm_cooldown:%' OR resource_id LIKE 'lane_wake:%'));

DROP POLICY IF EXISTS t12_lane_worker_halt ON public.trinity_system_config;
CREATE POLICY t12_lane_worker_halt ON public.trinity_system_config
  FOR SELECT TO t12_lane_worker
  USING (true);
