/**
 * Backlog 4.2 — POSTCARD Poseidon2 leaf dual-write.
 *
 * The properties worth locking are behavioural, not cosmetic:
 *  - default OFF is byte-identical to the pre-4.2 path (nothing written);
 *  - a prover-supplied leaf is authoritative in EVERY mode (the engine only fills a hole);
 *  - shadow computes but persists nothing;
 *  - the engine-derived leaf EQUALS the `poseidon2` merkle scheme's leaf for the same
 *    commitment — the equality that makes the column foldable, not merely populated;
 *  - a hash failure can never break the proof write.
 */
import {
  ENGINE_LEAF_SCHEME,
  leafDualWriteMode,
  resolveLeafDualWrite,
} from '../src/zkp/leaf-dual-write';
import { getHashScheme } from '../src/zkp/merkle-root';
import { poseidon2LeafHash } from '../src/zkp/poseidon2-leaf';

const COMMITMENT = '0x9f2c1b7e4a6d3058c1e2f4a6b8d0c2e4f6a8b0d2c4e6f8a0b2d4c6e8f0a2b4d6';

describe('leafDualWriteMode', () => {
  it('defaults to off when unset', () => {
    expect(leafDualWriteMode({} as NodeJS.ProcessEnv)).toBe('off');
  });

  it('accepts on/true/enforce as on, case- and whitespace-insensitively', () => {
    for (const v of ['on', 'ON', ' true ', 'True', 'enforce']) {
      expect(leafDualWriteMode({ POSEIDON2_LEAF_DUAL_WRITE: v } as NodeJS.ProcessEnv)).toBe('on');
    }
  });

  it('accepts shadow', () => {
    expect(leafDualWriteMode({ POSEIDON2_LEAF_DUAL_WRITE: ' Shadow ' } as NodeJS.ProcessEnv)).toBe('shadow');
  });

  it('treats a typo as off, never as on (fail-safe, not fail-open)', () => {
    for (const v of ['shadwo', 'yes', '1', 'enabled', '']) {
      expect(leafDualWriteMode({ POSEIDON2_LEAF_DUAL_WRITE: v } as NodeJS.ProcessEnv)).toBe('off');
    }
  });
});

describe('resolveLeafDualWrite — mode off (the deployed default)', () => {
  it('writes nothing at all', () => {
    const r = resolveLeafDualWrite(COMMITMENT, null, null, 'off');
    expect(r).toEqual({ leaf: null, scheme: null, computed: null, source: 'none', shadowed: false });
  });

  it('still passes a prover-supplied leaf through unchanged', () => {
    const r = resolveLeafDualWrite(COMMITMENT, '0xabc', 'prover-scheme-v9', 'off');
    expect(r.leaf).toBe('0xabc');
    expect(r.scheme).toBe('prover-scheme-v9');
    expect(r.source).toBe('prover');
  });
});

describe('resolveLeafDualWrite — the prover wins when it speaks', () => {
  it.each(['off', 'shadow', 'on'] as const)('mode %s never overrides the prover', (mode) => {
    const r = resolveLeafDualWrite(COMMITMENT, '0xproverleaf', 'poseidon2_babybear', mode);
    expect(r.source).toBe('prover');
    expect(r.leaf).toBe('0xproverleaf');
    expect(r.scheme).toBe('poseidon2_babybear');
    expect(r.leaf).not.toBe(poseidon2LeafHash(COMMITMENT));
  });

  it('keeps the prover leaf but nulls the scheme when the prover omits the tag', () => {
    const r = resolveLeafDualWrite(COMMITMENT, '0xproverleaf', '', 'on');
    expect(r.leaf).toBe('0xproverleaf');
    expect(r.scheme).toBeNull();
  });
});

describe('resolveLeafDualWrite — shadow', () => {
  it('computes the digest but persists nothing', () => {
    const r = resolveLeafDualWrite(COMMITMENT, null, null, 'shadow');
    expect(r.leaf).toBeNull();
    expect(r.scheme).toBeNull();
    expect(r.shadowed).toBe(true);
    expect(r.source).toBe('engine');
    expect(r.computed).toBe(poseidon2LeafHash(COMMITMENT));
  });
});

describe('resolveLeafDualWrite — on', () => {
  it('writes the engine leaf tagged with the engine lineage scheme', () => {
    const r = resolveLeafDualWrite(COMMITMENT, null, null, 'on');
    expect(r.leaf).toBe(poseidon2LeafHash(COMMITMENT));
    expect(r.scheme).toBe(ENGINE_LEAF_SCHEME);
    expect(r.source).toBe('engine');
    expect(r.shadowed).toBe(false);
  });

  it('produces a 32-byte 0x-hex digest', () => {
    const r = resolveLeafDualWrite(COMMITMENT, null, null, 'on');
    expect(r.leaf).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic and commitment-bound (different commitment ⇒ different leaf)', () => {
    const a = resolveLeafDualWrite(COMMITMENT, null, null, 'on');
    const b = resolveLeafDualWrite(COMMITMENT, null, null, 'on');
    const c = resolveLeafDualWrite(COMMITMENT.replace(/6$/, '7'), null, null, 'on');
    expect(a.leaf).toBe(b.leaf);
    expect(c.leaf).not.toBe(a.leaf);
  });
});

describe('the load-bearing equality: engine leaf == the poseidon2 merkle scheme leaf', () => {
  // This is what makes the stored column aggregation-ready. If these ever diverge,
  // a PACKAGE-tier fold over the stored leaves would not reproduce the tree.
  it.each([
    COMMITMENT,
    '0x00',
    'not-hex-at-all',
    '0x' + 'ff'.repeat(32),
    '',
  ].filter((c) => c.length > 0))('matches getHashScheme("poseidon2").leaf for %s', (commitment) => {
    const r = resolveLeafDualWrite(commitment, null, null, 'on');
    expect(r.leaf).toBe(getHashScheme('poseidon2').leaf(commitment));
  });

  it('does NOT collide with the keccak256 or sha256 scheme leaves (it is a different family)', () => {
    const r = resolveLeafDualWrite(COMMITMENT, null, null, 'on');
    expect(r.leaf).not.toBe(getHashScheme('keccak256').leaf(COMMITMENT));
    expect(r.leaf).not.toBe(getHashScheme('sha256').leaf(COMMITMENT));
  });
});

describe('fail-safe', () => {
  it('returns inert on an empty/missing commitment rather than hashing nothing', () => {
    for (const c of ['', null, undefined]) {
      expect(resolveLeafDualWrite(c, null, null, 'on')).toEqual({
        leaf: null,
        scheme: null,
        computed: null,
        source: 'none',
        shadowed: false,
      });
    }
  });

  it('swallows a hash failure and writes no leaf (a lineage column must never fail a proof)', () => {
    // A lone surrogate is not valid UTF-8; ethers `toUtf8Bytes` throws on it, which
    // exercises the real throw path inside poseidon2LeafHash rather than a mock.
    const lone = '\uD800';
    expect(() => poseidon2LeafHash(lone)).toThrow();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = resolveLeafDualWrite(lone, null, null, 'on');
      expect(r).toEqual({ leaf: null, scheme: null, computed: null, source: 'none', shadowed: false });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
