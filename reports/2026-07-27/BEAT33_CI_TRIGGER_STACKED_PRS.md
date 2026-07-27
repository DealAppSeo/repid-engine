# Beat 33 — the CI trigger that skipped stacked PRs, and three false claims in CLAUDE.md

**Date:** 2026-07-27 · **Beat:** 33 of the HyperDAG autonomous build loop
**Shipped:** repid-engine PR #213 (CI trigger) · PR #214 (CLAUDE.md corrections)
**Queue at beat start [V]:** `origin/main` = `a1b6e7f` — unchanged since Beat 30. Nothing merged in three beats.

---

## 0. The most important thing this beat found was a live hole in its own predecessor's PR

Beat 32's independent verifier reported that `hasBacktrackingRisk` — the guard Beat 32 had just fixed — still had a bypass. **I reproduced it before acting on it**, because Beat 32's own lesson was that a verifier's example can be wrong (its `(a+){10}` claim was). This one is real.

The guard scanned the body only at depth 1:

```ts
else if (depth !== 1) continue;   // src/services/task-verify-leg.ts:184
```

So wrapping a dangerous body in one extra pair of parentheses hid it completely. Measured against a real `.test()` on this Node build:

| n | `((a+))+$` vs `'a'.repeat(n) + 'b'` |
|---|---|
| 24 | 0.37 s |
| 27 | 2.9 s |
| 30 | **24.6 s** |

Clean exponential growth, at subject lengths far below the `MAX_SUBJECT_LEN=20,000` backstop the module leans on. And `parseContract('{"matches":"((a+))+$"}')` **accepted** it — reachable end-to-end, and it would have parked the bridge poller that runs every 30 seconds.

**The verifier reported one shape. Sweeping the space found four more** through the same hole: `(((a+)))+$` (depth 3), `((a*))*$`, `((a{2,}))+$`, `((a|aa))+$`. Depth is not a safety property; wrapping a dangerous body in parentheses does not tame it.

The sweep also turned up a **pre-existing false positive** nobody had noticed: `(?:abc)+` is fixed-width and entirely safe, and the old guard rejected it — the `?` that *opens* a non-capturing group was being counted as the `?` quantifier. That constrained the fix, because the obvious "count every depth" would have made it worse: every nested `(?:` would trip.

**Fixed on #209 (`7a8aff6`):** scan at every depth, with `groupBodyStart` stepping over `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and `(?<name>` wherever they occur — including on nested groups. An unrecognised `(?…` is deliberately left alone so its `?` still counts (fail closed). The false positive disappears as a side effect.

**Verified:** `tsc` clean; **69/69** across the three affected suites (was 66); #209 back to `MERGEABLE`/`CLEAN` with `test` pass 2m13s. Three mutations, each with a landing assertion: restore the `depth !== 1` skip → 2 failed · `groupBodyStart` no-op → 1 failed · drop the nested-prefix step → 1 failed.

**That last mutation initially killed nothing** — and that was a finding about my tests, not a passing grade. No case exercised a *nested* `(?:`. Added `(a(?:bc)d)+` and `(a(?<n>b)c)+` (safe) plus `(x(?:ab)*y)+` (risky), after which it kills.

**Two bypasses in two consecutive beats is a pattern worth naming.** The function's own comment concedes it is "a heuristic, not a proof of termination." A heuristic that has now failed twice against shapes a bored operator could type is probably the wrong instrument; an execution-timeout wrapper or a vetted library is the honest next step, and is queued for the next beat rather than bolted on here.

## 1. The finding Beat 32 surfaced, and what it actually cost

Beat 32 noticed in passing that PR #210 had only ever run `gitleaks`. This beat confirmed the mechanism and fixed it.

Both PR gates declared:

```yaml
on:
  pull_request:
    branches: [main]
```

GitHub dispatches a `pull_request` workflow only when the PR's **base** matches that filter. A **stacked** PR — one based on another feature branch — matched nothing, so `test` and `crosscheck` never ran on it.

**[V] Verified independently of Beat 32's report**, by reading the `on:` blocks at `origin/main` and by `gh pr checks`:

| PR | base | checks that have ever run |
|---|---|---|
| #210 | `feat/cc-2026-07-27-pcr-p2-retrieval` | `gitleaks` only |
| #207 | `feat/cc-2026-07-26-leanimt-plus-p1` | `gitleaks` only |
| all others | `main` | `test`, `crosscheck`, `gitleaks` |

