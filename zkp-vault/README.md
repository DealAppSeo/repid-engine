# zkp-vault — Plonky3 ZK vault for HyperDAG RepID

Real Plonky3 STARKs behind the TypeScript Plonky3 stub (`src/zkp/plonky3-stub.ts`,
`plonky3-real.ts`). Three statements, one shared production hiding-FRI config.

| module | statement | canon |
|---|---|---|
| `ownership` (lib root) | **human-anonymous ownership** — control a registered agent identity without revealing which human; per-context nullifier | D-019a (priority), D-020 |
| `selective_disclosure` | **`earned ≥ X` AND healthy gap** (`perceived ≤ earned + band`) without revealing earned/perceived/gap | D-030 |
| (parked, PR #95) | tier-range "tier ≥ X without revealing the score" | D-019a (PARKED, retained) |

Per **D-019a** the tier-range proof is **retained and parked** (PR #95) as a
selective-disclosure capability; `selective_disclosure` here is its D-030-justified
generalization (multi-dimensional RepID: earned / perceived / gap).

## Production config (P1.1)
`make_config` uses production hiding-FRI params — `log_blowup=3` (required: the
degree-7 MiMC quotient needs it), `num_queries=28`, `proof_of_work_bits=16`
≈ **100-bit conjectured security** (test params were ~7-bit). ZK via `HidingFriPcs` +
`MerkleTreeHidingMmcs`. Field BabyBear; MiMC S-box `x^7` (minimal permutation
exponent: `p−1 = 2^27·3·5`).

## Correctness gate — `cargo test` → 13/13
**Ownership (7):** valid accept · forged-nullifier reject · non-member unprovable ·
tampered reject · **unlinkable across contexts** · double-action detectable · bench.
**Selective disclosure (6):** accept above-threshold+healthy · accept perceived-within-band ·
**reject below-threshold** · **reject over-perceived gap** · reject wrong-policy · reject tampered.

## On-chain anchor (P1.3) — REAL, Base Sepolia
`cargo run --release --example emit_ownership_proof` → `proof.bin`, then
`node scripts/zkp/anchor-ownership-base-sepolia.cjs --proof proof.bin --context 9001 --nullifier <N>`
anchors `keccak256(abi.encode(context, nullifier, keccak256(proofBytes)))` as a
self-tx and verifies the on-chain calldata back.

Verified anchor (chainId 84532):
- tx `0xfffa1f4faa7a10d1bbae41dcfa4b1e19cc0db8588bded2d8f0623a360cb0f90f` (block 42467884, status 1)
- https://sepolia.basescan.org/tx/0xfffa1f4faa7a10d1bbae41dcfa4b1e19cc0db8588bded2d8f0623a360cb0f90f

## Nullifier registry + double-action (P1.2)
`migrations/2026-06-05-nullifier-registry.sql` (staged for Sean/XC): a
`nullifier_registry` table with `UNIQUE(context, nullifier)` + `register_nullifier()`
returning false on a double-action. Detection proven live on a temp table mirroring
the constraint: same nullifier across **different** contexts is allowed (unlinkable);
the **same** `(context, nullifier)` is rejected (`23505`).

## Honest scope / next steps
- Bind proofs to the agent's *recorded* values via a Poseidon2 commitment public input
  (range/ownership cores done; this ties them to external state).
- Merkle membership for large ownership groups (vs the current vanishing-product set).
- Poseidon2 hash (vs MiMC) over a larger field; audited round constants.
- `/prove/ownership` + `/prove/disclosure` HTTP wrappers behind the TS bridge.
- Court-order reveal (D-020): custodian-sealed human↔commitment link, off-circuit.
