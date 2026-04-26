-- ============================================================================
-- ANFIS-Ikigai Scoring Engine v0 — Schema
--
-- Sprint: feat/anfis-ikigai-scorer-v0  (P-014 reduction-to-practice foundation)
-- Six tables back the Sugeno-style fuzzy scoring engine that routes attention
-- by declared-purpose alignment instead of engagement maximisation.
--
-- All tables use IF NOT EXISTS so the migration is safely re-runnable. None
-- of the existing repid_*, hal_*, hyperdag_*, or trinity_* tables are touched.
--
-- See docs/ANFIS-IKIGAI-V0.md for the architectural overview and
-- docs/P-014-REDUCTION-TO-PRACTICE.md for the patent-relevant context.
-- ============================================================================

-- 1. ikigai_profiles ---------------------------------------------------------
-- The user's declared purpose, encoded as four ikigai dimensions. Each
-- dimension is a JSONB blob holding keywords, learnable LASSO feature
-- weights, and the membership-function parameters used at scoring time.
CREATE TABLE IF NOT EXISTS ikigai_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  profile_version INTEGER NOT NULL DEFAULT 1,
  love_dimension         JSONB NOT NULL DEFAULT '{}'::jsonb,
  good_at_dimension      JSONB NOT NULL DEFAULT '{}'::jsonb,
  world_needs_dimension  JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_for_dimension     JSONB NOT NULL DEFAULT '{}'::jsonb,
  declared_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active           BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_ikigai_profiles_user_active
  ON ikigai_profiles(user_id, active, profile_version DESC);

-- 2. attention_signals -------------------------------------------------------
-- Anything the engine might surface to the user: a parked idea, a tweet, a
-- query the user issued before, an item Trinity flagged. Source-agnostic on
-- purpose so future ingestors plug in without schema changes.
CREATE TABLE IF NOT EXISTS attention_signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type       TEXT NOT NULL,                   -- parking_lot | query_history | curated_x | internal_trinity | manual
  source_id         TEXT,
  content           TEXT NOT NULL,
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at TIMESTAMPTZ,
  dismissed         BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_attention_signals_lookup
  ON attention_signals(source_type, dismissed, created_at DESC);

-- 3. anfis_score_events ------------------------------------------------------
-- Append-only audit log of every scoring decision. rule_trace makes the
-- decision auditable; audit_chain_hash leaves a slot for HyperDAG anchoring.
CREATE TABLE IF NOT EXISTS anfis_score_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id             UUID NOT NULL REFERENCES attention_signals(id) ON DELETE CASCADE,
  profile_id            UUID NOT NULL REFERENCES ikigai_profiles(id)   ON DELETE CASCADE,
  love_alignment        NUMERIC(5,4) NOT NULL,
  good_at_alignment     NUMERIC(5,4) NOT NULL,
  world_needs_alignment NUMERIC(5,4) NOT NULL,
  paid_for_alignment    NUMERIC(5,4) NOT NULL,
  composite_score       NUMERIC(5,4) NOT NULL,
  anticipatory_delta    NUMERIC(5,4) NOT NULL DEFAULT 0,
  rule_trace            JSONB NOT NULL DEFAULT '[]'::jsonb,
  latency_ms            INTEGER NOT NULL DEFAULT 0,
  lasso_features_used   JSONB NOT NULL DEFAULT '[]'::jsonb,
  audit_chain_hash      TEXT,
  scored_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anfis_score_events_signal
  ON anfis_score_events(signal_id, scored_at DESC);

-- Partial index — only rows that pass the surfacing threshold (0.6). The
-- nightly digest reads this index, so it stays small even after months of
-- low-score events accumulate.
CREATE INDEX IF NOT EXISTS idx_anfis_score_events_surfaced
  ON anfis_score_events(composite_score DESC)
  WHERE composite_score >= 0.6;

-- 4. anfis_rule_base ---------------------------------------------------------
-- The Sugeno rule base. Rule weights are tunable by LASSO in v1. v0 keeps
-- weight=1.0 on every rule and lets the rule definitions themselves carry
-- the priority structure.
CREATE TABLE IF NOT EXISTS anfis_rule_base (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_text   TEXT NOT NULL,
  rule_json   JSONB NOT NULL,
  weight      NUMERIC(5,4) NOT NULL DEFAULT 1.0000,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anfis_rule_base_active
  ON anfis_rule_base(active);

-- 5. user_feedback_events ----------------------------------------------------
-- The labelled-data pipeline that v1 LASSO/PPO will train on. v0 only logs.
CREATE TABLE IF NOT EXISTS user_feedback_events (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id                 UUID NOT NULL REFERENCES attention_signals(id) ON DELETE CASCADE,
  feedback_type             TEXT NOT NULL,            -- surfaced_and_acted | surfaced_and_dismissed | should_have_surfaced | should_not_have_surfaced
  notes                     TEXT,
  reweight_target_dimension TEXT,                     -- love | good_at | world_needs | paid_for | NULL
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_events_signal
  ON user_feedback_events(signal_id, created_at DESC);

-- 6. lasso_feature_weights ---------------------------------------------------
-- Per-profile feature weight table that the LASSO-inspired pruner reads from.
-- v0 starts uniform (1/N for N features). v1 swaps in gradient updates from
-- user_feedback_events.
CREATE TABLE IF NOT EXISTS lasso_feature_weights (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    UUID NOT NULL REFERENCES ikigai_profiles(id) ON DELETE CASCADE,
  feature_name  TEXT NOT NULL,
  weight        NUMERIC(7,5) NOT NULL DEFAULT 0.00000,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, feature_name)
);

CREATE INDEX IF NOT EXISTS idx_lasso_feature_weights_profile
  ON lasso_feature_weights(profile_id, weight DESC);
