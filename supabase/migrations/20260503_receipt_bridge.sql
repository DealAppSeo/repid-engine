-- HyperDAG RepID Trust Receipt Bridge — v1.0
-- Sprint: feat/receipt-bridge-v1-2026-05-03
-- Purpose: persist off-chain receipt JSON + hash fields produced by
--   src/services/receipt-issuer.ts. The on-chain HyperDAGReceiptAdapter
--   emits ReceiptCommitted / ReceiptRevealed; an indexer (Gemini's parallel
--   sprint) backfills contract_tx_hash + invalidated_at from those events.
--
-- DO NOT APPLY AUTOMATICALLY. Sean reviews and runs.
-- Schema-first per CLAUDE-RULE-5: this migration assumes no existing
-- `hyperdag_receipts`, `trust_receipts`, or `receipts` table. Verified via
-- repo audit on 2026-05-03; no conflicts.

CREATE TABLE IF NOT EXISTS hyperdag_receipts (
  receipt_id            text PRIMARY KEY,
  agent_id              bigint NOT NULL,
  x402_payment_hash     text NOT NULL,
  task_hash             text NOT NULL,
  result_hash           text NOT NULL,
  rep_id_commitment     text NOT NULL,
  hal_dof_version       smallint NOT NULL CHECK (hal_dof_version IN (5, 6)),
  hal_output_hash       text NOT NULL,
  hal_bounded_score     numeric NOT NULL,
  hal_comma_bft_verdict smallint NOT NULL CHECK (hal_comma_bft_verdict IN (0, 1, 2)),
  hal_dimensions_hash   text NOT NULL,
  human_identity_root   text,
  receipt_uri           text NOT NULL DEFAULT '',
  receipt_uri_hash      text,
  receipt_content_hash  text NOT NULL,
  score_version         integer NOT NULL,
  status                smallint NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2)),
  contract_receipt_id   text,
  contract_tx_hash      text,
  contract_block_number bigint,
  committer_address     text NOT NULL,
  receipt_json          jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  invalidated_at        timestamptz,
  invalidation_reason   text
);

CREATE INDEX IF NOT EXISTS hyperdag_receipts_agent_id_idx
  ON hyperdag_receipts (agent_id);

CREATE INDEX IF NOT EXISTS hyperdag_receipts_x402_payment_hash_idx
  ON hyperdag_receipts (x402_payment_hash);

CREATE INDEX IF NOT EXISTS hyperdag_receipts_status_idx
  ON hyperdag_receipts (status);

CREATE INDEX IF NOT EXISTS hyperdag_receipts_created_at_idx
  ON hyperdag_receipts (created_at DESC);

CREATE INDEX IF NOT EXISTS hyperdag_receipts_contract_receipt_id_idx
  ON hyperdag_receipts (contract_receipt_id)
  WHERE contract_receipt_id IS NOT NULL;

COMMENT ON TABLE hyperdag_receipts IS
  'HyperDAG RepID Trust Receipts (v1.0). receipt_id is the off-chain content hash; contract_receipt_id is the on-chain receiptId assigned at HyperDAGReceiptAdapter.revealReceipt time.';
COMMENT ON COLUMN hyperdag_receipts.hal_comma_bft_verdict IS
  '0=pass, 1=veto (P-003 Pythagorean Comma BFT critical), 2=indeterminate';
COMMENT ON COLUMN hyperdag_receipts.status IS
  '0=active, 1=invalidated, 2=disputed';
