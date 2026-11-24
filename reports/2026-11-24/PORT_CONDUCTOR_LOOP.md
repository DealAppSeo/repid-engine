# Port of the conductor loop into the T12 lane feeder

2026-11-24 · PR #1599 · branch `cc/2026-11-24-port-conductor-loop` from `main` at `3cf26f74` · everything default off.
Marks: **[V]** = a command or query run today, named beside it. **[R]** = reported by a document, not re-checked.

## The short answer

**Goal:** prove the existing engine supervisor can complete one independently reviewed T12 shadow cycle with
the laptop off.

**Where that stands:**

- **Proven on GitHub's machines, with a throwaway database** [V, PR #1599 checks]: the supervisor's own
  end-to-end jobs (`e2e`, four `maker` jobs, `boundary-maker`, `boundary-checker`, `settle`) passed on this
  branch. A maker and a checker ran on separate machines, and a real commit moved between them.
- **Proven as a dry run on fixtures** [V, section 4]: the five rehearsals pass, with no database client loaded.
- **Not proven: one cycle against the production queue.** It cannot start. Production has 0 `t12_lane_*` roles,
  0 lane rows and 0 supervisor runs; no T12 secret exists; `T12_SUPERVISOR_ENABLED` is unset [V, section 6].
  That is one decision of Sean's away (section 8).

**Three limits to read before anything else:**

1. **The lane spec format carries code tasks only.** `validateSpec` requires an allowlisted repo, file `paths`
   and a jest or node-test `verify`. The cards cycle 1 proved by hand (claim audits from supplied text) were
   open-pool rows answered by the T12 runtime in trinity-symphony-shared. The first real shadow cycle the
   supervisor can run is therefore a code card (section 8), not an audit card.
2. **`delivery_contract`, `breaker` and the reconcile have no caller inside the lane runner.** The lanes check a
   commit with a test runner; their checker is a test run on a separate database role, not a second model. The
   callers added here are the read-only check and the dry run.
3. **In cycle 1 the K3 maker and its breaker ran on the same model family** (both
   `nvidia/nemotron-3-ultra-550b-a55b:free`) [V: `metadata.model_used` on rows 439484 and 439487]. They were
   different agents, not different families. The reconcile added here does not count such a review.

## 1. One job per component

| Component | Its one job | It never |
|---|---|---|
| `t12-supervisor.yml` in repid-engine (GitHub Actions) | **The only dispatcher.** It runs the maker, checker and integrator. | — |
| `trinity_tasks` and `trinity_artifacts` (Supabase) | Hold the live state: queue rows, leases, replies, saved artifacts. | hold instructions |
| `ops/t12/specs.jsonl` | The reviewed task list `replenish()` feeds from (D-154). | hold status |
| A Claude cloud routine | Watches, proposes follow-ups, writes a digest. | dispatches, or writes a row |
| living-docs | Approved instructions and sanitized hand-offs. | hold live state |
| Status views | Generated from the two tables each time (`reconcileCard`). | get edited by hand |
| `E:\dev\ops\loop\conductor\board\board.json` | **Retired by this port.** It was the prototype's board. | get updated again |

What was migrated from the board, once: its rules (as code and tests), its three snapshots (as fixtures in
`tests/fixtures/t12-conductor/`), and its one standing decision, the frozen `outreach` lane (as the
`--frozen-work-lane` option; no spec is in that lane today). Its open cards were not turned into specs: S1 and
S2 are Sean's; O1 is frozen; E4 is blocked on a file; E6 (a schema for the daily evidence manifest) is not a
code task, so it belongs in the planner's weekly list, not in `specs.jsonl`.

## 2. How the feeder ordered work before, and what changed

Read at `3cf26f74`, before any edit: `replenish()` walked the specs file top to bottom, skipped invalid specs and
spec ids already on any row, and stopped at `target`; it did not sort. `claimMake()` took ready rows by
`priority DESC, created_at ASC`, then the first whose paths nothing holds.

