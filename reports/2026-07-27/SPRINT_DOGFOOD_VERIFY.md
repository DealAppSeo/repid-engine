# SPRINT DOGFOOD + VERIFY — 2026-07-27

Read/test-only overnight dogfood of the HyperDAG task→claim→HAL→RepID loop, marketplace, pipeline health, and proof-carrying-retrieval code. No code changes, no flag flips, no self-validation. Supabase `qnnpjhlxljtqyigedwkb`. DB clock at snapshot: `2026-07-27 08:46:48Z`.

---

## 1. The 8 `[SPRINT-DOGFOOD]` tasks (ids 435005–435012) — LOOP WORKS END-TO-END [V]

Created `08:45:12Z`, all **8 claimed by 8 DISTINCT agents within ~4–34s**, all reached a **terminal state within ~30s**, and **all 8 produced exactly one `HAL_SCORE_EVENT`** in `repid_score_events`. The task→claim→HAL→RepID dogfoot fired for every task. No `-RepID` from the wrong-cause-effect bug (see below).

| id | term | claimed_by | HAL | hal_score | Δ RepID | outcome |
|----|------|-----------|-----|-----------|---------|---------|
| 435005 ANFIS | done | trinity-chesed | clean | 0.125 | 0 | pass |
| 435006 LASSO | done | trinity-torch | clean | 0.375 | **+1** | pass |
| 435007 ERC-8004 | done | trinity-veritas | clean | 0.181 | 0 | pass |
| 435008 x402 | done | trinity-sophia | **vetoed** | 0.585 | **−10** | legit veto |
| 435009 Poseidon2 | **shadow_reject** | trinity-gcm | **vetoed** | 0.500 | **−10** | legit (empty) |
| 435010 Plonky3 | **shadow_reject** | trinity-w3c | **vetoed** | 0.500 | **−10** | legit (empty) |
| 435011 ZKP nullifier | done | trinity-hdm | clean | 0.256 | 0 | pass |
| 435012 GraphRAG | done | trinity-orch | clean | 0.138 | 0 | pass |

### The 3 `−10` vetoes are ALL LEGITIMATE — NOT the wrong-cause-effect bug [V]

These are `is_real=true` documentation tasks with genuinely bad outputs. I read the `answer_text`:

- **x402 (sophia, −10, hallucination_caught=true):** the answer confidently defines x402 as *"a cryptographic content-addressing scheme … content hash with a proof-of-work nonce."* That is **flatly wrong** — x402 is the HTTP-402 stablecoin micropayment protocol (EIP-3009). This is a real, contentful hallucination. **HAL caught it correctly.**
- **Poseidon2 (gcm, −10) & Plonky3 (w3c, −10):** the answers are pure compliance theater — *"Task complete. The definition has been saved…"* / *"Done. The definition is precise, factual…"* with **no actual definition**. HAL vetoed them; the penalty direction is correct.

So HAL is correctly penalizing bad output on real work. This is the *opposite* of the wrong-cause-effect bug (which vetoes internal cron/drills). Minor label nit: the two empty answers carry `hallucination_caught=true` when the real failure is emptiness, not hallucination (`veto_class` is NULL) — cosmetic, penalty is right.

### Two independent quality gates each fired on a different failure mode [V] — good result

- **substance_gate (shadow):** flagged 435009/435010 as `output_too_short` (167/200 and 87/200 chars) → task status `shadow_reject`. The two empty non-answers were caught here.
- **HAL:** caught the contentful hallucination (x402), which *passed* the length gate (full-length answer → status `done`) but lost `−10` RepID.

Note x402 shows task status `done` despite the `−10` veto — a hallucinated answer still marks the task complete; RepID loss is the sole enforcement lever. Worth deciding whether `done` should reflect the veto, but not a bug.

---

## 2. Demo-trio marketplace — provisioned, buyer≠provider + independent verifier satisfiable [V]

All rows `active=true`; `total_fulfilled=0 / total_satisfied=0` across the board (nothing exercised yet).

- **verification** — ~13 active rows across many distinct providers (gcm, chesed, mel, apm, orch, nexus, hdm, sophia, w3c, torch, veritas, shofet ×2). Multiple distinct providers ⇒ buyer≠provider trivially satisfiable + an independent third-party peer-verifier is available. ✓
- **security_audit** — **3 active providers already seeded**: trinity-shofet (RepID 2027), trinity-apm (1260), trinity-gcm (1025). ✓ buyer≠provider + independent verifier possible. (Fulfillment path lands with **PR #205** — the deterministic auditor handler; the `agent_services` rows are already present, so #205's "seed a row" next-step is effectively done.)
- **reputation_audit** — 2 active rows, **BOTH provider = trinity-veritas** (RepID 1528). Single-sourced supply. buyer≠provider still holds (any of the other ~15 agents can buy) and an independent verifier is available, but there is **only one provider agent** for this service type. Not a blocker; flag for supply diversity if reputation_audit ever needs provider redundancy or to avoid a single-agent monopoly on that service.

---

## 3. Pipeline health [V]

- `repid_score_events` **last 1h = 10** (8 from this dogfood batch + 2 others) — engine is actively writing scores.
- `peer_verification_queue` **new rows last 1h = 0** (total 140,187). Expected for THIS batch: the 8 tasks had `needs_peer=false` / `verification_required=NULL`, so they don't enqueue peer-verify. The no-self-validation loop was not exercised by this batch — not evidence of breakage. (Consistent with L2 breaker 2.3 #188's structural ban on peer-verify recursion.)
- `erc8004_reputation_writes` **max(created_at) = 2026-07-23 04:36:23Z**, total 72. **Dormant ~4 days.** Matches STATE (last real x402 settlement→ERC-8004 write was 07-22/23). No new on-chain writes because no real x402 settlement occurred in the dogfood; expected, but the on-chain leg is idle.

