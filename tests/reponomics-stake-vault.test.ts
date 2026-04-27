/**
 * Reponomics — stake vault math tests.
 *
 * Pure-function tests don't need to mock the db module; they exercise
 * computeAuthority and babylonianSqrt directly. The DB-touching paths
 * (depositStake / withdrawStake / snapshotAuthority) are covered by
 * the two-builder snapshot test.
 */

import { computeAuthority, babylonianSqrt, BUILDER_FLOOR } from '../src/services/stake-vault';

describe('stake-vault — babylonian sqrt', () => {
  it('zero', () => expect(babylonianSqrt(0n)).toBe(0n));

  it('squares are exact: sqrt(10000) = 100', () => {
    expect(babylonianSqrt(10000n)).toBe(100n);
  });

  it('1_000_000_000 (= $1000 USDC) → ~31_622', () => {
    // Babylonian within a couple of integer units.
    const r = babylonianSqrt(1_000_000_000n);
    expect(r).toBeGreaterThanOrEqual(31_622n);
    expect(r).toBeLessThanOrEqual(31_624n);
  });

  it('50_000_000 (= $50 USDC) → ~7_071', () => {
    const r = babylonianSqrt(50_000_000n);
    expect(r).toBeGreaterThanOrEqual(7_070n);
    expect(r).toBeLessThanOrEqual(7_072n);
  });
});

describe('stake-vault — computeAuthority math', () => {
  it('Builder W (wealthy operator, $1000, sybil agent)', () => {
    const r = computeAuthority({
      stakeAmount: 1_000_000_000n,
      agentRepId: 5500,
      agentWisdom: 900,
      agentCharacter: 600,
      builderRepId: 5500,
    });
    // combinedScore = (5500 * 900 * 600) / 1_000_000 = 2970
    // stakeSqrt ≈ 31_623 → authority ≈ 31_623 * 2970 / 10000 ≈ 9_392
    expect(r.authority).toBeGreaterThanOrEqual(9_300n);
    expect(r.authority).toBeLessThanOrEqual(9_500n);
    expect(r.breakdown.builderFloorPassed).toBe(true);
    expect(r.breakdown.combinedScore).toBe('2970');
  });

  it('Builder M (mission, $50, mission-aligned agent)', () => {
    const r = computeAuthority({
      stakeAmount: 50_000_000n,
      agentRepId: 7000,
      agentWisdom: 1500,
      agentCharacter: 1700,
      builderRepId: 7000,
    });
    // combinedScore = (7000 * 1500 * 1700) / 1_000_000 = 17850
    // stakeSqrt ≈ 7_071 → authority ≈ 7_071 * 17850 / 10000 ≈ 12_622
    expect(r.authority).toBeGreaterThanOrEqual(12_500n);
    expect(r.authority).toBeLessThanOrEqual(12_700n);
    expect(r.breakdown.combinedScore).toBe('17850');
  });

  it('crossover: Builder M (less stake) outperforms Builder W (more stake)', () => {
    const w = computeAuthority({
      stakeAmount: 1_000_000_000n,
      agentRepId: 5500, agentWisdom: 900, agentCharacter: 600,
      builderRepId: 5500,
    });
    const m = computeAuthority({
      stakeAmount: 50_000_000n,
      agentRepId: 7000, agentWisdom: 1500, agentCharacter: 1700,
      builderRepId: 7000,
    });
    expect(m.authority).toBeGreaterThan(w.authority);
  });

  it('quadratic property: 100x stake yields ~10x authority (not 100x)', () => {
    const small = computeAuthority({
      stakeAmount: 100_000_000n,                    // $100
      agentRepId: 6000, agentWisdom: 1000, agentCharacter: 1000,
      builderRepId: 6000,
    });
    const big = computeAuthority({
      stakeAmount: 10_000_000_000n,                  // $10,000 (100×)
      agentRepId: 6000, agentWisdom: 1000, agentCharacter: 1000,
      builderRepId: 6000,
    });
    const ratio = Number(big.authority) / Number(small.authority);
    expect(ratio).toBeGreaterThanOrEqual(9);
    expect(ratio).toBeLessThanOrEqual(11);
  });

  it('builder below floor returns 0n with reason', () => {
    const r = computeAuthority({
      stakeAmount: 1_000_000_000n,
      agentRepId: 9000, agentWisdom: 2000, agentCharacter: 2000,
      builderRepId: BUILDER_FLOOR - 1,
    });
    expect(r.authority).toBe(0n);
    expect(r.breakdown.builderFloorPassed).toBe(false);
    expect(r.breakdown.reason).toMatch(/below floor/);
  });

  it('zero stake yields zero authority', () => {
    const r = computeAuthority({
      stakeAmount: 0n,
      agentRepId: 7000, agentWisdom: 1500, agentCharacter: 1700,
      builderRepId: 7000,
    });
    expect(r.authority).toBe(0n);
    expect(r.breakdown.builderFloorPassed).toBe(true);
  });
});
