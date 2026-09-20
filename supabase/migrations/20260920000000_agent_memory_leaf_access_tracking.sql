-- Backlog item 13 (PATENT_ALIGNED_BUILD_BACKLOG.md): access-tracking columns for
-- agent_memory_leaves so runHeatEvictionSweep (src/memory/memory-heat-sweep.ts) can
-- be driven from real DB heat data.
--
-- `last_accessed_at` — updated by fire-and-forget in GET /api/v1/memory/retrieve every
-- time an agent fetches its own memory. Defaults to the row's own created_at so existing
-- rows have a non-null baseline that ages normally (an old leaf that was never retrieved
-- is correctly cold from day 1).
--
-- `access_count` — cumulative retrieval count, incremented by the same hook. Starts at 1
-- (the implicit "inserted = one write") to avoid a division-by-zero degenerate case in
-- any future frequency-weighted scorer.
--
-- Both columns are additive. Nothing reads them yet — this is the schema half.
-- The wiring is in src/memory/memory-leaf-access.ts + src/routes/memory-retrieve.ts.

alter table public.agent_memory_leaves
  add column if not exists last_accessed_at timestamptz not null default now(),
  add column if not exists access_count      int         not null default 1;

-- Fast read for the sweep: fetch by agent + non-tombstoned + sorted by heat proxy (age).
create index if not exists idx_agent_memory_leaves_access
  on public.agent_memory_leaves (agent_id, last_accessed_at)
  where not tombstoned;

comment on column public.agent_memory_leaves.last_accessed_at is
  'Last time this agent retrieved its memory (via GET /api/v1/memory/retrieve). Defaults to created_at for existing rows.';
comment on column public.agent_memory_leaves.access_count is
  'Cumulative retrieval count; starts at 1 (inserted = one write). Incremented fire-and-forget by the retrieve route.';

-- Function called by recordLeafAccess (src/memory/memory-leaf-access.ts) to do the
-- atomic increment. Called via supabase.rpc('record_leaf_access', {p_agent_id: agentId}).
-- Returns rows_affected for testability (0 if no non-tombstoned rows exist).
create or replace function public.record_leaf_access(p_agent_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_rows integer;
begin
  update public.agent_memory_leaves
     set access_count     = access_count + 1,
         last_accessed_at = now()
   where agent_id  = p_agent_id
     and tombstoned = false;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
