/**
 * src/services/sponsorship.ts
 * S-ONCHAIN Phase 5: Sponsorship overcollateralization (4x own-exposure rule)
 * Used before allowing x402 or other sponsored usage.
 */

import { db } from '../db';

export async function canSponsor(
  sponsorAgent: string,
  sponsoredAgent: string,
  collateralUsdc: number,
  ratio: number = 3 // 4x rule uses 4 internally
): Promise<{ allowed: boolean; reason?: string; remainingCapacity?: number }> {
  // Sponsor must be ESTABLISHED+
  const { data: sponsor } = await db
    .from('repid_agents')
    .select('current_repid, tier')
    .eq('agent_name', sponsorAgent)
    .single();

  if (!sponsor || ['PROBATIONARY', 'EARNING'].includes(sponsor.tier)) {
    return { allowed: false, reason: 'sponsor_tier_too_low' };
  }

  // Get sponsor's active stakes
  const { data: stakes } = await db
    .from('staking_deposits')
    .select('amount_usdc')
    .eq('agent_name', sponsorAgent)
    .eq('status', 'active');

  const totalStaked = (stakes || []).reduce((s: number, d: any) => s + Number(d.amount_usdc || 0), 0);

  // Get sponsor's own daily usage (x402 or similar)
  const since24h = new Date(Date.now() - 86400000).toISOString();
  const { data: ownTxs } = await db
    .from('x402_payment_gates') // or appropriate usage table
    .select('amount_usdc')
    .eq('agent_name', sponsorAgent)
    .eq('authorized', true)
    .gte('requested_at', since24h);

  const ownExposure = (ownTxs || []).reduce((s: number, t: any) => s + Number(t.amount_usdc || 0), 0);

  // 4x own-exposure must be covered by stake
  if (totalStaked < ownExposure * 4) {
    return { allowed: false, reason: 'insufficient_stake_for_4x_rule' };
  }

  // Existing sponsorships
  const { data: existingSponsors } = await db
    .from('sponsorship_records')
    .select('collateral_usdc')
    .eq('sponsor_agent', sponsorAgent)
    .eq('status', 'active');

  const totalSponsored = (existingSponsors || []).reduce((s: number, sp: any) => s + Number(sp.collateral_usdc || 0), 0);

  const remainingCapacity = totalStaked - (ownExposure * 4) - totalSponsored;

  if (collateralUsdc > remainingCapacity) {
    return { allowed: false, reason: 'insufficient_remaining_capacity', remainingCapacity };
  }

  return { allowed: true, remainingCapacity };
}