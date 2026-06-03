/**
 * src/services/sponsorship.ts
 * S-ONCHAIN Phase 5: Sponsorship overcollateralization logic (4x own-exposure rule)
 */

import { db } from '../db';

export async function canSponsor(
  sponsorAgent: string, sponsoredAgent: string,
  collateralUsdc: number, ratio: number = 3
): Promise<{ allowed: boolean; reason?: string }> {
  // Sponsor must be ESTABLISHED+
  const { data: sponsor } = await db
    .from('repid_agents')
    .select('current_repid, tier')
    .eq('agent_name', sponsorAgent)
    .single();

  if (!sponsor || ['PROBATIONARY','EARNING'].includes(sponsor.tier)) {
    return { allowed: false, reason: 'sponsor_tier_too_low' };
  }

  // Check 4x own-exposure rule
  const { data: stakes } = await db
    .from('staking_deposits')
    .select('amount_usdc')
    .eq('agent_name', sponsorAgent)
    .eq('status', 'active');
  
  const totalStaked = stakes?.reduce((s, d) => s + Number(d.amount_usdc), 0) || 0;

  // Get sponsor's own daily usage
  const { data: ownTxs } = await db
    .from('x402_payment_gates')
    .select('amount_usdc')
    .eq('agent_name', sponsorAgent)
    .eq('authorized', true)
    .gte('requested_at', new Date(Date.now() - 86400000).toISOString());
  
  const ownExposure = ownTxs?.reduce((s, t) => s + Number(t.amount_usdc), 0) || 0;

  // 4x own-exposure must be covered by stake
  if (totalStaked < ownExposure * 4) {
    return { allowed: false, reason: 'insufficient_stake_for_4x_rule' };
  }

  // Check remaining capacity after own exposure + existing sponsorships
  const { data: existingSponsors } = await db
    .from('sponsorship_records')
    .select('collateral_usdc')
    .eq('sponsor_agent', sponsorAgent)
    .eq('status', 'active');
  
  const totalSponsored = existingSponsors?.reduce((s, sp) => s + Number(sp.collateral_usdc), 0) || 0;
  const remainingCapacity = totalStaked - (ownExposure * 4) - totalSponsored;

  if (collateralUsdc > remainingCapacity) {
    return { allowed: false, reason: 'insufficient_remaining_capacity' };
  }

  return { allowed: true };
}