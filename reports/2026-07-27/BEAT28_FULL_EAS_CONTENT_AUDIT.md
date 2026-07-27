# Beat 28 — the full EAS anchor set, content-verified: 220/220, on-chain

**Date:** 2026-07-27 · **Author:** CC (autonomous build loop, Beat 28) · **Type:** audit tooling + full sweep (read-only)
**Queued by:** Beat 26's "not attempted" note and Beat 27's next-beat item (3) — *"promote the merkle-root recomputation into a committed `verify-anchor-batch` script — a full 220-batch content audit as one command; only 2 of 220 are content-verified today."*

## Prior-art check (Beat 24's standing lesson)

`grep -rl "eas_anchor_batches\|merkle" reports/` → the anchoring lineage is Beat 8 → Beat 24 → Beat 26, each adding a layer:

| beat | what it established | what it did **not** |
|---|---|---|
| **Beat 8** | `eas_anchor_batches` has 219 rows, all `status='anchored'` | never left the DB — the anchoring evidence was the table's own `status` column |
| **Beat 24** | the attestations **exist on chain** (20 UIDs `eth_call`'d, negative control ABSENT) | never asked *what they commit to*; worked from `repid_zkp_proofs` only, so the 219-vs-220 gap was invisible |
| **Beat 25's verifier** | found the 219-vs-220 gap by cross-referencing the two tables | — |
| **Beat 26** | root-caused the orphan; recomputed **2** roots (one 100-leaf, one 60-leaf) and matched them on chain | left **218 of 220** batches content-unverified, and the method was a one-off script |
| **Beat 27's verifier** | independently re-derived both of Beat 26's roots in its own code | same 2-of-220 coverage |

**This beat is the generalisation:** the method becomes a committed command, and the coverage goes from 2/220 to **220/220**. That is net-new — no prior beat swept the set.

---

## 1. What "content-verified" means here

Existence is not integrity. Every prior beat proved an attestation *is there* and *is un-revoked*. None proved it commits to the **right** proofs. Three independent levels per batch, all implemented in `scripts/diag/verify-anchor-batch.ts`:

| level | question it answers | oracle |
|---|---|---|
| **L1 RECOMPUTE** | does the stored `merkle_root` actually equal a root rebuilt from these proofs' `zk_commitment` values? | re-derivation using the production builder `rootFromCommitments` (`src/zkp/merkle-root.ts`), the batch's own `hash_scheme`, and the worker's leaf order `created_at ASC, id ASC` (`eas-anchor-worker.ts:183`) |
| **L2 MEMBERSHIP** | is the stored `proof_ids` array exactly the set of proofs carrying this `eas_attestation_uid` — no extras, none missing, count agreeing? | `repid_zkp_proofs`, set-compared both directions |
| **L3 ON-CHAIN** | does the **attestation's own payload** carry that root, from an un-revoked attestation by the expected attester? | `eth_call getAttestation(uid)` on Base Sepolia, payload ABI-decoded per `eas-attestation-service.ts:60` (`['string','string','bytes32','uint256','string','uint64']`, index 2 = `merkleRoot`) |

L1 + L2 together upgrade *"an attestation sits next to these proofs"* into *"this attestation cryptographically commits to exactly these proofs, in this order."* L3 closes it against the chain rather than the DB's own say-so (CLAUDE_RULES r1).

## 2. The negative control — run first, because a check that cannot fail proves nothing

`--negative-control` drops each batch's **last leaf** before recomputing. Every batch must then be rejected; a green negative control would mean the comparison is broken and the normal run's ✅ is empty.

```
$ npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts --limit 5 --negative-control
  ✗ 0x10e540d0…71f0  (2026-07-05T00:26:45Z, 100 proofs)
      RECOMPUTE: MISMATCH recomputed=0x84e93811… stored=0xdf3800cd…
  MEMBERSHIP      : 5 pass / 0 FAIL       ← correctly unaffected: membership is a set check, not a hash
  RECOMPUTE       : 0 pass / 5 FAIL
  NEGATIVE CONTROL: ✅ all 5 rejected — the check discriminates.     (exit 0 under inverted semantics)
```

Dropping a leaf rather than flipping a byte is deliberate: it also exercises the odd-level *duplicate-last* rule, which is where a Bitcoin-style tree is most likely to silently agree with itself. **[V]**

## 3. The sweep — 220/220 [V]

```
$ npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts            # 219 recorded batches
  batches checked : 219
  MEMBERSHIP      : 219 pass / 0 FAIL
  RECOMPUTE       : 219 pass / 0 FAIL

$ npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts --onchain  # + the chain leg
  batches checked : 219
  MEMBERSHIP      : 219 pass / 0 FAIL
  RECOMPUTE       : 219 pass / 0 FAIL
  ONCHAIN         : 219 pass / 0 FAIL
  VERDICT         : ALL CONTENT-VERIFIED ✅

$ npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts --orphans --onchain
  batches checked : 1
  RECOMPUTE       : 1 pass / 0 FAIL
  ONCHAIN         : 1 pass / 0 FAIL
```

**219 recorded + 1 orphan = 220/220.** Every batch's stored root is reproducible from its proofs' commitments; every batch's `proof_ids` is exactly the uid's proof set; and every one of the 220 on-chain attestations carries that same root, from attester `0x4f8ad3fb…04fb`, with `revocationTime = 0`.

**What this actually licenses saying:** the EAS anchor set covering **21,960 real Plonky3 proofs** is now proven — not asserted — to commit to exactly those proofs. Previously that claim rested on a 2-batch spot check and 219 rows of the DB's own `status` column.

### 3a. The orphan, re-verified independently

The orphan (`0x6f4486f8…03e0`, the batch with no audit row — Beat 26 §1) has **no stored root**, so the chain is the only oracle. The script reconstructs its leaf set from `repid_zkp_proofs` in the worker's canonical order, recomputes, and matches the on-chain payload. This is a third independent confirmation of Beat 26's §3d result (Beat 26 → Beat 27's verifier → here), and it is what makes the backfill statement's `merkle_root` literal safe to run.

## 4. The tool

`scripts/diag/verify-anchor-batch.ts` — read-only, no writes, no DDL, no key handling (the chain leg is `eth_call` only). Exit 1 on any mismatch, so it can gate CI later.

```bash
npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts                 # all, DB-side
npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts --onchain       # + chain leg
npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts --sample 20     # even spread, not head-only
npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts --orphans --onchain
npx ts-node --transpile-only scripts/diag/verify-anchor-batch.ts --negative-control
```

`--sample` spreads evenly across the run rather than taking the first N — a head-only sample would only ever exercise the batches written closest to whatever failure is being investigated.

## 5. Honesty / scope notes

- **[V]** everything in §2–§3: run against `qnnpjhlxljtqyigedwkb` and Base Sepolia, outputs pasted verbatim above. The negative control was run **before** the sweep, not after, and is committed alongside it so the next person can re-arm it.
- **[V]** the L1 recomputation uses the *production* builder, not a reimplementation. That is deliberate — it verifies the **data**, not the builder. A bug inside `rootFromCommitments` itself would be invisible to L1 and L2. **L3 is what covers that hole**: the on-chain root was written by the worker at anchoring time and is compared against a root computed by today's code, so a subsequent regression in the builder would break L3 across the board.
- **[R]** the payload's non-root fields (`agentId`, `tier`, `proofType`, `proofId`) are decoded but **not** asserted — the representative-proof semantics of those fields is the trap Beat 26 documented (the uuid is the proof's `agent_id`, not a batch id). Only the `merkleRoot` field is treated as load-bearing.
- Not attempted: verifying that the 21,960 proofs are themselves *valid* Plonky3 proofs. This audit proves the anchor set commits to the right **rows**; it says nothing about whether each row's `proof_bytes` verifies. That is a separate, much larger sweep.
- The `eas_anchor_batches` bookkeeping gap is **still open** — this beat confirms the orphan is real and correctly anchored, but the missing audit row remains a Sean-GO prod write (see `reports/2026-07-26/BEAT26_EAS_BATCH_RECONCILIATION.md` §4, revised this beat).
