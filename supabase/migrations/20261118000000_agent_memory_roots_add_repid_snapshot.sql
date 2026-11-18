-- FILE ONLY — Sean applies. Additive, nullable, no effect on existing rows.
--
-- src/index.ts (memory-root anchor sweep, MEMORY_ROOT_ANCHOR_SWEEP_ENABLED=shadow|enforce) selects
-- `agent_memory_roots.repid_snapshot`, but no migration ever created that column, so the sweep's
-- fetch would fail in either mode. The value is the non-zero RepID the anchor carries as
-- `repidSnapshot` (src/memory/repid-snapshot.ts: the latest settled score committed under `root`).
--
-- PREREQUISITE: agent_memory_roots itself is NOT in prod as of 2026-11-18 [to_regclass returned NULL].
-- Apply 20260828000000_agent_memory_leaves_and_roots.sql and 20261006000000_agent_memory_roots_add_tx_hash.sql first.
alter table public.agent_memory_roots
  add column if not exists repid_snapshot bigint;

alter table public.agent_memory_roots
  add constraint agent_memory_roots_repid_snapshot_positive
  check (repid_snapshot is null or repid_snapshot > 0) not valid;

comment on column public.agent_memory_roots.repid_snapshot is
  'RepID carried by the anchor for this root (latest settled score in the epoch). NULL = not computed; never 0.';
