-- T3 — Delayed outcome signal ("held-up-in-use") for A2A service contracts.
-- The THIRD and deepest RepID touchpoint: "did it actually work when I used it?"
-- Additive + RLS-enabled (service_role full; anon/authenticated denied).
--
-- ⚠ UNAPPLIED. This file is a migration ARTIFACT ONLY — do NOT apply to prod from
-- this branch. Sean/Claude apply via Supabase MCP after review (CLAUDE-RULE-5/RULE-7).
--
-- ROLLBACK: DROP TABLE IF EXISTS service_outcomes CASCADE;

-- ── service_outcomes — one buyer outcome rating per contract ────────────
--
-- Parallel record: the contract may already be terminal ('settled'); this row
-- captures the delayed 24h–7d "held up in use?" signal without mutating the
-- contract. Provenance-bound to the exact contract + its x402 settlement.
CREATE TABLE IF NOT EXISTS service_outcomes (
  id                  BIGSERIAL PRIMARY KEY,

  -- Provenance binding (exact contract + settlement it refers to)
  contract_id         UUID NOT NULL REFERENCES service_contracts(id) ON DELETE CASCADE,
  x402_payment_id     UUID REFERENCES x402_settlements(id) ON DELETE SET NULL,
  settlement_tx_hash  TEXT,               -- copied from the settlement for audit convenience

  -- Parties
  provider_agent_id   UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  buyer_agent_id      UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  rater_agent_id      UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE, -- == buyer (buyer-only auth)

  -- The signal: 3-state rating (keeps the honest middle + gradient)
  rating              TEXT NOT NULL CHECK (rating IN ('good','ok','bad')),
  note                TEXT,

  -- Rater-weight snapshot (rater's current_repid at rating time drives influence)
  rater_repid_at_rating  INTEGER,
  rater_weight        NUMERIC,            -- the clamped multiplier actually applied

  -- Applied delta bookkeeping (mirrors what went to repid_score_events)
  provider_delta_applied INTEGER,
  score_event_id      UUID,               -- the repid_score_events row id (if any)

  -- 'bad' MAY open a dispute — never auto-disputed. This flag lets a later,
  -- separate worker offer/queue a dispute. Absence-neutral: no rating = no row.
  dispute_eligible    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Consensus-divergence hook (TODO): a later pass can discount a rating that
  -- diverges from the other T1/T2 signals for this contract. Left nullable +
  -- unused for now; full consensus-divergence is out of scope for T3 v1.
  divergence_score    NUMERIC,            -- reserved; NULL until a divergence pass runs
  divergence_discounted BOOLEAN NOT NULL DEFAULT FALSE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One outcome rating per contract (idempotent; a re-POST is rejected as duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS service_outcomes_contract_uniq
  ON service_outcomes (contract_id);

CREATE INDEX IF NOT EXISTS service_outcomes_provider_idx
  ON service_outcomes (provider_agent_id);
CREATE INDEX IF NOT EXISTS service_outcomes_created_idx
  ON service_outcomes (created_at);

ALTER TABLE service_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_outcomes_service_role_full ON service_outcomes;
CREATE POLICY service_outcomes_service_role_full ON service_outcomes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── service_outcome_pending — the nudge queue ───────────────────────────
--
-- When a contract settles, a pending-outcome becomes ELIGIBLE at settle+24h.
-- A flag-gated notifier (default OFF) reads this table to send the Telegram
-- "did it hold up?" prompt. Absence-neutral: nothing here ever penalizes — it
-- only enables an optional nudge. Marked resolved once an outcome is recorded
-- or the 7d window expires.
CREATE TABLE IF NOT EXISTS service_outcome_pending (
  id                  BIGSERIAL PRIMARY KEY,
  contract_id         UUID NOT NULL UNIQUE REFERENCES service_contracts(id) ON DELETE CASCADE,
  buyer_agent_id      UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  provider_agent_id   UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  settled_at          TIMESTAMPTZ NOT NULL,          -- anchor for the 24h..7d window
  eligible_at         TIMESTAMPTZ NOT NULL,          -- settled_at + 24h
  expires_at          TIMESTAMPTZ NOT NULL,          -- settled_at + 7d
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','notified','recorded','expired')),
  notified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_outcome_pending_status_idx
  ON service_outcome_pending (status, eligible_at);

ALTER TABLE service_outcome_pending ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_outcome_pending_service_role_full ON service_outcome_pending;
CREATE POLICY service_outcome_pending_service_role_full ON service_outcome_pending
  FOR ALL TO service_role USING (true) WITH CHECK (true);
