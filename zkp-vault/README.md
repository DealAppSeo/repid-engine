# zkp-vault — real Plonky3 ZK vault for RepID

Replaces the TypeScript Plonky3 **stub** (`src/zkp/plonky3-stub.ts`, `plonky3-real.ts`)
with a **genuine STARK**. Per the sprint: the TS bridge stays as the interface/contract;
this crate is the real cryptography behind it.

## The statement (the one concrete RepID-tier case)

> Prove an agent's RepID **tier is valid without revealing its exact score.**

- **Public inputs:** the claimed tier's bounds `(tier_lo, tier_hi)`.
- **Private witness:** the exact `score` — never enters `public_values`, never disclosed.
- **What the proof shows:** the prover knows a `score` with `tier_lo ≤ score ≤ tier_hi`.

Range is enforced by proving `score − tier_lo` and `tier_hi − score` are each a sum of
`K=14` boolean bits (each ∈ `[0, 2^14)`); RepID ∈ `[0, 10000] < 2^14`, and `2^14 ≪ p`
(BabyBear `p ≈ 2^31`), so there is no field wraparound. Zero-knowledge comes from the
**hiding** FRI PCS (`HidingFriPcs` + `MerkleTreeHidingMmcs`) — the construction Plonky3
ships in its own `test_zk`.

## Correctness gate (proven FIRST, before anything depends on it)

`cargo test` — 6/6:

| test | proves |
|---|---|
| `valid_proof_accepts` | a truthful proof **verifies** |
| `boundary_scores_accept` | tier edge values verify |
| `false_claim_rejected` | a proof built for ESTABLISHED **fails** when checked against VETERAN bounds |
| `tampered_proof_rejected` | flipping a proof byte → **rejected** (bad deserialize or failed verify) |
| `false_witness_is_unprovable` | an out-of-range score **cannot be proven** (constraints reject it) |
| `bench_prove_verify` | timing/size |

## Benchmark (release, BabyBear, K=14, height=8)

```
prove = 1.2 ms   verify = 0.2 ms   proof = 5254 bytes
```

## API

```rust
let (lo, hi) = tier_bounds("ESTABLISHED").unwrap();
let proof = prove_tier(1500, lo, hi);          // 1500 is private
verify_tier(&proof, lo, hi).unwrap();          // verifier learns only lo,hi
let bytes = proof_to_bytes(&proof);            // -> the bridge's `proof_bytes`
```

## Honest scope / next steps (NOT done here)

1. **Production FRI params.** Uses `create_test_fri_params` (low blowup) — right for the
   correctness gate + benchmarking, **not** production soundness. Swap for real params.
2. **Commitment binding.** Add a Poseidon2 commitment `C = H(score, salt)` as a public
   input so the proof is bound to the agent's *actual* recorded score, not just *some*
   in-range score. (The range core is done; this binds it to external state.)
3. **HTTP wrapper.** Expose `POST /prove/tier_range` returning `{ proof_bytes }` so the
   existing TS bridge (`PLONKY3_PROVER_URL`) can call it. Note: the current TS contract is
   `/prove/trade_auth` (a different statement) — add the tier endpoint, don't repurpose it.
4. **Recursion.** Aggregate many tier proofs into one recursive proof for batch anchoring.
5. **Base Sepolia anchor.** Anchor the aggregate root on-chain (needs the funded
   `EAS_ATTESTER_PRIVATE_KEY` — currently a known blocker).

The TS stub remains the interface; this crate is the cryptography the stub will call.
