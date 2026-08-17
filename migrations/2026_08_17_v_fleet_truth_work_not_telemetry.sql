-- v_fleet_truth — restore "no dead from silence", stop counting telemetry as work,
-- and promote the loop signal that now actually exists.
--
-- ***** NOT APPLIED. This file is a PROPOSAL. Sean gates it. *****
-- Nothing here has been run against any database. Every measurement quoted below was
-- taken with read-only SELECTs on 2026-08-17.
--
-- ============================================================================
-- 0. THE DIVERGENCE THAT STARTED THIS
-- ============================================================================
-- `2026_08_11_v_fleet_truth_no_dead_from_silence.sql` records itself as APPLIED and its
-- whole purpose was: TRUE = positive evidence of life · NULL = unknown, NOT dead. The
-- definition running in the database today ends that CASE with `ELSE false`.
--
-- So the deployed view does not match the migration that claims to define it, and the
-- one rule that migration exists to enforce is the exact rule that is missing.
--
-- WHETHER IT WAS NEVER APPLIED OR APPLIED AND LATER REVERTED IS **NOT CHECKED**. Both
-- stories fit what is observable, the DDL log was not examined, and guessing between
-- them would put a fourth unverified inference into a file whose subject is unverified
-- inference. If it matters, read the DDL log — do not read this comment as an answer.
--
-- The lesson is the divergence itself: a migration file is a record of INTENT, and this
-- repo had no check that the database agreed with it. `pg_get_viewdef` is the source of
-- truth; the file is not.
--
-- ============================================================================
-- 1. WHY THIS SURFACED NOW — one frozen column, read by three surfaces
-- ============================================================================
-- Narrative and the rest of that night's measurements:
-- reports/2026-08-17/CTO_NIGHT_BRIEF.md. Kept there, not here, per CLAUDE.md.
--
-- Agent presence writes were deliberately turned off in 2026-07 (HEARTBEAT_MODE='off')
-- to shed millions of writes a day. Two columns froze on that date and have been ageing
-- one minute per minute since: `agent_heartbeat.last_ping` and
-- `trinity_heartbeat.last_seen`. THREE surfaces still read them as liveness:
--
--   (a) this view's `heartbeat` branch, via agent_heartbeat.last_ping;
--   (b) the trinity swarm's own group watchdog (ConstitutionalAgentV4
--       runSurvivorResurrection), via trinity_heartbeat.last_seen;
--   (c) `agent_heartbeat.code_version`, still projected as column 6 below — see §5.
--
-- (b) is the one that mattered, and it is why this file exists. Because the watchdog
-- alerted on a field nothing writes, its alert could never clear: every agent declared
-- all eleven others DOWN, forever. Those alerts were the ONLY writer to
-- `trinity_agent_logs` attributable to a fleet agent — and this view's `work` branch
-- treats a recent log row as evidence of work.
--
-- SO THE DEAD SENSOR MANUFACTURED THE LIVE SIGNAL. A frozen column produced a flood of
-- false alarms, and the flood was then read, two surfaces downstream, as proof that the
-- agents were working. The view was not measuring the fleet; it was measuring its own
-- echo.
--
-- THE PART WORTH REMEMBERING: fixing the watchdog is what EXPOSES this. Silencing those
-- alerts removes the fake `work` signal, and every agent that had it drops through to
-- the `ELSE false` above and reads DEAD — while serving HTTP 200 with an advancing loop
-- counter. The repair of one bug uncovers the reverted fallback under it. A fix that
-- makes a dashboard look worse is not a regression; it is the removal of a lie that was
-- holding the number up.
--
-- ============================================================================
-- 2. CHANGE ONE — `ELSE false` becomes `ELSE NULL::boolean`
-- ============================================================================
-- Restores the documented rule. `false` is now a verdict that must be EARNED by positive
-- evidence (see `loop_stalled` in §4), not the default that silence falls into.
--
-- ============================================================================
-- 3. CHANGE TWO — a log row counts as work only if it names a task
-- ============================================================================
-- `work` previously counted ANY row in trinity_agent_logs. Most rows are telemetry, and
-- telemetry is not work: an agent emitting a health complaint every loop is not doing
-- its job, it is talking about itself.
--
-- THE DISCRIMINATOR IS MEASURED, NOT ASSUMED. The agent writes the task id into the
-- metadata JSONB (`metadata->>'taskId'`), never into the `task_id` COLUMN. A predicate on
-- the column matches NOTHING and would have read as a dead fleet — that check was run,
-- and it is the right check for the wrong property. Over the last 30 days,
-- `metadata ? 'taskId'` is a clean separator: EVERY row of every task-path action carried
-- it (task_processing, task_escalated, success_criteria_skipped,
-- substance_gate_shadow_reject, substance_gate_degraded), and NOT ONE row of any
-- telemetry action did (survivor_alert, api_auth_attempt, repid_score_changed).
--
-- WHY THIS SHAPE AND NOT A NAME LIST. The requirement was to fail toward UNKNOWN when
-- meeting something unrecognised. Both an allowlist of work-action names and this
-- predicate do that. This one is better because it does not need maintaining: a new
-- task-path action is counted the day it ships, and a new telemetry action is excluded
-- the day it ships, without anyone editing this view. That matters concretely — the
-- watchdog fix adds a NEW telemetry action (`survivor_sensor_suspect`), and this
-- predicate already excludes it.
--
-- NOTE THE INVERTED POLARITY, because the general advice points the other way. A name
-- list used as a GATE fails open on every type added later, which is why prefix matching
-- is preferred there. Here the list would be an allowlist of WORK, so an unrecognised
-- action is simply not counted — it fails CLOSED, to UNKNOWN. Same mechanism, opposite
-- safety direction. Do not port the "prefer prefix match" rule here without re-deriving
-- which way the failure runs.
--
-- HOW THIS CAN STILL FAIL OPEN, stated so it is not discovered later: a telemetry action
-- that happens to carry `taskId` would count as work. Nothing does today. If one appears,
-- that is a defect in the emitter — a log line that names a task it did not process —
-- and it should be fixed there, not patched around here.
--
-- WRITTEN AS `jsonb_exists(metadata, 'taskId')`, NOT `metadata ? 'taskId'`. The two were
-- verified to return identical counts here. The function form is used because `?` is a
-- parameter placeholder in many SQL clients and drivers, and a migration should not
-- depend on which one applies it.
--
-- ALSO WORTH KNOWING: `api_auth_attempt` is the single largest writer to that table, and
-- it never reached this view at all. It is written under the identity `api-gateway`,
-- which is not a row in `agent_heartbeat`, so the join always dropped it. It was never
-- inflating anything. The only telemetry that ever reached the `work` branch was the
-- survivor-alert flood.
--
-- ============================================================================
-- 4. CHANGE THREE — liveness from loop advancement, the signal that now exists
-- ============================================================================
-- `agent_health_probes` gained alive / loop_count / last_iteration_at / uptime_sec on
-- 2026-08-17 (`agent_health_probes_capture_loop_signal`). Before that the view could only
-- ask "did it answer". A process answers 200 forever while its work loop is wedged — that
-- is the failure a status check structurally cannot express, and it is why those columns
-- were added. This view should use them.
--
-- Liveness is now derived across the TWO most recent probes per agent:
--   advancing  — loop_count ticked up between probes, OR last_iteration_at is fresh.
--   stalled    — both loop_counts observed, neither moved, and last_iteration_at is not
--                fresh. Positive evidence of a wedged loop behind a healthy port.
--   unknown    — anything else (one probe only, or loop_count not observed).
--
-- RESTART GUARD. On restart, loop_count resets and the new value is LOWER than the
-- previous probe's. Without a guard that reads as "not advancing" and would alert on
-- every single redeploy. `uptime_sec` going backwards identifies a restart, and a restart
-- is never a stall.
--
-- NULL IS NOT ZERO. `loop_count IS NULL` means the prober did not observe it (the
-- column's own comment says so). It must never be compared as 0 — that would turn "not
-- observed" into "no iterations", which is this file's whole subject in miniature.
--
-- `probe_only` STOPS MEANING TWO THINGS. It used to cover both "it answered, and we know
-- nothing more" and "it answered, and it is wedged". Those are now `probe_only` (⇒
-- is_live NULL, genuinely unknown) and `loop_stalled` (⇒ is_live FALSE, earned).
--
-- ORDERING of the signals is strongest-evidence-first: heartbeat (if presence writes ever
-- return) → loop → work → loop_stalled → probe_only → none. `work` outranks
-- `loop_stalled` deliberately: a task actually processed inside the window is harder
-- evidence than a counter that has not moved.
--
-- ============================================================================
-- 5. WHAT THIS FILE DOES NOT FIX
-- ============================================================================
-- Column 6, `code_version`, still comes from `agent_heartbeat` and is therefore FROZEN at
-- 2026-07-17 like everything else on that table. `agent_health_probes.code_version` holds
-- the live value. It is left alone here because changing what an existing column means,
-- silently, inside a CREATE OR REPLACE is exactly the kind of quiet drift this file is
-- about. It needs its own decision: repoint it, or append `probe_code_version` beside it.
--
-- ============================================================================
-- 6. COMPATIBILITY
-- ============================================================================
-- CREATE OR REPLACE, not DROP: all 14 existing columns keep their names, types and
-- POSITIONS, so positional readers are unaffected. The six new columns append. `is_live`
-- stays boolean — it gains NULL as an inhabited value, which the 2026-08-11 migration
-- already intended.