Two of fifteen open PRs. The cost is not the count — it is that a green tick on those PRs meant *"no secrets committed"* and was read as *"tests pass."* #210's tests had exactly one independent execution in their lifetime: a verifier running them by hand in a throwaway worktree.

**This is the same defect class the last four beats have been chasing, in a new costume.** Beat 30's thesis was "a check that cannot fail proves nothing." A check that never *runs* is the degenerate case, and it had been sitting in `.github/workflows/` the whole time.

## 2. The fix, and why it was the dependency-earliest task available

Drop the `branches:` filter from `pull_request` in `ci.yml` and `crosscheck.yml`. `push` stays scoped to `main`, so this does not fire on every branch push. Cost is a couple of extra jobs per stacked-PR push.

It was chosen over the other unblocked candidates for a reason found *during* the beat, not assumed before it:

**[V] `allow_auto_merge: false` on the repo, and `main` has NO branch protection** (`gh api .../branches/main/protection` → 404 *"Branch not protected"*).

So the automation policy Sean chose on 2026-07-26 — *"auto-merge on green, safe class"* — has never been enabled at the GitHub level. Three beats have been prepping PRs for an auto-merge path that cannot fire. And the enablement has a strict ordering: **required status checks on `main` would leave every stacked PR permanently blocked**, because the required checks never run on them. Widening the trigger is a precondition for the protection, which is a precondition for auto-merge, which is what drains the queue. That is dependency-earliest under rule 5.

## 3. The pin, and the part that could have been fake

`tests/ci-workflow-triggers.test.ts` asserts the trigger stays open. A one-line YAML edit is exactly what gets re-added later under a plausible banner ("scope the trigger, save CI minutes").

The hazard is that a config-pinning test passes because *its own reader* is broken — a hand-rolled YAML walker that never finds `branches:` would make every assertion trivially true. That is the same species of lie as the defect being fixed, so the reader is pinned three ways:

1. against synthetic fixtures that **do** carry a filter, in both flow (`branches: [main]`) and block-sequence (`branches:` / `- main`) forms;
2. against the real `push:` trigger, which legitimately keeps `branches: [main]` — a reader that could not see a filter *in the real document* fails here;
3. against `pull_request` being **present** at all — deleting the trigger would otherwise satisfy "no filter".

Plus a negative case that the reader does not attribute a sibling event's filter to `pull_request`, and one that a `#` comment mentioning `branches` is not a filter.

### Verification

- `tsc --noEmit` clean; **12/12**.
- **Four mutations, each grepped back to confirm it landed before its result was trusted:**

| mutation | tests |
|---|---|
| re-add `branches: [main]` under `pull_request` | 1 failed |
| delete the `pull_request` trigger entirely | 1 failed |
| **blind the reader so `branches:` can never be found** | **5 failed** |
| drop the sibling-event `break` so a filter leaks across events | 4 failed |

The third is the one that proves the assertions are not vacuous.

### The empirical proof, not the semantics argument

"Stacked PRs will now run checks" is a claim about GitHub's dispatch behaviour. Rather than assert it, it was demonstrated: for `pull_request` events the workflow file comes from the merge ref, so the fix is testable **before** merge.

Throwaway PR **#215** was opened with base `feat/cc-2026-07-27-ci-trigger-stacked-prs` — a feature branch, not `main`.

**[V] Result: `test` and `crosscheck` were both dispatched, with run URLs.** The two checks that #210 (same shape, without the fix) has never had. #215 was closed and its branch deleted immediately after the observation; it exists in the record only as the control.

**[V] #213 itself:** `test` pass (2m15s), `crosscheck` pass, `gitleaks` pass; `MERGEABLE`/`CLEAN`. No production code touched.

## 4. Two mistakes worth recording, both about mutation harnesses

**The first mutation run reported 12/12 passing on three mutations that had not landed.** The `perl` patterns used `\n` where the workflow files use CRLF (`core.autocrlf=true`), so the substitutions silently no-opped and the unchanged tests passed. Had the landing check not been there, the honest reading of that output is "three of my four checks are decorative" — the exact wrong conclusion, arrived at through a green result.

This is the **fourth** consecutive beat in which a mutation silently failed to apply (Beats 27, 30, 31, 32 all recorded a variant). The grep-back is no longer a nice-to-have; it is the only thing standing between this loop and a fabricated verification. The rewrite asserts the occurrence count changed by exactly one and that the new text is present, and prints `landed=` per mutation.

