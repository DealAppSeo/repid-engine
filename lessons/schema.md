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
