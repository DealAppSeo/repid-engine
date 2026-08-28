-- Backlog item 5 (PATENT_ALIGNED_BUILD_BACKLOG.md): additive storage for the LeanIMT+
-- accumulator (src/memory/leanimt-plus.ts, P1, PR #203). Nothing reads or writes these
-- tables yet — this is the schema half only. The wiring gap it exists to eventually close
-- is documented in reports/2026-07-28/BEAT57_TRUSTED_ROOT_POLICY.md: HAL's grounding signal
-- (src/hal/hal-grounding.ts) accepts a `current_memory_root` to check answers against, but
-- src/scoring/pipeline.ts never supplies one (grep confirms zero callers), and there is no
-- table to source it from. That measurement beat determined the trusted root must be the
-- last ANCHORED epoch root, not the live one (LIVE_ROOT false-abstains 99.7-99.8% of
-- answers on any workload with real write volume) -- hence `agent_memory_roots` is keyed by
-- epoch, not just "latest".
--
-- `agent_memory_leaves` mirrors IndexedLeaf (leanimt-plus.ts:53): value/next/tombstoned,
-- stored as decimal strings because they are Poseidon2/BabyBear field elements which can
-- exceed a bigint column, and encodeLeaf (leanimt-plus.ts:65-67) stringifies them the same
-- way before hashing -- text keeps this table byte-faithful to what the hasher actually sees.
-- `leaf_index` is carried as bookkeeping only: per leanimt-plus.ts's own header comment, the
-- index is advisory and UNAUTHENTICATED (a witness's `path`, not its claimed `index`, is what
-- a verifier may bind a soundness decision to) -- nothing here or downstream may treat this
-- column as more than a hint for where to look.
--
-- `agent_memory_roots` records one committed root per (agent, epoch) -- the ANCHORED_EPOCH_EMIT
-- policy Beat 57 measured as the only one that is both offline-verifiable (0% false-abstain)
-- and boundable. `eas_uid`/`anchored_at` are left null until backlog item 10 (EAS anchoring)
-- exists to populate them; a root with `eas_uid is null` is committed but not yet on-chain.

create table if not exists public.agent_memory_leaves (
  id           bigserial primary key,
  agent_id     uuid        not null references public.repid_agents(id) on delete cascade,
  root_epoch   bigint      not null,
  leaf_index   integer     not null,
  value        text        not null,
  next         text        not null,
  tombstoned   boolean     not null default false,
  created_at   timestamptz not null default now(),

  constraint agent_memory_leaves_index_nonneg check (leaf_index >= 0),
  constraint agent_memory_leaves_unique_slot unique (agent_id, root_epoch, leaf_index)
);

create index if not exists idx_agent_memory_leaves_agent_epoch
  on public.agent_memory_leaves (agent_id, root_epoch);

create table if not exists public.agent_memory_roots (
  id           bigserial primary key,
  agent_id     uuid        not null references public.repid_agents(id) on delete cascade,
  epoch        bigint      not null,
  root         text        not null,
  leaf_count   integer     not null,
  computed_at  timestamptz not null default now(),
  eas_uid      text,
  anchored_at  timestamptz,

  constraint agent_memory_roots_leaf_count_nonneg check (leaf_count >= 0),
  constraint agent_memory_roots_epoch_nonneg check (epoch >= 0),
  constraint agent_memory_roots_unique_epoch unique (agent_id, epoch)
);

create index if not exists idx_agent_memory_roots_agent_epoch
  on public.agent_memory_roots (agent_id, epoch desc);

-- The query HAL's currency wiring will eventually need: "the last root this agent
-- committed", independent of whether it has been anchored on-chain yet.
create index if not exists idx_agent_memory_roots_latest
  on public.agent_memory_roots (agent_id, computed_at desc);

comment on table public.agent_memory_leaves is
  'IndexedLeaf rows (leanimt-plus.ts) per agent per committed epoch. Additive, unread by any src/ code as of 2026-08-28 -- schema-only half of backlog item 5.';

comment on table public.agent_memory_roots is
  'One LeanIMT+ root per (agent, epoch), ANCHORED_EPOCH_EMIT-keyed per BEAT57_TRUSTED_ROOT_POLICY.md. eas_uid populated by backlog item 10, not yet built.';
