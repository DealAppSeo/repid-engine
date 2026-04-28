-- ============================================================================
-- Reponomics — full-account (email + password) support
--
-- Builds on the anonymous-builder migration. Adds:
--   - email + password_hash      → email/password signup (auth_method='email')
--   - trading_provider           → 'alpaca_rest' | 'alpaca_mcp' | NULL
--   - trading_credentials_encrypted → JSONB blob (AES-256-GCM ciphertext)
--   - trading_paper_account_id   → opaque account id from broker
--   - agent_count                → denormalized count of repid_agents owned
--   - notification_prefs         → JSONB { channel, destination, agent_trade_caps }
--
-- All additive, IF NOT EXISTS guards. The unique-email index is partial so
-- existing wallet-only and token-only rows (email IS NULL) are unaffected.
-- ============================================================================

ALTER TABLE builders ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE builders ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE builders ADD COLUMN IF NOT EXISTS trading_provider TEXT;
-- trading_provider: 'alpaca_rest' | 'alpaca_mcp' | NULL
ALTER TABLE builders ADD COLUMN IF NOT EXISTS trading_credentials_encrypted JSONB;
ALTER TABLE builders ADD COLUMN IF NOT EXISTS trading_paper_account_id TEXT;
ALTER TABLE builders ADD COLUMN IF NOT EXISTS agent_count INTEGER DEFAULT 0;
ALTER TABLE builders ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_builders_email
  ON builders(LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_builders_trading_provider
  ON builders(trading_provider);

-- ============================================================================
-- paper_trade_orders — joins a linked_bet to the broker's order id so
-- the resolver knows which orders to poll and how to map fills back to
-- bet outcomes. Soft FK to linked_bets.id (TEXT primary key there).
-- ============================================================================

CREATE TABLE IF NOT EXISTS paper_trade_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id              TEXT NOT NULL,
  builder_id          UUID NOT NULL,
  agent_id            UUID NOT NULL,
  provider            TEXT NOT NULL,                            -- 'alpaca_rest' | 'alpaca_mcp'
  alpaca_order_id     TEXT,
  symbol              TEXT NOT NULL,
  qty                 NUMERIC(20, 8) NOT NULL,
  side                TEXT NOT NULL,                            -- 'buy' | 'sell'
  type                TEXT NOT NULL DEFAULT 'market',           -- 'market' | 'limit'
  limit_price         NUMERIC(20, 8),
  notional_estimate   NUMERIC(20, 2),
  cap_pct_at_open     INTEGER,
  status              TEXT NOT NULL DEFAULT 'open',             -- open | filled | resolved | cancelled
  filled_qty          NUMERIC(20, 8),
  filled_avg_price    NUMERIC(20, 8),
  pnl                 NUMERIC(20, 2),
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_trade_orders_status
  ON paper_trade_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trade_orders_builder
  ON paper_trade_orders(builder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trade_orders_bet
  ON paper_trade_orders(bet_id);