---

## 4. Proof-carrying-retrieval code review [V]

**`src/memory/proof-carrying-index.ts` (P0, on main via #198)** — clean and correct. `foldHash` (left-assoc), `provenanceHash` (folds source_id/repid/hal_verdict/timestamp/epoch), `leafHash = hash2(content_hash, provenanceHash)`, `verifyInclusion` (fold up path), and the reference binary-Merkle `referenceRoot`/`referenceProof` are logically sound. `hash2` is injected (sha256 mock in tests → Poseidon2 leaf with zero changes), and the odd-node-duplication case is handled **consistently** between `referenceRoot` (r = level[i] when no right sibling) and `referenceProof` (sibIdx = idx, siblingOnLeft=false → hash2(acc,acc)). Provenance is bound into every leaf, so the index is reputation-weighted by construction — the intended primitive.

**Two correctness/security concerns — both are P1 production requirements, NOT P0-scope bugs** (P0 is explicitly "tests/demo + fork-independent verify"):
1. **No domain separation between leaf and internal-node hashing.** The same `hash2` commits both leaves (`leafHash`) and internal Merkle nodes (`referenceRoot`). Without a leaf/node domain tag, an internal node value can be re-presented as a leaf — the classic Merkle second-preimage weakness. The production accumulator (P1) must domain-separate.
2. **Duplicated-odd-node reference tree is malleable** (CVE-2012-2459 / Bitcoin-style): duplicating the last node lets trees of different leaf counts collide. The file itself flags the production accumulator as P1 (indexed Merkle vs MMR-with-tombstones), so this is acceptable for demo but must not reach production.

Neither weakens the fork-independent `verifyInclusion` for its stated P0 use; both should be explicit acceptance criteria for the P1 accumulator.

**What the open PRs add (from PR descriptions, not yet on main):**
- **P1 #203** — `feat/cc-2026-07-26-leanimt-plus-p1`. LeanIMT+ indexed Merkle tree with sorted linked leaves: adds **membership + non-membership + provable retraction** (tombstone guard, stateless verifiers), Poseidon2-backed, 9/9 verified. This is the production accumulator that would address the concerns above. Stacked on P0 #198 — do not land before #198.
- **P2 #207** — `feat/cc-2026-07-27-pcr-p2-retrieval`. The retrieval API + **answer-binding**: retrieval returns entries *with* inclusion proofs (revoked excluded); `emitGroundedAnswer` **abstains unless every citation verifies** (HAL knowledge-boundary); adversarial-input-safe; 11/11 verified. Stacked on #203. Additive + inert.
- **P3 #208** — `feat/cc-2026-07-27-pcr-p3-eas-anchor`. **EAS-anchors the committed memory root** on Base Sepolia, reusing the existing EAS rail (`proofType=PCR_MEMORY_ROOT`, no new schema). Chain write/verify injected → offline-unit-testable (7/7); off-peak batching = ANFIS SCHEDULE axis. **Independent of the P2 stack** (takes a root string) → mergeable on its own.
- **HAL-grounding #210** — `feat/cc-2026-07-27-hal-grounding-shadow`. Wires the P2 abstain/knowledge-boundary primitive into the live HAL grader (`scoring/pipeline.ts`), gated by `HAL_GROUNDING_MODE`: **shadow (DEFAULT, log-only, zero verdict effect)** / enforce (Sean-GO, measurement-gated — neutralizes a positive delta for a claimed-but-unprovable answer) / off. Byte-identical today (`applicable:false` — no traffic carries a proof-carrying answer yet). Mirrors REPID_PURPOSE_GATE_V3 shadow discipline. Stacked on P2.

**Stacking order to land:** #198 (P0, merged) → #203 (P1) → #207 (P2) → #210 (HAL-grounding). #208 (P3 anchor) is independent and can land alone. All open ones are additive + inert / shadow-default.

---

## Summary

- **Loop [V]:** task→claim→HAL→RepID works end-to-end. 8/8 claimed by distinct agents, terminal in ~30s, 8/8 produced HAL score events.
- **Vetoes [V]:** 3× `−10` — all legitimate (1 real hallucination + 2 empty compliance-theater), none from the wrong-cause-effect bug. Two independent gates (substance shadow-gate + HAL) each caught a distinct failure mode. Encouraging.
- **Marketplace [V]:** all three service types active with buyer≠provider + independent-verifier structurally possible. security_audit rows already seeded (3 providers) ahead of #205's fulfillment handler; reputation_audit is single-sourced (only trinity-veritas) — supply-diversity flag, not a blocker.
- **Pipeline [V]:** score-events flowing (10/1h); peer-verify queue idle for this batch (tasks didn't request peer-verify — expected); ERC-8004 on-chain writes dormant ~4 days (no real settlement in dogfood).
- **Proof-carrying code [V]:** P0 sound; flagged two Merkle hygiene items (leaf/node domain separation + duplicated-odd-node malleability) as **P1 acceptance criteria** — P1 #203 (LeanIMT+) is the intended fix. P2/P3/HAL-grounding chain is additive + shadow-default.
