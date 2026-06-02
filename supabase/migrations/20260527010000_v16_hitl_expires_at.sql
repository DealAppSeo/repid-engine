-- V1.6 (CC2 2026-05-27): expires_at column for the approve/deny TTL sweeper.
-- Additive nullable column; existing pending rows keep expires_at=NULL and are
-- unaffected by the sweeper (which only acts on rows WHERE expires_at IS NOT NULL
-- AND expires_at < now()). New HITL rows pick up the 24h default automatically.
-- Already applied to prod via Supabase MCP; kept here for review/reproducibility.

ALTER TABLE trinity_hitl_requests
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (now() + interval '24 hours');

CREATE INDEX IF NOT EXISTS idx_hitl_req_pending_expiring
  ON trinity_hitl_requests(expires_at)
  WHERE status='pending' AND expires_at IS NOT NULL;
