#!/usr/bin/env ts-node
/**
 * Run the T12 coding lanes once, until nothing can move. Not a scheduler: nothing here re-runs itself.
 *
 *   npx ts-node scripts/t12/lanes.ts --specs <file.jsonl> --repo DealAppSeo/trustshell=<clean clone> --work-root <dir>
 *
 * Off unless T12_LANES_ENABLED is exactly `true`. Model calls also need T12_FREE_WAVE exactly `true`.
 * T12_LANES_ALLOW_EXEC runs model-written code in the checker: set it only on an ephemeral runner
 * with no secrets. T12_LANES_PUBLISH pushes branches and opens draft PRs. Each is off when unset.
 *
 * Exit: 0 ran, 2 NOT_CHECKED (not armed, or a bad argument), 1 failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { db as supabase } from '../../src/db';
import { getPgPool } from '../../src/db/direct-pg';
import { createRoutedAsk } from '../../src/orchestration/t12-lane-route';
import { createGitAdapters, ghPrClient } from '../../src/orchestration/t12-lane-git';
import { laneFlags, runLanes } from '../../src/orchestration/t12-lane-runner';
import { poolDb, type LaneSpec } from '../../src/orchestration/t12-lane-store';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function allArgs(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1] ?? ''] : []));
}

function notChecked(why: string): never {
  process.stderr.write(`t12 lanes NOT_CHECKED: ${why}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const flags = laneFlags();
  if (!flags.enabled) notChecked('T12_LANES_ENABLED is not exactly true; nothing was claimed.');
  const specsPath = arg('specs');
  const workRoot = arg('work-root');
  if (!specsPath || !existsSync(specsPath)) notChecked('--specs must name a JSONL file of lane specs.');
  if (!workRoot) notChecked('--work-root is required.');

  const repoDirs: Record<string, string> = {};
  for (const r of allArgs('repo')) {
    const at = r.indexOf('=');
    if (at < 1) notChecked(`--repo must be owner/name=path, got ${r}`);
    repoDirs[r.slice(0, at)] = r.slice(at + 1);
  }

  const stopFile = arg('stop-file');
  const specs = (): LaneSpec[] =>
    readFileSync(specsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LaneSpec);

  const lanes = Array.from({ length: Number(arg('lanes') ?? 3) }, (_, i) => `trinity-lane-${i + 1}`);
  const db = poolDb(getPgPool() as never);
  const report = await runLanes({
    db,
    haltClient: supabase,
    lanes,
    adapters: createGitAdapters({ repoDirs, workRoot, ask: createRoutedAsk(db), allowExec: flags.allowExec, pr: ghPrClient }),
    publishEnabled: flags.publish,
    checkEnabled: flags.allowExec,
    specs,
    readyTarget: Number(arg('ready-target') ?? 3),
    stop: () => (stopFile ? existsSync(stopFile) : false),
    log: (l) => process.stderr.write(`${l}\n`),
    dailyCap: arg('daily-cap') ? Number(arg('daily-cap')) : undefined,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

main().catch((e: unknown) => {
  process.stderr.write(`t12 lanes failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
