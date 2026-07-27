# Beat 31 — the verify leg, and the verdict vocabulary nobody had read

**Date:** 2026-07-27 · **Branch:** `feat/cc-2026-07-27-task-verify-leg` · **Base:** `origin/main` = `a1b6e7f`
**Follows:** `BEAT30_SWARM_ARTIFACT_FABRICATION_AUDIT.md` (18 nightly runs, 0 real measurements)
**Tag key:** `[V]` verified this beat with a query/command · `[R]` reported, not independently confirmed

---

## 1. What Beat 30 left, and what looking at the schema changed about it

Beat 30 measured the cost of a missing verify leg: the swarm produced 18 nights of confident
fiction and every one of them was graded `done` and bridged to RepID, because nothing downstream
could tell a measurement from a narration. It named the fix as "wiring, not DDL — the columns
already exist."

That is true. It is also incomplete in a way that would have broken the wiring on its first write.

**The two verdict columns are not free-form.** Read from prod this beat `[V]`:

```
trinity_tasks_verifier_verdict_check:
  verifier_verdict IS NULL OR verifier_verdict = ANY (ARRAY['approved','rejected','unclear'])
trinity_tasks_final_verdict_check:
  final_verdict    IS NULL OR final_verdict    = ANY (ARRAY['verified_done','disputed_done',
                                                            'rejected','unverified','spot_audited'])
```

Anything else raises `23514 check_violation`. A verify leg that wrote the obvious `'pass'`/`'fail'`
would have failed on every single row — silently, from the bridge's swallow-and-log path.

---

## 2. The latent defect this uncovered in code that is already live

`trinity-task-bridge.ts` decides `repid_verified` through `isIndependentlyVerified`, which on
`main` tests both verdict columns against **one** set:

```ts
const PASS_VERDICTS = new Set(['pass', 'verified', 'approved', 'confirmed', 'upheld']);
...
return PASS_VERDICTS.has(fv) || PASS_VERDICTS.has(vv);
```

Intersect that with what the database will accept:

| column | DB-legal values | ∩ `PASS_VERDICTS` |
|---|---|---|
| `verifier_verdict` | approved · rejected · unclear | `{approved}` |
| `final_verdict` | verified_done · disputed_done · rejected · unverified · spot_audited | **∅** |

**The `final_verdict` branch can never fire against a value the database would store.** A peer
verifier writing the legitimate pass value `verified_done` — and leaving `verifier_verdict` NULL,
which the schema permits — was read by the bridge as *not verified*.

Direction matters for how alarming this is: it **fails closed**. Nothing was ever over-credited;
a real pass signal was being discarded. But the branch is not a latent nicety — it is the half of
the check that the peer-verify design actually populates.

**Fixed** by splitting the vocabulary per column, with `disputed_done` deliberately excluded
(work completed under dispute is not a clean pass) and the loose legacy strings retained, because
the agent runtime lives in `trinity-symphony-shared` and cannot be grepped from this repo `[R]`.

**Blast radius today: zero, and that is measured, not assumed.** `verifier_agent_id` is non-null
on **0 of 362,965** rows all-time `[V]`, so `hasIndependentVerifier` short-circuits before the
verdict is ever consulted. A test pins that (`no verifier id still short-circuits, whatever the
verdict says`) so the widened vocabulary cannot start crediting rows through the back door.

### 2a. The pre-existing test asserted against a vocabulary the DB rejects

`tests/trinity-task-bridge-verify.test.ts` on `main` uses `verifier_verdict: 'pass'` and
`final_verdict: 'verified'`. Both are `23514` at the database. The test was green and the code was
wrong at the same time, which is the whole reason this is a report and not a one-line commit.
The original cases are **kept** (they still pin the self-validation rule, which is what they were
written for) and a `DB-legal verdict vocabulary` block is added beside them.

---

## 3. The column audit, all-time

Beat 30 measured a 90-day window. Widened to the whole table `[V]`:

