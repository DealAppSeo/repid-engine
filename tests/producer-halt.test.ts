/**
 * L2 breaker 2.1 — producer kill-switch (drain-only halt).
 * Pure lever: PRODUCER_HALT_CLASSES gates whether a task class may be spawned.
 * Fail-safe (only ever skips a spawn) + reversible (unset → resume).
 */
import { parseHaltClasses, isProducerHalted } from '../src/services/producer-halt';

describe('parseHaltClasses (breaker 2.1)', () => {
  test('unset / empty → empty set (nothing halted, legacy default)', () => {
    expect(parseHaltClasses(undefined).size).toBe(0);
    expect(parseHaltClasses(null).size).toBe(0);
    expect(parseHaltClasses('').size).toBe(0);
    expect(parseHaltClasses('   ').size).toBe(0);
  });

  test('normalizes case, whitespace, and drops empty tokens', () => {
    const s = parseHaltClasses('  Peer_Verify , FOO ,, ');
    expect(s.has('peer_verify')).toBe(true);
    expect(s.has('foo')).toBe(true);
    expect(s.size).toBe(2); // trailing empties dropped
  });
});

describe('isProducerHalted (breaker 2.1)', () => {
  test('env unset → not halted (default behavior preserved)', () => {
    expect(isProducerHalted('peer_verify', undefined)).toBe(false);
    expect(isProducerHalted('peer_verify', '')).toBe(false);
  });

  test('class listed → halted; class absent → not halted', () => {
    expect(isProducerHalted('peer_verify', 'peer_verify')).toBe(true);
    expect(isProducerHalted('peer_verify', 'peer_verify,other')).toBe(true);
    expect(isProducerHalted('other_class', 'peer_verify')).toBe(false);
  });

  test('case-insensitive match on both sides', () => {
    expect(isProducerHalted('PEER_VERIFY', 'peer_verify')).toBe(true);
    expect(isProducerHalted('peer_verify', 'PEER_VERIFY')).toBe(true);
  });

  test('"all" / "*" → global halt of every class', () => {
    expect(isProducerHalted('peer_verify', 'all')).toBe(true);
    expect(isProducerHalted('anything', 'all')).toBe(true);
    expect(isProducerHalted('peer_verify', '*')).toBe(true);
    expect(isProducerHalted('peer_verify', 'foo,all')).toBe(true);
  });

  test('fail-safe: a garbage/whitespace value never halts a real class', () => {
    expect(isProducerHalted('peer_verify', ' , , ')).toBe(false);
  });
});
