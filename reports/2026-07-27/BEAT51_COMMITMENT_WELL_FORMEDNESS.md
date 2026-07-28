# Beat 51 — the gap no witness can see: whole-commitment audit for the Patent #1 accumulator

**Date:** 2026-07-28 · **Branch:** `feat/cc-2026-07-28-commitment-audit` · **PR:** repid-engine #250
**Scope:** `src/memory/leanimt-plus.ts` (additive only), `tests/leanimt-plus-commitment-audit.test.ts` (new)

---

## 1. Independent verification of Beat 50 (#247) — CONFIRMED

Read the diff and the builder it depends on; did not re-run the author's tests as the verdict.

**The claim:** `verifyNonMembership` decided "is this value-0 low leaf the sentinel?" by reading
`w.lowLeaf.index`, a self-reported field the root does not bind. Fix derives the slot from the path.

**Checked against `src/memory/proof-carrying-index.ts:148-166` (`referenceProof`), not against the PR's prose:**

- `verifyInclusion` (`:113-119`) folds `path` and takes no index parameter at all. The unbound-field
  claim follows from the signature. **Confirmed.**
- The replacement predicate — *leftmost iff no step has `siblingOnLeft`* — is **exact for this builder**,
  and the two directions have different reasons:
  - **No false rejection.** Index 0 is even at every level (`idx = floor(idx/2)` from 0 stays 0), so
    the builder only ever emits the `idx + 1 < level.length` branch → `siblingOnLeft: false`. An honest
    sentinel witness always passes.
  - **No false acceptance.** For any `i > 0` with lowest set bit `b`, `i >> b` is odd, so at level `b`
    the builder takes the `idx % 2 === 1` branch and emits `siblingOnLeft: true`. That step cannot be
    elided by promotion: promotion fires only in the `else` arm, which requires an **even** position.
    Level `b` exists because `i >> b >= 1` implies ≥ 2 nodes at that level. **The step is always there.**
- Adversarial angle the PR did not state: a path is not required to *be* a `referenceProof` output. But
  an all-right-siblings path that folds to `root` places the leaf at position 0 under collision
  resistance — so the predicate is bound by the root, not by the builder's honesty. Holds.
- The new tests are **not vacuous**: each poison case asserts the tombstone guard does **not** fire and
  the target **is** provably a member at that root before asserting refusal.

**Verdict: green.** CI green on all five checks (`test`, `crosscheck`, `zkp-vault`, `gitleaks` ×2).
Not merged — I did not merge it and will not; it is a soundness change I authored.

**Also on the board, un-ledgered:** repid-engine **#249** (cloud build-loop scaffold) appeared since
Beat 50 — CI green, additive, `.github/workflows/` + docs only. It needs two secrets Sean must add
(`ANTHROPIC_API_KEY`, `LOOP_GH_PAT`) before it can run, so it is inert until he acts. Flagged, not merged.

---

## 2. The advance — the residual gap, taken from the spec end

Beat 50 closed a per-witness hole and **named** what it did not close: a stateless verifier cannot
establish global well-formedness of the committed list. That was carried as a note. This beat measures
it and buys the property explicitly.

### The gap is live, and #247 does not touch it

Two leaves, both honest-looking, no planted value-0 leaf, no tombstone trickery:

```
leaves = [ {0 → 0} sentinel — "the active set is empty" ,
           {7 → 0} LIVE, untombstoned, a real leaf of the tree ]
```

At that one root, measured [V]:

```
verifyMembership   (7n, witness@1, root) === true
verifyNonMembership(7n, {lowLeaf: witness@0}, root) === true
```

The sentinel is a *genuine* leaf at a *genuine* index 0 with a *genuine* path, so the Beat-50 path check
passes it — correctly. Nothing about this witness is forged. The lie is in a leaf the verifier was
**never shown**. This is the honest boundary of Patent #1's non-membership claim, and no single witness
of any design closes it. The same shape at depth (unlink a middle value without tombstoning it) behaves
identically.

### What was built

`auditCommitment(leaves, root, leafHash?, pair?) → { ok, violations, activeCount }` — O(n), pure, total.
A peer runs it **once per root** against the published leaf set (`LeanIMTPlus.leafSet()`, also added);
thereafter every cheap O(log n) per-witness proof against that root is sound.

- **Bound to the commitment first.** The root is re-derived from the audited leaves. A list that audits
  clean but hashes elsewhere says nothing about `root`, so `root-mismatch` is checked before anything else.
- **Coverage is the clause that closes the gap.** The `next`-chain must start at the sentinel, strictly
  increase, terminate at 0, and **reach every active leaf**. A skipped live value is an active leaf the
  chain never visits.
