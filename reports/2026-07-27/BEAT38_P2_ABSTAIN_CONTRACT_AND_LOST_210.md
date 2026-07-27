# Beat 38 — the P2 abstain contract, and a merged PR whose content is in no branch

**Date:** 2026-07-27 · **Repo:** `DealAppSeo/repid-engine` · **PR:** #207 (Patent #1 keystone)
**Beat objective:** priority 1 of the sprint brief — *land + harden the patent path*. At beat start
#207 was the **only** `CONFLICTING` PR in the repo and its `test` check was **red**; it is the P2
retrieval + answer-binding commit, i.e. the Patent #1 keystone. Everything else in the queue was
landing on its own (11 PRs merged since Beat 37).

---

## Finding 1 — PR #210 is marked MERGED and its content exists in no branch [V]

**Status on GitHub:** `#210 feat(hal): wire proof-carrying abstain into the grader (shadow-first)` —
`state: MERGED`, `mergedAt: 2026-07-27T14:50:51Z`, `baseRefName: feat/cc-2026-07-27-pcr-p2-retrieval`.

It merged into **#207's branch**, not into `main`. That branch was then **force-pushed** (rebased
onto `main` as a single commit) by a concurrent session, and the rebase **dropped** #210's commit.

Evidence, each command run and its exact output:

| Check | Command | Result |
|---|---|---|
| #210's commit on the branch? | `git merge-base --is-ancestor f603947 origin/feat/…-pcr-p2-retrieval` | **NO** |
| Reachable from any remote branch? | `git branch -r --contains f603947` | **(empty)** |
| Present on `main`? | `git ls-tree origin/main -- src/hal/hal-grounding.ts` | **(empty)** |
| Any `#210` commit on `main`? | `git log --oneline origin/main \| grep '(#210)'` | **NONE** |
| Grounding wiring on the branch? | `git show origin/feat/…:src/scoring/pipeline.ts \| grep -c -i grounding` | **0** |
| The force-push itself | `git reflog show origin/feat/…-pcr-p2-retrieval` | `ed6cc52 update by push` ← `f603947` ← `837c7bd` |

`f603947` still resolves as a **dangling object in this clone only**, because this beat fetched it
before the force-push. A `git gc` here, or a fresh clone anywhere else, and it is gone.

**Why it matters beyond bookkeeping.** #210 is the **abstain-if-ungrounded leg** of Patent #1 —
the morning briefing lists the chain as `commit → prove-inclusion → cite → bind-to-answer →
abstain-if-ungrounded → revoke → EAS-anchor-root` and names "#210 (HAL abstain, shadow)" as
built. Every status surface reads it as merged. **The code is not in the shipping line.** This is
the loop's recurring shape at a new address: *a green status that is not backed by the artifact*
(Beat 30's fabricating smoke test, Beat 34's check that never ran, Beat 37's pipeline exit code).

**Action taken:** `f603947` restored onto #207's branch as `60e7de7`, unmodified, before the object
could be lost. It is `src/hal/hal-grounding.ts` (62 lines) + `tests/hal-grounding.test.ts` (65) +
21 lines wiring into `src/scoring/pipeline.ts`, default `HAL_GROUNDING_MODE=shadow` — unchanged
shadow-first semantics, no behaviour change to live scoring.

**Structural note, not a fix.** Merging a PR into a *feature branch* rather than into `main` makes
its content hostage to that branch's future rewrites, and GitHub keeps reporting MERGED regardless.
That is a process property, not a bug in anyone's diff. It is the second beat running in which a
concurrent session's rewrite of a shared ref cost real work (Beat 37 recorded the live checkout
switching branches mid-beat).

---

## Finding 2 — the revoked-citation abstain path leaked the accumulator's internal error [X→FIXED]

This is why #207's `test` check was red.

`emitGroundedAnswer` documents exactly one contract: it **throws `abstain: …`** unless every
citation is a current member of the committed memory root. Three paths can abstain. Two honoured
the contract; the third did not:

| Abstain path | Message before this beat |
|---|---|
| no citations | `abstain: an answer must cite at least one committed memory entry` ✅ |
| value never committed | `abstain: cited value … is not in memory` ✅ |
| **cited value REVOKED** | `LeanIMTPlus.membershipProof: value … not active` ❌ |

