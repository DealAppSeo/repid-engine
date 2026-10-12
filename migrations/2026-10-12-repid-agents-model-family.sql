-- repid_agents.model_family — first-class model-family column (CC1, 2026-10-12)
-- OUTPUT_PATH: migrations/2026-10-12-repid-agents-model-family.sql
-- ISSUE: #1338 follow-up ("one column, not a new scorer. model_family on the agent.")
--
-- ==========================================================================================
-- PROMOTION-GATED — NOT APPLIED TO PROD (R7, Sean-gated). FILE ONLY.
-- The orchestrator holds DDL against qnnpjhlxljtqyigedwkb for Sean. This lane applied NOTHING.
-- ==========================================================================================
--
-- PURPOSE. The counterparty independence check (rule 4 of src/scoring/confirmed-outcome.ts)
-- confirms an outcome ONLY when it can POSITIVELY establish that the actor and the confirming
-- party are different model families. Until now the only place a family lived per-agent was the
-- `repid_agents.capabilities` jsonb (best-effort, often absent), so `readModelFamily` failed
-- closed almost always and the counterparty settler could never confirm. This column is the
-- first-class, queryable source of that family.
--
-- WHY `text`, NULLABLE, NO DEFAULT, NO BACKFILL. Additive and backward-compatible: existing
-- rows get NULL, and the reader (src/engine/repid-update.ts::modelFamilyOf) treats NULL as
-- "family unknown" and FAILS CLOSED — a NULL is never read as independence. So applying this
-- column changes NO score on its own: the counterparty path stays refused for every agent whose
-- family is still NULL. Populating it (and arming CONFIRMED_OUTCOME_SCORING_ENABLED, and wiring
-- the server-side confirmation verifier) are each separate, Sean-gated decisions. A DEFAULT or a
-- blanket backfill would be a guessed family — exactly the "NO INVENTED FAMILIES" rule the
-- model_family_registry seed already honours — so neither is included.
--
-- NO INDEX, DELIBERATELY. The only read is a primary-key lookup
--   SELECT model_family FROM repid_agents WHERE id = <uuid>
-- (see confirmedOutcomeDepsFor.readModelFamily). `model_family` is never a WHERE/JOIN predicate;
-- the family values are compared in application code after two PK reads. An index on it would
-- index a column nothing filters on. Add one only if a future query filters/groups BY family.
--
-- RELATIONSHIP TO model_family_registry. That table (migrations/2026-07-05-...) maps
-- (provider, model) -> family for HAL quorum disjointness. This column is the PER-AGENT family
-- of a repid_agents row. They are distinct mechanisms; this migration does not touch the registry.

ALTER TABLE repid_agents ADD COLUMN model_family text;
-- Idempotent re-apply form (same column, guarded):
--   ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS model_family text;

COMMENT ON COLUMN repid_agents.model_family IS
  'First-class model family of this agent (the disjointness key for the counterparty '
  'independence check, confirmed-outcome rule 4). NULL = unknown => fails closed (no '
  'confirmation). PRIMARY source; capabilities.model_family jsonb is the fallback. '
  'No default/backfill: a family is recorded, never guessed.';

-- POST-APPLY VERIFY:
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='repid_agents' AND column_name='model_family';
--   -- expect: model_family | text | YES | (null)
-- SELECT count(*) AS agents, count(model_family) AS with_family FROM repid_agents;
--   -- immediately after apply: with_family = 0 (every agent still fails closed, as intended)

-- ROLLBACK (also in migrations/rollback/DOWN_2026-10-12-repid-agents-model-family.sql):
-- ALTER TABLE repid_agents DROP COLUMN IF EXISTS model_family;
