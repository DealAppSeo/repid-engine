-- Staging bootstrap for an empty database.
-- CREATE TABLE IF NOT EXISTS only. This file is not applied by CI.

CREATE TABLE IF NOT EXISTS public.repid_agents (
  id uuid PRIMARY KEY,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.human_agent_binds (
  wallet text NOT NULL,
  agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet, agent_id)
);

CREATE TABLE IF NOT EXISTS public.stake_deposits (
  id uuid PRIMARY KEY,
  agent_id uuid,
  amount_usdc numeric,
  chain_id int NOT NULL DEFAULT 84532,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hal_quorum_receipts (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  claim_hash text
);

CREATE TABLE IF NOT EXISTS public.hal_quorum_validator_votes (
  receipt_id uuid,
  family text,
  host text,
  verdict text,
  first_pass_verdict text,
  first_pass_at timestamptz
);

ALTER TABLE public.repid_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_agent_binds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stake_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hal_quorum_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hal_quorum_validator_votes ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.repid_agents TO service_role;
GRANT ALL ON TABLE public.human_agent_binds TO service_role;
GRANT ALL ON TABLE public.stake_deposits TO service_role;
GRANT ALL ON TABLE public.hal_quorum_receipts TO service_role;
GRANT ALL ON TABLE public.hal_quorum_validator_votes TO service_role;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'repid_agents',
    'human_agent_binds',
    'stake_deposits',
    'hal_quorum_receipts',
    'hal_quorum_validator_votes'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND policyname = 'service_role_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY service_role_all ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        t
      );
    END IF;
  END LOOP;
END $$;

REVOKE SELECT, INSERT ON TABLE public.repid_agents FROM anon, PUBLIC;
REVOKE SELECT, INSERT ON TABLE public.human_agent_binds FROM anon, PUBLIC;
REVOKE SELECT, INSERT ON TABLE public.stake_deposits FROM anon, PUBLIC;
REVOKE SELECT, INSERT ON TABLE public.hal_quorum_receipts FROM anon, PUBLIC;
REVOKE SELECT, INSERT ON TABLE public.hal_quorum_validator_votes FROM anon, PUBLIC;
