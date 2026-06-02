-- S-SPINE — new app tables for the TrustChat viral surface.
-- Additive + RLS-enabled (service_role full; anon/authenticated denied). Applied via Supabase MCP.
-- ROLLBACK: DROP TABLE IF EXISTS comparison_votes, email_subscribers, referral_tracking CASCADE;

-- ── Phase 3: head-to-head comparison votes ─────────────────────────────
CREATE TABLE IF NOT EXISTS comparison_votes (
  id               BIGSERIAL PRIMARY KEY,
  session_id_left  UUID NOT NULL,
  session_id_right UUID NOT NULL,
  winner           TEXT NOT NULL CHECK (winner IN ('left','right','tie')),
  prompt           TEXT,
  voter_ip_hash    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE comparison_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comparison_votes_service_role_full ON comparison_votes;
CREATE POLICY comparison_votes_service_role_full ON comparison_votes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Phase 5: email subscribers ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_subscribers (
  id                 BIGSERIAL PRIMARY KEY,
  email              TEXT UNIQUE NOT NULL,
  source             TEXT CHECK (source IN ('trustchat','hub','trustshell','founding','other')),
  subscribed_at      TIMESTAMPTZ DEFAULT NOW(),
  unsubscribed_at    TIMESTAMPTZ,
  confirmed          BOOLEAN DEFAULT FALSE,
  confirmation_token UUID DEFAULT gen_random_uuid(),
  ref_code           TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE email_subscribers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_subscribers_service_role_full ON email_subscribers;
CREATE POLICY email_subscribers_service_role_full ON email_subscribers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Phase 6: referral tracking ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_tracking (
  id                  BIGSERIAL PRIMARY KEY,
  ref_code            TEXT NOT NULL,
  source_type         TEXT CHECK (source_type IN ('qr_code','share_link','email','social','direct')),
  landed_at           TIMESTAMPTZ DEFAULT NOW(),
  converted_to_session BOOLEAN DEFAULT FALSE,
  converted_to_email  BOOLEAN DEFAULT FALSE,
  session_id          UUID,
  user_agent          TEXT,
  ip_hash             TEXT
);
ALTER TABLE referral_tracking ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS referral_tracking_service_role_full ON referral_tracking;
CREATE POLICY referral_tracking_service_role_full ON referral_tracking FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_referral_tracking_ref_code ON referral_tracking (ref_code);
CREATE INDEX IF NOT EXISTS idx_email_subscribers_source ON email_subscribers (source);
