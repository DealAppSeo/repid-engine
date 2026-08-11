/**
 * health-probe-worker — Option B: probe the fleet from the always-on API service.
 *
 * WHY IN-PROCESS RATHER THAN A CRON SERVICE. `v_fleet_truth` only counts a probe younger than 10
 * minutes; past that it silently falls back to the weaker work-log signal and nine of twelve
 * agents become NULL again. A Railway cron would work but spins a fresh container every run
 * (~144/day on a ten-minute schedule). This service is already always-on, so a timer costs zero.
 *
 * THREE GUARDS, EACH FOR A FAILURE THIS CODEBASE HAS ALREADY HAD
 *
 * 1. DEFAULT OFF (`HEALTH_PROBE_ENABLED`). House style: zero change at merge, Sean flips. A new
 *    always-on loop in the API service is a live-state change, so it ships inert.
 *
 * 2. HONOURS THE L0 HALT. LESSONS records two ungated tick loops found during nine days of
 *    drift, one of which moved money. This one only reads — but "it only reads" is exactly the
 *    argument that let the other two ship ungated, and a halt that some loops ignore is not a
 *    halt. It parks like everything else.
 *
 * 3. RE-ENTRANCY GUARD. Twelve HTTP calls at a 12s timeout can outlast a short interval. Without
 *    the guard, ticks overlap, probes pile up, and the table fills with duplicate observations
 *    that make a flap look like an outage.
 *
 * IT CANNOT BREAK A REQUEST. Every path is caught and swallowed with a log, exactly like
 * `checkAndAwardBadges`. A failed WRITE is reported as a write failure, never as a fleet failure
 * — otherwise a logging outage reads as twelve agents going down at once.
 */
import { db } from '../db';
import { shouldParkForHalt } from '../services/emergency-halt';
import { probeFleet, summarise } from '../observability/health-probe';

const WORKER = 'health-probe';

/** Default 5 min: comfortably inside v_fleet_truth's 10-minute window, so a single missed tick
 *  degrades to "stale but still counted" rather than straight to NULL. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
/** Re-entrancy guard — see guard 3 above. */
let running = false;

export async function runOnce(): Promise<void> {
  if (running) {
    console.warn(`[${WORKER}] previous tick still running — skipping (re-entrancy guard)`);
    return;
  }
  running = true;
  try {
    if (await shouldParkForHalt(db, WORKER)) return;

    const rows = await probeFleet();
    console.log(`[${WORKER}] ${summarise(rows)}`);

    const { error } = await db.from('agent_health_probes').insert(rows);
    if (error) {
      // A failed WRITE is not a failed fleet. Say which one broke.
      console.error(`[${WORKER}] probes ran but were NOT persisted: ${error.message}`);
    }
  } catch (e: any) {
    // Never propagate: this runs on a timer beside the request path.
    console.error(`[${WORKER}] tick failed: ${e?.message ?? e}`);
  } finally {
    running = false;
  }
}

/**
 * Start the loop. No-op unless `HEALTH_PROBE_ENABLED === 'true'`.
 *
 * Deliberately does NOT probe immediately on boot: a restart loop would then hammer twelve hosts
 * on every crash. The first tick lands one interval in.
 */
export function startHealthProbeWorker(intervalMs = Number(process.env.HEALTH_PROBE_INTERVAL_MS) || DEFAULT_INTERVAL_MS): boolean {
  if (process.env.HEALTH_PROBE_ENABLED !== 'true') return false;
  if (timer) return true; // already started — idempotent

  timer = setInterval(() => { void runOnce(); }, intervalMs);
  // Do not keep the process alive on this timer alone.
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[${WORKER}] started (every ${Math.round(intervalMs / 1000)}s, default OFF flag is ON)`);
  return true;
}

/** For tests and graceful shutdown. */
export function stopHealthProbeWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
