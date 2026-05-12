/**
 * CC Sprint 9 — capture pre-wakeup baseline.
 *
 * Runs all 8 liveness probes (Phase 1) + captures additional metrics
 * (tier distribution, total RepID, total proofs, RLS posture, etc.).
 * Writes a markdown report to:
 *   E:\dev\reports\2026-05-12\BASELINE_PRE_WAKEUP_2026-05-12.md
 *
 * This is the "before" snapshot for the Phase 9 post-wakeup diff.
 *
 * Usage:
 *   npm run capture:baseline
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './liveness-probes/_shared';
import { probeZkpPipeline } from './liveness-probes/probe-zkp-pipeline';
import { probeHalPipeline } from './liveness-probes/probe-hal-pipeline';
import { probeRepidScoring } from './liveness-probes/probe-repid-scoring';
import { probeGraphRag } from './liveness-probes/probe-graph-rag';
import { probeX402Settlements } from './liveness-probes/probe-x402-settlements';
import { probeOnchainReputation } from './liveness-probes/probe-onchain-reputation';
import { probeTrinitySwarm } from './liveness-probes/probe-trinity-swarm';
import { probeAnfisRouting } from './liveness-probes/probe-anfis-routing';

const OUT_PATH = path.resolve('E:/dev/reports/2026-05-12/BASELINE_PRE_WAKEUP_2026-05-12.md');

(async () => {
  const db = getDb();
  const capturedAt = new Date().toISOString();

  // 8 probes in parallel
  const probes = await Promise.all([
    probeZkpPipeline(),
    probeHalPipeline(),
    probeRepidScoring(),
    probeGraphRag(),
    probeX402Settlements(),
    probeOnchainReputation(),
    probeTrinitySwarm(),
    probeAnfisRouting(),
  ]);

  // Additional metrics
  const [
    agentCount,
    repidByTier,
    repidSum,
    proofsTotal,
    artifactsTotal,
  ] = await Promise.all([
    db.from('repid_agents').select('*', { count: 'exact', head: true }),
    db.from('repid_agents').select('tier'),
    db.from('repid_agents').select('current_repid'),
    db.from('repid_zkp_proofs').select('*', { count: 'exact', head: true }),
    db.from('trinity_artifacts').select('*', { count: 'exact', head: true }),
  ]);

  // Migration count: separate try because schema_migrations may not be reachable via PostgREST
  let migrationCount: number | null = null;
  try {
    const r = await (db.from as any)('supabase_migrations.schema_migrations').select('*', { count: 'exact', head: true });
    migrationCount = r?.count ?? null;
  } catch { migrationCount = null; }

  const tierDist: Record<string, number> = {};
  for (const r of (repidByTier.data ?? []) as any[]) {
    tierDist[r.tier] = (tierDist[r.tier] ?? 0) + 1;
  }
  const totalRepid = ((repidSum.data ?? []) as any[]).reduce((s, r) => s + (r.current_repid ?? 0), 0);

  // RLS-on count via raw query (PostgREST can't reach pg_class directly; fall back to a count via Supabase RPC if available, else skip)
  let rlsOn: number | null = null;
  try {
    const { data } = await db.rpc('exec_sql' as any, { sql: "SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true" });
    if (Array.isArray(data) && data[0]) rlsOn = (data[0] as any).n;
  } catch {
    // RPC missing — report null; Phase 9 will use same approach
  }

  // Production smoke — best-effort, marked as not-attempted from this script
  // (Sean runs `npm run smoke:prod` separately; this baseline just records pre-state).
  const smokeNote = 'production smoke not run from this script — Sean runs `npm run smoke:prod` separately and records result in the post-wakeup capture';

  // Build markdown
  const lines: string[] = [];
  lines.push(`# Pre-Wakeup Baseline — 2026-05-12`);
  lines.push('');
  lines.push(`**Captured at:** ${capturedAt}`);
  lines.push(`**Captured by:** CC Sprint 9 (\`scripts/capture-baseline.ts\`)`);
  lines.push(`**Purpose:** "before" snapshot for the Phase 9 post-wakeup diff. Compare against \`POST_WAKEUP_STATE_2026-05-12.md\` after Sean executes \`SWARM_WAKEUP_SEQUENCE_2026-05-12.md\`.`);
  lines.push('');
  lines.push(`## Liveness probes (Phase 1)`);
  lines.push('');
  lines.push(`| Probe | Status | Key metric |`);
  lines.push(`|---|---|---|`);
  for (const p of probes) {
    const kv = Object.entries(p.metrics).slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    lines.push(`| \`${p.name}\` | **${p.status}** | ${kv} |`);
  }
  lines.push('');
  lines.push(`Summary: GREEN=${probes.filter(p=>p.status==='GREEN').length} AMBER=${probes.filter(p=>p.status==='AMBER').length} RED=${probes.filter(p=>p.status==='RED').length}`);
  lines.push('');
  lines.push(`## Substrate counts`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total agents in \`repid_agents\` | ${agentCount.count ?? 'unknown'} |`);
  lines.push(`| Sum of \`current_repid\` across all agents | ${totalRepid} |`);
  lines.push(`| Total ZKP proofs in \`repid_zkp_proofs\` (all-time) | ${proofsTotal.count ?? 'unknown'} |`);
  lines.push(`| Total \`trinity_artifacts\` (all-time) | ${artifactsTotal.count ?? 'unknown'} |`);
  lines.push(`| Migration ledger size | ${migrationCount ?? 'unreachable from PostgREST'} |`);
  lines.push(`| RLS-on table count (public) | ${rlsOn ?? 'unreachable from PostgREST — see Phase 9 alt path'} |`);
  lines.push('');
  lines.push(`### Agent tier distribution`);
  lines.push('');
  lines.push(`| Tier | Count |`);
  lines.push(`|---|---|`);
  for (const tier of ['PROBATIONARY','EARNING','ESTABLISHED','AUTONOMOUS','VETERAN']) {
    lines.push(`| ${tier} | ${tierDist[tier] ?? 0} |`);
  }
  if (tierDist['null']) lines.push(`| (null) | ${tierDist['null']} |`);
  lines.push('');
  lines.push(`## Production smoke`);
  lines.push('');
  lines.push(smokeNote);
  lines.push('');
  lines.push(`## Detailed probe metrics`);
  lines.push('');
  for (const p of probes) {
    lines.push(`### ${p.name} — ${p.status}`);
    lines.push('```json');
    lines.push(JSON.stringify(p.metrics, null, 2));
    lines.push('```');
    if (p.message) {
      lines.push('');
      lines.push(`> ${p.message}`);
    }
    lines.push('');
  }
  lines.push(`---`);
  lines.push('');
  lines.push(`*"Whatever your hand finds to do, do it with all your might." — Ecclesiastes 9:10*`);
  lines.push('');
  lines.push(`*CC Sprint 9 — Pre-Wakeup Baseline — 2026-05-12*`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Probes: GREEN=${probes.filter(p=>p.status==='GREEN').length} AMBER=${probes.filter(p=>p.status==='AMBER').length} RED=${probes.filter(p=>p.status==='RED').length}`);
})().catch((e) => { console.error('capture-baseline crashed:', e); process.exit(1); });
