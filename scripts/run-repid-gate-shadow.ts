/**
 * C-1 — populate the RepID active-gate SHADOW LOG over active agents (no enforcement). Computes what
 * the active gate WOULD do (claim limit, reward scale, quarantine candidacy) for every active agent
 * and logs it via logGateShadow (repid_gate_shadow_log if applied, else trinity_agent_logs). Safe to
 * run repeatedly; writes only shadow rows. Enforcement is Tier-2 (REPID_ACTIVE_GATE_MODE=enforce).
 */
import 'dotenv/config';
import { db } from '../src/db';
import { evaluateGate, logGateShadow } from '../src/services/repid-active-gate';

async function main() {
  const { data: agents, error } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid')
    .eq('lifecycle_status', 'active')
    .not('current_repid', 'is', null);
  if (error || !agents) { console.error('fetch failed:', error?.message); process.exit(1); }

  let quarantine = 0;
  for (const a of agents as any[]) {
    // recent_delta from the last few score events (best-effort, advisory).
    const { data: ev } = await db.from('repid_score_events')
      .select('delta_applied').eq('agent_id', a.id).order('created_at', { ascending: false }).limit(5);
    const recent_delta = (ev as any[] | null)?.reduce((s, e) => s + (Number(e.delta_applied) || 0), 0) ?? 0;
    const e = evaluateGate({ id: a.id, agent_name: a.agent_name, current_repid: a.current_repid, recent_delta });
    if (e.quarantine_candidate) quarantine++;
    await logGateShadow(db, e, { source: 'run-repid-gate-shadow', agent_name: a.agent_name });
  }
  console.log(`[repid-gate-shadow] evaluated ${agents.length} active agents; ${quarantine} quarantine candidates. SHADOW — nothing enforced.`);
  process.exit(0);
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
