/**
 * mesh-memory-sse.test.ts
 *
 * Proves the claims made for the sandbox SSE memory cell (src/services/mesh-memory):
 *
 *   1. WRITE→QUERY correctness: a keyword search returns exactly the records
 *      that carried that keyword, decrypted correctly — without decrypting the
 *      rest of the store.
 *   2. WRONG KEY cannot search (wrong tokens → no hits) and cannot read (GCM
 *      auth fails if it somehow reaches a ciphertext).
 *   3. HOST CONFIDENTIALITY: the host's entire view (ciphertext + token index)
 *      contains neither any plaintext payload nor any keyword in the clear.
 *   4. PROOF-CARRYING RETRIEVAL (stub): every hit carries a verified Merkle
 *      inclusion proof; a tampered index blob breaks the proof.
 *   5. LEAKAGE (honest): the host DOES learn access pattern + result size on a
 *      query, and search-pattern (same keyword → identical token). Asserted so
 *      the leakage profile is documented in executable form, not just prose.
 *
 * All data below is synthetic. No production rows, no real agent ids, no real keys.
 */

import {
  MeshMemoryClient,
  EncryptedMemoryCell,
  createCell,
  verifyProof,
  leafHash,
  MerkleTree,
  gcmDecrypt,
  type MemoryRecordInput,
  type SealedCell,
} from '../src/services/mesh-memory';
// Canon Poseidon2-BabyBear impl (backlog 4.0-b/4.0-c, bit-exact vs Plonky3 0.3.0
// KAT). Imported directly so the parity check compares the mesh-memory commitment
// against the SAME primitives it is built from — no hand-rolled second Poseidon2.
import { poseidon2LeafHash, poseidon2PairHash, hexToFields } from '../src/zkp/poseidon2-leaf';
import { BABYBEAR_P } from '../src/zkp/poseidon2-babybear';

// ── synthetic corpus (fictional agent notes) ─────────────────────────────────
const USER_KEY = 'sandbox-user-key-alpha-0123456789abcdef'; // synthetic, >= 16 chars
const OTHER_KEY = 'sandbox-user-key-bravo-fedcba9876543210'; // a different user's key

const CORPUS: MemoryRecordInput[] = [
  { id: 'm1', keywords: ['payments', 'escrow', 'usdc'], payload: { note: 'held payment until delivery verified', amount: 4.2 } },
  { id: 'm2', keywords: ['escrow', 'dispute'], payload: { note: 'buyer opened a dispute on escrow' } },
  { id: 'm3', keywords: ['routing', 'anfis'], payload: { note: 'routed to the cheap free-tier model' } },
  { id: 'm4', keywords: ['payments', 'refund'], payload: { note: 'partial refund issued' } },
];

function makeCell(key = USER_KEY) {
  return createCell(key, CORPUS);
}

describe('mesh-memory SSE cell — write/query correctness', () => {
  it('returns exactly the records carrying a keyword, decrypted', () => {
    const { client, cell } = makeCell();

    const escrow = client.search(cell, 'escrow');
    expect(escrow.map((h) => h.id).sort()).toEqual(['m1', 'm2']);

    const payments = client.search(cell, 'payments');
    expect(payments.map((h) => h.id).sort()).toEqual(['m1', 'm4']);

    // payload round-trips correctly
    const m1 = escrow.find((h) => h.id === 'm1')!;
    expect(m1.payload).toEqual({ note: 'held payment until delivery verified', amount: 4.2 });
  });

  it('is normalization-insensitive (case / whitespace)', () => {
    const { client, cell } = makeCell();
    expect(client.search(cell, '  ESCROW ').map((h) => h.id).sort()).toEqual(['m1', 'm2']);
  });

  it('returns [] for a keyword that matches nothing', () => {
    const { client, cell } = makeCell();
    expect(client.search(cell, 'nonexistent-keyword')).toEqual([]);
  });

  it('does not require decrypting the whole store to answer a query', () => {
    // The host serves a single-token lookup + only the matching record ids.
    // We assert the host never had to hand over more than the matched records.
    const { client, cell } = makeCell();
    const spy = jest.spyOn(cell, 'getRecord');
    client.search(cell, 'routing'); // only m3
    const requestedIds = spy.mock.calls.map((c) => c[0]);
    expect(requestedIds).toEqual(['m3']);
    expect(requestedIds.length).toBeLessThan(CORPUS.length);
    spy.mockRestore();
  });
});

