-- Update hal_test_prompts.certainty_levels_to_test column default
-- to match the actual data shape that production writers use.
--
-- Background: the column was originally defaulted to a raw array
-- '[0.5, 0.7, 0.85, 0.95]'::jsonb, but all 26 production rows store
-- the value as {"test":[...]} objects. The default never applied to
-- existing rows, and the production reader at
-- src/services/hal-tester.ts silently fell back to 0.88 because
-- optional chaining ?.[0] on an object returns undefined.
--
-- This migration corrects the default; no data migration is needed.
-- The 26 existing rows are already in the {"test":[...]} shape.

ALTER TABLE public.hal_test_prompts
    ALTER COLUMN certainty_levels_to_test
    SET DEFAULT '{"test":[0.5,0.7,0.85,0.95]}'::jsonb;

-- Verify
SELECT column_name, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'hal_test_prompts'
   AND column_name = 'certainty_levels_to_test';