| | count | of 362,965 |
|---|---:|---:|
| `verification_method` non-null | 0 | 0% |
| `verifier_verdict` non-null | 0 | 0% |
| `final_verdict` non-null | 0 | 0% |
| `verified_output` non-null | 0 | 0% |
| `verifier_agent_id` non-null | 0 | 0% |
| `expected_output` non-null | 52 | 0.014% |
| `success_criteria` ≠ the column default | 22,052 | 6.1% |

**Refinement of a Beat 30 figure:** the 124,608 rows reading exactly `"Pass default checks."` are
not agents typing a filler string — it is the column's `DEFAULT` `[V]`:
`success_criteria text DEFAULT 'Pass default checks.'::text`. Same conclusion (the field carries
no information), different mechanism, and the mechanism is the part you would need to fix it.

Nothing in this repo has ever written the four verification columns `[V]` — repo-wide grep finds
reads in the bridge and one `final_verdict` write that targets a **different table**
(`trinity_receipt_bft_results`, `receipt-indexer.ts:258`). Textbook Pattern G.

---

## 4. A second finding, not previously recorded: 147,537 rows assert a verification that never happened

`repid_verified = true` on **147,537 of 362,965** rows `[V]`, while `verifier_agent_id` is non-null
on **zero**. Under the current rule those trues are unreachable — so they predate it.

Month by month, `repid_verified=true` tracks `metadata.repid_bridged='true'` essentially 1:1 `[V]`
(2026-04: 15/15 · 05: 44,011/44,011 · 06: 64,500/64,499 · 07: 39,011/39,011). The bridge wrote them
itself, back when `markTaskBridged` set the flag unconditionally.

The cutover is visible to the day `[V]`:

| bridged day | rows | `repid_verified=true` | has `independently_verified` key |
|---|---:|---:|---:|
| … 2026-07-17 | 1,360 | 1,360 | 0 |
| 2026-07-18 … 07-24 | 12 | 12 | 0 |
| **2026-07-25** | 6 | **0** | 6 |
| 2026-07-26 | 1 | **0** | 1 |

**The current bridge is honest** `[V]` — the #185/#186 fix went live around 2026-07-24/25 and every
row bridged since carries `repid_verified=false` plus the `independently_verified` marker.

What remains is **147,537 historical rows carrying a true claim in a trust-named column with no
verifier behind any of them.** Scope, stated precisely rather than dramatised: `trinity_tasks.repid_verified`
is written by the bridge and **read by nothing in this repo** `[V]` (the `repid_verified_decisions`
grep hits are a different table). So it is a latent false claim, not a live overclaim on any public
surface — with the honest limit that the agent runtime in `trinity-symphony-shared` cannot be
grepped from here `[R]`.

Remediation is a single-writer prod DML and is **not** taken here. Recommended shape, for Sean:

```sql
-- Retire the pre-#185 self-asserted verification flag. Additive-audit first:
select count(*) from trinity_tasks
 where repid_verified is true and verifier_agent_id is null;   -- expect 147,537
-- then, if approved:
update trinity_tasks set repid_verified = false
 where repid_verified is true and verifier_agent_id is null;
```

Reversible only in the sense that the flag can be rewritten; the *original* claim was never
evidence-backed, so nothing of value is lost. Deliberately left unrun.

---

## 5. What shipped

`src/services/task-verify-leg.ts` — a deterministic grader for the task classes that need no tools:
the task ships a machine-checkable contract in `expected_output`, and code grades the result.

**Assertions.** Substantive (can *confirm*): `matches` (regex) · `contains_all` · `json_keys`.
Negative (can only *reject*): `contains_none` · `min_length` · `no_placeholders`.

**Four design commitments, each with a test that fails if it is removed:**

1. **No contract → no verdict.** Absent/empty/prose `expected_output` returns `null` and all four
   columns stay NULL. "Unverified" is the honest state for ~99.99% of rows and it stays that way.
