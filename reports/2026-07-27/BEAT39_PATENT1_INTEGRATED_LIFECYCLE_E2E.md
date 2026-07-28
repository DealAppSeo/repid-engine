# Beat 39 — Patent #1 integrated lifecycle E2E (reduction-to-practice gap (b) closed)

**Date:** 2026-07-27 · **Branch:** `feat/cc-2026-07-27-patent1-e2e` · **Base:** `origin/main` @ `ddc43f8`
**Backlog:** `PATENT_ALIGNED_BUILD_BACKLOG.md` items 3/4/10 (P2 retrieval, answer-binding, P3 anchoring) — the *composition* of them.
**Catalog:** closes reduction-to-practice gap **(b)** in `PATENT_EVIDENCE_CATALOG_v1.md`. Gap **(c)** — one real Base-Sepolia anchor of a memory root — is untouched and still open.

## Why this exists

Every layer of Patent #1 already had its own passing suite: P0 leaf (`proof-carrying-index`), P1 accumulator (`leanimt-plus`), P2 retrieval + answer-binding (`proof-carrying-memory`), P3 EAS anchoring (`memory-root-anchor`), and the HAL abstain signal (`hal-grounding`). **Nothing walked the claim as a whole across those module boundaries.** A patent is granted on the combination; the parts passing separately is not evidence that the composed system behaves as claimed.

Three joints were only ever exercised against synthetic stand-ins, and each is a place the composition could have been wrong while every unit suite stayed green:

| Joint | What was tested before | What was assumed |
|---|---|---|
| P2 → P3 | anchoring a hand-written root string | that the anchored root **is** the root the answer was bound to |
| P2 → HAL | grounding signal from a hand-**tampered** answer | that it fires for a **genuine revocation** |
| P1 → P2 | retraction as "membership stops verifying" | that **absence itself verifies** (`nonMembershipWitness` was exported and called by no P2-level test) |

The third is the sharpest. *Absence of proof* and *proof of absence* are different claims, and only the second one is the patent's.

## What the test asserts

`tests/patent1-lifecycle-e2e.test.ts` — one run, real Poseidon2-BabyBear via module defaults (no injected hash fakes), so a pass is evidence about the shipped cryptography.

1. **COMMIT** three reputation-weighted entries → root `R1`.
2. **ANCHOR `R1`** (P3, chain write recorded not performed) — asserts the attestation's `merkleRoot` **is** `mem.root()` and `proofType = PCR_MEMORY_ROOT`.
3. **RETRIEVE** — each hit's witness verifies against `R1`.
4. **BIND** an answer to its cited proof set.
5. **VERIFY** independently *and* through `computeGroundingSignal(…, 'enforce')` → grounded, `would_abstain: false`.
6. **REVOKE** the cited entry → `R2 ≠ R1`, entry no longer retrievable.
7. **PROVABLE STALENESS** — the answer's bytes are frozen and asserted unchanged; it **still verifies against its own `R1`** and **fails against `R2`**. Staleness is a property of the world, not evidence of tampering, and the two are told apart.
   **7b. Re-binding cannot launder a retracted citation** — a forger who re-binds to `R2` gets `binding_ok: true` and `grounded: false`. Binding integrity and current-validity are independent gates; both must hold.
8. **PROOF OF ABSENCE** — `verifyNonMembership(revoked, witness, R2) === true`, and it is *specific*: the same witness does **not** "prove" absence of a still-present entry.
9. **ABSTAIN** — re-emitting throws `abstain:`; the HAL signal reports `would_abstain: true`, `verified_citations: 0`.
10. **RE-ANCHOR `R2`** — the retraction is itself publicly timestamped, distinct root, distinct epoch.
11. **Revocation is surgical** — the untouched entry still grounds an answer at `R2`.

Plus: an answer citing one live **and** one retracted entry abstains **entirely** (no partial grounding), and an anchored root cannot silently absorb later appends.

## Verification

- **[V] `tsc --noEmit` clean.**
- **[V] 7 suites / 47 tests pass**, taken from jest's own total line rather than by summing the suites I watched (Beat 36's FINDING 2): the new E2E plus all six pre-existing Patent-#1 suites, run together.
- **[V] Mutation-tested against the absence of each property.** 7 mutations of the source (never the test), harness held originals **in memory** and restored in a `finally` (Beat 38's lesson: restoring from git wipes uncommitted work). Baseline PASS → post-restore PASS → **zero residue** (`git status` clean but for the new file, checked not assumed).

| Mutation | Result |
|---|---|
| `revoke()` is a no-op | **KILLED** |
| `grounded` ignores citation verification (binding-only) | **KILLED** |
| anchor carries a different root than memory committed | **KILLED** |
| `verifyNonMembership` always returns true | **KILLED** |
| HAL signal always reports grounded | **KILLED** |
| appending does not move the root | **KILLED** |
| `emitGroundedAnswer` skips the revoked-path throw | **SURVIVED — bad mutation, settled empirically** |

**The survivor was probed, not argued about.** Under it the system *still* abstains — captured message: `abstain: answer not grounded (citation_unverified:527230424691…)` — because `emitGroundedAnswer` has a second, independent gate (the final `verifyProofCarryingAnswer` check). The behavioural property this E2E asserts genuinely still holds, so the mutation does not remove the property; it removes one of two mechanisms enforcing it. The *message contract* for that specific path is pinned one layer down, and **`tests/proof-carrying-memory.test.ts` FAILS under the same mutation** — Beat 38's regression pin doing exactly its job. Coverage exists at the right layer: the unit suite pins the message, the E2E pins the composed behaviour.

**One mutation first reported NOT-LANDED and was re-run, not counted.** The literal used `\n` against CRLF files — the identical trap Beats 36 and 37 hit. The harness discarded it rather than scoring a free pass; CRLF-normalized it **KILLED**.

## Honest limits

- **The chain write is recorded, not performed.** The real `attestProof` needs the funded attester key, which is a hard line for this loop to handle. **Gap (c) — one live Base-Sepolia anchor of a memory root — remains open and is now the only untested joint in the claim.** This test proves the *right bytes are handed to* the chain layer; it does not prove the transaction lands.
- **No live DB.** The whole chain is in-process by design (memory is in-process); no `agent_memory_leaves`/`agent_memory_roots` persistence is exercised — backlog item 5 is still unbuilt.
- The E2E asserts composed behaviour, so it is deliberately coarser than the unit suites on message contracts. That is the intended split, recorded here so a future beat does not read it as a gap.
