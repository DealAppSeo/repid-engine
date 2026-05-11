-- ================================================================
-- CC Sprint 2 — additive columns on user_api_keys for BYOK bypass lookup
-- 2026-05-11
-- ================================================================
-- The `user_api_keys` table already exists (created by Gemini's BYOK
-- MVP merged via 13fb2c9). Verified schema as of 2026-05-11 morning:
--   id uuid, user_id uuid NOT NULL, provider_name text NOT NULL,
--   encrypted_api_key text NOT NULL, key_status text default 'active',
--   usage_count int, last_used_at, created_at, updated_at
--
-- For rate-limit BYOK bypass we need O(1) lookup by key hash. The
-- existing encrypted_api_key cannot be used for lookup (would require
-- decrypting every row per request). We add:
--   - key_hash    text — SHA-256 of the raw key (after 'hdg_byok_' prefix
--                       if applicable), used for O(1) bypass lookup
--   - key_prefix  text — first 8 chars of the raw key for display + log
--
-- Both nullable for backfill compatibility (existing rows have 0 today).
-- New BYOK key inserts MUST populate both. The unique index is partial
-- so multiple NULLs are allowed but real hashes must be unique.
-- ================================================================

BEGIN;

ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS key_hash text,
  ADD COLUMN IF NOT EXISTS key_prefix text;

-- O(1) lookup for rate-limiter BYOK bypass; uniqueness on non-null hashes.
CREATE UNIQUE INDEX IF NOT EXISTS user_api_keys_key_hash_active_idx
  ON public.user_api_keys (key_hash)
  WHERE key_hash IS NOT NULL AND key_status = 'active';

-- Read-side index for revocation status filter
CREATE INDEX IF NOT EXISTS user_api_keys_status_idx
  ON public.user_api_keys (key_status)
  WHERE key_status <> 'active';

-- Note: RLS was already enabled on this table by Gemini's BYOK migration.
-- We don't re-enable here. service_role bypasses RLS for the rate limiter.

COMMIT;

-- Rollback:
--   DROP INDEX IF EXISTS public.user_api_keys_status_idx;
--   DROP INDEX IF EXISTS public.user_api_keys_key_hash_active_idx;
--   ALTER TABLE public.user_api_keys DROP COLUMN IF EXISTS key_prefix;
--   ALTER TABLE public.user_api_keys DROP COLUMN IF EXISTS key_hash;
