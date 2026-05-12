/**
 * CC Sprint 9 Phase 9 — capture post-wakeup state + diff vs baseline.
 *
 * Runs all 8 probes + the same auxiliary counts as capture-baseline.ts.
 * Reads E:\dev\reports\2026-05-12\BASELINE_PRE_WAKEUP_2026-05-12.md when present
 * and writes a side-by-side diff to:
 *   E:\dev\reports\2026-05-12\POST_WAKEUP_STATE_2026-05-12.md
 *
 * Usage (Sean runs this after wake-up):
 *   npm run capture:post-wakeup
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

const REPORTS_DIR = path.resolve('E:/dev/reports/2026-05-12');
const BASELINE_PATH = path.join(REPORTS_DIR, 'BASELINE_PRE_WAKEUP_2026-05-12.md');
const OUT_PATH = path.join(REPORTS_DIR, 'POST_WAKEUP_STATE_2026-05-12.md');

interface Counts {
  agents: number | null;
  totalRepid: number;
  proofs: number | null;
  artifacts: number | null;
  scoreEvents: number | null;
  memoryEdges: number | null;
  memoryNodes: number | null;
  halRunnerResults: number | null;
  tradeExecutionLog: number | null;
}

async function captureCounts(): Promise<Counts> {
  const db = getDb();
  const [agents, repids, proofs, artifacts, scoreEvents, edges, nodes, halRuns, trades] = await Promise.all([
    db.from('repid_agents').select('*', { count: 'exact', head: true }),
    db.from('repid_agents').select('current_repid'),
    db.from('repid_zkp_proofs').select('*', { count: 'exact', head: true }),
    db.from('trinity_artifacts').select('*', { count: 'exact', head: true }),
    db.from('repid_score_events').select('*', { count: 'exact', head: true }),
    db.from('agent_memory_edges').select('*', { count: 'exact', head: true }),
    db.from('agent_memory_nodes').select('*', { count: 'exact', head: true }),
    db.from('hal_runner_results').select('*', { count: 'exact', head: true }),
    db.from('trade_execution_log').select('*', { count: 'exact', head: true }),
  ]);
  const totalRepid = ((repids.data ?? []) as any[]).reduce((s, r) => s + (r.current_repid ?? 0), 0);
  return {
    agents: agents.count,
    totalRepid,
    proofs: proofs.count,
    artifacts: artifacts.count,
    scoreEvents: scoreEvents.count,
    memoryEdges: edges.count,
    memoryNodes: nodes.count,
    halRunnerResults: halRuns.count,
    tradeExecutionLog: trades.count,
  };
}

function parseBaselineCounts(md: string): Partial<Counts> {
  // best-effort regex parse from the baseline markdown
  const grab = (label: string) => {
    const m = new RegExp(`\\|[^|]*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^|]*\\| ([^|]+) \\|`).exec(md);
    if (!m || !m[1]) return null;
    const v = m[1].trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    agents: grab('Total agents in `repid_agents`'),
    totalRepid: grab('Sum of `current_repid`') ?? 0,
    proofs: grab('Total ZKP proofs'),
    artifacts: grab('Total `trinity_artifacts`'),
  };
}

function formatDiff(label: string, before: number | null | undefined, after: number | null | undefined): string {
  const b = before ?? 0;
  const a = after ?? 0;
  const d = a - b;
  const sign = d > 0 ? `+${d}` : d < 0 ? `${d}` : '0';
  const mark = d > 0 ? ' 🆕' : d < 0 ? ' ⚠️' : '';
  return `| ${label} | ${before ?? 'n/a'} | ${after ?? 'n/a'} | ${sign}${mark} |`;
}

(async () => {
  const capturedAt = new Date().toISOString();

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

  const after = await captureCounts();

  let baselineCounts: Partial<Counts> = {};
  let baselineFound = false;
  try {
    if (fs.existsSync(BASELINE_PATH)) {
      const md = fs.readFileSync(BASELINE_PATH, 'utf-8');
      baselineCounts = parseBaselineCounts(md);
      baselineFound = true;
    }
  } catch { /* leave empty */ }

  const lines: string[] = [];
  lines.push(`# Post-Wakeup State — 2026-05-12`);
  lines.push('');
  lines.push(`**Captured at:** ${capturedAt}`);
  lines.push(`**Captured by:** CC Sprint 9 (\`scripts/capture-post-wakeup.ts\`)`);
  lines.push(`**Baseline:** ${baselineFound ? BASELINE_PATH : 'not found — diff column will show only "after" values'}`);
  lines.push('');
  lines.push(`## Liveness probes`);
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
  lines.push(`## Substrate counts diff`);
  lines.push('');
  lines.push(`| Metric | Before | After | Δ |`);
  lines.push(`|---|---|---|---|`);
  lines.push(formatDiff('repid_agents', baselineCounts.agents, after.agents));
  lines.push(formatDiff('Σ current_repid', baselineCounts.totalRepid, after.totalRepid));
  lines.push(formatDiff('repid_zkp_proofs', baselineCounts.proofs, after.proofs));
  lines.push(formatDiff('trinity_artifacts', baselineCounts.artifacts, after.artifacts));
  lines.push('');
  lines.push(`## Substrate counts (after only — not in baseline)`);
  lines.push('');
  lines.push(`| Metric | After |`);
  lines.push(`|---|---|`);
  lines.push(`| repid_score_events | ${after.scoreEvents ?? 'n/a'} |`);
  lines.push(`| agent_memory_nodes | ${after.memoryNodes ?? 'n/a'} |`);
  lines.push(`| agent_memory_edges | ${after.memoryEdges ?? 'n/a'} |`);
  lines.push(`| hal_runner_results | ${after.halRunnerResults ?? 'n/a'} |`);
  lines.push(`| trade_execution_log | ${after.tradeExecutionLog ?? 'n/a'} |`);
  lines.push('');
  lines.push(`## Detailed probe metrics`);
  lines.push('');
  for (const p of probes) {
    lines.push(`### ${p.name} — ${p.status}`);
    lines.push('```json');
    lines.push(JSON.stringify(p.metrics, null, 2));
    lines.push('```');
    if (p.message) { lines.push(''); lines.push(`> ${p.message}`); }
    lines.push('');
  }
  lines.push(`---`);
  lines.push('');
  lines.push(`*CC Sprint 9 — Post-Wakeup State — 2026-05-12*`);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Probes: GREEN=${probes.filter(p=>p.status==='GREEN').length} AMBER=${probes.filter(p=>p.status==='AMBER').length} RED=${probes.filter(p=>p.status==='RED').length}`);
})().catch((e) => { console.error('capture-post-wakeup crashed:', e); process.exit(1); });
