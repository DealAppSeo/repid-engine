# Beat 50 — the witness index was gating a soundness decision, and nothing binds it

**Date:** 2026-07-28 (UTC) · **Author:** autonomous build-loop (Claude) · **Status:** finding [V], fix on branch `fix/cc-2026-07-28-nonmembership-index-unbound`, **awaiting independent verification (rule 3 — I wrote it)**
**Patent bearing:** Patent #1 — "current-valid, revocable, proof-carrying memory". This is the *non-membership soundness* clause, i.e. what "provably absent" is worth.

---

## 1. The finding

`verifyNonMembership` (`src/memory/leanimt-plus.ts:132`, pre-fix) decided whether a value-0 low leaf
was the **sentinel** by reading `w.lowLeaf.index`:

```ts
if (L.value === 0n && w.lowLeaf.index !== 0) return false; // tombstone guard
```

`index` is a **self-reported field of an untrusted witness**. `verifyInclusion` folds `path` and
never reads it (`proof-carrying-index.ts:115`), so the root binds the leaf's *contents* and its
*position via the path*, and binds `index` not at all. Beat 49 established this for one case — that
a *tombstoned* leaf's forged `index: 0` defeats the guard, leaving `L.tombstoned` as the sole
defence. **This beat measured the case where `L.tombstoned` is not there to catch it.**

### The forgery [V] — measured on `origin/main` @ `16b220c`, not argued

A committer plants ONE leaf that is value-0 and **not** tombstoned, at a non-zero index:

```
leaves = [ {0 → 7, live} sentinel , {0 → 0, LIVE}  ← poison, index 1 , {7 → 0, live} ]
witness = { index: 0 (LIED), leaf: poison, path: <genuine path for index 1> }

verifyNonMembership(7n, witness, root)  ===  true        ← 7 is LIVE at this same root
verifyMembership   (7n, <honest>, root) ===  true
```

Both hold at the same root: **membership and non-membership are not mutually exclusive**, so the
committed memory is not a function. It works with `next = 0` (reads as the tail) and with
`next = 999999` (reads as "the next active value is above 7") — both satisfy the ordering test, and
the tombstone guard never fires because the poison leaf is not tombstoned. A single planted leaf is
a **universal absence oracle**: any live value can be proved absent, which is exactly the property
the revocation/audit claim rests on.

### The same field also produced FALSE NEGATIVES

Symmetrically: an **honest** non-membership proof whose low leaf is the sentinel is *rejected* if the
index is mislabelled — a valid retraction proof refused because of a field no one authenticates.
Both directions are pinned in the tests.

---

## 2. The fix

Derive the slot from the **path**, which the root does bind:

```ts
if (L.value === 0n && !pathIsLeftmost(w.lowLeaf.path)) return false;
// pathIsLeftmost = path.every(s => !s.siblingOnLeft)
```

A leaf is leftmost iff its sibling is on the right at **every** level. The equivalence is exact for
this builder: a position with any 1-bit is odd at that level and therefore has a left sibling, and a
lone **promoted** node always sits at an even position (`buildLevel` promotes at even `i`), so
promotion can never hide a left-sibling step. Not left as an argument — measured for **every index
at 13 tree sizes** (1–17 leaves, odd and even), `pathIsLeftmost(proof(i)) === (i === 0)` in all cases.

`InclusionWitness.index` is kept (prover-side bookkeeping) and now carries a doc-comment stating it
is unauthenticated and may never gate a soundness decision. `lowLeafIndex` inside `LeanIMTPlus` still
uses `i !== 0` — correctly: that is the *prover* walking its own trusted state, not a verifier
reading an untrusted claim.

---

## 3. Verification performed by the author (NOT a substitute for rule-3 review)

- **Defect reproduced, not asserted.** With only the guard line reverted to the index version and the
  tests kept: **4 of 22 fail** — the two poison-leaf cases, the membership/non-membership exclusion
  case, and the honest-witness index-forgery case (the false-negative direction). The other 18 are
  premise and honest-path tests and correctly hold either way. Source restored from a byte-compared
  golden copy afterwards; `git diff --stat` = 30 insertions, 1 deletion, one file.
- **The attack is asserted to be live, so the test cannot pass by the forgery being toothless:** each
  poison case asserts the tombstone guard does *not* fire, the ordering test *is* satisfied, and the
  target value *is* provably a member at that same root, before asserting the refusal.
- Bounded local run (no repo-wide build, per the loop contract): the 7 memory/grounding suites —
  `leanimt-plus-index-unbound`, `leanimt-plus`, `proof-carrying-index`,
  `proof-carrying-index.poseidon2`, `proof-carrying-memory`, `proof-carrying-e2e`, `hal-grounding` —
  **64/64 pass**. Full-suite and `tsc` are CI's job.

**Not verified by me and deliberately not claimed:** whether these tests survive an adversarial
mutation battery. I wrote them; that is a different agent's job.

---

## 4. What this does NOT fix — carried, deliberately, and now written into the source

A stateless verifier sees one witness against one root, and the root's producer is not trusted. This
fix closes what is *checkable* from that position; it does **not** make non-membership sound against
an arbitrary adversarial committer. A committer who forges the whole tree can still publish a
sentinel whose `next` skips over live values, and no single non-membership witness can detect it.
Indexed Merkle trees normally close this by constraining **insertion in-circuit**; this reference has
no such constraint. Non-membership is therefore sound **relative to a well-formed commitment**, not
against an arbitrary one.

That limitation is now stated in the `leanimt-plus.ts` header rather than left to be inferred from
the guards, and is carried as the **commitment-well-formedness gap** — the honest next question for
Patent #1's non-membership claim, and a real one (it is the difference between "provably absent" and
"provably absent, assuming the committer built the tree the way the code does").

---

## 5. The shape, for the record

Fourteen beats, fourteen weaker properties. Beat 49's was *a property demonstrated by the harness
rather than held by the code*. This one is its neighbour: **a guard that reads data the commitment
does not bind** — which is not a weak guard, it is a decorative one. It had the shape of
defence-in-depth (two guards on adjacent lines) and contributed nothing, while the one line beside it
carried the whole property. The tell was available by reading: `verifyInclusion`'s signature does not
take an index.
