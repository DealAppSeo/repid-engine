-- First pass vs HAL on hal_quorum_validator_votes.
-- Staged DDL. This file does not apply itself and does not enable the writer.
-- Sean co-sign required before apply_migration.
--
-- Existing rows gain null pass columns, which satisfies the check:
-- a post-HAL value requires a TRUE or FALSE first pass and its timestamp.

ALTER TABLE public.hal_quorum_validator_votes
  ADD COLUMN IF NOT EXISTS host text,
  ADD COLUMN IF NOT EXISTS first_pass_verdict text,
  ADD COLUMN IF NOT EXISTS first_pass_at timestamptz,
  ADD COLUMN IF NOT EXISTS post_hal_verdict text,
  ADD COLUMN IF NOT EXISTS post_hal_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hal_quorum_votes_post_requires_first_pass'
  ) THEN
    ALTER TABLE public.hal_quorum_validator_votes
      ADD CONSTRAINT hal_quorum_votes_post_requires_first_pass
      CHECK (
        (post_hal_verdict IS NULL AND post_hal_at IS NULL)
        OR (
          first_pass_verdict IN ('TRUE', 'FALSE')
          AND first_pass_at IS NOT NULL
        )
      );
  END IF;
END $$;
