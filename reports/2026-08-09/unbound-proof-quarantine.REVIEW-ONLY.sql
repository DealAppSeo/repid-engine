-- =============================================================================
-- unbound-proof-quarantine.REVIEW-ONLY.sql
-- Corpus hygiene for repid_zkp_proofs — QUARANTINE (never delete) the unbound
-- "real" proofs that pollute the real-proof count.
--
--   ⛔ REVIEW ONLY — DO NOT APPLY. DO NOT EXECUTE. ⛔
--
-- This file is a PROPOSAL for Sean. Applying any statement here mutates production
-- data and/or schema and is a Sean-gated action (BLOCKED_FOR_SEAN). It lives under
-- reports/ precisely so no migration runner picks it up. Nothing here runs from CI,
-- from the app, or from a deploy.
--
-- Provenance rule: this MARKS rows, it never DELETEs them. An unbound proof is
-- evidence of a producer bug; deleting it destroys the audit trail. We flag it so the
-- honest metric can EXCLUDE it while the row stays on disk.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- THE FINDING  [V SQL 2026-08-08]
-- -----------------------------------------------------------------------------
-- Of 22,239 is_real=true rows, 7,958 carry a statement of the shape
--   { "repid_score": <n>, "threshold": <n> }
-- with NO agent_id and NO tier, and repid_score defaulted to 1000. Those proofs are
-- unbound: they are tied to no agent, certify nothing, and fail the published WASM
-- verifier ("missing field `agent_id`" / "missing field `tier`"). The honest
-- real-agent-bound count is ~14,281 (= 22,239 - 7,958).
--
-- Root cause (now fixed forward): src/services/proof-drain-service.ts assembled the
-- statement inline as { repid_score, threshold }. From 2026-08-09 it goes through
-- src/zkp/proof-statement-guard.buildBoundStatement, which fails closed. This file is
-- only about the ROWS ALREADY WRITTEN.

-- -----------------------------------------------------------------------------
-- STEP 0 — CONFIRM THE POPULATION before touching anything (read-only).
-- Run these SELECTs first and eyeball the counts against the finding. If the numbers
-- do not match, STOP — the detection predicate or the schema has drifted.
-- -----------------------------------------------------------------------------

-- 0a. Total real, unbound-real, and the honest bound count.
SELECT
  count(*) FILTER (WHERE is_real)                                              AS real_total,
  count(*) FILTER (WHERE is_real
                     AND (statement ->> 'agent_id') IS NULL
                     AND (statement ->> 'tier')     IS NULL)                   AS unbound_real,
  count(*) FILTER (WHERE is_real
                     AND (statement ->> 'agent_id') IS NOT NULL
                     AND (statement ->> 'tier')     IS NOT NULL)               AS bound_real
FROM repid_zkp_proofs;
-- EXPECT (approx, 2026-08-08): real_total=22239, unbound_real=7958, bound_real~14281.

-- 0b. Sanity: are the unbound rows really the score=1000 default cohort?
SELECT (statement ->> 'repid_score') AS score, count(*)
FROM repid_zkp_proofs
WHERE is_real
  AND (statement ->> 'agent_id') IS NULL
  AND (statement ->> 'tier')     IS NULL
GROUP BY 1
ORDER BY count(*) DESC
LIMIT 20;
-- EXPECT the 1000 bucket to dominate. A surprise here means widen the review before
-- flagging anything.

-- -----------------------------------------------------------------------------
-- STEP 1 — ADD A QUARANTINE FLAG  (DDL — Sean-gated, additive, reversible).
-- A dedicated column, NOT a mutation of is_real. is_real is trigger-derived and
-- CHECK-guarded (repid_zkp_proofs_is_real_integrity); do not fight the trigger. The
-- flag is orthogonal provenance: "this row is real-by-scheme but NOT agent-bound".
-- Default FALSE so every existing and future row is un-quarantined until explicitly set.
-- -----------------------------------------------------------------------------
-- ALTER TABLE repid_zkp_proofs
--   ADD COLUMN IF NOT EXISTS is_unbound boolean NOT NULL DEFAULT false;
--
-- COMMENT ON COLUMN repid_zkp_proofs.is_unbound IS
--   'Corpus hygiene 2026-08-09: TRUE when is_real but the statement lacks an agent_id/tier '
--   'binding (the pre-guard proof-drain cohort). Row is retained for provenance; the honest '
--   'real-proof metric MUST exclude is_unbound=true.';

-- -----------------------------------------------------------------------------
-- STEP 2 — FLAG THE UNBOUND COHORT  (DML — Sean-gated). MARK, never DELETE.
-- Idempotent: re-running only re-sets the same rows. Wrap in a transaction so the
-- rowcount can be checked against STEP 0a before COMMIT.
-- -----------------------------------------------------------------------------
-- BEGIN;
--   UPDATE repid_zkp_proofs
--      SET is_unbound = true
--    WHERE is_real
--      AND (statement ->> 'agent_id') IS NULL
--      AND (statement ->> 'tier')     IS NULL
--      AND is_unbound = false;
--   -- Confirm exactly the expected number of rows were flagged (≈7958) BEFORE commit:
--   -- SELECT count(*) FROM repid_zkp_proofs WHERE is_unbound;
-- COMMIT;   -- or ROLLBACK if the count is not what STEP 0a predicted.

-- -----------------------------------------------------------------------------
-- STEP 3 — THE HONEST METRIC  (read path the dashboards/leaderboard should use).
-- Whether or not STEP 1/2 are applied, the corpus becomes trustworthy the moment the
-- READ excludes unbound rows. Two equivalent forms:
-- -----------------------------------------------------------------------------
-- 3a. If STEP 1/2 applied — cheap boolean filter:
-- SELECT count(*) AS honest_real_proofs
-- FROM repid_zkp_proofs
-- WHERE is_real AND NOT is_unbound;
--
-- 3b. If STEP 1/2 NOT applied — the predicate stands alone (no schema change needed to
--     start reporting honestly):
-- SELECT count(*) AS honest_real_proofs
-- FROM repid_zkp_proofs
-- WHERE is_real
--   AND (statement ->> 'agent_id') IS NOT NULL
--   AND (statement ->> 'tier')     IS NOT NULL;
-- EXPECT ~14,281.

-- -----------------------------------------------------------------------------
-- BLOCKED_FOR_SEAN
-- -----------------------------------------------------------------------------
-- STEP 1 (ALTER TABLE) and STEP 2 (UPDATE) mutate production schema/data and must be
-- applied by Sean (or under his explicit GO) after STEP 0 confirms the counts on the
-- live database. STEP 0 and STEP 3 are read-only and safe to run for verification.
-- The forward fix (proof-statement-guard) is already in code and needs no DB change.
-- =============================================================================
