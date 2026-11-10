-- DRAFT rollback for migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql. The owner applies it;
-- nothing runs it automatically. It removes the lane roles, their policies and the belt functions.
--
-- What it does NOT undo, on purpose:
--   - Row security stays enabled on trinity_tasks, agent_resource_claims and trinity_system_config.
--     Production had it on before the forward file.
--   - The PUBLIC EXECUTE closure on other SECURITY DEFINER functions is not reopened. The forward file
--     granted EXECUTE by name to every role that could reach one through PUBLIC, so no role lost
--     access; reopening PUBLIC needs the list from before it ran, which it does not record. That is a
--     security-review decision, not a rollback step.
--   - Belt rows already written to principal_grants and trinity_agent_logs stay, as history.
BEGIN;

DROP POLICY IF EXISTS t12_lane_maker_pool ON public.trinity_tasks;
DROP POLICY IF EXISTS t12_lane_checker_pool ON public.trinity_tasks;
DROP POLICY IF EXISTS t12_lane_integrator_pool ON public.trinity_tasks;
DROP POLICY IF EXISTS t12_lane_worker_pool ON public.trinity_tasks;
DROP POLICY IF EXISTS t12_lane_claims ON public.agent_resource_claims;
DROP POLICY IF EXISTS t12_lane_worker_claims ON public.agent_resource_claims;
DROP POLICY IF EXISTS t12_lane_halt ON public.trinity_system_config;
DROP POLICY IF EXISTS t12_lane_worker_halt ON public.trinity_system_config;

DROP FUNCTION IF EXISTS public.t12_belt_stage_permits(text, public.trinity_tasks);
DROP FUNCTION IF EXISTS public.t12_belt_checkout(bigint, text, integer);
DROP FUNCTION IF EXISTS public.t12_belt_permits(bigint, jsonb);
DROP FUNCTION IF EXISTS public.t12_belt_paths_ok(text, jsonb);
DROP FUNCTION IF EXISTS public.t12_belt_prefixes(text);

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['t12_lane_maker', 't12_lane_checker', 't12_lane_integrator', 't12_lane_worker'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    -- DROP OWNED would also drop anything the role owns, and that is not this file's call.
    IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = r::regrole)
       OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r::regrole)
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r::regrole) THEN
      RAISE EXCEPTION '% owns database objects; reassign them before rolling back', r;
    END IF;
    -- Owns nothing, so this only revokes its grants and default privileges in this database.
    EXECUTE format('DROP OWNED BY %I', r);
    BEGIN
      EXECUTE format('DROP ROLE %I', r);
    EXCEPTION WHEN dependent_objects_still_exist THEN
      -- It still holds grants in another database of this cluster. It can no longer log in; drop it there.
      EXECUTE format('ALTER ROLE %I NOLOGIN', r);
      RAISE NOTICE '% still holds privileges in another database: made NOLOGIN, not dropped', r;
    END;
  END LOOP;
END $$;

COMMIT;
