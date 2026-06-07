-- TRACK A ANFIS/LASSO shadow logs (A2)
-- Additive table for logging BOTH static router decision AND ANFIS decision + outcomes on live traffic.
-- ANFIS in shadow only (does not control routing until A3/A4 measure proves win on cost AND quality per cat).
-- RLS: service_role_all (internal, like other routing/audit tables).
-- Per rules: schema-first, additive, rollback per-table, verify after apply, Sean co-sign for apply.
-- Cite: src/db.ts (client is UNTYPED — no database.types.ts append needed), src/providers/router.ts (anfisRec),
--       src/routes/route.ts (wire shadow insert on /v1/llm/complete success+failure paths).
-- Report: E:\dev\reports\2026-06-05\XC_ANFIS_LASSO_A0A1A2.md
--
-- RECONCILE NOTE (CC 2026-06-06, trim of #94):
-- The table ALREADY EXISTS in prod (AITrinitySymphony qnnpjhlxljtqyigedwkb) from the earlier
-- Phase-2.10/P3 logger, with the legacy column set (verified live 2026-06-06):
--   id, request_text, selected_model, confidence_score, cost_saved, latency_ms, success, created_at, verified_by
-- A bare `CREATE TABLE IF NOT EXISTS` with the new column set is therefore a NO-OP on prod, so the new
-- src/routes/route.ts insert (prompt_preview, category, static_*, anfis_*, cost_usdc) would fail silently
-- (the insert is try/caught) → ZERO real cost data captured. To actually light up shadow logging this
-- migration ADDs the missing columns idempotently, so it works whether the table is fresh or legacy.

-- 1) Fresh install — full target schema.
CREATE TABLE IF NOT EXISTS anfis_routing_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_preview TEXT,            -- truncated for privacy
  category TEXT,
  static_provider TEXT,
  static_tier TEXT,
  static_reason TEXT,
  anfis_provider TEXT,
  anfis_tier TEXT,
  anfis_conf NUMERIC(5,4),
  cost_usdc NUMERIC(12,6),
  cost_saved NUMERIC(12,6),       -- static_cost - anfis_cost (counterfactual)
  latency_ms INTEGER,
  success BOOLEAN,
  verified_by TEXT[],             -- ['static:<prov>:<tier>', 'anfis:<prov>:<tier>']
  request_text TEXT,              -- legacy field kept for back-compat with old readers
  outcome_hal_score NUMERIC(5,4), -- quality outcome for A3 measure
  outcome_vetoed BOOLEAN,
  n_providers INTEGER,
  notes JSONB
);

-- 2) Reconcile a pre-existing (legacy) table — additive, idempotent. No-ops on a fresh table.
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS prompt_preview    TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS category          TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS static_provider   TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS static_tier       TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS static_reason     TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS anfis_provider    TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS anfis_tier        TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS anfis_conf        NUMERIC(5,4);
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS cost_usdc         NUMERIC(12,6);
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS cost_saved        NUMERIC(12,6);
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS latency_ms        INTEGER;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS success           BOOLEAN;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS verified_by       TEXT[];
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS request_text      TEXT;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS outcome_hal_score NUMERIC(5,4);
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS outcome_vetoed    BOOLEAN;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS n_providers       INTEGER;
ALTER TABLE anfis_routing_logs ADD COLUMN IF NOT EXISTS notes             JSONB;

-- 3) RLS service role only (internal sensitive routing decisions, no client read proven).
ALTER TABLE anfis_routing_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON anfis_routing_logs;
CREATE POLICY "service_role_all" ON anfis_routing_logs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ROLLBACK (per table, safe — drops only the columns this migration adds + the policy):
-- DROP POLICY IF EXISTS "service_role_all" ON anfis_routing_logs;
-- ALTER TABLE anfis_routing_logs
--   DROP COLUMN IF EXISTS prompt_preview, DROP COLUMN IF EXISTS category,
--   DROP COLUMN IF EXISTS static_provider, DROP COLUMN IF EXISTS static_tier, DROP COLUMN IF EXISTS static_reason,
--   DROP COLUMN IF EXISTS anfis_provider, DROP COLUMN IF EXISTS anfis_tier, DROP COLUMN IF EXISTS anfis_conf,
--   DROP COLUMN IF EXISTS cost_usdc, DROP COLUMN IF EXISTS outcome_hal_score, DROP COLUMN IF EXISTS outcome_vetoed,
--   DROP COLUMN IF EXISTS n_providers, DROP COLUMN IF EXISTS notes;
-- (cost_saved/latency_ms/success/verified_by/request_text predate this migration — do NOT drop on rollback.)

-- Post-apply verify:
-- SELECT column_name FROM information_schema.columns WHERE table_name='anfis_routing_logs' ORDER BY ordinal_position;
-- SELECT COUNT(*) FROM anfis_routing_logs WHERE anfis_provider IS NOT NULL; -- should grow once shadow traffic flows
-- SELECT * FROM pg_policies WHERE tablename = 'anfis_routing_logs';

COMMENT ON TABLE anfis_routing_logs IS 'Shadow logs for ANFIS vs static router decisions (A2). Ground truth outcomes for A3 measure (cost + HAL quality per cat). T12 feeds. Reversible shadow.';
