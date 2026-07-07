-- DOWN migration for supabase/migrations/20260702000000_agent_delegations.sql
-- Drops agent_delegations + its indexes (indexes drop with the table).
-- Cleanly reversible: UP is a single additive CREATE TABLE IF NOT EXISTS with
-- three indexes; DROP fully unwinds. builders (FK parent) is NOT touched — it
-- pre-exists this wave (20260427_add_builder_registry.sql).
DROP TABLE IF EXISTS agent_delegations CASCADE;
