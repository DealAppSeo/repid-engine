/** Console rendering + JSON emission for the verify suite. */
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { CheckResult, SuiteReport } from './types';

export function gitInfo(): { commit: string; branch: string } {
  const safe = (cmd: string, d: string) => { try { return execSync(cmd).toString().trim(); } catch { return d; } };
  return {
    commit: safe('git rev-parse --short HEAD', 'unknown'),
    branch: safe('git rev-parse --abbrev-ref HEAD', 'unknown'),
  };
}

const icon = (s: string) => (s === 'PASS' ? '✅' : s === 'FAIL' ? '❌' : '⚠️ ');

export function buildReport(results: CheckResult[]): SuiteReport {
  const { commit, branch } = gitInfo();
  const counts = {
    pass: results.filter(r => r.status === 'PASS').length,
    fail: results.filter(r => r.status === 'FAIL').length,
    skip: results.filter(r => r.status === 'SKIP').length,
    blocking_fail: results.filter(r => r.status === 'FAIL' && r.blocking).length,
  };
  return {
    generated_at: new Date().toISOString(),
    commit, branch,
    ok: counts.blocking_fail === 0,
    counts,
    results,
  };
}

export function printReport(rep: SuiteReport): void {
  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  verify:crosscheck   ${rep.branch} @ ${rep.commit}`);
  console.log('────────────────────────────────────────────────────────');
  for (const r of rep.results) {
    const tag = r.blocking ? '' : ' (warn-only)';
    console.log(`  ${icon(r.status)} ${r.id.padEnd(13)} ${r.status.padEnd(4)} ${r.summary}${r.status === 'FAIL' ? tag : ''}`);
  }
  console.log('────────────────────────────────────────────────────────');
  console.log(`  ${rep.counts.pass} PASS · ${rep.counts.fail} FAIL · ${rep.counts.skip} SKIP` +
    (rep.counts.blocking_fail ? `  →  ${rep.counts.blocking_fail} BLOCKING` : ''));
  console.log(`  RESULT: ${rep.ok ? '✅ GREEN (no blocking failures)' : '❌ RED (blocking failure → merge blocked)'}`);
  console.log('────────────────────────────────────────────────────────\n');
}

export function writeReportJson(rep: SuiteReport, path: string): void {
  writeFileSync(path, JSON.stringify(rep, null, 2));
  console.log(`  report → ${path}`);
}
