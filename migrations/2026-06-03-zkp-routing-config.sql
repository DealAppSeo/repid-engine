-- R2 / prior ZKP: zkp_routing_config (fast_groth16 vs plonky3_stark classification)
-- DDL via apply_migration. Idempotent.
CREATE TABLE IF NOT EXISTS public.zkp_routing_config (
  proof_type text PRIMARY KEY,
  active boolean NOT NULL DEFAULT true,
  zkp_system text NOT NULL CHECK (zkp_system IN ('fast_groth16','plonky3_stark')),
  sensitivity numeric(3,2) DEFAULT 0.5,
  frequency text,
  regulatory_tag text,
  pre_stageable boolean DEFAULT false,
  max_frequency_per_day integer,
  notes text,
  updated_at timestamptz DEFAULT now()
);

-- Seed split (POSTCARD low-sens -> fast; high sens/reg -> plonky3)
INSERT INTO public.zkp_routing_config (proof_type, zkp_system, sensitivity, regulatory_tag, notes)
VALUES
  ('POSTCARD', 'fast_groth16', 0.3, 'identity-integrity', 'low sens, high volume from drain; cheap path'),
  ('ENVELOPE', 'plonky3_stark', 0.7, 'compliance', 'higher sens'),
  ('PACKAGE', 'plonky3_stark', 0.9, 'reg-high', 'regulatory or high-stakes')
ON CONFLICT (proof_type) DO UPDATE SET
  zkp_system = EXCLUDED.zkp_system,
  sensitivity = EXCLUDED.sensitivity,
  notes = EXCLUDED.notes,
  updated_at = now();

-- After apply: SELECT * FROM zkp_routing_config; router logs per-proof decision.
