/**
 * Backlog 4.0-e — POSTCARD commitment sha256 -> Poseidon2, shadow-first.
 *
 * What these tests are FOR (and what they deliberately do not do):
 *  - Prove the persisted value is byte-identical to the pre-4.0-e behaviour in every
 *    supported mode. The golden sha256 vectors below were produced by an EXTERNAL tool
 *    (`printf '%s' <preimage> | sha256sum`), not by this module, so the "unchanged"
 *    claim is not self-referential.
 *  - Prove the Poseidon2 family is exactly the parity-gated leaf hash of the SAME
 *    preimage. `poseidon2LeafHash` is bit-exact against the independent Rust oracle
 *    (tests/poseidon2-leaf.test.ts, 4.0-c) — this file asserts the composition, it does
 *    not re-assert the cryptography.
 *  - Prove the persist-mode refusal is real, and quantify the reason.
 */
import {
  buildPostcardCommitment,
  generateNonce,
  postcardCommitmentPreimage,
  postcardCommitmentSha256,
  postcardCommitmentPoseidon2,
  resolveCommitmentMode,
  resetCommitmentShadowState,
  POSEIDON2_COMMITMENT_TAG,
  type PostcardCommitmentInput,
} from '../src/zkp/commitment';
import { poseidon2LeafHash, hexToFields } from '../src/zkp/poseidon2-leaf';

const BASE: PostcardCommitmentInput = {
  agentId: 'agent-1',
  score: 1234,
  tier: 'ESTABLISHED',
  nonce: '0xdeadbeef',
  proverCommitment: '0xabc',
};

// Produced OUTSIDE this module: printf '%s' 'agent-1|1234|ESTABLISHED|0xdeadbeef|0xabc' | sha256sum
const GOLDEN_SHA = '0xfb5aded46a37dcbeb4f5b9b4aeecae212e16ffa45cf265aa4b20720e0accd274';
// printf '%s' 'a|5|EARNING|0xnonce|' | sha256sum   (absent proverCommitment -> '')
const GOLDEN_SHA_NO_PROVER = '0xa115d47af48830653309f74c1142272524fd323f8e9d0c5396ffd4151d796e22';

beforeEach(() => {
  resetCommitmentShadowState();
  delete process.env.POSTCARD_COMMITMENT_MODE;
});

describe('4.0-e: the persisted value is unchanged', () => {
  it('matches an externally-computed sha256 golden vector', () => {
    expect(postcardCommitmentSha256(BASE)).toBe(GOLDEN_SHA);
    expect(buildPostcardCommitment(BASE)).toBe(GOLDEN_SHA);
  });

  it('binds an absent proverCommitment as the empty component', () => {
    const v = buildPostcardCommitment({ agentId: 'a', score: 5, tier: 'EARNING', nonce: '0xnonce' });
    expect(v).toBe(GOLDEN_SHA_NO_PROVER);
  });

  it('returns the sha256 value in shadow mode too — shadow persists nothing new', () => {
    const logs: string[] = [];
    expect(buildPostcardCommitment(BASE, { mode: 'shadow', log: (m) => logs.push(m) })).toBe(GOLDEN_SHA);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(POSEIDON2_COMMITMENT_TAG);
    expect(logs[0]).toContain(postcardCommitmentPoseidon2(BASE));
  });

  it('logs nothing at all in the default mode', () => {
    const logs: string[] = [];
    buildPostcardCommitment(BASE, { log: (m) => logs.push(m) });
    expect(logs).toEqual([]);
  });
});

describe('4.0-e: both families hash ONE shared preimage', () => {
  it('poseidon2 commitment IS the parity-gated leaf hash of the canonical preimage', () => {
    expect(postcardCommitmentPoseidon2(BASE)).toBe(poseidon2LeafHash(postcardCommitmentPreimage(BASE)));
  });

  it.each<[keyof PostcardCommitmentInput, unknown]>([
    ['agentId', 'agent-2'],
    ['score', 1235],
    ['tier', 'VETERAN'],
    ['nonce', '0xdeadbeee'],
    ['proverCommitment', '0xabd'],
  ])('changing %s changes BOTH families', (field, value) => {
    const mutated = { ...BASE, [field]: value } as PostcardCommitmentInput;
    expect(postcardCommitmentSha256(mutated)).not.toBe(postcardCommitmentSha256(BASE));
    expect(postcardCommitmentPoseidon2(mutated)).not.toBe(postcardCommitmentPoseidon2(BASE));
  });

  it('is deterministic and nonce-unique in the poseidon2 family too', () => {
    expect(postcardCommitmentPoseidon2(BASE)).toBe(postcardCommitmentPoseidon2({ ...BASE }));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(postcardCommitmentPoseidon2({ ...BASE, nonce: generateNonce() }));
    }
    expect(seen.size).toBe(200);
  });

  it('KNOWN, INHERITED: the `|` join is ambiguous — pinned so a free-text component fails here', () => {
    // Both components are engine-controlled today (uuid / number / enum / hex), so this
    // is not reachable in production. If a future field can contain `|`, this test breaks
    // and the fix must land in BOTH families at once (module header).
    const left: PostcardCommitmentInput = { agentId: 'x|1', score: 2, tier: 'T', nonce: 'n' };
    const right = { agentId: 'x', score: '1|2', tier: 'T', nonce: 'n' } as unknown as PostcardCommitmentInput;
    expect(postcardCommitmentPreimage(left)).toBe(postcardCommitmentPreimage(right));
    // ...and the ambiguity therefore propagates to BOTH families, identically.
    expect(postcardCommitmentSha256(left)).toBe(postcardCommitmentSha256(right));
    expect(postcardCommitmentPoseidon2(left)).toBe(postcardCommitmentPoseidon2(right));
  });
});

