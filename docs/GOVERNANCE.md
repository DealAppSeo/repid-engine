# HyperDAG Protocol — Governance Framework

HyperDAG is transitioning from a founder-bootstrapped prototype to a community-governed public good. This document outlines the principles and mechanisms that ensure the protocol remains neutral, secure, and aligned with its mission.

## 1. Principles
*   **Math over Trust**: Reputation is earned through verifiable proofs, not social consensus.
*   **Skin in the Game**: High-value decisions require collateral or proven technical merit.
*   **Anti-Sybil by Design**: Governance must resist plutocracy (capture by capital) through non-financial reputation signals.
*   **Transparency**: Every protocol change must be debated in the open.

## 2. Transition Phases

### Phase 1: Founder Bootstrap (May - August 2026)
*   **Status**: Active.
*   **Authority**: Sean Goodwin (Founder) retains unilateral decision rights over the core API and architecture.
*   **Goal**: Rapid iteration and architectural coherence during soft-launch.

### Phase 2: Reputation-Weighted Influence (August - November 2026)
*   **Mechanism**: Snapshot voting.
*   **Eligibility**: Holders of Veteran-tier RepID Identities and core code contributors.
*   **Scope**: Parameter tuning (e.g., HAL thresholds) and non-critical roadmap priorities.

### Phase 3: Three-Branch Council (2027)
The final governance state of the protocol:
1.  **Technical Merit (Devs)**: Elected by contributors. Focus on security and performance.
2.  **Resource Providers (Stakers)**: Stake-weighted voting. Focus on economic stability and throughput.
3.  **User Advocacy (Sortition)**: Randomly selected verified users. Focus on accessibility and mission alignment.

## 3. Specific Mechanisms

### Quadratic Voting (QV)
HyperDAG uses Quadratic Voting for **grant allocations** and **bug bounties**. This ensures that broad community support outweighs concentrated capital, preventing "whales" from dominating the resource allocation process.

### RepID-Gated Earning
Governance participation is directly linked to an agent's (or developer's) **RepID score**. 
*   **Veteran/Autonomous** status provides higher voting weight in the Technical Merit branch.
*   **Reputation Decay** ensures that dormant participants lose their influence over time.

### Slashing & Dispute Resolution
In the event of a "proven fabrication" (a high-certainty decision proven false by the HAL pipeline), the associated worker's collateral is slashed.
*   **Dispute Pool**: Slashed funds are moved to a community-managed pool.
*   **RetroPGF**: The community votes on distributing this pool to researchers who identified the failure mode.

---

## 4. How to Participate
1.  **Issues & RFCs**: Every major change starts as an RFC (Request for Comments).
2.  **RepID Accumulation**: Build high-quality agents that produce verifiable wisdom signals.
3.  **Code Contributions**: Technical merit is the fastest path to governance influence.

---
*"Whatever is true, whatever is noble, whatever is right..." — Philippians 4:8*
