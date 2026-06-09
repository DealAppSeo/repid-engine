-- R3: RepID restore-9 (keep staged; apply ONLY AFTER Sean deploys CC drain gate 9dbeb98 or equiv, else re-pins to floor).
-- Via repid_score_events source='restore' (triggers floor/peak logic).
-- Sean co-sign + apply_migration post-deploy.
-- Rollback: delete the restore events for the 9.

BEGIN;

INSERT INTO public.repid_score_events (agent_id, source, repid_before, repid_delta, repid_after, decision, hal_decision, created_at, metadata)
SELECT a.id, 'restore', COALESCE(a.current_repid,0),
       GREATEST(300, COALESCE(a.peak_repid,800) - COALESCE(a.current_repid,0)),
       COALESCE(a.peak_repid,800), 'RESTORE', 'APPROVE', now(),
       jsonb_build_object('r3','2026-06-03','note','apply only after CC drain gate deploy','cc_gate','9dbeb98')
FROM public.repid_agents a
WHERE a.id IN ('trinity-veritas','trinity-sophia','trinity-shofet','trinity-mel','trinity-apm','trinity-gcm','trinity-hdm','trinity-torch','trinity-nexus')
  AND COALESCE(a.current_repid,0) <= 600;  -- only the pinned ones at apply time

COMMIT;

-- Post (after deploy): SELECT id, current_repid, peak_repid FROM repid_agents WHERE id LIKE 'trinity-%' ORDER BY current_repid;
-- SELECT agent_id, source, repid_delta, metadata FROM repid_score_events WHERE source='restore' AND created_at > '2026-06-03' LIMIT 9;
-- To revert: DELETE FROM repid_score_events WHERE source='restore' AND metadata->>'r3' = '2026-06-03';
