-- DISJOINTNESS VIOLATIONS LOG (Phase 1, CC 2026-07-05)
-- OUTPUT_PATH: migrations/2026-07-05-disjoint-violations.sql
-- SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7 (family-disjointness HARD RULE).
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD (R7, Sean-gated). FILE ONLY.
-- ==========================================================================================
--
-- PURPOSE: durable audit sink for §7 violations detected by src/decisioning/disjointness.ts
-- (the ViolationSink target). A violation = a judge/quorum sharing a model family with a routing
-- candidate it grades (self-grading). Written by assertDisjoint() via a wired DB sink; the code
-- default already logs LOUDLY to stderr (no silent swallow) even before this table is applied.

CREATE TABLE IF NOT EXISTS disjoint_violations (
  id                  BIGSERIAL PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared_families     TEXT[] NOT NULL,     -- the families that overlapped (the violation core)
  candidate_families  TEXT[] NOT NULL,
  judge_families      TEXT[] NOT NULL,
  context             TEXT,                -- e.g. request id / lane / quorum id
  reason              TEXT NOT NULL        -- human-readable glass-box reason
);

CREATE INDEX IF NOT EXISTS idx_disjoint_violations_created ON disjoint_violations (created_at DESC);

ALTER TABLE disjoint_violations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON disjoint_violations;
CREATE POLICY "service_role_all" ON disjoint_violations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE disjoint_violations IS
  '§7 family-disjointness violations (judge shares a model family with a candidate it grades = self-grading). Written by src/decisioning/disjointness.ts assertDisjoint sink. PROMOTION-GATED.';

-- ROLLBACK:
-- DROP POLICY IF EXISTS "service_role_all" ON disjoint_violations;
-- DROP TABLE IF EXISTS disjoint_violations;

-- POST-APPLY VERIFY:
-- SELECT count(*) FROM disjoint_violations;  -- 0 is healthy
-- SELECT * FROM pg_policies WHERE tablename='disjoint_violations';