**The fourth mutation, as first written, was a behavioural no-op and I nearly counted it as a kill.** `if (found)` → `if (found || true)` changed nothing, because the sibling-event guard is the `break` above it, not that condition. The `if (found)` is genuinely redundant. Re-targeted at the `break`, it killed 4 tests. A mutation that fails to change behaviour and a test that fails to check anything are indistinguishable from the outside — which is why the mutation has to be *designed against the mechanism*, not against the nearest line of code.

Also: `subprocess` decoding died on cp1252 when jest echoed a `→` and a `’` from the test names, and Git Bash path-mangled `origin/main:.env.example` into `origin\main;.env.example`. Both cost a round trip. Neither affected a result.

## 5. Second ship — CLAUDE.md had three false claims, and one of them had a measurable cost

`CLAUDE.md` is the first file every agent reads here. Its "Commands" block was wrong three ways. Each was verified against `origin/main`, not reasoned about. → **PR #214**, docs only.

**(1) "A dummy `.env` is committed for local boot-without-DB" — false.**
`git ls-tree -r origin/main` lists only `.env.example`. `.env` is gitignored (`.gitignore:3`) and `git log --all -- .env` is empty — never tracked in any reachable ref. And `.env.example` ships `SUPABASE_URL=` and `SUPABASE_SERVICE_KEY=` **empty** (value length 0, verified without printing values) — precisely the two that `src/config.ts:46` throws without.

**This is why the same discovery keeps recurring.** Beats 31 and 32 both logged *"local test runs need `SUPABASE_*` dummies or `trinity-task-bridge-verify` fails at import"* as a fresh finding, each filing it as a pre-existing quirk. It is not a quirk; it is a documented promise that was never true. A doc that lies about setup does not merely fail to help — it converts a one-line fix into a rediscovery, every time.

**(2) The documented single-test commands do not run.** `npx jest tests/repid-score.test.ts` and `npx jest -t "..."` both abort with *"Multiple configurations found"* — the repo has both a `jest.config.js` and a vestigial `jest` key in `package.json`. Verified by running both verbatim. `npm test` works only because the script already passes `--config jest.config.js`. Added the flag to the documented forms and named the duplicate-config root cause; deleting a config is not a docs-PR action.

**(3) The jest `roots` claim is stale.** Documented as `['<rootDir>/tests']` with a blanket "`src/**/__tests__` is not picked up." Actual: `['<rootDir>/tests', '<rootDir>/src/hal/lib/__tests__']`. So **one** `__tests__` directory runs (2 files) and **six** do not. The blanket claim points the wrong way on the single folder that *is* covered — an agent would assume `src/hal/lib/__tests__` changes are untested. All seven enumerated.

## 6. Deliberate non-action — T12 dispatch, fifth beat running

The contract asks for 2–5 T12 items per beat. **None enqueued, and the gate has not moved.** The sequence set in Beat 31 stands: merge #209 → run `TASK_VERIFY_LEG_MODE=shadow` → read a night of logs → *then* dispatch contract-bearing tasks. #209 is still unmerged. Beat 30's measurement is the reason: 18 of 18 nightly artifacts contained zero real measurements because the agents lack an HTTP client, so dispatching work that requires a capability they do not have manufactures fabrication. Nothing about that changed this beat.

## 7. Live context at beat end [V sql:2026-07-27]

| metric | value | note |
|---|---|---|
| `trinity_tasks` pending | 0 | 9 claims / 14 score events in 24 h |
| `repid_proof_queue` pending | **40,551** | **unchanged from Beat 32** — the producer did not add rows this interval, so "producer alive" is not re-asserted here |
| `erc8004_reputation_writes` | 72 | last 2026-07-23 04:36 UTC |
| `eas_anchor_batches` | 219 rows | vs 225 distinct anchored UIDs — backfill still un-run |
| `repid_zkp_proofs` | 78,783 | unchanged |

## 8. Carried, unchanged

The public 500 on `GET /api/v1/marketplace/browse` · retire the nightly `[E2E-SMOKE nightly]` spawner · the EAS backfill INSERT · the 147,537 `repid_verified=true` rows with no verifier behind them (audit SQL in BEAT31 §4, deliberately unrun) · proof-generation restart is a two-env-var action once #204 lands · `verify-anchor-batch --sample` into the verify suite · `statement.commitment_scheme` after #201 lands.

---

*Sequence over schedule. Evidence over claims. A check that never runs is the degenerate case of a check that cannot fail. Micah 6:8.*
