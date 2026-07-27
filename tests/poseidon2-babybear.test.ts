/**
 * Poseidon2-BabyBear TS parity gate (backlog 4.0-b).
 *
 * Validates the from-scratch TS permutation (`src/zkp/poseidon2-babybear.ts`)
 * against the INDEPENDENT Rust KAT oracle (backlog 4.0-a, PR #195):
 * `zkp-vault/kat/poseidon2_babybear16_kat.json`, produced by Plonky3's audited
 * `p3_baby_bear::default_babybear_poseidon2_16()`.
 *
 * The expected vectors below are copied verbatim from that committed oracle JSON.
 * PR #195's `published_rng_vector_reproduces` test proves the oracle harness calls
 * p3 correctly (it reproduces p3-poseidon2 0.3.0's OWN published width-16 vector),
 * so matching these is genuine cross-language parity — not "both wrong the same way".
 * If `zkp-vault/kat/poseidon2_babybear16_kat.json` is present on disk, we ALSO
 * cross-check against it directly (belt and suspenders).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  BABYBEAR_P,
  INTERNAL_DIAG_16,
  POSEIDON2_WIDTH,
  poseidon2Permute16,
  poseidon2Permute16u32,
} from '../src/zkp/poseidon2-babybear';

/** The frozen oracle vectors (verbatim from zkp-vault/kat/poseidon2_babybear16_kat.json). */
const KAT: Array<{ name: string; input: number[]; output: number[] }> = [
  {
    name: 'zeros',
    input: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    output: [
      1168947398, 128782440, 747404447, 883925857, 360581875, 1704698758, 1878363991, 1054281681,
      682225194, 705839125, 1218819873, 41544645, 1095344608, 174996601, 1678438226, 11259290,
    ],
  },
  {
    name: 'iota',
    input: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    output: [
      1906786279, 1737026427, 1959749225, 700325316, 1638050605, 1021608788, 1726691001,
      1761127344, 1552405120, 417318995, 36799261, 1215172152, 614923223, 1300746575, 957311597,
      304856115,
    ],
  },
  {
    name: 'ones',
    input: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    output: [
      1607442146, 1676863504, 74171774, 1027473481, 903407411, 908950222, 104477602, 2007030265,
      446104774, 602432596, 534407330, 1149883704, 1005849640, 1234792612, 1595133452, 176734963,
    ],
  },
  {
    name: 'leaf_777_555',
    input: [777, 555, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    output: [
      422725277, 1581034804, 1057071425, 346283028, 136171787, 85690020, 1217386996, 1125229924,
      1977276789, 290529933, 792620854, 1998043765, 1814053164, 452246913, 1805057740, 106202400,
    ],
  },
];

describe('Poseidon2-BabyBear width-16 permutation (backlog 4.0-b)', () => {
  describe('parity against the Rust KAT oracle (PR #195, p3-baby-bear 0.3.0)', () => {
    for (const vec of KAT) {
      it(`reproduces the frozen oracle vector "${vec.name}" element-for-element`, () => {
        expect(poseidon2Permute16u32(vec.input)).toEqual(vec.output);
      });
    }
  });

  it('cross-checks against the committed oracle JSON when present on disk', () => {
    const katPath = join(__dirname, '..', 'zkp-vault', 'kat', 'poseidon2_babybear16_kat.json');
    if (!existsSync(katPath)) {
      // File lives on the 4.0-a branch/PR #195; absent on a fresh off-main checkout.
      // The embedded KAT above is the authoritative copy — nothing to do here.
      return;
    }
    const parsed = JSON.parse(readFileSync(katPath, 'utf8')) as {
      scheme: string;
      field_prime: number;
      width: number;
      vectors: Array<{ name: string; input: number[]; output: number[] }>;
    };
    expect(parsed.field_prime).toBe(Number(BABYBEAR_P));
    expect(parsed.width).toBe(POSEIDON2_WIDTH);
    for (const v of parsed.vectors) {
      expect(poseidon2Permute16u32(v.input)).toEqual(v.output);
    }
  });

  describe('field & structural invariants', () => {
    it('is deterministic (pure function of input)', () => {
      const input = [777, 555, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      expect(poseidon2Permute16u32(input)).toEqual(poseidon2Permute16u32(input));
    });

    it('produces canonical field outputs in [0, p)', () => {
      const out = poseidon2Permute16(KAT[1]!.input.map((v) => BigInt(v)));
      expect(out).toHaveLength(POSEIDON2_WIDTH);
      for (const e of out) {
        expect(e).toBeGreaterThanOrEqual(0n);
        expect(e).toBeLessThan(BABYBEAR_P);
      }
    });

    it('diffuses (all-zeros input does not map to all-zeros — round constants applied)', () => {
      const out = poseidon2Permute16u32(new Array(16).fill(0));
      expect(out.some((e) => e !== 0)).toBe(true);
    });

    it('bigint and u32 wrappers agree', () => {
      const u32 = poseidon2Permute16u32(KAT[2]!.input);
      const big = poseidon2Permute16(KAT[2]!.input.map((v) => BigInt(v)));
      expect(big.map((v) => Number(v))).toEqual(u32);
    });

    it('has the correct internal diagonal V[0] = -2 mod p and V[1..2] = 1, 2', () => {
      expect(INTERNAL_DIAG_16[0]).toBe(BABYBEAR_P - 2n);
      expect(INTERNAL_DIAG_16[1]).toBe(1n);
      expect(INTERNAL_DIAG_16[2]).toBe(2n);
      expect(INTERNAL_DIAG_16).toHaveLength(POSEIDON2_WIDTH);
    });
  });

  describe('input validation', () => {
    it('rejects wrong-length input', () => {
      expect(() => poseidon2Permute16u32([1, 2, 3])).toThrow(/expected 16/);
      expect(() => poseidon2Permute16([1n, 2n, 3n])).toThrow(/expected 16/);
    });

    it('rejects non-canonical u32 input (>= p, negative, non-integer)', () => {
      const base = new Array(16).fill(0);
      expect(() => poseidon2Permute16u32([Number(BABYBEAR_P), ...base.slice(1)])).toThrow(/canonical/);
      expect(() => poseidon2Permute16u32([-1, ...base.slice(1)])).toThrow(/canonical/);
      expect(() => poseidon2Permute16u32([1.5, ...base.slice(1)])).toThrow(/canonical/);
    });
  });
});