2. **A contract that cannot confirm is never read as confirming.** All-negative contracts yield
   `unclear`/`unverified`, never `approved` — even when every assertion passes. *(Mutation M2:
   deleting this gate turns an unconfirmable contract into `approved` and the suite goes red.)*
3. **DB-legal by construction.** The emitted values come from constants transcribed from the CHECK
   constraints, and a test asserts every reachable verdict is in the DB's set. *(Mutation M1:
   emitting `'verified'` instead of `'verified_done'` — the value the old bridge vocabulary expected
   — goes red.)*
4. **It never claims peer verification.** `repid_verified` is untouched; the stamp is
   `verification_method = 'deterministic-v1'`, so a code pass and an agent pass stay filterable
   apart in SQL forever.

**Placeholder rejection** is on by default whenever a contract exists, seeded from what Beat 30
actually measured — `abc123`, the value six agents emitted as a 40-hex commit sha on six different
nights, is in the list. *(Mutation M3: defaulting it off goes red.)*

**Mode lever `TASK_VERIFY_LEG_MODE`:** `off` (default — nothing computed, nothing written) ·
`shadow` (compute + log, persist nothing) · `enforce` (write the four columns). Resolution is
fail-safe: `enfroce`, `on`, `true`, `1`, `''` and unset all resolve to **off**, never to on. The
bridge prints the resolved mode at startup, because the failure this guards is someone deploying
with it set and nobody knowing.

**Bounds.** Operator-supplied regexes are capped at 200 chars, tested against at most 20,000 chars
of result, and rejected outright if they contain a nested quantifier (`(a+)+`) — the bridge polls
every 30 s and must not be parked by catastrophic backtracking. Stated limit: this is a
conservative heuristic, not a proof of termination; contracts are authored by the task creator, not
by the agent being graded.

A grader fault is caught and logged: it must never cost a task its score event.

---

## 6. Verification of this beat's own work

- `tsc --noEmit` clean `[V]`
- **60/60** across the three affected suites `[V]` — `task-verify-leg` **41 new**,
  `trinity-task-bridge-verify` 14 (5 pre-existing + 9 new), `peer-verify-prefilter-recursion` 5
- **Four mutations, each confirmed to have LANDED before the result was trusted** (Beat 27 and
  Beat 30 both recorded a silent no-op substitution reading as a pass; the line was grepped back
  every time here) `[V]`:

| # | mutation | landed at | result |
|---|---|---|---|
| M1 | `final = 'verified_done'` → `'verified'` (DB-illegal) | line 373 | 2 failed / 39 passed |
| M2 | delete the "cannot confirm" gate | line 366 | 1 failed / 40 passed |
| M3 | placeholder check defaults off | line 347 | 2 failed / 39 passed |
| M4 | restore `main`'s single verdict vocabulary in the bridge | line 51 | 2 failed / 12 passed |

Clean revert to 41/41 and 14/14 after each `[V]`. M4 is the one that matters most: it demonstrates
the §2 defect is real rather than asserted — with `main`'s vocabulary, `verified_done` and
`spot_audited` are read as failures.

All work done in a throwaway worktree with its own `npm install`; no `node_modules` junction
anywhere (Beat 27's rule); the live checkout was never switched.

---

## 7. What this does NOT do

- It does not enqueue any T12 work. The verify leg is the precondition, not the dispatch — and the
  leg is `off` by default until someone turns it on in `shadow` and reads a few nights of logs.
- It does not grade the 362,965 existing rows. It grades at bridge time, forward only.
- It is not peer verification and does not replace it. A deterministic checker cannot judge whether
  a research summary is *correct* — only whether it satisfies a contract. Contracts are for the
  tool-free, checkable classes (the two glossary tasks Beat 30 identified as genuinely well-done are
  exactly this shape); everything else still needs an independent agent.
- It writes nothing to prod. No DDL, no DML, no flag flipped.
