# PATENT EVIDENCE / ENABLING-DISCLOSURE CATALOG — HyperDAG Proof-Carrying Memory suite (v1)

**Date:** 2026-07-27 · **Author:** CC (research pass, read-only) · **Repo:** `DealAppSeo/repid-engine`
**Working tree HEAD at catalog time:** `a1b6e7f` (`chore(zkp): verify-anchor-batch (#199)`) — the branch tip `0696751` (ANFIS enablement staging) is one commit ahead and was read from git, not checked out.
**Primary sources:** `E:\dev\living-docs\03_specs\PROOF_CARRYING_RETRIEVAL_v0.md` (spec) · `DECISIONS.md` D-094 (accumulator fork) · Grok patent analysis · `reports/2026-07-27/SPRINT_DOGFOOD_VERIFY.md` (measured loop).
**Verification convention:** `[V-live]` = a test/query I ran this session · `[V-code]` = read directly from the cited file:line · `[R]` = reported by a secondary doc (PR description / runbook / dogfood report), not independently executed here.

> **READ THIS FIRST — filing posture.** Only **Patent-#1 Layer-0 (the inclusion-verify primitive, PR #198)** and the **Poseidon2-BabyBear substrate (#195/#196/#197)** are merged to the working branch AND ran green in this session (**61/61 tests passing [V-live]**). The higher layers that complete each independent claim — LeanIMT+ revocation (#203), answer-binding (#207), EAS memory-root anchoring (#208), HAL grounding (#210) — exist as code **with tests on unmerged feature branches**; I read every one `[V-code]` but did **not** execute them (branches not checked out) and they are **not integrated end-to-end or exercised on-chain**. Section 6 is the honest completeness matrix — treat it as the pre-filing punch list. Every independent claim below is **enabled by disclosed code**; several are **not yet reduced to practice as an integrated system**. Say so to the attorney.

> ### ⚠ POSTURE UPDATE — 2026-07-27, Beat 38. The paragraph above is SUPERSEDED on the merge question; read this block with it.
> The catalog was written at `a1b6e7f`, when nothing above Layer-0 had merged. **`origin/main` is now `50cd9c2`** and most of the punch list has landed. Verified this beat, each by command:
>
> - **MERGED to `main` since:** **#203** (P1 LeanIMT+ revocation/non-membership) · **#208** (P3 EAS memory-root anchor) · **#218** (Merkle hardening, below) · plus #211/#201/#212/#213/#214/#217/#204/#200.
> - **#207** (P2 answer-binding) is **green and mergeable** as of this beat — `test`/`crosscheck`/`gitleaks` all SUCCESS bound to head `d57fb2d` [V]. Its suites were **executed**, not merely read: memory + HAL suites **44/44**, full local suite **2,382 passed** with the single failing suite (`tests/hal/golden-math.test.ts`) confirmed failing **identically at the base commit**.
> - **NEW, not in the body below: #218 — Merkle domain separation + non-malleable odd-node handling.** Leaf and internal-node digests now carry distinct domain tags (RFC-6962 style, second-preimage resistance), and a lone odd node is **promoted unchanged** instead of hashed with itself — closing the `[…,x]` vs `[…,x,x]` same-root malleability (**CVE-2012-2459**). Verified this beat that `LeanIMTPlus` calls `referenceRoot`/`referenceProof`/`verifyInclusion`, so **the hardening reaches the load-bearing accumulator**, not only P0's reference tree. This materially strengthens §1.1(a)/(b): the committed root is a sound cryptographic commitment, not merely a hash chain.
> - **⚠ #210 (HAL grounding / abstention) reads MERGED on GitHub but its content was in NO branch.** It landed onto #207's feature branch rather than `main`, and that branch was force-pushed; the rebase dropped the commit (`git branch -r --contains f603947` → empty; absent from `main`). **Restored this beat onto #207.** Until #207 lands, treat #3's abstention leg as *not on main*.
> - **Corrected on the record:** P2's commit message claims `verified 11/11`. The file contains **9** tests and **1 was failing** — the revoked-citation abstain path leaked the accumulator's internal error instead of the documented `abstain:` contract. Fixed + pinned this beat (5/5 mutations killed). **The catalog's own footnote warning about the `11/11` figure was correct**; this is the confirmation.
>
> **Punch-list items (a)–(c) are now largely satisfied or in reach:** (a) merges — done except #207, which is green; (b) an integrated commit→revoke→bind→verify E2E — **still not written**; (c) a real Base-Sepolia anchor of a memory root — **still not run** (P3's chain-write remains an injected mock in tests). (d) Patent-#2 claim-scoping is unchanged and still a decision, not a build. **The two genuine gaps for reduction-to-practice remain (b) and (c).**

