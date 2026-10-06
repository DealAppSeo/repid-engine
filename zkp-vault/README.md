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

## Correctness gate (proven FIRST). `cargo test` → 7/7

| test | proves |
|---|---|
| `valid_owner_accepts` | a real owner proof verifies |
| `forged_nullifier_rejected` | a wrong nullifier does **not** verify |
| `non_member_is_unprovable` | a non-member (secret not in group) **cannot** prove |
| `tampered_proof_rejected` | flipping a proof byte → rejected |
| `unlinkable_across_contexts` | same human, two contexts → different nullifiers; nothing else links them |
| `double_action_detectable_in_context` | same `(human, context)` → identical nullifier |
| `bench_prove_verify` | timing/size |

## Benchmark

```
MiMC era (release; R=12, group=4, height=8):  prove = 8.2 ms   verify = 1.0 ms   proof = 8854 bytes
Poseidon2, measured 2026-10-06 via zkpv:      prove (whole process) ≈ 6 ms        proof = 19,735 bytes
```
The first line predates the move to Poseidon2 and is kept as history, not as the current figure.

## Hash & config
- In-AIR **Poseidon2** over BabyBear (width 16, S-box `x^7`, 4+4 full and 13 partial rounds,
  Horizen-Labs constants), from the audited `p3-poseidon2-air` 0.3.0 gadget; the off-circuit
  `poseidon2_hash2::h_p2_field` and its KAT are gated against it. This replaced an earlier
  hand-written MiMC (this line said MiMC until 2026-10-06, after the code had moved on).
- **Zero-knowledge** via the hiding FRI PCS (`HidingFriPcs` + `MerkleTreeHidingMmcs`),
  reused from PR #95. `log_blowup=3` so the LDE covers the degree-7 quotient domain.

## API
```rust
let group = [commitment(11,101), commitment(secret, agent_id), commitment(33,303), commitment(44,404)];
let proof = prove_ownership(secret, agent_id, context, &group);   // secret, agent_id are private
verify_ownership(&proof, context, nullifier(secret, context), &group).unwrap();
let bytes = proof_to_bytes(&proof);   // -> the bridge's `proof_bytes`
```

## Command line: `zkpv` (2026-10-06)

`cargo build --release` builds `target/release/zkpv`, a JSON front end over the API above, so a
script can produce and check the evidence an ERC-8004 Validation Registry request carries:

```
zkpv commit <secret> <agent_id>                        -> {"commitment":N}
zkpv nullifier <secret> <context>                      -> {"nullifier":N}
zkpv prove <secret> <agent_id> <context> <c0,c1,c2,c3> -> {"context","nullifier","group","proof"}
zkpv verify < request.json                             -> {"ok":true|false}   exit 0 / 1 / 2
```

`npm run demo:human-backed` (repo root) runs it end to end: a validationRequest / validationResponse
pair with keccak256 hashes, plus reuse, unlinkability, tamper and non-member checks. CI runs the
demo on every PR (`zkp-vault` job). `tests/zkpv_cli.rs` pins the binary.

## Honest scope / next steps (NOT done here)
1. **Group membership** uses a vanishing-polynomial product over a small public set
   (degree = group size). Production should use a **Merkle tree** (log-depth path) for
   large groups.
2. **Field size** — the hash is Poseidon2 now, but inputs and the nullifier are single BabyBear
   elements (~31 bits), so a nullifier's preimage is brute-forceable. Production needs a larger
   field or multi-element encodings.
3. **FRI** uses small test-grade params (`log_blowup=3`, `num_queries=2`): right for the
   gate/benchmark, **not** production soundness.
4. **HTTP wrapper** — `POST /prove/ownership` returning `{ proof_bytes }` so the TS bridge
   (`PLONKY3_PROVER_URL`) can call it. (Current TS contract is `/prove/trade_auth`; add the
   ownership endpoint, don't repurpose.)
5. **Court-order reveal (D-020)** — the human↔commitment link is sealed off-circuit
   (encrypted to a custodian/court key); this circuit proves control anonymously, the
   reveal is a custodian decryption gated by court order. No circuit change.

This supersedes the earlier RepID-range statement (PR #95) per D-019.