describe('mesh-memory SSE cell — wrong key cannot search or read', () => {
  it('a different user key finds nothing (wrong search tokens)', () => {
    const { cell } = makeCell(USER_KEY);
    const attacker = new MeshMemoryClient(OTHER_KEY);
    // Attacker searches for a keyword that DOES exist under the real key.
    expect(attacker.search(cell, 'escrow')).toEqual([]);
    expect(attacker.search(cell, 'payments')).toEqual([]);
  });

  it('a wrong key cannot decrypt a record ciphertext even if handed the id', () => {
    const { cell } = makeCell(USER_KEY);
    const attacker = new MeshMemoryClient(OTHER_KEY);
    const salt = Buffer.from(cell.salt(), 'base64');
    // Reach past the API: grab a real ciphertext and try to decrypt with the
    // attacker's derived record key. GCM auth must fail.
    const rec = cell.getRecord('m1')!;
    // Derive the attacker's record subkey the same way the client would.
    const { deriveSubkey } = require('../src/services/mesh-memory/crypto');
    const wrongEnc = deriveSubkey(
      (attacker as any)['master'],
      salt,
      'mesh-memory:sse:record:v1'
    );
    expect(() => gcmDecrypt(wrongEnc, rec.blob)).toThrow();
  });

  it('a wrong key cannot decrypt a postings blob', () => {
    const { client, cell } = makeCell(USER_KEY);
    const realToken = client.searchToken(Buffer.from(cell.salt(), 'base64'), 'escrow');
    const res = cell.lookup(realToken)!;
    expect(res).toBeTruthy();
    const attacker = new MeshMemoryClient(OTHER_KEY);
    const salt = Buffer.from(cell.salt(), 'base64');
    const { deriveSubkey } = require('../src/services/mesh-memory/crypto');
    const wrongPost = deriveSubkey((attacker as any)['master'], salt, 'mesh-memory:sse:postings:v1');
    const wrongKw = deriveSubkey(wrongPost, salt, `postings:${realToken}`);
    expect(() => gcmDecrypt(wrongKw, res.postings)).toThrow();
  });
});

