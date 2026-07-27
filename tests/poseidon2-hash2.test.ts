/**
 * Poseidon2-BabyBear 2-to-1 scalar-hash parity gate (backlog 4.0-d.2).
 *
 * Validates `poseidon2Hash2` (`src/zkp/poseidon2-hash2.ts`) — the off-circuit
 * canonical `H_p2(a,b) = Perm16([a,b,0..])[0]` for the ownership circuit
 * leaf/nullifier — against the INDEPENDENT Rust oracle (backlog 4.0-d.1):
 * `zkp-vault/kat/poseidon2_babybear16_2to1_kat.json`, produced by Plonky3's audited
 * `default_babybear_poseidon2_16()`.
 *
 * The expected vectors below are copied verbatim from that committed oracle JSON.
 * Because the underlying TS permutation already reproduces p3's permutation
 * element-for-element (#196, gated on #195's raw KAT), matching these is genuine
 * cross-language parity — not "both wrong the same way". We ALSO cross-check against the
 * committed oracle JSON itself (belt and suspenders), and fail loud if it is missing —
 * a gate that can silently skip its own oracle is not a gate.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { BABYBEAR_P } from '../src/zkp/poseidon2-babybear';
import { poseidon2Hash2, poseidon2Hash2u32 } from '../src/zkp/poseidon2-hash2';

/** Frozen oracle vectors (verbatim from zkp-vault/kat/poseidon2_babybear16_2to1_kat.json). */
const KAT: Array<{ name: string; a: number; b: number; output: number }> = [
  { name: 'zeros', a: 0, b: 0, output: 1168947398 },
  { name: 'one_two', a: 1, b: 2, output: 509865809 },
  { name: 'leaf_777_555', a: 777, b: 555, output: 422725277 },
  { name: 'secret_agent', a: 123456789, b: 42, output: 896117012 },
  { name: 'scope_secret_ctx1', a: 999983, b: 1, output: 943144322 },
  { name: 'scope_secret_ctx2', a: 999983, b: 2, output: 1841904044 },
  { name: 'max_max', a: 2013265920, b: 2013265920, output: 1470936837 },
  { name: 'max_zero', a: 2013265920, b: 0, output: 429449726 },
];

describe('Poseidon2-BabyBear 2-to-1 scalar hash H_p2 (backlog 4.0-d.2)', () => {
  describe('parity against the Rust 2-to-1 KAT oracle (4.0-d.1)', () => {
    for (const vec of KAT) {
      it(`reproduces the frozen oracle vector "${vec.name}"`, () => {
        expect(poseidon2Hash2u32(vec.a, vec.b)).toBe(vec.output);
        expect(poseidon2Hash2(BigInt(vec.a), BigInt(vec.b))).toBe(BigInt(vec.output));
      });
    }
  });

  it('cross-checks against the committed oracle JSON', () => {
    const katPath = join(
      __dirname,
      '..',
      'zkp-vault',
      'kat',
      'poseidon2_babybear16_2to1_kat.json',
    );
    // Fail loud, never vacuously pass: this JSON is committed alongside this test (both
    // landed in the same 4.0-d.1/4.0-d.2 change) and is the oracle the whole gate rests
    // on. Skipping it on absence would turn a missing oracle into a green run.
    expect(existsSync(katPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(katPath, 'utf8')) as {
      scheme: string;
      field_prime: number;
      width: number;
      vectors: Array<{ name: string; a: number; b: number; output: number }>;
    };
    expect(parsed.field_prime).toBe(Number(BABYBEAR_P));
    // Guards against a truncated/emptied oracle silently satisfying the loop below.
    expect(parsed.vectors).toHaveLength(KAT.length);
    for (const v of parsed.vectors) {
      expect(poseidon2Hash2u32(v.a, v.b)).toBe(v.output);
    }
  });

  describe('the definition H_p2(a,b) = Perm16([a,b,0..])[0] is self-consistent with the raw permutation KAT', () => {
    // H_p2 of the zeros/leaf inputs must equal lane 0 of the RAW-permutation vectors
    // frozen in poseidon2-babybear.test.ts (#195/#196) — an internal cross-check that
    // this module reads the correct output lane of the correct permutation.
    it('H_p2(0,0) == raw permute(zeros)[0]', () => {
      expect(poseidon2Hash2u32(0, 0)).toBe(1168947398);
    });
    it('H_p2(777,555) == raw permute([777,555,0..])[0]', () => {
      expect(poseidon2Hash2u32(777, 555)).toBe(422725277);
    });
  });

  describe('cryptographic sanity properties', () => {
    it('is deterministic (pure function of its two inputs)', () => {
      expect(poseidon2Hash2u32(777, 555)).toBe(poseidon2Hash2u32(777, 555));
      expect(poseidon2Hash2(123n, 456n)).toBe(poseidon2Hash2(123n, 456n));
    });

    it('separates scopes: same secret, distinct scope -> distinct hash (Invariant 2)', () => {
      const secret = 999983;
      expect(poseidon2Hash2u32(secret, 1)).not.toBe(poseidon2Hash2u32(secret, 2));
      expect(poseidon2Hash2u32(secret, 1)).not.toBe(poseidon2Hash2u32(secret, 3));
    });

    it('is order-sensitive (not symmetric in a,b)', () => {
      expect(poseidon2Hash2u32(1, 0)).not.toBe(poseidon2Hash2u32(0, 1));
    });

    it('does not collapse distinct inputs to a constant', () => {
      const outputs = new Set(KAT.map((v) => v.output));
      expect(outputs.size).toBe(KAT.length);
    });

    it('produces canonical field outputs in [0, p)', () => {
      for (const vec of KAT) {
        const out = poseidon2Hash2(BigInt(vec.a), BigInt(vec.b));
        expect(out).toBeGreaterThanOrEqual(0n);
        expect(out).toBeLessThan(BABYBEAR_P);
      }
    });

    it('bigint and u32 wrappers agree', () => {
      expect(Number(poseidon2Hash2(777n, 555n))).toBe(poseidon2Hash2u32(777, 555));
    });
  });

  describe('input validation', () => {
    it('rejects non-canonical u32 inputs (>= p, negative, non-integer)', () => {
      expect(() => poseidon2Hash2u32(Number(BABYBEAR_P), 0)).toThrow(/canonical/);
      expect(() => poseidon2Hash2u32(0, -1)).toThrow(/canonical/);
      expect(() => poseidon2Hash2u32(1.5, 0)).toThrow(/canonical/);
    });
  });
});
