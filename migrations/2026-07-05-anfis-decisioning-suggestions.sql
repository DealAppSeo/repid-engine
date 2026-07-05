-- ANFIS DECISIONING — advisory `suggestions` table (Phase 1 CONTRACT FREEZE, CC 2026-07-05)
-- OUTPUT_PATH: migrations/2026-07-05-anfis-decisioning-suggestions.sql
-- SPEC: E:\dev\living-docs\03_specs\PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD. R7: prod DDL is Sean-gated. This is a FILE ONLY.
-- Do NOT run against qnnpjhlxljtqyigedwkb until Sean co-signs (autonomy ladder L0->L1).
-- ==========================================================================================
--
-- PURPOSE: the advisory-not-blocking sink (spec §2 ADOPT): the decisioning engine writes a
-- suggestion the consumer MAY read within a ~25ms budget, then falls back to static priority.
-- A row here NEVER routes traffic by itself — it is advisory. Live routing is a SEPARATE,
-- later, promotion-gated flip (spec §4 P2). This table is the durable form of decision-record.schema.json.
--
-- SCHEMA-FIRST (CLAUDE-RULE-5): column set derived from decision-record.schema.json, which is
-- itself derived from phase0-replay.csv (21 cols, read 2026-07-05) — NOT invented. anfis_tier
-- values ('0a','1','slm') and actual_status values ('success','failed','rate_limited') enumerated
-- from live telemetry 2026-07-05. Style follows migrations/2026-06-05-anfis-routing-logs.sql
-- (BIGSERIAL PK, TIMESTAMPTZ default now(), RLS service_role_all, rollback + verify blocks).

-- 1) Table (fresh install — full target schema).
CREATE TABLE IF NOT EXISTS anfis_decisioning_suggestions (
  id                        BIGSERIAL PRIMARY KEY,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- observed call linkage (decision-record: id / call_id)
  llm_call_id               UUID,            -- llm_call_log.id (uuid PK of the observed call)
  call_id                   UUID,            -- llm_call_log.call_id (business call id)

  -- attribution: which frozen param set produced this suggestion (params.schema.json params_version)
  params_version            TEXT,
  scalarization_profile     TEXT,            -- weight-vector.schema.json profile applied at decision time

  -- observed (actual) route
  provider_actual           TEXT,
  tier_actual               TEXT,
  model_actual              TEXT,

  -- ADVISORY suggestion (what ANFIS would recommend) — glass box
  anfis_provider            TEXT,
  anfis_tier                TEXT,            -- CHECK '0a' | '1' | 'slm'
  anfis_confidence          NUMERIC(5,4),    -- 0..1
  anfis_rule_weights        JSONB,           -- fired fuzzy-rule strengths (glass box)
  anfis_lasso_features      JSONB,           -- selected feature names (subset of len/low/cat/cost/rate/qual)

  -- predictions for the TAKEN route (moving-average). NULL = honest no-predictor skip (§7), NOT 0.
  pred_cost_usd             NUMERIC(18,10),
  pred_latency_ms           INTEGER,
  pred_quality              NUMERIC(5,4),

  -- observed outcomes
  actual_cost_usd           NUMERIC(18,10),
  actual_latency_ms         INTEGER,
  actual_status             TEXT,            -- CHECK 'success' | 'failed' | 'rate_limited'
  actual_quality            NUMERIC(5,4),

  -- prediction error (taken route only; NULL when pred is NULL — counterfactual-honest §7)
  prediction_error_cost     NUMERIC(18,10),
  prediction_error_latency  INTEGER,
  prediction_error_quality  NUMERIC(6,4),

  decision_wall_time_ms     NUMERIC(10,4),   -- advisory overhead (Phase-0 p95 0.0434ms)

  -- ADVISORY PURITY marker: pinned FALSE. TRUE would mean this suggestion actually routed traffic,
  -- which is a SEPARATE promotion-gated path (L2). At L0/L1 this is always FALSE by construction.
  routed_live               BOOLEAN NOT NULL DEFAULT FALSE,

  notes                     JSONB
);

-- 2) Value-domain guards (match the enumerated telemetry + AnfisRouterOutput).
--    Split out so a legacy/pre-existing table reconciles idempotently.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anfis_sugg_tier_chk') THEN
    ALTER TABLE anfis_decisioning_suggestions
      ADD CONSTRAINT anfis_sugg_tier_chk CHECK (anfis_tier IS NULL OR anfis_tier IN ('0a','1','slm'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anfis_sugg_status_chk') THEN
    ALTER TABLE anfis_decisioning_suggestions
      ADD CONSTRAINT anfis_sugg_status_chk CHECK (actual_status IS NULL OR actual_status IN ('success','failed','rate_limited'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anfis_sugg_advisory_purity_chk') THEN
    -- ADVISORY PURITY at L0/L1: routed_live must be FALSE. The promotion flip (L2) drops this constraint
    -- in its OWN Sean-gated migration; it is NOT relaxed here.
    ALTER TABLE anfis_decisioning_suggestions
      ADD CONSTRAINT anfis_sugg_advisory_purity_chk CHECK (routed_live = FALSE);
  END IF;
END $$;

-- 3) Read path index (consumer reads latest suggestion for a call within its 25ms budget).
CREATE INDEX IF NOT EXISTS idx_anfis_sugg_call_id   ON anfis_decisioning_suggestions (call_id);
CREATE INDEX IF NOT EXISTS idx_anfis_sugg_created   ON anfis_decisioning_suggestions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anfis_sugg_params    ON anfis_decisioning_suggestions (params_version);

-- 4) RLS — service role only (internal advisory routing decisions; no client read proven). Matches
--    anfis_routing_logs. 100%-RLS invariant (STATE_OF_THE_SYSTEM: all tables RLS-on).
ALTER TABLE anfis_decisioning_suggestions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON anfis_decisioning_suggestions;
CREATE POLICY "service_role_all" ON anfis_decisioning_suggestions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE anfis_decisioning_suggestions IS
  'ADVISORY (shadow) ANFIS routing suggestions — durable form of decision-record.schema.json. routed_live pinned FALSE at L0/L1 (advisory purity). Columns derived from phase0-replay.csv. PROMOTION-GATED; live routing is a separate Sean-gated flip.';

-- ROLLBACK (per table, safe):
-- DROP POLICY IF EXISTS "service_role_all" ON anfis_decisioning_suggestions;
-- DROP TABLE IF EXISTS anfis_decisioning_suggestions;

-- POST-APPLY VERIFY (run only after a Sean-gated apply):
-- SELECT column_name FROM information_schema.columns WHERE table_name='anfis_decisioning_suggestions' ORDER BY ordinal_position;
-- SELECT conname FROM pg_constraint WHERE conrelid='anfis_decisioning_suggestions'::regclass;
-- SELECT * FROM pg_policies WHERE tablename='anfis_decisioning_suggestions';
