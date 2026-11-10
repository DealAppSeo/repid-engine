-- DRAFT. The owner applies this; nothing runs it automatically. Set each login password separately
-- with ALTER ROLE, never in this file. Rollback: migrations/rollback/DOWN_2026-11-08_t12_lane_worker_role_DRAFT.sql.
--
-- A lane runs model-written code, so its database access is limited to the lane pool, and each stage
-- has its own role: t12_lane_maker, t12_lane_checker and t12_lane_integrator.
--
-- WHY THREE ROLES. The first version of this file had one shared role, t12_lane_worker, for every
-- stage. With it a maker set its own submitted row to `approved` with no check, and the integrator
-- then took it for publishing (gate-0 probe P1, 2026-11-09). Now Postgres decides which stage moves
-- each role may make (t12_belt_stage_permits below), so:
--   - the maker cannot record a verdict or move a row to checking, approved, integrating or integrated;
--   - the checker cannot enqueue, make or submit, and cannot take or approve work its own lane produced;
--   - the integrator cannot approve: it can only hand a row it took from `approved` back to `approved`.
-- The shared role is retired: if an earlier draft created it, this file strips it and makes it NOLOGIN.
--
-- WHAT THIS IS NOT. One owner holds all three credentials. This is role separation under the same
-- controller, not independent authority.
--
-- Tested by tests/t12-lane-profile.test.ts, which applies this file to a throwaway database and then
-- tries to go past it.

-- One transaction: run with psql -f, a refusal below would otherwise stop only its own block.
BEGIN;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['t12_lane_maker', 't12_lane_checker', 't12_lane_integrator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT', r);
    END IF;
  END LOOP;
END $$;

-- A role of one of these names may already exist with more power. ALTER ROLE resets attributes only,
-- and NOINHERIT does not stop SET ROLE, so memberships and object grants are removed here too. Each
-- REVOKE targets a grant the role actually holds, because a blanket REVOKE fails on any object the
-- applying role cannot administer. The retired shared role gets the same treatment.
DO $$
DECLARE
  r text;
  who oid;
  stmt text;
BEGIN
  FOREACH r IN ARRAY ARRAY['t12_lane_maker', 't12_lane_checker', 't12_lane_integrator', 't12_lane_worker'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    who := r::regrole;
    FOR stmt IN
      SELECT format('REVOKE %s FROM %I', roleid::regrole, r) FROM pg_auth_members WHERE member = who
      UNION ALL
      SELECT format('REVOKE ALL ON %s %s FROM %I', CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, c.oid::regclass, r)
        FROM pg_class c
       WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = who)
          OR EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a WHERE t.attrelid = c.oid AND a.grantee = who)
      UNION
      SELECT format('REVOKE ALL ON FUNCTION %s FROM %I', p.oid::regprocedure, r)
        FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = who
      UNION
      SELECT format('REVOKE ALL ON SCHEMA %I FROM %I', n.nspname, r)
        FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = who
      UNION
      -- A default privilege would grant the role every object created later.
      SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %s %s REVOKE ALL ON %s FROM %I',
                    d.defaclrole::regrole,
                    CASE WHEN d.defaclnamespace = 0 THEN '' ELSE format('IN SCHEMA %s', d.defaclnamespace::regnamespace) END,
                    CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END,
                    r)
        FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = who
    LOOP
      EXECUTE stmt;
    END LOOP;
    -- Ownership cannot be revoked, and dropping someone's objects is not this file's call.
    IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = who)
       OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = who)
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = who) THEN
      RAISE EXCEPTION '% owns database objects; reassign them before applying this file', r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_lane_worker') THEN
    ALTER ROLE t12_lane_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END $$;

ALTER ROLE t12_lane_maker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER ROLE t12_lane_checker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER ROLE t12_lane_integrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

GRANT USAGE ON SCHEMA public TO t12_lane_maker, t12_lane_checker, t12_lane_integrator;

-- Only the columns a lane writes. `result` is the column the RepID bridge scores, and it is not here.
GRANT SELECT ON public.trinity_tasks TO t12_lane_maker, t12_lane_checker, t12_lane_integrator;
-- Only a maker enqueues.
GRANT INSERT (title, description, task_type, task_category, status, assigned_to, priority, insert_source, metadata) ON public.trinity_tasks TO t12_lane_maker;
-- Every stage write is one UPDATE naming all of these columns, so each role needs them all. Which
-- values a role may change is decided per role by t12_belt_stage_permits, not by this grant.
GRANT UPDATE (status, claimed_by, claimed_at, started_at, expires_at, claim_count, metadata, artifact_url, external_artifact_url,
              verifier_verdict, verifier_evidence, final_verdict, verification_method, stuck_reason, verified_at, verify_count, completed_at)
  ON public.trinity_tasks TO t12_lane_maker, t12_lane_checker, t12_lane_integrator;
