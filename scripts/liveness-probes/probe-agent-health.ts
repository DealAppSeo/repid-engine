/**
 * probe-agent-health — CLI wrapper around the probe core in `src/observability/health-probe.ts`.
 *
 * The logic lives in `src/` because the in-process worker imports it and `dist/` only builds
 * `src/`. Keeping a second copy here would guarantee the two drift, and the one that drifts is
 * always the one you are not looking at.
 *
 * Usage:
 *   npx ts-node scripts/liveness-probes/probe-agent-health.ts            # probe + persist
 *   npx ts-node scripts/liveness-probes/probe-agent-health.ts --dry-run  # probe only, NO creds
 *
 * `--dry-run` needs no database credentials at all — `src/db` is required lazily below. A
 * diagnostic tool must be runnable in the degraded situation you are trying to diagnose.
 */
import { probeFleet, summarise } from '../../src/observability/health-probe';

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const rows = await probeFleet();

  for (const r of rows) {
    const status = r.ok ? 'UP  ' : r.http_status === null ? 'UNREACH' : 'DOWN';
    console.log(
      `${status} ${r.agent_name.padEnd(18)} ${String(r.http_status ?? '-').padStart(4)} ` +
        `${String(r.latency_ms).padStart(6)}ms${r.error ? '  ' + r.error : ''}`,
    );
  }
  console.log(`\n${summarise(rows)}`);

  if (dryRun) {
    console.log('--dry-run: nothing written');
    return 0;
  }

  // Lazy on purpose — see the header note about --dry-run without credentials.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { db } = require('../../src/db');
  const { error } = await db.from('agent_health_probes').insert(rows);
  if (error) {
    // A failed WRITE is not a failed probe. Naming which one broke stops the next reader
    // mistaking a logging outage for a fleet outage.
    console.error(`probe results NOT persisted (probes themselves ran fine): ${error.message}`);
    return 1;
  }
  console.log(`wrote ${rows.length} probe rows`);
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error('probe run failed:', e?.message ?? e);
    process.exit(1);
  });
}
