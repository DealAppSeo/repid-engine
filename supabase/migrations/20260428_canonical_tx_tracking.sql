ALTER TABLE repid_agents 
ADD COLUMN IF NOT EXISTS last_canonical_tx TEXT,
ADD COLUMN IF NOT EXISTS last_canonical_status TEXT;
