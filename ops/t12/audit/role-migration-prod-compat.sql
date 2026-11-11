-- READ-ONLY. Does migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql fit the live schema it would land on?
-- Run it in a READ ONLY transaction against the target database before the owner applies the migration.
-- It changes nothing and needs no lane role to exist. Each block answers one question the CI fixture
-- cannot, because the fixture is synthetic.
--
-- What it established on 2026-11-11 (production): row security already on for all three tables, so the
-- forward file's ENABLE is a no-op; all four lane names survive normalize_agent_name unchanged; every
-- enabled trinity_tasks trigger runs as the caller and none acts on a lane row; PUBLIC holds no table
-- privilege on any table below, so the lane roles get only what the forward file grants; 13 SECURITY
-- DEFINER functions in public are still open to PUBLIC, and the forward file names 17 roles on each
-- before closing PUBLIC.

BEGIN READ ONLY;

-- 1. Row security, owner, and every policy on the tables the forward file touches.
SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner,
       p.polname, p.polcmd, p.polpermissive,
       (SELECT array_agg(coalesce(r.rolname, 'PUBLIC')) FROM unnest(p.polroles) pr LEFT JOIN pg_roles r ON r.oid = pr) AS roles
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
 WHERE c.relname IN ('trinity_tasks', 'agent_resource_claims', 'trinity_system_config', 'principal_grants', 'trinity_agent_logs')
 ORDER BY 1, 5;

-- 2. Enabled triggers on trinity_tasks: each runs as the lane role when a lane writes, so each must
--    either not fire on a lane row or touch nothing the lane role lacks. Read every body.
SELECT tg.tgname, p.proname, p.prosecdef, pg_get_triggerdef(tg.oid) AS trig, p.prosrc
  FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
 WHERE tg.tgrelid = 'public.trinity_tasks'::regclass AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'
 ORDER BY 1;

-- 3. The lane names must survive the name trigger, or the row policy's assigned_to pin refuses every insert.
SELECT normalize_agent_name('trinity-t12-lanes') AS pool, normalize_agent_name('trinity-lane-1') AS lane1,
       normalize_agent_name('trinity-lane-2') AS lane2, normalize_agent_name('trinity-lane-3') AS lane3;

-- 4. Columns, constraints and sequences the forward file names.
SELECT pg_get_constraintdef(co.oid) FROM pg_constraint co WHERE co.conrelid = 'public.trinity_tasks'::regclass AND co.contype = 'c';
SELECT pg_get_serial_sequence('public.trinity_tasks', 'id') AS tasks_seq, pg_get_serial_sequence('public.agent_resource_claims', 'id') AS claims_seq;
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'trinity_tasks'
   AND column_name IN ('title', 'description', 'task_type', 'task_category', 'status', 'assigned_to', 'priority', 'insert_source', 'metadata',
                       'claimed_by', 'claimed_at', 'started_at', 'expires_at', 'claim_count', 'artifact_url', 'external_artifact_url')
 ORDER BY 1;

-- 5. Table privileges held through PUBLIC (expect none), and leftovers from an earlier draft (expect none).
SELECT c.relname, c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
 WHERE c.relname IN ('trinity_tasks', 'agent_resource_claims', 'trinity_system_config', 'principal_grants', 'trinity_agent_logs');
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 't12_lane%';
SELECT proname FROM pg_proc WHERE proname LIKE 't12_belt%';

-- 6. The scope of the PUBLIC EXECUTE closure: which definer functions it re-grants, and to which roles.
SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef AND p.proname !~ '^t12_belt_'
   AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
 ORDER BY 1;
SELECT rolname FROM pg_roles WHERE rolname !~ '^t12_lane_' AND rolname !~ '^pg_' ORDER BY 1;

-- 7. The reaper the lanes rely on for expired leases.
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'trinity_reap_expired_claims';

ROLLBACK;
