import { Router } from 'express';
import { db } from '../db';
import { summarizeFleet } from '../observability/agent-liveness';

const router = Router();

router.get('/api/health/agents', async (req, res) => {
  try {
    const [hb, agents] = await Promise.all([
      db.from('agent_heartbeat').select('agent_name,status,last_ping,loop_count,code_version,current_task_id'),
      db.from('repid_agents').select('agent_name,current_repid,tier,last_active_at'),
    ]);
    const repidByName = new Map((agents.data || []).map((a: any) => [a.agent_name, a]));
    const fleet = summarizeFleet(hb.data || []);
    // `status` used to be emitted raw next to a correctly-derived `live`, so the
    // same object carried both the right answer and a contradicting one. It is now
    // named `self_reported_status` — kept for diagnosis, never authoritative.
    const grid = fleet.agents.map((l) => {
      const h: any = (hb.data || []).find((x: any) => x.agent_name === l.agentName) ?? {};
      const a: any = repidByName.get(l.agentName);
      return {
        agent_name: l.agentName,
        state: l.state,
        live: l.live,
        minutes_since_ping: l.minutesSinceLastPing,
        self_reported_status: l.selfReportedStatus,
        self_report_contradicted: l.selfReportContradicted,
        loop_count: h.loop_count,
        code_version: h.code_version,
        current_task_id: h.current_task_id,
        repid: a?.current_repid ?? null,
        tier: a?.tier ?? null,
      };
    });
    res.json({
      count: fleet.total,
      live: fleet.live,
      stale: fleet.stale,
      dead: fleet.dead,
      uptime_pct: fleet.uptimePct,
      // Loud on purpose: non-zero means agents died without being able to say so.
      self_report_contradictions: fleet.contradictions,
      agents: grid,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/health/system', async (req, res) => {
  try {
    const [hb] = await Promise.all([
      db.from('agent_heartbeat').select('agent_name,status,last_ping'),
    ]);
    const fleet = summarizeFleet(hb.data || []);
    const grid = fleet.agents.map((l) => ({ agent_name: l.agentName, live: l.live, state: l.state }));
    const liveCount = fleet.live;
    const totalCount = fleet.total;
    const uptime_pct = fleet.uptimePct;

    res.json({
      status: uptime_pct > 50 ? 'healthy' : 'degraded',
      uptime_pct,
      live_agents: liveCount,
      total_agents: totalCount,
      timestamp: new Date().toISOString()
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