---

## 0. The shared substrate (all three patents build on it)

One cryptographic substrate is reused across the three claims (this is itself the "build once, reuse" thesis of `ZKP_ARCHITECTURE_INVARIANTS`, and a differentiator — the prior art does not share an identity/anchor/reputation substrate across retrieval, routing, and revocation).

| Substrate piece | File:line | Status | Evidence |
|---|---|---|---|
| **Poseidon2-BabyBear permutation** (width-16, S-box x⁷, 8 external + 13 internal rounds; constants ported verbatim from `p3-baby-bear` 0.3.0, `MDSMat4` external layer) | `src/zkp/poseidon2-babybear.ts:1-30` | **merged, live-green** | KAT-gated bit-exact vs independent Rust oracle `zkp-vault/kat/poseidon2_babybear16_kat.json`; `published_rng_vector_reproduces` proves the harness calls p3 correctly (genuine cross-language parity, not "both wrong the same way"). **9 tests pass [V-live].** PR #195/#196 |
| **Poseidon2 leaf + 2:1 compression** (`PaddingFreeSponge<16,8,8>` + `TruncatedPermutation<2,8,16>`; 8×BabyBear → 0x+64hex) | `src/zkp/poseidon2-leaf.ts:55-140` | **merged, live-green** | Bit-exact vs `poseidon2_babybear16_leaf_kat.json`. Tests pass [V-live]. PR #197 |
| **Merkle scheme is hash-agnostic** (keccak256 default; poseidon2 real-but-non-default until epoch anchor selects it) | `src/zkp/merkle-root.ts:11-21` | merged | `[V-code]` — the documented sha256→Poseidon2 migration seam |
| **Plonky3 aggregation pin** (all `p3-*` crates 0.3.0, lockstep) | `zkp-vault/Cargo.toml:8-19` | pinned | `[V-code]` Invariant-5 lockstep |
| **EAS anchoring rail** (Base Sepolia EAS `0x4200…0021`, schema `constitutional-compliance-v1`, funded `HYPERDAG_ATTESTOR_PRIVATE_KEY`; `attestProof` + `redTeamPayloadMatch` on-chain readback) | `src/services/eas-attestation-service.ts:11-108` | merged, historically live | `[V-code]`; live history: 225 EAS anchors on Base Sepolia, 20/20 sampled verified via `getAttestation` (INFRA_INVENTORY §11) `[R]` |
| **RepID scoring + HAL verdict** (the reputation/quality signals folded into leaves) | `src/engine/repid-update.ts`; HAL pipeline | live | measured in dogfood (§Patent-1 RTP) |

**Field decision (relevant to all claims):** BabyBear is held (Invariant-1); KoalaBear's degree-3 S-box is flagged by Grok as a real recursion win but a field switch is Sean-gated and A/B-deferred (spec §5). The hash/field-injection seam (`Hash2` injected everywhere) is the A/B insurance and is itself a claimable design element (hash-agnostic verifiers).

---

## PATENT #1 — Current-valid, revocable, proof-carrying agent memory

*Indexed Merkle + reputation-weighted leaves + on-chain root + answer↔proof binding.*

### 1.1 The construction (concrete technical arrangement)

**(a) Reputation-weighted leaf.** Every memory entry commits as `leafHash = hash2(content_hash, provenanceHash)` where `provenanceHash` folds `{source_id, source_repid, hal_verdict, timestamp, epoch}` — so the **source's RepID and the HAL verdict on the entry are bound into the leaf commitment itself**. The index is reputation-weighted *by construction*, not by a side table.
- `src/memory/proof-carrying-index.ts:48-58` (`provenanceHash`, `leafHash`) `[V-code]`
- `verifyInclusion` folds a leaf up a path to a root, fork-independent (works for MMR or indexed tree): `:65-71` `[V-code]`