- Plus the invariants the per-witness verifiers must assume: one untombstoned value-0 sentinel at slot 0,
  no untombstoned value-0 leaf anywhere else (the Beat-50 oracle, refused a second way at list level),
  canonical tombstones, no duplicate active values, no cycles.
- **Total, per #240/#245's lesson:** the input is untrusted, so a malformed leaf is a `false`, never a
  throw. `undefined`, `null`, non-bigint fields, `{}` — all return a verdict. The violation list is capped
  at 32 so a hostile list cannot make the report itself the payload.

### Evidence, not assertion

- **26 new tests, all adversarial cases reproduce the attack first.** Every forgery test asserts the
  per-witness verifier **is** fooled before asserting the audit refuses it — a test that only checked
  `ok === false` would pass against a rejector that refuses everything.
- **Mutation-checked, not assumed:** with only the coverage clause removed and the tests kept, **2 of 26
  fail** — precisely the two skipped-live-value cases. The other 24 hold either way (they pin other
  clauses and the honest paths). Source restored from a byte-compared golden copy; `git diff --stat`
  confirms **115 insertions, 0 deletions**.
- **Bounded local run** per the contract (no repo-wide build): 8 memory/grounding suites, **76/76**.
  Full suite and `tsc` are CI's job.
- **Zero conflict with #247 by construction:** purely additive, and the line #247 rewrites is untouched.

### What this does NOT claim

It buys well-formedness **for a published list**. It does not make a *withheld* list auditable, and it is
not the in-circuit insertion constraint a production indexed Merkle tree uses — that remains the durable
answer and is now stated as such in the source header, with the two soundness scopes written out so a
future caller cannot conflate them. Non-membership relied on without a passing audit is still
sound-relative-to-a-well-formed-commitment, and should be stated that way.

---

## 3. T12 — twelfth beat of the hold

[V sql, unchanged] `claude-sprint` tasks: 54 done, 4 shadow_reject, **0 pending, 0 in flight, max
claim_count 0**. `trinity-symphony-shared` #34 (the claim cap) is still OPEN and CLEAN. No dispatch —
feeding a queue nothing drains is theatre.

---

## 4. Mistakes / process notes

- **I nearly built the wrong thing.** The first framing was "add a well-formedness flag to the witness" —
  which is the same mistake Beat 50 fixed, one level up: a self-reported claim cannot establish a
  property about leaves the verifier never sees. The gap is not a missing check on the witness; it is a
  different *scope*. Writing the two scopes into the header first is what made the shape obvious.
- **The gap survives a fix that looks like it should have covered it.** #247 hardened exactly the guard
  an attacker would have to beat — and this forgery never touches that guard, because it uses an
  entirely honest sentinel. Worth stating plainly: *hardening a check does not bound what the check is
  about.*
- **Weaker-property count: fifteen in fifteen beats.** This one's shape: **a property demonstrated at the
  wrong scope** — every per-witness test in the suite passes on a commitment that is not a function.

---

## 5. Open for Sean (rule-4)

1. **`trinity-symphony-shared` #34 — passed independent verification six rounds ago, still open.**
   Merging it ends twelve beats of T12 idle. Unchanged and still the highest-leverage merge available.
2. **repid-engine #250 (new, this beat)** — the whole-commitment audit. Patent #1 material: it is the
   claim boundary for provable retraction. Green, additive, no conflict with #247.
3. **repid-engine #247** — independently verified green this beat. A live non-membership forgery fix.
   Not auto-merged (I wrote it).
4. **repid-engine #249** — cloud build-loop scaffold, green and inert. Needs two GitHub secrets from Sean
   before it does anything; also the standing fix for the two-cron-instances-one-checkout problem.
5. **#243, #242, #245 remain open, green, unmerged** — all Patent #1 / grounding material. #245 gates
   `HAL_GROUNDING_MODE=enforce`.
6. **#225 + #233 — merge order still matters.** #225 alone ships the unpinned `regretAtPrice` column;
   #233 is the fix stacked on it. No intervening state where `main` carries the unpinned version.
7. **Carried unchanged:** Patent #1 RTP gap (c) — one real Base Sepolia anchor with the funded attester
   (a hard line for this loop) · #231 and #216 conflicting · branch protection requires only `test` ·
   `PROOF_ENQUEUE_HAL_MODE=enforce` · the dead `jest` key in `package.json` · `repid_gate_shadow_log`
   absent from prod.

**Next beat:** (1) independently verify **#250** — I wrote it, and the mutation battery I ran is my own.
(2) The pipeline trusted-root wiring, **starting from the schema** (which root, stored where, written by
whom) — carried from Beat 50 and still the right next build. (3) Decide whether `auditCommitment` should
gate anything in `hal-grounding` (today it gates nothing; wiring it is a behavior change and needs a
measurement packet). (4) If #34 merges, resume T12 and watch the cap's first live reaps.