GRANT SELECT, INSERT, UPDATE ON public.agent_resource_claims TO t12_lane_maker, t12_lane_checker, t12_lane_integrator;
GRANT SELECT ON public.trinity_system_config TO t12_lane_maker, t12_lane_checker, t12_lane_integrator;

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO t12_lane_maker', pg_get_serial_sequence('public.trinity_tasks', 'id'));
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO t12_lane_maker, t12_lane_checker, t12_lane_integrator', pg_get_serial_sequence('public.agent_resource_claims', 'id'));
END $$;

ALTER TABLE public.trinity_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_resource_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trinity_system_config ENABLE ROW LEVEL SECURITY;

-- Task-bound belts. A lane may submit work only under a live belt for that task and that claim.
-- The belt is a row in principal_grants. No lane role holds a privilege on that table or on the
-- denial log, so none can mint, restore, or read back either one. A policy function, not the
-- lane's code, decides, which is what makes this enforcement instead of a check the code can skip.
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
    FROM public.trinity_tasks WHERE id = p_task AND assigned_to = 'trinity-t12-lanes' FOR UPDATE;
  belt := COALESCE(r.t #>> '{spec,belt}', 'engineering');
  reason := CASE
    WHEN r.id IS NULL THEN 'task is not in the lane pool'
    WHEN r.status IS DISTINCT FROM 'claimed' OR r.t ->> 'stage' IS DISTINCT FROM 'making' THEN 'task is not being made'
    WHEN p_lane !~ '^trinity-lane-[a-z0-9][a-z0-9-]*$' THEN 'the grantee is not a lane'
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
    -- Lane tasks only, and one row per task and reason every 10 minutes, so the caller cannot flood
    -- this log or pin a denial on a task outside the pool.
    IF r.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.trinity_agent_logs
       WHERE task_id = p_task AND action = 'belt_denied' AND message = reason AND created_at > now() - interval '10 minutes'
    ) THEN
      INSERT INTO public.trinity_agent_logs (agent, task_id, action, status, message, metadata)
      VALUES ('t12-belt-issuer', p_task, 'belt_denied', 'denied', reason, jsonb_build_object('lane', left(p_lane, 80), 'epoch', p_epoch, 'belt', left(belt, 40)));
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', reason);
  END IF;
  RETURN jsonb_build_object('ok', true, 'grant_id', g.id, 'belt', g.role, 'expires_at', g.expires_at);
END
$$;