| Rule | Existing feeder | This change |
|---|---|---|
| Scan immediate, near, long before every dispatch | Half: `priority` ordered claims; `replenish` used file order. | Adds an optional horizon to both. A spec without one ranks as near, so the 34 existing specs keep their order. |
| Failed work first **within each horizon** | Half: a rejected row came back with its rejection reason (so it already was a fix), but did not go ahead of newer work. | Adds the ordering. The existing cap (three failed attempts end the row) stays. |
| A frozen lane takes no work | Missing. | Adds it. A freeze also holds back a failed row. |
| Sean-only cards are set aside and the scan continues | Exists: only T12 specs are in the file. | Kept. In board replays the card is listed as skipped with "owner is Sean, not T12". |
| Never the same card twice | Exists, stronger: spec id deduped across every state, plus row and path locks. | Kept, unchanged. |
| Fewer than the limit when fewer exist; never invent | Exists: `READY_UNDERFLOW`, no filler. | Kept, unchanged. |

**Two differences from the prototype, both on purpose:**

- The prototype put every failed card ahead of all horizons. Sean's rule is failed first within each horizon.
  On the trial snapshots the same three cards are picked, in a different order: CT-1 was I0, I2, N2 and is now
  I2, I0, N2; CT-2 was Z7, Z9, A2 and is now A2, Z7, Z9. (I0, Z7 and Z9 are finished cards no longer on the
  board, so they have no horizon and rank as near.) The cycle-1 board is unchanged: K3 is immediate.
- The prototype let a failed card through a frozen lane. Here it does not.

## 3. What was added

| Piece | File | Caller |
|---|---|---|
| Order rules, pure: `orderFeed` | `src/orchestration/t12-feed-order.ts` | `planReplenish()` and `claimMake()` |
| The top-up plan, pure: `planReplenish` (taken out of `replenish`) | `src/orchestration/t12-lane-store.ts` | `replenish()`, and the dry run |
| Spec fields in `context` as `meta:` entries | `specMeta` in `t12-feed-order.ts`; checked by `validateSpec` | the feeder (horizon, work lane); the check script (contract) |
| Reply and artifact check, read-only | `src/orchestration/t12-delivery-check.ts`, `scripts/t12/delivery-check.ts` | run by hand; `reconcileCard` |
| Reconcile: four separate answers per card | `src/orchestration/t12-reconcile.ts` | the dry run. No lane stage calls it yet. |
| Dry run of five situations | `src/orchestration/t12-rehearsal.ts`, `scripts/t12/rehearse.ts` | run by hand, and by `tests/t12-reconcile.test.ts` |
| Frozen work lanes | `--frozen-work-lane <topic>` on `scripts/t12/lanes.ts` | `runLanes`. The workflow passes none. |

**The fields.** WORK_CASCADE section 2 says new fields ride in `context`. `context` is a list of file paths the
maker reads from disk and sends to the model, and `validateSpec` refuses anything that is not a clean path;
`trinity_tasks` has no `context` column [V: `information_schema.columns`]. So they ride as `meta:` entries in
that list, which the file readers skip:

```
"context": ["lib/onchain-repid.ts", "meta:breaker", "meta:horizon=immediate", "meta:work_lane=pre-post-audit",
            "meta:delivery_contract.pattern=^\\d+ \\| .+ \\| (SUPPORTED|NOT SUPPORTED)",
            "meta:delivery_contract.min_lines=9"]
```

