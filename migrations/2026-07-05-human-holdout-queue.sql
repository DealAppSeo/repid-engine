-- DECISIONING — HUMAN-HOLDOUT QUEUE (Goodhart tripwire) (Phase 2, CC 2026-07-05)
-- OUTPUT_PATH: migrations/2026-07-05-human-holdout-queue.sql
-- SPEC: E:\dev\living-docs\03_specs\PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD. R7: prod DDL is Sean-gated. This is a FILE ONLY.
-- Do NOT run against qnnpjhlxljtqyigedwkb until Sean co-signs (autonomy ladder L0->L1).
-- ==========================================================================================
--
-- PURPOSE: the Goodhart TRIPWIRE. A small uniform-random slice of sampled calls is diverted to HUMANS
-- and DELIBERATELY WITHHELD from the family-disjoint jury. Comparing the human label to what the jury
-- WOULD have produced (or to the trained model's prediction) detects the failure mode where the automated
-- label pipeline is optimized against itself and silently drifts from human ground truth ("when a measure
-- becomes a target it ceases to be a good measure"). Without a human holdout, jury-vs-jury agreement can
-- look perfect while both drift together (P-003 Pythagorean-Comma veto: high agreement can be coordinated
-- dissonance, not truth). This table is that independent human check.
--
-- RELATION TO decisioning_label_queue: the holdout is DISJOINT from the jury-labeled floor — a call is
-- EITHER jury-labeled (label queue) OR human-held-out (this table), never both, so the human label is an
-- untainted comparison set. Selection is uniform-random (same sampler family), NOT suspicion-coupled.
--
-- SCHEMA-FIRST (CLAUDE-RULE-5): llm_call_log linkage columns verified live [V qnnpjhlxljtqyigedwkb
-- 2026-07-05] (id uuid, call_id uuid, provider/tier/model text, status text). Style mirrors
-- migrations/2026-07-05-label-queue.sql.

-- 1) Table.
CREATE TABLE IF NOT EXISTS decisioning_human_holdout (
  id                     BIGSERIAL PRIMARY KEY,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the held-out completed call (llm_call_log linkage)
  llm_call_id            UUID NOT NULL,
  call_id                UUID,
  provider_actual        TEXT,
  tier_actual            TEXT,
  model_actual           TEXT,
  call_status            TEXT,                   -- CHECK terminal status

  -- SAMPLER PROVENANCE (auditability + reproducibility of the uniform-random holdout draw)
  sample_seed            TEXT NOT NULL,
  holdout_rate           NUMERIC(6,5) NOT NULL,  -- fraction diverted to humans (small, e.g. 0.01)
  inclusion_score        NUMERIC(10,9),

  -- HUMAN label lifecycle. The jury NEVER writes here (tripwire independence).
  human_status           TEXT NOT NULL DEFAULT 'awaiting_human',  -- awaiting_human | labeled | skipped
  human_label            NUMERIC(5,4),           -- human quality verdict in [0,1] — ground-truth comparator
  human_labeler          TEXT,                   -- who labeled (audit)
  human_labeled_at       TIMESTAMPTZ,

  -- DRIFT COMPARISON (filled when both a human label and the counterpart jury/model prediction exist).
  -- Stored for the drift report; NULL until both sides present (counterfactual-honest: no fabricated gap).
  jury_or_model_label    NUMERIC(5,4),
  label_gap              NUMERIC(6,4),           -- |human_label - jury_or_model_label|; the tripwire metric

  -- ADVISORY PURITY marker: a holdout row NEVER routes. Pinned FALSE.
  routed_live            BOOLEAN NOT NULL DEFAULT FALSE,

  notes                  JSONB,

  CONSTRAINT decisioning_human_holdout_call_uniq UNIQUE (llm_call_id)
);

-- 2) Value-domain guards.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dhh_call_status_chk') THEN
    ALTER TABLE decisioning_human_holdout
      ADD CONSTRAINT dhh_call_status_chk CHECK (call_status IS NULL OR call_status IN ('success','failed','rate_limited'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dhh_human_status_chk') THEN
    ALTER TABLE decisioning_human_holdout
      ADD CONSTRAINT dhh_human_status_chk CHECK (human_status IN ('awaiting_human','labeled','skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dhh_rate_range_chk') THEN
    ALTER TABLE decisioning_human_holdout
      ADD CONSTRAINT dhh_rate_range_chk CHECK (holdout_rate >= 0 AND holdout_rate <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dhh_advisory_purity_chk') THEN
    ALTER TABLE decisioning_human_holdout
      ADD CONSTRAINT dhh_advisory_purity_chk CHECK (routed_live = FALSE);
  END IF;
END $$;

-- 3) Indexes.
CREATE INDEX IF NOT EXISTS idx_dhh_human_status ON decisioning_human_holdout (human_status);
CREATE INDEX IF NOT EXISTS idx_dhh_created      ON decisioning_human_holdout (created_at DESC);

-- 4) RLS — service role only. 100%-RLS invariant. (A human-review UI would read via service_role/edge fn.)
ALTER TABLE decisioning_human_holdout ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON decisioning_human_holdout;
CREATE POLICY "service_role_all" ON decisioning_human_holdout
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE decisioning_human_holdout IS
  'Goodhart TRIPWIRE — uniform-random human holdout, DISJOINT from the jury-labeled floor and NEVER jury-written. human_label vs jury_or_model_label => label_gap detects label-pipeline drift from human ground truth. routed_live pinned FALSE (advisory purity). PROMOTION-GATED.';

-- ROLLBACK (safe):
-- DROP POLICY IF EXISTS "service_role_all" ON decisioning_human_holdout;
-- DROP TABLE IF EXISTS decisioning_human_holdout;

-- POST-APPLY VERIFY (run only after a Sean-gated apply):
-- SELECT column_name FROM information_schema.columns WHERE table_name='decisioning_human_holdout' ORDER BY ordinal_position;
-- SELECT conname FROM pg_constraint WHERE conrelid='decisioning_human_holdout'::regclass;
-- SELECT * FROM pg_policies WHERE tablename='decisioning_human_holdout';
