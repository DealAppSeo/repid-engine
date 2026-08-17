-- ============================================================================
-- repid_score_events — make the ISSUER of a verdict identifiable, and its
-- evidence typed. Prerequisite for issuer staking (Gate 2).
--
-- STATUS: WRITTEN, NOT APPLIED. Left for Sean.
-- ============================================================================
--
-- Every number below was taken from the live catalog / ledger on 2026-08-17 by
-- read-only query. No DDL and no writes were run against production to produce
-- them. Where a query could not settle a question the line says NOT CHECKED.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GOAL THIS UNBLOCKS, AND THE THREE THINGS THAT ARE ALREADY TRUE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Goal: an agent that issues a verdict stakes its own standing on it, so a
-- veto that consulted nothing costs the issuer. That needs three facts on the
-- row: WHO issued, WHAT the issue was grounded in, and a vocabulary to charge
-- under. Measured, only one of the three is missing outright — which is why
-- this migration is much smaller than the problem statement implies.
--
--   1. WHO — the column already exists. `counterparty_agent_id uuid`
--      (FK → repid_agents(id) ON DELETE SET NULL, plus
--      `repid_score_events_counterparty_not_self`) was added 2026-08-11 and
--      1,285 rows carry a value today. It is NULL on **all 147,723**
--      HAL_SCORE_EVENT rows. So the gap is a WRITER gap, not a column gap.
--      *** Adding another identity column here would be wrong. ***
--
--   2. VOCABULARY — already present, and this is the finding that shrank the
--      migration. `repid_score_events_event_type_check` enumerates 36 literals
--      and **`VALIDATOR_PENALTY` and `VALIDATOR_REWARD` are already among
--      them**, already in use (1 and 31 rows). An issuer charge is expressible
--      today. Unlike the peer-verify and work-seat lanes, issuer staking is
--      **not blocked on a CHECK-constraint change**, and this file deliberately
--      does not touch that constraint — a needless rewrite of it would collide
--      with `20260815190000_work_seat_event_types.sql` in the other repo, where
--      whichever migration is applied SECOND silently drops the first one's
--      literals.
--
--   3. WHAT IT WAS GROUNDED IN — this is the real gap, and it is worse than
--      "absent". See below.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- GAP A — THE COUNTERPARTY COLUMN CANNOT SAY WHAT THE COUNTERPARTY *WAS*
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The 1,285 rows that carry a counterparty today mean at least four different
-- things, and nothing on the row distinguishes them:
--
--     SERVICE_FULFILLED   1,221 of 1,317   the other side of a trade
--     SERVICE_SATISFIED      30 of    40   the other side of a trade
--     VALIDATION_FAILED      21 of    26   the validator
--     CHALLENGE_LOSS/WIN     13 of    35   the challenger
--
-- The meaning is currently recovered by switching on `event_type`, which is
-- caller-supplied and therefore cannot carry trust (LESSONS 4). A charge
-- routine that reads "counterparty" and assumes "issuer" would debit a trading
-- counterparty for a verdict it never issued. `counterparty_role` makes the
-- relationship a stated fact rather than an inference from a label.
--
-- The enumerated set is closed on purpose and starts SMALL — only roles for
-- which a writer exists or is being wired in this change. An open text column
-- would let the next writer invent a fifth spelling of "issuer", which is
-- exactly how `event_type` grew to 36.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- GAP B — THE PROVIDER EVIDENCE IS A NUMBER THAT MEANS TWO OPPOSITE THINGS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This is the load-bearing measurement in this file, and it inverts the premise
-- the sprint started from.
--
-- (i) The field name in the offline corpus does not exist in production.
--     `metadata ? 'hal_providers_used'`  →  **0 rows**, of 147,723.
--     The live writer emits `quorum_providers_used`  →  **93,656 rows**.
--     A query written against the corpus's field name returns nothing and reads
--     as "production records no provider evidence". It records it on 63.4% of
--     HAL rows. (LESSONS 5 — match the emitted name, not the tidy one.)
--
-- (ii) The 63.4% is a clean cutover, not a sampling artefact:
--     last row WITHOUT the key   2026-06-04 02:30:15Z
--     first row WITH    the key  2026-06-04 02:38:43Z
--     rows without the key after that instant  **0**
--     So: recorded on 100% of HAL events since 2026-06-04, on 0% before. The
--     54,067 older rows are NOT RECORDED, and no amount of care makes them
--     measurable.
--
-- (iii) The recorded value is a jsonb NUMBER in all 93,656 rows (0 arrays),
--     though `src/hal/provider-width.ts` types the persisted shape as a name
--     ARRAY. It is a COUNT. So the row can answer "how many" and can never
--     answer "which family" — and a gateway-fronted count overstates
--     independence, which is the quantity a quorum veto depends on.
--
-- (iv) THE ZERO IS NOT A ZERO. Every row recording 0 providers is:
--          hal_mode = 'extractor-fallback'   1,967
--          hal_mode = NULL (extractor path)    476
--     and NOT ONE row where a fact-check quorum ran and genuinely used zero.
--     The writer coalesces an ABSENT signal to 0
--     (`Number(signals.providers_used ?? 0)` — src/scoring/pipeline.ts). So the
--     stored 0 means "not recorded", 100% of the time, in a column a cost
--     function would read as "consulted nothing" — the fail-open direction.
--     This is LESSONS 1's `''`-reads-as-nothing failure in numeric form, and it
--     is the reason the new column is NULL-able with NULL reserved for NOT
--     RECORDED and 0 reserved for MEASURED ZERO.
--
-- (v) Consequently the live "unearned veto" story differs from the offline one.
--     Of 115,103 HAL vetoes, grouped by recorded provider count:
--          0 providers    110 vetoes,     0 charged a point
--          2 providers 50,372 vetoes, 37,537 charged  (-375,370 points)
--          3 providers 11,735 vetoes,  5,285 charged   (-52,850)
--          4 providers  4,368 vetoes,      7 charged        (-70)
--          5 providers  1,781 vetoes,     17 charged       (-170)
--     **No veto with fewer than two providers has charged a single point since
--     the cutover.** The R4 quorum gate holds in production. The 46,724 vetoes
--     that did charge with unknown provenance are ALL pre-2026-06-04.
--     So the live defect is NOT that unearned vetoes drain the subject — they
--     do not. It is that a verdict has no issuer, so a *correct* veto earns its
--     issuer nothing and a *wrong* one costs it nothing. The asymmetry the
--     staking design exists to remove is entirely on the issuer side.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS SCHEMA FORECLOSES — READ BEFORE PRICING ANYTHING WITH IT
--
-- Two limits, both stated because a ledger that can price one side of a
-- decision and not the other funds the side it cannot see.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- LIMIT 1 — IT CAN PRICE A WRONG VETO. IT CANNOT PRICE SILENCE.
--
-- If a cost function charges for wrong vetoes and nothing charges for declining
-- to veto, the issuer's cheapest move is to stop vetoing: measured precision
-- rises while recall collapses, and every number on the dashboard improves.
-- This branch makes silence free BY CONSTRUCTION — an evidence-free veto is
-- already downgraded to `flagged` with delta 0, and an evidence-free reward is
-- already withheld. Asked what of that would be detectable, measured live:
--
--   OBSERVABLE with the existing columns plus the two added here
--     the non-vetoed population is recorded, not discarded — of 147,723 HAL
--       events, 115,103 vetoed / 21,972 flagged / 10,648 clean, and
--       `hal_decision` is NULL on none of them. So a veto RATE, and its decline
--       over time, is a plain GROUP BY on created_at. That is the leading
--       indicator and it is already available.
--     hollowing-out near the quorum threshold is computable from `hal_score`
--       against `issuer_providers_used_n` once this migration is applied — that
--       pairing is a reason the count is a typed column and not a jsonb key.
--
--   NOT OBSERVABLE, and NOT fixable by any column added here
--     a FALSE-NEGATIVE RATE on live rows. It needs a ground-truth label on the
--     answers that were NOT vetoed, and there is none: `hal_ground_truth_labels`
--     holds 1,579 rows and **100% of them have source_table =
--     'hal_runner_results'** — the offline corpus. Not one label points at a
--     `repid_score_events` row. No column on this table can create that label;
--     it requires an observation from outside the system that issued the
--     verdict, which is the same structural bar that makes a verifier's own
--     catch/miss uncomputable without an outside observer.
--
--   So: a veto-rate collapse would be VISIBLE and a quiet loss of recall would
--   NOT. Anyone building the cost function should treat the veto rate as the
--   abstention tripwire and should NOT claim recall is being watched.
--
-- LIMIT 2 — THE CHARGEABLE ATOM HERE IS ONE NAMED ISSUER, NOT A PANEL.
--
-- `counterparty_agent_id` is a single uuid. If the entity that should be
-- charged is the PANEL — the provider set together with its quorum outcome, on
-- the argument that panel-level precision is the only precision anyone has
-- measured — then this schema does not reach it, and the reason is the
-- corruption in GAP B (iii): `issuer_providers_used_n` is a COUNT, so it can
-- say a panel of three answered and can never say WHICH three. Two different
-- panels with the same width are indistinguishable on the row.
--
-- That is a deliberate refusal, not an oversight: the persisted provider NAME
-- lists are corrupt, and a gateway label names no family, so a names column
-- populated from them today would be wrong rather than absent. Making the panel
-- chargeable needs the typed `family` field that in-process `ProviderAttempt`
-- objects already carry to be persisted at write time — a WRITER change first,
-- and only then a column. Adding the column first would produce exactly the
-- plausible-looking wrong width `src/hal/provider-width.ts` exists to refuse.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--
--   * No delta, no threshold, no policy, no weight. The cost of an unearned
--     veto is UNMEASURED and cannot be measured against production data that
--     does not exist. A number nothing justifies is worse than an honest gap.
--
--   * No change to `repid_score_events_event_type_check` — see point 2 above.
--
--   * No backfill, and no backfill function. Section "BACKFILL" below states
--     why one cannot be written honestly.
--
--   * No unique index on `idempotency_key`. The 42P10 defect is real and was
--     reproduced (below), and the fix is one line in the CALLER, not an index
--     here. Adding a plain unique index would duplicate an existing partial one
--     to paper over a caller's SQL — the same refusal
--     `20260815190000_work_seat_event_types.sql` makes.
--
--   * It does not enable anything. `src/scoring/issuer-identity.ts` is gated
--     OFF by default; applying this file alone changes no row and no score.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 42P10 — VERIFIED, REPRODUCED, AND THE FIX IS NOT IN THIS FILE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Claim under test: `ON CONFLICT (idempotency_key)` resolves no arbiter because
-- only PARTIAL unique indexes exist. VERIFIED 2026-08-17, two ways.
--
--   Catalog: `repid_score_events` has exactly three unique indexes — the
--   primary key, and two PARTIAL ones on `idempotency_key`, predicates
--   `idempotency_key IS NOT NULL` and `idempotency_key LIKE 'peer_verify:%'`.
--   `pg_constraint` holds NO unique constraint on the table (contype 'u': none).
--
--   Reproduced, without writing a row, by planning the statement only:
--       EXPLAIN INSERT INTO repid_score_events (...) SELECT ... WHERE false
--       ON CONFLICT (idempotency_key) DO NOTHING;
--     → ERROR 42P10: there is no unique or exclusion constraint matching the
--       ON CONFLICT specification
--   Arbiter resolution happens at PLAN time, so EXPLAIN raises it and nothing
--   is inserted. (`WHERE false` is belt-and-braces; EXPLAIN never executes.)
--
--   The fix, verified the same way:
--       ... ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
--     → plans, and the plan names its arbiter:
--       "Conflict Arbiter Indexes: uq_score_events_idempotency_key"
--
--   VERDICT: **no index and no DDL is needed.** Repeating the predicate in the
--   statement is sufficient and is the whole fix. It belongs in
--   `src/services/peer-verify-score.ts` (`insertScoreEventLegacy`), which is
--   this repo's, and is NOT applied here because that function is deliberately
--   byte-frozen by `tests/score-event-writer-ratchet.test.ts`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY — EVERY CONSTRAINT, TRIGGER AND INDEX THIS DEPENDS ON, CHECKED LIVE
-- ─────────────────────────────────────────────────────────────────────────────
--
--   `repid_score_events_counterparty_not_self` CHECK
--       (counterparty IS NULL OR counterparty <> agent_id) — EXISTS. Any writer
--       naming the issuer MUST skip the field when issuer = subject, or every
--       such insert fails 23514. Handled in `issuer-identity.ts`; that is the
--       single most likely way this change breaks a live writer.
--
--   `repid_score_events_counterparty_fkey` → repid_agents(id) — EXISTS. A
--       configured issuer id absent from `repid_agents` fails 23503 on EVERY
--       insert, not just issuer ones. The resolver therefore treats an
--       unresolvable id as "no issuer", never as a value to try.
--
--   `trg_apply_repid_score_event` BEFORE INSERT, all rows — EXISTS, and it
--       returns early when `repid_delta_applied IS NOT NULL`. The HAL pipeline
--       always sets that field, so this trigger is a no-op for HAL rows and
--       stays one. A FUTURE issuer-charge writer that OMITS the field will have
--       its delta applied by this trigger automatically. That is the mechanism
--       any charge will run on and it is stated here so it is not rediscovered.
--
--   `trg_hal_penalty_guard` BEFORE INSERT — EXISTS, and its body gates on
--       `event_type = 'HAL_SCORE_EVENT'`. An issuer charge written under
--       `VALIDATOR_PENALTY` is NOT covered by it. The guard that suppresses an
--       ungrounded penalty against a subject has no counterpart on the issuer
--       side; whoever writes the charge owns that.
--
--   New CHECKs below constrain only NEW columns, which are NULL on all
--   152,161 existing rows, so validation is instantaneous and cannot fail.
--
--   NOT CHECKED: whether any external consumer (dashboards, the other lane,
--   `attestation-minter`) does `SELECT *` into a fixed-width struct. Adding
--   columns is safe for views, which store expanded column lists.
--
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- A. What role the counterparty played. See GAP A.
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS counterparty_role text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_counterparty_role_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_counterparty_role_chk
      CHECK (
        counterparty_role IS NULL
        OR counterparty_role = ANY (ARRAY[
          -- The agent that ISSUED the verdict this row records. The one the
          -- staking design needs; nothing writes it before this change.
          'verdict_issuer',
          -- The agent the verdict was ABOUT. Set on a charge/reward row whose
          -- agent_id is the issuer, i.e. the mirror of 'verdict_issuer'.
          'verdict_subject',
          -- The four meanings already present in the data, named so existing
          -- rows can be qualified later without inventing a new spelling.
          'trade_counterparty',
          'validator',
          'challenger'
        ])
      );
  END IF;

  -- A role without a party is a claim about nobody. The reverse (a party with
  -- no role) stays legal: 1,285 rows are already in that state and this
  -- migration does not backfill them.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_counterparty_role_needs_party'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_counterparty_role_needs_party
      CHECK (counterparty_role IS NULL OR counterparty_agent_id IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN repid_score_events.counterparty_role IS
  'What counterparty_agent_id WAS in this event. NULL means not recorded — it '
  'never means "no role", and it must not be inferred from event_type, which is '
  'caller-supplied. Rows written before 2026-08-17 are all NULL.';

-- ---------------------------------------------------------------------------
-- B. How many verification providers the ISSUER actually consulted. See GAP B.
--
--    smallint: the live maximum recorded is 5.
--    NULL  = NOT RECORDED (the issuer did not report, or this predates the
--            field). It is the default and it is not a zero.
--    0     = MEASURED ZERO — the issuer reports it consulted nothing. Today no
--            row in production can honestly claim this, because the writer
--            coalesces absence to 0; the new writer must not.
--    >= 1  = that many providers answered.
--
--    This is deliberately a COUNT and not a name array. The persisted name
--    lists are corrupt (`src/hal/provider-width.ts`: empty, or a count smuggled
--    into a name slot) and a gateway label names no family, so a names column
--    added now would be populated from data that cannot support it. Family
--    width is left NOT RECORDED rather than recorded wrong.
-- ---------------------------------------------------------------------------
ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS issuer_providers_used_n smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_issuer_providers_used_n_chk'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_issuer_providers_used_n_chk
      CHECK (issuer_providers_used_n IS NULL OR issuer_providers_used_n >= 0);
  END IF;
END $$;

COMMENT ON COLUMN repid_score_events.issuer_providers_used_n IS
  'Verification providers the verdict issuer consulted. NULL = NOT RECORDED, '
  '0 = MEASURED ZERO (issuer consulted nothing), >=1 = that many answered. The '
  'distinction is the whole point: metadata.quorum_providers_used stores 0 for '
  'both cases and is therefore unusable for charging. A count, not a family '
  'width — see src/hal/provider-width.ts for why names are not stored.';

-- ---------------------------------------------------------------------------
-- C. Indexes.
--
-- Partial, for the same reason idx_score_events_counterparty is partial: the
-- columns are NULL on ~100% of rows and will stay that way for every event
-- type that has no issuer. An index over the NULLs would be most of the index
-- and none of the queries.
--
-- The first is the charge-side lookup: "every event this issuer issued".
-- The second answers "unearned verdicts by this issuer" in one index scan,
-- which is the only query the cost function must run over the full ledger.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_score_events_counterparty_role
  ON repid_score_events (counterparty_role, counterparty_agent_id)
  WHERE counterparty_role IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_score_events_issuer_evidence
  ON repid_score_events (counterparty_agent_id, issuer_providers_used_n)
  WHERE counterparty_role = 'verdict_issuer';

COMMIT;

-- ============================================================================
-- BACKFILL — the honest answer is NO, and it is not a matter of effort.
--
-- 147,723 HAL_SCORE_EVENT rows carry no issuer. Asked whether any join path
-- recovers one, three were tested live on 2026-08-17:
--
--   llm_call_id → llm_call_log.call_id
--       147,624 of 147,723 HAL rows carry an llm_call_id, and **15** of them
--       resolve to a row in llm_call_log (486,376 rows). The id is minted
--       locally by the pipeline and never lands in that table. DEAD END, and it
--       is the one that looks most like a key.
--
--   idempotency_key → trinity_tasks.id
--       LIVE AND ALMOST TOTAL, and it is not what it seems. 147,643 rows are
--       keyed `trinity_task_bridge_<taskid>` and **147,600 (99.92%) resolve to
--       a trinity_tasks row.** But on all 147,600 joined tasks,
--       `verifier_agent_id`, `verified_by` and `final_verdict` are **NULL**.
--       The join is real and it carries zero issuer information. (It is a real
--       TASK key, though — worth knowing for the separate "no task key on
--       repid_score_events" blocker, which this measurement partly answers.)
--
--   llm_provider on the row
--       Present on 144,277 rows, 12 distinct values — and it names the provider
--       of the ANSWER BEING JUDGED, not the issuer of the verdict
--       (`llm_provider: canonicalizeProvider(input.provider_used)`). Reading it
--       as the issuer would attribute every verdict to its own defendant.
--       DEAD END, and the most dangerous of the three because it populates.
--
-- So: the issuer is not RECOVERABLE from any table. It is also not AMBIGUOUS —
-- every HAL_SCORE_EVENT row was issued by one actor, this repo's HAL pipeline.
-- What is genuinely gone is the issuer's CONFIGURATION for the 54,067 rows
-- written before 2026-06-04 (no hal_mode, no decision_source, no provider
-- count). For the 93,656 rows after it, the configuration IS recorded and could
-- be qualified — but qualifying them requires a repid_agents row that stands
-- for the HAL pipeline, and NO SUCH ROW HAS BEEN IDENTIFIED. Five agent rows
-- have HAL-ish names; picking one would be a guess, and a guess in a
-- foreign-keyed column is fiction that later reads as evidence.
--
-- RECOMMENDATION: do not backfill. Set the issuer at write time from here on,
-- and let a NULL keep meaning "nobody was recording", exactly as the 2026-08-11
-- counterparty migration established.
-- ============================================================================

-- ============================================================================
-- BLOCKED ON SEAN — the exact actions, in order.
--
--   1. Decide whether the HAL pipeline gets an identity in `repid_agents`, and
--      if so which row. Nothing else in this file can proceed without it, and
--      it cannot be inferred. Once it exists, set HAL_ISSUER_AGENT_ID on the
--      `repid-engine` Railway SERVICE (not project-shared).
--   2. Apply this migration. On its own it writes no row and moves no score.
--   3. Only then set HAL_ISSUER_IDENTITY_ENABLED=true. Setting it BEFORE
--      step 2 makes every HAL score-event insert fail — the writer would name
--      columns that do not exist. The flag and the migration are coupled in
--      that direction only; the migration alone is inert.
--   4. Separately, and independent of all the above: the one-line 42P10 fix in
--      src/services/peer-verify-score.ts, which needs the byte-frozen
--      allow-list in tests/score-event-writer-ratchet.test.ts shrunk in the
--      same commit.
-- ============================================================================

-- ROLLBACK (manual, uncomment to use). Dropping the columns removes the
-- constraints and indexes with them; there is no backfilled data to unwind
-- because this migration writes none.
-- BEGIN;
--   DROP INDEX IF EXISTS idx_score_events_issuer_evidence;
--   DROP INDEX IF EXISTS idx_score_events_counterparty_role;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS issuer_providers_used_n;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS counterparty_role;
-- COMMIT;
