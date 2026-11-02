/**
 * Experimental RepID (t12-exp-v1) over the T12 known-answer loop.
 *
 *   npm run exp-repid:replay -- --version ka-v2-precommitted,ka-v1-symmetric [--from-file rows.json] [--json]
 *       Scores every answered known-answer task under each version and prints per-agent n, score, mean and a
 *       95% interval. WRITES NOTHING: it is given no store. --from-file takes a JSON array of KnownAnswerRow
 *       (an offline copy of the same join); otherwise it reads trinity_tasks / hal_test_cases / repid_agents.
 *
 *   npm run exp-repid:settle
 *       Settles every answered known-answer task into repid_experimental_events under ACTIVE_VERSIONS, in the
 *       mode EXPERIMENTAL_REPID_MODE says (unset = off = nothing written). Evidence is read from the database
 *       only, never from a file: a file is caller-supplied and could be forged. Re-running is safe: consumed
 *       evidence is refused by the table's unique indexes (already_consumed).
 */
import { readFileSync } from 'node:fs';
import {
  ACTIVE_VERSIONS,
  experimentalRepidMode,
  knownAnswerEvidence,
  loadKnownAnswerRows,
  replayKnownAnswers,
  settleExperimental,
  type KnownAnswerRow,
} from '../../src/services/experimental-repid';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function replay(): Promise<void> {
  const versions = (arg('--version') ?? 'ka-v2-precommitted').split(',').map((v) => v.trim()).filter(Boolean);
  const file = arg('--from-file');
  const rows: KnownAnswerRow[] = file ? JSON.parse(readFileSync(file, 'utf8')) : await loadKnownAnswerRows();
  const lines = replayKnownAnswers(rows, versions);
  if (process.argv.includes('--json')) {
    for (const l of lines) console.log(JSON.stringify(l));
    return;
  }
  console.log(`replay: ${rows.length} known-answer rows, versions ${versions.join(', ')}; nothing written`);
  for (const v of versions) {
    console.log(`\n${v}`);
    console.log('agent'.padEnd(18) + 'n'.padStart(5) + 'skip'.padStart(6) + 'score'.padStart(10) + 'mean'.padStart(9) + '   95% CI of mean');
    for (const l of lines.filter((x) => x.version === v)) {
      const ci = l.ci95 ? `[${l.ci95[0].toFixed(3)}, ${l.ci95[1].toFixed(3)}]` : '-';
      console.log(l.agent.padEnd(18) + String(l.n).padStart(5) + String(l.skipped).padStart(6) + l.score.toFixed(3).padStart(10) + l.mean.toFixed(3).padStart(9) + '   ' + ci);
    }
  }
}

async function settle(): Promise<void> {
  const mode = experimentalRepidMode();
  if (mode === 'off') {
    console.log('EXPERIMENTAL_REPID_MODE is off: nothing read, nothing written.');
    return;
  }
  const rows = await loadKnownAnswerRows();
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const evidence = knownAnswerEvidence(r);
    for (const version of ACTIVE_VERSIONS) {
      const res = await settleExperimental({ agentId: r.subject_agent_id, evidence, version }, { mode });
      const key = `${version}:${res.status === 'refused' ? `refused:${res.reason}` : res.status}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify({ mode, rows: rows.length, tally }, null, 2));
  if (Object.keys(tally).some((k) => k.endsWith('store_error'))) process.exitCode = 1;
}

const cmd = process.argv[2];
(cmd === 'replay' ? replay() : cmd === 'settle' ? settle() : Promise.reject(new Error('usage: run.ts replay|settle')))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
