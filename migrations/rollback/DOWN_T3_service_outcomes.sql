-- DOWN migration for scripts/migrations/T3_service_outcomes.sql
-- Drops the two T3 outcome tables. Indexes + RLS policies drop WITH the table
-- (CASCADE). Cleanly reversible: the UP is pure additive CREATE TABLE IF NOT
-- EXISTS, so DROP fully unwinds it. FK children (none reference these) — CASCADE
-- is defensive.
DROP TABLE IF EXISTS service_outcome_pending CASCADE;
DROP TABLE IF EXISTS service_outcomes CASCADE;
