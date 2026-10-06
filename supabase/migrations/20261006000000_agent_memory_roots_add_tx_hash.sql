-- Add tx_hash column to agent_memory_roots.
-- The EAS anchor returns a txHash alongside the UID; the sweep's writeback already
-- accepts it (memory-root-anchor-sweep.ts:31,78) but index.ts ignored it because
-- this column did not exist. Additive: nullable, no impact on existing rows.
alter table public.agent_memory_roots
  add column if not exists tx_hash text;

comment on column public.agent_memory_roots.tx_hash is
  'Base Sepolia transaction hash of the EAS attestation that anchored this root. '
  'NULL until the memory-root anchor sweep runs in enforce mode and the anchor succeeds. '
  'Populated by the sweep writeback (src/index.ts) alongside eas_uid/anchored_at.';