**The failing case is the one the primitive exists for.** Provable retraction forcing abstention
IS the Patent #1 keystone behaviour ("a retracted fact can no longer be retrieved or cited"), and
it was the only abstain case not signalled as an abstention. A caller branching on the `abstain:`
contract — the documented way to tell a principled refusal from an internal fault — would
mis-classify a retraction as a bug, and the safe default is opposite on each side of that line.

**The existing test was right and the code was wrong.** `tests/proof-carrying-memory.test.ts`
already asserted `toThrow(/abstain/)` on the revoked path. The P2 commit message claims
`verified 11/11`; the file contains **9** tests and **1 failed**. The claim is not reproducible.

**Reproduced before acting, and attributed before fixing.** The concern was that this beat's
rebase onto `main` caused it — `main` carries #218's Merkle domain separation + non-malleable
odd-node handling, which changed the hashing under P2. Ruled out by experiment rather than
argument: with the **pre-#218** `proof-carrying-index.ts` swapped in (the exact #207 branch state
for every module on this code path; `leanimt-plus.ts` and both P2 files are byte-identical between
the two), the same single test fails with the same message — `8 passed, 1 failed`. **Pre-existing
on the branch, not rebase-induced.**

Worth recording, since it was the thing being ruled out: `LeanIMTPlus` calls
`referenceRoot`/`referenceProof`/`verifyInclusion`, so #218's hardening **does** reach the
load-bearing accumulator, not only P0's reference tree. The domain-separation work covers the
path P2/P3 actually use.

**Fix:** wrap the witness call and re-throw as an abstention, **preserving the underlying cause**
in the message rather than swallowing it, so diagnosis still works.

```ts
let witness: InclusionWitness;
try {
  witness = memory.membershipWitness(v);
} catch (e) {
  const cause = e instanceof Error ? e.message : String(e);
  throw new Error(`abstain: cited value ${v.slice(0, 12)}… is not currently valid (${cause})`);
}
```

---

## The pin, and proof that it can fail

Two tests added. The first **enumerates all three abstain paths** and asserts each carries the
`abstain:` prefix, compared as a `[name, prefix]` pair so a failure names *which* path leaked
rather than just showing a bad string. The second asserts the revoked message states *why* **and**
retains the accumulator's cause.

**5 of 5 mutations killed** — baseline PASS → post-restore PASS → **zero marker residue on disk
(checked, not assumed)**:

| Mutation | Result |
|---|---|
| M1 remove the try/catch entirely | **FAIL** (killed) |
| M2 drop the preserved cause from the message | **FAIL** (killed) |
| M3 rename the prefix on the revoked path only | **FAIL** (killed) |
| M4 rename the prefix on the never-committed path | **FAIL** (killed) |
| M5 rename the prefix on the no-citations path | **FAIL** (killed) |

M4 and M5 exist because a pin that only covers the path just fixed would let the other two regress
silently — the same *"file-granular vs per-case"* lesson Beat 37 learned on the lineage pin.

**M1 first reported `NOT-LANDED (anchor not found)` — the CRLF trap, caught by the guard rather
than by luck.** The multi-line anchor used `\n` against CRLF files, the identical trap Beats 36 and
37 hit. Without the marker guard it would have read as a **free pass on the most important
mutation of the five**. Harness fixed to normalize to the file's own line endings.

---

## Verification

- `npx tsc --noEmit` — **clean**.
- Memory + HAL suites (6 files: proof-carrying-memory, hal-grounding, leanimt-plus,
  proof-carrying-index, proof-carrying-index.poseidon2, memory-root-anchor):
  **44 passed / 44**, taken from jest's own totals. Before this beat: 42 total with **1 failing**.
- Full local suite run **unpiped** (Beat 37's lesson — a piped run reports the pipe's exit code):
  see the ledger entry for the exact figure and the baseline comparison for any failing suite.
- Worktree discipline: dedicated worktree outside the repo with its **own** `npm install`, no
  junction anywhere, live checkout never switched. Mutation harness kept outside the repo.

## Live context [sql:2026-07-27]

`repid_proof_queue` pending **40,554**, newest row **13:56:54Z** — *not growing* (the dogfood queue
has drained; `trinity_tasks` pending **0**). `trinity_system_config.emergency_halt` = **false**.
ERC-8004 writes **72**. `repid_zkp_proofs` **78,783**. `eas_anchor_batches` **219**.
