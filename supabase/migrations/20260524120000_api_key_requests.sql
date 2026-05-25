-- API key issuance V0 — request intake queue + additive key metadata.
-- ⚠️ NOT auto-applied. Surface to Sean; apply after greenlight (RULE-1, schema migration).
-- Safe/additive: new table + IF NOT EXISTS columns. agent_api_keys.last_used_at already exists (skipped).
--
-- api_key_requests holds developer emails → RLS service_role-ONLY (no anon/authenticated read),
-- following the 2026-05-23 RLS-curation lesson (don't expose PII via the anon key).

CREATE TABLE IF NOT EXISTS api_key_requests (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  use_case TEXT NOT NULL,
  organization TEXT,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | provisioned | rejected
  notes TEXT,
  api_key_hash TEXT,                                -- set on provision (hash only, never plaintext)
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  provisioned_at TIMESTAMPTZ,
  rejected_reason TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_status ON api_key_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_requests_email ON api_key_requests(email);

ALTER TABLE api_key_requests ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='api_key_requests' AND policyname='service_role_full_access') THEN
    CREATE POLICY "service_role_full_access" ON api_key_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Additive metadata on agent_api_keys (tier/rate-limit/expiry/link to request).
-- last_used_at already exists on this table → intentionally not re-added.
ALTER TABLE agent_api_keys
  ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'testnet',
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute INT DEFAULT 60,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS request_id BIGINT REFERENCES api_key_requests(id);
