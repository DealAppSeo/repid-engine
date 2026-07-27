# Beat 29 — Restarting proof generation safely: measured state + runbook

**Date:** 2026-07-27 · **Author:** Claude (autonomous build loop, Beat 29)
**Status of every number below:** `[V]` = produced by a query/EXPLAIN I ran against
`qnnpjhlxljtqyigedwkb` while writing this, or by a command whose output is quoted.
`[R]` = reported, not verified by me.

This closes the scoping half of the item Beat 28 left as *"the live question"*: with
repid-engine **#192** (producer-side churn filter) merged, what actually stands between
here and restarting ZK proof generation — and what does a safe restart look like.

---

## 1. Why this was blocked, and what changed

The proof-generation consumer (`npm run worker` →
`dist/scripts/start-proof-drain-service.js`, Railway service `proof-drain-worker`) has
not completed a job since **2026-06-16 18:13:23Z** `[V]` — that is the newest
`completed_at`-era row in `repid_proof_queue`, and every pending row since carries
`attempts = 0`, i.e. **never picked up**, not *tried and failed*.

For four beats the blocker was that a blind restart would prove the whole backlog, which
is overwhelmingly internal-scoring churn. #192 fixed that **at the producer end** — new
churn stops being enqueued once its lever is set to `enforce`. It does nothing about the
**40,258 churn rows already queued.**

---

## 2. The backlog, measured `[V]`

`repid_proof_queue` has no `event_type` column; the classification comes from joining
`event_id` → `repid_score_events.event_type` (a real FK,
`repid_proof_queue_event_id_fkey`).

| status | event_type | rows | attempts=0 | oldest | newest |
|---|---|---|---|---|---|
| pending | `HAL_SCORE_EVENT` | **40,258** | 40,258 | 2026-06-16 21:43Z | 2026-07-25 19:36Z |
| pending | `SERVICE_FULFILLED` | 252 | 252 | 2026-06-18 21:57Z | 2026-07-23 04:33Z |
| pending | `VALIDATOR_REWARD` | 3 | 3 | 2026-07-25 03:16Z | 2026-07-25 03:16Z |
| pending | `VALIDATION_FAILED` | 3 | 3 | 2026-06-24 22:44Z | 2026-07-25 03:16Z |
| pending | `SERVICE_SATISFIED` | 2 | 2 | 2026-07-23 04:33Z | 2026-07-23 04:33Z |
| pending | `PREDICTION_RESOLVE` | 1 | 1 | 2026-06-19 08:02Z | — |
| pending | *(no score event)* | 22 | 22 | 2026-06-18 21:57Z | 2026-07-02 22:39Z |
| completed | `HAL_SCORE_EVENT` | 78,018 | — | 2026-05-12 | 2026-06-16 18:13Z |
| completed | others | 3,511 | — | 2026-04-20 | 2026-06-16 06:59Z |
| failed | `HAL_SCORE_EVENT` | 6 | — | 2026-06-03 | 2026-06-08 |

**Pending total 40,541 `[V]`** — matching Beat 8's figure exactly, 40 days later.

Two refinements Beat 8 did not have:

- **Economic pending is 261, not "~258" `[V]`** — `SERVICE_FULFILLED` 252 +
  `VALIDATOR_REWARD` 3 + `VALIDATION_FAILED` 3 + `SERVICE_SATISFIED` 2 +
  `PREDICTION_RESOLVE` 1. Churn share is **99.36%**.
- **The 22 "orphan" rows are already inert `[V]`.** All 22 have `event_id IS NULL`
  *and* `zkp_service_url IS NULL`. `fetchPendingBatch` filters on
  `zkp_service_url = $2`, and NULL never equals anything — so the drain has never been
  able to see them and never will. They are a dead-letter class, not a live risk.
  Drainable pending is therefore **40,519**, not 40,541.
- The newest churn row (2026-07-25 19:36:28Z) is one of **my own Beat 1 diagnostic
  probes** `[V]` — the producer is alive and enqueuing; only the consumer is stopped.

---

## 3. What a blind restart would actually do

`fetchPendingBatch` selects `status='pending' AND zkp_service_url=<prover>` with
**`LIMIT 20` and no `ORDER BY`** `[V, src/services/proof-drain-service.ts]`. Physical
order puts the churn first. With `pollIntervalMs=2000` and `batchSize=20`, the drain
would work through ~40k churn jobs before reaching the 261 economic ones.

Each completed job writes a `repid_zkp_proofs` row, and **where the prover returns a
`merkle_root`, `insertCanonicalProof` calls `easService.attestProof` per proof** — there
are two such attest paths in that function (the S-ONCHAIN Phase 2 block and the R3
block). That is real Base Sepolia gas per attestation.

