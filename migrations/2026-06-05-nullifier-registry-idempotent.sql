-- Nullifier registry for anonymous-ownership proofs (SPRINT_CC_3 P3).
-- FULLY IDEMPOTENT — safe to re-run. Service-role-only (consistent with RLS lockdown).
-- DONE-CHECK: to_regclass('public.nullifier_registry') is non-null;
--   double-insert of the same (context, nullifier) raises 23505.

CREATE TABLE IF NOT EXISTS public.nullifier_registry (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  context       numeric      NOT NULL,
  nullifier     numeric      NOT NULL,
  proof_digest  text,
  anchor_tx     text,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- THE double-action guard (idempotent add): one nullifier per context.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nullifier_registry_context_nullifier_key'
      AND conrelid = 'public.nullifier_registry'::regclass
  ) THEN
    ALTER TABLE public.nullifier_registry
      ADD CONSTRAINT nullifier_registry_context_nullifier_key UNIQUE (context, nullifier);
  END IF;
END $$;

-- Same nullifier across DIFFERENT contexts is allowed (unlinkable); only
-- (context, nullifier) reuse is rejected.
CREATE INDEX IF NOT EXISTS nullifier_registry_nullifier_idx
  ON public.nullifier_registry (nullifier);

ALTER TABLE public.nullifier_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.nullifier_registry;
CREATE POLICY "service_role_all" ON public.nullifier_registry
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Returns true if the action is NEW (and records it), false on double-action.
CREATE OR REPLACE FUNCTION public.register_nullifier(
  p_context numeric, p_nullifier numeric, p_proof_digest text DEFAULT NULL, p_anchor_tx text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.nullifier_registry (context, nullifier, proof_digest, anchor_tx)
  VALUES (p_context, p_nullifier, p_proof_digest, p_anchor_tx);
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false;
END;
$$;

-- Rollback:
--   DROP FUNCTION IF EXISTS public.register_nullifier(numeric, numeric, text, text);
--   DROP TABLE IF EXISTS public.nullifier_registry;
