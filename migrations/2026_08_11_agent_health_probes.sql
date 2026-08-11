-- agent_health_probes + v_fleet_truth probe precedence.  APPLIED 2026-08-11 (DDL log).
--
-- WHY. Every liveness surface in this database was derived from work an agent CHOSE to do:
-- agent_heartbeat.last_ping (writes removed 2026-07-17, starved), trinity_agent_logs (proves it
-- RAN, not that it is UP), trinity_swarm_health (a view over the same). None can distinguish
-- "idle but healthy" from "gone" -- which is how v_fleet_truth came to report 12 healthy agents
-- as dead while three of them answered HTTP 200.
--
-- An external GET /health cannot be faked by a dead process. That is the structural property a
-- self-reported status column can never have, and it is the only reason this table exists.
--
-- MEASURED IMMEDIATELY AFTER WIRING: 12/12 agents HTTP 200 (266-532ms), liveness_signal='probe'.
-- Before the probe existed the work-log signal could prove only 3 -- the other 9 were
-- indistinguishable from dead. The view had previously asserted that all 12 were dead.
--
-- EVIDENCE PRECEDENCE (strongest first): probe > heartbeat > work > none (NULL).
-- is_live may only be FALSE when a probe actually answered non-2xx -- a verdict, not an absence.
--
-- Writer: scripts/liveness-probes/probe-agent-health.ts. NEEDS SCHEDULING: probes older than
-- 10 minutes stop counting and the view correctly falls back to weaker evidence.

create table if not exists public.agent_health_probes (
  id          bigserial primary key,
  agent_name  text        not null,
  url         text        not null,
  -- NULL = the request never completed (DNS/TLS/timeout) and is NOT the same fact as a 5xx,
  -- which means the host answered. Collapsing them hides "unreachable" inside "down".
  http_status integer,
  ok          boolean     not null,
  latency_ms  integer,
  error       text,
  probed_at   timestamptz not null default now()
);

create index if not exists agent_health_probes_agent_time_idx
  on public.agent_health_probes (agent_name, probed_at desc);

-- RLS enabled on the deployed table (service-role only; no policies, fail-closed).
-- Applied via the Supabase migration `agent_health_probes`.

-- v_fleet_truth is replaced to prefer probe evidence; the deployed definition lives in the
-- Supabase migration `v_fleet_truth_prefers_http_probe`.
