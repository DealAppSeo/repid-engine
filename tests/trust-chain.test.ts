/**
 * trust-chain.test.ts — the scoring rules, tested as the ways a harness lies.
 *
 * Every assertion here corresponds to a false green this codebase has actually shipped: a
 * skipped check scored as a pass, an empty result printed as VERIFIED, a known defect omitted
 * so the board stayed green, and a negative finding that stayed on the page long after someone
 * fixed the thing.
 */
import {
  scoreChain,
  blocked,
  expectedFail,
  tierBypassesStake,
  type Leg,
} from '../src/e2e/trust-chain';

const pass = (id: string): Leg => ({ id, says: id, status: 'PASS', detail: 'ok' });

describe('scoreChain — NOT_CHECKED is never a pass', () => {
  it('exits 2, not 0, when a leg was not checked', () => {
    const v = scoreChain([pass('a'), { id: 'b', says: 'b', status: 'NOT_CHECKED', detail: 'no creds' }]);
    expect(v.exitCode).toBe(2);
  });

  it('exits 2 when a leg is BLOCKED by an earlier one', () => {
    const v = scoreChain([pass('a'), blocked('b', 'b', 'a')]);
    expect(v.exitCode).toBe(2);
  });

  it('exits 0 only when every leg passed (or is a known debt)', () => {
    expect(scoreChain([pass('a'), pass('b')]).exitCode).toBe(0);
  });

  it('a real failure exits 1 and outranks NOT_CHECKED', () => {
    const v = scoreChain([
      { id: 'a', says: 'a', status: 'FAILED', detail: 'broken' },
      { id: 'b', says: 'b', status: 'NOT_CHECKED', detail: 'unknown' },
    ]);
    expect(v.exitCode).toBe(1);
  });
});

describe('EXPECTED_FAIL — a known debt must not go red every run, nor read as a pass', () => {
  const known = expectedFail({
    id: 'concurrency',
    says: 'two agents cannot both spend the same stake',
    ref: 'x402-gate.ts fire-and-forget audit insert',
    stillBroken: true,
    detail: 'daily_used is summed from a row that is not awaited',
  });

  it('does not fail the run — a leg that is red every time trains the reader to ignore red', () => {
    expect(scoreChain([pass('a'), known]).exitCode).toBe(0);
  });

  it('is NOT counted among the passing legs', () => {
    const v = scoreChain([pass('a'), known]);
    expect(v.summary).toMatch(/1\/2 passed/);
    expect(v.summary).toMatch(/1 known-broken/);
  });

  it('carries the reference that makes the label checkable', () => {
    expect(known.ref).toBeTruthy();
    expect(known.status).toBe('EXPECTED_FAIL');
  });

  it('a known defect that STARTS PASSING is reported, not silently upgraded', () => {
    // The whole point: negative findings decay silently. Someone fixes the defect and no
    // surface notices, so the doc keeps asserting a bug that is gone.
    const fixed = expectedFail({
      id: 'concurrency',
      says: 'two agents cannot both spend the same stake',
      ref: 'x402-gate.ts fire-and-forget audit insert',
      stillBroken: false,
      detail: 'the reservation now holds',
    });
    expect(fixed.status).toBe('EXPECTED_FAIL_NOW_PASSING');
    expect(fixed.detail).toMatch(/EXPECTED TO FAIL AND DID NOT/);
    expect(scoreChain([fixed]).summary).toMatch(/NOW PASSING/);
  });

  it('an EXPECTED_FAIL_NOW_PASSING is surfaced even in an otherwise clean run', () => {
    const v = scoreChain([pass('a'), expectedFail({
      id: 'x', says: 'x', ref: 'r', stillBroken: false, detail: 'd',
    })]);
    expect(v.summary).toMatch(/the record is stale/);
  });
});

describe('blocked — a leg nobody could evaluate is not a leg that failed', () => {
  it('names the leg that blocked it and refuses to be read as a failure', () => {
    const b = blocked('chain', 'the staking human owns the spending agent', 'bind');
    expect(b.status).toBe('BLOCKED');
    expect(b.detail).toMatch(/"bind" did not pass/);
    expect(b.detail).toMatch(/must not be read as one/);
  });
});

describe('tierBypassesStake — the latent hole', () => {
  it('flags exactly the two tiers whose requires_stake is false', () => {
    expect(tierBypassesStake('AUTONOMOUS')).toBe(true);
    expect(tierBypassesStake('VETERAN')).toBe(true);
    expect(tierBypassesStake('ESTABLISHED')).toBe(false);
    expect(tierBypassesStake('EARNING')).toBe(false);
    expect(tierBypassesStake('PROBATIONARY')).toBe(false);
  });

  it('is case-insensitive and safe on null — an unknown tier must not read as bypassing', () => {
    expect(tierBypassesStake('veteran')).toBe(true);
    expect(tierBypassesStake(null)).toBe(false);
    expect(tierBypassesStake(undefined)).toBe(false);
    expect(tierBypassesStake('NONSENSE')).toBe(false);
  });
});
