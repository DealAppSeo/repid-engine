# APPLY INSTRUCTIONS — 2026-06-04 (XC staged hardening for Claude/Sean via Supabase MCP)

**Context:** XC R4 outputs staged in this tree (repid-engine-xc5 worktree, on its feature branch). DB/chain gates were BLOCKED in XC env (no keys) so nothing applied live. These are ready for apply on Sean's co-sign via MCP (or Supabase SQL editor / apply_migration).

**Base:** repid-engine main at `2cb70c1` (per handoff; migration verified compatible / only adds the two policies on top of that state).

**Order (exact, one at a time, verify between):**

1. **RLS-33 clean (migrations/2026-06-03-rls-33-clean.sql)**
   - File: `migrations/2026-06-03-rls-33-clean.sql` (in this tree; content verified: only x402_settlements owner_read_own + agent_services public_read; service_role_all recreated for them; 31/33 credential tables explicitly left deny-all/service-only with comments listing examples like agent_api_keys, authorized_signers, stake_*, hal_*, zkp_routing_config, etc.; each has -- rollback: DROP POLICY lines + DISABLE RLS).
   - Apply: Run the full BEGIN; ... COMMIT; (the two ALTER/CREATE blocks).
   - Verify post: 
     ```
     SELECT schemaname, tablename, policyname, roles, cmd 
     FROM pg_policies 
     WHERE tablename IN ('x402_settlements','agent_services');
     ```
     Expect: owner_read_own + public_read (plus service_role_all); no new policies on any credential tables.
   - Rollback (per table, exact from file):
     - For x402_settlements: `DROP POLICY IF EXISTS "owner_read_own" ON public.x402_settlements; DROP POLICY IF EXISTS "service_role_all" ON public.x402_settlements; ALTER TABLE public.x402_settlements DISABLE ROW LEVEL SECURITY;`
     - For agent_services: `DROP POLICY IF EXISTS "public_read" ON public.agent_services; DROP POLICY IF EXISTS "service_role_all" ON public.agent_services; ALTER TABLE public.agent_services DISABLE ROW LEVEL SECURITY;`
   - Gate: only 2 tables gained client policies; 31/33 untouched; anon read on x402 now fails (if was open); service_role still full.

2. **Pen-test findings (fresh test_run_id)**
   - File: `scratch/r4-pen-test-findings.sql`
   - Contains: 4 INSERTs into red_team_results with test_run_id='r4-2026-06-04-grok-probe' (f2-authz-spoof high, x402-replay high, controller-ssrf med, rls-anon-read high; each with payload/finding/severity/repro/fix/rollback).
   - Apply: Run the INSERTs (or the whole file).
   - Verify: `SELECT count(*) FROM red_team_results WHERE test_run_id = 'r4-2026-06-04-grok-probe';` (should be 4).
   - Rollback: `DELETE FROM red_team_results WHERE test_run_id = 'r4-2026-06-04-grok-probe';`
   - Note: re-runs use new test_run_id (e.g. for DeepSeek/Qwen probes).

3. **Triage 8539 stale tasks**
   - Script: `scripts/triage-stale-tasks.ts` (or the SQL it emits).
   - SQL (reversible archive):
     ```
     -- Classify first
     SELECT source, status, count(*) as cnt, min(created_at) as oldest
     FROM trinity_tasks
     WHERE created_at < '2026-05-13'
     GROUP BY source, status ORDER BY cnt DESC;

     -- Archive (dead system pending, no recent claim)
     UPDATE trinity_tasks
     SET status = 'archived', 
         archived_at = now(),
         metadata = jsonb_set(COALESCE(metadata, '{}'), '{r4_triage}', '"2026-06-03-dead-system"')
     WHERE source = 'system'
       AND status IN ('pending', 'queued')
       AND created_at < '2026-05-13'
       AND NOT EXISTS (
         SELECT 1 FROM trinity_task_claims c 
         WHERE c.task_id = trinity_tasks.id AND c.claimed_at > '2026-05-01'
       );

     -- Rollback (reversible via metadata tag)
     -- UPDATE trinity_tasks 
     -- SET status = 'pending', archived_at = null, metadata = metadata - 'r4_triage'
     -- WHERE metadata->>'r4_triage' = '2026-06-03-dead-system';
     ```
   - Apply: Run classify, then the UPDATE (archive first — reversible).
   - Verify: counts drop for system pending <2026-05-13; archived_at set; tag present.
   - Full delete only after review + Sean co-sign (sprint: recommend archive first).
   - Rollback: the UPDATE SET pending + remove tag (exact in script).

**General:**
- Run in Supabase SQL editor or via apply_migration (on Sean's co-sign).
- Testable: each has explicit rollback; run on staging first if possible.
- Citations: the files themselves have headers matching XC R4 / handoff §7; verified in xc5 tree against 2cb70c1 base.
- After applies: re-run relevant verifiers (rls checks, red_team_results count, trinity_tasks counts).

**Handoff:** Claude owns applying these via MCP on co-sign. XC staged only (keyless env).

*2026-06-04. Micah 6:8.*