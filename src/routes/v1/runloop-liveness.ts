import { Router, Request, Response } from 'express';
import { db } from '../../db';
import {
  deriveHealth,
  summarizeFleetHealth,
  LIVE_WINDOW_MIN,
  SPIN_FLOOR_LOOPS,
  type ProgressRow,
} from '../../observability/agent-liveness';

/**
 * GET /api/v1/runloop-liveness — is the swarm actually WORKING?
 *
 * ─── PROVENANCE ──────────────────────────────────────────────────────────────
 *
 * Ported from `diag/worker-liveness-instrumentation-2026-05-19`, a diagnostic
 * branch that was never merged. Two things are worth recording about it.
 *
 * First, why it existed: Sprint 13 found all 12 agents frozen while
 * `agent_heartbeat.status='online'` and `last_ping` stayed fresh for ~63h,
 * because the heartbeat writer is an independent `setInterval` decoupled from
 * the runLoop. Every health signal was blind.
 *
 * Second, why this is not a copy. The original classified an agent HEALTHY on
 * `loop_count > 0` plus a fresh ping. Measured 2026-08-17, `trinity-mel`
 * satisfied both for the four weeks it was dead — 19,155 loops, 0 completions,
 * pinging the whole time. **The endpoint written to catch a hung loop was blind
 * to a spinning one.** The classification now lives in
 * `src/observability/agent-liveness.ts` (`deriveHealth`), which treats
 * live-but-producing-nothing as its own state; this file is the HTTP surface
 * over it and holds no judgement of its own.
 *
 * ─── WHY SWARM-LEVEL, ON THIS SERVICE ────────────────────────────────────────
 *
 * The Sprint 13 spec sketched a per-agent endpoint on each agent's own server.
 * Swarm-level on repid-engine was chosen instead because it gives one stable URL
 * for UptimeRobot, it can see a STAGGERED failure that no single agent can, and
 * an endpoint hosted by the process it monitors cannot report that process being
 * down. The per-agent route below is for drilling in, never for monitoring.
 *
 * ─── WHAT IT STILL CANNOT SEE ────────────────────────────────────────────────
 *
 * `loop_count` and `tasks_completed_session` reset on restart, so a loop that
 * spins, restarts and spins again looks young every time. Catching that needs a
 * durable production series (`repid_score_events`, `hal_classifications`) rather
 * than a heartbeat snapshot. This endpoint is a floor, not a ceiling — do not
 * read a 200 from it as proof the fleet is producing.
 */

const router = Router();

/** Below this many healthy agents the swarm is not doing its job. */
const SWARM_HEALTHY_THRESHOLD = 8;
const SWARM_DEGRADED_THRESHOLD = 4;

const HEARTBEAT_COLUMNS =
  'agent_name, last_ping, loop_count, current_task_id, status, code_version, ' +
  'railway_service_id, tasks_completed_session, tasks_failed_session';

/** GET /api/v1/runloop-liveness — swarm-level. 200 only when the swarm works. */
router.get('/runloop-liveness', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await db
      .from('agent_heartbeat')
      .select(HEARTBEAT_COLUMNS)
      .like('agent_name', 'trinity-%')
      .neq('agent_name', 'trinity-shofet-local');
    if (error) throw new Error(`agent_heartbeat query failed: ${error.message}`);

    const rows = ((data ?? []) as unknown) as ProgressRow[];
    const now = Date.now();
    const summary = summarizeFleetHealth(rows, now);

    let swarmStatus: 'HEALTHY' | 'DEGRADED' | 'DORMANT';
    if (summary.healthy >= SWARM_HEALTHY_THRESHOLD) swarmStatus = 'HEALTHY';
    else if (summary.healthy >= SWARM_DEGRADED_THRESHOLD) swarmStatus = 'DEGRADED';
    else swarmStatus = 'DORMANT';

    return res.status(swarmStatus === 'HEALTHY' ? 200 : 503).json({
      swarm_status: swarmStatus,
      healthy_count: summary.healthy,
      // Reported beside healthy_count on purpose: a fleet can be fully live and
      // entirely spinning, and one number alone cannot say so.
      live_count: summary.live,
      spinning_count: summary.spinning,
      not_looping_count: summary.notLooping,
      contradictions: summary.contradictions,
      total_count: summary.total,
      healthy_threshold: SWARM_HEALTHY_THRESHOLD,
      live_window_minutes: LIVE_WINDOW_MIN,
      spin_floor_loops: SPIN_FLOOR_LOOPS,
      agents: summary.fleet
        .slice()
        .sort((a, b) => a.agentName.localeCompare(b.agentName)),
      checked_at: new Date(now).toISOString(),
    });
  } catch (e: any) {
    console.error('[runloop-liveness] swarm error:', e?.message ?? String(e));
    // NOT 200. An endpoint that cannot read the table does not know the fleet is
    // healthy, and UNKNOWN must never be served with a success code.
    return res.status(503).json({
      swarm_status: 'UNKNOWN',
      error: 'query failed',
      checked_at: new Date().toISOString(),
    });
  }
});

/** GET /api/v1/runloop-liveness/:agent_name — drill-in for one agent. */
router.get('/runloop-liveness/:agent_name', async (req: Request, res: Response) => {
  const name = req.params.agent_name;
  try {
    const { data, error } = await db
      .from('agent_heartbeat')
      .select(HEARTBEAT_COLUMNS)
      .eq('agent_name', name)
      .maybeSingle();
    if (error) {
      console.error('[runloop-liveness/:agent] query error:', error.message);
      return res.status(503).json({ error: 'query failed', agent: name });
    }
    if (!data) return res.status(404).json({ error: 'unknown agent', agent: name });

    const health = deriveHealth((data as unknown) as ProgressRow, Date.now());
    return res.status(health.healthy ? 200 : 503).json({
      agent: health,
      checked_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[runloop-liveness/:agent] error:', e?.message ?? String(e));
    return res.status(503).json({ error: 'internal', agent: name });
  }
});

export default router;
