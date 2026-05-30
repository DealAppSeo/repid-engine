/**
 * Unit tests for the per-proof nonce commitment fix (sprint 2026-05-29, Part B).
 * Root cause: commitments were deterministic per (agent, score/tier) → 18.1%
 * unique across 22,780 rows. The nonce makes every proof unique.
 */
import { buildPostcardCommitment, generateNonce } from '../src/zkp/commitment';

describe('commitment nonce', () => {
  it('generateNonce yields fresh 16-byte 0x-hex values', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('same (agent,score,tier) + DIFFERENT nonce → DIFFERENT commitment (fixes collision)', () => {
    const base = { agentId: 'agent-1', score: 10, tier: 'PROBATIONARY', proverCommitment: '0xabc' };
    const c1 = buildPostcardCommitment({ ...base, nonce: generateNonce() });
    const c2 = buildPostcardCommitment({ ...base, nonce: generateNonce() });
    expect(c1).not.toBe(c2);
    expect(c1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('same inputs incl. nonce → deterministic (reproducible)', () => {
    const input = { agentId: 'agent-1', score: 10, tier: 'PROBATIONARY', nonce: '0x' + '11'.repeat(16), proverCommitment: '0xabc' };
    expect(buildPostcardCommitment(input)).toBe(buildPostcardCommitment(input));
  });

  it('1000 proofs for the SAME agent/score produce 1000 distinct commitments', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(buildPostcardCommitment({ agentId: 'stable-agent', score: 10, tier: 'PROBATIONARY', nonce: generateNonce() }));
    }
    expect(seen.size).toBe(1000); // was: 1 distinct value across thousands of rows
  });

  it('binds the prover commitment (different prover output → different result)', () => {
    const nonce = '0x' + '22'.repeat(16);
    const c1 = buildPostcardCommitment({ agentId: 'a', score: 5, tier: 'EARNING', nonce, proverCommitment: '0xaaa' });
    const c2 = buildPostcardCommitment({ agentId: 'a', score: 5, tier: 'EARNING', nonce, proverCommitment: '0xbbb' });
    expect(c1).not.toBe(c2);
  });
});
