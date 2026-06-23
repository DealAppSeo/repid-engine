-- Migration: Create identity_claims table for handle claims
-- Created: 2026-06-18

CREATE TABLE IF NOT EXISTS public.identity_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_did TEXT NOT NULL,
  handle_type TEXT NOT NULL,
  handle_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimable',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_handle_type_hash UNIQUE (handle_type, handle_hash)
);

CREATE INDEX IF NOT EXISTS idx_identity_claims_holder_did ON public.identity_claims(holder_did);
