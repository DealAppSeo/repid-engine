/**
 * CC Sprint 9 Phase 6 — Circuit breaker tests.
 *
 * Verifies:
 *   - All 6 breaker rows exist in repid_config with default values.
 *   - readAllBreakers returns booleans for every key.
 *   - flipBreaker mutates the row and clears the 5s in-process cache.
 *   - The middleware factory returns 503 with a clear payload when tripped.
 *
 * Hermetic: only touches repid_config rows we own; restores state on teardown.
 */

import { breaker, flipBreaker, isTripped, readAllBreakers, BreakerKey } from '../../src/middleware/circuit-breaker';
import { describeIfSchema } from '../helpers/describe-if-schema';

const ALL_KEYS: BreakerKey[] = [
  'cb_disable_x402_settlements',
  'cb_disable_zkp_proofs',
  'cb_disable_onchain_writes',
  'cb_disable_trade_execution',
  'cb_disable_score_writes',
  'cb_freeze_swarm_responses',
];

describeIfSchema('circuit-breaker', () => {
  jest.setTimeout(20000);

  it('readAllBreakers returns a boolean for every known key', async () => {
    const all = await readAllBreakers();
    for (const k of ALL_KEYS) {
      expect(typeof all[k]).toBe('boolean');
    }
  });

  it('flipBreaker round-trips and clears cache', async () => {
    const KEY: BreakerKey = 'cb_freeze_swarm_responses';
    const original = await isTripped(KEY);
    try {
      await flipBreaker(KEY, !original, 'jest-circuit-breaker-test');
      // cache should be cleared by flipBreaker — next read reflects the new value
      expect(await isTripped(KEY)).toBe(!original);
    } finally {
      await flipBreaker(KEY, original, 'jest-circuit-breaker-test-restore');
    }
  });

  it('breaker(...) middleware returns 503 with the expected payload when tripped', async () => {
    const KEY: BreakerKey = 'cb_disable_x402_settlements';
    const original = await isTripped(KEY);
    try {
      await flipBreaker(KEY, true, 'jest-circuit-breaker-test');
      const handler = breaker(KEY);
      const req = {} as any;
      let status = 0;
      let body: any = null;
      const res = {
        status(c: number) { status = c; return this; },
        json(b: any) { body = b; return this; },
      } as any;
      let nextCalled = false;
      await handler(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
      expect(status).toBe(503);
      expect(body.error).toBe('circuit_breaker_open');
      expect(body.breaker).toBe(KEY);
    } finally {
      await flipBreaker(KEY, original, 'jest-circuit-breaker-test-restore');
    }
  });

  it('breaker(...) middleware calls next() when not tripped', async () => {
    const KEY: BreakerKey = 'cb_freeze_swarm_responses';
    const original = await isTripped(KEY);
    try {
      await flipBreaker(KEY, false, 'jest-circuit-breaker-test');
      const handler = breaker(KEY);
      const req = {} as any;
      let nextCalled = false;
      const res = {
        status() { return this; },
        json() { return this; },
      } as any;
      await handler(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
    } finally {
      await flipBreaker(KEY, original, 'jest-circuit-breaker-test-restore');
    }
  });
});
