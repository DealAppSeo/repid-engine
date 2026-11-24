# Fixes to the T12 worker-role migration, after the two-reviewer review

2026-11-24 · branch `cc/2026-11-24-role-migration-fixes`, cut from `origin/main` at `3cf26f74` · by Claude (a session started by the conductor session).
Review being answered: `E:\dev\reports\2026-11-24\ROLE_MIGRATION_REVIEW.md` (findings 1 to 9).

**Nothing was applied to any real database.** Every change is to a file or a test. The forward file is still named DRAFT.
The only database these changes ran on is a throwaway PostgreSQL 17 container on this laptop (`docker run postgres:17`, trust auth), plus CI's own.
Production was read, never written: each production fact below came from a SELECT through the read-only connector, as `supabase_read_only_user`.

This is a change to the permission model. It needs the owner and two reviewers from two non-Claude model families before it lands. Applying it to production is the owner's action alone.

## Each finding

| # | Finding | Status | What changed, and how it was checked |
|---|---|---|---|
| 1 | The file stops on production because four lines name the superuser attribute | **Fixed, and the finding itself is now verified** | See "Finding 1" below |
| 2 | "No other role gains or loses anything" is not true for roles created later | **Fixed** | Comment in the forward file corrected, and it says what was wrong before. New test: a role created after the file ran cannot call a function the file closed, until it is granted. The test title that repeated the wrong claim is corrected too |
| 3 | The rollback does not reopen those functions | **Fixed** | Stated in the first lines of the rollback file, not only further down |
| 4 | Lane names are text the caller writes | **Not changed (by design, as the review says)** | It limits what the fix for finding 5 can do. See "Finding 5" |
| 5 | A role can end a claim it does not hold | **Partly fixed. One part left open on purpose** | See "Finding 5" below. Read this one before approving |
| 6 | Checkout reports success for a grant the submission check will refuse | **Fixed** | See "Finding 6" below |
| 7 | Does anything compare the files a commit really changes with the task's allowed paths? | **Answered: yes. Not a defect. One narrower note** | See "Finding 7" below |
| 8 | The eight trigger bodies | **Settled by the conductor session; two tests added here to keep it settled** | The file itself needed no change. (1) Static test: the forward file grants no lane the parent column or the spawn counters (`parent_task_id`, `generation`, `spawned_count`, `last_spawned_at`), and makes no whole-table insert or update grant; the lineage trigger updates the parent row, which a lane cannot do. (2) Database test: after the forward file runs, the maker inserts a pool row through the name trigger, and `normalize_agent_name(text)` is still not an owner-rights function and still open to everyone. Its control closes the helper and the same insert fails at the trigger, so the pass means something. The non-superuser block does the same insert. Both facts re-read from production today, read-only. These pin behaviour the file already had, so there is no red run against the old file; the control is what shows the test can fail |
| 9 | Supabase's own guard on grants to platform roles | **Not verified** | Needs a Supabase branch, which is the owner's call. What plain PostgreSQL 17 shows is under "Finding 1" |

## Finding 1: verified by running it, then fixed

Neither reviewer had executed this. It is now reproduced.

**The test.** `tests/t12-lane-profile.test.ts`, block "the forward file, applied by a login that is not a superuser, as production would". It creates a login with the same attributes as production's `postgres`, makes it owner of a fresh database, and applies the forward file as that login.
Production's `postgres` today, from `SELECT … FROM pg_roles WHERE rolname = 'postgres'`: PostgreSQL 17.4; superuser **false**; create role, create database, bypass row security, replication all **true**. The test's first case asserts its own login matches that.

**Red, on the file as it was on main:**
```
● the forward file, applied by a login that is not a superuser, as production would › the whole file applies, and leaves three logins that cannot go past row security
    permission denied to alter role | Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.
Tests:       1 failed, 118 skipped, 2 passed, 121 total
```

**Green, on the fixed file** (same command):
```
Tests:       119 skipped, 3 passed, 122 total
```
Command for both: `T12_LANES_PG_URL=postgres://postgres@127.0.0.1:54417/postgres npx jest --config jest.config.js --forceExit --runInBand tests/t12-lane-profile.test.ts -t "applied by a login that is not a superuser"`.

**The fix.** The superuser attribute is gone from the four role-altering lines and stays on the line that first creates a role (creating with it is allowed; a test runs that exact statement as the non-superuser login). After those lines a new check stops the file with a clear error if a lane role, or the retired shared role, is a superuser or can bypass row security.

**A consequence to know about.** The file used to strip superuser from a lane role that already had it. It can no longer do that, so in that case it stops instead, says which role, and applies nothing. Test: "stops with a clear error, and applies nothing, when a lane role is a superuser". The existing test setup that pre-made the lane roles superusers was changed to match. Production has no lane roles today (compat check, row 5b), so this path is not expected there.

