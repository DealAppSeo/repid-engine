import { Router, Request, Response } from 'express';
import { db } from '../../db';
import {
  deriveLoopHealth,
  summarizeFleetLoop,
  LOOP_STALE_MIN,
  type HealthProbeRow,
} from '../../observability/agent-liveness';
import { TRINITY_AGENTS } from '../../observability/health-probe';

/**
 * GET /api/v1/runloop-liveness — is the swarm actually WORKING?
 *
 * ─── WHAT THIS READS, AND WHY IT CHANGED ─────────────────────────────────────
 *
 * `agent_health_probes`, populated by the external prober. It previously read
 * `agent_heartbeat`, and that was wrong: **nothing has written that table since
 * 2026-07-17 22:18.** Agent presence writes were deliberately switched off
 * (HEARTBEAT_MODE='off', ~8.6M writes/day) and the replacement is the /health
 * body the prober now records. Reading the old table meant every answer was
 * computed from twelve frozen rows — mel pinned at 19,155 loops / 0 completions
 * forever, regardless of what the fleet was doing.
 *
 * That is worth stating plainly because it is the same defect twice: the first
 * version of this endpoint classified HEALTHY on `loop_count > 0` plus a fresh
 * ping, which trinity-mel satisfied for the four weeks it was dead; the second
 * fixed the rule and left it pointed at a dead table. **An instrument is only as
 * live as its source.**
 *
 * ─── THE SIGNAL ──────────────────────────────────────────────────────────────
 *
 * Each agent serves `{alive, loopCount, lastIterationAt, ...}` from process
 * memory. `lastIterationAt` is stamped at the top of every runLoop iteration and
 * BEFORE the idle gate, so a deliberately paused agent keeps it fresh and only a
 * genuinely stopped loop lets it age. Stale + HTTP 200 is therefore a hung loop
 * on a single sample — which is exactly the state a status-code monitor reports
 * as green.
 *
 * ─── WHAT IT STILL CANNOT SEE ────────────────────────────────────────────────
 *
 * A loop that ADVANCES while producing nothing. `lastIterationAt` proves
 * iteration, not output. Measured 2026-08-17: twelve agents at HTTP 200 with
 * zero `repid_score_events` and zero `hal_classifications` since 04:00 — if
 * their loops are turning, this endpoint will call them healthy and they are
 * still doing no work. Closing that needs the production tables, which is a
 * separate query and a separate claim. **A 200 here is a floor, not proof the
 * fleet is producing.**
 */

const router = Router();

/** Below this many healthy agents the swarm is not doing its job. */
const SWARM_HEALTHY_THRESHOLD = 8;
const SWARM_DEGRADED_THRESHOLD = 4;

/** A probe older than this describes the past, not the present. */
const PROBE_FRESH_MIN = 30;

const PROBE_COLUMNS =
  'agent_name, ok, http_status, alive, loop_count, last_iteration_at, code_version, body_error, probed_at';

/**
 * Latest probe per agent.
 *
 * Fetches a bounded recent window and reduces in-app rather than issuing twelve
 * queries. Ordered ascending so the last write per agent wins.
 */
async function latestProbes(): Promise<HealthProbeRow[]> {
  const since = new Date(Date.now() - PROBE_FRESH_MIN * 60_000).toISOString();
  const { data, error } = await db
    .from('agent_health_probes')
    .select(PROBE_COLUMNS)
    .gte('probed_at', since)
    .order('probed_at', { ascending: true })
    .limit(2000);
  if (error) throw new Error(`agent_health_probes query failed: ${error.message}`);

  const latest = new Map<string, HealthProbeRow>();
  for (const row of ((data ?? []) as unknown) as HealthProbeRow[]) {
    if (typeof row.agent_name === 'string') latest.set(row.agent_name, row);
  }
  // An agent with NO recent probe must appear as a row, not vanish from the
  // denominator. A fleet view that silently drops unprobed agents reports a
  // higher healthy percentage the more agents stop being observed.
  for (const name of TRINITY_AGENTS) {
    if (!latest.has(name)) {
      latest.set(name, { agent_name: name, ok: false, http_status: null, body_error: 'no probe in the last ' + PROBE_FRESH_MIN + ' minutes' });
    }
  }
  return [...latest.values()];
}

/** GET /api/v1/runloop-liveness — swarm-level. 200 only when the swarm works. */
router.get('/runloop-liveness', async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    const summary = summarizeFleetLoop(await latestProbes(), now);

    let swarmStatus: 'HEALTHY' | 'DEGRADED' | 'DORMANT';
    if (summary.healthy >= SWARM_HEALTHY_THRESHOLD) swarmStatus = 'HEALTHY';
    else if (summary.healthy >= SWARM_DEGRADED_THRESHOLD) swarmStatus = 'DEGRADED';
    else swarmStatus = 'DORMANT';

    return res.status(swarmStatus === 'HEALTHY' ? 200 : 503).json({
      swarm_status: swarmStatus,
      healthy_count: summary.healthy,
      hung_count: summary.hung,
      down_count: summary.down,
      unknown_count: summary.unknown,
      // The headline number: answering 200 with a stopped loop. Reported at fleet
      // level because that is the reading a status-code monitor gets wrong.
      responding_but_stopped: summary.respondingButStopped,
      total_count: summary.total,
      healthy_threshold: SWARM_HEALTHY_THRESHOLD,
      loop_stale_minutes: LOOP_STALE_MIN,
      probe_window_minutes: PROBE_FRESH_MIN,
      source: 'agent_health_probes (/health body). agent_heartbeat is frozen since 2026-07-17 and is NOT read.',
      agents: summary.agents,
      checked_at: new Date(now).toISOString(),
    });
  } catch (e: any) {
    console.error('[runloop-liveness] swarm error:', e?.message ?? String(e));
    // NOT 200. An endpoint that cannot read its source does not know the fleet is
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
      .from('agent_health_probes')
      .select(PROBE_COLUMNS)
      .eq('agent_name', name)
      .order('probed_at', { ascending: false })
      .limit(1);
    if (error) {
      console.error('[runloop-liveness/:agent] query error:', error.message);
      return res.status(503).json({ error: 'query failed', agent: name });
    }
    const row = (((data ?? []) as unknown) as HealthProbeRow[])[0];
    if (!row) return res.status(404).json({ error: 'no probe recorded for this agent', agent: name });

    const health = deriveLoopHealth(row, Date.now());
    return res.status(health.healthy ? 200 : 503).json({
      agent: health,
      probed_at: row.probed_at ?? null,
      checked_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[runloop-liveness/:agent] error:', e?.message ?? String(e));
    return res.status(503).json({ error: 'internal', agent: name });
  }
});

export default router;
