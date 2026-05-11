# HyperDAG Protocol Roadmap — 2026

This roadmap outlines the journey of the HyperDAG Protocol from its v0.1 "Soft Launch" to a fully decentralized trust layer for the Agentic Web.

## Phase 1: Foundations (May 2026 - CURRENT)
**Status: Shipped / Live**

The core infrastructure for verifiable agent reputation.
*   ✅ **HAL Pipeline**: Cross-LLM hallucination detection with Pythagorean Comma scaling.
*   ✅ **Plonky3 STARKs**: Real zero-knowledge proofs for agent reputation scores.
*   ✅ **ERC-8004 Integration**: Identity Registry and Reputation Registry live on Base Sepolia.
*   ✅ **x402 Facilitator**: Payment-gated premium recall service for Graph RAG.
*   ✅ **BYOK (Bring Your Own Key)**: User-side encrypted API key storage.
*   ✅ **Local Verification**: WASM-based client-side STARK verification in the TrustShell SDK.

## Phase 2: Ecosystem Expansion (Q3 2026)
**Status: Next**

Making the protocol useful for more than just Trinity agents.
*   **Path B Personality Workers**: Enabling lightweight workers for "bench-warmer" identities.
*   **Public Agent Portal**: SEO-optimized public profiles for every minted agent ID.
*   **Cost-Tracking Dashboard**: Detailed analytics for BYOK users and premium recall consumers.
*   **Multi-Key Management**: Support for multiple API keys per provider with named slots.
*   **Validator Marketplace**: Opening the HAL pipeline to third-party hallucination checkers.

## Phase 3: Governance & Decentralization (Q4 2026)
**Status: Exploring**

Transitioning decision-making to the community.
*   **GOVERNANCE.md Publication**: Formalizing the transition from founder-bootstrapped to community-led.
*   **Reputation-Weighted Voting**: Initial Snapshot voting for RetroPGF allocations.
*   **Quadratic Voting**: Implementation of QV for bug bounties and ecosystem grants.
*   **Slashing Mechanics**: Collateral-backed workers with economic penalties for proven fabrications.

## Phase 4: Full v1.0 (2027)
**Status: Future**

*   **Three-Branch Council**: Sortition, Technical Merit, and Stakeholder branches live.
*   **Cross-Chain Reputation**: Expanding ERC-8004 registries to 25+ L2s and sidechains.
*   **Autonomous Evolution**: Agents capable of proposing their own governance changes based on performance metrics.

---

## Technical Targets

| Metric | v0.1 Target | v1.0 Target |
| :--- | :--- | :--- |
| **Verification Latency** | < 200ms (WASM) | < 50ms (Hardware accelerated) |
| **F1 Score (Hallucination)** | 0.86 | > 0.95 |
| **Proof Size** | 17 KB | < 2 KB |
| **Throughput** | 100 req/sec | 10,000+ req/sec |

---
*HyperDAG Protocol — The math of trust.*
