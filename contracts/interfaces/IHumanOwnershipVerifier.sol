// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * IHumanOwnershipVerifier — interface/spec ONLY (no implementation, no deploy).
 *
 * Sprint 2026-05-28 Phase 4. GATED on XC's design:
 *   E:\dev\reports\2026-05-28\XC_HUMAN_OWNERSHIP_ZKP_DESIGN.md (Phase 3).
 *
 * Groth16 verifier for the human-anonymous ownership / custodianship proof.
 * The real human identity NEVER appears on-chain — only the commitment root,
 * agentId, nullifier, and the authority threshold.
 *
 * DEPLOY IS DEFERRED TO SEAN (Railway/Base = Sean-only). This file exists so
 * the off-chain wiring (agent_custodianship_links privacy migration, the stake
 * authority loop) can be reviewed against the exact on-chain ABI.
 */

/**
 * Public signals — EXACT ordering from XC_HUMAN_OWNERSHIP_ZKP_DESIGN Phase 3
 * (`OwnershipProofPubSignals`). A Groth16 verifier receives these as a flat
 * uint256[7] field-element array in this index order; the struct mirrors it for
 * off-chain encoding clarity. capabilitiesHash is carried as a field element
 * (bytes32 reinterpreted as uint256) at index 4.
 *
 *   index 0: humansRoot        — root of the approved-humans Merkle tree
 *   index 1: agentId           — agent being claimed (repid_agents / ERC-8004)
 *   index 2: nullifier         — Poseidon2(identity_nullifier, agentId), per-agent scope
 *   index 3: minAuthority       — authority threshold being claimed
 *   index 4: capabilitiesHash  — hash of capabilities being unlocked
 *   index 5: policyVersion     — custodianship policy version / hash
 *   index 6: blockNumber       — freshness anchor (block number or timestamp)
 */
struct OwnershipProofPubSignals {
    uint256 humansRoot;       // index 0
    uint256 agentId;          // index 1
    uint256 nullifier;        // index 2
    uint256 minAuthority;     // index 3
    uint256 capabilitiesHash; // index 4 (bytes32 as field element)
    uint256 policyVersion;    // index 5
    uint256 blockNumber;      // index 6
}

interface IHumanOwnershipVerifier {
    /**
     * Canonical Groth16 verifier entrypoint (snarkjs/Circom layout). `input`
     * MUST be the 7 public signals in the index order documented above.
     * Pure: verifies the proof only; the consumer contract handles nullifier
     * replay / double-ownership state (see IHumanOwnershipGate).
     */
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[7] calldata input
    ) external view returns (bool);
}

/**
 * Consumer gate that wraps the pure verifier with on-chain state: nullifier
 * registry (anti double-ownership) + freshness. This is the contract the
 * off-chain custodianship-link writer would target. INTERFACE ONLY.
 */
interface IHumanOwnershipGate {
    /// Emitted when an ownership claim is accepted; `nullifier` is the on-chain
    /// anti-double-spend signal (standard Semaphore pattern).
    event OwnershipClaimed(uint256 indexed agentId, uint256 indexed nullifier, bytes32 capabilitiesHash);

    /// Reverts if proof invalid, nullifier already used for this scope, or stale.
    function claimOwnership(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        OwnershipProofPubSignals calldata pub
    ) external;

    /// True once a (agentId, nullifier) pair has been consumed.
    function isNullifierUsed(uint256 agentId, uint256 nullifier) external view returns (bool);

    /// Current accepted approved-humans Merkle root.
    function humansRoot() external view returns (uint256);
}
