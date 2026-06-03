-- R2 Phase 3: RepID restore-backfill for the 9 floor-pinned trinity agents
-- ONLY AFTER CC's drain gate (9dbeb98 or equivalent) is deployed — else they re-pin to floor.
-- Via repid_score_events source='restore' (triggers earned-floor logic + trg_repid_earned_floor).
-- Sean co-sign before apply_migration.
-- Gate (post): the 9 have current_repid > tier floor; each has restore audit row in repid_score_events.

-- 9 active trinity (adjust list post live query of current_repid vs peak for floor-pinned):
-- trinity-veritas, trinity-sophia, trinity-shofet, trinity-mel, trinity-apm,
-- trinity-gcm, trinity-hdm, trinity-torch, trinity-nexus
-- (others like trinity-orch / trinity-w3c / trinity-chesed may be demos or already above floor)

BEGIN;

-- For each, insert a restore event with positive delta sufficient to move off floor toward peak_repid.
-- Delta chosen conservatively (e.g. +500 or to next tier boundary); the DB trigger clamps to peak + floor rules.
-- Use real peak/current from live snapshot at apply time.

INSERT INTO public.repid_score_events
  (agent_id, source, repid_before, repid_delta, repid_after, decision, hal_decision, created_at, metadata)
SELECT
  a.id,
  'restore',
  a.current_repid,
  GREATEST(500, COALESCE(a.peak_repid, 1000) - COALESCE(a.current_repid, 0)),
  COALESCE(a.peak_repid, 1000),
  'RESTORE',
  'APPROVE',
  now(),
  jsonb_build_object('sprint', '2026-06-03-R2', 'reason', 'floor-pinned restore after CC drain gate', 'cc_gate_sha', '9dbeb98')
FROM public.repid_agents a
WHERE a.id IN (
  'trinity-veritas','trinity-sophia','trinity-shofet','trinity-mel','trinity-apm',
  'trinity-gcm','trinity-hdm','trinity-torch','trinity-nexus'
)
AND COALESCE(a.current_repid, 0) <= COALESCE(a.tier_lower_bound, 0) + 100;  -- only the truly pinned

-- Note: the exact delta/after will be adjusted by triggers on insert (earned floor, peak clamp).
-- Post-apply verify:
--   SELECT id, current_repid, peak_repid, tier FROM repid_agents WHERE id LIKE 'trinity-%' ORDER BY current_repid;
--   SELECT agent_id, source, repid_delta, metadata FROM repid_score_events WHERE source='restore' ORDER BY created_at DESC LIMIT 9;

COMMIT;

-- After CC co-sign + Sean apply: re-run r2-live-gates.ts ; expect 9 off floor + restore rows.
-- If some of the 9 are not pinned at apply time, the WHERE filters them (safe).