**What the green run does and does not show.** On plain PostgreSQL 17 the whole file applies as a non-superuser, including the block that names every role on the functions it closes. That is not Supabase: its guard on reserved roles is not part of plain PostgreSQL (finding 9, not verified).

## Finding 5: what was fixed, what was left, and what the fix cannot do

**What honest code does** (`src/orchestration/t12-lane-store.ts`). Every write that ends a claim clears `claimed_by`, so the new row has no holder to name. What it does carry is the newest receipt, whose `actor` is the lane, and every store call writes one. So "the lane named on the new row" is the actor of the newest receipt.

**Where honest code meets the rule, and the rule is now enforced:**
- Maker, on a row some lane holds: that lane may leave the row as it is (heartbeat, belt checkout, route attempt), or end the claim under its own name (release, fail, wait for capacity, submit). Nobody may take the row over or move it out of its stage while the claim stays.
- Checker recording a verdict (approved, rejected, back to ready, not checked): only the lane that holds the check.
- Integrator publishing or refusing: only the lane that took the row.

**Where honest code cannot meet the rule, so I stopped there instead of weakening it.** `recoverStages` (store, line 646) hands a claim back when its holder has gone silent. The lane doing that is never the holder, by definition, and it writes `recoverStages` as the actor. So these two moves are exactly as they were before:
- checking → awaiting_check (checker role);
- integrating → approved (integrator role).

Any lane holding that role's login can still hand back a claim it does not hold, with no check on who holds it or how old the claim is. A hand-back cannot approve or publish anything; it can delay work. Closing it needs a decision that is not mine to make here. Two candidates, not designed: allow a non-holder to hand back only when the claim is older than the stage timeout; or do recovery under its own login. A test named `OPEN: a hand-back by a lane that does not hold the claim is still accepted` pins this, so nobody reads the gap as closed.

**What the fix cannot do, in any form.** The lane name on the new row is text the caller writes, and all lanes of one stage share one database login (finding 4). Someone holding the maker login can read who holds a row and write that name. Each new test includes that exact write as its control, and it lands. So this stops code from ending a claim through a wrong or stale handle. It does not stop a person or program that holds the login and means to. The boundary is still the database role. The review said "narrows"; that is the right word.

**Tests** (block "ending a claim needs the lane that holds it"):
- a maker cannot release, reject, take over or re-stage a task another lane is making;
- a checker cannot finish a check another lane holds;
- an integrator cannot publish or refuse work another lane took;
- the honest path still passes: every way the store ends a claim it holds (release, failure, wait for capacity, rejected verdict, not-checked verdict, refused publish). Approve and publish are in the older "whole lane job" test.

Red on the unchanged function, each run alone: `Expected: "42501"  Received: "written"` for all three refusal tests. Green after: `Tests: 122 skipped, 6 passed, 128 total` (the five above plus the finding 2 test).

## Finding 6

When checkout finds a grant already there, it now reports success only for one the submission check will accept: issued by the belt issuer, naming this lane, for the belt this task needs, already valid, not revoked, not expired. Each failure returns its own reason and is logged where the lane cannot edit it.
Test: "checkout does not report success for an existing grant that names another lane or another belt". It covers the grantee and the belt (the two the review asked for), the issuer and the start time, and two controls: asking twice for an untouched grant is still a success, and a restored grant works again and its submission lands.
Red before: expected `{"ok": false, "reason": "the belt for this claim names another lane"}`, received `"ok": true`. Green after: `1 passed`.

## Finding 7

**The comparison exists.** The checker compares the files the commit really changes with the task's allowed paths, not with the list the lane declared:
- `src/orchestration/t12-lane-git.ts` lines 252 to 255: `git diff --name-status --no-renames <base> <commit>`, and any file not in the task's paths is rejected as "wrote outside its lease". Tested by `tests/t12-lanes.test.ts` line 273.
- `src/orchestration/t12-lane-transfer.ts` lines 71 to 76: the same comparison when a commit moves between machines as a bundle, plus "exactly one commit on top of the base", plain files only, adds and edits only. Tested by `tests/t12-lane-transfer.test.ts` line 134.

The commit a checker approved is the commit that gets published: neither the checker nor the integrator can change the submission on the row, and the maker cannot touch a row past awaiting_check.

**One narrower note, from reading only (not executed).** When maker, checker and integrator share one clone (no bundle), the integrator does not compare again; it relies on the checker's approval (`t12-lane-git.ts` line 319 on). And in that mode nothing checks that the commit is exactly one commit on top of its base. The checker compares the two end states, so a file added in one commit and removed in a later one would not show in the comparison but would be in the pushed history. The bundle path refuses that. Whether the one-clone mode should too is a separate, small question; I have not designed a fix.

