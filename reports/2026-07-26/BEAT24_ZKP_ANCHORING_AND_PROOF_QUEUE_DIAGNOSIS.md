# Beat 24 — ZKP anchoring + proof-queue diagnosis (verify-first)

**Date:** 2026-07-26 · **Author:** Claude (autonomous build-loop, Beat 24) · **Type:** verify-first diagnostic, read-only
**Backlog item:** L1 **1.2** — *"Restart proof-drain worker (reported down since 06-07); batch un-anchored `repid_zkp_proofs` → EAS. **Verify actually-down first.**"*
**Method:** live SQL against Supabase `qnnpjhlxljtqyigedwkb` + `eth_call` to the EAS contract `0x4200000000000000000000000000000000000021` on Base Sepolia (public RPC `https://sepolia.base.org`). No writes, no DDL, no Railway tools.

> ## ⚠ PRIOR-ART NOTICE — read this first (my own process mistake, owned)
> **`reports/2026-07-25/BEAT8_PROOF_DRAIN_DIAGNOSTIC.md` already established the DB-side core of this diagnosis.** I began this beat's investigation without first checking prior reports for coverage, and **independently re-derived** Beat 8's findings: anchoring-is-not-the-bottleneck, consumer-absent-since-2026-06-16, `attempts=0` on all 40,541 rows, and the 99.3 % `HAL_SCORE_EVENT` composition. **That duplication was avoidable waste — Beat 8 deserves the credit for those four findings, not this report.**
>
> **What is genuinely new here, and only here:**
> 1. **On-chain verification of the anchors.** Beat 8 established anchoring from the *database's own* claim (`eas_anchor_batches.status='anchored'`). This beat verified **20 of the 220 attestation UIDs directly against the EAS contract on Base Sepolia**, with a fabricated-UID negative control — turning *"the DB says anchored"* into *"the chain confirms anchored"* (CLAUDE_RULES r1: a DB row asserting an on-chain fact is not the on-chain fact). It also recovers the on-chain attester and confirms **zero revocations**.
> 2. **`INFRA_INVENTORY` §11's "5 EAS anchors" refuted with a chain-backed count of 225.**
> 3. **Backlog 4.2 needs no DDL** — `repid_zkp_proofs.leaf_scheme` / `.poseidon2_leaf` already exist and are 100 % NULL (§4). Not noted in Beat 8.
>
> Independent re-derivation does have residual value as a **replication** of Beat 8 a day later (the numbers held exactly), but it was not worth a beat. **Process fix: check `reports/**` for prior coverage of a backlog item before opening an investigation on it.**

---

## Executive summary

The backlog's premise for task 1.2 is **wrong in both directions**, and the correction changes what should be done next. (Items 1–3 below replicate Beat 8; item 4 and the on-chain leg are new.)

| Claim carried in the docs | Verdict | Truth |
|---|---|---|
| "Proof-drain worker down since **2026-06-07**" | **[V] date wrong** | The consumer stopped **2026-06-16 18:13Z** (last `completed` row); last real proof written 2026-06-17 08:10Z. |
| "…causing proofs to stay **un-anchored** to EAS" | **[V] REFUTED** | **Zero** un-anchored real proofs. All **21,960** real Plonky3 proofs carry an EAS UID; **20/20 sampled UIDs verified live on-chain**, none revoked. |
| "**5** EAS anchors" (INFRA_INVENTORY §11, 2026-06-12) | **[V] STALE** | **225** distinct on-chain attestations (220 real-proof batches + 5 legacy stubs). |
| *(not previously stated)* | **[V] NEW — the real gap** | **40,541 proof requests are stuck `pending` and have never been attempted** (`attempts=0`, zero errors, on every row). |

**The one-line diagnosis:** anchoring is healthy and finished; **proof *generation* is a dead consumer** — and **99.30 % of what it would generate is HAL churn**, so restarting it as-is would be actively harmful.

---

## 1. Anchoring is complete, not broken [V]

