-- HAL PUBLIC FACT-CHECKS — source-tagged counter for public/eval/user fact-checks (CC 2026-07-20)
-- OUTPUT_PATH: migrations/2026-07-20-hal-public-fact-checks.sql
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD. R7: prod DDL is Sean-gated. This is a FILE ONLY.
-- Do NOT run against qnnpjhlxljtqyigedwkb until Sean co-signs.
-- ==========================================================================================
--
-- PURPOSE: `hal_classifications` (the internal production classifier's sink) stays PURE and
-- production-only per Sean's decision. This NEW, separately-tagged table accumulates the public
-- POST /api/v1/hal/evaluate fact-checks (and other eval/user surfaces) so that counter can grow
-- honestly and be blended with tunable weights LATER. The two counters are NEVER merged.
--
-- SCHEMA-FIRST (CLAUDE-RULE-5): column set is exactly the additive contract in the sprint —
-- id/source/verdict/hal_score/prompt_hash/created_at. Style follows
-- migrations/2026-07-05-anfis-decisioning-suggestions.sql (BIGSERIAL PK, TIMESTAMPTZ default now(),
-- RLS service_role_all, rollback + verify blocks).

-- 1) Table (fresh install — full target schema).
CREATE TABLE IF NOT EXISTS hal_public_fact_checks (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('eval', 'trustchat', 'aidebate', 'api')),
  verdict      TEXT,
  hal_score    NUMERIC,
  prompt_hash  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Read-path indexes (the public counter groups by source and reports last_updated).
CREATE INDEX IF NOT EXISTS idx_hal_public_fact_checks_source  ON hal_public_fact_checks (source);
CREATE INDEX IF NOT EXISTS idx_hal_public_fact_checks_created ON hal_public_fact_checks (created_at DESC);

-- 3) RLS — service role only (the engine writes via the service-role key; no client read/write
--    proven). Matches the 100%-RLS invariant (STATE_OF_THE_SYSTEM: all tables RLS-on).
ALTER TABLE hal_public_fact_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON hal_public_fact_checks;
CREATE POLICY "service_role_all" ON hal_public_fact_checks
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE hal_public_fact_checks IS
  'Source-tagged counter for PUBLIC/eval/user HAL fact-checks (POST /api/v1/hal/evaluate). SEPARATE from and never merged with hal_classifications (internal production classifier). Blendable with tunable weights later.';

-- ROLLBACK (safe):
-- DROP POLICY IF EXISTS "service_role_all" ON hal_public_fact_checks;
-- DROP TABLE IF EXISTS hal_public_fact_checks;

-- POST-APPLY VERIFY (run only after a Sean-gated apply):
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name='hal_public_fact_checks' ORDER BY ordinal_position;
-- SELECT conname FROM pg_constraint WHERE conrelid='hal_public_fact_checks'::regclass;
-- SELECT * FROM pg_policies WHERE tablename='hal_public_fact_checks';
