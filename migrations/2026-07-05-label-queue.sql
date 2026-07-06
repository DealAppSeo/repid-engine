-- DECISIONING — verification-floor LABEL QUEUE (Phase 2, CC 2026-07-05)
-- OUTPUT_PATH: migrations/2026-07-05-label-queue.sql
-- SPEC: E:\dev\living-docs\03_specs\PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD. R7: prod DDL is Sean-gated. This is a FILE ONLY.
-- Do NOT run against qnnpjhlxljtqyigedwkb until Sean co-signs (autonomy ladder L0->L1).
-- ==========================================================================================
--
-- PURPOSE: the durable sink for the UNIFORM-RANDOM VERIFICATION FLOOR (src/decisioning/verification-sampler.ts).
-- A completed llm_call_log call selected by the sampler (inclusion = hash(seed, call_id) < rate) is queued
-- here for later family-disjoint jury labeling. A row here is ADVISORY: it marks a call for labeling; it
-- NEVER routes traffic and NEVER mutates a RepID score. The quality LABEL (jury verdict) is written back
-- once the disjoint jury runs (§7: quality-only label; cost+latency stay decision-time weights, not labels).
--
-- SCHEMA-FIRST (CLAUDE-RULE-5): llm_call_log columns verified live [V qnnpjhlxljtqyigedwkb 2026-07-05]:
--   id uuid, call_id uuid, provider text, tier text, model text, status text
--   (status domain enumerated live: 'success' 157025 / 'failed' 163708 / 'rate_limited' 2480).
-- Style follows migrations/2026-07-05-anfis-decisioning-suggestions.sql (BIGSERIAL PK, TIMESTAMPTZ now(),
-- RLS service_role_all, rollback + verify blocks).

-- 1) Table.
CREATE TABLE IF NOT EXISTS decisioning_label_queue (
  id                     BIGSERIAL PRIMARY KEY,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the sampled completed call (llm_call_log linkage)
  llm_call_id            UUID NOT NULL,          -- llm_call_log.id (uuid PK)
  call_id                UUID,                   -- llm_call_log.call_id (business id)
  provider_actual        TEXT,
  tier_actual            TEXT,
  model_actual           TEXT,
  call_status            TEXT,                   -- CHECK terminal status of the sampled call

  -- SAMPLER PROVENANCE (auditability): the exact (seed, rate) + inclusion score that admitted this row.
  -- Lets a reviewer reproduce the uniform-random decision and confirm it was NOT suspicion-coupled.
  sample_seed            TEXT NOT NULL,
  sample_rate            NUMERIC(6,5) NOT NULL,  -- e.g. 0.05000
  inclusion_score        NUMERIC(10,9),          -- hash(seed,id)/2^32 in [0,1); < sample_rate by construction

  -- WHY sampled — pinned to the anti-bias guarantee. 'verification_floor' = uniform-random floor.
  -- 'canary' = injected known-answer probe (see canary loader). NOT a suspicion reason (§7).
  sample_reason          TEXT NOT NULL DEFAULT 'verification_floor',

  -- LABELING lifecycle (filled by the disjoint jury, later)
  label_status           TEXT NOT NULL DEFAULT 'queued',  -- queued | labeling | labeled | skipped
  jury_models            JSONB,                  -- the family-disjoint judge set assembled (glass box)
  jury_families          JSONB,                  -- families of the judges (must exclude generating family)
  quality_label          NUMERIC(5,4),           -- jury verdict in [0,1] — the TRAINED label (§7 quality-only)
  labeled_at             TIMESTAMPTZ,

  -- ADVISORY PURITY marker: a label NEVER routes. Pinned FALSE; the promotion flip owns any change.
  routed_live            BOOLEAN NOT NULL DEFAULT FALSE,

  notes                  JSONB,

  -- one queue row per sampled call (idempotent re-runs of the sampler don't duplicate)
  CONSTRAINT decisioning_label_queue_call_uniq UNIQUE (llm_call_id)
);

-- 2) Value-domain guards.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dlq_call_status_chk') THEN
    ALTER TABLE decisioning_label_queue
      ADD CONSTRAINT dlq_call_status_chk CHECK (call_status IS NULL OR call_status IN ('success','failed','rate_limited'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dlq_label_status_chk') THEN
    ALTER TABLE decisioning_label_queue
      ADD CONSTRAINT dlq_label_status_chk CHECK (label_status IN ('queued','labeling','labeled','skipped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dlq_sample_reason_chk') THEN
    ALTER TABLE decisioning_label_queue
      ADD CONSTRAINT dlq_sample_reason_chk CHECK (sample_reason IN ('verification_floor','canary'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dlq_rate_range_chk') THEN
    ALTER TABLE decisioning_label_queue
      ADD CONSTRAINT dlq_rate_range_chk CHECK (sample_rate >= 0 AND sample_rate <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dlq_advisory_purity_chk') THEN
    -- ADVISORY PURITY: routed_live must be FALSE. Promotion flip (L2) drops this in its OWN migration.
    ALTER TABLE decisioning_label_queue
      ADD CONSTRAINT dlq_advisory_purity_chk CHECK (routed_live = FALSE);
  END IF;
END $$;

-- 3) Indexes.
CREATE INDEX IF NOT EXISTS idx_dlq_label_status ON decisioning_label_queue (label_status);
CREATE INDEX IF NOT EXISTS idx_dlq_created      ON decisioning_label_queue (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_reason       ON decisioning_label_queue (sample_reason);

-- 4) RLS — service role only (internal advisory labeling; no client read proven). 100%-RLS invariant.
ALTER TABLE decisioning_label_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON decisioning_label_queue;
CREATE POLICY "service_role_all" ON decisioning_label_queue
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE decisioning_label_queue IS
  'Uniform-random VERIFICATION FLOOR label queue (§7 anti-bias). Rows are sampled by hash(seed,call_id)<rate (NOT suspicion-coupled) and await a family-disjoint jury label. quality_label is the trained label (quality-only); cost+latency are NOT labels. routed_live pinned FALSE (advisory purity). PROMOTION-GATED.';

-- ROLLBACK (safe):
-- DROP POLICY IF EXISTS "service_role_all" ON decisioning_label_queue;
-- DROP TABLE IF EXISTS decisioning_label_queue;

-- POST-APPLY VERIFY (run only after a Sean-gated apply):
-- SELECT column_name FROM information_schema.columns WHERE table_name='decisioning_label_queue' ORDER BY ordinal_position;
-- SELECT conname FROM pg_constraint WHERE conrelid='decisioning_label_queue'::regclass;
-- SELECT * FROM pg_policies WHERE tablename='decisioning_label_queue';
