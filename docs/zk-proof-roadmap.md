# RepID ZK Proof Generation & Verification Roadmap

This document outlines the evolutionary path for the Zero-Knowledge Proof (ZKP) system inside `repid-engine`.

---

## 1. Phase 1: HMAC stubs (V1 Launch)
- **Status**: Completed.
- **Proof Generation**: Deterministic base64 HMAC-SHA256 signature calculated from agent ID, requester pubkey, tier, and timestamp.
- **Proof Source Label**: `hmac_fallback`.
- **Proof Format**: `plonky3-babybear-stub-v1`.
- **Characteristics**: Fast, lightweight, zero infrastructure cost. Used for development and non-mainnet testing where computational overhead is not justified.

## 2. Phase 1.5: TS Wrapper Integration & Prover Failover (V1.5 Soft Launch)
- **Status**: Completed (Scaffolded).
- **Proof Generation**: Refactored the `/prove-repid` router to consume a decoupled TypeScript wrapper interface in `src/zk-proof/prover.ts`.
- **Proof Source Label**: Dynamically maps to `plonky3_real` or `hmac_fallback` depending on whether the real prover URL is set and reachable.
- **Prover Client**: Bridges to the Rust-based HTTP prover at `PLONKY3_PROVER_URL` with a 5-second connection timeout, retrying once on network failures before falling back to HMAC.

## 3. Phase 2: Plonky3 Rust Prover Integration (V2)
- **Status**: Backlog.
- **Goal**: Full migration of proof generation to the client side or a dedicated local prover microservice executing Plonky3 STARK proofs.
- **Architecture**:
  - Integrate Rust crate containing the custom RepID circuit directly via FFI (Node Native Addons) or as a local CLI binary to avoid network round-trip overhead.
  - Verification: Use the `@hyperdag/proof-verifier` package to verify Plonky3 proofs within the engine's routes without external dependencies.
- **Proof Format**: `plonky3-real-v1`.
- **Proof Source Label**: `plonky3_real`.

## 4. Phase 3: Quantum-Resistant & Optimizations (V3)
- **Status**: Future.
- **Goal**: Transition circuits to quantum-resistant SNARKs/STARKs and apply folding schemes (e.g. Nova/Sangria) for sub-second recursive proof generation.
