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
--
-- Added 2026-11-24, after the two-reviewer review of the forward file:
--   - block 4 asks about EVERY column the forward file grants, and prints a row for each one whether
--     it exists or not. The earlier list had 16 names and left out the 8 the checker and integrator
--     write; and a query that lists only what it finds cannot show that something is missing.
--   - block 8: the columns, constraints and partial unique index the belt functions rely on in
--     principal_grants, and the columns of the denial log.
--   - block 9: whether the login that will apply the forward file is a superuser. On PostgreSQL 16+
--     that decides whether ALTER ROLE may name the superuser attribute at all (review finding 1).
--   - block 2 prints an md5 of each trigger function's source. Compare with the last run: a changed
--     fingerprint means that trigger must be read again before a lane writes to the table.
--     2026-11-24 production, first 8 characters as recorded that day in ROLE_MIGRATION_COMPAT_CHECK.md:
--       auto_fix_task_status 9d1df741 · trg_auto_lineage 19220775 · trg_enable_enforce_artifact d2e1bc58
--       trg_normalize_agent_names 4ef156c5 · trg_protect_key_tasks 1584c707
--       trg_task_status_reflects_result 34881cbb · trigger_throttle_healing fff58d0a
--       update_trinity_tasks_updated_at 10ff09e0
--     and what each does on a lane write is in ROLE_MIGRATION_REVIEW.md of the same date.

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
--    either not fire on a lane row or touch nothing the lane role lacks. Read every body, or compare
--    each fingerprint with the last run and read the ones that changed.
SELECT tg.tgname, p.proname, p.prosecdef, md5(p.prosrc) AS body_md5, left(md5(p.prosrc), 8) AS body_md5_8, pg_get_triggerdef(tg.oid) AS trig, p.prosrc
  FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
 WHERE tg.tgrelid = 'public.trinity_tasks'::regclass AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'
 ORDER BY 1;

-- 3. The lane names must survive the name trigger, or the row policy's assigned_to pin refuses every insert.
SELECT normalize_agent_name('trinity-t12-lanes') AS pool, normalize_agent_name('trinity-lane-1') AS lane1,
       normalize_agent_name('trinity-lane-2') AS lane2, normalize_agent_name('trinity-lane-3') AS lane3;

-- 4. Columns, constraints and sequences the forward file names.
SELECT pg_get_constraintdef(co.oid) FROM pg_constraint co WHERE co.conrelid = 'public.trinity_tasks'::regclass AND co.contype = 'c';
SELECT pg_get_serial_sequence('public.trinity_tasks', 'id') AS tasks_seq, pg_get_serial_sequence('public.agent_resource_claims', 'id') AS claims_seq;
--    One row per column the forward file names on trinity_tasks, present or not. Expect present = true
--    on all 26; a false stops the forward file at its column grant. `generated` must be empty: a
--    generated column cannot be written. The last 8 are the ones the earlier list left out.
SELECT want.col, c.column_name IS NOT NULL AS present, c.data_type, c.is_nullable, c.is_generated AS generated
  FROM unnest(ARRAY['title', 'description', 'task_type', 'task_category', 'status', 'assigned_to', 'priority', 'insert_source', 'metadata',
                    'claimed_by', 'claimed_at', 'started_at', 'expires_at', 'claim_count', 'artifact_url', 'external_artifact_url',
                    'id', 'created_at',
                    'verifier_verdict', 'verifier_evidence', 'final_verdict', 'verification_method', 'stuck_reason', 'verified_at', 'verify_count', 'completed_at']) WITH ORDINALITY AS want(col, n)
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = 'trinity_tasks' AND c.column_name = want.col
 ORDER BY want.n;

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