**(b) Current-validity via indexed Merkle tree (LeanIMT+).** Leaves form a **sorted linked list** `(value, next, tombstoned)`. This gives BOTH membership and **non-membership** proofs, and **provable retraction**: `revoke(v)` relinks the predecessor to skip `v` and tombstones the leaf, so a subsequent non-membership proof for `v` succeeds — *without rewriting history*. "Current validity" = `inclusion ∧ non-membership-of-revocation`.
- `src/memory/leanimt-plus.ts` — `insert` `:88-96`, `revoke` (unlink + tombstone) `:99-110`, stateless verifiers `verifyMembership`/`verifyNonMembership`/`verifyCurrentValidity` `:135-159` `[V-code]`
- Domain-separated, tombstone-folded leaf encoding (`LEAF_TAG = 'repid.memory.leanimt+.v0'`, tombstone in the digest so a retraction changes the commitment) `:33-36` `[V-code]` — this directly answers the two Merkle-hygiene concerns the dogfood flagged against the P0 reference tree.
- Sentinel + tombstone guard: only index-0 may hold value 0; a tombstoned leaf can never serve as a low leaf `:60-66` `[V-code]`

**(c) Answer↔proof binding (the keystone).** An agent's answer is bound to the exact proof-set it cited: `binding = pair( H(answer), pair(root, citationsDigest) )`. Verification recomputes the binding AND re-checks every citation is a *current member* of the committed root. `emitGroundedAnswer` **throws (abstains) unless every cited value is a current member** — no proof ⇒ no answer; a later-revoked citation makes a previously-valid answer **provably stale**.
- `src/memory/proof-carrying-memory.ts` — `bindAnswer` `:138-146`, `verifyProofCarryingAnswer` (adversarial-input-safe: malformed witness counts as unverified, never crashes) `:150-171`, `emitGroundedAnswer` (abstain gate) `:178-196`, `retrieve` excludes revoked entries `:120-129` `[V-code]`

**(d) On-chain anchoring.** The committed root is EAS-anchored per epoch on Base Sepolia, **reusing the existing rail** (`proofType='PCR_MEMORY_ROOT'` on the live `constitutional-compliance-v1` schema — no new schema, no new on-chain infra). Anchor write injected → offline-testable; verify path reads the attestation back and matches the local root.
- `src/memory/memory-root-anchor.ts` — `buildMemoryRootAttest` `:44-54`, `anchorMemoryRoot` `:57-66`, `verifyMemoryRootAnchor` (on-chain readback) `:70-75` `[V-code]`, reusing `eas-attestation-service.ts:46-108`

### 1.2 Reduction-to-practice evidence

| Layer | PR / branch | Tests | Status |
|---|---|---|---|
| P0 inclusion-verify primitive | **#198 (merged)** | `tests/proof-carrying-index.test.ts` — **4/4 pass [V-live]** (valid proof verifies; forged leaf fails; tampered path fails; leafHash deterministic + provenance-sensitive) | **live-green** |
| P1 LeanIMT+ revocation | #203 `feat/cc-2026-07-26-leanimt-plus-p1` | `tests/leanimt-plus.test.ts` — **7 it-blocks** `[V-code]` (dogfood report says "9/9" `[R]` — likely counts sub-assertions) | code+tests present, **not executed / unmerged** |
| P2 answer-binding + retrieval | #207 `feat/cc-2026-07-27-pcr-p2-retrieval` | `tests/proof-carrying-memory.test.ts` — **9 it-blocks** `[V-code]` (report "11/11" `[R]`) | **not executed / unmerged** |
| P3 EAS memory-root anchor | #208 `feat/cc-2026-07-27-pcr-p3-eas-anchor` | `tests/memory-root-anchor.test.ts` — **8 it-blocks** `[V-code]` | **not executed / unmerged**; chain-write is injected (never fired against Base Sepolia for a memory root) |

**Measured live behavior — the RepID/HAL enforcement leg (SPRINT_DOGFOOD_VERIFY.md, DB `qnnpjhlxljtqyigedwkb`, 2026-07-27) `[R, DB-measured]`:** 8 real doc tasks, **8 distinct agents**, all terminal in ~30s, all 8 produced exactly one HAL score event. Three `−10` RepID penalties, **all legitimate**: one contentful hallucination (an agent defined x402 as a "content-addressing scheme" — flatly wrong; HAL vetoed) + two empty compliance-theater answers (caught by an independent substance gate). RepID deltas observed: `+1 / 0 / −10`. This is the *live* demonstration that grounded/quality answers earn and ungrounded ones are penalized — the enforcement mechanism the answer-binding layer formalizes cryptographically.

