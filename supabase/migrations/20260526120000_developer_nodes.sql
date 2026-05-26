-- Federated developer-node onboarding — V2 SUBSTRATE.
-- ⚠️ NOT auto-applied. Surface to Sean / orchestrator; apply after greenlight (RULE-1, schema migration).
-- Safe/additive: new tables only, all IF NOT EXISTS. No changes to existing tables.
--
-- developer_nodes registers a federated developer's node (a self-hosted squad runner).
-- federation_events is the per-node event stream (federated-learning event submissions).
-- Both hold operator contact + node URLs → RLS service_role-ONLY (no anon/authenticated access),
-- following the 2026-05-23 RLS-curation lesson (don't expose operator PII / node topology via the anon key).
--
-- Convention: TEXT + CHECK constraints (not Postgres ENUM types) per repo convention.

CREATE TABLE IF NOT EXISTS developer_nodes (
  id BIGSERIAL PRIMARY KEY,
  owner_email TEXT NOT NULL,
  sbt_id TEXT,                                       -- optional SBT identity; set once node verifies
  node_url TEXT NOT NULL,
  license_tier TEXT NOT NULL DEFAULT 'free_federated'
    CHECK (license_tier IN ('free_federated','licensed_silo')),
  federated_optin BOOLEAN NOT NULL DEFAULT false,    -- must be true to submit federated events
  squad_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','suspended')),
  challenge_nonce TEXT,                              -- issued at register; node echoes back to verify reachability
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_developer_nodes_status ON developer_nodes(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_developer_nodes_owner_email ON developer_nodes(owner_email);

CREATE TABLE IF NOT EXISTS federation_events (
  id BIGSERIAL PRIMARY KEY,
  node_id BIGINT REFERENCES developer_nodes(id),
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_federation_events_node ON federation_events(node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_federation_events_type ON federation_events(event_type, created_at DESC);

ALTER TABLE developer_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='developer_nodes' AND policyname='service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON developer_nodes FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='federation_events' AND policyname='service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON federation_events FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
