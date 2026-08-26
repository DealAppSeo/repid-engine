-- ============================================================================
-- repid_score_events — sufficient-statistic columns for Phase 0 of the
-- posterior (Beta-Binomial) shadow-scoring proposal.
--
-- STATUS: WRITTEN, NOT APPLIED. This branch was authored inside the cloud
-- build loop's GitHub Actions runner, which has no Supabase credentials and
-- no route to qnnpjhlxljtqyigedwkb (confirmed 2026-08-26, Beat 63 of
-- reports/2026-07-25/AUTONOMOUS_LOOP_LEDGER.md, and re-confirmed this beat —
-- checking for a live-DB proxy would repeat that exact mistake). Every prior
-- migration in this directory that reached STATUS: APPLIED did so by running
-- read-only verification queries against the live catalog first (see e.g.
-- 2026-08-17-issuer-identity-and-verdict-evidence.sql, 2026-08-11-score-events-
-- counterparty.sql). This file has NOT had that verification and must not be
-- treated as equivalent to one that has. Apply only from a session with a live
-- Supabase connection, after re-running the verification queries at the foot
-- of this file.
-- ============================================================================
--
-- WHY THIS IS SAFE TO WRITE BLIND, WHEN OTHER MIGRATIONS ARE NOT.
--
-- Every column below is a bare `ADD COLUMN IF NOT EXISTS`, nullable, no
-- DEFAULT, added to a table this migration does not otherwise touch. Unlike
-- 2026-08-03-repid-score-events-range-check.sql — which had to survive
-- whatever the existing 152k+ rows already contained — a brand-new nullable
-- column starts NULL on every existing row by construction; there is no
-- existing value for it to conflict with. The CHECK constraints added below
-- are scoped to `col IS NULL OR <condition>` for the same reason: on the day
-- this migration runs, every one of those columns is NULL on 100% of rows, so
-- validation is instantaneous and cannot fail, regardless of what the rest of
-- the table holds. That is what makes it safe to draft without the live read
-- this repo's own convention otherwise requires before writing DDL.
--
-- WHAT THIS ANSWERS: docs/HANDOFF-2026-08-22.md §5 ("Schema to lock now"),
-- written by the session that designed the Beta-Binomial evolution of RepID
-- scoring. Its §6 rollout plan calls Phase 0 ("land the columns, write
-- shadow-only posterior rows through the existing shadow-scoring.ts, no
-- behaviour change") "the item with... the cheapest" schema change and the
-- prerequisite for everything after it. That handoff's own "Next Claude"
-- instruction named this as the first thing to do; the 15 PRs merged between
-- 2026-08-22 and this beat (#463-#477) did not touch it — this migration is
-- that instruction's first concrete step, not a restatement of it.
--
-- WHAT THIS DOES NOT DO. It does not write a single row, does not touch
-- `shadow-scoring.ts` or `policy-version.ts`, and does not implement the
-- weighting or decay functions §4 of the handoff spends four sections arguing
-- about. Those need the design review (and, per §7, Sean's adoption call on
-- the posterior evolution itself) that a schema-only, reversible, zero-write
-- migration does not. Landing the columns without landing the formula is
-- deliberate: it lets a shadow writer exist later without a second migration,
-- while carrying zero of the actual scoring-policy risk this beat is not
-- positioned to review alone (LESSON: "a claim needs the capability that
-- produces it" — this runner can verify a `tsc`/`jest` pass, not a live
-- catalog read, so it does only the part that needs the former).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- MAPPING FROM HANDOFF §5 TO COLUMNS BELOW
-- ─────────────────────────────────────────────────────────────────────────────
--
--   "evidence_weight (numeric) on the event"        -> evidence_weight
--   "run_state_at_event -> pre/post sufficient
--    statistics (alpha, beta) ... plus the weight
--    applied" (the weight IS evidence_weight,        -> pre_posterior_alpha,
--    not duplicated in a second column)                 pre_posterior_beta,
--                                                        post_posterior_alpha,
--                                                        post_posterior_beta
--   "Raw n alongside weighted counts"                -> raw_n_increment
--   "Prior parameters recorded per event"            -> prior_alpha, prior_beta
--   "impact_mode"                                    -> impact_mode
--   "Severity inputs, not only the severity output"  -> severity_inputs
--
--   "domain_id separate from human label" is DELIBERATELY NOT in this file.
--   `repid_score_events.task_domain` (text, already live — see
--   src/providers/router.ts:337-338 and src/scoring/task-purpose.ts) is the
--   human label the handoff means. Giving it a stable identity is a registry
--   decision (a lookup table + a migration path for relabeling), not a column
--   addition, and inventing that registry unilaterally inside a schema-lock
--   migration would be exactly the kind of adjacent-scope drift CLAUDE-RULE-3
--   rules out. Left open, named explicitly so it is not silently dropped.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. evidence_weight — w_i. Separate from severity: severity says how bad an
--    outcome was, evidence_weight says how much this ONE event should move a
--    posterior relative to others. Without it, a trivial ping and a large
--    settlement are indistinguishable pseudo-counts (the dilution attack
--    HANDOFF §4 names). Non-negative; a negative weight would mean "this event
--    un-happens", which is not a concept this ledger has.
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS evidence_weight numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_evidence_weight_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_evidence_weight_chk
      CHECK (evidence_weight IS NULL OR evidence_weight >= 0);
  END IF;
END $$;

COMMENT ON COLUMN repid_score_events.evidence_weight IS
  'w_i for a value-weighted Beta-Binomial update (see docs/HANDOFF-2026-08-22.md '
  'S4). Separate from severity: this is HOW MUCH the event counts, not how BAD '
  'it was. NULL means not recorded -- true for every row until a posterior '
  'writer exists. Never negative.';

-- ---------------------------------------------------------------------------
-- 2. raw_n_increment -- the un-weighted count. HANDOFF S4's "two statistics,
--    not one": value-weighted evidence drives the posterior mean (resists
--    dilution), but a posterior fit on one large interaction must not report
--    the same confidence as one fit on a hundred small ones -- that needs raw
--    n, tracked independently of weight. Almost always 1 per row; kept as an
--    integer rather than assumed, because at least one existing writer
--    (2026-08-11-score-events-counterparty.sql, the shared-contract backfill)
--    already collapses what were multiple real interactions into fewer rows,
--    so "count the rows" is not always the same number as "count the
--    observations".
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS raw_n_increment integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_raw_n_increment_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_raw_n_increment_chk
      CHECK (raw_n_increment IS NULL OR raw_n_increment >= 0);
  END IF;
