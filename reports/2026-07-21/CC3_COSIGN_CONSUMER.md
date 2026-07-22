# CC-3 — Fail-closed `awaiting_cosign` consumer (flag-gated, default off)

**Date:** 2026-07-21
**Branch:** `feat/cc-2026-07-21-cosign-consumer` (cut from `origin/main`)
**Status:** COMPLETE — not blocked. tsc clean, targeted tests green. Branch-only, prod untouched.

## The gap being closed (P0.6)

The auto-dispatch loop parks a finished task at `status = 'awaiting_cosign'` and waits for a
disjoint co-signer to sign off the artifact before it may be called `done`. Nothing on
`origin/main` ever flips those tasks forward — they pile up indefinitely. This adds that flip,
and only that flip.

**Provenance note:** there is **no** `awaiting_cosign` string, no `scripts/dispatch/`, and no
dispatch `.mjs` anywhere on `origin/main` or in the main working tree (verified by grep). The
producer loop that sets `awaiting_cosign` (the `run-once.mjs` referenced in STATE_OF_THE_SYSTEM)
is out-of-repo, so this consumer is **self-contained**: it consumes a configurable status
(default `awaiting_cosign`) rather than depending on an in-repo producer.

## Fail-closed design

A task advances to `done` **only** when every condition holds (pure fn `evaluateCosign`):

1. an artifact exists to co-sign (`artifact_url` / `external_artifact_url`),
2. a co-sign record with a named co-signer is present (from `metadata.cosign` or `signatures[]`),
3. the producer is known (`claimed_by` → `completed_by` → `agent_assigned`) — else disjointness
   is unprovable → hold,
4. the co-signer is **disjoint** from the producer (no self-cosign / rubber-stamp),
   case-insensitive,
5. the verdict is an explicit PASS token (`pass|verified|approved|ok|accepted|...`).

Any other case — missing field, self-cosign, non-PASS verdict, malformed record, DB read
error, or write error — **holds** the task: it is left exactly where it is (`awaiting_cosign`),
never marked done. `evaluateCosign` never throws. The advancing UPDATE is guarded on the
awaiting status (`.eq('status', awaiting)`) so a concurrent worker can't double-advance.

**No new status value is invented** on the hold path — we never write a status the DB CHECK
constraint might reject, and we touch no prod DDL. Hold == leave the row alone (loudly logged).

## The flag

`COSIGN_CONSUMER_ENABLED` — **DEFAULT FALSE**. Must be the literal string `true` to run
(`'1'`, `'yes'`, unset → off). While off, the module is inert and is **not** wired into the boot
path (`src/index.ts` untouched), so default behavior is unchanged (shadow-first). Other env
knobs: `COSIGN_AWAITING_STATUS` (default `awaiting_cosign`), `COSIGN_DONE_STATUS` (default
`done`), `COSIGN_CONSUMER_POLL_MS` (default 300000), `COSIGN_CONSUMER_BATCH` (default 25).

## Files

- `src/services/cosign-consumer.ts` — pure decision core (`evaluateCosign`, `extractCosignRecord`,
  `toCosignTask`) + DB runner (`processAwaitingCosign`) + opt-in interval lifecycle
  (`startCosignConsumer`/`stop...`). Modeled on `src/services/hitl-expiration-job.ts`.
- `scripts/dispatch/cosign-consumer.ts` — run-once (default) / `--loop` entrypoint; refuses to
  act unless the flag is `true`.
- `tests/cosign-consumer.test.ts` — 32 tests: the fail-closed matrix + a DB-mocked sweep proving
  exactly the one clean disjoint-PASS row flips to `done` (status-guarded) and everything else holds.

## Test result

```
npx tsc --noEmit                                             → exit 0 (clean)
npx jest --config jest.config.js tests/cosign-consumer.test.ts → 32 passed
npx jest ... tests/dogfood-cosign.test.ts tests/cosign-consumer.test.ts → 36 passed (2 suites)
```

### `tests/dogfood-cosign.test.ts` note (adaptation)

This test **already exists on `origin/main`** unchanged. It is a smoke/doc test for the
peer-verification RepID wiring (imports `getAgentPrivateKey` from `src/routes/peer-verification`)
and asserts the `DOGFOOD_REPID_FROM_COSIGN` flag defaults OFF — it does **not** exercise this
consumer. It passes as-is. Its only dependency is the boot-time Supabase-creds check in
`src/config.ts` (reached via `src/db`); in a fresh worktree with no gitignored `.env` present it
throws `SUPABASE_URL and SUPABASE_SERVICE_KEY are required` at import. Running with dummy
placeholder creds (the test never makes a network call) makes it green:

```
SUPABASE_URL=https://dummy.supabase.co SUPABASE_SERVICE_KEY=dummy-key \
  npx jest --config jest.config.js tests/dogfood-cosign.test.ts   → passed
```

I did **not** modify the pre-existing test and did **not** commit any `.env` (secrets stay in
Railway env). This consumer's own module is type-only on the DB import, so
`tests/cosign-consumer.test.ts` needs no env at all.

## Guardrails honored

Branch-only, cut from `origin/main`. No merge, no peer-branch push, no prod DDL, no
Railway/secrets/on-chain. Additive only (no existing rule/behavior removed). Shadow-first: the
one behavior that can flip a live row is gated behind a default-off flag and is not auto-started.
```
