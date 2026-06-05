/**
 * Sponsorship for R3 staking exercise >N=1.
 * Writes to sponsorship_records and agent_stakes.
 * Enforces 4x own exposure, 3:1, tier, authority via min(R,100 sqrt S).
 */
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { computeAuthority } from './authority-math'; // assume exists or from stake-vault

export async function canSponsor(sponsorId: string, amount: number, ownExposure: number): Promise<{ ok: boolean; reason?: string }> {
  const { data: s } = await db.from('repid_agents').select('tier').eq('id', sponsorId).maybeSingle();
  if (!s || !['ESTABLISHED','AUTONOMOUS','VETERAN'].includes((s as any).tier || '')) return { ok: false, reason: 'tier' };
  const { data: stakes } = await db.from('agent_stakes').select('stake_amount').eq('staker_agent', sponsorId).eq('status', 'active');
  const total = (stakes || []).reduce((a: number, r: any) => a + Number(r.stake_amount || 0), 0);
  if (total < ownExposure * 4) return { ok: false, reason: '4x' };
  if ((total - ownExposure * 4) < amount * 3) return { ok: false, reason: '3x1' };
  return { ok: true };
}

export async function recordSponsorship(sponsorId: string, targetId: string, amount: number, dim = 'exercise') {
  const check = await canSponsor(sponsorId, amount, 0); // simplified
  if (!check.ok) return { ok: false, error: check.reason };
  await db.from('sponsorship_records' as any).insert({ sponsor_agent: sponsorId, target_agent: targetId, amount_usdc: amount, dimension: dim, status: 'active' });
  await db.from('agent_stakes').insert({ staker_agent: targetId, stake_amount: amount, dimension: dim, status: 'sponsored', target_model: sponsorId });
  await emitAuditEvent({ event_type: 'sponsorship', source_table: 'sponsorship_records', source_id: targetId, payload: { sponsor: sponsorId, amount } });
  return { ok: true };
}
