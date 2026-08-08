/**
 * mesh-memory/sse-cell.ts — the smallest working searchable-encryption memory cell.
 *
 * SANDBOX / SHADOW. No production tables, no RepID, no chain, no env secrets.
 * Synthetic data only. This is an experiment toward the agent mesh-memory layer.
 *
 * ═══ WHAT THIS IS (REAL) ═════════════════════════════════════════════════════
 * A minimal Searchable Symmetric Encryption (SSE) scheme, in the style of the
 * Curtmola–Garay–Kamara–Ostrovsky "SSE-1" inverted index:
 *
 *   • Records are encrypted with AES-256-GCM under a per-user record key. The
 *     host stores only ciphertext; without the key it is unreadable.
 *   • Keywords map to DETERMINISTIC search tokens via HMAC-SHA256(K_tok, w). The
 *     host indexes by token, so a single-keyword lookup finds matching records
 *     WITHOUT decrypting the store — the whole point of SSE.
 *   • The postings list for each keyword (the set of matching record ids) is
 *     itself AES-256-GCM-encrypted under a per-keyword key K_w = HMAC(K_post, w).
 *     So before any query, the host cannot read which records share a keyword.
 *   • A wrong key produces wrong tokens (finds nothing) AND cannot decrypt any
 *     record or postings blob (GCM auth tag fails). Proven in the tests.
 *
 * ═══ WHAT THIS IS NOT (leakage profile — stated honestly) ════════════════════
 * This is SSE, NOT zero-knowledge and NOT ORAM. The standard, unavoidable-at-
 * this-tier leakage:
 *   • SETUP leakage: the host learns the number of records, the number of
 *     distinct keyword tokens, and each encrypted-postings blob's LENGTH (hence
 *     roughly how many records match a keyword — the result-size upper bound).
 *   • QUERY / ACCESS-PATTERN leakage: when the client searches, the host sees
 *     the token (an opaque HMAC, not the keyword) and learns WHICH records are
 *     returned and that two searches for the same keyword are identical (search-
 *     pattern leakage, inherent to deterministic tokens). Over many queries this
 *     enables known statistical/access-pattern attacks — SSE trades this leakage
 *     for practicality. Do not claim "the host learns nothing".
 *   • The host does NOT learn: any plaintext, any keyword in the clear, or the
 *     postings of an un-queried keyword.
 *
 * ═══ PROOF-CARRYING RETRIEVAL (Poseidon2 commitment; ZK circuit still STUB) ═══
 * Every search/record result carries a Merkle inclusion proof against a root
 * committed at seal time (see merkle.ts). The tree now hashes with **Poseidon2
 * over BabyBear** (the canon impl in src/zkp/poseidon2-leaf.ts, bit-exact vs
 * Plonky3 0.3.0), so the root is aggregation/ZK-circuit-ready.
 *
 * This is still an INTEGRITY commitment — it proves the host returned committed
 * data, not something it fabricated (non-equivocation). It is NOT zero-knowledge:
 * Poseidon2 makes a future Plonky3 membership circuit POSSIBLE (prove inclusion
 * under the root without revealing the record), but that circuit does not exist
 * yet. Until it does, retrieval is a commitment, not a ZK proof.
 */

import {
  toMasterKey,
  deriveSubkey,
  gcmEncrypt,
  gcmDecrypt,
  keywordToken,
  randomBytes,
  sha256Hex,
  type GcmBlob,
} from './crypto';
import { MerkleTree, verifyProof, type MerkleProof } from './merkle';

// ── input / wire types ───────────────────────────────────────────────────────

/** A plaintext memory record the client wants to store (synthetic data only). */
export interface MemoryRecordInput {
  id: string;
  keywords: string[];
  /** arbitrary JSON-serializable payload */
  payload: unknown;
}

/** The sealed, host-side cell: ciphertext + token index + commitment. No key. */
export interface SealedCell {
  version: 1;
  /** per-cell public (non-secret) HKDF salt, base64 */
  salt: string;
  /** recordId → encrypted payload */
  records: Record<string, GcmBlob>;
  /** searchToken(hex) → encrypted postings (JSON list of recordIds) */
  index: Record<string, GcmBlob>;
  /** Merkle root over the committed index + record leaves */
  commitmentRoot: string;
}

