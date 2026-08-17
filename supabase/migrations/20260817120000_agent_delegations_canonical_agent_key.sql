-- ============================================================================
-- agent_delegations: give a signed grant an UNAMBIGUOUS subject.
--
-- *** NOT APPLIED. *** Written for review, deliberately not run against the live
-- database — the same posture as the delegations table's own migration above it.
-- Nothing in this file changes behaviour on its own; the resolver that motivates
-- it (services/agent-owner-resolver.ts) reads the CURRENT schema and refuses to
-- attribute an ambiguous grant rather than depending on this landing first.
--
-- THE DEFECT. `agent_delegations.agent_id` is TEXT holding `repid_agents.
-- agent_name`, chosen (see 20260702000000) to match how the settlement path keys
-- its lookups. That choice assumed agent_name identifies an agent.
--
-- IT DOES NOT. MEASURED 2026-08-17 against production: agent_name is not unique
-- — 8 distinct names are carried by 39 different agent rows, and one single name
-- is carried by 8 of them. There is no unique constraint on the column, and the
-- name-keyed sources elsewhere in the system (agent_kya_registry) do not even
-- write the name in the same form, so an exact join between them matches ZERO
-- rows while a case-folded, prefix-stripped join matches 12.
--
-- WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE. This row is a SIGNED SPENDING
-- GRANT. A delegation naming a colliding string authorises every agent that
-- shares it — up to eight agents spending against one human's signature, none of
-- which the signer named or saw. The EIP-712 message itself embeds `agent` as a
-- string, so the signature commits to the ambiguous name too: the defect is in
-- the identifier, not merely in the storage.
--
-- WHY THIS IS NOT "ADD A UNIQUE CONSTRAINT ON agent_name". That statement would
-- fail on today's data (39 rows collide), and forcing it through would mean
-- renaming or deleting live agents to satisfy a constraint. The identifier that
-- IS unique already exists: repid_agents.id. This migration adds it alongside
-- the name rather than replacing it, so nothing that reads `agent_id` breaks.
--
-- SAFE TO APPLY WHENEVER SOMEONE CHOOSES TO: the table is empty (0 rows,
-- MEASURED 2026-08-17), so the new column needs no backfill and the NOT NULL
-- decision can be made later without touching data. It is left NULLABLE here
-- precisely so applying it cannot fail — a migration that cannot fail is a
-- migration whose review is about the design, not about the outage.
--
-- WHAT STILL HAS TO HAPPEN BEFORE ENFORCEMENT (not done by this file):
--   1. services/agent-delegation.ts#recordDelegation must populate agent_uuid
--      from the agent row it already loads for the ownership check.
--   2. The EIP-712 Delegation type should carry the uuid, which is a
--      DELEGATION_DOMAIN.version bump — old signatures must not silently verify
--      against a new meaning.
--   3. Only then can agent_uuid become NOT NULL and agent_id become derived.
-- ============================================================================

ALTER TABLE agent_delegations
  ADD COLUMN IF NOT EXISTS agent_uuid UUID REFERENCES repid_agents(id);

COMMENT ON COLUMN agent_delegations.agent_uuid IS
  'Canonical subject of the grant. repid_agents.agent_name (agent_id) is NOT unique - 8 names covered 39 agent rows on 2026-08-17 - so a name-keyed grant can authorise agents its signer never named. Populate this on every new delegation; agent_id is retained for the existing read path.';

CREATE INDEX IF NOT EXISTS idx_agent_delegations_agent_uuid_live
  ON agent_delegations(agent_uuid)
  WHERE revoked_at IS NULL;

-- Diagnostic, not a constraint: how many agent rows answer to each name that a
-- delegation could name. Anything above 1 is a grant whose subject is a set.
-- Kept as a view so the check survives in the database rather than in a
-- session's scrollback.
CREATE OR REPLACE VIEW v_agent_name_ambiguity AS
SELECT agent_name,
       count(*)                       AS agent_rows,
       count(*) > 1                   AS is_ambiguous,
       array_agg(id ORDER BY created_at) AS agent_ids
FROM repid_agents
GROUP BY agent_name
HAVING count(*) > 1;

COMMENT ON VIEW v_agent_name_ambiguity IS
  'Agent names carried by more than one repid_agents row. Every text-keyed authority source (agent_delegations.agent_id, agent_kya_registry.agent_name) is ambiguous for these names, and the owner resolver returns unknown rather than attributing a grant to one of them.';