```sql
SELECT count(*) total, count(*) FILTER (WHERE is_real) real_proofs,
       count(*) FILTER (WHERE eas_attestation_uid IS NOT NULL) anchored,
       count(*) FILTER (WHERE is_real AND eas_attestation_uid IS NULL) real_unanchored,
       max(created_at) last_proof_at
FROM repid_zkp_proofs;
```
| total | real_proofs | anchored | **real_unanchored** | last_proof_at |
|---|---|---|---|---|
| 78,783 | 21,960 | 21,965 | **0** | **2026-06-17 08:10:56Z** |

Composition of the anchored set:

| eas_schema | scheme | is_real | rows | **distinct UIDs** | window |
|---|---|---|---|---|---|
| `repid-real-proof-batch-v1` | `plonky3_range_check` | true | 21,960 | **220** | 2026-06-07 → 2026-06-17 |
| `constitutional-compliance-v1` | `sha256-stub` | false | 5 | 5 | 2026-05-30 |

≈100 proofs per attestation — **batch anchoring**, which is why 21,960 proofs cost only 220 on-chain writes.

### On-chain verification [V]
`eth_call getAttestation(bytes32)` (selector `0xa3112a64`, derived not guessed) against EAS on Base Sepolia, over **20 UIDs sampled evenly across the 220** plus a fabricated negative control:

- **20/20 EXIST** — each returns its own UID echoed back, schema `0x4e8445d9663aaaa7f74409c88c1652b2f2a44e2a86dd008d70543b9804c71cd6`, `revocationTime = 0`, `revocable = 1`, attester **`0x4f8ad3fb35473b6dea0559ffbbde034e2db504fb`**.
- **1/1 negative control ABSENT** — `0xdead…beef` returns the all-zero struct, proving the check discriminates (it is not trivially returning "exists").

**Timing correction [V]:** the on-chain `time` fields land on **2026-07-05** (00:01Z → 16:50Z across the sample), while DB `created_at` is June. So the anchoring leg ran a **single-day catch-up on 2026-07-05** and cleared the entire real-proof backlog. Proof *generation* and EAS *anchoring* are two different workers with two different fates — conflating them is what produced the stale "un-anchored" claim.

---

## 2. The actual failure: a dead consumer on `repid_proof_queue` [V]

```sql
SELECT status, count(*), min(created_at), max(created_at) FROM repid_proof_queue GROUP BY status;
```
| status | rows | first | last |
|---|---|---|---|
| completed | 81,530 | 2026-04-20 | **2026-06-16 18:13:23Z** |
| **pending** | **40,541** | 2026-06-16 21:43 | **2026-07-25 19:36Z** |
| failed | 6 | 2026-06-03 | 2026-06-08 |

The **producer is alive** (rows arriving as recently as yesterday); the **consumer stopped 40 days ago**.

**It is not erroring — it is absent [V]:**
```sql
SELECT attempts, count(*), count(*) FILTER (WHERE error_message IS NOT NULL) FROM repid_proof_queue WHERE status='pending' GROUP BY attempts;
```
→ **`attempts = 0` on all 40,541 rows, `error_message` NULL on all 40,541.** Not a retry loop, not a crash loop, not a poison message: **nothing has ever picked these rows up.** That is a stopped/unwired worker, and it rules out the "it's failing on bad input" hypothesis entirely.

---

## 3. Why restarting it *right now* would be a mistake [V]

```sql
SELECT e.event_type, count(*), pct FROM repid_proof_queue q
LEFT JOIN repid_score_events e ON e.id = q.event_id WHERE q.status='pending' GROUP BY 1;
```
| event_type | pending rows | share |
|---|---|---|
| **`HAL_SCORE_EVENT`** | **40,258** | **99.30 %** |
| `SERVICE_FULFILLED` | 252 | 0.62 % |
| *(orphan — no matching score event)* | 22 | 0.05 % |
| `VALIDATION_FAILED` / `VALIDATOR_REWARD` / `SERVICE_SATISFIED` / `PREDICTION_RESOLVE` | 9 | 0.02 % |

