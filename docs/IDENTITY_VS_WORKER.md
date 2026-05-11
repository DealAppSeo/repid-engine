# Identity vs. Worker: The HyperDAG Architectural Boundary

In the HyperDAG Protocol, we make a fundamental distinction between an **Identity** and a **Worker**. Understanding this boundary is critical for developers building on the testnet.

## The Core Distinction

### 1. Identity (The Reputation Anchor)
*   **Definition**: A persistent row in the `repid_agents` table.
*   **On-Chain Representation**: An ERC-8004 NFT minted on the canonical Identity Registry (`0x8004A818...`).
*   **Properties**:
    *   Has a **RepID Score** (0-9999).
    *   Has a **Tier** (Probationary, Earning, Established, Veteran, Autonomous).
    *   Acts as the anchor for all historical trust signals.
*   **State**: Can exist without any active compute. If no signals are received, the Identity enters **Reputation Decay**, and its RepID score will drift downward over time.

### 2. Worker (The Cognitive Engine)
*   **Definition**: A live service (e.g., a Railway service like `trinity-sophia`) running the agent's cognitive code.
*   **Action**: Performs tasks, makes decisions, and generates "Wisdom" signals.
*   **Wisdom**: A worker's primary job is to generate high-quality decisions that finalized into RepID score increases for its associated Identity.
*   **Multi-tenancy**: A single worker *can* serve multiple identities (though for v1 launch, we prioritize a 1:1 mapping for our flagship Trinity agents).

---

## Why the Split?

This architecture solves three specific problems for the Agentic Web:

1.  **Fault Tolerance**: If a worker service goes down, the agent's **Identity** (and its hard-earned reputation) remains safe on-chain. You can spin up a new worker, point it at the same Identity, and resume operation.
2.  **Trust-Minimized Transition**: An agent's identity can be sold, transferred, or "hired" by different compute providers without losing its historical proof-of-work.
3.  **Reputation Decay (Proof of Liveness)**: By separating identity from worker, we can measure liveness. An identity that isn't actively backed by a worker producing valid signals will naturally lose its "Veteran" status. **Reputation must be maintained.**

---

## V1 Launch Constraints (Path A)

For the HyperDAG v1 soft launch:
*   **Path A**: Only Identities backed by a verified, live **Worker** are eligible for Spokesperson roles and official on-chain minting.
*   **Flagship Agents**: SOPHIA, VERITAS, CHESED, and SHOFET are the first wave of identities fully backed by Trinity workers.
*   **Bench-Warmers**: Other identities (e.g., ORACLE, MENTOR) exist in the database but will not be minted until Path B (lightweight personality workers) is deployed in v1.x.

---

## Integration for Developers

When calling the API, you are usually interacting with a **Worker** to get a decision, but you are verifying the **Identity's** RepID score to decide if you trust that decision.

*   **To lookup an Identity**: `GET /api/v1/agents/:id/card`
*   **To request a decision from a Worker**: `POST /api/v1/agents/:id/score-event` (proxied through the HAL pipeline).

---
*HyperDAG Protocol — The math of trust.*
