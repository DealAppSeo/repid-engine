/**
 * M1 human↔agent binding — EAS anchor, DRY-RUN ONLY.
 *
 * Produces the broadcast-ready EAS attestation calldata for the VERIFIED M1 binding
 * (see E:\dev\reports\2026-06-13\CC_M1_HUMAN_AGENT_BINDING.md). Reuses
 * buildEasAttestationRequest (src/services/zkp-epoch-anchor) — NO new schema, NO send.
 * The on-chain send is HELD for Sean (attester 0x4F8AD3fB…504fb, funded).
 *
 *   npx ts-node scripts/m1-anchor.ts          # prints the held cast + the post-send SQL
 *
 * There is intentionally NO --send path here: anchoring is Sean-only.
 */
import { AbiCoder, keccak256 } from 'ethers';
import { buildEasAttestationRequest } from '../src/services/zkp-epoch-anchor';

// ── Verified M1 binding values (trinity-nexus, ownership scope = agent_dbt_id = 1).
const COMMITMENT_FELT = 661672746n;  // Poseidon2 commitment C1 (human_sbt_mints.commitment_hash)
const NULLIFIER_FELT  = 427127326n;  // scoped nullifier (nullifier_registry, context=1)
const PROOF_DIGEST    = '0x02c937e9cc5864f97b50a41caaf22f5e4d26a12fd8ba6229ff1f87acd7e5712c'; // sha256(STARK bytes)
const LEAF_HEX        = '0x3b7ffc0a'; // Poseidon2 leaf {agent,threshold,repid} (capabilities_hash)
const AGENT_DBT_ID    = 1;

// Binding root = keccak256(abi.encode(proof_digest, commitment, nullifier)) — binds all three so a
// single EAS attestation pins the whole binding (proof ⇄ identity commitment ⇄ scoped nullifier).
const bindingRoot = keccak256(
  AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'uint256'],
    [PROOF_DIGEST, COMMITMENT_FELT, NULLIFIER_FELT],
  ),
);

const req = buildEasAttestationRequest({
  root: bindingRoot,
  epoch: 'm1-binding-2026-06-13',
  proofCount: 1,
  firstId: AGENT_DBT_ID,
  lastId: AGENT_DBT_ID,
});

console.log('=== M1 EAS-ANCHOR — DRY-RUN (on-chain send HELD for Sean) ===');
console.log('binding      commitment=%s  nullifier=%s  leaf=%s', COMMITMENT_FELT, NULLIFIER_FELT, LEAF_HEX);
console.log('proof_digest', PROOF_DIGEST);
console.log('bindingRoot ', bindingRoot);
console.log('EAS contract', req.easContract, '(Base Sepolia)');
console.log('schemaUid   ', req.schemaUid);
console.log('schema      ', req.schemaString);
console.log('encodedData ', req.encodedData);
console.log('\n# HELD — Sean broadcasts (attester whose key derives to 0x4F8AD3fB35473b6DEA0559FfbbDe034e2Db504fb):');
console.log(`cast send ${req.easContract} ${req.attestCalldata} \\`);
console.log('  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $HYPERDAG_ATTESTOR_PRIVATE_KEY');
console.log('\n# After the tx confirms, record the anchor (service_role):');
console.log(`#   UPDATE nullifier_registry SET anchor_tx='<TX_HASH>' WHERE context=1 AND nullifier=427127326; -- SINGLE-WRITER-OK`);
console.log('\n(DRY-RUN — nothing broadcast. If the schemaUid above is not yet registered on Base Sepolia,');
console.log(' register it first; resolver=0x0 → not attester-restricted, so any funded key produces a valid attestation.)');