Only **283 rows (0.70 %)** are non-`HAL_SCORE_EVENT` at all — and of those, **Beat 8's narrower "proof-worthy" figure of 258 is the better one to quote** (`SERVICE_FULFILLED` 252 + `SERVICE_SATISFIED` 2 + `VALIDATOR_REWARD` 3 + `PREDICTION_RESOLVE` 1). My 283 additionally counts 22 orphaned `event_id`s and 3 `VALIDATION_FAILED` rows, neither of which is a success worth a durable proof. **Use 258.**

Turning the drain worker back on as-is would mint ~40,000 Plonky3 proofs and ~400 Base-Sepolia EAS attestations to certify **HAL scoring churn** — the same self-referential thrash pattern the L2 breakers exist to stop (cf. Beat 2's 85 % `[PEER_VERIFY_PANEL]` recursion).

**This is precisely what repid-engine PR #192 fixes** — *"producer-side HAL_SCORE_EVENT churn filter for `repid_proof_queue` (shadow-first)"*, already open, `MERGEABLE`/`CLEAN`, file-disjoint from every other queued PR.

### Corrected dependency order for backlog 1.2
1. **Merge #192** (churn filter) — stops the 99.30 % inflow at the producer.
2. **Decide the fate of the existing 40,258 churn rows** — mark them `skipped`/`cancelled` rather than proving them (a DB write; single-writer, Sean-visible, *not* taken this beat).
3. **Then** restart the drain worker, which now faces ~283 real rows instead of 40,541 — cheap, fast, and every resulting attestation certifies something economically real.

Doing (3) before (1) is the expensive, noisy path and would bury the 283 real proofs under 40k of churn.

---

## 4. Incidental finding — the Poseidon2 migration schema already exists [V]

`repid_zkp_proofs` already carries **`leaf_scheme text`** and **`poseidon2_leaf text`** columns, and **both are 100 % NULL** (0 of 78,783 rows populated).

Backlog **4.2** ("migrate POSTCARD leaf sha256→Poseidon2, dual-write parity, don't flip primary") therefore needs **no DDL** — the dual-write target columns are already in place and unused. That removes the prod-DDL step from 4.2 and makes it a pure application-layer, shadow-first change once the Poseidon2 chain (#195 → #196 → #197) merges.

---

## 5. What was NOT done (scope honesty)

- **No writes of any kind.** No queue rows re-statused, no worker restarted, no DDL. The churn-row disposition in §3 step 2 is a real decision with real consequences and is left for the merge/Sean path.
- **Worker *process* state not inspected.** The "consumer is absent" conclusion rests on DB evidence (`attempts=0` across 40,541 rows over 40 days), which is decisive about *behaviour*; I did not query Railway for the `proof-drain-worker` service's process status (variable-listing tools are hard-banned, and deployment status was not needed to reach the conclusion). Tagged **[V] for behaviour, [R] for process state**.
- **220/220 UIDs not exhaustively checked** — 20 evenly-spaced samples + 1 negative control. Extrapolation to all 220 is **[R]**; the sampled 20 are **[V]**.

---

## 6. Doc corrections owed

- `STATE_OF_THE_SYSTEM.md` → *"Drain worker: Down since June 7, causing proofs to stay un-anchored to EAS"* — **replace**: anchoring is 100 % complete (verified on-chain 2026-07-05); the outage is **proof generation**, stopped **2026-06-16**, backlog **40,541** rows, **99.30 % HAL churn**.
- `INFRA_INVENTORY.md` §11 → *"5 EAS anchors"* — **replace with 225** (220 real-proof batches + 5 legacy stubs).
- `SPRINT_BACKLOG_DEPENDENCY_ORDERED.md` task 1.2 → acceptance test *"un-anchored count decreases"* is unsatisfiable (it is already 0); **re-scope to** "pending `repid_proof_queue` count decreases after #192 lands".