`delivery_contract` has the shape trinity-symphony-shared PR 130 reads from `metadata.delivery_contract`.
`breaker` means a second agent on a different model family must check the maker's answer. `validateSpec` was
extended because a test needs it: a pattern holds `\`, `*` and `?`, each refused in a path.

**The reconcile.** For one card it takes the maker row, its artifacts, the review rows and the score events,
and answers four things separately:

| Answer | Values | Read from |
|---|---|---|
| queue | waiting, in_progress, lease_expired, finished, not_checked | `status`, `expires_at` against the read time |
| delivery | delivered, not_delivered, disagree, not_checked | `result` and every `trinity_artifacts.content`, against the contract |
| acceptance | accepted, rejected, needs_review, pending, not_checked | review rows; one counts only from another agent on another model family |
| scoring | none, shadow_only, live_moved, not_checked | `repid_score_events.delta` and `is_shadow` |

When reply and artifact disagree it keeps both copies and routes the card to review, even with a passing
review. Evidence that could not be read is `not_checked`, never a pass and never a fail.

## 4. The five rehearsals

Command: `npx ts-node --transpile-only scripts/t12/rehearse.ts` → exit 0 [V]. It reads committed fixtures and the
real `ops/t12/specs.jsonl`, and calls the same `orderFeed`, `planReplenish` and `reconcileCard` the feeder and
the status view use. A test starts it and counts loaded database modules: `DB_MODULES=0`. No row was written.

```
PASS 1. a saved artifact counts as delivered when the reply is only a summary
     {"queue":"finished","delivery":"delivered","acceptance":"pending","scoring":"shadow_only","route":"wait","delivered_in_reply":false,"delivered_in_artifact":true}
PASS 2. a breaker on another model family verifies that artifact; one on the maker's family does not count
     {"other_family":{"delivery":"delivered","acceptance":"accepted","scoring":"shadow_only","route":"close"},"same_family":{"acceptance":"not_checked","reasons":["review 900003 ran on gpt-oss, the maker's own model family"]}}
PASS 3. a failed card comes back for repair before new work in its horizon
     [{"id":"K3","kind":"fix","reason":"last attempt failed at 2026-11-24T10:36:00Z, horizon immediate"},{"id":"K4","kind":"new","reason":"eligible, horizon immediate"},{"id":"E6","kind":"new","reason":"eligible, horizon long"}]
PASS 4. running the feeder twice dispatches no duplicate
     {"first_run":["ts-repid-to-tier","ts-after-create-table","ts-as-of-epoch"],"second_run_nothing_changed":[],"third_run_after_the_first_three_finished":["ts-seen-by-from-hal","ts-claim-label-of","ts-api-url-refusal"]}
PASS 5. when an immediate blocker clears while a near card is ready, immediate is picked next
     {"while_blocked":[{"id":"N1","kind":"new","reason":"eligible, horizon near"}],"set_aside":[{"id":"S1","reason":"owner is Sean, not T12"},{"id":"M1","reason":"state is blocked: the text to audit is not fetched yet"}],"after_it_clears":[{"id":"M1","kind":"new","reason":"eligible, horizon immediate"}]}
DRY RUN: 5 of 5 passed; no row was written and no connection was opened.
```

What each one is and is not: 1 and 2 run the reconcile on rows written for the rehearsal. 3 and 5 replay boards
through the ported order (3 is the cycle-1 board when K3 had failed, plus one new immediate card, K4, listed
ahead of it so the repair has something to beat). 4 runs the real top-up plan on the real specs file against an in-memory pool; the same
dedupe against a real Postgres is `tests/t12-lanes.test.ts` "replenish dedupes…" and "three lanes replenishing at
once insert each task once". None of the five called a model or a worker.

The reply and artifact check was also run on the four cycle-1 rows, read from production with a SELECT through
the Supabase connector [V]: 439484 (gcm) and 439487 (chesed) each disagree at line 3; 439485 and 439490 (w3c)
agree. That matches the hand reading in `LOOP_CYCLE_1.md`.

## 5. Checks run

**Negative control, shown red then restored** [V]. With new work placed ahead of fixes inside a horizon in
`orderFeed`:

- `npx jest tests/t12-feed-order.test.ts tests/t12-reconcile.test.ts` → `Tests: 3 failed, 41 passed`
  (CT-1, "puts failed work first inside its own horizon", "returns a failed item once, as a fix").
- `scripts/t12/rehearse.ts` → `FAIL 3.` · `DRY RUN: 4 of 5 passed` · exit 1.
- Restored → `Tests: 55 passed` across the three new suites · `DRY RUN: 5 of 5 passed` · exit 0.

The control found a real gap first: rehearsal 3 as first written still passed with the rule broken, because its
board had no rival card. The rival (K4) was added and the control repeated; the lines above are the second run.
An earlier control on the first version of the rule also turned the database test "a rejected task is claimed
again before a newer task with a higher priority" red (`Expected: "fix-me"  Received: "urgent-new"`).

**Gating commands, run locally on the final code** [V]:

| Command (as in `.github/workflows/ci.yml`) | Result |
|---|---|
| `node scripts/hooks/prod-fixture-guard.js --ci` | exit 0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run check` | `VERIFIED — 1 check passed.` |
| `npx jest` on the three new suites plus `t12-specs-valid`, `t12-ab-context`, `lessons-injectable` | `Test Suites: 6 passed` · `Tests: 114 passed` (before the K4 change; the three new suites re-run after it: `55 passed`) |
| `tests/t12-lanes.test.ts`, the eight feeder tests, on a local Postgres 17 | `8 passed, 117 skipped` (filtered by name) |
| `npx ts-node --transpile-only scripts/preflight.ts` | `Preflight: FAIL`: fresh base PASS, duplicate work PASS, owner-only paths PASS; claim, lease, fencing and scope FAIL with "no task claimed". This work came from a session brief and has no `trinity_tasks` row. The CI preflight job is advisory. |

