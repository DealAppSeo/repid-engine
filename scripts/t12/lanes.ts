#!/usr/bin/env ts-node
/**
 * Run the T12 coding lanes once, until nothing can move. Not a scheduler: nothing here re-runs itself.
 *
 *   npx ts-node scripts/t12/lanes.ts --specs <file.jsonl> --repo DealAppSeo/trustshell=<clean clone> --work-root <dir>
 *
 * Off unless T12_LANES_ENABLED is exactly `true`. Model calls also need T12_FREE_WAVE exactly `true`.
 * T12_LANES_ALLOW_EXEC runs model-written code in the checker: set it only on an ephemeral runner
 * with no secrets. T12_LANES_PUBLISH pushes branches and opens draft PRs. Each is off when unset.
 * A worker refuses to start with a signing, finance or admin credential in its environment, or on a
 * database role that bypasses row security. T12_LANES_ALLOW_PRIVILEGED_DB is for throwaway databases.
 *
 * Exit: 0 ran, 2 NOT_CHECKED (not armed, or a bad argument), 1 failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertLocalDataStore } from '../../src/selfhost/egress-guard';
import { createRoutedAsk } from '../../src/orchestration/t12-lane-route';
import { createGitAdapters, ghPrClient } from '../../src/orchestration/t12-lane-git';
import { laneFlags, runLanes } from '../../src/orchestration/t12-lane-runner';
import { dbPrivilege, privilegedEnvPresent, reachableDefiners } from '../../src/orchestration/t12-lane-profile';
import { pgHaltClient, poolDb, type LaneSpec } from '../../src/orchestration/t12-lane-store';

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
  if (flags.publish && flags.allowExec) notChecked('T12_LANES_PUBLISH and T12_LANES_ALLOW_EXEC must not be set together: the publisher holds a push credential that model-written code could read. Check on a host with no secrets.');
  const forbidden = privilegedEnvPresent(process.env, flags.publish ? 'integrator' : 'worker');
  if (forbidden.length) notChecked(`refusing to start with privileged credentials in the environment: ${forbidden.join(', ')}`);
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

  const one = arg('lane-name');
  const lanes = one ? [one] : Array.from({ length: Number(arg('lanes') ?? 3) }, (_, i) => `trinity-lane-${i + 1}`);
  const wake = arg('wake') === 'scheduled' ? ('scheduled' as const) : ('human_prompt' as const);
  // Not direct-pg: it loads the operator pager, and so the whole engine config, which demands a
  // service key this worker must not hold. Same data-locality guard, its own bounded pool.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) notChecked('DATABASE_URL is not set.');
  assertLocalDataStore(connectionString, 'DATABASE_URL');
  const db = poolDb(new Pool({ connectionString, max: lanes.length + 3, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, query_timeout: 30_000 }) as never);
  const role = await dbPrivilege(db);
  if (role.privileged && !flags.allowPrivilegedDb) notChecked(`database role ${role.name} can bypass row security; a worker must use the restricted role`);
  const definers = await reachableDefiners(db);
  if (definers.length && !flags.allowPrivilegedDb) notChecked(`database role ${role.name} can call SECURITY DEFINER functions outside the lane belts: ${definers.join(', ')}`);
  const report = await runLanes({
    db,
    haltClient: pgHaltClient(db) as never,
    wake,
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
