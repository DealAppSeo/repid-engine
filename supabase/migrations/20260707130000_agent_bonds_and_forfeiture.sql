-- Anti-Sybil MVP (2026-07-07) — proof-of-cost BOND + detection→FORFEITURE ledger.
--
-- ⚠️ MIGRATION FILE ONLY — DO NOT APPLY WITHOUT SEAN GREENLIGHT + PARAMETERS.
-- Design: E:\dev\living-docs\03_specs\REPID_ECONOMIC_DESIGN_v1.md §2–§4.
-- Red-team: E:\dev\reports\2026-07-07\T2_SYBIL_FARMING_REDTEAM.md §4 rank 1/5.
--
-- REGULATORY (spec §3, §7): naming is "bond" / "bond forfeiture" / "penalty" —
-- NEVER "slashing" (SEC Kraken precedent). Testnet-first; mainnet bonds need
-- money-transmitter + securities counsel BEFORE apply.
--
-- WHAT THIS ADDS (all NEW, additive — touches no existing table's data):
--   agent_bonds            — the proof-of-cost stake that puts an agent in the
--                            ECONOMIC band. has_active_bond in app code
--                            (src/services/economic-standing.ts) reads this.
--   repid_redteam_probes   — the continuous, randomly-assigned, family-disjoint
--                            independent detection probes on economic-band agents.
--   repid_bond_forfeitures — the due-process ledger: a PROVEN violation → a
--                            forfeiture, WITH an appeal window (never on accusation).
--
-- The FORFEITURE ACTION reuses the EXISTING prod primitive apply_repid_penalty
-- (p_agent uuid, p_new_repid integer[, p_event jsonb]) + repid_agents.floor_override
-- (both verified live 2026-07-07) — this migration only adds the ledger + wiring
-- surface; the demotion itself is the deployed penalty fn (§4: "wire the existing
-- apply_repid_penalty").
--
-- ⚙️ SEAN PARAMETERS REQUIRED before apply (spec §9): bond amount, provisional→
-- economic threshold, forfeiture due-process (detection confidence, appeal window,
-- partial vs full). Left as columns/config, not hardcoded.
--
-- ROLLBACK: DROP TABLE repid_bond_forfeitures, repid_redteam_probes, agent_bonds
--           CASCADE; DELETE FROM repid_config WHERE key LIKE 'bond_%' OR key LIKE 'redteam_%'.

-- ── 1) agent_bonds — proof-of-cost stake (band boundary) ────────────────────
CREATE TABLE IF NOT EXISTS agent_bonds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  -- Stablecoin bond amount (raw, 6-decimal USDC-style). Testnet-first.
  amount_usdc_raw    BIGINT NOT NULL CHECK (amount_usdc_raw >= 0),
  asset              TEXT NOT NULL DEFAULT 'USDC',
  chain              TEXT NOT NULL DEFAULT 'base-sepolia',
  -- On-chain provenance of the bond deposit (testnet). NULL while pre-chain.
  deposit_tx_hash    TEXT,
  -- 'active' = agent is in the ECONOMIC band; 'forfeited' / 'released' end it.
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'forfeited', 'released', 'pending')),
  is_simulated       BOOLEAN NOT NULL DEFAULT true,  -- testnet-first: simulated until real deposit verified
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at        TIMESTAMPTZ,
  forfeited_at       TIMESTAMPTZ
);
-- One ACTIVE bond per agent (economic standing is boolean, not stacked).
CREATE UNIQUE INDEX IF NOT EXISTS agent_bonds_one_active_per_agent
  ON agent_bonds(agent_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_bonds_agent_idx ON agent_bonds(agent_id);

-- ── 2) repid_redteam_probes — independent detection (spec §4) ───────────────
-- Continuous, randomly-assigned, family-disjoint probes the target's owner
-- CANNOT choose. Detects sockpuppet loops / collusion / bot-timing / self-dealing.
CREATE TABLE IF NOT EXISTS repid_redteam_probes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_agent_id    UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  -- The independent red-teamer (itself staked + rotated; NULL for an automated probe).
  redteam_agent_id   UUID REFERENCES repid_agents(id) ON DELETE SET NULL,
  probe_type         TEXT NOT NULL
                       CHECK (probe_type IN ('counterparty_graph','collusion_ring','bot_timing','self_dealing','other')),
  -- 'clean' | 'suspicious' | 'violation' — only 'violation' (proven) may forfeit.
  verdict            TEXT NOT NULL DEFAULT 'pending'
                       CHECK (verdict IN ('pending','clean','suspicious','violation')),
  confidence         NUMERIC CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- graph metrics / timing / counterparty ids
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS redteam_probes_target_idx ON repid_redteam_probes(target_agent_id, created_at DESC);

-- ── 3) repid_bond_forfeitures — due-process ledger (spec §3) ─────────────────
-- Forfeiture on PROVEN violation, WITH appeal. Justice + mercy: recoverable.
CREATE TABLE IF NOT EXISTS repid_bond_forfeitures (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL REFERENCES repid_agents(id) ON DELETE CASCADE,
  bond_id            UUID REFERENCES agent_bonds(id) ON DELETE SET NULL,
  probe_id           UUID REFERENCES repid_redteam_probes(id) ON DELETE SET NULL,
  reason             TEXT NOT NULL,
  -- partial vs full forfeiture (Sean parameter). raw amount forfeited.
  forfeited_amount_usdc_raw BIGINT NOT NULL DEFAULT 0 CHECK (forfeited_amount_usdc_raw >= 0),
  -- RepID demotion applied via apply_repid_penalty (the deployed primitive).
  repid_penalty_applied     INTEGER NOT NULL DEFAULT 0,
  -- Due process: proposed → (appeal window) → upheld / overturned / withdrawn.
  status             TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed','appealed','upheld','overturned','withdrawn')),
  appeal_opens_at    TIMESTAMPTZ,
  appeal_closes_at   TIMESTAMPTZ,       -- Sean parameter: appeal window length
  appeal_notes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bond_forfeitures_agent_idx ON repid_bond_forfeitures(agent_id, created_at DESC);

-- ── 4) Config parameters (Sean-owned; defaults are conservative placeholders) ─
INSERT INTO repid_config (key, value, description) VALUES
  ('bond_enabled', 'false', 'Anti-Sybil: master switch for proof-of-cost bonds. Default off (testnet-first).'),
  ('bond_amount_usdc_raw', '5000000', 'Bond to enter the ECONOMIC band (raw 6-dec USDC = $5 testnet placeholder). SEAN PARAMETER §9.1.'),
  ('bond_forfeiture_confidence_min', '0.9', 'Min probe confidence to PROPOSE a forfeiture. SEAN PARAMETER §9.3.'),
  ('bond_appeal_window_hours', '72', 'Appeal window before a proposed forfeiture is upheld. SEAN PARAMETER §9.3.'),
  ('redteam_probe_enabled', 'false', 'Anti-Sybil: continuous red-team probes on economic-band agents. Default off.')
ON CONFLICT (key) DO NOTHING;

-- ── 5) has_active_bond helper — what economic-standing.ts reads ─────────────
CREATE OR REPLACE FUNCTION agent_has_active_bond(p_agent_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM agent_bonds
    WHERE agent_id = p_agent_id AND status = 'active'
  );
$$ LANGUAGE SQL STABLE;
