<!-- triggers: schema column migration table constraint supabase sql postgres presence integration test ddl trigger tier check -->
# Schema / DB / test-environment lessons

Full narratives behind LESSONS §5 and §7. Appended when a brief concerns schema or DB tests.

## Match the real names, not the tidy ones (§5)
`INTEGRITY_TYPES` held a bare `'DECEPTION'` under `Set.has()`, but the engine writes
`DEFENDED_DECEPTION_FABRICATED_CITATION` — nothing matched, so an agent caught **fabricating**
passed a gate one that merely went quiet would not have. Exactly backwards. A `status` column's
CHECK allowed `{QUEUED,DISPATCHED,COMPLETE,FAILED,BLOCKED}` and rejected `CANCELLED` (23514).
`repid_agents.tier` is overwritten on every write by `trg_sync_tier(compute_tier(...))` — app
writes to it are theater. **Apply:** read the values the system emits and the actual constraints/
triggers before writing SQL. Prefer prefix/substring match — an exact-match list **fails open**
for every value added later.

## A red check is a status, not a verdict (§7)
`Cannot find module 'pg'` looked like a broken rebase; it was a worktree with no `npm install`.
Two ENV masquerades measured 2026-08-22: ~768 test failures were a **Windows-only** ESM error
(`ERR_UNSUPPORTED_ESM_URL_SCHEME`, a suite `import()`ing an `.mjs` by raw `c:\` path — green on
Linux CI), and integration suites armed against a Supabase that did not exist because their guard
checked credential **presence**, which the CLAUDE.md-recommended `localhost:54321` dummy satisfies.
In CI, no secrets → they skip → green. Net: red locally for a non-reason, silent in CI.

**Apply:** classify **ENV/CONFIG** vs **REAL** on a checkout *without* your change before judging.
Gate integration tests on an explicit `RUN_INTEGRATION=1` plus credentials, never on presence —
and never special-case one bad host (`localhost:54321`), which fails open for every other
unreachable endpoint. Export the config-boot dummies knowing they boot `src/config.ts` and do
NOT enable integration.

## Read the declared link before you join an id (§4)
`erc8004_reputation_writes.repid_event_id` was joined to `repid_score_events`; its foreign key
points to `repid_events`. Both tables use bigint ids in the same range, so the wrong join
returned a plausible row for 29 of 29 writes, all dated 2026-05-04. Two sessions (2026-11-14,
2026-11-16) then reported a "wrong link" defect that did not exist: following the key, every
write cited its own settlement event. **Apply:** before any join on an `*_id` column, read
`select pg_get_constraintdef(oid) from pg_constraint where conrelid = '<table>'::regclass and
contype = 'f'`. A join that *finds* a defect is a claim: re-derive the link from the key first.

## Trace a duplicate to its first stage (§2)
A double on-chain write (2026-07-08) was traced to the inline trigger and fixed there. One
stage up, the settlement had emitted two outbox events for one x402 payment, 3.5 s apart, so
one job produced three `giveFeedback` transactions. **Apply:** for any duplicate, count the
same key at every stage (payment, contract, outbox event, write, transaction) and name the
FIRST stage where the count is above one.
