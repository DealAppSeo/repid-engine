# Beat 8 — Proof-Drain / ZKP-Anchoring Diagnostic (Task 1.2)
**Date:** 2026-07-25/26 · **Mode:** read-only SQL vs `qnnpjhlxljtqyigedwkb` · **Rule:** verify-before-assert; all findings `[V]` = live-queried this beat.

## TL;DR
The stale-doc claim *"proof-drain worker down since June 7, causing proofs to stay un-anchored to EAS"* is **imprecise on both the date and the mechanism**. Corrected:
- **EAS anchoring is NOT the bottleneck.** Every real proof is already anchored.
- **The real, verified degradation is one stage upstream:** the proof-**generation** consumer that drains `repid_proof_queue` (pending → real Plonky3 proof → row in `repid_zkp_proofs`) has been **absent since ~2026-06-16**. **40,541 jobs are `pending` with `attempts=0`** (never picked up).
- **But 99.3% of that backlog is `HAL_SCORE_EVENT` internal churn** — only **~258 jobs are genuine economic events**. A blanket restart-and-drain would generate + anchor 40k proofs of mostly non-economic churn (gas cost, attesting to internal scoring). The right action is a **filtered drain of the ~258 real events**, not a 40k flush.

## Evidence

### 1. `repid_zkp_proofs` — real proofs are 100% anchored `[V]`
| is_real | anchored (eas_attestation_uid set) | n | earliest | latest |
|---|---|---|---|---|
| true | **true** | **21,960** | 2026-06-07 | 2026-06-17 |
| false | true | 5 | 2026-05-30 | 2026-05-30 |
| false | **false** | **56,818** | 2026-05-22 | 2026-06-07 |

- Real proofs (is_real=true, all have `proof_bytes`): **21,960 / 21,960 anchored (100%)**. There is **no un-anchored real-proof backlog**.
- The 56,818 "un-anchored" are **stubs** (is_real=false, no proof_bytes), a static historical population (05-22→06-07). Stubs have nothing to attest — anchoring them would be attesting to placeholders.
- No `repid_zkp_proofs` row of any kind created since **2026-06-17 08:10** (ZKP write path idle ~5.5 wks — matches the general throughput-starvation from Beats 0–2).

### 2. EAS-anchor stage works `[V]`
- `eas_anchor_batches`: **219 batches, all `status='anchored'`** (2026-07-05). No `pending`/`error` batches. The anchoring worker is not the failure point.

### 3. The real backlog: `repid_proof_queue` `[V]`
| status | n | earliest | latest |
|---|---|---|---|
| completed | 81,530 | 2026-04-20 | **2026-06-16 18:13** |
| failed | 6 | 2026-06-03 | 2026-06-08 |
| **pending** | **40,541** | 2026-06-16 21:43 | **2026-07-25 19:36** |

- Last `completed` = **2026-06-16 18:13** → the consumer stopped ~then (matches last real proof 2026-06-17).
- All 40,541 `pending` have **`attempts=0`** and `proof_bytes IS NULL` → the worker **never touched them** (absent/undeployed consumer, not a crash-looping one; `failed`=6 and static since 06-08).
- Newest pending job = **2026-07-25 19:36:28** — the *producer* (enqueue-on-score-event) is alive; that timestamp matches today's Beat-1 swarm-probe completions. Producer up, consumer down.

### 4. Backlog composition — 99.3% churn `[V]`
| event_type | pending jobs | note |
|---|---|---|
| HAL_SCORE_EVENT | **40,258** | internal HAL scoring churn (non-economic) |
| SERVICE_FULFILLED | 252 | **real economic event** (contract fulfilled) |
| (null) | 22 | orphaned event_id |
| VALIDATOR_REWARD | 3 | real |
| VALIDATION_FAILED | 3 | not a proof-worthy success |
| SERVICE_SATISFIED | 2 | real |
| PREDICTION_RESOLVE | 1 | real |

- Genuine economic/deliverable events worth a durable proof ≈ **258** (SERVICE_FULFILLED + SERVICE_SATISFIED + VALIDATOR_REWARD + PREDICTION_RESOLVE).

## Corrections to stale docs
- STATE_OF_THE_SYSTEM "Drain worker: Down since June 7 … proofs stay un-anchored to EAS" → **down since ~2026-06-16** (June 7 was the stub→real cutover), and the failure is **proof-generation** (`repid_proof_queue` consumer), **not EAS anchoring** (which is 100% current for real proofs).
- Backlog Task 1.2 line "batch un-anchored `repid_zkp_proofs` → EAS" → **wrong stage**; the un-anchored rows are stubs. The real work is draining `repid_proof_queue` pending jobs into real proofs.
- Prior "78,783 total = 21,960 real + 56,823 stubs" → confirmed (56,818 unanchored stubs + 5 anchored stubs = 56,823). ✓

## Recommendation (for Sean — rule-4 infra + a gas-cost decision)
The proof-generation worker (Railway `proof-drain-worker` in the `repid-engine` project) is down; restarting it is a Railway infra action on Sean's account. **Before a blind restart**, note:
1. A blanket drain generates + anchors **40k proofs of mostly HAL churn** → gas + attesting to internal scoring. Not desirable.
2. Preferred: **drain only the ~258 real economic events** (SERVICE_FULFILLED/SATISFIED, VALIDATOR_REWARD, PREDICTION_RESOLVE), and **gate `HAL_SCORE_EVENT` out of proof-queue enqueue** (or route to shadow) — same anti-churn principle as breakers 2.0/2.1/2.3. That producer-side filter is a **free branch task** the loop can build next beat (no Sean needed for the code; Sean needed only to restart the worker on prod).
3. Whether internal HAL scoring events *should* ever get on-chain proofs at all is a small vision call (they're not economic) — flag, don't decide.

**Net:** this beat evidenced a real, precise degradation (not the one the doc described) and produced a decision-ready, gas-safe path — while removing a wasteful "restart + anchor 56k stubs" action the stale doc implied.