-- 8. What the belt functions rely on outside trinity_tasks.
--    8a. Columns of principal_grants that t12_belt_checkout writes and t12_belt_permits reads, and the
--        columns of the denial log. One row each, present or not. Expect present = true on all.
SELECT want.tbl, want.col, c.column_name IS NOT NULL AS present, c.data_type, c.is_nullable, c.column_default
  FROM (VALUES ('principal_grants', 'id'), ('principal_grants', 'grantor_agent_id'), ('principal_grants', 'grantee_agent_id'), ('principal_grants', 'grant_class'),
               ('principal_grants', 'capabilities'), ('principal_grants', 'role'), ('principal_grants', 'expires_at'), ('principal_grants', 'mint_reason'),
               ('principal_grants', 'idempotency_key'), ('principal_grants', 'signature_status'), ('principal_grants', 'revoked_at'), ('principal_grants', 'not_before'),
               ('trinity_agent_logs', 'agent'), ('trinity_agent_logs', 'task_id'), ('trinity_agent_logs', 'action'), ('trinity_agent_logs', 'status'),
               ('trinity_agent_logs', 'message'), ('trinity_agent_logs', 'metadata'), ('trinity_agent_logs', 'created_at')) AS want(tbl, col)
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col
 ORDER BY 1, 2;
--    8b. Any column of either table that must be given a value and has no default, so the function's
--        insert would fail if it is not in 8a. Expect: only names that appear in 8a.
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('principal_grants', 'trinity_agent_logs')
   AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'
 ORDER BY 1, 2;
--    8c. The index behind ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL. Expect one
--        row with is_unique = true, valid = true, and exactly that column and that predicate. Without
--        it, the checkout function fails on every call.
SELECT i.indexrelid::regclass AS index_name, i.indisunique AS is_unique, i.indisvalid AS valid,
       pg_get_indexdef(i.indexrelid) AS definition, pg_get_expr(i.indpred, i.indrelid) AS predicate
  FROM pg_index i
 WHERE i.indrelid = 'public.principal_grants'::regclass
   AND pg_get_indexdef(i.indexrelid) LIKE '%idempotency_key%';
--    8d. The check constraints the function's row must satisfy: grant_class 'cold', signature_status
--        'NOT_CHECKED', expires_at after not_before, depth 0.
SELECT co.conname, pg_get_constraintdef(co.oid) FROM pg_constraint co WHERE co.conrelid = 'public.principal_grants'::regclass AND co.contype = 'c' ORDER BY 1;

-- 9. Who applies the forward file. Run this check as any login; the row that matters is the login
--    the owner will apply as (the SQL editor's is `postgres`). On PostgreSQL 16 and later a login with
--    rolsuper = false may not name the superuser attribute in ALTER ROLE, and may only remove
--    BYPASSRLS, CREATEDB or REPLICATION from a role if it holds that attribute itself. The forward
--    file needs: rolcreaterole, rolcreatedb, rolbypassrls and rolreplication all true, or rolsuper.
SELECT current_setting('server_version') AS server_version, current_user AS this_check_ran_as;
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
  FROM pg_roles WHERE rolname IN ('postgres', current_user) ORDER BY 1;
--    The applying login must also own what the forward file changes: the five tables, the two id
--    sequences, and each definer function it re-grants. Expect that login in every row.
--    (2026-11-24 production: `postgres` on all of them.)
SELECT c.relname AS object, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
 WHERE c.relname IN ('trinity_tasks', 'agent_resource_claims', 'trinity_system_config', 'principal_grants', 'trinity_agent_logs')
    OR c.oid IN (pg_get_serial_sequence('public.trinity_tasks', 'id')::regclass, pg_get_serial_sequence('public.agent_resource_claims', 'id')::regclass)
UNION ALL
SELECT p.oid::regprocedure::text, pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef AND p.proname !~ '^t12_belt_'
   AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
 ORDER BY 1;
--    And it must be able to add functions to schema public and hand out its use. The schema belongs
--    to the database owner, so expect the applying login as db_owner, or applying_login_is_db_owner
--    true. (2026-11-24 production: db_owner `postgres`.)
SELECT (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS db_owner,
       pg_has_role('postgres', 'pg_database_owner', 'MEMBER') AS applying_login_is_db_owner,
       (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public') AS public_schema_acl;

ROLLBACK;
