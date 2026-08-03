/**
 * internal-cron.ts — UptimeRobot-driven cron triggers (CC1, 2026-05-25).
 *
 * Repurposes the existing UptimeRobot monitors (free, 5-min pings) as our cron system
 * for the telemetry runners. Three POST endpoints, each:
 *   - require header `X-Cron-Token` === env `CRON_TRIGGER_TOKEN` (else 401)
 *   - are idempotent: a run within the trigger's min-interval is skipped (no double-write)
 *   - log each actual run to repid_telemetry_snapshots (metric_family='cron_trigger';
 *     snapshot_type='cron_trigger' carried in metadata — the table has no snapshot_type col)
 *   - return 200 { status, trigger, last_run, summary }
 *
 * Mounted BEFORE authMiddleware (its own token is the auth; no REPID_API_KEY needed).
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { captureTelemetry, healthSummary24h, runAuditProbe } from '../../observability/cron-runners';
import { runStatusDigest } from '../../services/status-digest';
import { retuneAnfisRoutingRunner } from '../../services/anfis-retune';

const router = Router();

// Min interval between actual runs per trigger (slightly under the intended schedule to
// tolerate UptimeRobot jitter). UptimeRobot pings every 5 min; only in-window runs execute.
const MIN_INTERVAL_MS: Record<string, number> = {
  'capture-telemetry': 55 * 60 * 1000,      // ~hourly
  'health-24h': 23 * 60 * 60 * 1000,        // ~daily
  'audit-probe': 23 * 60 * 60 * 1000,       // ~daily
  'anfis-retune': 6 * 60 * 60 * 1000,       // ~every 6h (task 21 — routing adaptation loop)
  // ~daily. A digest that arrives twice is worse than one that arrives late — it
  // trains you to skim it.
  'status-digest': 23 * 60 * 60 * 1000,
};

async function lastRun(trigger: string): Promise<{ at: string; summary: any } | null> {
  const { data } = await db.from('repid_telemetry_snapshots')
    .select('snapshot_at,metric_value').eq('metric_family', 'cron_trigger').eq('metric_name', trigger)
    .order('snapshot_at', { ascending: false }).limit(1);
  const row = data?.[0];
  return row ? { at: row.snapshot_at, summary: (row.metric_value as any)?.summary } : null;
}

function handle(trigger: string, runner: (sb: any, opts: any) => Promise<any>) {
  return async (req: Request, res: Response) => {
    const token = process.env.CRON_TRIGGER_TOKEN;
    if (!token || req.header('X-Cron-Token') !== token) {
      return res.status(401).json({ error: 'invalid_or_missing_cron_token' });
    }
    // Idempotency: skip if a run happened within this trigger's window.
    try {
      const prev = await lastRun(trigger);
      if (prev && Date.now() - new Date(prev.at).getTime() < (MIN_INTERVAL_MS[trigger] ?? 0)) {
        return res.status(200).json({ status: 'skipped_idempotent', trigger, last_run: prev.at, summary: prev.summary });
      }
    } catch { /* fall through — better to run than to block on the idempotency read */ }

    // Run the telemetry runner.
    let summary: any = null, ok = true, error: string | undefined;
    try { summary = await runner(db, { persist: true }); } catch (e: any) { ok = false; error = e.message; }

    // Log this invocation (every actual run; skipped pings above do not log to avoid spam).
    const at = new Date().toISOString();
    try {
      await db.from('repid_telemetry_snapshots').insert({
        snapshot_at: at, metric_family: 'cron_trigger', metric_name: trigger,
        metric_value: { ok, summary, error: error ?? null },
        metadata: { snapshot_type: 'cron_trigger', source: 'uptimerobot' },
      });
    } catch { /* logging is best-effort */ }

    return res.status(ok ? 200 : 500).json({ status: ok ? 'ran' : 'error', trigger, last_run: at, summary, error });
  };
}

router.post('/capture-telemetry', handle('capture-telemetry', captureTelemetry));
router.post('/health-24h', handle('health-24h', healthSummary24h));
router.post('/audit-probe', handle('audit-probe', runAuditProbe));
// STATUS DIGEST — the scheduled "is anyone out there / did the loop run / what
// needs a human" message. Same handle() wrapper as every other cron: X-Cron-Token,
// idempotency window, and the run logged to repid_telemetry_snapshots so the
// numbers are recoverable even if Telegram was down.
router.post('/status-digest', handle('status-digest', async () => runStatusDigest()));
// task 21 — ANFIS routing re-tune. The runner is a no-op-write (dry-run) unless
// ANFIS_RETUNE_ENABLED=true, so wiring the trigger is inert until the flag is flipped.
router.post('/anfis-retune', handle('anfis-retune', retuneAnfisRoutingRunner));

export default router;
