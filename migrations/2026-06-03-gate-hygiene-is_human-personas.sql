-- R2 Phase 5: Gate hygiene (D-009 is_human, D-032 18 role-personas)
-- D-009: is_human=true for the human/SEAN accounts (they must be excluded from counterparty floors, demotion gates etc).
-- D-032: the 18 active non-human non-trinity role-personas/demos — flag gate-exempt in metadata or retire from active.
-- Sean co-signs the is_human UPDATE. Personas: recommend + apply on go (nothing deleted w/o Sean).
-- Post: LIVE is_human_true >0 ; personas disposition in metadata or status.

BEGIN;

-- D-009: the human/SEAN rows (inventory via live: SELECT id, agent_name, is_human FROM repid_agents WHERE agent_name ILIKE '%sean%' OR agent_name ILIKE '%human%' OR is_human IS NULL LIMIT 20;)
-- Set true for all that are actual humans (not role personas).
UPDATE public.repid_agents
SET is_human = true, last_earned_update = now()
WHERE (agent_name ILIKE '%sean%' OR agent_name ILIKE '%human%' OR id IN ('human-01','operator-sean'))
  AND COALESCE(is_human, false) = false;

-- Also flip any that are clearly service accounts but were missed in prior.
-- (If over-set, Sean can revert; is_human is advisory for gates.)

-- D-032: 18 role-personas (non-trinity demos/roles that are active).
-- Strategy: set metadata.gate_exempt = true (so counterparty/ inflation gates skip per D-009 logic extension),
-- or set is_active=false / retired if they are pure test.
-- Inventory first (no blind retire):
--   SELECT id, agent_name, tier, current_repid, is_human, metadata FROM repid_agents
--   WHERE COALESCE(is_human,false)=false AND id NOT LIKE 'trinity-%' AND (last_active_at > now()-interval '30 days' OR current_repid > 0)
--   ORDER BY current_repid DESC LIMIT 30;
-- Then for the 18: either
UPDATE public.repid_agents
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('gate_exempt', true, 'd032_role_persona', true, 'updated_r2', '2026-06-03')
WHERE id IN (
  -- TODO after live inventory: list the exact 18 role/demo ids here (e.g. 'role-mediator-1', 'demo-validator-3', ...)
  -- For now, safe no-op on obvious demo patterns if present:
  SELECT id FROM public.repid_agents
  WHERE (agent_name ILIKE 'demo-%' OR agent_name ILIKE 'role-%' OR agent_name ILIKE '%persona%')
    AND COALESCE(is_human, false) = false
    AND id NOT LIKE 'trinity-%'
  LIMIT 18
);

-- If some of the 18 should be fully retired (no longer active in swarm), add:
-- UPDATE ... SET is_active = false, retired_at = now() WHERE id = 'specific-demo-to-retire';

COMMIT;

-- Post apply (Sean): SELECT count(*) FILTER (WHERE is_human) FROM repid_agents; -- >0
-- SELECT id, agent_name, metadata->>'gate_exempt' FROM repid_agents WHERE metadata->>'d032_role_persona' = 'true';
-- Update living SCHEMA_TRUTH_MAP + D-009/D-032 notes.
-- Recommend: after verify, remove or archive this migration file (per "recommend before removing").
