-- DRAFT: Sean applies (prod DDL is Sean-only). Comment only: no data, no constraint, no lock beyond
-- a catalog update. Rollback: COMMENT ON COLUMN erc8004_reputation_writes.repid_event_id IS NULL;
--
-- Why: the column name reads as "a repid_score_events id". It is a foreign key to repid_events.
-- A join to the wrong table returns plausible rows, and on 2026-11-16 it produced a false finding
-- that 30 days of on-chain writes cited RepID events from May. The comment puts the right table
-- where a reader of the schema will see it.
COMMENT ON COLUMN public.erc8004_reputation_writes.repid_event_id IS
  'FK to repid_events.id (the outbox row this write drained), NOT repid_score_events. For the score this write published, join repid_score_events ON contract_id AND agent_id. See scripts/erc8004/event-link-check.sql.';
