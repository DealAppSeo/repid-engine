-- REPID-E1 — sealed response ledger (P1). DRAFT migration, STAGED for the single writer.
-- Verified vs live prod [V sql:2026-06-12, CC]: `e1_response_ledger` does NOT exist
-- (to_regclass = NULL). Additive + idempotent — safe to apply once.
--
-- WHY a fresh table (not repid_experiment_events): that table is a column-for-column CLONE of
-- repid_score_events (a scoring log) with NO arm_id/task_id/prompt_hash/output_hash/sampling, it is
-- RLS-OFF + anon-writable, and it already holds 1,080 unrelated rows. E1 needs a sealed, hashed,
-- tamper-evident, deterministic-sampling ledger — built fresh here.
--
-- PROVENANCE IS DENORMALIZED AT WRITE [V CC]: the repid_score_events.llm_call_id -> llm_call_log
-- join recovers only 0.004% (3 / 79,371). DO NOT rely on a join. model/provider/model_version/
-- sampling are first-class columns, written at the moment the response is produced.
--
-- ⚠️ r6 NOTE: CLAUDE_RULES r6 says Claude (or Sean) applies prod SQL; this directive routes the apply
-- to XC. Either is fine — this DDL is self-contained + idempotent + verified against the live schema.

CREATE TABLE IF NOT EXISTS public.e1_response_ledger (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          text        NOT NULL,                 -- human-readable run name ('DRYRUN', 'E1-CONFIRMATORY-…')
  model           text        NOT NULL,                 -- e.g. 'llama-3.1-8b-instant'  (denormalized provenance)
  provider        text        NOT NULL,                 -- e.g. 'groq'
  model_version   text,                                 -- provider-reported version/snapshot if available
  arm_id          text        NOT NULL,                 -- experiment arm / condition
  task_id         text        NOT NULL,                 -- the task instance
  replicate_idx   integer     NOT NULL,                 -- which replicate of (arm × task), 0-based
  temperature     double precision NOT NULL,            -- sampling determinism …
  top_p           double precision NOT NULL,
  seed            bigint,                                -- NULL only if the provider ignores seeds (record it!)
  prompt_hash     text        NOT NULL,                 -- sha256(canonical prompt), hex 0x… — tamper-evident
  output_hash     text        NOT NULL,                 -- sha256(raw output), hex 0x… — the Merkle leaf for P2
  raw_output_ref  text,                                 -- pointer (storage URI/object key) to the raw output; raw NOT inlined
  scoring_version text        NOT NULL,                 -- the scoring code/rubric version applied
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One row per (run, arm, task, replicate): blocks duplicate/double writes of the same cell.
  -- prod-applied cell key includes `model` (one model per family → equivalent cell key); verify-first authoritative.
  CONSTRAINT e1_response_ledger_cell_uniq UNIQUE (run_id, model, arm_id, task_id, replicate_idx)
);

COMMENT ON TABLE public.e1_response_ledger IS
  'REPID-E1 sealed response ledger. Append-only, service_role-only. Denormalized provenance (the '
  'llm_call_id join is dead, 0.004%). output_hash is the Merkle leaf the commit-reveal anchor (P2) seals.';

CREATE INDEX IF NOT EXISTS idx_e1_ledger_run        ON public.e1_response_ledger (run_id);
CREATE INDEX IF NOT EXISTS idx_e1_ledger_arm_task   ON public.e1_response_ledger (run_id, arm_id, task_id);
CREATE INDEX IF NOT EXISTS idx_e1_ledger_created    ON public.e1_response_ledger (created_at);

-- ── SEALING: RLS-on, service_role-only, no anon/authenticated, append-only (no UPDATE/DELETE) ──
ALTER TABLE public.e1_response_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.e1_response_ledger FORCE ROW LEVEL SECURITY;  -- table owner is also subject to RLS

-- Revoke every grant from the public-facing roles (belt). service_role bypasses RLS for the writer.
REVOKE ALL ON public.e1_response_ledger FROM PUBLIC, anon, authenticated;
-- Supabase DEFAULT PRIVILEGES grant service_role ALL at CREATE — revoke down to read+append so even
-- service_role cannot UPDATE/DELETE/TRUNCATE (the TRUNCATE gap a row-level trigger cannot catch).
REVOKE ALL ON public.e1_response_ledger FROM service_role;
GRANT SELECT, INSERT ON public.e1_response_ledger TO service_role;  -- read + append only; NO update/delete/truncate

-- RLS policy: only service_role may read/insert (suspenders — even if a grant leaks later).
DROP POLICY IF EXISTS e1_ledger_service_only ON public.e1_response_ledger;
CREATE POLICY e1_ledger_service_only ON public.e1_response_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Append-only ENFORCEMENT at the data layer (not just grants): block UPDATE/DELETE for everyone,
-- including service_role, so a sealed row can never be silently mutated after the fact.
CREATE OR REPLACE FUNCTION public.e1_ledger_block_mutations() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'e1_response_ledger is append-only (% blocked) — sealed research-integrity ledger', TG_OP;
END;
$$;
DROP TRIGGER IF EXISTS trg_e1_ledger_append_only ON public.e1_response_ledger;
CREATE TRIGGER trg_e1_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.e1_response_ledger
  FOR EACH ROW EXECUTE FUNCTION public.e1_ledger_block_mutations();

-- ── POST-APPLY VERIFY (run after applying; all should hold) ──
-- SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='e1_response_ledger';      -- t, t
-- SELECT has_table_privilege('anon','public.e1_response_ledger','INSERT');                          -- f
-- SELECT has_table_privilege('authenticated','public.e1_response_ledger','SELECT');                 -- f
-- SELECT has_table_privilege('service_role','public.e1_response_ledger','UPDATE');                  -- (grant) f
-- -- and an UPDATE/DELETE as service_role must RAISE (append-only trigger).
