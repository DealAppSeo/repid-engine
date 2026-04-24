# HAL Audit Chain

Tamper-evident, hash-chained audit trail for HAL events.

## Why a parallel table

`hal_audit_chain` lives alongside `hal_production_events` rather than replacing
it or adding columns to it. This keeps the HAL hot write path unchanged and
lets us adopt the chain incrementally:

- **No risk to the live HAL insert path.** `hal_production_events` continues to
  behave exactly as before. If the chain writer throws, HAL still logs.
- **Generalisable.** The chain is not HAL-specific — `source_table` +
  `source_id` let any event source (`hal_production_events`,
  `trinity_agent_logs`, `repid_score_events`, …) chain into the same timeline.
- **No historical backfill required.** Chain starts at genesis on first
  append. Rows in `hal_production_events` predating the chain are simply not
  covered; rows written after wiring are.

See also: branch `docs/hal-canonical-v1`, commit `a251605` — Sean's
intentionally schema-only migration.

## Schema

```sql
CREATE TABLE hal_audit_chain (
  id BIGSERIAL PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_payload JSONB NOT NULL,
  previous_entry_hash TEXT,        -- null on the genesis row
  current_entry_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Indexes: `created_at`, `(source_table, source_id)`.

## Hash formula

For every row:

```
canonical_text   = canonicalJson(event_payload)
current_hash     = SHA256( coalesce(previous_hash, '') ||
                           canonical_text ||
                           source_table ||
                           source_id )
```

- `canonicalJson` is JS-side stable serialisation: recursively sort object
  keys, no whitespace, arrays keep order, numbers normalised through a JSON
  round-trip. This is deterministic across write and verify.
- `||` is plain string concatenation (UTF-8). `pgcrypto.digest('sha256')` on
  the Postgres side and `crypto.createHash('sha256')` on the Node side
  produce identical lowercase hex output.

## Atomicity

Concurrent appenders race for the "last hash." The writer calls the
`append_hal_audit_chain` PL/pgSQL function, which acquires
`pg_advisory_xact_lock(hashtext('hal_audit_chain_append'))` before reading
the tail — so every concurrent appender observes the true last hash before
computing and inserting its own.

## How to verify

```
GET /api/v1/audit/verify       — public, no auth
```

Walks the chain from id ASC, recomputing every hash.

Responses:

```json
// Intact
{ "valid": true, "total_entries": 1234, "last_id": 1234 }

// Broken
{
  "valid": false,
  "total_entries": 1002,
  "first_break_at_id": 1003,
  "expected_hash": "…",
  "actual_hash": "…"
}
```

`first_break_at_id` is the id of the first row whose recomputed hash does not
match its stored `current_entry_hash`. Any tampering — modifying an event
payload, deleting a row, reordering — breaks the chain at or before that id.

The endpoint is intentionally public. Auditability is the point: anyone can
verify the chain without credentials.

## How to add a new event source

1. Locate the insert site (e.g., `repid_score_events`) in code.
2. Immediately after the write succeeds, call:
   ```ts
   await appendToAuditChain('repid_score_events', String(insertedId), rowJustWritten);
   ```
   Wrap in try/catch if the host path must remain non-blocking.
3. `source_table` should be the real table name; `source_id` should be
   whatever string uniquely identifies the row there.

The chain does not need to know the source table's schema — it just stores
the payload JSONB and chains on it.

## Running tests

Pure unit tests always run:

```
npx jest tests/auditChain.test.ts
```

Integration tests against a live Supabase are gated (they truncate
`hal_audit_chain` between cases, so never point them at a chain that holds
real data):

```
RUN_AUDIT_CHAIN_INTEGRATION=1 npx jest tests/auditChain.test.ts
```

## Migrations in this PR

1. `supabase/migrations/20260423_add_hal_audit_chain.sql` — table + indexes
   (from commit `a251605`, landed earlier on `docs/hal-canonical-v1`).
2. `supabase/migrations/20260423_add_hal_audit_chain_append_fn.sql` —
   `append_hal_audit_chain` RPC with advisory-lock atomicity.

Both applied to the Trinity Supabase project (`qnnpjhlxljtqyigedwkb`) by
this sprint. `hal_production_events` is intentionally untouched.
