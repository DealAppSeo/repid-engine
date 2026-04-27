-- ============================================================================
-- Reponomics — two-builder demo seed
--
-- Creates Builder W (wealthy operator with 5 sybil agents) and Builder M
-- (mission builder owning APM). Bumps APM and VERITAS to demo-grade RepID
-- + Wisdom + Character so the crossover math (Phase 9 of the sprint)
-- demonstrates correctly without requiring weeks of real trades to build
-- up score history.
--
-- DEMO-TIME BUMP: APM and VERITAS rows have their current_repid updated.
-- This is reversible — anyone with admin access can restore to the
-- pre-seed values (APM=1240, VERITAS=3260) if needed.
--
-- Idempotent: NOT EXISTS guards on every insert; ON CONFLICT for builder
-- inserts; UPDATE for live agent rows is conditional on agent_name match.
-- ============================================================================

-- 1. Builder W (wealthy operator) — $1000 USDC stake, 5 sybil agents.
INSERT INTO builders (id, address, current_repid, ghost_cohort_count, display_name, created_at)
SELECT
  '00000000-0000-0000-0000-000000000001',
  '0x57484c5400000000000000000000000000000001',           -- 'WLTW' prefix
  5500,
  0,
  'Builder W (wealthy operator)',
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM builders WHERE id = '00000000-0000-0000-0000-000000000001');

-- 2. Builder M (mission-aligned, low capital) — $50 USDC stake, owns APM.
INSERT INTO builders (id, address, current_repid, ghost_cohort_count, display_name, created_at)
SELECT
  '00000000-0000-0000-0000-000000000002',
  '0x4d49535300000000000000000000000000000002',           -- 'MISS' prefix
  7000,
  0,
  'Builder M (mission builder)',
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM builders WHERE id = '00000000-0000-0000-0000-000000000002');

-- 3. Stake deposits — both builders' simulated USDC stakes.
INSERT INTO stake_deposits (builder_id, amount, status, is_simulated, deposit_tx_hash, created_at)
SELECT
  '00000000-0000-0000-0000-000000000001',
  1000000000,                                              -- $1000 USDC = 1_000_000_000 (6 decimals)
  'active',
  TRUE,
  'simulated:builder_w_initial_1000',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM stake_deposits WHERE deposit_tx_hash = 'simulated:builder_w_initial_1000'
);

INSERT INTO stake_deposits (builder_id, amount, status, is_simulated, deposit_tx_hash, created_at)
SELECT
  '00000000-0000-0000-0000-000000000002',
  50000000,                                                -- $50 USDC = 50_000_000
  'active',
  TRUE,
  'simulated:builder_m_initial_50',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM stake_deposits WHERE deposit_tx_hash = 'simulated:builder_m_initial_50'
);

-- 4. Bump APM and VERITAS to demo-grade scores. Live values were
--    APM repid=1240, VERITAS repid=3260; this is a deliberate demo bump.
--    repid_score_events captures the transition for auditability.

DO $$
DECLARE
  v_apm UUID;
  v_veritas UUID;
  v_apm_old INTEGER;
  v_veritas_old INTEGER;
BEGIN
  SELECT id, current_repid INTO v_apm, v_apm_old FROM repid_agents WHERE agent_name = 'APM' LIMIT 1;
  SELECT id, current_repid INTO v_veritas, v_veritas_old FROM repid_agents WHERE agent_name = 'VERITAS' LIMIT 1;

  IF v_apm IS NOT NULL AND v_apm_old <> 7000 THEN
    UPDATE repid_agents
    SET current_repid = 7000,
        wisdom_score = 1500,
        character_score = 1700,
        builder_id = '00000000-0000-0000-0000-000000000002',
        last_active_at = NOW()
    WHERE id = v_apm;

    INSERT INTO repid_score_events (agent_id, event_type, delta, repid_before, repid_after, created_at, metadata)
    VALUES (v_apm, 'demo_seed_bump', 7000 - v_apm_old, v_apm_old, 7000, NOW(),
            jsonb_build_object('reason', 'reponomics demo seed; mission-aligned agent for Builder M'));
  END IF;

  IF v_veritas IS NOT NULL AND v_veritas_old <> 5500 THEN
    UPDATE repid_agents
    SET current_repid = 5500,
        wisdom_score = 1100,
        character_score = 1100,
        last_active_at = NOW()
    WHERE id = v_veritas;

    INSERT INTO repid_score_events (agent_id, event_type, delta, repid_before, repid_after, created_at, metadata)
    VALUES (v_veritas, 'demo_seed_bump', 5500 - v_veritas_old, v_veritas_old, 5500, NOW(),
            jsonb_build_object('reason', 'reponomics demo seed; trade counterparty for APM'));
  END IF;
END $$;

-- 5. Builder W's 5 sybil agents (RepID 5500, W=900, C=600).
--    Inserted as repid_agents rows, owned by Builder W.
INSERT INTO repid_agents (
  id, agent_name, agent_type, current_repid, wisdom_score, character_score,
  builder_id, last_active_at, last_updated, created_at, tier
)
SELECT
  gen_random_uuid(),
  'BUILDER_W_SYBIL_' || gs::text,
  'external',
  5500,
  900,
  600,
  '00000000-0000-0000-0000-000000000001',
  NOW(),
  NOW(),
  NOW(),
  'EARNING_AUTONOMY'
FROM generate_series(1, 5) AS gs
WHERE NOT EXISTS (
  SELECT 1 FROM repid_agents WHERE agent_name = 'BUILDER_W_SYBIL_' || gs::text
);
