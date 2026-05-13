/**
 * CC Sprint 9 — master script that runs all 8 liveness probes in parallel,
 * prints a status table, and writes results to liveness_probe_history.
 *
 * Exit code: 0 if all probes are GREEN or AMBER; 1 if any RED.
 *
 * Usage:
 *   npm run probe:all
 */

import 'dotenv/config';
import { formatRow, getDb, ProbeResult } from './_shared';
import { probeZkpPipeline } from './probe-zkp-pipeline';
import { probeHalPipeline } from './probe-hal-pipeline';
import { probeRepidScoring } from './probe-repid-scoring';
import { probeGraphRag } from './probe-graph-rag';
import { probeX402Settlements } from './probe-x402-settlements';
import { probeOnchainReputation } from './probe-onchain-reputation';
import { probeTrinitySwarm } from './probe-trinity-swarm';
import { probeAnfisRouting } from './probe-anfis-routing';

async function persistHistory(results: ProbeResult[]): Promise<void> {
  // Best-effort: skip silently if liveness_probe_history doesn't exist yet
  // (Phase 1 migration may not have been applied in the local environment).
  try {
    const db = getDb();
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rows = results.map((r) => ({
      run_id: runId,
      probe_name: r.name,
      status: r.status,
      metrics: r.metrics,
      message: r.message ?? null,
    }));
    const { error } = await db.from('liveness_probe_history').insert(rows);
    if (error) {
      console.warn(`[run-all-probes] history insert skipped: ${error.message}`);
    }
  } catch (e: any) {
    console.warn(`[run-all-probes] history persistence error: ${e?.message ?? e}`);
  }
}

(async () => {
  const startMs = Date.now();
  const results = await Promise.all([
    probeZkpPipeline(),
    probeHalPipeline(),
    probeRepidScoring(),
    probeGraphRag(),
    probeX402Settlements(),
    probeOnchainReputation(),
    probeTrinitySwarm(),
    probeAnfisRouting(),
  ]);

  console.log('');
  console.log('=== CC Sprint 9 Liveness Probes ===');
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log(`Wall-clock: ${Date.now() - startMs}ms`);
  console.log('');
  for (const r of results) {
    console.log(formatRow(r));
    if (r.message) console.log(`        ${r.message}`);
  }
  console.log('');

  await persistHistory(results);

  const counts = results.reduce(
    (acc, r) => ({ ...acc, [r.status]: (acc as any)[r.status] + 1 }),
    { GREEN: 0, AMBER: 0, RED: 0 } as Record<string, number>
  );
  console.log(`Summary: GREEN=${counts.GREEN} AMBER=${counts.AMBER} RED=${counts.RED}`);

  process.exit(counts.RED > 0 ? 1 : 0);
})().catch((e) => {
  console.error('run-all-probes crashed:', e);
  process.exit(2);
});
