-- DOWN_2026-09-04-work-statement-bind.sql
-- Reverses migrations/2026-09-04-work-statement-bind.sql
-- Additive reverse: drops the NEW trigger/functions/view/columns.
-- Does NOT drop work_statement_hash (that column pre-existed).
-- Does NOT delete rows. Does NOT touch RepID.

BEGIN;

DROP TRIGGER IF EXISTS trg_service_contracts_work_statement ON public.service_contracts;
DROP FUNCTION IF EXISTS public.enforce_work_statement_bind();
DROP FUNCTION IF EXISTS public.normalize_work_statement(jsonb);
DROP FUNCTION IF EXISTS public.work_statement_sha256(jsonb);
DROP FUNCTION IF EXISTS public.work_statement_canonical_text(jsonb);
DROP VIEW IF EXISTS public.v_service_contracts_work_statement;

ALTER TABLE public.service_contracts
  DROP COLUMN IF EXISTS criterion_ratings,
  DROP COLUMN IF EXISTS work_statement_bound_at,
  DROP COLUMN IF EXISTS work_statement;

COMMIT;
