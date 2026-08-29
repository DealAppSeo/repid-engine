/**
 * `builderFloorPassed: true` WAS REPORTED BY TWO PATHS THAT NEVER CONSULTED THE FLOOR.
 *
 * `computeAuthority` has three routes to a non-zero authority and only ONE of them evaluates
 * `BUILDER_FLOOR`:
 *
 *   1. normal          — compares builderRepId against BUILDER_FLOOR. Honest.
 *   2. isDemoBuilder   — a token_only builder. Takes an entirely different formula
 *                        (stake x pctOfStake) and never looks at the floor.
 *   3. isFreshDemo     — builderRepId 0 AND agentRepId 0. Skips the floor comparison AND
 *                        substitutes fabricated scores for the ones it does not have.
 *
 * All three wrote `builderFloorPassed: true` into `stake_authority_snapshots.basis`. Routes 2
 * and 3 therefore recorded a PASS for a check that was never performed — the same NOT_CHECKED-
 * scored-as-a-verdict shape that cost twelve days of disputed contracts, pointed the other way:
 * there a missing measurement became FAILED, here it becomes PASSED.
 *
 * A boolean CANNOT express this, which is why the fix is not "flip it to false": "the floor
 * rejected you" and "the floor was never applied" are different claims, and collapsing them is
 * how two outcomes become one. Hence `floorCheck`, which has three.
 *
 * THESE TESTS ASSERT THE RECORD, NOT THE MONEY. No authority value changes here, deliberately —
 * whether a keyless token_only builder should hold authority at all is a policy question for a
 * human, and this change exists so that question is answerable from the audit trail instead of
 * invisible in it.
 */
import { computeAuthority, BUILDER_FLOOR } from '../src/services/authority-math';

const base = {
  stakeAmount: 100_000_000n,
  agentRepId: 3000,
  agentWisdom: 800,
  agentCharacter: 600,
  builderRepId: 1500,
};

describe('floorCheck — three outcomes, because a boolean cannot hold this', () => {
  it('normal builder above the floor: the floor RAN and PASSED', () => {
    const r = computeAuthority(base);
    expect(r.breakdown.floorCheck).toBe('PASSED');
    expect(r.authority).toBeGreaterThan(0n);
  });

  it('normal builder below the floor: the floor RAN and FAILED', () => {
    const r = computeAuthority({ ...base, builderRepId: BUILDER_FLOOR - 1 });
    expect(r.breakdown.floorCheck).toBe('FAILED');
    expect(r.authority).toBe(0n);
  });

  it('token_only builder: NOT_APPLIED — and it still gets authority, which is the point', () => {
    const r = computeAuthority({ ...base, builderRepId: 0, isDemoBuilder: true });
    expect(r.breakdown.floorCheck).toBe('NOT_APPLIED');
    // The bypass is real and is NOT being closed here. It is being made legible.
    expect(r.authority).toBeGreaterThan(0n);
    expect(r.breakdown.reason).toMatch(/token_only/);
  });

  it('fresh demo builder: NOT_APPLIED, and the record says the scores were SUBSTITUTED', () => {
    const r = computeAuthority({ ...base, builderRepId: 0, agentRepId: 0 });
    expect(r.breakdown.floorCheck).toBe('NOT_APPLIED');
    expect(r.authority).toBeGreaterThan(0n);
    // A reader must not mistake the fabricated 5500/800/600 for measured reputation.
    expect(r.breakdown.reason).toMatch(/substituted/i);
  });

  it('a below-floor builder is never NOT_APPLIED just because its agent has no score', () => {
    // agentRepId 0 alone must not trigger the fresh-demo bypass — only 0 AND 0 does.
    const r = computeAuthority({ ...base, builderRepId: 100, agentRepId: 0 });
    expect(r.breakdown.floorCheck).toBe('FAILED');
    expect(r.authority).toBe(0n);
  });
});

describe('the legacy boolean stays, and stays lossy on purpose', () => {
  it('still true on both bypass paths, so nothing reading it changes behaviour', () => {
    expect(computeAuthority({ ...base, builderRepId: 0, isDemoBuilder: true })
      .breakdown.builderFloorPassed).toBe(true);
    expect(computeAuthority({ ...base, builderRepId: 0, agentRepId: 0 })
      .breakdown.builderFloorPassed).toBe(true);
  });

  it('and it is exactly floorCheck !== FAILED — the collapse is explicit, not accidental', () => {
    for (const args of [
      base,
      { ...base, builderRepId: BUILDER_FLOOR - 1 },
      { ...base, builderRepId: 0, isDemoBuilder: true },
      { ...base, builderRepId: 0, agentRepId: 0 },
    ]) {
      const r = computeAuthority(args);
      expect(r.breakdown.builderFloorPassed).toBe(r.breakdown.floorCheck !== 'FAILED');
    }
  });
});
