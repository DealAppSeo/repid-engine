/**
 * mesh-memory — sandbox searchable-encryption memory cell for the agent mesh.
 *
 * STATUS: SANDBOX / SHADOW. Not wired to any route, table, RepID path, or
 * chain. Synthetic data only. See sse-cell.ts for the full REAL-vs-STUB and
 * leakage-profile documentation.
 *
 * REAL:  AES-256-GCM record encryption + HMAC-SHA256 deterministic search
 *        tokens + encrypted postings (a minimal SSE-1-style inverted index).
 * STUB:  proof-carrying retrieval == a Merkle inclusion commitment (integrity,
 *        not zero-knowledge). The ZK version (Poseidon2 + Plonky3) is future.
 */

export {
  MeshMemoryClient,
  EncryptedMemoryCell,
  createCell,
  type MemoryRecordInput,
  type SealedCell,
  type SearchHit,
} from './sse-cell';

export { MerkleTree, verifyProof, leafHash, type MerkleProof } from './merkle';

export {
  toMasterKey,
  keywordToken,
  gcmEncrypt,
  gcmDecrypt,
  type GcmBlob,
} from './crypto';
