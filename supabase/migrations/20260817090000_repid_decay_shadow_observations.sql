-- Decay shadow sweep observations.
--
-- WHY A SWEEP AND NOT THE EXISTING HOOK. Decay is already assessed and recorded
-- on every score event (scoring/pipeline.ts -> decayMetadata), and that path is
-- healthy: 100% of events since 2026-08-10 carry it. It still cannot answer the
-- question the ratchet needs answered.
--
-- Decay is a function of INACTIVITY. An event-triggered hook only observes agents
-- that generate events. As of 2026-08-17: 71 shadow observations covering 13 of
-- 176 agents in 14 days, while 131 agents have zero 30-day activity. The cohort
-- whose decay exposure matters most is precisely the cohort that emits nothing,
-- so waiting longer yields more data about the 13 and none about the 131.
--
-- WHY NOT WRITE INTO repid_score_events. That table is the canonical, append-only
-- score ledger and carries the reconciliation invariant
-- `repid_after - repid_before = repid_delta_applied`. Sweep rows are measurements,
-- not score history: they move nothing, so they would either break that identity
-- or need a permanent exemption inside it. A separate table keeps the ledger's
-- meaning intact and lets sweep data be dropped without touching history.

create table if not exists public.repid_decay_shadow_observations (
  id            bigserial primary key,
  sweep_id      uuid        not null,
  swept_at      timestamptz not null default now(),
  agent_id      uuid        not null references public.repid_agents(id) on delete cascade,

  -- Verbatim from DecayAssessment. `mode` is recorded even though a sweep always
  -- runs in shadow, so a row can never be mistaken for an applied change.
  mode          text        not null,
  repid_before  integer     not null,
  decayed_to    integer     not null,
  would_remove  integer     not null,
  factor        numeric     not null,
  activity_30d  integer     not null,

  -- The ruler. Tuned constants are secret, so this is an HMAC over them, not the
  -- values: it says whether two sweeps are COMPARABLE without disclosing what
  -- they were measured with. Null when no salt is configured — in which case the
  -- sweep is still valid on its own but cannot be compared across a re-tune.
  params_ruler  text,

  -- A sweep observation must never be mistaken for an applied decay.
  constraint decay_shadow_never_enforces check (mode = 'shadow'),
  constraint decay_shadow_would_remove_nonneg check (would_remove >= 0)
);

create index if not exists idx_decay_shadow_sweep
  on public.repid_decay_shadow_observations (sweep_id);

create index if not exists idx_decay_shadow_agent_time
  on public.repid_decay_shadow_observations (agent_id, swept_at desc);

-- The whole point is the inactive cohort; make that the cheap query.
create index if not exists idx_decay_shadow_zero_activity
  on public.repid_decay_shadow_observations (swept_at desc)
  where activity_30d = 0;

comment on table public.repid_decay_shadow_observations is
  'Counterfactual decay per agent from a periodic sweep. Never affects a score. Exists because decay is a function of inactivity and an event-triggered hook cannot observe inactive agents.';