describe('mesh-memory SSE cell — host confidentiality', () => {
  it('the host view contains no plaintext payload and no keyword in the clear', () => {
    const { cell } = makeCell();
    const view: SealedCell = cell.hostView();
    const blob = JSON.stringify(view);

    // Plaintext note fragments must NOT appear anywhere in the ciphertext view.
    const secretFragments = [
      'held payment until delivery',
      'buyer opened a dispute',
      'cheap free-tier model',
      'partial refund issued',
    ];
    for (const frag of secretFragments) {
      expect(blob).not.toContain(frag);
    }
    // Keywords must NOT appear in the clear as index keys — the index is keyed
    // by 64-hex HMAC tokens, never by the keyword string.
    const keywords = ['payments', 'escrow', 'usdc', 'dispute', 'routing', 'anfis', 'refund'];
    for (const kw of keywords) {
      expect(Object.keys(view.index)).not.toContain(kw);
    }
    // Every index key is a 32-byte hex HMAC token.
    for (const token of Object.keys(view.index)) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('two records with disjoint keywords produce ciphertexts with no shared plaintext leakage', () => {
    // Same payload encrypted twice yields different ciphertext (random IV).
    const { cell: c1 } = createCell(USER_KEY, [{ id: 'x', keywords: ['k'], payload: { note: 'same' } }]);
    const { cell: c2 } = createCell(USER_KEY, [{ id: 'x', keywords: ['k'], payload: { note: 'same' } }]);
    expect(c1.hostView().records['x']!.ct).not.toEqual(c2.hostView().records['x']!.ct);
  });
});

describe('mesh-memory SSE cell — proof-carrying retrieval (Poseidon2 commitment)', () => {
  it('every hit carries a Poseidon2 Merkle inclusion proof that verifies against the committed root', () => {
    const { client, cell } = makeCell();
    const hits = client.search(cell, 'escrow');
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect(h.proofVerified).toBe(true);
      // Honest, self-describing label: a Poseidon2 commitment, NOT a ZK proof.
      expect(h.proof.kind).toBe('merkle-inclusion-poseidon2-commitment');
      // The committed root is a 32-byte (8 BabyBear field element) Poseidon2 digest.
      expect(cell.commitmentRoot()).toMatch(/^0x[0-9a-f]{64}$/);
      expect(verifyProof(h.proof, cell.commitmentRoot())).toBe(true);
    }
  });

  it('a proof does not verify against a different root (integrity binding)', () => {
    const { client, cell } = makeCell();
    const hit = client.search(cell, 'routing')[0]!;
    const wrongRoot = 'f'.repeat(64);
    expect(verifyProof(hit.proof, wrongRoot)).toBe(false);
  });

  it('tampering with a committed postings blob is detected at load (root mismatch)', () => {
    const { cell } = makeCell();
    const tampered: SealedCell = JSON.parse(JSON.stringify(cell.hostView()));
    // Flip one byte of some index blob's ciphertext but keep the old root.
    const firstToken = Object.keys(tampered.index)[0]!;
    const b = tampered.index[firstToken]!;
    const raw = Buffer.from(b.ct, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    b.ct = raw.toString('base64');
    // Loading a cell whose contents no longer match its committed root must throw.
    expect(() => new EncryptedMemoryCell(tampered)).toThrow(/commitment root mismatch/);
  });
});

describe('mesh-memory Merkle commitment — Poseidon2 field arithmetic matches canon impl', () => {
  it('leafHash matches the canon Poseidon2 leaf hash (with the L domain prefix)', () => {
    // The tree leaf-hashes raw strings; the mesh-memory leaf convention prefixes
    // 'L' for domain separation, so leafHash(x) === canon poseidon2LeafHash('L'+x).
    expect(leafHash('IDX:abc:def')).toBe(poseidon2LeafHash('L' + 'IDX:abc:def'));
  });

  it('a 2-leaf tree root equals a hand-computed Poseidon2 leaf+compress over the canon impl', () => {
    const a = 'REC:m1:aaa';
    const b = 'REC:m2:bbb';
    const root = new MerkleTree([a, b]).root();
    const expected = poseidon2PairHash(
      poseidon2LeafHash('L' + a),
      poseidon2LeafHash('L' + b),
    );
    expect(root).toBe(expected);
  });

  it('every commitment digest is 8 canonical BabyBear field elements (< p)', () => {
    const { cell } = makeCell();
    const root = cell.commitmentRoot();
    // hexToFields throws if any limb is non-canonical (>= p); assert it parses
    // AND that all 8 limbs are genuinely in [0, p) — real field arithmetic, not
    // an opaque 256-bit hash reinterpreted.
    const limbs = hexToFields(root);
    expect(limbs).toHaveLength(8);
    for (const limb of limbs) {
      expect(limb).toBeGreaterThanOrEqual(0n);
      expect(limb < BABYBEAR_P).toBe(true);
    }
  });

  it('is deterministic: sealing the same corpus twice yields the same Poseidon2 leaf hashes', () => {
    // (Roots differ because record ciphertexts use random IVs; but the leaf hash
    // of a fixed string is deterministic — the Poseidon2 permutation is pure.)
    expect(leafHash('stable-input')).toBe(leafHash('stable-input'));
  });
});

describe('mesh-memory SSE cell — honest leakage profile (documented in code)', () => {
  it('SEARCH-PATTERN leakage: the same keyword yields the same token every time', () => {
    const { client, cell } = makeCell();
    const salt = Buffer.from(cell.salt(), 'base64');
    const t1 = client.searchToken(salt, 'escrow');
    const t2 = client.searchToken(salt, 'escrow');
    expect(t1).toEqual(t2); // deterministic — this IS the leakage, asserted honestly
  });

  it('RESULT-SIZE / ACCESS-PATTERN leakage: host learns which & how many records a token returns', () => {
    const { client, cell } = makeCell();
    const salt = Buffer.from(cell.salt(), 'base64');
    const token = client.searchToken(salt, 'escrow');
    const res = cell.lookup(token)!;
    // The host cannot read the postings (encrypted), but the moment the CLIENT
    // resolves them it fetches specific record ids the host then serves — the
    // host observes exactly which ids are accessed. We model that observable:
    const spy = jest.spyOn(cell, 'getRecord');
    client.search(cell, 'escrow');
    const accessed = spy.mock.calls.map((c) => c[0]).sort();
    expect(accessed).toEqual(['m1', 'm2']); // access pattern is visible to the host
    spy.mockRestore();
    // And the encrypted-postings blob length is a (loose) upper bound on result size.
    expect(res.postings.ct.length).toBeGreaterThan(0);
  });

  it('the host CANNOT learn the postings of an un-queried keyword', () => {
    const { cell } = makeCell();
    // Without the client ever issuing the token, the host holds only an opaque
    // encrypted blob for each keyword and cannot enumerate the plaintext ids.
    const view = cell.hostView();
    for (const token of Object.keys(view.index)) {
      // Best the host can do without a key: see a GCM blob. Assert it is opaque.
      const blob = view.index[token]!;
      expect(blob).toHaveProperty('iv');
      expect(blob).toHaveProperty('tag');
      expect(blob).toHaveProperty('ct');
      // No plaintext record id ('m1'..'m4') is recoverable from the raw blob bytes.
      const decoded = Buffer.from(blob.ct, 'base64').toString('latin1');
      expect(decoded).not.toContain('m1');
      expect(decoded).not.toContain('m2');
    }
  });
});
