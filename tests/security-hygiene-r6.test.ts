/**
 * R6 Phase 3 — security hygiene: tamper-evident trace, fail-closed completeness, rate-limiting.
 */
import { TraceChain, canonicalJson } from '../src/services/governance-trace';
import { SafeGovernor, RateLimiter } from '../src/services/governance-safe';

describe('trace integrity — tamper-evident hash chain', () => {
  it('a clean chain verifies ok', () => {
    const c = new TraceChain();
    c.append({ a: 1 }, 1000);
    c.append({ b: 2 }, 1001);
    c.append({ c: 3 }, 1002);
    expect(c.verify().ok).toBe(true);
  });

  it('tampering with a past entry payload is DETECTED at that seq', () => {
    const c = new TraceChain();
    c.append({ action: 'read' }, 1000);
    c.append({ action: 'DROP', tier: 'T2' }, 1001);
    c.append({ action: 'read' }, 1002);
    // Attacker rewrites the middle entry to hide the destructive action.
    (c.all()[1] as any).payload = { action: 'read', tier: 'T0' };
    const inner = (c as any).entries[1];
    inner.payload = { action: 'read', tier: 'T0' };
    const v = c.verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it('breaking a prevHash link is detected', () => {
    const c = new TraceChain();
    c.append({ x: 1 }, 1000);
    c.append({ x: 2 }, 1001);
    (c as any).entries[1].prevHash = 'deadbeef';
    expect(c.verify().ok).toBe(false);
  });

  it('canonicalJson is key-order stable (so hashes are deterministic)', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe('fail-closed completeness — every error path → safe T2', () => {
  it('(b) a throwing trace persist BLOCKS (cannot suppress the log to hide an action)', () => {
    const gov = new SafeGovernor('s', { persist: () => { throw new Error('disk full'); } });
    const v = gov.govern({ kind: 'read', paths: ['a.ts'] }, 1000);
    expect(v.blocked).toBe(true);
    expect(v.tier).toBe('T2');
    expect(v.failClosed).toBe(true);
    expect(v.reason).toMatch(/trace write failed/i);
  });

  it('(c) a throwing rate-limiter BLOCKS', () => {
    const throwingLimiter = { check: () => { throw new Error('boom'); } } as unknown as RateLimiter;
    const gov = new SafeGovernor('s', { rateLimiter: throwingLimiter });
    const v = gov.govern({ kind: 'read' }, 1000);
    expect(v.tier).toBe('T2');
    expect(v.failClosed).toBe(true);
  });

  it('(a) a throwing session/classifier BLOCKS', () => {
    const gov = new SafeGovernor('s');
    (gov as any).session.govern = () => { throw new Error('classifier exploded'); };
    const v = gov.govern({ kind: 'read' }, 1000);
    expect(v.tier).toBe('T2');
    expect(v.failClosed).toBe(true);
  });

  it('the happy path is NOT fail-closed and records a verifiable trace', () => {
    const gov = new SafeGovernor('s');
    const v = gov.govern({ kind: 'read', paths: ['a.ts'] }, 1000);
    expect(v.failClosed).toBe(false);
    expect(v.traceHash).not.toBeNull();
    expect(gov.trace.verify().ok).toBe(true);
  });
});

describe('rate-limiting — flood cannot bury a T2 or exhaust the gate', () => {
  it('a burst beyond the limit is flagged and escalated', () => {
    const gov = new SafeGovernor('flood', { rateLimiter: new RateLimiter(2, 1000) });
    gov.govern({ kind: 'read' }, 1000);
    gov.govern({ kind: 'read' }, 1000);
    const third = gov.govern({ kind: 'read' }, 1000); // 3rd in window → over limit
    expect(third.rateLimited).toBe(true);
    expect(third.tier).not.toBe('T0'); // escalated, not silently auto-proceeded
  });

  it('a T2 hidden inside a T0 flood is STILL caught (each action classified independently)', () => {
    const gov = new SafeGovernor('flood2', { rateLimiter: new RateLimiter(100, 1000) });
    for (let i = 0; i < 10; i++) gov.govern({ kind: 'read', paths: [`f${i}.ts`] }, 1000 + i);
    const evil = gov.govern({ kind: 'git', git: { operation: 'push', targetRef: 'main' } }, 1100);
    expect(evil.tier).toBe('T2');
    expect(evil.blocked).toBe(true);
  });
});
