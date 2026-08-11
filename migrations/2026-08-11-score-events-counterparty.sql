-- ============================================================================
-- repid_score_events.counterparty_agent_id — record the other party at write time
-- Lane: engine-core · branch claude/e2e-mvp-packaging-plttzn
-- ============================================================================
--
-- WHY. Measured 2026-08-11 while backfilling the memory graph: every interaction between
-- two agents is currently stored as TWO UNRELATED SINGLE-AGENT ROWS. `repid_score_events`
-- has one `agent_id` and no counterparty, so a provider's SERVICE_FULFILLED and the buyer's
-- SERVICE_FULFILLED for the same contract are joined only by an optional `contract_id` that
-- 99.2% of events never set. The relationship is destroyed at write time and cannot be
-- recovered later by any amount of inference:
--
--   all 152,130 score events  →  42 unique agent pairs
--   llm_call_id / zk_proof_id →  1:1 with the event, shared by 0 agents
--
-- This is the upstream fix. It does not make old data richer; it stops throwing the
-- relationship away from here on.
--
-- ── DESIGN DECISIONS THAT ARE NOT OBVIOUS ────────────────────────────────────────────────
--
-- ON DELETE SET NULL, deliberately NOT CASCADE. `agent_id` cascades, which is right — an
-- agent's own history goes with the agent. Cascading on the COUNTERPARTY would delete this
-- agent's history because some unrelated other agent was removed. The event is about
-- `agent_id`; losing the counterparty must degrade the row, never destroy it.
--
-- CHECK (counterparty <> agent_id). An event where you are your own counterparty is
-- meaningless, and it is the exact shape `agent_memory_edges.no_self_edges` already forbids
-- downstream. Rejecting it here keeps the invalid row from ever existing rather than
-- filtering it at every reader.
--
-- NULLABLE, with no default and no backfill-to-a-guess. Most event types genuinely have no
-- counterparty (DECAY, GENESIS, HAL_SCORE_EVENT). NULL means "no other party, or not
-- recorded" — it must never be read as "self".
--
-- PROVENANCE ON DERIVED VALUES. The backfill below stamps `metadata.counterparty_source`.
-- A value that was RECORDED at write time and one INFERRED afterwards are different kinds
-- of evidence, and the distinction disappears the moment they share a column. Live writes
-- leave the marker absent, which is what "recorded at the time" looks like.
--
-- ── WHAT THE BACKFILL CAN AND CANNOT RECOVER ─────────────────────────────────────────────
--
--   shared contract_id, exactly 2 agents   614 contracts →  1,262 events   (no ambiguity:
--                                          measured, EVERY multi-agent contract has exactly
--                                          two, so nothing is guessed)
--   metadata->>'challengerId', valid uuid, existing agent, not self  →  13 events
--   everything else                                                  →  NOT recoverable
--
-- ~1,275 of 152,130 rows, under 1%. The column's value is prospective. Anyone reading a
-- coverage number off this table should know that a NULL on a pre-2026-08-11 row means
-- "nobody was recording", not "there was no counterparty".
--
-- NOT backfilled from `metadata.counterparty` (37 rows): those hold display strings like
-- 'mock-fl-buyer-1782493422522', not agent ids. Coercing them would put fiction in a
-- foreign-keyed column.
--
-- ── APPLIED TO PRODUCTION 2026-08-11, project qnnpjhlxljtqyigedwkb ─────────────────────────
--
--   backfilled       1,262 shared_contract + 13 metadata_challenger = 1,275 of 152,130 rows
--   re-run           second apply updated 0 of both (idempotent)
--   pairs queryable  53 distinct agent pairs directly on the column — MORE than the 42 the
--                    contract self-join could find, because the challenger metadata adds 11
--   integrity        0 self-counterparty rows · 0 dangling references · 1,275 provenance-marked
--
--   Constraints probed by trying to violate them, inside a deliberately aborted block:
--     self as counterparty     → rejected (check_violation)
--     unknown agent id         → rejected (foreign_key_violation)
--   Row count unchanged at 152,130 afterwards, confirming the probe wrote nothing.
--
-- Applied by transcription through an MCP client, so the deployed body was diffed against
-- this file. Normalised md5 of prosrc, verified equal on 2026-08-11:
--   backfill_score_event_counterparty  f79b7c4465177f925c741bb0ae9b962f  (2827 chars)
-- ============================================================================
BEGIN;

ALTER TABLE repid_score_events
  ADD COLUMN IF NOT EXISTS counterparty_agent_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_counterparty_fkey'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_counterparty_fkey
      FOREIGN KEY (counterparty_agent_id) REFERENCES repid_agents(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repid_score_events_counterparty_not_self'
  ) THEN
    ALTER TABLE repid_score_events
      ADD CONSTRAINT repid_score_events_counterparty_not_self
      CHECK (counterparty_agent_id IS NULL OR counterparty_agent_id <> agent_id);
  END IF;
END $$;

-- Partial: the column is NULL for the large majority of rows and always will be, so an
-- index over the NULLs would be most of the index and none of the queries.
CREATE INDEX IF NOT EXISTS idx_score_events_counterparty
  ON repid_score_events (counterparty_agent_id)
  WHERE counterparty_agent_id IS NOT NULL;

-- The pair lookup the memory-graph backfill actually runs.
CREATE INDEX IF NOT EXISTS idx_score_events_agent_counterparty
  ON repid_score_events (agent_id, counterparty_agent_id)
  WHERE counterparty_agent_id IS NOT NULL;