/** A search hit: the decrypted record, plus the integrity proof it came with. */
export interface SearchHit {
  id: string;
  payload: unknown;
  /** STUB integrity proof (Merkle inclusion), verified === true if it checked out */
  proof: MerkleProof;
  proofVerified: boolean;
}

// ── canonical leaf encoding (shared by host committer + client verifier) ──────

function blobFingerprint(blob: GcmBlob): string {
  return sha256Hex(`${blob.iv}.${blob.tag}.${blob.ct}`);
}

function indexLeaf(token: string, blob: GcmBlob): string {
  return `IDX:${token}:${blobFingerprint(blob)}`;
}

function recordLeaf(id: string, blob: GcmBlob): string {
  return `REC:${id}:${blobFingerprint(blob)}`;
}

/**
 * Deterministic ordering of all committed leaves. Both the host (building the
 * tree) and the client (locating a leaf's index to verify a proof) must agree
 * on this ordering, so it is defined once here.
 */
function orderedLeaves(sealed: Pick<SealedCell, 'index' | 'records'>): {
  leaves: string[];
  indexPos: Map<string, number>;
  recordPos: Map<string, number>;
} {
  const leaves: string[] = [];
  const indexPos = new Map<string, number>();
  const recordPos = new Map<string, number>();

  for (const token of Object.keys(sealed.index).sort()) {
    const blob = sealed.index[token]!;
    indexPos.set(token, leaves.length);
    leaves.push(indexLeaf(token, blob));
  }
  for (const id of Object.keys(sealed.records).sort()) {
    const blob = sealed.records[id]!;
    recordPos.set(id, leaves.length);
    leaves.push(recordLeaf(id, blob));
  }
  return { leaves, indexPos, recordPos };
}

// ── client: holds the user key, builds cells, searches, decrypts ─────────────

/**
 * The key-holding side. In a real deployment this runs inside the agent's
 * trusted boundary; the host only ever receives a SealedCell and search tokens.
 */
export class MeshMemoryClient {
  private readonly master: Buffer;

  constructor(userKey: string) {
    this.master = toMasterKey(userKey);
  }

  private subkeys(salt: Buffer): { tok: Buffer; post: Buffer; enc: Buffer } {
    return {
      tok: deriveSubkey(this.master, salt, 'mesh-memory:sse:token:v1'),
      post: deriveSubkey(this.master, salt, 'mesh-memory:sse:postings:v1'),
      enc: deriveSubkey(this.master, salt, 'mesh-memory:sse:record:v1'),
    };
  }

  /** Encrypt a batch of records into a SealedCell the host can store. */
  seal(records: MemoryRecordInput[]): SealedCell {
    const salt = randomBytes(16);
    const { tok, post, enc } = this.subkeys(salt);

    const recordBlobs: Record<string, GcmBlob> = {};
    const inverted = new Map<string, Set<string>>(); // keyword-token → recordIds

    for (const rec of records) {
      if (recordBlobs[rec.id]) {
        throw new Error(`mesh-memory: duplicate record id "${rec.id}"`);
      }
      recordBlobs[rec.id] = gcmEncrypt(enc, JSON.stringify(rec.payload));
      for (const kw of rec.keywords) {
        const token = keywordToken(tok, kw);
        let set = inverted.get(token);
        if (!set) {
          set = new Set<string>();
          inverted.set(token, set);
        }
        set.add(rec.id);
      }
    }

    const index: Record<string, GcmBlob> = {};
    for (const [token, ids] of inverted) {
      // per-keyword postings key: derive from K_post and the token (which is
      // itself keyed by the keyword) so each postings list gets an independent key.
      const kw = deriveSubkey(post, salt, `postings:${token}`);
      const sorted = [...ids].sort();
      index[token] = gcmEncrypt(kw, JSON.stringify(sorted));
    }

    const { leaves } = orderedLeaves({ index, records: recordBlobs });
    const root = new MerkleTree(leaves).root();

    return {
      version: 1,
      salt: salt.toString('base64'),
      records: recordBlobs,
      index,
      commitmentRoot: root,
    };
  }

