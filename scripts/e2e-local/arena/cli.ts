/**
 * Arena batch driver: runs the named cases against a devnet and writes one evidence record per case.
 * It is what E:\dev\ops\loop\arena-loop.mjs launches. The loop starts and stops the Hardhat node and serves
 * the free-LLM agents over loopback HTTP; this process holds no key and calls no model itself.
 *
 *   npx ts-node --transpile-only scripts/e2e-local/arena/cli.ts --list-cases
 *   npx ts-node --transpile-only scripts/e2e-local/arena/cli.ts --rpc http://127.0.0.1:18545 --stub
 *        [--agents-url http://127.0.0.1:PORT/agent --token T] [--cases a,b,c] [--out-dir DIR]
 *        [--batch-id ID] [--sym-seed N]
 *
 * Last stdout line: `ARENA_RESULT {json}`. Exit 0 when the batch ran (the loop decides what a breach means), 2 on a crash.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpAgents, StubAgents, type ArenaAgents } from './agents';
import { ViemChain } from './chain';
import { sha256Hex } from './core';
import { bootEngine } from './engine';
import { CASE_IDS, CONTROL_CASES, type CaseId } from './oracle';
import { EXTRA_CASE_IDS, type ExtraCaseId } from './cases';
import { KNOWN_FAILING, runCase, type Evidence } from './runner';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = 'true';
    else (out[a.slice(2)] = next), i++;
  }
  return out;
}

export function summarise(batchId: string, evs: Evidence[]) {
  const by = (v: string) => evs.filter((e) => e.oracle_verdict === v);
  const breaches: Record<string, number> = {};
  for (const e of evs) for (const b of e.breaches) breaches[b] = (breaches[b] ?? 0) + 1;
  const failed = by('FAIL');
  return {
    batch_id: batchId,
    records: evs.length,
    pass: by('PASS').length,
    fail: failed.length,
    not_checked: by('NOT_CHECKED').length,
    known_failing: failed.filter((e) => e.pinned_known_failure).map((e) => e.case),
    new_failing: failed.filter((e) => !e.pinned_known_failure).map((e) => e.case),
    breaches,
    run_ids: evs.map((e) => e.run_id),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['list-cases']) {
    console.log(JSON.stringify({ cases: CASE_IDS, controls: CONTROL_CASES, extra_cases: EXTRA_CASE_IDS, known_failing: KNOWN_FAILING }));
    return;
  }
  if (!a['rpc']) throw new Error('--rpc is required');
  const cases = (a['cases'] ? a['cases'].split(',') : [...CASE_IDS, ...EXTRA_CASE_IDS]) as Array<CaseId | ExtraCaseId>;
  for (const c of cases) if (!(CASE_IDS as readonly string[]).includes(c) && !(EXTRA_CASE_IDS as readonly string[]).includes(c)) throw new Error(`unknown case ${c}`);

  const engine = bootEngine();
  const chain = new ViemChain(a['rpc']);
  const agents: ArenaAgents = a['stub'] ? new StubAgents() : new HttpAgents(a['agents-url'] ?? '', a['token'] ?? '');
  const oraclePath = join(__dirname, 'oracle.ts');
  // Line endings are normalised so the same oracle hashes the same on a CRLF and an LF checkout.
  const oracleSha = () => sha256Hex(readFileSync(oraclePath, 'utf8').replaceAll('\r\n', '\n'));
  const evaluatorSha256 = oracleSha();
  const repo = join(__dirname, '..', '..', '..');
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim().length > 0;
  // A record made on uncommitted code says so: its sha alone would not reproduce it.
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim() + (dirty ? '-dirty' : '');
  const batchId = a['batch-id'] ?? randomUUID();

  const evs: Evidence[] = [];
  for (const [i, c] of cases.entries()) {
    const ev = await runCase(c, { chain, engine, agents, batchId, gitSha, evaluatorSha256, currentEvaluatorSha256: oracleSha, symSeed: Number(a['sym-seed'] ?? 0), outDir: a['out-dir'] });
    evs.push(ev);
    console.log(`#${i + 1} ${c} [${ev.negotiation.asset}] ${ev.oracle_verdict}${ev.pinned_known_failure ? ' (pinned known failure)' : ''}${ev.not_checked_reason ? ` - ${ev.not_checked_reason}` : ''}${ev.breaches.length ? ` breaches=${ev.breaches.join(',')}` : ''}`);
  }
  const egress = engine.egress;
  console.log(`ARENA_RESULT ${JSON.stringify({ ...summarise(batchId, evs), git_sha: gitSha, evaluator_sha256: evaluatorSha256, egress_blocked: egress.blocked.length, egress_local: egress.local })}`);
  try {
    engine.db?.close?.();
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error(String((e as Error).stack ?? e).slice(0, 2000));
  process.exitCode = 2;
});