COMMENT ON COLUMN repid_score_events.counterparty_agent_id IS
  'The OTHER agent in a two-party event (buyer<->provider, challenger<->defender, '
  'producer<->verifier). NULL means no counterparty OR not recorded — never self, which the '
  'CHECK enforces. metadata.counterparty_source marks values inferred by backfill rather '
  'than recorded at write time.';

-- ---------------------------------------------------------------------------
-- Backfill. Dry-run by default, same as every other writer in this repo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_score_event_counterparty(p_apply boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v_contract_candidates  bigint;
  v_challenger_candidates bigint;
  v_contract_set   bigint := 0;
  v_challenger_set bigint := 0;
  v_filled_before  bigint;
  v_filled_after   bigint;
  v_total          bigint;
BEGIN
  SELECT COUNT(*) INTO v_total FROM repid_score_events;
  SELECT COUNT(*) INTO v_filled_before FROM repid_score_events WHERE counterparty_agent_id IS NOT NULL;

  -- Exactly-one-other-agent only. A contract with three parties has no single counterparty,
  -- and picking one would be inventing a fact. Measured: no such contract exists today, but
  -- the guard is the difference between "none exist" and "we assumed none exist".
  SELECT COUNT(*) INTO v_contract_candidates
  FROM repid_score_events e
  WHERE e.counterparty_agent_id IS NULL
    AND e.contract_id IS NOT NULL
    AND (SELECT COUNT(DISTINCT o.agent_id) FROM repid_score_events o
         WHERE o.contract_id = e.contract_id AND o.agent_id <> e.agent_id) = 1;

  SELECT COUNT(*) INTO v_challenger_candidates
  FROM repid_score_events e
  WHERE e.counterparty_agent_id IS NULL
    AND e.metadata->>'challengerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND (e.metadata->>'challengerId')::uuid <> e.agent_id
    AND EXISTS (SELECT 1 FROM repid_agents a WHERE a.id = (e.metadata->>'challengerId')::uuid);

  IF p_apply THEN
    WITH upd AS (
      UPDATE repid_score_events e
         SET counterparty_agent_id = (
               SELECT DISTINCT o.agent_id FROM repid_score_events o
               WHERE o.contract_id = e.contract_id AND o.agent_id <> e.agent_id),
             metadata = COALESCE(e.metadata, '{}'::jsonb)
                        || jsonb_build_object('counterparty_source', 'derived:shared_contract')
       WHERE e.counterparty_agent_id IS NULL
         AND e.contract_id IS NOT NULL
         AND (SELECT COUNT(DISTINCT o.agent_id) FROM repid_score_events o
              WHERE o.contract_id = e.contract_id AND o.agent_id <> e.agent_id) = 1
      RETURNING 1
    ) SELECT COUNT(*) INTO v_contract_set FROM upd;

    WITH upd AS (
      UPDATE repid_score_events e
         SET counterparty_agent_id = (e.metadata->>'challengerId')::uuid,
             metadata = COALESCE(e.metadata, '{}'::jsonb)
                        || jsonb_build_object('counterparty_source', 'derived:metadata_challenger')
       WHERE e.counterparty_agent_id IS NULL
         AND e.metadata->>'challengerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND (e.metadata->>'challengerId')::uuid <> e.agent_id
         AND EXISTS (SELECT 1 FROM repid_agents a WHERE a.id = (e.metadata->>'challengerId')::uuid)
      RETURNING 1
    ) SELECT COUNT(*) INTO v_challenger_set FROM upd;
  END IF;

  SELECT COUNT(*) INTO v_filled_after FROM repid_score_events WHERE counterparty_agent_id IS NOT NULL;

  RETURN jsonb_build_object(
    'applied', p_apply,
    'candidates', jsonb_build_object(
      'shared_contract',    v_contract_candidates,
      'metadata_challenger', v_challenger_candidates
    ),
    'updated', jsonb_build_object(
      'shared_contract',    v_contract_set,
      'metadata_challenger', v_challenger_set
    ),
    'rows_with_counterparty_before', v_filled_before,
    'rows_with_counterparty_after',  v_filled_after,
    'rows_total',                    v_total,
    -- Stated so nobody reads the filled count as coverage. A NULL on an old row means
    -- nobody was recording, not that there was no counterparty.
    'coverage_note',
      'pre-2026-08-11 rows: NULL means NOT RECORDED, not "no counterparty". '
      || 'Only rows written after the call sites were wired carry a recorded value.'
  );
END;
$fn$;

COMMIT;

-- ROLLBACK (manual, uncomment to use). Dropping the column is the complete rollback for a
-- newly added column — it removes backfilled and live-written values alike, which is what
-- reverting this change means.
-- BEGIN;
--   DROP FUNCTION IF EXISTS backfill_score_event_counterparty(boolean);
--   DROP INDEX IF EXISTS idx_score_events_agent_counterparty;
--   DROP INDEX IF EXISTS idx_score_events_counterparty;
--   ALTER TABLE repid_score_events DROP CONSTRAINT IF EXISTS repid_score_events_counterparty_not_self;
--   ALTER TABLE repid_score_events DROP CONSTRAINT IF EXISTS repid_score_events_counterparty_fkey;
--   ALTER TABLE repid_score_events DROP COLUMN IF EXISTS counterparty_agent_id;
--   -- and the provenance markers the backfill wrote:
--   UPDATE repid_score_events SET metadata = metadata - 'counterparty_source'
--    WHERE metadata ? 'counterparty_source';
-- COMMIT;
