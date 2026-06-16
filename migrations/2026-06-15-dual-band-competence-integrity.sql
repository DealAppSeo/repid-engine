-- ============================================================================
-- STAGED — Sean applies via Supabase SQL editor. DO NOT auto-apply.
--
-- Dual-Band Phase C: Competence × Integrity columns on repid_agents.
--
-- Charter: REPID_DUAL_BAND_CHARTER INV-1 (disjoint signals):
--   competence_score  ← HAL fact-check OUTCOMES (quorum-confirmed pass/veto)
--   integrity_score   ← peer_verification_queue outcomes (verified vs disputed)
--                       NEVER HAL's own veto signal (no self-veto circularity)
--
-- Relationship to GA's existing wisdom_score / character_score columns:
--   wisdom_score  = prediction-calibration (Brier/confidence vs actual outcomes)
--   character_score = mission-alignment actions (helping low-repid agents, etc.)
--   These are REPONOMICS bands (§ Mayer ABI sub-dimensions), NOT the headline
--   Competence/Integrity bands. All four columns coexist — they are orthogonal.
--
-- New columns added here:
--   competence_score   numeric   — [0,1] share of HAL quorum-confirmed correct
--   competence_n       int       — number of quorum-scored events in window
--   integrity_score    numeric   — [0,1] share of peer verifications = 'verified'
--   integrity_n        int       — finalized peer verifications (verified|disputed)
--   dual_band_updated_at timestamptz — last time computeAllDualBands() wrote
--
-- All additive, idempotent (IF NOT EXISTS).
-- ============================================================================

ALTER TABLE public.repid_agents
  ADD COLUMN IF NOT EXISTS competence_score       numeric,
  ADD COLUMN IF NOT EXISTS competence_n           int,
  ADD COLUMN IF NOT EXISTS integrity_score        numeric,
  ADD COLUMN IF NOT EXISTS integrity_n            int,
  ADD COLUMN IF NOT EXISTS dual_band_updated_at   timestamptz;

COMMENT ON COLUMN public.repid_agents.competence_score IS
  'Band A — Competence [0,1]: share of HAL quorum-confirmed-correct events. Source: repid_score_events(event_type=HAL_SCORE_EVENT, hal_decision=clean+hallucination_caught). INV-1: disjoint from integrity_score.';

COMMENT ON COLUMN public.repid_agents.competence_n IS
  'Sample size for competence_score: count of HAL_SCORE_EVENT rows with a non-null hal_decision.';

COMMENT ON COLUMN public.repid_agents.integrity_score IS
  'Band B — Integrity [0,1]: share of peer_verification_queue rows with verification_status=verified among finalized (verified|disputed). NEVER uses HAL veto as signal (INV-1: no self-veto circularity).';

COMMENT ON COLUMN public.repid_agents.integrity_n IS
  'Sample size for integrity_score: count of finalized (verified|disputed) peer_verification_queue rows for this agent as source.';

COMMENT ON COLUMN public.repid_agents.dual_band_updated_at IS
  'Timestamp of the last dual-band computation by computeAllDualBands() in src/services/dual-band.ts.';
