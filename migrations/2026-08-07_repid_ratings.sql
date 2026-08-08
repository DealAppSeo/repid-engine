-- migrations/2026-08-07_repid_ratings.sql
--
-- TrustMarket rating ingestion — schema for the two tables the ratings API uses.
-- NOT auto-applied. Schema in this project is managed externally; applying this to
-- prod is a Sean-gated action (CLAUDE-RULE: schema-first prod SQL, log all DDL).
-- Until applied, GET /ratings/:agentId returns an empty summary and POST /ratings
-- fails closed (outcome lookups return not-found), which is safe, never a false accept.
--
-- Review notes:
--   * repid_ratings is the append-only rating log.
--   * repid_outcomes is the SERVER-side source of truth the API looks up to decide
--     admissibility (gate decision + committed fold root + counterparty). A rating
--     can only anchor to a row here — that is what makes ratings un-gameable.
--   * The UNIQUE index enforces one rating per (rater, outcome, stage): no ballot-stuffing.

-- ── outcomes the server holds (written at settlement time) ──────────────────────
-- If an equivalent record already exists elsewhere (e.g. repid_score_events with the
-- gate decision + fold root in metadata), point lookupOutcome() at that instead of
-- creating this table. This is the minimal shape the admission logic needs.
CREATE TABLE IF NOT EXISTS repid_outcomes (
  id             text PRIMARY KEY,
  agent_id       text NOT NULL,
  gate_decision  text NOT NULL CHECK (gate_decision IN ('ALLOW', 'REFUSE')),
  fold_root      bigint NOT NULL,
  counterparty_id text,
  value_at_risk  numeric,
  -- Genesis epoch policy (Sean, 2026-08-07): every outcome is permanently labeled so a
  -- bootstrap/dogfood score can never be laundered as organically-earned. Safe honest
  -- defaults — we are in the 'genesis' epoch and unproven rows are 'bootstrap'.
  --   epoch:      iam (identity, no score claim) | genesis (V1 cohort, disclosed) | earned (external)
  --   provenance: bootstrap (we generated it, dogfood) | external (a stranger did)
  epoch          text NOT NULL DEFAULT 'genesis' CHECK (epoch IN ('iam', 'genesis', 'earned')),
  provenance     text NOT NULL DEFAULT 'bootstrap' CHECK (provenance IN ('bootstrap', 'external')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- No stake capital on Genesis scores (Sean, 2026-08-07): a bootstrap outcome must not
  -- carry real value-at-risk. Fail-closed at the DB, belt-and-suspenders to the app rule.
  CONSTRAINT chk_no_stake_on_bootstrap CHECK (
    provenance <> 'bootstrap' OR value_at_risk IS NULL OR value_at_risk = 0
  )
);
CREATE INDEX IF NOT EXISTS idx_repid_outcomes_agent ON repid_outcomes (agent_id);
CREATE INDEX IF NOT EXISTS idx_repid_outcomes_epoch ON repid_outcomes (epoch, provenance);

-- ── the ratings themselves ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repid_ratings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_agent_id text NOT NULL,
  rater_id         text NOT NULL,
  stage            text NOT NULL CHECK (stage IN ('settled', 'to_spec', 'retained')),
  verdict          text NOT NULL CHECK (verdict IN ('good', 'ok', 'bad')),
  outcome_id       text NOT NULL REFERENCES repid_outcomes (id),
  fold_root        bigint NOT NULL,
  -- Same Genesis labels as repid_outcomes: a rating cast during bootstrap/genesis is
  -- permanently marked so it is never silently counted as an organically-earned signal.
  epoch            text NOT NULL DEFAULT 'genesis' CHECK (epoch IN ('iam', 'genesis', 'earned')),
  provenance       text NOT NULL DEFAULT 'bootstrap' CHECK (provenance IN ('bootstrap', 'external')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One rating per rater, per outcome, per stage. The API relies on the resulting
-- 23505 to return 409 duplicate_rating rather than double-counting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repid_ratings_rater_outcome_stage
  ON repid_ratings (rater_id, outcome_id, stage);

CREATE INDEX IF NOT EXISTS idx_repid_ratings_subject ON repid_ratings (subject_agent_id);

-- A rater must not rate their own agent. Enforced in the API (self_rating), and
-- belt-and-suspenders here so a direct writer cannot bypass it:
ALTER TABLE repid_ratings
  ADD CONSTRAINT chk_no_self_rating CHECK (rater_id <> subject_agent_id);