-- The submission belt, checked inside t12_belt_stage_permits for every lane write. Only a live belt
-- can put a submission on a row. On its own it allows any stage once a submission exists, which is
-- the P1 hole; the stage check below is what closes it.
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
  -- The integrator pushes this ref and the checker hands these ids to git, so they must be exact.
  IF n #>> '{submission,branch}' IS DISTINCT FROM format('t12/%s-e%s', o #>> '{spec,id}', o ->> 'epoch')
     OR n #>> '{submission,branch}' !~ '^t12/[A-Za-z0-9_.-]{1,64}-e[0-9]+$'
     OR COALESCE(n #>> '{submission,commit}', '') !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR COALESCE(n #>> '{submission,base}', '') !~ '^([0-9a-f]{40}|[0-9a-f]{64})$' THEN
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

-- Which stage moves each role may make. Every lane write to trinity_tasks passes through here (the
-- policies below), so what a role can do is decided in Postgres, not by which code it runs. The role
-- name is fixed in each policy, so a caller cannot pick another role's rules. The submission belt
-- above still applies to every write.
CREATE OR REPLACE FUNCTION public.t12_belt_stage_permits(p_role text, p_new public.trinity_tasks) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  o public.trinity_tasks;
  n jsonb := p_new.metadata -> 't12';
  ot jsonb;
  os text;
  ns text := p_new.metadata #>> '{t12,stage}';
  producer text;
  same_work boolean;
  same_verdict boolean;
  same_finish boolean;
BEGIN
  IF NOT public.t12_belt_permits(p_new.id, p_new.metadata) THEN
    RETURN false;
  END IF;
  SELECT * INTO o FROM public.trinity_tasks WHERE id = p_new.id AND assigned_to = 'trinity-t12-lanes';
  IF NOT FOUND THEN
    -- A new row. Only a maker enqueues, and only work nobody has started.
    RETURN p_role = 'maker' AND p_new.status = 'pending' AND p_new.claimed_by IS NULL AND n -> 'producer' IS NULL;
  END IF;
  ot := o.metadata -> 't12';
  IF n IS NULL OR ot IS NULL THEN
    RETURN false;
  END IF;
  os := ot ->> 'stage';
  producer := ot ->> 'producer';
  same_work := n -> 'submission' IS NOT DISTINCT FROM ot -> 'submission' AND n -> 'producer' IS NOT DISTINCT FROM ot -> 'producer';
  -- The verdict is the checker's alone.
  same_verdict := p_new.verifier_verdict IS NOT DISTINCT FROM o.verifier_verdict
    AND p_new.verifier_evidence IS NOT DISTINCT FROM o.verifier_evidence
    AND p_new.verification_method IS NOT DISTINCT FROM o.verification_method
    AND p_new.verified_at IS NOT DISTINCT FROM o.verified_at
    AND COALESCE(p_new.verify_count, 0) = COALESCE(o.verify_count, 0);
  -- Publishing is the integrator's alone.
  same_finish := p_new.completed_at IS NOT DISTINCT FROM o.completed_at
    AND p_new.external_artifact_url IS NOT DISTINCT FROM o.external_artifact_url;
  -- No stage closes a lane task as done: `rejected` is the only final verdict any stage may write,
  -- plus `unverified` on a checker's approval.
  IF p_new.final_verdict IS DISTINCT FROM o.final_verdict AND p_new.final_verdict IS DISTINCT FROM 'rejected'
     AND NOT (p_role = 'checker' AND ns = 'approved' AND p_new.final_verdict = 'unverified') THEN
    RETURN false;
  END IF;

  IF p_role = 'maker' THEN
    -- Claim, heartbeat, release, wait, give up, or submit under a belt. Nothing past awaiting_check.
    RETURN same_verdict AND same_finish AND os IN ('ready', 'making', 'waiting_for_capacity') AND (
      (same_work AND ns IN ('ready', 'making', 'waiting_for_capacity', 'rejected', 'not_checked'))
      -- t12_belt_permits has already required a live belt for a changed submission. The producer it
      -- records is the lane that holds that belt.
      OR (os = 'making' AND ns = 'awaiting_check' AND o.claimed_by IS NOT NULL AND n ->> 'producer' IS NOT DISTINCT FROM o.claimed_by));
  END IF;

  IF p_role = 'checker' THEN
    IF NOT same_work OR NOT same_finish OR producer IS NULL THEN
      RETURN false;
    END IF;
    IF os = 'awaiting_check' THEN
      -- Take a check, never as the lane that made the work.
      RETURN ns = 'checking' AND same_verdict AND p_new.claimed_by IS NOT NULL AND p_new.claimed_by IS DISTINCT FROM producer;
    END IF;
    IF os = 'checking' THEN
      -- Record a verdict, or hand the check back. The lane holding the check is never the producer.
      RETURN o.claimed_by IS NOT NULL AND o.claimed_by IS DISTINCT FROM producer AND p_new.claimed_by IS NULL AND (
        ns = 'approved'
        OR (ns IN ('ready', 'rejected', 'awaiting_check', 'not_checked') AND p_new.verifier_verdict IS DISTINCT FROM 'approved'));
    END IF;
    RETURN false;
  END IF;

  IF p_role = 'integrator' THEN
    IF NOT same_work OR NOT same_verdict THEN
      RETURN false;
    END IF;
    IF os = 'approved' THEN
      -- Take verified work to publish. A lane never publishes HIGH risk.
      RETURN ns = 'integrating' AND same_finish AND p_new.claimed_by IS NOT NULL AND ot #>> '{spec,risk}' IS DISTINCT FROM 'HIGH';
    END IF;
    IF os = 'integrating' THEN
      -- Publish, refuse, or hand back. Handing back returns the row to `approved`, where it came
      -- from, so an integrator can never make approved a row that a checker did not.
      RETURN o.claimed_by IS NOT NULL AND (
        (ns = 'integrated' AND p_new.completed_at IS NOT NULL)
        OR (ns = 'rejected' AND same_finish)
        OR (ns = 'approved' AND same_finish AND p_new.claimed_by IS NULL));
    END IF;
    RETURN false;
  END IF;
  RETURN false;
END
$$;

-- Supabase's default privileges make a new public function executable by anon and authenticated.
REVOKE ALL ON FUNCTION public.t12_belt_prefixes(text), public.t12_belt_paths_ok(text, jsonb), public.t12_belt_checkout(bigint, text, integer),
  public.t12_belt_permits(bigint, jsonb), public.t12_belt_stage_permits(text, public.trinity_tasks) FROM PUBLIC;
DO $$
DECLARE
  who text;
BEGIN
  FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = who) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.t12_belt_prefixes(text), public.t12_belt_paths_ok(text, jsonb), public.t12_belt_checkout(bigint, text, integer), '
                     'public.t12_belt_permits(bigint, jsonb), public.t12_belt_stage_permits(text, public.trinity_tasks) FROM %I', who);
    END IF;
  END LOOP;
