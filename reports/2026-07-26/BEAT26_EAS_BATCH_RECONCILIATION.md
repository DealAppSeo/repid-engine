# Beat 26 — `eas_anchor_batches` reconciliation: the one orphaned attestation, root-caused and cryptographically proven

**Date:** 2026-07-26 · **Author:** CC (autonomous build loop, Beat 26) · **Type:** verify-first diagnostic + prepared (not executed) prod DML
**Queued by:** Beat 25's independent verifier — *"`eas_anchor_batches` has 219 rows (`sum(proof_count)=21,860`) but `repid_zkp_proofs` carries 220 distinct real-proof UIDs (21,960 proofs) — 1 attestation / ~100 proofs missing a batch record."*

## Prior-art check (Beat 24's lesson: check `reports/` before opening an investigation)
`grep -rl eas_anchor_batches reports/` → three prior files. **Neither prior beat reconciled the two tables:**
- `reports/2026-07-25/BEAT8_PROOF_DRAIN_DIAGNOSTIC.md` — states *"`eas_anchor_batches`: **219 batches**, all `status='anchored'`"* and stops there. It never compared 219 against the proof-side UID count, and its anchoring evidence is the DB's own `status` column (no chain call).
- `reports/2026-07-26/BEAT24_ZKP_ANCHORING_AND_PROOF_QUEUE_DIAGNOSIS.md` — added the on-chain leg (20 UIDs `eth_call`'d) but worked from `repid_zkp_proofs` only, so the 219-vs-220 gap was invisible to it.
- The gap was first seen by **Beat 25's verifier**, which cross-referenced the tables. This report is the follow-through, and it is **net-new work**: nobody had root-caused it, recovered its transaction, or verified what the attestation actually commits to.

---

## 1. The gap, reproduced exactly [V]

```
batch_rows              219      batch_anchored          219
batch_proof_count_sum   21,860
real_proofs             21,960   distinct_uids_real      220
real_unanchored         0        orphan_batches          0        (batches with no matching proofs)
```
Exactly one direction of asymmetry: every batch row has proofs, but one UID's worth of proofs has no batch row. Difference = **1 batch / 100 proofs**, and `21,860 + 100 = 21,960` closes the arithmetic with nothing left over.

**The orphan [V]:**

| field | value |
|---|---|
| `eas_attestation_uid` | `0x6f4486f84c4d782cb289a4bda14e5a67419bcdaf4d8ef65495fe95e1081a03e0` |
| proofs carrying it | **100** (all `is_real`, all `zk_commitment` in canonical `0x`+64-hex form) |
| `id` range | **56838 … 56937** (dense — exactly 100 ids) |
| proof `created_at` span | 2026-06-07 09:58:57Z → 2026-06-16 19:36:03Z |

**It is the FIRST batch of the run, not a random hole [V]:** `min(proof_id_min)` across all 219 recorded batches = **56938** — precisely one past the orphan's `id_max` of 56937. The recorded set is fully contiguous from there (`0` non-contiguous gaps) and its size histogram is `218 × 100 + 1 × 60`. The table's history begins immediately *after* the missing batch.

---

## 2. Root cause: a known, already-hardened best-effort failure [V]

`src/workers/eas-anchor-worker.ts` writes the audit row **after** the on-chain attest and the uid writeback, and deliberately treats it as non-fatal:

> `// Audit-row write is best-effort and MUST NOT abort the backfill or lose the already-completed on-chain anchor … A failed audit-row insert — returned error OR a thrown rejection (e.g. eas_anchor_batches missing) — is logged loud and the loop continues to the next batch. (This is the exact 2026-07-04 failure mode.)`

The comment names the date. The on-chain timestamps confirm it:

| | on-chain `time` | UTC |
|---|---|---|
| **orphan** attestation | `0x6a499ee6` | **2026-07-05 00:01:42Z** (= 2026‑07‑04 17:01 PDT) |
| first *recorded* batch | `0x6a49a012` | 2026-07-05 00:06:42Z |

**Exactly 300 s apart** — one anchoring cycle. The first batch anchored, its audit insert failed (table absent / not yet created at that moment), the worker logged loud and carried on, and the table starts populating from cycle 2. The liveness signal (`eas_attestation_uid` on the proof rows) landed correctly, which is why no downstream surface ever noticed.

**Blast radius: nil.** `grep -rn eas_anchor_batches src scripts` → the only references are the worker's own inserts and its comments. **Nothing in the codebase reads this table.** It is pure audit bookkeeping; the missing row cannot cause re-anchoring, double-spend of gas, or a wrong liveness reading.

---

## 3. Chain verification — and a first for this codebase [V]

**3a. The attestation exists and is healthy.** `eth_call getAttestation(bytes32)` (selector `0xa3112a64`) on EAS `0x4200000000000000000000000000000000000021`, Base Sepolia:
- schema `0x4e8445d9663aaaa7f74409c88c1652b2f2a44e2a86dd008d70543b9804c71cd6` — same as every recorded batch
- attester `0x4f8ad3fb35473b6dea0559ffbbde034e2db504fb` — same
- `revocationTime = 0`, `expirationTime = 0`, `revocable = 1`
- **negative control** `0x…dead` → all-zero struct = ABSENT, so the check discriminates.

**3b. Its transaction, recovered.** `eth_getLogs` on the EAS address over a 400-block window ending at the first recorded batch's block, matched on the uid: **`0x444cb9bbff4dcb6ab48e0f81a98921f7049906ea21c086eb6f76197f4be7c6a8`**, block **43720707**, `topic0 = 0x8bf46bf4…141b35` (`Attested`), receipt **`status = 0x1`**, `from = 0x4f8ad3fb…04fb`, gasUsed 448,976.

**3c. Decoding the attestation payload corrected a trap.** The EAS data encodes `(agentId, tier, merkleRoot, repidSnapshot, proofType, proofId)` — matching `attestProof({proofId: proofIdMin, agentId: rep.agent_id, tier: rep.tier_proven, …})`. For the orphan: `proofId = 0xde06 = 56838` (**the chain itself states the batch's `proof_id_min`**, independently confirming the id range derived from the DB), tier `ESTABLISHED`, proofType `REAL_PROOF_BATCH`.
The uuid string in the payload is the **representative proof's `agent_id`, NOT the `batch_id`** — verified by control: the recorded first batch's payload uuid `32e0e809-…` equals `repid_zkp_proofs.agent_id` for id 56938, while its actual `batch_id` is `cdd1e775-…`. Reading it as a batch id would have written a wrong primary key into the backfill. `batch_id` is `gen_random_uuid()` and is *not* recoverable from chain — the backfill must mint a fresh one.

**3d. The merkle root recomputed from scratch — this is the load-bearing proof.** Prior beats verified that attestations *exist*. Nobody had checked **what they commit to**. Reusing the exact construction in `src/zkp/merkle-root.ts` (leaf = `keccak256(utf8(zk_commitment))`, pair = `keccak256(concat(bytes,bytes))`, Bitcoin-style odd→duplicate) over the 100 commitments in the worker's `selectBatch` order (`created_at ASC, id ASC`):

```
leaves        : 100
recomputed    : 0x9a1ae18b8ca2198184393a64ee39ac1fe6e6b50cc3c8848ce1ce7e6f8f2dfbc5
on-chain root : 0x9a1ae18b8ca2198184393a64ee39ac1fe6e6b50cc3c8848ce1ce7e6f8f2dfbc5
MATCH         : true
```

**What this establishes, beyond the bookkeeping question:** the on-chain attestation is not merely *adjacent* to those 100 proofs — it **cryptographically commits to exactly them, in exactly that order**. It is the first end-to-end confirmation that the anchoring pipeline's root construction, ordering, and on-chain payload all agree. Every field of the proposed backfill row is therefore chain-derived, not inferred.

**3e. Spot-audit: a RECORDED batch verifies the same way, at the other end of the run [V].** To rule out "the method happens to reproduce this one root," the same recomputation was run against the tail batch — the only 60-proof batch, `proof_id 78765…78824`, uid `0xa5a9971017f0f86a7cc24b2f91761f518945998fb46771d1060358ef89b66056`:

```
leaves     : 60
recomputed : 0x10bb760b7e140a231b9ba660c1dccbea609bb0da80645c8fae39efc0f3802e8f
DB merkle_root      : identical
on-chain root (eth_call getAttestation) : identical
```

Two batches now verified content-first — the **first** batch of the run (orphaned, 100 leaves) and the **last** (recorded, 60 leaves, which also exercises the odd-level duplicate-last rule at 15→8). Recomputed root, stored root, and on-chain root agree in both. This is a 2-of-220 sample, not a full audit — but it is the first evidence in this codebase that the EAS anchors commit to the *right content*, not merely that they exist.

*(Scripts: `scratchpad/recompute-batch-root.js`, `scratchpad/root2.js`, deliberately kept out of the repo — one-shot forensics, not maintained tools. Promoting the method to a committed `verify-anchor-batch.ts` would make a full 220-batch sweep a cheap, repeatable audit; queued, not built this beat.)*

---

## 4. The backfill — prepared, NOT executed

Attempted and **blocked by the environment's write classifier**; not worked around. It stays a Sean-GO item, which is also how Beat 25 framed it. Every *chain-derived* literal below is chain-verified per §3 (see the provenance table after the statement for which is which).

> **REVISED 2026-07-27 (Beat 28)** — two edits from Beat 27's independent verifier (finding B9), applied here so the statement is one-click for Sean. **(1)** The provenance prose no longer goes in the `error` column. **(2)** `proof_ids` is now ordered `created_at, id` to match the leaf-order contract by construction. Rationale for both is below the statement. Gap re-verified live at Beat 28: `batch_rows=219`, `sum(proof_count)=21,860`, `rows_with_error=0`, real UIDs `220` / real proofs `21,960`, `min(proof_id_min)=56938`, orphan not yet backfilled. **[V]**

```sql
-- Backfill the one lost audit row for EAS attestation 0x6f4486f8…03e0.
-- Provenance: audit row lost to the best-effort audit-insert failure on the FIRST batch of the
-- 2026-07-04/05 anchoring run (the exact failure mode documented in src/workers/eas-anchor-worker.ts).
-- The on-chain attest and the uid writeback both landed; only this bookkeeping row was lost.
-- Chain-derived fields: merkle_root, tx_hash, eas_uid, created_at  — from getAttestation(uid) + the
--   Attested log tx (block 43720707, receipt status 1); merkle_root additionally recomputed locally
--   from the 100 zk_commitments (keccak256 leaf/pair, selectBatch order) and matched exactly.
-- DB-derived fields: proof_id_min/max, proof_count, proof_ids (from repid_zkp_proofs).
-- Code-label fields: hash_scheme, eas_schema, status (constants the worker writes; NOT chain-derived).
-- Full write-up: reports/2026-07-26/BEAT26_EAS_BATCH_RECONCILIATION.md
insert into eas_anchor_batches
  (merkle_root, hash_scheme, tx_hash, eas_uid, eas_schema,
   proof_id_min, proof_id_max, proof_count, proof_ids, status, created_at)
select
  '0x9a1ae18b8ca2198184393a64ee39ac1fe6e6b50cc3c8848ce1ce7e6f8f2dfbc5',
  'keccak256',
  '0x444cb9bbff4dcb6ab48e0f81a98921f7049906ea21c086eb6f76197f4be7c6a8',
  '0x6f4486f84c4d782cb289a4bda14e5a67419bcdaf4d8ef65495fe95e1081a03e0',
  'repid-real-proof-batch-v1',
  56838, 56937, 100,
  (select array_agg(id order by created_at, id) from repid_zkp_proofs
     where eas_attestation_uid='0x6f4486f84c4d782cb289a4bda14e5a67419bcdaf4d8ef65495fe95e1081a03e0'),
  'anchored',
  '2026-07-05T00:01:42Z'::timestamptz
where not exists (
  select 1 from eas_anchor_batches
  where eas_uid='0x6f4486f84c4d782cb289a4bda14e5a67419bcdaf4d8ef65495fe95e1081a03e0');
```

**Field provenance — what is actually chain-proven, and what is not:**

| field | value | provenance |
|---|---|---|
| `merkle_root` | `0x9a1ae18b…fbc5` | **chain** (decoded from the attestation) **+ independently recomputed locally**, §3d |
| `tx_hash` | `0x444cb9bb…c6a8` | **chain** (`eth_getLogs` → receipt status 1, block 43720707), §3c |
| `eas_uid` | `0x6f4486f8…03e0` | **chain** (`getAttestation` → exists, `revocationTime=0`), §3b |
| `created_at` | `2026-07-05T00:01:42Z` | **chain** (on-chain attestation timestamp), §3b |
| `proof_id_min/max`, `proof_count`, `proof_ids` | 56838 / 56937 / 100 / … | **DB** (`repid_zkp_proofs` rows carrying that uid), §1 |
| `hash_scheme`, `eas_schema`, `status` | `keccak256`, `repid-real-proof-batch-v1`, `anchored` | **code labels** the worker writes — DB-corroborated against the other 219 rows, *not* chain-derived |

- **Additive, idempotent** (`where not exists`), **reversible** (`delete from eas_anchor_batches where eas_uid='0x6f4486f8…03e0';`).
- `batch_id` intentionally omitted → `gen_random_uuid()` default (§3c: the chain does not carry it — the uuid inside the attestation payload is the representative proof's `agent_id`, not a batch id).
- **Why `error` is now left NULL (verifier finding B9):** `error` is an *operational failure* field — `eas-anchor-worker.ts:276` writes it only on the `status='failed'` path, and **0 of 219 rows carry a non-NULL value [V]**. Putting provenance prose there would make this the table's only `status='anchored' AND error IS NOT NULL` row, which any "did a batch fail?" query reads as a failure. The batch did not fail; a *separate* bookkeeping insert did, 40 days earlier. Provenance instead lives in the SQL comment above, in this report, and in the loop ledger. **Trade-off stated honestly:** the row is then not self-marking as a backfill — the cost of not planting a false alarm in a monitored column. (The table has no metadata/notes column; `hash_scheme`/`eas_schema`/`status` are all load-bearing, so there is no honest third place to put it.)
- **Why `order by created_at, id` (verifier finding B9):** `selectBatch()` orders `ORDER BY created_at ASC, id ASC` (`eas-anchor-worker.ts:183`) and the worker stores `proof_ids` in exactly that order, so this makes the backfilled row match the leaf-order contract **by construction** rather than by coincidence. For this particular batch both orderings happen to produce the same array (Beat 27's verifier proved that), so this changes no value today — it removes a latent inconsistency, it does not fix a wrong one.
- Post-condition to check: `batch_rows = 220`, `sum(proof_count) = 21,960`, orphan query returns 0 rows.

**Recommendation: apply it.** Risk is as close to zero as a prod write gets — additive, guarded, reversible, every consequential value chain-proven, and **no code path reads this table** (re-confirmed repo-wide by Beat 27's verifier). The alternative is leaving a permanent 1-in-220 hole in the audit trail that certifies 21,960 proofs.

---

## 5. Correction to the standing anchor figures

Beat 24 corrected `INFRA_INVENTORY.md` §11 from "5 EAS anchors" to **225** (220 batch + 5 legacy stubs). That number came from `repid_zkp_proofs`' 220 distinct real UIDs and is **correct as written** — it is `eas_anchor_batches` (219) that is one short, not the anchor count. No doc change needed; recorded here so a future reader who finds 219 in the batch table does not "correct" 225 down to 224.

## 6. Scope / honesty notes
- **[V]** everything in §1–§4 above: reproduced by SQL against `qnnpjhlxljtqyigedwkb`, `eth_call`/`eth_getLogs`/`eth_getTransactionReceipt` against Base Sepolia, and a local recomputation.
- **[R]** the *reason* the very first audit insert failed (table not yet created vs. a transient error) is inferred from the worker's own comment naming "the exact 2026-07-04 failure mode" plus the 300 s timing — no log from 2026-07-04 was retrieved.
- Not attempted: recomputing the roots of the remaining 218 batches (2 of 220 done, §3d + §3e). The method now exists and would make a full sweep cheap if a complete audit is ever wanted.
