-- Backlog item 13 (PATENT_ALIGNED_BUILD_BACKLOG.md): durable heat-tier classification
-- column on agent_memory_leaves.
--
-- `heat_tier` is written by writeHeatTiers (src/memory/memory-heat-tier-writer.ts)
-- after each shadow sweep (logHeatSweepShadow, gated on HEAT_EVICTION_SHADOW_ENABLED).
-- NULL means "not yet classified" — rows added before the sweep has run keep NULL.
--
-- Shadow-first: nothing tombstones or promotes based on this column until Sean GO.
-- The column is the persistence layer for what the shadow log already reports ephemerally.
--
-- Deliberately NOT NOT NULL — existing rows lack a classification until the sweep runs.

alter table public.agent_memory_leaves
  add column if not exists heat_tier text
    check (heat_tier in ('hot', 'warm', 'cold', 'on_chain'));

-- Fast filter for the eviction pass: fetch cold/on_chain candidates by agent.
create index if not exists idx_agent_memory_leaves_heat_tier
  on public.agent_memory_leaves (agent_id, heat_tier)
  where not tombstoned;

comment on column public.agent_memory_leaves.heat_tier is
  'Durable heat classification from the last shadow sweep (hot/warm/cold/on_chain). NULL = not yet classified. Written by writeHeatTiers; gated on HEAT_EVICTION_SHADOW_ENABLED.';
