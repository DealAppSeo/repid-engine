/**
 * Probe: ANFIS routing engine.
 * PASS: rules exist AND recent snapshots.
 * AMBER: rules exist, no recent snapshots (engine deployed but unused).
 * RED: rules empty or snapshots stale.
 */
import { getDb, ProbeResult, ProbeStatus } from './_shared';

export async function probeAnfisRouting(): Promise<ProbeResult> {
  const db = getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { count: ruleCount } = await db
    .from('trinity_anfis_rules').select('*', { count: 'exact', head: true });

  const { count: snapshots24h } = await db
    .from('hal_anfis_snapshots').select('*', { count: 'exact', head: true })
    .gte('created_at', since24h);

  const { data: latest } = await db
    .from('hal_anfis_snapshots').select('created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  let status: ProbeStatus;
  if ((ruleCount ?? 0) >= 1 && (snapshots24h ?? 0) >= 1) status = 'GREEN';
  else if ((ruleCount ?? 0) >= 1) status = 'AMBER';
  else status = 'RED';

  return {
    name: 'anfis-routing',
    status,
    metrics: {
      rule_count: ruleCount ?? 0,
      snapshots_24h: snapshots24h ?? 0,
      last_snapshot_at: (latest as any)?.created_at ?? null,
    },
  };
}

if (require.main === module) {
  probeAnfisRouting().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'RED' ? 1 : 0); });
}
