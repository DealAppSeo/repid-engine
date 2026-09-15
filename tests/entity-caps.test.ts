/**
 * LOOP C10 — caps as config, Bronze ceiling, slash rung. SYNTHETIC.
 */
import {
  applyClaimOrTransfer,
  assertCanMintAbt,
  CapExceededError,
  capAtRung,
  displayTier,
  loadEntityCaps,
  resetEntityCapsCache,
  slashRung,
  type EntityCapsConfig,
} from '../src/identity/entity-caps';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cfg = (): EntityCapsConfig => loadEntityCaps();

describe('C10 caps', () => {
  beforeEach(() => resetEntityCapsCache());

  it('ladder is 3 → 7 → 12 → 21 from config', () => {
    expect(cfg().ladder).toEqual([3, 7, 12, 21]);
    expect(capAtRung(0)).toBe(3);
    expect(capAtRung(1)).toBe(7);
    expect(capAtRung(2)).toBe(12);
    expect(capAtRung(3)).toBe(21);
  });

  it('4th ABT under a cap-3 custodian is refused; raising the cap in CONFIG allows it', () => {
    const state = { custodian_id: '00000000-0000-4000-8000-0000000000c1', rung: 0, abt_count: 3 };
    expect(() => assertCanMintAbt(state)).toThrow(CapExceededError);

    const dir = mkdtempSync(join(tmpdir(), 'caps-'));
    const p = join(dir, 'caps.json');
    writeFileSync(
      p,
      JSON.stringify({
        ladder: [4, 7, 12, 21],
        defaultRung: 0,
        unclaimedCeiling: 'Bronze',
        displayTiers: ['Bronze', 'Silver', 'Gold', 'Platinum'],
        claimInheritsPercent: 100,
        transferVests: true,
      }),
    );
    const raised = loadEntityCaps(p);
    expect(() => assertCanMintAbt(state, raised)).not.toThrow();
  });

  it('unclaimed DBT with a Veteran-range score still displays Bronze', () => {
    expect(displayTier({ kind: 'DBT', currentRepid: 9000 })).toBe('Bronze');
    expect(displayTier({ kind: 'SBT', currentRepid: 9000 })).toBe('Platinum');
  });

  it('claim preserves 100% of score; a simulated transfer vests instead', () => {
    const claim = applyClaimOrTransfer({ earnedScore: 4321, kind: 'claim' });
    expect(claim.score_after).toBe(4321);
    expect(claim.inherited_percent).toBe(100);
    expect(claim.vested).toBe(false);
    const xfer = applyClaimOrTransfer({ earnedScore: 4321, kind: 'transfer' });
    expect(xfer.vested).toBe(true);
    expect(xfer.score_after).toBe(0);
  });

  it('slash drops the custodian a rung and blocks new slots until step-up', () => {
    const before = { custodian_id: '00000000-0000-4000-8000-0000000000c1', rung: 1, abt_count: 4 };
    expect(() => assertCanMintAbt(before)).not.toThrow(); // cap 7
    const slashed = slashRung(before);
    expect(slashed.rung).toBe(0);
    expect(() => assertCanMintAbt(slashed)).toThrow(CapExceededError); // cap 3, count 4
  });
});
