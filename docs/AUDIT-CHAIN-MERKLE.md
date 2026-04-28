# Audit chain Merkle anchoring

Daily Merkle root of `hal_audit_chain` committed on Base Sepolia.

## Why anchor

`hal_audit_chain` is the canonical, HMAC-chained record of every reputation
mutation, gated decision, and cross-table effect in the system. It is real,
strictly append-only at the application layer, and the chain links via
`previous_entry_hash` make in-place mutation detectable on full replay.

Detectable, but not impossible. Anyone with database write access could
splice a fake row in at the tail by recomputing `previous_entry_hash` from
the most recent legitimate entry. Once anchored on-chain, that attack
becomes infeasible: an inserted row would force the recomputed root
to diverge from the on-chain commitment for the day in question.

This puts the chain in the same trust class as a Bitcoin checkpoint:
fast off-chain reads, infrequent on-chain commitments, integrity
verifiable by anyone with the day's audit rows + the on-chain tx.

## How it works

`src/services/audit-merkle-anchor.ts` exports two pure-ish functions:

- `computeDailyMerkleRoot(date)` — reads all `hal_audit_chain` rows where
  `created_at` falls within `[date 00:00 UTC, next day 00:00 UTC)`,
  computes a binary Merkle tree, returns `{ root, entry_count, first_id,
  last_id }`. Empty day → `ZeroHash` + `entry_count: 0`.
- `anchorDailyRoot(date)` — wraps the compute call, sends a
  zero-value self-transfer on Base Sepolia with the root as `data`,
  upserts a row in `audit_merkle_anchors`, returns the full result.

### Leaf hash

```
leaf = keccak256( utf8(id) || canonical(event_payload) || utf8(previous_entry_hash || "") )
```

`canonical(...)` is the same `canonicalJson()` used by `auditChainWriter`
to deterministically stringify the payload — sorted keys, no whitespace.
This means a verifier can reconstruct the leaf from the row's three stored
fields without ambiguity.

### Tree shape

Bitcoin-style binary tree: pair-hash adjacent leaves with
`keccak256(left || right)`, duplicate the last leaf when the level has odd
count, recurse until a single root remains. Single leaf → root equals leaf.

### On-chain transaction

`anchorDailyRoot` sends:

```
to:    wallet.address    (self-transfer)
value: 0
data:  <32-byte Merkle root>
```

Total gas: ~21k (self-transfer) + 16 gas/byte × 32 bytes ≈ **~21,512 gas**.
At a typical Base Sepolia 0.01 gwei × $4000/ETH that is around
**$0.0001 per anchor**.

### Wallet selection

1. `AUDIT_ANCHOR_PRIVATE_KEY` if set — preferred so audit writes don't
   share a key with deploys.
2. `DEPLOYER_PRIVATE_KEY` (the existing TRINITY_DEPLOYER) as fallback.
3. If neither is set: status returned as `failed_no_wallet`, row
   persisted with that status, no throw.

### Cron schedule

`src/index.ts`, gated on `NODE_ENV !== 'test'`:

- Schedules the first run for the next 02:00 UTC after process start.
- Then `setInterval(runDailyAuditAnchor, 24h)`.
- The cron anchors **yesterday's** date — by 02:00 UTC, all of yesterday's
  rows are guaranteed visible.
- Telegram alert on `status: 'sent'` with date, entry count, root, and
  Basescan URL.

## Persistence — `audit_merkle_anchors`

Migration: `supabase/migrations/20260428_audit_anchors.sql`.

```
anchor_date     DATE      UNIQUE        — re-runs upsert
merkle_root     TEXT
entry_count     INTEGER
first_audit_id  BIGINT
last_audit_id   BIGINT
tx_hash         TEXT      nullable
basescan_url    TEXT      nullable
anchored_at     TIMESTAMPTZ
status          TEXT      sent | no_entries | pending_retry | failed_persist | failed_no_wallet
```

`anchor_date` is unique. The cron uses `upsert(..., onConflict:
'anchor_date')`, so:

- A missed cron tick + manual re-trigger → upsert, no duplicate row.
- A `pending_retry` row that succeeds on the next attempt → status
  flips to `sent`, tx_hash and basescan_url populate.

## Verification

To verify a given anchor day:

1. `SELECT id, event_payload, previous_entry_hash FROM hal_audit_chain
   WHERE created_at::date = '<anchor_date>' ORDER BY id ASC;`
2. For each row compute `leaf = keccak256(utf8(id) ||
   canonicalJson(event_payload) || utf8(prev || ''))`.
3. Pair-hash the leaves bottom-up (Bitcoin-style: odd → duplicate).
4. Compare to `audit_merkle_anchors.merkle_root` for that date.
5. Cross-check against the on-chain tx: `eth_getTransactionByHash(tx_hash)`,
   read `data` field — it should equal `merkle_root` byte-for-byte.

If steps 4 and 5 agree, the audit chain for that day is verifiably
intact. Any disagreement means somebody changed an anchored row.

## Status semantics

| status            | meaning                                         | next action       |
|-------------------|-------------------------------------------------|-------------------|
| `sent`            | tx broadcast, row persisted with hash           | none — done       |
| `no_entries`      | zero rows that day, persisted as `ZeroHash`     | none — done       |
| `pending_retry`   | compute or send failed, will retry next cron    | wait or re-trigger|
| `failed_persist`  | tx sent but DB upsert failed                    | operator: re-run; idempotent |
| `failed_no_wallet`| no `AUDIT_ANCHOR_PRIVATE_KEY` or `DEPLOYER_*`   | set env, re-run   |

## Files

- `src/services/audit-merkle-anchor.ts` — service, ~270 LOC, no new deps
  (uses ethers' `keccak256`, `concat`, `getBytes`, `ZeroHash`, `Wallet`,
  `JsonRpcProvider`).
- `supabase/migrations/20260428_audit_anchors.sql` — schema.
- `src/index.ts` — `runDailyAuditAnchor()` cron, `IS_TEST` gated.
- `tests/audit-merkle-anchor.test.ts` — 16 tests covering pure
  Merkle math, computeDailyMerkleRoot, anchorDailyRoot happy path,
  network-error retry, no-wallet path, persist-failure path, date
  bounds.
