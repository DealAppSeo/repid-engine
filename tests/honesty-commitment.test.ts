/**
 * PHASE A — honesty-stack commitment: tamper-evidence + uniqueness.
 */
import { buildHonestyCommitment, hashText, generateNonce, type HonestyStack } from '../src/zkp/commitment';

const base = (): HonestyStack => ({
  agent_id: '11111111-1111-1111-1111-111111111111',
  prompt_hash: hashText('is the earth flat?'),
  decision_text_hash: hashText('vetoed|2 families FALSE|escalate'),
  nonce: '0x00000000000000000000000000000000',
  timestamp: '2026-06-15T00:00:00.000Z',
  sbfa_decision: 'escalate',
  hal_score: 0.82,
});

describe('honesty commitment', () => {
  test('deterministic for identical inputs', () => {
    expect(buildHonestyCommitment(base())).toBe(buildHonestyCommitment(base()));
  });

  test('is a 0x-prefixed sha256 (32-byte) hex', () => {
    expect(buildHonestyCommitment(base())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('TAMPER-EVIDENT: changing ANY bound field changes the commitment', () => {
    const c0 = buildHonestyCommitment(base());
    const mutate: Array<(h: HonestyStack) => void> = [
      (h) => (h.agent_id = '22222222-2222-2222-2222-222222222222'),
      (h) => (h.prompt_hash = hashText('different prompt')),
      (h) => (h.decision_text_hash = hashText('clean|no FALSE')),
      (h) => (h.nonce = generateNonce()),
      (h) => (h.timestamp = '2026-06-16T00:00:00.000Z'),
      (h) => (h.sbfa_decision = 'act'),
      (h) => (h.hal_score = 0.5),
    ];
    for (const m of mutate) {
      const h = base();
      m(h);
      expect(buildHonestyCommitment(h)).not.toBe(c0);
    }
  });

  test('a swapped agent_id yields a DIFFERENT commitment (no silent identity swap)', () => {
    const a = base();
    const b = { ...base(), agent_id: '99999999-9999-9999-9999-999999999999' };
    expect(buildHonestyCommitment(a)).not.toBe(buildHonestyCommitment(b));
  });

  test('fresh nonce makes re-proofs of the SAME decision unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(buildHonestyCommitment({ ...base(), nonce: generateNonce() }));
    }
    expect(seen.size).toBe(50);
  });

  test('hashText is stable + 0x-hex', () => {
    expect(hashText('x')).toBe(hashText('x'));
    expect(hashText('x')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashText('x')).not.toBe(hashText('y'));
  });
});
