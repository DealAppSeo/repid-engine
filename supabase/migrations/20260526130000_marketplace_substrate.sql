-- RepID marketplace substrate — rent/sell agent listings. V2 SUBSTRATE.
-- ⚠️ NOT auto-applied. Surface to Sean / orchestrator; apply after greenlight (RULE-1, schema migration).
-- Safe/additive: new tables only, all IF NOT EXISTS. No changes to existing tables.
--
-- agent_listings: an agent owner lists an agent for rent or sale at a USDC price.
-- rental_records: a renter takes a listing for a window; the agent does work under the renter.
--
-- ⚠️ SETTLEMENT DISABLED (Phase 2 of marketplace). These tables record intent + lifecycle ONLY.
-- No money moves, nothing settles on-chain. Full UI/economics defer to TrustMarket.dev.
--
-- Convention: TEXT + CHECK constraints (not Postgres ENUM types) per repo convention.

CREATE TABLE IF NOT EXISTS agent_listings (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL,
  owner_sbt_id TEXT NOT NULL,
  listing_type TEXT NOT NULL
    CHECK (listing_type IN ('rent','sell')),
  price_usdc NUMERIC NOT NULL,
  rep_id_at_listing INT NOT NULL,
  rental_duration_hours INT,                         -- only meaningful for listing_type='rent'
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','sold','rented_out')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_listings_status ON agent_listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_listings_agent ON agent_listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_listings_owner ON agent_listings(owner_sbt_id);

CREATE TABLE IF NOT EXISTS rental_records (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES agent_listings(id),
  renter_sbt_id TEXT NOT NULL,
  target_squad_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  rep_id_earned_during_rental INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN rental_records.rep_id_earned_during_rental IS
  'RepID earned during rental attributes to the AGENT, not the renter.';

CREATE INDEX IF NOT EXISTS idx_rental_records_listing ON rental_records(listing_id);
CREATE INDEX IF NOT EXISTS idx_rental_records_renter ON rental_records(renter_sbt_id);

ALTER TABLE agent_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_records ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_listings' AND policyname='service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON agent_listings FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rental_records' AND policyname='service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON rental_records FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
