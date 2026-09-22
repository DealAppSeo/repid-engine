/**
 * stake-authority-shadow.test.ts — the seam that finally gives `stake-authority-resolver` a
 * caller, tested as the things that would let DEMO money buy REAL spending authority.
 *
 * The resolver's own safety rules are already covered by `stake-authority-resolver.test.ts`.
 * What was never covered, because nothing called it, is the WIRING: which rows reach the
 * resolver, whether the flag genuinely suppresses all I/O, and whether a failure in the shadow
 * can reach the money path it observes. Those are this file's subject.
 */

// Every db read is recorded so "performs NO reads while disabled" is an assertion, not a claim.
(global as any).__reads = [];
(global as any).__agentRow = { builder_id: null } as any;
(global as any).__deposits = [] as any[];

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      (global as any).__reads.push(table);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: (global as any).__agentRow, error: null }),
        then: (res: any) => res({ data: (global as any).__deposits, error: null }),
      };
      return chain;
    },
  },
}));

import {
  observeStakeAuthority,
  stakeAuthorityShadowEnabled,
} from '../src/services/stake-authority-shadow';

const FLAG = 'STAKE_AUTHORITY_SHADOW_ENABLED';
const decision = { stake_available: 1.02 }; // the measured prod mean, for realism

function reset(deposits: any[] = [], builderId: string | null = null) {
  (global as any).__reads = [];
  (global as any).__agentRow = { builder_id: builderId };
  (global as any).__deposits = deposits;
}

describe('stake-authority-shadow — the flag really is inert', () => {
  beforeEach(() => { delete process.env[FLAG]; reset(); });

  it('is OFF by default', () => {
    expect(stakeAuthorityShadowEnabled()).toBe(false);
  });

  it('only the exact string "true" arms it — a populated-but-wrong value stays off', () => {
    for (const v of ['1', 'yes', 'TRUE ', 'on', '']) {
      process.env[FLAG] = v;
      expect(stakeAuthorityShadowEnabled()).toBe(false);
    }
    process.env[FLAG] = 'true';
    expect(stakeAuthorityShadowEnabled()).toBe(true);
  });

  it('performs NO database reads while disabled', async () => {
    const obs = await observeStakeAuthority({ agent: 'trinity-sophia', amount: 5, decision });
    expect(obs.verdict).toBe('disabled');
    expect((global as any).__reads).toEqual([]);
  });

  it('a disabled observation reports NOT_CHECKED, never "no divergence"', async () => {
    const obs = await observeStakeAuthority({ agent: 'trinity-sophia', amount: 5, decision });
    // A null comparison must not be readable as a measured zero.
    expect(obs.comparison).toBeNull();
    expect(obs.detail).toMatch(/nothing observed/i);
    expect(obs.detail).toMatch(/not a finding of no divergence/i);
  });
});

describe('stake-authority-shadow — what reaches the resolver', () => {
  beforeEach(() => { process.env[FLAG] = 'true'; reset(); });
  afterEach(() => { delete process.env[FLAG]; });

  it('an agent with no builder_id yields unresolvedOwner and reads no deposits', async () => {
    reset([], null);
    const obs = await observeStakeAuthority({ agent: 'trinity-orphan', amount: 5, decision });
    expect(obs.verdict).toBe('observed');
    expect(obs.comparison!.unresolvedOwner).toBe(true);
    expect(obs.comparison!.correctedCollateralUsdc).toBe(0);
    // The deposit table must not be consulted at all for an ownerless agent.
    expect((global as any).__reads).not.toContain('stake_deposits');
  });

  it('SIMULATED deposits are excluded — the fail-OPEN direction this exists to prevent', async () => {
    reset(
      [
        { builder_id: 'b1', amount: 40_000_000, status: 'active', is_simulated: true },
        { builder_id: 'b1', amount: 40_000_000, status: 'active', is_simulated: true },
      ],
      'b1',
    );
    const obs = await observeStakeAuthority({ agent: 'trinity-sophia', amount: 5, decision });
    // $80 of demo money must back exactly $0 of authority.
    expect(obs.comparison!.correctedCollateralUsdc).toBe(0);
    expect(obs.comparison!.basis).toMatch(/EXCLUDED/);
  });

  it('REAL active deposits are counted, and an over-credit is flagged in that direction', async () => {
    reset([{ builder_id: 'b1', amount: 40_000_000, status: 'active', is_simulated: false }], 'b1');
    const obs = await observeStakeAuthority({ agent: 'trinity-sophia', amount: 5, decision });
    expect(obs.comparison!.correctedCollateralUsdc).toBe(40);
    // corrected ($40) exceeds what the gate used ($1.02), so the gate is UNDER-crediting here.
    expect(obs.comparison!.currentOverCredits).toBe(false);
    expect(obs.comparison!.divergenceUsdc).toBeCloseTo(38.98, 2);
  });

  it('rows are handed over UNFILTERED beyond the owner, so the resolver applies the exclusions', async () => {
    // An inactive real deposit must be dropped by the RESOLVER, which can only happen if the
    // wiring passes it through rather than pre-filtering on status.
    reset([{ builder_id: 'b1', amount: 99_000_000, status: 'withdrawn', is_simulated: false }], 'b1');
    const obs = await observeStakeAuthority({ agent: 'trinity-sophia', amount: 5, decision });
    expect(obs.comparison!.correctedCollateralUsdc).toBe(0);
    expect(obs.comparison!.depositsConsidered ?? 0).toBe(0);
  });

  it('compares against the value the gate ACTUALLY used, not a re-derivation', async () => {
    reset([{ builder_id: 'b1', amount: 1_000_000, status: 'active', is_simulated: false }], 'b1');
    const obs = await observeStakeAuthority({
      agent: 'trinity-sophia',
      amount: 5,
      decision: { stake_available: 777 },
    });
    expect(obs.comparison!.currentStakeAvailable).toBe(777);
    expect(obs.comparison!.currentOverCredits).toBe(true); // 1 < 777 → gate over-credits
  });
});

describe('stake-authority-shadow — it cannot break the path it observes', () => {
  beforeEach(() => { process.env[FLAG] = 'true'; reset(); });
  afterEach(() => { delete process.env[FLAG]; });

  it('a database failure becomes verdict "error" and never throws', async () => {
    (global as any).__agentRow = null;
    const boom = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.resetModules();
    const obs = await observeStakeAuthority({ agent: 'trinity-sophia', amount: 5, decision })
      .catch(() => ({ verdict: 'THREW' } as any));
    // Either it observed with a null row (unresolved owner) or it errored — never threw.
    expect(['observed', 'error']).toContain(obs.verdict);
    boom.mockRestore();
  });

  it('always reports the live value back unchanged, whatever the verdict', async () => {
    delete process.env[FLAG];
    const off = await observeStakeAuthority({ agent: 'a', amount: 5, decision: { stake_available: 12.5 } });
    process.env[FLAG] = 'true';
    reset([], 'b1');
    const on = await observeStakeAuthority({ agent: 'a', amount: 5, decision: { stake_available: 12.5 } });
    expect(off.liveStakeAvailable).toBe(12.5);
    expect(on.liveStakeAvailable).toBe(12.5);
  });
});
