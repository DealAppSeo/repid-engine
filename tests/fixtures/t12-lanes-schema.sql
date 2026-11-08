-- The parts of production `trinity_tasks` the T12 lanes depend on, for tests/t12-lanes.test.ts.
-- Constraints, trigger functions and the reaper are copied from qnnpjhlxljtqyigedwkb on 2026-11-07
-- (pg_get_constraintdef / pg_get_functiondef), because the lanes are shaped by how those behave.
-- Refresh this file if any of them change in production.

DROP TABLE IF EXISTS trinity_tasks CASCADE;
DROP TABLE IF EXISTS trinity_changelog CASCADE;
DROP TABLE IF EXISTS agent_resource_claims CASCADE;
DROP TABLE IF EXISTS trinity_system_config CASCADE;
DROP TABLE IF EXISTS repid_agents CASCADE;

CREATE TABLE trinity_system_config (id integer PRIMARY KEY, emergency_halt boolean NOT NULL DEFAULT false);
INSERT INTO trinity_system_config (id, emergency_halt) VALUES (1, false);
-- Present only so a test can prove the restricted worker role cannot read it.
CREATE TABLE repid_agents (id serial PRIMARY KEY, agent_name text, current_repid integer);
INSERT INTO repid_agents (agent_name, current_repid) VALUES ('trinity-orch', 1000);

CREATE TABLE agent_resource_claims (
  id bigserial PRIMARY KEY,
  resource_kind text NOT NULL CHECK (resource_kind = ANY (ARRAY['repo','git_branch','supabase_table','supabase_migration','railway_service','env_var','other'])),
  resource_id text NOT NULL,
  claimed_by text NOT NULL,
  session_id text,
  purpose text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CONSTRAINT claim_expires_after_it_starts CHECK (expires_at > claimed_at)
);
CREATE UNIQUE INDEX uniq_active_claim ON agent_resource_claims (resource_kind, resource_id) WHERE released_at IS NULL;

CREATE TABLE trinity_changelog (
  id bigserial PRIMARY KEY, change_date timestamptz, change_type text, description text, changed_by text
);

CREATE TABLE trinity_tasks (
  id bigserial PRIMARY KEY,
  title text,
  description text NOT NULL,
  task_type text,
  task_category text,
  status varchar DEFAULT 'pending',
  priority integer DEFAULT 5,
  assigned_to text,
  agent_assigned varchar,
  agent_name text,
  completed_by text,
  claimed_by text,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  claim_count integer NOT NULL DEFAULT 0,
  required_capabilities text[] NOT NULL DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  result text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  insert_source text,
  artifact_url text,
  external_artifact_url text,
  proof_of_work text,
  requires_external_artifact boolean,
  verified_output jsonb,
  success_criteria text,
  verifier_verdict text,
  verifier_evidence text,
  final_verdict text,
  verification_method text,
  stuck_reason text,
  verified_at timestamptz,
  verify_count integer,
  CONSTRAINT check_claimed_by_prefix CHECK (claimed_by IS NULL OR claimed_by ~~ 'trinity-%' OR claimed_by = 'SYSTEM'),
  CONSTRAINT claim_atomic CHECK ((claimed_by IS NULL AND claimed_at IS NULL) OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)),
  CONSTRAINT trinity_tasks_final_verdict_check CHECK (final_verdict IS NULL OR final_verdict = ANY (ARRAY['verified_done','disputed_done','rejected','unverified','spot_audited'])),
  CONSTRAINT trinity_tasks_task_category_check CHECK (task_category = ANY (ARRAY['thinking','building'])),
  CONSTRAINT trinity_tasks_verifier_verdict_check CHECK (verifier_verdict IS NULL OR verifier_verdict = ANY (ARRAY['approved','rejected','unclear'])),
  CONSTRAINT valid_task_status CHECK (status::text = ANY (ARRAY['pending','in_progress','doing','completed','done','failed','cancelled','archived','verified','pending_validation','shadow_reject','pending_clarification','needs_artifact','not_checked','claimed']))
);

CREATE INDEX idx_trinity_tasks_status_assigned ON trinity_tasks (status, assigned_to, priority DESC);

CREATE OR REPLACE FUNCTION normalize_agent_name(raw_name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $function$
DECLARE
  cleaned TEXT;
  squad_names TEXT[] := ARRAY['alpha', 'beta', 'gamma', 'orchestration', 'orch'];
BEGIN
  cleaned := LOWER(TRIM(raw_name));
  IF cleaned = ANY(squad_names) THEN
    RETURN cleaned;
  END IF;
  cleaned := REGEXP_REPLACE(cleaned, '^trinity[-_\s]+', '', 'i');
  RETURN 'trinity-' || cleaned;
END;
$function$;

CREATE OR REPLACE FUNCTION auto_normalize_agent_names() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  NEW.assigned_to  := normalize_agent_name(NEW.assigned_to);
  NEW.claimed_by   := CASE WHEN NEW.claimed_by IS NOT NULL THEN normalize_agent_name(NEW.claimed_by) ELSE NULL END;
  NEW.completed_by := CASE WHEN NEW.completed_by IS NOT NULL THEN normalize_agent_name(NEW.completed_by) ELSE NULL END;
  NEW.agent_name   := CASE WHEN NEW.agent_name IS NOT NULL THEN normalize_agent_name(NEW.agent_name) ELSE NULL END;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_normalize_agent_names BEFORE INSERT OR UPDATE ON trinity_tasks FOR EACH ROW EXECUTE FUNCTION auto_normalize_agent_names();

-- Production calls a routing table here; a row back is what makes the bounce to pending happen.
CREATE OR REPLACE FUNCTION fn_auto_escalate_failed_task() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status = 'failed' AND (OLD.status IS NULL OR OLD.status != 'failed') THEN
    NEW.status := 'pending';
    NEW.claimed_by := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_auto_escalate BEFORE UPDATE ON trinity_tasks FOR EACH ROW EXECUTE FUNCTION fn_auto_escalate_failed_task();

CREATE OR REPLACE FUNCTION task_status_reflects_result() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status = 'done' AND NEW.result IS NOT NULL AND NEW.result::text ~* 'NOT[ _]CHECKED' THEN
    NEW.status := 'not_checked';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_task_status_reflects_result BEFORE INSERT OR UPDATE OF status, result ON trinity_tasks FOR EACH ROW EXECUTE FUNCTION task_status_reflects_result();

CREATE OR REPLACE FUNCTION trinity_reap_expired_claims() RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
  reaped integer;
BEGIN
  UPDATE public.trinity_tasks
     SET claimed_by = NULL,
         claimed_at = NULL,
         expires_at = NULL,
         status     = 'pending'
   WHERE completed_at IS NULL
     AND expires_at IS NOT NULL
     AND expires_at < now();
  GET DIAGNOSTICS reaped = ROW_COUNT;
  IF reaped > 0 THEN
    INSERT INTO public.trinity_changelog(change_date, change_type, description, changed_by)
    VALUES (now(), 'reaper', 'trinity_reap_expired_claims freed ' || reaped || ' expired-lease claim(s)', 'trinity_reap_expired_claims');
  END IF;
  RETURN reaped;
END;
$function$;
