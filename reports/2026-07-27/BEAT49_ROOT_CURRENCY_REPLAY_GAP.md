# Beat 49 — the revocation→abstain property was demonstrated in four places and enforced in zero

**Date:** 2026-07-28 (UTC) · **Author:** autonomous build-loop (Claude) · **Status:** finding [V], fix on branch `feat/cc-2026-07-28-grounding-root-currency`, **awaiting independent verification (rule 3 — I wrote it)**
**Patent bearing:** Patent #1 — "current-valid, revocable, proof-carrying memory". This is about the *current-valid* clause specifically.

---

## 1. The finding

`computeGroundingSignal` — the only production integration of proof-carrying retrieval
(`src/scoring/pipeline.ts:413`) — **cannot detect a revocation.** An agent that replays its
pre-revocation answer verbatim is reported `grounded: true, would_abstain: false`.

This was not visible from the tests because **every existing demonstration of the abstain property
performs a substitution that production does not**:

| Demonstration | line | what it verifies |
|---|---|---|
| `scripts/demo/proof-carrying-e2e.ts` (the convergence artifact) | `:88`, `:89` | `{ ...pca, memory_root: pcm.root() }` |
| `scripts/hal/medical-grounding-eval.ts` (the F1 = 1.000 eval, #236) | `:76`–`:78` | `staleAtCurrentRoot = { ...pca, memory_root: pcm.root() }` |
| `tests/proof-carrying-e2e.test.ts` (#220, RTP gap (b)) | `:32`, `:33` | `staleAtNewRoot` |
| production — `src/scoring/pipeline.ts` | `:413` | `{ proof_carrying_answer: input.proof_carrying_answer ?? null }` — **no root** |

The first three hand-build the stale answer. The fourth, the only one that runs against real traffic,
passes the answer straight through. `GroundingInput` had no field for a trusted root, so HAL was
**structurally incapable** of the check its own header comment claimed.

### Why the substitution is the wrong instrument

`{ ...pca, memory_root: newRoot }` is an object no agent and no adversary produces. It asserts a root
it holds no witness for, so it fails on the *crypto* — binding mismatch and citation failure. It is a
forgery, and forgery is a different threat from replay.

The real adversary is lazier: it re-sends the **original answer, unchanged**. Root and witness still
agree with each other, because they did when it was minted. The pure verifier is satisfied — and it is
*correct* to be. A membership proof is only ever evidence about the root it was built against.

**Current validity is therefore not a property of the crypto at all.** It is established only when the
verifier compares the asserted root against a root it independently trusts. Nothing did that.

### Evidence [V] — measured, not read

Probe against `origin/main` @ `2afa45a` (commit a fact → emit a grounded answer → revoke it → verify
the untouched answer exactly as the pipeline does):

```
root moved: true
--- A) PRODUCTION PATH: verify the answer exactly as the agent emitted it (no substitution) ---
  pca.memory_root === R1 (stale): true
  grounded       = true   verified= 1/1
  would_abstain  = false  reason= grounded
--- B) HARNESS PATH: demo/eval substitute the CURRENT root before verifying ---
  grounded       = false
  would_abstain  = true

VERDICT: revocation invisible on the production path = true
```

The fact was revoked. The root moved. HAL said `grounded`.

---

## 2. The fix

Currency is a **caller obligation at the integration boundary**, not something the verifier can supply.
`verifyProofCarryingAnswer` stays a pure function over the root the answer asserts — that is the right
shape for a verifier, and it is left untouched (which also keeps this change clear of the file two
concurrent verifications are mutating for #240).

`src/hal/hal-grounding.ts`:

- `GroundingInput.current_memory_root?: string | null` — the root **this verifier** independently
  believes is current. Never read out of the answer.
- `GroundingSignal.root_current: boolean | null` — `true` checked-and-equal · `false`
  checked-and-superseded · **`null` not checked**.
- Supplied and different → `grounded: false`, `would_abstain: true`, `reason: 'ungrounded:stale_root'`,
  short-circuited **before** the crypto.
- Not supplied → behaviour is unchanged, but `reason` degrades from `'grounded'` to
  `'grounded_at_asserted_root'` and `root_current` is `null`. The signal reports the strongest *true*
  statement rather than the one it was making.

**Currency is checked before crypto, and root equality is the check — not re-verification.** Re-running
an old witness against the current root fails on *any* memory movement, conflating "this fact was
retracted" with "some unrelated fact was added". Root equality says the honest thing: this answer
describes a superseded memory state, so currency cannot be established, so abstain. The agent's remedy
is to re-derive against the live root — where a still-valid fact succeeds and a revoked one yields no
witness at all (`emitGroundedAnswer` throws `abstain:`). Both halves of that remedy are pinned.

### Default-safe

Purely additive. With `current_memory_root` omitted — which is every current caller — the verdict
(`grounded` / `would_abstain`) is byte-identical to before. No Sean-gated flag is touched;
`HAL_GROUNDING_MODE` stays `shadow`. Nothing in `src/` branches on the `reason` string (checked).

---

## 3. Verification performed by the author (NOT a substitute for rule-3 review)

- **Defect reproduced, not asserted.** With only the source change reverted to `origin/main`,
  **8 of the 10 new tests fail.** The 2 that pass pin the *premise* — that the replay is internally
  consistent and that re-deriving after a revocation throws — and correctly hold either way.
- **Full suite: 2515 tests / 238 suites — 2484 passed, 12 failed, 18 skipped, 1 todo.**
- **The 12 failures are pre-existing [V].** Confirmed by stashing the change and re-running those three
  suites on clean `origin/main` @ `2afa45a`: **identical 12 failed / 2 passed / 14 total**. They are
  `tests/hal-accuracy-summary.test.ts`, `tests/trinity-swarm-health.test.ts`, `tests/hal/golden-math.test.ts`
  — live-provider/live-ops suites; none import `hal-grounding`.
- `npx tsc --noEmit` → **exit 0**.
- The convergence artifact `scripts/demo/proof-carrying-e2e.ts` still exits 0, now demonstrating the
  code's property instead of the harness's: it prints that the replay **is** still valid at its own
  superseded root (`grounded=true` — the attack is real and not self-defeating) and that HAL, holding
  the current root, catches it (`root_current=false`, `ungrounded:stale_root`). The PASS condition now
  requires **both**, so the demo can no longer pass by the attack being toothless.

**Not verified by me and deliberately not claimed:** whether the new tests survive an adversarial
mutation battery. I wrote them; that is a different agent's job.

---

## 4. What this does NOT fix — carried, deliberately

1. **The pipeline still passes no root.** `src/scoring/pipeline.ts:413` gains the *capability* to check
   currency but does not yet exercise it, because the scoring pipeline has no independent view of an
   agent's current memory root. Wiring one is a real integration question (whose root? the last EAS-
   anchored one? the last committed one?) and deserves its own beat. Until then production sits on the
   honest `root_current: null` path — the difference from before is that it now *says so*.
2. **`scripts/hal/medical-grounding-eval.ts` (#236) still hand-substitutes.** Its
   **F1 = 1.000 measures a substitution production does not perform**, and it is a patent-adjacent
   document. The numbers are not wrong about what they measured; the report should state which
   scenario was measured. Flagged for Sean in the ledger — I did not quietly rewrite a published
   measurement.
3. **`tests/proof-carrying-e2e.test.ts` (#220) is not wrong, but pins less than it reads as pinning** —
   it pins that a *forged* root is rejected, not that a *replay* is. Left alone under CLAUDE-RULE-3.

---

## 5. The shape, for the record

This is the loop's recurring failure mode at a new altitude. Twelve prior beats found *a constant
pinned as a number rather than as a behaviour*. This one is: **a property demonstrated by the harness
rather than held by the code** — and it survived a purpose-built E2E test, a curated 10-case eval that
scored F1 = 1.000, and a demo written specifically to show it off. All three were honest. All three
substituted. A perfect score is a claim about the cases you wrote; a passing demo is a claim about the
script you wrote. Neither is a claim about what production does.