END $$;

COMMENT ON COLUMN repid_score_events.raw_n_increment IS
  'Un-weighted observation count this row contributes to a posterior fit -- '
  'the confidence-gate statistic, kept apart from evidence_weight so dilution '
  'resistance (weighted) and confidence inflation (raw n) cannot be conflated '
  'into one number. NULL means not recorded. Usually 1; not assumed to be, '
  'because some rows already aggregate more than one real observation.';

-- ---------------------------------------------------------------------------
-- 3. prior_alpha / prior_beta -- the (alpha0, beta0) in force for this
--    agent+domain at write time. HANDOFF S4 calls the prior "an unaudited
--    policy lever with enormous reach" and S6 requires it be reconstructible
--    per row, not read off whatever the current policy default happens to be
--    -- a prior that can only be read from "whatever the code says today" is
--    unrecoverable the moment the code changes. Beta parameters are strictly
--    positive by definition.
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS prior_alpha numeric,
  ADD COLUMN IF NOT EXISTS prior_beta  numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_prior_alpha_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_prior_alpha_chk
      CHECK (prior_alpha IS NULL OR prior_alpha > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_prior_beta_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_prior_beta_chk
      CHECK (prior_beta IS NULL OR prior_beta > 0);
  END IF;
END $$;

COMMENT ON COLUMN repid_score_events.prior_alpha IS
  'Beta prior alpha0 in force for this agent+domain at write time. Recorded '
  'per event, not read from current policy defaults, because the prior is a '
  'policy lever that can move (see docs/HANDOFF-2026-08-22.md S4 item 5) and a '
  'ledger of point values cannot answer "what prior produced this posterior" '
  'after it does. NULL means not recorded. Strictly positive when set.';

COMMENT ON COLUMN repid_score_events.prior_beta IS
  'Beta prior beta0. See prior_alpha -- always set or unset together.';

-- ---------------------------------------------------------------------------
-- 4. pre_posterior_{alpha,beta} / post_posterior_{alpha,beta} -- the running
--    posterior immediately before and after this event. This is the
--    "run_state_at_event" HANDOFF S5 calls "highest value on this list and
--    the cheapest": a posterior cannot be reconstructed from a ledger of point
--    estimates, only from a chain of sufficient statistics. The weight this
--    event applied is evidence_weight above, deliberately not duplicated
--    here.
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS pre_posterior_alpha  numeric,
  ADD COLUMN IF NOT EXISTS pre_posterior_beta   numeric,
  ADD COLUMN IF NOT EXISTS post_posterior_alpha numeric,
  ADD COLUMN IF NOT EXISTS post_posterior_beta  numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_pre_posterior_alpha_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_pre_posterior_alpha_chk
      CHECK (pre_posterior_alpha IS NULL OR pre_posterior_alpha > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_pre_posterior_beta_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_pre_posterior_beta_chk
      CHECK (pre_posterior_beta IS NULL OR pre_posterior_beta > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_post_posterior_alpha_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_post_posterior_alpha_chk
      CHECK (post_posterior_alpha IS NULL OR post_posterior_alpha > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_post_posterior_beta_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_post_posterior_beta_chk
      CHECK (post_posterior_beta IS NULL OR post_posterior_beta > 0);
  END IF;
END $$;

COMMENT ON COLUMN repid_score_events.pre_posterior_alpha IS
  'Running Beta posterior alpha for this agent+domain immediately BEFORE this '
  'event was applied (pre-update sufficient statistic). Together with '
  'post_posterior_alpha/beta this makes the posterior chain reconstructible '
  'row-by-row without replaying the whole ledger. NULL means not recorded.';

COMMENT ON COLUMN repid_score_events.pre_posterior_beta IS
  'Running Beta posterior beta immediately before this event. See pre_posterior_alpha.';

COMMENT ON COLUMN repid_score_events.post_posterior_alpha IS
  'Running Beta posterior alpha immediately AFTER this event was applied '
  '(post-update sufficient statistic). See pre_posterior_alpha.';

COMMENT ON COLUMN repid_score_events.post_posterior_beta IS
  'Running Beta posterior beta immediately after this event. See pre_posterior_alpha.';

-- ---------------------------------------------------------------------------
-- 5. impact_mode -- lets absolute and ratio impact coexist during shadow
--    comparison (HANDOFF S5). A closed vocabulary, not free text, and safe to
--    validate immediately (not NOT VALID) because the column is new and every
--    existing row is NULL, which the CHECK explicitly permits.
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS impact_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_impact_mode_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_impact_mode_chk
      CHECK (impact_mode IS NULL OR impact_mode IN ('absolute', 'ratio'));
  END IF;
END $$;

COMMENT ON COLUMN repid_score_events.impact_mode IS
  'Whether evidence_weight/severity for this row was computed as an absolute '
  'value or a ratio, so both can be shadow-compared without one silently '
  'being read as the other. NULL means not recorded. Closed vocabulary: '
  '''absolute'' | ''ratio''.';

-- ---------------------------------------------------------------------------
-- 6. severity_inputs -- the INPUTS to the severity computation, not only its
--    output. HANDOFF S5: "you cannot re-score history from an output." jsonb,
--    versioned by the writer (not by this migration, which defines no shape) --
--    the same posture 2026-08-11's `metadata.counterparty_source` provenance
--    marker takes: freeform now, interpreted by whoever writes it, because
--    inventing a rigid shape before a real writer exists would be locking in a
--    guess.
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS severity_inputs jsonb;

COMMENT ON COLUMN repid_score_events.severity_inputs IS
  'Raw inputs to this row''s severity computation (e.g. stake, novelty, '
  'confidence), not only the derived severity/delta -- lets history be '
  're-scored under a different severity function later. Shape is owned by the '
  'writer that populates it, not fixed by this migration. NULL means not '
  'recorded.';

COMMIT;

-- ============================================================================
-- BLAST RADIUS -- applying this while traffic is live.
--
-- LOCK: each ADD COLUMN / ADD CONSTRAINT takes ACCESS EXCLUSIVE on
-- repid_score_events, but every constraint here is scoped to a column that is
-- new in this same transaction and therefore NULL on all existing rows -- so,
-- unlike 2026-08-03-repid-score-events-range-check.sql, there is no seq scan
-- and no possibility of a 23514 on existing data. This is catalog-only work;
-- expected milliseconds regardless of row count.
-- BLOCKS: concurrent INSERT/UPDATE on repid_score_events queues behind that
-- momentary lock. A queue blip, not an outage.
-- WHAT BREAKS: nothing existing. No writer names these columns yet, so every
-- current INSERT continues to omit them and they land NULL, exactly as today.
-- IRREVERSIBILITY: none. Every column here is new and this migration writes
-- no row, so the rollback below is a complete, lossless revert.
-- ============================================================================

-- ============================================================================
-- VERIFICATION -- run these from a session with a live Supabase connection,
-- BEFORE applying (to confirm the columns do not already exist under a
-- different migration) and AFTER (to confirm the shape landed as written).
-- Read-only; safe to run at any time.
--
--   -- Before: expect 0 rows (nothing here should already exist).
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'repid_score_events'
--     AND column_name IN (
--       'evidence_weight', 'raw_n_increment', 'prior_alpha', 'prior_beta',
--       'pre_posterior_alpha', 'pre_posterior_beta',
--       'post_posterior_alpha', 'post_posterior_beta',
--       'impact_mode', 'severity_inputs'
--     );
--
--   -- After: expect all 10 columns, all nullable ('YES'), and (except
--   -- severity_inputs, which is jsonb) numeric/text/integer as written above.
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'repid_score_events'
--     AND column_name IN (
--       'evidence_weight', 'raw_n_increment', 'prior_alpha', 'prior_beta',
--       'pre_posterior_alpha', 'pre_posterior_beta',
--       'post_posterior_alpha', 'post_posterior_beta',
--       'impact_mode', 'severity_inputs'
--     )
--   ORDER BY column_name;
--
--   -- After: expect every one of these 10 columns to be 100% NULL, since no
--   -- writer populates them yet.
--   SELECT
--     count(*) FILTER (WHERE evidence_weight       IS NOT NULL) AS evidence_weight_set,
--     count(*) FILTER (WHERE raw_n_increment       IS NOT NULL) AS raw_n_increment_set,
--     count(*) FILTER (WHERE prior_alpha           IS NOT NULL) AS prior_alpha_set,
--     count(*) FILTER (WHERE pre_posterior_alpha   IS NOT NULL) AS pre_posterior_alpha_set,
--     count(*) FILTER (WHERE post_posterior_alpha  IS NOT NULL) AS post_posterior_alpha_set,
--     count(*) FILTER (WHERE impact_mode           IS NOT NULL) AS impact_mode_set,
--     count(*) FILTER (WHERE severity_inputs       IS NOT NULL) AS severity_inputs_set,
--     count(*) AS total_rows
--   FROM repid_score_events;
-- ============================================================================

-- ROLLBACK (manual, uncomment to use). This migration writes no row and
-- backfills nothing, so dropping the columns is a complete, lossless revert.
-- BEGIN;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS severity_inputs;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS impact_mode;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS post_posterior_beta;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS post_posterior_alpha;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS pre_posterior_beta;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS pre_posterior_alpha;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS prior_beta;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS prior_alpha;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS raw_n_increment;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS evidence_weight;
-- COMMIT;
