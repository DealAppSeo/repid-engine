-- REPID UNCERTAINTY (SHADOW) — how much CHECKED evidence stood behind each agent's RepID, per run.
--
-- ╔══════════════════════════════════════════════════════════════════════════════════╗
-- ║  NOT APPLIED TO PROD (Sean-gated). FILE ONLY.                                       ║
-- ║  Nothing live reads or writes this table. Its only writer is a manual run of        ║
-- ║  scripts/shadow/print-repid-uncertainty.ts --live --write-shadow. Without this      ║
-- ║  table that flag fails loudly (exit 1); nothing else is affected.                   ║
-- ╚══════════════════════════════════════════════════════════════════════════════════╝
--
-- WHAT. A Glicko ratings deviation (RD) per agent, computed by src/shadow/repid-uncertainty.ts from
-- outcomes the shadow anti-farming eligibility record (#1461) counts as checked: owner-distinct on
-- signed evidence, or independently confirmed. Self-trades, unknown owners and unverifiable feedback
-- add nothing. 350 = no checked evidence; it falls as checked outcomes accumulate, rises again with
-- inactivity, and never drops below 30. Method: Glickman, "The Glicko system" (glicko.net).
--
-- SHADOW. Append-only history, one row per agent per run, so a run can be compared with the last.
-- `repid_at_compute` is a COPY of repid_agents.current_repid at compute time, kept so the two read
-- side by side. Nothing here is written back to repid_agents, a tier, a chain or a page. Using RD in
-- scoring is MAJOR and Sean's.
--
--   agent_id          repid_agents.id. No foreign key, on purpose: a shadow row must never block
--                     or cascade into the live table.
--   as_of             the instant the RD describes.
--   rd                Glicko rating points, in [30, 350].
--   checked_outcomes  outcomes that counted.
--   not_counted       events naming the agent as actor that did not count (replays included).
--   last_checked_at   the latest counted outcome, null if none.
--   method            schema, constants and the c in use, e.g.
--                     'repid-uncertainty/0 glicko1-rd c=100.66 period=30d floor=30 unrated=350'.
--
-- ACCESS. RLS on; every privilege revoked from anon and authenticated: only the service role reads
-- or writes. Mirrors 20261021120000_owner_auth_nonces.sql.

create table if not exists public.repid_uncertainty_shadow (
  id               bigserial   primary key,
  agent_id         uuid        not null,
  computed_at      timestamptz not null default now(),
  as_of            timestamptz not null,
  rd               numeric     not null check (rd >= 30 and rd <= 350),
  checked_outcomes integer     not null check (checked_outcomes >= 0),
  not_counted      integer     not null check (not_counted >= 0),
  last_checked_at  timestamptz,
  repid_at_compute numeric,
  method           text        not null
);

create index if not exists repid_uncertainty_shadow_agent_idx
  on public.repid_uncertainty_shadow (agent_id, as_of desc);

alter table public.repid_uncertainty_shadow enable row level security;

revoke all on public.repid_uncertainty_shadow from anon, authenticated;

-- ── ROLLBACK (DOWN) — run this to undo, if the table is ever applied ───────────────────
-- Nothing live depends on it.
-- drop table if exists public.repid_uncertainty_shadow;