**What the local runs cannot tell you** [V]. The full `npm test` on this Windows laptop fails 271 suites on clean
`main` (698 pass), so it is not an instrument for this change. The timing-sensitive runner and routing tests in
the Postgres suites also vary run to run here: on the same files, clean `main` failed 11 and this branch failed
24 and then 6; no test failed in every branch run and in no `main` run. The gate for those suites is CI, which
runs them on Linux against Postgres 17 and fails on any skip.

**CI on GitHub** [V: `gh pr checks 1599`]:

On the code commit `4f18f737` (read with `gh api repos/DealAppSeo/repid-engine/commits/4f18f737/check-runs`):
every check succeeded: `test`, `e2e`, `settle`, `boundary-maker`, `boundary-checker`, the four `maker` jobs,
`CodeQL`, `Analyze (javascript-typescript)`, `HAL prompt-injection / jailbreak probes`, `crosscheck`, `gitleaks`,
`resident-secrets`, `preflight`, `risk-class`, `zkp-vault`. `crosscheck-live` was skipped (it skips on every PR).
Open code-scanning findings on the PR: 0. Strix has not reviewed it: Strix does not review drafts.
This report was committed after that read, so the head commit differs from `4f18f737` by this file only.

The first push had a type error in the new check file (`tsc` red) and was fixed in the next commit. The second
push failed code scanning (`js/regex-injection`: the pattern validator compiled a pattern in the main context).
Patterns are now compiled where they are run, in a separate context under a time limit.

## 6. Prerequisites

**Correction to the brief.** `T12_WORKER_DATABASE_URL` is not a name the workflow reads. The shared worker role
was retired after gate-0 probe P1; `t12-supervisor.yml` at `3cf26f74` reads one database secret per role. It also
has no schedule: its only trigger is a manual start.

Stages: **A** dry run · **B** read-only monitoring · **C** real shadow dispatch (`publish=false`) · **D** publishing
draft PRs (after C, a later decision). No secret value belongs in the repo or in this report.