create or replace view public.v_fleet_truth as
 WITH work AS (
         -- A log row is evidence of WORK only if it names the task it was working on.
         -- Telemetry (survivor alerts, auth attempts) carries no taskId and is excluded.
         -- See §3: measured separator, fails closed to UNKNOWN on anything unrecognised.
         SELECT COALESCE(trinity_agent_logs.agent_name, trinity_agent_logs.agent) AS who,
            max(trinity_agent_logs.created_at) AS last_work_at
           FROM trinity_agent_logs
          WHERE trinity_agent_logs.created_at > (now() - '7 days'::interval)
            AND jsonb_exists(trinity_agent_logs.metadata, 'taskId')
          GROUP BY (COALESCE(trinity_agent_logs.agent_name, trinity_agent_logs.agent))
        ), probe AS (
         -- Latest probe per agent, carrying the PREVIOUS probe's counters alongside it.
         -- lead() over a DESC partition looks one row further back in time, so a single
         -- pass yields both rows we need to measure advancement.
         SELECT s.agent_name, s.probe_ok, s.http_status, s.probed_at, s.latency_ms,
            s.loop_count, s.prev_loop_count, s.last_iteration_at,
            s.uptime_sec, s.prev_uptime_sec
           FROM ( SELECT agent_health_probes.agent_name,
                    agent_health_probes.ok AS probe_ok,
                    agent_health_probes.http_status,
                    agent_health_probes.probed_at,
                    agent_health_probes.latency_ms,
                    agent_health_probes.loop_count,
                    agent_health_probes.last_iteration_at,
                    agent_health_probes.uptime_sec,
                    lead(agent_health_probes.loop_count) OVER w AS prev_loop_count,
                    lead(agent_health_probes.uptime_sec) OVER w AS prev_uptime_sec,
                    row_number() OVER w AS rn
                   FROM agent_health_probes
                  WHERE agent_health_probes.probed_at > (now() - '1 day'::interval)
                  WINDOW w AS (PARTITION BY agent_health_probes.agent_name
                               ORDER BY agent_health_probes.probed_at DESC)) s
          WHERE s.rn = 1
        ), flag AS (
         SELECT h.agent_name, h.last_ping, h.railway_service_id, h.code_version,
            w.last_work_at, p.probe_ok, p.http_status, p.probed_at,
            p.loop_count, p.prev_loop_count, p.last_iteration_at, p.uptime_sec,
            (h.last_ping > (now() - '00:10:00'::interval)) AS pinged,
            (w.last_work_at > (now() - '00:10:00'::interval)) AS worked,
            (p.probed_at > (now() - '00:10:00'::interval) AND p.probe_ok) AS reachable,
                CASE
                    -- Not reachable inside the window ⇒ we have no basis for a loop
                    -- verdict at all. NULL, never false.
                    WHEN NOT (p.probed_at > (now() - '00:10:00'::interval) AND p.probe_ok) THEN NULL::boolean
                    -- A fresh iteration timestamp is direct evidence the loop turned.
                    WHEN p.last_iteration_at > (now() - '00:10:00'::interval) THEN true
                    -- Counter not observed on either probe ⇒ unknown. NULL is not 0.
                    WHEN p.loop_count IS NULL OR p.prev_loop_count IS NULL THEN NULL::boolean
                    -- uptime went backwards ⇒ the process restarted between probes. The
                    -- counter reset; that is not a stall and must not read as one.
                    WHEN p.uptime_sec IS NOT NULL AND p.prev_uptime_sec IS NOT NULL
                         AND p.uptime_sec < p.prev_uptime_sec THEN NULL::boolean
                    WHEN p.loop_count > p.prev_loop_count THEN true
                    ELSE false
                END AS loop_advancing
           FROM agent_heartbeat h
             LEFT JOIN work w ON w.who = h.agent_name
             LEFT JOIN probe p ON p.agent_name = h.agent_name
        )
 SELECT f.agent_name,
    f.last_ping,
    round(EXTRACT(epoch FROM now() - f.last_ping) / 60.0, 1) AS minutes_since_ping,
        CASE
            WHEN f.pinged THEN true
            WHEN f.loop_advancing THEN true
            WHEN f.worked THEN true
            -- The ONLY earned false: the process answers, and its loop provably is not
            -- advancing. Every other absence of evidence falls to NULL below.
            WHEN f.loop_advancing IS FALSE THEN false
            ELSE NULL::boolean
        END AS is_live,
    f.railway_service_id,
    f.code_version,
    f.last_work_at,
    round(EXTRACT(epoch FROM now() - f.last_work_at) / 60.0, 1) AS minutes_since_work,
        CASE
            WHEN f.pinged THEN 'heartbeat'::text
            WHEN f.loop_advancing THEN 'loop'::text
            WHEN f.worked THEN 'work'::text
            WHEN f.loop_advancing IS FALSE THEN 'loop_stalled'::text
            WHEN f.reachable THEN 'probe_only'::text
            ELSE 'none'::text
        END AS liveness_signal,
    f.probe_ok,
    f.http_status AS probe_http_status,
    f.probed_at,
    round(EXTRACT(epoch FROM now() - f.probed_at) / 60.0, 1) AS minutes_since_probe,
        CASE
            WHEN f.probed_at > (now() - '00:10:00'::interval) THEN f.probe_ok
            ELSE NULL::boolean
        END AS is_reachable,
    -- --- appended 2026-08-17: the loop signal, so a reader can audit the verdict ---
    f.loop_count,
    f.prev_loop_count,
    f.loop_advancing,
    f.last_iteration_at,
    round(EXTRACT(epoch FROM now() - f.last_iteration_at) / 60.0, 1) AS minutes_since_iteration,
    f.uptime_sec
   FROM flag f;

comment on view public.v_fleet_truth is
  'Fleet liveness. is_live: true = positive evidence · false = EARNED only by a stalled loop behind a reachable port · NULL = unknown, NEVER "dead". work counts only log rows naming a taskId, so telemetry cannot masquerade as work. See migrations/2026_08_17_v_fleet_truth_work_not_telemetry.sql.';
