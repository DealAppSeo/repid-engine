-- =============================================================================
-- HAL shadow threshold keys (XC #24, sprint-2026-07-12-ecosystem)
-- Additive only. Does NOT change live hal_veto_threshold / hal_block_threshold.
-- Apply only via Sean co-sign / apply_migration. Default: staged on branch.
-- Rollback: DELETE FROM repid_config WHERE key IN (...shadow keys...);
-- =============================================================================

-- Shadow mirrors of live HAL thresholds for review-before-promote autotune.
INSERT INTO public.repid_config (key, value, min_value, max_value, conductor_tunable, requires_vote, auto_tunable, description, updated_by)
VALUES
  (
    'hal_veto_threshold_shadow',
    '0.43',
    0.25,
    0.70,
    true,
    false,
    true,
    'SHADOW only — proposed HAL veto threshold from shadow-threshold-autotune. Never read by live scoring. Sean promotes by copying to hal_veto_threshold after review.',
    'xc-2026-07-13-shadow-autotune'
  ),
  (
    'hal_block_threshold_shadow',
    '0.55',
    0.30,
    0.85,
    true,
    false,
    true,
    'SHADOW only — proposed HAL block threshold. Never read by live scoring.',
    'xc-2026-07-13-shadow-autotune'
  ),
  (
    'hal_shadow_autotune_last_run',
    '',
    NULL,
    NULL,
    false,
    false,
    false,
    'ISO timestamp of last shadow autotune run (metadata).',
    'xc-2026-07-13-shadow-autotune'
  ),
  (
    'hal_shadow_autotune_enabled',
    'false',
    NULL,
    NULL,
    true,
    false,
    false,
    'When true, scripts/hal/shadow-threshold-autotune.ts may WRITE shadow keys. Default false = dry-run measure only.',
    'xc-2026-07-13-shadow-autotune'
  )
ON CONFLICT (key) DO NOTHING;

-- Optional: allow update_type to include shadow in app validation if constrained elsewhere.
-- No CHECK change on hal_threshold_updates in this migration (column is free text today).
