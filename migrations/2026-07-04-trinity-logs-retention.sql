-- 2026-07-04-trinity-logs-retention.sql
-- Applied live to qnnpjhlxljtqyigedwkb on 2026-07-04 (via MCP). Committed here for
-- reproducibility. Bounds trinity_agent_logs growth: keeps ALL "signal" action
-- types, deletes only high-volume operational "noise" older than 14 days.
--
-- Context: trinity_agent_logs had bloated to 967 MB / 1.66M rows (llm_failover 612k,
-- api_auth_attempt 229k, task lifecycle ~500k). Signal (bft_slash, sbfa_pi_terms,
-- substance_gate_*, calibration_audit, first_human_sbt, …) is ~4% and archived to
-- E:\dev\archives\trinity_agent_logs. After prune + VACUUM FULL: 75 MB.

-- Batch delete of noise action-types older than the cutoff (index-driven; each call
-- stays well under the statement timeout). Returns rows deleted.
CREATE OR REPLACE FUNCTION prune_trinity_logs_batch(p_cutoff timestamptz, p_limit int)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE n integer;
BEGIN
  WITH del AS (
    SELECT ctid FROM trinity_agent_logs
    WHERE created_at < p_cutoff
      AND action = ANY(ARRAY[
        'llm_failover','api_auth_attempt','task_processing','task_reaped',
        'task_processing_llm','llm_error','learning_triggered','task_failure',
        'task_processing_local','success_criteria_skipped','task_processing_contract'
      ])
    LIMIT p_limit
  )
  DELETE FROM trinity_agent_logs t USING del WHERE t.ctid = del.ctid;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Nightly retention wrapper: loops the batch delete until drained (guard-capped).
CREATE OR REPLACE FUNCTION prune_trinity_logs_retention()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff timestamptz := now() - interval '14 days';
  deleted integer := 0;
  n integer;
  guard integer := 0;
BEGIN
  LOOP
    n := prune_trinity_logs_batch(cutoff, 10000);
    deleted := deleted + n;
    guard := guard + 1;
    EXIT WHEN n = 0 OR guard > 500;
  END LOOP;
  RAISE NOTICE 'trinity_agent_logs retention: deleted % rows', deleted;
  RETURN deleted;
END $$;

-- Nightly at 08:00 UTC (jobid 6 when applied).
-- SELECT cron.schedule('trinity-agent-logs-retention', '0 8 * * *',
--                      $$SELECT prune_trinity_logs_retention()$$);