### 1.3 Novelty vs prior art

| Prior work (verified-real 2026-07-26) | What it does | What it LACKS that #1 has |
|---|---|---|
| **LeanIMT / LeanIMT+** (PSE zk-kit, audited in Semaphore v4) | indexed Merkle tree; membership + non-membership | generic identity anchoring — **no reputation-weighted leaves, no HAL-verdict/RepID provenance, no answer-binding** |
| **zkRAG** (ePrint 2026/709, HNSW PIOP) | ZK proof that retrieval was correct | proves computation, but over a **static** index — **no current-validity/revocation, no reputation-weighting, no on-chain-anchored root, no answer-binding** |
| **VeriRAG** (2026/637) | verifiable RAG pipeline | same gaps — no revocable reputation-weighted committed memory; no abstain-unless-proven gate |
| **V3DB** (arXiv 2603.03065, IVF-PQ multiset) | verifiable vector DB membership | static membership; **no provable retraction, no reputation, no answer↔root binding** |

**The combination that is novel:** a single EAS-anchored index that is simultaneously (i) **current-valid & revocable** (non-membership-of-revocation), (ii) **reputation-weighted** (source RepID + HAL verdict folded into each leaf commitment), and (iii) **answer-binding with a knowledge-boundary abstain gate** (an answer is cryptographically bound to the exact current-member citation set, and the agent must abstain if any citation cannot be proven a current member). No cited work binds an LLM answer to a proof-set over a revocable, reputation-weighted, on-chain-anchored memory.

### 1.4 Claim sketch

- **Independent 1A (system).** A computer-implemented agent-memory system comprising: an append-only accumulator whose leaves each commit a content hash together with a provenance record including a reputation score of the entry's source and a hallucination-assessment verdict; a revocation mechanism producing, for a retracted entry, a non-membership proof against the same committed root without rewriting prior leaves; and an answer-binding module that emits an agent answer only when every cited entry is provably a current member of the committed root, the answer being cryptographically bound to the cited proof-set.
- **Independent 1B (method).** A method of grounding an agent output comprising: committing memory entries as reputation-weighted leaves of an indexed Merkle tree; anchoring the tree root on a public ledger per epoch; upon a query, returning entries each with a current-validity proof excluding revoked entries; and refusing to emit any answer whose citations do not all verify against the anchored root (abstention on knowledge-boundary).
- **Dependent (deferred frontier):** the accumulator is a LeanIMT+ sorted-linked-list indexed Merkle tree with domain-separated tombstone-folded leaf encoding (1.1b); the leaf/pair hash is Poseidon2 over a Plonky3-native field making leaves aggregation-ready (§0); a recursive STARK aggregates many inclusion proofs into one anchored proof (P4, deferred); inclusion is proven in zero-knowledge revealing only a property of the entry (P5, deferred).

---

## PATENT #2 — Policy-gated proof-tier selection via a unified ANFIS/LASSO fabric

### 2.1 The construction

**(a) ANFIS/LASSO routing fabric.** A neuro-fuzzy (ANFIS) forward pass over prompt + provider-state features, with a **LASSO sparse feature-selection layer** for interpretability/cheapness (only top-k features drive the pick). Golden-ratio fuzzy centers/spreads reused from the comma scaffold.
- `src/services/anfis-router.ts` — `anfisRecommendProvider` `:57-121`, `lassoSelectFeatures` `:47-54`, `computeShadowDecision` `:124-135` `[V-code]`

**(b) Server-side broker with policy gate.** `POST /api/v1/llm/complete` injects the provider key **server-side** (caller never sees it; `user_paid_keys` redacted from logs), runs static-cost-ordered routing with an ANFIS shadow recommendation, and writes a routing/cost row. ANFIS reorder is **policy-gated** by `ROUTER_STRICT_COST_ORDER` (default on → ANFIS shadow-only; off → ANFIS may reorder). Scope-gated (`llm_complete`) + agent-bound (no cross-agent impersonation).
- `src/routes/route.ts` — broker `:115`, server-side key inject + `user_paid_keys` redaction `:232-233`, scope gate `:198-199`, agent-binding/no-impersonation `:207`, ANFIS decision surfaced as `router_decision` `:266`, cost-delta log to `anfis_routing_logs` with `cost_saved` + `verified_by` `:318-344` `[V-code]`
- `src/providers/router.ts:15-16` wires the ANFIS shadow into the live route `[V-code]`

