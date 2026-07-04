-- ============================================================================
-- BLIND 2-of-3 ADJUDICATION PANEL — peer_verification_votes table
-- ============================================================================
-- Branch: feat/cc-2026-07-03-peer-verify-panel
-- Author: CC (Claude), 2026-07-03
--
-- WHY: The legacy single-verifier peer-verification path paid +3 on a lone,
-- context-contaminated reviewer's 'verified' verdict — one opinion, no
-- correctness signal, gameable. This table backs a BLIND 2-of-3 panel: three
-- INDEPENDENT verifiers vote without seeing each other's verdicts; the 2-of-3
-- majority is the correctness signal that reward is honestly derived from.
--
-- ADDITIVE + NON-BREAKING: this is a NEW table. It does NOT touch
-- peer_verification_queue's existing single verifier_agent_id/verifier_response_id/
-- verifier_signature columns or the legacy /respond flow. When
-- PEER_VERIFY_PANEL_ENABLED is false (the default), nothing writes here and prod
-- behavior is byte-for-byte unchanged. Sean applies this migration BEFORE
-- enabling the flag.
--
-- Column-type note: source_response_id is uuid to match
-- peer_verification_queue.source_response_id (uuid). verifier_agent_id is uuid to
-- match repid_agents.id (uuid). Verified against live schema 2026-07-03.
-- ============================================================================

CREATE TABLE IF NOT EXISTS peer_verification_votes (
  id                  bigserial PRIMARY KEY,
  source_response_id  uuid NOT NULL,
  -- the claim being adjudicated; FK-shaped to peer_verification_queue.source_response_id
  queue_id            bigint,                    -- optional convenience link to peer_verification_queue.id
  verifier_agent_id   uuid NOT NULL,             -- repid_agents.id of the voting verifier
  verifier_agent_name text,                      -- denormalized for readability / audit
  provider            text,                      -- LLM provider used for this vote (independence axis)
  verdict             text NOT NULL,             -- 'verified' | 'disputed' | 'timeout'
  signature           text,                      -- HMAC over (source_response_id:verifier_response_id:verdict)
  verifier_response_id uuid,                      -- the verifier's own response artifact id
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT peer_verification_votes_verdict_chk
    CHECK (verdict IN ('verified','disputed','timeout')),

  -- BLIND-PANEL INTEGRITY: one vote per (claim, verifier). A verifier cannot
  -- stuff the ballot; a re-submission is idempotent-rejected by this constraint.
  CONSTRAINT peer_verification_votes_uniq
    UNIQUE (source_response_id, verifier_agent_id)
);

-- Consensus resolver reads all votes for a source_response_id.
CREATE INDEX IF NOT EXISTS idx_peer_verification_votes_source
  ON peer_verification_votes (source_response_id);

CREATE INDEX IF NOT EXISTS idx_peer_verification_votes_queue
  ON peer_verification_votes (queue_id);

-- ---------------------------------------------------------------------------
-- RLS: the whole DB is RLS-on (579/579 tables). Enable RLS and grant only the
-- service_role (the engine connects as service_role / DB owner). No anon /
-- authenticated policy — votes are engine-internal, like peer_verification_queue.
-- ---------------------------------------------------------------------------
ALTER TABLE peer_verification_votes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON peer_verification_votes FROM anon, authenticated;
GRANT ALL ON peer_verification_votes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE peer_verification_votes_id_seq TO service_role;

-- service_role bypasses RLS by default; this explicit policy documents intent
-- and covers any non-bypass role the engine might use.
DROP POLICY IF EXISTS peer_verification_votes_service_all ON peer_verification_votes;
CREATE POLICY peer_verification_votes_service_all
  ON peer_verification_votes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
