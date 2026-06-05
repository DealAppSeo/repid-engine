import { Router } from 'express';
import { db } from '../db';

const router = Router();

router.get('/api/health/agents', async (req, res) => {
  try {
    const [hb, agents] = await Promise.all([
      db.from('agent_heartbeat').select('agent_name,status,last_ping,loop_count,code_version,current_task_id'),
      db.from('repid_agents').select('agent_name,current_repid,tier,last_active_at'),
    ]);
    const repidByName = new Map((agents.data || []).map((a: any) => [a.agent_name, a]));
    const now = Date.now();
    const grid = (hb.data || []).map((h: any) => {
      const a: any = repidByName.get(h.agent_name);
      const mins = h.last_ping ? (now - new Date(h.last_ping).getTime()) / 60000 : null;
      return {
        agent_name: h.agent_name,
        status: h.status,
        live: mins != null && mins < 5,
        minutes_since_ping: mins != null ? Number(mins.toFixed(1)) : null,
        loop_count: h.loop_count,
        code_version: h.code_version,
        current_task_id: h.current_task_id,
        repid: a?.current_repid ?? null,
        tier: a?.tier ?? null,
      };
    });
    const live = grid.filter((g) => g.live).length;
    res.json({ count: grid.length, live, uptime_pct: grid.length ? Math.round((live / grid.length) * 100) : 0, agents: grid });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/health/system', async (req, res) => {
  try {
    const [hb] = await Promise.all([
      db.from('agent_heartbeat').select('agent_name,status,last_ping'),
    ]);
    const now = Date.now();
    const grid = (hb.data || []).map((h: any) => {
      const mins = h.last_ping ? (now - new Date(h.last_ping).getTime()) / 60000 : null;
      return {
        agent_name: h.agent_name,
        live: mins != null && mins < 5,
      };
    });
    const liveCount = grid.filter((g) => g.live).length;
    const totalCount = grid.length;
    const uptime_pct = totalCount ? Math.round((liveCount / totalCount) * 100) : 0;

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
