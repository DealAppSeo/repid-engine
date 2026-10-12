# Dependabot wave — operational lessons (2026-10-11)

Narrative home per `CLAUDE.md` ("Narratives stay in `reports/<date>/`"). Measured
during the wave, written so the next agent on any surface doesn't re-learn them.
Status/decisions live beside this in `DEPENDABOT-TRIAGE.md`; this file is the *why*.

Context: the Tier-A security wave added a `.github/dependabot.yml` to every repo,
which opened ~46 Dependabot PRs at once. Driving them to green surfaced nine
reusable lessons. The capstone fix — grouped `dependabot.yml` per repo — exists so
most of these can't recur.

## 1. When N PRs fail the same check the same way, suspect ONE systemic cause
Every repid-engine Dependabot PR's `test` job was red. The cause was not in any
bump: GitHub withholds Actions secrets from **Dependabot-authored** runs, so the
integration step got empty `SUPABASE_URL_TEST` / `SUPABASE_SERVICE_KEY_TEST`, and
18 suites threw at import instead of skipping. One root fix (PR #1307: secretless
runs SKIP instead of throwing) cleared all of them. Triaging ten PRs individually
would have been ten wrong investigations. Look for the shared root before the Nth.

## 2. A green *title* is not a green *check*
A Dependabot title saying "minor/patch group" does not mean its `test` passes.
#1290 (an npm minor-patch group) was red because one of its 11 updates bumped
`solc`, which broke a pinned-bytecode test. This was gotten wrong first — tagging it
"safe" from the title — and caught by the operator. Measure the actual check
conclusion; never infer mergeability from the title. (RULE-4.)

## 3. Re-running a workflow ≠ re-testing against current `main`
A workflow **re-run reuses the original merge commit**. It does not pull in a fix
that landed on `main` *after* the run was created. trustshell #502's `check` was
re-run twice and failed identically both times on the stale merge-ref — the relaxed
test from #512 (already on `main`) was never in that checkout. Verified from the job
log: the old test (`checkout@v4`) was still what ran.

## 4. To pick up a fix that's now on `main`, update the BRANCH — don't re-run, don't rely on `@dependabot rebase`
The fix for #3 is to update the PR branch so it *contains* current `main`:
GitHub's "Update branch" (`update_pull_request_branch`) merges `main` in → new head
→ CI re-runs against the fix → green. `@dependabot rebase` is unreliable here: it
no-ops on a PR that is mergeable-but-behind (it only acts to resolve a conflict), so
it silently did nothing on #502. Update-branch is deterministic and immediate; use
it for the "fix is on main, pull it in" case.

## 5. A new head drops a required check that doesn't auto-rerun
trustshell requires the `Strix Security Review` check and does **not** re-run it on
push. Any branch update / rebase / recreate creates a new head → Strix goes *absent*
(not pending, not failing) → the PR reads `blocked` → you must comment
`@strix-security` to re-trigger it. Budget that extra step before touching such a
branch; "absent required check" is the trap that looks like a stuck PR.

## 6. npm group PRs need Dependabot to regenerate the lockfile
You cannot hand-merge `main` into an npm-group Dependabot PR whose group bumps the
same deps `main` just changed — the `package-lock.json` conflicts and only Dependabot
regenerates it. Update-branch is for action/workflow bumps (no lockfile). For npm
groups, let Dependabot `rebase`/`recreate` do the lockfile.

## 7. Shared-workflow-file serial conflicts are structural, not bad luck
Merging one GitHub-Actions bump makes every *other* open action bump in that repo
conflict, because they all edit the same workflow YAML. Firing `@dependabot rebase`
after each merge is treating a structural problem as a one-off. The fix is
**grouping** — one grouped PR per repo — so there is nothing to serialize.

## 8. Three outcomes on every check: a re-run that "completed" is not "passed"
Read the `conclusion`, not the `status`. `completed` + `failure` is still failure; a
`check_suite.completed` event only says nothing is still running, not that everything
passed. VERIFIED / NOT_CHECKED / FAILED, always.

## 9. A closed Dependabot PR comes back unless it is ignored
Closing a major bump without `@dependabot ignore this major version` (or an `ignore`
entry in `dependabot.yml`) means Dependabot re-opens it on the next run. The grouped
config's per-dependency `ignore` list is what makes the deliberate closes stick — the
close alone does not.

## The capstone
Grouped `dependabot.yml` per repo (minor+patch → one PR; the closed majors `ignore`d)
turns a 46-PR storm into one grouped PR per repo and removes the shared-file
serial-conflict dance entirely. It lands *after* a wave clears, so both schemes never
run at once. That is the antifragile move: change the structure so the failure mode
can't recur, rather than getting faster at firing rebases.
