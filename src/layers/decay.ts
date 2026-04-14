import { db } from '../db';

// Patent pending P-023 — do not expose constants in public repos
const LAMBDA = 0.05;
const K = 0.1;
const REPID_MAX = 10000;
const REPID_MIN = 10;
const DECAY_FLOOR = 0.90;
const DECAY_CAP = 1.00;
const REDEMPTION_WINDOW_DAYS = 30;
const REDEMPTION_PROSOCIAL_THRESHOLD = 5;
const REDEMPTION_MODIFIER = 0.80; // 20% penalty reduction

export function computeDecayFactor(params: {
  currentRepId: number; activity30d: number;
}): number {
  const raw = 1 - (LAMBDA
    * Math.exp(-K * params.activity30d)
    * Math.sqrt(params.currentRepId / REPID_MAX));
  return Math.min(DECAY_CAP, Math.max(DECAY_FLOOR, raw));
}

export function applyDecay(currentRepId: number, activity30d: number): number {
  return Math.max(REPID_MIN,
    Math.round(currentRepId * computeDecayFactor({ currentRepId, activity30d })));
}

// Redemption Arc Rule — Micah 6:8 as math.
// Sustained prosocial behavior after violations reduces the penalty multiplier.
// Keeps the path open for the last, lost, and least.
export async function computeRedemptionModifier(agentId: string): Promise<number> {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90*24*60*60*1000).toISOString();
    const windowStart = new Date(Date.now() - REDEMPTION_WINDOW_DAYS*24*60*60*1000).toISOString();
    const { count: violations } = await db.from('repid_score_events')
      .select('id', { count:'exact', head:true })
      .eq('agent_id', agentId)
      .in('event_type', ['EPISTEMIC_VIOLATION','CONSTITUTIONAL_VIOLATION'])
      .gte('created_at', ninetyDaysAgo);
    if (!violations || violations === 0) return 1.0;
    const { count: prosocial } = await db.from('repid_score_events')
      .select('id', { count:'exact', head:true })
      .eq('agent_id', agentId)
      .in('event_type', ['CHALLENGE_WIN','PEACEMAKER','SELF_MONITOR',
                         'REFERRAL','CONSTITUTIONAL_PASS'])
      .gte('created_at', windowStart);
    return (prosocial ?? 0) >= REDEMPTION_PROSOCIAL_THRESHOLD
      ? REDEMPTION_MODIFIER : 1.0;
  } catch { return 1.0; } // fail open — never punish harder due to DB error
}

export function getRedemptionStatus(_agentId: string):
  'ACTIVE'|'INACTIVE'|'PENDING_REFERENDUM' { return 'INACTIVE'; }
