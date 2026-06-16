-- STAGED — Sean applies via Supabase. Decouples human-trigger from action threshold per SBFA v0.2 §2.5.
--
-- Adds hal_hitl_threshold to repid_config:
--   hal_hitl_threshold  (numeric, default 0.30) — HAL score ceiling that triggers a human review
--                        request, separate from hal_veto_threshold (the action gate).
--
-- Intent:
--   hal_veto_threshold  controls whether HAL vetoes/challenges the deliverable (action).
--   hal_hitl_threshold  controls whether a HITL human review request is enqueued (trigger).
--   Typically hal_hitl_threshold < hal_veto_threshold so borderline cases reach a human
--   before HAL would auto-veto them.
--
-- Additive, idempotent (INSERT ... ON CONFLICT DO NOTHING).
-- Safe to apply to production without downtime.
--
-- Rollback: DELETE FROM repid_config WHERE key = 'hal_hitl_threshold';

INSERT INTO repid_config (key, value, description, updated_at)
VALUES (
  'hal_hitl_threshold',
  '0.30',
  'HAL score below which a HITL review request is created (human-trigger gate). Distinct from hal_veto_threshold (action gate). Lower value = more human oversight. Per SBFA v0.2 §2.5.',
  NOW()
)
ON CONFLICT (key) DO NOTHING;
