/**
 * verify:crosscheck — re-derive the load-bearing claims and emit machine-readable PASS/FAIL.
 * A report can't assert something this harness contradicts. Exit non-zero iff a BLOCKING
 * check FAILs (→ CI blocks the merge). SKIP (e.g. no provider keys) never blocks, never
 * silently passes — it shows as ⚠️ with a reason.
 *
 * Usage:  npm run verify:crosscheck            (all checks)
 *         npm run verify:crosscheck -- --only authority,rls
 *         npm run verify:crosscheck -- --json-only > report.json
 *
 * WARN_ONLY (env, comma-list of check ids) demotes a check's FAIL to non-blocking — for
 * Cowork to phase in invariants that currently fail on a pre-existing gap (e.g. rls) without
 * blocking every PR on day one. Documented in CC_CROSSCHECK_HARNESS.md.
 */
import { join } from 'path';
import { Check, CheckResult } from './lib/types';
import { buildReport, printReport, writeReportJson } from './lib/report';
import { authorityCheck } from './checks/authority';
import { f2AuthzCheck } from './checks/f2-authz';
import { rlsCheck } from './checks/rls';
import { halCheck } from './checks/hal';
import { repidGuardsCheck } from './checks/repid-guards';
import { swarmThroughputCheck } from './checks/swarm-throughput';
import { halAblationCheck } from './checks/hal-ablation';
import { repidFloorCheck } from './checks/repid-floor';
import { zkpAnchorCheck } from './checks/zkp-anchor';

const REGISTRY: Record<string, Check> = {
  authority: authorityCheck,
  'f2-authz': f2AuthzCheck,
  rls: rlsCheck,
  hal: halCheck,
  'repid-guards': repidGuardsCheck,
  'swarm-throughput': swarmThroughputCheck,
  // S-HAL-TRUTH 2026-06-03 — CC-owned merge-gate checks (Phase 6).
  'hal-ablation': halAblationCheck,   // B AUC ≥ plain-majority A on the persisted corpus
  'repid-floor': repidFloorCheck,     // no active trinity agent pinned at floor w/ peak ≥ 2× (drain signature)
  'zkp-anchor': zkpAnchorCheck,       // recent proofs have non-zero EAS coverage (pairs with XC)
};

function parseList(flag: string): string[] | null {
  const i = process.argv.indexOf(flag);
  const val = i === -1 ? undefined : process.argv[i + 1];
  if (!val) return null;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

(async () => {
  const jsonOnly = process.argv.includes('--json-only');
  const only = parseList('--only');
  const warnOnly = new Set((process.env.WARN_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean));

  const ids = (only ?? Object.keys(REGISTRY)).filter(id => {
    const ok = id in REGISTRY;
    if (!ok && !jsonOnly) console.error(`  (skip unknown check: ${id})`);
    return ok;
  });

  const results: CheckResult[] = [];
  for (const id of ids) {
    const fn = REGISTRY[id];
    if (!fn) continue;
    if (!jsonOnly) process.stdout.write(`  running ${id} … `);
    let r: CheckResult;
    try {
      r = await fn();
    } catch (e: any) {
      r = { id, title: id, status: 'FAIL', summary: `check threw: ${e?.message ?? e}`, blocking: true };
    }
    if (warnOnly.has(id) && r.status === 'FAIL') r = { ...r, blocking: false };
    if (!jsonOnly) console.log(r.status);
    results.push(r);
  }

  const rep = buildReport(results);
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  } else {
    printReport(rep);
    writeReportJson(rep, join(process.cwd(), 'verify-crosscheck-report.json'));
  }
  process.exit(rep.ok ? 0 : 1);
})().catch(e => { console.error('crosscheck runner crashed:', e); process.exit(2); });
