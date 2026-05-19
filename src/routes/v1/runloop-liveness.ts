import { Router, Request, Response } from 'express';
import { db } from '../../db';

/**
 * Sprint 14 R-6 — /api/v1/runloop-liveness
 *
 * Swarm-level runLoop liveness. Distinguishes "loop is iterating" from
 * "heartbeat alive but loop hung" by reading `agent_heartbeat.loop_count`
 * (wired by Sprint 14 R-3 in trinity-symphony-shared's ConstitutionalAgentV4).
 *
 * Why this exists: Sprint 13 diagnostic showed all 12 agents froze staggered
 * 2026-05-16/17 while `agent_heartbeat.status='online'` + fresh `last_ping`
 * stayed green the entire ~63h outage — because the heartbeat writer is an
 * independent setInterval, decoupled from the runLoop. Every existing health
 * signal was blind. This endpoint is the missing signal.
 *
 * NOTE on design choice: the Sprint 13 spec sketched a per-agent endpoint on
 * each agent's Express server. Sprint 14 explicitly chose swarm-level on
 * repid-engine because: (a) one stable URL for UptimeRobot, (b) cross-agent
 * aggregation (catches the stagger pattern, not just one freeze), (c) reuses
 * the wired `agent_heartbeat` columns as source of truth (single SoT).
 */

const router = Router();

const HEARTBEAT_FRESH_MS = 5 * 60 * 1000;
const SWARM_HEALTHY_THRESHOLD = 8;

interface AgentHeartbeatRow {
  agent_name: string;
  last_ping: string;
  loop_count: number | null;
  current_task_id: number | null;
  status: string | null;
  code_version: string | null;
  railway_service_id: string | null;
  tasks_completed_session: number | null;
  tasks_failed_session: number | null;
}

type AgentStatus =
  | 'HEALTHY'           // loop_count > 0 AND last_ping fresh
  | 'NEVER_LOOPED'      // heartbeat fresh but loop_count <= 0 — the Sprint 13 freeze signature
  | 'HEARTBEAT_STALE';  // last_ping older than threshold — agent itself appears dead/restarting

interface AgentSnapshot {
  name: string;
  last_ping_min_ago: number | null;
  loop_count: number | null;
  current_task_id: number | null;
  tasks_completed_session: number | null;
  tasks_failed_session: number | null;
  code_version: string | null;
  railway_service_id: string | null;
  status: AgentStatus;
}

function classifyAgent(row: AgentHeartbeatRow, nowMs: number): AgentSnapshot {
  const lastPingMs = row.last_ping ? new Date(row.last_ping).getTime() : NaN;
  const ageMs = Number.isFinite(lastPingMs) ? nowMs - lastPingMs : Number.POSITIVE_INFINITY;
  const heartbeatFresh = ageMs < HEARTBEAT_FRESH_MS;
  const looped = (row.loop_count ?? 0) > 0;
  let status: AgentStatus;
  if (heartbeatFresh && looped) status = 'HEALTHY';
  else if (!heartbeatFresh) status = 'HEARTBEAT_STALE';
  else status = 'NEVER_LOOPED';
  return {
    name: row.agent_name,
    last_ping_min_ago: Number.isFinite(lastPingMs) ? Number((ageMs / 60_000).toFixed(2)) : null,
    loop_count: row.loop_count,
    current_task_id: row.current_task_id,
    tasks_completed_session: row.tasks_completed_session,
    tasks_failed_session: row.tasks_failed_session,
    code_version: row.code_version,
    railway_service_id: row.railway_service_id,
    status,
  };
}

async function fetchSwarm(): Promise<AgentHeartbeatRow[]> {
  const { data, error } = await db
    .from('agent_heartbeat')
    .select(
      'agent_name, last_ping, loop_count, current_task_id, status, code_version, railway_service_id, tasks_completed_session, tasks_failed_session'
    )
    .like('agent_name', 'trinity-%')
    .neq('agent_name', 'trinity-shofet-local');
  if (error) throw new Error(`agent_heartbeat query failed: ${error.message}`);
  return ((data ?? []) as unknown) as AgentHeartbeatRow[];
}

/** GET /api/v1/runloop-liveness — swarm-level liveness. */
router.get('/runloop-liveness', async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    const rows = await fetchSwarm();
    const agents = rows
      .map((r) => classifyAgent(r, now))
      .sort((a, b) => a.name.localeCompare(b.name));
    const healthyCount = agents.filter((a) => a.status === 'HEALTHY').length;
    const totalCount = agents.length;
    let swarmStatus: 'HEALTHY' | 'DEGRADED' | 'DORMANT';
    if (healthyCount >= SWARM_HEALTHY_THRESHOLD) swarmStatus = 'HEALTHY';
    else if (healthyCount >= 4) swarmStatus = 'DEGRADED';
    else swarmStatus = 'DORMANT';
    const httpStatus = swarmStatus === 'HEALTHY' ? 200 : 503;
    return res.status(httpStatus).json({
      swarm_status: swarmStatus,
      healthy_count: healthyCount,
      total_count: totalCount,
      healthy_threshold: SWARM_HEALTHY_THRESHOLD,
      heartbeat_fresh_seconds: HEARTBEAT_FRESH_MS / 1000,
      agents,
      checked_at: new Date(now).toISOString(),
    });
  } catch (e: any) {
    console.error('[runloop-liveness] swarm error:', e?.message ?? String(e), e?.stack ?? '');
    return res.status(503).json({
      swarm_status: 'UNKNOWN',
      error: 'query failed',
      checked_at: new Date().toISOString(),
    });
  }
});

/** GET /api/v1/runloop-liveness/:agent_name — per-agent liveness (canary). */
router.get('/runloop-liveness/:agent_name', async (req: Request, res: Response) => {
  const name = req.params.agent_name;
  try {
    const { data, error } = await db
      .from('agent_heartbeat')
      .select(
        'agent_name, last_ping, loop_count, current_task_id, status, code_version, railway_service_id, tasks_completed_session, tasks_failed_session'
      )
      .eq('agent_name', name)
      .maybeSingle();
    if (error) {
      console.error('[runloop-liveness/:agent] query error:', error.message);
      return res.status(503).json({ error: 'query failed', agent: name });
    }
    if (!data) {
      return res.status(404).json({ error: 'unknown agent', agent: name });
    }
    const snapshot = classifyAgent((data as unknown) as AgentHeartbeatRow, Date.now());
    const httpStatus = snapshot.status === 'HEALTHY' ? 200 : 503;
    return res.status(httpStatus).json({ agent: snapshot, checked_at: new Date().toISOString() });
  } catch (e: any) {
    console.error('[runloop-liveness/:agent] error:', e?.message ?? String(e));
    return res.status(503).json({ error: 'internal', agent: name });
  }
});

export default router;
