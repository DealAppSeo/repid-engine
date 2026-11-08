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

DROP POLICY IF EXISTS t12_lane_worker_pool ON public.trinity_tasks;
CREATE POLICY t12_lane_worker_pool ON public.trinity_tasks
  FOR ALL TO t12_lane_worker
  USING (assigned_to = 'trinity-t12-lanes')
  WITH CHECK (assigned_to = 'trinity-t12-lanes');

DROP POLICY IF EXISTS t12_lane_worker_claims ON public.agent_resource_claims;
CREATE POLICY t12_lane_worker_claims ON public.agent_resource_claims
  FOR ALL TO t12_lane_worker
  USING (resource_kind = 'other' AND (resource_id LIKE 'llm_cooldown:%' OR resource_id LIKE 'lane_wake:%'))
  WITH CHECK (resource_kind = 'other' AND (resource_id LIKE 'llm_cooldown:%' OR resource_id LIKE 'lane_wake:%'));

DROP POLICY IF EXISTS t12_lane_worker_halt ON public.trinity_system_config;
CREATE POLICY t12_lane_worker_halt ON public.trinity_system_config
  FOR SELECT TO t12_lane_worker
  USING (true);
