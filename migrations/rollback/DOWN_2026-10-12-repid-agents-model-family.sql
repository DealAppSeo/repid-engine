-- DOWN for migrations/2026-10-12-repid-agents-model-family.sql
-- PROMOTION-GATED — NOT APPLIED TO PROD (R7, Sean-gated). FILE ONLY.
--
-- Drops the additive, nullable column. Safe because nothing in this repo WRITES model_family
-- (the reader only SELECTs it and treats absence as fail-closed), so removing it returns the
-- counterparty settler to its pre-column "always refused via NULL" behaviour. If any external
-- consumer has begun writing it, DROP is destructive to that data — check before running.

ALTER TABLE repid_agents DROP COLUMN IF EXISTS model_family;
