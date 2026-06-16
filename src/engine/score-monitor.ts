import { db } from '../db';
import { fireWebhook } from '../services/webhook';

const lastScores = new Map<string, number>();

export async function scoreMonitor() {
  try {
    const { data: agents } = await db.from('repid_agents').select('id, current_repid');
    if (!agents) return;
    for (const agent of agents) {
      const oldScore = lastScores.get(agent.id);
      if (oldScore !== undefined && Math.abs(agent.current_repid - oldScore) > 100) {
        const delta = agent.current_repid - oldScore;
        fireWebhook('repid.score_changed', { agent_id: agent.id, old_score: oldScore, new_score: agent.current_repid, delta });
        const { error } = await db.from('trinity_agent_logs').insert({
          action: 'repid_score_changed',
          metadata: { agent_id: agent.id, old_score: oldScore, new_score: agent.current_repid, delta }
        });
    if (error) console.error(error);
      }
      lastScores.set(agent.id, agent.current_repid);
    }
  } catch (err) {
    // PHASE A — no silent swallow: a monitor failure (DB outage, schema drift) must be visible,
    // not hidden. Log loud; the monitor is non-fatal so we still return without throwing.
    console.error('[score-monitor] tick failed:', err instanceof Error ? err.message : err);
  }
}