**(c) Proof-tier selection axis.** A parallel policy router selects the *proof* tier (`fast_groth16` / `plonky3_stark` / `hash`) from `zkp_routing_config` by sensitivity + regulatory tag + frequency.
- `src/zkp/proof-router.ts` — `routeProofRequest` `:20-56` `[V-code]`

**(d) SCHEDULE axis.** Anchoring is deferred to low-gas windows (`isOffPeakHour`/`selectOffPeakBatch`) — a first-class cost/latency routing dimension.
- `src/memory/memory-root-anchor.ts:78-94` `[V-code]`

### 2.2 Reduction-to-practice evidence

| Piece | PR / branch | Tests | Status |
|---|---|---|---|
| ANFIS/LASSO provider fabric (shadow) | live on engine | `anfis-routing-shape.test.ts`, `anfis-poa-feed.test.ts`, `anfis-retune.test.ts` on disk | **live** (shadow-only; writes `anfis_routing_logs`) `[V-code]` |
| Broker enablement acceptance | staging commit `0696751` (branch tip; **not** flipped) | `tests/anfis-enablement.test.ts` — **5 acceptance criteria (a)-(e), 8 it-blocks** `[V-code]`: (a) no key leak, (b) server-side injection completes keyless, (c) ANFIS decision present + row logged, (d) `ROUTER_STRICT_COST_ORDER` gates reorder, (e) scope+agent-binding auth | runbook says all green `[R]`; **not executed this session** |
| Proof-tier router | merged | — | `[V-code]` rule-based, **not ANFIS-driven** (see gap) |

**Runbook (`reports/2026-07-27/ANFIS_ENABLEMENT_RUNBOOK.md`, commit `0696751`) `[V-code]`:** confirms the broker is *already implemented and deployed*; the "gap is not code — the 12 Trinity agents call providers **directly**, so zero agent traffic flows through the broker." Enablement = mint per-agent scoped keys (`scripts/anfis/mint-agent-keys.ts`) + point agents at the broker + flip `ROUTER_STRICT_COST_ORDER`. All steps staged, reversible, **un-flipped**.

### 2.3 Novelty vs prior art
Provider-routing (cost/latency/quality) via learned policies is well-trodden (LiteLLM, RouteLLM, etc.). The claimed novelty is **unifying heterogeneous decision axes — LLM-provider, cryptographic proof-tier, and anchor-schedule — under one interpretable ANFIS/LASSO fabric, with proof-tier as a first-class routing output**, and doing so behind a scope-gated, agent-bound, key-injecting broker whose recommendations are shadow-logged with a realized `cost_saved` before any policy takes effect (measure-before-enforce). No cited router treats "which zero-knowledge proof system" as a co-equal routing decision alongside "which model."

### 2.4 Claim sketch
- **Independent 2A.** A routing system comprising a neuro-fuzzy inference network with an L1-sparse feature-selection layer that, from request and system-state features, jointly selects (i) a language-model provider and (ii) a cryptographic proof tier for a verifiable artifact associated with the request, gated by a policy flag that admits the neuro-fuzzy recommendation only after a shadow phase records a realized cost delta.
- **Dependent:** the broker injects provider credentials server-side and rejects requests whose scoped token is not bound to the target agent (2.1b); a third axis defers on-chain anchoring to a low-gas schedule window (2.1d).
- **⚠ Reduction-to-practice caveat (see §6):** the *unification* of provider-routing and proof-tier-routing into one fabric is **architecturally present but not yet integrated** — today they are two separate modules (ANFIS `anfis-router.ts` vs rule-based `proof-router.ts`). File 2A's "jointly selects … under one fabric" only after wiring proof-tier through ANFIS, or narrow the claim to the provider-routing fabric + a policy-gated proof-tier selector.

---

## PATENT #3 — Hybrid verifiable-GraphRAG over current-valid memory + knowledge-boundary abstention + hierarchical durable harness

### 3.1 The construction

