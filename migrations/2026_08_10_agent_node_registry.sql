-- agent_node_registry — ONE record per (node, lane) carrying THREE things that were
-- about to be built as three separate registries: the write LEASE, the CAPABILITY
-- manifest, and the liveness signal.
--
-- WHY ONE TABLE. Three registries describing the same entity drift, and drift is the
-- exact failure this whole effort exists to kill. A lease says "what I own", a manifest
-- says "what I can do", a heartbeat says "am I alive" — all three are properties of one
-- running node, keyed the same way, updated on the same tick.
--
-- WHY NOT REUSE agent_heartbeat. Different grain. agent_heartbeat is keyed on
-- agent_name (a Trinity agent identity, one row per agent). This is keyed on
-- (node_id, lane) — a MACHINE holding a WORK ALLOCATION. One node can hold several
-- lanes; one lane can move between nodes. Overloading agent_heartbeat would conflate
-- "who is this agent" with "what is this box currently allowed to write".
--
-- NO `status` COLUMN — DELIBERATE. agent_heartbeat has one, and it is the column the
-- preflight rules call "the lying status column": a process that dies cannot update its
-- own status to 'dead', so a status enum reports health right up until it is most wrong.
-- Liveness here is DERIVED from heartbeat_at recency, mirroring v_fleet_truth
-- (`last_ping > now() - interval '10 minutes'`). Same idiom, one health language.
--
-- APPLIED: not yet. Net-new additive object (CLAUDE_RULES 7 permits self-apply for
-- net-new); held for Sean's look because it is the schema other things will bind to.

create table if not exists public.agent_node_registry (
  id            uuid primary key default gen_random_uuid(),

  -- WHO / WHERE ------------------------------------------------------------------
  -- Stable per machine, NOT per session: a laptop that opens 50 Claude sessions is
  -- still one node with one set of paths. Identity must not be the hostname either —
  -- a node moves VPS -> home NAS -> a friend's PC and keeps its reputation.
  node_id       text        not null,
  -- 'claude-code' | 'railway' | 'vps' | 'grok' | 'gemini' | 't12' ...
  surface       text        not null,
  -- Must match an id in src/orchestration/lanes.ts (hal | identity-pay | zkp | engine-core).
  lane          text        not null,

  -- THE LEASE --------------------------------------------------------------------
  -- Repo-relative POSIX globs this node may write. Overlap is refused in TypeScript,
  -- not here: glob overlap is not expressible as a useful SQL constraint, and a check
  -- that only half-works would be worse than an honest application-level gate.
  owns          text[]      not null default '{}',
  branch        text,
  purpose       text,

  -- THE CAPABILITY MANIFEST ------------------------------------------------------
  -- Schedule on facts, not on the assumption that every node is equal.
  models        text[]      not null default '{}',
  cpu_cores     integer,
  ram_mb        integer,
  region        text,
  can_prove     boolean     not null default false,
  -- FAIL CLOSED, AND THIS IS THE IMPORTANT ONE. A 3B model on an old laptop must never
  -- silently join the accuracy quorum — weak voters drag F1 and destroy the glass box.
  -- Default false means a new node is triage-only until someone deliberately promotes it.
  can_hal_vote  boolean     not null default false,

  -- LIVENESS + LEASE VALIDITY ----------------------------------------------------
  acquired_at   timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  -- Authoritative for the LEASE (matches write-lease.ts: expiresAt decides, not TTL math).
  -- Deliberately LONGER than the 10-minute liveness window, so a node reads as NOT LIVE
  -- before its paths are released — you get a window to notice, instead of a silent handoff.
  expires_at    timestamptz not null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One lease per (node, lane). Re-acquiring upserts rather than accumulating rows.
  constraint agent_node_registry_node_lane_key unique (node_id, lane)
);

create index if not exists agent_node_registry_lane_idx      on public.agent_node_registry (lane);
create index if not exists agent_node_registry_heartbeat_idx on public.agent_node_registry (heartbeat_at desc);
create index if not exists agent_node_registry_expires_idx   on public.agent_node_registry (expires_at);

alter table public.agent_node_registry enable row level security;

-- v_node_truth — the SAME shape and threshold as v_fleet_truth, on purpose.
-- Two different definitions of "live" in one system is how "is the swarm healthy?"
-- gets two answers. `lease_active` is separate from `is_live` because they answer
-- different questions: is anyone home, versus may this node still write.
create or replace view public.v_node_truth as
select
  node_id,
  surface,
  lane,
  owns,
  models,
  can_hal_vote,
  can_prove,
  region,
  heartbeat_at,
  round(extract(epoch from now() - heartbeat_at) / 60.0, 1) as minutes_since_heartbeat,
  heartbeat_at > (now() - '00:10:00'::interval)             as is_live,
  expires_at,
  expires_at > now()                                        as lease_active
from public.agent_node_registry;

-- SECURITY_INVOKER — NOT optional, and the security advisor flagged it as ERROR within
-- seconds of the create. A Postgres view defaults to the OWNER's privileges, so this view
-- would read agent_node_registry with RLS BYPASSED — handing any caller of the view the
-- full lease + capability map of every node, defeating the RLS enabled directly above it.
-- security_invoker evaluates the view under the CALLER's rights, so the table's RLS is
-- what decides. Any future view over this table needs the same line.
alter view public.v_node_truth set (security_invoker = true);

comment on table public.agent_node_registry is
  'One row per (node, lane): write lease + capability manifest + heartbeat. No status column by design — liveness is derived from heartbeat_at recency (see v_node_truth), because a dead process cannot mark itself dead.';
comment on column public.agent_node_registry.can_hal_vote is
  'Fail-closed. FALSE means triage-only: this node may not join the HAL accuracy quorum. Weak local models drag F1; promotion is deliberate, never inherited.';
