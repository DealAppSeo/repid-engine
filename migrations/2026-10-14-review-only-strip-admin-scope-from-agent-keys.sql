-- REVIEW-ONLY. Ends in ROLLBACK. Nothing here has been applied. [S1 2026-10-14]
--
-- WHY. POST /api/v1/agents/register is keyless and issued every new agent a key scoped
-- ['score_event','llm_complete','read_card','admin']. The controller read 'admin' as admin
-- (sleep/wake/sprint, directives, controller tokens, HITL decide). The code fix stops honouring
-- the scope and stops issuing it; this strips it from the keys already issued, so no older code
-- path, and no future one that trusts the scope again, inherits the hole.
--
-- SCHEMA [V prod 2026-10-14, information_schema + pg_trigger]: public.agent_api_keys has
-- id uuid, agent_id uuid, key_hash text, key_prefix text, name text, created_at, last_used_at,
-- revoked_at timestamptz, scopes text[] default '{}'. No triggers. (The tier / request_id /
-- expires_at columns from 20260524120000 are NOT on prod.)
--
-- WHICH ROWS [V prod 2026-10-14]. 275 keys in total. 86 carry 'admin' (85 live, 1 revoked), and
-- every one has the registration route's exact signature: name = 'default' and
-- scopes = {score_event,llm_complete,read_card,admin}. 20 were ever used, all by probe or test
-- agents (trinity-xc1-stranger-run1, trinity-cc-sdk-smoke-*, ...), none by the house fleet.
-- 0 rows carry 'operator'. 0 carry 'bounty_verify'. No operator path issued 'admin'
-- (operator scripts insert other scopes, and nothing else writes this table with 'admin').
-- So the predicate below, the registration signature, matches all of them, and only them.
--
-- EFFECT. The keys keep working as the agent itself (score_event, llm_complete, read_card).
-- Key management no longer needs 'admin' (routes/key-management.ts is now self-auth), so no
-- legitimate holder loses anything.
--
-- TO APPLY: run as is and read the three result sets. If the before count is 86 (or the
-- registration-only number has grown, which is new self-registrations since this was written),
-- and after = 0, change the last line to COMMIT.

-- 1. Before.
SELECT
  count(*) FILTER (WHERE 'admin' = ANY(scopes))                                AS admin_rows,
  count(*) FILTER (WHERE 'admin' = ANY(scopes) AND revoked_at IS NULL)         AS admin_live,
  count(*) FILTER (WHERE 'admin' = ANY(scopes)
                     AND NOT (name = 'default'
                              AND scopes = ARRAY['score_event','llm_complete','read_card','admin']::text[]))
                                                                               AS admin_not_registration_shape,
  count(*) FILTER (WHERE 'operator' = ANY(scopes))                             AS operator_rows
FROM public.agent_api_keys;
-- Expected [V 2026-10-14]: 86 | 85 | 0 | 0. A non-zero admin_not_registration_shape means a key
-- was given 'admin' some other way: STOP and look at those rows before changing anything.

BEGIN;

UPDATE public.agent_api_keys
   SET scopes = array_remove(scopes, 'admin')
 WHERE name = 'default'
   AND scopes = ARRAY['score_event','llm_complete','read_card','admin']::text[];
-- Expected: UPDATE 86 (at time of writing).

-- 2. After, inside the transaction.
SELECT
  count(*) FILTER (WHERE 'admin' = ANY(scopes))                                          AS admin_rows_after,
  count(*) FILTER (WHERE name = 'default'
                     AND scopes = ARRAY['score_event','llm_complete','read_card']::text[]) AS registration_shape_after
FROM public.agent_api_keys;
-- Expected: 0 | 89 (86 stripped + 3 'default' keys that already had exactly these scopes [V 2026-10-14]).

ROLLBACK;
