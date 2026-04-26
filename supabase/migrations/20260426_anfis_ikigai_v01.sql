-- ============================================================================
-- ANFIS-Ikigai v0.1 — Adversarial Harmonic Filter + Federated Prep
--
-- Sprint: feat/anfis-ikigai-v0.1-adversarial-harmonic.
-- Strictly additive — no destructive changes to v0 tables. Each new table
-- references anfis_score_events(id) so v0 score-event lookups stay the
-- single source of truth and the v0.1 enrichments are an audit overlay.
--
-- See docs/ANFIS-IKIGAI.md for the consolidated architecture and
-- docs/P-014-REDUCTION-TO-PRACTICE.md §§ harmonic / antagonist / SBFA /
-- federated for the patent claims this schema embodies.
-- ============================================================================

-- 1. anfis_perspective_scores -----------------------------------------------
-- Per-perspective LLM scoring records (the SBFA aggregator's row store).
-- Five rows per v0.1-full evaluation by default — one per perspective_role.
CREATE TABLE IF NOT EXISTS anfis_perspective_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_event_id  UUID NOT NULL REFERENCES anfis_score_events(id) ON DELETE CASCADE,
  perspective_role TEXT NOT NULL,                  -- protagonist | antagonist | naive_user | long_term_self | mission_aligned_peer
  model_used       TEXT NOT NULL,
  composite_score  NUMERIC(5,4) NOT NULL,
  rationale        TEXT,
  latency_ms       INTEGER NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(10,8) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anfis_perspective_scores_lookup
  ON anfis_perspective_scores(score_event_id, perspective_role);

-- 2. anfis_harmonic_alignment ------------------------------------------------
-- Circle-of-Fifths-style adjacent-pair distances + aggregate resonance.
-- pythagorean_comma_multiplier defaults to the same constant the HAL v1
-- formula uses (531441/524288), giving the architecture a single shared
-- dissonance amplifier across both layers.
CREATE TABLE IF NOT EXISTS anfis_harmonic_alignment (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_event_id              UUID NOT NULL REFERENCES anfis_score_events(id) ON DELETE CASCADE,
  love_good_at_distance       NUMERIC(5,4) NOT NULL,
  good_at_world_needs_distance NUMERIC(5,4) NOT NULL,
  world_needs_paid_for_distance NUMERIC(5,4) NOT NULL,
  paid_for_love_distance      NUMERIC(5,4) NOT NULL,
  resonance_score             NUMERIC(5,4) NOT NULL,
  dissonance_flag             BOOLEAN NOT NULL DEFAULT FALSE,
  pythagorean_comma_multiplier NUMERIC(8,7) NOT NULL DEFAULT 1.0136433,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anfis_harmonic_lookup
  ON anfis_harmonic_alignment(score_event_id, dissonance_flag);

-- 3. anfis_antagonist_evaluations -------------------------------------------
-- Structured devil's-advocate path. Distinct from perspective_scores because
-- the antagonist gets a structured argument + counter-evidence keyword list
-- and an explicit veto math output, not just a number.
CREATE TABLE IF NOT EXISTS anfis_antagonist_evaluations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_event_id           UUID NOT NULL REFERENCES anfis_score_events(id) ON DELETE CASCADE,
  argument_against         TEXT NOT NULL,
  counter_evidence_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  antagonist_score         NUMERIC(5,4) NOT NULL,
  protagonist_score        NUMERIC(5,4) NOT NULL,
  net_score                NUMERIC(5,4) NOT NULL,
  veto_triggered           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anfis_antagonist_lookup
  ON anfis_antagonist_evaluations(score_event_id, veto_triggered);

-- 4. anfis_federated_observations -------------------------------------------
-- Schema-only for v0.1 — actual cross-user sharing is a v1 decision Sean
-- still has to make. Every row defaults to share_consent=false; rows can be
-- inspected, summarised, and (later) exported only after explicit opt-in.
--
-- observation_payload MUST be a structured pattern, never raw signal text.
-- See docs/ANFIS-FEDERATED-LEARNING-V0-PREP.md for the threat model.
CREATE TABLE IF NOT EXISTS anfis_federated_observations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          UUID,                       -- nullable: anonymised aggregations don't need it
  pattern_type        TEXT NOT NULL,              -- rule_firing_distribution | antagonist_correction_rate | harmonic_dissonance_correlation | feature_weight_drift
  observation_payload JSONB NOT NULL,
  hash_of_inputs      TEXT,
  share_consent       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anfis_federated_obs_lookup
  ON anfis_federated_observations(pattern_type, share_consent, created_at DESC);

-- 5. anfis_circle_of_fifths_config -------------------------------------------
-- Singleton config row. Lets the dimension order, perfect-fifth ratio,
-- and dissonance threshold be tuned without another migration.
CREATE TABLE IF NOT EXISTS anfis_circle_of_fifths_config (
  id                       INTEGER PRIMARY KEY DEFAULT 1,
  dimension_order          TEXT[] NOT NULL,
  perfect_fifth_ratio      NUMERIC(8,7) NOT NULL,
  pythagorean_comma_value  NUMERIC(8,7) NOT NULL,
  dissonance_threshold     NUMERIC(5,4) NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);

INSERT INTO anfis_circle_of_fifths_config (
  id, dimension_order, perfect_fifth_ratio, pythagorean_comma_value, dissonance_threshold
)
SELECT
  1,
  ARRAY['love', 'good_at', 'world_needs', 'paid_for'],
  1.5000000,    -- musical perfect fifth = 3:2
  1.0136433,    -- Pythagorean comma = 531441/524288 (same constant HAL v1 uses)
  0.0136        -- comma - 1, matching HAL veto math
WHERE NOT EXISTS (SELECT 1 FROM anfis_circle_of_fifths_config WHERE id = 1);
