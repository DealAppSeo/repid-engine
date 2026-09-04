# CLAIM_LEDGER.md

The moat is claim discipline. A claim lives in exactly one state, and it may only
move rightward when evidence exists:

- **CLAIMED** — asserted, not yet built. No evidence. Never citeable externally.
- **BUILT** — code exists and compiles/tests pass, but not demonstrated end-to-end
  against live systems. Citeable internally as "built", never as "works in prod".
- **VERIFIED** — demonstrated against the live system with captured evidence
  (a run, a tx hash, a test artifact). Only VERIFIED claims may appear in anything
  external (marketing, patents, investor material) — and only after Sean audits.

Rules:
1. No claim reaches VERIFIED without a linked artifact (report path, tx hash, run output).
2. A failed verification demotes the claim; it does not stay VERIFIED on yesterday's evidence.
3. Live-state facts (on-chain counts, RepID values, prod health) are dated snapshots —
   re-verify before re-asserting. Generated types/docs/memory are HINTS, not evidence.
4. Every agent (CC/Grok/Gemini/T12) writes here. One row = one claim = one owner.

Last updated: 2026-09-04 by CC.

**Two rows sat in CLAIMED after they were built [MEASURED 2026-09-04].** Both were
moved to BUILT below on evidence that was already sitting in the repo — 14 passing
tests for one, 39 for the other. Nobody had re-read the ledger against the code in
four weeks.

That direction of staleness is the one this file is least protected against. Rule 2
demotes a claim when a verification FAILS, so an over-claim gets caught; nothing
walks the other way, and a row that under-states what exists just sits there. The
cost is not cosmetic: this ledger is what gates external statements, so an audit run
against it would have found two surfaces reported as vapour that ship working,
tested code — and the natural next move on reading "asserted, not built" is to build
it again. Re-read CLAIMED against the code before any audit, not only after a
failure.

---

## VERIFIED

| Claim | Evidence | Owner | Date |
|-------|----------|-------|------|
| The full 7-step trust harness runs end-to-end against live systems, no mocks | `npm run demo:harness` — footer `legs: hal=REAL repid=REAL proof=REAL nullifier=REAL anchor=REAL fold=REAL`; `reports/2026-08-07/TRUST_HARNESS_MVP_VERIFIED.md`; PR #364 | CC | 2026-08-07 |
| HAL vetoes a false claim with a *calibrated* confidence, not a raw score | Run: raw halScore 1 → calibrated P(hallucination) 0.9999, ruler `rigorous-v1@596f10de18d0, T=0.8192 bias=0.4079` | CC | 2026-08-07 |
| A confident-wrong outcome costs more than a right one earns (asymmetric delta) | Run leg 6: FAILURE_AGENT_FAULT, value 500, **δ −119.99**, RepID 2070→1950; STEP 1 commit `d18459c` enforces asymmetric deltas | CC | 2026-08-07 |
| Dual-auth gate is fail-closed: both authorities present + HAL veto ⇒ REFUSE | Run leg 7: agent=OK human=OK → **REFUSE** (blocker `hal_vetoed` listed) | CC | 2026-08-07 |
| ZK range proof is verified locally, not taken on the server's word | Run leg 3: `plonky3_range_check`, 10673 proof bytes, statement RepID ≥ 999 without revealing 2070 | CC | 2026-08-07 |
| Poseidon2 scoped nullifier is scope-separated (ZKP invariant 2) | Run leg 4: ownership → 284393528, consent → 1572901508 (same secret, different scope) | CC | 2026-08-07 |
| On-chain reputation writes are live on Base Sepolia | Run leg 5: 78 lifetime writes; IdentityRegistry `0x8004A818…BD9e`, ReputationRegistry `0x8004B663…8713`, chain 84532 | CC | 2026-08-07 |
| A full economic loop (USDC settle → on-chain reputation attestation) happened | `GET /api/v1/receipts/hero`: settlement tx `0x2a7ac1…`, attestation tx `0xd362c1…`, both on basescan | prior | ≤2026-08-06 |

> **Scenario provenance:** the rows above are from tonight's live re-run of the demo's
> **scenario A** (false, unanchored claim → HAL veto → δ −119.99 → REFUSE). The demo's
> other scenarios — **B** (true claim + valid anchor → δ +25 → ALLOW), **C** (true, no
> anchor → δ +0), **D** (malformed "pending" proof → stripped, collapses onto C) — were
> demonstrated in the prior session but **not** re-run tonight. They are BUILT +
> prior-demonstrated, re-verify-pending; do not cite B/C/D deltas as tonight-fresh.

## BUILT (not yet verified live end-to-end)

| Claim | What exists | Missing to reach VERIFIED | Owner |
|-------|-------------|---------------------------|-------|
| x402 payment-proof linking gates positive deltas | `src/services/x402-outcome-link.ts` (+tests); STEP 2 `627e571` caught a real FAIL-OPEN | A live positive-reward run where the anchor is required and present | CC |
| HAL confidence calibration fit on a frozen holdout | `src/services/hal-calibration.ts` + `scripts/hal-eval/fit-calibration.ts` (ECE) | A published ECE number on the current frozen corpus with its ruler | CC |
| Outcome classification schema with enforced asymmetric deltas | `src/services/outcome-classification.ts` (+158-line test) | (folded into VERIFIED harness run above; keep here until independent test-count asserted) | CC |
| TrustShell `presentProof` / badge path | `presentProof` + `verifyProofLocally` on the SDK client, `src/lib/badge.ts` (`renderProofBadge` / `renderProofBadgeMarkdown` / `proofBadgeStatus`), a `badge` CLI command, all exported from `src/lib/index.ts`. **14/14 `tests/badge.test.ts` pass [RUN 2026-09-04]**, and they pin the honest states, not just the happy one: verifier UNAVAILABLE → red and explicitly NOT a pass (fail-closed); no verification run → grey, "we refuse to imply unchecked trust"; the badge NEVER reveals the score in any state; the SVG is self-contained with no external references | A live run against the backend producing a real proof, verified client-side, with the badge rendered from it | CC |
| TrustMarket rating ingestion consuming fold root + dual-auth decision | `src/services/rating-ingestion.ts` consumes BOTH halves — it imports `Decision` from `./dual-auth-gate` and rejects `outcome_not_authorized` unless the gate said ALLOW, and rejects `fold_root_mismatch` when the claimed root disagrees with the server's. Fails closed by design: "an unrecorded ALLOW is not an ALLOW" (`:151`). **39/39 pass across `tests/rating-ingestion.test.ts` + `tests/participant-rating.test.ts` [RUN 2026-09-04]** | A live rating ingested end-to-end against a real settled interaction; both tables held 0 rows at last check, so the path is tested but unexercised | CC |

## CLAIMED (asserted, not built)

| Claim | Note |
|-------|------|
| TrustTrader backend consuming fold root / RepID | Surface D |
| trustchat / AISocialMirror shared auth/RepID/gate hooks | Surface E — stub clean interfaces where repos absent |
| AITrinitySymphony.com correct deploy-target mapping | Surface F — diagnose + PR steps, do NOT flip DNS |