END $$;
-- Only a maker checks out a belt. Every role needs the stage check, because its policy calls it.
GRANT EXECUTE ON FUNCTION public.t12_belt_checkout(bigint, text, integer) TO t12_lane_maker;
GRANT EXECUTE ON FUNCTION public.t12_belt_stage_permits(text, public.trinity_tasks) TO t12_lane_maker, t12_lane_checker, t12_lane_integrator;

-- A SECURITY DEFINER function runs with its owner's rights, and every function starts out executable
-- by PUBLIC, which includes the lane roles. PUBLIC cannot exclude a role, so for each such function
-- still open to PUBLIC, this names every role except the lane roles and then closes PUBLIC. No other
-- role gains or loses anything, and a function already closed to PUBLIC is left alone. This does
-- change the grants on functions the lanes do not own, which is why the owner reviews and applies
-- this file, and why it needs a security review.
DO $$
DECLARE
  f regprocedure;
  who text;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef AND p.proname !~ '^t12_belt_'
       AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  LOOP
    FOR who IN SELECT rolname FROM pg_roles WHERE rolname !~ '^t12_lane_' AND rolname !~ '^pg_' LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, who);
    END LOOP;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;

-- The retired shared role's policies. Without a grant they are inert; dropping them leaves nothing to re-arm.
DROP POLICY IF EXISTS t12_lane_worker_pool ON public.trinity_tasks;
DROP POLICY IF EXISTS t12_lane_worker_claims ON public.agent_resource_claims;
DROP POLICY IF EXISTS t12_lane_worker_halt ON public.trinity_system_config;

-- One policy per role, each naming its own rules. The status pin and the lane-name pin apply to all.
DROP POLICY IF EXISTS t12_lane_maker_pool ON public.trinity_tasks;
CREATE POLICY t12_lane_maker_pool ON public.trinity_tasks
  FOR ALL TO t12_lane_maker
  USING (assigned_to = 'trinity-t12-lanes')
  WITH CHECK (
    assigned_to = 'trinity-t12-lanes'
    AND public.t12_belt_stage_permits('maker', trinity_tasks)
    -- Never done, verified or shadow_reject: trinity-task-bridge scores those with no pool filter.
    AND status IN ('pending', 'claimed', 'pending_validation', 'cancelled', 'not_checked')
    -- A belt names its holder, so a row may only ever name a lane.
    AND (claimed_by IS NULL OR claimed_by ~ '^trinity-lane-[a-z0-9][a-z0-9-]*$')
  );

DROP POLICY IF EXISTS t12_lane_checker_pool ON public.trinity_tasks;
CREATE POLICY t12_lane_checker_pool ON public.trinity_tasks
  FOR ALL TO t12_lane_checker
  USING (assigned_to = 'trinity-t12-lanes')
  WITH CHECK (
    assigned_to = 'trinity-t12-lanes'
    AND public.t12_belt_stage_permits('checker', trinity_tasks)
    AND status IN ('pending', 'claimed', 'pending_validation', 'cancelled', 'not_checked')
    AND (claimed_by IS NULL OR claimed_by ~ '^trinity-lane-[a-z0-9][a-z0-9-]*$')
  );

DROP POLICY IF EXISTS t12_lane_integrator_pool ON public.trinity_tasks;
CREATE POLICY t12_lane_integrator_pool ON public.trinity_tasks
  FOR ALL TO t12_lane_integrator
  USING (assigned_to = 'trinity-t12-lanes')
  WITH CHECK (
    assigned_to = 'trinity-t12-lanes'
    AND public.t12_belt_stage_permits('integrator', trinity_tasks)
    AND status IN ('pending', 'claimed', 'pending_validation', 'cancelled', 'not_checked')
    AND (claimed_by IS NULL OR claimed_by ~ '^trinity-lane-[a-z0-9][a-z0-9-]*$')
  );

DROP POLICY IF EXISTS t12_lane_claims ON public.agent_resource_claims;
CREATE POLICY t12_lane_claims ON public.agent_resource_claims
  FOR ALL TO t12_lane_maker, t12_lane_checker, t12_lane_integrator
  USING (resource_kind = 'other' AND (resource_id LIKE 'llm_cooldown:%' OR resource_id LIKE 'lane_wake:%'))
  WITH CHECK (resource_kind = 'other' AND (resource_id LIKE 'llm_cooldown:%' OR resource_id LIKE 'lane_wake:%'));

DROP POLICY IF EXISTS t12_lane_halt ON public.trinity_system_config;
CREATE POLICY t12_lane_halt ON public.trinity_system_config
  FOR SELECT TO t12_lane_maker, t12_lane_checker, t12_lane_integrator
  USING (true);

COMMIT;
