-- ============================================================================
-- Reponomics — linked bets, x402 settlements, trading rounds, atomic RPC
--
-- linked_bets: open and resolved bets, with token_delta_resolved and
-- repid_delta_resolved that MUST share sign (atomic linkage; one-way
-- valve). Enforced by the apply_linked_bet_resolution PL/pgSQL function.
--
-- x402_settlements: HTTP 402 receipts.
--
-- trading_rounds: APM↔VERITAS round metadata, joining two linked_bets
-- (apm_bet_id, veritas_bet_id) per round.
-- ============================================================================

CREATE TABLE IF NOT EXISTS linked_bets (
  id                       TEXT PRIMARY KEY,                -- 'bet_<ts>_<rand>'
  agent_id                 UUID NOT NULL,                    -- soft FK to repid_agents.id
  bet_amount               NUMERIC(38,0) NOT NULL,           -- USDC smallest unit
  claimed_confidence       INTEGER NOT NULL DEFAULT 0,       -- basis points 0-10000
  prediction_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  oracle_endpoint          TEXT,
  expected_resolution_time TIMESTAMPTZ,
  status                   TEXT NOT NULL DEFAULT 'open',     -- open | awaiting_payment | delivered | resolved | cancelled
  token_delta_resolved     NUMERIC(38,0),                     -- nullable until resolved
  repid_delta_resolved     INTEGER,                            -- nullable until resolved
  plonky3_proof_bytes      TEXT,                              -- hex string from plonky3 stub or real prover
  is_simulated             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_linked_bets_agent_status
  ON linked_bets(agent_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_linked_bets_open
  ON linked_bets(status, expected_resolution_time)
  WHERE status = 'open';

-- Atomic linkage check: enforce that token and repid deltas share sign.
ALTER TABLE linked_bets DROP CONSTRAINT IF EXISTS chk_linked_bets_sign;
ALTER TABLE linked_bets ADD CONSTRAINT chk_linked_bets_sign CHECK (
  (token_delta_resolved IS NULL AND repid_delta_resolved IS NULL)
  OR (token_delta_resolved >= 0 AND repid_delta_resolved >= 0)
  OR (token_delta_resolved <= 0 AND repid_delta_resolved <= 0)
);

CREATE TABLE IF NOT EXISTS x402_settlements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_address       TEXT,
  payee_address       TEXT,
  amount              NUMERIC(38,0) NOT NULL,
  asset               TEXT NOT NULL DEFAULT 'USDC',
  settlement_tx_hash  TEXT,
  http_402_challenge  TEXT,                                  -- the tip_id / resource id from the 402 response
  is_simulated        BOOLEAN NOT NULL DEFAULT TRUE,
  settled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_x402_settlements_payee
  ON x402_settlements(payee_address, settled_at DESC);

CREATE TABLE IF NOT EXISTS trading_rounds (
  id                   TEXT PRIMARY KEY,
  apm_bet_id           TEXT REFERENCES linked_bets(id),
  veritas_bet_id       TEXT REFERENCES linked_bets(id),
  status               TEXT NOT NULL DEFAULT 'open',         -- open | resolved | failed
  expected_resolution  TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolution_outcome   BOOLEAN,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trading_rounds_status
  ON trading_rounds(status, expected_resolution);

-- ============================================================================
-- apply_linked_bet_resolution: atomic settlement function
--
-- Called from src/services/linked-bet-resolver.ts. Updates the bet's
-- status + delta columns, increments repid_agents.current_repid by
-- repid_delta, and inserts a row into repid_score_events. Wrapped in a
-- transaction so partial failure rolls back.
-- ============================================================================
CREATE OR REPLACE FUNCTION apply_linked_bet_resolution(
  p_bet_id      TEXT,
  p_token_delta NUMERIC,
  p_repid_delta INTEGER,
  p_resolved_at TIMESTAMPTZ
) RETURNS JSONB AS $$
DECLARE
  v_agent UUID;
  v_old_repid INTEGER;
  v_new_repid INTEGER;
BEGIN
  -- Atomic linkage guard (defense-in-depth; the table CHECK also enforces).
  IF (p_token_delta > 0 AND p_repid_delta < 0) OR (p_token_delta < 0 AND p_repid_delta > 0) THEN
    RAISE EXCEPTION 'atomic linkage violation: token_delta=% repid_delta=% must share sign',
      p_token_delta, p_repid_delta;
  END IF;

  SELECT agent_id INTO v_agent FROM linked_bets WHERE id = p_bet_id;
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'bet not found: %', p_bet_id;
  END IF;

  SELECT current_repid INTO v_old_repid FROM repid_agents WHERE id = v_agent;
  v_new_repid := GREATEST(0, LEAST(10000, v_old_repid + p_repid_delta));

  UPDATE linked_bets
  SET status = 'resolved',
      token_delta_resolved = p_token_delta,
      repid_delta_resolved = p_repid_delta,
      resolved_at = p_resolved_at
  WHERE id = p_bet_id;

  UPDATE repid_agents
  SET current_repid = v_new_repid,
      last_updated = p_resolved_at,
      last_active_at = p_resolved_at
  WHERE id = v_agent;

  INSERT INTO repid_score_events (
    agent_id, event_type, delta, repid_before, repid_after, created_at, metadata
  ) VALUES (
    v_agent, 'linked_bet_resolved', p_repid_delta, v_old_repid, v_new_repid, p_resolved_at,
    jsonb_build_object('bet_id', p_bet_id, 'token_delta', p_token_delta::text)
  );

  RETURN jsonb_build_object(
    'bet_id', p_bet_id,
    'agent_id', v_agent,
    'old_repid', v_old_repid,
    'new_repid', v_new_repid,
    'token_delta', p_token_delta::text,
    'repid_delta', p_repid_delta
  );
END;
$$ LANGUAGE plpgsql;
