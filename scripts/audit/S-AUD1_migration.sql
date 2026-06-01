-- ============================================================================
-- S-AUD1 — Hash-Chained Audit Trail + Tool Call Log   (DESIGN ONLY)
-- Author: CC · 2026-05-30 · branch feat/cc-2026-05-30-s-aud1
--
-- DO NOT APPLY until Sean co-signs. Present-for-review SQL (schema is managed
-- externally per CLAUDE.md). Every statement is idempotent / re-runnable.
--
-- Schema was queried first (no assumptions):
--   hal_production_events.id is UUID (NOT serial) → the chain is ordered by
--     (created_at, id), never by id. created_at exists.
--   tool_call_log does not exist → created here (id BIGSERIAL = insert order).
--   trustchat_sessions exists with llm_model but NOT llm_model_version /
--     response_hash → both added (llm_model_version is distinct from llm_model).
--   pgcrypto is already enabled (digest()/sha256 available).
--
-- HASH-CHAIN MODEL (tamper-evident, append-only):
--   each row's previous_entry_hash = SHA256( <prior row's previous_entry_hash>
--                                            || <this row's content> )
--   where content = (to_jsonb(row) - 'previous_entry_hash')::text  — the row
--   WITHOUT the chain column (so it isn't self-referential) and as canonical,
--   key-sorted JSON so the trigger and the verifier serialize identically.
--   The first row links to the literal sentinel 'GENESIS'.
--   Verification recomputes the chain IN-DB (same serialization) — see
--   scripts/audit/verify-chain.ts.
--   NOTE: any UPDATE to an audited row changes its content → the chain no longer
--   verifies from that row forward. That is the point (audit tables are
--   append-only; an UPDATE is tamper-evidence, not a bug).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Generic chain trigger — reusable across any table that has a
-- previous_entry_hash TEXT column + created_at + id. BEFORE INSERT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_audit_hash_chain() RETURNS trigger AS $$
DECLARE
  prev_hash text;
  content   text;
BEGIN
  -- Serialize inserts per table so two concurrent inserts can't read the same
  -- "last row" and fork the chain. Released at transaction end.
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_NAME));

  -- prior entry's chain hash, by the deterministic total order (created_at, id).
  EXECUTE format(
    'SELECT previous_entry_hash FROM %I ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1',
    TG_TABLE_NAME
  ) INTO prev_hash;

  -- content = this row minus the chain column (canonical, key-sorted JSON).
  content := (to_jsonb(NEW) - 'previous_entry_hash')::text;

  NEW.previous_entry_hash :=
    encode(digest(coalesce(prev_hash, 'GENESIS') || content, 'sha256'), 'hex');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- TASK 1 — hal_production_events: add chain column + trigger
-- ===========================================================================
ALTER TABLE hal_production_events
  ADD COLUMN IF NOT EXISTS previous_entry_hash text;

DROP TRIGGER IF EXISTS trg_hal_production_events_hash_chain ON hal_production_events;
CREATE TRIGGER trg_hal_production_events_hash_chain
  BEFORE INSERT ON hal_production_events
  FOR EACH ROW EXECUTE FUNCTION fn_audit_hash_chain();

-- Optional one-time BACKFILL so the chain also covers existing history.
-- (Forward-only without this: pre-migration rows keep previous_entry_hash NULL
--  and verify-chain would report them as unchained.) Row-by-row; run once.
-- Uncomment to apply:
-- DO $$
-- DECLARE r RECORD; prev text := NULL; h text;
-- BEGIN
--   FOR r IN SELECT * FROM hal_production_events ORDER BY created_at, id LOOP
--     h := encode(digest(coalesce(prev,'GENESIS')
--            || ((to_jsonb(r) - 'previous_entry_hash')::text), 'sha256'), 'hex');
--     UPDATE hal_production_events SET previous_entry_hash = h WHERE id = r.id;
--     prev := h;
--   END LOOP;
-- END $$;

-- ===========================================================================
-- TASK 2 — tool_call_log: new table + same chain trigger
-- ===========================================================================
CREATE TABLE IF NOT EXISTS tool_call_log (
  id                  BIGSERIAL PRIMARY KEY,
  agent_name          TEXT NOT NULL,
  tool_name           TEXT NOT NULL,
  tool_input          JSONB,
  tool_output_hash    TEXT,
  repid_at_call       INTEGER,
  confidence_at_call  NUMERIC(5,4),
  autonomy_tier       TEXT CHECK (autonomy_tier IN ('just_do_it','do_then_tell','ask_first')),
  hitl_required       BOOLEAN DEFAULT FALSE,
  hitl_decision       TEXT,
  previous_entry_hash TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_tool_call_log_hash_chain ON tool_call_log;
CREATE TRIGGER trg_tool_call_log_hash_chain
  BEFORE INSERT ON tool_call_log
  FOR EACH ROW EXECUTE FUNCTION fn_audit_hash_chain();

-- RLS note: tool_call_log holds agent behavioural data → enable RLS service_role-only
-- when applied, consistent with the S-SEC2 critical set (left to the RLS batch / Sean):
-- ALTER TABLE tool_call_log ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "service_role_only" ON tool_call_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===========================================================================
-- TASK 3 — trustchat_sessions: model provenance (verified absent before ALTER)
--   llm_model already exists; llm_model_version is a distinct version string.
-- ===========================================================================
ALTER TABLE trustchat_sessions
  ADD COLUMN IF NOT EXISTS llm_model_version TEXT,
  ADD COLUMN IF NOT EXISTS response_hash     TEXT;

COMMIT;

-- ============================================================================
-- ROLLBACK (per object, if a step misbehaves):
--   DROP TRIGGER IF EXISTS trg_hal_production_events_hash_chain ON hal_production_events;
--   ALTER TABLE hal_production_events DROP COLUMN IF EXISTS previous_entry_hash;
--   DROP TRIGGER IF EXISTS trg_tool_call_log_hash_chain ON tool_call_log;
--   DROP TABLE IF EXISTS tool_call_log;
--   ALTER TABLE trustchat_sessions DROP COLUMN IF EXISTS llm_model_version, DROP COLUMN IF EXISTS response_hash;
--   DROP FUNCTION IF EXISTS fn_audit_hash_chain();
-- ============================================================================
