// PR C (audit 2606.26028) — opportunity-grade delta reject.
// The reject THROWS (never truncates); the 9990 overflow backstop is a SEPARATE tool that stays.
import {
  assertDeltaWithinBound,
  OversizeDeltaError,
  clampEventDelta,
  MAX_ABS_EVENT_DELTA,
  deltaRejectBound,
  DELTA_REJECT_BOUND_DEFAULT,
} from '../src/services/wisdom-normalize';

describe('PR C — opportunity-grade delta reject bound', () => {
  // A2: an insane delta is REJECTED with a named error, and is NOT quietly turned into 9990.
  it('A2: a 12000 delta throws OversizeDeltaError and is NOT stored as 9990', () => {
    let thrown: unknown;
    try { assertDeltaWithinBound(12000, 'PREDICTION_RESOLVE'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(OversizeDeltaError);
    expect((thrown as OversizeDeltaError).delta).toBe(12000);
    // The backstop, if reached, WOULD have silently produced 9990 — the reject fires first.
    expect(clampEventDelta(12000).delta).toBe(9990);
    expect((thrown as OversizeDeltaError).delta).not.toBe(9990);
  });

  // A3: GENESIS (the genesis grant) is exempt — its observed 1940 is accepted.
  it('A3: a GENESIS delta of 1940 is accepted', () => {
    expect(() => assertDeltaWithinBound(1940, 'GENESIS')).not.toThrow();
    expect(deltaRejectBound('GENESIS')).toBe(Infinity);
  });

  // A4: an ordinary delta is accepted.
  it('A4: an ordinary delta of 42 is accepted', () => {
    expect(() => assertDeltaWithinBound(42, 'HAL_SCORE_EVENT')).not.toThrow();
  });

  // A5: the 9990 backstop is still present and still reachable.
  it('A5: the 9990 overflow backstop is present and reachable', () => {
    expect(MAX_ABS_EVENT_DELTA).toBe(9990);
    expect(clampEventDelta(50000).delta).toBe(9990);
    expect(clampEventDelta(-50000).delta).toBe(-9990);
  });

  it('per-type bounds: SERVICE_FULFILLED accepts its observed 364, rejects 600', () => {
    expect(() => assertDeltaWithinBound(364, 'SERVICE_FULFILLED')).not.toThrow();
    expect(() => assertDeltaWithinBound(600, 'SERVICE_FULFILLED')).toThrow(OversizeDeltaError);
  });

  it('default bound (100) rejects 101 on an unlisted type, both signs', () => {
    expect(() => assertDeltaWithinBound(100, 'SOME_NEW_TYPE')).not.toThrow();
    expect(() => assertDeltaWithinBound(101, 'SOME_NEW_TYPE')).toThrow(OversizeDeltaError);
    expect(() => assertDeltaWithinBound(-101, 'SOME_NEW_TYPE')).toThrow(OversizeDeltaError);
  });

  it('non-finite is left to the backstop (not treated as oversize)', () => {
    expect(() => assertDeltaWithinBound(NaN, 'HAL_SCORE_EVENT')).not.toThrow();
    expect(() => assertDeltaWithinBound(Infinity, 'HAL_SCORE_EVENT')).not.toThrow();
    expect(clampEventDelta(NaN).delta).toBe(0); // backstop handles it
  });

  it('the error names the type, delta and bound', () => {
    try {
      assertDeltaWithinBound(9000, 'VALIDATION_FAILED');
    } catch (e) {
      const err = e as OversizeDeltaError;
      expect(err.name).toBe('OversizeDeltaError');
      expect(err.eventType).toBe('VALIDATION_FAILED');
      expect(err.bound).toBe(300);
      expect(err.message).toMatch(/oversize_delta_rejected/);
    }
  });

  // A guard that silently does nothing is worse than no guard: it reports a
  // protection it is not providing. With a normal object literal these keys
  // resolve to inherited members (all truthy), so `??` never reached the
  // default, deltaRejectBound returned a FUNCTION, and `Math.abs(d) > fn` was
  // false — 999999 sailed through with no throw and no log. Measured, not
  // hypothesised. Found by Strix; fixed by giving BOUNDS a null prototype.
  it('rejects oversize deltas for prototype-named event types', () => {
    for (const evil of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(deltaRejectBound(evil)).toBe(DELTA_REJECT_BOUND_DEFAULT);
      expect(() => assertDeltaWithinBound(999999, evil)).toThrow(OversizeDeltaError);
    }
  });

  it('a prototype-named type still gets the real bound when one is declared', () => {
    // guards the fix itself: null-prototype must not break ordinary lookups
    expect(deltaRejectBound('SERVICE_FULFILLED')).toBe(500);
    expect(deltaRejectBound('GENESIS')).toBe(Infinity);
  });
});
