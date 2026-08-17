/**
 * verdict-reachability-audit.test.ts
 *
 * Only `computeVerdict` is unit-testable here — the rest of the script does live I/O against
 * `qnnpjhlxljtqyigedwkb.supabase.co`, which this sandbox cannot reach (verified: running the
 * script produces exit code 2, NOT_CHECKED, rather than a false pass). `computeVerdict` is the
 * pure decision the script makes once it HAS a count, and it is what a future CI gate would call.
 */
import { computeVerdict, BASELINE_UNREACHABLE, BASELINE_DATE } from '../scripts/verdict-reachability-audit';

describe('computeVerdict', () => {
  it('at the baseline: no regression', () => {
    const v = computeVerdict(BASELINE_UNREACHABLE);
    expect(v).toEqual({ regressed: false, growth: 0, exitCode: 0 });
  });

  it('below the baseline (partial cleanup): no regression, growth negative', () => {
    const v = computeVerdict(BASELINE_UNREACHABLE - 100);
    expect(v.regressed).toBe(false);
    expect(v.growth).toBe(-100);
    expect(v.exitCode).toBe(0);
  });

  it('one row above baseline: REGRESSED — the boundary is exclusive of baseline itself', () => {
    const v = computeVerdict(BASELINE_UNREACHABLE + 1);
    expect(v).toEqual({ regressed: true, growth: 1, exitCode: 1 });
  });

  it('a large jump: growth is reported exactly, not clamped or rounded', () => {
    const v = computeVerdict(BASELINE_UNREACHABLE + 3063);
    // 3063 chosen deliberately: it is the count of a DIFFERENT, legitimate shape
    // (flagged-below-0.40) from the same investigation. If someone ever wires the wrong
    // predicate into the live query, this is the size of jump that mistake would produce —
    // pinning the arithmetic here means that mistake reads as an obviously wrong number, not a
    // silent pass.
    expect(v).toEqual({ regressed: true, growth: 3063, exitCode: 1 });
  });

  it('accepts a custom baseline without mutating the exported default', () => {
    const v = computeVerdict(50, 40);
    expect(v).toEqual({ regressed: true, growth: 10, exitCode: 1 });
    expect(BASELINE_UNREACHABLE).toBe(568); // the module constant is untouched
  });

  it('zero unreachable rows is a real result, not falsy-skipped', () => {
    const v = computeVerdict(0);
    expect(v.regressed).toBe(false);
    expect(v.growth).toBe(-568);
  });
});

describe('the baseline is dated, so staleness is visible', () => {
  it('BASELINE_DATE matches the measurement the number came from', () => {
    // If this ever drifts from reports/2026-08-17/LEDGER-VERDICT-REACHABILITY.md, that report's
    // own baseline claim and this constant would silently disagree. There is no code check that
    // can catch that — recorded here as the assertion a human keeps honest by hand.
    expect(BASELINE_DATE).toBe('2026-08-17');
  });
});
