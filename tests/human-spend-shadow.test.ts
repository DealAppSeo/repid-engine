/**
 * Human spend shadow — fail closed, and not the live gate.
 *
 * no stake → no spend
 * stake present → the effective cap is a number
 * unbound agent → no spend
 * amount over min(human cap, agent cap) → deny
 *
 * decideAuthority is imported only to prove this shadow did not become it.
 * AUTONOMOUS with no stake is still authorised by the live function. The shadow
 * denies. That gap is the point: enforce stays off.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { decideAuthority } from '../src/services/x402-gate';
import { resolveCollateral } from '../src/services/stake-authority-resolver';
import { shadowHumanSpend } from '../src/services/human-spend-shadow';

const SRC = resolve(__dirname, '..', 'src');

describe('human spend shadow', () => {
  it('no stake means no spend, and a missing stake is not treated as zero-that-passes', () => {
    const none = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 100,
      ownerCapUsdc: 50,
      bound: true,
      stakeAvailableUsdc: 0,
    });
    expect(none.spend).toBe('deny');
    expect(none.reason).toBe('no_stake');
    expect(none.applied).toBe(false);
    expect(none.enforced).toBe(false);

    const notLooked = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 100,
      bound: true,
    });
    expect(notLooked.reason).toBe('stake_not_checked');
    expect(notLooked.spend).toBe('deny');
  });

  it('stake present makes the effective cap visible, and over the minimum denies', () => {
    const under = shadowHumanSpend({
      amountUsdc: 20,
      agentCapUsdc: 100,
      ownerCapUsdc: 25,
      bound: true,
      stakeAvailableUsdc: 40,
    });
    expect(under.spend).toBe('would_allow');
    expect(under.effective_cap_usdc).toBe(25);
    expect(under.human_cap_usdc).toBe(25);
    expect(under.agent_cap_usdc).toBe(100);
    expect(under.applied).toBe(false);

    const over = shadowHumanSpend({
      amountUsdc: 30,
      agentCapUsdc: 100,
      ownerCapUsdc: 25,
      bound: true,
      stakeAvailableUsdc: 40,
    });
    expect(over.spend).toBe('deny');
    expect(over.reason).toBe('over_cap');
    expect(over.effective_cap_usdc).toBe(25);

    const ownerCannotWiden = shadowHumanSpend({
      amountUsdc: 80,
      agentCapUsdc: 100,
      ownerCapUsdc: 1000,
      bound: true,
      stakeAvailableUsdc: 40,
    });
    expect(ownerCannotWiden.effective_cap_usdc).toBe(100);
    expect(ownerCannotWiden.spend).toBe('would_allow');
  });

  it('an unbound agent cannot spend, even with stake and room under the cap', () => {
    const unbound = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 100,
      ownerCapUsdc: 100,
      bound: false,
      stakeAvailableUsdc: 50,
    });
    expect(unbound.spend).toBe('deny');
    expect(unbound.reason).toBe('unbound_agent');
    expect(unbound.applied).toBe(false);

    const collateral = resolveCollateral(
      { agentName: 'example', builderId: null },
      [{ builder_id: 'someone', amount: 5_000_000, status: 'active', is_simulated: false }],
    );
    expect(collateral.unresolvedOwner).toBe(true);
    expect(collateral.collateralUsdc).toBe(0);
  });

  it('does not flip the live gate: AUTONOMOUS with no stake still passes decideAuthority', () => {
    const live = decideAuthority(10, {
      tier: 'AUTONOMOUS',
      stake_available: 0,
      daily_used: 0,
      open_disputes: 0,
    });
    expect(live.authorized).toBe(true);

    const shadow = shadowHumanSpend({
      amountUsdc: 10,
      agentCapUsdc: live.per_tx_limit,
      ownerCapUsdc: null,
      bound: true,
      stakeAvailableUsdc: 0,
    });
    expect(shadow.spend).toBe('deny');
    expect(shadow.reason).toBe('no_stake');
    expect(shadow.enforced).toBe(false);
  });

  it('the live stake read is still agent_stakes, and repid_agents is not given stake_amount', () => {
    const gate = readFileSync(join(SRC, 'services', 'x402-gate.ts'), 'utf8');
    expect(gate).toContain("db.from('agent_stakes').select('stake_amount')");
    expect(gate).toContain(".select('tier, current_repid, conservator_address')");
    expect(gate).toContain('repid_agents has NO stake_amount column');
    expect(gate).toContain('void observeOwnerCeiling(');
    expect(gate).toContain('void observeStakeAuthority(');
  });
});