| # | What | Exactly where | Minimum scope | Proof it is set correctly | Needed for | Today [V] |
|---|---|---|---|---|---|---|
| 0 | Nothing | — | — | `npx ts-node --transpile-only scripts/t12/rehearse.ts` exits 0 | A | passes |
| 1 | Nothing new. The watcher uses the database connector already attached to the routine "Trinity daily integrity check" | claude.ai → Routines → Trinity daily integrity check | SELECT only. The connector can write, so read-only is by instruction, not enforced [R, CLOUD_ROUTINES_INVENTORY] | the routine's run shows only SELECT statements | B | attached |
| 2 | Worker-role migration. First the compatibility check `ops/t12/audit/role-migration-prod-compat.sql`, then `migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql`. Undo: `migrations/rollback/DOWN_2026-11-08_t12_lane_worker_role_DRAFT.sql` | Supabase → project `qnnpjhlxljtqyigedwkb` → SQL editor (paste the file's text) | three login roles with no bypass of row security, limited to the lane pool | `select rolname, rolbypassrls from pg_roles where rolname like 't12_lane_%';` → three rows, all `false` | C | 0 roles, 0 `t12_belt*` functions |
| 3 | A password for each of `t12_lane_maker`, `t12_lane_checker`, `t12_lane_integrator` | same SQL editor: `ALTER ROLE <role> PASSWORD '<new>';` typed there, never saved to a file | login only | step 5's run starts; a wrong password fails the job at connect | C | not done |
| 4 | Secrets `T12_MAKER_DATABASE_URL`, `T12_CHECKER_DATABASE_URL` (and `T12_INTEGRATOR_DATABASE_URL` for stage D). Value: Supabase → Project Settings → Database → Connection string (pooler, port 6543), with that role's name and password in place of the default user | GitHub → DealAppSeo/repid-engine → Settings → Secrets and variables → Actions → Secrets | one role each. The worker refuses to start on a role that can bypass row security, so pasting the service connection string fails loudly | `gh secret list --repo DealAppSeo/repid-engine` lists the names; the maker job does not print `NOT_CHECKED: database role … can bypass row security` | C (integrator: D) | 11 secrets, none with T12 in the name |
| 5 | Secret `T12_GROQ_API_KEY`: the maker's model key. Reuse the `GROQ_API_KEY` already saved by name in `repos\.env.master` [V, names only]; do not create a new key | same Secrets page | a free-tier model key; no spend | the maker job reports `made: 1` or a route failure with a reason, not a missing-key error | C | absent |
| 6 | Variable `T12_SUPERVISOR_ENABLED` = `true` | same page, Variables tab | repository variable | `gh variable list --repo DealAppSeo/repid-engine` shows it | C | unset; only `T12_G25_ENABLED` exists |
| 7 | The first run: `gh workflow run t12-supervisor.yml --repo DealAppSeo/repid-engine -f target_repo=DealAppSeo/trustshell -f specs=ops/t12/specs.jsonl -f publish=false` | a terminal, or Actions → t12-supervisor → Run workflow | manual start | `gh run list --repo DealAppSeo/repid-engine --workflow t12-supervisor.yml` shows it; `select status, count(*) from trinity_tasks where insert_source='t12-lane-replenish' group by 1;` shows rows | C | 0 runs, 0 rows |
| 8 | Secret `T12_PR_TOKEN`: a fine-grained token on the one target repo, contents and pull requests read/write. No saved key has that name [V, names only] | same Secrets page | one repo. NOT_CHECKED: what stops that token landing a PR; the target repo's ruleset has to | a run with `publish=true` opens a draft PR and cannot land it | **D only**. With `publish=false` the integrator job is skipped | absent |
| 9 | A schedule | a `schedule:` block in `.github/workflows/t12-supervisor.yml`, in its own PR. A scheduled run has no `target_repo` or `specs` input, so that PR must supply them | — | `gh run list` shows scheduled runs | after C is read | none |

The workflow already shows as `active` in `gh workflow list`; "enabling" it means row 6, not a toggle.

## 7. Watcher and digest (proposed; no routine was edited)

- **Watcher:** add one section to the existing routine "Trinity daily integrity check" (daily 09:00 Los Angeles,
  database connector attached). It reads only:
  `select status, count(*) from trinity_tasks where insert_source='t12-lane-replenish' group by 1;`
  then, per finished lane row, the row, its `trinity_artifacts` by `task_id`, and its score events, and reports
  the four answers of section 3. It proposes follow-ups as text. It dispatches nothing.
- **Digest:** add one section to the existing "Nightly recap" (already phone-readable): lane rows by queue state,
  cards routed to review or repair with their one-line reason, and anything `not_checked`. Not a new routine.
- **Cadence:** routines run at most hourly [R, inventory], so the watcher is a daily read, not a control loop.
  The dispatcher's own cadence is row 9.
- **Overlap:** the local task `conductor-planner-files-only` (D-194) only runs with the laptop on. Once the
  watcher section exists, turn it off (Sean's call).
- NOT_CHECKED: which column ties a score event to a task. Three `repid_score_events` rows mention 439484 [V, text
  match]; the exact join is not established, so the watcher's scoring answer stays `not_checked` until it is.

## 8. Hand-back

**Diff summary.** New: `t12-feed-order.ts`, `t12-delivery-check.ts`, `t12-reconcile.ts`, `t12-rehearsal.ts`,
`scripts/t12/delivery-check.ts`, `scripts/t12/rehearse.ts`, four fixtures, three test files. Changed:
`t12-lane-store.ts` (`validateSpec`, `claimMake`, `replenish`, new `planReplenish`), `t12-lane-runner.ts` and
`scripts/t12/lanes.ts` (the freeze option), `t12-lane-git.ts` and `scripts/t12/build-context.cjs` (skip `meta:`
entries), `tests/t12-lanes.test.ts` (five database tests). No workflow, migration, secret, variable or schedule
was touched. One behaviour changes by default once lanes run: a rejected task is offered again before newer work
in its horizon.

**Rehearsals.** 5 of 5 pass (section 4).

**Remaining blockers.**
1. Prerequisite rows 2 to 7 (Sean).
2. Free models on lane code specs: 0 of 6 first-attempt verified [R, WORK_CASCADE section 3]. The first real
   cycle may end in a rejection. That is still a complete, independently checked cycle, and it exercises
   fix-first on the next run.
3. Audit cards cannot run in the lanes (limit 1 above). Design call, not made here.
4. No lane stage calls a second model family, so `breaker` is not enforced anywhere yet.
5. Risk class of this PR by the repo's script: MEDIUM [V: `risk-gate.mjs class DealAppSeo/repid-engine 1599`], so
   it needs two reviewers from two non-Claude families before it can land.

**First real shadow card.** `ts-repid-to-tier`, the first line of `ops/t12/specs.jsonl`: LOW risk, one new test
file in trustshell, two negative controls already in the spec. With the default ready target of 3 the feeder
queues the first three specs in the file and this one is claimed first (same priority, oldest row). Run with
`publish=false`:
the maker writes the test, the checker (a different database role, in a container, with no model key) runs it
and both controls, and nothing is published.

**The one decision for Sean.**
> Apply the T12 worker-role migration to production?
> **What changes:** three new database logins (`t12_lane_maker`, `t12_lane_checker`, `t12_lane_integrator`) and
> the rules that limit each to its own stage of the lane pool. No existing row changes. Nothing starts running.
> **Risk:** besides adding the lane roles' own rules on `trinity_tasks`, it closes 13 database functions that
> anyone can call today and re-opens each to a list of 17 named roles; a role missing from that list would lose
> a function it uses. The read-only check `ops/t12/audit/role-migration-prod-compat.sql` was last run against
> production on 2026-11-11 [R, its own header], not by this session; run it again first, since 13 days of
> changes have landed since.
> **Undo:** paste `migrations/rollback/DOWN_2026-11-08_t12_lane_worker_role_DRAFT.sql` in the same editor.

Everything after it (rows 3 to 7) is setup that follows from a yes and stays inert until row 6.

## 9. Not verified

- One cycle against the production queue (blocked on section 6).
- `scripts/t12/delivery-check.ts` has never read a real database. Its reader is tested with a stand-in and with
  real row contents; the "not armed" exits were run (`exit 2`). A local end-to-end run was stopped by the guard
  hook, which refuses table-creating SQL wherever it points.
- The `meta:` skip in `t12-lane-git.ts` and `build-context.cjs` has no test of its own.
- `claimMake` orders only the first 100 ready rows.
- The copy comparison is line for line after squeezing spaces; a copy that differs only in formatting reads as a
  disagreement. The differing lines are returned so a person can tell.
- `modelFamily` takes a model name up to its first digit. Two families sharing a prefix would read as one, which
  errs toward "not independent".
- `WORK_CASCADE_2026-11-16.md` section 2 still says only "ride in `context`"; it should name the `meta:` form.
  That file is canon outside this repo and was not edited.
