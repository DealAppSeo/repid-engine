/**
 * Poseidon2-BabyBear LEAF-mode parity gate (backlog 4.0-c).
 *
 * Validates the from-scratch TS leaf primitives (`src/zkp/poseidon2-leaf.ts`):
 *   - `poseidon2Sponge`   = PaddingFreeSponge<16,8,8>
 *   - `poseidon2Compress` = TruncatedPermutation<2,8,16>
 * against the INDEPENDENT Rust oracle (backlog 4.0-c):
 * `zkp-vault/kat/poseidon2_babybear16_leaf_kat.json`, produced by Plonky3's own
 * audited p3-symmetric constructions over `default_babybear_poseidon2_16()`.
 *
 * The expected vectors below are copied verbatim from that committed oracle JSON.
 * The Rust test `zkp-vault/tests/poseidon2_leaf_kat.rs` proves the wrapper wiring
 * is correct (compression / one-block sponge equal the RAW permutation prefix), so
 * matching these is genuine cross-language parity, not "both wrong the same way".
 * If the oracle JSON is present on disk we ALSO cross-check against it directly.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  bytesToFields,
  fieldsToHex,
  hexToFields,
  poseidon2Compress,
  poseidon2LeafHash,
  poseidon2PairHash,
  poseidon2Sponge,
} from '../src/zkp/poseidon2-leaf';
import {
  buildInclusion,
  getHashScheme,
  rootFromCommitments,
  verifyInclusion,
} from '../src/zkp/merkle-root';

// --- Verbatim from zkp-vault/kat/poseidon2_babybear16_leaf_kat.json (4.0-c oracle) ---
const COMPRESSION_KAT: Array<{ name: string; left: number[]; right: number[]; output: number[] }> = [
  { name: 'zeros', left: [0, 0, 0, 0, 0, 0, 0, 0], right: [0, 0, 0, 0, 0, 0, 0, 0],
    output: [1168947398, 128782440, 747404447, 883925857, 360581875, 1704698758, 1878363991, 1054281681] },
  { name: 'iota', left: [0, 1, 2, 3, 4, 5, 6, 7], right: [8, 9, 10, 11, 12, 13, 14, 15],
    output: [1906786279, 1737026427, 1959749225, 700325316, 1638050605, 1021608788, 1726691001, 1761127344] },
  { name: 'leaf_pair', left: [777, 555, 0, 0, 0, 0, 0, 0], right: [111, 222, 0, 0, 0, 0, 0, 0],
    output: [524394786, 1518921725, 48539887, 406190224, 1035741103, 167259337, 569172278, 1168200020] },
];

const SPONGE_KAT: Array<{ name: string; input: number[]; output: number[] }> = [
  { name: 'empty', input: [], output: [0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'len1', input: [42],
    output: [180805231, 67238331, 638499573, 1735227380, 839369042, 1086125639, 381411113, 858921385] },
  { name: 'len8', input: [0, 1, 2, 3, 4, 5, 6, 7],
    output: [458038305, 257183205, 1951318676, 729287742, 1357995677, 631765864, 502434224, 1170329282] },
  { name: 'len9', input: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    output: [676812573, 1270559507, 381485534, 1698063116, 133058718, 707903278, 665192678, 1007467608] },
  { name: 'len16', input: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    output: [568621648, 260560799, 1787535874, 764831861, 341748543, 546488453, 1028837269, 1917944385] },
  { name: 'len17', input: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    output: [1974045815, 196820718, 1073353574, 87259145, 297839827, 1251432516, 1044535156, 1062713680] },
  { name: 'bytes_repid', input: [114, 101, 112, 105, 100],
    output: [966236718, 1661882984, 689238320, 1747583344, 546169788, 228048187, 1322879760, 73198847] },
];

const toBig = (a: number[]): bigint[] => a.map((v) => BigInt(v));

describe('Poseidon2-BabyBear leaf — compression parity vs Rust oracle', () => {
  for (const v of COMPRESSION_KAT) {
    it(`compress(${v.name}) matches the oracle element-for-element`, () => {
      const got = poseidon2Compress(toBig(v.left), toBig(v.right));
      expect(got).toEqual(toBig(v.output));
    });
  }
});

describe('Poseidon2-BabyBear leaf — sponge parity vs Rust oracle', () => {
  for (const v of SPONGE_KAT) {
    it(`sponge(${v.name}, len=${v.input.length}) matches the oracle element-for-element`, () => {
      const got = poseidon2Sponge(toBig(v.input));
      expect(got).toEqual(toBig(v.output));
    });
  }
});

describe('Poseidon2-BabyBear leaf — on-disk oracle cross-check (belt and suspenders)', () => {
  const katPath = join(__dirname, '..', 'zkp-vault', 'kat', 'poseidon2_babybear16_leaf_kat.json');
  it('embedded vectors equal the committed oracle JSON when present', () => {
    if (!existsSync(katPath)) {
      // Off a fresh checkout without the zkp-vault oracle, the embedded copy above
      // is authoritative (same discipline as the 4.0-b permutation test).
      return;
    }
    const oracle = JSON.parse(readFileSync(katPath, 'utf8'));
    expect(oracle.scheme).toBe('poseidon2_babybear16_leaf');
    // Compression
    const oc: any[] = oracle.compression;
    expect(oc.length).toBe(COMPRESSION_KAT.length);
    for (let i = 0; i < oc.length; i++) {
      expect(oc[i].left).toEqual(COMPRESSION_KAT[i]!.left);
      expect(oc[i].right).toEqual(COMPRESSION_KAT[i]!.right);
      expect(oc[i].output).toEqual(COMPRESSION_KAT[i]!.output);
    }
    // Sponge
    const os: any[] = oracle.sponge;
    expect(os.length).toBe(SPONGE_KAT.length);
    for (let i = 0; i < os.length; i++) {
      expect(os[i].input).toEqual(SPONGE_KAT[i]!.input);
      expect(os[i].output).toEqual(SPONGE_KAT[i]!.output);
    }
  });
});

describe('Poseidon2-BabyBear leaf — serialization', () => {
  it('fieldsToHex produces 0x + 64 hex chars (32 bytes)', () => {
    const hex = fieldsToHex(toBig(COMPRESSION_KAT[0]!.output));
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hexToFields is the exact inverse of fieldsToHex', () => {
    for (const v of COMPRESSION_KAT) {
      const elems = toBig(v.output);
      expect(hexToFields(fieldsToHex(elems))).toEqual(elems);
    }
  });

  it('rejects wrong-length hex', () => {
    expect(() => hexToFields('0xdeadbeef')).toThrow();
    expect(() => hexToFields('0x' + 'a'.repeat(63))).toThrow();
  });

  it('rejects a non-canonical (>= p) limb', () => {
    // ffffffff = 4294967295 >= p, in the first limb.
    expect(() => hexToFields('0x' + 'ffffffff' + '00'.repeat(28))).toThrow(/canonical/);
  });

  it('bytesToFields maps one byte to one field element', () => {
    const f = bytesToFields(new Uint8Array([0, 1, 255]));
    expect(f).toEqual([0n, 1n, 255n]);
  });
});

describe('Poseidon2-BabyBear leaf — merkle-root wiring (no longer throws)', () => {
  it('the poseidon2 scheme is selectable and non-throwing', () => {
    const scheme = getHashScheme('poseidon2');
    expect(scheme.name).toBe('poseidon2');
    const leaf = scheme.leaf('agent-42|1000|ESTABLISHED');
    expect(leaf).toMatch(/^0x[0-9a-f]{64}$/);
    const pair = scheme.pair(leaf, leaf);
    expect(pair).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('leaf hash matches the sponge of the commitment bytes', () => {
    const commitment = 'repid';
    // "repid" utf8 bytes == the bytes_repid sponge KAT input.
    expect(poseidon2LeafHash(commitment)).toBe(fieldsToHex(toBig(SPONGE_KAT[6]!.output)));
  });

  it('pair hash matches compression of the parsed digests', () => {
    const a = fieldsToHex(toBig(COMPRESSION_KAT[0]!.output));
    const b = fieldsToHex(toBig(COMPRESSION_KAT[1]!.output));
    expect(poseidon2PairHash(a, b)).toBe(
      fieldsToHex(poseidon2Compress(hexToFields(a), hexToFields(b))),
    );
  });

  it('builds a poseidon2 merkle root with verifiable inclusion proofs', () => {
    const commitments = ['0xaaa|1', '0xbbb|2', '0xccc|3', '0xddd|4', '0xeee|5'];
    const { root, leaves, scheme } = rootFromCommitments(commitments, 'poseidon2');
    expect(scheme).toBe('poseidon2');
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    const hs = getHashScheme('poseidon2');
    for (let i = 0; i < commitments.length; i++) {
      const proof = buildInclusion(leaves, i, hs);
      expect(proof.root.toLowerCase()).toBe(root.toLowerCase());
      expect(verifyInclusion(proof)).toBe(true);
    }
    // Tamper detection: a wrong sibling must fail verification.
    const proof0 = buildInclusion(leaves, 0, hs);
    const tampered = {
      ...proof0,
      siblings: proof0.siblings.map((s, idx) =>
        idx === 0 ? { ...s, hash: fieldsToHex(toBig(COMPRESSION_KAT[2]!.output)) } : s,
      ),
    };
    expect(verifyInclusion(tampered)).toBe(false);
  });
});

describe('Poseidon2-BabyBear leaf — properties', () => {
  it('is deterministic', () => {
    expect(poseidon2Sponge(toBig([1, 2, 3]))).toEqual(poseidon2Sponge(toBig([1, 2, 3])));
    expect(poseidon2Compress(toBig(COMPRESSION_KAT[1]!.left), toBig(COMPRESSION_KAT[1]!.right)))
      .toEqual(poseidon2Compress(toBig(COMPRESSION_KAT[1]!.left), toBig(COMPRESSION_KAT[1]!.right)));
  });

  it('distinguishes distinct inputs (no collapse)', () => {
    expect(poseidon2Sponge(toBig([1]))).not.toEqual(poseidon2Sponge(toBig([2])));
    expect(poseidon2Compress(toBig([1, 0, 0, 0, 0, 0, 0, 0]), toBig([0, 0, 0, 0, 0, 0, 0, 0])))
      .not.toEqual(poseidon2Compress(toBig([0, 0, 0, 0, 0, 0, 0, 0]), toBig([0, 0, 0, 0, 0, 0, 0, 0])));
  });

  it('all outputs are canonical (< p)', () => {
    const P = BigInt(2013265921);
    for (const e of poseidon2Sponge(toBig([9, 8, 7, 6, 5]))) {
      expect(e < P).toBe(true);
      expect(e >= 0n).toBe(true);
    }
  });
});
