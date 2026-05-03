-- Daily Merkle anchor records for hal_audit_chain.
-- Each row records one day's worth of audit entries reduced to a single
-- 32-byte keccak256 Merkle root, and (when successfully sent) the
-- Base Sepolia transaction that committed that root on-chain.
--
-- anchor_date is UNIQUE — re-running the cron for the same date upserts.
-- status values produced by src/services/audit-merkle-anchor.ts:
--   'sent'              tx broadcast successfully
--   'no_entries'        zero rows for that date — persisted as ZeroHash
--   'pending_retry'     compute or send failed, will retry next cron
--   'failed_persist'    tx sent but DB write failed (operator follow-up)
--   'failed_no_wallet'  no AUDIT_ANCHOR_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY

CREATE TABLE IF NOT EXISTS audit_merkle_anchors (
  id BIGSERIAL PRIMARY KEY,
  anchor_date DATE NOT NULL UNIQUE,
  merkle_root TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  first_audit_id BIGINT,
  last_audit_id BIGINT,
  tx_hash TEXT,
  basescan_url TEXT,
  anchored_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_audit_merkle_anchors_status
  ON audit_merkle_anchors(status);

CREATE INDEX IF NOT EXISTS idx_audit_merkle_anchors_anchored_at
  ON audit_merkle_anchors(anchored_at);
