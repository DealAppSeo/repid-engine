import { db } from '../db';

// Patent pending P-023 — the TUNED constants are supplied by the environment
// (config/scoring-params.ts) and are deliberately absent from this public repo.
// REPID_MAX / REPID_MIN stay here: they are the published tier bounds, not tuning.
import { scoringParams } from '../config/scoring-params';

const REPID_MAX = 10000;
const REPID_MIN = 10;

export function computeDecayFactor(params: {
  currentRepId: number; activity30d: number;
}): number {
  const p = scoringParams();
  const raw = 1 - (p.decayLambda
    * Math.exp(-p.decayK * params.activity30d)
    * Math.sqrt(params.currentRepId / REPID_MAX));
  return Math.min(p.decayCap, Math.max(p.decayFloor, raw));
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
    const windowStart = new Date(Date.now() - scoringParams().redemptionWindowDays*24*60*60*1000).toISOString();
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
    return (prosocial ?? 0) >= scoringParams().redemptionProsocialThreshold
      ? scoringParams().redemptionModifier : 1.0;
  } catch { return 1.0; } // fail open — never punish harder due to DB error
}

export function getRedemptionStatus(_agentId: string):
  'ACTIVE'|'INACTIVE'|'PENDING_REFERENDUM' { return 'INACTIVE'; }
