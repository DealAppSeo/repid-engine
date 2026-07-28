# Beat 57 — which root does a verifier trust? The measured half of a question deferred six beats

**Date:** 2026-07-28 · **Repo:** `repid-engine` · **Artifacts:** `scripts/sim/trusted-root-policy.ts`, `tests/trusted-root-policy-sim.test.ts`

---

## 1. Why this beat exists

repid-engine **#242** closed the replay gap (HAL accepted an answer whose cited fact had been revoked, because the answer carried the root it was minted against and the crypto agreed). It gave `GroundingInput` a `current_memory_root` field — and then deliberately did not wire it, carrying the reason as its own item:

> "The pipeline still passes no root — it gains the capability, not the wiring. Which root is production's trusted root (last committed? last EAS-anchored?) is a real integration question deserving its own beat."

That beat has been deferred since Beat 50 (as "the pipeline trusted-root wiring, starting from the schema"). **This is it, and it is answered with a measurement rather than a preference.**

#242 also already stated the shape of the cost, correctly and without a number:

> "Re-running an old witness against the current root fails on *any* memory movement, conflating 'this fact was retracted' with 'some unrelated fact was added'."

**That is confirmed here independently, not discovered here.** Running the convergence demo's stage-4 computation against three mutations — revoke the cited fact / insert an unrelated fact / revoke a *different* fact — the demo's `staleGrounded === false` and `would_abstain === true` fire **identically in all three**, while `membershipWitness` confirms the cited fact is still live in cases 2 and 3. The distinguishing term in the demo is `pcAbstained` (which goes through `emitGroundedAnswer` and therefore actually consults memory), not the HAL signal. The HAL signal — the one that would gate production if `HAL_GROUNDING_MODE=enforce` were flipped — cannot tell retraction from any other write.

**What was missing was the magnitude.** A conflation that costs 1% is a rounding error; one that costs 99% forecloses a design.

---

## 2. Method, and what it is not

`scripts/sim/trusted-root-policy.ts` — a seeded, deterministic simulation over a synthetic workload. **It is not a measurement of production traffic**, and it does not re-test the crypto (which has its own suites). It models the single property this question turns on: **the memory root moves on every write.**

For every emitted answer, ground truth at verification time is whether the cited fact is still active.
- refusing a live fact = **false abstention** (availability cost)
- accepting a retracted fact = **unsound accept** (correctness cost — the failure Patent #1 claims to close)
- a fact with no witness under the trusted root = **unciteable**

Parameters: `ops=20000, revokeShare=0.15, queryShare=0.25, epochEvery=50, verifyLag=40`, seeds 1/2/3.

**Not scored, stated so the table is not over-read:**
- **RE_DERIVE is the ground-truth oracle by construction**, so its 0/0 is a tautology and not a result. Its real cost is architectural: it needs live memory access at verification time, which a peer verifying an answer *offline* does not have. No simulation over this workload can price that — it is the reason the other policies exist at all.
- The **unsound-accept** column rests on **9–17 events per run**. Its decimals are not sampled well enough to quote and are not quoted below.

---

## 3. Result

| policy | false-abstain | unsound-accept | unciteable | shape of the failure |
|---|---|---|---|---|
| **LIVE_ROOT** — trust the latest committed root | **99.7–99.8%** | 0 | 0 | refuses on any intervening write |
| **ANCHORED_LIVE_EMIT** — trust the anchored root, emit at the live root | **>95%** | 0 | 0 | incoherent pairing; the roots almost never match |
| **ANCHORED_EPOCH_EMIT** — trust *and emit at* the last anchored root | **0%** | small, rising | 1.1% | sound within the epoch; blind to post-anchor retractions |
| **RE_DERIVE** — re-issue the witness against live memory | 0 | 0 | 0 | oracle; **cannot be run offline** |

**LIVE_ROOT false-abstains on 99.7–99.8% of answers, stable across all three seeds.** That is the number the question needed. The most obvious production choice — "trust the root I currently hold" — is not a conservative default; it is a policy that abstains on essentially everything, on a memory that takes any writes at all. It is over-strict, never unsound (unsound-accept is exactly 0), which is why it would ship looking safe and read as a broken feature.

**The naive pairing is no better than the naive policy.** Trusting the anchored root while agents emit against the live root inherits the same >95% refusal — the two obvious choices do not compose.

**ANCHORED_EPOCH_EMIT is the only policy that is both offline-verifiable and usable.** Roots match by construction, so false abstention is 0. Its cost moves entirely into the two staleness columns.

---

## 4. The result that contradicts the obvious framing

Anchor cadence looks like a staleness-vs-cost trade in which correctness and availability pull against each other. **Measured, they do not pull against each other at all.** Sensitivity over `epochEvery ∈ {10, 25, 50, 100, 250}`, seed 1:

| epochEvery | unsound-accept | unciteable |
|---|---|---|
| 10 | 0.0% | 0.2% |
| 25 | 0.0% | 0.7% |
| 50 | 0.1% | 1.1% |
| 100 | 0.1% | 1.9% |
| 250 | 0.2% | 4.5% |

Both columns worsen as the epoch lengthens. They are **two faces of one quantity — snapshot age** — so shortening the epoch improves both at once.

**Precision of that claim, stated at the strength the data supports.** `unciteable` rises monotonically at *every step*, on every seed. `unsound-accept` rises **endpoint-to-endpoint** on every seed but is **not step-wise monotone** — adjacent cadences genuinely invert (measured 0.14% → 0.12%), because it rests on ~10–20 events. The first version of the test asserted step-wise monotonicity for both and **went red**; the claim was weakened to match the data rather than the threshold loosened to match the claim.

**Consequence for the epoch-boundary decision.** T12 task #435039 (`trinity-sophia`, honestly tagged `[reasoned]` throughout) recommended a hybrid `N writes OR ΔT` boundary, reasoning about a staleness-vs-cost trade. The measurement narrows that: since correctness and availability co-move, **there is no correctness-vs-availability dial to tune** — anchor as often as affordable. The only genuine counterweight is **anchor cost (gas), which this simulation does not model and therefore cannot recommend a cadence from.** That is the remaining input, and it is a real-money question, so it is Sean's.

---

## 5. What this does and does not settle

**Settles:** production must not wire `current_memory_root` to the last committed root. The capability #242 added is, at that setting, a switch that turns grounding off.

**Settles:** the coherent design is epoch-scoped — agents emit against the last anchored root, peers verify against it, and `verifyPublication` (#255) is the check that the epoch root is domain- and time-bound. The publication channel and the trusted-root policy are the same decision seen from two ends.

**Does not settle:** the cadence (needs the gas number). Does not settle the **withheld-epoch attack** — an agent may anchor E+1 and simply not publish it, serving citations against a still-valid E. Every artifact genuine, the set incomplete. One anchor cannot detect it; it is the honest boundary of the whole chain and remains open.

**Does not settle** anything about production rates. `revokeShare` and `verifyLag` are assumptions. The transferable results are the ordering and the shape, not the decimals — with the single exception of LIVE_ROOT's ~99.8%, which is a structural consequence of "the root moves on every write" and would hold under any workload with a non-trivial write rate.

---

## 6. Reproduce

```bash
npx ts-node --transpile-only scripts/sim/trusted-root-policy.ts --seed 1 --ops 20000
npx jest --config jest.config.js tests/trusted-root-policy-sim.test.ts     # 7/7
```

Every figure above is recomputed by the test suite, which asserts only the claims this report makes — Beat 54 refuted #251 for publishing figures its own script could not reproduce, and these assertions exist so that cannot recur here.
