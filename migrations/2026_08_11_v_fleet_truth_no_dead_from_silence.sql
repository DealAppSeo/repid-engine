-- v_fleet_truth — stop asserting "dead" from an absent signal.  APPLIED 2026-08-11 (DDL log).
--
-- THE BUG. is_live was `last_ping > now() - 10min` over agent_heartbeat. Agent-side heartbeat
-- writes were DELIBERATELY REMOVED on 2026-07-17 in favour of UptimeRobot + /health, so last_ping
-- froze. The view then reported is_live=false for ALL 12 trinity agents while trinity-orch,
-- -veritas and -sophia were returning HTTP 200 on /health.
--
-- A monitoring surface that reports healthy services as dead is worse than none. This is the
-- premise bug `trinity-preflight` exists to prevent, sitting inside the very view that skill
-- names as its source of truth — so every session was told to trust it.
--
-- THE FIX. Never conclude "dead" from silence:
--   TRUE = positive evidence of life inside the window · NULL = no signal, unknown, NOT dead.
-- Conflating NULL with FALSE is exactly what broke. Column ORDER is preserved so this is a
-- CREATE OR REPLACE, not a drop: positional readers are unaffected and new columns append.
--
-- SECOND SIGNAL. trinity_agent_logs: an agent that WROTE a log 3 minutes ago was demonstrably
-- running 3 minutes ago. Real evidence, unlike a status column. But it is WORK-DONE, not
-- PROCESS-UP — an agent can be up and idle — so its absence yields NULL, never false.
--
-- STILL NOT IN THIS DATABASE: true process liveness. Only the HTTP /health probe knows it and
-- that lives in UptimeRobot. `liveness_signal` names the evidence behind each row so a reader can
-- distinguish a real verdict from an absent one.
--
-- MEASURED IMMEDIATELY AFTER APPLYING: 3 agents true (signal='work', 0.6-4.5 min), 9 null
-- (signal='none'). Previously all 12 were false. Zero are now asserted dead, which is correct —
-- there is no evidence that any of them is down.

-- (definition below mirrors what is deployed; see the Supabase migration of the same name)
create or replace view public.v_fleet_truth as
 WITH work AS (
         SELECT COALESCE(trinity_agent_logs.agent_name, trinity_agent_logs.agent) AS who,
            max(trinity_agent_logs.created_at) AS last_work_at
           FROM trinity_agent_logs
          WHERE trinity_agent_logs.created_at > (now() - '7 days'::interval)
          GROUP BY (COALESCE(trinity_agent_logs.agent_name, trinity_agent_logs.agent))
        )
 SELECT h.agent_name,
    h.last_ping,
    round(EXTRACT(epoch FROM now() - h.last_ping) / 60.0, 1) AS minutes_since_ping,
        CASE
            WHEN h.last_ping > (now() - '00:10:00'::interval) THEN true
            WHEN w.last_work_at > (now() - '00:10:00'::interval) THEN true
            ELSE NULL::boolean
        END AS is_live,
    h.railway_service_id,
    h.code_version,
    w.last_work_at,
    round(EXTRACT(epoch FROM now() - w.last_work_at) / 60.0, 1) AS minutes_since_work,
        CASE
            WHEN h.last_ping > (now() - '00:10:00'::interval) THEN 'heartbeat'::text
            WHEN w.last_work_at > (now() - '00:10:00'::interval) THEN 'work'::text
            ELSE 'none'::text
        END AS liveness_signal
   FROM agent_heartbeat h
     LEFT JOIN work w ON w.who = h.agent_name;
