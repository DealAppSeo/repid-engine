/**
 * stake-authority-resolver — the safety properties, each tested as the thing that would let real
 * money out the door if it broke.
 *
 * Synthetic rows on purpose: [V 2026-08-11] no production builder both owns an agent AND has
 * staked (depositor and agent-owner sets are disjoint), so prod cannot yet exercise these paths.
 * Testing them now is what makes the first real stake a measurement instead of a scramble.
 */
import {
  compareToLiveGate,
  resolveCollateral,
  type AgentOwnership,
  type StakeDepositRow,
} from '../src/services/stake-authority-resolver';

const owner: AgentOwnership = { agentName: 'trinity-veritas', builderId: 'b-1' };
const dep = (over: Partial<StakeDepositRow> = {}): StakeDepositRow => ({
  builder_id: 'b-1',
  amount: 10_000_000, // $10
  status: 'active',
  is_simulated: false,
  ...over,
});

describe('simulated collateral never backs real authority', () => {
  it('THE ONE THAT MATTERS: demo money is excluded from the sum', () => {
    const r = resolveCollateral(owner, [dep(), dep({ is_simulated: true, amount: 999_000_000 })]);
    expect(r.collateralUsdc).toBe(10);
    expect(r.simulatedExcluded).toBe(1);
  });

  it('an agent backed ONLY by simulated deposits has zero authority-backing collateral', () => {
    const r = resolveCollateral(owner, [dep({ is_simulated: true }), dep({ is_simulated: true })]);
    expect(r.collateralRaw).toBe(0);
    expect(r.depositsConsidered).toBe(2);
    expect(r.basis).toMatch(/EXCLUDED/);
  });

  it('a null is_simulated is treated as REAL (only an explicit true excludes)', () => {
    expect(resolveCollateral(owner, [dep({ is_simulated: null })]).collateralUsdc).toBe(10);
  });
});

describe('an unresolved owner yields zero, never a guess', () => {
  it('no builder_id -> zero, flagged, and it says why', () => {
    const r = resolveCollateral({ agentName: 'orphan', builderId: null }, [dep()]);
    expect(r.collateralRaw).toBe(0);
    expect(r.unresolvedOwner).toBe(true);
    expect(r.basis).toMatch(/rather than guessing an owner/);
  });

  it("never counts another builder's deposits", () => {
    const r = resolveCollateral(owner, [dep({ builder_id: 'b-2', amount: 500_000_000 })]);
    expect(r.collateralRaw).toBe(0);
    expect(r.depositsConsidered).toBe(0);
  });

  it('distinguishes "no collateral" from "could not tell"', () => {
    const noCollateral = resolveCollateral(owner, []);
    const couldNotTell = resolveCollateral({ agentName: 'x', builderId: null }, [dep()]);
    expect(noCollateral.collateralRaw).toBe(couldNotTell.collateralRaw); // both 0 ...
    expect(noCollateral.unresolvedOwner).toBe(false); // ... but they are different facts
    expect(couldNotTell.unresolvedOwner).toBe(true);
  });
});

describe('only ACTIVE deposits count', () => {
  it('withdrawn and pending rows are ignored', () => {
    const r = resolveCollateral(owner, [
      dep(),
      dep({ status: 'withdrawn', amount: 999_000_000 }),
      dep({ status: 'pending', amount: 999_000_000 }),
    ]);
    expect(r.collateralUsdc).toBe(10);
    expect(r.depositsConsidered).toBe(1);
  });

  it('a null amount contributes nothing rather than NaN', () => {
    const r = resolveCollateral(owner, [dep({ amount: null }), dep()]);
    expect(Number.isFinite(r.collateralRaw)).toBe(true);
    expect(r.collateralUsdc).toBe(10);
  });
});

describe('the shadow comparison surfaces OVER-crediting, which is the dangerous direction', () => {
  it('flags the live gate crediting authority the collateral does not support', () => {
    // The prod shape today: the gate sums prediction wagers; real collateral is zero.
    const c = compareToLiveGate(owner, [], 175.5);
    expect(c.correctedCollateralUsdc).toBe(0);
    expect(c.divergenceUsdc).toBeCloseTo(-175.5, 6);
    expect(c.currentOverCredits).toBe(true);
  });

  it('under-crediting is reported but NOT flagged as over-credit', () => {
    const c = compareToLiveGate(owner, [dep({ amount: 50_000_000 })], 0);
    expect(c.correctedCollateralUsdc).toBe(50);
    expect(c.divergenceUsdc).toBeCloseTo(50, 6);
    expect(c.currentOverCredits).toBe(false); // the safe direction — today's defect
  });

  it('agreement shows zero divergence', () => {
    const c = compareToLiveGate(owner, [dep()], 10);
    expect(c.divergenceUsdc).toBe(0);
    expect(c.currentOverCredits).toBe(false);
  });

  it('carries the basis so a log line explains itself', () => {
    expect(compareToLiveGate(owner, [dep()], 0).basis).toMatch(/real active deposit/);
  });

  it('TODAY’S PROD SHAPE: disjoint owner sets -> zero, correctly and uselessly', () => {
    // 43 agents carry a builder_id; 47 builders deposited; the overlap is zero.
    const c = compareToLiveGate({ agentName: 'trinity-orch', builderId: 'agent-owner' },
      [dep({ builder_id: 'depositor-who-owns-no-agent' })], 0);
    expect(c.correctedCollateralUsdc).toBe(0);
    expect(c.divergenceUsdc).toBe(0); // identical to the live gate -> proves nothing yet
  });
});

describe('purity', () => {
  it('does not mutate its inputs', () => {
    const rows = [dep(), dep({ is_simulated: true })];
    const snapshot = JSON.stringify(rows);
    resolveCollateral(owner, rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it('same inputs, same verdict', () => {
    expect(resolveCollateral(owner, [dep()])).toEqual(resolveCollateral(owner, [dep()]));
  });
});
