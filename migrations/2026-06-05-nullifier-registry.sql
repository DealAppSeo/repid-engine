-- Nullifier registry for anonymous-ownership proofs (P1.2, SPRINT_CC_2_2026-06-05).
-- Records the public, context-scoped nullifier of each accepted ownership proof so
-- that a SECOND action by the same human in the SAME context is detected
-- (double-action), while the SAME nullifier in DIFFERENT contexts is allowed
-- (unlinkability is preserved — see D-020 / the anon-ownership circuit, PR #96).
--
-- Service-role-only (additive), consistent with the RLS lockdown. Sean/XC apply.
-- Rollback at the bottom.

CREATE TABLE IF NOT EXISTS public.nullifier_registry (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  context       numeric      NOT NULL,   -- the external nullifier / action context
  nullifier     numeric      NOT NULL,   -- H(secret, context), public output of the proof
  proof_digest  text,                    -- keccak256(proof_bytes), optional link to the proof
  anchor_tx     text,                    -- Base Sepolia anchor tx hash, if anchored
  created_at    timestamptz  NOT NULL DEFAULT now(),
  -- THE double-action guard: one nullifier may be used at most once per context.
  CONSTRAINT nullifier_registry_context_nullifier_key UNIQUE (context, nullifier)
);

-- Same nullifier across different contexts is intentionally allowed (unlinkable);
-- only (context, nullifier) reuse is rejected.
CREATE INDEX IF NOT EXISTS nullifier_registry_nullifier_idx
  ON public.nullifier_registry (nullifier);

ALTER TABLE public.nullifier_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON public.nullifier_registry;
CREATE POLICY "service_role_all" ON public.nullifier_registry
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Helper: returns true if the action is NEW (and records it), false if it is a
-- double-action in this context. Service-role only (SECURITY DEFINER not needed —
-- writers are the service-role engine).
CREATE OR REPLACE FUNCTION public.register_nullifier(
  p_context numeric, p_nullifier numeric, p_proof_digest text DEFAULT NULL, p_anchor_tx text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.nullifier_registry (context, nullifier, proof_digest, anchor_tx)
  VALUES (p_context, p_nullifier, p_proof_digest, p_anchor_tx);
  RETURN true;   -- first action in this context
EXCEPTION WHEN unique_violation THEN
  RETURN false;  -- double-action detected
END;
$$;

-- Post-apply verify (Sean):
--   SELECT public.register_nullifier(9001, 531345275);  -- expect true
--   SELECT public.register_nullifier(9001, 531345275);  -- expect false (double-action)
--   SELECT public.register_nullifier(9002, 531345275);  -- expect true (different context)

-- Rollback:
--   DROP FUNCTION IF EXISTS public.register_nullifier(numeric, numeric, text, text);
--   DROP TABLE IF EXISTS public.nullifier_registry;
