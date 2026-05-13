/**
 * Probe: HAL pipeline (hal_runner_results + hal_evaluations dual-write).
 */
import { getDb, classifyByActivity, ProbeResult } from './_shared';

export async function probeHalPipeline(): Promise<ProbeResult> {
  const db = getDb();
  const now = new Date();
  const since1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const { count: hrrCount1h } = await db
    .from('hal_runner_results').select('*', { count: 'exact', head: true })
    .gte('created_at', since1h);
  const { count: hrrCount24h } = await db
    .from('hal_runner_results').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);
  const { data: latestHrr } = await db
    .from('hal_runner_results').select('created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  // hal_evaluations is the dual-write target, env-gated by HAL_EVALUATIONS_DUAL_WRITE
  const { count: heCount24h } = await db
    .from('hal_evaluations').select('*', { count: 'exact', head: true })
    .gte('ts', since24h);
  const { data: latestHe } = await db
    .from('hal_evaluations').select('ts')
    .order('ts', { ascending: false }).limit(1).maybeSingle();

  const halRunnerStatus = classifyByActivity(hrrCount1h ?? 0, hrrCount24h ?? 0);
  const halEvaluationsStatus = (heCount24h ?? 0) >= 1 ? 'GREEN' : 'RED';

  return {
    name: 'hal-pipeline',
    status: halRunnerStatus, // overall feature health gated on canonical pipeline
    metrics: {
      hal_runner_status: halRunnerStatus,
      hal_evaluations_status: halEvaluationsStatus,
      hal_runs_1h: hrrCount1h ?? 0,
      hal_runs_24h: hrrCount24h ?? 0,
      last_hal_run: (latestHrr as any)?.created_at ?? null,
      hal_evaluations_24h: heCount24h ?? 0,
      last_hal_evaluation: (latestHe as any)?.ts ?? null,
    },
    message: halEvaluationsStatus === 'RED'
      ? 'hal_evaluations dual-write target is silent; check HAL_EVALUATIONS_DUAL_WRITE env on repid-engine Railway'
      : undefined,
  };
}

if (require.main === module) {
  probeHalPipeline().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
