-- ============================================================================
-- Reponomics — Wisdom + Character history
--
-- agent_wisdom_history: per-bet calibration data point. Wisdom score
-- recomputes from the trailing 50 entries via Pythagorean Comma logic
-- in src/services/wisdom-score.ts.
--
-- agent_character_history: per-mission-relevant action. Character score
-- adjusts by event-type delta and stays within [100, 2000].
--
-- Both tables join to repid_agents.id (UUID).
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_wisdom_history (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL,                       -- soft FK to repid_agents.id
  claimed_confidence INTEGER NOT NULL,                    -- basis points 0-10000
  actual_outcome     SMALLINT NOT NULL,                   -- 0 or 1
  calibration_delta  NUMERIC(8,4),                         -- |claimed - actual|, computed at update
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_wisdom_agent ON agent_wisdom_history(agent_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS agent_character_history (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                 UUID NOT NULL,                  -- soft FK to repid_agents.id
  action_type              TEXT NOT NULL,                  -- trade_with_low_repid | attestation_to_low_repid | underserved_domain_action | agent_abandonment
  helped_low_repid_party   BOOLEAN NOT NULL DEFAULT FALSE,
  mission_alignment_weight NUMERIC(6,2) NOT NULL,
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_character_agent ON agent_character_history(agent_id, computed_at DESC);
