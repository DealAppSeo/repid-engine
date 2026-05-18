CREATE TABLE storage_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_contract_id UUID NOT NULL REFERENCES service_contracts(id),
  content_hash TEXT NOT NULL,  -- SHA-256 hex of content
  content_size_bytes BIGINT NOT NULL CHECK (content_size_bytes > 0),
  storage_path TEXT NOT NULL,   -- Supabase bucket path
  bucket_name TEXT NOT NULL DEFAULT 'artifact-storage',
  mime_type TEXT,
  retention_until TIMESTAMPTZ,  -- nullable = indefinite
  retrieval_count BIGINT NOT NULL DEFAULT 0,
  last_retrieved_at TIMESTAMPTZ,
  buyer_agent_id UUID NOT NULL REFERENCES repid_agents(id),
  provider_agent_id UUID NOT NULL REFERENCES repid_agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_storage_contracts_hash ON storage_contracts(content_hash);
CREATE INDEX idx_storage_contracts_buyer ON storage_contracts(buyer_agent_id);
CREATE INDEX idx_storage_contracts_provider ON storage_contracts(provider_agent_id);
CREATE INDEX idx_storage_contracts_service ON storage_contracts(service_contract_id);
CREATE INDEX idx_storage_contracts_active ON storage_contracts(deleted_at)
  WHERE deleted_at IS NULL;

INSERT INTO storage.buckets (id, name, public)
VALUES ('artifact-storage', 'artifact-storage', false)
ON CONFLICT DO NOTHING;
