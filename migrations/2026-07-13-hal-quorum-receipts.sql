-- =============================================================================
-- HAL quorum receipt + validator votes (XC #23 persistence SPEC → staged DDL)
-- Sprint: sprint-2026-07-12-ecosystem
-- Does NOT enable writers. Engine hook lands behind flag in a follow-up CC PR.
-- Sean co-sign required before apply_migration.
-- Rollback:
--   DROP TABLE IF EXISTS public.hal_quorum_validator_votes;
--   DROP TABLE IF EXISTS public.hal_quorum_receipts;
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.hal_quorum_receipts (
  id                bigserial PRIMARY KEY,
  score_event_id    bigint NULL,
  quorum_id         text NOT NULL,
  agent_id          text NULL,
  decision          text NOT NULL,
  scoring_decision  text NOT NULL,
  quorum_met        boolean NOT NULL,
  families_used     int NOT NULL,
  providers_used    int NOT NULL,
  families          text[] NOT NULL DEFAULT '{}',
  families_unmapped text[] NOT NULL DEFAULT '{}',
  agreement         numeric NULL,
  hal_score         numeric NULL,
  hal_mode          text NULL,
  sbfa_decision     text NULL,
  sbfa_belief       numeric NULL,
  sbfa_ignorance    numeric NULL,
  decision_source   text NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hal_quorum_validator_votes (
  id              bigserial PRIMARY KEY,
  receipt_id      bigint NOT NULL REFERENCES public.hal_quorum_receipts(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  model           text NULL,
  family          text NOT NULL,
  verdict         text NOT NULL,
  confidence      numeric NULL,
  latency_ms      int NULL,
  error           text NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hal_quorum_receipts_created
  ON public.hal_quorum_receipts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hal_quorum_receipts_event
  ON public.hal_quorum_receipts (score_event_id);
CREATE INDEX IF NOT EXISTS idx_hal_quorum_receipts_quorum
  ON public.hal_quorum_receipts (quorum_id);
CREATE INDEX IF NOT EXISTS idx_hal_quorum_votes_receipt
  ON public.hal_quorum_validator_votes (receipt_id);

ALTER TABLE public.hal_quorum_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hal_quorum_validator_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON public.hal_quorum_receipts;
CREATE POLICY "service_role_all" ON public.hal_quorum_receipts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all" ON public.hal_quorum_validator_votes;
CREATE POLICY "service_role_all" ON public.hal_quorum_validator_votes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.hal_quorum_receipts IS
  'XC #23: durable HAL family-quorum panel receipts. Separate from TrustTrader trinity_receipt_bft_results.';
COMMENT ON TABLE public.hal_quorum_validator_votes IS
  'Per-provider/family votes for a hal_quorum_receipts panel.';
