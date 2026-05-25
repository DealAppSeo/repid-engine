-- Create license_tier type if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'squad_license_tier') THEN
    CREATE TYPE squad_license_tier AS ENUM ('free_federated', 'licensed_silo', 'hybrid');
  END IF;
END$$;

-- Create squad table
CREATE TABLE IF NOT EXISTS public.squad (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  owner_human_sbt_id TEXT REFERENCES public.human_sbt_registry(token_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fractionalized BOOLEAN NOT NULL DEFAULT FALSE,
  federated_optin BOOLEAN NOT NULL DEFAULT FALSE,
  license_tier squad_license_tier NOT NULL DEFAULT 'free_federated'
);

-- Enable Row Level Security
ALTER TABLE public.squad ENABLE ROW LEVEL SECURITY;

-- Policies for squad
DROP POLICY IF EXISTS squad_select ON public.squad;
CREATE POLICY squad_select ON public.squad FOR SELECT USING (true);

DROP POLICY IF EXISTS squad_all ON public.squad;
CREATE POLICY squad_all ON public.squad FOR ALL USING (true) WITH CHECK (true);

-- Insert default squads
INSERT INTO public.squad (id, name, owner_human_sbt_id, license_tier) VALUES
  ('550e8400-e29b-41d4-a716-446655440001', 'Alpha Squad', 'SBT-HUMAN-CEO-001', 'free_federated'),
  ('550e8400-e29b-41d4-a716-446655440002', 'Beta Squad', 'SBT-HUMAN-CEO-001', 'free_federated'),
  ('550e8400-e29b-41d4-a716-446655440003', 'Gamma Squad', 'SBT-HUMAN-CEO-001', 'free_federated'),
  ('550e8400-e29b-41d4-a716-446655440004', 'Orchestration Squad', 'SBT-HUMAN-CEO-001', 'free_federated')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  owner_human_sbt_id = EXCLUDED.owner_human_sbt_id,
  license_tier = EXCLUDED.license_tier;

-- Create squad_membership table
CREATE TABLE IF NOT EXISTS public.squad_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id UUID NOT NULL REFERENCES public.squad(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.repid_agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('primary', 'secondary', 'tertiary', 'member', 'triad_member', 'spokesperson', 'external', 'test')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  is_delegate BOOLEAN NOT NULL DEFAULT FALSE
);

-- Enable Row Level Security
ALTER TABLE public.squad_membership ENABLE ROW LEVEL SECURITY;

-- Policies for squad_membership
DROP POLICY IF EXISTS squad_membership_select ON public.squad_membership;
CREATE POLICY squad_membership_select ON public.squad_membership FOR SELECT USING (true);

DROP POLICY IF EXISTS squad_membership_all ON public.squad_membership;
CREATE POLICY squad_membership_all ON public.squad_membership FOR ALL USING (true) WITH CHECK (true);

-- Create unique index to ensure an agent can only be in one active squad at a time
CREATE UNIQUE INDEX IF NOT EXISTS squad_membership_active_agent_idx 
ON public.squad_membership (agent_id) 
WHERE (left_at IS NULL);

-- Backfill existing squad mappings into squad_membership
INSERT INTO public.squad_membership (squad_id, agent_id, role, joined_at, is_delegate)
SELECT 
  CASE 
    WHEN squad_id = 'alpha' THEN '550e8400-e29b-41d4-a716-446655440001'::uuid
    WHEN squad_id = 'beta' THEN '550e8400-e29b-41d4-a716-446655440002'::uuid
    WHEN squad_id = 'gamma' THEN '550e8400-e29b-41d4-a716-446655440003'::uuid
    WHEN squad_id = 'orchestration' THEN '550e8400-e29b-41d4-a716-446655440004'::uuid
  END as squad_uuid,
  id as agent_id,
  COALESCE(squad_role, 'member') as role,
  COALESCE(joined_squad_at, NOW()) as joined_at,
  CASE 
    WHEN agent_name IN ('trinity-gcm', 'trinity-mel', 'trinity-hdm', 'trinity-orch') THEN TRUE
    ELSE FALSE
  END as is_delegate
FROM public.repid_agents
WHERE squad_id IN ('alpha', 'beta', 'gamma', 'orchestration')
ON CONFLICT DO NOTHING;

-- Alter repid_agents.squad_id type to UUID and add FK constraint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'repid_agents' AND column_name = 'squad_id' AND data_type = 'text'
  ) THEN
    ALTER TABLE public.repid_agents RENAME COLUMN squad_id TO squad_id_old;
    ALTER TABLE public.repid_agents ADD COLUMN squad_id UUID REFERENCES public.squad(id);

    UPDATE public.repid_agents SET squad_id = 
      CASE 
        WHEN squad_id_old = 'alpha' THEN '550e8400-e29b-41d4-a716-446655440001'::uuid
        WHEN squad_id_old = 'beta' THEN '550e8400-e29b-41d4-a716-446655440002'::uuid
        WHEN squad_id_old = 'gamma' THEN '550e8400-e29b-41d4-a716-446655440003'::uuid
        WHEN squad_id_old = 'orchestration' THEN '550e8400-e29b-41d4-a716-446655440004'::uuid
        ELSE NULL
      END;

    ALTER TABLE public.repid_agents DROP COLUMN squad_id_old;
  END IF;
END$$;

-- Create squad_internal_attestations table
CREATE TABLE IF NOT EXISTS public.squad_internal_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id UUID NOT NULL REFERENCES public.squad(id) ON DELETE CASCADE,
  response_id UUID NOT NULL,
  attesting_agent_id UUID NOT NULL REFERENCES public.repid_agents(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  attestation_type TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.squad_internal_attestations ENABLE ROW LEVEL SECURITY;

-- Policies for squad_internal_attestations
DROP POLICY IF EXISTS squad_internal_attestations_select ON public.squad_internal_attestations;
CREATE POLICY squad_internal_attestations_select ON public.squad_internal_attestations FOR SELECT USING (true);

DROP POLICY IF EXISTS squad_internal_attestations_all ON public.squad_internal_attestations;
CREATE POLICY squad_internal_attestations_all ON public.squad_internal_attestations FOR ALL USING (true) WITH CHECK (true);

-- Create rep_id_provenance table
CREATE TABLE IF NOT EXISTS public.rep_id_provenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.repid_agents(id) ON DELETE CASCADE,
  squad_id UUID REFERENCES public.squad(id) ON DELETE SET NULL,
  increment_amount INTEGER NOT NULL,
  source_event_id BIGINT REFERENCES public.repid_score_events(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.rep_id_provenance ENABLE ROW LEVEL SECURITY;

-- Policies for rep_id_provenance
DROP POLICY IF EXISTS rep_id_provenance_select ON public.rep_id_provenance;
CREATE POLICY rep_id_provenance_select ON public.rep_id_provenance FOR SELECT USING (true);

DROP POLICY IF EXISTS rep_id_provenance_all ON public.rep_id_provenance;
CREATE POLICY rep_id_provenance_all ON public.rep_id_provenance FOR ALL USING (true) WITH CHECK (true);

-- Backfill rep_id_provenance from existing repid_score_events
INSERT INTO public.rep_id_provenance (agent_id, squad_id, increment_amount, source_event_id, source_type, earned_at)
SELECT 
  e.agent_id,
  a.squad_id,
  e.delta,
  e.id,
  e.event_type,
  COALESCE(e.created_at, NOW())
FROM public.repid_score_events e
JOIN public.repid_agents a ON e.agent_id = a.id
ON CONFLICT DO NOTHING;