  /** The deterministic search token to hand a host for a keyword. Leaks nothing without K_tok. */
  searchToken(salt: Buffer, keyword: string): string {
    const { tok } = this.subkeys(salt);
    return keywordToken(tok, keyword);
  }

  /**
   * Full search round-trip against a host cell: produce the token, ask the host,
   * verify the integrity proof, decrypt postings + records. Returns [] on a
   * keyword with no matches. Throws if a returned record fails to decrypt
   * (wrong key / tamper) — callers see that as a hard failure, not empty.
   */
  search(host: EncryptedMemoryCell, keyword: string): SearchHit[] {
    const salt = Buffer.from(host.salt(), 'base64');
    const { tok, post, enc } = this.subkeys(salt);
    const token = keywordToken(tok, keyword);

    const res = host.lookup(token);
    if (!res) return [];

    // 1. verify the postings blob is committed under the root.
    if (!verifyProof(res.proof, host.commitmentRoot())) {
      throw new Error('mesh-memory: index proof failed — host returned uncommitted postings');
    }
    // 2. decrypt postings to get the record ids.
    const kw = deriveSubkey(post, salt, `postings:${token}`);
    const ids: string[] = JSON.parse(gcmDecrypt(kw, res.postings).toString('utf8'));

    // 3. fetch + verify + decrypt each record.
    const hits: SearchHit[] = [];
    for (const id of ids) {
      const got = host.getRecord(id);
      if (!got) throw new Error(`mesh-memory: postings referenced missing record "${id}"`);
      const proofVerified = verifyProof(got.proof, host.commitmentRoot());
      const payload = JSON.parse(gcmDecrypt(enc, got.blob).toString('utf8'));
      hits.push({ id, payload, proof: got.proof, proofVerified });
    }
    return hits;
  }
}

// ── host: holds only ciphertext + index + commitment. Never sees the key ─────

/**
 * The untrusted-ish storage side. It can serve searches by token and produce
 * integrity proofs, but holds no key and can decrypt nothing. This is the
 * object that would live in the shared mesh / on an untrusted store.
 */
export class EncryptedMemoryCell {
  private readonly sealed: SealedCell;
  private readonly tree: MerkleTree;
  private readonly indexPos: Map<string, number>;
  private readonly recordPos: Map<string, number>;

  constructor(sealed: SealedCell) {
    this.sealed = sealed;
    const { leaves, indexPos, recordPos } = orderedLeaves(sealed);
    this.tree = new MerkleTree(leaves);
    this.indexPos = indexPos;
    this.recordPos = recordPos;
    // Defensive: the loaded root must match what we recompute, else the cell was
    // tampered between seal and load.
    if (this.tree.root() !== sealed.commitmentRoot) {
      throw new Error('mesh-memory: commitment root mismatch on load (cell tampered?)');
    }
  }

  salt(): string {
    return this.sealed.salt;
  }

  commitmentRoot(): string {
    return this.sealed.commitmentRoot;
  }

  /** Serve a keyword search by token: encrypted postings + inclusion proof, or null. */
  lookup(token: string): { postings: GcmBlob; proof: MerkleProof } | null {
    const blob = this.sealed.index[token];
    const pos = this.indexPos.get(token);
    if (!blob || pos === undefined) return null;
    return { postings: blob, proof: this.tree.proof(pos) };
  }

  /** Serve a record ciphertext by id + inclusion proof, or null. */
  getRecord(id: string): { blob: GcmBlob; proof: MerkleProof } | null {
    const blob = this.sealed.records[id];
    const pos = this.recordPos.get(id);
    if (!blob || pos === undefined) return null;
    return { blob, proof: this.tree.proof(pos) };
  }

  /**
   * The ENTIRE view an honest-but-curious host has. Used by tests to prove the
   * host cannot see plaintext or keywords. Returns ciphertext + opaque tokens only.
   */
  hostView(): SealedCell {
    return this.sealed;
  }
}

/** Convenience: seal records with a user key and return the loaded host cell. */
export function createCell(userKey: string, records: MemoryRecordInput[]): {
  client: MeshMemoryClient;
  cell: EncryptedMemoryCell;
} {
  const client = new MeshMemoryClient(userKey);
  const sealed = client.seal(records);
  return { client, cell: new EncryptedMemoryCell(sealed) };
}
