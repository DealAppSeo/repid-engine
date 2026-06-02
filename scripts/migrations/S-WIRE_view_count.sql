-- S-WIRE — share-page view counter for trustchat_sessions. Additive, applied via Supabase MCP.
-- ROLLBACK: ALTER TABLE trustchat_sessions DROP COLUMN IF EXISTS view_count;
ALTER TABLE trustchat_sessions ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0;
