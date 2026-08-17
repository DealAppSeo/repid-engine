-- Capture the /health BODY, not just its status code.
--
-- APPLIED to project qnnpjhlxljtqyigedwkb on 2026-08-17 (migration
-- `agent_health_probes_capture_loop_signal`). Recorded here so the schema is in
-- the repo as well as in the database.
--
-- WHY. Agent presence writes to `agent_heartbeat` were deliberately turned off
-- in 2026-07 (HEARTBEAT_MODE='off' / legacy HEARTBEAT_DB_WRITES=off in
-- ConstitutionalAgentV4) to shed ~8.6M writes/day. The replacement shipped
-- correctly: each agent's GET /health returns {alive, loopCount,
-- lastIterationAt, currentTaskId, uptimeSec, codeVersion} from process memory,
-- so a hung loop is externally detectable — loopCount stops advancing and
-- lastIterationAt goes stale while the process still answers 200.
--
-- The prober then recorded only http_status/ok/latency_ms and DISCARDED the
-- body. So every 5 minutes the fleet's real liveness signal was fetched over
-- HTTP and thrown away, leaving exactly the one bit that was never sufficient:
-- did it answer. Measured 2026-08-17: all twelve agents at HTTP 200 with zero
-- repid_score_events and zero hal_classifications — indistinguishable, from
-- this table, from a fully working fleet.
--
-- ADDITIVE AND NULLABLE ONLY. Every column is nullable with no default and no
-- backfill: existing rows stay valid, existing inserts naming only the old
-- columns keep working, and a probe that cannot parse a body writes NULL rather
-- than a zero. NULL means "not observed" and must never be read as 0 — a
-- zero-valued loop_count is a claim, a NULL is the absence of one.

alter table public.agent_health_probes
  add column if not exists alive             boolean,
  add column if not exists loop_count        integer,
  add column if not exists last_iteration_at timestamptz,
  add column if not exists current_task_id   text,
  add column if not exists uptime_sec        integer,
  add column if not exists code_version      text,
  -- Why the parse failed, when it did. Distinguishes "agent serves a body we
  -- cannot read" from "agent serves no body at all" — different faults.
  add column if not exists body_error        text;

comment on column public.agent_health_probes.loop_count is
  'From GET /health body. NULL = not observed (unparsed/absent), never 0. The agent_heartbeat.loop_count column is frozen at 2026-07-17 and must not be used.';
comment on column public.agent_health_probes.last_iteration_at is
  'From GET /health body. Freshness of THIS is the hung-loop signal — a process can answer 200 forever while the loop stops advancing.';

-- Latest probe per agent. The endpoint reads this rather than ordering in the
-- app, so "most recent" is defined in one place.
create index if not exists agent_health_probes_agent_probed_at_idx
  on public.agent_health_probes (agent_name, probed_at desc);
