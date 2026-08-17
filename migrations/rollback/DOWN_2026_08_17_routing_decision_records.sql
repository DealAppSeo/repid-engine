-- Rollback for migrations/2026_08_17_routing_decision_records.sql.
--
-- The UP migration is additive-only and creates exactly one new table with two of
-- its own indexes. It alters no existing table, so this DOWN is a single drop and
-- there is nothing to restore.
--
-- Set ROUTING_RECORD_PERSIST=false (or unset it -- off is the default) BEFORE
-- running this, or the writer will log an insert error per routing attempt. The
-- writer swallows its errors and never blocks routing either way.

drop table if exists public.routing_decision_records;
