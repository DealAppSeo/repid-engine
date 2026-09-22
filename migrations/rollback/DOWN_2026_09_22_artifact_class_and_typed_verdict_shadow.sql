-- Rollback for 2026_09_22_artifact_class_and_typed_verdict_shadow.sql
--
-- READ BEFORE RUNNING. This is not symmetric with the UP, and it cannot be.
--
-- Dropping `typed_verdict_shadow` DESTROYS the observations. That is the whole
-- reason the layer exists — the log IS the deliverable — so a rollback that runs
-- it unthinkingly throws away the measurement and leaves the question ("what would
-- a typed rule have escalated?") exactly where it started.
--
-- If you are rolling back because the shadow was noisy or wrong, you want the flag
-- OFF (unset TYPED_VERDICT_SHADOW_ENABLED), not this file: with the flag off the
-- module performs no reads and no writes, and the rows already collected survive.
--
-- Run this only to undo a MISTAKEN application of the migration itself.

BEGIN;

-- Copy anything already observed before dropping it. Costs nothing when the table
-- is empty, and is the difference between a reversible mistake and a lost dataset.
CREATE TABLE IF NOT EXISTS public.typed_verdict_shadow_archived_20260922
  AS SELECT * FROM public.typed_verdict_shadow;

DROP TABLE IF EXISTS public.typed_verdict_shadow;

-- `artifact_class` is dropped with its constraint and index (DROP COLUMN takes
-- both). Any value an author set is lost; there is nowhere else it is recorded.
DROP INDEX IF EXISTS public.idx_trinity_tasks_artifact_class;

ALTER TABLE public.trinity_tasks
  DROP CONSTRAINT IF EXISTS trinity_tasks_artifact_class_check;

ALTER TABLE public.trinity_tasks
  DROP COLUMN IF EXISTS artifact_class;

COMMIT;
