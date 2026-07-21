-- ANFIS POA FEED — per-(model, task_type) TRUST WEIGHT store (reward-model-as-router, SHADOW).
-- OUTPUT_PATH: migrations/2026-07-21-anfis-trust-weights.sql
-- MODULE: src/decisioning/anfis-poa-feed.ts (ingestPoaOutcome) · TESTS: tests/anfis-poa-feed.test.ts
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD. R7 / CLAUDE-RULE: prod DDL is Sean-gated. FILE ONLY.
-- Do NOT run against qnnpjhlxljtqyigedwkb until Sean co-signs. Branch-only artifact.
-- ==========================================================================================
--
-- PURPOSE: durable sink for the ANFIS reward-model FEED. Each row is the current EXPONENTIAL
-- MOVING AVERAGE of a proper-scoring (Brier) reward over POA outcomes for one (model, task_type):
-- correct+confident answers push trust_weight UP, confident-wrong answers push it DOWN. This is
-- the reward-model-as-router: RepID outcomes decide which model to trust for which task.
--
-- SHADOW / ADVISORY PURITY: nothing in the live routing path READS this table, so writing it
-- changes ZERO routing/RepID/HAL/on-chain behavior. `routed_live` is pinned FALSE by a CHECK
-- constraint (same discipline as anfis_decisioning_suggestions); a future Sean-gated promotion
-- migration drops that constraint when the weight actually steers traffic.
--
-- SCHEMA-FIRST (CLAUDE-RULE-5): columns derived from the PoaOutcome/PoaIngestResult shapes in
-- src/decisioning/anfis-poa-feed.ts. Style follows migrations/2026-07-05-anfis-decisioning-suggestions.sql
-- (BIGSERIAL PK, TIMESTAMPTZ default now(), unique key, RLS service_role_all, rollback + verify blocks).

-- 1) Table (fresh install — full target schema).
CREATE TABLE IF NOT EXISTS anfis_trust_weights (
  id                 BIGSERIAL PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- trust-weight key
  model              TEXT NOT NULL,
  task_type          TEXT NOT NULL,
  family             TEXT,               -- model family (llama/gemini/…) for family-level rollups

  -- the learned signal
  trust_weight       NUMERIC(6,5) NOT NULL,   -- EMA of the proper-scoring reward, [0..1]
  ema_alpha          NUMERIC(5,4),            -- responsiveness used for this row's update
  sample_count       INTEGER NOT NULL DEFAULT 0,
  cumulative_reward  NUMERIC(18,6),           -- running sum of rewards (for avg-reward audits)

  -- last observed outcome (audit / glass box)
  last_reward        NUMERIC(6,5),
  last_confidence    NUMERIC(6,5),
  last_correct       BOOLEAN,
  last_repid_delta   NUMERIC(12,4),
  last_agent         TEXT,
  last_role          TEXT,

  -- ADVISORY PURITY marker: pinned FALSE. TRUE would mean this weight routed live traffic,
  -- which is a SEPARATE promotion-gated path. At shadow this is always FALSE by construction.
  routed_live        BOOLEAN NOT NULL DEFAULT FALSE,

  notes              JSONB,

  UNIQUE (model, task_type)               -- read-modify-write upsert key (onConflict: 'model,task_type')
);

-- 2) Reconcile a pre-existing table — additive, idempotent (no-ops on a fresh table).
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS family            TEXT;
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS ema_alpha         NUMERIC(5,4);
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS sample_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS cumulative_reward NUMERIC(18,6);
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS last_reward       NUMERIC(6,5);
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS last_confidence   NUMERIC(6,5);
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS last_correct      BOOLEAN;
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS last_repid_delta  NUMERIC(12,4);
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS last_agent        TEXT;
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS last_role         TEXT;
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS routed_live       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE anfis_trust_weights ADD COLUMN IF NOT EXISTS notes             JSONB;

-- 3) Advisory-purity guard: routed_live must be FALSE at shadow. The promotion flip drops this in
--    its OWN Sean-gated migration; it is NOT relaxed here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anfis_trust_weights_advisory_purity_chk') THEN
    ALTER TABLE anfis_trust_weights
      ADD CONSTRAINT anfis_trust_weights_advisory_purity_chk CHECK (routed_live = FALSE);
  END IF;
END $$;

-- 4) Indexes: the upsert key is covered by the UNIQUE(model, task_type); add a family rollup path.
CREATE INDEX IF NOT EXISTS idx_anfis_trust_weights_family     ON anfis_trust_weights (family);
CREATE INDEX IF NOT EXISTS idx_anfis_trust_weights_task_type  ON anfis_trust_weights (task_type);

-- 5) RLS — service role only (internal advisory routing signal; no client read). Matches
--    anfis_routing_logs / anfis_decisioning_suggestions. 100%-RLS invariant.
ALTER TABLE anfis_trust_weights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON anfis_trust_weights;
CREATE POLICY "service_role_all" ON anfis_trust_weights
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE anfis_trust_weights IS
  'ANFIS reward-model FEED: per-(model,task_type) EMA of a proper-scoring (Brier) reward over POA outcomes. Reward-model-as-router (SHADOW). routed_live pinned FALSE (advisory purity). Written by src/decisioning/anfis-poa-feed.ts. PROMOTION-GATED; live routing is a separate Sean-gated flip.';

-- ROLLBACK (per table, safe):
-- DROP POLICY IF EXISTS "service_role_all" ON anfis_trust_weights;
-- DROP TABLE IF EXISTS anfis_trust_weights;

-- POST-APPLY VERIFY (run only after a Sean-gated apply):
-- SELECT column_name FROM information_schema.columns WHERE table_name='anfis_trust_weights' ORDER BY ordinal_position;
-- SELECT conname FROM pg_constraint WHERE conrelid='anfis_trust_weights'::regclass;
-- SELECT * FROM pg_policies WHERE tablename='anfis_trust_weights';
-- SELECT model, task_type, trust_weight, sample_count FROM anfis_trust_weights ORDER BY updated_at DESC LIMIT 20;
