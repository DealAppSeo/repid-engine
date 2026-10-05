# zkp-vault — anonymous-ownership ZK vault (Plonky3)

Replaces the TypeScript Plonky3 **stub** (`src/zkp/plonky3-stub.ts`, `plonky3-real.ts`)
with a **genuine STARK**. The TS bridge stays as the interface/contract; this crate is
the real cryptography behind it.

## Statement: **human-anonymous ownership** (NOT reputation) — D-019 / D-020

Per DECISION_LOG **D-019**: RepID reputation is **public** on-chain (ERC-8004), so proving
it in ZK is redundant. The real need is to prove a human **controls** an agent **without
revealing which human**, with a court-order-only reveal (**D-020**). This is a
Semaphore-style proof. **No reputation values appear in the circuit.**

- **Public inputs:** `context`, a `nullifier`, the group's public commitment set `{C_0..C_{M-1}}`.
- **Private witness:** owner `secret`, `agent_id` — never revealed.
- **Proof shows:**
  1. `leaf = H(secret, agent_id)` ∈ `{C_j}` via `∏_j (leaf − C_j) = 0` — controls a
     *registered* identity **without disclosing which one**;
  2. `nullifier = H(secret, context)` is correctly derived.

### Nullifier (P1.2)
`nullifier = H(secret, context)`, one per `(human, context)`:
- **Unlinkable across contexts** — different context ⇒ different nullifier; the leaf never
  enters the public inputs, and the only shared public value is the group set (common to
  all members).
- **Double-action detectable within a context** — same `(secret, context)` ⇒ same
  nullifier, so a registry can reject a repeat.

## Correctness gate (ownership AIR). `cargo test --lib` → 48

The 48 lib tests include 7 ownership-AIR gates, plus the ordering-check, Merkle-path,
non-membership, and depth-D non-membership modules added in Item 14 (steps 14.0-a–14.0-d,
PRs #1189/#1198/#1200/#1201). External KAT test binaries add 15 more (6+3+6).

Key ownership gates (original 7, still green):

| test | proves |
|---|---|
| `valid_owner_accepts` | a real owner proof verifies |
| `forged_nullifier_rejected` | a wrong nullifier does **not** verify |
| `non_member_is_unprovable` | a non-member cannot prove (debug profile) |
| `tampered_proof_rejected` | flipping a proof byte → rejected |
| `unlinkable_across_contexts` | same human, two contexts → different nullifiers |
| `double_action_detectable_in_context` | same `(human, context)` → identical nullifier |
| `bench_prove_verify` | timing/size |

## Benchmark (release; BabyBear, Poseidon2, group=4, height=8)

```
prove = ~5.3 ms   verify = ~1.0 ms   proof = ~19 734 bytes   trace_width = 299
```

(Increased from MiMC's 8.2 ms / 8854 B because Poseidon2Air has 299 columns vs 27.
FRI amortizes width well — proof size grows far less than trace.)

## Hash & config
- In-AIR **Poseidon2-BabyBear** (width-16, audited Horizen-Labs round constants) via
  the `p3-poseidon2-air` 0.3.0 gadget — **not hand-rolled**. `H_p2(a,b) = Perm16([a,b,0…])[0]`.
  Replaced MiMC in Beat 25 / backlog 4.0-d.3 (PR #199, 2026-07-26). [MEASURED 2026-10-05]
- **Zero-knowledge** via the hiding FRI PCS (`HidingFriPcs` + `MerkleTreeHidingMmcs`),
  reused from PR #95. `log_blowup=3` (conservative — Poseidon2 degree ≤ 3, vs MiMC's 7).

## Additional modules (Item 14)

- **`ordering_check`** — prove `low < target < high` in BabyBear (14.0-a, PR #1189).
- **`merkle_path`** — prove `H_p2(left, right) = root` at one level (14.0-b, PR #1198).
- **`non_membership`** — prove `target ∉ Merkle_tree(root)`: 1 ordering + 2 Merkle-path STARKs (14.0-c, PR #1200).
- **`non_membership_depth_d`** — depth-D extension: 1 + 2D STARKs (14.0-d, PR #1201).

## API
```rust
let group = [commitment(11,101), commitment(secret, agent_id), commitment(33,303), commitment(44,404)];
let proof = prove_ownership(secret, agent_id, context, &group);   // secret, agent_id are private
verify_ownership(&proof, context, nullifier(secret, context), &group).unwrap();
let bytes = proof_to_bytes(&proof);   // -> the bridge's `proof_bytes`
```

## Honest scope / next steps (NOT done here)
1. **Group membership** uses a vanishing-polynomial product over a small public set
   (degree = group size). Production should use a **Merkle tree** (log-depth path) for
   large groups.
2. **Hash** — MiMC over BabyBear is ~field-size security. Production: **Poseidon2** over a
   larger field, audited round count/constants.
3. **FRI** uses small test-grade params (`log_blowup=3`, `num_queries=2`): right for the
   gate/benchmark, **not** production soundness.
4. **HTTP wrapper** — `POST /prove/ownership` returning `{ proof_bytes }` so the TS bridge
   (`PLONKY3_PROVER_URL`) can call it. (Current TS contract is `/prove/trade_auth`; add the
   ownership endpoint, don't repurpose.)
5. **Court-order reveal (D-020)** — the human↔commitment link is sealed off-circuit
   (encrypted to a custodian/court key); this circuit proves control anonymously, the
   reveal is a custodian decryption gated by court order. No circuit change.

This supersedes the earlier RepID-range statement (PR #95) per D-019.
