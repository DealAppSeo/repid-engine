/**
 * Anchor red-team attacks (a) forge root (b) replay epoch — run against zkp-epoch-anchor pure fns.
 */
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  epochLeaf,
  buildMerkleProof,
  verifyMerkleProof,
  buildEasAttestationRequest,
  computeSchemaUid,
  EAS_SCHEMA_STRING,
} from '../src/services/zkp-epoch-anchor';
import { buildMerkleRoot } from '../src/services/audit-merkle-anchor';

const commits = ['real-c0', 'real-c1', 'real-c2'];
const leaves = commits.map(epochLeaf);
const root = buildMerkleRoot(leaves);

// Attack (a): stranger forges off-chain root with fake leaf
const forgedRoot = buildMerkleRoot([...leaves.slice(0, 2), epochLeaf('evil-insert')]);
const forgeRootOk = forgedRoot === root;

const p = buildMerkleProof(leaves, 1);
const tampered = { ...p, leaf: keccak256(toUtf8Bytes('tampered-commit')) };
const forgeLeafRejected = !verifyMerkleProof(tampered);

// Attack (c): replay prior epoch root in new attestation payload (different epoch label, same root)
const epochA = buildEasAttestationRequest({ root, epoch: '2026-06-16', proofCount: 3, firstId: 1, lastId: 3 });
const epochB = buildEasAttestationRequest({ root, epoch: '2026-06-17', proofCount: 9999, firstId: 1, lastId: 9999 });
const replaySameRootDifferentEpoch = epochA.merkleRoot === epochB.merkleRoot && epochA.epoch !== epochB.epoch;
// On-chain replay is NOT cryptographically blocked by EAS itself — mitigation is per-epoch root uniqueness + verify-back filters epoch in payload
const schemaUid = computeSchemaUid(EAS_SCHEMA_STRING, '0x0000000000000000000000000000000000000000', true);

console.log(JSON.stringify({
  attacks: {
    forge_offchain_root_matches_real: forgeRootOk,
    forge_leaf_inclusion_rejected: forgeLeafRejected,
    replay_root_reusable_across_epochs: replaySameRootDifferentEpoch,
  },
  verdict: {
    forge_root: forgeRootOk ? 'FAIL' : 'PASS (forged root differs)',
    forge_inclusion: forgeLeafRejected ? 'PASS (tampered leaf rejected)' : 'FAIL',
    replay: 'RESIDUAL (EAS accepts any root; verify-back must check epoch+count binding)',
  },
  schema_uid: schemaUid,
  real_root: root,
}, null, 2));