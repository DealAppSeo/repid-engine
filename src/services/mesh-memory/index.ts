/**
 * mesh-memory — sandbox searchable-encryption memory cell for the agent mesh.
 *
 * STATUS: SANDBOX / SHADOW. Not wired to any route, table, RepID path, or
 * chain. Synthetic data only. See sse-cell.ts for the full REAL-vs-STUB and
 * leakage-profile documentation.
 *
 * REAL:  AES-256-GCM record encryption + HMAC-SHA256 deterministic search
 *        tokens + encrypted postings (a minimal SSE-1-style inverted index) +
 *        a Poseidon2-over-BabyBear Merkle commitment (canon impl, Plonky3-parity)
 *        making the index root aggregation/ZK-circuit-ready.
 * STUB:  proof-carrying retrieval == a Merkle inclusion *commitment* (integrity /
 *        non-equivocation, NOT zero-knowledge). Poseidon2 makes it ZK-READY; the
 *        actual ZK membership circuit (Plonky3, proving inclusion without
 *        revealing the record) does NOT exist yet.
 */

export {
  MeshMemoryClient,
  EncryptedMemoryCell,
  createCell,
  type MemoryRecordInput,
  type SealedCell,
  type SearchHit,
} from './sse-cell';

export {
  MerkleTree,
  verifyProof,
  leafHash,
  DEFAULT_SCHEME,
  type MerkleProof,
  type MerkleProofKind,
  type MerkleHashScheme,
} from './merkle';

export {
  toMasterKey,
  keywordToken,
  gcmEncrypt,
  gcmDecrypt,
  type GcmBlob,
} from './crypto';