**(a) Knowledge-boundary abstention, wired to HAL.** The abstain primitive from #1 is wired into the live HAL grader in **shadow-first** mode: if an answer carries a proof-carrying binding, HAL verifies it; an answer that *claimed* grounding but cannot prove every citation is "ungrounded" and *should* abstain. `HAL_GROUNDING_MODE` = `shadow` (default, log-only, zero verdict effect) / `enforce` (Sean-GO, neutralizes a positive delta for a claimed-but-unprovable answer) / `off`.
- `src/hal/hal-grounding.ts` — `groundingMode` `:33-38`, `computeGroundingSignal` (never throws; `applicable`/`grounded`/`would_abstain`) `:60-82` `[V-code]`; wires `proof-carrying-memory.verifyProofCarryingAnswer`

**(b) Reputation-weighted shared knowledge commons → GraphRAG.** Because each leaf carries `source_repid` + `hal_verdict`, a federated index becomes a reputation-weighted verified-memory commons; GraphRAG over that committed graph is "the ecosystem's collective verified memory" (spec §5, §10). **Design-stage** — the retrieval API (P2) returns proof-carrying entries, but no graph/vector index is built.

**(c) Hierarchical durable harness.** The phased P0→P5 stack (verify → accumulator → retrieval API → EAS anchor → Plonky3 verifiable-retrieval → ZK property proofs) is the durable, hierarchical verification harness; durability = per-epoch on-chain anchoring (#1d). Apex verifiable-retrieval (prove top-k / subgraph-walk correctness) is P4, ANFIS-gated, deferred.

### 3.2 Reduction-to-practice evidence

| Piece | PR / branch | Tests | Status |
|---|---|---|---|
| HAL grounding / abstention hook | #210 `feat/cc-2026-07-27-hal-grounding-shadow` | `tests/hal-grounding.test.ts` — **6 it-blocks** `[V-code]` | **shadow, never fired live** (`applicable:false` — no live traffic carries a proof-carrying answer yet); **not executed / unmerged** |
| Proof-carrying retrieval API | #207 (P2) | shares `proof-carrying-memory.test.ts` | as §1.2 |
| Verifiable-GraphRAG (P4) | — | — | **not built** — design only |

**Live abstention behavior proxy `[R, DB-measured]`:** the dogfood's two empty compliance-theater answers were caught by an independent substance gate and HAL penalized the hallucination — the *behavioral* knowledge-boundary already discriminates grounded from ungrounded output; the *cryptographic* abstention (`emitGroundedAnswer` throwing) is coded + unit-tested but has **not** processed live traffic.

### 3.3 Novelty vs prior art
zkRAG / VeriRAG / V3DB make *retrieval* verifiable; **WHIR** (ePrint 2024/1586, + whir-p3) is a near-term hash-based PCS/aggregation building block (Invariant-5 aggregation tier) — none couple verifiable retrieval to a **knowledge-boundary abstention gate driven by a hallucination-assessment layer** over a **revocable, reputation-weighted** memory, and none frame it as a **hierarchical durable harness** whose freshness is guaranteed by per-epoch on-chain root anchoring. The novelty is the *coupling*: verifiable-GraphRAG over current-valid memory **plus** structural abstention when the boundary is crossed.

### 3.4 Claim sketch
- **Independent 3A.** A retrieval-augmented generation method over a committed, revocable, reputation-weighted memory index, comprising: retrieving graph-linked entries each with a current-validity proof; grading a candidate answer with a hallucination-assessment layer that verifies the answer's proof-carrying binding; and abstaining when any cited entry cannot be proven a current member of the anchored root.
- **Dependent (deferred frontier):** a recursive STARK proves top-k or subgraph-walk correctness over the committed graph (P4); the abstention gate operates in a shadow mode that records would-abstain signals before enforcement (3.1a); anchoring cadence is scheduled by the routing fabric of Patent #2.
- **⚠ Reduction-to-practice caveat:** the GraphRAG-over-committed-memory element (3.1b) and verifiable-retrieval (P4) are **not built**; only the abstention primitive (3.1a) is coded (unmerged, shadow, never fired). This is the weakest-enabled of the three — file the abstention/knowledge-boundary claims on the disclosed code, and keep the verifiable-GraphRAG claims as forward-looking dependents supported by the spec's enablement, not by a working build.

---

## 6. Reduction-to-practice completeness matrix (the pre-filing punch list)

> **Column 4 and 5 are as-of `a1b6e7f`. See the Beat-38 posture block at the top for the current state — most of column 5 has since flipped to ✅. Re-verified rows are marked → in column 5.**

| Claim element | Enabling code exists | Tests written | Ran green THIS session | Merged to working branch | Integrated E2E | On-chain demonstrated |
|---|---|---|---|---|---|---|
| #1 inclusion-verify primitive (P0) | ✅ `[V-code]` | ✅ 4 | ✅ **[V-live]** | ✅ #198 | n/a | n/a |
| #1 reputation-weighted leaf | ✅ | ✅ | ✅ (in P0) | ✅ | — | — |
| **#1 Merkle domain separation + non-malleable odd node (CVE-2012-2459)** | ✅ | ✅ | ✅ **[V-live] Beat 38** | ✅ **#218 → `main`** | — | — |
| #1 LeanIMT+ revocation / non-membership (P1) | ✅ `[V-code]` | ✅ 7 | ✅ **[V-live] Beat 38** | ✅ **#203 → `main`** | ❌ | n/a |
| #1 answer-binding + abstain (P2) | ✅ `[V-code]` | ✅ 9 **(not 11; 1 was failing — fixed Beat 38, now 11)** | ✅ **[V-live] Beat 38** | → **#207 green, not yet on `main`** | ❌ | n/a |
| #1 EAS memory-root anchor (P3) | ✅ `[V-code]` | ✅ 8 | ✅ **[V-live] Beat 38** | ✅ **#208 → `main`** | ❌ | ❌ (chain-write injected; never run for a memory root) |
| #1 `agent_memory_*` prod tables | ❌ (additive migration not applied) | — | — | — | — | — |
| Poseidon2-BabyBear substrate | ✅ | ✅ | ✅ **[V-live] 61/61** | ✅ #195/#196/#197 | — | — |
| #2 ANFIS/LASSO provider fabric | ✅ | ✅ | ❌ (live in shadow, not run here) | ✅ | partial | — |
| #2 broker enablement (agents→broker) | ✅ | ✅ 5 crit | ❌ | ⏸ staged `0696751`, **un-flipped** | ❌ (agents still call providers direct) | — |
| #2 **unified** proof-tier ⊕ provider fabric | ⚠ two separate modules | — | — | — | ❌ **not unified** | — |
| #3 HAL knowledge-boundary abstention | ✅ `[V-code]` | ✅ 6 | ✅ **[V-live] Beat 38** | ⚠ **#210 reads MERGED but its content was in no branch — restored onto #207 (Beat 38)** | ❌ (shadow, `applicable:false`, never fired live) | — |
| #3 verifiable-GraphRAG (P4) | ❌ design only | — | — | — | — | — |

**Bottom line for the attorney:**
1. **All three independent claims are *enabled*** by disclosed source (I read every cited file). Enablement/written-description is defensible from the code + spec.
2. **Reduction to practice is PARTIAL and uneven.** Solidly reduced to practice + independently re-run this session: the Poseidon2 substrate and the #1 inclusion-verify primitive (61/61 green). Coded-with-tests-but-unmerged-and-unrun: #1 revocation/answer-binding/anchor, #3 abstention. **Not built:** verifiable-GraphRAG (#3 P4), the ANFIS-driven *unified* proof-tier fabric (#2).
3. **No integrated end-to-end run exists** of "commit → revoke → retrieve-with-proof → bind-answer → anchor-root-on-chain → HAL-verify." Each stage is unit-proven in isolation; the chain has never executed as one flow, and no memory root has been anchored on Base Sepolia (the P3 chain-write is an injected mock in tests).
4. **Strongest measured behavioral evidence** is the RepID/HAL enforcement loop (dogfood: legitimate penalties for hallucinated + empty answers) — this substantiates the *enforcement* rationale behind #1's answer-binding and #3's abstention, even though the cryptographic gates have not processed live traffic.

**Recommended finish-before-filing (or file provisional now + reduce to practice under the priority window):** (a) merge #203→#207→#210 and run their suites; (b) one integrated E2E test covering commit→revoke→bind→verify; (c) one real Base-Sepolia anchor of a memory root via #208 with `getAttestation` readback; (d) either wire proof-tier through ANFIS or narrow Patent-#2's "unified fabric" language. Items (a)-(c) are low-effort (code + tests already exist); (d) is a claim-scoping decision.

---
*Read-only research pass. No code changed, no secrets printed. Test counts are it/test-block counts by direct grep `[V-code]`; the "61/61" figure is a live `npx jest` run this session `[V-live]`. Secondary "9/9"/"11/11" figures are from the dogfood report `[R]` and count differently. Verify each unmerged suite by running it before relying on its pass count in a filing.*
