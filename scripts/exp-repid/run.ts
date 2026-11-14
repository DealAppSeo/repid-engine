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
 *
 *   npm run exp-repid:reveal -- <reveal.json> [--published <sha256>] [--settle] [--json] [--out summary.json]
 *       Grades known-answer work whose key was COMMITTED before dispatch and REVEALED after it (a rehearsal
 *       runner's tasks). The reveal file ({ tag, items }) is caller-supplied, so it must cover every task
 *       dispatched under its tag, each item must open its PUBLISHED commitment, and each row must still carry
 *       that commitment and the exact reply and claimer the conductor graded (see commit-reveal-key.ts).
 *       ANY rejected item, or a commitments hash that differs from --published, makes the run unclean: it
 *       exits 1 and settles nothing, because an exclusion someone could cause must never beat the penalty.
 *       Prints, per task, the key-graded delta beside the bridge's own fact-check delta for the same task.
 *       Without --settle it WRITES NOTHING. --settle requires --published, writes SHADOW rows only, and
 *       refuses unless EXPERIMENTAL_REPID_MODE=shadow: the commit-reveal key is not ratified for active.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  ACTIVE_VERSIONS,
  experimentalRepidMode,
  knownAnswerEvidence,
  loadKnownAnswerRows,
  replayKnownAnswers,
  settleExperimental,
  type KnownAnswerRow,
} from '../../src/services/experimental-repid';
import { keyVsBridge, loadBridgeDeltas, loadCommitRevealRows, parseRevealFile, revealIsClean } from '../../src/services/commit-reveal-key';

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

async function reveal(): Promise<void> {
  const file = process.argv[3];
  if (!file || file.startsWith('--')) throw new Error('usage: run.ts reveal <reveal.json> [--published <sha256>] [--settle] [--json] [--out file]');
  const doSettle = process.argv.includes('--settle');
  // The commitments hash published BEFORE dispatch. Without it nobody has checked that this reveal is the whole
  // published list, so --settle requires it; a report without it says so.
  const published = (arg('--published') ?? '').trim().toLowerCase() || null;
  if (doSettle && !published) {
    console.error('reveal --settle requires --published <sha256>, the commitments hash published before dispatch. Nothing read, nothing written.');
    process.exitCode = 2;
    return;
  }
  // Refuse before reading anything: the commit-reveal key settles shadow only until it is ratified.
  if (doSettle && experimentalRepidMode() !== 'shadow') {
    console.error(`reveal --settle writes shadow rows only; EXPERIMENTAL_REPID_MODE is '${experimentalRepidMode()}', expected 'shadow'. Nothing read, nothing written.`);
    process.exitCode = 2;
    return;
  }
  const { rows, rejected, unanswered, published_commitments_sha256 } = await loadCommitRevealRows(parseRevealFile(JSON.parse(readFileSync(file, 'utf8'))));
  const bridge = await loadBridgeDeltas(rows.map((r) => r.task_id));
  const summary = keyVsBridge(rows, bridge);
  // Any rejection makes the whole reveal unclean (commit-reveal-key.ts header): an item someone can knock
  // out must not leave the run measured on the items they chose to keep. So does a reveal whose commitments
  // are not the published list. With no --published, the list was not checked: NOT_CHECKED, not clean.
  const manifest_ok = published === null ? null : published === published_commitments_sha256;
  const clean = revealIsClean(rejected) && manifest_ok !== false;
  const report = { ...summary, rejected, unanswered, published_commitments_sha256, manifest_ok, clean };
  const outFile = arg('--out');
  if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`reveal: ${rows.length} accepted, ${rejected.length} rejected; grading rule ${summary.version}${doSettle && clean ? '' : '; nothing written'}`);
    for (const x of rejected) console.log(`  REJECTED task ${x.task_id}: ${x.reason}`);
    if (unanswered.length) console.log(`  unanswered (scored nothing, not a rejection): ${unanswered.join(', ')}`);
    console.log(`commitments hash of this reveal: ${published_commitments_sha256} (${manifest_ok === null ? 'NOT_CHECKED: pass --published' : manifest_ok ? 'matches the published one' : 'DOES NOT match the published one'})`);
    console.log('task'.padEnd(10) + 'agent'.padEnd(18) + 'expected'.padEnd(10) + 'answer'.padEnd(10) + 'key'.padStart(7) + 'bridge'.padStart(9));
    for (const l of summary.lines) {
      const fmt = (x: number | null) => (x === null ? '-' : String(Math.round(x * 1000) / 1000));
      console.log(l.task_id.padEnd(10) + l.agent.padEnd(18) + l.expected.padEnd(10) + String(l.decision ?? '-').padEnd(10) + fmt(l.key_delta).padStart(7) + fmt(l.bridge_delta).padStart(9));
    }
    const t = (x: Record<string, number>) => `up ${x.up}, down ${x.down}, zero ${x.zero}, missing ${x.missing}`;
    console.log(`\nright ${summary.right} (+${summary.right_abstain} right abstain), wrong ${summary.wrong}, abstained ${summary.abstained}, not scorable ${summary.not_scorable}`);
    console.log(`key follows the answer: ${summary.key_follows_answer ? 'YES' : 'NO'}`);
    console.log(`bridge on right answers: ${t(summary.bridge_on_right)}`);
    console.log(`bridge on wrong answers: ${t(summary.bridge_on_wrong)}`);
  }
  if (!clean) {
    const why = [
      ...(manifest_ok === false ? [`the reveal's commitments hash ${published_commitments_sha256} is not the published ${published}`] : []),
      ...(rejected.length ? [`${rejected.length} item(s) rejected (${rejected.map((x) => `${x.task_id}:${x.reason}`).join(', ')})`] : []),
    ];
    console.error(`reveal: NOT A CLEAN MEASUREMENT: ${why.join('; ')}. Nothing settled.`);
    process.exitCode = 1;
    return;
  }
  if (!doSettle) return;
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const evidence = knownAnswerEvidence(r);
    for (const version of ACTIVE_VERSIONS) {
      const res = await settleExperimental({ agentId: r.subject_agent_id, evidence, version }, { mode: 'shadow' });
      const key = `${version}:${res.status === 'refused' ? `refused:${res.reason}` : res.status}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify({ mode: 'shadow', rows: rows.length, tally }, null, 2));
  if (Object.keys(tally).some((k) => k.endsWith('store_error'))) process.exitCode = 1;
}

const cmd = process.argv[2];
(cmd === 'replay' ? replay() : cmd === 'settle' ? settle() : cmd === 'reveal' ? reveal() : Promise.reject(new Error('usage: run.ts replay|settle|reveal')))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
