-- PARTICIPANT-RATING + DOGFOOD ACCOUNTABILITY LEDGER (CC 2026-07-08)
-- OUTPUT_PATH: migrations/2026-07-08-participant-rating-ledger.sql
-- SPEC: TRUST_HARNESS_SPRINT_AND_RATINGS.md Part C (the 5 laws) + Part B (dogfood).
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD (R7, Sean-gated). FILE ONLY.
-- ==========================================================================================
--
-- WHY A NEW TABLE (not repid_score_events):
--   1. repid_score_events.event_type has a CHECK-constraint whitelist that does NOT admit a
--      participant-rating / dogfood event type — writing one would fail 23514.
--   2. repid_score_events.agent_id is a FK to repid_agents(id). LLM/SLM participants (deepseek,
--      groq, mistral, …) are NOT rows in repid_agents, so a rating OF a model cannot be an
--      agent_id row. A participant-rating ledger must hold non-agent nodes.
--   Hence a dedicated append-only sink. The RepID engine (repid_score_events) stays the sink for
--   AGENT score changes; this table is the RATING-GRAPH edge log (agents rate LLMs / each other).
--
-- SHADOW-FIRST: the ledger writer (src/engine/participant-rating-ledger.ts) DEFAULTS to shadow
-- mode (PARTICIPANT_RATING_MODE=shadow) — it logs the would-be row and does NOT mutate any live
-- current_repid. repid_delta is recorded as the WOULD-BE delta (measurement), applied=false in
-- shadow. This table is the durable sink once the flag flips to live (Sean-gated).

CREATE TABLE IF NOT EXISTS participant_rating_ledger (
  id                    BIGSERIAL PRIMARY KEY,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- rating-graph edge (rater → ratee). Nodes are agents / LLMs / SLMs / humans, so these are
  -- free-text ids (provider/model slug OR agent uuid-as-text), NOT FKs to repid_agents.
  rater_id              TEXT NOT NULL,
  rater_kind            TEXT NOT NULL CHECK (rater_kind = ANY (ARRAY['agent','llm','slm','human'])),
  rater_family          TEXT,               -- correlation family (L4 family-disjoint)
  rater_repid_at_event  INTEGER,            -- L3: rater's RepID snapshot (rating weight ∝ this)

  ratee_id              TEXT NOT NULL,
  ratee_kind            TEXT NOT NULL CHECK (ratee_kind = ANY (ARRAY['agent','llm','slm','human'])),
  ratee_family          TEXT,

  -- L2 ground-truth anchor: how the engagement was verified (drives edge weight).
  verification_strength TEXT NOT NULL CHECK (verification_strength = ANY (
                          ARRAY['execution-verified','quorum-verified','peer-opinion','self-report'])),

  -- L1 earned-gate: the VERIFIED engagement receipt this edge references (hashkey-chain hash,
  -- on-chain tx, or canary-run id + row). NOT NULL — an edge with no receipt is rejected in code.
  engagement_receipt_ref TEXT NOT NULL,

  -- L5 multi-axis (never one collapsed score). Kept in jsonb so axes stay separable + auditable:
  --   { accuracy, calibration, coverage, latency, cost } (each optional).
  axes                  JSONB NOT NULL,

  -- L4 anti-gaming provenance.
  stake_usd             NUMERIC DEFAULT 0,  -- consequence weighting ($50 settlement > $0.01)
  rater_bonded          BOOLEAN DEFAULT false, -- Sybil bond posted?
  edge_weight           NUMERIC,            -- computed aggregation weight (principle-level, not the RepID formula)
  collusion_flagged     BOOLEAN DEFAULT false,
  family_conflict_flagged BOOLEAN DEFAULT false,

  -- Dogfood accountability (Part B): when this edge represents AGENT-WORK verified by a
  -- decorrelated reviewer, these carry the would-be RepID delta. In shadow mode repid_applied=false.
  work_ref              TEXT,               -- PR / task id the agent's contribution corresponds to
  verified_by           TEXT,               -- the decorrelated reviewer (who verified the work)
  repid_delta           INTEGER,            -- the WOULD-BE RepID delta from this verified outcome
  repid_applied         BOOLEAN NOT NULL DEFAULT false, -- shadow=false (logged, not mutated); live=true

  mode                  TEXT NOT NULL DEFAULT 'shadow'
                          CHECK (mode = ANY (ARRAY['shadow','live'])),
  note                  TEXT,
  metadata              JSONB
);

CREATE INDEX IF NOT EXISTS idx_participant_rating_ratee ON participant_rating_ledger (ratee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_participant_rating_rater ON participant_rating_ledger (rater_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_participant_rating_receipt ON participant_rating_ledger (engagement_receipt_ref);

ALTER TABLE participant_rating_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON participant_rating_ledger;
CREATE POLICY "service_role_all" ON participant_rating_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE participant_rating_ledger IS
  'Participant-rating graph edges + dogfood accountability (agents rate LLMs/each other; agents earn RepID for verified work). 5-laws-enforced in src/engine/participant-rating.ts; written by participant-rating-ledger.ts (SHADOW-FIRST default). PROMOTION-GATED.';

-- ROLLBACK:
-- DROP POLICY IF EXISTS "service_role_all" ON participant_rating_ledger;
-- DROP TABLE IF EXISTS participant_rating_ledger;

-- POST-APPLY VERIFY:
-- SELECT count(*) FROM participant_rating_ledger;                     -- 0 is healthy pre-seed
-- SELECT mode, count(*) FROM participant_rating_ledger GROUP BY mode; -- expect all 'shadow' pre-flip
-- SELECT * FROM pg_policies WHERE tablename='participant_rating_ledger';