> `[R]`, and it matters: whether the deployed prover actually returns `merkle_root` on
> this path is **not** verified here. The 21,960 historical proofs were anchored in
> 100-proof *batches* by `eas-anchor-worker.ts` (220 attestations — content-audited
> 220/220 in Beat 28), which is consistent with the drain path producing no per-proof
> attestation. If that holds, the blind-restart cost is ~40k proof rows and the batch
> worker's ~403 additional batch attestations rather than ~40k individual ones. Either
> way the artifact is the same lie: **certifying internal HAL scoring as if it were
> economic activity.** Verify before relying on the smaller number.

---

## 4. What shipped this beat: the consumer-side guard

`src/services/proof-drain-churn-guard.ts` + wiring in `proof-drain-service.ts`
(PR #204). Lever `PROOF_DRAIN_CHURN_MODE`:

| mode | fetch | churn jobs | default? |
|---|---|---|---|
| `off` | the legacy statement, character-for-character | proved | **yes** — unset, empty or a typo all resolve here |
| `shadow` | legacy result set + an `is_churn` column | **still proved**, composition logged | no |
| `enforce` | churn excluded from the fetch | never claimed, never written, left `pending` | no |

The important property: **`enforce` performs no writes at all.** Excluded jobs are not
marked, not failed, not deleted — they stay exactly as they have been since 2026-06-16.
So the decision is reversible by one env change with nothing to undo, and it does **not**
require a 40k-row prod UPDATE to happen first. That is the coupling this removes: Beat 28
listed the churn-row disposition as *"the last thing standing between here and restarting
proof generation"* — with this guard, the restart no longer waits on it.

Measured on live prod `[V, EXPLAIN ANALYZE 2026-07-27]`:
`enforce` returns exactly **261** rows — the economic set, no more, no less.

---

## 5. Runbook — restarting proof generation

**Preconditions**

1. `[V]` #192 merged (`proof-enqueue-filter.ts` on `main`).
2. PR **#204** (this guard) merged.
3. `[R] — verify first` the prover service `zkp-postcard-production.up.railway.app` is
   healthy, and confirm whether it returns `merkle_root` (drives §3's gas question).

**Sean-only actions (Railway, on `proof-drain-worker`)**

```
PROOF_DRAIN_CHURN_MODE=enforce     # required — without it the restart proves the 40k
PROOF_ENQUEUE_HAL_MODE=enforce     # optional, on the engine: stops new churn entering
```
then restart the service. The worker prints its guard mode in the first lines of its log,
so a restart that forgot the lever is loud rather than silent:

```
[ProofDrain] churn-guard ENFORCE — jobs whose score event is one of {HAL_SCORE_EVENT}
are excluded from the fetch and left pending (never claimed, never written)
```

**Expected outcome:** 261 economic jobs drain (at 20/2s, bounded by prover latency — call
it minutes, not hours), then the queue goes idle with 40,258 churn rows untouched.

**Verification (run after, do not assume)**

```sql
-- 1. economic backlog drained, churn untouched
select coalesce(e.event_type,'<none>') as event_type, q.status, count(*)
from repid_proof_queue q left join repid_score_events e on e.id = q.event_id
where q.created_at > '2026-06-16' group by 1,2 order by 3 desc;

-- 2. no churn was proved: every new proof row must trace to an economic event
select count(*) from repid_zkp_proofs where created_at > now() - interval '1 day';
```

Then content-audit whatever got anchored with the tool merged in #199:

```bash
npx ts-node scripts/diag/verify-anchor-batch.ts --sample 5
```

**Rollback:** set `PROOF_DRAIN_CHURN_MODE=off` (or unset it) and restart. Nothing to undo —
`enforce` never wrote anything.

---

## 6. Still Sean's call (not blocked by it any more)

- **Disposition of the 40,258 churn rows** → recommend `skipped` (or `cancelled`).
  `repid_proof_queue.status` has **no CHECK constraint** `[V]`, so a new status value
  needs no DDL. This is now housekeeping — it makes the queue's depth honest and removes
  the per-poll scan cost in §4 — rather than a precondition. It remains a single-writer
  prod write that I have deliberately not made.
- **A partial index** would remove the enforce-mode poll cost entirely. Not proposed as
  part of #204: prod DDL goes through one writer with a look first, and the cost is
  tolerable and temporary.

---

## 7. Honest limits of this document

- The Railway runtime state of `proof-drain-worker` is `[R]` — the Railway MCP had no API
  token in this session, and I did not chase it. What is `[V]` is that **no job has
  completed since 2026-06-16**, which is the fact the restart actually depends on.
- §3's per-proof-attestation gas figure is `[R]` and explicitly flagged; it needs one
  prover response inspected to settle.
- The guard is verified by unit tests + `EXPLAIN ANALYZE` against prod. It has **not**
  run against the live queue in a real worker process — by construction, since the worker
  is stopped and starting it is Sean's action.
