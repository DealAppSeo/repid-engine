-- ============================================================================
-- WS2.3 Stage-1 migration — rrl_shadow_ledger (ADDITIVE, NEW table)
-- ============================================================================
-- STATUS: WRITTEN, NOT APPLIED. Applying prod DDL is Sean-only (CLAUDE_RULES r7 / task).
-- This file exists so the shadow ledger has a real DB target when (and only when) the
-- WS2.3 exit gates pass and Sean applies it. It is purely additive: it does NOT touch,
-- reference, or constrain repid_agents / repid_score_events or any canonical table.
--
-- Project: qnnpjhlxljtqyigedwkb (AITrinitySymphony / Trinity prod).
-- Apply with:  supabase migration / MCP apply_migration  -- BY SEAN, after co-sign.
--
-- Shadow discipline: rows here are what the RRL rule WOULD have done. NOTHING reads this
-- table to mutate live RepID. Stage-1 (RepID moves) is a separate, gated cutover.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rrl_shadow_ledger (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts                timestamptz NOT NULL DEFAULT now(),

    -- who / what was scored
    agent_id          text        NOT NULL,           -- matches repid_agents.agent_id (text), NOT an FK (shadow = decoupled)
    event_id          text        NOT NULL,           -- id of the ground-truth-bearing event
    event_source      text        NOT NULL            -- provenance of the outcome oracle
                        CHECK (event_source IN ('hal','peer_verify','dispute','synthetic','replay')),
    round             integer     NOT NULL DEFAULT 0, -- logical time index within a stream/replay

    -- the would-be effect (recorded, NEVER applied at Stage-0)
    computed_delta    double precision NOT NULL,      -- RRL delta that WOULD have been applied
    mechanisms_fired  text[]      NOT NULL DEFAULT '{}', -- which mechanisms contributed
    detector_fired    boolean     NOT NULL DEFAULT false, -- anti-gaming detector penalty fired

    would_be_repid    double precision NOT NULL,      -- agent RepID IF shadow deltas were live (1000 baseline)
    live_repid        double precision,               -- actual current RepID at scoring time (nullable)

    note              text,                            -- freeform label (e.g. 'synthetic:concealer')

    -- shadow-run provenance so Stage-1 promotion can audit which run produced a row
    run_id            text,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- Query paths: by agent trajectory, by run, by time.
CREATE INDEX IF NOT EXISTS idx_rrl_shadow_ledger_agent   ON public.rrl_shadow_ledger (agent_id, round);
CREATE INDEX IF NOT EXISTS idx_rrl_shadow_ledger_run     ON public.rrl_shadow_ledger (run_id);
CREATE INDEX IF NOT EXISTS idx_rrl_shadow_ledger_ts      ON public.rrl_shadow_ledger (ts);
CREATE INDEX IF NOT EXISTS idx_rrl_shadow_ledger_source  ON public.rrl_shadow_ledger (event_source);

-- ----------------------------------------------------------------------------
-- RLS: enabled + locked to service_role only. anon/authenticated get NOTHING.
-- (Matches the STATE_OF_THE_SYSTEM 100%-RLS posture; shadow data is internal.)
-- ----------------------------------------------------------------------------
ALTER TABLE public.rrl_shadow_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rrl_shadow_ledger FROM anon, authenticated;
GRANT  ALL ON public.rrl_shadow_ledger TO service_role;

DROP POLICY IF EXISTS rrl_shadow_ledger_service_all ON public.rrl_shadow_ledger;
CREATE POLICY rrl_shadow_ledger_service_all
    ON public.rrl_shadow_ledger
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.rrl_shadow_ledger IS
    'WS2.3 RRL shadow-mode ledger. Would-be reputation deltas, recorded not applied. '
    'No FK to canonical repid tables by design (shadow = fully decoupled). Stage-0 sink target.';
