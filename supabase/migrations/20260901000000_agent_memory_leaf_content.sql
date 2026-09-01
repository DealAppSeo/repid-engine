-- Backlog item 3 (PATENT_ALIGNED_BUILD_BACKLOG.md, P2 retrieval API): closes the second
-- blocker beat 85 (2026-09-01) traced the retrieval endpoint to. `agent_memory_leaves`
-- (migration 20260828000000) stores only the leaf commitment (`value`/`next`/`tombstoned`) --
-- never the `MemoryEntry` content it commits to (src/memory/proof-carrying-memory.ts:26-32).
-- `ProofCarryingMemory` keeps content off-index in its own in-process `Map`, which does not
-- survive past the request that built it, so nothing today can answer "what does this leaf
-- actually say" outside a single live process.
--
-- Write-once, content-addressed: `value` is the entry's own leaf commitment
-- (poseidon2LeafHash(encodeEntry(entry)), see proof-carrying-memory.ts's now-exported
-- `encodeEntry`), so the same content always maps to the same value -- matching the
-- in-memory store's own idempotency (`add()` is a no-op if the key already exists). This
-- table does not by itself make retrieval sound; a reader MUST recompute
-- poseidon2LeafHash(encodeEntry(row)) and compare it to `value` before trusting `content`,
-- the same way `memory-root-store.ts`'s `auditStoredCommitment` never trusts a row's claimed
-- root without recomputing it. That check lives in `src/memory/memory-content-store.ts`.
--
-- Deliberately NOT keyed by `agent_memory_leaves.leaf_index` or `root_epoch`: those describe
-- WHERE a value sits in one committed tree snapshot, but content-addressing means the same
-- entry can recur at a different index in a later epoch (e.g. re-added after being
-- superseded) without being re-hashed or re-stored. `unique(agent_id, value)` is the actual
-- identity; the join to a specific leaf row happens on `value`, not on position.

create table if not exists public.agent_memory_leaf_content (
  id            bigserial primary key,
  agent_id      uuid        not null references public.repid_agents(id) on delete cascade,
  value         text        not null,
  content       text        not null,
  source_id     text        not null,
  source_repid  integer     not null,
  hal_verdict   text        not null,
  epoch         integer     not null,
  created_at    timestamptz not null default now(),

  constraint agent_memory_leaf_content_epoch_nonneg check (epoch >= 0),
  constraint agent_memory_leaf_content_unique_value unique (agent_id, value)
);

create index if not exists idx_agent_memory_leaf_content_agent_value
  on public.agent_memory_leaf_content (agent_id, value);

comment on table public.agent_memory_leaf_content is
  'Off-index MemoryEntry content, content-addressed by its own leaf commitment (value). Additive, unread by any src/ code as of 2026-09-01 -- schema half of backlog item 3''s content-storage blocker. A reader must verify value == poseidon2LeafHash(encodeEntry(row)) before trusting content (see memory-content-store.ts); this table alone does not make retrieval sound.';