## The read-only production check (`ops/t12/audit/role-migration-prod-compat.sql`)

Still read-only: one READ ONLY transaction, rolled back, every statement a SELECT. A new test asserts that, and asserts that the file asks about every column the forward file grants, so the list cannot fall behind the migration again.
Added:
- all 26 columns the forward file names on the task table, one row each **whether present or not** (the old query listed only what it found, so it could not show a missing column; it also left out the 8 the checker and integrator write);
- the columns, check constraints and partial unique index the belt functions rely on in the grants table, the columns of the denial log, and any required column with no default;
- whether the applying login is a superuser, its other attributes, the server version, and whether it owns everything the forward file changes;
- an md5 of each enabled trigger function's source, with today's eight recorded in the file's header.

I ran the new queries against production today, read-only. Results:
- all 26 task-table columns present, none generated;
- all 19 grants-table and log columns present; the only required columns with no default are ones the function sets;
- the index: `principal_grants_idempotency_key_uidx`, unique, valid, on `(idempotency_key) WHERE (idempotency_key IS NOT NULL)`;
- the eight trigger fingerprints are the same eight the compat check recorded this morning;
- `postgres` owns the five tables, both id sequences and all 13 functions, and is the database owner.

One query was refused by the guard hook because its text contained privilege keywords inside a read. I did not work around it; I asked the same question another way (the schema's access list) and kept those words out of the audit file, so an agent can run the file through the read-only connector.

## Gating commands, run locally

What CI gates on, read from `.github/workflows/ci.yml` (job `test`: fixture guard, `npx tsc --noEmit`, `npm run check`, `npm test`, `npm run test:integration`) and `.github/workflows/t12-supervisor-synthetic.yml` (the Postgres 17 suites, which include this test file).

| Command | Result here |
|---|---|
| `npx tsc --noEmit` | exit 0, no output |
| `node scripts/hooks/prod-fixture-guard.js --ci` | exit 0 |
| `npm run check` | exit 0: `VERIFIED — 1 check passed.` |
| `T12_LANES_PG_URL=… npx jest --config jest.config.js --forceExit --runInBand tests/t12-lane-profile.test.ts tests/t12-lane-rollback.test.ts tests/t12-lane-transfer.test.ts` | exit 0: `Test Suites: 3 passed, 3 total` · `Tests: 146 passed, 146 total` · 83.7 s |
| `npm test` (all suites) | **NOT RUN.** Not an instrument on this laptop; CI is the reading |
| `npm run test:integration` | **NOT RUN** locally; CI |
| `npx ts-node --transpile-only scripts/preflight.ts --dir . --files …` | **exit 1 (FAIL)**. `fresh_base` PASS (starts from the current tip `3cf26f74`); `duplicate_work` PASS (no other open PR touches these files, 3 checked); `claim`, `lease`, `fencing`, `scope` FAIL with "no task claimed: name the trinity_tasks row this work belongs to"; `permission` WARN "owner decision needed before merge (r31 MAJOR)". This work was started by the conductor session and has no row in the task queue, so those four rows cannot pass. I did not invent a row to make them pass |

**One failure on the way, and what it was.** The first full run of the test file failed 67 tests. Cause: the older block's setup hook passed jest's default 5-second limit once, right after the new block dropped its database, and every test after it failed for want of setup. The same file passed in full on the next two runs with no change (132 of 132 alone, 135 of 135 with the rollback suite). Both setup hooks now carry an explicit 60-second limit; the final run above is after that change. I classed this as timing in the test setup, not a defect in the migration, because the failure was the hook's timeout and the identical code passed twice.

After the two finding 8 tests were added: `tests/t12-lane-profile.test.ts tests/t12-lane-rollback.test.ts`, same command, exit 0, `Test Suites: 2 passed` · `Tests: 137 passed, 137 total`; `npx tsc --noEmit` exit 0.

CI results are in the pull request, read from GitHub after pushing; see the PR's checks for the current state.

## Not verified
- **Supabase's own behaviour** on role and grant statements (findings 1 and 9). Plain PostgreSQL 17 only.
- **The full `npm test` on this laptop.** It is not an instrument here (about 271 suites fail on clean main on Windows; measured earlier today). CI is the reading.
- **The one-clone note under finding 7.** Read, not executed.
- **The runner and routing suites** (`t12-lanes`, `t12-lane-routing`, `t12-supervisor-e2e`) apply the same forward file as a superuser. Locally they are timing-flaky on this laptop, so I rely on CI's `e2e` job for them. See the gating section for what CI said.

## For whoever applies this
Do not apply from this branch until it has landed. When it has: run the read-only check first, compare block 2's fingerprints with the header, and confirm block 9 shows the applying login with create-role, create-database, bypass-row-security and replication all true.
