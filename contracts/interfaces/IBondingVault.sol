// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * IBondingVault — interface/spec ONLY (no implementation, no deploy).
 *
 * Sprint 2026-05-28 Phase 4. On-chain counterpart to the off-chain stake loop
 * wired this sprint (src/services/stake-vault.ts + stake-capability-bridge.ts):
 *   deposit → authority snapshot → per-agent capability cap → slash-on-dispute.
 *
 * Authority formula + RepID floor: GATED on XC Phase 4
 * (XC_HUMAN_OWNERSHIP_ZKP_DESIGN.md): authority = sqrt(stake) * log10(max(repId,1)),
 * RepID floor >= 500 to participate (>= 2000 for high tiers). The off-chain
 * code currently uses the pre-existing reponomics formula (stakeSqrt * R*W*C /
 * 500000, builder floor 5000) — reconciling the two is a Sean/XC decision
 * flagged in the report; this interface encodes XC's canonical floor semantics.
 *
 * DEPLOY DEFERRED TO SEAN. USDC amounts are 6-decimal raw (100 USDC = 1e8).
 */
interface IBondingVault {
    event StakeDeposited(uint256 indexed agentId, uint256 amount, uint256 authorityAfter);
    event StakeWithdrawn(uint256 indexed agentId, uint256 amount, uint256 authorityAfter);
    event StakeSlashed(uint256 indexed agentId, uint256 amount, uint256 indexed claimId);

    /// Bond stake for an agent. Reverts if the staker's RepID is below the
    /// participation floor (XC Phase 4: >= 500).
    function deposit(uint256 agentId, uint256 amount) external;

    /// Withdraw unlocked stake. Reverts while any stake is locked to an open claim.
    function withdraw(uint256 agentId, uint256 amount) external;

    /// Slash bonded stake on a dispute loss / RepID slash and lock the remainder
    /// to `claimId` (one-way valve until the dispute resolves). Authorized caller
    /// only (the dispute/slash module). Mirrors slashAgentStake() off-chain.
    function slash(uint256 agentId, uint256 claimId, uint256 amount) external;

    /// Authority = f(stake, RepID) with the RepID floor applied (0 below floor).
    function authorityOf(uint256 agentId) external view returns (uint256);

    /// Per-transaction ceiling derived from authority (maps to
    /// repid_agent_stakes.max_transaction_usdc off-chain).
    function maxTransactionUsdc(uint256 agentId) external view returns (uint256);

    /// Bonded total and the amount currently locked to a claim.
    function bondedStake(uint256 agentId) external view returns (uint256 total, uint256 lockedForClaimId);
}