describe('4.0-e: the persist mode is refused, not silently honoured', () => {
  it.each(['poseidon2', 'on', 'enforce', 'true', '1', 'enabled', 'POSEIDON2', ' on '])(
    "'%s' resolves to sha256 and warns",
    (raw) => {
      resetCommitmentShadowState();
      const warns: string[] = [];
      expect(resolveCommitmentMode(raw, (m) => warns.push(m))).toBe('sha256');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('NOT implemented');
    }
  );

  it.each([undefined, null, '', '   ', 'sha256', 'shadwo', 'off', 'no', 'shadow-mode'])(
    "'%s' resolves to sha256 silently (fail-safe, not fail-open)",
    (raw) => {
      const warns: string[] = [];
      expect(resolveCommitmentMode(raw as string | undefined | null, (m) => warns.push(m))).toBe('sha256');
      expect(warns).toEqual([]);
    }
  );

  it.each(['shadow', 'SHADOW', ' shadow '])("only the exact token '%s' enables shadow", (raw) => {
    expect(resolveCommitmentMode(raw, () => undefined)).toBe('shadow');
  });

  it('warns only once across repeated persist-like resolutions', () => {
    const warns: string[] = [];
    for (let i = 0; i < 5; i++) resolveCommitmentMode('poseidon2', (m) => warns.push(m));
    expect(warns).toHaveLength(1);
  });

  it('reads the env var when no explicit mode is passed', () => {
    process.env.POSTCARD_COMMITMENT_MODE = 'shadow';
    const logs: string[] = [];
    expect(buildPostcardCommitment(BASE, { log: (m) => logs.push(m) })).toBe(GOLDEN_SHA);
    expect(logs).toHaveLength(1);
  });
});

describe('4.0-e: why the cutover needs a scheme tag (the measured reason)', () => {
  it('a poseidon2 commitment is always limb-canonical', () => {
    for (let i = 0; i < 50; i++) {
      const h = postcardCommitmentPoseidon2({ ...BASE, nonce: generateNonce() });
      expect(() => hexToFields(h)).not.toThrow();
    }
  });

  it('a sha256 commitment is USUALLY not — but not always, which is the whole problem', () => {
    let canonical = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const h = postcardCommitmentSha256({ ...BASE, nonce: generateNonce() });
      try {
        hexToFields(h);
        canonical++;
      } catch {
        /* expected for the overwhelming majority */
      }
    }
    // P(all 8 limbs < p) = (p/2^32)^8 = 0.2331%. Over 400 draws the expected count is
    // ~0.93, so "usually not" is the assertion that holds; "never" would be false, and
    // it is false on the live table too (131 of 56,622 distinct rows [sql:2026-07-27]).
    expect(canonical).toBeLessThan(N / 4);
  });
});

describe('4.0-e: shadow logging is bounded and cannot break a proof write', () => {
  it('samples: first 20 then every 500th, so a 40k-row drain cannot flood the log', () => {
    const logs: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      buildPostcardCommitment({ ...BASE, nonce: `0x${i}` }, { mode: 'shadow', log: (m) => logs.push(m) });
    }
    expect(logs.length).toBe(20 + 20); // 1..20, then 500,1000,...,10000
  });

  it('a poseidon2 failure is swallowed and the sha256 value still returns', () => {
    const logs: string[] = [];
    // A lone surrogate cannot be encoded to valid UTF-8 -> forces the shadow path to throw.
    const out = buildPostcardCommitment(
      { ...BASE, agentId: '\uD800' },
      { mode: 'shadow', log: (m) => logs.push(m) }
    );
    expect(out).toBe(postcardCommitmentSha256({ ...BASE, agentId: '\uD800' }));
    expect(out.startsWith('0x')).toBe(true);
    // The point is that the CATCH branch ran — a log line alone would also be emitted
    // by the happy path, so assert the failure marker and that no candidate was claimed.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('poseidon2 FAILED');
    expect(logs[0]).not.toContain(POSEIDON2_COMMITMENT_TAG);
    expect(() => postcardCommitmentPoseidon2({ ...BASE, agentId: '\uD800' })).toThrow();
  });
});
